// 换色：肤色、发色、瞳色、服装色相/饱和度。
// Rocketbox 的皮肤、头发、衣服都画在同一张贴图上，没有现成的遮罩，所以加载时在 JS 里生成：
//   1. 按颜色判断皮肤（橙色调、中等饱和、不太暗）和头发（黄棕色调；深色时色调放宽）；
//   2. 对皮肤做形态学闭运算，把鼻孔、眼角褶皱这类被皮肤包围的小块暗区并回皮肤，
//      否则它们会被当成深色头发染色；
//   3. 头发 = 头发色 且 不在（略微扩大的）皮肤区域里。
// 虹膜在眼球贴图正中，用圆形区域定位。换色都按原贴图明暗缩放，保留纹理细节。
import * as THREE from 'three';

// 肤色是贴图里的皮肤颜色（不含光照），原贴图的平均肤色约为 #cc997a
export const SKIN_PRESETS = [
  ['原色', null], ['白皙', '#d8ad94'], ['自然', '#cc997a'], ['小麦', '#b07a58'], ['古铜', '#8c5a3d'], ['深棕', '#5c3a28'],
];
export const HAIR_PRESETS = [
  ['原色', null], ['黑色', '#16110e'], ['深棕', '#3a2416'], ['栗色', '#6b3a22'], ['金色', '#d4ad66'],
  ['银灰', '#b9b9bd'], ['酒红', '#7c2230'], ['粉色', '#e08fb0'], ['蓝色', '#3a5fae'],
];
export const EYE_PRESETS = [
  ['原色', null], ['深棕', '#5a3218'], ['黑色', '#211810'], ['蓝色', '#3b78c9'], ['绿色', '#3f8f4f'],
  ['灰色', '#8a949b'], ['琥珀', '#c58a2c'], ['紫色', '#7a4fb5'],
];

// 眼球在头部贴图里的 UV 区域，虹膜在正中；左下角是口腔内部（牙齿、牙龈、舌头），不参与换色（两个人物相同）
const EYE_BOX = [0.207, 0.011, 0.32, 0.125];
const MOUTH_BOX = [0, 0, 0.205, 0.32];
const IRIS = { u: 0.2635, v: 0.068, r: 0.0175 };
const MASK_SIZE = 512;

// ---------------------------------------------------------------- 颜色判定

function smooth(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
const band = (x, a, b, s) => smooth(a - s, a + s, x) * (1 - smooth(b - s, b + s, x));

function hsv(r, g, b) {
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
  }
  return [((h * 60) + 360) % 360, max ? d / max : 0, max];
}

// 阈值按实测：两个人物的皮肤约为 色相 16°–25°、饱和 0.36–0.56、明度 0.66–0.86；
// 金发约为 32°–34°、饱和 0.45–0.53，与皮肤只差约 10°；深棕发明度只有 0.1–0.25
const skinScore = ([h, s, v]) => band(h, 8, 26.5, 2) * band(s, 0.15, 0.62, 0.04) * smooth(0.56, 0.64, v);
const hairScore = ([h, s, v]) => {
  const light = band(h, 29.5, 62, 2) * smooth(0.12, 0.2, s); // 金发、浅棕
  // 深棕、黑发；色相下限 16° 是为了排除口腔内部（暗红）
  const dark = band(h, 16, 62, 3) * smooth(0.25, 0.35, s) * (1 - smooth(0.4, 0.5, v));
  return Math.max(light, dark) * smooth(0.03, 0.08, v);
};
// 发根：和皮肤同色调但明显更暗（发际线处明度约 0.42–0.56，额头皮肤约 0.75–0.86）。
// 下巴底下的阴影也是这个颜色，所以它只在和头发连着时才算头发（见 growRegions）
const rootsScore = ([h, s, v]) => band(h, 14, 62, 2) * smooth(0.3, 0.38, s) * (1 - smooth(0.58, 0.64, v)) * smooth(0.1, 0.18, v);
// 嘴唇偏红，闭运算填皮肤时跳过，否则会出现方块色斑
const lipScore = ([h, s]) => Math.max(1 - smooth(8, 12, h), smooth(335, 345, h)) * smooth(0.25, 0.35, s);

const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

// TextureLoader 在图片加载完才给 texture.image 赋值，所以先等它出现
async function whenLoaded(tex, timeout = 60000) {
  if (!tex) return null;
  const start = performance.now();
  while (!tex.image) {
    if (performance.now() - start > timeout) return null;
    await new Promise((r) => setTimeout(r, 100));
  }
  const img = tex.image;
  if (img.complete === false) {
    await new Promise((r) => {
      img.addEventListener('load', r, { once: true });
      img.addEventListener('error', r, { once: true });
    });
  }
  return img.width || img.naturalWidth ? img : null;
}

function pixels(img, size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0, size, size);
  return g.getImageData(0, 0, size, size).data;
}

// 方形窗口的最大/最小值滤波（可分离），用于膨胀/腐蚀
function morph(src, size, r, useMax) {
  const tmp = new Uint8Array(src.length);
  const out = new Uint8Array(src.length);
  const pick = useMax ? Math.max : Math.min;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let m = src[y * size + x];
      for (let k = -r; k <= r; k++) {
        const xx = x + k;
        if (xx >= 0 && xx < size) m = pick(m, src[y * size + xx]);
      }
      tmp[y * size + x] = m;
    }
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let m = tmp[y * size + x];
      for (let k = -r; k <= r; k++) {
        const yy = y + k;
        if (yy >= 0 && yy < size) m = pick(m, tmp[yy * size + x]);
      }
      out[y * size + x] = m;
    }
  }
  return out;
}

// 宽泛的肤色系：红到橙黄、有一定饱和度（含嘴唇）
const broadSkinScore = ([h, s, v]) => Math.max(1 - smooth(40, 46, h), smooth(340, 346, h)) * smooth(0.1, 0.16, s) * smooth(0.08, 0.15, v);

// 介于皮肤和头发之间、说不清是哪个的颜色（如发际线的浅色绒毛、耳廓阴影）
const ambiguousScore = ([h, s, v]) => band(h, 8, 45, 3) * smooth(0.12, 0.2, s) * smooth(0.12, 0.2, v);

/**
 * 两轮扩张：
 *   1. 头发（2）沿发根色和模糊色往外长，最多 12 像素——发际线的发根归头发；
 *   2. 皮肤（1）再沿剩下的发根色/模糊色往外长，最多 8 像素，并向任意非头发像素多扩 4 像素，
 *      避免换深肤色后下巴阴影、耳廓边缘留一圈原色。
 */
function growRegions(skin, hair, ambiguous, roots, size) {
  const total = size * size;
  const label = new Uint8Array(total);
  for (let i = 0; i < total; i++) {
    if (skin[i]) label[i] = 1;
    else if (hair[i]) label[i] = 2;
  }
  const grow = (who, maxDist, halo) => {
    const dist = new Uint16Array(total);
    const queue = new Int32Array(total);
    let head = 0;
    let tail = 0;
    for (let i = 0; i < total; i++) if (label[i] === who) queue[tail++] = i;
    while (head < tail) {
      const i = queue[head++];
      const x = i % size;
      const d = dist[i] + 1;
      for (const j of [i - 1, i + 1, i - size, i + size]) {
        if (j < 0 || j >= total || label[j]) continue;
        if ((j === i - 1 && x === 0) || (j === i + 1 && x === size - 1)) continue;
        if (!(((roots[j] || ambiguous[j]) && d <= maxDist) || d <= halo)) continue;
        label[j] = who;
        dist[j] = d;
        queue[tail++] = j;
      }
    }
  };
  grow(2, 12, 0);
  grow(1, 8, 4);
  return label;
}

// 4 邻域连通块小于 minArea 的置 0
function removeSmallIslands(mask, size, minArea) {
  const seen = new Uint8Array(mask.length);
  const stack = [];
  const block = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    block.length = 0;
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const i = stack.pop();
      block.push(i);
      const x = i % size;
      for (const j of [i - 1, i + 1, i - size, i + size]) {
        if (j < 0 || j >= mask.length || seen[j] || !mask[j]) continue;
        if ((j === i - 1 && x === 0) || (j === i + 1 && x === size - 1)) continue;
        seen[j] = 1;
        stack.push(j);
      }
    }
    if (block.length < minArea) for (const i of block) mask[i] = 0;
  }
}

/**
 * 生成遮罩贴图（R = 皮肤，G = 头发）并测量原色。
 * 画布第 0 行是图片顶部，对应 UV 的 v = 1（贴图 flipY），写入时倒过来。
 */
function analyze(img, withHair) {
  const n = MASK_SIZE;
  const d = pixels(img, n);
  const skin = new Uint8Array(n * n);
  const hair = new Uint8Array(n * n);
  const lip = new Uint8Array(n * n);
  const ambiguous = new Uint8Array(n * n);
  const roots = new Uint8Array(n * n);
  const broadSkin = new Uint8Array(n * n);
  for (let i = 0; i < n * n; i++) {
    const h = hsv(d[i * 4] / 255, d[i * 4 + 1] / 255, d[i * 4 + 2] / 255);
    skin[i] = skinScore(h) > 0.5 ? 1 : 0;
    hair[i] = hairScore(h) > 0.5 ? 1 : 0;
    lip[i] = lipScore(h) > 0.5 ? 1 : 0;
    ambiguous[i] = ambiguousScore(h) > 0.5 ? 1 : 0;
    roots[i] = withHair && rootsScore(h) > 0.5 ? 1 : 0;
    broadSkin[i] = broadSkinScore(h) > 0.5 ? 1 : 0;
  }
  // 去掉零星的小块"皮肤"（如米白衣服上的杂点），再闭运算：先膨胀再腐蚀，填掉皮肤里的小块暗区
  removeSmallIslands(skin, n, 300);
  const closed = morph(morph(skin, n, 4, true), n, 4, false);
  for (let i = 0; i < n * n; i++) if (closed[i] && !skin[i] && lip[i]) closed[i] = 0;
  // 头发同样闭运算，补上发丝间的高光/阴影空洞，否则染色会斑驳
  const hairClosed = withHair ? morph(morph(hair, n, 3, true), n, 3, false) : new Uint8Array(n * n);
  // 眼眶的睫毛线也是深色，会被当成头发（染出彩色眼线），这类小块直接去掉
  removeSmallIslands(hairClosed, n, 400);
  const label = growRegions(closed, hairClosed, ambiguous, roots, n);

  const mask = new Uint8Array(n * n * 4);
  const skinSum = [0, 0, 0];
  let skinN = 0;
  let hairSum = 0;
  let hairN = 0;
  let irisSum = 0;
  let irisN = 0;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      const u = (x + 0.5) / n;
      const v = 1 - (y + 0.5) / n;
      const inBox = (b) => u > b[0] && u < b[2] && v > b[1] && v < b[3];
      const inEye = withHair && (inBox(EYE_BOX) || inBox(MOUTH_BOX));
      // 头部贴图里剩下的肤色系像素（眼睑、嘴唇、下颌阴影）也算皮肤，否则换深肤色后会留浅色圈
      const leftover = withHair && label[i] === 0 && broadSkin[i];
      const s = (label[i] === 1 || leftover) && !inEye ? 1 : 0;
      const hr = label[i] === 2 && !inEye ? 1 : 0;
      const o = ((n - 1 - y) * n + x) * 4;
      mask[o] = s * 255;
      mask[o + 1] = hr * 255;
      mask[o + 3] = 255;
      const [r, g, b] = [toLinear(d[i * 4] / 255), toLinear(d[i * 4 + 1] / 255), toLinear(d[i * 4 + 2] / 255)];
      if (skin[i] && s) { skinSum[0] += r; skinSum[1] += g; skinSum[2] += b; skinN++; }
      if (hr) { hairSum += lum(r, g, b); hairN++; }
      if (Math.hypot(u - IRIS.u, v - IRIS.v) < IRIS.r * 0.8) { irisSum += lum(r, g, b); irisN++; }
    }
  }
  const tex = new THREE.DataTexture(mask, n, n);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return {
    tex,
    skin: skinN ? new THREE.Color(skinSum[0] / skinN, skinSum[1] / skinN, skinSum[2] / skinN) : null,
    hair: hairN ? hairSum / hairN : null,
    iris: irisN ? irisSum / irisN : null,
  };
}

// 头发卡片（透明贴图）的平均亮度
function hairCardLum(img) {
  const d = pixels(img, 256);
  let s = 0;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 128) continue;
    s += lum(toLinear(d[i] / 255), toLinear(d[i + 1] / 255), toLinear(d[i + 2] / 255));
    n++;
  }
  return n ? s / n : null;
}

// ---------------------------------------------------------------- 着色器

const GLSL_COMMON = /* glsl */ `
uniform sampler2D uMask; uniform float uReady;
uniform vec3 uSkinRatio; uniform float uSkinAmt;
uniform vec3 uHairColor; uniform float uHairRef; uniform float uHairAmt;
uniform vec3 uEyeColor; uniform float uEyeRef; uniform float uEyeAmt;
uniform float uClothHue; uniform float uClothSat;
vec3 lkHsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + 1e-10)), d / (q.x + 1e-10), q.x);
}
vec3 lkRgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}
float lkLum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
`;

const FRAGMENT = {
  head: /* glsl */ `
    vec4 m = texture2D(uMask, vMapUv) * uReady;
    c = mix(c, c * uSkinRatio, m.r * uSkinAmt);
    c = mix(c, uHairColor * (lkLum(c) / uHairRef), m.g * uHairAmt);
    // 虹膜：眼球贴图正中的圆；保留高光（亮且不饱和）
    float iris = 1.0 - smoothstep(${(IRIS.r * 0.85).toFixed(4)}, ${IRIS.r.toFixed(4)}, distance(vMapUv, vec2(${IRIS.u}, ${IRIS.v})));
    float highlight = smoothstep(0.7, 0.9, h.z) * (1.0 - smoothstep(0.1, 0.25, h.y));
    c = mix(c, uEyeColor * (lkLum(c) / uEyeRef), iris * (1.0 - highlight) * uEyeAmt);`,
  body: /* glsl */ `
    float skin = texture2D(uMask, vMapUv).r * uReady;
    c = mix(c, c * uSkinRatio, skin * uSkinAmt);
    if (abs(uClothHue) + abs(uClothSat) > 0.001) {
      vec3 h2 = vec3(fract(h.x + uClothHue + 1.0), clamp(h.y * (1.0 + uClothSat), 0.0, 1.0), h.z);
      c = mix(c, pow(lkRgb(h2), vec3(2.2)), (1.0 - skin) * uReady);
    }`,
  hair: /* glsl */ `
    c = mix(c, uHairColor * (lkLum(c) / uHairRef), uHairAmt);`,
};

/**
 * @param materials { head, body, hair }：Rocketbox 的三个材质
 * @returns { apply(color) }，color: { skin, hair, eye: '#rrggbb' | null, clothHue: -180…180, clothSat: -1…1 }
 */
export function createColorizer(materials) {
  const shared = {
    uSkinRatio: { value: new THREE.Vector3(1, 1, 1) }, uSkinAmt: { value: 0 },
    uHairColor: { value: new THREE.Color() }, uHairAmt: { value: 0 },
    uEyeColor: { value: new THREE.Color() }, uEyeRef: { value: 0.05 }, uEyeAmt: { value: 0 },
    uClothHue: { value: 0 }, uClothSat: { value: 0 },
  };
  // 每个材质自己的遮罩和头发参考亮度
  const own = {};
  for (const kind of ['head', 'body', 'hair']) {
    own[kind] = { uMask: { value: null }, uReady: { value: 0 }, uHairRef: { value: 0.25 } };
  }

  for (const [kind, mat] of Object.entries(materials)) {
    if (!mat?.map) continue;
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, shared, own[kind]);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${GLSL_COMMON}`)
        .replace('#include <map_fragment>', `#include <map_fragment>
  {
    vec3 c = diffuseColor.rgb;
    vec3 h = lkHsv(pow(max(c, 0.0), vec3(1.0 / 2.2)));
    ${FRAGMENT[kind]}
    diffuseColor.rgb = max(c, 0.0);
  }`);
    };
    mat.customProgramCacheKey = () => `look-${kind}`;
    mat.needsUpdate = true;
  }

  let refSkin = null;
  let current = {};
  const ready = (async () => {
    const [headImg, bodyImg, hairImg] = await Promise.all(
      ['head', 'body', 'hair'].map((k) => whenLoaded(materials[k]?.map)),
    );
    if (headImg) {
      const a = analyze(headImg, true);
      own.head.uMask.value = a.tex;
      own.head.uReady.value = 1;
      if (a.hair) own.head.uHairRef.value = a.hair;
      if (a.iris) shared.uEyeRef.value = a.iris;
      refSkin = a.skin;
    }
    if (bodyImg) {
      const a = analyze(bodyImg, false);
      own.body.uMask.value = a.tex;
      own.body.uReady.value = 1;
      refSkin ??= a.skin;
    }
    if (hairImg) {
      const l = hairCardLum(hairImg);
      if (l) own.hair.uHairRef.value = l;
    }
    apply(current);
  })().catch((err) => console.error('换色遮罩生成失败', err));

  function apply(color = {}) {
    current = color;
    if (color.skin && refSkin) {
      const t = new THREE.Color(color.skin); // sRGB 十六进制 → 线性
      const k = (c, r) => THREE.MathUtils.clamp(c / r, 0.12, 2.2);
      shared.uSkinRatio.value.set(k(t.r, refSkin.r), k(t.g, refSkin.g), k(t.b, refSkin.b));
      shared.uSkinAmt.value = 1;
    } else {
      shared.uSkinAmt.value = 0;
    }
    shared.uHairAmt.value = color.hair ? 1 : 0;
    if (color.hair) shared.uHairColor.value.set(color.hair);
    shared.uEyeAmt.value = color.eye ? 1 : 0;
    if (color.eye) shared.uEyeColor.value.set(color.eye);
    shared.uClothHue.value = (color.clothHue ?? 0) / 360;
    shared.uClothSat.value = color.clothSat ?? 0;
  }

  return { apply, ready };
}

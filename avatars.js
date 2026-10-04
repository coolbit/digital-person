// 数字人模型加载。两种来源统一成同一个接口，供 main.js 驱动：
//   { scene, humanoid, axisSign, update(dt), setFace(blendshapes), dispose() }
// - humanoid：three-vrm 的 VRMHumanoid，通过 getNormalizedBoneNode() 写骨骼旋转
// - axisSign：Kalidokit 按 VRM 0.x（模型朝 -Z）调好，朝 +Z 的模型要翻转 X/Z 轴
// - setFace：传入 MediaPipe 的 blendshape 分数 { eyeBlinkLeft: 0.8, ... }
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { VRMLoaderPlugin, VRMUtils, VRMHumanoid } from '@pixiv/three-vrm';
import { createSculptor } from './sculpt.js';
import { createColorizer } from './colors.js';

const clamp01 = (v) => THREE.MathUtils.clamp(v, 0, 1);

// MediaPipe 的 blendshape 分数普遍偏保守（例如挑眉、瞪眼、鼓腮很难超过 0.5），
// 按 ARKit 名称放大到接近满幅；未列出的保持 1。
// browDown、mouthPucker 平时就容易误报偏高（微笑时皱眉、闭嘴时撅嘴），不放大
const GAIN = {
  browInnerUp: 1.6, browOuterUpLeft: 1.6, browOuterUpRight: 1.6,
  eyeWideLeft: 2.2, eyeWideRight: 2.2, cheekPuff: 2.5, cheekSquintLeft: 1.4, cheekSquintRight: 1.4,
  jawOpen: 1.3, jawLeft: 1.5, jawRight: 1.5, jawForward: 1.5,
  mouthFunnel: 1.6, mouthLeft: 1.5, mouthRight: 1.5,
  mouthRollLower: 1.5, mouthRollUpper: 1.5, mouthShrugLower: 1.4, mouthShrugUpper: 1.4,
  mouthPressLeft: 1.4, mouthPressRight: 1.4, mouthStretchLeft: 1.5, mouthStretchRight: 1.5,
  mouthDimpleLeft: 1.5, mouthDimpleRight: 1.5, mouthFrownLeft: 1.6, mouthFrownRight: 1.6,
  mouthLowerDownLeft: 1.4, mouthLowerDownRight: 1.4, mouthUpperUpLeft: 1.3, mouthUpperUpRight: 1.3,
  noseSneerLeft: 1.6, noseSneerRight: 1.6,
};

// 眨眼分数在睁眼时也有 0.1–0.3，闭眼时又到不了 1，拉伸一下才能完全睁开/闭合
const calibrate = (name, v) =>
  name.startsWith('eyeBlink') ? clamp01((v - 0.2) / 0.5) : clamp01(v * (GAIN[name] ?? 1));

// 镜像跟随：本人的左边驱动数字人的右边
const mirrorName = (name) =>
  name.replace(/Left|Right/g, (s) => (s === 'Left' ? 'Right' : 'Left'));

// ---------------------------------------------------------------- VRM

export async function loadVRM(url, onProgress) {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  const gltf = await loader.loadAsync(url, onProgress);
  const vrm = gltf.userData.vrm;
  VRMUtils.removeUnnecessaryVertices(gltf.scene);
  VRMUtils.combineSkeletons(gltf.scene);
  VRMUtils.rotateVRM0(vrm);
  vrm.scene.traverse((o) => { o.frustumCulled = false; });

  const current = {};
  const setExpression = (name, value, lerp = 0.5) => {
    const em = vrm.expressionManager;
    if (!em?.getExpression(name)) return;
    current[name] = THREE.MathUtils.lerp(current[name] ?? 0, value, lerp);
    em.setValue(name, current[name]);
  };

  return {
    scene: vrm.scene,
    humanoid: vrm.humanoid,
    sculpt: null, // VRM 没有统一的面部骨骼，暂不支持捏脸
    colors: null, // VRM 用 MToon 材质，贴图结构各异，暂不支持换色
    axisSign: vrm.meta?.metaVersion === '0' ? 1 : -1,
    lookAt: (target) => { if (vrm.lookAt) vrm.lookAt.target = target; },
    update: (dt) => vrm.update(dt),
    // VRM 只有少量预设表情，把 ARKit 分数折算过去
    setFace(bs) {
      setExpression('blinkRight', calibrate('eyeBlinkLeft', bs.eyeBlinkLeft ?? 0), 0.6);
      setExpression('blinkLeft', calibrate('eyeBlinkRight', bs.eyeBlinkRight ?? 0), 0.6);
      setExpression('aa', clamp01((bs.jawOpen ?? 0) * 1.6));
      setExpression('ou', clamp01((bs.mouthPucker ?? 0) * 1.2));
      setExpression('oh', clamp01((bs.mouthFunnel ?? 0) * 1.5));
      const smile = ((bs.mouthSmileLeft ?? 0) + (bs.mouthSmileRight ?? 0)) / 2;
      setExpression('happy', clamp01((smile - 0.2) * 1.6));
    },
    dispose: () => VRMUtils.deepDispose(vrm.scene),
  };
}

// ---------------------------------------------------------------- Microsoft Rocketbox (FBX, 3ds Max Biped 骨骼)

const BIP = 'Bip01_';
const BLANK_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';
const FINGERS = { Thumb: 0, Index: 1, Middle: 2, Ring: 3, Little: 4 };

function rocketboxBoneMap() {
  const map = {
    hips: 'Pelvis', spine: 'Spine', chest: 'Spine1', upperChest: 'Spine2', neck: 'Neck', head: 'Head',
    leftEye: 'LEye', rightEye: 'REye',
  };
  for (const [side, s] of [['left', 'L'], ['right', 'R']]) {
    Object.assign(map, {
      [`${side}Shoulder`]: `${s}_Clavicle`,
      [`${side}UpperArm`]: `${s}_UpperArm`,
      [`${side}LowerArm`]: `${s}_Forearm`,
      [`${side}Hand`]: `${s}_Hand`,
      [`${side}UpperLeg`]: `${s}_Thigh`,
      [`${side}LowerLeg`]: `${s}_Calf`,
      [`${side}Foot`]: `${s}_Foot`,
      [`${side}Toes`]: `${s}_Toe0`,
    });
    for (const [finger, n] of Object.entries(FINGERS)) {
      const segs = finger === 'Thumb' ? ['Metacarpal', 'Proximal', 'Distal'] : ['Proximal', 'Intermediate', 'Distal'];
      segs.forEach((seg, i) => { map[`${side}${finger}${seg}`] = `${s}_Finger${n}${i ? i : ''}`; });
    }
  }
  return map;
}

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();

// 旋转 bone，使 bone→child 在世界空间里指向 dir（最小旋转，不引入扭转）
function aimBone(bone, child, dir) {
  if (!bone || !child) return;
  bone.updateWorldMatrix(true, true);
  const from = child.getWorldPosition(_v2).sub(bone.getWorldPosition(_v1)).normalize();
  const delta = _q1.setFromUnitVectors(from, dir);
  const world = bone.getWorldQuaternion(_q2).premultiply(delta);
  const parentWorld = bone.parent.getWorldQuaternion(new THREE.Quaternion());
  bone.quaternion.copy(parentWorld.invert().multiply(world));
  bone.updateWorldMatrix(false, true);
}

// Kalidokit 假定静止姿势是 T-pose，Rocketbox 原始是 A-pose，先摆成 T-pose 再建人形骨骼
function toTPose(get) {
  for (const [s, x] of [['L', 1], ['R', -1]]) {
    const out = new THREE.Vector3(x, 0, 0);
    aimBone(get(`${s}_UpperArm`), get(`${s}_Forearm`), out);
    aimBone(get(`${s}_Forearm`), get(`${s}_Hand`), out);
    aimBone(get(`${s}_Hand`), get(`${s}_Finger2`), out);
    for (let n = 1; n <= 4; n++) {
      aimBone(get(`${s}_Finger${n}`), get(`${s}_Finger${n}1`), out);
      aimBone(get(`${s}_Finger${n}1`), get(`${s}_Finger${n}2`), out);
    }
    const down = new THREE.Vector3(0, -1, 0);
    aimBone(get(`${s}_Thigh`), get(`${s}_Calf`), down);
    aimBone(get(`${s}_Calf`), get(`${s}_Foot`), down);
  }
}

// 只保留 ARKit 52 个表情（AK_xx_Name），其余 100 多个 viseme/FACS 变形会白白占用显存
function keepArkitMorphs(mesh) {
  const dict = mesh.morphTargetDictionary;
  if (!dict) return {};
  const keep = [];
  const index = {};
  for (const [key, i] of Object.entries(dict)) {
    const m = key.match(/AK_\d+_(\w+)$/);
    if (!m) continue;
    index[m[1][0].toLowerCase() + m[1].slice(1)] = keep.length;
    keep.push(i);
  }
  const attrs = mesh.geometry.morphAttributes;
  for (const k of Object.keys(attrs)) attrs[k] = keep.map((i) => attrs[k][i]);
  mesh.morphTargetDictionary = index;
  mesh.morphTargetInfluences = new Array(keep.length).fill(0);
  return index;
}

function upgradeMaterial(old) {
  const isAlpha = !!old.alphaMap || /opacity/i.test(old.name);
  const mat = new THREE.MeshPhysicalMaterial({
    name: old.name,
    map: old.map,
    normalMap: old.normalMap,
    roughness: isAlpha ? 0.7 : 0.55,
    metalness: 0,
    // 皮肤表面的柔光
    sheen: isAlpha ? 0 : 0.25,
    sheenRoughness: 0.8,
    sheenColor: new THREE.Color(0xffd9c7),
    side: isAlpha ? THREE.DoubleSide : THREE.FrontSide,
    alphaTest: isAlpha ? 0.35 : 0,
  });
  if (mat.normalMap) mat.normalScale.set(0.8, 0.8);
  old.dispose();
  return mat;
}

/**
 * @param dir    模型目录，例如 ./models/rocketbox/Female_Adult_01
 * @param name   例如 Female_Adult_01
 */
export async function loadRocketbox(dir, name, onProgress) {
  const manager = new THREE.LoadingManager();
  // FBX 里记录的是作者机器上的 TGA 绝对路径，改指向本地转好的 JPG/PNG
  manager.setURLModifier((url) => {
    if (!/\.tga$/i.test(url)) return url;
    const base = url.split(/[\\/]/).pop().replace(/\.tga$/i, '');
    // 高光贴图没有下载（PBR 材质用不到），给个 1×1 占位图避免 404
    if (/specular/i.test(base)) return BLANK_PNG;
    return `${dir}/textures/${base}.${/opacity/i.test(base) ? 'png' : 'jpg'}`;
  });
  manager.addHandler(/\.tga$/i, new THREE.TextureLoader(manager));

  const root = await new FBXLoader(manager).loadAsync(`${dir}/${name}_facial.fbx`, onProgress);
  root.scale.setScalar(0.01); // 厘米 → 米
  root.updateMatrixWorld(true);

  const bones = {};
  root.traverse((o) => { if (o.isBone) bones[o.name] = o; });
  const get = (n) => bones[BIP + n];

  // Biped 的锁骨挂在 Neck 下、大腿挂在 Spine 下；改挂到 VRM 期望的父骨骼上，
  // 否则转头时手臂会跟着甩，弯腰时腿会跟着动。attach() 保持世界变换不变，蒙皮不受影响。
  get('Spine2')?.attach(get('L_Clavicle'));
  get('Spine2')?.attach(get('R_Clavicle'));
  get('Pelvis')?.attach(get('L_Thigh'));
  get('Pelvis')?.attach(get('R_Thigh'));
  toTPose(get);
  // 捏脸要记录面部骨骼的静止状态，必须在模型还处于静止姿势时创建
  const sculptor = createSculptor(bones);

  let faceMesh = null;
  let morphIndex = {};
  const materials = {};
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.frustumCulled = false;
    o.material = Array.isArray(o.material) ? o.material.map(upgradeMaterial) : upgradeMaterial(o.material);
    for (const m of [].concat(o.material)) {
      const kind = /_head$/i.test(m.name) ? 'head' : /_body$/i.test(m.name) ? 'body' : /opacity/i.test(m.name) ? 'hair' : null;
      if (kind) materials[kind] = m;
    }
    if (o.morphTargetDictionary && !faceMesh) {
      faceMesh = o;
      morphIndex = keepArkitMorphs(o);
    }
  });

  const humanBones = {};
  for (const [vrmName, bipName] of Object.entries(rocketboxBoneMap())) {
    const node = get(bipName);
    if (node) humanBones[vrmName] = { node };
  }

  // 归一化骨骼是按建立时的世界坐标记录的，模型此时必须已在原点、朝 +Z、单位为米
  const group = new THREE.Group();
  group.add(root);
  const humanoid = new VRMHumanoid(humanBones);
  group.add(humanoid.normalizedHumanBonesRoot);

  // 模型的 eyeLook 变形几乎不动眼球，改为直接转眼球骨骼。
  // 归一化骨骼在世界坐标系下：绕 +Y 转向模型左侧（+X），绕 -X 转向上方
  const eyes = { Left: humanoid.getNormalizedBoneNode('leftEye'), Right: humanoid.getNormalizedBoneNode('rightEye') };
  const _eyeQ = new THREE.Quaternion();
  const _eyeE = new THREE.Euler();
  function lookEyes(bs) {
    for (const [side, node] of Object.entries(eyes)) {
      if (!node) continue;
      const out = bs[`eyeLookOut${side}`] ?? 0;
      const inn = bs[`eyeLookIn${side}`] ?? 0;
      // 左眼向外 = 朝 +X，右眼向外 = 朝 -X
      const yaw = (side === 'Left' ? out - inn : inn - out) * 0.45;
      const pitch = -((bs[`eyeLookUp${side}`] ?? 0) - (bs[`eyeLookDown${side}`] ?? 0)) * 0.3;
      _eyeQ.setFromEuler(_eyeE.set(pitch, yaw, 0));
      node.quaternion.slerp(_eyeQ, 0.5);
    }
  }

  return {
    scene: group,
    humanoid,
    sculpt: sculptor,
    colors: createColorizer(materials),
    axisSign: -1,
    lookAt: () => {},
    update: () => humanoid.update(),
    setFace(bs) {
      if (!faceMesh) return;
      const inf = faceMesh.morphTargetInfluences;
      const mirrored = {};
      for (const [name, score] of Object.entries(bs)) {
        const m = mirrorName(name);
        mirrored[m] = score;
        const i = morphIndex[m];
        if (i !== undefined) inf[i] = THREE.MathUtils.lerp(inf[i], calibrate(name, score), 0.6);
      }
      lookEyes(mirrored);
    },
    dispose() {
      root.traverse((o) => {
        if (!o.isMesh) return;
        o.geometry.dispose();
        for (const m of [].concat(o.material)) {
          m.map?.dispose();
          m.normalMap?.dispose();
          m.dispose();
        }
      });
    },
  };
}

// 跟踪数据的预处理：关键点滤波、手/脸裁剪区域、手指弯曲求解
import * as THREE from 'three';

// ---------------------------------------------------------------- One Euro 滤波
// 慢速时强平滑去抖，快速时放开减少延迟，比固定系数的指数平滑更跟手

const smoothingFactor = (cutoff, dt) => {
  const r = 2 * Math.PI * cutoff * dt;
  return r / (r + 1);
};

class OneEuro {
  constructor(minCutoff, beta, dCutoff = 1) {
    Object.assign(this, { minCutoff, beta, dCutoff, x: null, dx: 0, t: null });
  }

  filter(v, t) {
    if (this.t === null) {
      this.x = v;
      this.t = t;
      return v;
    }
    const dt = Math.max(t - this.t, 1e-3);
    this.t = t;
    const a = smoothingFactor(this.dCutoff, dt);
    this.dx = a * ((v - this.x) / dt) + (1 - a) * this.dx;
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += smoothingFactor(cutoff, dt) * (v - this.x);
    return this.x;
  }
}

export class LandmarkFilter {
  constructor(minCutoff = 1.5, beta = 4) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.filters = [];
  }

  /** @param t 秒 */
  apply(landmarks, t) {
    return landmarks.map((p, i) => {
      const f = (this.filters[i] ??= [0, 1, 2].map(() => new OneEuro(this.minCutoff, this.beta)));
      return { ...p, x: f[0].filter(p.x, t), y: f[1].filter(p.y, t), z: f[2].filter(p.z, t) };
    });
  }

  reset() {
    this.filters = [];
  }
}

// ---------------------------------------------------------------- 裁剪区域
// 人站远时，手和脸在整幅画面里只有几十像素，手部/面部模型直接检测不到。
// 用身体关键点定位后裁出一块正方形放大，再交给专门的模型。

const px = (p, w, h) => ({ x: p.x * w, y: p.y * h });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const visible = (p, min = 0.3) => p && (p.visibility ?? 1) > min;

/** @returns {{x, y, size}} 像素坐标的正方形，或 null */
export function faceRoi(pose2D, w, h) {
  // 只要求鼻子可见；侧脸时远侧眼睛/耳朵的可见度很低，但位置估计仍可用
  if (!visible(pose2D[0], 0.5)) return null;
  const pts = [0, 2, 5, 9, 10].map((i) => px(pose2D[i], w, h));
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  const ears = dist(px(pose2D[7], w, h), px(pose2D[8], w, h));
  const eyes = dist(pts[1], pts[2]);
  const shoulders = dist(px(pose2D[11], w, h), px(pose2D[12], w, h));
  const size = Math.max(2.4 * ears, 5 * eyes, 0.7 * shoulders, 64);
  return { x: cx - size / 2, y: cy - size / 2, size };
}

// 本人左手 = 姿态点 15/17/19/21；镜像后驱动数字人的右手
const HAND_POINTS = { Right: [15, 17, 19, 21], Left: [16, 18, 20, 22] };

export function handRoi(pose2D, side, w, h) {
  const [wi, pi, ii] = HAND_POINTS[side];
  if (!visible(pose2D[wi])) return null;
  const wrist = px(pose2D[wi], w, h);
  const knuckles = { x: (pose2D[pi].x + pose2D[ii].x) / 2 * w, y: (pose2D[pi].y + pose2D[ii].y) / 2 * h };
  const len = dist(wrist, knuckles);
  const shoulders = dist(px(pose2D[11], w, h), px(pose2D[12], w, h));
  const size = Math.max(4.5 * len, 0.6 * shoulders, 64);
  // 手掌中心在手腕往指尖方向一点
  const cx = wrist.x + (knuckles.x - wrist.x) * 0.9;
  const cy = wrist.y + (knuckles.y - wrist.y) * 0.9;
  return { x: cx - size / 2, y: cy - size / 2, size };
}

export function drawRoi(ctx, source, roi) {
  const s = ctx.canvas.width;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, s, s);
  ctx.drawImage(source, roi.x, roi.y, roi.size, roi.size, 0, 0, s, s);
}

/** 裁剪图上的归一化坐标 → 整幅画面的归一化坐标（用于画骨架） */
export function roiToFrame(landmarks, roi, w, h) {
  return landmarks.map((p) => ({ ...p, x: (roi.x + p.x * roi.size) / w, y: (roi.y + p.y * roi.size) / h }));
}

// ---------------------------------------------------------------- 手掌朝向

// 摄像头坐标（x 向右、y 向下、z 向远）→ 数字人世界坐标（朝 +Z 面对镜头）。
// 三个轴同时取反恰好等于"镜像 + 转过来面对你"
const toAvatar = (p) => new THREE.Vector3(-p.x, -p.y, -p.z);

/**
 * 手掌在数字人世界坐标中的旋转（相对 T-pose 时掌心朝下、手指朝外的静止姿势）。
 * 由手指方向（手腕→中指根）和掌心法线（食指根、小指根张成的平面）确定，包含手腕扭转。
 */
export function handOrientation(world, side) {
  const wrist = toAvatar(world[0]);
  const dir = toAvatar(world[9]).sub(wrist).normalize();
  const index = toAvatar(world[5]).sub(wrist);
  const pinky = toAvatar(world[17]).sub(wrist);
  // 叉乘顺序让两只手在掌心朝下时法线都指向 -Y
  const normal = side === 'Right' ? index.cross(pinky) : pinky.cross(index);
  normal.addScaledVector(dir, -normal.dot(dir)).normalize();
  const target = new THREE.Matrix4().makeBasis(dir, normal, dir.clone().cross(normal));

  const restDir = new THREE.Vector3(side === 'Right' ? -1 : 1, 0, 0);
  const restNormal = new THREE.Vector3(0, -1, 0);
  const rest = new THREE.Matrix4().makeBasis(restDir, restNormal, restDir.clone().cross(restNormal));
  return new THREE.Quaternion().setFromRotationMatrix(target.multiply(rest.transpose()));
}

// ---------------------------------------------------------------- 身体：直接 3D 重定向
// 不再用 Kalidokit 的欧拉角近似：每段骨骼直接对准 MediaPipe 测到的 3D 方向。
// 输出的都是"世界坐标下相对静止姿势（T-pose、面朝 +Z）的旋转 Δ"，由调用方换算成局部旋转。

const _m1 = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();

/** 由 x 轴和大致的 y 轴构造正交基，返回把单位基 (X, Y, Z) 转到它的旋转 */
export function frameFrom(x, up) {
  const X = x.clone().normalize();
  const Z = new THREE.Vector3().crossVectors(X, up).normalize();
  const Y = new THREE.Vector3().crossVectors(Z, X);
  return new THREE.Quaternion().setFromRotationMatrix(_m1.makeBasis(X, Y, Z));
}

/** 把静止基 (d0, b0) 转到目标基 (d, b) 的旋转；d 为骨骼方向，b 为弯曲方向（与 d 正交） */
function basisRotation(d0, b0, d, b) {
  const rest = _m1.makeBasis(d0, b0, d0.clone().cross(b0));
  const target = _m2.makeBasis(d, b, d.clone().cross(b));
  return new THREE.Quaternion().setFromRotationMatrix(target.multiply(rest.transpose()));
}

/**
 * 上臂/大腿：方向对准 d，并让肘/膝的弯曲落在真实的弯曲平面里（否则前臂会拧麻花）。
 * 手臂几乎伸直时弯曲平面不确定，平滑退化为最小旋转。
 * @param d0 静止时骨骼方向；b0 静止时关节弯曲的方向（手臂朝前 +Z，膝盖朝后 -Z）
 * @param d 目标骨骼方向；next 下一段（前臂/小腿）的目标方向
 */
function limbRotation(d0, b0, d, next) {
  const swing = new THREE.Quaternion().setFromUnitVectors(d0, d);
  const bendVec = next.clone().addScaledVector(d, -next.dot(d));
  const bendAngle = d.angleTo(next);
  if (bendVec.lengthSq() < 1e-8) return swing;
  const restBend = b0.clone().addScaledVector(d0, -b0.dot(d0)).normalize();
  const hinge = basisRotation(d0, restBend, d, bendVec.normalize());
  const w = THREE.MathUtils.smoothstep(bendAngle, 0.2, 0.6);
  return swing.slerp(hinge, w);
}

/** 下一段（前臂/小腿）：在父骨骼基础上的最小旋转，相当于纯铰链 */
function childRotation(parentDelta, d0, d) {
  const current = d0.clone().applyQuaternion(parentDelta);
  return new THREE.Quaternion().setFromUnitVectors(current, d).multiply(parentDelta);
}

const FORWARD = new THREE.Vector3(0, 0, 1);
const BACKWARD = new THREE.Vector3(0, 0, -1);
const UP = new THREE.Vector3(0, 1, 0);

// 镜像：本人左侧（奇数编号）驱动数字人右侧
const SIDES = {
  right: { shoulder: 11, elbow: 13, wrist: 15, hip: 23, knee: 25, ankle: 27, heel: 29, toe: 31 },
  left: { shoulder: 12, elbow: 14, wrist: 16, hip: 24, knee: 26, ankle: 28, heel: 30, toe: 32 },
};

/**
 * @param world   姿态模型的世界坐标关键点（米）
 * @param restDir 数字人静止姿势下各骨骼指向子骨骼的方向（世界坐标）
 * @param flags   { hips: 髋部可见, legs: 腿部可见 }
 * @returns { 骨骼名: 世界坐标下的 Δ 旋转 }
 */
export function solveBody(world, restDir, flags) {
  const P = (i) => toAvatar(world[i]);
  const mid = (a, b) => P(a).add(P(b)).multiplyScalar(0.5);
  const out = {};

  // 躯干：肩线定胸口朝向，髋线定骨盆朝向，脊柱取两者之间
  const up = mid(11, 12).sub(mid(23, 24));
  const chest = frameFrom(P(12).sub(P(11)), flags.hips ? up : UP);
  const hips = flags.hips ? frameFrom(P(24).sub(P(23)), up) : new THREE.Quaternion();
  out.hips = hips;
  out.spine = hips.clone().slerp(chest, 0.5);
  out.chest = chest;

  for (const [side, j] of Object.entries(SIDES)) {
    const upper = P(j.elbow).sub(P(j.shoulder)).normalize();
    const lower = P(j.wrist).sub(P(j.elbow)).normalize();
    const ua = limbRotation(restDir[`${side}UpperArm`], FORWARD, upper, lower);
    out[`${side}UpperArm`] = ua;
    out[`${side}LowerArm`] = childRotation(ua, restDir[`${side}LowerArm`], lower);

    if (flags.legs) {
      const thigh = P(j.knee).sub(P(j.hip)).normalize();
      const shin = P(j.ankle).sub(P(j.knee)).normalize();
      const ul = limbRotation(restDir[`${side}UpperLeg`], BACKWARD, thigh, shin);
      out[`${side}UpperLeg`] = ul;
      const ll = childRotation(ul, restDir[`${side}LowerLeg`], shin);
      out[`${side}LowerLeg`] = ll;
      if (restDir[`${side}Foot`]) {
        out[`${side}Foot`] = childRotation(ll, restDir[`${side}Foot`], P(j.toe).sub(P(j.heel)).normalize());
      }
    }
  }
  return out;
}

/** 头部朝向（世界 Δ）。优先用面部网格（裁剪图归一化坐标），否则用姿态的耳朵/眼睛/嘴 */
export function solveHead(faceLandmarks, poseWorld) {
  if (faceLandmarks) {
    const F = (i) => toAvatar(faceLandmarks[i]);
    // 33 = 本人右眼外角，263 = 本人左眼外角；10 = 额头，152 = 下巴
    return frameFrom(F(33).sub(F(263)), F(10).sub(F(152)));
  }
  const P = (i) => toAvatar(poseWorld[i]);
  const eyes = P(2).add(P(5)).multiplyScalar(0.5);
  const mouth = P(9).add(P(10)).multiplyScalar(0.5);
  return frameFrom(P(8).sub(P(7)), eyes.sub(mouth));
}

// ---------------------------------------------------------------- 手指：直接 3D 重定向
// 每个指节对准手部 3D 关键点的方向（含弯曲和左右张开），拇指也一样，不再用 Kalidokit。

export const FINGER_CHAINS = {
  Thumb: [[1, 2, 'Metacarpal'], [2, 3, 'Proximal'], [3, 4, 'Distal']],
  Index: [[5, 6, 'Proximal'], [6, 7, 'Intermediate'], [7, 8, 'Distal']],
  Middle: [[9, 10, 'Proximal'], [10, 11, 'Intermediate'], [11, 12, 'Distal']],
  Ring: [[13, 14, 'Proximal'], [14, 15, 'Intermediate'], [15, 16, 'Distal']],
  Little: [[17, 18, 'Proximal'], [18, 19, 'Intermediate'], [19, 20, 'Distal']],
};

/**
 * @param side      'left' | 'right'（数字人的左右）
 * @param handDelta 手掌的世界 Δ（handOrientation 的结果）
 * @returns { 骨骼名: 世界 Δ }，按每根手指从根到尖的顺序
 */
export function solveFingerBones(world, side, handDelta, restDir) {
  const P = (i) => toAvatar(world[i]);
  const out = {};
  for (const [finger, segs] of Object.entries(FINGER_CHAINS)) {
    let parent = handDelta;
    for (const [a, b, seg] of segs) {
      const name = `${side}${finger}${seg}`;
      if (!restDir[name]) break;
      parent = childRotation(parent, restDir[name], P(b).sub(P(a)).normalize());
      out[name] = parent;
    }
  }
  return out;
}

/**
 * 摆正手掌时的扭转如果全压在手腕上，腕部蒙皮会拧成麻花；真实人体是小臂（尺桡骨）在转。
 * 把手相对小臂的局部旋转分解为"绕小臂轴的扭转 × 其余"，返回扭转的一部分，由调用方挪给小臂。
 * @param local 手相对小臂的局部旋转；axis 小臂骨骼方向（局部坐标）
 */
export function twistPart(local, axis, amount) {
  const r = new THREE.Vector3(local.x, local.y, local.z);
  const p = axis.clone().multiplyScalar(r.dot(axis));
  const twist = new THREE.Quaternion(p.x, p.y, p.z, local.w);
  if (twist.lengthSq() < 1e-10) return new THREE.Quaternion();
  twist.normalize();
  return new THREE.Quaternion().slerp(twist, amount);
}

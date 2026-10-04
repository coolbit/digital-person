// 捏脸：通过移动/缩放 Rocketbox 的面部骨骼改变脸型。
// 面部骨骼不参与动作跟随，表情走的是变形（morph），所以捏脸和跟随、表情互不干扰。
import * as THREE from 'three';

// move 单位是厘米（世界坐标，模型面朝 +Z、Y 向上），按滑块值 -1…1 线性缩放；
// pair 表示左右成对的骨骼，x 方向自动镜像（正值 = 向外）；scale 是均匀缩放的增量
export const SCULPT_PARAMS = [
  { group: '脸型', id: 'headSize', label: '头部大小', ops: [{ bones: ['Head'], scale: 0.08 }] },
  { group: '脸型', id: 'cheekWidth', label: '颧骨宽度', ops: [{ pair: 'Cheek', move: [1.2, 0.2, 0.3] }] },
  { group: '脸型', id: 'jawWidth', label: '下颌宽度', ops: [{ pair: 'Masseter', move: [1.3, 0, 0] }] },
  {
    group: '脸型', id: 'chinLength', label: '下巴长度',
    // 下颌骨下移会把下唇一起带下去（张嘴），下唇反向补偿回来
    ops: [
      { bones: ['MJaw'], move: [0, -0.55, 0] },
      // 下唇周围还有部分顶点只绑在下颌上，略微多补一点才能闭合
      { bones: ['MBottomLip', 'MTongue'], pair: 'MouthBottom', move: [0, 0.7, 0] },
    ],
  },
  {
    group: '脸型', id: 'chinForward', label: '下巴前后',
    ops: [
      { bones: ['MJaw'], move: [0, 0, 0.7] },
      { bones: ['MBottomLip', 'MTongue'], pair: 'MouthBottom', move: [0, 0, -0.5] },
    ],
  },

  // 眼球骨骼带着周围皮肤，放大它会像戴护目镜；主要靠上下眼睑张开，眼球只微调
  { group: '眼睛', id: 'eyeSize', label: '眼睛大小', ops: [
    { pair: 'Eye', scale: 0.04 },
    { pair: 'EyeBlinkTop', move: [0, 0.25, 0.05] },
    { pair: 'EyeBlinkBottom', move: [0, -0.1, 0] },
  ] },
  { group: '眼睛', id: 'eyeSpacing', label: '眼距', ops: [{ pair: ['Eye', 'EyeBlinkTop', 'EyeBlinkBottom'], move: [0.35, 0, 0] }] },
  { group: '眼睛', id: 'eyeHeight', label: '眼睛高低', ops: [{ pair: ['Eye', 'EyeBlinkTop', 'EyeBlinkBottom'], move: [0, 0.4, 0] }] },
  { group: '眼睛', id: 'eyeDepth', label: '眼窝深浅', ops: [{ pair: ['Eye', 'EyeBlinkTop', 'EyeBlinkBottom'], move: [0, 0, -0.3] }] },

  { group: '眉毛', id: 'browHeight', label: '眉毛高低', ops: [
    { bones: ['MMiddleEyebrow'], pair: ['InnerEyebrow', 'OuterEyebrow'], move: [0, 0.5, 0] },
  ] },
  { group: '眉毛', id: 'browTilt', label: '眉尾上扬', ops: [
    { pair: 'OuterEyebrow', move: [0, 0.45, 0] },
    { pair: 'InnerEyebrow', move: [0, -0.15, 0] },
  ] },
  { group: '眉毛', id: 'browRidge', label: '眉骨高度', ops: [
    { bones: ['MMiddleEyebrow'], pair: ['InnerEyebrow', 'OuterEyebrow'], move: [0, 0, 0.4] },
  ] },

  { group: '鼻子', id: 'noseSize', label: '鼻子大小', ops: [{ bones: ['MNose'], scale: 0.25 }] },
  { group: '鼻子', id: 'noseHeight', label: '鼻子高低', ops: [{ bones: ['MNose'], move: [0, 0.45, 0] }] },
  { group: '鼻子', id: 'noseBridge', label: '鼻梁高度', ops: [{ bones: ['MNose'], move: [0, 0, 0.5] }] },

  { group: '嘴巴', id: 'mouthWidth', label: '嘴巴宽度', ops: [
    { pair: 'MouthCorner', move: [0.45, 0, 0] },
    { pair: ['Upperlip', 'MouthBottom', 'Caninus'], move: [0.2, 0, 0] },
  ] },
  { group: '嘴巴', id: 'lipThickness', label: '嘴唇厚度', ops: [
    // 上下拉开会张嘴，所以主要往前嘟出来
    { bones: ['MUpperLip'], pair: 'Upperlip', move: [0, 0.04, 0.3] },
    { bones: ['MBottomLip'], pair: 'MouthBottom', move: [0, -0.04, 0.3] },
  ] },
  { group: '嘴巴', id: 'mouthHeight', label: '嘴巴高低', ops: [
    { bones: ['MUpperLip', 'MBottomLip'], pair: ['MouthCorner', 'Upperlip', 'MouthBottom', 'Caninus'], move: [0, 0.4, 0] },
  ] },
];

const BIP = 'Bip01_';

/**
 * @param bones 骨骼名（Bip01_xxx）→ Bone；必须在模型处于静止姿势、已缩放到米时调用
 * @returns { apply(values) }，values: { 参数 id: -1…1 }
 */
export function createSculptor(bones) {
  const rest = new Map();
  const _q = new THREE.Quaternion();
  const _s = new THREE.Vector3();
  const _p = new THREE.Vector3();

  const remember = (bone) => {
    if (!bone || rest.has(bone)) return;
    bone.parent.updateWorldMatrix(true, false);
    bone.parent.matrixWorld.decompose(_p, _q, _s);
    rest.set(bone, {
      position: bone.position.clone(),
      scale: bone.scale.clone(),
      // 世界方向 → 父骨骼局部方向
      toLocal: _q.clone().invert(),
      invScale: 1 / _s.x,
    });
  };

  // 展开每条操作涉及的骨骼及其 x 镜像符号
  const targets = (op) => {
    const list = [];
    for (const n of op.bones ?? []) list.push([bones[BIP + n], 1]);
    for (const n of [].concat(op.pair ?? [])) {
      list.push([bones[`${BIP}L${n}`], 1]);
      list.push([bones[`${BIP}R${n}`], -1]);
    }
    return list.filter(([b]) => b);
  };

  for (const p of SCULPT_PARAMS) for (const op of p.ops) for (const [b] of targets(op)) remember(b);

  const offset = new THREE.Vector3();
  return {
    apply(values) {
      for (const [bone, r] of rest) {
        bone.position.copy(r.position);
        bone.scale.copy(r.scale);
      }
      for (const p of SCULPT_PARAMS) {
        const v = values[p.id] ?? 0;
        if (!v) continue;
        for (const op of p.ops) {
          for (const [bone, side] of targets(op)) {
            const r = rest.get(bone);
            if (op.move) {
              offset.set(op.move[0] * side, op.move[1], op.move[2]).multiplyScalar(v * 0.01);
              bone.position.add(offset.applyQuaternion(r.toLocal).multiplyScalar(r.invScale));
            }
            if (op.scale) bone.scale.multiplyScalar(1 + op.scale * v);
          }
        }
      }
    },
  };
}

// ---------------------------------------------------------------- 体型
// 改的是原始骨骼的骨长（子骨骼相对父骨骼的位置）和缩放。
// 动作跟随只写骨骼旋转，不碰这些，所以写实模型和 VRM 都适用。
// lengthen：这些骨骼相对父骨骼的偏移按比例拉长；scale：均匀缩放；height：整体缩放

export const BODY_PARAMS = [
  { group: '体型', id: 'height', label: '身高', height: 0.1 },
  { group: '体型', id: 'shoulders', label: '肩宽', lengthen: ['leftUpperArm', 'rightUpperArm'], amount: 0.35 },
  { group: '体型', id: 'neck', label: '脖子长度', lengthen: ['head'], amount: 0.4 },
  { group: '体型', id: 'torso', label: '躯干长度', lengthen: ['chest', 'upperChest', 'neck'], amount: 0.15 },
  { group: '四肢', id: 'arms', label: '手臂长度', lengthen: ['leftLowerArm', 'rightLowerArm', 'leftHand', 'rightHand'], amount: 0.12 },
  { group: '四肢', id: 'legs', label: '腿长', lengthen: ['leftLowerLeg', 'rightLowerLeg', 'leftFoot', 'rightFoot'], amount: 0.12 },
  { group: '四肢', id: 'hands', label: '手掌大小', scale: ['leftHand', 'rightHand'], amount: 0.15 },
  { group: '四肢', id: 'feet', label: '脚大小', scale: ['leftFoot', 'rightFoot'], amount: 0.15 },
];

/**
 * @param humanoid three-vrm 的 VRMHumanoid（用原始骨骼）
 * @param root     数字人的根节点（整体缩放用）
 */
export function createBodyShaper(humanoid, root) {
  const rest = new Map();
  const remember = (node) => {
    if (node && !rest.has(node)) rest.set(node, { position: node.position.clone(), scale: node.scale.clone() });
  };
  const nodes = (names) => (names ?? []).map((n) => humanoid.getRawBoneNode(n)).filter(Boolean);
  for (const p of BODY_PARAMS) for (const n of nodes(p.lengthen ?? p.scale)) remember(n);
  const rootScale = root.scale.clone();

  return {
    apply(values) {
      for (const [node, r] of rest) {
        node.position.copy(r.position);
        node.scale.copy(r.scale);
      }
      root.scale.copy(rootScale);
      for (const p of BODY_PARAMS) {
        const v = values[p.id] ?? 0;
        if (!v) continue;
        if (p.height) root.scale.multiplyScalar(1 + p.height * v);
        for (const n of nodes(p.lengthen)) n.position.multiplyScalar(1 + p.amount * v);
        for (const n of nodes(p.scale)) n.scale.multiplyScalar(1 + p.amount * v);
      }
    },
  };
}

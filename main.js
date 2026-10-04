import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import * as Kalidokit from 'kalidokit';
import {
  FilesetResolver, PoseLandmarker, FaceLandmarker, HandLandmarker, DrawingUtils,
} from '@mediapipe/tasks-vision';
import { loadVRM, loadRocketbox } from './avatars.js';
import { SCULPT_PARAMS, BODY_PARAMS, createBodyShaper } from './sculpt.js';
import { SKIN_PRESETS, HAIR_PRESETS, EYE_PRESETS } from './colors.js';
import {
  LandmarkFilter, faceRoi, handRoi, drawRoi, roiToFrame, handOrientation, solveBody, solveHead,
  solveFingerBones, twistPart, FINGER_CHAINS,
} from './solver.js';

// 所有资源都在本地，由 scripts/fetch-assets.sh 下载
const WASM_BASE = new URL('./vendor/mediapipe/wasm', location.href).href;
const MODEL_BASE = './models';
const AVATARS = {
  Female_Adult_01: { label: '写实 · 女', load: (p) => loadRocketbox('./models/rocketbox/Female_Adult_01', 'Female_Adult_01', p) },
  Male_Adult_01: { label: '写实 · 男', load: (p) => loadRocketbox('./models/rocketbox/Male_Adult_01', 'Male_Adult_01', p) },
  vrm: { label: '二次元 · VRM', load: (p) => loadVRM('./models/avatar.vrm', p) },
};

const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const video = $('video');
const overlay = $('overlay');
const overlayCtx = overlay.getContext('2d');

function setStatus(text, kind = '') {
  statusEl.textContent = text;
  statusEl.className = kind;
}

// ---------------------------------------------------------------- three.js scene

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
$('stage').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0f1115);
// 基于物理的材质需要环境光照，写实皮肤才不会发灰
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.6;

const camera = new THREE.PerspectiveCamera(30, window.innerWidth / window.innerHeight, 0.1, 50);
camera.position.set(0, 1.1, 4.2);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.95, 0);
controls.enableDamping = true;
controls.update();
// 镜头平滑移动的目标（捏脸时推到脸部）
let camGoal = null;

const hemi = new THREE.HemisphereLight(0xffffff, 0x444466, 0.6);
scene.add(hemi);
const key = new THREE.DirectionalLight(0xfff1e0, 2.2);
key.position.set(1.2, 2.5, 2.5);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.left = key.shadow.camera.bottom = -1.5;
key.shadow.camera.right = key.shadow.camera.top = 1.5;
key.shadow.bias = -0.0005;
key.shadow.normalBias = 0.02;
scene.add(key);
const rim = new THREE.DirectionalLight(0xbfd4ff, 1.2);
rim.position.set(-1.5, 2, -2);
scene.add(rim);

const ground = new THREE.Mesh(new THREE.CircleGeometry(3, 64), new THREE.ShadowMaterial({ opacity: 0.35 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);
let grid = new THREE.GridHelper(6, 24, 0x2a2f3a, 0x1c2029);
scene.add(grid);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------------------------------------------------------------- avatar

let avatar = null;
const restHips = new THREE.Vector3();
let restFootY = 0;

const FOOT_BONES = ['leftFoot', 'rightFoot', 'leftToes', 'rightToes'];
const _foot = new THREE.Vector3();
function lowestFootY() {
  let min = Infinity;
  for (const b of FOOT_BONES) {
    const node = avatar.humanoid.getRawBoneNode(b);
    if (node) min = Math.min(min, node.getWorldPosition(_foot).y);
  }
  return min;
}

// Kalidokit 估计的身体高度不可靠，弓步、下蹲时会飘起来；每帧把最低的脚拉回地面
function groundAvatar() {
  avatar.scene.updateMatrixWorld(true);
  const y = lowestFootY();
  if (!Number.isFinite(y)) return;
  avatar.scene.position.y += (restFootY - y) * 0.5;
}

let avatarId = null;

async function setAvatar(load, label, id) {
  setStatus(`正在加载 ${label}…`);
  const next = await load((e) => {
    if (e.total) setStatus(`正在加载 ${label}… ${Math.round((e.loaded / e.total) * 100)}%`);
  });
  next.scene.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  if (avatar) {
    scene.remove(avatar.scene);
    avatar.dispose();
  }
  avatar = next;
  avatarId = id;
  avatar.lookAt(camera);
  avatar.body = createBodyShaper(avatar.humanoid, avatar.scene);
  applyLook();
  restHips.copy(avatar.humanoid.getNormalizedBoneNode('hips').position);
  scene.add(avatar.scene);
  measureRest();
  rotTargets.clear();
  posTargets.clear();
  applyRestPose();
  stepRig(-1); // 直接到位
  avatar.update(0);
  avatar.scene.updateMatrixWorld(true);
  restFootY = lowestFootY();
}

// 接受 PascalCase（LeftUpperArm）或 three-vrm 的 camelCase（leftUpperArm）
const boneName = (name) => name[0].toLowerCase() + name.slice(1);

// 跟踪结果只设定目标，每个渲染帧按时间插值过去：
// 摄像头 30fps 的数据在 60fps 画面上也连续，且插值速度与帧率无关。
// RATE 是响应速度（1/秒），越大越跟手
const RATE = { body: 22, hand: 28, head: 25, hips: 8, rest: 3 };
const rotTargets = new Map();
const posTargets = new Map();

function rigRotation(name, rot, dampener = 1, rate = RATE.body) {
  if (!avatar || !rot) return;
  const bone = avatar.humanoid.getNormalizedBoneNode(boneName(name));
  if (!bone) return;
  const s = avatar.axisSign;
  const e = new THREE.Euler(rot.x * dampener * s, rot.y * dampener, rot.z * dampener * s, rot.rotationOrder || 'XYZ');
  rotTargets.set(bone, { q: new THREE.Quaternion().setFromEuler(e), rate });
}

function rigPosition(name, pos, rate = RATE.hips) {
  if (!avatar) return;
  const bone = avatar.humanoid.getNormalizedBoneNode(boneName(name));
  if (!bone) return;
  posTargets.set(bone, { p: new THREE.Vector3(pos.x, pos.y, pos.z), rate });
}

function rigQuaternion(name, q, rate = RATE.body) {
  if (!avatar) return;
  const bone = avatar.humanoid.getNormalizedBoneNode(boneName(name));
  if (bone) rotTargets.set(bone, { q, rate });
}

function stepRig(dt) {
  for (const [bone, t] of rotTargets) bone.quaternion.slerp(t.q, dt < 0 ? 1 : 1 - Math.exp(-t.rate * dt));
  for (const [bone, t] of posTargets) bone.position.lerp(t.p, dt < 0 ? 1 : 1 - Math.exp(-t.rate * dt));
}

// ---------------------------------------------------------------- 世界 Δ → 局部旋转
// solver.js 输出的是"世界坐标下相对静止姿势的旋转"。归一化骨骼的静止旋转都是单位四元数，
// 所以骨骼在归一化根节点下的旋转 R = root⁻¹·Δ·root，局部旋转 = R(父)⁻¹·R(自己)。

const PARENT = {
  spine: 'hips', chest: 'spine', upperChest: 'chest', neck: 'upperChest', head: 'neck',
};
for (const s of ['left', 'right']) {
  Object.assign(PARENT, {
    [`${s}Shoulder`]: 'upperChest', [`${s}UpperArm`]: `${s}Shoulder`, [`${s}LowerArm`]: `${s}UpperArm`,
    [`${s}Hand`]: `${s}LowerArm`, [`${s}UpperLeg`]: 'hips', [`${s}LowerLeg`]: `${s}UpperLeg`,
    [`${s}Foot`]: `${s}LowerLeg`,
  });
  for (const [finger, segs] of Object.entries(FINGER_CHAINS)) {
    segs.forEach(([, , seg], i) => {
      PARENT[`${s}${finger}${seg}`] = i === 0 ? `${s}Hand` : `${s}${finger}${segs[i - 1][2]}`;
    });
  }
}

const restDir = {};
const rootQ = new THREE.Quaternion();
const rootQInv = new THREE.Quaternion();
let solved = {}; // 本帧各骨骼在根节点下的旋转 R

// 静止姿势（T-pose）下各段骨骼的朝向，取自模型本身，兼容不同比例的模型
function measureRest() {
  const h = avatar.humanoid;
  avatar.scene.updateMatrixWorld(true);
  h.normalizedHumanBonesRoot.getWorldQuaternion(rootQ);
  rootQInv.copy(rootQ).invert();
  const pos = (n) => h.getNormalizedBoneNode(n)?.getWorldPosition(new THREE.Vector3());
  for (const s of ['left', 'right']) {
    for (const [bone, child] of [['UpperArm', 'LowerArm'], ['LowerArm', 'Hand'], ['UpperLeg', 'LowerLeg'], ['LowerLeg', 'Foot'], ['Foot', 'Toes']]) {
      const a = pos(s + bone);
      const b = pos(s + child);
      if (a && b) restDir[s + bone] = b.sub(a).normalize();
    }
    // 指节：指向下一节；指尖没有子骨骼，沿用上一节的方向
    for (const [finger, segs] of Object.entries(FINGER_CHAINS)) {
      segs.forEach(([, , seg], i) => {
        const name = `${s}${finger}${seg}`;
        const a = pos(name);
        const b = segs[i + 1] && pos(`${s}${finger}${segs[i + 1][2]}`);
        if (a && b) restDir[name] = b.sub(a).normalize();
        else if (a && i > 0) restDir[name] = restDir[`${s}${finger}${segs[i - 1][2]}`];
      });
    }
  }
}

function rootRotation(name) {
  if (!name) return new THREE.Quaternion();
  return (solved[name] ?? rootRotation(PARENT[name])).clone();
}

/** 按世界 Δ 设定骨骼目标；必须从父到子依次调用 */
function rigDelta(name, delta, rate = RATE.body) {
  const R = rootQInv.clone().multiply(delta).multiply(rootQ);
  const local = rootRotation(PARENT[name]).invert().multiply(R);
  solved[name] = R;
  rigQuaternion(name, local, rate);
}

const ZERO = { x: 0, y: 0, z: 0 };
const LEG_BONES = ['LeftUpperLeg', 'LeftLowerLeg', 'RightUpperLeg', 'RightLowerLeg'];
const FINGER_NAMES = ['Index', 'Middle', 'Ring', 'Little'].flatMap((f) => ['Proximal', 'Intermediate', 'Distal'].map((s) => f + s));

// 手跟丢时手指慢慢回到自然微屈
function relaxHand(side, rate = RATE.rest) {
  const z = side === 'Right' ? -0.2 : 0.2;
  for (const f of FINGER_NAMES) rigRotation(side + f, { x: 0, y: 0, z }, 1, rate);
}

// 没有跟踪数据时慢慢回到自然站立（手臂放下）
function applyRestPose(rate = RATE.rest) {
  for (const b of ['Hips', 'Spine', 'Chest', 'Neck', 'Head', 'LeftShoulder', 'RightShoulder',
    'LeftLowerArm', 'RightLowerArm', 'LeftHand', 'RightHand', ...LEG_BONES]) rigRotation(b, ZERO, 1, rate);
  rigRotation('LeftUpperArm', { x: 0, y: 0, z: 1.2 }, 1, rate);
  rigRotation('RightUpperArm', { x: 0, y: 0, z: -1.2 }, 1, rate);
  relaxHand('Left', rate);
  relaxHand('Right', rate);
  if (avatar) rigPosition('Hips', restHips, rate);
}

// ---------------------------------------------------------------- applying tracking results

const opts = {
  face: $('tFace'), hands: $('tHands'), legs: $('tLegs'), move: $('tMove'),
};

const inFrame = (p) => p && (p.visibility ?? 0) > 0.5 && p.x > 0 && p.x < 1 && p.y > 0 && p.y < 1;

function applyPose(pose3D, pose2D) {
  // 髋部/腿不在画面里时（坐在桌前、半身入镜），模型对它们的位置是瞎猜的，不用
  // 躯干在画面里明显不是竖直的（偏离超过 60°），多半是姿态模型把人看错了（例如手臂挡住身体时），
  // 这时也不信任髋部。站立/坐着跟随的场景里人不会躺平
  const W = video.videoWidth;
  const H = video.videoHeight;
  const tx = ((pose2D[11].x + pose2D[12].x) - (pose2D[23].x + pose2D[24].x)) * W;
  const ty = ((pose2D[11].y + pose2D[12].y) - (pose2D[23].y + pose2D[24].y)) * H;
  const upright = ty < 0 && Math.abs(Math.atan2(tx, -ty)) < Math.PI / 3;
  const flags = {
    hips: upright && [23, 24].every((i) => inFrame(pose2D[i])),
    legs: upright && opts.legs.checked && [25, 26, 27, 28].every((i) => inFrame(pose2D[i])),
  };
  const body = solveBody(pose3D, restDir, flags);
  solved = {};

  rigDelta('hips', body.hips);
  rigDelta('spine', body.spine);
  rigDelta('chest', body.chest);
  rigDelta('upperChest', body.chest);
  for (const side of ['left', 'right']) {
    rigDelta(`${side}Shoulder`, body.chest);
    rigDelta(`${side}UpperArm`, body[`${side}UpperArm`]);
    rigDelta(`${side}LowerArm`, body[`${side}LowerArm`]);
    if (flags.legs) {
      rigDelta(`${side}UpperLeg`, body[`${side}UpperLeg`]);
      rigDelta(`${side}LowerLeg`, body[`${side}LowerLeg`]);
      if (body[`${side}Foot`]) rigDelta(`${side}Foot`, body[`${side}Foot`]);
    } else {
      for (const b of ['UpperLeg', 'LowerLeg', 'Foot']) rigDelta(`${side}${b}`, body.hips, RATE.rest);
    }
  }

  // 整体位移沿用 Kalidokit 的估计（基于画面中髋部的位置）
  const rig = Kalidokit.Pose.solve(pose3D, pose2D, { runtime: 'mediapipe', video, enableLegs: false });
  const s = avatar.axisSign;
  if (rig && opts.move.checked && flags.hips) {
    rigPosition('Hips', {
      x: restHips.x + rig.Hips.position.x * s,
      y: restHips.y + rig.Hips.position.y,
      z: restHips.z - rig.Hips.position.z * s,
    });
  } else {
    rigPosition('Hips', restHips);
  }
  return body;
}

function applyHead(faceLandmarks, pose3D, body) {
  const head = solveHead(faceLandmarks, pose3D);
  // 转头分摊到脖子和头两级
  rigDelta('neck', body.chest.clone().slerp(head, 0.5), RATE.head);
  rigDelta('head', head, RATE.head);
}

function applyFace(blendshapes) {
  if (blendshapes) {
    avatar.setFace(Object.fromEntries(blendshapes.categories.map((c) => [c.categoryName, c.score])));
  }
}

function applyHand(world, side) {
  const s = side === 'Right' ? 'right' : 'left';
  const handDelta = handOrientation(world, side);
  rigDelta(`${s}Hand`, handDelta, RATE.hand);
  shareTwist(s);
  for (const [name, delta] of Object.entries(solveFingerBones(world, s, handDelta, restDir))) {
    rigDelta(name, delta, RATE.hand);
  }
}

// 手腕扭转的一半挪给小臂（手在世界中的朝向不变）
function shareTwist(s) {
  const lower = `${s}LowerArm`;
  const hand = `${s}Hand`;
  if (!solved[lower] || !solved[hand] || !restDir[lower]) return;
  const axis = restDir[lower].clone().applyQuaternion(rootQInv);
  const handLocal = solved[lower].clone().invert().multiply(solved[hand]);
  const half = twistPart(handLocal, axis, 0.5);
  const lowerR = solved[lower].clone().multiply(half);
  solved[lower] = lowerR;
  rigQuaternion(lower, rootRotation(PARENT[lower]).invert().multiply(lowerR), RATE.hand);
  rigQuaternion(hand, lowerR.clone().invert().multiply(solved[hand]), RATE.hand);
}

// ---------------------------------------------------------------- MediaPipe tracking

let poseLm, faceLm, fileset;
const handLm = {};

// heavy 模型（30 MB）关键点明显更准，尤其是遮挡和侧身时；full 更快
const createPose = () => PoseLandmarker.createFromOptions(fileset, {
  baseOptions: { modelAssetPath: `${MODEL_BASE}/${$('poseModel').value}`, delegate: 'GPU' },
  runningMode: 'VIDEO', numPoses: 1,
});

$('poseModel').addEventListener('change', async () => {
  if (!poseLm) return;
  const sel = $('poseModel');
  sel.disabled = true;
  setStatus('正在切换姿态模型…');
  const old = poseLm;
  poseLm = await createPose();
  old.close();
  filters.pose2D.reset();
  filters.pose3D.reset();
  sel.disabled = false;
  setStatus('已开始跟踪，动起来吧', 'ok');
});

async function initTrackers() {
  fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
  const base = (path) => ({ modelAssetPath: `${MODEL_BASE}/${path}`, delegate: 'GPU' });
  // 左右手各用一个实例，各自在自己的裁剪图上跟踪
  const hand = () => HandLandmarker.createFromOptions(fileset, {
    baseOptions: base('hand_landmarker.task'),
    runningMode: 'VIDEO', numHands: 1, minHandDetectionConfidence: 0.4, minHandPresenceConfidence: 0.4,
  });
  [poseLm, faceLm, handLm.Left, handLm.Right] = await Promise.all([
    createPose(),
    FaceLandmarker.createFromOptions(fileset, {
      baseOptions: base('face_landmarker.task'),
      runningMode: 'VIDEO', numFaces: 1, outputFaceBlendshapes: true,
    }),
    hand(),
    hand(),
  ]);
}

async function startCamera() {
  // 分辨率越高，裁出来的手和脸越清晰
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
  overlay.width = video.videoWidth;
  overlay.height = video.videoHeight;
}

const CROP = 256;
const cropCtx = () => {
  const c = document.createElement('canvas');
  c.width = c.height = CROP;
  return c.getContext('2d');
};
const faceCtx = cropCtx();
const handCtx = { Left: cropCtx(), Right: cropCtx() };
const filters = {
  pose2D: new LandmarkFilter(1.5, 4),
  pose3D: new LandmarkFilter(1.5, 4),
  hand: { Left: new LandmarkFilter(2, 8), Right: new LandmarkFilter(2, 8) },
};

const drawing = new DrawingUtils(overlayCtx);
// 检测偶尔会闪断一两帧；短时间内保持最后的姿势，超过才回落，避免手指/身体抽动
const HOLD = { pose: 0.5, hand: 0.4 };
const lastSeen = { pose: 0, Left: 0, Right: 0 };
let lastVideoTime = -1;
let tracking = false;

function drawRoiBox(roi, color) {
  overlayCtx.strokeStyle = color;
  overlayCtx.lineWidth = 2;
  overlayCtx.strokeRect(roi.x, roi.y, roi.size, roi.size);
}

function track() {
  if (!tracking || video.readyState < 2 || video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;
  const ts = performance.now();
  const t = ts / 1000;
  const W = video.videoWidth;
  const H = video.videoHeight;

  const pose = poseLm.detectForVideo(video, ts);
  overlayCtx.clearRect(0, 0, overlay.width, overlay.height);

  if (!pose.landmarks?.[0] || !pose.worldLandmarks?.[0]) {
    if (t - lastSeen.pose > HOLD.pose) {
      $('track').textContent = '未检测到人';
      filters.pose2D.reset();
      filters.pose3D.reset();
      applyRestPose();
    }
    return;
  }
  lastSeen.pose = t;
  const pose2D = filters.pose2D.apply(pose.landmarks[0], t);
  const pose3D = filters.pose3D.apply(pose.worldLandmarks[0], t);
  drawing.drawConnectors(pose2D, PoseLandmarker.POSE_CONNECTIONS, { color: '#5b8cff', lineWidth: 3 });
  drawing.drawLandmarks(pose2D, { color: '#ffffff', radius: 2 });

  const body = applyPose(pose3D, pose2D);
  const status = [];

  let faceLandmarks = null;
  if (opts.face.checked) {
    const roi = faceRoi(pose2D, W, H);
    let found = false;
    if (roi) {
      drawRoi(faceCtx, video, roi);
      const face = faceLm.detectForVideo(faceCtx.canvas, ts);
      const lm = face.faceLandmarks?.[0];
      if (lm) {
        found = true;
        faceLandmarks = lm;
        applyFace(face.faceBlendshapes?.[0]);
        drawRoiBox(roi, '#f5a524');
        drawing.drawConnectors(roiToFrame(lm, roi, W, H), FaceLandmarker.FACE_LANDMARKS_TESSELATION, { color: '#f5a52440', lineWidth: 1 });
      }
    }
    status.push(found ? '脸' : '脸✕');
  }

  // 面部网格给出的头部朝向最准；脸跟丢时退回用姿态的耳朵/眼睛/嘴估计
  applyHead(faceLandmarks, pose3D, body);

  if (opts.hands.checked) {
    for (const side of ['Right', 'Left']) {
      const roi = handRoi(pose2D, side, W, H);
      let found = false;
      if (roi) {
        drawRoi(handCtx[side], video, roi);
        const res = handLm[side].detectForVideo(handCtx[side].canvas, ts);
        if (res.landmarks?.[0]) {
          found = true;
          lastSeen[side] = t;
          applyHand(filters.hand[side].apply(res.worldLandmarks[0], t), side);
          drawRoiBox(roi, '#3ecf8e');
          drawing.drawConnectors(roiToFrame(res.landmarks[0], roi, W, H), HandLandmarker.HAND_CONNECTIONS, { color: '#3ecf8e', lineWidth: 2 });
        }
      }
      if (!found && t - lastSeen[side] > HOLD.hand) {
        filters.hand[side].reset();
        relaxHand(side);
      }
      // 镜像：数字人右手 = 本人左手
      status.push((side === 'Right' ? '左手' : '右手') + (found ? '' : '✕'));
    }
  }
  $('track').textContent = `跟踪中 · ${status.join(' ')}`;
}

// ---------------------------------------------------------------- main loop

const clock = new THREE.Clock();
let frames = 0;
let fpsTime = performance.now();

function loop() {
  requestAnimationFrame(loop);
  const dt = clock.getDelta();
  if (avatar) {
    try { track(); } catch (err) { console.error(err); }
    stepRig(dt);
    avatar.update(dt);
    groundAvatar();
  }
  if (camGoal) {
    const a = 1 - Math.exp(-6 * dt);
    camera.position.lerp(camGoal.position, a);
    controls.target.lerp(camGoal.target, a);
    if (camera.position.distanceTo(camGoal.position) < 0.002) camGoal = null;
  }
  controls.update();
  renderer.render(scene, camera);

  frames++;
  const now = performance.now();
  if (now - fpsTime > 1000) {
    $('fps').textContent = `${Math.round((frames * 1000) / (now - fpsTime))} fps`;
    frames = 0;
    fpsTime = now;
  }
}
loop();

// ---------------------------------------------------------------- UI

$('startBtn').addEventListener('click', async () => {
  const btn = $('startBtn');
  btn.disabled = true;
  try {
    setStatus('正在加载识别模型…');
    if (!poseLm) await initTrackers();
    setStatus('正在请求摄像头权限…');
    await startCamera();
    tracking = true;
    btn.textContent = '跟踪中';
    setStatus('已开始跟踪，动起来吧', 'ok');
  } catch (err) {
    console.error(err);
    btn.disabled = false;
    setStatus(`启动失败：${err.message || err}`, 'warn');
  }
});

const select = $('avatarSelect');
for (const [id, a] of Object.entries(AVATARS)) select.add(new Option(a.label, id));

async function chooseAvatar(id) {
  const a = AVATARS[id];
  select.disabled = true;
  try {
    await setAvatar(a.load, a.label, id);
    setStatus(tracking ? '已开始跟踪，动起来吧' : '模型已就绪，点击开启摄像头', tracking ? 'ok' : '');
  } catch (err) {
    console.error(err);
    setStatus(`${a.label} 加载失败：${err.message || err}`, 'warn');
  } finally {
    select.disabled = false;
  }
}
select.addEventListener('change', () => chooseAvatar(select.value));

async function loadFromFile(file) {
  if (!file || !file.name.toLowerCase().endsWith('.vrm')) {
    setStatus('请选择 .vrm 格式的模型文件', 'warn');
    return;
  }
  const url = URL.createObjectURL(file);
  try {
    await setAvatar((p) => loadVRM(url, p), file.name, null);
    setStatus(`已加载 ${file.name}`, 'ok');
  } catch (err) {
    console.error(err);
    setStatus(`模型加载失败：${err.message || err}`, 'warn');
  } finally {
    URL.revokeObjectURL(url);
  }
}

$('vrmFile').addEventListener('change', (e) => loadFromFile(e.target.files[0]));
window.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dragging'); });
window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dragging'); });
window.addEventListener('drop', (e) => {
  e.preventDefault();
  document.body.classList.remove('dragging');
  loadFromFile(e.dataTransfer.files[0]);
});

chooseAvatar(select.value).then(() => { $('startBtn').disabled = false; });

// ---------------------------------------------------------------- 捏人：脸部、身体、颜色、存档

const LOOK_DEFAULT = () => ({ face: {}, body: {}, color: {} });
let look = LOOK_DEFAULT();
const lookKey = () => `look:${avatarId}`;

function loadLook() {
  try {
    const saved = JSON.parse(localStorage.getItem(lookKey()));
    if (saved) return { ...LOOK_DEFAULT(), ...saved };
    // 旧版只存了脸型
    const face = JSON.parse(localStorage.getItem(`sculpt:${avatarId}`));
    if (face) return { ...LOOK_DEFAULT(), face };
  } catch {
    // 读不到就用默认
  }
  return LOOK_DEFAULT();
}

function saveLook() {
  if (!avatarId) return; // 临时上传的模型不保存
  try {
    localStorage.setItem(lookKey(), JSON.stringify(look));
  } catch {
    // 隐私模式等情况下存不了，不影响使用
  }
}

function renderLook() {
  avatar?.sculpt?.apply(look.face);
  avatar?.body?.apply(look.body);
  avatar?.colors?.apply(look.color);
}

// 切换数字人时读取它保存的形象
function applyLook() {
  look = avatarId ? loadLook() : LOOK_DEFAULT();
  renderLook();
  syncLookUI();
}

function lookChanged() {
  renderLook();
  saveLook();
  // 改身高/脖子等会让头的位置变，编辑器开着时镜头跟过去
  if (!$('sculpt').hidden) aimAtFace();
}

const sliders = []; // { input, section, id }

function buildSliders(page, params, section) {
  let group = null;
  for (const p of params) {
    if (p.group !== group) {
      group = p.group;
      const h = document.createElement('h3');
      h.className = 'group-title';
      h.textContent = group;
      page.append(h);
    }
    const row = document.createElement('label');
    row.className = 'slider';
    row.innerHTML = `<span>${p.label}</span><input type="range" min="${p.min ?? -1}" max="${p.max ?? 1}" step="${p.step ?? 0.01}" value="0" />`;
    const input = row.querySelector('input');
    input.addEventListener('input', () => {
      look[section][p.id] = Number(input.value);
      lookChanged();
    });
    // 双击归零
    input.addEventListener('dblclick', () => {
      input.value = 0;
      input.dispatchEvent(new Event('input'));
    });
    sliders.push({ input, section, id: p.id });
    page.append(row);
  }
}

const page = (name) => document.querySelector(`.tab-page[data-page="${name}"]`);
buildSliders(page('face'), SCULPT_PARAMS, 'face');
buildSliders(page('body'), BODY_PARAMS, 'body');

const swatchRows = []; // { key, buttons: [[button, value]] }
function buildSwatches(container, title, key, presets) {
  const h = document.createElement('h3');
  h.className = 'group-title';
  h.textContent = title;
  const row = document.createElement('div');
  row.className = 'swatches';
  const buttons = presets.map(([name, value]) => {
    const b = document.createElement('button');
    b.className = 'swatch' + (value ? '' : ' original');
    b.title = name;
    b.setAttribute('aria-label', `${title}：${name}`);
    if (value) b.style.background = value;
    b.addEventListener('click', () => {
      look.color[key] = value;
      lookChanged();
      syncLookUI();
    });
    row.append(b);
    return [b, value];
  });
  container.append(h, row);
  swatchRows.push({ key, buttons });
}
buildSwatches(page('color'), '肤色', 'skin', SKIN_PRESETS);
buildSwatches(page('color'), '发色', 'hair', HAIR_PRESETS);
buildSwatches(page('color'), '瞳色', 'eye', EYE_PRESETS);
buildSliders(page('color'), [
  { group: '服装', id: 'clothHue', label: '色相', min: -180, max: 180, step: 1 },
  { group: '服装', id: 'clothSat', label: '饱和度' },
], 'color');

let activeTab = 'face';
const SECTION_OF_TAB = { face: 'face', body: 'body', color: 'color' };

function tabSupported(tab) {
  if (tab === 'face') return !!avatar?.sculpt;
  if (tab === 'color') return !!avatar?.colors;
  return !!avatar;
}

function syncLookUI() {
  for (const { input, section, id } of sliders) {
    input.value = look[section][id] ?? 0;
    input.disabled = !tabSupported(section);
  }
  for (const { key, buttons } of swatchRows) {
    for (const [b, value] of buttons) {
      b.setAttribute('aria-pressed', String((look.color[key] ?? null) === value));
      b.disabled = !avatar?.colors;
    }
  }
  const supported = tabSupported(activeTab);
  const note = {
    face: '当前数字人不支持捏脸，请切换到"写实"模型。',
    color: '当前数字人不支持换色，请切换到"写实"模型。',
  };
  $('sculptNote').textContent = supported ? (activeTab === 'save' ? '' : '双击滑块可单独归零。') : note[activeTab];
  $('sculptRandom').disabled = !supported;
  $('sculptReset').disabled = !supported;
  document.querySelector('.sculpt-actions').hidden = activeTab === 'save';
}

for (const tab of document.querySelectorAll('.tabs [role="tab"]')) {
  tab.addEventListener('click', () => {
    activeTab = tab.dataset.tab;
    for (const t of document.querySelectorAll('.tabs [role="tab"]')) t.setAttribute('aria-selected', String(t === tab));
    for (const pg of document.querySelectorAll('.tab-page')) pg.hidden = pg.dataset.page !== activeTab;
    syncLookUI();
  });
}

// 偏向中间值的随机数，避免各项同时走极端
const randomMid = (scale) => +(((Math.random() + Math.random()) - 1) * scale).toFixed(2);
const pick = (list) => list[Math.floor(Math.random() * list.length)][1];

$('sculptRandom').addEventListener('click', () => {
  if (activeTab === 'face') for (const p of SCULPT_PARAMS) look.face[p.id] = randomMid(0.8);
  if (activeTab === 'body') for (const p of BODY_PARAMS) look.body[p.id] = randomMid(0.6);
  if (activeTab === 'color') {
    look.color = {
      skin: pick(SKIN_PRESETS), hair: pick(HAIR_PRESETS), eye: pick(EYE_PRESETS),
      clothHue: Math.round((Math.random() * 2 - 1) * 180), clothSat: randomMid(0.4),
    };
  }
  lookChanged();
  syncLookUI();
});

$('sculptReset').addEventListener('click', () => {
  const section = SECTION_OF_TAB[activeTab];
  if (section) look[section] = {};
  lookChanged();
  syncLookUI();
});

function download(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');

$('lookExport').addEventListener('click', () => {
  const data = { app: 'digital-person', version: 1, avatar: avatarId, look };
  download(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), `形象-${avatarId ?? 'custom'}-${stamp()}.json`);
});

$('lookImport').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data?.look) throw new Error('不是形象文件');
    look = { ...LOOK_DEFAULT(), ...data.look };
    lookChanged();
    syncLookUI();
    toast(data.avatar && data.avatar !== avatarId ? '已导入（该形象原本属于另一个数字人，效果可能不同）' : '已导入形象');
  } catch (err) {
    toast(`导入失败：${err.message}`);
  }
});

// 打开捏人时镜头推到脸部，关闭时回到原来的视角
let savedView = null;

function aimAtFace() {
  const head = avatar?.humanoid.getRawBoneNode('head');
  if (!head) return;
  avatar.scene.updateMatrixWorld(true);
  const p = head.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, 0.08, 0));
  camGoal = { target: p, position: p.clone().add(new THREE.Vector3(0, 0.02, 0.85)) };
}

function focusFace() {
  savedView = { position: camera.position.clone(), target: controls.target.clone() };
  aimAtFace();
}

function toggleSculpt(open) {
  const panel = $('sculpt');
  panel.hidden = !open;
  $('sculptBtn').textContent = open ? '完成捏人' : '捏人';
  if (open) {
    syncLookUI();
    focusFace();
  } else if (savedView) {
    camGoal = savedView;
    savedView = null;
  }
}

$('sculptBtn').addEventListener('click', () => toggleSculpt($('sculpt').hidden));
$('sculptClose').addEventListener('click', () => toggleSculpt(false));

// ---------------------------------------------------------------- 场景：背景、灯光

function gradientTexture(top, bottom) {
  const c = document.createElement('canvas');
  c.width = 2;
  c.height = 512;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 512);
  grad.addColorStop(0, top);
  grad.addColorStop(1, bottom);
  g.fillStyle = grad;
  g.fillRect(0, 0, 2, 512);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 绿幕/蓝幕去掉地面和阴影，方便抠像
const BACKGROUNDS = {
  dark: { color: 0x0f1115, grid: [0x2a2f3a, 0x1c2029], shadow: 0.35 },
  light: { color: 0xe6e9ee, grid: [0xb4bac4, 0xd2d6dd], shadow: 0.2 },
  gradient: { gradient: ['#3a4660', '#0f1115'], grid: [0x3a4256, 0x232836], shadow: 0.35 },
  green: { color: 0x00b140 },
  blue: { color: 0x0047bb },
};

function setBackground(name) {
  const bg = BACKGROUNDS[name] ?? BACKGROUNDS.dark;
  if (scene.background?.isTexture) scene.background.dispose();
  scene.background = bg.gradient ? gradientTexture(...bg.gradient) : new THREE.Color(bg.color);
  scene.remove(grid);
  grid.geometry.dispose();
  grid = new THREE.GridHelper(6, 24, ...(bg.grid ?? [0, 0]));
  grid.visible = !!bg.grid;
  scene.add(grid);
  ground.visible = !!bg.shadow;
  ground.material.opacity = bg.shadow ?? 0;
}

const LIGHTS = {
  studio: { hemi: 0.6, key: [0xfff1e0, 2.2, [1.2, 2.5, 2.5]], rim: [0xbfd4ff, 1.2], env: 0.6, exposure: 1.0 },
  soft: { hemi: 1.1, key: [0xffffff, 1.3, [0.5, 3, 3]], rim: [0xffffff, 0.6], env: 1.0, exposure: 1.0 },
  warm: { hemi: 0.5, key: [0xffc98f, 2.6, [1.5, 2.2, 2]], rim: [0xff9a5c, 1.4], env: 0.5, exposure: 1.05 },
  cool: { hemi: 0.6, key: [0xd6e4ff, 2.2, [-1, 2.5, 2.5]], rim: [0x6fa8ff, 1.6], env: 0.6, exposure: 1.0 },
  drama: { hemi: 0.12, key: [0xffffff, 3.4, [2.5, 2, 0.6]], rim: [0x4f7dff, 2.4], env: 0.15, exposure: 1.1 },
};

function setLights(name) {
  const l = LIGHTS[name] ?? LIGHTS.studio;
  hemi.intensity = l.hemi;
  key.color.set(l.key[0]);
  key.intensity = l.key[1];
  key.position.set(...l.key[2]);
  rim.color.set(l.rim[0]);
  rim.intensity = l.rim[1];
  scene.environmentIntensity = l.env;
  renderer.toneMappingExposure = l.exposure;
}

const sceneSettings = (() => {
  try {
    return JSON.parse(localStorage.getItem('scene')) ?? {};
  } catch {
    return {};
  }
})();

function saveScene() {
  try {
    localStorage.setItem('scene', JSON.stringify(sceneSettings));
  } catch {
    // 存不了不影响使用
  }
}

$('bgSelect').value = sceneSettings.bg ?? 'dark';
$('lightSelect').value = sceneSettings.light ?? 'studio';
setBackground($('bgSelect').value);
setLights($('lightSelect').value);
$('bgSelect').addEventListener('change', (e) => { sceneSettings.bg = e.target.value; setBackground(e.target.value); saveScene(); });
$('lightSelect').addEventListener('change', (e) => { sceneSettings.light = e.target.value; setLights(e.target.value); saveScene(); });

// ---------------------------------------------------------------- 输出：截图、录像、隐藏界面

let toastTimer = null;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2500);
}

$('shotBtn').addEventListener('click', () => {
  // WebGL 画布默认不保留绘制结果，截图前在同一任务里重新渲染一帧
  renderer.render(scene, camera);
  renderer.domElement.toBlob((blob) => {
    download(blob, `数字人-${stamp()}.png`);
    toast('截图已保存');
  }, 'image/png');
});

let recorder = null;
let recTimer = null;

function recordingType() {
  for (const t of ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4']) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return '';
}

$('recBtn').addEventListener('click', () => {
  const btn = $('recBtn');
  if (recorder) {
    recorder.stop();
    return;
  }
  if (!window.MediaRecorder) {
    toast('当前浏览器不支持录制');
    return;
  }
  const type = recordingType();
  const chunks = [];
  recorder = new MediaRecorder(renderer.domElement.captureStream(30), { mimeType: type, videoBitsPerSecond: 8_000_000 });
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  recorder.onstop = () => {
    clearInterval(recTimer);
    btn.classList.remove('recording');
    btn.textContent = '录制视频';
    recorder = null;
    const ext = type.includes('mp4') ? 'mp4' : 'webm';
    download(new Blob(chunks, { type: type || 'video/webm' }), `数字人-${stamp()}.${ext}`);
    toast('视频已保存');
  };
  recorder.start(1000);
  const started = Date.now();
  btn.classList.add('recording');
  const tick = () => {
    const sec = Math.floor((Date.now() - started) / 1000);
    btn.textContent = `停止 ${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
  };
  tick();
  recTimer = setInterval(tick, 500);
});

window.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() !== 'h' || e.metaKey || e.ctrlKey || e.altKey) return;
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName) && document.activeElement.type !== 'range') return;
  document.body.classList.toggle('clean');
  if (!document.body.classList.contains('clean')) toast('按 H 可再次隐藏界面');
});

#!/usr/bin/env bash
# 下载页面运行所需的全部库和模型到本地，之后可完全离线使用。
set -euo pipefail
cd "$(dirname "$0")/.."

JSD=https://cdn.jsdelivr.net/npm
MP=https://storage.googleapis.com/mediapipe-models
TASKS_VISION=@mediapipe/tasks-vision@0.10.14

fetch() { # <url> <dest>
  if [[ -s "$2" ]]; then echo "skip  $2"; return; fi
  mkdir -p "$(dirname "$2")"
  echo "fetch $2"
  curl -fsSL --retry 3 -o "$2.part" "$1"
  mv "$2.part" "$2"
}

# JS 库
fetch "$JSD/three@0.169.0/build/three.module.js"                       vendor/three/build/three.module.js
fetch "$JSD/three@0.169.0/examples/jsm/loaders/GLTFLoader.js"          vendor/three/examples/jsm/loaders/GLTFLoader.js
fetch "$JSD/three@0.169.0/examples/jsm/controls/OrbitControls.js"      vendor/three/examples/jsm/controls/OrbitControls.js
fetch "$JSD/three@0.169.0/examples/jsm/utils/BufferGeometryUtils.js"   vendor/three/examples/jsm/utils/BufferGeometryUtils.js
for f in loaders/FBXLoader.js libs/fflate.module.js curves/NURBSCurve.js curves/NURBSUtils.js environments/RoomEnvironment.js; do
  fetch "$JSD/three@0.169.0/examples/jsm/$f" "vendor/three/examples/jsm/$f"
done
fetch "$JSD/@pixiv/three-vrm@3.5.5/lib/three-vrm.module.min.js"        vendor/three-vrm/three-vrm.module.min.js
fetch "$JSD/kalidokit@1.1.5/dist/kalidokit.es.js"                      vendor/kalidokit/kalidokit.es.js
fetch "$JSD/$TASKS_VISION/vision_bundle.mjs"                           vendor/mediapipe/vision_bundle.mjs
for f in vision_wasm_internal.js vision_wasm_internal.wasm vision_wasm_nosimd_internal.js vision_wasm_nosimd_internal.wasm; do
  fetch "$JSD/$TASKS_VISION/wasm/$f" "vendor/mediapipe/wasm/$f"
done

# 识别模型
fetch "$MP/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task" models/pose_landmarker_full.task
fetch "$MP/pose_landmarker/pose_landmarker_heavy/float16/latest/pose_landmarker_heavy.task" models/pose_landmarker_heavy.task
fetch "$MP/face_landmarker/face_landmarker/float16/latest/face_landmarker.task"          models/face_landmarker.task
fetch "$MP/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task"          models/hand_landmarker.task

# 默认数字人
fetch "https://cdn.jsdelivr.net/gh/pixiv/three-vrm@dev/packages/three-vrm/examples/models/VRM1_Constraint_Twist_Sample.vrm" models/avatar.vrm

# 写实数字人：Microsoft Rocketbox（MIT 许可，可商用），带 ARKit 52 表情
# 格式 "目录:贴图前缀"，前缀见仓库里各人物的 Textures/ 目录
# TGA 贴图转成 JPG/PNG 以减小体积（需要 ffmpeg）
# 优先走 jsDelivr（快很多），它拒绝的文件类型（如 .fbx）退回 GitHub 原始地址
RB_JSD=https://cdn.jsdelivr.net/gh/microsoft/Microsoft-Rocketbox@master/Assets/Avatars
RB_RAW=https://raw.githubusercontent.com/microsoft/Microsoft-Rocketbox/master/Assets/Avatars
fetch_rb() { fetch "$RB_JSD/$1" "$2" 2>/dev/null || fetch "$RB_RAW/$1" "$2"; }
ROCKETBOX=(
  "Adults/Female_Adult_01:f001"
  "Adults/Male_Adult_01:m002"
)
for entry in "${ROCKETBOX[@]}"; do
  path=${entry%%:*}; prefix=${entry##*:}; name=${path##*/}; dir=models/rocketbox/$name
  fetch_rb "$path/Export/${name}_facial.fbx" "$dir/${name}_facial.fbx"
  fetch_rb "$path/$name.png" "$dir/preview.png"
  for t in body_color body_normal head_color head_normal opacity_color; do
    ext=jpg; [[ $t == opacity_color ]] && ext=png
    out="$dir/textures/${prefix}_$t.$ext"
    [[ -s "$out" ]] && { echo "skip  $out"; continue; }
    fetch_rb "$path/Textures/${prefix}_$t.tga" "$dir/textures/${prefix}_$t.tga"
    ffmpeg -y -loglevel error -i "$dir/textures/${prefix}_$t.tga" -q:v 3 "$out"
    rm "$dir/textures/${prefix}_$t.tga"
  done
done
curl -fsSL -o models/rocketbox/LICENSE.md https://raw.githubusercontent.com/microsoft/Microsoft-Rocketbox/master/LICENSE.md

echo "done"

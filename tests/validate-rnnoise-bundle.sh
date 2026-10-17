#!/usr/bin/env bash
# Optional dependency integration test: verifies the pinned prebuilt model ABI.
set -euo pipefail
REV="cb529a59a8478fe604e57986fc96afdaecfa6fb7"
SHA="d054e0640b918141ee80f7b6e2eb5bcac9fe38a4"
TEMP="$(mktemp -d)"
trap 'rm -rf "${TEMP}"' EXIT
curl -fLsS --retry 3 \
  "https://raw.githubusercontent.com/jitsi/rnnoise-wasm/${REV}/dist/rnnoise-sync.js" \
  -o "${TEMP}/rnnoise-sync.mjs"
[[ "$(git hash-object "${TEMP}/rnnoise-sync.mjs")" == "${SHA}" ]] || {
  echo 'Bad optional RNNoise WASM bundle hash' >&2; exit 1;
}
export RNNOISE_MODEL_PATH="${TEMP}/rnnoise-sync.mjs"
node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const path=process.env.RNNOISE_MODEL_PATH;
const {default:factory}=await import(pathToFileURL(path).href);
const wasm=await factory();
assert.equal(typeof wasm._rnnoise_process_frame,'function');
assert.equal(typeof wasm._rnnoise_create,'function');
assert(wasm.HEAPF32 instanceof Float32Array);
const state=wasm._rnnoise_create();
const pIn=wasm._malloc(480*4),pOut=wasm._malloc(480*4);
assert(state&&pIn&&pOut,'RNNoise state and buffers allocated');
for(let i=0;i<480;i++)wasm.HEAPF32[pIn/4+i]=1000*Math.sin(2*Math.PI*i/48);
const vad=wasm._rnnoise_process_frame(state,pOut,pIn);
assert(Number.isFinite(vad),'RNNoise VAD finite');
for(let i=0;i<480;i++)
  assert(Number.isFinite(wasm.HEAPF32[pOut/4+i]),'RNNoise output must be finite');
wasm._rnnoise_destroy(state);
wasm._free(pIn);wasm._free(pOut);
console.log('Pinned Jitsi RNNoise WASM artifact processed a real 480-sample frame');
NODE

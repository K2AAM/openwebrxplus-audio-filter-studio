#!/usr/bin/env bash
# Install the optional Jitsi-built RNNoise 0.2 WebAssembly bundle for Studio.
# This DOES NOT run upstream code as root. It only installs a pinned JS asset.
set -euo pipefail

UPSTREAM_COMMIT="cb529a59a8478fe604e57986fc96afdaecfa6fb7"
EXPECTED_GIT_BLOB="d054e0640b918141ee80f7b6e2eb5bcac9fe38a4"
TARGET="${1:-/usr/lib/python3/dist-packages/htdocs/plugins/receiver/audio_filter}"
RAW="https://raw.githubusercontent.com/jitsi/rnnoise-wasm/${UPSTREAM_COMMIT}"
RNNOISE_C="372f7b4b76cde4ca1ec4605353dd17898a99de38"

for command in curl git install; do
  command -v "${command}" >/dev/null || { echo "Missing: ${command}" >&2; exit 1; }
done

tmpdir="$(mktemp -d)"
trap 'rm -rf "${tmpdir}"' EXIT

echo "Retrieving pinned, prebuilt RNNoise WASM bundle (about 1.9 MiB)..."
curl -fLsS --retry 3 "${RAW}/dist/rnnoise-sync.js" -o "${tmpdir}/rnnoise-sync.js"
actual="$(git hash-object "${tmpdir}/rnnoise-sync.js")"
if [[ "${actual}" != "${EXPECTED_GIT_BLOB}" ]]; then
  echo "RNNoise bundle integrity check failed (${actual}). Nothing installed." >&2
  exit 1
fi

# Preserve the notices for BOTH the Apache-licensed wrapper and the
# BSD-licensed RNNoise C library included in its compiled WebAssembly.
curl -fLsS --retry 3 "${RAW}/LICENSE" -o "${tmpdir}/RNNOISE-WASM-APACHE-LICENSE.txt"
curl -fLsS --retry 3 \
  "https://raw.githubusercontent.com/xiph/rnnoise/${RNNOISE_C}/COPYING" \
  -o "${tmpdir}/RNNOISE-BSD-LICENSE.txt"

if [[ ! -d "${TARGET}" ]]; then
  echo "Plugin directory does not exist: ${TARGET}" >&2
  exit 1
fi
echo "Installing verified optional RNNoise asset into ${TARGET}"
sudo install -m 644 "${tmpdir}/rnnoise-sync.js" "${TARGET}/rnnoise-sync.js"
sudo install -m 644 "${tmpdir}/RNNOISE-WASM-APACHE-LICENSE.txt" "${TARGET}/RNNOISE-WASM-APACHE-LICENSE.txt"
sudo install -m 644 "${tmpdir}/RNNOISE-BSD-LICENSE.txt" "${TARGET}/RNNOISE-BSD-LICENSE.txt"

echo "RNNoise installed. Hard reload the SDR browser, enable NR, then"
echo "select Advanced -> NR engine -> RNNoise WASM (experimental)."
echo "Classic NR remains the default and fallback. 48 kHz voice only."

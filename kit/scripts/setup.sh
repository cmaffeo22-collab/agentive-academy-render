#!/usr/bin/env bash
# One-time setup for Agentive Sketch Explainer. Installs into $MGS_HOME (default ~/.agentive-sketch-explainer):
# a Python venv with pinned packages, the Kokoro voice model (SHA-256 checked) and the pinned Node packages.
# Needs: python3 (3.11 or newer), node 18 or newer with npm, ffmpeg with libx264 and libass, curl. Free and open source; no accounts.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
MGS_HOME="${MGS_HOME:-$HOME/.agentive-sketch-explainer}"
command -v ffmpeg >/dev/null || { echo "ffmpeg is required (with libx264 and libass)"; exit 1; }
command -v node >/dev/null && command -v npm >/dev/null || { echo "node 18+ and npm are required"; exit 1; }
python3 -c 'import sys; assert sys.version_info >= (3, 11), "Python 3.11 or newer is required"'
ENC="$(ffmpeg -hide_banner -encoders 2>/dev/null)"; grep -q libx264 <<<"$ENC" || { echo "ffmpeg needs libx264"; exit 1; }
FILTERS="$(ffmpeg -hide_banner -filters 2>/dev/null)"; grep -q ' subtitles ' <<<"$FILTERS" || { echo "ffmpeg needs libass (subtitles filter) for the captions cut"; exit 1; }
mkdir -p "$MGS_HOME/models" "$MGS_HOME/node"
[ -x "$MGS_HOME/venv/bin/python" ] || python3 -m venv "$MGS_HOME/venv"
"$MGS_HOME/venv/bin/pip" install -q -r "$HERE/requirements.txt"
cp "$HERE/package.json" "$MGS_HOME/node/package.json"
(cd "$MGS_HOME/node" && npm install --silent --no-audit --no-fund)
REL=https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0
fetch() {  # name sha256
  local f="$MGS_HOME/models/$1"
  [ -s "$f" ] || curl -fL --retry 4 -o "$f" "$REL/$1"
  echo "$2  $f" | sha256sum -c - >/dev/null || { echo "checksum mismatch for $1"; rm -f "$f"; exit 1; }
}
fetch kokoro-v1.0.onnx 7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5
fetch voices-v1.0.bin bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d
echo "ready: $MGS_HOME"

#!/usr/bin/env bash
# Academy lesson video: content JSON -> one checked 1920x1080 MP4 plus its .srt (YouTube CC). Draft only; never uploads.
# Usage: bash scripts/lesson.sh content/<id>.json <out_dir>
# Length: intro 25 to 36 s, concept 45 to 92 s. Captions are not burned in. A finished PASS is skipped on re-run.
# Files reach <out_dir> only after check.sh prints PASS; a failure goes to <out_dir>/_failed/<id>/ with its reason.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
MGS_HOME="${MGS_HOME:-$HOME/.agentive-sketch-explainer}"
export MG_MODELS="$MGS_HOME/models" MG_NODE_MODULES="$MGS_HOME/node/node_modules" NODE_PATH="$MGS_HOME/node/node_modules"
PY="$MGS_HOME/venv/bin/python"
[ -x "$PY" ] && [ -d "$MG_NODE_MODULES/roughjs" ] || { echo "Not set up. Run: bash $HERE/setup.sh"; exit 1; }
SPEC="$1"; OUTD="$2"; N="${MGS_SLICES:-$(nproc 2>/dev/null || echo 4)}"
read ID KIND < <(python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print(d["id"],d.get("kind",""))' "$SPEC")
[[ "$ID" =~ ^[a-z0-9-]+$ ]] || { echo "bad id: $ID"; exit 1; }
case "$KIND" in intro) MIND=25; MAXD=36;; concept) MIND=45; MAXD=92;; *) echo "kind must be intro or concept"; exit 1;; esac
mkdir -p "$OUTD"
if [ -f "$OUTD/$ID.check.txt" ] && grep -q '^PASS' "$OUTD/$ID.check.txt" && [ -f "$OUTD/$ID.mp4" ]; then
  cmp -s "$SPEC" "$OUTD/$ID.json" && { echo "SKIP $ID (already passed, same content)"; exit 0; }
  echo "$ID content changed since its PASS: rebuilding"; fi
B="${MGS_WORK:-$PWD/lesson-work}/build/$ID"; T="$B/out"; rm -rf "$B"; mkdir -p "$T"
fail() { mkdir -p "$OUTD/_failed/$ID"; cp -f "$T"/* "$OUTD/_failed/$ID/" 2>/dev/null || true; echo "$1" > "$OUTD/_failed/$ID/FAILED.txt"; echo "FAIL $ID: $1"; exit 1; }
"$PY" "$HERE/voice.py" --check "$SPEC" >/dev/null || fail "content check (run voice.py --check)"
node "$HERE/render.cjs" "$SPEC" /dev/null 16x9 /dev/null --layout-only 2>"$T/layout.txt" || fail "$(cat "$T/layout.txt")"
"$PY" "$HERE/voice.py" "$SPEC" "$B"
bash "$HERE/render-par.sh" "$SPEC" "$B/timeline.json" 16x9 "$B/video-16x9.mp4" "$N"
"$PY" "$HERE/sound.py" "$B/timeline.json" "$B/video-16x9.sound.json" "$B"
bash "$HERE/mix.sh" "$B" "$B/video-16x9.mp4" "$T/$ID.mp4"
python3 "$HERE/srt_fix.py" "$B/captions.srt" "$T/$ID.srt"; cp "$SPEC" "$T/$ID.json"
python3 -c 'import sys,re;t=open(sys.argv[1],encoding="utf-8").read();sys.exit(3 if re.search("[\u2013\u2014]",t) else (4 if re.search("AI[- ]generated",t,re.I) else 0))' "$T/$ID.srt"; rc=$?; [ $rc -eq 0 ] || fail "srt guard rc=$rc (3=long dash, 4=AI label)"
MIND=$MIND MAXD=$MAXD bash "$HERE/check.sh" "$T/$ID.mp4" 16x9 "$SPEC" > "$T/$ID.check.txt" 2>&1 || fail "$(cat "$T/$ID.check.txt")"
for x in mp4 srt json check.txt; do mv -f "$T/$ID.$x" "$OUTD/$ID.$x"; done
rm -rf "$B"; cat "$OUTD/$ID.check.txt"

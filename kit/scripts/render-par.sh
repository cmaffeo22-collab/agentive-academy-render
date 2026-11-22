#!/usr/bin/env bash
# Render a format in N parallel slices, then join them losslessly.
# Usage: render-par.sh <content.json> <timeline.json> <9x16|16x9> <out.mp4> [slices]
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; CJ="$1"; TJ="$2"; FMT="$3"; OUT="$4"; N="${5:-4}"
export NODE_PATH="${MG_NODE_MODULES:-$HOME/.agentive-sketch-explainer/node/node_modules}"
TOTAL=$(python3 -c 'import json,math,sys;print(math.ceil(json.load(open(sys.argv[1]))["duration"]*30))' "$TJ")
N=$(( N > 8 ? 8 : N )); N=$(( N < 1 ? 1 : N ))
PIDS=(); TMP="$(mktemp -d)"; STEP=$(( (TOTAL + N - 1) / N ))
for i in $(seq 0 $((N-1))); do
  node "$HERE/render.cjs" "$CJ" "$TJ" "$FMT" "$TMP/part$i.mp4" --from $((i*STEP)) --to $(((i+1)*STEP)) & PIDS+=($!)
done; for p in "${PIDS[@]}"; do wait "$p"; done
for i in $(seq 0 $((N-1))); do echo "file '$TMP/part$i.mp4'"; done > "$TMP/list.txt"
ffmpeg -y -loglevel error -f concat -safe 0 -i "$TMP/list.txt" -c copy "$OUT"
python3 - "$TMP" "$N" "${OUT%.mp4}.sound.json" <<'PY'
import json,sys
tmp,n,out=sys.argv[1],int(sys.argv[2]),sys.argv[3]
parts=[json.load(open(f'{tmp}/part{i}.sound.json')) for i in range(n)]
d=parts[0]; d['ink']=sum((p['ink'] for p in parts),[]); d['from']=0; json.dump(d,open(out,'w'))
PY
rm -rf "$TMP"; echo "wrote $OUT ($TOTAL frames)"

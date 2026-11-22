#!/usr/bin/env bash
# Render one chunk of lessons on a GitHub-hosted runner and upload each finished lesson, encrypted, to the "renders" release.
# Usage: bash ci/render_chunk.sh <chunk index> <chunk count>     env: LESSON_KEY (secret), GH_TOKEN, GITHUB_REPOSITORY
# Each chunk has its own release, renders-<index>, so no release nears the 1,000-asset limit.
# Public logs show only lesson ids and PASS/FAIL. Lesson text, logs and videos leave the runner only encrypted.
# The render itself runs without the key or the token in its environment.
set -uo pipefail
I="$1"; N="$2"; ROOT="$(cd "$(dirname "$0")/.." && pwd)"; W="$RUNNER_TEMP/w"; mkdir -p "$W/content" "$W/out" "$W/up"
[ -n "${LESSON_KEY:-}" ] || { echo "LESSON_KEY secret is missing"; exit 1; }
enc() { openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:LESSON_KEY -in "$1" -out "$2"; }
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:LESSON_KEY -in "$ROOT/data/lessons.tgz.enc" | tar xz -C "$W/content" || { echo "could not decrypt lessons (wrong LESSON_KEY?)"; exit 1; }
mapfile -t ALL < <(ls -d "$W"/content/*-m[0-9][0-9]-l[0-9][0-9] | xargs -n1 basename | sort | grep -vxF -f "$ROOT/data/done.txt" || true)
MINE=(); for k in "${!ALL[@]}"; do [ $((k % N)) -eq "$I" ] && MINE+=("${ALL[$k]}"); done
echo "chunk $I of $N: ${#MINE[@]} lessons"
# Lessons already uploaded by an earlier run of this chunk are skipped (the chunk list asset is the record).
REL="renders-$I"
gh release view "$REL" >/dev/null 2>&1 || gh release create "$REL" --title "$REL" --notes "Encrypted render outputs. Not for public use." >/dev/null 2>&1 || true
gh release download "$REL" -p "chunk-$I.txt" -D "$W" --clobber >/dev/null 2>&1 || : > "$W/chunk-$I.txt"
touch "$W/chunk-$I.txt"
cd "$ROOT/kit"; export MGS_WORK="$W/work" MGS_SLICES="$(nproc)"
for L in "${MINE[@]}"; do
  grep -qx "$L" "$W/chunk-$I.txt" && { echo "skip $L (already uploaded)"; continue; }
  ok=1; t0=$(date +%s)
  for k in intro concept-1 concept-2; do
    env -u LESSON_KEY -u GH_TOKEN -u GITHUB_TOKEN bash scripts/lesson.sh "$W/content/$L/$L-$k.json" "$W/out/$L" > "$W/out/$L.$k.log" 2>&1 || ok=0
  done
  if [ $ok = 1 ] && [ "$(grep -l '^PASS' "$W/out/$L"/*.check.txt 2>/dev/null | wc -l)" -ge 3 ]; then
    tar czf "$W/up/$L.tgz" -C "$W/out/$L" $(cd "$W/out/$L" && ls "$L"-*.mp4 "$L"-*.srt "$L"-*.json "$L"-*.check.txt) && enc "$W/up/$L.tgz" "$W/up/$L.tgz.enc" \
      && gh release upload "$REL" "$W/up/$L.tgz.enc" --clobber >/dev/null \
      && { echo "$L" >> "$W/chunk-$I.txt"; gh release upload "$REL" "$W/chunk-$I.txt" --clobber >/dev/null; echo "PASS $L ($(( $(date +%s) - t0 ))s)"; } \
      || echo "UPLOAD-FAIL $L"
    rm -rf "$W/out/$L" "$W/up/$L.tgz" "$W/up/$L.tgz.enc"
  else
    echo "FAIL $L"
    tar czf "$W/up/fail-$L.tgz" -C "$W/out" "$L.intro.log" "$L.concept-1.log" "$L.concept-2.log" 2>/dev/null; enc "$W/up/fail-$L.tgz" "$W/up/fail-$L.tgz.enc" \
      && gh release upload "$REL" "$W/up/fail-$L.tgz.enc" --clobber >/dev/null || true
  fi
  rm -f "$W/out/$L".*.log
done
echo "chunk $I done: $(wc -l < "$W/chunk-$I.txt") lessons uploaded in total"

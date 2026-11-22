#!/usr/bin/env bash
# Mix voice + music + sfx, then mux onto the silent render. Loud, stereo, social-ready.
# Voice: high-pass, a little presence, gentle compression, a touch of room so it sits less dry.
# Music ducks under the voice (sidechain). Master: two-pass loudnorm to -14 LUFS, -1.5 dBTP, AAC 192k 48 kHz stereo.
# Usage: bash mix.sh <build_dir> <video_silent.mp4> <out.mp4> [music_db] [sfx_db]
set -euo pipefail
B="$1"; V="$2"; OUT="$3"; MDB="${4:--14}"; SDB="${5:--4}"
# one voice is mono and goes to the centre; a cast arrives in stereo with its own placement
VCH=$(ffprobe -v error -select_streams a:0 -show_entries stream=channels -of csv=p=0 "$B/voice.wav")
[ "$VCH" = 1 ] && PAN="pan=stereo|c0=c0|c1=c0" || PAN="anull"
G="[0:a]aresample=48000,highpass=f=85,equalizer=f=220:t=q:w=1.2:g=-2,equalizer=f=3200:t=q:w=1.0:g=2.5,equalizer=f=9000:t=q:w=1.5:g=1.5,acompressor=threshold=-20dB:ratio=3:attack=6:release=90:makeup=2,aecho=0.85:0.6:28|47:0.10|0.06,$PAN,asplit=2[vo][key];[1:a]volume=${MDB}dB[mu];[mu][key]sidechaincompress=threshold=0.04:ratio=5:attack=25:release=350[mud];[2:a]volume=${SDB}dB[fx];[vo][mud][fx]amix=inputs=3:normalize=0:duration=first"
ffmpeg -y -loglevel error -i "$B/voice.wav" -i "$B/music.wav" -i "$B/sfx.wav" -filter_complex "$G[m]" -map "[m]" -c:a pcm_s24le "$B/premix.wav"
M="$(ffmpeg -hide_banner -nostats -i "$B/premix.wav" -af loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json -f null - 2>&1 | sed -n '/^{/,/^}/p')"
get() { python3 -c 'import json,sys;print(json.loads(sys.stdin.read())[sys.argv[1]])' "$1" <<<"$M"; }
LN="loudnorm=I=-14:TP=-1.5:LRA=11:measured_I=$(get input_i):measured_TP=$(get input_tp):measured_LRA=$(get input_lra):measured_thresh=$(get input_thresh):offset=$(get target_offset):linear=true"
ffmpeg -y -loglevel error -i "$V" -i "$B/premix.wav" -map 0:v -map 1:a -c:v copy \
  -af "$LN,aresample=48000,alimiter=limit=0.7:level=false" -c:a aac -aac_pns 0 -b:a 192k -ar 48000 -ac 2 -shortest -movflags +faststart "$OUT"
echo "wrote $OUT"

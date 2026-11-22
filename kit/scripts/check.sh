#!/usr/bin/env bash
# Format checks on a finished video. Prints PASS or the list of failures.
# Usage: bash check.sh <video.mp4> <9x16|16x9> [content.json] [captions.srt]   (length 50 to 66 s; MIND/MAXD override)
# A PASS means the file is built right (size, rate, audio, loudness, length, no black bars, captions inside the frame, no AI label, no long dashes).
# It does not judge the picture or the voice: watch it and listen before sign-off.
set -uo pipefail
V="$1"; FMT="$2"; CJ="${3:-}"; FAIL=()
read W H R < <(ffprobe -v error -select_streams v:0 -show_entries stream=width,height,r_frame_rate -of csv=p=0:s=x "$V" | tr x ' ')
[ "$FMT" = "9x16" ] && { [ "$W" = 1080 ] && [ "$H" = 1920 ] || FAIL+=("size $W x $H, want 1080x1920"); }
[ "$FMT" = "16x9" ] && { [ "$W" = 1920 ] && [ "$H" = 1080 ] || FAIL+=("size $W x $H, want 1920x1080"); }
[ "$R" = "30/1" ] || FAIL+=("frame rate $R, want 30/1")
read SR CH < <(ffprobe -v error -select_streams a:0 -show_entries stream=channels,sample_rate -of csv=p=0:s=x "$V" | tr x ' ')
[ "${CH:-0}" = 2 ] || FAIL+=("audio channels ${CH:-none}, want 2 (stereo)")
[ "${SR:-0}" = 48000 ] || FAIL+=("sample rate ${SR:-none}, want 48000")
D=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$V"); python3 -c "import sys;d=float('$D');sys.exit(0 if float('${MIND:-50}')<=d<=float('${MAXD:-66}') else 1)" || FAIL+=("duration $D s outside ${MIND:-50} to ${MAXD:-66}")
E=$(ffmpeg -hide_banner -nostats -i "$V" -af ebur128=peak=true -f null - 2>&1 | sed -n '/Summary/,$p')
I=$(grep -m1 ' I:' <<<"$E" | awk '{print $2}'); PK=$(grep -m1 'Peak:' <<<"$E" | awk '{print $2}')
python3 -c "import sys;sys.exit(0 if abs(float('$I')+14)<=1 else 1)" || FAIL+=("loudness $I LUFS, want -14 +/- 1")
python3 -c "import sys;sys.exit(0 if float('$PK')<=-1.0 else 1)" || FAIL+=("true peak $PK dBFS, want -1.0 or lower")
SIL=$(ffmpeg -hide_banner -nostats -i "$V" -af silencedetect=n=-45dB:d=0.3 -f null - 2>&1 | awk '/silence_duration/{s+=$NF}END{print s+0}')
python3 -c "import sys;sys.exit(0 if float('$SIL')/float('$D')<0.25 else 1)" || FAIL+=("silence ${SIL}s is over 25%")
FR=$(ffmpeg -hide_banner -nostats -i "$V" -vf freezedetect=n=0.0005:d=3.5 -map 0:v -f null - 2>&1 | grep -c freeze_start)
[ "$FR" = 0 ] || FAIL+=("$FR frozen stretch(es) over 3.5 s")
# no black bars: the picture must fill the whole frame (samples 4 seconds from the middle)
CROP=$(ffmpeg -hide_banner -nostats -ss "$(python3 -c "print(float('$D')/2)")" -t 4 -i "$V" -vf cropdetect=limit=20:round=2:reset=0 -an -f null - 2>&1 | grep -o 'crop=[0-9:]*' | tail -1)
[ "${CROP:-crop=$W:$H:0:0}" = "crop=$W:$H:0:0" ] || FAIL+=("black bars found ($CROP); the picture must fill $W x $H")
# no AI labels anywhere (the owner adds disclosure at posting): file and stream metadata, content, captions
ffprobe -v error -show_entries format_tags:stream_tags -of default=nw=1 "$V" | grep -qiE "AI[- ]generated" && FAIL+=("AI label in file metadata")
SRT="${4:-}"; for X in "$CJ" "$SRT"; do [ -n "$X" ] && grep -qiE "AI[- ]generated" "$X" && FAIL+=("AI label in $X"); done
if [ -n "$SRT" ]; then python3 -c "import sys;sys.exit(1 if any(c in open(sys.argv[1],encoding='utf-8').read() for c in '\u2014\u2013') else 0)" "$SRT" || FAIL+=("long dash in $SRT"); fi
if [ -n "$CJ" ]; then python3 -c "import sys;sys.exit(1 if any(c in open(sys.argv[1],encoding='utf-8').read() for c in '\u2014\u2013') else 0)" "$CJ" || FAIL+=("long dash in $CJ"); fi
# captions must sit fully inside the frame: each SRT line is drawn exactly as captions.py burns it and its box is measured
if [ -n "$SRT" ]; then CB=""; for P in python3 "${MGS_HOME:-$HOME/.agentive-sketch-explainer}/venv/bin/python"; do "$P" -c "import numpy" 2>/dev/null && { CB="$P"; break; }; done
  if [ -z "$CB" ]; then FAIL+=("caption bounds not checked: no python with numpy"); else CBO=$("$CB" "$(dirname "$0")/caption_bounds.py" "$SRT" "$FMT" 2>&1) || FAIL+=("captions outside the frame: $(grep -m3 FAIL <<<"$CBO" | tr '\n' ' ')"); fi; fi
if [ ${#FAIL[@]} -eq 0 ]; then echo "PASS  $V  (${W}x${H}, ${D}s, $I LUFS, peak $PK, silence ${SIL}s)"; else printf 'FAIL  %s\n' "${FAIL[@]}"; exit 1; fi

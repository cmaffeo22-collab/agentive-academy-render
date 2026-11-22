# Third-party components

| Component | Use | Licence |
|---|---|---|
| Kokoro-82M model and kokoro-onnx | Voice synthesis | Apache 2.0 |
| espeak-ng (via kokoro-onnx phonemiser) | Turns text into phonemes at run time; not shipped with the videos | GPL 3.0 (tool use only; the audio it helps make is not covered) |
| rough.js | Sketch-style strokes | MIT |
| opentype.js | Font outlines for hand-lettered text | MIT |
| @resvg/resvg-js | SVG to image | MPL 2.0 |
| Kalam (Indian Type Foundry) | Handwriting font | SIL OFL 1.1, see `fonts/Kalam-OFL.txt` |
| JetBrains Mono | Mono labels | SIL OFL 1.1, see `fonts/JetBrainsMono-OFL.txt` |
| ffmpeg | Encode and mix | LGPL/GPL build, used as a tool |
| libass | Subtitles filter, which setup.sh requires of the ffmpeg build | ISC, used as a tool |
| numpy, soundfile, onnxruntime | Audio maths and model runtime | BSD / MIT |

Music and sound effects are synthesised by `scripts/sound.py`; no samples or recordings are used.

ffmpeg is used as a tool; the common Linux builds include libx264, which is GPL. Rendered videos are not covered by these licences.

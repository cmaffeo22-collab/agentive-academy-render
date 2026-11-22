"""Voice + timeline. Kokoro-82M (Apache 2.0) via kokoro-onnx, CPU only.
Usage: python voice.py content/<id>.json build/<id> [voice]
Each spoken line is synthesised on its own so every card lands on its words.
Any line can name its own "voice" (a cast), and "pan" can place each voice a little left or right.
Every line is matched to the same loudness so voices trade evenly.
v2: any number of Kokoro voices, an "end" line ("Reach out to learn more."), an optional "note", 150 to 165 spoken words.
Writes voice.wav (48 kHz, mono for one voice, stereo for a cast or any pan), timeline.json, captions.srt."""
import json, os, sys
import numpy as np

MODELS = os.environ.get("MG_MODELS", os.path.expanduser("~/.agentive-sketch-explainer/models"))
LEAD_IN, TAIL = 0.45, 2.4   # lesson variant: short hold on the closing card, no contact end card
GAP = {"title": 0.40, "card": 0.24, "found-intro": 0.26, "found": 0.20, "cta": 0.8, "end": 0.0}
FOOTER = "AGENTIVE ACADEMY"
END_SAYS = {"Reach out to learn more.", "Reach out to learn more at agentiveintegrations dot com."}
WORDS = {"intro": ((68, 80), (60, 88)), "concept": ((130, 210), (115, 225))}   # intro about 30 s, concept 45 to 90 s

ICONS = {"kernel", "routing", "robot", "code", "toolbox", "database", "plug", "target", "shield", "log", "sign", "copies",
         "clock", "lock", "eye", "chart", "dice", "refresh", "mail", "box", "phone"}
GROUPS = {"gold", "green", "coral", "copper", "light"}

def known_voices():
    """Voice names in the Kokoro voices file, or None when the model is not installed here."""
    f = f"{MODELS}/voices-v1.0.bin"
    if not os.path.exists(f): return None
    return set(np.load(f).files)

def lines_of(spec):
    out = [("title", "title", spec["title"])]
    out += [(f"card{i+1}", "card", c) for i, c in enumerate(spec["cards"])]
    if spec.get("foundation", {}).get("items"):
        out += [("found", "found-intro", spec["foundation"])]
        out += [(f"found{i+1}", "found", f) for i, f in enumerate(spec["foundation"]["items"])]
    out += [("cta", "cta", spec["cta"])]
    return out

def word_count(spec):
    return sum(len(it["say"].split()) for _, _, it in lines_of(spec))

def validate(spec, warn=None):
    """Fail loudly before any render: the layout is built for this exact shape."""
    import re
    errs = []
    cards, items = spec.get("cards", []), spec.get("foundation", {}).get("items", [])
    kind = spec.get("kind")
    if kind not in WORDS: errs.append(f'"kind" must be one of {sorted(WORDS)}, got {kind!r}'); kind = "concept"
    if not 4 <= len(cards) <= 12: errs.append(f"need 4 to 12 cards, got {len(cards)}")
    if items and not 3 <= len(items) <= 5: errs.append(f"foundation needs 3 to 5 items or none, got {len(items)}")
    if "end" in spec: errs.append('lesson videos have no "end" line (no contact card)')
    footer = spec.get("footer", FOOTER)
    if not footer.startswith(FOOTER): errs.append(f'footer must start with "{FOOTER}", got {footer!r}')
    voices = {it.get("voice", spec.get("voice", "af_heart")) for _, _, it in lines_of(spec)} if cards else set()
    if len(voices) > 1: errs.append(f"one narrator only: lines use {sorted(voices)}")
    t = spec.get("title", {})
    for k in ("text", "em", "kicker", "say"):
        if not isinstance(t.get(k), str) or not t.get(k).strip(): errs.append(f"title.{k} is required"); t[k] = t.get(k) or "x"
    if len(t["text"] + " " + t["em"]) > 32: errs.append(f"title text plus em over 32 characters: {t['text']} {t['em']!r}")
    if len(t["kicker"]) > 24: errs.append(f"kicker over 24 characters: {t['kicker']!r}")
    cta = spec.get("cta", {})
    if not isinstance(cta.get("text"), str) or not 1 <= len(cta["text"]) <= 40: errs.append("cta.text must be 1 to 40 characters"); spec["cta"] = {"text": "x", "say": cta.get("say", "x x x")}
    for i, c in enumerate(cards, 1):
        for k in ("title", "sub", "icon", "say"):
            if not isinstance(c.get(k), str) or not c.get(k).strip(): errs.append(f"card {i} {k} is required"); c[k] = c.get(k) or "x"
    note = spec.get("note")
    texts = [spec["title"]["text"], spec["title"]["em"], spec["title"]["kicker"], spec["cta"]["text"], footer]
    if note is not None:
        if not isinstance(note, str) or not 1 <= len(note) <= 60: errs.append(f"note must be 1 to 60 characters, got {note!r}")
        elif not re.fullmatch(r"[A-Za-z0-9 .,:;'&%/()?!+#@-]+", note): errs.append(f"note may use letters, digits, spaces and . , : ; ' & % / ( ) ? ! + # @ - only: {note!r}")
        else: texts.append(note)
    for i, c in enumerate(cards, 1):
        if len(c["title"]) > 11: errs.append(f"card {i} title over 11 characters: {c['title']!r}")
        if len(c["sub"]) > 26: errs.append(f"card {i} sub over 26 characters: {c['sub']!r}")
        if c["icon"] not in ICONS: errs.append(f"card {i} unknown icon {c['icon']!r}")
        if "accent" in c and c["accent"] not in GROUPS: errs.append(f"card {i} accent must be one of {sorted(GROUPS)}")
        if "badge" in c and not (isinstance(c["badge"], str) and 1 <= len(c["badge"]) <= 2 and c["badge"].isalnum()): errs.append(f"card {i} badge must be 1 or 2 letters or digits")
        texts += [c["title"], c["sub"]]
    for i, f in enumerate(items, 1):
        if len(f["text"]) > 20: errs.append(f"foundation {i} over 20 characters: {f['text']!r}")
        texts.append(f["text"])
    lines = lines_of(spec) if 4 <= len(cards) <= 12 else []
    says = [it["say"] for _, _, it in lines]
    for t in says:
        if len(t.split()) > 25: errs.append(f"spoken line over 25 words: {t[:40]!r}...")
        if len(t.split()) < 3: errs.append(f"spoken line under 3 words: {t!r}")
    for t in texts + says:
        bad = [ch for ch in t if (ord(ch) > 126 and ch != "\u00b7") or ch in "\u2013\u2014"]
        if bad: errs.append(f"unsupported character {bad[0]!r} in {t[:40]!r} (Kalam is Latin only; no long dashes)")
    if not re.fullmatch(r"[a-z0-9-]{1,80}", str(spec.get("id", ""))): errs.append(f"id must be 1 to 80 lowercase letters, digits or hyphens: {spec.get('id')!r}")
    for t in texts + says:
        if any(ch in t for ch in "{}\\"): errs.append(f"braces and backslashes are not allowed (caption codes): {t[:40]!r}")
    raw = json.dumps(spec).lower()
    if re.search(r"ai[- ]generated", raw): errs.append("no AI labels: remove every \"AI-generated\" text (the owner adds disclosure at posting)")
    if "book a call" in raw: errs.append('never write or say "book a call"')
    # voices: any number of Kokoro voices; every line names one or falls back to the top-level "voice"
    default = spec.get("voice", "af_heart"); cast = set()
    for sid, _, it in lines:
        v = it.get("voice", default)
        if not isinstance(v, str) or not re.fullmatch(r"[a-z]{2}_[a-z]+", v): errs.append(f"{sid}: voice must be a Kokoro voice name like af_heart, got {v!r}")
        else: cast.add(v)
    kv = known_voices()
    if kv is not None:
        miss = sorted(cast - kv)
        if miss: errs.append(f"unknown Kokoro voice(s): {miss}. Available: {', '.join(sorted(kv))}")
    if warn is not None:
        odd = sorted(v for v in cast if v[0] not in "ab")
        if odd: warn.append(f"non-English voice(s) {odd}: lines are read as US English")
    pan, speeds = spec.get("pan", {}), spec.get("speeds", {})
    errs += [f"pan/speeds names {v!r}, which no line uses" for v in sorted((set(pan) | set(speeds)) - cast)] if lines else []
    errs += [f"pan for {v} must be a number from -1 to 1" for v, p in pan.items() if not isinstance(p, (int, float)) or not -1 <= p <= 1]
    errs += [f"speed for {v} must be a number from 0.5 to 2" for v, x in speeds.items() if not isinstance(x, (int, float)) or not 0.5 <= x <= 2]
    if lines:
        n = word_count(spec); ok, hard = WORDS[kind]
        if not hard[0] <= n <= hard[1]: errs.append(f"{n} spoken words; {kind} must be {hard[0]} to {hard[1]} (aim {ok[0]} to {ok[1]})")
        elif warn is not None and not ok[0] <= n <= ok[1]: warn.append(f"{n} spoken words; aim for {ok[0]} to {ok[1]}")
    if errs: sys.exit("content check failed:\n  " + "\n  ".join(errs))

def main(spec_path, out, override=None):
    import soundfile as sf
    from kokoro_onnx import Kokoro
    spec = json.load(open(spec_path, encoding="utf-8")); w = []; validate(spec, w); [print("WARN", x) for x in w]; os.makedirs(out, exist_ok=True)
    voice = override or spec.get("voice", "af_heart"); speed = spec.get("speed", 1.1)
    k = Kokoro(f"{MODELS}/kokoro-v1.0.onnx", f"{MODELS}/voices-v1.0.bin")
    lines = lines_of(spec)
    who = (lambda item: override) if override else (lambda item: item.get("voice", voice))  # a voice on the command line overrides the cast
    cast = {who(it) for _, _, it in lines}; known = set(k.get_voices())
    missing = sorted(cast - known)
    if missing: sys.exit(f"unknown Kokoro voice(s): {missing}. Available: {', '.join(sorted(known))}")
    pan, speeds = ({}, {}) if override else (spec.get("pan", {}), spec.get("speeds", {}))
    stereo = len(cast) > 1 or any(pan.values())
    sr = 24000; t = LEAD_IN; pieces = [np.zeros((int(LEAD_IN * sr), 2), np.float32)]; segs = []
    for sid, kind, item in lines:
        v, text = who(item), item["say"]
        a, sr_ = k.create(text, voice=v, speed=speeds.get(v, speed), lang="en-us"); assert sr_ == sr
        a = a.astype(np.float32); nz = np.where(np.abs(a) > 0.008)[0]
        if len(nz): a = a[max(0, nz[0] - 240): nz[-1] + 600]
        a = a * min(0.08 / max(1e-6, np.sqrt(np.mean(a ** 2))), 0.95 / max(1e-6, np.abs(a).max()))  # even loudness per line
        th = (pan.get(v, 0.0) + 1) * np.pi / 4
        st = np.stack([a * np.cos(th), a * np.sin(th)], 1) * np.sqrt(2)
        d = len(a) / sr
        segs.append({"id": sid, "kind": kind, "voice": v, "text": text, "start": round(t, 3), "end": round(t + d, 3)})
        pieces += [st, np.zeros((int(GAP[kind] * sr), 2), np.float32)]; t += d + GAP[kind]
    pieces.append(np.zeros((int(TAIL * sr), 2), np.float32)); t += TAIL
    a = np.concatenate(pieces); a = a / max(1e-6, np.abs(a).max()) * 0.89
    x = np.arange(len(a)) / sr; x48 = np.arange(int(len(a) * 2)) / 48000
    a48 = np.stack([np.interp(x48, x, a[:, c]) for c in (0, 1)], 1)
    sf.write(f"{out}/voice.wav", (a48 if stereo else a48[:, 0]).astype(np.float32), 48000, subtype="PCM_16")
    json.dump({"id": spec["id"], "voice": voice, "duration": round(t, 3), "segments": segs},
              open(f"{out}/timeline.json", "w"), indent=1)
    def ts(s): h, m = divmod(int(s), 3600); m, s2 = divmod(m, 60); return f"{h:02}:{m:02}:{s2:02},{int((s % 1) * 1000):03}"
    with open(f"{out}/captions.srt", "w") as f:
        for i, s in enumerate(segs, 1): f.write(f"{i}\n{ts(s['start'])} --> {ts(s['end'])}\n{s['text']}\n\n")
    print(spec["id"], voice, "words", word_count(spec), "duration", round(t, 2), "s")

if __name__ == "__main__":
    if len(sys.argv) > 2 and sys.argv[1] == "--check":   # validate content files only, no voice: python3 voice.py --check a.json [b.json ...]
        bad = 0
        for f in sys.argv[2:]:
            try:
                w = []; sp = json.load(open(f, encoding="utf-8")); validate(sp, w)
                print("OK  ", f, f"({word_count(sp)} words)"); [print("  WARN", x) for x in w]
            except SystemExit as e: bad += 1; print("FAIL", f, "\n ", e)
            except Exception as e: bad += 1; print("FAIL", f, "\n  unreadable:", repr(e))
        sys.exit(1 if bad else 0)
    main(*sys.argv[1:4])

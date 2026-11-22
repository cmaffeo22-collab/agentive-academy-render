"""Sound beds, synthesised from scratch (no samples, no licences to track).
Usage: python sound.py <timeline.json> <video.sound.json> <out_dir>
Writes music.wav (soft lo-fi groove, 92 BPM, Am-F-C-G) and sfx.wav (marker scribble that
follows how much ink is drawn each frame, plus pops for badges and thuds for foundation stones).
Both 48 kHz stereo float. Levels are set again in mix.sh."""
import json, sys
import numpy as np, soundfile as sf

SR = 48000
rng = np.random.default_rng(7)

def onepole_lp(x, fc):
    a = np.exp(-2 * np.pi * fc / SR); y = np.empty_like(x); s = 0.0
    for i in range(len(x)): s = (1 - a) * x[i] + a * s; y[i] = s
    return y

def lp_fast(x, fc):  # vectorised 2x one-pole via filtfilt-like cumulative trick (cheap, good enough for noise)
    from numpy.fft import rfft, irfft, rfftfreq
    X = rfft(x); f = rfftfreq(len(x), 1 / SR); X *= 1 / np.sqrt(1 + (f / fc) ** 4); return irfft(X, len(x))

def bp_fast(x, lo, hi):
    from numpy.fft import rfft, irfft, rfftfreq
    X = rfft(x); f = rfftfreq(len(x), 1 / SR)
    X *= (1 / np.sqrt(1 + (lo / np.maximum(f, 1)) ** 4)) * (1 / np.sqrt(1 + (f / hi) ** 4)); return irfft(X, len(x))

def note(m): return 440 * 2 ** ((m - 69) / 12)

def karplus(freq, dur, bright=0.5):
    n = int(dur * SR); N = int(SR / freq); buf = rng.uniform(-1, 1, N) * 0.6
    buf = lp_fast(np.tile(buf, 4), 2000 + 4000 * bright)[:N]
    out = np.empty(n); idx = 0
    for i in range(n):
        out[i] = buf[idx]; nxt = (idx + 1) % N
        buf[idx] = 0.996 * 0.5 * (buf[idx] + buf[nxt]); idx = nxt
    return out

def music(dur):
    bpm = 92; beat = 60 / bpm; bar = 4 * beat
    prog = [(57, [57, 60, 64]), (53, [53, 57, 60]), (48, [55, 60, 64]), (55, [55, 59, 62])]  # Am F C G
    L = np.zeros(int((dur + 3) * SR)); R = np.zeros_like(L)
    t = np.arange(int(bar * SR)) / SR
    nbars = int(np.ceil(dur / bar)) + 1
    plucks = {}
    for b in range(nbars):
        root, ch = prog[b % 4]
        if b == nbars - 1: root, ch = 48, [55, 60, 64]  # resolve on C
        s = int(b * bar * SR)
        # pad: soft, slightly detuned partials, slow attack
        env = np.minimum(1, t / 0.6) * np.minimum(1, (bar - t) / 0.4 + 0.15)
        pad = sum(np.sin(2 * np.pi * note(m) * t * d) / (k + 1) for m in ch for k, d in enumerate((1.0, 1.004, 0.997)))
        pad += 0.6 * np.sin(2 * np.pi * note(root - 12) * t)
        pad = lp_fast(pad * env, 1400) * 0.05
        seg = slice(s, s + len(t)); L[seg] += pad[: len(L[seg])]; R[seg] += pad[: len(R[seg])]
        # plucked arpeggio on eighths, panned a little
        arp = [ch[0] + 12, ch[1] + 12, ch[2] + 12, ch[1] + 12, ch[0] + 24, ch[2] + 12, ch[1] + 12, ch[2] + 12]
        for i, m in enumerate(arp):
            if b == nbars - 1 and i > 0: break
            if m not in plucks: plucks[m] = karplus(note(m), 1.2)
            p = plucks[m] * (0.07 if i % 2 == 0 else 0.05); st = s + int(i * beat / 2 * SR)
            pan = 0.35 + 0.3 * ((i * 3) % 4) / 3
            e = min(len(p), len(L) - st)
            if e > 0: L[st:st + e] += p[:e] * (1 - pan); R[st:st + e] += p[:e] * pan
        # soft kick on 1 and 3, shaker on the off-beats, rim on 2 and 4
        for k in range(4):
            st = s + int(k * beat * SR)
            if k in (0, 2):
                kt = np.arange(int(0.3 * SR)) / SR; f = 45 + 70 * np.exp(-kt * 30)
                kick = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-kt * 9) * 0.32
                e = min(len(kick), len(L) - st)
                if e > 0: L[st:st + e] += kick[:e]; R[st:st + e] += kick[:e]
            else:
                rt = np.arange(int(0.08 * SR)) / SR; rim = bp_fast(rng.normal(0, 1, len(rt)), 900, 3000) * np.exp(-rt * 60) * 0.05
                e = min(len(rim), len(L) - st)
                if e > 0: L[st:st + e] += rim[:e] * 0.9; R[st:st + e] += rim[:e]
            for h in (0.5,):
                st2 = st + int(h * beat * SR); ht = np.arange(int(0.05 * SR)) / SR
                hat = bp_fast(rng.normal(0, 1, len(ht)), 6000, 14000) * np.exp(-ht * 90) * 0.035
                e = min(len(hat), len(L) - st2)
                if e > 0: L[st2:st2 + e] += hat[:e] * 0.7; R[st2:st2 + e] += hat[:e]
    n = int(dur * SR); L, R = L[:n], R[:n]
    fade = np.ones(n); fi = int(0.4 * SR); fo = int(2.0 * SR)
    fade[:fi] = np.linspace(0, 1, fi); fade[-fo:] = np.linspace(1, 0, fo) ** 1.5
    return np.stack([L * fade, R * fade], 1)

def sfx(dur, snd):
    n = int(dur * SR); fps = snd["fps"]; ink = np.array(snd["ink"], float)
    rate = np.sqrt(ink / (np.percentile(ink[ink > 0], 95) + 1e-6)).clip(0, 1.2)
    rate = np.convolve(rate, [0.25, 0.5, 0.25], mode="same")
    env = np.interp(np.arange(n) / SR, np.arange(len(rate)) / fps, rate)
    noise = bp_fast(rng.normal(0, 1, n), 1800, 7000)
    grain = 0.55 + 0.45 * np.sin(2 * np.pi * np.cumsum(18 + 14 * rng.random(n)) / SR)  # felt-tip texture
    scr = noise * grain * env * 0.06
    L = scr * 0.9; R = scr * 1.0
    for ev in snd["events"]:
        st = int(ev["t"] * SR)
        if ev["type"] == "pop":
            tt = np.arange(int(0.09 * SR)) / SR; f = 520 + 380 * np.exp(-tt * 40)
            x = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-tt * 38) * 0.16
        else:
            tt = np.arange(int(0.18 * SR)) / SR
            x = (np.sin(2 * np.pi * 78 * tt) * 0.3 + lp_fast(rng.normal(0, 1, len(tt)), 600) * 0.15) * np.exp(-tt * 22)
        e = min(len(x), n - st)
        if e > 0: L[st:st + e] += x[:e]; R[st:st + e] += x[:e]
    return np.stack([L, R], 1)

if __name__ == "__main__":
    tl = json.load(open(sys.argv[1])); snd = json.load(open(sys.argv[2])); out = sys.argv[3]
    d = tl["duration"]
    sf.write(f"{out}/music.wav", music(d).astype(np.float32), SR, subtype="FLOAT")
    sf.write(f"{out}/sfx.wav", sfx(d, snd).astype(np.float32), SR, subtype="FLOAT")
    print("beds written", round(d, 2), "s")

"""Make the .srt YouTube-friendly: plain acronyms (A.G.I. -> AGI), cues of at most 2 lines x 42 characters,
long cues split into balanced chunks (no one-word orphans), and no cue shorter than MIN_S seconds or of 2 words or
fewer: such a cue is merged into a neighbour, and the pair is re-split evenly if it no longer fits.
Usage: python3 srt_fix.py in.srt out.srt   (safe to run on an already-fixed .srt; output words and order never change)"""
import re, sys
MIN_S, W, L = 1.0, 42, 2
def ts2s(t): h, m, r = t.split(':'); s, ms = r.split(','); return int(h)*3600 + int(m)*60 + int(s) + int(ms)/1000
def s2ts(x):
    ms = int(round(x * 1000)); h, ms = divmod(ms, 3600000); m, ms = divmod(ms, 60000); s, ms = divmod(ms, 1000)
    return f"{h:02}:{m:02}:{s:02},{ms:03}"
def wrap(words, n=W):
    ls = ['']
    for w in words:
        c = (ls[-1] + ' ' + w).strip()
        if len(c) > n and ls[-1]: ls.append(w)
        else: ls[-1] = c
    return ls
def fits(words): return len(wrap(words)) <= L
def balanced(words):
    """Split words into the fewest groups that each fit 2 x 42, with groups as even in length as possible."""
    if fits(words): return [words]
    total = len(' '.join(words))
    for k in range(2, len(words) + 1):
        target = total / k; groups, cur = [], []
        for i, w in enumerate(words):
            left = len(words) - i; need = k - len(groups) - 1
            if cur and (len(' '.join(cur + [w])) > target * 1.15 or left == need) and len(groups) < k - 1:
                groups.append(cur); cur = []
            cur.append(w)
        groups.append(cur)
        if all(fits(g) for g in groups): return groups
    return [[w] for w in words]
def split_cue(a, b, words):
    gs = balanced(words); tot = sum(len(' '.join(g)) for g in gs); t, out = a, []
    for g in gs:
        d = (b - a) * len(' '.join(g)) / tot; out.append([t, t + d, g]); t += d
    return out
def short(c): return (c[1] - c[0]) < MIN_S or len(c[2]) <= 2
cues = []
for blk in open(sys.argv[1], encoding='utf-8').read().strip().split('\n\n'):
    lines = blk.strip().split('\n')
    if len(lines) < 3: continue
    a, b = [ts2s(x.strip()) for x in lines[1].split('-->')]
    text = re.sub(r'\b((?:[A-Z]\.){2,})', lambda m: m.group(1).replace('.', ''), ' '.join(lines[2:]))
    cues += split_cue(a, b, text.split())
changed = True
while changed:
    changed = False
    for i, c in enumerate(cues):
        if not short(c) or len(cues) == 1: continue
        j = i - 1 if i > 0 else i + 1
        if i > 0 and i + 1 < len(cues) and (cues[i+1][0] - c[1]) < (c[0] - cues[i-1][1]) - 0.3: j = i + 1
        p, q = sorted((i, j)); A, B = cues[p], cues[q]
        if B[0] - A[1] > 1.5: continue          # a real pause: leave the gap alone
        merged = split_cue(A[0], B[1], A[2] + B[2])
        if len(merged) == 1 or not any(short(m) for m in merged):
            cues[p:q+1] = merged; changed = True; break
with open(sys.argv[2], 'w', encoding='utf-8') as f:
    for i, (a, b, g) in enumerate(cues, 1): f.write(f"{i}\n{s2ts(a)} --> {s2ts(b)}\n" + '\n'.join(wrap(g)) + "\n\n")

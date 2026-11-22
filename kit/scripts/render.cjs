// Hand-drawn motion graphics renderer (no browser, no GPU).
// Builds one SVG per frame (rough.js sketch strokes + opentype.js glyph outlines),
// rasterises it with resvg and pipes raw frames to ffmpeg.
// Usage: NODE_PATH=<node_modules> node render.cjs <content.json> <timeline.json> <9x16|16x9> <out_video.mp4> [--from N --to N] [--still t1,t2]
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const rough = require('roughjs');
const opentype = require('opentype.js');
const { Resvg } = require('@resvg/resvg-js');

const args = process.argv.slice(2);
const [contentPath, timelinePath, FORMAT, OUT] = args;
const opt = (k) => { const i = args.indexOf(k); return i > -1 ? args[i + 1] : null; };
const FPS = 30;
const HERE = __dirname;
const FONTS = path.join(HERE, '..', 'fonts');
const C = JSON.parse(fs.readFileSync(contentPath, 'utf8'));
const TL = args.includes('--layout-only') ? { segments: [], duration: 0 } : JSON.parse(fs.readFileSync(timelinePath, 'utf8'));
const SEG = Object.fromEntries(TL.segments.map((s) => [s.id, s]));

// Brand palette (agentive-brand skill, section 3; screen palette).
const P = { navy0: '#03051a', navy3: '#12173d', navy4: '#1b2150', gold: '#d9a84c', goldHi: '#f2d68e',
  goldTx: '#e5bd63', copper: '#c98a4c', fg: '#f4efe4', muted: '#b8b2a4', subtle: '#8d877a',
  success: '#7fd39a', danger: '#ff8d76' };
const GROUP = { gold: '#d9a84c', green: '#7fd39a', coral: '#ff8d76', copper: '#c98a4c', light: '#f2d68e' }; // optional per-card group colour
const ACCENT = [P.gold, P.success, P.copper, P.goldHi, P.success, P.gold, P.copper, P.danger, P.success, P.goldHi, P.gold, P.copper];

const loadFont = (f) => { const b = fs.readFileSync(path.join(FONTS, f)); return opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
const F = { bold: loadFont('Kalam-700.ttf'), reg: loadFont('Kalam-400.ttf'), mono: loadFont('JetBrainsMono.ttf') };

// ---------------------------------------------------------------- layout
// Academy lesson variant: 16:9 only, 4 to 12 cards (one row up to 6, else two centred rows), foundation row optional.
if (FORMAT !== '16x9') throw new Error('lesson videos render 16x9 only');
const HAS_FOUND = !!(C.foundation && C.foundation.items && C.foundation.items.length);
const L = (() => {
  const W = 1920, H = 1080, cw = 255, ch = 270, gx = 54, n = C.cards.length;
  const rows = n <= 6 ? [n] : [Math.ceil(n / 2), n - Math.ceil(n / 2)];
  const ys = rows.length === 1 ? [HAS_FOUND ? 330 : 450] : [215, 520];
  const cards = []; rows.forEach((cnt, r) => { const tw = cnt * cw + (cnt - 1) * gx, x0 = (W - tw) / 2;
    for (let i = 0; i < cnt; i++) cards.push({ x: x0 + i * (cw + gx), y: ys[r], w: cw, h: ch }); });
  return { W, H, cards, icon: 92, iconY: 38, tSize: 36, tY: 176, sSize: 23, sY: [222, 246], ul: 189,
    title: { lines: [[C.title.text + ' ', C.title.em]], size: 74, ys: [108], swooshY: 128, kickerY: 168, kSize: 22 },
    found: { x: 60, w: 1800, slabY: 812, slabH: 22, y: 834, h: 140, tSize: 32 },
    footY: 1028, fSize: 18, camCard: 2.0, camTitle: 1.6, label: 1012 };
})();
const { W, H } = L;
// v2 optional note: a small mono line under the kicker. Only when present, the title block moves up and (9:16) the board down a little to make room.
const NOTE = C.note || null;
if (NOTE) {
  const up = L.W === 1920 ? 34 : 20, down = L.W === 1920 ? 0 : 24;
  L.title.ys = L.title.ys.map((y) => y - up); L.title.swooshY -= up; L.title.kickerY -= up;
  L.cards.forEach((b) => { b.y += down; }); L.found.slabY += down; L.found.y += down; L.footY += down; L.label += down;
  L.noteY = L.title.kickerY + (L.W === 1920 ? 40 : 38);
}
const FOOTER = C.footer || 'AGENTIVE ACADEMY';

// ---------------------------------------------------------------- layout preflight (fails the build on any text wider than its box)
{
  const bad = []; const cw = L.cards[0].w;
  const tw = F.bold.getAdvanceWidth(C.title.text + ' ' + C.title.em, L.title.size); if (tw > 1500) bad.push(`title ${Math.round(tw)} px wide, max 1500`);
  C.cards.forEach((c, i) => { const w = F.bold.getAdvanceWidth(c.title, L.tSize); if (w > cw - 20) bad.push(`card ${i + 1} title "${c.title}" ${Math.round(w)} px, max ${cw - 20}`);
    const longest = Math.max(...c.sub.split(' ').map((x) => F.reg.getAdvanceWidth(x, 18))); if (longest > cw - 26) bad.push(`card ${i + 1} sub word too wide`);
    const lines2 = F.reg.getAdvanceWidth(c.sub, Math.round(L.sSize * 0.8)); if (lines2 > 2 * (cw - 26) * 0.95) bad.push(`card ${i + 1} sub "${c.sub}" needs more than two lines`); });
  if (HAS_FOUND) { const sw = L.found.w / C.foundation.items.length - 34;
    C.foundation.items.forEach((it, i) => { const ws = it.text.split(' '), h = Math.ceil(ws.length / 2); const parts = ws.length > 1 && F.bold.getAdvanceWidth(it.text, L.found.tSize) > sw + 10 ? [ws.slice(0, h).join(' '), ws.slice(h).join(' ')] : [it.text];
      parts.forEach((p) => { const w = F.bold.getAdvanceWidth(p, L.found.tSize); if (w > sw) bad.push(`foundation ${i + 1} "${p}" ${Math.round(w)} px, max ${Math.round(sw)}`); }); }); }
  { const ws = C.cta.text.split(' '); for (const p of [ws.slice(0, 3).join(' '), ws.slice(3).join(' ')]) { const w = F.bold.getAdvanceWidth(p, 66); if (w > 920) bad.push(`cta line "${p}" ${Math.round(w)} px, max 920`); } }
  if (bad.length) { console.error('layout check failed:\n  ' + bad.join('\n  ')); process.exit(3); }
  if (args.includes('--layout-only')) { console.log('layout OK'); process.exit(0); }
}

// ---------------------------------------------------------------- geometry helpers
const gen = rough.generator();
const VARIANTS = 3, BOIL_FRAMES = 4;
function bez(p0, p1, p2, p3, n, out) {
  for (let i = 1; i <= n; i++) { const t = i / n, u = 1 - t;
    out.push([u*u*u*p0[0] + 3*u*u*t*p1[0] + 3*u*t*t*p2[0] + t*t*t*p3[0], u*u*u*p0[1] + 3*u*u*t*p1[1] + 3*u*t*t*p2[1] + t*t*t*p3[1]]); }
}
function measure(subs) { // subs: array of point arrays -> {subs, cum, len}
  let len = 0; const out = [];
  for (const pts of subs) { if (pts.length < 2) continue; const cum = [len];
    for (let i = 1; i < pts.length; i++) { len += Math.hypot(pts[i][0] - pts[i-1][0], pts[i][1] - pts[i-1][1]); cum.push(len); }
    out.push({ pts, cum }); }
  return { subs: out, len };
}
function opsToSubs(ops, tf) {
  const subs = []; let cur = null, last = null;
  for (const o of ops) {
    const d = o.data;
    if (o.op === 'move') { cur = [tf(d[0], d[1])]; subs.push(cur); last = [d[0], d[1]]; }
    else if (o.op === 'lineTo') { cur.push(tf(d[0], d[1])); last = [d[0], d[1]]; }
    else if (o.op === 'bcurveTo') { const tmp = []; bez(last, [d[0], d[1]], [d[2], d[3]], [d[4], d[5]], 8, tmp); tmp.forEach((p) => cur.push(tf(p[0], p[1]))); last = [d[4], d[5]]; }
  }
  return subs;
}
// A rough shape -> {stroke: [variants], hatch: [variants], solid: polygon|null}
let seedBase = 11;
function roughShape(make, tf, o = {}) {
  const res = { stroke: [], hatch: [], solid: null };
  const s0 = seedBase++ * 7;
  for (let v = 0; v < VARIANTS; v++) {
    const dr = make({ roughness: o.roughness ?? 1.15, bowing: o.bowing ?? 1, seed: s0 + v * 101, strokeWidth: 1,
      fill: o.fill, fillStyle: o.fillStyle || 'hachure', hachureGap: o.gap || 7, fillWeight: 1, hachureAngle: o.angle ?? -41,
      disableMultiStroke: !!o.single, preserveVertices: !!o.preserve });
    const st = [], ha = [];
    for (const set of dr.sets) {
      if (set.type === 'path') st.push(...opsToSubs(set.ops, tf));
      else if (set.type === 'fillSketch') ha.push(...opsToSubs(set.ops, tf));
      else if (set.type === 'fillPath' && v === 0) res.solid = opsToSubs(set.ops, tf);
    }
    res.stroke.push(measure(st)); res.hatch.push(measure(ha));
  }
  return res;
}
const affine = (ox, oy, s) => (x, y) => [ox + x * s, oy + y * s];
const ID = (x, y) => [x, y];

// text -> glyph outline (for tracing) + fill path data
function textShape(font, str, size, x, y, align = 'center') {
  const wdt = font.getAdvanceWidth(str, size);
  const x0 = align === 'center' ? x - wdt / 2 : align === 'right' ? x - wdt : x;
  const p = font.getPath(str, x0, y, size);
  const subs = []; let cur = null, last = null;
  for (const c of p.commands) {
    if (c.type === 'M') { cur = [[c.x, c.y]]; subs.push(cur); last = [c.x, c.y]; }
    else if (c.type === 'L') { cur.push([c.x, c.y]); last = [c.x, c.y]; }
    else if (c.type === 'Q') { const tmp = []; bez(last, [last[0] + 2/3*(c.x1-last[0]), last[1] + 2/3*(c.y1-last[1])], [c.x + 2/3*(c.x1-c.x), c.y + 2/3*(c.y1-c.y)], [c.x, c.y], 6, tmp); cur.push(...tmp); last = [c.x, c.y]; }
    else if (c.type === 'C') { const tmp = []; bez(last, [c.x1, c.y1], [c.x2, c.y2], [c.x, c.y], 6, tmp); cur.push(...tmp); last = [c.x, c.y]; }
    else if (c.type === 'Z' && cur && cur.length) { cur.push([cur[0][0], cur[0][1]]); }
  }
  const m = measure(subs);
  // fill from our own flattened outline (resvg dropped glyphs from opentype's path data at some offsets)
  const d = m.subs.map((q) => 'M' + q.pts.map((pt) => pt[0].toFixed(1) + ' ' + pt[1].toFixed(1)).join('L') + 'Z').join('');
  return { outline: m, d, width: wdt, x0 };
}

// ---------------------------------------------------------------- scene elements
// element kinds: stroke (rough, boils), solid (fade), text (trace then fill), badge (pop), dash (arrow)
const E = [];
const ease = (u) => (u < 0.5 ? 4*u*u*u : 1 - Math.pow(-2*u + 2, 3) / 2);
const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
function addRough(shape, color, width, t0, t1, opts = {}) {
  E.push({ k: 'stroke', v: shape.stroke, color, width, t0, t1, op: opts.op ?? 1 });
  if (shape.hatch[0].len > 0) E.push({ k: 'stroke', v: shape.hatch, color: opts.hatchColor || color, width: opts.hw || width * 0.55, t0: opts.h0 ?? t1 - (t1 - t0) * 0.3, t1: opts.h1 ?? t1 + (t1 - t0) * 0.5, op: opts.hop ?? 0.85 });
  if (shape.solid && opts.solidColor) E.push({ k: 'solid', subs: shape.solid, color: opts.solidColor, t0, t1, op: opts.solidOp ?? 1 });
}
function addText(font, str, size, x, y, color, t0, t1, align, op = 1) {
  const s = textShape(font, str, size, x, y, align);
  E.push({ k: 'text', s, color, t0, t1, op });
  return s;
}
// rounded rectangle path
const rrect = (x, y, w, h, r) => `M${x+r},${y} L${x+w-r},${y} Q${x+w},${y} ${x+w},${y+r} L${x+w},${y+h-r} Q${x+w},${y+h} ${x+w-r},${y+h} L${x+r},${y+h} Q${x},${y+h} ${x},${y+h-r} L${x},${y+r} Q${x},${y} ${x+r},${y} Z`;

// icons drawn in a 100x100 box; each returns list of [makeFn, opts, colorKey]
function icon(name, A) {
  const S = []; const add = (make, o = {}, col = 'ink') => S.push({ make, o, col });
  const fillA = { fill: A, gap: 6 };
  switch (name) {
    case 'kernel':
      add((o) => gen.path(rrect(18, 6, 58, 80, 4), o));
      add((o) => gen.line(28, 26, 66, 26, o)); add((o) => gen.line(28, 40, 66, 40, o)); add((o) => gen.line(28, 54, 52, 54, o));
      add((o) => gen.circle(72, 76, 34, o), fillA, 'A'); add((o) => gen.linearPath([[63, 76], [70, 83], [82, 68]], o), {}, 'ink');
      break;
    case 'routing':
      add((o) => gen.line(50, 12, 50, 96, o));
      add((o) => gen.polygon([[50, 18], [84, 18], [95, 29], [84, 40], [50, 40]], o), fillA, 'A');
      add((o) => gen.polygon([[50, 50], [16, 50], [5, 61], [16, 72], [50, 72]], o));
      add((o) => gen.line(30, 96, 70, 96, o));
      break;
    case 'robot':
      add((o) => gen.line(50, 26, 50, 12, o)); add((o) => gen.circle(50, 9, 9, o), fillA, 'A');
      add((o) => gen.path(rrect(20, 26, 60, 48, 8), o), fillA, 'A');
      add((o) => gen.circle(38, 46, 13, o)); add((o) => gen.circle(62, 46, 13, o)); add((o) => gen.line(38, 62, 62, 62, o));
      add((o) => gen.line(30, 74, 30, 92, o)); add((o) => gen.line(70, 74, 70, 92, o)); add((o) => gen.line(22, 92, 78, 92, o));
      break;
    case 'code':
      add((o) => gen.path(rrect(6, 14, 88, 72, 6), o)); add((o) => gen.line(6, 28, 94, 28, o));
      add((o) => gen.circle(15, 21, 5, o)); add((o) => gen.circle(25, 21, 5, o));
      add((o) => gen.linearPath([[36, 42], [24, 56], [36, 70]], o), {}, 'A'); add((o) => gen.linearPath([[64, 42], [76, 56], [64, 70]], o), {}, 'A');
      add((o) => gen.line(56, 38, 44, 74, o), {}, 'A');
      break;
    case 'toolbox':
      add((o) => gen.path('M34,42 L34,30 Q34,26 38,26 L62,26 Q66,26 66,30 L66,42', o));
      add((o) => gen.path(rrect(10, 42, 80, 46, 5), o), fillA, 'A'); add((o) => gen.line(10, 58, 90, 58, o));
      add((o) => gen.path(rrect(44, 54, 12, 9, 2), o));
      add((o) => gen.line(70, 8, 84, 36, o)); add((o) => gen.circle(68, 8, 12, o));
      break;
    case 'database':
      add((o) => gen.ellipse(50, 20, 64, 20, o), fillA, 'A');
      add((o) => gen.line(18, 20, 18, 80, o)); add((o) => gen.line(82, 20, 82, 80, o));
      add((o) => gen.arc(50, 40, 64, 20, 0, Math.PI, false, o)); add((o) => gen.arc(50, 60, 64, 20, 0, Math.PI, false, o));
      add((o) => gen.arc(50, 80, 64, 20, 0, Math.PI, false, o));
      break;
    case 'plug':
      add((o) => gen.line(40, 6, 40, 22, o)); add((o) => gen.line(60, 6, 60, 22, o));
      add((o) => gen.path(rrect(28, 22, 44, 34, 6), o), fillA, 'A');
      add((o) => gen.path('M50,56 L50,66 Q50,78 38,80 Q22,82 24,96', o));
      add((o) => gen.path('M80,40 L92,34 M80,52 L94,52 M80,64 L92,70', o), {}, 'A');
      break;
    case 'target':
      add((o) => gen.circle(46, 54, 80, o)); add((o) => gen.circle(46, 54, 52, o)); add((o) => gen.circle(46, 54, 22, o), { fill: A, gap: 4 }, 'A');
      add((o) => gen.line(46, 54, 90, 10, o), {}, 'A'); add((o) => gen.linearPath([[80, 8], [90, 10], [92, 20]], o), {}, 'A');
      break;
    case 'shield':
      add((o) => gen.path('M50,6 L86,18 Q86,66 50,94 Q14,66 14,18 Z', o), fillA, 'A');
      add((o) => gen.linearPath([[32, 50], [45, 63], [70, 36]], o), {}, 'ink');
      break;
    case 'log':
      add((o) => gen.path(rrect(18, 8, 66, 84, 5), o));
      for (const y of [22, 40, 58, 76]) add((o) => gen.circle(18, y, 8, o), {}, 'A');
      add((o) => gen.linearPath([[32, 28], [36, 32], [42, 24]], o), {}, 'A'); add((o) => gen.line(48, 28, 74, 28, o));
      add((o) => gen.linearPath([[32, 48], [36, 52], [42, 44]], o), {}, 'A'); add((o) => gen.line(48, 48, 74, 48, o));
      add((o) => gen.linearPath([[32, 68], [36, 72], [42, 64]], o), {}, 'A'); add((o) => gen.line(48, 68, 68, 68, o));
      break;
    case 'sign':
      add((o) => gen.path(rrect(8, 18, 70, 76, 4), o)); add((o) => gen.line(18, 34, 58, 34, o)); add((o) => gen.line(18, 46, 50, 46, o));
      add((o) => gen.curve([[16, 74], [24, 62], [30, 76], [38, 64], [44, 78], [56, 68], [66, 72]], o), {}, 'A');
      add((o) => gen.line(16, 84, 66, 84, o));
      add((o) => gen.polygon([[62, 58], [90, 10], [98, 15], [70, 63], [60, 68]], o), fillA, 'A');
      break;
    case 'copies':
      add((o) => gen.path(rrect(30, 8, 62, 44, 6), o), fillA, 'A'); add((o) => gen.circle(82, 30, 7, o));
      add((o) => gen.path(rrect(8, 46, 62, 44, 6), o), fillA, 'A'); add((o) => gen.circle(60, 68, 7, o));
      add((o) => gen.line(18, 68, 44, 68, o)); add((o) => gen.line(40, 30, 66, 30, o));
      break;
    case 'clock':
      add((o) => gen.circle(50, 52, 84, o), fillA, 'A'); add((o) => gen.linearPath([[50, 52], [50, 24]], o)); add((o) => gen.linearPath([[50, 52], [70, 62]], o));
      add((o) => gen.line(50, 14, 50, 20, o)); add((o) => gen.line(88, 52, 82, 52, o)); add((o) => gen.line(50, 90, 50, 84, o)); add((o) => gen.line(12, 52, 18, 52, o));
      break;
    case 'lock':
      add((o) => gen.path('M30,46 L30,32 Q30,12 50,12 Q70,12 70,32 L70,46', o));
      add((o) => gen.path(rrect(18, 46, 64, 46, 6), o), fillA, 'A'); add((o) => gen.circle(50, 64, 12, o)); add((o) => gen.line(50, 70, 50, 80, o));
      break;
    case 'eye':
      add((o) => gen.path('M6,50 Q50,8 94,50 Q50,92 6,50 Z', o)); add((o) => gen.circle(50, 50, 34, o), fillA, 'A'); add((o) => gen.circle(50, 50, 10, o), { fill: '#03051a', gap: 3 });
      break;
    case 'chart':
      add((o) => gen.linearPath([[8, 8], [8, 92], [94, 92]], o));
      add((o) => gen.rectangle(20, 64, 14, 26, o), fillA, 'A'); add((o) => gen.rectangle(42, 46, 14, 44, o), fillA, 'A'); add((o) => gen.rectangle(64, 24, 14, 66, o), fillA, 'A');
      add((o) => gen.linearPath([[20, 50], [48, 30], [80, 10]], o), {}, 'ink'); add((o) => gen.linearPath([[70, 10], [80, 10], [80, 20]], o));
      break;
    case 'dice':
      add((o) => gen.path(rrect(10, 10, 80, 80, 12), o), fillA, 'A');
      for (const [x, y] of [[30, 30], [70, 30], [50, 50], [30, 70], [70, 70]]) add((o) => gen.circle(x, y, 11, o), { fill: '#f4efe4', gap: 2 });
      break;
    case 'refresh':
      add((o) => gen.arc(50, 50, 72, 72, Math.PI * 1.1, Math.PI * 1.95, false, o), {}, 'A'); add((o) => gen.linearPath([[78, 18], [84, 34], [68, 36]], o), {}, 'A');
      add((o) => gen.arc(50, 50, 72, 72, Math.PI * 0.1, Math.PI * 0.95, false, o)); add((o) => gen.linearPath([[22, 82], [16, 66], [32, 64]], o));
      break;
    case 'mail':
      add((o) => gen.path(rrect(6, 20, 88, 62, 6), o), fillA, 'A'); add((o) => gen.linearPath([[8, 24], [50, 56], [92, 24]], o));
      add((o) => gen.line(8, 80, 38, 52, o)); add((o) => gen.line(92, 80, 62, 52, o));
      break;
    case 'box':
      add((o) => gen.polygon([[50, 8], [90, 28], [50, 48], [10, 28]], o), { fill: '#03051a', gap: 4 });
      add((o) => gen.polygon([[10, 28], [50, 48], [50, 94], [10, 74]], o), fillA, 'A'); add((o) => gen.polygon([[50, 48], [90, 28], [90, 74], [50, 94]], o));
      add((o) => gen.path('M66,60 Q74,54 74,64 Q74,70 70,72 M70,80 L70,82', o));
      break;
    case 'phone':
      add((o) => gen.path(rrect(26, 4, 48, 92, 8), o)); add((o) => gen.path(rrect(32, 14, 36, 64, 3), o), fillA, 'A');
      add((o) => gen.circle(50, 86, 6, o)); add((o) => gen.line(44, 9, 56, 9, o));
      break;
    default: throw new Error('no icon ' + name);
  }
  return S;
}

// ---- background atmosphere and footer (board space)
// ---- title
const tseg = SEG.title; const T0 = tseg.start;
{
  const t = L.title; let t0 = T0 + 0.05;
  t.lines.forEach((parts, li) => {
    const total = parts.reduce((s, p) => s + F.bold.getAdvanceWidth(p, t.size), 0);
    let x = W / 2 - total / 2;
    parts.forEach((p, pi) => {
      const isEm = pi === 1; const wd = F.bold.getAdvanceWidth(p, t.size); const dur = 0.25 + p.length * 0.055;
      addText(F.bold, p, t.size, x, t.ys[li], isEm ? P.goldTx : P.fg, t0, t0 + dur, 'left');
      t0 += dur * 0.85; x += wd;
    });
  });
  const sw = L.W === 1920 ? 560 : 520;
  addRough(roughShape((o) => gen.curve([[W/2 - sw/2, t.swooshY + 6], [W/2 - sw/6, t.swooshY - 2], [W/2 + sw/4, t.swooshY + 2], [W/2 + sw/2, t.swooshY - 8]], o), ID, { roughness: 1.4 }), P.gold, 6, t0, t0 + 0.45);
  // sparkles
  const tw = L.W === 1920 ? 940 : 600; const sy = t.ys[0] - t.size * 0.55;
  for (const [sx, dir] of [[W/2 - tw/2 - 30, -1], [W/2 + tw/2 + 30, 1]]) {
    const sh = roughShape((o) => gen.path(`M${sx},${sy} l${dir*-14},${-14} M${sx + dir*8},${sy - 4} l${dir*4},${-20} M${sx - dir*4},${sy + 8} l${dir*-20},${-2}`, o), ID, { roughness: 0.8 });
    addRough(sh, P.goldHi, 4, t0 + 0.35, t0 + 0.7);
  }
  // kicker in mono with the gold rule
  const ks = textShape(F.mono, C.title.kicker.split('').join(' '), t.kSize, W / 2 + 20, t.kickerY, 'center');
  E.push({ k: 'text', s: ks, color: P.goldTx, t0: t0 + 0.55, t1: t0 + 1.25, op: 1 });
  addRough(roughShape((o) => gen.line(ks.x0 - 46, t.kickerY - t.kSize * 0.35, ks.x0 - 12, t.kickerY - t.kSize * 0.35, o), ID, { single: true }), P.gold, 2.5, t0 + 0.55, t0 + 0.8);
  if (NOTE) { // 28 px when it fits the 980 px board width (60 characters still land at about 27 px)
    const maxw = L.W === 1920 ? 1500 : 980; const nsz = Math.min(28, maxw / (F.mono.getAdvanceWidth(NOTE, 1) || 1));
    E.push({ k: 'text', s: textShape(F.mono, NOTE, nsz, W / 2, L.noteY, 'center'), color: P.goldTx, t0: t0 + 1.0, t1: t0 + 1.6, op: 0.9 });
  }
}

// ---- cards and arrows
const EV = []; // sound events
C.cards.forEach((c, i) => {
  const s = SEG['card' + (i + 1)]; const b = L.cards[i]; const A = c.accent ? (GROUP[c.accent] || ACCENT[i % ACCENT.length]) : ACCENT[i % ACCENT.length];
  const k = clamp((s.end - s.start) / 2.2, 0.55, 1); const a = s.start - 0.05; const T = (u) => a + u * k;
  // card body: navy fill + sketch border
  E.push({ k: 'solid', subs: [[[b.x + 6, b.y], [b.x + b.w - 6, b.y], [b.x + b.w, b.y + 6], [b.x + b.w, b.y + b.h - 6], [b.x + b.w - 6, b.y + b.h], [b.x + 6, b.y + b.h], [b.x, b.y + b.h - 6], [b.x, b.y + 6]]], color: P.navy3, t0: T(0), t1: T(0.4), op: 0.85 });
  addRough(roughShape((o) => gen.path(rrect(b.x, b.y, b.w, b.h, 16), o), ID, { roughness: 1.3, bowing: 1.5 }), A, 3.4, T(0), T(0.75));
  // badge
  E.push({ k: 'badge', cx: b.x + b.w / 2, cy: b.y, r: L.W === 1920 ? 27 : 31, color: A, n: c.badge || String(i + 1), t0: T(0.05), t1: T(0.05) + 0.32 });
  EV.push({ t: T(0.05), type: 'pop' });
  // icon: shapes drawn one after another across the icon window
  const sz = L.icon, ox = b.x + b.w / 2 - sz / 2, oy = b.y + L.iconY, tf = affine(ox, oy, sz / 100);
  const parts = icon(c.icon, A).map((p) => ({ p, sh: roughShape(p.make, tf, { fill: p.o.fill, gap: p.o.gap, roughness: 1.0 }) }));
  const tot = parts.reduce((s2, q) => s2 + q.sh.stroke[0].len, 0); let acc = 0; const w0 = T(0.25), w1 = T(1.2);
  parts.forEach(({ p, sh }) => {
    const f0 = w0 + (acc / tot) * (w1 - w0); acc += sh.stroke[0].len; const f1 = w0 + (acc / tot) * (w1 - w0);
    addRough(sh, p.col === 'A' ? A : P.fg, 3, f0, Math.max(f1, f0 + 0.08), { h0: T(0.85), h1: T(1.5), hw: 1.7, hatchColor: A });
  });
  // title, underline, subtitle
  const ts = addText(F.bold, c.title, L.tSize, b.x + b.w / 2, b.y + L.tY, P.fg, T(0.45), T(1.25), 'center');
  const uw = Math.min(150, ts.width * 0.7);
  addRough(roughShape((o) => gen.line(b.x + b.w / 2 - uw / 2, b.y + L.ul, b.x + b.w / 2 + uw / 2, b.y + L.ul - 2, o), ID, { roughness: 1.2 }), A, 4, T(1.2), T(1.45));
  const maxw = b.w - 26; const words = c.sub.split(' ');
  const wrap = (sz) => { const ls = ['']; for (const wd of words) { const cand = (ls[ls.length - 1] + ' ' + wd).trim(); if (F.reg.getAdvanceWidth(cand, sz) > maxw && ls[ls.length - 1]) ls.push(wd); else ls[ls.length - 1] = cand; } return ls; };
  // v2.1: shrink to fit one line (down to 80%); if it still needs two, lift both lines so the second clears the card's bottom border
  let sSz = L.sSize, lines = wrap(sSz); const sMin = Math.round(L.sSize * 0.8); while (lines.length > 1 && sSz > sMin) lines = wrap(--sSz);
  while (lines.length > 2 && sSz > 18) lines = wrap(--sSz); // never a third line below the card
  const sYs = lines.length === 1 ? [L.sY[0] - 4] : [L.sY[0] - 9, L.sY[1] - 11];
  lines.forEach((ln, li) => addText(F.reg, ln, sSz, b.x + b.w / 2, b.y + sYs[li], P.muted, T(1.1 + li * 0.2), T(1.7 + li * 0.2), 'center'));
  // arrow to the next card, drawn as the narration moves on
  if (i < C.cards.length - 1) {
    const n = L.cards[i + 1]; const ns = SEG['card' + (i + 2)];
    let pts;
    if (Math.abs(n.y - b.y) < 1) pts = [[b.x + b.w + 9, b.y + b.h / 2], [n.x - 9, n.y + n.h / 2]];
    else { const gy = (b.y + b.h + n.y) / 2; pts = [[b.x + b.w - 50, b.y + b.h + 8], [b.x + b.w - 50, gy], [n.x + 50, gy], [n.x + 50, n.y - 10]]; }
    E.push({ k: 'dash', pts, color: P.muted, width: 3, t0: ns.start - 0.4, t1: ns.start + 0.12 });
  }
});

// ---- foundation (optional)
const PULL = HAS_FOUND ? SEG.found.start : SEG.cta.start - 0.9;
if (HAS_FOUND) {
  const f = L.found; const fs0 = SEG.found;
  E.push({ k: 'solid', subs: [[[f.x, f.slabY], [f.x + f.w, f.slabY], [f.x + f.w, f.slabY + f.slabH], [f.x, f.slabY + f.slabH]]], color: P.navy4, t0: fs0.start, t1: fs0.start + 0.5, op: 0.9 });
  addRough(roughShape((o) => gen.rectangle(f.x, f.slabY, f.w, f.slabH, o), ID, { fill: P.subtle, fillStyle: 'cross-hatch', gap: 10, roughness: 1.4 }), P.muted, 3, fs0.start, fs0.start + 0.9, { hop: 0.5, hw: 1.3 });
  const n = C.foundation.items.length, sw = f.w / n;
  C.foundation.items.forEach((it, i) => {
    const s = SEG['found' + (i + 1)]; const x = f.x + i * sw + 5, w = sw - 10, a = s.start - 0.1;
    E.push({ k: 'solid', subs: [[[x, f.y], [x + w, f.y], [x + w, f.y + f.h], [x, f.y + f.h]]], color: P.navy3, t0: a, t1: a + 0.3, op: 0.9 });
    addRough(roughShape((o) => gen.rectangle(x, f.y, w, f.h, o), ID, { fill: P.subtle, gap: 11, roughness: 1.6, bowing: 2, angle: 50 }), P.muted, 3, a, a + 0.45, { hop: 0.22, hw: 1.2, h0: a + 0.2, h1: a + 0.6 });
    // a crack or two for the stone feel
    addRough(roughShape((o) => gen.linearPath([[x + w * 0.78, f.y + 4], [x + w * 0.72, f.y + 22], [x + w * 0.8, f.y + 34]], o), ID, { single: true }), P.subtle, 2, a + 0.3, a + 0.5);
    const words = it.text.split(' '); const lines = words.length > 1 && F.bold.getAdvanceWidth(it.text, f.tSize) > w - 24 ? [words.slice(0, Math.ceil(words.length / 2)).join(' '), words.slice(Math.ceil(words.length / 2)).join(' ')] : [it.text];
    const cy = f.y + f.h / 2 + f.tSize * 0.33;
    lines.forEach((ln, li) => addText(F.bold, ln, f.tSize, x + w / 2, cy + (li - (lines.length - 1) / 2) * f.tSize * 1.1, P.fg, a + 0.15 + li * 0.15, a + 0.7 + li * 0.15, 'center'));
    EV.push({ t: a, type: 'thud' });
  });
}
{ const ft = textShape(F.mono, FOOTER, L.fSize, W / 2, L.footY, 'center');
  E.push({ k: 'text', s: ft, color: P.subtle, t0: PULL + 0.3, t1: PULL + 1.2, op: 1 }); }

// ---- call to action box (board centre, drawn over the finished board)
const CTA = (() => {
  const s = SEG.cta; const bw = L.W === 1920 ? 980 : 820, bh = L.W === 1920 ? 210 : 250;
  const x = W / 2 - bw / 2, y = H / 2 - bh / 2 - (L.W === 1920 ? 0 : 40); const a = s.start - 0.15;
  E.push({ k: 'solid', subs: [[[-W, -H], [2 * W, -H], [2 * W, 2 * H], [-W, 2 * H]]], color: P.navy0, t0: a - 0.1, t1: a + 0.35, op: 0.72 }); // lesson variant: board dims behind the closing card
  E.push({ k: 'solid', subs: [[[x, y], [x + bw, y], [x + bw, y + bh], [x, y + bh]]], color: P.navy0, t0: a, t1: a + 0.25, op: 1 });
  addRough(roughShape((o) => gen.path(rrect(x, y, bw, bh, 22), o), ID, { roughness: 1.5, bowing: 2 }), P.gold, 5, a, a + 0.6);
  const sz = L.W === 1920 ? 66 : 64; const words = C.cta.text.split(' ');
  const l1 = words.slice(0, 3).join(' '), l2 = words.slice(3).join(' ');
  addText(F.bold, l1, sz, W / 2, y + bh / 2 - sz * 0.15, P.fg, a + 0.2, a + 0.9, 'center');
  addText(F.bold, l2, sz, W / 2, y + bh / 2 + sz * 0.95, P.goldTx, a + 0.6, a + 1.3, 'center');
  EV.push({ t: a, type: 'pop' });
  return { a };
})();

const END = { a: null }; // lesson videos have no contact end card

// ---------------------------------------------------------------- camera
const cam = [];
cam.push({ at: 0, cx: W / 2, cy: 0, z: L.camTitle, lift: 160 }); // lift: keeps the approved v1 framing (the band above the title)
C.cards.forEach((c, i) => { const b = L.cards[i]; cam.push({ at: SEG['card' + (i + 1)].start, cx: b.x + b.w / 2, cy: b.y + b.h / 2 - 10, z: L.camCard, lift: 0 }); }); // 9:16 row 1: keeps the approved v1 framing
cam.push({ at: PULL, cx: W / 2, cy: H / 2, z: 1, dur: 1.1 });
function camAt(t) {
  const clampC = (c) => { const hw = W / (2 * c.z), hh = H / (2 * c.z); return { cx: clamp(c.cx, hw, W - hw), cy: clamp(c.cy, hh - (c.lift || 0), H - hh), z: c.z }; };
  let cur = clampC(cam[0]);
  for (let i = 1; i < cam.length; i++) {
    const dur = cam[i].dur || 0.65; const st = cam[i].at - 0.5;
    if (t < st) break;
    const u = ease(clamp((t - st) / dur)); const tg = clampC(cam[i]);
    // interpolate zoom in log space so the move feels even
    const z = Math.exp(Math.log(cur.z) + (Math.log(tg.z) - Math.log(cur.z)) * u);
    cur = { cx: cur.cx + (tg.cx - cur.cx) * u, cy: cur.cy + (tg.cy - cur.cy) * u, z };
  }
  return cur;
}

// ---------------------------------------------------------------- frame builder
const f1 = (n) => n.toFixed(1);
function partial(m, p) { // measured polyline set -> path data up to fraction p
  if (p <= 0 || m.len === 0) return '';
  const lim = m.len * p; let d = '';
  for (const s of m.subs) {
    if (s.cum[0] >= lim) break;
    d += 'M' + f1(s.pts[0][0]) + ' ' + f1(s.pts[0][1]);
    for (let i = 1; i < s.pts.length; i++) {
      if (s.cum[i] <= lim) d += 'L' + f1(s.pts[i][0]) + ' ' + f1(s.pts[i][1]);
      else { const r = (lim - s.cum[i - 1]) / (s.cum[i] - s.cum[i - 1]); d += 'L' + f1(s.pts[i-1][0] + (s.pts[i][0] - s.pts[i-1][0]) * r) + ' ' + f1(s.pts[i-1][1] + (s.pts[i][1] - s.pts[i-1][1]) * r); break; }
    }
  }
  return d;
}
const polyD = (subs) => subs.map((s) => 'M' + s.map((p) => f1(p[0]) + ' ' + f1(p[1])).join('L') + 'Z').join('');
const drawnLen = new Float64Array(E.length);
const dashCache = new Map();
function dashes(e) {
  if (dashCache.has(e)) return dashCache.get(e);
  const m = measure([e.pts]); const out = []; const DL = 13, GP = 10;
  for (let s = 0; s < m.len - 4; s += DL + GP) out.push([s, Math.min(s + DL, m.len)]);
  const at = (l) => { const sub = m.subs[0]; for (let i = 1; i < sub.pts.length; i++) if (sub.cum[i] >= l) { const r = (l - sub.cum[i-1]) / (sub.cum[i] - sub.cum[i-1] || 1); return [sub.pts[i-1][0] + (sub.pts[i][0] - sub.pts[i-1][0]) * r, sub.pts[i-1][1] + (sub.pts[i][1] - sub.pts[i-1][1]) * r]; } return sub.pts[sub.pts.length - 1]; };
  const segs = out.map(([a, b]) => [at(a), at(b)]);
  const last = e.pts[e.pts.length - 1], prev = e.pts[e.pts.length - 2]; const ang = Math.atan2(last[1] - prev[1], last[0] - prev[0]);
  const head = [[last[0] - 15 * Math.cos(ang - 0.5), last[1] - 15 * Math.sin(ang - 0.5)], last, [last[0] - 15 * Math.cos(ang + 0.5), last[1] - 15 * Math.sin(ang + 0.5)]];
  const r = { segs, head, len: m.len }; dashCache.set(e, r); return r;
}

function frameSVG(fi) {
  const t = fi / FPS; const vi = Math.floor(fi / BOIL_FRAMES) % VARIANTS; const c = camAt(t);
  let body = '', ink = 0;
  E.forEach((e, ei) => {
    if (t < e.t0) return;
    const u = clamp((t - e.t0) / Math.max(1e-3, e.t1 - e.t0));
    if (e.k === 'stroke') {
      const m = e.v[vi]; const p = ease(u); const d = partial(m, p);
      const L0 = e.v[0].len * p; ink += Math.max(0, L0 - drawnLen[ei]) * (e.width > 2 ? 1 : 0.4); drawnLen[ei] = L0;
      if (d) body += `<path d="${d}" fill="none" stroke="${e.color}" stroke-width="${e.width}" stroke-linecap="round" stroke-linejoin="round" opacity="${e.op}"/>`;
    } else if (e.k === 'solid') {
      body += `<path d="${polyD(e.subs)}" fill="${e.color}" opacity="${(e.op * ease(u)).toFixed(3)}"/>`;
    } else if (e.k === 'text') {
      const tr = clamp(u / 0.7), fl = clamp((u - 0.35) / 0.65);
      const L0 = e.s.outline.len * ease(tr); ink += Math.max(0, L0 - drawnLen[ei]) * 0.25; drawnLen[ei] = L0;
      if (fl > 0) body += `<path d="${e.s.d}" fill="${e.color}" opacity="${(e.op * ease(fl)).toFixed(3)}"/>`;
      if (tr < 1 || fl < 1) { const d = partial(e.s.outline, ease(tr)); if (d) body += `<path d="${d}" fill="none" stroke="${e.color}" stroke-width="1.6" stroke-linejoin="round" opacity="${(1 - 0.6 * fl).toFixed(3)}"/>`; }
    } else if (e.k === 'badge') {
      const sc = u < 1 ? 1 + 2.2 * Math.pow(u - 1, 3) + 1.2 * Math.pow(u - 1, 2) : 1; // ease-out-back
      const ts = textShape(F.bold, e.n, e.r * 1.25, 0, e.r * 0.42, 'center');
      body += `<g transform="translate(${f1(e.cx)} ${f1(e.cy)}) scale(${Math.max(0.01, sc).toFixed(3)})"><circle r="${e.r}" fill="${e.color}"/><circle r="${e.r + 3}" fill="none" stroke="${P.navy0}" stroke-width="3"/><path d="${ts.d}" fill="${P.navy0}"/></g>`;
    } else if (e.k === 'dash') {
      const g = dashes(e); const p = ease(u); const lim = g.len * p; let d = '';
      g.segs.forEach(([a, b], si) => { if ((si * 23) <= lim) d += `M${f1(a[0])} ${f1(a[1])}L${f1(b[0])} ${f1(b[1])}`; });
      if (p > 0.97) d += `M${f1(g.head[0][0])} ${f1(g.head[0][1])}L${f1(g.head[1][0])} ${f1(g.head[1][1])}L${f1(g.head[2][0])} ${f1(g.head[2][1])}`;
      if (d) body += `<path d="${d}" fill="none" stroke="${e.color}" stroke-width="${e.width}" stroke-linecap="round" stroke-linejoin="round"/>`;
    }
  });
  const tf = `translate(${f1(W / 2)} ${f1(H / 2)}) scale(${c.z.toFixed(4)}) translate(${f1(-c.cx)} ${f1(-c.cy)})`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs><radialGradient id="g" cx="50%" cy="-5%" r="85%"><stop offset="0" stop-color="#d9a84c" stop-opacity="0.13"/><stop offset="0.6" stop-color="#d9a84c" stop-opacity="0"/></radialGradient>
<radialGradient id="g2" cx="100%" cy="100%" r="70%"><stop offset="0" stop-color="#2a3a8a" stop-opacity="0.22"/><stop offset="1" stop-color="#2a3a8a" stop-opacity="0"/></radialGradient></defs>
<rect width="${W}" height="${H}" fill="${P.navy0}"/><rect width="${W}" height="${H}" fill="url(#g)"/><rect width="${W}" height="${H}" fill="url(#g2)"/>
<g transform="${tf}">${body}</g></svg>`;
  return { svg, ink };
}

// ---------------------------------------------------------------- run
const total = Math.ceil(TL.duration * FPS);
async function main() {
  const still = opt('--still');
  if (still) {
    for (const ts of still.split(',')) {
      const fi = Math.round(parseFloat(ts) * FPS); for (let j = 0; j < fi; j++) frameSVG(j); // advance ink state
      const { svg } = frameSVG(fi); fs.writeFileSync(`${OUT}-${ts}.svg`, svg); fs.writeFileSync(`${OUT}-${ts}.png`, new Resvg(svg).render().asPng()); drawnLen.fill(0);
    }
    return;
  }
  const from = parseInt(opt('--from') || '0', 10), to = Math.min(total, parseInt(opt('--to') || String(total), 10));
  for (let j = 0; j < from; j++) frameSVG(j);
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-r', String(FPS), '-i', '-',
    '-vf', 'noise=c0s=4:c0f=u,format=yuv420p', '-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-tune', 'animation', '-r', String(FPS), OUT], { stdio: ['pipe', 'inherit', 'inherit'] });
  const ink = []; const t0 = Date.now();
  for (let fi = from; fi < to; fi++) {
    const { svg, ink: k } = frameSVG(fi); ink.push(+k.toFixed(1));
    const px = new Resvg(svg).render().pixels;
    if (!ff.stdin.write(px)) await new Promise((r) => ff.stdin.once('drain', r));
    if (fi % 150 === 0) process.stderr.write(`frame ${fi}/${to} ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
  }
  ff.stdin.end(); await new Promise((r) => ff.on('close', r));
  fs.writeFileSync(OUT.replace(/\.mp4$/, '') + '.sound.json', JSON.stringify({ fps: FPS, from, ink, events: EV, ctaStart: CTA.a, endStart: END.a }));
  process.stderr.write(`done ${OUT} ${to - from} frames in ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
}
main().catch((e) => { console.error(e); process.exit(1); });

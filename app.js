import { FilesetResolver, HandLandmarker } from './lib/vision_bundle.mjs';

const video = document.getElementById('video');
const cv = document.getElementById('fx');
const ctx = cv.getContext('2d');
const statusEl = document.getElementById('status');
const modeEl = document.getElementById('mode');
const startBtn = document.getElementById('startBtn');

// ---------- настройки ----------
const COLORS = ['#ff3df0', '#3dfcff', '#ffe94d', '#7dff4d', '#ff8a3d', '#a98bff', '#ff4d6a'];
const STAR_GAP = 40;          // px пути пальца между звёздами
const LOST_MS = 250;          // столько ждём пропавшую руку, прежде чем поднять «перо»
const HOLD_MS = 100;          // жест засчитывается, если держится ≥2 кадров и столько мс
const MATCH_DIST = 0.25;      // макс. сдвиг запястья между кадрами (доля кадра)
const CHUNK = 96;             // столько точек линии, после чего кусок запекается
const HAND_LINKS = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],
  [9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];

// ---------- холст ----------
let W = 0, H = 0, dpr = 1;
const baked = document.createElement('canvas');   // готовые куски линий рисуем сюда один раз
const bctx = baked.getContext('2d');

function resize() {
  dpr = Math.min(devicePixelRatio || 1, 2);
  W = innerWidth; H = innerHeight;
  for (const c of [cv, baked]) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  rebake();
}
let resizeQueued = false;
function queueResize() {
  if (resizeQueued) return;
  resizeQueued = true;
  // на iOS размеры окна обновляются не сразу после поворота
  requestAnimationFrame(() => requestAnimationFrame(() => { resizeQueued = false; resize(); }));
}
addEventListener('resize', queueResize);
addEventListener('orientationchange', queueResize);
video.addEventListener('resize', queueResize);   // камера сменила размер кадра (поворот телефона)

// iOS ставит видео на паузу, когда вкладка скрыта
function resumeVideo() { if (!document.hidden && video.srcObject && video.paused) video.play().catch(() => {}); }
document.addEventListener('visibilitychange', resumeVideo);
addEventListener('pageshow', resumeVideo);
addEventListener('focus', resumeVideo);

// ---------- координаты ----------
// Всё нарисованное хранится в нормализованных координатах кадра камеры (0..1, без зеркала),
// а в пиксели экрана переводится при отрисовке, поэтому поворот экрана ничего не сдвигает.
function cover() {
  const vw = video.videoWidth || 640, vh = video.videoHeight || 480;
  const s = Math.max(W / vw, H / vh);
  return { vw, vh, s, ox: (W - vw * s) / 2, oy: (H - vh * s) / 2 };
}
function toScreen(p) {
  const { vw, vh, s, ox, oy } = cover();
  return { x: W - (p.x * vw * s + ox), y: p.y * vh * s + oy };   // видео показано зеркально
}

// ---------- фильтр дрожания One Euro ----------
class OneEuro {
  constructor(minCut = 1.2, beta = 8, dCut = 1) { Object.assign(this, { minCut, beta, dCut }); this.reset(); }
  reset() { this.x = null; this.dx = 0; this.t = 0; }
  alpha(cut, dt) { const r = 2 * Math.PI * cut * dt; return r / (r + 1); }
  f(v, t) {
    if (this.x === null) { this.x = v; this.t = t; return v; }
    const dt = Math.max((t - this.t) / 1000, 1e-3); this.t = t;
    this.dx += this.alpha(this.dCut, dt) * ((v - this.x) / dt - this.dx);
    this.x += this.alpha(this.minCut + this.beta * Math.abs(this.dx), dt) * (v - this.x);
    return this.x;
  }
}

// ---------- жесты ----------
// По углам в суставах и расстояниям в 3D (z у MediaPipe в тех же единицах, что и x).
function gestureOf(lm) {
  const vw = video.videoWidth || 1, vh = video.videoHeight || 1;
  const P = lm.map(p => [p.x * vw, p.y * vh, p.z * vw]);
  const sub = (a, b) => [P[a][0] - P[b][0], P[a][1] - P[b][1], P[a][2] - P[b][2]];
  const len = v => Math.hypot(v[0], v[1], v[2]);
  const dist = (a, b) => len(sub(a, b));
  const angle = (a, b, c) => {          // угол в суставе b, градусы (180 = прямо)
    const u = sub(a, b), v = sub(c, b);
    const cos = (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (len(u) * len(v) || 1);
    return Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI;
  };
  const palm = dist(0, 9) || 1;
  const fingers = [[5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]].map(([m, p, d, t]) => {
    const bend = (180 - angle(m, p, d)) + (180 - angle(p, d, t));   // суммарный сгиб пальца
    const reach = dist(t, 0) / dist(p, 0);                          // >1: кончик дальше сустава от запястья
    return {
      ext: bend < 50 && reach > 1.2 && dist(t, m) > palm * 0.55,
      fold: bend > 90 || reach < 1.0 || dist(t, m) < palm * 0.4,
    };
  });
  const [ix, md, rg, pk] = fingers;
  const ext = fingers.filter(f => f.ext).length;
  const foldOthers = [md, rg, pk].filter(f => f.fold).length;
  if (ix.ext && !md.ext && !rg.ext && !pk.ext && foldOthers >= 2) return 'point';
  if (ext === 0 && fingers.filter(f => f.fold).length >= 4) return 'fist';
  if (ext === 4) return 'open';
  return 'other';
}

// жест меняется, только если новый держится ≥2 кадров и ≥HOLD_MS
function stableGesture(tr, g, now) {
  if (g === tr.cand) tr.n++; else { tr.cand = g; tr.n = 1; tr.since = now; }
  if (tr.n >= 2 && now - tr.since >= HOLD_MS) tr.stable = g;
  return tr.stable;
}

// ---------- руки между кадрами: по положению запястья (метка Left/Right часто прыгает) ----------
const trackers = [];
let trackId = 0;
function matchTrackers(hands, now) {
  const live = trackers.filter(t => now - t.seen <= LOST_MS * 2);
  const pairs = [];
  hands.forEach((lm, i) => live.forEach(t => {
    // ожидаемое положение с учётом скорости запястья
    const dt = Math.min(now - t.seen, LOST_MS);
    pairs.push({ i, t, d: Math.hypot(lm[0].x - (t.wx + t.vx * dt), lm[0].y - (t.wy + t.vy * dt)) });
  }));
  pairs.sort((a, b) => a.d - b.d);
  const byHand = new Map(), used = new Set();
  for (const pr of pairs) {
    if (pr.d > MATCH_DIST || byHand.has(pr.i) || used.has(pr.t)) continue;
    byHand.set(pr.i, pr.t); used.add(pr.t);
  }
  const out = hands.map((lm, i) => {
    let t = byHand.get(i);
    if (!t) {
      t = { id: ++trackId, cand: 'none', n: 0, since: now, stable: 'none', prev: 'none',
            wx: lm[0].x, wy: lm[0].y, vx: 0, vy: 0, seen: now, fx: new OneEuro(), fy: new OneEuro() };
      trackers.push(t);
    }
    const dt = Math.max(now - t.seen, 1);
    if (byHand.has(i)) { t.vx = .5 * t.vx + .5 * (lm[0].x - t.wx) / dt; t.vy = .5 * t.vy + .5 * (lm[0].y - t.wy) / dt; }
    t.wx = lm[0].x; t.wy = lm[0].y; t.seen = now;
    return t;
  });
  for (let i = trackers.length - 1; i >= 0; i--) if (now - trackers[i].seen > LOST_MS * 2) trackers.splice(i, 1);
  return out;
}

// иногда MediaPipe находит одну и ту же руку дважды
function dedupe(hands) {
  return hands.filter((lm, i) => !hands.some((o, j) => j < i &&
    Math.hypot(o[0].x - lm[0].x, o[0].y - lm[0].y) < 0.04 && Math.hypot(o[9].x - lm[9].x, o[9].y - lm[9].y) < 0.04));
}

// ---------- состояние рисунка ----------
const strokes = [];           // запечённые куски линий {id, color, pts:[{x,y}] нормализованные}
const stars = [];             // {x,y нормализ., r, ph, born, group} или, если летит: {fly, sx, sy, vx, vy, life, trail}
const sparks = [];            // искры в px экрана (живут доли секунды)
const history = [];           // для «Отменить»: {type:'stroke', id} | {type:'stars', group}
let colorIdx = 0, strokeId = 0, groupId = 0;
let current = null;           // линия, которая рисуется сейчас
let starRun = null;           // звёзды, которые ставятся сейчас {group, last, acc}
let mode = 'line';
let drawerId = null;          // id трекера рисующей руки
let penDown = false, lastDrawSeen = 0;
let tipNorm = null;           // сглаженный кончик пальца (нормализ.)

function startStroke() {
  current = { id: ++strokeId, color: COLORS[colorIdx++ % COLORS.length], pts: [], baked: false };
}
function flushChunk(keepTail) {
  if (!current || current.pts.length < 2) return;
  const chunk = { id: current.id, color: current.color, pts: current.pts.slice() };
  strokes.push(chunk); neon(bctx, chunk);
  if (!current.baked) { current.baked = true; history.push({ type: 'stroke', id: current.id }); }
  current.pts = keepTail ? current.pts.slice(-2) : [];
}
function endStroke() {
  if (current) flushChunk(false);
  current = null; starRun = null; penDown = false;
}

function penMove(p, now) {   // p — нормализованные координаты кончика пальца
  const sp = toScreen(p);
  if (mode === 'line') {
    if (!current) startStroke();
    const last = current.pts.at(-1);
    if (!last) current.pts.push(p);
    else { const lp = toScreen(last); if (Math.hypot(sp.x - lp.x, sp.y - lp.y) >= 1.5) current.pts.push(p); }
    if (current.pts.length >= CHUNK) flushChunk(true);   // длинную линию запекаем частями
    for (let k = 0; k < 2; k++) addSpark(sp.x, sp.y, Math.random() < .5 ? '#fff' : current.color, 1);
  } else {
    if (!starRun) starRun = { group: ++groupId, last: null, acc: 0, added: false };
    if (!starRun.last) { addStar(p, sp, now); starRun.last = { p, sp }; return; }
    // звёзды ставятся ровно через каждые STAR_GAP px пройденного пальцем пути
    const a = starRun.last, seg = Math.hypot(sp.x - a.sp.x, sp.y - a.sp.y);
    let need = STAR_GAP - starRun.acc, done = 0;
    while (seg - done >= need) {
      done += need;
      const k = done / seg;
      addStar({ x: a.p.x + (p.x - a.p.x) * k, y: a.p.y + (p.y - a.p.y) * k },
              { x: a.sp.x + (sp.x - a.sp.x) * k, y: a.sp.y + (sp.y - a.sp.y) * k }, now);
      need = STAR_GAP;
    }
    starRun.acc = STAR_GAP - need + (seg - done);
    starRun.last = { p, sp };
  }
}

function addStar(p, sp, now) {
  if (!starRun.added) { starRun.added = true; history.push({ type: 'stars', group: starRun.group }); }
  stars.push({ x: p.x, y: p.y, r: 8 + Math.random() * 6, ph: Math.random() * 6.28, born: now, group: starRun.group, fly: false });
  for (let k = 0; k < 10; k++) addSpark(sp.x, sp.y, '#fff3a0', 1.5);
}

function launchStars(center) {   // center — px экрана
  for (const s of stars) {
    if (s.fly) continue;
    const p = toScreen(s);
    let dx = p.x - center.x, dy = p.y - center.y;
    const d = Math.hypot(dx, dy) || 1; dx /= d; dy /= d;
    const a = Math.atan2(dy, dx) + (Math.random() - .5) * .5;
    const sp = 260 + Math.random() * 280;   // px/с
    Object.assign(s, { fly: true, sx: p.x, sy: p.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1, fade: .55 + Math.random() * .25, trail: [] });
  }
  if (starRun) starRun = null;
}

function addSpark(x, y, color, power) {
  const a = Math.random() * 6.28, sp = (40 + Math.random() * 160) * power;
  sparks.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1, color });
  if (sparks.length > 400) sparks.splice(0, sparks.length - 400);
}

// ---------- обработка кадра распознавания ----------
let lastHands = [];   // для скелета
const stats = { frames: 0, raw: '' };   // для автотестов
function onHands(res, now) {
  const lms = dedupe(res.landmarks || []);
  const trs = matchTrackers(lms, now);
  const found = lms.map((lm, i) => { const raw = gestureOf(lm); return { lm, tr: trs[i], raw, g: stableGesture(trs[i], raw, now) }; });
  stats.frames++; stats.raw = found.map(h => h.raw).join(',');

  // рисующая рука: та, что показывает палец; кулак рисующим не становится никогда
  let drawer = found.find(h => h.tr.id === drawerId) || null;
  if (!drawer || drawer.g !== 'point') drawer = found.find(h => h.g === 'point') || drawer;
  if (drawer && drawer.g === 'fist') drawer = null;
  if (drawer && drawer.tr.id !== drawerId) {
    if (penDown) endStroke();   // рисовать начала другая рука — это новая линия
    drawerId = drawer.tr.id;
  }

  // режим «звёзды»: другая (не рисующая) рука держит кулак; короткая потеря руки режим не сбрасывает
  const fistHeld = trackers.some(t => t.id !== drawerId && t.stable === 'fist' && now - t.seen <= LOST_MS);
  const newMode = fistHeld ? 'stars' : 'line';
  if (newMode !== mode) {
    if (current) flushChunk(false);
    current = null; starRun = null;
    mode = newMode;
  }

  // раскрытая ладонь: звёзды разлетаются от её центра
  for (const h of found) {
    if (h.g === 'open' && h.tr.prev !== 'open') {
      const c = [0, 5, 9, 13, 17].reduce((a, k) => ({ x: a.x + h.lm[k].x / 5, y: a.y + h.lm[k].y / 5 }), { x: 0, y: 0 });
      launchStars(toScreen(c));
    }
    h.tr.prev = h.g;
  }

  lastHands = found.map(h => ({ lm: h.lm, g: h.g, drawer: h === drawer }));

  if (drawer && drawer.g === 'point') {
    const tr = drawer.tr;
    if (!penDown) { tr.fx.reset(); tr.fy.reset(); }
    tipNorm = { x: tr.fx.f(drawer.lm[8].x, now), y: tr.fy.f(drawer.lm[8].y, now) };
    penDown = true; lastDrawSeen = now;
    penMove(tipNorm, now);
  } else if (penDown && drawer) {
    endStroke();   // рисующая рука видна, но палец уже не вытянут
  }
}

// пропажа руки дольше LOST_MS поднимает «перо»
function tick(now) {
  if (penDown && now - lastDrawSeen > LOST_MS) endStroke();
  if (!penDown) tipNorm = null;
  if (now - lastDetect > LOST_MS) lastHands = [];
}

// ---------- отрисовка ----------
function path(c, pts) {
  c.beginPath(); c.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length - 1; i++) {
    c.quadraticCurveTo(pts[i].x, pts[i].y, (pts[i].x + pts[i + 1].x) / 2, (pts[i].y + pts[i + 1].y) / 2);
  }
  const l = pts.at(-1); c.lineTo(l.x, l.y);
}

// неон: цветное свечение в несколько слоёв и яркая белая сердцевина
function neon(c, s) {
  if (s.pts.length < 2) return;
  const pts = s.pts.map(toScreen);
  c.save();
  c.lineCap = c.lineJoin = 'round';
  c.strokeStyle = s.color;
  c.globalAlpha = .10; c.lineWidth = 30; path(c, pts); c.stroke();
  c.globalAlpha = .22; c.lineWidth = 17; path(c, pts); c.stroke();
  c.globalAlpha = .65; c.lineWidth = 9;  path(c, pts); c.stroke();
  c.globalAlpha = 1;   c.lineWidth = 5;  c.strokeStyle = mix(s.color); path(c, pts); c.stroke();
  c.strokeStyle = '#fff'; c.lineWidth = 2.5; path(c, pts); c.stroke();
  c.restore();
}
const mixCache = {};
function mix(hex) {   // цвет между белым и цветом линии — переход от сердцевины к свечению
  if (mixCache[hex]) return mixCache[hex];
  const n = parseInt(hex.slice(1), 16), m = v => Math.round(v + (255 - v) * .45);
  return (mixCache[hex] = `rgb(${m(n >> 16)},${m((n >> 8) & 255)},${m(n & 255)})`);
}
function rebake() {
  bctx.clearRect(0, 0, W, H);
  for (const s of strokes) neon(bctx, s);
}

// спрайт звезды со свечением (рисуется один раз)
const starSprite = (() => {
  const c = document.createElement('canvas'), S = 128; c.width = c.height = S;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(255,250,215,1)'); g.addColorStop(.12, 'rgba(255,235,150,.75)');
  g.addColorStop(.35, 'rgba(255,215,100,.22)'); g.addColorStop(1, 'rgba(255,210,90,0)');
  x.fillStyle = g; x.fillRect(0, 0, S, S);
  x.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? 7 : 19, a = i * Math.PI / 5 - Math.PI / 2;
    x.lineTo(S / 2 + Math.cos(a) * r, S / 2 + Math.sin(a) * r);
  }
  x.closePath(); x.fillStyle = '#fffbe6'; x.shadowColor = '#ffd94d'; x.shadowBlur = 10; x.fill();
  // тонкие лучи-блики
  x.strokeStyle = 'rgba(255,255,240,.8)'; x.lineWidth = 1.5; x.shadowBlur = 6;
  x.beginPath(); x.moveTo(S / 2 - 40, S / 2); x.lineTo(S / 2 + 40, S / 2); x.moveTo(S / 2, S / 2 - 40); x.lineTo(S / 2, S / 2 + 40); x.stroke();
  return c;
})();

let lastRender = 0;
function drawEffects(c, now, dt) {
  c.drawImage(baked, 0, 0, W, H);
  if (current) neon(c, current);

  // созвездия: соседние звёзды одной серии соединены тонкими линиями
  c.save();
  c.strokeStyle = 'rgba(255,245,210,.55)'; c.lineWidth = 1.2;
  c.shadowColor = 'rgba(255,230,150,.9)'; c.shadowBlur = 4;
  c.beginPath();
  for (let i = 1; i < stars.length; i++) {
    const a = stars[i - 1], b = stars[i];
    if (a.group !== b.group || a.fly || b.fly) continue;
    const pa = toScreen(a), pb = toScreen(b);
    c.moveTo(pa.x, pa.y); c.lineTo(pb.x, pb.y);
  }
  c.stroke();
  c.restore();

  // звёзды
  for (let i = stars.length - 1; i >= 0; i--) {
    const s = stars[i];
    let p;
    if (s.fly) {
      if (dt) {
        s.trail.push({ x: s.sx, y: s.sy }); if (s.trail.length > 24) s.trail.shift();
        s.vx *= 1 + dt * 1.2; s.vy *= 1 + dt * 1.2;   // разгоняются
        s.sx += s.vx * dt; s.sy += s.vy * dt; s.life -= dt * s.fade;
      }
      if (s.life <= 0 || s.sx < -200 || s.sx > W + 200 || s.sy < -200 || s.sy > H + 200) { stars.splice(i, 1); continue; }
      p = { x: s.sx, y: s.sy };
      // светящийся хвост: широкое свечение и тонкая яркая сердцевина, сужается к концу
      if (s.trail.length > 1) {
        const tail = s.trail[0];
        const g = c.createLinearGradient(tail.x, tail.y, p.x, p.y);
        g.addColorStop(0, 'rgba(255,210,90,0)'); g.addColorStop(1, `rgba(255,225,130,${.55 * s.life})`);
        const g2 = c.createLinearGradient(tail.x, tail.y, p.x, p.y);
        g2.addColorStop(0, 'rgba(255,255,240,0)'); g2.addColorStop(1, `rgba(255,255,240,${.95 * s.life})`);
        c.save(); c.lineCap = 'round'; c.lineJoin = 'round'; c.globalCompositeOperation = 'lighter';
        c.beginPath(); c.moveTo(tail.x, tail.y);
        for (const q of s.trail) c.lineTo(q.x, q.y);
        c.lineTo(p.x, p.y);
        c.strokeStyle = g; c.lineWidth = s.r * 1.1; c.stroke();
        c.strokeStyle = g2; c.lineWidth = s.r * .35; c.stroke();
        c.restore();
      }
    } else p = toScreen(s);
    // мерцание
    const tw = .75 + .25 * Math.sin(now / 170 + s.ph) * Math.sin(now / 410 + s.ph * 2);
    const pop = Math.min(1, (now - s.born) / 200);
    const size = s.r * 7 * tw * (pop < 1 ? .3 + pop * .9 : 1);
    c.globalAlpha = Math.max(0, Math.min(1, s.fly ? s.life : .6 + .4 * tw));
    c.drawImage(starSprite, p.x - size / 2, p.y - size / 2, size, size);
  }
  c.globalAlpha = 1;

  // искры
  c.save(); c.globalCompositeOperation = 'lighter';
  for (let i = sparks.length - 1; i >= 0; i--) {
    const p = sparks[i];
    if (dt) { p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 120 * dt; p.life -= dt * 2.4; }
    if (p.life <= 0) { sparks.splice(i, 1); continue; }
    c.globalAlpha = p.life; c.fillStyle = p.color;
    const r = 1 + p.life * 1.6;
    c.fillRect(p.x - r / 2, p.y - r / 2, r, r);
  }
  c.restore();
}

function drawHands(c) {
  c.save();
  c.lineWidth = 1.5; c.lineCap = 'round';
  for (const h of lastHands) {
    const pts = h.lm.map(toScreen);
    c.strokeStyle = h.drawer ? 'rgba(61,252,255,.8)' : h.g === 'fist' ? 'rgba(255,233,77,.85)' : 'rgba(255,255,255,.6)';
    c.beginPath();
    for (const [a, b] of HAND_LINKS) { c.moveTo(pts[a].x, pts[a].y); c.lineTo(pts[b].x, pts[b].y); }
    c.stroke();
    c.fillStyle = c.strokeStyle;
    for (const p of pts) { c.beginPath(); c.arc(p.x, p.y, 2, 0, 6.29); c.fill(); }
  }
  if (tipNorm && penDown) {   // светящийся кончик пальца
    const p = toScreen(tipNorm);
    const col = mode === 'stars' ? '#ffe94d' : current?.color || '#fff';
    c.fillStyle = '#fff'; c.shadowColor = col; c.shadowBlur = 20;
    c.beginPath(); c.arc(p.x, p.y, 5, 0, 6.29); c.fill();
  }
  c.restore();
}

function render(now) {
  const dt = lastRender ? Math.min((now - lastRender) / 1000, .05) : 0;
  lastRender = now;
  ctx.clearRect(0, 0, W, H);
  drawEffects(ctx, now, dt);
  drawHands(ctx);
}

function updateHud() {
  const txt = mode === 'stars' ? '⭐ Звёзды' : '✏️ Линия';
  if (modeEl.textContent !== txt) modeEl.textContent = txt;
  modeEl.classList.toggle('stars', mode === 'stars');
  modeEl.classList.toggle('drawing', penDown);
}

// ---------- распознавание ----------
let landmarker = null, delegate = 'GPU', lastVideoTime = -1, lastDetect = 0, errors = 0, lastTs = 0;

async function createLandmarker(prefer) {
  const fileset = await FilesetResolver.forVisionTasks(new URL('./lib/wasm', import.meta.url).href);
  const opts = d => ({
    baseOptions: { modelAssetPath: new URL('./models/hand_landmarker.task', import.meta.url).href, delegate: d },
    runningMode: 'VIDEO', numHands: 2,
    minHandDetectionConfidence: .5, minHandPresenceConfidence: .5, minTrackingConfidence: .5,
  });
  if (prefer === 'GPU') {
    try { const l = await HandLandmarker.createFromOptions(fileset, opts('GPU')); delegate = 'GPU'; return l; }
    catch (e) { console.warn('GPU недоступен, перехожу на CPU', e); }
  }
  delegate = 'CPU';
  return HandLandmarker.createFromOptions(fileset, opts('CPU'));
}

function switchToCpu() {
  const old = landmarker; landmarker = null;
  createLandmarker('CPU')
    .then(l => { landmarker = l; errors = 0; })
    .catch(err => { console.error(err); showError('Распознавание рук не запустилось. Обновите страницу.'); })
    .finally(() => { try { old?.close(); } catch {} });
}

// программный WebGL (без настоящей видеокарты) бывает в разы медленнее CPU — тогда переходим на CPU
const gpuTimes = [];
function checkSpeed(ms) {
  if (delegate !== 'GPU' || gpuTimes.length >= 10) return;
  gpuTimes.push(ms);
  if (gpuTimes.length === 10) {
    const med = gpuTimes.slice(2).sort((a, b) => a - b)[4];   // первые кадры — прогрев
    if (med > 80) { console.warn(`GPU медленный (${med.toFixed(0)} мс на кадр), перехожу на CPU`); switchToCpu(); }
  }
}

function loop() {
  const now = performance.now();
  if (landmarker && video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    const ts = Math.max(now, lastTs + 1); lastTs = ts;   // метки времени должны строго расти
    let res = null;
    try {
      const t1 = performance.now();
      res = landmarker.detectForVideo(video, ts); errors = 0;
      checkSpeed(performance.now() - t1);
    }
    catch (e) {
      console.error(e);
      // на некоторых телефонах GPU-режим падает уже во время работы — переходим на CPU
      if (++errors > 3 && delegate === 'GPU') switchToCpu();
    }
    if (res) { lastDetect = now; onHands(res, now); }
  }
  tick(now);
  render(now);
  updateHud();
  requestAnimationFrame(loop);
}

// ---------- камера ----------
function cameraError(e) {
  const n = e?.name || '';
  if (!window.isSecureContext) return 'Камера работает только по HTTPS (или на localhost). Откройте сайт по https://';
  if (n === 'NotAllowedError' || n === 'SecurityError') return 'Доступ к камере запрещён. Разрешите камеру для этого сайта в настройках браузера и нажмите кнопку ещё раз.';
  if (n === 'NotFoundError' || n === 'OverconstrainedError') return 'Камера не найдена. Подключите камеру и попробуйте снова.';
  if (n === 'NotReadableError' || n === 'AbortError') return 'Камера занята другим приложением. Закройте его и попробуйте снова.';
  return 'Не удалось включить камеру: ' + (e?.message || e);
}
function showError(msg) {
  document.getElementById('start').classList.remove('off');
  statusEl.textContent = msg; statusEl.classList.add('error');
  startBtn.disabled = false; startBtn.textContent = 'Попробовать снова';
}

async function start() {
  startBtn.disabled = true;
  statusEl.classList.remove('error');
  let stage = 'camera';
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error('браузер не даёт доступ к камере'), { name: window.isSecureContext ? 'NotFoundError' : 'SecurityError' });
    statusEl.textContent = 'Включаю камеру…';
    video.srcObject?.getTracks().forEach(t => t.stop());
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    } catch (e) {
      if (e.name !== 'OverconstrainedError') throw e;
      stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    }
    video.srcObject = stream;
    await video.play();
    if (!video.videoWidth) await new Promise(r => video.addEventListener('loadedmetadata', r, { once: true }));
    resize();
    stage = 'model';
    if (!landmarker) {
      statusEl.textContent = 'Загружаю распознавание рук…';
      landmarker = await createLandmarker(new URLSearchParams(location.search).get('delegate') === 'cpu' ? 'CPU' : 'GPU');
    }
    document.getElementById('start').classList.add('off');
    document.getElementById('tools').hidden = false;
    document.getElementById('hint').hidden = false;
    modeEl.hidden = false;
    if (!loopStarted) { loopStarted = true; loop(); }
  } catch (e) {
    console.error(e);
    showError(stage === 'camera' ? cameraError(e) : 'Не удалось загрузить распознавание рук: ' + (e?.message || e));
  }
}
let loopStarted = false;

// ---------- кнопки ----------
startBtn.onclick = start;
document.getElementById('undoBtn').onclick = () => {
  if (current || starRun) endStroke();
  while (history.length) {
    const h = history.pop();
    if (h.type === 'stroke') {
      for (let i = strokes.length - 1; i >= 0; i--) if (strokes[i].id === h.id) strokes.splice(i, 1);
      rebake(); return;
    }
    const before = stars.length;
    for (let i = stars.length - 1; i >= 0; i--) if (stars[i].group === h.group && !stars[i].fly) stars.splice(i, 1);
    if (stars.length !== before) return;   // если эти звёзды уже улетели, отменяем следующее действие
  }
};
document.getElementById('clearBtn').onclick = () => {
  strokes.length = stars.length = sparks.length = history.length = 0;
  current = null; starRun = null; penDown = false;
  rebake();
};
document.getElementById('shotBtn').onclick = () => {
  const c = document.createElement('canvas'); c.width = cv.width; c.height = cv.height;
  const x = c.getContext('2d');
  const { vw, vh, s, ox, oy } = cover();
  x.setTransform(-dpr, 0, 0, dpr, c.width, 0);   // кадр камеры зеркально, как на экране
  x.drawImage(video, ox, oy, vw * s, vh * s);
  x.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawEffects(x, performance.now(), 0);           // эффекты без скелета рук
  c.toBlob(async blob => {
    c.width = c.height = 0;   // освобождаем память (важно на iOS)
    if (!blob) return;
    const file = new File([blob], `magic-hands-${Date.now()}.png`, { type: 'image/png' });
    if (navigator.canShare?.({ files: [file] }) && /iPhone|iPad|Android/i.test(navigator.userAgent)) {
      try { await navigator.share({ files: [file] }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.download = file.name; a.href = url;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }, 'image/png');
};

resize();
// для автотестов
window.__magic = {
  gestureOf, stats, strokes, stars, history, trackers,
  get mode() { return mode; }, get penDown() { return penDown; }, get current() { return current; },
  get hands() { return lastHands; }, get delegate() { return delegate; }, get ready() { return !!landmarker; },
};

import { FilesetResolver, HandLandmarker } from './lib/vision_bundle.mjs';

const video = document.getElementById('video');
const cv = document.getElementById('fx');
const ctx = cv.getContext('2d');
const statusEl = document.getElementById('status');
const modeEl = document.getElementById('mode');

// ---------- холст ----------
let W = 0, H = 0, dpr = 1;
const baked = document.createElement('canvas');   // готовые линии рисуем один раз сюда
const bctx = baked.getContext('2d');

function resize() {
  const norm = W ? stars.map(s => fromScreen(s)) : null;
  dpr = Math.min(devicePixelRatio || 1, 2);
  W = innerWidth; H = innerHeight;
  for (const c of [cv, baked]) { c.width = W * dpr; c.height = H * dpr; }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (norm) stars.forEach((s, i) => { const p = toScreen(norm[i]); s.trail = []; s.x = p.x; s.y = p.y; });
  rebake();
}
let resizeQueued = false;
function queueResize() {
  if (resizeQueued) return;
  resizeQueued = true;
  requestAnimationFrame(() => requestAnimationFrame(() => { resizeQueued = false; resize(); }));
}
addEventListener('resize', queueResize);
addEventListener('orientationchange', queueResize);
video.addEventListener('resize', queueResize);   // камера сменила размер кадра
// iOS ставит видео на паузу, когда вкладка скрыта
document.addEventListener('visibilitychange', () => { if (!document.hidden && video.srcObject) video.play().catch(() => {}); });

// ---------- настройки ----------
const COLORS = ['#ff4fd8', '#ffe94d', '#3dfcff', '#7dff4d', '#ff8a3d', '#a98bff'];
const STAR_GAP = 42;          // px между звёздами при рисовании
const LOST_MS = 250;          // сколько ждём потерянную руку, прежде чем поднять «перо»
const HAND_LINKS = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],
  [9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];

// ---------- состояние ----------
const strokes = [];           // готовые линии {pts, color}
const stars = [];             // {x,y,r,rot,born,ph,group,fly,vx,vy,life,trail}
const sparks = [];
const history = [];           // для «Отменить»: 'stroke' | номер группы звёзд
let colorIdx = 0, groupId = 0;
let current = null;           // линия, которую рисуем сейчас
let drawerId = null;          // какая рука рисует
let trackId = 0, strokeId = 0;
let penDown = false, mode = 'line', lastSeen = 0;
let lastStar = null, curGroup = 0;
const trackers = [];          // руки, сопоставленные между кадрами по положению запястья

// ---------- фильтр дрожания (One Euro) ----------
class OneEuro {
  constructor(minCut = 1.2, beta = 0.02, dCut = 1) { Object.assign(this, { minCut, beta, dCut, x: null, dx: 0, t: 0 }); }
  alpha(cut, dt) { const r = 2 * Math.PI * cut * dt; return r / (r + 1); }
  f(v, t) {
    if (this.x === null) { this.x = v; this.t = t; return v; }
    const dt = Math.max((t - this.t) / 1000, 1e-3); this.t = t;
    const dx = (v - this.x) / dt;
    this.dx += this.alpha(this.dCut, dt) * (dx - this.dx);
    const cut = this.minCut + this.beta * Math.abs(this.dx);
    this.x += this.alpha(cut, dt) * (v - this.x);
    return this.x;
  }
}

// ---------- координаты ----------
function toScreen(p) {
  const vw = video.videoWidth || 640, vh = video.videoHeight || 480;
  const s = Math.max(W / vw, H / vh);
  return { x: W - (p.x * vw * s + (W - vw * s) / 2), y: p.y * vh * s + (H - vh * s) / 2 };
}

function fromScreen(p) {
  const vw = video.videoWidth || 640, vh = video.videoHeight || 480;
  const s = Math.max(W / vw, H / vh);
  return { x: (W - p.x - (W - vw * s) / 2) / (vw * s), y: (p.y - (H - vh * s) / 2) / (vh * s) };
}

// ---------- жесты ----------
function gestureOf(lm) {
  const vw = video.videoWidth || 1, vh = video.videoHeight || 1;
  const P = lm.map(p => ({ x: p.x * vw, y: p.y * vh, z: p.z * vw }));
  const dist = (a, b) => Math.hypot(P[a].x - P[b].x, P[a].y - P[b].y, P[a].z - P[b].z);
  const angle = (a, b, c) => {          // угол в суставе b, градусы
    const u = [P[a].x - P[b].x, P[a].y - P[b].y, P[a].z - P[b].z];
    const v = [P[c].x - P[b].x, P[c].y - P[b].y, P[c].z - P[b].z];
    const cos = (u[0]*v[0] + u[1]*v[1] + u[2]*v[2]) / (Math.hypot(...u) * Math.hypot(...v) || 1);
    return Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI;
  };
  const palm = dist(0, 9) || 1;
  const fingers = [[5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]].map(([m, p, d, t]) => {
    const straight = angle(m, p, d) > 150 && angle(p, d, t) > 140;
    const far = dist(t, 0) > dist(p, 0) * 1.15;
    return {
      ext: straight && far,
      fold: dist(t, 0) < dist(p, 0) * 1.05 || dist(t, m) < palm * 0.45,
    };
  });
  const ext = fingers.filter(f => f.ext).length;
  const fold = fingers.filter(f => f.fold).length;
  if (fingers[0].ext && !fingers[1].ext && !fingers[2].ext && !fingers[3].ext) return 'point';
  if (ext === 0 && fold >= 3) return 'fist';
  if (ext >= 4) return 'open';
  return 'other';
}

// жест считается сменившимся, только если держится хотя бы 2 кадра и ~0.1 с
function stableGesture(tr, g, now) {
  if (g === tr.cand) tr.n++; else { tr.cand = g; tr.n = 1; tr.since = now; }
  if (tr.n >= 2 && now - tr.since >= (g === 'point' ? 50 : 100)) tr.stable = g;
  return tr.stable;
}

// ---------- обработка кадра ----------
// сопоставляем руки с прошлым кадром по ближайшему запястью (метка Left/Right от MediaPipe часто прыгает)
function matchTrackers(landmarks, now) {
  const live = trackers.filter(t => now - t.seen < 1200);
  const pairs = [];
  landmarks.forEach((lm, i) => live.forEach(t => pairs.push({ i, t, d: Math.hypot(lm[0].x - t.wx, lm[0].y - t.wy) })));
  pairs.sort((a, b) => a.d - b.d);
  const byHand = new Map(), usedT = new Set();
  for (const pr of pairs) {
    if (pr.d > 0.3 || byHand.has(pr.i) || usedT.has(pr.t)) continue;
    byHand.set(pr.i, pr.t); usedT.add(pr.t);
  }
  return landmarks.map((lm, i) => {
    let t = byHand.get(i);
    if (!t) trackers.push(t = { id: ++trackId, cand: 'other', n: 0, since: now, stable: 'other', prev: 'other', fx: new OneEuro(), fy: new OneEuro() });
    t.seen = now; t.wx = lm[0].x; t.wy = lm[0].y;
    return t;
  });
}

function onHands(res, now) {
  const trs = matchTrackers(res.landmarks, now);
  const found = res.landmarks.map((lm, i) => ({ lm, tr: trs[i], g: stableGesture(trs[i], gestureOf(lm), now) }));
  for (let i = trackers.length - 1; i >= 0; i--) if (now - trackers[i].seen > 1500) trackers.splice(i, 1);

  // кто рисует: рука с указательным пальцем; кулак рисующим не становится
  let drawer = found.find(h => h.tr.id === drawerId);
  const pointing = found.find(h => h.g === 'point');
  if (pointing && (!drawer || drawer.g !== 'point')) drawer = pointing;
  if (!drawer && found.length === 1 && found[0].g !== 'fist' && !trackers.some(t => t.id === drawerId && now - t.seen < LOST_MS)) drawer = found[0];
  if (drawer) drawerId = drawer.tr.id;

  // вторая рука в кулаке = рисуем звёзды (переживает короткую потерю руки)
  const fistHeld = trackers.some(t => t.id !== drawerId && t.stable === 'fist' && now - t.seen < LOST_MS);
  const newMode = fistHeld ? 'stars' : 'line';
  // любая рука раскрылась = звёзды улетают
  for (const h of found) {
    if (h.g === 'open' && h.tr.prev !== 'open') launchStars(toScreen(h.lm[9]));
    h.tr.prev = h.g;
  }
  if (newMode !== mode) { endStroke(); mode = newMode; }

  const handsOut = found.map(h => ({ lm: h.lm, pts: h.lm.map(toScreen), role: h === drawer ? 'drawer' : 'mod', g: h.g }));

  if (drawer && drawer.g === 'point') {
    lastSeen = now;
    if (!penDown) { drawer.tr.fx.x = null; drawer.tr.fy.x = null; }
    const raw = toScreen(drawer.lm[8]);
    const tip = { x: drawer.tr.fx.f(raw.x, now), y: drawer.tr.fy.f(raw.y, now) };
    if (!penDown) { penDown = true; startStroke(); }
    moveTo(tip, now);
    return { hands: handsOut, tip };
  }
  if (penDown && (drawer || now - lastSeen > LOST_MS)) endStroke();
  return { hands: handsOut, tip: null };
}

function startStroke() {
  if (mode === 'line') {
    current = { pts: [], color: COLORS[colorIdx++ % COLORS.length], id: ++strokeId, chunks: 0 };
  } else {
    curGroup = ++groupId; lastStar = null;
  }
}

function moveTo(p, now) {
  if (mode === 'line') {
    if (!current) startStroke();
    const last = current.pts.length && toScreen(current.pts[current.pts.length - 1]);
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 1.5) current.pts.push(fromScreen(p));
    if (current.pts.length > 120) {          // длинную линию запекаем частями, чтобы не тормозило
      flushChunk();
      current.pts = [current.pts.at(-1)];
    }
    if (Math.random() < .7) addSpark(p.x, p.y, current.color);
  } else {
    if (!curGroup) curGroup = ++groupId;
    if (!lastStar || Math.hypot(p.x - lastStar.x, p.y - lastStar.y) > STAR_GAP) {
      if (!lastStar) history.push(curGroup);
      stars.push({ x: p.x, y: p.y, r: 9 + Math.random() * 8, rot: Math.random() * 6.28, born: now, ph: Math.random() * 6.28,
                   group: curGroup, fly: false, vx: 0, vy: 0, life: 1, trail: [] });
      for (let k = 0; k < 8; k++) addSpark(p.x, p.y, '#fff3a0');
      lastStar = { x: p.x, y: p.y };
    }
  }
}

function flushChunk() {
  if (current.pts.length < 2) return;
  const chunk = { pts: current.pts.slice(), color: current.color, id: current.id };
  strokes.push(chunk); bake(chunk);
  if (!current.chunks++) history.push('stroke');
}

function endStroke() {
  penDown = false;
  if (current) flushChunk();
  current = null; lastStar = null; curGroup = 0;
}

function launchStars(c) {
  for (const s of stars) {
    if (s.fly) continue;
    const a = Math.atan2(s.y - c.y, s.x - c.x) + (Math.random() - .5) * .8;
    const sp = 2.5 + Math.random() * 3.5;
    s.fly = true; s.vx = Math.cos(a) * sp; s.vy = Math.sin(a) * sp - 1.5;
  }
}

function addSpark(x, y, color) {
  const a = Math.random() * 6.28, sp = .5 + Math.random() * 2.5;
  sparks.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1, color });
}

// ---------- рисование ----------
function path(c, pts) {
  c.beginPath(); c.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length - 1; i++) {
    const m = { x: (pts[i].x + pts[i + 1].x) / 2, y: (pts[i].y + pts[i + 1].y) / 2 };
    c.quadraticCurveTo(pts[i].x, pts[i].y, m.x, m.y);
  }
  const l = pts[pts.length - 1]; c.lineTo(l.x, l.y);
}

function neon(c, s) {
  if (s.pts.length < 2) return;
  s = { ...s, pts: s.pts.map(toScreen) };
  c.lineCap = c.lineJoin = 'round';
  c.strokeStyle = s.color;
  c.globalAlpha = .18; c.lineWidth = 22; path(c, s.pts); c.stroke();
  c.globalAlpha = .45; c.lineWidth = 10; path(c, s.pts); c.stroke();
  c.globalAlpha = 1;   c.lineWidth = 5;  path(c, s.pts); c.stroke();
  c.strokeStyle = '#fff'; c.lineWidth = 2; path(c, s.pts); c.stroke();
}

function bake(s) { neon(bctx, s); }
function rebake() { bctx.clearRect(0, 0, W, H); strokes.forEach(bake); }

// спрайт звезды со свечением (рисуется один раз)
const starSprite = (() => {
  const c = document.createElement('canvas'), S = 128; c.width = c.height = S;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(S/2, S/2, 0, S/2, S/2, S/2);
  g.addColorStop(0, 'rgba(255,240,170,.9)'); g.addColorStop(.25, 'rgba(255,220,110,.35)'); g.addColorStop(1, 'rgba(255,220,110,0)');
  x.fillStyle = g; x.fillRect(0, 0, S, S);
  x.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? 9 : 24, a = i * Math.PI / 5 - Math.PI / 2;
    x.lineTo(S/2 + Math.cos(a) * r, S/2 + Math.sin(a) * r);
  }
  x.closePath(); x.fillStyle = '#fff6c2'; x.shadowColor = '#ffd94d'; x.shadowBlur = 12; x.fill();
  return c;
})();

function render(now, frame) {
  ctx.clearRect(0, 0, W, H);
  ctx.drawImage(baked, 0, 0, W, H);
  if (current) neon(ctx, current);

  // линии созвездий
  ctx.strokeStyle = 'rgba(255,245,200,.55)'; ctx.lineWidth = 1.2;
  for (let i = 1; i < stars.length; i++) {
    const a = stars[i - 1], b = stars[i];
    if (a.group !== b.group || a.fly || b.fly) continue;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }

  // звёзды
  for (let i = stars.length - 1; i >= 0; i--) {
    const s = stars[i];
    if (s.fly) {
      s.trail.push({ x: s.x, y: s.y }); if (s.trail.length > 14) s.trail.shift();
      s.vx *= 1.012; s.vy = s.vy * 1.012 - .06;
      s.x += s.vx; s.y += s.vy; s.rot += .15; s.life -= .006;
      if (s.life <= 0 || s.x < -150 || s.x > W + 150 || s.y < -150 || s.y > H + 150) { stars.splice(i, 1); continue; }
      ctx.lineCap = 'round';
      for (let k = 1; k < s.trail.length; k++) {
        ctx.globalAlpha = (k / s.trail.length) * .6 * s.life;
        ctx.strokeStyle = '#ffe98a'; ctx.lineWidth = (k / s.trail.length) * s.r * .6;
        ctx.beginPath(); ctx.moveTo(s.trail[k-1].x, s.trail[k-1].y); ctx.lineTo(s.trail[k].x, s.trail[k].y); ctx.stroke();
      }
    }
    const tw = .8 + .2 * Math.sin(now / 220 + s.ph);
    const pop = Math.min(1, (now - s.born) / 180);
    const size = s.r * 5.3 * tw * (pop < 1 ? pop * 1.3 : 1);
    ctx.globalAlpha = Math.max(0, s.life);
    ctx.save(); ctx.translate(s.x, s.y); ctx.rotate(s.rot);
    ctx.drawImage(starSprite, -size / 2, -size / 2, size, size);
    ctx.restore();
  }
  ctx.globalAlpha = 1;

  // искры
  for (let i = sparks.length - 1; i >= 0; i--) {
    const p = sparks[i];
    p.x += p.vx; p.y += p.vy; p.vy += .03; p.life -= .04;
    if (p.life <= 0) { sparks.splice(i, 1); continue; }
    ctx.globalAlpha = p.life; ctx.fillStyle = p.color;
    ctx.fillRect(p.x - 1, p.y - 1, 2.5, 2.5);
  }
  ctx.globalAlpha = 1;

  // скелет рук
  if (frame) {
    for (const h of frame.hands) {
      ctx.strokeStyle = h.role === 'drawer' ? 'rgba(61,252,255,.75)' : (h.g === 'fist' ? 'rgba(255,233,77,.8)' : 'rgba(255,255,255,.55)');
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (const [a, b] of HAND_LINKS) { ctx.moveTo(h.pts[a].x, h.pts[a].y); ctx.lineTo(h.pts[b].x, h.pts[b].y); }
      ctx.stroke();
      ctx.fillStyle = ctx.strokeStyle;
      for (const p of h.pts) ctx.fillRect(p.x - 2, p.y - 2, 4, 4);
    }
    if (frame.tip) {
      ctx.fillStyle = mode === 'stars' ? '#ffe94d' : '#fff';
      ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = 18;
      ctx.beginPath(); ctx.arc(frame.tip.x, frame.tip.y, 7, 0, 6.29); ctx.fill();
      ctx.shadowBlur = 0;
    }
  }
}

function updateHud(frame) {
  const n = frame ? frame.hands.length : 0;
  const m = mode === 'stars' ? '⭐ Звёзды' : '✏️ Линия';
  const pen = penDown ? ' · рисую' : '';
  const txt = n ? `${m}${pen}` : 'Покажи руку в камеру';
  if (modeEl.textContent !== txt) modeEl.textContent = txt;
  modeEl.classList.toggle('stars', mode === 'stars');
}

// ---------- запуск ----------
let landmarker = null, lastVideoTime = -1, lastFrame = null, delegate = 'GPU', errors = 0;

async function createLandmarker(prefer) {
  const fileset = await FilesetResolver.forVisionTasks(new URL('./lib/wasm', import.meta.url).href);
  const opts = delegate => ({
    baseOptions: { modelAssetPath: new URL('./models/hand_landmarker.task', import.meta.url).href, delegate },
    runningMode: 'VIDEO', numHands: 2,
    minHandDetectionConfidence: .5, minHandPresenceConfidence: .5, minTrackingConfidence: .5,
  });
  if (prefer === 'GPU') {
    try { return await HandLandmarker.createFromOptions(fileset, opts('GPU')); }
    catch (e) { console.warn('GPU недоступен, перехожу на CPU', e); }
  }
  delegate = 'CPU';
  return HandLandmarker.createFromOptions(fileset, opts('CPU'));
}

function loop() {
  const now = performance.now();
  if (landmarker && video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    let res = null;
    try { res = landmarker.detectForVideo(video, now); errors = 0; }
    catch (e) {
      console.error(e);
      // на некоторых телефонах GPU-режим падает уже во время работы — переключаемся на CPU
      if (++errors > 5 && delegate === 'GPU' && landmarker) {
        const old = landmarker; landmarker = null; delegate = 'CPU';
        createLandmarker('CPU')
          .then(l => { landmarker = l; errors = 0; })
          .catch(err => { console.error(err); modeEl.textContent = 'Распознавание рук не запустилось. Обновите страницу'; })
          .finally(() => { try { old.close(); } catch {} });
      }
    }
    if (res) lastFrame = onHands(res, now);
  }
  render(now, lastFrame);
  updateHud(lastFrame);
  requestAnimationFrame(loop);
}

async function start() {
  const btn = document.getElementById('startBtn');
  btn.disabled = true;
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('браузер не даёт доступ к камере (нужен HTTPS)');
    statusEl.textContent = 'Включаю камеру…';
    video.srcObject?.getTracks().forEach(t => t.stop());
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    video.srcObject = stream;
    await video.play();
    statusEl.textContent = 'Загружаю распознавание рук…';
    landmarker = await createLandmarker('GPU');
    document.getElementById('start').classList.add('off');
    document.getElementById('tools').hidden = false;
    loop();
  } catch (e) {
    btn.disabled = false;
    statusEl.textContent = 'Ошибка: ' + (e.message || e);
    console.error(e);
  }
}

document.getElementById('startBtn').onclick = start;
document.getElementById('undoBtn').onclick = () => {
  const last = history.pop();
  if (last === 'stroke') {
    const id = strokes.at(-1)?.id;
    while (strokes.length && strokes.at(-1).id === id) strokes.pop();
    rebake();
  } else if (last !== undefined) {
    const before = stars.length;
    for (let i = stars.length - 1; i >= 0; i--) if (stars[i].group === last) stars.splice(i, 1);
    if (before === stars.length) document.getElementById('undoBtn').click();   // эти звёзды уже улетели — отменяем следующее
  }
};
document.getElementById('clearBtn').onclick = () => {
  strokes.length = stars.length = sparks.length = history.length = 0;
  current = null; lastStar = null; curGroup = 0; penDown = false;
  rebake();
};
document.getElementById('shotBtn').onclick = () => {
  const c = document.createElement('canvas'); c.width = W * dpr; c.height = H * dpr;
  const x = c.getContext('2d');
  const vw = video.videoWidth, vh = video.videoHeight, s = Math.max(W / vw, H / vh) * dpr;
  x.translate(c.width, 0); x.scale(-1, 1);
  x.drawImage(video, (c.width - vw * s) / 2, (c.height - vh * s) / 2, vw * s, vh * s);
  x.setTransform(1, 0, 0, 1, 0, 0);
  x.drawImage(cv, 0, 0);
  c.toBlob(async blob => {
    c.width = c.height = 0;   // освобождаем память (важно на iOS)
    const file = new File([blob], 'magic-hands.png', { type: 'image/png' });
    if (navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file] }); return; } catch {} }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.download = file.name; a.href = url; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }, 'image/png');
};

resize();
window.__magic = { feed: onHands, gestureOf, strokes, stars, get mode() { return mode; }, get penDown() { return penDown; }, get frame() { return lastFrame; } };

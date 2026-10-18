const video = document.getElementById('video');
const cv = document.getElementById('fx');
const ctx = cv.getContext('2d');
const statusEl = document.getElementById('status');
let W = 0, H = 0, dpr = 1;

function resize() {
  dpr = Math.min(devicePixelRatio || 1, 2);
  W = innerWidth; H = innerHeight;
  cv.width = W * dpr; cv.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
addEventListener('resize', resize);
resize();

// ---------- состояние эффектов ----------
const strokes = [];          // неоновые линии
const stars = [];            // звёзды
const sparks = [];           // искры
const COLORS = ['#ff6ec7', '#ffe94d', '#4dfff0', '#8cff4d', '#ff9a4d', '#a98bff'];
let colorIdx = 0;
let groupId = 0;
const hands = {};            // состояние по каждой руке (индекс)

// ---------- распознавание жестов ----------
const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
function gestureOf(lm) {
  const w = lm[0];
  const ext = [[8, 6], [12, 10], [16, 14], [20, 18]].map(([t, p]) => d(lm[t], w) > d(lm[p], w) * 1.12);
  const n = ext.filter(Boolean).length;
  if (ext[0] && n === 1) return 'point';
  if (n === 0) return 'fist';
  if (n >= 4) return 'open';
  return 'other';
}

// координаты видео -> экран (зеркально, object-fit: cover)
function toScreen(p) {
  const vw = video.videoWidth || 640, vh = video.videoHeight || 480;
  const s = Math.max(W / vw, H / vh);
  const ox = (W - vw * s) / 2, oy = (H - vh * s) / 2;
  return { x: W - (p.x * vw * s + ox), y: p.y * vh * s + oy };
}

function onResults(res) {
  const seen = new Set();
  (res.multiHandLandmarks || []).forEach((lm, i) => {
    seen.add(i);
    const h = hands[i] || (hands[i] = { hist: [], tip: null, stroke: null, lastStar: null, lastStarT: 0, prev: 'other' });
    h.hist.push(gestureOf(lm));
    if (h.hist.length > 4) h.hist.shift();
    // устойчивый жест: большинство из последних кадров
    const cnt = {};
    h.hist.forEach(g => cnt[g] = (cnt[g] || 0) + 1);
    const g = Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a])[0];
    const now = performance.now();

    if (g === 'point') {
      const raw = toScreen(lm[8]);
      h.tip = h.tip ? { x: h.tip.x + (raw.x - h.tip.x) * 0.5, y: h.tip.y + (raw.y - h.tip.y) * 0.5 } : raw;
      if (!h.stroke) {
        h.stroke = { pts: [], color: COLORS[colorIdx++ % COLORS.length] };
        strokes.push(h.stroke);
      }
      h.stroke.pts.push({ x: h.tip.x, y: h.tip.y });
      for (let k = 0; k < 2; k++) addSpark(h.tip.x, h.tip.y, h.stroke.color);
    } else {
      h.stroke = null; h.tip = null;
    }

    if (g === 'fist') {
      const c = [0, 5, 9, 13, 17].map(k => toScreen(lm[k]));
      const p = { x: c.reduce((s, q) => s + q.x, 0) / 5, y: c.reduce((s, q) => s + q.y, 0) / 5 };
      if (h.prev !== 'fist') { groupId++; h.lastStar = null; }
      if (!h.lastStar || Math.hypot(p.x - h.lastStar.x, p.y - h.lastStar.y) > 55 || now - h.lastStarT > 500) {
        stars.push({ x: p.x, y: p.y, r: 7 + Math.random() * 7, rot: Math.random() * 6.28, born: now,
                     ph: Math.random() * 6.28, group: groupId, vx: 0, vy: 0, fly: false, life: 1 });
        h.lastStar = p; h.lastStarT = now;
      }
    }

    if (g === 'open' && stars.length) {
      const c = toScreen(lm[9]);
      stars.forEach(s => {
        if (s.fly) return;
        const a = Math.atan2(s.y - c.y, s.x - c.x) + (Math.random() - 0.5) * 1.2;
        const sp = 8 + Math.random() * 14;
        s.fly = true; s.vx = Math.cos(a) * sp; s.vy = Math.sin(a) * sp - 4;
      });
    }
    h.prev = g;
  });
  Object.keys(hands).forEach(k => { if (!seen.has(+k)) { hands[k].stroke = null; hands[k].tip = null; hands[k].prev = 'other'; } });
}

function addSpark(x, y, color) {
  const a = Math.random() * 6.28, sp = 1 + Math.random() * 3;
  sparks.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1, color });
}

// ---------- отрисовка ----------
function drawStar(x, y, r, rot) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const rr = i % 2 ? r * 0.45 : r, a = rot + i * Math.PI / 5 - Math.PI / 2;
    ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  ctx.closePath();
}

function strokePath(pts) {
  ctx.beginPath();
  pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
}

function frame() {
  const now = performance.now();
  ctx.clearRect(0, 0, W, H);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';

  // неоновые линии
  strokes.forEach(s => {
    if (s.pts.length < 2) return;
    ctx.shadowColor = s.color; ctx.shadowBlur = 22;
    ctx.strokeStyle = s.color; ctx.lineWidth = 7; ctx.globalAlpha = .55;
    strokePath(s.pts); ctx.stroke();
    ctx.globalAlpha = 1; ctx.shadowBlur = 10;
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.5;
    strokePath(s.pts); ctx.stroke();
  });
  ctx.shadowBlur = 0;

  // созвездия: линии между соседними звёздами
  ctx.strokeStyle = 'rgba(255,255,255,.5)'; ctx.lineWidth = 1;
  for (let i = 1; i < stars.length; i++) {
    const a = stars[i - 1], b = stars[i];
    if (a.group !== b.group || a.fly || b.fly) continue;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }

  // звёзды
  for (let i = stars.length - 1; i >= 0; i--) {
    const s = stars[i];
    if (s.fly) {
      s.x += s.vx; s.y += s.vy; s.vx *= 0.985; s.vy *= 0.985; s.rot += 0.08; s.life -= 0.012;
      if (s.life <= 0 || s.x < -80 || s.x > W + 80 || s.y < -80 || s.y > H + 80) { stars.splice(i, 1); continue; }
      if (Math.random() < .6) addSpark(s.x, s.y, '#fff3a0');
    }
    const tw = 0.75 + 0.25 * Math.sin(now / 250 + s.ph);
    const pop = Math.min(1, (now - s.born) / 200);
    const r = s.r * tw * (0.4 + 0.6 * pop);
    ctx.globalAlpha = Math.max(0, s.life);
    ctx.shadowColor = '#ffe27a'; ctx.shadowBlur = 20;
    ctx.fillStyle = '#fff3a8';
    drawStar(s.x, s.y, r, s.rot); ctx.fill();
    ctx.shadowBlur = 0;
  }
  ctx.globalAlpha = 1;

  // искры
  for (let i = sparks.length - 1; i >= 0; i--) {
    const p = sparks[i];
    p.x += p.vx; p.y += p.vy; p.life -= 0.05;
    if (p.life <= 0) { sparks.splice(i, 1); continue; }
    ctx.globalAlpha = p.life; ctx.fillStyle = p.color;
    ctx.fillRect(p.x, p.y, 2, 2);
  }
  ctx.globalAlpha = 1;

  // кончик пальца
  Object.values(hands).forEach(h => {
    if (!h.tip) return;
    ctx.shadowColor = '#fff'; ctx.shadowBlur = 20; ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(h.tip.x, h.tip.y, 5, 0, 6.28); ctx.fill();
    ctx.shadowBlur = 0;
  });

  requestAnimationFrame(frame);
}

// ---------- запуск ----------
async function start() {
  const btn = document.getElementById('startBtn');
  btn.disabled = true; statusEl.textContent = 'Запускаю камеру…';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 1280, height: 720 }, audio: false });
    video.srcObject = stream;
    await video.play();
    const hd = new Hands({ locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/${f}` });
    hd.setOptions({ maxNumHands: 2, modelComplexity: 1, minDetectionConfidence: 0.6, minTrackingConfidence: 0.5 });
    hd.onResults(onResults);
    statusEl.textContent = 'Загружаю модель руки…';
    await hd.initialize();
    document.getElementById('start').classList.add('off');
    document.getElementById('tools').hidden = false;
    let busy = false;
    const loop = async () => {
      if (!busy && video.readyState >= 2) { busy = true; try { await hd.send({ image: video }); } finally { busy = false; } }
      requestAnimationFrame(loop);
    };
    loop();
    frame();
  } catch (e) {
    btn.disabled = false;
    statusEl.textContent = 'Не удалось запустить: ' + (e.message || e) + '. Нужен доступ к камере и HTTPS/localhost.';
  }
}
document.getElementById('startBtn').onclick = start;

document.getElementById('clearBtn').onclick = () => { strokes.length = 0; stars.length = 0; sparks.length = 0; };
document.getElementById('shotBtn').onclick = () => {
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d');
  const vw = video.videoWidth, vh = video.videoHeight, s = Math.max(W / vw, H / vh);
  x.translate(W, 0); x.scale(-1, 1);
  x.drawImage(video, (W - vw * s) / 2, (H - vh * s) / 2, vw * s, vh * s);
  x.setTransform(1, 0, 0, 1, 0, 0);
  x.drawImage(cv, 0, 0, W, H);
  const a = document.createElement('a'); a.download = 'magic-hands.png'; a.href = c.toDataURL('image/png'); a.click();
};

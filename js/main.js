'use strict';
(function () {
  const canvas = document.getElementById('c');
  const $ = (id) => document.getElementById(id);
  const PALETTE = ['#F4A3B5', '#F6C28B', '#EEDC8E', '#A9DFBF', '#9CC7EE', '#C4B0EA', '#1F8A8A', '#4A47A3'];
  const toRGB = (h) => [1, 3, 5].map(i => parseInt(h.substr(i, 2), 16) / 255);
  const RGB = PALETTE.map(toRGB);

  const store = {
    get() { try { return JSON.parse(localStorage.getItem('inkbloom') || '{}'); } catch (e) { return {}; } },
    set(v) { try { localStorage.setItem('inkbloom', JSON.stringify(v)); } catch (e) {} }
  };
  const saved = store.get();
  const settings = Object.assign({ scene: 'day', sound: true, ambient: true, slow: false, color: 0 }, saved);
  const save = () => store.set(settings);

  const state = { paused: false, clearUntil: 0, drops: 0, strokes: 0, clears: 0, renderer: null, fps: 0, night: settings.scene === 'night' ? 1 : 0 };
  let simTime = 0, visTime = 0, realTime = 0;

  // ---------- renderer ----------
  let R;
  const force2d = /[?&]renderer=2d/.test(location.search);
  try { if (force2d) throw new Error('forced'); R = window.createFluidRenderer(canvas); }
  catch (e) { if (!force2d) console.warn('WebGL fluid unavailable, using Canvas2D fallback:', e.message); R = window.createCanvasRenderer(canvas); }
  state.renderer = R.name;

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(canvas.clientWidth * dpr)), h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; R.resize(); }
  }
  resize();

  // ---------- ink presence (for "long-press on empty water") ----------
  let marks = [];
  const tau = () => (settings.slow ? 15 : 7.5);
  function markInk(x, y) { marks.push({ x, y, t: simTime }); if (marks.length > 400) marks.shift(); }
  function isEmpty(x, y) {
    const ar = canvas.width / canvas.height, T = tau();
    marks = marks.filter(m => simTime - m.t < T * 4);
    return !marks.some(m => Math.hypot((m.x - x) * ar, m.y - y) < 0.09 && Math.exp(-(simTime - m.t) / T) > 0.12);
  }

  // ---------- UI ----------
  const palette = $('palette');
  const dots = [];
  PALETTE.concat(['random']).forEach((c, i) => {
    const d = document.createElement('button');
    d.className = 'dot' + (c === 'random' ? ' random' : '');
    if (c !== 'random') d.style.background = c;
    d.dataset.idx = c === 'random' ? -1 : i;
    d.setAttribute('aria-label', c === 'random' ? 'Random colors' : 'Color ' + (i + 1));
    palette.appendChild(d); dots.push(d);
  });
  function selectColor(idx) { settings.color = idx; save(); dots.forEach(d => d.classList.toggle('on', +d.dataset.idx === idx)); }
  selectColor(settings.color);
  function pickColor() { return settings.color < 0 ? RGB[Math.floor(Math.random() * RGB.length)] : RGB[settings.color]; }

  const pill = $('pausedPill'), hint = $('hint');
  function setPaused(p) { state.paused = p; pill.classList.toggle('on', p); }
  function clearWater() { setPaused(false); state.clearUntil = realTime + 2.2; state.clears++; marks = []; }
  let hintGone = false;
  function dismissHint() { if (!hintGone) { hintGone = true; hint.classList.add('gone'); } }

  let idleTimer;
  function wake() { document.body.classList.remove('idle'); clearTimeout(idleTimer); idleTimer = setTimeout(() => document.body.classList.add('idle'), 6000); }
  wake();

  // settings panel
  const panel = $('settings');
  const openPanel = (o) => panel.classList.toggle('hidden', !o);
  const panelOpen = () => !panel.classList.contains('hidden');
  $('gear').addEventListener('click', (e) => { e.stopPropagation(); InkAudio.unlock(); openPanel(!panelOpen()); wake(); });
  function applyScene() {
    document.body.classList.toggle('night', settings.scene === 'night');
    panel.querySelectorAll('[data-scene]').forEach(b => b.classList.toggle('on', b.dataset.scene === settings.scene));
    document.querySelector('meta[name=theme-color]').setAttribute('content', settings.scene === 'night' ? '#05080e' : '#b9d6da');
  }
  panel.querySelectorAll('[data-scene]').forEach(b => b.addEventListener('click', () => { settings.scene = b.dataset.scene; save(); applyScene(); }));
  const optSound = $('optSound'), optAmbient = $('optAmbient'), optSlow = $('optSlow');
  optSound.checked = settings.sound; optAmbient.checked = settings.ambient; optSlow.checked = settings.slow;
  optSound.addEventListener('change', () => { settings.sound = optSound.checked; save(); InkAudio.setSound(settings.sound); });
  optAmbient.addEventListener('change', () => { settings.ambient = optAmbient.checked; save(); InkAudio.setAmbient(settings.ambient); });
  optSlow.addEventListener('change', () => { settings.slow = optSlow.checked; save(); });
  InkAudio.setSound(settings.sound); InkAudio.setAmbient(settings.ambient);
  applyScene();

  $('clearBtn').addEventListener('click', (e) => { e.stopPropagation(); InkAudio.unlock(); clearWater(); wake(); });

  // bottom bar: tap a dot to select, swipe up anywhere on it to clear
  const bar = $('bar');
  let barStart = null;
  bar.addEventListener('pointerdown', (e) => {
    if (e.target.closest('#clearBtn')) return;
    InkAudio.unlock(); wake();
    barStart = { id: e.pointerId, x: e.clientX, y: e.clientY, dot: e.target.closest('.dot'), done: false };
    try { bar.setPointerCapture(e.pointerId); } catch (err) {}
    e.preventDefault();
  });
  bar.addEventListener('pointermove', (e) => {
    if (!barStart || barStart.id !== e.pointerId || barStart.done) return;
    const dy = e.clientY - barStart.y, dx = e.clientX - barStart.x;
    if (dy < -60 && Math.abs(dx) < Math.abs(dy)) { barStart.done = true; clearWater(); }
  });
  const barEnd = (e) => {
    if (!barStart || barStart.id !== e.pointerId) return;
    const moved = Math.hypot(e.clientX - barStart.x, e.clientY - barStart.y);
    if (!barStart.done && barStart.dot && moved < 20 && e.type === 'pointerup') selectColor(+barStart.dot.dataset.idx);
    barStart = null;
  };
  bar.addEventListener('pointerup', barEnd); bar.addEventListener('pointercancel', barEnd);

  // ---------- touch on water ----------
  const pointers = new Map();
  const toUV = (e) => [e.clientX / canvas.clientWidth, 1 - e.clientY / canvas.clientHeight];
  const haptic = () => { if (navigator.vibrate) { try { navigator.vibrate(6); } catch (e) {} } };
  let lastStreamSound = 0;

  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    InkAudio.unlock(); wake();
    if (panelOpen()) { openPanel(false); pointers.set(e.pointerId, { swallow: true }); return; }
    if (state.paused) { setPaused(false); pointers.set(e.pointerId, { swallow: true }); return; }
    dismissHint();
    try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
    const [x, y] = toUV(e);
    const empty = isEmpty(x, y);
    const size = 0.85 + Math.random() * 0.35;
    const color = pickColor();
    R.drop(x, y, color, size); markInk(x, y); state.drops++;
    InkAudio.plop(size, x); haptic();
    const p = { x, y, sx: e.clientX, sy: e.clientY, moved: false, color, swallow: false };
    p.timer = setTimeout(() => { if (!p.moved && empty) { setPaused(true); p.swallow = true; haptic(); } }, 650);
    pointers.set(e.pointerId, p);
  });
  canvas.addEventListener('pointermove', (e) => {
    const p = pointers.get(e.pointerId);
    if (!p || p.swallow) return;
    e.preventDefault();
    if (!p.moved && Math.hypot(e.clientX - p.sx, e.clientY - p.sy) > 10) { p.moved = true; clearTimeout(p.timer); state.strokes++; }
    if (!p.moved) return;
    const [x, y] = toUV(e);
    R.stream(p.x, p.y, x, y, p.color); markInk(x, y);
    const now = performance.now();
    if (now - lastStreamSound > 140) { lastStreamSound = now; InkAudio.plop(0.4 + Math.random() * 0.3, x, true); }
    p.x = x; p.y = y;
  });
  const end = (e) => { const p = pointers.get(e.pointerId); if (p) { clearTimeout(p.timer); pointers.delete(e.pointerId); } };
  canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end);

  // block iOS gestures / zoom / scroll bounce
  ['gesturestart', 'gesturechange', 'dblclick', 'contextmenu'].forEach(t => document.addEventListener(t, (e) => e.preventDefault(), { passive: false }));
  document.addEventListener('touchmove', (e) => { if (e.cancelable && !e.target.closest('#settings')) e.preventDefault(); }, { passive: false });
  let lastTouchEnd = 0;
  document.addEventListener('touchend', (e) => { const n = Date.now(); if (n - lastTouchEnd < 300 && e.target === canvas && e.cancelable) e.preventDefault(); lastTouchEnd = n; }, { passive: false });

  // ---------- loop ----------
  let raf = 0, last = performance.now(), fpsAcc = 0, fpsN = 0;
  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(Math.max((now - last) / 1000, 0), 0.033); last = now;
    realTime += dt;
    fpsAcc += dt; fpsN++; if (fpsAcc > 1) { state.fps = Math.round(fpsN / fpsAcc); fpsAcc = 0; fpsN = 0; }
    resize();
    const clearing = realTime < state.clearUntil;
    if (!state.paused) {
      const sdt = dt * (settings.slow ? 0.6 : 1);
      simTime += dt;
      R.step(sdt, {
        dyeDecay: Math.exp(-dt / (clearing ? 0.35 : tau())),
        velDecay: Math.exp(-dt * (clearing ? 3 : 0.35)),
        curl: 20, drift: 1.1
      });
    }
    const target = settings.scene === 'night' ? 1 : 0;
    state.night += (target - state.night) * Math.min(1, dt * 2.5);
    visTime += dt * (state.paused ? 0.2 : 1);
    R.render(visTime, state.night);
  }
  function start() { if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); } }
  function stop() { cancelAnimationFrame(raf); raf = 0; }
  document.addEventListener('visibilitychange', () => { if (document.hidden) { stop(); InkAudio.suspend(); } else { start(); InkAudio.resume(); } });
  window.addEventListener('pagehide', () => { stop(); InkAudio.suspend(); });
  window.addEventListener('pageshow', () => { if (!document.hidden) start(); });
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); stop(); });
  canvas.addEventListener('webglcontextrestored', () => location.reload());
  start();

  // read-only hook for automated checks
  window.inkBloom = { state, settings, audio: InkAudio, get running() { return !!raf; } };
})();

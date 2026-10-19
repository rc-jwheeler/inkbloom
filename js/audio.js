/* Soft generated audio: watery plops + optional ambient bed. Starts only after a user gesture. */
'use strict';
window.InkAudio = (function () {
  let ctx = null, master = null, bed = null, bedGain = null, toneTimer = null;
  let soundOn = true, ambientOn = true;
  const PENTA = [0, 2, 4, 7, 9];
  function unlock() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      master = ctx.createGain(); master.gain.value = soundOn ? 0.9 : 0;
      const comp = ctx.createDynamicsCompressor();
      master.connect(comp); comp.connect(ctx.destination);
      // iOS unlock: play a silent buffer within the gesture
      const b = ctx.createBuffer(1, 1, 22050), s = ctx.createBufferSource(); s.buffer = b; s.connect(ctx.destination); s.start(0);
    }
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
    updateAmbient();
  }
  function pan(node, x) {
    if (ctx.createStereoPanner) { const p = ctx.createStereoPanner(); p.pan.value = Math.max(-1, Math.min(1, (x - 0.5) * 1.2)); node.connect(p); return p; }
    return node;
  }
  function plop(size, x, quiet) {
    if (!ctx || !soundOn) return;
    const t = ctx.currentTime, s = Math.max(0.2, Math.min(1.6, size));
    const vol = (quiet ? 0.05 : 0.16) * (0.6 + s * 0.4);
    const f0 = 300 + (1.6 - s) * 260 + Math.random() * 60;
    const o = ctx.createOscillator(), g = ctx.createGain(), lp = ctx.createBiquadFilter();
    o.type = 'sine'; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f0 * 2.1, t + 0.09);
    lp.type = 'lowpass'; lp.frequency.value = 1800;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.008); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22 + s * 0.08);
    o.connect(lp); lp.connect(g); pan(g, x).connect(master);
    o.start(t); o.stop(t + 0.4);
    if (!quiet) { // faint chime tail
      const note = 72 + PENTA[Math.floor(Math.random() * 5)] + (s > 1 ? -12 : 0);
      const c = ctx.createOscillator(), cg = ctx.createGain();
      c.type = 'triangle'; c.frequency.value = 440 * Math.pow(2, (note - 69) / 12);
      cg.gain.setValueAtTime(0.0001, t + 0.02); cg.gain.exponentialRampToValueAtTime(0.022, t + 0.05); cg.gain.exponentialRampToValueAtTime(0.0001, t + 1.8);
      c.connect(cg); pan(cg, x).connect(master); c.start(t + 0.02); c.stop(t + 2);
    }
  }
  function startBed() {
    if (bed || !ctx) return;
    const len = ctx.sampleRate * 6, buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) { const d = buf.getChannelData(ch); let last = 0; for (let i = 0; i < len; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; d[i] = last * 3.2; } }
    bed = ctx.createBufferSource(); bed.buffer = buf; bed.loop = true;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 520;
    bedGain = ctx.createGain(); bedGain.gain.value = 0;
    const lfo = ctx.createOscillator(), lfoG = ctx.createGain(); lfo.frequency.value = 0.06; lfoG.gain.value = 0.015; lfo.connect(lfoG); lfoG.connect(bedGain.gain); lfo.start();
    bed.connect(lp); lp.connect(bedGain); bedGain.connect(master); bed.start();
    bedGain.gain.setTargetAtTime(0.05, ctx.currentTime, 2);
    scheduleTone();
  }
  function stopBed() {
    if (!bed) return;
    const b = bed, g = bedGain; bed = null; bedGain = null;
    g.gain.setTargetAtTime(0, ctx.currentTime, 0.6); setTimeout(() => { try { b.stop(); } catch (e) {} }, 3000);
    clearTimeout(toneTimer);
  }
  function scheduleTone() {
    clearTimeout(toneTimer);
    toneTimer = setTimeout(() => {
      if (!bed || !soundOn || !ctx || ctx.state !== 'running') return scheduleTone();
      const t = ctx.currentTime, note = 55 + PENTA[Math.floor(Math.random() * 5)] + 12 * Math.floor(Math.random() * 2);
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = 440 * Math.pow(2, (note - 69) / 12);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.018, t + 2.5); g.gain.exponentialRampToValueAtTime(0.0001, t + 8);
      o.connect(g); pan(g, Math.random()).connect(master); o.start(t); o.stop(t + 8.5);
      scheduleTone();
    }, 7000 + Math.random() * 14000);
  }
  function updateAmbient() { if (!ctx) return; (soundOn && ambientOn) ? startBed() : stopBed(); }
  return {
    unlock, plop,
    setSound(on) { soundOn = on; if (master) master.gain.setTargetAtTime(on ? 0.9 : 0, ctx.currentTime, 0.15); updateAmbient(); },
    setAmbient(on) { ambientOn = on; updateAmbient(); },
    suspend() { if (ctx && ctx.state === 'running') ctx.suspend(); },
    resume() { if (ctx && soundOn) ctx.resume().catch(() => {}); },
    get state() { return ctx ? ctx.state : 'none'; },
    get bedOn() { return !!bed; }
  };
})();

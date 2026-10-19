/* Canvas2D fallback: soft radial blobs drifting and fading. Used only if WebGL fails. */
'use strict';
window.createCanvasRenderer = function (canvas) {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('No 2D canvas');
  let blobs = [], time = 0;
  const hex = (rgb, a) => `rgba(${Math.round(rgb[0] * 255)},${Math.round(rgb[1] * 255)},${Math.round(rgb[2] * 255)},${a})`;
  function add(x, y, rgb, r, vx, vy, amt) { blobs.push({ x, y, rgb, r, vx, vy, amt, grow: 0.012 + Math.random() * 0.01 }); if (blobs.length > 600) blobs.shift(); }
  return {
    name: 'canvas2d',
    resize() {},
    drop(x, y, rgb, size) {
      add(x, y, rgb, 0.03 * size, 0, 0, 1);
      const n = 7 + Math.floor(Math.random() * 4);
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2, s = (0.01 + Math.random() * 0.03) * size;
        add(x, y, rgb, 0.012 * size, Math.cos(a) * s, Math.sin(a) * s, 0.6);
      }
    },
    stream(x0, y0, x1, y1, rgb) {
      const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 0.01));
      for (let i = 1; i <= steps; i++) { const t = i / steps; add(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, rgb, 0.012, (x1 - x0) * 0.6, (y1 - y0) * 0.6, 0.35); }
    },
    step(dt, opts) {
      time += dt;
      const decay = opts.dyeDecay;
      for (const b of blobs) {
        b.x += b.vx * dt + Math.sin(time * 0.05 + b.y * 6) * 0.002 * dt; b.y += b.vy * dt + Math.cos(time * 0.04 + b.x * 6) * 0.002 * dt;
        b.vx *= Math.pow(0.4, dt); b.vy *= Math.pow(0.4, dt);
        b.r += b.grow * dt; b.grow *= Math.pow(0.7, dt); b.amt *= decay;
      }
      blobs = blobs.filter(b => b.amt > 0.01);
    },
    render(t, night) {
      const w = canvas.width, h = canvas.height, m = h;
      const g = ctx.createLinearGradient(0, 0, 0, h);
      if (night > 0.5) { g.addColorStop(0, '#09101a'); g.addColorStop(1, '#03070d'); } else { g.addColorStop(0, '#dcecea'); g.addColorStop(1, '#b3d3d8'); }
      ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1; ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = night > 0.5 ? 'lighter' : 'multiply';
      for (const b of blobs) {
        const px = b.x * w, py = (1 - b.y) * h, r = b.r * m;
        const rg = ctx.createRadialGradient(px, py, 0, px, py, r);
        const a = Math.min(1, b.amt) * (night > 0.5 ? 0.5 : 0.75);
        rg.addColorStop(0, hex(b.rgb, a)); rg.addColorStop(1, hex(b.rgb, 0));
        ctx.fillStyle = rg; ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
    },
    isLost: () => false
  };
};

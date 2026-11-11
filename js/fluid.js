/* Ink Bloom: small WebGL advection / pressure-projection fluid with ink "dye". */
'use strict';
window.createFluidRenderer = function (canvas) {
  const ctxParams = { alpha: false, depth: false, stencil: false, antialias: false, preserveDrawingBuffer: false, powerPreference: 'default' };
  let gl = canvas.getContext('webgl2', ctxParams);
  const isWebGL2 = !!gl;
  if (!gl) gl = canvas.getContext('webgl', ctxParams) || canvas.getContext('experimental-webgl', ctxParams);
  if (!gl) throw new Error('WebGL unavailable');

  let halfFloat, supportLinear;
  if (isWebGL2) {
    gl.getExtension('EXT_color_buffer_float');
    gl.getExtension('EXT_color_buffer_half_float');
    halfFloat = gl.HALF_FLOAT;
    supportLinear = true; // 16F is filterable in WebGL2
  } else {
    const hf = gl.getExtension('OES_texture_half_float');
    if (!hf) throw new Error('No half float textures');
    gl.getExtension('EXT_color_buffer_half_float');
    halfFloat = hf.HALF_FLOAT_OES;
    supportLinear = !!gl.getExtension('OES_texture_half_float_linear');
  }

  function supportRender(internalFormat, format, type) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, 4, 4, 0, format, type, null);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fbo); gl.deleteTexture(tex);
    return ok;
  }
  function format(internalFormat, fmt) {
    if (supportRender(internalFormat, fmt, halfFloat)) return { internalFormat, format: fmt };
    if (!isWebGL2) return null;
    if (internalFormat === gl.R16F) return format(gl.RG16F, gl.RG);
    if (internalFormat === gl.RG16F) return format(gl.RGBA16F, gl.RGBA);
    return null;
  }
  const fRGBA = isWebGL2 ? format(gl.RGBA16F, gl.RGBA) : format(gl.RGBA, gl.RGBA);
  const fRG = isWebGL2 ? format(gl.RG16F, gl.RG) : fRGBA;
  const fR = isWebGL2 ? format(gl.R16F, gl.RED) : fRGBA;
  if (!fRGBA || !fRG || !fR) throw new Error('No renderable float format');

  // ---------- shaders ----------
  const baseVS = `
    precision highp float;
    attribute vec2 aPosition;
    varying vec2 vUv; varying vec2 vL; varying vec2 vR; varying vec2 vT; varying vec2 vB;
    uniform vec2 texelSize;
    void main () {
      vUv = aPosition * 0.5 + 0.5;
      vL = vUv - vec2(texelSize.x, 0.0); vR = vUv + vec2(texelSize.x, 0.0);
      vT = vUv + vec2(0.0, texelSize.y); vB = vUv - vec2(0.0, texelSize.y);
      gl_Position = vec4(aPosition, 0.0, 1.0);
    }`;
  const H = 'precision highp float; precision highp sampler2D;\n varying vec2 vUv; varying vec2 vL; varying vec2 vR; varying vec2 vT; varying vec2 vB;\n';
  const FS = {
    copy: H + `uniform sampler2D uTexture; void main(){ gl_FragColor = texture2D(uTexture, vUv); }`,
    clear: H + `uniform sampler2D uTexture; uniform float value; void main(){ gl_FragColor = value * texture2D(uTexture, vUv); }`,
    splat: H + `
      uniform sampler2D uTarget; uniform float aspectRatio; uniform vec4 color; uniform vec2 point;
      uniform float radius; uniform float irregular; uniform float seed;
      void main () {
        vec2 p = vUv - point; p.x *= aspectRatio;
        float g = exp(-dot(p, p) / radius);
        float ang = atan(p.y, p.x);
        float n = 0.55 * sin(ang * 3.0 + seed) + 0.3 * sin(ang * 7.0 + seed * 1.7) + 0.15 * sin(ang * 13.0 + seed * 2.3);
        g *= clamp(1.0 + irregular * n * smoothstep(0.0, 0.6, 1.0 - g), 0.0, 2.0);
        gl_FragColor = texture2D(uTarget, vUv) + color * g;
      }`,
    advection: H + `
      uniform sampler2D uVelocity; uniform sampler2D uSource;
      uniform vec2 texelSize; uniform vec2 dyeTexelSize; uniform float dt; uniform float decay;
      vec4 bilerp (sampler2D sam, vec2 uv, vec2 tsize) {
        vec2 st = uv / tsize - 0.5; vec2 iuv = floor(st); vec2 fuv = fract(st);
        vec4 a = texture2D(sam, (iuv + vec2(0.5, 0.5)) * tsize);
        vec4 b = texture2D(sam, (iuv + vec2(1.5, 0.5)) * tsize);
        vec4 c = texture2D(sam, (iuv + vec2(0.5, 1.5)) * tsize);
        vec4 d = texture2D(sam, (iuv + vec2(1.5, 1.5)) * tsize);
        return mix(mix(a, b, fuv.x), mix(c, d, fuv.x), fuv.y);
      }
      void main () {
      #ifdef MANUAL_FILTERING
        vec2 coord = vUv - dt * bilerp(uVelocity, vUv, texelSize).xy * texelSize;
        vec4 result = bilerp(uSource, coord, dyeTexelSize);
      #else
        vec2 coord = vUv - dt * texture2D(uVelocity, vUv).xy * texelSize;
        vec4 result = texture2D(uSource, coord);
      #endif
        gl_FragColor = result * decay;
      }`,
    force: H + `
      uniform sampler2D uVelocity; uniform float time; uniform float strength; uniform float dt; uniform float aspectRatio;
      void main () {
        vec2 p = vUv * vec2(aspectRatio, 1.0) * 2.2;
        float a = 1.3 * p.x + 0.05 * time, b = 1.1 * p.y - 0.04 * time, c = 2.7 * p.x - 1.9 * p.y + 0.07 * time;
        float dpx = 1.3 * cos(a) * cos(b) + 1.35 * cos(c);
        float dpy = -1.1 * sin(a) * sin(b) - 0.95 * cos(c);
        vec2 v = texture2D(uVelocity, vUv).xy + vec2(dpy, -dpx) * strength * dt;
        gl_FragColor = vec4(v, 0.0, 1.0);
      }`,
    divergence: H + `
      uniform sampler2D uVelocity;
      void main () {
        float L = texture2D(uVelocity, vL).x; float R = texture2D(uVelocity, vR).x;
        float T = texture2D(uVelocity, vT).y; float B = texture2D(uVelocity, vB).y;
        vec2 C = texture2D(uVelocity, vUv).xy;
        if (vL.x < 0.0) L = -C.x; if (vR.x > 1.0) R = -C.x;
        if (vT.y > 1.0) T = -C.y; if (vB.y < 0.0) B = -C.y;
        gl_FragColor = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);
      }`,
    curl: H + `
      uniform sampler2D uVelocity;
      void main () {
        float L = texture2D(uVelocity, vL).y; float R = texture2D(uVelocity, vR).y;
        float T = texture2D(uVelocity, vT).x; float B = texture2D(uVelocity, vB).x;
        gl_FragColor = vec4(0.5 * (R - L - T + B), 0.0, 0.0, 1.0);
      }`,
    vorticity: H + `
      uniform sampler2D uVelocity; uniform sampler2D uCurl; uniform float curl; uniform float dt;
      void main () {
        float L = texture2D(uCurl, vL).x; float R = texture2D(uCurl, vR).x;
        float T = texture2D(uCurl, vT).x; float B = texture2D(uCurl, vB).x;
        float C = texture2D(uCurl, vUv).x;
        vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
        force /= length(force) + 0.0001; force *= curl * C; force.y *= -1.0;
        vec2 v = texture2D(uVelocity, vUv).xy + force * dt;
        v = min(max(v, -1000.0), 1000.0);
        gl_FragColor = vec4(v, 0.0, 1.0);
      }`,
    pressure: H + `
      uniform sampler2D uPressure; uniform sampler2D uDivergence;
      void main () {
        float L = texture2D(uPressure, vL).x; float R = texture2D(uPressure, vR).x;
        float T = texture2D(uPressure, vT).x; float B = texture2D(uPressure, vB).x;
        float d = texture2D(uDivergence, vUv).x;
        gl_FragColor = vec4((L + R + B + T - d) * 0.25, 0.0, 0.0, 1.0);
      }`,
    gradient: H + `
      uniform sampler2D uPressure; uniform sampler2D uVelocity;
      void main () {
        float L = texture2D(uPressure, vL).x; float R = texture2D(uPressure, vR).x;
        float T = texture2D(uPressure, vT).x; float B = texture2D(uPressure, vB).x;
        vec2 v = texture2D(uVelocity, vUv).xy - vec2(R - L, T - B);
        gl_FragColor = vec4(v, 0.0, 1.0);
      }`,
    display: H + `
      uniform sampler2D uDye; uniform sampler2D uVelocity;
      uniform float uTime; uniform float uNight; uniform float aspectRatio; uniform vec2 dyeTexel;
      uniform vec2 uUvScale; uniform vec2 uUvOffset;
      float hash (vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise (vec2 p) {
        vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
      }
      float caustic (vec2 uv, float t) {
        vec2 p = uv * 6.28318 - 250.0; vec2 i = p; float c = 1.0; float inten = 0.005;
        for (int n = 0; n < 4; n++) {
          float tt = t * (1.0 - (3.5 / float(n + 1)));
          i = p + vec2(cos(tt - i.x) + sin(tt + i.y), sin(tt - i.y) + cos(tt + i.x));
          c += 1.0 / length(vec2(p.x / (sin(i.x + tt) / inten), p.y / (cos(i.y + tt) / inten)));
        }
        c /= 4.0; c = 1.17 - pow(c, 1.4);
        return clamp(pow(abs(c), 8.0), 0.0, 1.0);
      }
      void main () {
        vec2 uv = uUvOffset + vUv * uUvScale; float t = uTime;
        vec2 vel = texture2D(uVelocity, uv).xy;
        vec2 wuv = uv * vec2(aspectRatio, 1.0) + vec2(t * 0.006, t * 0.004) + vel * 0.0004;
        float n = noise(wuv * 3.0 + t * 0.02) * 0.6 + noise(wuv * 7.0 - t * 0.03) * 0.4;
        float ca = caustic(wuv * 0.85, t * 0.16 + 23.0);
        vec3 water = mix(
          mix(vec3(0.70, 0.83, 0.85), vec3(0.87, 0.93, 0.92), uv.y * 0.7 + n * 0.3),
          mix(vec3(0.012, 0.025, 0.05), vec3(0.035, 0.06, 0.10), uv.y * 0.6 + n * 0.4), uNight);
        water += ca * mix(vec3(0.09, 0.11, 0.10), vec3(0.035, 0.07, 0.11), uNight);
        vec2 q = uv - 0.5; water *= 1.0 - dot(q, q) * mix(0.35, 0.9, uNight);

        vec4 d = texture2D(uDye, uv);
        float a = max(d.a, 0.0);
        vec3 c = clamp(d.rgb / max(a, 0.0001), 0.0, 1.0);
        float op = 1.0 - exp(-a * mix(3.0, 2.6, uNight));
        float aN = 0.25 * (texture2D(uDye, uv + vec2(dyeTexel.x * 2.0, 0.0)).a + texture2D(uDye, uv - vec2(dyeTexel.x * 2.0, 0.0)).a
                         + texture2D(uDye, uv + vec2(0.0, dyeTexel.y * 2.0)).a + texture2D(uDye, uv - vec2(0.0, dyeTexel.y * 2.0)).a);
        float edge = clamp((a - aN) * 5.0, 0.0, 1.0);

        vec3 dayInk = mix(c, water * c * 1.3, 0.45);
        vec3 dayCol = mix(water, dayInk, op * 0.93) * (1.0 - edge * 0.2 * op);
        vec3 bright = mix(c, vec3(1.0), 0.12) * 1.15;
        vec3 nightCol = water * (1.0 - op * 0.5) + bright * op * 1.15 + bright * edge * 0.2;
        vec3 col = mix(dayCol, nightCol, uNight);
        col += (n - 0.5) * 0.012;
        col += (hash(gl_FragCoord.xy + fract(t)) - 0.5) / 255.0;
        gl_FragColor = vec4(col, 1.0);
      }`
  };

  function compile(type, src, defines) {
    const s = gl.createShader(type);
    gl.shaderSource(s, (defines || '') + src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('Shader: ' + gl.getShaderInfoLog(s));
    return s;
  }
  const vs = compile(gl.VERTEX_SHADER, baseVS);
  function program(fsSrc, defines) {
    const p = gl.createProgram();
    gl.attachShader(p, vs); gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fsSrc, defines));
    gl.bindAttribLocation(p, 0, 'aPosition');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Link: ' + gl.getProgramInfoLog(p));
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const name = gl.getActiveUniform(p, i).name; u[name] = gl.getUniformLocation(p, name); }
    return { p, u, bind() { gl.useProgram(p); } };
  }
  const P = {};
  for (const k in FS) P[k] = program(FS[k], k === 'advection' && !supportLinear ? '#define MANUAL_FILTERING\n' : '');

  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]), gl.STATIC_DRAW);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.enableVertexAttribArray(0);

  function blit(target) {
    if (!target) { gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight); gl.bindFramebuffer(gl.FRAMEBUFFER, null); }
    else { gl.viewport(0, 0, target.width, target.height); gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo); }
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
  }

  function createFBO(w, h, f, filter) {
    gl.activeTexture(gl.TEXTURE0);
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, f.internalFormat, w, h, 0, f.format, halfFloat, null);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.viewport(0, 0, w, h); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    return {
      texture, fbo, width: w, height: h, tx: 1 / w, ty: 1 / h,
      attach(id) { gl.activeTexture(gl.TEXTURE0 + id); gl.bindTexture(gl.TEXTURE_2D, texture); return id; },
      dispose() { gl.deleteTexture(texture); gl.deleteFramebuffer(fbo); }
    };
  }
  function createDouble(w, h, f, filter) {
    let a = createFBO(w, h, f, filter), b = createFBO(w, h, f, filter);
    return {
      width: w, height: h, tx: 1 / w, ty: 1 / h,
      get read() { return a; }, get write() { return b; },
      swap() { const t = a; a = b; b = t; },
      dispose() { a.dispose(); b.dispose(); }
    };
  }
  function resizeDouble(old, w, h, f, filter) {
    if (old && old.width === w && old.height === h) return old;
    const nd = createDouble(w, h, f, filter);
    if (old) {
      P.copy.bind(); gl.uniform1i(P.copy.u.uTexture, old.read.attach(0));
      blit(nd.write); nd.swap(); old.dispose();
    }
    return nd;
  }
  function res(r) {
    let ar = gl.drawingBufferWidth / gl.drawingBufferHeight; if (ar < 1) ar = 1 / ar;
    const mn = Math.round(r), mx = Math.round(r * ar);
    return gl.drawingBufferWidth > gl.drawingBufferHeight ? { w: mx, h: mn } : { w: mn, h: mx };
  }

  const SIM_RES = 128, DYE_RES = 512;
  const filter = supportLinear ? gl.LINEAR : gl.NEAREST;
  let velocity, dye, divergence, curl, pressure;
  function initFramebuffers() {
    const s = res(SIM_RES), d = res(DYE_RES);
    dye = resizeDouble(dye, d.w, d.h, fRGBA, filter);
    velocity = resizeDouble(velocity, s.w, s.h, fRG, filter);
    if (!divergence || divergence.width !== s.w || divergence.height !== s.h) {
      if (divergence) { divergence.dispose(); curl.dispose(); pressure.dispose(); }
      divergence = createFBO(s.w, s.h, fR, gl.NEAREST);
      curl = createFBO(s.w, s.h, fR, gl.NEAREST);
      pressure = createDouble(s.w, s.h, fR, gl.NEAREST);
    }
  }
  initFramebuffers();

  const aspect = () => canvas.width / canvas.height;

  function splat(target, x, y, color, radius, irregular) {
    P.splat.bind();
    gl.uniform1i(P.splat.u.uTarget, target.read.attach(0));
    gl.uniform1f(P.splat.u.aspectRatio, aspect());
    gl.uniform2f(P.splat.u.point, x, y);
    gl.uniform4f(P.splat.u.color, color[0], color[1], color[2], color[3]);
    gl.uniform1f(P.splat.u.radius, radius);
    gl.uniform1f(P.splat.u.irregular, irregular || 0);
    gl.uniform1f(P.splat.u.seed, Math.random() * 100);
    blit(target.write); target.swap();
  }
  const dyeSplat = (x, y, rgb, amt, sigma, irr) => splat(dye, x, y, [rgb[0] * amt, rgb[1] * amt, rgb[2] * amt, amt], sigma * sigma, irr);
  const velSplat = (x, y, vx, vy, sigma) => splat(velocity, x, y, [vx, vy, 0, 0], sigma * sigma, 0);

  let time = 0;
  const api = {
    name: isWebGL2 ? 'webgl2' : 'webgl1',
    resize() { initFramebuffers(); },
    drop(x, y, rgb, size) {
      const ar = aspect();
      const jets = 5 + Math.floor(Math.random() * 3), base = Math.random() * Math.PI * 2;
      for (let i = 0; i < jets; i++) {
        const ang = base + i * (Math.PI * 2 / jets) + (Math.random() - 0.5) * 0.9;
        const dx = Math.cos(ang), dy = Math.sin(ang), off = 0.012 * size;
        const f = (150 + Math.random() * 130) * size;
        velSplat(x + dx * off / ar, y + dy * off, dx * f, dy * f, 0.02 * size);
      }
      dyeSplat(x, y, rgb, 1.6, 0.03 * size, 0.9);
      const sats = 2 + Math.floor(Math.random() * 3);
      for (let i = 0; i < sats; i++) {
        const ang = Math.random() * Math.PI * 2, r = (0.012 + Math.random() * 0.02) * size;
        dyeSplat(x + Math.cos(ang) * r / ar, y + Math.sin(ang) * r, rgb, 0.35 + Math.random() * 0.3, 0.008 * size, 0.6);
      }
    },
    stream(x0, y0, x1, y1, rgb) {
      const ar = aspect();
      const dxh = (x1 - x0) * ar, dyh = y1 - y0;
      const dist = Math.hypot(dxh, dyh);
      const steps = Math.max(1, Math.min(24, Math.ceil(dist / 0.007)));
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        dyeSplat(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, rgb, 0.26, 0.011, 0.4);
      }
      const k = 1700;
      velSplat(x1, y1, Math.max(-400, Math.min(400, dxh * k)), Math.max(-400, Math.min(400, dyh * k)), 0.02);
    },
    step(dt, opts) {
      gl.disable(gl.BLEND);
      time += dt;
      const s = velocity;
      // gentle ambient drift
      P.force.bind();
      gl.uniform2f(P.force.u.texelSize, s.tx, s.ty);
      gl.uniform1i(P.force.u.uVelocity, s.read.attach(0));
      gl.uniform1f(P.force.u.time, time);
      gl.uniform1f(P.force.u.strength, opts.drift);
      gl.uniform1f(P.force.u.dt, dt);
      gl.uniform1f(P.force.u.aspectRatio, aspect());
      blit(s.write); s.swap();

      P.curl.bind();
      gl.uniform2f(P.curl.u.texelSize, s.tx, s.ty);
      gl.uniform1i(P.curl.u.uVelocity, s.read.attach(0));
      blit(curl);

      P.vorticity.bind();
      gl.uniform2f(P.vorticity.u.texelSize, s.tx, s.ty);
      gl.uniform1i(P.vorticity.u.uVelocity, s.read.attach(0));
      gl.uniform1i(P.vorticity.u.uCurl, curl.attach(1));
      gl.uniform1f(P.vorticity.u.curl, opts.curl);
      gl.uniform1f(P.vorticity.u.dt, dt);
      blit(s.write); s.swap();

      P.divergence.bind();
      gl.uniform2f(P.divergence.u.texelSize, s.tx, s.ty);
      gl.uniform1i(P.divergence.u.uVelocity, s.read.attach(0));
      blit(divergence);

      P.clear.bind();
      gl.uniform1i(P.clear.u.uTexture, pressure.read.attach(0));
      gl.uniform1f(P.clear.u.value, 0.8);
      blit(pressure.write); pressure.swap();

      P.pressure.bind();
      gl.uniform2f(P.pressure.u.texelSize, s.tx, s.ty);
      gl.uniform1i(P.pressure.u.uDivergence, divergence.attach(0));
      for (let i = 0; i < 20; i++) {
        gl.uniform1i(P.pressure.u.uPressure, pressure.read.attach(1));
        blit(pressure.write); pressure.swap();
      }

      P.gradient.bind();
      gl.uniform2f(P.gradient.u.texelSize, s.tx, s.ty);
      gl.uniform1i(P.gradient.u.uPressure, pressure.read.attach(0));
      gl.uniform1i(P.gradient.u.uVelocity, s.read.attach(1));
      blit(s.write); s.swap();

      P.advection.bind();
      gl.uniform2f(P.advection.u.texelSize, s.tx, s.ty);
      if (!supportLinear) gl.uniform2f(P.advection.u.dyeTexelSize, s.tx, s.ty);
      const vid = s.read.attach(0);
      gl.uniform1i(P.advection.u.uVelocity, vid);
      gl.uniform1i(P.advection.u.uSource, vid);
      gl.uniform1f(P.advection.u.dt, dt);
      gl.uniform1f(P.advection.u.decay, opts.velDecay);
      blit(s.write); s.swap();

      if (!supportLinear) gl.uniform2f(P.advection.u.dyeTexelSize, dye.tx, dye.ty);
      gl.uniform1i(P.advection.u.uVelocity, s.read.attach(0));
      gl.uniform1i(P.advection.u.uSource, dye.read.attach(1));
      gl.uniform1f(P.advection.u.decay, opts.dyeDecay);
      blit(dye.write); dye.swap();
    },
    render(t, night) {
      P.display.bind();
      gl.uniform1i(P.display.u.uDye, dye.read.attach(0));
      gl.uniform1i(P.display.u.uVelocity, velocity.read.attach(1));
      gl.uniform1f(P.display.u.uTime, t);
      gl.uniform1f(P.display.u.uNight, night);
      gl.uniform1f(P.display.u.aspectRatio, aspect());
      gl.uniform2f(P.display.u.dyeTexel, dye.tx, dye.ty);
      gl.uniform2f(P.display.u.uUvScale, 1, 1);
      gl.uniform2f(P.display.u.uUvOffset, 0, 0);
      blit(null);
    },
    exportFrame(tw, th, t, night) {
      const srcW = canvas.width, srcH = canvas.height;
      const sa = srcW / srcH, ta = tw / th;
      let scaleX = 1, scaleY = 1, offX = 0, offY = 0;
      if (sa > ta) { scaleX = ta / sa; offX = (1 - scaleX) / 2; }
      else { scaleY = sa / ta; offY = (1 - scaleY) / 2; }

      const tex = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const internal = isWebGL2 ? gl.RGBA8 : gl.RGBA;
      gl.texImage2D(gl.TEXTURE_2D, 0, internal, tw, th, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.deleteFramebuffer(fbo); gl.deleteTexture(tex);
        throw new Error('Wallpaper framebuffer incomplete');
      }

      P.display.bind();
      gl.uniform1i(P.display.u.uDye, dye.read.attach(0));
      gl.uniform1i(P.display.u.uVelocity, velocity.read.attach(1));
      gl.uniform1f(P.display.u.uTime, t);
      gl.uniform1f(P.display.u.uNight, night);
      gl.uniform1f(P.display.u.aspectRatio, aspect());
      gl.uniform2f(P.display.u.dyeTexel, dye.tx, dye.ty);
      gl.uniform2f(P.display.u.uUvScale, scaleX, scaleY);
      gl.uniform2f(P.display.u.uUvOffset, offX, offY);
      gl.viewport(0, 0, tw, th);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);

      const pixels = new Uint8Array(tw * th * 4);
      gl.readPixels(0, 0, tw, th, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(fbo); gl.deleteTexture(tex);

      const out = document.createElement('canvas');
      out.width = tw; out.height = th;
      const ctx = out.getContext('2d');
      const img = ctx.createImageData(tw, th);
      const row = tw * 4;
      for (let y = 0; y < th; y++) {
        img.data.set(pixels.subarray((th - 1 - y) * row, (th - y) * row), y * row);
      }
      ctx.putImageData(img, 0, 0);
      return out;
    },
    isLost: () => gl.isContextLost()
  };
  return api;
};

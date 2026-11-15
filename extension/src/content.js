// 3D Viewing content script: finds the playing <video>, ships tiny frames to the local app (via the service worker),
// and renders a red/cyan anaglyph over the video with WebGL2 using the depth maps that come back.
(() => {
  if (window.__d3dLoaded) return;
  window.__d3dLoaded = true;

  const DEFAULTS = { enabled: false, strength: 2.0, convergence: 0.4, swapEyes: false, mode: "dubois", quality: "medium", preferH264: false };
  const QUALITY = { low: { maxH: 480, steps: 3 }, medium: { maxH: 720, steps: 5 }, high: { maxH: 1080, steps: 6 }, native: { maxH: 4320, steps: 6 } };
  const MIN_VIDEO_AREA = 240 * 135;
  const MIN_SEND_INTERVAL = 40; // ms
  const STREAM = crypto.getRandomValues(new Uint32Array(1))[0] >>> 0;

  let settings = { ...DEFAULTS };
  let port = null;
  let appConnected = false;
  let inflight = false, inflightAt = 0, lastSendAt = 0, lastSentMediaTime = -1;
  let frameId = 0;
  let nextW = 196;
  let lastDepthAt = 0;
  let video = null;
  let renderer = null;
  let blocked = new WeakSet();
  let badge = "";
  const capCanvas = document.createElement("canvas");
  const capCtx = capCanvas.getContext("2d", { willReadFrequently: true });

  // ---------------------------------------------------------------- settings
  chrome.storage.local.get(DEFAULTS).then((s) => { settings = { ...DEFAULTS, ...s }; applyEnabled(); });
  chrome.storage.onChanged.addListener((ch) => {
    for (const k in ch) settings[k] = ch[k].newValue;
    applyEnabled();
    if (renderer) renderer.queueDraw();
  });

  // ------------------------------------------------------------ app connection
  function ensurePort() {
    if (port) return port;
    try {
      port = chrome.runtime.connect({ name: "d3d" });
    } catch (_) { port = null; return null; }
    port.onMessage.addListener(onBg);
    port.onDisconnect.addListener(() => { port = null; inflight = false; appConnected = false; });
    port.postMessage({ t: "hello", stream: STREAM });
    return port;
  }
  function closePort() { if (port) { try { port.disconnect(); } catch (_) {} port = null; } appConnected = false; inflight = false; }

  function onBg(m) {
    if (m.t === "state") {
      appConnected = m.connected;
      if (!m.connected) setBadge(settings.enabled ? "!" : "", "#c0392b");
      return;
    }
    if (m.t !== "depth") return;
    inflight = false;
    if (m.nextW >= 112 && m.nextW <= 640) nextW = m.nextW;
    const bin = atob(m.b64);
    const d = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) d[i] = bin.charCodeAt(i);
    lastDepthAt = performance.now();
    if (renderer) { renderer.setDepth(d, m.w, m.h, (m.flags & 1) !== 0); setBadge("3D", "#1e8e3e"); }
  }

  function setBadge(text, color) {
    if (text === badge || !port) return;
    badge = text;
    port.postMessage({ t: "badge", text, color });
  }

  // --------------------------------------------------------------- video logic
  function visibleArea(v) {
    const r = v.getBoundingClientRect();
    if (r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) return 0;
    return r.width * r.height;
  }
  function pickVideo() {
    if (video && video.isConnected && visibleArea(video) >= MIN_VIDEO_AREA && !video.ended) return video;
    let best = null, area = 0;
    for (const v of document.querySelectorAll("video")) {
      if (blocked.has(v) || v.readyState < 2 || v.paused || v.ended) continue;
      const a = visibleArea(v);
      if (a >= MIN_VIDEO_AREA && a > area) { best = v; area = a; }
    }
    return best;
  }

  function applyEnabled() {
    if (settings.enabled) { if (!tickTimer) tickTimer = setInterval(tick, 700); tick(); }
    else { if (tickTimer) { clearInterval(tickTimer); tickTimer = null; } detach(); closePort(); }
  }
  let tickTimer = null;

  function tick() {
    if (!settings.enabled) return;
    const v = pickVideo();
    if (v !== video) { detach(); if (v) attach(v); }
    if (video) ensurePort();
    if (renderer && appConnected && lastDepthAt && performance.now() - lastDepthAt > 4000 && !video.paused) {
      renderer.hide(); // app stalled: fall back to the plain video
    }
  }

  function attach(v) {
    if (v.mediaKeys) { blocked.add(v); setBadge("DRM", "#7f8c8d"); ensurePort(); return; }
    video = v;
    try { renderer = new Renderer(v); } catch (e) { console.warn("[3D Viewing] WebGL2 unavailable", e); video = null; return; }
    lastSentMediaTime = -1; inflight = false; lastDepthAt = 0;
    loop();
  }
  function detach() {
    if (renderer) renderer.destroy();
    renderer = null; video = null; inflight = false;
    setBadge("", "#000");
  }

  // Per-video-frame loop: capture a small frame for the app when idle, redraw the overlay.
  function loop() {
    const v = video, r = renderer;
    if (!v || !r || v !== video) return;
    const next = (cb) => (v.requestVideoFrameCallback ? v.requestVideoFrameCallback(cb) : requestAnimationFrame(() => cb(performance.now(), {})));
    const step = (_now, meta) => {
      if (v !== video || r !== renderer) return;
      maybeSendFrame(v, meta && meta.mediaTime !== undefined ? meta.mediaTime : v.currentTime);
      r.draw();
      next(step);
    };
    next(step);
  }

  function maybeSendFrame(v, mediaTime) {
    const now = performance.now();
    if (!appConnected || !port) return;
    if (inflight && now - inflightAt < 1500) return;
    if (now - lastSendAt < MIN_SEND_INTERVAL) return;
    if (v.paused && mediaTime === lastSentMediaTime) return;
    if (v.videoWidth < 2 || v.videoHeight < 2) return;
    const ar = v.videoWidth / v.videoHeight;
    const w = nextW, h = Math.max(28, Math.round(w / ar / 14) * 14);
    if (capCanvas.width !== w || capCanvas.height !== h) { capCanvas.width = w; capCanvas.height = h; }
    let img;
    try {
      capCtx.drawImage(v, 0, 0, w, h);
      img = capCtx.getImageData(0, 0, w, h).data;
    } catch (_) { return markBlocked(v, "unreadable"); }
    const rgb = new Uint8Array(w * h * 3);
    for (let i = 0, j = 0; i < img.length; i += 4, j += 3) { rgb[j] = img[i]; rgb[j + 1] = img[i + 1]; rgb[j + 2] = img[i + 2]; }
    let s = "";
    for (let i = 0; i < rgb.length; i += 0x8000) s += String.fromCharCode.apply(null, rgb.subarray(i, i + 0x8000));
    inflight = true; inflightAt = now; lastSendAt = now; lastSentMediaTime = mediaTime;
    port.postMessage({ t: "frame", stream: STREAM, fid: frameId++ >>> 0, w, h, b64: btoa(s) });
  }

  function markBlocked(v, why) {
    blocked.add(v);
    detach();
    setBadge(why === "drm" ? "DRM" : "N/A", "#7f8c8d");
  }

  // ------------------------------------------------------------------ renderer
  const VERT = `#version 300 es
out vec2 vUv;
void main(){ vec2 p = vec2(float((gl_VertexID<<1)&2), float(gl_VertexID&2)); vUv = p; gl_Position = vec4(p*2.0-1.0, 0.0, 1.0); }`;

  // Pass 1: cross-fade the two latest depth maps and upsample them to canvas resolution, guided by the video's luma
  // (joint bilateral over the 2x2 depth footprint) so depth edges snap to picture edges.
  const FRAG_REFINE = `#version 300 es
precision highp float;
uniform sampler2D uDA, uDB, uVid;
uniform float uMix; uniform vec4 uRect; uniform vec2 uDepthSize;
in vec2 vUv; out vec4 o;
float luma(vec3 c){ return dot(c, vec3(0.299,0.587,0.114)); }
vec3 vid(vec2 uv){ return texture(uVid, clamp((uv-uRect.xy)/(uRect.zw-uRect.xy),0.0,1.0)).rgb; }
float depthAt(vec2 uv){ return mix(texture(uDA,uv).r, texture(uDB,uv).r, uMix); }
void main(){
  vec2 vuv = clamp((vUv-uRect.xy)/(uRect.zw-uRect.xy),0.0,1.0);
  vec2 p = vuv*uDepthSize - 0.5; vec2 i = floor(p); vec2 f = p - i;
  float Lp = luma(texture(uVid, vuv).rgb);
  float sum = 0.0, wsum = 0.0;
  for(int y=0;y<2;y++) for(int x=0;x<2;x++){
    vec2 q = (i + vec2(float(x),float(y)) + 0.5)/uDepthSize;
    float wb = (x==0 ? 1.0-f.x : f.x) * (y==0 ? 1.0-f.y : f.y);
    float dl = Lp - luma(texture(uVid, q).rgb);
    float w = wb*exp(-dl*dl*40.0) + 1e-4;
    sum += w*depthAt(q); wsum += w;
  }
  o = vec4(vec3(sum/wsum), 1.0);
}`;

  // Pass 2: synthesise both eyes by backward warping (fixed-point search along the scanline) and mix into red/cyan.
  const FRAG_ANAGLYPH = `#version 300 es
precision highp float;
uniform sampler2D uVid, uDepth;
uniform vec4 uRect; uniform float uShift, uConv, uSwap; uniform int uMode, uSteps;
in vec2 vUv; out vec4 o;
vec3 vid(vec2 uv){ return texture(uVid, clamp((uv-uRect.xy)/(uRect.zw-uRect.xy),0.0,1.0)).rgb; }
vec3 eye(vec2 uv, float sgn){
  vec2 x = uv;
  for(int i=0;i<8;i++){
    if(i>=uSteps) break;
    float d = texture(uDepth, x).r;
    x.x = uv.x - sgn*uShift*(d-uConv);
  }
  return vid(x);
}
const mat3 DL = mat3(0.437,-0.062,-0.048, 0.449,-0.062,-0.050, 0.164,-0.024,-0.017);
const mat3 DR = mat3(-0.011,0.377,-0.026, -0.032,0.761,-0.093, -0.007,0.009,1.234);
void main(){
  bool inside = vUv.x>=uRect.x && vUv.x<=uRect.z && vUv.y>=uRect.y && vUv.y<=uRect.w;
  if(!inside){ o = vec4(0.0); return; }
  vec3 L = eye(vUv, uSwap), R = eye(vUv, -uSwap);
  vec3 c;
  if(uMode==0){ c = DL*L + DR*R; }
  else if(uMode==1){ c = vec3(dot(L,vec3(0.299,0.587,0.114)), R.g, R.b); }
  else { float lL = dot(L,vec3(0.299,0.587,0.114)), lR = dot(R,vec3(0.299,0.587,0.114)); c = vec3(lL, lR, lR); }
  o = vec4(clamp(c,0.0,1.0), 1.0);
}`;

  class Renderer {
    constructor(v) {
      this.video = v;
      this.canvas = document.createElement("canvas");
      this.canvas.setAttribute("data-d3d", "overlay");
      const gl = this.canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, powerPreference: "low-power" });
      if (!gl) throw new Error("no webgl2");
      this.gl = gl;
      this.prog1 = this.program(VERT, FRAG_REFINE);
      this.prog2 = this.program(VERT, FRAG_ANAGLYPH);
      this.vao = gl.createVertexArray();
      this.texVid = this.tex(gl.LINEAR);
      this.texA = this.tex(gl.LINEAR); this.texB = this.tex(gl.LINEAR);
      this.texDepth = this.tex(gl.LINEAR); this.fbo = gl.createFramebuffer();
      this.depthSize = [2, 2]; this.depthT = [0, 0]; this.haveDepth = false; this.shown = false;
      this.mix = 1; this.refW = 0; this.refH = 0; this.drawQueued = false;
      this.gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      this.canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); detach(); });
      this.onFs = () => this.layout(true);
      document.addEventListener("fullscreenchange", this.onFs);
      this.ro = new ResizeObserver(() => this.queueDraw());
      this.ro.observe(v);
      this.onSeek = () => { lastSentMediaTime = -1; this.queueDraw(); };
      v.addEventListener("seeked", this.onSeek); v.addEventListener("pause", this.onSeek);
      v.addEventListener("loadeddata", this.onSeek); v.addEventListener("emptied", this.onSeek);
      this.canvas.style.cssText = "display:none";
    }
    program(vs, fs) {
      const gl = this.gl;
      const mk = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
      const p = gl.createProgram(); gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
      gl.linkProgram(p); if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
      return p;
    }
    tex(filter) {
      const gl = this.gl, t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    }
    setDepth(data, w, h, cut) {
      const gl = this.gl, now = performance.now();
      const t = this.texA; this.texA = this.texB; this.texB = t; // A = previous, B = newest
      gl.bindTexture(gl.TEXTURE_2D, this.texB);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, data);
      if (cut || !this.haveDepth || this.depthSize[0] !== w || this.depthSize[1] !== h) {
        // no cross-fade across a scene cut / size change: make A identical to B
        gl.bindTexture(gl.TEXTURE_2D, this.texA);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, data);
        this.depthT = [now, now];
      } else {
        this.depthT = [this.depthT[1], now];
      }
      this.depthSize = [w, h]; this.haveDepth = true; this.hidden = false;
    }
    hide() { this.hidden = true; this.shown = false; this.canvas.style.display = "none"; }
    queueDraw() {
      if (this.drawQueued || !this.video || !this.video.paused) return;
      this.drawQueued = true;
      requestAnimationFrame(() => { this.drawQueued = false; this.draw(); });
    }
    layout(force) {
      const v = this.video, c = this.canvas, q = QUALITY[settings.quality] || QUALITY.medium;
      const par = v.parentElement;
      if (!par) return false;
      const rect = v.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return false;
      const positioned = getComputedStyle(par).position !== "static" && !document.fullscreenElement;
      const fsEl = document.fullscreenElement;
      const wantParent = positioned ? par : (fsEl && fsEl.contains(v) ? fsEl : document.documentElement);
      const vs = getComputedStyle(v);
      if (positioned) {
        if (c.previousElementSibling !== v) v.after(c);
        c.style.cssText = `position:absolute;left:${v.offsetLeft}px;top:${v.offsetTop}px;width:${v.offsetWidth}px;height:${v.offsetHeight}px;` +
          `pointer-events:none;z-index:${vs.zIndex};transform:${vs.transform};transform-origin:${vs.transformOrigin};display:block;`;
      } else {
        if (c.parentElement !== wantParent) wantParent.appendChild(c);
        c.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;pointer-events:none;z-index:2147483646;display:block;`;
      }
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      let bw = Math.round(rect.width * dpr), bh = Math.round(rect.height * dpr);
      if (bh > q.maxH) { const k = q.maxH / bh; bw = Math.round(bw * k); bh = q.maxH; }
      if (c.width !== bw || c.height !== bh) { c.width = bw; c.height = bh; }
      // where the picture sits inside the element box (object-fit)
      const vw = v.videoWidth, vh = v.videoHeight, W = rect.width, H = rect.height, fit = vs.objectFit;
      let sx = 1, sy = 1;
      if (vw && vh) {
        const s = fit === "cover" ? Math.max(W / vw, H / vh) : fit === "fill" ? 0 : Math.min(W / vw, H / vh);
        if (s) { sx = vw * s / W; sy = vh * s / H; }
      }
      this.rect = [0.5 - sx / 2, 0.5 - sy / 2, 0.5 + sx / 2, 0.5 + sy / 2];
      return true;
    }
    draw() {
      if (!this.haveDepth || this.hidden || this.video.readyState < 2) return;
      if (!this.layout()) return;
      const gl = this.gl, c = this.canvas, q = QUALITY[settings.quality] || QUALITY.medium;
      // video frame -> texture
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.texVid);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.video); }
      catch (_) { return markBlocked(this.video, "unreadable"); }
      // cross-fade between the two latest depth maps
      const span = Math.max(this.depthT[1] - this.depthT[0], 16);
      this.mix = Math.min(1, Math.max(0, (performance.now() - this.depthT[1]) / span));
      gl.bindVertexArray(this.vao);
      gl.disable(gl.BLEND);

      // pass 1 -> half-resolution refined depth
      const rw = Math.max(2, c.width >> 1), rh = Math.max(2, c.height >> 1);
      if (rw !== this.refW || rh !== this.refH) {
        gl.bindTexture(gl.TEXTURE_2D, this.texDepth);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, rw, rh, 0, gl.RED, gl.UNSIGNED_BYTE, null);
        this.refW = rw; this.refH = rh;
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texDepth, 0);
      gl.viewport(0, 0, rw, rh);
      gl.useProgram(this.prog1);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.texA);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.texB);
      this.u1(this.prog1, { uVid: 0, uDA: 1, uDB: 2 });
      gl.uniform1f(gl.getUniformLocation(this.prog1, "uMix"), this.mix);
      gl.uniform4fv(gl.getUniformLocation(this.prog1, "uRect"), this.rect);
      gl.uniform2fv(gl.getUniformLocation(this.prog1, "uDepthSize"), this.depthSize);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      // pass 2 -> screen
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, c.width, c.height);
      gl.useProgram(this.prog2);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.texDepth);
      this.u1(this.prog2, { uVid: 0, uDepth: 1 });
      const modeIdx = settings.mode === "half" ? 1 : settings.mode === "gray" ? 2 : 0;
      const rectW = this.rect[2] - this.rect[0];
      gl.uniform4fv(gl.getUniformLocation(this.prog2, "uRect"), this.rect);
      gl.uniform1f(gl.getUniformLocation(this.prog2, "uShift"), (settings.strength / 100) * rectW * 0.5);
      gl.uniform1f(gl.getUniformLocation(this.prog2, "uConv"), settings.convergence);
      gl.uniform1f(gl.getUniformLocation(this.prog2, "uSwap"), settings.swapEyes ? -1 : 1);
      gl.uniform1i(gl.getUniformLocation(this.prog2, "uMode"), modeIdx);
      gl.uniform1i(gl.getUniformLocation(this.prog2, "uSteps"), q.steps);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      this.shown = true;
    }
    u1(prog, map) { for (const k in map) this.gl.uniform1i(this.gl.getUniformLocation(prog, k), map[k]); }
    destroy() {
      document.removeEventListener("fullscreenchange", this.onFs);
      this.ro.disconnect();
      const v = this.video;
      v.removeEventListener("seeked", this.onSeek); v.removeEventListener("pause", this.onSeek);
      v.removeEventListener("loadeddata", this.onSeek); v.removeEventListener("emptied", this.onSeek);
      this.canvas.remove();
      const ext = this.gl.getExtension("WEBGL_lose_context"); if (ext) ext.loseContext();
    }
  }
})();

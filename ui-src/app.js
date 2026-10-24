// The Terrarium page: terrain (WebGL), the ecosystem (a small simulation on a 2D canvas) and the HUD. genesis.mjs is
// inlined above this file by scripts/build.mjs, so makeWorld, describeWorld, rng, hashString and clamp01 are in scope.

const $ = (id) => document.getElementById(id);
const TAU = Math.PI * 2;
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const store = {
  get(k, d) { try { const v = localStorage.getItem(`terrarium:${k}`); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`terrarium:${k}`, JSON.stringify(v)); } catch { /* sandboxed frames have no storage */ } },
};

// ---------- bridge (docs/plugin-sdk.md in Agent Control, "Pages") ----------
const embedded = window.parent !== window;
const bridge = (() => {
  const pending = new Map(); let seq = 0; let workspaceId = null;
  const listeners = [];
  addEventListener("message", (e) => {
    if (e.source !== parent || !e.data || typeof e.data !== "object") return;
    const m = e.data;
    if (m.type === "agent-control:init") {
      workspaceId = m.workspaceId ?? null;
      const vars = m.theme?.vars ?? {};
      for (const k of ["--accent", "--radius"]) if (vars[k]) document.documentElement.style.setProperty(k, vars[k]);
      if (m.theme?.font) document.documentElement.style.setProperty("--font", m.theme.font);
      document.documentElement.dataset.mode = m.theme?.mode === "light" ? "light" : "dark";
      for (const f of listeners) f(m);
    }
    if (m.type === "agent-control:response") {
      const p = pending.get(m.id); pending.delete(m.id);
      if (p) { clearTimeout(p.timer); m.ok ? p.resolve(m.data) : p.reject(new Error(m.error || `HTTP ${m.status}`)); }
    }
  });
  const post = (msg) => { if (embedded) parent.postMessage(msg, "*"); };
  return {
    onInit: (f) => listeners.push(f),
    get workspaceId() { return workspaceId; },
    call: (method, path, body) => new Promise((resolve, reject) => {
      if (!embedded) return reject(new Error("not embedded"));
      const id = ++seq;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("The dashboard did not answer")); }, 10000);
      pending.set(id, { resolve, reject, timer });
      post({ type: "agent-control:request", id, method, path, body });
    }),
    ready: () => post({ type: "agent-control:ready" }),
    resize: (height) => post({ type: "agent-control:resize", height }),
    navigate: (href) => post({ type: "agent-control:navigate", href }),
    toast: (message) => post({ type: "agent-control:toast", message }),
  };
})();

// ---------- noise ----------
function makeNoise(seed) {
  const r = rng(seed);
  const perm = r.shuffle([...Array(256).keys()]);
  const p = new Uint8Array(512);
  for (let i = 0; i < 512; i++) p[i] = perm[i & 255];
  const G = [[1, 1], [-1, 1], [1, -1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]];
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi, X = xi & 255, Y = yi & 255;
    const g = (h, dx, dy) => { const v = G[h & 7]; return v[0] * dx + v[1] * dy; };
    const aa = p[p[X] + Y], ab = p[p[X] + Y + 1], ba = p[p[X + 1] + Y], bb = p[p[X + 1] + Y + 1];
    const u = fade(xf), v = fade(yf);
    return lerp(lerp(g(aa, xf, yf), g(ba, xf - 1, yf), u), lerp(g(ab, xf, yf - 1), g(bb, xf - 1, yf - 1), u), v);
  };
}
function fbm(n, x, y, oct) {
  let s = 0, a = 0.5, f = 1, norm = 0;
  for (let i = 0; i < oct; i++) { s += a * n(x * f, y * f); norm += a; a *= 0.5; f *= 2.03; }
  return s / norm;
}

// ---------- terrain ----------
/** The shape of the land only depends on the seed and the aspect ratio; climate is applied on top by `climate()`. */
function buildTerrain(seed, aspect) {
  const W = 384, H = Math.max(96, Math.min(384, Math.round(W / aspect)));
  const nh = makeNoise(`${seed}|h`), nq = makeNoise(`${seed}|q`), nm = makeNoise(`${seed}|m`), nt = makeNoise(`${seed}|t`);
  const height = new Float32Array(W * H), moist = new Float32Array(W * H), tnoise = new Float32Array(W * H);
  const sc = 2.6;
  let lo = Infinity, hi = -Infinity;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const px = (x / W) * aspect * sc, py = (y / H) * sc;
    const qx = fbm(nq, px, py, 4), qy = fbm(nq, px + 5.2, py + 1.3, 4);
    const h = fbm(nh, px + 1.4 * qx, py + 1.4 * qy, 6);
    const i = y * W + x;
    height[i] = h; moist[i] = fbm(nm, px * 1.3 + 3.1, py * 1.3 - 7.7, 4); tnoise[i] = fbm(nt, px * 0.7, py * 0.7, 3);
    if (h < lo) lo = h; if (h > hi) hi = h;
  }
  for (let i = 0; i < height.length; i++) height[i] = (height[i] - lo) / (hi - lo || 1);
  const sorted = Float32Array.from(height).sort();
  return { W, H, aspect, height, moist, tnoise, sorted, temp: new Float32Array(W * H), fert: new Float32Array(W * H), wet: new Float32Array(W * H), sea: 0.5, tex: new Uint8Array(W * H * 4) };
}
/** Sea level, temperature, moisture and fertility for the current heat, water and life. */
function climate(T, p) {
  const n = T.sorted.length;
  T.sea = T.sorted[Math.max(0, Math.min(n - 1, Math.floor((0.03 + p.water * 0.9) * n)))];
  const { W, H, height, moist, tnoise, temp, fert, wet, tex, sea } = T;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, h = height[i];
    const land = h >= sea, e = land ? (h - sea) / (1 - sea || 1) : 0;
    const m = Math.max(0, Math.min(1, 0.5 + 0.55 * moist[i] + (land ? 0.42 * (1 - smooth(0, 0.22, e)) - 0.15 : 0.3)));
    const lat = 1 - Math.abs(y / H - 0.5) * 2;
    const t = Math.max(0, Math.min(1, 0.04 + p.heat * 0.9 + 0.4 * tnoise[i] - 0.42 * e + 0.12 * lat - 0.06));
    const f = land ? m * Math.max(0, 1 - Math.abs(t - 0.55) * 1.35) * (1 - e * 0.75) : (sea - h) / (sea || 1) < 0.3 ? 0.3 : 0.02;
    temp[i] = t; wet[i] = m; fert[i] = f;
    tex[i * 4] = Math.round(h * 255); tex[i * 4 + 1] = Math.round(m * 255); tex[i * 4 + 2] = Math.round(t * 255); tex[i * 4 + 3] = Math.round(Math.max(0, Math.min(1, f)) * 255);
  }
}

// ---------- WebGL terrain ----------
const VERT = `attribute vec2 p; varying vec2 vUv; void main(){ vUv = vec2(p.x*0.5+0.5, 0.5-p.y*0.5); gl_Position = vec4(p,0.0,1.0); }`;
const FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 vUv;
uniform sampler2D uMap; uniform vec2 uTexel;
uniform float uAspect, uTime, uSea, uWeird, uLife, uDay, uMotion, uFade;
uniform vec3 uPa, uPb, uPc, uPd; uniform vec4 uWave;
vec3 pal(float t){ return uPa + uPb*cos(6.28318*(uPc*t + uPd)); }
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
float vnoise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(hash(i),hash(i+vec2(1.0,0.0)),f.x), mix(hash(i+vec2(0.0,1.0)),hash(i+vec2(1.0,1.0)),f.x), f.y); }
void main(){
  float t = uTime*uMotion, w = uWeird*uWeird;
  vec2 uv = vUv, q = vec2(uv.x*uAspect, uv.y);
  vec2 warp = vec2(vnoise(q*5.0+vec2(t*0.07,0.0)), vnoise(q*5.0+vec2(9.0,-t*0.05))) - 0.5;
  uv += warp*(0.002 + 0.02*w)*uMotion;
  if (uWeird > 0.8) { vec2 c = uv-0.5; c.x *= uAspect; float r = length(c); float a = atan(c.y,c.x) + (uWeird-0.8)*2.2*sin(r*9.0 - t*0.3)*uMotion; c = r*vec2(cos(a),sin(a)); c.x /= uAspect; uv = 0.5 + c; }
  vec4 m = texture2D(uMap, uv);
  float h = m.r, moist = m.g, temp = m.b, fert = m.a;
  float hx = texture2D(uMap, uv+vec2(uTexel.x,0.0)).r - texture2D(uMap, uv-vec2(uTexel.x,0.0)).r;
  float hy = texture2D(uMap, uv+vec2(0.0,uTexel.y)).r - texture2D(uMap, uv-vec2(0.0,uTexel.y)).r;
  float night = 1.0 - uDay;
  vec3 col;
  if (h < uSea) {
    float d = clamp((uSea-h)/max(uSea,0.001), 0.0, 1.0);
    vec3 shallow = mix(vec3(0.14,0.5,0.62), vec3(0.28,0.78,0.7), temp);
    shallow = mix(shallow, vec3(0.72,0.88,0.95), smoothstep(0.2,0.02,temp)*0.8);
    vec3 deep = mix(vec3(0.02,0.06,0.2), vec3(0.03,0.12,0.24), temp);
    col = mix(shallow, deep, smoothstep(0.0,0.55,d));
    float c = sin(q.x*70.0 + t*1.2 + sin(q.y*31.0 + t*0.8)*1.5) * sin(q.y*64.0 - t*1.0 + sin(q.x*27.0 - t*0.6)*1.5);
    float caustic = smoothstep(0.55, 1.0, c) * (1.0-d);
    col += caustic*(0.06 + 0.12*w);
    col += night*caustic*vec3(0.1,0.65,0.75)*0.7;
    float foam = smoothstep(0.02, 0.0, uSea-h) * (0.55+0.45*sin(t*2.0 + (q.x+q.y)*60.0));
    col += foam*0.24;
    col = mix(col, pal(d*1.3 + moist*0.6 + t*0.025)*0.85, 0.62*w);
  } else {
    float e = clamp((h-uSea)/max(1.0-uSea,0.001), 0.0, 1.0);
    vec3 sand=vec3(0.84,0.76,0.55), grass=vec3(0.36,0.6,0.27), forest=vec3(0.13,0.36,0.2), desert=vec3(0.88,0.58,0.32), tundra=vec3(0.7,0.76,0.74), rock=vec3(0.44,0.4,0.38), snow=vec3(0.95,0.97,1.0), jungle=vec3(0.09,0.42,0.24), ash=vec3(0.34,0.22,0.18);
    vec3 cold = mix(snow*0.93, tundra, smoothstep(0.08,0.3,temp));
    vec3 mild = mix(mix(sand*0.95, grass, smoothstep(0.25,0.5,moist)), forest, smoothstep(0.6,0.9,moist));
    vec3 hot = mix(mix(ash, desert, smoothstep(0.0,0.35,moist+0.15)), jungle, smoothstep(0.55,0.9,moist));
    vec3 low = temp < 0.35 ? mix(cold, mild, smoothstep(0.22,0.35,temp)) : mix(mild, hot, smoothstep(0.58,0.88,temp));
    low = mix(sand, low, smoothstep(0.0,0.05,e));
    vec3 hi = mix(rock, snow, smoothstep(0.55,0.85, e + (0.45-temp)*0.7));
    col = mix(low, hi, smoothstep(0.5,0.9,e));
    col *= 0.86 + 0.3*fert*uLife;
    float shade = clamp(1.0 + (hx - hy)*9.0, 0.55, 1.45);
    col *= shade;
    col = mix(col, pal(e*2.2 + moist*0.8 + t*0.02)*shade, 0.06 + 0.74*w);
    float lines = abs(fract(e*12.0 - t*0.06*uWeird) - 0.5);
    col += smoothstep(0.07, 0.0, lines) * (0.025 + 0.42*w) * pal(e + 0.35 + t*0.05);
  }
  float wd = distance(q, vec2(uWave.x*uAspect, uWave.y));
  float k = (wd - uWave.z*0.22)*16.0;
  float ring = exp(-k*k) * uWave.w * exp(-uWave.z*0.35);
  col = mix(col, pal(wd*4.0 + t*0.2) + 0.15, clamp(ring,0.0,1.0)*0.8);
  col = mix(col*vec3(0.26,0.28,0.48) + vec3(0.0,0.006,0.03), col, uDay);
  vec2 v = vUv - 0.5; col *= 1.0 - dot(v,v)*0.85;
  col += (hash(vUv*vec2(1013.0,717.0) + fract(t*0.37)) - 0.5)*0.03;
  gl_FragColor = vec4(col*uFade, 1.0);
}`;

function makeGL(canvas) {
  const gl = canvas.getContext("webgl", { antialias: false, alpha: false, preserveDrawingBuffer: true });
  if (!gl) return null;
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG)); gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  gl.useProgram(prog);
  const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "p"); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
  for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
  const U = {}; for (const n of ["uMap", "uTexel", "uAspect", "uTime", "uSea", "uWeird", "uLife", "uDay", "uMotion", "uFade", "uPa", "uPb", "uPc", "uPd", "uWave"]) U[n] = gl.getUniformLocation(prog, n);
  gl.uniform1i(U.uMap, 0);
  return {
    upload(T) { gl.bindTexture(gl.TEXTURE_2D, tex); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, T.W, T.H, 0, gl.RGBA, gl.UNSIGNED_BYTE, T.tex); gl.uniform2f(U.uTexel, 1 / T.W, 1 / T.H); },
    draw(u) {
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform1f(U.uAspect, u.aspect); gl.uniform1f(U.uTime, u.time); gl.uniform1f(U.uSea, u.sea); gl.uniform1f(U.uWeird, u.weird);
      gl.uniform1f(U.uLife, u.life); gl.uniform1f(U.uDay, u.day); gl.uniform1f(U.uMotion, u.motion); gl.uniform1f(U.uFade, u.fade);
      gl.uniform3fv(U.uPa, u.pal.a); gl.uniform3fv(U.uPb, u.pal.b); gl.uniform3fv(U.uPc, u.pal.c); gl.uniform3fv(U.uPd, u.pal.d);
      gl.uniform4f(U.uWave, u.wave[0], u.wave[1], u.wave[2], u.wave[3]);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}

// ---------- state ----------
const S = {
  source: "pulse", seed: "", params: { heat: 0.5, water: 0.5, life: 0.6, weird: 0.4, species: 5 }, target: null,
  world: null, terrain: null, creatures: [], flora: [], particles: [], spirits: new Map(),
  time: 0, paused: false, focus: null, hover: null, wave: [0.5, 0.5, 99, 0], nextWave: 12, fade: 0,
  history: [], sampleAt: 0, extinctSince: new Map(), born: 0, died: 0, maxGen: 1, pulse: null, worlds: [], drift: store.get("drift", false), driftAt: 0,
  dpr: Math.min(1.75, devicePixelRatio || 1), slow: 0, lastPulseAt: 0, ready: false,
};
const glCanvas = $("gl"), trails = $("trails"), fx = $("fx");
const tctx = trails.getContext("2d"), ctx = fx.getContext("2d");
let GL = null;
try { GL = makeGL(glCanvas); } catch (e) { console.warn("Terrarium: WebGL failed", e); }
if (!GL) $("nogl").style.display = "grid";
glCanvas.addEventListener("webglcontextlost", (e) => e.preventDefault());
glCanvas.addEventListener("webglcontextrestored", () => { try { GL = makeGL(glCanvas); if (S.terrain) GL?.upload(S.terrain); } catch (e) { console.warn("Terrarium: WebGL did not come back", e); } });

let VW = innerWidth, VH = innerHeight, A = VW / VH, SC = VH * S.dpr, labelFont = "system-ui";
function resize() {
  labelFont = getComputedStyle(document.body).fontFamily || "system-ui";
  VW = innerWidth; VH = Math.max(1, innerHeight); const newA = VW / VH;
  for (const c of [glCanvas, trails, fx]) { c.width = Math.round(VW * S.dpr); c.height = Math.round(VH * S.dpr); }
  SC = fx.height;
  if (S.terrain && Math.abs(newA - S.terrain.aspect) / S.terrain.aspect > 0.25) { A = newA; rebuildTerrain(); }
  else A = newA;
  for (const c of S.creatures) c.x = Math.min(c.x, A - 0.01);
}
addEventListener("resize", () => { clearTimeout(resize.t); resize.t = setTimeout(resize, 120); });

// ---------- terrain queries (world units: x in 0..A, y in 0..1) ----------
const cell = (x, y) => { const T = S.terrain; const ix = Math.max(0, Math.min(T.W - 1, Math.floor((x / A) * T.W))), iy = Math.max(0, Math.min(T.H - 1, Math.floor(y * T.H))); return iy * T.W + ix; };
const isLand = (x, y) => S.terrain.height[cell(x, y)] >= S.terrain.sea;
const habitable = (hab, x, y) => (x < 0.004 || y < 0.004 || x > A - 0.004 || y > 0.996 ? false : hab === "air" ? true : hab === "land" ? isLand(x, y) : !isLand(x, y));
function spot(hab, tries = 60, want = null) {
  for (let i = 0; i < tries; i++) {
    const x = 0.02 + Math.random() * (A - 0.04), y = 0.02 + Math.random() * 0.96;
    if (habitable(hab, x, y) && (!want || want(x, y))) return { x, y };
  }
  return null;
}

// ---------- spatial hash ----------
const CELL = 0.07;
function grid(items) {
  const g = new Map();
  for (const it of items) { if (it.dead) continue; const k = Math.floor(it.x / CELL) * 1024 + Math.floor(it.y / CELL); let b = g.get(k); if (!b) g.set(k, (b = [])); b.push(it); }
  return g;
}
function near(g, x, y, r, fn) {
  const x0 = Math.floor((x - r) / CELL), x1 = Math.floor((x + r) / CELL), y0 = Math.floor((y - r) / CELL), y1 = Math.floor((y + r) / CELL);
  for (let gx = x0; gx <= x1; gx++) for (let gy = y0; gy <= y1; gy++) { const b = g.get(gx * 1024 + gy); if (b) for (const it of b) fn(it); }
}
function nearest(g, x, y, r, ok) {
  let best = null, bd = r * r;
  near(g, x, y, r, (it) => { if (it.dead || !ok(it)) return; const d = (it.x - x) ** 2 + (it.y - y) ** 2; if (d < bd) { bd = d; best = it; } });
  return best ? { it: best, d: Math.sqrt(bd) } : null;
}

// ---------- chronicle ----------
function chronicle(text) {
  const box = $("chronicle");
  const el = document.createElement("div"); el.textContent = text; box.append(el);
  while (box.children.length > 4) box.firstChild.remove();
  setTimeout(() => { el.style.opacity = "0"; setTimeout(() => el.remove(), 1300); }, 9000);
}

// ---------- worlds ----------
const species = () => S.world?.species ?? [];
const spOf = (id) => S.world.species[id];
const signature = (sp) => `${sp.name}|${sp.plan}|${sp.habitat}`;

function rebuildTerrain() {
  S.terrain = buildTerrain(S.seed, A);
  climate(S.terrain, S.params);
  GL?.upload(S.terrain);
}

/** A new world from scratch: new land, new flora, new species. */
function genesis(seed, params, why) {
  const stage = $("stage");
  const go = () => {
    S.seed = seed; S.params = { ...params };
    S.world = makeWorld({ seed, ...params });
    rebuildTerrain();
    S.creatures = []; S.flora = []; S.particles = []; S.history = []; S.extinctSince.clear(); S.focus = null; S.born = 0; S.died = 0; S.maxGen = 1;
    tctx.clearRect(0, 0, trails.width, trails.height);
    seedFlora(floraTarget());
    for (const sp of S.world.species) for (let i = 0; i < startCount(sp); i++) spawn(sp);
    for (const s of S.spirits.values()) Object.assign(s, spot("air"));
    S.fade = 0;
    renderHud(true);
    if (why) chronicle(why);
  };
  if (!S.ready || reduced) { go(); S.ready = true; return; }
  stage.classList.add("warp");
  setTimeout(() => { go(); stage.classList.remove("warp"); }, 420);
}

/**
 * Same seed, new parameters: the land stays, the climate changes, species that still exist keep living, species that
 * no longer fit fade out and newcomers migrate in.
 */
function reshape(params) {
  const before = S.world;
  S.params = { ...params };
  const next = makeWorld({ seed: S.seed, ...params });
  const keep = new Map();
  for (const sp of next.species) { const old = before.species.find((o) => signature(o) === signature(sp)); if (old) keep.set(old.id, sp); }
  for (const c of S.creatures) {
    const sp = keep.get(c.sp.id);
    if (sp) { c.hue += sp.hue - c.sp.hue; c.sp = sp; } else if (!c.dead) die(c, "fade");
  }
  S.world = next;
  for (const sp of next.species) if (![...keep.values()].includes(sp)) { for (let i = 0; i < Math.ceil(startCount(sp) / 2); i++) spawn(sp); chronicle(`${sp.name} migrated in: ${sp.title}`); }
  const kinds = next.flora;
  for (const f of S.flora) if (!kinds.find((k) => k.kind === f.kind)) { const alt = kinds.filter((k) => k.where === f.where); if (alt.length) { const k = alt[Math.floor(Math.random() * alt.length)]; f.kind = k.kind; f.hue = k.hue; } else f.dead = true; }
  for (const f of S.flora) { const k = kinds.find((x) => x.kind === f.kind); if (k) f.hue = k.hue; }
  climate(S.terrain, S.params);
  GL?.upload(S.terrain);
  const changed = next.species.length !== before.species.length || next.species.some((sp, i) => signature(sp) !== signature(before.species[i]));
  renderHud(changed);
}

function setParams(params, { seed = S.seed, why } = {}) {
  const p = { ...S.params, ...params };
  if (!S.world || seed !== S.seed) return genesis(seed, p, why);
  const same = ["heat", "water", "life", "weird"].every((k) => Math.abs(p[k] - S.params[k]) < 0.002) && p.species === S.params.species;
  if (!same) reshape(p);
}

// ---------- flora ----------
const floraTarget = () => Math.round((70 + 380 * S.params.life) * Math.min(1.6, A / 1.8));
function seedFlora(n) {
  const kinds = S.world.flora;
  for (let i = 0; i < n; i++) {
    let s = null;
    for (let tries = 0; tries < 10 && !s; tries++) {
      const x = 0.01 + Math.random() * (A - 0.02), y = 0.01 + Math.random() * 0.98;
      if (Math.random() < S.terrain.fert[cell(x, y)] * 1.25) s = { x, y };
    }
    if (!s) continue;
    const land = isLand(s.x, s.y);
    const pool = kinds.filter((k) => (k.where === "land") === land);
    if (!pool.length) continue;
    addFlora(s.x, s.y, pool[Math.floor(Math.random() * pool.length)], Math.random() * 0.8 + 0.2);
  }
}
function addFlora(x, y, kind, e = 0.15) {
  if (S.flora.length > 900) return;
  S.flora.push({ x, y, kind: kind.kind, hue: kind.hue + (Math.random() - 0.5) * 24, e, phase: Math.random() * TAU, size: 0.7 + Math.random() * 0.6, flip: Math.random() < 0.5 ? -1 : 1 });
}

// ---------- creatures ----------
function startCount(sp) {
  const life = S.params.life, area = Math.min(1.5, A / 1.8);
  const base = sp.trophic === 1 ? 9 + 16 * life : sp.trophic === 2 ? 3 + 4 * life : 2 + 1.5 * life;
  return Math.max(2, Math.round(base * area));
}
const capFor = (sp) => Math.round((sp.trophic === 1 ? 46 : sp.trophic === 2 ? 16 : 7) * (0.6 + 0.7 * S.params.life) * Math.min(1.5, A / 1.8));
function spawn(sp, at = null, parent = null) {
  const pos = at ?? spot(sp.habitat);
  if (!pos || S.creatures.length > 340) return null;
  const c = {
    sp, x: pos.x, y: pos.y, px: pos.x, py: pos.y, ang: Math.random() * TAU, wobble: 0, energy: parent ? 0.5 : 0.55 + Math.random() * 0.4,
    age: parent ? 0 : Math.random() * sp.lifespan * 0.5, life: sp.lifespan * (0.75 + Math.random() * 0.5), size: sp.size * (parent ? 0.55 : 0.85 + Math.random() * 0.3),
    hue: (parent ? parent.hue : sp.hue) + (parent ? (Math.random() - 0.5) * (6 + 30 * S.params.weird) : (Math.random() - 0.5) * 14),
    phase: Math.random() * TAU, gen: parent ? parent.gen + 1 : 1, turn: Math.random() < 0.5 ? 1 : -1, roll: 0, dead: false, mode: "",
    segs: sp.plan === "serpent" ? Array.from({ length: 8 }, () => ({ x: pos.x, y: pos.y })) : null,
  };
  S.creatures.push(c);
  if (parent) { S.born++; S.maxGen = Math.max(S.maxGen, c.gen); }
  return c;
}
function burst(x, y, hue, n, speed = 0.12, life = 1.2, kind = "spark") {
  for (let i = 0; i < n && S.particles.length < 1600; i++) {
    const a = Math.random() * TAU, v = speed * (0.3 + Math.random());
    S.particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, t: 0, life: life * (0.6 + Math.random() * 0.8), hue: hue + (Math.random() - 0.5) * 40, size: 0.6 + Math.random() * 1.4, kind });
  }
}
function die(c, how) {
  c.dead = true; S.died++;
  burst(c.x, c.y, c.hue, how === "eaten" ? 18 : 10, how === "eaten" ? 0.18 : 0.08, how === "fade" ? 0.8 : 1.3);
  if (how !== "eaten" && isLand(c.x, c.y) && Math.random() < 0.5) {
    const kinds = S.world.flora.filter((k) => k.where === "land");
    if (kinds.length) addFlora(c.x, c.y, kinds[Math.floor(Math.random() * kinds.length)], 0.3);
  }
}

function step(dt) {
  const W = S.world, P = S.params, day = dayLight();
  const cg = grid(S.creatures), fg = grid(S.flora);
  const pop = new Array(W.species.length).fill(0);
  for (const c of S.creatures) if (!c.dead) pop[c.sp.id]++;
  const caps = W.species.map(capFor);

  for (const c of S.creatures) {
    if (c.dead) continue;
    const sp = c.sp;
    c.age += dt; c.px = c.x; c.py = c.y;
    const sense = 0.1 + sp.size * 5;
    c.wobble += (Math.random() - 0.5) * dt * 6; c.wobble *= 0.96;
    let sx = Math.cos(c.ang + c.wobble * 0.6), sy = Math.sin(c.ang + c.wobble * 0.6), boost = 1;
    c.mode = "";

    if (sp.eatenBy.length) {
      const f = nearest(cg, c.x, c.y, sense * 0.9, (o) => sp.eatenBy.includes(o.sp.id));
      if (f) { sx += ((c.x - f.it.x) / (f.d || 1)) * 3; sy += ((c.y - f.it.y) / (f.d || 1)) * 3; boost = 1.55; c.mode = "flee"; }
    }
    if (c.rest > 0) c.rest -= dt;
    if (!c.mode && (sp.diet === "flora" ? c.energy < 1.45 : c.energy < 1 && !(c.rest > 0))) {
      if (sp.diet === "flora") {
        const f = nearest(fg, c.x, c.y, sense * 1.3, (o) => o.e > 0.22 && (sp.floraKinds ?? []).includes(o.kind));
        if (f) {
          sx += ((f.it.x - c.x) / (f.d || 1)) * 2; sy += ((f.it.y - c.y) / (f.d || 1)) * 2; c.mode = "graze";
          if (f.d < c.size * 1.4 + 0.008) { const bite = Math.min(f.it.e, dt * 0.9); f.it.e -= bite; c.energy += bite * 0.75; boost = 0.15; }
        }
      } else if (sp.diet === "meat") {
        const f = nearest(cg, c.x, c.y, sense * 1.15, (o) => sp.eats.includes(o.sp.id));
        if (f) {
          sx += ((f.it.x - c.x) / (f.d || 1)) * 2.4; sy += ((f.it.y - c.y) / (f.d || 1)) * 2.4; boost = 1.45; c.mode = "hunt";
          if (f.d < c.size + f.it.size) { die(f.it, "eaten"); c.energy += 0.5; c.rest = 5 + Math.random() * 6; chronicleMaybe(`${sp.name} caught a ${f.it.sp.name}`, 0.05); }
        }
      }
    }
    if (sp.diet === "light") c.energy += dt * 0.038 * (0.35 + 0.85 * day) * (0.55 + 0.8 * P.life);
    if (sp.diet === "filter" && !isLand(c.x, c.y)) c.energy += dt * 0.04 * (0.6 + 0.7 * P.life);

    if (sp.social) {
      let ax = 0, ay = 0, cx = 0, cy = 0, n = 0;
      near(cg, c.x, c.y, 0.06, (o) => { if (o === c || o.sp !== sp || o.dead) return; ax += Math.cos(o.ang); ay += Math.sin(o.ang); cx += o.x; cy += o.y; n++; });
      if (n) { sx += (ax / n) * 0.5 + (cx / n - c.x) * 6; sy += (ay / n) * 0.5 + (cy / n - c.y) * 6; }
    }
    if (c.x < 0.04) sx += 2; if (c.x > A - 0.04) sx -= 2; if (c.y < 0.04) sy += 2; if (c.y > 0.96) sy -= 2;

    const want = Math.atan2(sy, sx);
    let dA = ((want - c.ang + Math.PI * 3) % TAU) - Math.PI;
    c.ang += Math.max(-1, Math.min(1, dA)) * dt * 4.2;
    let speed = sp.speed * boost * (0.75 + 0.5 * P.life * 0.5);
    if (sp.plan === "jelly") speed *= 0.25 + 0.95 * Math.max(0, Math.sin(c.phase * 0.9));
    const look = 0.018 + c.size;
    if (sp.habitat !== "air" && !habitable(sp.habitat, c.x + Math.cos(c.ang) * look, c.y + Math.sin(c.ang) * look)) c.ang += c.turn * dt * 7;
    const nx = c.x + Math.cos(c.ang) * speed * dt, ny = c.y + Math.sin(c.ang) * speed * dt;
    if (habitable(sp.habitat, nx, ny)) { c.x = nx; c.y = ny; }
    else if (!habitable(sp.habitat, c.x, c.y)) { c.x = nx; c.y = ny; c.energy -= dt * 0.08; } // stranded: keep moving, it hurts
    else { c.ang += c.turn * (1.2 + Math.random()); }
    c.phase += dt * (3 + speed * 60);
    c.roll += speed * dt / Math.max(0.004, c.size);
    if (c.segs) {
      let hx = c.x, hy = c.y; const gap = c.size * 0.95;
      for (const s of c.segs) { const dx = s.x - hx, dy = s.y - hy, d = Math.hypot(dx, dy) || 1; if (d > gap) { s.x = hx + (dx / d) * gap; s.y = hy + (dy / d) * gap; } hx = s.x; hy = s.y; }
    }

    c.energy -= dt * (0.017 + sp.size * 0.7 + speed * 0.06) * (sp.trophic > 1 ? 0.8 : 1);
    if (c.energy > 1.3 && c.age > 7 && pop[sp.id] < caps[sp.id]) {
      c.energy -= 0.62; pop[sp.id]++;
      const kid = spawn(sp, { x: c.x + (Math.random() - 0.5) * 0.01, y: c.y + (Math.random() - 0.5) * 0.01 }, c);
      if (kid) { burst(c.x, c.y, c.hue + 60, 5, 0.04, 0.7, "heart"); if (kid.gen % 5 === 0) chronicleMaybe(`A ${sp.name} of generation ${kid.gen} hatched`, 0.6); }
    }
    if (c.energy <= 0 || c.age > c.life) die(c, c.energy <= 0 ? "hunger" : "age");
  }
  S.creatures = S.creatures.filter((c) => !c.dead);

  // Flora regrows faster in the light, where it is fertile and near the spirits of busy agents.
  const regrow = dt * 0.05 * (0.3 + P.life) * (0.5 + 0.6 * day);
  for (const f of S.flora) f.e = Math.min(1, f.e + regrow * (f.boost ?? 1)), f.boost = 1;
  if (S.flora.length < floraTarget() && Math.random() < dt * 6) seedFlora(1);
  if (Math.random() < dt * 0.5) for (const f of S.flora) { if ((f.kind === "kelp") === isLand(f.x, f.y)) f.dead = true; }
  S.flora = S.flora.filter((f) => !f.dead);

  // Extinction is not forever: after a while, migrants arrive.
  for (const sp of W.species) {
    if (pop[sp.id] > 0) { S.extinctSince.delete(sp.id); continue; }
    if (!S.extinctSince.has(sp.id)) { S.extinctSince.set(sp.id, S.time); if (S.history.length > 5) chronicle(`The last ${sp.name} is gone. Extinct, for now.`); }
    else if (S.time - S.extinctSince.get(sp.id) > 14) { for (let i = 0; i < 3; i++) spawn(sp); S.extinctSince.delete(sp.id); chronicle(`Migrants: ${sp.name} returned to the ${W.name.split(" of ")[0].replace(/^The \S+ /, "").toLowerCase()}`); }
  }

  stepSpirits(dt, fg);
  for (const p of S.particles) { p.t += dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.97; p.vy *= 0.97; if (p.kind === "rise") p.vy -= dt * 0.05; }
  S.particles = S.particles.filter((p) => p.t < p.life);

  // Colour waves roll over weird worlds now and then.
  S.wave[2] += dt;
  if ((S.nextWave -= dt) < 0) {
    S.nextWave = 18 + Math.random() * 40 * (1.2 - P.weird);
    if (P.weird > 0.3 && !reduced) { S.wave = [Math.random(), Math.random(), 0, 0.3 + 0.7 * P.weird]; chronicleMaybe("A colour wave rolls over the land", 0.5); }
  }
  if (S.time - S.sampleAt > 1) {
    S.sampleAt = S.time;
    S.history.push(W.species.map((sp) => pop[sp.id]));
    if (S.history.length > 160) S.history.shift();
  }
}
let lastChron = 0;
function chronicleMaybe(text, p) { if (S.time - lastChron > 6 && Math.random() < p) { lastChron = S.time; chronicle(text); } }

// ---------- spirits (tasks of the workspace) ----------
const SPIRIT = {
  running: { hue: 186, label: "running" },
  awaiting_input: { hue: 40, label: "waiting for you" },
  review: { hue: 282, label: "ready for review" },
  merging: { hue: 140, label: "merging" },
};
function syncSpirits(list, recent) {
  const seen = new Set();
  for (const t of list) {
    seen.add(t.id);
    const s = S.spirits.get(t.id);
    if (s) { if (s.status !== t.status) { s.status = t.status; burst(s.x, s.y, SPIRIT[t.status]?.hue ?? 200, 12, 0.06, 0.9); } s.code = t.code; continue; }
    const p = spot("air") ?? { x: A / 2, y: 0.5 };
    S.spirits.set(t.id, { id: t.id, code: t.code || "task", status: t.status, x: p.x, y: p.y, ang: Math.random() * TAU, trail: [], born: S.time });
    if (S.ready) chronicle(`${t.code || "A task"} drifted in (${SPIRIT[t.status]?.label ?? t.status})`);
  }
  for (const [id, s] of S.spirits) {
    if (seen.has(id)) continue;
    const r = recent.find((x) => x.id === id);
    if (r?.status === "done") ascend(s); else if (r?.status === "failed") crumble(s); else burst(s.x, s.y, 220, 10, 0.05, 1);
    S.spirits.delete(id);
  }
}
function ascend(s) {
  burst(s.x, s.y, 45, 60, 0.22, 2.2, "rise");
  S.wave = [s.x / A, s.y, 0, 0.9];
  const kinds = S.world.flora.filter((k) => k.where === (isLand(s.x, s.y) ? "land" : "water"));
  for (let i = 0; i < 14 && kinds.length; i++) { const a = Math.random() * TAU, d = Math.random() * 0.07; addFlora(s.x + Math.cos(a) * d, s.y + Math.sin(a) * d, kinds[i % kinds.length], 0.9); }
  chronicle(`${s.code} is done and blossomed into a grove`);
}
function crumble(s) {
  for (let i = 0; i < 40; i++) { const a = Math.random() * TAU, d = 0.03 + Math.random() * 0.05; S.particles.push({ x: s.x + Math.cos(a) * d, y: s.y + Math.sin(a) * d, vx: -Math.cos(a) * d * 1.4, vy: -Math.sin(a) * d * 1.4, t: 0, life: 1, hue: 330, size: 1.2, kind: "spark" }); }
  chronicle(`${s.code} failed and crumbled to dust`);
}
function stepSpirits(dt, fg) {
  for (const s of S.spirits.values()) {
    const n = Math.sin(s.x * 3.1 + S.time * 0.13) + Math.cos(s.y * 2.7 - S.time * 0.11);
    s.ang += n * dt * 1.4;
    if (s.x < 0.05) s.ang = lerp(s.ang, 0, dt * 2); if (s.x > A - 0.05) s.ang = lerp(s.ang, Math.PI, dt * 2);
    if (s.y < 0.06) s.ang = lerp(s.ang, Math.PI / 2, dt * 2); if (s.y > 0.94) s.ang = lerp(s.ang, -Math.PI / 2, dt * 2);
    const v = s.status === "running" ? 0.06 : 0.025;
    s.x = Math.max(0.01, Math.min(A - 0.01, s.x + Math.cos(s.ang) * v * dt)); s.y = Math.max(0.01, Math.min(0.99, s.y + Math.sin(s.ang) * v * dt));
    s.trail.push({ x: s.x, y: s.y }); if (s.trail.length > 46) s.trail.shift();
    near(fg, s.x, s.y, 0.09, (f) => { f.boost = 6; });
    if (s.status === "awaiting_input" && Math.random() < dt * 0.7) S.particles.push({ x: s.x, y: s.y, vx: 0, vy: 0, t: 0, life: 1.8, hue: 40, size: 1, kind: "ring" });
  }
}

// ---------- drawing ----------
const glowCache = new Map();
function glow(hue) {
  const key = Math.round(((hue % 360) + 360) % 360 / 8);
  let c = glowCache.get(key);
  if (!c) {
    c = document.createElement("canvas"); c.width = c.height = 64;
    const g = c.getContext("2d"), grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, `hsla(${key * 8},100%,72%,1)`); grd.addColorStop(0.35, `hsla(${key * 8},100%,60%,.35)`); grd.addColorStop(1, `hsla(${key * 8},100%,50%,0)`);
    g.fillStyle = grd; g.fillRect(0, 0, 64, 64); glowCache.set(key, c);
  }
  return c;
}
const dayLen = 150;
function dayLight() { const ph = (S.time / dayLen) % 1; return smooth(0.08, 0.4, 0.5 + 0.5 * Math.cos(ph * TAU)); }
const hueNow = (h, weird) => h + (reduced ? 0 : S.time * 22 * weird * weird);

function eyes(g, n, s, look, blink) {
  for (let k = 0; k < n; k++) {
    const a = n === 1 ? 0 : (k / (n - 1) - 0.5) * 1.5;
    const ex = Math.cos(a) * s * 0.45, ey = Math.sin(a) * s * 0.55, r = (s * 0.3) / Math.sqrt(n * 0.8);
    if (blink) { g.strokeStyle = "rgba(20,10,30,.8)"; g.lineWidth = Math.max(1, r * 0.4); g.beginPath(); g.moveTo(ex - r, ey); g.lineTo(ex + r, ey); g.stroke(); continue; }
    g.fillStyle = "#fff"; g.beginPath(); g.arc(ex, ey, r, 0, TAU); g.fill();
    g.fillStyle = "#140a1e"; g.beginPath(); g.arc(ex + r * 0.35 * look, ey, r * 0.55, 0, TAU); g.fill();
  }
}
/** Draws one creature centred on (0,0) facing +x, s = body radius in pixels. Used by the world and the bestiary. */
function drawBody(g, c, s, t, hue, alpha = 1) {
  const sp = c.sp, sat = sp.sat;
  const body = `hsla(${hue},${sat}%,56%,${alpha})`, light = `hsla(${hue + 25},${sat}%,76%,${alpha * 0.85})`, dark = `hsla(${hue - 20},${sat}%,30%,${alpha})`;
  const blink = ((t + c.phase * 3) % 4.5) < 0.12;
  const look = c.mode === "flee" ? -1 : 1;
  switch (sp.plan) {
    case "gloop": {
      g.fillStyle = body; g.beginPath();
      for (let i = 0; i <= 18; i++) { const a = (i / 18) * TAU, r = s * (1 + 0.14 * Math.sin(a * 3 + t * 5 + c.phase) + 0.07 * Math.sin(a * 5 - t * 3)) * (1 + 0.12 * Math.cos(a)); i ? g.lineTo(Math.cos(a) * r, Math.sin(a) * r) : g.moveTo(Math.cos(a) * r, Math.sin(a) * r); }
      g.fill(); g.fillStyle = light; g.beginPath(); g.arc(-s * 0.3, -s * 0.35, s * 0.32, 0, TAU); g.fill();
      eyes(g, sp.eyes, s, look, blink); break;
    }
    case "jelly": {
      const pulse = Math.max(0, Math.sin(c.phase * 0.9));
      g.strokeStyle = `hsla(${hue + 40},${sat}%,70%,${alpha * 0.7})`; g.lineWidth = Math.max(1, s * 0.13); g.lineCap = "round";
      const k = 3 + sp.limbs;
      for (let j = 0; j < k; j++) { const oy = (j / (k - 1) - 0.5) * s * 1.3; g.beginPath(); g.moveTo(-s * 0.2, oy); for (let i = 1; i <= 6; i++) g.lineTo(-s * 0.2 - i * s * 0.36, oy * (1 - i * 0.06) + Math.sin(t * 4 + i * 0.9 + j) * s * 0.18); g.stroke(); }
      g.fillStyle = `hsla(${hue},${sat}%,62%,${alpha * 0.82})`; g.beginPath(); g.ellipse(0, 0, s * (0.75 + 0.15 * pulse), s * (1.05 - 0.12 * pulse), 0, -Math.PI / 2, Math.PI / 2); g.closePath(); g.fill();
      g.fillStyle = light; g.beginPath(); g.ellipse(s * 0.25, 0, s * 0.25, s * 0.5, 0, 0, TAU); g.fill();
      eyes(g, Math.min(sp.eyes, 3), s * 0.8, look, blink); break;
    }
    case "strider": {
      g.strokeStyle = dark; g.lineWidth = Math.max(1, s * 0.16); g.lineCap = "round"; g.lineJoin = "round";
      const L = sp.limbs;
      for (let i = 0; i < L; i++) for (const side of [-1, 1]) {
        const ax = (L === 1 ? 0 : i / (L - 1) - 0.5) * s * 1.3, sw = Math.sin(c.phase + i * 2.1 + (side > 0 ? Math.PI : 0));
        g.beginPath(); g.moveTo(ax, side * s * 0.35); g.lineTo(ax + sw * s * 0.45, side * s * 1.05); g.lineTo(ax + sw * s * 0.95 - s * 0.15, side * s * 1.55); g.stroke();
      }
      g.fillStyle = body; g.beginPath(); g.ellipse(0, 0, s * 1.05, s * 0.62, 0, 0, TAU); g.fill();
      g.fillStyle = light; g.beginPath(); g.ellipse(-s * 0.2, -s * 0.2, s * 0.5, s * 0.2, 0, 0, TAU); g.fill();
      g.fillStyle = body; g.beginPath(); g.arc(s * 0.95, 0, s * 0.52, 0, TAU); g.fill();
      g.save(); g.translate(s * 0.95, 0); eyes(g, sp.eyes, s * 0.62, look, blink); g.restore(); break;
    }
    case "flutter": {
      const flap = Math.abs(Math.sin(c.phase * 1.6));
      g.fillStyle = `hsla(${hue + 50},${sat}%,66%,${alpha * 0.72})`;
      for (const side of [-1, 1]) { g.beginPath(); g.ellipse(-s * 0.1, side * s * 0.55 * (0.35 + 0.65 * flap), s * 0.7, s * 0.5 * (0.3 + 0.7 * flap), side * 0.35, 0, TAU); g.fill(); }
      g.strokeStyle = `hsla(${hue + 90},90%,80%,${alpha * 0.55})`; g.lineWidth = Math.max(1, s * 0.07);
      for (const side of [-1, 1]) { g.beginPath(); g.ellipse(-s * 0.1, side * s * 0.55 * (0.35 + 0.65 * flap), s * 0.4, s * 0.28 * (0.3 + 0.7 * flap), side * 0.35, 0, TAU); g.stroke(); }
      g.fillStyle = body; g.beginPath(); g.ellipse(0, 0, s * 0.62, s * 0.24, 0, 0, TAU); g.fill();
      g.save(); g.translate(s * 0.45, 0); eyes(g, Math.min(sp.eyes, 2), s * 0.38, look, blink); g.restore(); break;
    }
    case "urchin": {
      const k = 7 + sp.limbs * 2;
      g.save(); g.rotate(c.roll * 0.35);
      g.fillStyle = body; g.strokeStyle = light; g.lineWidth = Math.max(1, s * 0.08); g.beginPath();
      for (let i = 0; i <= k * 2; i++) { const a = (i / (k * 2)) * TAU, r = i % 2 ? s * 0.62 : s * (1.3 + 0.18 * Math.sin(t * 3 + i)); i ? g.lineTo(Math.cos(a) * r, Math.sin(a) * r) : g.moveTo(Math.cos(a) * r, Math.sin(a) * r); }
      g.closePath(); g.fill(); g.stroke(); g.restore();
      g.fillStyle = dark; g.beginPath(); g.arc(0, 0, s * 0.58, 0, TAU); g.fill();
      eyes(g, sp.eyes, s * 0.85, look, blink); break;
    }
    default: { g.fillStyle = body; g.beginPath(); g.arc(0, 0, s, 0, TAU); g.fill(); eyes(g, sp.eyes, s, look, blink); }
  }
}
function drawSerpent(g, c, sc, t, hue, alpha) {
  const s = c.size * sc, segs = c.segs, n = segs.length, sp = c.sp;
  for (let i = n - 1; i >= 0; i--) {
    const k = 1 - i / n, r = s * (0.35 + 0.6 * k);
    g.fillStyle = `hsla(${hue + (i % 2) * (25 + 50 * S.params.weird)},${sp.sat}%,${50 + (i % 2) * 12}%,${alpha})`;
    g.beginPath(); g.arc(segs[i].x * sc, segs[i].y * sc, r, 0, TAU); g.fill();
  }
  g.save(); g.translate(c.x * sc, c.y * sc); g.rotate(c.ang);
  g.fillStyle = `hsla(${hue},${sp.sat}%,56%,${alpha})`; g.beginPath(); g.ellipse(0, 0, s * 1.1, s * 0.85, 0, 0, TAU); g.fill();
  eyes(g, sp.eyes, s * 0.95, c.mode === "flee" ? -1 : 1, ((t + c.phase * 3) % 4.5) < 0.12);
  if (Math.sin(t * 2 + c.phase) > 0.85) { g.strokeStyle = `hsla(${hue + 160},90%,65%,${alpha})`; g.lineWidth = Math.max(1, s * 0.12); g.beginPath(); g.moveTo(s * 1.05, 0); g.lineTo(s * 1.6, -s * 0.15); g.moveTo(s * 1.05, 0); g.lineTo(s * 1.6, s * 0.15); g.stroke(); }
  g.restore();
}
function drawFlora(g, f, sc, t, night, weird) {
  const x = f.x * sc, y = f.y * sc, s = sc * 0.011 * f.size * (0.35 + 0.65 * f.e), h = hueNow(f.hue, weird);
  const sway = Math.sin(t * 1.3 + f.phase) * 0.12;
  g.save(); g.translate(x, y);
  if (night > 0.25 && f.e > 0.3) { const gl = glow(h); g.globalAlpha = night * 0.5 * f.e; g.drawImage(gl, -s * 2.2, -s * 2.6, s * 4.4, s * 4.4); g.globalAlpha = 1; }
  switch (f.kind) {
    case "glowcap": {
      g.rotate(sway); g.strokeStyle = `hsla(${h - 30},30%,78%,.9)`; g.lineWidth = Math.max(1, s * 0.22); g.beginPath(); g.moveTo(0, 0); g.lineTo(0, -s * 1.2); g.stroke();
      g.fillStyle = `hsla(${h},85%,${58 + night * 14}%,.95)`; g.beginPath(); g.arc(0, -s * 1.2, s * 0.85, Math.PI, 0); g.closePath(); g.fill();
      g.fillStyle = `hsla(${h + 60},100%,88%,.9)`; for (let i = -1; i <= 1; i++) { g.beginPath(); g.arc(i * s * 0.4, -s * 1.5 + Math.abs(i) * s * 0.15, s * 0.12, 0, TAU); g.fill(); }
      break;
    }
    case "spiralfern": {
      g.rotate(sway * 1.5); g.strokeStyle = `hsla(${h},70%,${48 + night * 20}%,.95)`; g.lineWidth = Math.max(1, s * 0.2); g.lineCap = "round"; g.beginPath(); g.moveTo(0, 0);
      for (let i = 0; i <= 22; i++) { const a = i * 0.42 * f.flip, r = s * 1.5 * (1 - i / 26); g.lineTo(Math.sin(a) * r * 0.6 + f.flip * (s * 0.6 - r * 0.4), -s * 1.6 + Math.cos(a) * r * 0.6 - (1 - i / 22) * s * 0.4); }
      g.stroke(); break;
    }
    case "crystal": {
      for (let i = -1; i <= 1; i++) { g.fillStyle = `hsla(${h + i * 18},70%,${75 + night * 10}%,${0.72 + 0.2 * Math.sin(t * 2 + f.phase + i)})`; g.beginPath(); g.moveTo(i * s * 0.5 - s * 0.22, 0); g.lineTo(i * s * 0.62, -s * (1.6 - Math.abs(i) * 0.5)); g.lineTo(i * s * 0.5 + s * 0.22, 0); g.closePath(); g.fill(); }
      break;
    }
    case "bulbtree": {
      g.rotate(sway * 0.6); g.strokeStyle = `hsla(${h - 140},30%,32%,.95)`; g.lineWidth = Math.max(1, s * 0.3); g.beginPath(); g.moveTo(0, 0); g.lineTo(0, -s * 1.1); g.stroke();
      for (const [dx, dy, r] of [[0, -1.6, 0.78], [-0.6, -1.15, 0.55], [0.62, -1.2, 0.5]]) { g.fillStyle = `hsla(${h + dx * 40},75%,${50 + night * 16}%,.95)`; g.beginPath(); g.arc(dx * s, dy * s, r * s * (1 + 0.06 * Math.sin(t * 2.4 + f.phase + dx)), 0, TAU); g.fill(); }
      break;
    }
    case "spinebloom": {
      g.fillStyle = `hsla(${h - 150},45%,40%,.95)`; g.beginPath(); g.ellipse(0, -s * 0.8, s * 0.38, s * 0.85, 0, 0, TAU); g.fill();
      g.fillStyle = `hsla(${h},95%,62%,.95)`; for (let i = 0; i < 5; i++) { const a = (i / 5) * TAU + t * 0.4; g.beginPath(); g.arc(Math.cos(a) * s * 0.3, -s * 1.7 + Math.sin(a) * s * 0.3, s * 0.22, 0, TAU); g.fill(); }
      break;
    }
    case "kelp": {
      g.strokeStyle = `hsla(${h},60%,${40 + night * 25}%,.85)`; g.lineWidth = Math.max(1, s * 0.22); g.beginPath(); g.moveTo(0, 0);
      for (let i = 1; i <= 6; i++) g.lineTo(Math.sin(t * 1.6 + f.phase + i * 0.8) * s * 0.35, -i * s * 0.36); g.stroke();
      g.fillStyle = `hsla(${h + 70},100%,${70 + night * 15}%,.9)`; g.beginPath(); g.arc(Math.sin(t * 1.6 + f.phase + 4.8) * s * 0.35, -s * 2.2, s * 0.22 * (1 + night), 0, TAU); g.fill();
      break;
    }
  }
  g.restore();
}

function render(dt) {
  const P = S.params, day = dayLight(), night = 1 - day, weird = P.weird, t = S.time, sc = SC;
  S.fade = Math.min(1, S.fade + dt * 1.2);
  GL?.draw({ aspect: A, time: t, sea: S.terrain.sea, weird, life: P.life, day: 0.12 + 0.88 * day, motion: reduced ? 0.25 : 1, fade: smooth(0, 1, S.fade), pal: S.world.palette, wave: S.wave });

  // Trails: a fading layer under the creatures. Weird worlds keep their trails longer and let them glow.
  tctx.globalCompositeOperation = "destination-out";
  tctx.fillStyle = `rgba(0,0,0,${reduced ? 1 : lerp(0.32, 0.045, weird)})`; tctx.fillRect(0, 0, trails.width, trails.height);
  tctx.globalCompositeOperation = "lighter"; tctx.lineCap = "round";
  if (!reduced) {
    for (const c of S.creatures) {
      if (S.focus !== null && c.sp.id !== S.focus) continue;
      tctx.strokeStyle = `hsla(${hueNow(c.hue, weird)},90%,60%,${0.06 + 0.3 * weird + 0.2 * night})`; tctx.lineWidth = Math.max(1, c.size * sc * (0.4 + weird));
      tctx.beginPath(); tctx.moveTo(c.px * sc, c.py * sc); tctx.lineTo(c.x * sc, c.y * sc); tctx.stroke();
    }
  }
  for (const s of S.spirits.values()) {
    const h = SPIRIT[s.status]?.hue ?? 200, n = s.trail.length;
    for (let i = 1; i < n; i++) { tctx.strokeStyle = `hsla(${h},100%,70%,${(i / n) * 0.35})`; tctx.lineWidth = (i / n) * sc * 0.009; tctx.beginPath(); tctx.moveTo(s.trail[i - 1].x * sc, s.trail[i - 1].y * sc); tctx.lineTo(s.trail[i].x * sc, s.trail[i].y * sc); tctx.stroke(); }
  }

  ctx.clearRect(0, 0, fx.width, fx.height);
  for (const f of S.flora) drawFlora(ctx, f, sc, t, night, weird);
  const dim = (c) => (S.focus === null || c.sp.id === S.focus ? 1 : 0.22);
  const order = (c) => (c.sp.habitat === "air" ? 1 : 0);
  const sorted = [...S.creatures].sort((a, b) => order(a) - order(b));
  for (const c of sorted) {
    const s = c.size * sc, h = hueNow(c.hue, weird), a = dim(c);
    if (night > 0.2 || weird > 0.6) { ctx.globalCompositeOperation = "lighter"; ctx.globalAlpha = Math.min(1, (night * 0.85 + (weird - 0.6) * 0.8) * c.sp.glow) * a; const gl = glow(h); ctx.drawImage(gl, c.x * sc - s * 3, c.y * sc - s * 3, s * 6, s * 6); ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over"; }
    if (c.sp.habitat === "air") { ctx.fillStyle = `rgba(10,0,30,${0.22 * a})`; ctx.beginPath(); ctx.ellipse(c.x * sc + s * 1.6, c.y * sc + s * 2.4, s * 0.9, s * 0.45, 0, 0, TAU); ctx.fill(); }
    if (c.sp.plan === "serpent") { drawSerpent(ctx, c, sc, t, h, a); continue; }
    ctx.save(); ctx.translate(c.x * sc, c.y * sc); ctx.rotate(c.ang); drawBody(ctx, c, s, t, h, a); ctx.restore();
  }
  if (S.focus !== null) for (const c of S.creatures) if (c.sp.id === S.focus) { ctx.strokeStyle = "rgba(255,255,255,.55)"; ctx.lineWidth = Math.max(1, sc * 0.0018); ctx.beginPath(); ctx.arc(c.x * sc, c.y * sc, c.size * sc * 2.3, 0, TAU); ctx.stroke(); }

  ctx.globalCompositeOperation = "lighter";
  for (const p of S.particles) {
    const k = 1 - p.t / p.life;
    if (p.kind === "ring") { ctx.strokeStyle = `hsla(${p.hue},100%,65%,${k * 0.7})`; ctx.lineWidth = Math.max(1, sc * 0.002); ctx.beginPath(); ctx.arc(p.x * sc, p.y * sc, (1 - k) * sc * 0.06, 0, TAU); ctx.stroke(); continue; }
    if (p.kind === "heart") { ctx.fillStyle = `hsla(${p.hue},100%,75%,${k})`; ctx.font = `${Math.round(sc * 0.016)}px system-ui`; ctx.fillText("♥", p.x * sc, p.y * sc); continue; }
    const r = p.size * sc * 0.004 * (0.4 + k);
    ctx.drawImage(glow(p.hue), p.x * sc - r * 3, p.y * sc - r * 3, r * 6, r * 6);
  }
  for (const s of S.spirits.values()) {
    const h = SPIRIT[s.status]?.hue ?? 200, beat = 1 + 0.25 * Math.sin(t * (s.status === "awaiting_input" ? 6 : 2.5)), r = sc * 0.012 * beat;
    ctx.drawImage(glow(h), s.x * sc - r * 4, s.y * sc - r * 4, r * 8, r * 8);
    ctx.fillStyle = "rgba(255,255,255,.95)"; ctx.beginPath(); ctx.arc(s.x * sc, s.y * sc, r * 0.38, 0, TAU); ctx.fill();
    ctx.strokeStyle = `hsla(${h},100%,80%,.8)`; ctx.lineWidth = Math.max(1, sc * 0.0016); ctx.beginPath(); ctx.arc(s.x * sc, s.y * sc, r * 1.25, t * 2, t * 2 + 4.4); ctx.stroke();
  }
  ctx.globalCompositeOperation = "source-over";
  ctx.font = `600 ${Math.round(Math.max(10, sc * 0.016))}px ${labelFont}`; ctx.textAlign = "center";
  for (const s of S.spirits.values()) { ctx.fillStyle = "rgba(0,0,0,.45)"; ctx.fillText(s.code, s.x * sc + 1, s.y * sc + sc * 0.034 + 1); ctx.fillStyle = `hsla(${SPIRIT[s.status]?.hue ?? 200},100%,88%,.95)`; ctx.fillText(s.code, s.x * sc, s.y * sc + sc * 0.034); }
  ctx.textAlign = "start";
}

// ---------- HUD ----------
const SLIDERS = [
  { key: "heat", label: "Heat", from: "#5ad1ff", to: "#ff6a3d", words: ["frozen", "cool", "temperate", "warm", "scorching"] },
  { key: "water", label: "Water", from: "#e0b46a", to: "#2a6cff", words: ["desert", "dry", "balanced", "wet", "ocean"] },
  { key: "life", label: "Life", from: "#7a6a5a", to: "#4dff8e", words: ["barren", "sparse", "lively", "lush", "teeming"] },
  { key: "weird", label: "Weirdness", from: "#8aa0b8", to: "#ff3df2", words: ["natural", "uncanny", "strange", "psychedelic", "melting"] },
  { key: "species", label: "Species", from: "#555", to: "#fff", min: 3, max: 9, step: 1 },
];
let pendingParams = {};
function buildSliders() {
  const box = $("sliders"); box.innerHTML = "";
  for (const d of SLIDERS) {
    const f = document.createElement("div"); f.className = "field";
    f.innerHTML = `<label><span>${d.label}</span><span id="v-${d.key}"></span></label><input type="range" id="r-${d.key}" min="${d.min ?? 0}" max="${d.max ?? 1}" step="${d.step ?? 0.01}" style="--from:${d.from};--to:${d.to}"><small id="x-${d.key}"></small>`;
    box.append(f);
    f.querySelector("input").addEventListener("input", (e) => {
      if (S.source !== "dream") return;
      const v = d.key === "species" ? Math.round(+e.target.value) : +e.target.value;
      pendingParams[d.key] = v;
      clearTimeout(buildSliders.t); buildSliders.t = setTimeout(() => { const p = pendingParams; pendingParams = {}; setParams(p); saveDream(); }, 90);
      $(`v-${d.key}`).textContent = valueWord(d, v);
    });
  }
}
const valueWord = (d, v) => (d.key === "species" ? String(Math.round(v)) : `${d.words[Math.min(4, Math.floor(v * 5))]} · ${Math.round(v * 100)}`);
function syncSliders() {
  for (const d of SLIDERS) {
    const r = $(`r-${d.key}`), v = S.params[d.key];
    if (document.activeElement !== r) r.value = v;
    r.disabled = S.source !== "dream";
    $(`v-${d.key}`).textContent = valueWord(d, v);
    $(`x-${d.key}`).textContent = S.source === "pulse" && S.pulse?.explain ? S.pulse.explain[d.key] : "";
  }
  if (document.activeElement !== $("seed")) $("seed").value = S.seed;
  $("seed").disabled = S.source !== "dream"; $("b-dice").disabled = S.source !== "dream";
  $("b-fork").hidden = S.source === "dream";
  $("s-pulse").classList.toggle("on", S.source === "pulse"); $("s-dream").classList.toggle("on", S.source === "dream");
  $("s-pulse").textContent = embedded ? "Your workspace" : "Demo pulse";
  $("drift").checked = S.drift;
  $("srcnote").textContent = S.source === "pulse"
    ? (embedded ? `This world follows the last ${S.pulse?.days ?? 7} days of your workspace. Running tasks drift through it as spirits; click one to open it.` : "Opened on its own, so pretend agents are at work. Install the plugin in Agent Control for the real thing.")
    : "Your own world. Change the sliders and it changes live; a new seed grows new land.";
}
function renderWorlds() {
  const box = $("worlds"); box.innerHTML = "";
  const list = S.worlds;
  for (const w of list) {
    const row = document.createElement("div"); row.className = "world";
    const pal = makeWorld({ seed: w.seed, ...w }).palette;
    const col = (t) => `rgb(${[0, 1, 2].map((i) => Math.round(255 * Math.max(0, Math.min(1, pal.a[i] + pal.b[i] * Math.cos(TAU * (pal.c[i] * t + pal.d[i])))))).join(",")})`;
    row.innerHTML = `<div class="swatch" style="background:linear-gradient(135deg,${col(0)},${col(0.33)},${col(0.66)})"></div><div class="wname"><div></div><div></div></div>${w.author === "agent" ? '<span class="badge">agent</span>' : ""}<button class="x" title="Forget this world">×</button>`;
    row.querySelector(".wname div").textContent = w.name;
    row.querySelector(".wname div:last-child").textContent = w.lore || `heat ${Math.round(w.heat * 100)} · water ${Math.round(w.water * 100)} · weird ${Math.round(w.weird * 100)}`;
    row.addEventListener("click", (e) => {
      if (e.target.classList.contains("x")) return forget(w);
      S.source = "dream"; S.drift = false; store.set("drift", false);
      genesis(w.seed, { heat: w.heat, water: w.water, life: w.life, weird: w.weird, species: w.species }, `You stepped into ${w.name}`);
      S.worldName = w.name; saveDream();
    });
    box.append(row);
  }
  $("worldsnote").textContent = list.length ? "" : embedded ? "Keep a world with the bookmark button. Agents can dream worlds too, with the terrarium_dream_world tool." : "Keep a world with the bookmark button.";
}
async function forget(w) {
  if (embedded && typeof w.id === "number") { try { await bridge.call("DELETE", `/worlds/${w.id}`); } catch (e) { bridge.toast(`Could not forget the world: ${e.message}`); return; } }
  S.worlds = S.worlds.filter((x) => x !== w); if (!embedded) store.set("worlds", S.worlds);
  renderWorlds();
}
async function keepWorld() {
  const w = { name: S.worldName || S.world.name, seed: S.seed, ...S.params };
  if (embedded) {
    try { const r = await bridge.call("POST", "/worlds", w); S.worlds.unshift(r.world); bridge.toast(`Kept ${w.name}`); }
    catch (e) { bridge.toast(`Could not keep the world: ${e.message}`); return; }
  } else { S.worlds.unshift({ ...w, id: `local-${Date.now()}`, author: "you" }); store.set("worlds", S.worlds.slice(0, 40)); }
  chronicle(`You kept ${w.name}`); renderWorlds();
}

const portraits = [];
function renderHud(full) {
  const W = S.world;
  $("name").textContent = S.source === "dream" && S.worldName ? S.worldName : W.name;
  $("source").textContent = S.source === "pulse" ? (embedded ? `Terrarium · your workspace · ${S.pulse?.days ?? 7} days` : "Terrarium · demo pulse") : "Terrarium · dream";
  if (full) {
    const box = $("cards"); box.innerHTML = ""; portraits.length = 0;
    for (const sp of W.species) {
      const card = document.createElement("div"); card.className = "card"; card.dataset.id = sp.id;
      const cv = document.createElement("canvas"); cv.width = cv.height = 116;
      const diet = sp.diet === "meat" ? `hunts ${sp.eats.map((i) => W.species[i].name).join(", ")}` : sp.diet === "light" ? "eats light" : sp.diet === "filter" ? "filters water" : `grazes ${(sp.floraKinds ?? []).map((k) => W.flora.find((f) => f.kind === k)?.name).join(", ")}`;
      card.innerHTML = `<div></div><div><div class="cname"></div><div class="ctitle"></div><div class="tags"><span>${sp.habitat}</span><span>${sp.trophic === 3 ? "apex hunter" : sp.trophic === 2 ? "hunter" : { flora: "grazer", light: "light-eater", filter: "filter-feeder" }[sp.diet]}</span><span>${sp.eyes} eye${sp.eyes > 1 ? "s" : ""}</span></div><div class="web"></div><div class="pop"></div></div>`;
      card.firstChild.append(cv);
      card.querySelector(".cname").textContent = sp.name; card.querySelector(".cname").style.color = `hsl(${sp.hue} 80% var(--name-l))`;
      card.querySelector(".ctitle").textContent = sp.title;
      card.querySelector(".web").textContent = diet + (sp.eatenBy.length ? ` · fears ${sp.eatenBy.map((i) => W.species[i].name).join(", ")}` : "");
      card.addEventListener("click", () => { S.focus = S.focus === sp.id ? null : sp.id; for (const c of document.querySelectorAll(".card")) c.classList.toggle("on", +c.dataset.id === S.focus); });
      box.append(card);
      portraits.push({ sp, cv, g: cv.getContext("2d"), card, fake: { sp, phase: Math.random() * TAU, mode: "", roll: 0, size: sp.size } });
    }
    $("lore").textContent = describeWorld({ ...W, name: $("name").textContent }).split("\n").slice(1, 4).join("\n");
    syncSliders(); renderWorlds();
  }
}
function tickHud() {
  const pop = new Array(S.world.species.length).fill(0);
  for (const c of S.creatures) pop[c.sp.id]++;
  const day = dayLight();
  $("meta").innerHTML = `<span><b>${S.creatures.length}</b> beings</span><span><b>${S.world.species.length}</b> species</span><span>generation <b>${S.maxGen}</b></span>${S.spirits.size ? `<span><b>${S.spirits.size}</b> spirit${S.spirits.size > 1 ? "s" : ""}</span>` : ""}`;
  $("clock").textContent = day > 0.6 ? "☀" : day > 0.25 ? "◐" : "☾";
  if (!$("bestiary").classList.contains("closed")) for (const p of portraits) {
    p.card.querySelector(".pop").innerHTML = pop[p.sp.id] ? `<b>${pop[p.sp.id]}</b> alive` : "extinct, for now";
    p.card.classList.toggle("extinct", !pop[p.sp.id]);
  }
}
function drawPortraits(dt) {
  if ($("bestiary").classList.contains("closed")) return;
  for (const p of portraits) {
    const g = p.g; g.clearRect(0, 0, 116, 116);
    p.fake.phase += dt * 5; p.fake.roll += dt * 2;
    g.save(); g.translate(58, 58); g.rotate(-0.35 + Math.sin(S.time * 0.8 + p.sp.id) * 0.12);
    if (p.sp.plan === "serpent") {
      for (let i = 8; i >= 0; i--) { g.fillStyle = `hsla(${p.sp.hue + (i % 2) * 30},${p.sp.sat}%,${50 + (i % 2) * 12}%,1)`; g.beginPath(); g.arc(-i * 10, Math.sin(S.time * 3 + i * 0.7) * 6, 15 * (0.35 + 0.6 * (1 - i / 9)), 0, TAU); g.fill(); }
      g.translate(16, 0); drawBody(g, { ...p.fake, sp: { ...p.sp, plan: "gloop" } }, 13, S.time, p.sp.hue);
    } else drawBody(g, p.fake, p.sp.plan === "flutter" ? 30 : 22, S.time, p.sp.hue);
    g.restore();
  }
}
function drawChart() {
  const cv = $("chart"), r = cv.getBoundingClientRect(), dpr = S.dpr;
  if (cv.width !== Math.round(r.width * dpr)) { cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr); }
  const g = cv.getContext("2d"), w = cv.width, h = cv.height, H = S.history;
  g.clearRect(0, 0, w, h);
  if (H.length < 2) return;
  const tot = H.map((row) => row.reduce((a, b) => a + b, 0)), max = Math.max(10, ...tot) * 1.1;
  const n = S.world.species.length, xs = (i) => (i / 159) * w + (w - ((H.length - 1) / 159) * w);
  const base = new Array(H.length).fill(0);
  for (let k = 0; k < n; k++) {
    const sp = S.world.species[k]; if (!sp) continue;
    const top = H.map((row, i) => base[i] + (row[k] ?? 0));
    g.beginPath(); g.moveTo(xs(0), h - (base[0] / max) * h);
    for (let i = 0; i < H.length; i++) g.lineTo(xs(i), h - (top[i] / max) * h);
    for (let i = H.length - 1; i >= 0; i--) g.lineTo(xs(i), h - (base[i] / max) * h);
    g.closePath(); g.fillStyle = `hsla(${hueNow(sp.hue, S.params.weird)},80%,62%,${S.focus === null || S.focus === k ? 0.55 : 0.12})`; g.fill();
    for (let i = 0; i < H.length; i++) base[i] = top[i];
  }
}

// ---------- pointer ----------
function pick(mx, my) {
  const x = (mx / VW) * A, y = my / VH;
  for (const s of S.spirits.values()) if (Math.hypot(s.x - x, s.y - y) < 0.03) return { spirit: s };
  let best = null, bd = 0.03;
  for (const c of S.creatures) { const d = Math.hypot(c.x - x, c.y - y) - c.size; if (d < bd) { bd = d; best = c; } }
  return best ? { creature: best } : null;
}
fx.addEventListener("pointermove", (e) => {
  const hit = pick(e.clientX, e.clientY), tip = $("tip");
  fx.classList.toggle("pointing", Boolean(hit?.spirit && embedded));
  if (!hit) { tip.style.opacity = "0"; return; }
  if (hit.spirit) tip.innerHTML = `<b></b><span></span>`, tip.querySelector("b").textContent = hit.spirit.code, tip.querySelector("span").textContent = `${SPIRIT[hit.spirit.status]?.label ?? hit.spirit.status}${embedded ? " · click to open" : ""}`;
  else { const c = hit.creature; tip.innerHTML = `<b></b><span></span>`; tip.querySelector("b").textContent = c.sp.name; tip.querySelector("span").textContent = `${c.sp.title} · generation ${c.gen} · ${c.mode === "hunt" ? "hunting" : c.mode === "flee" ? "fleeing!" : c.mode === "graze" ? "grazing" : "wandering"} · ${Math.round(Math.max(0, c.energy) * 100)}% fed`; }
  tip.style.left = `${Math.min(VW - 270, e.clientX + 14)}px`; tip.style.top = `${e.clientY + 14}px`; tip.style.opacity = "1";
});
fx.addEventListener("pointerleave", () => { $("tip").style.opacity = "0"; });
fx.addEventListener("click", (e) => {
  const hit = pick(e.clientX, e.clientY);
  if (hit?.spirit && embedded) return bridge.navigate(`#/task/${encodeURIComponent(hit.spirit.id)}`);
  if (hit?.creature) { S.focus = hit.creature.sp.id; openDrawer("bestiary", true); for (const c of document.querySelectorAll(".card")) c.classList.toggle("on", +c.dataset.id === S.focus); return; }
  const x = (e.clientX / VW) * A, y = e.clientY / VH, land = isLand(x, y);
  const kinds = S.world.flora.filter((k) => k.where === (land ? "land" : "water"));
  for (let i = 0; i < 7 && kinds.length; i++) { const a = Math.random() * TAU, d = Math.random() * 0.035; addFlora(x + Math.cos(a) * d, y + Math.sin(a) * d, kinds[i % kinds.length], 0.6); }
  burst(x, y, kinds[0]?.hue ?? 120, 16, 0.07, 1.1);
});

// ---------- drawers and buttons ----------
function openDrawer(id, on) {
  const el = $(id), open = on ?? el.classList.contains("closed");
  el.classList.toggle("closed", !open); $(`b-${id}`).classList.toggle("on", open);
  store.set(`open:${id}`, open);
}
$("b-controls").onclick = () => openDrawer("controls");
$("b-bestiary").onclick = () => openDrawer("bestiary");
$("b-pause").onclick = () => { S.paused = !S.paused; $("b-pause").classList.toggle("on", S.paused); };
$("b-keep").onclick = keepWorld;
$("b-new").onclick = () => dreamNew();
$("b-dice").onclick = () => { if (S.source === "dream") { genesis(randomSeed(), S.params, "New land rose from the sea"); S.worldName = null; saveDream(); } };
$("seed").addEventListener("change", (e) => { if (S.source !== "dream") return; const v = e.target.value.trim().slice(0, 80) || randomSeed(); S.worldName = null; genesis(v, S.params, `The seed "${v}" sprouted`); saveDream(); });
$("drift").addEventListener("change", (e) => { S.drift = e.target.checked; store.set("drift", S.drift); S.driftAt = S.time; if (S.drift && S.source !== "dream") useSource("dream"); });
$("s-pulse").onclick = () => useSource("pulse");
$("s-dream").onclick = () => useSource("dream");
$("b-fork").onclick = () => { S.source = "dream"; S.worldName = null; S.drift = false; store.set("drift", false); saveDream(); renderHud(true); chronicle("A dream copy of your workspace's world"); };
let tall = false;
$("b-tall").onclick = () => { tall = !tall; bridge.resize(tall ? Math.round(screen.availHeight * 0.92) : 700); $("b-tall").classList.toggle("on", tall); };
addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.key === " ") { e.preventDefault(); $("b-pause").click(); }
  else if (e.key === "n") dreamNew();
  else if (e.key === "b") openDrawer("bestiary");
  else if (e.key === "c") openDrawer("controls");
  else if (e.key === "Escape") { S.focus = null; for (const c of document.querySelectorAll(".card")) c.classList.remove("on"); }
});

const randomSeed = () => { const r = rng(Date.now() ^ Math.floor(Math.random() * 1e9)); return `${makeName(r, 1, 2).toLowerCase()}-${makeName(r, 1, 2).toLowerCase()}`; };
function dreamParams() { const r = Math.random; return { heat: Math.round(r() * 100) / 100, water: Math.round((0.15 + r() * 0.75) * 100) / 100, life: Math.round((0.35 + r() * 0.6) * 100) / 100, weird: Math.round(Math.pow(r(), 0.7) * 100) / 100, species: 4 + Math.floor(r() * 6) }; }
function dreamNew() {
  S.source = "dream"; S.worldName = null;
  genesis(randomSeed(), dreamParams(), "You dreamed a new world");
  S.driftAt = S.time; saveDream();
}
const saveDream = () => { if (S.source === "dream") store.set("dream", { seed: S.seed, params: S.params, name: S.worldName ?? null }); store.set("source", S.source); };
function useSource(src) {
  if (src === S.source) return;
  S.source = src; store.set("source", src);
  if (src === "pulse") { S.worldName = null; if (S.pulse) applyPulse(S.pulse, true); else pollPulse(); }
  else { const d = store.get("dream", null); S.worldName = d?.name ?? null; if (d?.seed) genesis(d.seed, d.params, "Back in your dream"); else dreamNew(); }
  renderHud(true);
}

// ---------- the pulse ----------
function applyPulse(p, jump) {
  if (!p) return;
  S.pulse = p;
  S.worlds = embedded ? p.worlds ?? [] : store.get("worlds", []);
  syncSpirits(p.spirits ?? [], p.recent ?? []);
  if (S.source !== "pulse") { renderWorlds(); return; }
  if (jump || !S.world || p.seed !== S.seed) { S.target = null; genesis(p.seed, p.params, S.ready ? "Your workspace's world" : null); return; }
  S.target = { ...p.params };
  syncSliders(); renderWorlds();
}
/** Drifts the parameters toward the latest pulse so the world changes gently instead of jumping. */
function easeToTarget() {
  if (S.source !== "pulse" || !S.target) return;
  const p = { ...S.params }; let moved = false;
  for (const k of ["heat", "water", "life", "weird"]) { const d = S.target[k] - p[k]; if (Math.abs(d) > 0.004) { p[k] += Math.sign(d) * Math.min(Math.abs(d), 0.02); moved = true; } else p[k] = S.target[k]; }
  if (p.species !== S.target.species) { p.species = S.target.species; moved = true; }
  if (moved) { reshape(p); syncSliders(); }
}
async function pollPulse() {
  if (!embedded) return applyPulse(demoPulse(), false);
  try { applyPulse(await bridge.call("GET", "/pulse"), false); }
  catch (e) { if (!S.world) { genesis("terrarium", S.params, null); } console.warn("Terrarium: no pulse", e); }
}

// Opened on its own (GitHub Pages, a local file): pretend agents at work, so the spirits and the pulse can be seen.
const demo = { tasks: [], n: 140, t0: Date.now() };
function demoPulse() {
  const now = Date.now(), m = (now - demo.t0) / 60000;
  if (!demo.tasks.length) for (let i = 0; i < 5; i++) demo.tasks.push({ id: `demo-${i}`, code: `AC-${demo.n++}`, status: ["running", "running", "awaiting_input", "review", "running"][i] });
  const recent = [];
  for (const t of demo.tasks) {
    if (t.status === "running" && Math.random() < 0.18) t.status = Math.random() < 0.3 ? "awaiting_input" : "review";
    else if (t.status === "awaiting_input" && Math.random() < 0.3) t.status = "running";
    else if (t.status === "review" && Math.random() < 0.35) { t.status = Math.random() < 0.85 ? "done" : "failed"; recent.push({ id: t.id, code: t.code, status: t.status }); }
  }
  demo.tasks = demo.tasks.filter((t) => t.status !== "done" && t.status !== "failed");
  while (demo.tasks.length < 3 + Math.round(2 + 2 * Math.sin(m))) demo.tasks.push({ id: `demo-${demo.n}`, code: `AC-${demo.n++}`, status: "running" });
  const stats = { created: 18 + Math.round(10 * Math.sin(m * 0.7)), done: 9 + Math.round(6 * Math.sin(m * 0.4)), failed: 1 + Math.round(Math.max(0, 2 * Math.sin(m * 0.9))), runs: 30, board: 12 };
  const k = (x) => Math.max(0, Math.min(1, x));
  return {
    seed: "workspace:demo", days: 7, stats,
    params: { heat: k(0.55 + 0.25 * Math.sin(m * 0.5)), water: k(0.5 + 0.2 * Math.cos(m * 0.33)), life: k(0.7 + 0.2 * Math.sin(m * 0.4)), weird: k(0.5 + 0.35 * Math.sin(m * 0.27)), species: 6 },
    explain: { heat: "pretend: 18 tasks and 30 runs this week", water: "pretend: a couple of failures", life: "pretend: 9 tasks delivered", weird: "pretend: agents arguing on the board", species: "more kinds of work, more species" },
    spirits: demo.tasks.map((t) => ({ ...t })), recent, worlds: [],
  };
}

// ---------- loop ----------
let last = performance.now(), hudAt = 0, easeAt = 0, pulseAt = 0, frames = 0, slowFor = 0;
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  if (S.world && S.terrain) {
    if (!S.paused) { S.time += dt; step(dt); }
    render(S.paused ? 0 : dt);
    drawPortraits(dt);
    if (now - hudAt > 500) { hudAt = now; tickHud(); drawChart(); }
    if (now - easeAt > 1000) { easeAt = now; easeToTarget(); }
    if (now - pulseAt > (embedded ? 15000 : 9000)) { pulseAt = now; if (S.source === "pulse" || embedded) pollPulse(); }
    if (S.drift && S.source === "dream" && S.time - S.driftAt > 180) dreamNew();
    // Too slow (a big screen on a small GPU): draw fewer pixels.
    if (dt > 0.034) slowFor += dt; else slowFor = Math.max(0, slowFor - dt * 0.5);
    if (slowFor > 3 && S.dpr > 1) { S.dpr = 1; slowFor = 0; resize(); }
  }
  frames++;
  requestAnimationFrame(frame);
}

function start() {
  buildSliders(); resize();
  for (const id of ["controls", "bestiary"]) if (store.get(`open:${id}`, false)) openDrawer(id, true);
  if (embedded) {
    $("b-tall").hidden = false;
    bridge.onInit(() => { labelFont = getComputedStyle(document.body).fontFamily || "system-ui"; });
    bridge.ready(); bridge.resize(700);
    // Settings decide where to start; the pulse arrives through the bridge.
    bridge.call("GET", "/pulse").then((p) => {
      const want = store.get("source", p.settings?.start ?? "pulse");
      S.source = want === "dream" ? "dream" : "pulse";
      if (S.source === "dream") { const d = store.get("dream", null); applyPulse(p, false); if (d?.seed) { S.worldName = d.name; genesis(d.seed, d.params, null); } else dreamNew(); if (p.settings?.start === "dream") S.drift = true; }
      else applyPulse(p, true);
      S.ready = true; renderHud(true);
    }).catch((e) => { console.warn("Terrarium: no pulse", e); S.source = "dream"; dreamNew(); S.ready = true; });
  } else {
    S.source = store.get("source", "pulse");
    const q = new URLSearchParams(location.search);
    if (q.has("time")) S.time = Math.max(0, +q.get("time") || 0); // e.g. ?time=75 starts at night
    if (q.get("seed")) { S.source = "dream"; genesis(q.get("seed"), { ...S.params, ...Object.fromEntries(["heat", "water", "life", "weird", "species"].filter((k) => q.has(k)).map((k) => [k, +q.get(k)])) }, null); S.ready = true; renderHud(true); }
    else if (S.source === "dream") { const d = store.get("dream", null); S.worldName = d?.name ?? null; if (d?.seed) genesis(d.seed, d.params, null); else genesis(randomSeed(), dreamParams(), null); S.ready = true; }
    else { applyPulse(demoPulse(), true); S.ready = true; }
    S.worlds = store.get("worlds", []); renderHud(true);
  }
  requestAnimationFrame(frame);
}
start();
// For debugging from the console of the page.
window.terrarium = S;

let seed = 12345;
function rnd() { // mulberry32 — 32bit 정확 연산
  seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function gauss() { let u = 0, v = 0; while (u === 0) u = rnd(); while (v === 0) v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

/** 선형 장면: 배경 + 여러 크기의 Gaussian (밝기 동적범위 확보) */
function scene(w, h, bgE, peakE) {
  const a = new Float64Array(w * h);
  const blobs = [[0.30, 0.35, 14, 1.0], [0.62, 0.30, 26, 0.55], [0.45, 0.68, 40, 0.28], [0.78, 0.72, 9, 0.8]];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = bgE;
    for (const [fx, fy, sg, amp] of blobs) {
      const dx = x - fx * w, dy = y - fy * h;
      s += peakE * amp * Math.exp(-(dx * dx + dy * dy) / (2 * sg * sg));
    }
    a[y * w + x] = s;
  }
  return a;
}
function shot(a, readE) { const o = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) o[i] = a[i] + Math.sqrt(a[i]) * gauss() + readE * gauss(); return o; }
function tone(a, k, fullE) { const o = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) { const t = Math.max(0, a[i]) / fullE;
    o[i] = Math.min(255, Math.round(255 * Math.pow(Math.min(1, t), k))); } return o; }
function affine(a, gain, off) { const o = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) o[i] = Math.min(255, Math.max(0, Math.round(a[i] * gain + off))); return o; }
function upscale(a, w, h, U, mode) {
  if (U === 1) return { d: a, w, h };
  const W = w * U, H = h * U, o = new Float64Array(W * H);
  for (let Y = 0; Y < H; Y++) for (let X = 0; X < W; X++) {
    if (mode === "nearest") { o[Y * W + X] = a[Math.min(h - 1, Math.floor(Y / U)) * w + Math.min(w - 1, Math.floor(X / U))]; continue; }
    const sx = (X + 0.5) / U - 0.5, sy = (Y + 0.5) / U - 0.5;
    const x0 = Math.floor(sx), y0 = Math.floor(sy), tx = sx - x0, ty = sy - y0;
    const cl = (v, m) => Math.min(m - 1, Math.max(0, v));
    const g = (xx, yy) => a[cl(yy, h) * w + cl(xx, w)];
    o[Y * W + X] = Math.round(
      g(x0, y0) * (1 - tx) * (1 - ty) + g(x0 + 1, y0) * tx * (1 - ty) +
      g(x0, y0 + 1) * (1 - tx) * ty + g(x0 + 1, y0 + 1) * tx * ty);
  }
  return { d: o, w: W, h: H };
}

const W0 = 460, H0 = 340, FULL = 4000;
function build({ U = 1, mode = "bilinear", k = 1, bgE = 30, peakE = 3400, readE = 3, gain = null, off = 0 }) {
  const lin = shot(scene(W0, H0, bgE, peakE), readE);
  let img = gain !== null ? affine(lin, gain, off) : tone(lin, k, FULL);
  return upscale(img, W0, H0, U, mode);
}


export { build, scene, shot, tone, affine, upscale };

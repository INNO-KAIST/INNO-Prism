/* =============================================================================
 * INNO Prism — core data layer (loaders, branch split, beam-profile fit)
 * NOTE: the legacy v5 fitting engine has been REMOVED from this file.
 * All power-scan fitting now lives in PrismFit (fit2.js).
 * ========================================================================== */
"use strict";
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PrismEngine = api;
})(typeof self !== "undefined" ? self : this, function () {

const VERSION = "1.0.0";
const TINY = 1e-300;
const LOG10 = Math.log(10);

/* ------------------------------- utilities ------------------------------- */
const isNum = (v) => typeof v === "number" && isFinite(v);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function finiteVals(arr) {
  const out = [];
  for (let i = 0; i < arr.length; i++) if (isFinite(arr[i])) out.push(arr[i]);
  return out;
}
function nanmedian(arr) {
  const a = finiteVals(arr);
  if (!a.length) return NaN;
  a.sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : 0.5 * (a[m - 1] + a[m]);
}
function nanmean(arr) {
  let s = 0, n = 0;
  for (const v of arr) if (isFinite(v)) { s += v; n++; }
  return n ? s / n : NaN;
}
function nanmax(arr) { let m = -Infinity, any = false; for (const v of arr) if (isFinite(v)) { any = true; if (v > m) m = v; } return any ? m : NaN; }
function nanmin(arr) { let m = Infinity, any = false; for (const v of arr) if (isFinite(v)) { any = true; if (v < m) m = v; } return any ? m : NaN; }
/** numpy-style linear-interpolation percentile over finite values. q in [0,100] */
function nanpercentile(arr, q) {
  const a = finiteVals(arr);
  if (!a.length) return NaN;
  a.sort((x, y) => x - y);
  const idx = (a.length - 1) * (q / 100.0);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return a[lo];
  return a[lo] + (a[hi] - a[lo]) * (idx - lo);
}
/** numpy-style quantile (q in [0,1]) */
function nanquantile(arr, q) { return nanpercentile(arr, 100.0 * q); }
function stdArr(arr) { // population std over finite values (ddof=0), matching np.std
  const a = finiteVals(arr);
  if (!a.length) return NaN;
  const m = a.reduce((s, v) => s + v, 0) / a.length;
  return Math.sqrt(a.reduce((s, v) => s + (v - m) * (v - m), 0) / a.length);
}
function argmaxFinite(arr) {
  let bi = 0, bv = -Infinity;
  for (let i = 0; i < arr.length; i++) if (isFinite(arr[i]) && arr[i] > bv) { bv = arr[i]; bi = i; }
  return bi;
}
function logspace(lo10, hi10, n) {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.pow(10, lo10 + (hi10 - lo10) * i / (n - 1));
  return out;
}
function expClip(v) { return Math.exp(clamp(v, -700, 700)); }
function log10Pos(v) { return Math.log10(Math.max(v, TINY)); }

/** Gaussian elimination with partial pivoting; A is n×n (array of rows), b length n. */
function solveLinear(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-300) return null;
    if (piv !== col) { const t = M[piv]; M[piv] = M[col]; M[col] = t; }
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  const x = new Array(n);
  for (let i = 0; i < n; i++) x[i] = M[i][n] / M[i][i];
  return x;
}
/** Inverse of symmetric PSD matrix with Tikhonov fallback. Returns array of rows or null. */
function invSym(A) {
  const n = A.length;
  for (let attempt = 0; attempt < 4; attempt++) {
    const lam = attempt === 0 ? 0 : Math.pow(10, -12 + 3 * attempt) * (1 + Math.abs(A[0][0]));
    const Areg = A.map((row, i) => row.map((v, j) => v + (i === j ? lam : 0)));
    const cols = [];
    let ok = true;
    for (let j = 0; j < n; j++) {
      const e = new Array(n).fill(0); e[j] = 1;
      const x = solveLinear(Areg, e);
      if (!x || x.some((v) => !isFinite(v))) { ok = false; break; }
      cols.push(x);
    }
    if (ok) {
      const inv = [];
      for (let i = 0; i < n; i++) { inv.push(new Array(n)); for (let j = 0; j < n; j++) inv[i][j] = cols[j][i]; }
      return inv;
    }
  }
  return null;
}

/* Seeded PRNG (mulberry32) + Box–Muller normal — [IMP-1] reproducible bootstrap */
function makeRng(seed) {
  let a = seed >>> 0;
  const u = () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let spare = null;
  const normal = () => {
    if (spare !== null) { const v = spare; spare = null; return v; }
    let u1 = 0, u2 = 0;
    do { u1 = u(); } while (u1 <= 1e-12);
    u2 = u();
    const r = Math.sqrt(-2 * Math.log(u1)), th = 2 * Math.PI * u2;
    spare = r * Math.sin(th);
    return r * Math.cos(th);
  };
  return { uniform: u, normal };
}

/* ----------------------------- data loading ------------------------------ */
/** rows: array of arrays (n × reps). Returns {mean, std} per row (np.std ddof=0). */
function safeMeanStd(rows) {
  const n = rows.length, mean = new Array(n), std = new Array(n);
  for (let i = 0; i < n; i++) {
    const r = rows[i];
    mean[i] = nanmean(r);
    std[i] = r.length > 1 ? stdArr(r) : 0.0;
  }
  return { mean, std };
}

/** Build LoadedData from APD arrays: count2D and power2D are n×reps row arrays. */
function buildLoadedFromAPD(count2D, power2D, meta) {
  const yc = safeMeanStd(count2D), xc = safeMeanStd(power2D);
  return {
    dataType: "APD", meta: meta || {},
    xRawAvg: xc.mean, xRawStd: xc.std, yRawAvg: yc.mean, yRawStd: yc.std,
    replicateCount: count2D.length ? count2D[0].length : 1,
    xReplicates: power2D, yReplicates: count2D,
    wavelengthInfo: null,
  };
}

/**
 * Build LoadedData from EMCCD arrays.
 * spectra: {n, reps, pix, data: Float64Array (n*reps*pix)}; power2D n×reps; wls length pix.
 */
function buildLoadedFromEMCCD(spectra, power2D, wls, bandMin, bandMax, meta) {
  const { n, reps, pix, data } = spectra;
  let i0 = nearestIndex(wls, bandMin), i1 = nearestIndex(wls, bandMax);
  if (i1 <= i0) { const t = Math.min(i0, i1); i1 = Math.min(t + 1, wls.length); i0 = t; }
  const integ = []; // n × reps
  for (let i = 0; i < n; i++) {
    const row = new Array(reps);
    for (let r = 0; r < reps; r++) {
      let s = 0;
      const base = (i * reps + r) * pix;
      for (let p = i0; p < i1; p++) s += data[base + p];
      row[r] = s;
    }
    integ.push(row);
  }
  const yc = safeMeanStd(integ);
  let xAvg, xStd, xReps;
  if (Array.isArray(power2D[0])) {
    const xc = safeMeanStd(power2D);
    xAvg = xc.mean; xStd = xc.std; xReps = power2D;
  } else {
    xAvg = Array.from(power2D); xStd = xAvg.map(() => 0); xReps = xAvg.map((v) => [v]);
  }
  // replicate-averaged spectra for the preview panel
  const specAvg = new Float64Array(n * pix), specStd = new Float64Array(n * pix);
  for (let i = 0; i < n; i++) {
    for (let p = 0; p < pix; p++) {
      let s = 0, s2 = 0;
      for (let r = 0; r < reps; r++) { const v = data[(i * reps + r) * pix + p]; s += v; s2 += v * v; }
      const m = s / reps;
      specAvg[i * pix + p] = m;
      specStd[i * pix + p] = Math.sqrt(Math.max(s2 / reps - m * m, 0));
    }
  }
  return {
    dataType: "EMCCD", meta: meta || {},
    xRawAvg: xAvg, xRawStd: xStd, yRawAvg: yc.mean, yRawStd: yc.std,
    replicateCount: reps, xReplicates: xReps, yReplicates: integ,
    wavelengthInfo: {
      wls: Array.from(wls), spectra, spectraAvg: specAvg, spectraStd: specStd,
      bandMin, bandMax, pix, n,
    },
  };
}
function nearestIndex(arr, target) {
  let bi = 0, bd = Infinity;
  for (let i = 0; i < arr.length; i++) { const d = Math.abs(arr[i] - target); if (d < bd) { bd = d; bi = i; } }
  return bi;
}

/* --------------------------- branch splitting ---------------------------- */
function detectScanMode(power) {
  const p = power, n = p.length;
  if (n < 5) return { mode: "up", peakIdx: argmaxFinite(p) };
  const peakIdx = argmaxFinite(p);
  if (peakIdx <= 1 || peakIdx >= n - 2) return { mode: "up", peakIdx };
  let incOk = 0, incN = 0, decOk = 0, decN = 0;
  for (let i = 1; i <= peakIdx; i++) { incN++; if (p[i] - p[i - 1] >= 0) incOk++; }
  for (let i = peakIdx + 1; i < n; i++) { decN++; if (p[i] - p[i - 1] <= 0) decOk++; }
  const incRatio = incN ? incOk / incN : 1, decRatio = decN ? decOk / decN : 0;
  const isUpDown = peakIdx < n - 2 && incRatio > 0.65 && decRatio > 0.65;
  return { mode: isUpDown ? "updown" : "up", peakIdx };
}
function sliceBranch(name, idx, loaded) {
  return {
    name, sourceIndices: idx,
    powerAvg: idx.map((i) => loaded.xRawAvg[i]),
    powerStd: idx.map((i) => loaded.xRawStd[i]),
    intensityAvg: idx.map((i) => loaded.yRawAvg[i]),
    intensityStd: idx.map((i) => loaded.yRawStd[i]),
    powerReplicates: loaded.xReplicates ? idx.map((i) => loaded.xReplicates[i]) : null,
    intensityReplicates: loaded.yReplicates ? idx.map((i) => loaded.yReplicates[i]) : null,
  };
}
function splitBranches(loaded) {
  const n = loaded.xRawAvg.length;
  let { mode, peakIdx } = detectScanMode(loaded.xRawAvg);
  const allIdx = Array.from({ length: n }, (_, i) => i);
  const upIdx = allIdx.slice(0, peakIdx + 1);
  let downBranch = null;
  if (mode === "updown" && peakIdx + 1 < n) {
    const downIdx = allIdx.slice(peakIdx);
    if (downIdx.length >= 3) downBranch = sliceBranch("down", downIdx, loaded);
  } else mode = "up";
  return {
    scanMode: mode, peakIndexAll: peakIdx,
    all: sliceBranch("all", allIdx, loaded),
    up: sliceBranch("up", upIdx.length >= 2 ? upIdx : allIdx, loaded),
    down: downBranch,
  };
}

/* ----------------- Levenberg–Marquardt with box constraints --------------- */
function levenbergMarquardt(residFn, theta0, lo, hi, opts) {
  const maxIter = opts?.maxIter ?? 200, ftol = opts?.ftol ?? 1e-11;
  const np = theta0.length;
  let theta = theta0.map((v, i) => clamp(v, lo[i], hi[i]));
  let r = residFn(theta);
  let cost = r.reduce((s, v) => s + v * v, 0);
  if (!isFinite(cost)) return { theta, cost: Infinity, iterations: 0 };
  let lambda = 1e-3;
  const stepScale = 1e-7;
  for (let iter = 0; iter < maxIter; iter++) {
    // numeric Jacobian (forward differences in θ)
    const m = r.length;
    const J = [];
    for (let j = 0; j < np; j++) {
      const h = Math.max(Math.abs(theta[j]) * stepScale, 1e-9);
      const tp = theta.slice();
      tp[j] = clamp(theta[j] + h, lo[j], hi[j]);
      const hEff = tp[j] - theta[j];
      if (Math.abs(hEff) < 1e-15) { J.push(new Array(m).fill(0)); continue; }
      const rp = residFn(tp);
      const col = new Array(m);
      for (let i = 0; i < m; i++) col[i] = (rp[i] - r[i]) / hEff;
      J.push(col);
    }
    // normal equations: (JtJ + λ·diag) δ = -Jt r
    const JtJ = [], Jtr = new Array(np).fill(0);
    for (let a = 0; a < np; a++) {
      JtJ.push(new Array(np).fill(0));
      for (let i = 0; i < m; i++) Jtr[a] += J[a][i] * r[i];
    }
    for (let a = 0; a < np; a++)
      for (let b = a; b < np; b++) {
        let s = 0;
        for (let i = 0; i < m; i++) s += J[a][i] * J[b][i];
        JtJ[a][b] = s; JtJ[b][a] = s;
      }
    let improved = false;
    for (let attempt = 0; attempt < 8; attempt++) {
      const A = JtJ.map((row, a) => row.map((v, b) => v + (a === b ? lambda * Math.max(v, 1e-12) : 0)));
      const delta = solveLinear(A, Jtr.map((v) => -v));
      if (!delta || delta.some((v) => !isFinite(v))) { lambda *= 10; continue; }
      const thetaNew = theta.map((v, i) => clamp(v + delta[i], lo[i], hi[i]));
      const rNew = residFn(thetaNew);
      const costNew = rNew.reduce((s, v) => s + v * v, 0);
      if (isFinite(costNew) && costNew < cost) {
        const rel = (cost - costNew) / Math.max(cost, 1e-300);
        theta = thetaNew; r = rNew; cost = costNew;
        lambda = Math.max(lambda / 3, 1e-12);
        improved = true;
        if (rel < ftol) return { theta, cost, iterations: iter + 1 };
        break;
      }
      lambda *= 10;
      if (lambda > 1e12) break;
    }
    if (!improved) break;
  }
  return { theta, cost, iterations: maxIter };
}

/* ----------------------- beam profile (2D Gaussian) ------------------------ */
/* ---------------- v3.15 · 비닝 배수 선택 (2-pass) --------------------------
 * 문제: 이전 규칙 `f = ceil(max(W,H)/320)` 은 **원본 크기만** 보고 긴 변을 늘 ~320 px 로
 * 줄였다. 빔이 실제로 몇 화소인지는 보지 않는다. 그래서 같은 빔이라도 촬영 경로에 따라
 * 전혀 다른 값이 나왔다 — 260921 실측에서 **같은 빔을 1:1 원본과 3× 화면캡쳐에서
 * ×2.466 다르게** 쟀다.
 *
 * 기전: 비닝은 폭 f 의 box convolution 이므로 σ_meas² ≈ σ_true² + f²/12.
 * 스팟이 f 에 가까워지면 측정되는 것은 빔이 아니라 box 다. 실측에서 f 에 따라 A_peak 가
 * 1.370 → 2.942 µm² 로 단조 증가한 것이 그 서명이다.
 *
 * 왜 지금까지 안 드러났나: 옛 파일은 1360×1024 캔버스에 **3× 확대된 뷰**였다. f=5 는
 * 같았지만 빔이 화소 기준 3배 커서 샘플링 FWHM ≈ 4.1 px 로 간신히 버텼다.
 * **규칙이 조용히 확대본에 맞춰져 있었다.**
 *
 * 해법: 보수적인 1차 비닝으로 스팟 크기를 먼저 재고, box 분산을 역보정해 원해상도
 * FWHM 을 추정한 뒤, 비닝 후에도 targetFwhm 이상이 남도록 f 를 고른다.
 * 이전 규칙은 **상한**으로만 남긴다 — 더 잘게 비닝하지는 않으므로 비용·메모리가
 * 나빠지지 않고, 1차 피팅이 실패하면 그대로 후퇴한다.
 *
 * 실측 검증(260921): 1:1 원본 → f=1 (A_peak 1.370, f=1 과 일치),
 * 3× 화면캡쳐 모사 → f=3 (1.323) — 두 경로 불일치가 ×2.466 → **×1.036** 으로 수렴.
 */
const BIN_TARGET_FWHM = 6;   // 비닝 후 확보할 최소 샘플링 FWHM (px)
/** f×f box 평균. NaN(주석·포화 마스크)은 제외하고, bin 전체가 NaN 이면 NaN 을 남긴다. */
function binDown(src, w0, h0, f) {
  if (f === 1) return { w: w0, h: h0, data: src };
  const w = Math.floor(w0 / f), h = Math.floor(h0 / f), o = new Float64Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let sum = 0, cnt = 0;
    for (let dy = 0; dy < f; dy++) for (let dx = 0; dx < f; dx++) {
      const v = src[(y * f + dy) * w0 + (x * f + dx)];
      if (isFinite(v)) { sum += v; cnt++; }
    }
    o[y * w + x] = cnt ? sum / cnt : NaN;
  }
  return { w, h, data: o };
}
/**
 * 반환: {f, by:"spot"|"cap"|"fallback", fCap, f0, fwhmFull}
 *   by="spot"     스팟 크기로 정함 (정상 경로)
 *   by="cap"      상한 규칙에 걸림 (스팟이 충분히 커서 더 줄여도 되지만 상한을 지킴)
 *   by="fallback" 1차 피팅 실패 → 이전 규칙 그대로
 */
function chooseBinFactor(src, w0, h0, opts) {
  const o = Object.assign({ satLevel: Infinity, targetFwhm: BIN_TARGET_FWHM, cap: null }, opts || {});
  const fCap = isFinite(o.cap) && o.cap >= 1 ? Math.floor(o.cap) : Math.max(1, Math.ceil(Math.max(w0, h0) / 320));
  if (fCap === 1) return { f: 1, by: "cap", fCap, f0: 1 };
  // 1차는 보수적으로 (상한의 약 절반 해상도) — 여기서 실패하면 이전 규칙으로 후퇴한다
  const f0 = Math.max(1, Math.min(fCap, Math.ceil(Math.max(w0, h0) / 640)));
  let p1 = null;
  try { p1 = fitBeam(binDown(src, w0, h0, f0), { satLevel: o.satLevel }); }
  catch (e) { p1 = null; }
  if (!p1 || !p1.success || !isFinite(p1.sx) || !isFinite(p1.sy)) return { f: fCap, by: "fallback", fCap, f0 };
  const sMin = Math.min(p1.sx, p1.sy) * f0;                             // 원해상도 px 로 환산
  const sTrue = Math.sqrt(Math.max(sMin * sMin - f0 * f0 / 12, 1e-6));  // box 분산 역보정
  const fwhmFull = 2.3548 * sTrue;
  const fSpot = Math.floor(fwhmFull / o.targetFwhm);
  const f = Math.max(1, Math.min(fCap, fSpot));
  return { f, by: fSpot >= fCap ? "cap" : "spot", fCap, f0, fwhmFull };
}

/**
 * Rotated elliptical 2D Gaussian + constant background:
 *   I(x,y) = B + A·exp(−[a·dx² + 2b·dx·dy + c·dy²]),  dx=x−x0, dy=y−y0
 *   a = cos²θ/(2σx²)+sin²θ/(2σy²), b = −sin2θ/(4σx²)+sin2θ/(4σy²),
 *   c = sin²θ/(2σx²)+cos²θ/(2σy²)
 * img: {w, h, data} row-major grayscale. opts.satLevel: pixels ≥ satLevel are
 * excluded from the fit (sensor clipping would bias σ downward).
 * Returns {B, A, x0, y0, sx, sy, theta, r2, nSat, nUsed, success}.
 */
function fitGaussian2D(img, opts) {
  const { w, h, data } = img;
  const satLevel = opts && isFinite(opts.satLevel) ? opts.satLevel : Infinity;
  const n = w * h;
  // moments-based initialization
  let vmin = Infinity, vmax = -Infinity;
  for (let i = 0; i < n; i++) { const v = data[i]; if (!isFinite(v)) continue; if (v < vmin) vmin = v; if (v > vmax) vmax = v; }
  // background: median of 1-px border
  const border = [];
  for (let x = 0; x < w; x++) { border.push(data[x], data[(h - 1) * w + x]); }
  for (let y = 0; y < h; y++) { border.push(data[y * w], data[y * w + w - 1]); }
  const B0 = nanmedian(border.filter(isFinite));
  let sw = 0, sx0 = 0, sy0 = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const raw = data[y * w + x];
    if (!isFinite(raw)) continue;
    const v = Math.max(raw - B0, 0);
    sw += v; sx0 += v * x; sy0 += v * y;
  }
  if (!(sw > 0)) return { success: false, message: "no signal above background" };
  const cx = sx0 / sw, cy = sy0 / sw;
  let mxx = 0, myy = 0, mxy = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const raw = data[y * w + x];
    if (!isFinite(raw)) continue;
    const v = Math.max(raw - B0, 0);
    mxx += v * (x - cx) * (x - cx); myy += v * (y - cy) * (y - cy); mxy += v * (x - cx) * (y - cy);
  }
  mxx /= sw; myy /= sw; mxy /= sw;
  const tr = mxx + myy, det = mxx * myy - mxy * mxy;
  const disc = Math.sqrt(Math.max(tr * tr / 4 - det, 0));
  const l1 = tr / 2 + disc, l2 = Math.max(tr / 2 - disc, 0.25);
  const theta0 = 0.5 * Math.atan2(2 * mxy, mxx - myy);
  const sx0i = Math.sqrt(Math.max(l1, 0.25)), sy0i = Math.sqrt(Math.max(l2, 0.25));
  const A0 = Math.max(vmax - B0, 1e-6);
  // masked pixel list (exclude saturated pixels)
  const px = [], pyy = [], pv = [];
  let nSat = 0, nMasked = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = data[y * w + x];
    if (!isFinite(v)) { nMasked++; continue; }
    if (v >= satLevel) { nSat++; continue; }
    px.push(x); pyy.push(y); pv.push(v);
  }
  const m = pv.length;
  if (m < 50) return { success: false, message: "too few unsaturated pixels" };
  const model = (theta) => {
    const [B, A, x0, y0, sx, sy, th] = theta;
    const c2 = Math.cos(th), s2 = Math.sin(th);
    const a = c2 * c2 / (2 * sx * sx) + s2 * s2 / (2 * sy * sy);
    // NOTE sign: expanding u=dx·cosθ+dy·sinθ, v=−dx·sinθ+dy·cosθ gives
    // +sinθcosθ/(2σx²) − sinθcosθ/(2σy²). The opposite sign (used before
    // v2.3.1) mirrors the reported θ, so the drawn ellipse tilted the wrong
    // way for rotated beams. Now matches the ISO moment convention.
    const b = s2 * c2 / (2 * sx * sx) - s2 * c2 / (2 * sy * sy);
    const cc = s2 * s2 / (2 * sx * sx) + c2 * c2 / (2 * sy * sy);
    return { B, A, a, b, cc, x0, y0 };
  };
  const residFn = (theta) => {
    const { B, A, a, b, cc, x0, y0 } = model(theta);
    const r = new Array(m);
    for (let i = 0; i < m; i++) {
      const dx = px[i] - x0, dy = pyy[i] - y0;
      const e = a * dx * dx + 2 * b * dx * dy + cc * dy * dy;
      r[i] = pv[i] - (B + A * (e < 60 ? Math.exp(-e) : 0));
    }
    return r;
  };
  const lo = [vmin - A0, A0 * 1e-3, 0, 0, 0.5, 0.5, -Math.PI / 2];
  const hi = [vmax, A0 * 4, w, h, Math.max(w, h), Math.max(w, h), Math.PI / 2];
  const t0 = [B0, A0, cx, cy, sx0i, sy0i, theta0];
  const res = levenbergMarquardt(residFn, t0, lo, hi, { maxIter: 120, ftol: 1e-10 });
  let [B, A, x0, y0, sx, sy, th] = res.theta;
  // canonicalize: sx = major axis
  if (sy > sx) { const t = sx; sx = sy; sy = t; th = th > 0 ? th - Math.PI / 2 : th + Math.PI / 2; }
  // r2 over used pixels
  const rr = residFn([B, A, x0, y0, sx, sy, th].length === 7 ? [B, A, x0, y0, sx, sy, th] : res.theta);
  let ssRes = 0, meanV = 0;
  for (const v of pv) meanV += v; meanV /= m;
  let ssTot = 0;
  for (let i = 0; i < m; i++) { ssRes += rr[i] * rr[i]; ssTot += (pv[i] - meanV) * (pv[i] - meanV); }
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : NaN;
  return { success: isFinite(sx) && isFinite(sy) && sx > 0 && sy > 0, B, A, x0, y0, sx, sy, theta: th, r2, nSat, nMasked, nUsed: m, cost: res.cost };
}

/**
 * Isolate the MAIN beam blob before Gaussian fitting.
 * Optical setups often produce secondary foci / ghost reflections (e.g. cover-
 * glass back-reflection) beside the main focus. A single-Gaussian fit over the
 * whole frame is biased by them, so: threshold above background → connected
 * components → keep the component with the largest integrated flux (the main
 * beam), mask every other significant blob (NaN, with 1-px dilation).
 * img: {w, h, data} (may already contain NaN from annotation removal).
 * Returns {data (new Float64Array), nBlobs, nGhosts, ghostPx, mainBlob:{cx,cy,flux}}.
 */
function isolateMainBlob(img, opts) {
  const { w, h } = img;
  const src = img.data;
  const n = w * h;
  // background level & scatter from border + low half
  const border = [];
  for (let x = 0; x < w; x++) { border.push(src[x], src[(h - 1) * w + x]); }
  for (let y = 0; y < h; y++) { border.push(src[y * w], src[y * w + w - 1]); }
  const B0 = nanmedian(border.filter(isFinite));
  const lows = [];
  for (let i = 0; i < n; i++) if (isFinite(src[i]) && src[i] <= B0) lows.push(B0 - src[i]);
  const sigBg = 1.4826 * nanmedian(lows) || 1;
  let vmax = -Infinity;
  for (let i = 0; i < n; i++) if (isFinite(src[i]) && src[i] > vmax) vmax = src[i];
  const thr = B0 + Math.max((opts && opts.fracThr ? opts.fracThr : 0.2) * (vmax - B0), 8 * sigBg);
  // connected components (4-neighbour) above threshold
  const label = new Int32Array(n).fill(-1);
  const comps = [];
  const stack = [];
  for (let i0 = 0; i0 < n; i0++) {
    if (label[i0] >= 0 || !isFinite(src[i0]) || src[i0] < thr) continue;
    const id = comps.length;
    const comp = { flux: 0, cx: 0, cy: 0, px: [] };
    comps.push(comp);
    stack.length = 0; stack.push(i0); label[i0] = id;
    while (stack.length) {
      const i = stack.pop();
      const v = src[i] - B0;
      comp.flux += v;
      const x = i % w, y = (i / w) | 0;
      comp.cx += v * x; comp.cy += v * y;
      comp.px.push(i);
      const nb = [];
      if (x > 0) nb.push(i - 1);
      if (x < w - 1) nb.push(i + 1);
      if (y > 0) nb.push(i - w);
      if (y < h - 1) nb.push(i + w);
      for (const j of nb) {
        if (label[j] < 0 && isFinite(src[j]) && src[j] >= thr) { label[j] = id; stack.push(j); }
      }
    }
    comp.cx /= Math.max(comp.flux, 1e-12); comp.cy /= Math.max(comp.flux, 1e-12);
  }
  const out = Float64Array.from(src);
  if (comps.length <= 1) return { data: out, nBlobs: comps.length, nGhosts: 0, ghostPx: 0, mainBlob: comps[0] || null };
  let main = comps[0];
  for (const c of comps) if (c.flux > main.flux) main = c;
  let nGhosts = 0, ghostPx = 0;
  for (const c of comps) {
    if (c === main) continue;
    // significant ghost: ≥1% of main flux OR ≥6 px; tiny specks also masked
    const significant = c.flux >= 0.01 * main.flux || c.px.length >= 6;
    if (!significant) continue;
    nGhosts++;
    for (const i of c.px) {
      out[i] = NaN; ghostPx++;
      const x = i % w, y = (i / w) | 0; // 1-px dilation
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx >= 0 && xx < w && yy >= 0 && yy < h) out[yy * w + xx] = NaN;
      }
    }
  }
  return { data: out, nBlobs: comps.length, nGhosts, ghostPx, mainBlob: { cx: main.cx, cy: main.cy, flux: main.flux } };
}

/* ---- NaN-aware helpers for the near-ghost splitter ---- */

/** Iteratively fill NaN holes with 3×3 neighbour means (for LABELING only —
 *  keeps annotation-masked holes from severing the main spot's connectivity). */
function fillNaNByDiffusion(src, w, h, maxIter) {
  const out = Float64Array.from(src);
  let remaining = 0;
  for (let i = 0; i < out.length; i++) if (!isFinite(out[i])) remaining++;
  for (let it = 0; it < (maxIter || 40) && remaining > 0; it++) {
    const nxt = Float64Array.from(out);
    let filled = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (isFinite(out[i])) continue;
      let s = 0, c = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || xx >= w || yy < 0 || yy >= h) continue;
        const v = out[yy * w + xx];
        if (isFinite(v)) { s += v; c++; }
      }
      if (c >= 3) { nxt[i] = s / c; filled++; }
    }
    out.set(nxt);
    remaining -= filled;
    if (!filled) break;
  }
  return out;
}

/** NaN-aware 3×3 box smoothing (noise suppression before watershed labeling). */
function box3(src, w, h) {
  const out = new Float64Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0, c = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || xx >= w || yy < 0 || yy >= h) continue;
      const v = src[yy * w + xx];
      if (isFinite(v)) { s += v; c++; }
    }
    out[y * w + x] = c ? s / c : NaN;
  }
  return out;
}

/**
 * Split TOUCHING blobs — reflections sitting right next to the main focus
 * merge with it at any single low threshold, so isolateMainBlob passes them
 * through. Here: watershed-by-immersion (pixels processed in descending
 * intensity; a pixel with no labeled neighbour founds a region at a local
 * max) with union-find prominence merging (a region whose peak rises less
 * than `prom` above the saddle where it meets a stronger region is the SAME
 * physical spot — handles saturation plateaus and annotation holes). The
 * region with the largest integrated flux is the main beam; every other
 * significant region is NaN-masked with 2-px dilation (to kill its wings).
 * Returns {data, nNear, nearPx, main:{cx,cy,flux,bbox}, B0, sigBg}.
 */
function splitTouchingBlobs(img, opts) {
  const { w, h } = img;
  const src = img.data;
  const n = w * h;
  const border = [];
  for (let x = 0; x < w; x++) { border.push(src[x], src[(h - 1) * w + x]); }
  for (let y = 0; y < h; y++) { border.push(src[y * w], src[y * w + w - 1]); }
  const B0 = nanmedian(border.filter(isFinite));
  const lows = [];
  for (let i = 0; i < n; i++) if (isFinite(src[i]) && src[i] <= B0) lows.push(B0 - src[i]);
  const sigBg = 1.4826 * nanmedian(lows) || 1;
  let vmax = -Infinity;
  for (let i = 0; i < n; i++) if (isFinite(src[i]) && src[i] > vmax) vmax = src[i];
  const none = () => ({ data: Float64Array.from(src), nNear: 0, nearPx: 0, main: null, B0, sigBg });
  if (!(vmax > B0)) return none();
  const thrLow = B0 + Math.max(((opts && opts.fracLow) || 0.12) * (vmax - B0), 6 * sigBg);
  const prom = Math.max(((opts && opts.promFrac) || 0.10) * (vmax - B0), 5 * sigBg);
  // labeling field: fill annotation holes, then smooth
  const sm = box3(fillNaNByDiffusion(src, w, h, 40), w, h);
  const idx = [];
  for (let i = 0; i < n; i++) if (isFinite(sm[i]) && sm[i] >= thrLow) idx.push(i);
  if (!idx.length) return none();
  idx.sort((a, b) => sm[b] - sm[a]);
  const label = new Int32Array(n).fill(-1);
  const parent = [], peakV = [];
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  for (const i of idx) {
    const x = i % w, y = (i / w) | 0;
    let best = -1, bestV = -Infinity;
    const roots = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || xx >= w || yy < 0 || yy >= h) continue;
      const j = yy * w + xx;
      if (label[j] < 0) continue;
      const r = find(label[j]);
      if (roots.indexOf(r) < 0) roots.push(r);
      if (sm[j] > bestV) { bestV = sm[j]; best = r; }
    }
    if (best < 0) { // local max → new region
      const id = parent.length;
      parent.push(id); peakV.push(sm[i]);
      label[i] = id;
    } else {
      label[i] = best;
      // this pixel is the saddle where two (or more) regions meet
      for (const r0 of roots) {
        const rA = find(r0), rB = find(best);
        if (rA === rB) continue;
        const weak = Math.min(peakV[rA], peakV[rB]);
        if (weak - sm[i] < prom) { // low prominence → merge (same spot)
          const keep = peakV[rA] >= peakV[rB] ? rA : rB;
          const drop = keep === rA ? rB : rA;
          parent[drop] = keep;
          peakV[keep] = Math.max(peakV[keep], peakV[drop]);
        }
      }
    }
  }
  // accumulate regions on resolved roots (flux over ORIGINAL finite values)
  const regs = new Map();
  for (const i of idx) {
    const r = find(label[i]);
    let g = regs.get(r);
    if (!g) { g = { flux: 0, cx: 0, cy: 0, px: [], x0: w, x1: 0, y0: h, y1: 0 }; regs.set(r, g); }
    const x = i % w, y = (i / w) | 0;
    const v = (isFinite(src[i]) ? src[i] : sm[i]) - B0;
    if (v > 0) { g.flux += v; g.cx += v * x; g.cy += v * y; }
    g.px.push(i);
    if (x < g.x0) g.x0 = x; if (x > g.x1) g.x1 = x;
    if (y < g.y0) g.y0 = y; if (y > g.y1) g.y1 = y;
  }
  let main = null;
  for (const g of regs.values()) if (!main || g.flux > main.flux) main = g;
  const out = Float64Array.from(src);
  let nNear = 0, nearPx = 0;
  for (const g of regs.values()) {
    if (g === main) continue;
    const significant = g.flux >= 0.01 * main.flux || g.px.length >= 6;
    if (!significant) continue;
    nNear++;
    for (const i of g.px) {
      const x = i % w, y = (i / w) | 0;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx >= 0 && xx < w && yy >= 0 && yy < h) {
          if (isFinite(out[yy * w + xx])) nearPx++;
          out[yy * w + xx] = NaN;
        }
      }
    }
  }
  const mflux = Math.max(main.flux, 1e-12);
  return {
    data: out, nNear, nearPx, B0, sigBg,
    main: { cx: main.cx / mflux, cy: main.cy / mflux, flux: main.flux, bbox: { x0: main.x0, x1: main.x1, y0: main.y0, y1: main.y1 } },
  };
}

/** Mask pixels whose POSITIVE residual vs the fitted Gaussian exceeds
 *  k·(robust σ) — leftover reflection wings / speckle the blob passes missed. */
function residualClipMask(img, fit, k, satLevel) {
  const { w, h, data } = img;
  const { B, A, x0, y0, sx, sy, theta } = fit;
  const c2 = Math.cos(theta), s2 = Math.sin(theta);
  const a = c2 * c2 / (2 * sx * sx) + s2 * s2 / (2 * sy * sy);
  const b = s2 * c2 / (2 * sx * sx) - s2 * c2 / (2 * sy * sy); // sign per fitGaussian2D note
  const cc = s2 * s2 / (2 * sx * sx) + c2 * c2 / (2 * sy * sy);
  const sat = isFinite(satLevel) ? satLevel : Infinity;
  const resid = new Float64Array(w * h).fill(NaN);
  const vals = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    const v = data[i];
    if (!isFinite(v) || v >= sat) continue;
    const dx = x - x0, dy = y - y0;
    const e = a * dx * dx + 2 * b * dx * dy + cc * dy * dy;
    const r = v - (B + A * (e < 60 ? Math.exp(-e) : 0));
    resid[i] = r; vals.push(r);
  }
  if (vals.length < 50) return null;
  const med = nanmedian(vals);
  const dev = vals.map((r) => Math.abs(r - med));
  const sig = 1.4826 * nanmedian(dev) || 1;
  const out = Float64Array.from(data);
  let nClip = 0;
  for (let i = 0; i < w * h; i++) {
    if (isFinite(resid[i]) && resid[i] - med > k * sig) { out[i] = NaN; nClip++; }
  }
  return { data: out, nClip, nFinite: vals.length };
}

/**
 * Remove column/row STREAK artifacts (CCD readout smear — a bright source
 * bleeds along the charge-transfer direction, producing a full-height
 * near-constant vertical band through the spot; looks like a spectrometer
 * 0th-order streak). The streak is y-independent per column, so the robust
 * per-column median (computed EXCLUDING the spot's row band) equals
 * background + streak; subtracting the positive excess flattens it without
 * touching the compact focus. Rows are handled symmetrically afterwards.
 * Correction is applied only when a streak is actually detected
 * (≥2 columns/rows with excess > 4·σ of the median profile).
 * Returns {data, nCols, nRows, colAmp, rowAmp}.
 */
function removeStreaks(img, opts) {
  const { w, h } = img;
  const src = img.data;
  const out = Float64Array.from(src);
  const res = { data: out, nCols: 0, nRows: 0, colAmp: 0, rowAmp: 0 };

  // rough spot location: peak of 5-smoothed row/col sums (to exclude its band)
  const rowSum = new Float64Array(h), colSum = new Float64Array(w);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = src[y * w + x];
    if (isFinite(v)) { rowSum[y] += v; colSum[x] += v; }
  }
  const smoothPeak = (arr) => {
    let best = 0, bi = 0;
    for (let i = 0; i < arr.length; i++) {
      let s = 0, c = 0;
      for (let j = Math.max(0, i - 2); j <= Math.min(arr.length - 1, i + 2); j++) { s += arr[j]; c++; }
      if (s / c > best) { best = s / c; bi = i; }
    }
    return bi;
  };
  const ySpot = smoothPeak(rowSum), xSpot = smoothPeak(colSum);
  const yBand = Math.max(Math.round(0.15 * h), 10);
  const xBand = Math.max(Math.round(0.15 * w), 10);

  const pass = (isCol) => {
    const nProf = isCol ? w : h, nAlong = isCol ? h : w;
    const spotC = isCol ? ySpot : xSpot;
    const band = isCol ? yBand : xBand;
    const med = new Float64Array(nProf).fill(NaN);
    const buf = [];
    for (let p = 0; p < nProf; p++) {
      buf.length = 0;
      for (let q = 0; q < nAlong; q++) {
        if (Math.abs(q - spotC) <= band) continue; // exclude spot band
        const v = isCol ? out[q * w + p] : out[p * w + q];
        if (isFinite(v)) buf.push(v);
      }
      if (buf.length >= Math.max(8, 0.3 * nAlong)) med[p] = nanmedian(buf);
    }
    const base = nanmedian(Array.from(med));
    if (!isFinite(base)) return null;
    const devs = [];
    for (let p = 0; p < nProf; p++) if (isFinite(med[p])) devs.push(Math.abs(med[p] - base));
    const sig = Math.max(1.4826 * nanmedian(devs), 1e-6);
    // 3-wide median smoothing of the excess profile (kill single-column noise)
    const exc = new Float64Array(nProf);
    for (let p = 0; p < nProf; p++) exc[p] = isFinite(med[p]) ? med[p] - base : 0;
    const excSm = new Float64Array(nProf);
    for (let p = 0; p < nProf; p++) {
      const a = exc[Math.max(0, p - 1)], b = exc[p], c = exc[Math.min(nProf - 1, p + 1)];
      excSm[p] = Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
    }
    let nDet = 0, amp = 0;
    for (let p = 0; p < nProf; p++) { if (excSm[p] > 4 * sig) nDet++; if (excSm[p] > amp) amp = excSm[p]; }
    if (nDet < 2) return null; // no real streak — leave untouched
    let nCorr = 0;
    for (let p = 0; p < nProf; p++) {
      const e = excSm[p];
      if (!(e > 2 * sig)) continue; // soft threshold once streak confirmed
      nCorr++;
      for (let q = 0; q < nAlong; q++) {
        const i = isCol ? q * w + p : p * w + q;
        if (isFinite(out[i])) out[i] -= e;
      }
    }
    return { nCorr, amp };
  };

  const c1 = pass(true);
  if (c1) { res.nCols = c1.nCorr; res.colAmp = c1.amp; }
  const c2 = pass(false);
  if (c2) { res.nRows = c2.nCorr; res.rowAmp = c2.amp; }
  return res;
}

/**
 * Full beam-image fitting pipeline (use this instead of calling the stages
 * by hand):
 *   1. isolateMainBlob    — mask far-away ghost reflections (separate blobs)
 *   2. splitTouchingBlobs — split & mask reflections TOUCHING the main spot
 *   3. ROI crop around the main region (background structure far from the
 *      beam stops polluting B and R²)
 *   4. fitGaussian2D, then up to 2 residual-clip refits (mask +4σ positive
 *      outliers — leftover reflection wings; capped at 15% of pixels)
 * Returns the fit in FULL-FRAME pixel coordinates, plus
 * {nGhosts, ghostPx, nNear, nearPx, nClip, roi, maskedData}.
 */
function fitBeam(img, opts) {
  const o = opts || {};
  const { w, h } = img;
  // saturation must be masked BEFORE any correction — subtracting a streak
  // would drop clipped pixels below satLevel and let them re-enter the fit
  // at wrong (clipped) values
  const sat = isFinite(o.satLevel) ? o.satLevel : Infinity;
  const work = Float64Array.from(img.data);
  let nSatPre = 0;
  for (let i = 0; i < work.length; i++) {
    if (isFinite(work[i]) && work[i] >= sat) { work[i] = NaN; nSatPre++; }
  }
  // 0. CCD readout-smear streak removal (vertical/horizontal bands)
  const stk = removeStreaks({ w, h, data: work }, o);
  const iso = isolateMainBlob({ w, h, data: stk.data }, o);
  const spl = splitTouchingBlobs({ w, h, data: iso.data }, o);
  let sub = { w, h, data: spl.data }, ox = 0, oy = 0, roi = null;
  if (spl.main) {
    const bb = spl.main.bbox;
    const half = Math.max(bb.x1 - bb.x0 + 1, bb.y1 - bb.y0 + 1);
    const mx = Math.max(Math.round(1.5 * half), 16);
    const x0 = Math.max(0, bb.x0 - mx), x1 = Math.min(w - 1, bb.x1 + mx);
    const y0 = Math.max(0, bb.y0 - mx), y1 = Math.min(h - 1, bb.y1 + mx);
    const sw = x1 - x0 + 1, sh = y1 - y0 + 1;
    if (sw >= 24 && sh >= 24 && sw * sh < 0.9 * w * h) {
      const sd = new Float64Array(sw * sh);
      for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) sd[y * sw + x] = spl.data[(y + y0) * w + (x + x0)];
      sub = { w: sw, h: sh, data: sd };
      ox = x0; oy = y0;
      roi = { x0, y0, x1, y1 };
    }
  }
  let fit = fitGaussian2D(sub, o);
  let nClip = 0;
  for (let pass = 0; pass < 2 && fit.success; pass++) {
    const rc = residualClipMask(sub, fit, 4, o.satLevel);
    if (!rc || rc.nClip === 0) break;
    if (rc.nClip > 0.15 * rc.nFinite) break; // model itself is off — don't self-serve
    sub = { w: sub.w, h: sub.h, data: rc.data };
    nClip += rc.nClip;
    const f2 = fitGaussian2D(sub, o);
    if (!f2.success) break;
    fit = f2;
  }
  if (fit.success) { fit.x0 += ox; fit.y0 += oy; }
  fit.nGhosts = iso.nGhosts; fit.ghostPx = iso.ghostPx;
  fit.nNear = spl.nNear; fit.nearPx = spl.nearPx;
  fit.nClip = nClip;
  fit.roi = roi;
  fit.nSat = nSatPre;
  // ISO 11146 second-moment (rotated D4σ) — model-free cross-check on the
  // same corrected frame the Gaussian fit used
  try { fit.moments = momentsD4Sigma({ w, h, data: spl.data }, o); }
  catch (e) { fit.moments = null; }
  if (fit.moments && fit.success && fit.sx > 0) {
    // non-Gaussianity: D4σ area vs fitted 1/e² area (1.0 = perfectly Gaussian)
    fit.d4sAreaRatio = (fit.moments.sigmaMajor * fit.moments.sigmaMinor) / (fit.sx * fit.sy);
  }
  // ---- v3.9: curve of growth — core 밖에 빛이 얼마나 있는가 ----
  // 파워밀도는 I0 = P / A_peak 로 계산되는데, 이 식은 **측정한 P 전부가 core 에
  // 들어간다**고 가정한다. core 밖에 halo 가 있으면 그만큼 과대평가된다.
  //
  // 순진하게 "배경 위 양수 픽셀의 합"을 쓰면 안 된다 — 잡음의 양수 쪽만 세는
  // rectification 때문에 빈 프레임에서도 거대한 가짜 플럭스가 나온다(순수 Gaussian
  // 에서 core 비율 7.5% 로 측정됨). 그래서 **부호를 살려서** 원형 조리개로 적분하고,
  // 배경은 바깥 annulus 에서 다시 잡는다. 잡음은 상쇄되고 halo 만 남는다.
  //
  // 주의: 이미지가 산란면을 결상한 것이면 halo 는 결상경로 artifact 일 수 있다.
  // 값만 내고 자동 보정하지 않는다 — 판단은 호출자가 한다.
  if (fit.success && isFinite(fit.A) && fit.sx > 0 && fit.sy > 0) {
    const sg = Math.sqrt(fit.sx * fit.sy);
    const cx = fit.x0, cy = fit.y0;
    const D = spl.data;
    const rMaxFit = Math.min(cx, cy, w - 1 - cx, h - 1 - cy);   // 프레임에 갇히지 않는 최대 반경
    const rOut = Math.min(rMaxFit, 14 * sg);
    // 배경: rOut 바깥 annulus (없으면 프레임 테두리)
    const ring = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const v = D[y * w + x];
      if (!isFinite(v)) continue;
      const dx = x - cx, dy = y - cy, r = Math.sqrt(dx * dx + dy * dy);
      if (r > rOut && r <= 1.35 * rOut) ring.push(v);
    }
    const bg = ring.length >= 30 ? nanmedian(ring) : (isFinite(fit.B) ? fit.B : 0);
    const coreFlux = 2 * Math.PI * fit.A * fit.sx * fit.sy;   // 적합 Gaussian 의 해석적 적분
    const growth = [];
    for (const kR of [1, 2, 3, 4, 6, 8, 10, 14]) {
      const R = kR * sg;
      if (R > rMaxFit) break;
      let sum = 0, npx = 0;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const v = D[y * w + x];
        if (!isFinite(v)) continue;
        const dx = x - cx, dy = y - cy;
        if (dx * dx + dy * dy > R * R) continue;
        sum += v - bg; npx++;                                  // **부호 유지** — 잡음 상쇄
      }
      growth.push({ kSigma: kR, R, flux: sum, nPx: npx,
                    ratio: coreFlux > 0 ? sum / coreFlux : NaN });
    }
    fit.growth = growth;
    fit.coreFlux = coreFlux;
    fit.growthBg = bg;
    // halo 지표: 가장 바깥 조리개의 포함 플럭스 / core 플럭스.
    // 순수 Gaussian 이면 ≈ 1.00 (3σ 안에 98.9%, 그 밖은 무시 가능).
    const last = growth.length ? growth[growth.length - 1] : null;
    fit.enclosedRatio = last ? last.ratio : NaN;
    fit.coreFrac = last && isFinite(last.ratio) && last.ratio > 0 ? 1 / last.ratio : NaN;
    fit.growthRadiusSigma = last ? last.kSigma : NaN;
  }
  fit.nStreakCols = stk.nCols; fit.nStreakRows = stk.nRows;
  fit.streakColAmp = stk.colAmp; fit.streakRowAmp = stk.rowAmp;
  fit.maskedData = spl.data; // full-frame, streak-corrected + ghosts masked (preview)
  return fit;
}

/**
 * ISO 11146 second-moment beam widths — the MODEL-FREE (rotated) D4σ.
 *
 * Why rotation must be handled: the naive per-camera-axis D4σ ignores the
 * cross moment σxy and reports the widths of the ellipse's BOUNDING BOX, so
 * the implied area σx·σy overestimates the true σa·σb (e.g. +25% for a 2:1
 * ellipse at 45°) and the peak irradiance is underestimated by the same
 * factor. ISO 11146 fixes this by diagonalising the second-moment matrix:
 *
 *   σx² = Σ I·(x−x̄)²/ΣI,  σy² = Σ I·(y−ȳ)²/ΣI,  σxy = Σ I·(x−x̄)(y−ȳ)/ΣI
 *   γ  = sign(σx²−σy²)
 *   dσa = 2√2 · [ (σx²+σy²) + γ·√((σx²−σy²)² + 4σxy²) ]^½
 *   dσb = 2√2 · [ (σx²+σy²) − γ·√((σx²−σy²)² + 4σxy²) ]^½
 *   φ   = ½·atan2(2σxy, σx²−σy²)
 *
 * Unlike the Gaussian fit this makes NO shape assumption, so comparing the
 * two is a direct non-Gaussianity test (wings/pedestal/flat-top inflate D4σ).
 * Second moments are r²-weighted and therefore noise-sensitive, so ISO
 * mandates background subtraction and a finite integration aperture: here the
 * aperture is an ellipse of `apertureFactor`× the D4σ diameters centred on
 * the centroid, iterated to convergence, with the background re-estimated
 * from the annulus outside it each round.
 *
 * img: {w, h, data} — should already be streak/ghost/annotation corrected
 * (NaN = excluded). Returns null if there is no usable signal.
 */
function momentsD4Sigma(img, opts) {
  const o = opts || {};
  const { w, h } = img;
  const src = img.data;
  const n = w * h;
  // Aperture size: ISO 11146-3 suggests ~3× the beam diameter, but second
  // moments are r²-weighted so the (signal-free) outer ring only injects
  // variance. Measured on synthetic rotated Gaussians (12 seeds × 3 SNRs):
  //   apF 1.5 → bias −4.5% (tail truncated)      · sd 0.05–0.95%
  //   apF 2.0 → bias −0.2…+0.1% (unbiased)       · sd 0.17–2.3%   ← default
  //   apF 3.0 → bias −0.3…+0.6%                  · sd 0.55–8.7%
  // 2× keeps ISO's unbiasedness at 3–4× lower dispersion; still configurable.
  const apF = isFinite(o.apertureFactor) ? o.apertureFactor : 2;
  const maxIter = o.maxIter || 30;

  // --- initial background from the frame border ---
  const border = [];
  for (let x = 0; x < w; x++) { border.push(src[x], src[(h - 1) * w + x]); }
  for (let y = 0; y < h; y++) { border.push(src[y * w], src[y * w + w - 1]); }
  let B = nanmedian(border.filter(isFinite));
  if (!isFinite(B)) B = 0;
  const lows = [];
  for (let i = 0; i < n; i++) if (isFinite(src[i]) && src[i] <= B) lows.push(B - src[i]);
  const sigBg = 1.4826 * nanmedian(lows) || 1;

  // --- seed centroid/size from a thresholded first pass ---
  let vmax = -Infinity;
  for (let i = 0; i < n; i++) if (isFinite(src[i]) && src[i] > vmax) vmax = src[i];
  if (!(vmax > B)) return null;
  const thr = B + Math.max(0.1 * (vmax - B), 5 * sigBg);
  let s0 = 0, sx0 = 0, sy0 = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = src[y * w + x];
    if (!isFinite(v) || v < thr) continue;
    const q = v - B;
    s0 += q; sx0 += q * x; sy0 += q * y;
  }
  if (!(s0 > 0)) return null;
  let cx = sx0 / s0, cy = sy0 / s0;
  let mxx = 0, myy = 0, mxy = 0, sw = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = src[y * w + x];
    if (!isFinite(v) || v < thr) continue;
    const q = v - B, dx = x - cx, dy = y - cy;
    sw += q; mxx += q * dx * dx; myy += q * dy * dy; mxy += q * dx * dy;
  }
  mxx /= sw; myy /= sw; mxy /= sw;

  // --- ISO iteration: aperture → moments → aperture … ---
  let converged = false, iter = 0, apertureClipped = false;
  let nMasked = 0, nInside = 0, fluxIn = 0;
  let prevA = Infinity, prevB2 = Infinity;
  let sa2 = mxx, sb2 = myy, phi = 0;
  for (; iter < maxIter; iter++) {
    // principal decomposition of the current moment matrix
    const sum = mxx + myy, diff = mxx - myy;
    const g = diff >= 0 ? 1 : -1;
    const root = Math.sqrt(diff * diff + 4 * mxy * mxy);
    sa2 = Math.max(0.5 * (sum + g * root), 0.01);
    sb2 = Math.max(0.5 * (sum - g * root), 0.01);
    phi = 0.5 * Math.atan2(2 * mxy, diff);
    const sa = Math.sqrt(sa2), sb = Math.sqrt(sb2);
    // aperture semi-axes: apF × D4σ / 2 = apF × 2σ
    let ra = apF * 2 * sa, rb = apF * 2 * sb;
    const rMax = Math.max(w, h);
    if (ra > rMax || rb > rMax) { ra = Math.min(ra, rMax); rb = Math.min(rb, rMax); apertureClipped = true; }
    const ct = Math.cos(phi), st = Math.sin(phi);
    // background from the annulus just outside the aperture (1.0–1.4×)
    const ring = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const v = src[y * w + x];
      if (!isFinite(v)) continue;
      const dx = x - cx, dy = y - cy;
      const u = (dx * ct + dy * st) / ra, t = (-dx * st + dy * ct) / rb;
      const r2 = u * u + t * t;
      if (r2 > 1 && r2 <= 1.96) ring.push(v);
    }
    if (ring.length >= 30) B = nanmedian(ring);
    // moments inside the aperture (signed values — no clipping: clipping the
    // negative noise excursions would bias the background upward)
    let S = 0, Sx = 0, Sy = 0;
    nInside = 0; nMasked = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const dx = x - cx, dy = y - cy;
      const u = (dx * ct + dy * st) / ra, t = (-dx * st + dy * ct) / rb;
      if (u * u + t * t > 1) continue;
      nInside++;
      const v = src[y * w + x];
      if (!isFinite(v)) { nMasked++; continue; }
      const q = v - B;
      S += q; Sx += q * x; Sy += q * y;
    }
    if (!(S > 0)) return null;
    const ncx = Sx / S, ncy = Sy / S;
    let nxx = 0, nyy = 0, nxy = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const dx0 = x - cx, dy0 = y - cy;
      const u = (dx0 * ct + dy0 * st) / ra, t = (-dx0 * st + dy0 * ct) / rb;
      if (u * u + t * t > 1) continue;
      const v = src[y * w + x];
      if (!isFinite(v)) continue;
      const q = v - B, dx = x - ncx, dy = y - ncy;
      nxx += q * dx * dx; nyy += q * dy * dy; nxy += q * dx * dy;
    }
    cx = ncx; cy = ncy; fluxIn = S;
    mxx = nxx / S; myy = nyy / S; mxy = nxy / S;
    if (!(isFinite(mxx) && isFinite(myy) && isFinite(mxy)) || mxx <= 0 || myy <= 0) return null;
    const dA = Math.abs(Math.sqrt(Math.max(sa2, 0)) - prevA) / Math.max(prevA, 1e-9);
    const dB = Math.abs(Math.sqrt(Math.max(sb2, 0)) - prevB2) / Math.max(prevB2, 1e-9);
    prevA = Math.sqrt(Math.max(sa2, 0)); prevB2 = Math.sqrt(Math.max(sb2, 0));
    if (dA < 1e-3 && dB < 1e-3) { converged = true; break; }
  }
  // final principal decomposition
  const sum = mxx + myy, diff = mxx - myy;
  const g = diff >= 0 ? 1 : -1;
  const root = Math.sqrt(diff * diff + 4 * mxy * mxy);
  const sigA = Math.sqrt(Math.max(0.5 * (sum + g * root), 0));
  const sigB = Math.sqrt(Math.max(0.5 * (sum - g * root), 0));
  const theta = 0.5 * Math.atan2(2 * mxy, diff);
  return {
    cx, cy,
    sigmaMajor: sigA, sigmaMinor: sigB, theta,      // principal axes (rotated)
    d4sMajor: 4 * sigA, d4sMinor: 4 * sigB,
    sigmaXlab: Math.sqrt(Math.max(mxx, 0)),         // camera-axis (naive) values
    sigmaYlab: Math.sqrt(Math.max(myy, 0)),
    sigmaXY: mxy,
    // how much a rotation-blind D4σ would overestimate the effective area
    naiveAreaRatio: (sigA * sigB) > 0 ? Math.sqrt(mxx * myy) / (sigA * sigB) : NaN,
    background: B, sigBg, converged, iter: iter + 1,
    apertureClipped, maskedFraction: nInside ? nMasked / nInside : 0,
    flux: fluxIn,
  };
}

/**
 * Physical beam metrics from a pixel-space fit. umPerPx converts to µm.
 * Radii: w = 2σ (1/e² intensity radius). FWHM = 2.3548σ.
 * Areas (µm²) with matching mean-density definitions:
 *   peak:  A = π·wx·wy/2      → I_peak   = P / A   (elliptical Gaussian peak)
 *   e2avg: A = π·wx·wy        → I_avg    = 0.865·P / A (86.5% power inside 1/e²)
 *   fwhm:  A = π·FWHMx·FWHMy/4 → I_avg   = 0.5·P / A  (50% power inside FWHM)
 */
function beamMetrics(fit, umPerPx) {
  const s = isFinite(umPerPx) && umPerPx > 0 ? umPerPx : 1;
  const sxu = fit.sx * s, syu = fit.sy * s;
  const wx = 2 * sxu, wy = 2 * syu;                 // 1/e² radii, µm
  const fwx = 2.354820045 * sxu, fwy = 2.354820045 * syu;
  const areaPeak = Math.PI * wx * wy / 2;
  const area1e2 = Math.PI * wx * wy;
  const areaFwhm = Math.PI * fwx * fwy / 4;
  return {
    umPerPx: s, sigmaXum: sxu, sigmaYum: syu, thetaDeg: fit.theta * 180 / Math.PI,
    d1e2Xum: 2 * wx, d1e2Yum: 2 * wy,               // 1/e² diameters = 4σ
    fwhmXum: fwx, fwhmYum: fwy,
    areaPeakUm2: areaPeak, area1e2Um2: area1e2, areaFwhmUm2: areaFwhm,
    powerFraction: { peak: 1.0, e2avg: 0.8646647, fwhm: 0.5 },
  };
}

/* ============================================================================
 * INNO Prism — 업로드 이미지 무결성 검사 (image QA)
 *
 * 목적: 빔 보정에 쓰이는 이미지가 "카메라 원본 1:1 · 선형 ADU" 라는 전제를
 *       만족하는지 검사한다. 두 검사 모두 **빔의 모양에 의존하지 않고**
 *       노이즈 통계만 쓰므로 특정 데이터에 매몰되지 않는다.
 *
 *  A. 업스케일 검출 (upscale / resampling)
 *     화면 캡쳐는 표시 배율만큼 보간되어 저장된다. 원래 독립이던 픽셀 노이즈가
 *     N px 에 걸쳐 상관되므로, 배경 노이즈의 variogram 으로 상관길이 L 을 재면
 *     L ≈ 표시 배율이 된다. µm/px 가 L 배 틀리므로 면적은 L² 배 틀린다.
 *
 *  B. 비선형성 검출 (gamma / auto-contrast / tone mapping)
 *     선형 검출기의 잡음은  Var(I) = g·I + σ_read²  — 신호에 대해 **아핀**이고
 *     기울기 g > 0 이다. 따라서 밝기에 따라 분산이 *감소*하는 영상은 어떤 선형
 *     검출기로도 만들어질 수 없다. 화면 캡쳐에 씌워진 감마(y = I^{1/γ})는 정확히
 *     그 감소를 만든다(멱법칙으로 보면 기울기 β = 2 − γ). 이 판정은 기울기의
 *     **부호**만 쓰므로, 업스케일이 분산을 상수배 줄이는 것에 영향받지 않는다.
 *
 *     검출 한계(합성 격자 22셀로 확인, 임의 문턱 없음):
 *       · γ ≳ 2.0 : 확정 검출          · 1 < γ ≲ 1.6 : read noise 지배와
 *       구분 불가 → 판정 보류 또는 미탐. 이 한계를 숨기지 않고 보고한다.
 *
 *  두 검사 모두 판정 근거가 부족하면 "판정 불가"를 반환한다 — 억지로 값을
 *  내놓지 않는 것이 이 모듈의 계약이다.
 *
 *  알려진 한계: bilinear 리샘플과 강한 톤커브가 겹치면 L 이 ~35% 과대평가된다.
 *  그래서 L 을 µm/px 보정에 쓰라는 **권고는 선형성이 확인된 경우로 한정**한다.
 * ========================================================================== */

const UPSCALE_DMAX = 14;      // variogram 최대 lag
const UPSCALE_WARN = 1.25;    // L 이 이 값을 넘으면 원본이 아님
const SEG_MIN = 40;           // 배경 구간 최소 길이 (px)
const LIN_MIN_DECADES = 0.8;  // 신호 동적범위 최소 (dec)
const LIN_R2_MIN = 0.85;      // 아핀 모델(Var = a + b·m) 적합 하한
const LIN_VAR_RATIO_MIN = 2;  // 분산이 이 배수 이상 변해야 기울기 부호를 신뢰할 수 있다
const LIN_SIGMA_MIN = 0.45;   // σ̂ 가 (양자화 계단의) 이 배수보다 작으면 양자화 지배 → 폐기
const QUANT_VAR = 1 / 12;     // 계단 1 의 양자화 분산 바닥 (균일분포)

function qMedian(a) {
  if (!a.length) return NaN;
  const b = Float64Array.from(a).sort();
  const n = b.length, h = n >> 1;
  return n % 2 ? b[h] : 0.5 * (b[h - 1] + b[h]);
}
function qPercentile(a, p) {
  if (!a.length) return NaN;
  const b = Float64Array.from(a).sort();
  const i = Math.min(b.length - 1, Math.max(0, Math.round((b.length - 1) * p)));
  return b[i];
}

/* ---------------------------------------------------------------- A. 업스케일 */
/** 한 방향(행 또는 열)에 대해 배경 구간의 variogram γ(d)=½E[(x_i−x_{i+d})²] 누적 */
function accumVariogram(getLine, getMask, nLines, lineLen, dmax, acc, cnt, stride) {
  const st = Math.max(1, stride | 0);
  for (let L = 0; L < nLines; L += st) {
    const v = getLine(L), mk = getMask(L);
    let s = 0;
    while (s < lineLen) {
      if (!mk[s]) { s++; continue; }
      let e = s;
      while (e < lineLen && mk[e]) e++;
      if (e - s >= SEG_MIN) {
        // 구간 내 최소자승 직선 제거 — 배경 기울기가 γ(d) 의 tail 을 부풀리는 것을 막는다
        const n = e - s;
        let sx = 0, sy = 0, sxx = 0, sxy = 0;
        for (let i = s; i < e; i++) { const t = i - s; sx += t; sy += v[i]; sxx += t * t; sxy += t * v[i]; }
        const den = n * sxx - sx * sx;
        const sl = Math.abs(den) > 1e-12 ? (n * sxy - sx * sy) / den : 0;
        const ic = (sy - sl * sx) / n;
        const r = new Float64Array(n);
        for (let i = s; i < e; i++) r[i - s] = v[i] - (ic + sl * (i - s));
        /* 2차 차분 γ₂(d) = E[(x_{i−d} − 2x_i + x_{i+d})²]/6.
         * 1차 차분은 국소 기울기만 지우지만 2차 차분은 곡률까지 지우므로,
         * 배경에 남은 빔 날개(매끄러운 곡면)가 tail 을 부풀리는 것을 크게 억제한다. */
        for (let d = 1; d <= dmax; d++) {
          for (let i = d; i + d < n; i++) {
            const t = r[i - d] - 2 * r[i] + r[i + d];
            acc[d] += t * t; cnt[d]++;
          }
        }
      }
      s = e;
    }
  }
}

/** 배경 노이즈 상관길이 L 추정. gray 는 Float64Array(w*h), NaN 은 마스크. */
function estimateUpscale(gray, w, h) {
  const fin = [];
  for (let i = 0; i < gray.length; i++) if (isFinite(gray[i])) fin.push(gray[i]);
  if (fin.length < 5000) return { ok: false, applicable: false, reason: "유효 픽셀 부족" };
  /* 배경 선택은 **흐린 영상** 위에서 한다. 원본에서 분위수로 자르면 균일한 배경이
   * 문턱을 가로질러 얼룩덜룩해져 연속 구간이 끊기고, 문턱을 느슨하게 하면 빔 날개가
   * 섞여 그 매끄러운 구조가 variogram 의 tail 을 부풀려 L 을 과대평가한다.
   * 흐린 영상의 median + 5σ 는 잡음에 흔들리지 않으면서 빔 발자국만 정확히 뺀다. */
  const Sb = qBoxBlur(gray, w, h, 4);
  const sf = [];
  for (let i = 0; i < Sb.length; i++) if (isFinite(Sb[i])) sf.push(Sb[i]);
  if (sf.length < 5000) return { ok: false, reason: "유효 픽셀 부족" };
  const smed = qMedian(sf);
  const smad = qMedian(sf.map(v => Math.abs(v - smed))) * 1.4826;
  const bgHi = smed + 5 * Math.max(smad, 0.15);
  const bgMask = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i++)
    bgMask[i] = (isFinite(gray[i]) && isFinite(Sb[i]) && Sb[i] <= bgHi && gray[i] < 250) ? 1 : 0;

  const dmax = UPSCALE_DMAX;
  const mk = () => ({ a: new Float64Array(dmax + 1), c: new Float64Array(dmax + 1) });
  const X = mk(), Y = mk();
  const rowBuf = new Float64Array(w), rowMk = new Uint8Array(w);
  const colBuf = new Float64Array(h), colMk = new Uint8Array(h);
  accumVariogram(
    (r) => { for (let x = 0; x < w; x++) rowBuf[x] = gray[r * w + x]; return rowBuf; },
    (r) => { for (let x = 0; x < w; x++) rowMk[x] = bgMask[r * w + x]; return rowMk; },
    h, w, dmax, X.a, X.c, Math.max(1, Math.floor(h / 400)));
  accumVariogram(
    (c) => { for (let y = 0; y < h; y++) colBuf[y] = gray[y * w + c]; return colBuf; },
    (c) => { for (let y = 0; y < h; y++) colMk[y] = bgMask[y * w + c]; return colMk; },
    w, h, dmax, Y.a, Y.c, Math.max(1, Math.floor(w / 400)));

  /* ρ(d) ≈ max(0, 1 − d/U) — nearest·bilinear 모두 이 삼각형에 잘 맞는다.
   * 이른 절단(threshold crossing) 대신 U 를 직접 적합해 잡음에 강건하게 만든다. */
  const lenOf = (A) => {
    const g = new Array(dmax + 1).fill(NaN);
    for (let d = 1; d <= dmax; d++) if (A.c[d] > 200) g[d] = A.a[d] / A.c[d] / 6;
    const tail = [];
    for (let d = dmax - 4; d <= dmax; d++) if (isFinite(g[d])) tail.push(g[d]);
    if (tail.length < 3) return { L: NaN, rho: g };
    const gInf = qMedian(tail);
    if (!(gInf > 0)) return { L: NaN, rho: g };
    /* 정규화 γ₂(d)/σ². 상관 ρ 를 가진 잡음에서
     *   γ₂(d)/σ² = 1 − (4/3)ρ(d) + (1/3)ρ(2d),   ρ(d) ≈ max(0, 1 − d/U)
     * 이 값을 U 에 대해 직접 적합한다 (d ≥ U 에서 1 로 수렴). */
    const q = new Array(dmax + 1).fill(NaN);
    for (let d = 1; d <= dmax; d++) if (isFinite(g[d])) q[d] = g[d] / gInf;
    const T = (d, U) => Math.max(0, 1 - d / U);
    const model = (d, U) => 1 - (4 / 3) * T(d, U) + (1 / 3) * T(2 * d, U);
    let best = 1, bestE = Infinity;
    for (let U = 1; U <= 8.0001; U += 0.02) {
      let e = 0, n = 0;
      for (let d = 1; d <= dmax; d++) {
        if (!isFinite(q[d])) continue;
        const r = q[d] - model(d, U); e += r * r; n++;
      }
      if (n >= 4 && e / n < bestE) { bestE = e / n; best = U; }
    }
    // 보고용 ρ(d) 는 삼각모형 기준으로 환산
    const rho = new Array(dmax + 1).fill(NaN);
    for (let d = 1; d <= dmax; d++) if (isFinite(q[d])) rho[d] = T(d, best);
    return { L: best, rho, q, rmse: Math.sqrt(bestE) };
  };
  const rx = lenOf(X), ry = lenOf(Y);
  if (!isFinite(rx.L) || !isFinite(ry.L)) return { ok: false, reason: "배경 구간 부족" };
  const L = Math.sqrt(rx.L * ry.L);
  return {
    ok: true, L, Lx: rx.L, Ly: ry.L, rhoX: rx.rho, rhoY: ry.rho,
    rmseX: rx.rmse, rmseY: ry.rmse, qX: rx.q, qY: ry.q,
    bgMask,
    upscaled: L >= UPSCALE_WARN,
    factor: L >= UPSCALE_WARN ? Math.round(L) : 1,
    anisotropic: Math.abs(rx.L - ry.L) / L > 0.35
  };
}

/* ---------------------------------------------------- A′. 블록 압축 검출 */
/* JPEG 는 8×8 DCT 블록 단위로 양자화하므로 블록 경계에서 픽셀 차이가 커지고
 * 블록 내부는 평활해진다. 이 8 px 주기가 있으면 잡음 상관이 인위적으로 늘어나
 * **업스케일 검출기가 오탐**한다(합성 대조군에서 무손실 L=1.00 → JPEG q85 L=2.19).
 * 따라서 블록 압축이 보이면 업스케일 배수를 보고하지 않고 판정을 보류한다.
 * 선형성 검사는 같은 대조군에서 JPEG 에 영향받지 않았으므로 그대로 유효하다. */
const BLOCK_N = 8;
const BLOCK_WARN = 1.5;       // max/median 비가 이보다 크면 블록 경계 존재

function estimateBlocking(gray, w, h, bgMask) {
  const accX = new Float64Array(BLOCK_N), cntX = new Float64Array(BLOCK_N);
  const accY = new Float64Array(BLOCK_N), cntY = new Float64Array(BLOCK_N);
  for (let y = 0; y < h; y++) for (let x = 0; x + 1 < w; x++) {
    const i = y * w + x;
    if (!bgMask[i] || !bgMask[i + 1]) continue;
    const ph = x % BLOCK_N;                       // x → x+1 경계의 위상
    accX[ph] += Math.abs(gray[i + 1] - gray[i]); cntX[ph]++;
  }
  for (let y = 0; y + 1 < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (!bgMask[i] || !bgMask[i + w]) continue;
    const ph = y % BLOCK_N;
    accY[ph] += Math.abs(gray[i + w] - gray[i]); cntY[ph]++;
  }
  const prof = (acc, cnt) => {
    const v = [];
    for (let k = 0; k < BLOCK_N; k++) { if (cnt[k] < 500) return null; v.push(acc[k] / cnt[k]); }
    return v;
  };
  const px = prof(accX, cntX), py = prof(accY, cntY);
  if (!px || !py) return { ok: false, reason: "배경 표본 부족" };
  const ratio = (v) => {
    const med = qMedian(v), mx = Math.max(...v);
    return med > 0 ? mx / med : NaN;
  };
  const rx = ratio(px), ry = ratio(py);
  const rr = Math.max(isFinite(rx) ? rx : 0, isFinite(ry) ? ry : 0);
  /* JPEG 은 8 위상 중 **하나**만 솟는다. N× 업스케일(N|8)도 8 주기를 만들지만
   * 솟는 위상이 8/N 개(2× → 4개, 4× → 2개)이므로 개수로 구분한다.
   * 8× 최근접 업스케일만은 원리적으로 구분되지 않는다 — 그 경우 L≈8 이 함께 나온다. */
  const nHigh = (v) => {
    const med = qMedian(v), mx = Math.max(...v), mid = 0.5 * (med + mx);
    return v.filter((t) => t > mid).length;
  };
  const nx = nHigh(px), ny = nHigh(py);
  const single = (nx === 1 && ny === 1);
  return {
    ok: true, profX: px, profY: py, ratioX: rx, ratioY: ry, ratio: rr,
    nHighX: nx, nHighY: ny, singlePhase: single,
    phaseX: px.indexOf(Math.max(...px)), phaseY: py.indexOf(Math.max(...py)),
    blocked: rr >= BLOCK_WARN && single,
  };
}

/* -------------------------------------------------------------- B. 선형성 */
/* 4차 차분 커널 [1,-4,6,-4,1] 은 3차 이하 다항식(국소 평면·곡률·기울기 변화)을
 * 소거하므로 빔 자체의 매끄러운 구조를 노이즈로 오인하지 않는다.
 * Var(d4) = 70σ².  정수 픽셀값에서는 median|d4| 이 정수로 계단화되어 어두운 쪽
 * (σ ≲ 1 DN)에서 심하게 편향되므로, **상위 10% 를 절사한 제곱평균**을 쓴다.
 *   Z~N(0,1) 에서 E[Z² | |Z| ≤ z_{0.95}] = 0.62302  →  E[d4²|절사] = 43.611 σ²   */
const D4_TRIM_MS = 43.6114;
function sigmaFromD4(arr) {
  if (arr.length < 40) return NaN;
  const b = Float64Array.from(arr).sort();
  const cut = b[Math.min(b.length - 1, Math.floor(b.length * 0.90))];
  let s = 0, n = 0;
  for (let i = 0; i < b.length; i++) { if (b[i] > cut) break; s += b[i] * b[i]; n++; }
  return n >= 20 ? Math.sqrt(s / n / D4_TRIM_MS) : NaN;
}
const LIN_BIN_MIN = 120;      // 빈당 최소 픽셀
const LIN_STRUCT_MAX = 1.5;   // σ̂(2D)/σ̂(D) 가 이보다 크면 구조 오염으로 폐기

function qBoxBlur(gray, w, h, r) {
  const t = new Float64Array(w * h), o = new Float64Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0, c = 0;
    for (let i = -r; i <= r; i++) { const xx = x + i; if (xx < 0 || xx >= w) continue;
      const v = gray[y * w + xx]; if (isFinite(v)) { s += v; c++; } }
    t[y * w + x] = c ? s / c : NaN;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0, c = 0;
    for (let j = -r; j <= r; j++) { const yy = y + j; if (yy < 0 || yy >= h) continue;
      const v = t[yy * w + x]; if (isFinite(v)) { s += v; c++; } }
    o[y * w + x] = c ? s / c : NaN;
  }
  return o;
}

/** 각 픽셀에서 lag D 4차 차분의 절대값을 수집 (수평·수직 모두). NaN/포화 제외. */
function collectD4(gray, w, h, D, S, black, bins, loM, hiM, NB) {
  const push = (bi, v) => { if (bi >= 0 && bi < NB) bins[bi].push(v); };
  const lg = Math.log(hiM / loM);
  const idx = (m) => (m <= 0 ? -1 : Math.floor(NB * Math.log(m / loM) / lg));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const m = S[y * w + x] - black;
    const bi = idx(m); if (bi < 0 || bi >= NB) continue;
    if (x - 2 * D >= 0 && x + 2 * D < w) {
      const a = gray[y*w+x-2*D], b = gray[y*w+x-D], c = gray[y*w+x],
            d = gray[y*w+x+D],   e = gray[y*w+x+2*D];
      if (isFinite(a)&&isFinite(b)&&isFinite(c)&&isFinite(d)&&isFinite(e) &&
          a<250&&b<250&&c<250&&d<250&&e<250)
        push(bi, Math.abs(a - 4*b + 6*c - 4*d + e));
    }
    if (y - 2 * D >= 0 && y + 2 * D < h) {
      const a = gray[(y-2*D)*w+x], b = gray[(y-D)*w+x], c = gray[y*w+x],
            d = gray[(y+D)*w+x],   e = gray[(y+2*D)*w+x];
      if (isFinite(a)&&isFinite(b)&&isFinite(c)&&isFinite(d)&&isFinite(e) &&
          a<250&&b<250&&c<250&&d<250&&e<250)
        push(bi, Math.abs(a - 4*b + 6*c - 4*d + e));
    }
  }
}

/* v3.17 — `quantStep` 은 0–255 환산 후의 **실제 양자화 계단**이다.
 * 8-bit canvas 경로면 1, 12-bit TIFF 를 0–255 로 환산했으면 0.0623.
 * 이걸 1 로 고정해 두면 12-bit 자료에서 분산 바닥을 **256배 과다 차감**하고
 * (v = s1² − 1/12), 멀쩡한 빈을 σ 문턱으로 대량 폐기한다. 계조를 살려 읽어 온
 * 의미가 거기서 사라진다. */
function estimateLinearity(gray, w, h, upscaleL, quantStep) {
  const qStep = isFinite(quantStep) && quantStep > 0 ? quantStep : 1;
  const sigMin = LIN_SIGMA_MIN * qStep;
  const quantVar = QUANT_VAR * qStep * qStep;
  const D = Math.max(1, Math.round(isFinite(upscaleL) ? upscaleL : 1));
  const fin = [];
  for (let i = 0; i < gray.length; i++) if (isFinite(gray[i]) && gray[i] < 250) fin.push(gray[i]);
  if (fin.length < 5000) return { ok: false, reason: "유효 픽셀 부족" };
  const black = qPercentile(fin, 0.25);
  const S = qBoxBlur(gray, w, h, D);

  const sig = [];
  for (let i = 0; i < S.length; i++) { const m = S[i] - black; if (m > 0.5 && isFinite(m)) sig.push(m); }
  if (sig.length < 600) return { ok: false, applicable: false, reason: "신호 픽셀 부족" };
  const loM = Math.max(0.5, qPercentile(sig, 0.10)), hiM = qPercentile(sig, 0.999);
  const dec = Math.log10(hiM / loM);
  if (!(dec >= LIN_MIN_DECADES)) return { ok: false, applicable: false, reason: `신호 동적범위 부족 (${dec.toFixed(2)} dec < ${LIN_MIN_DECADES})`, decades: dec };

  const NB = 8;
  const b1 = [], b2 = [];
  for (let i = 0; i < NB; i++) { b1.push([]); b2.push([]); }
  collectD4(gray, w, h, D,     S, black, b1, loM, hiM, NB);
  collectD4(gray, w, h, 2 * D, S, black, b2, loM, hiM, NB);

  const pts = [];
  /* v3.16 — 빈이 **왜** 폐기됐는지 센다. "잴 수 없었다"와 "재 봤더니 이상하다"를
   * 가르는 근거가 바로 이 분포다 (아래 verdict 분기에서 쓴다). */
  let nDropSigma = 0, nDropStruct = 0, nDropCount = 0;
  for (let i = 0; i < NB; i++) {
    if (b1[i].length < LIN_BIN_MIN || b2[i].length < LIN_BIN_MIN) { nDropCount++; continue; }
    const s1 = sigmaFromD4(b1[i]), s2 = sigmaFromD4(b2[i]);
    if (!isFinite(s1) || !isFinite(s2)) { nDropCount++; continue; }
    if (!(s1 > 0)) { nDropCount++; continue; }
    if (s2 / s1 > LIN_STRUCT_MAX) { nDropStruct++; continue; }   // 매끄러운 구조 오염(리샘플 등) → 폐기
    if (s1 < sigMin) { nDropSigma++; continue; }                 // 양자화 바닥 지배 → 폐기
    const v = s1 * s1 - quantVar;
    if (!(v > 0)) continue;
    const m = loM * Math.pow(hiM / loM, (i + 0.5) / NB);
    pts.push({ m, v, n: b1[i].length });
  }
  if (pts.length < 4) return { ok: false, applicable: false, reason: `유효 밝기 빈 부족 (${pts.length}) — 구조 오염 또는 표본 부족` };

  /* 선형 검출기의 물리 모델은 멱법칙이 아니라 **아핀**이다:
   *     Var(I) = g·I + σ_read²  =  (g·black + σ_read²) + g·m,   m = I − black
   * 어두운 쪽에서 분산이 평평해지는 것은 비선형이 아니라 배경 광자잡음·read noise
   * 때문이므로, 멱법칙 기울기 β 로 판정하면 선형 영상도 β<1 로 나와 오탐이 난다.
   * 따라서 a + b·m 을 상대잔차 가중 최소자승으로 적합하고 b 의 **부호**로 판정한다.
   *   b < 0  : 분산이 밝기에 따라 감소 → 어떤 선형 검출기로도 불가능 → 비선형 확정
   *   b > 0 이고 적합이 좋고 분산 변동이 충분 → 선형과 정합
   *   그 외   : read noise 지배 등으로 구분 불가 → 판정 보류                      */
  const vMin = Math.min(...pts.map(p => p.v)), vMax = Math.max(...pts.map(p => p.v));
  const varRatio = vMax / Math.max(vMin, 1e-12);
  let Sw = 0, Sx = 0, Sy = 0, Sxx = 0, Sxy = 0;
  for (const p of pts) {
    const wt = p.n / (p.v * p.v);            // 상대잔차 가중 (분산 추정의 상대오차는 일정)
    Sw += wt; Sx += wt * p.m; Sy += wt * p.v; Sxx += wt * p.m * p.m; Sxy += wt * p.m * p.v;
  }
  const den = Sw * Sxx - Sx * Sx;
  if (!(Math.abs(den) > 1e-18)) return { ok: false, applicable: false, reason: "회귀 불능" };
  const b = (Sw * Sxy - Sx * Sy) / den;
  const a = (Sy - b * Sx) / Sw;
  let ssr = 0, sst = 0, wsum = 0, vbar = 0;
  for (const p of pts) { const wt = p.n / (p.v * p.v); wsum += wt; vbar += wt * p.v; }
  vbar /= wsum;
  for (const p of pts) {
    const wt = p.n / (p.v * p.v);
    ssr += wt * Math.pow(p.v - (a + b * p.m), 2);
    sst += wt * Math.pow(p.v - vbar, 2);
  }
  const r2 = sst > 0 ? 1 - ssr / sst : NaN;
  // b 의 표준오차 (가중 LS)
  const seB = Math.sqrt(Math.max(0, (ssr / Math.max(1, pts.length - 2)) * Sw / den));
  // 참고용 멱법칙 기울기 (해석 보조 — 판정에는 쓰지 않는다)
  let Lw = 0, Lx = 0, Ly = 0, Lxx = 0, Lxy = 0;
  for (const p of pts) { const wt = Math.log10(p.n), X = Math.log10(p.m), Y = Math.log10(p.v);
    Lw += wt; Lx += wt * X; Ly += wt * Y; Lxx += wt * X * X; Lxy += wt * X * Y; }
  const lden = Lw * Lxx - Lx * Lx;
  const beta = Math.abs(lden) > 1e-12 ? (Lw * Lxy - Lx * Ly) / lden : NaN;
  let lss = 0; const la = (Ly - beta * Lx) / Lw;
  for (const p of pts) { const r = Math.log10(p.v) - (la + beta * Math.log10(p.m)); lss += Math.log10(p.n) * r * r; }
  const seBeta = Math.sqrt(Math.max(0, (lss / Math.max(1, pts.length - 2)) * Lw / lden));

  const decreasing = b + 2 * seB < 0;
  const increasing = b - 2 * seB > 0;
  /* Var = a + b·m 에서 a ≥ 0 이면 d logVar/d logm = b·m/(a+b·m) ≤ 1 이다.
   * 따라서 β 가 1 을 유의하게 넘으면 a < 0 을 요구하는 셈이고, 이는 신호 0 에서
   * 분산이 음수라는 뜻이므로 어떤 선형 검출기로도 불가능하다 → 비선형 확정. */
  const superLinear = isFinite(beta) && isFinite(seBeta) && (beta - 2 * seBeta > 1);
  /* v3.16 — "판정 보류"를 **둘로 가른다.**
   *
   * 집속 스팟 + 어두운 배경은 중간 밝기 화소가 구조적으로 거의 없고, 8-bit 로 깎이면
   * 배경 σ 가 양자화 바닥(0.45 LSB) 아래로 내려간다. 그러면 이 검사는 **적용 자체가
   * 불가능**하다 — 자료가 나쁜 게 아니라 이 방법이 이 종류의 영상에 맞지 않는 것이다.
   * 그런데 출력이 "톤커브가 의심스럽다"와 구분되지 않아서, γ=0.33 으로 제대로 찍은
   * 정상 파일이 `clean:false` 로 떨어지고 무결성 OK 배지가 **영원히 뜨지 않았다.**
   * 허위 경보는 진짜 경고를 죽인다(v3.13 dichroic 가드에서 채택한 원칙).
   *
   *   not-applicable : 구조적으로 잴 수 없음 (read noise 지배 · 양자화 바닥)
   *                    → issue 가 아니다. notes 로만 알린다.
   *   indeterminate  : 쟀는데 결과가 이상함 (아핀 적합 불량 · 분산 변동 부족)
   *                    → 실제 의심이므로 issue 로 올린다.
   *
   * 가르는 기준은 `increasing` 이다: 분산이 밝기에 따라 유의하게 늘지 **않으면**
   * 기울기 자체가 식별되지 않은 것이므로 아무것도 판정할 수 없다. 늘긴 하는데
   * 적합이 나쁘거나 변동이 작은 것은 자료가 무언가를 말하고 있는 것이다. */
  /* 이 함수는 **잰 것만 보고한다.** "적용 불가인가"는 업스케일·블록압축 판정까지
   * 함께 봐야 정해지므로 imageIntegrity 가 결정한다 (§v3.16).
   * 여기서는 보류의 **종류**만 분류해 올린다. */
  const verdict = (decreasing || superLinear) ? "nonlinear"
    : (increasing && r2 >= LIN_R2_MIN && varRatio >= LIN_VAR_RATIO_MIN) ? "linear"
    : "indeterminate";
  const indeterminateKind = verdict !== "indeterminate" ? null
    : !increasing ? "no-slope"                                   // 기울기 자체가 식별되지 않음
    : varRatio < LIN_VAR_RATIO_MIN ? "low-var-ratio"
    : "poor-fit";
  const why = verdict !== "indeterminate" ? null
    : indeterminateKind === "no-slope" ? "분산이 밝기에 거의 무관 — read noise 지배와 완만한 톤커브를 구분할 수 없음"
    : indeterminateKind === "low-var-ratio" ? `분산 변동 부족 (${varRatio.toFixed(2)}배)`
    : `아핀 모델 적합 불량 (R²=${r2.toFixed(3)}) — 톤커브 의심`;
  return { ok: true, _pts: pts, a, b, seB, r2, beta, seBeta, superLinear, bins: pts.length, decades: dec, varRatio, D,
    verdict, linear: verdict === "linear", indeterminateKind,
    nDropSigma, nDropStruct, nDropCount,
    indeterminateWhy: why, why };
}

/* ------------------------------------------------------------------ 종합 */
/** 종합 판정.
 *  중요: 업스케일 배수를 µm/px 보정에 쓰라고 **권고하는 것**은 선형성이 확인된
 *  경우로 한정한다. 비선형(톤커브) 영상에서는 리샘플 커널과 톤커브의 상호작용으로
 *  L 이 최대 ~35% 과대평가될 수 있음이 합성 격자에서 확인되었기 때문이다
 *  (bilinear + γ≥2.2 조합). 그 경우 권고는 "원본 TIFF 재촬영" 하나뿐이다. */
function imageIntegrity(gray, w, h, opts) {
  const quantStep = opts && isFinite(opts.quantStep) && opts.quantStep > 0 ? opts.quantStep : 1;
  const up = estimateUpscale(gray, w, h);
  const blk = up.ok && up.bgMask ? estimateBlocking(gray, w, h, up.bgMask) : { ok: false, reason: "배경 마스크 없음" };
  if (up.ok) delete up.bgMask;
  /* 블록 압축이 보이면 업스케일 배수는 신뢰할 수 없다 — 판정 보류로 낮춘다. */
  if (blk.ok && blk.blocked && up.ok) { up.confoundedByBlocking = true; up.upscaled = false; up.factor = null; }
  const lin = estimateLinearity(gray, w, h, up.ok ? up.L : 1, quantStep);
  const issues = [];
  if (blk.ok && blk.blocked)
    issues.push({ kind: "block-compression", severity: "high", ratio: blk.ratio,
      why: "8 px 주기 블록 경계 — JPEG 등 블록 압축. 업스케일 판정 불가" });
  if (up.ok && up.upscaled)
    issues.push({ kind: "upscale", severity: "high", L: up.L, factor: up.factor });
  else if (!up.ok)
    issues.push({ kind: "upscale-unverified", severity: "medium", why: up.reason });
  /* v3.16 — "잴 수 없었다"와 "재 봤더니 이상하다"를 가른다.
   *
   * 집속 스팟 + 어두운 배경은 중간 밝기 화소가 구조적으로 거의 없어서, 분산-밝기
   * 기울기 자체가 식별되지 않는다(`no-slope`). 이건 자료가 수상한 게 아니라 **이 방법이
   * 이 종류의 영상에 맞지 않는 것**이다. 그런데 출력이 "톤커브 의심"과 구분되지 않아
   * γ=0.33 으로 제대로 찍은 정상 파일이 clean:false 로 떨어지고 무결성 OK 배지가
   * **영원히 뜨지 않았다.** 허위 경보는 진짜 경고를 죽인다(v3.13 dichroic 가드의 원칙).
   *
   * 다만 `no-slope` 를 무조건 면제하면 안 된다. **리샘플·블록압축된 영상도 이웃 상관
   * 때문에 같은 증상을 낸다** — 실제로 합성 격자 시험의 U=3 bilinear 두 건(L=2.63·3.99)이
   * 그렇다. 그건 "적용 불가"가 아니라 바로 이 검사가 잡아야 할 조작이므로, 그 경우에는
   * 판정 보류를 issue 로 유지한다. 즉 면제는 **1:1 무압축 영상에 한정**한다. */
  const resampled = !!(up.ok && isFinite(up.L) && up.L > 1.5) || !!(up.ok && up.upscaled);
  const blockedNow = !!(blk.ok && blk.blocked);
  /* 리샘플·블록압축된 영상에서는 **검사를 못 돌린 이유가 그 조작일 수 있으므로**
   * 면제하지 않는다. "적용 안 됨"은 무해하게 들리는데, 그 경우 무해하지 않다. */
  const linNotApplicable = !resampled && !blockedNow
    && (!lin.ok || (lin.verdict === "indeterminate" && lin.indeterminateKind === "no-slope"));
  const notes = [];
  if (lin.ok && lin.verdict === "nonlinear")
    issues.push({ kind: "nonlinear", severity: "high", b: lin.b, r2: lin.r2, beta: lin.beta });
  else if (linNotApplicable)
    notes.push({ kind: "linearity-not-applicable",
      why: lin.ok ? lin.indeterminateWhy : lin.reason, beta: lin.ok ? lin.beta : NaN,
      detail: lin.ok
        ? "집속 스팟처럼 중간 밝기 화소가 거의 없는 영상에서는 분산-밝기 기울기가 식별되지 않습니다. 톤커브가 있다는 뜻도, 없다는 뜻도 아닙니다."
        : "검사를 돌릴 표본 자체가 부족합니다." });
  else
    issues.push({ kind: "linearity-unverified", severity: "medium",
      why: lin.ok ? lin.indeterminateWhy : lin.reason, beta: lin.ok ? lin.beta : NaN });
  const blocked = blk.ok && blk.blocked;
  const linearOK = lin.ok && lin.verdict === "linear";
  const scaleSuggestion = (up.ok && up.upscaled && linearOK && !blocked)
    ? { divideUmPerPxBy: up.factor, areaFactor: up.factor * up.factor }
    : null;
  /* "검사를 통과함"과 "검사가 적용되지 않음"은 화면에서 반드시 구분돼야 한다.
   * clean:true 만으로는 둘이 같아 보인다. */
  const verified = {
    upscale: !!(up.ok),
    linearity: !!(lin.ok && (lin.verdict === "linear" || lin.verdict === "nonlinear")),
    blocking: !!(blk.ok),
  };
  if (lin && typeof lin === "object") lin.applicable = !linNotApplicable;
  return {
    upscale: up, linearity: lin, blocking: blk, issues, notes, verified, quantStep,
    clean: issues.length === 0,
    scaleSuggestion,
    scaleAdvisoryOnly: up.ok && up.upscaled && !linearOK,
    action: blocked
      ? "무손실 원본 필요 — 이 파일은 블록 압축(JPEG 계열)되어 업스케일 판정이 불가능하다"
      : (up.ok && up.upscaled) || (lin.ok && lin.verdict === "nonlinear")
      ? "재촬영 권장 — 카메라 원본(1:1, 선형 TIFF)"
      : (issues.length ? "주의 — 아래 항목 확인" : null)
  };
}

/* ------------------------------- exports ---------------------------------- */
return {
  VERSION: "2.0-core",
  // math utils
  nanmedian, nanmean, nanmax, nanmin, nanpercentile, solveLinear, invSym, makeRng, logspace,
  // loading
  safeMeanStd, buildLoadedFromAPD, buildLoadedFromEMCCD, nearestIndex,
  // branching
  detectScanMode, splitBranches,
  // beam profile
  fitGaussian2D, beamMetrics, isolateMainBlob, splitTouchingBlobs, removeStreaks, fitBeam,
  chooseBinFactor, binDown,
  momentsD4Sigma,
  // v3.10: 업로드 이미지 무결성 (업스케일·선형성)
  imageIntegrity, estimateUpscale, estimateLinearity, estimateBlocking,
};
});

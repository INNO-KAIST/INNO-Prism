/* Reproduce the user's smear case: a faint FULL-HEIGHT vertical band (CCD
 * readout smear / 0th-order-like streak) through a small central focus.
 * Old pipeline: σy blown up by the band. New: removeStreaks flattens it. */
"use strict";
const E = require("../src/engine.js");

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// binned-scale frame like the user's (1358×1024 at 5× → 272×205)
const W = 272, H = 205;
const TRUE = { x0: 130, y0: 101, sx: 2.6, sy: 2.4, A: 180, B: 12 };
const rng = mulberry32(4242);
const img = new Float64Array(W * H);
for (let i = 0; i < img.length; i++) img[i] = TRUE.B + 1.8 * gauss(rng);
// full-height smear band: Gaussian x-profile centered on the spot column,
// sigma 9 px, amplitude 26 (faint but wide — dominates integrated flux!)
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const dx = (x - TRUE.x0) / 9;
  img[y * W + x] += 26 * Math.exp(-0.5 * dx * dx);
}
// small focus spot
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const dx = x - TRUE.x0, dy = y - TRUE.y0;
  const e = (dx * dx) / (2 * TRUE.sx * TRUE.sx) + (dy * dy) / (2 * TRUE.sy * TRUE.sy);
  if (e < 40) img[y * W + x] += TRUE.A * Math.exp(-e);
}
for (let i = 0; i < img.length; i++) img[i] = Math.min(Math.round(img[i]), 255);
// scale-bar annotation already chroma-removed by the app → NaN block
for (let y = 130; y < 134; y++) for (let x = 170; x < 192; x++) img[y * W + x] = NaN;

let fail = 0;
const check = (name, ok, info) => { console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${info ? " — " + info : ""}`); if (!ok) fail++; };

// OLD equivalent (no streak removal): isolate+split+fit directly
const isoOld = E.isolateMainBlob({ w: W, h: H, data: img }, {});
const oldFit = E.fitGaussian2D({ w: W, h: H, data: isoOld.data }, { satLevel: 254 });
console.log(`OLD : sx=${oldFit.sx.toFixed(2)} sy=${oldFit.sy.toFixed(2)} R²=${oldFit.r2.toFixed(3)} (true 2.6/2.4)`);

// streak removal alone
const stk = E.removeStreaks({ w: W, h: H, data: img }, {});
console.log(`STK : cols=${stk.nCols} amp=${stk.colAmp.toFixed(1)} rows=${stk.nRows}`);
check("streak detected across band", stk.nCols >= 15, `cols=${stk.nCols}`);
check("streak amplitude ≈ 26", Math.abs(stk.colAmp - 26) < 6, `amp=${stk.colAmp.toFixed(1)}`);
check("no false row correction", stk.nRows === 0);

// full new pipeline
const fit = E.fitBeam({ w: W, h: H, data: img }, { satLevel: 254 });
console.log(`NEW : sx=${fit.sx.toFixed(2)} sy=${fit.sy.toFixed(2)} th=${(fit.theta * 180 / Math.PI).toFixed(1)}° R²=${fit.r2.toFixed(3)} streakCols=${fit.nStreakCols}`);
check("sx within 8%", Math.abs(fit.sx - TRUE.sx) / TRUE.sx < 0.08, `sx=${fit.sx.toFixed(2)}`);
check("sy within 8%", Math.abs(fit.sy - TRUE.sy) / TRUE.sy < 0.08, `sy=${fit.sy.toFixed(2)}`);
check("center within 1px", Math.hypot(fit.x0 - TRUE.x0, fit.y0 - TRUE.y0) < 1);
check("R² > 0.9", fit.r2 > 0.9);
check("old pipeline was distorted (sanity)", oldFit.sy > TRUE.sy * 1.5 || oldFit.r2 < 0.8,
  `old sy=${oldFit.sy.toFixed(2)} R²=${oldFit.r2.toFixed(3)}`);

// regression: streak-free image must be untouched by removeStreaks
const img2 = new Float64Array(W * H);
const rng2 = mulberry32(7);
for (let i = 0; i < img2.length; i++) img2[i] = TRUE.B + 1.8 * gauss(rng2);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const dx = x - TRUE.x0, dy = y - TRUE.y0;
  const e = (dx * dx) / (2 * 7 * 7) + (dy * dy) / (2 * 5 * 5);
  if (e < 40) img2[y * W + x] += 200 * Math.exp(-e);
}
const stk2 = E.removeStreaks({ w: W, h: H, data: img2 }, {});
check("clean image: no streak correction", stk2.nCols === 0 && stk2.nRows === 0,
  `cols=${stk2.nCols} rows=${stk2.nRows}`);
const fit2c = E.fitBeam({ w: W, h: H, data: img2 }, { satLevel: 254 });
check("clean fit unchanged (sx≈7)", Math.abs(fit2c.sx - 7) / 7 < 0.05, `sx=${fit2c.sx.toFixed(2)}`);

console.log(fail ? `\n${fail} FAILURES` : "\nALL PASS");
process.exit(fail ? 1 : 0);

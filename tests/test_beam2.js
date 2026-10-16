/* Reproduce the user's failure: reflections TOUCHING the main focus merge
 * into one blob and inflate the fitted ellipse (R²~0.69). Verify the new
 * fitBeam pipeline (watershed split + ROI + residual clip) recovers truth. */
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

const W = 272, H = 205;
const TRUE = { x0: 136, y0: 100, sx: 7.0, sy: 5.0, th: (10 * Math.PI) / 180, A: 240, B: 45 };
function spot(data, x0, y0, sx, sy, th, A) {
  const c = Math.cos(th), s = Math.sin(th);
  const a = c * c / (2 * sx * sx) + s * s / (2 * sy * sy);
  const b = s * c / (2 * sx * sx) - s * c / (2 * sy * sy); // 표준 회전 규약
  const cc = s * s / (2 * sx * sx) + c * c / (2 * sy * sy);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const dx = x - x0, dy = y - y0;
    const e = a * dx * dx + 2 * b * dx * dy + cc * dy * dy;
    if (e < 60) data[y * W + x] += A * Math.exp(-e);
  }
}

const rng = mulberry32(20260810);
const img = new Float64Array(W * H);
for (let i = 0; i < img.length; i++) img[i] = TRUE.B + 2.5 * gauss(rng);
// background structure: vertical stripe (like real camera vignette bands)
for (let y = 0; y < H; y++) for (let x = 128; x < 141; x++) img[y * W + x] += 6;
// main focus
spot(img, TRUE.x0, TRUE.y0, TRUE.sx, TRUE.sy, TRUE.th, TRUE.A);
// TOUCHING reflections (the user's problem — wings overlap the main spot's,
// and they sit INSIDE the annotation circle so no NaN ring severs them)
spot(img, 120, 96, 4.0, 3.5, 0, 170);
spot(img, 150, 106, 3.5, 3.0, 0, 140);
// far ghosts
spot(img, 60, 60, 5, 5, 0, 90);
spot(img, 220, 150, 4, 4, 0, 70);
// clip to 8-bit (saturation) BEFORE annotation holes
for (let i = 0; i < img.length; i++) img[i] = Math.min(Math.round(img[i]), 255);
// annotation holes (chroma-removed circle overlapping the beam + text block)
for (let t = 0; t < 720; t++) {
  const ang = (t / 720) * 2 * Math.PI;
  for (let rr = 26; rr <= 28; rr++) {
    const x = Math.round(TRUE.x0 + rr * Math.cos(ang));
    const y = Math.round(TRUE.y0 + rr * Math.sin(ang));
    if (x >= 0 && x < W && y >= 0 && y < H) img[y * W + x] = NaN;
  }
}
for (let y = 130; y < 138; y++) for (let x = 158; x < 178; x++) img[y * W + x] = NaN;

function report(tag, fit) {
  const errSx = 100 * Math.abs(fit.sx - TRUE.sx) / TRUE.sx;
  const errSy = 100 * Math.abs(fit.sy - TRUE.sy) / TRUE.sy;
  const thDeg = (fit.theta * 180) / Math.PI;
  console.log(
    `${tag}: sx=${fit.sx.toFixed(2)} (err ${errSx.toFixed(1)}%) sy=${fit.sy.toFixed(2)} (err ${errSy.toFixed(1)}%) ` +
    `th=${thDeg.toFixed(1)}° x0=${fit.x0.toFixed(1)} y0=${fit.y0.toFixed(1)} R²=${fit.r2.toFixed(3)} ` +
    `[far=${fit.nGhosts ?? "-"} near=${fit.nNear ?? "-"} clip=${fit.nClip ?? "-"} sat=${fit.nSat}]`
  );
  return { errSx, errSy, thDeg };
}

// OLD pipeline (what the user saw)
const iso = E.isolateMainBlob({ w: W, h: H, data: img }, {});
const old = E.fitGaussian2D({ w: W, h: H, data: iso.data }, { satLevel: 254 });
old.nGhosts = iso.nGhosts;
report("OLD ", old);

// NEW pipeline
const fit = E.fitBeam({ w: W, h: H, data: img }, { satLevel: 254 });
const r = report("NEW ", fit);

let fail = 0;
const check = (name, ok) => { console.log(`  ${ok ? "PASS" : "FAIL"} ${name}`); if (!ok) fail++; };
check("far ghosts masked (2)", fit.nGhosts >= 2);
check("near reflections split (≥2)", fit.nNear >= 2);
check("sx error < 6%", r.errSx < 6);
check("sy error < 6%", r.errSy < 6);
check("theta within 4° of 10°", Math.abs(r.thDeg - 10) < 4);
check("center within 1.5 px", Math.hypot(fit.x0 - TRUE.x0, fit.y0 - TRUE.y0) < 1.5);
check("R² > 0.93", fit.r2 > 0.93);
check("old pipeline was indeed broken (sanity)", old.sx > TRUE.sx * 1.3 || old.r2 < 0.85);

// no-ghost regression: clean single beam must be untouched by the splitter
const img2 = new Float64Array(W * H);
const rng2 = mulberry32(7);
for (let i = 0; i < img2.length; i++) img2[i] = TRUE.B + 2.5 * gauss(rng2);
spot(img2, TRUE.x0, TRUE.y0, TRUE.sx, TRUE.sy, TRUE.th, 200);
for (let i = 0; i < img2.length; i++) img2[i] = Math.min(Math.round(img2[i]), 255);
const fit2 = E.fitBeam({ w: W, h: H, data: img2 }, { satLevel: 254 });
const r2r = report("CLEAN", fit2);
check("clean: no near split", fit2.nNear === 0);
check("clean: sx error < 4%", r2r.errSx < 4);
check("clean: sy error < 4%", r2r.errSy < 4);
check("clean: R² > 0.97", fit2.r2 > 0.97);

console.log(fail ? `\n${fail} FAILURES` : "\nALL PASS");
process.exit(fail ? 1 : 0);

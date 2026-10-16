/* ISO 11146 rotated-D4σ validation.
 * Cases: rotated Gaussian (moments must equal the fit), flat-top and
 * super-Gaussian (D4σ must diverge from the Gaussian fit in the KNOWN
 * direction), noise robustness, and the naive-vs-rotated area error. */
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

const W = 401, H = 401;
/** shape: "gauss" | "flattop" | "super4"; sa/sb = principal sigmas (px) */
function makeImg(shape, sa, sb, thDeg, { noise = 1.5, B = 20, A = 200, seed = 5 } = {}) {
  const rng = mulberry32(seed);
  const d = new Float64Array(W * H);
  const th = (thDeg * Math.PI) / 180, c = Math.cos(th), s = Math.sin(th);
  const x0 = 200.5, y0 = 200.5;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const dx = x - x0, dy = y - y0;
    const u = (dx * c + dy * s) / sa, v = (-dx * s + dy * c) / sb;
    const r2 = u * u + v * v;
    let I = 0;
    if (shape === "gauss") I = A * Math.exp(-0.5 * r2);
    else if (shape === "flattop") I = r2 <= 1 ? A : 0;               // uniform ellipse
    else if (shape === "super4") I = A * Math.exp(-0.5 * r2 * r2);   // super-Gaussian n=4
    d[y * W + x] = B + I + noise * gauss(rng);
  }
  return { w: W, h: H, data: d };
}

let fail = 0;
const check = (name, ok, info) => { console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${info ? " — " + info : ""}`); if (!ok) fail++; };
const deg = (r) => (r * 180) / Math.PI;

// ---- C1: rotated Gaussian — moments must reproduce the truth exactly ----
{
  const SA = 26, SB = 13, TH = 30;
  const img = makeImg("gauss", SA, SB, TH, { seed: 11 });
  const m = E.momentsD4Sigma(img, {});
  console.log(`C1 rot-Gauss: σa=${m.sigmaMajor.toFixed(2)} σb=${m.sigmaMinor.toFixed(2)} θ=${deg(m.theta).toFixed(2)}° ` +
    `D4σ=${m.d4sMajor.toFixed(1)}×${m.d4sMinor.toFixed(1)} iter=${m.iter} conv=${m.converged} naiveAreaRatio=${m.naiveAreaRatio.toFixed(4)}`);
  check("C1 σa within 3%", Math.abs(m.sigmaMajor - SA) / SA < 0.03, m.sigmaMajor.toFixed(2));
  check("C1 σb within 3%", Math.abs(m.sigmaMinor - SB) / SB < 0.03, m.sigmaMinor.toFixed(2));
  check("C1 θ within 1.5°", Math.abs(deg(m.theta) - TH) < 1.5, deg(m.theta).toFixed(2));
  check("C1 converged", m.converged);
  // naive (rotation-blind) area error must match theory
  const t = (TH * Math.PI) / 180;
  const sxLab = Math.sqrt(SA ** 2 * Math.cos(t) ** 2 + SB ** 2 * Math.sin(t) ** 2);
  const syLab = Math.sqrt(SA ** 2 * Math.sin(t) ** 2 + SB ** 2 * Math.cos(t) ** 2);
  const theoryRatio = (sxLab * syLab) / (SA * SB);
  check("C1 naive-area overestimate matches theory", Math.abs(m.naiveAreaRatio - theoryRatio) / theoryRatio < 0.03,
    `measured ${m.naiveAreaRatio.toFixed(3)} vs theory ${theoryRatio.toFixed(3)} (+${((theoryRatio - 1) * 100).toFixed(1)}%)`);
  // Gaussian fit and moments must agree for a Gaussian beam
  const fit = E.fitBeam(img, { satLevel: 1e9 });
  console.log(`   fit: σ=${fit.sx.toFixed(2)}×${fit.sy.toFixed(2)} θ=${deg(fit.theta).toFixed(2)}° | d4sAreaRatio=${fit.d4sAreaRatio.toFixed(4)}`);
  check("C1 fit↔moments area agree within 5%", Math.abs(fit.d4sAreaRatio - 1) < 0.05, fit.d4sAreaRatio.toFixed(4));
  check("C1 fitBeam exposes moments", !!fit.moments);
}

// ---- C2: circular flat-top — D4σ has an exact analytic answer ----
// uniform disc radius R: σ = R/2 → D4σ = 2R = the true diameter
{
  const R = 60;
  const img = makeImg("flattop", R, R, 0, { seed: 22, noise: 1.0 });
  const m = E.momentsD4Sigma(img, {});
  console.log(`C2 flat-top R=${R}: σ=${m.sigmaMajor.toFixed(2)} (참 ${R / 2}) D4σ=${m.d4sMajor.toFixed(1)} (참 ${2 * R})`);
  check("C2 σ = R/2 within 4%", Math.abs(m.sigmaMajor - R / 2) / (R / 2) < 0.04, m.sigmaMajor.toFixed(2));
  const fit = E.fitBeam(img, { satLevel: 1e9 });
  console.log(`   Gaussian fit σ=${fit.sx.toFixed(2)} → d4sAreaRatio=${fit.d4sAreaRatio.toFixed(3)} (비-Gaussian 진단)`);
  check("C2 non-Gaussian flagged (ratio ≠ 1 by >10%)", Math.abs(fit.d4sAreaRatio - 1) > 0.10, fit.d4sAreaRatio.toFixed(3));
}

// ---- C3: rotated super-Gaussian (flat-ish top, sharp edge) ----
{
  const SA = 40, SB = 20, TH = -25;
  const img = makeImg("super4", SA, SB, TH, { seed: 33 });
  const m = E.momentsD4Sigma(img, {});
  console.log(`C3 super-Gauss: σa=${m.sigmaMajor.toFixed(2)} σb=${m.sigmaMinor.toFixed(2)} θ=${deg(m.theta).toFixed(2)}° (참 θ=${TH}°) 비율=${(m.sigmaMajor / m.sigmaMinor).toFixed(3)} (참 ${(SA / SB).toFixed(3)})`);
  check("C3 θ within 2°", Math.abs(deg(m.theta) - TH) < 2, deg(m.theta).toFixed(2));
  check("C3 축비 within 4%", Math.abs(m.sigmaMajor / m.sigmaMinor - SA / SB) / (SA / SB) < 0.04);
}

// ---- C4: noise robustness / reproducibility across seeds ----
{
  const SA = 26, SB = 13, TH = 30, vals = [];
  for (let s = 1; s <= 8; s++) {
    const img = makeImg("gauss", SA, SB, TH, { seed: 100 + s, noise: 4.0, A: 120 });
    const m = E.momentsD4Sigma(img, {});
    vals.push(m ? m.sigmaMajor : NaN);
  }
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
  console.log(`C4 noise σa: mean=${mean.toFixed(2)} sd=${sd.toFixed(3)} (참 ${SA}) — ${vals.map((v) => v.toFixed(1)).join(" ")}`);
  check("C4 편향 < 4%", Math.abs(mean - SA) / SA < 0.04, mean.toFixed(2));
  check("C4 재현성 sd < 2%", sd / SA < 0.02, (100 * sd / SA).toFixed(2) + "%");
  // determinism
  const i1 = makeImg("gauss", SA, SB, TH, { seed: 7 });
  const a1 = E.momentsD4Sigma(i1, {}), a2 = E.momentsD4Sigma(i1, {});
  check("C4 결정성", JSON.stringify(a1) === JSON.stringify(a2));
}

// ---- C5: masked pixels (annotation/ghost holes) must be reported ----
{
  const img = makeImg("gauss", 26, 13, 30, { seed: 44 });
  for (let y = 195; y < 205; y++) for (let x = 195; x < 215; x++) img.data[y * W + x] = NaN;
  const m = E.momentsD4Sigma(img, {});
  console.log(`C5 마스크: maskedFraction=${(100 * m.maskedFraction).toFixed(2)}% σa=${m.sigmaMajor.toFixed(2)}`);
  check("C5 마스크 비율 보고", m.maskedFraction > 0);
  check("C5 마스크에도 NaN 없음", isFinite(m.sigmaMajor) && isFinite(m.sigmaMinor));
}

console.log(fail ? `\n${fail} FAILURES` : "\nALL PASS");
process.exit(fail ? 1 : 0);

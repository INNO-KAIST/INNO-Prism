/* 면적 기준(빔 폭 정의) 기본값의 근거 — 참값 대조.
 *
 * 앱은 σ 를 Gaussian 항등식 A_peak = 2πσxσy 로 바꿔 파워밀도를 낸다.
 * 따라서 "어느 폭 정의가 옳은가"는 정의 논쟁이 아니라 **측정 가능한 질문**이다:
 * 참 peak irradiance 환산면적 A_true = P / I_peak 를 누가 더 잘 맞히는가.
 *
 * 합성: 회전 타원 Gaussian 코어 + 같은 중심의 넓은 받침(pedestal, 3× 폭)을
 * 0~120% 비율로 섞는다. 받침은 실제 빔에서 산란·수차로 흔히 생긴다.
 *
 * 잠그는 결론 (v3.6.2 에서 기본값을 d4sigma 로 바꾼 근거):
 *   (1) 순수 Gaussian 에서 두 기준 모두 1% 이내 — 기본값을 무엇으로 두든 손해가 없다
 *   (2) 약한 비-Gaussian(면적비 ~1.1) 에서는 D4σ 가 뚜렷이 낫다
 *   (3) 받침이 커지면 D4σ 가 발산한다 — 2차 모멘트가 r² 가중이기 때문
 *   (4) 역전은 면적비 ≈ 1.35 부근에서 일어난다 (UI 문턱의 근거)
 * (3)(4)는 기본값을 바꾼 것이 "D4σ가 늘 낫다"는 뜻이 아님을 못박는다.
 */
"use strict";
const E = require("../src/engine.js");

function mulberry32(a) {
  return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function gauss(r) { let u = 0, v = 0; while (u === 0) u = r(); while (v === 0) v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

const W = 401, H = 401, SA = 20, SB = 12, TH = 25, AMP = 200, K = 9;  // K = 받침 폭² 배수 (3× 폭)
const prof = (f, r2) => AMP * ((1 - f) * Math.exp(-0.5 * r2) + f * Math.exp(-0.5 * r2 / K));
function makeImg(f, noise, seed) {
  const rng = mulberry32(seed), d = new Float64Array(W * H);
  const th = TH * Math.PI / 180, c = Math.cos(th), s = Math.sin(th);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const dx = x - 200.5, dy = y - 200.5;
    const u = (dx * c + dy * s) / SA, v = (-dx * s + dy * c) / SB;
    d[y * W + x] = 20 + prof(f, u * u + v * v) + noise * gauss(rng);
  }
  return { w: W, h: H, data: d };
}
/** A_true = P / I_peak — 잡음 없는 프로파일에서 직접 적분 */
function truthArea(f) {
  let P = 0, I0 = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const dx = x - 200.5, dy = y - 200.5;
    const I = prof(f, (dx * dx) / (SA * SA) + (dy * dy) / (SB * SB));
    P += I; if (I > I0) I0 = I;
  }
  return P / I0;
}
const areaPeak = (sx, sy) => 2 * Math.PI * sx * sy;   // 앱의 A_peak = π·wx·wy/2, w = 2σ
const med = (a) => { const b = a.slice().sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };

let fail = 0;
const check = (n, ok, i) => { console.log(`  ${ok ? "PASS" : "FAIL"} ${n}${i ? " — " + i : ""}`); if (!ok) fail++; };

const rows = [];
for (const f of [0, 0.02, 0.033, 0.038, 0.05, 0.08]) {
  const At = truthArea(f), eg = [], ed = [], rr = [];
  for (let seed = 1; seed <= 5; seed++) {
    const fit = E.fitBeam(makeImg(f, 1.5, seed * 13), { satLevel: 1e9 });
    if (!fit || !fit.success || !(fit.sx > 0)) continue;
    eg.push(100 * (areaPeak(fit.sx, fit.sy) - At) / At);
    if (fit.moments && isFinite(fit.moments.sigmaMajor)) {
      ed.push(100 * (areaPeak(fit.moments.sigmaMajor, fit.moments.sigmaMinor) - At) / At);
      rr.push(fit.d4sAreaRatio);
    }
  }
  const r = { f, ratio: med(rr), gauss: med(eg), d4s: med(ed) };
  rows.push(r);
  console.log(`  받침 ${(f * 100).toFixed(1).padStart(4)}%  면적비 ${r.ratio.toFixed(2)}  |  ` +
    `Gaussian ${r.gauss.toFixed(1).padStart(6)}%   D4σ ${r.d4s.toFixed(1).padStart(6)}%   ` +
    `→ ${Math.abs(r.d4s) < Math.abs(r.gauss) ? "D4σ" : "Gaussian"} 우세`);
}
console.log("");
const at = (f) => rows.find((r) => r.f === f);

check("(1) 순수 Gaussian 에서 두 기준 모두 1% 이내",
  Math.abs(at(0).gauss) < 1 && Math.abs(at(0).d4s) < 1, `Gaussian ${at(0).gauss.toFixed(2)}% · D4σ ${at(0).d4s.toFixed(2)}%`);
check("(1b) 순수 Gaussian 면적비 ≈ 1", Math.abs(at(0).ratio - 1) < 0.03, at(0).ratio.toFixed(3));

const mild = at(0.02);
check("(2) 약한 비-Gaussian(면적비 1.05~1.2)에서 D4σ 가 낫다",
  mild.ratio > 1.05 && mild.ratio < 1.2 && Math.abs(mild.d4s) < Math.abs(mild.gauss),
  `면적비 ${mild.ratio.toFixed(2)} · Gaussian ${mild.gauss.toFixed(1)}% vs D4σ ${mild.d4s.toFixed(1)}%`);
check("(2b) 그 지점에서 차이가 유의미하다 (Gaussian 오차가 D4σ 의 3배 이상)",
  Math.abs(mild.gauss) > 3 * Math.abs(mild.d4s),
  `${Math.abs(mild.gauss).toFixed(1)}% vs ${Math.abs(mild.d4s).toFixed(1)}%`);

const big = at(0.08);
check("(3) 받침이 크면 D4σ 가 발산한다 — 기본값 변경이 '항상 낫다'는 뜻이 아니다",
  Math.abs(big.d4s) > 100 && Math.abs(big.d4s) > Math.abs(big.gauss),
  `면적비 ${big.ratio.toFixed(2)} · Gaussian ${big.gauss.toFixed(1)}% vs D4σ ${big.d4s.toFixed(1)}%`);

// (4) 역전 지점 — 면적비 1.2~1.6 사이에 있어야 UI 문턱 1.35 가 정당하다
let cross = null;
for (let i = 1; i < rows.length; i++) {
  const prev = rows[i - 1], cur = rows[i];
  const prevD4Win = Math.abs(prev.d4s) < Math.abs(prev.gauss);
  const curD4Win = Math.abs(cur.d4s) < Math.abs(cur.gauss);
  if (prevD4Win && !curD4Win) { cross = [prev.ratio, cur.ratio]; break; }
}
check("(4) 역전 지점이 존재한다", !!cross, cross ? `면적비 ${cross[0].toFixed(2)} ↔ ${cross[1].toFixed(2)} 사이` : "없음");
check("(4b) UI 문턱 1.35 가 그 구간 안에 있다",
  !!cross && cross[0] <= 1.35 && 1.35 <= cross[1],
  cross ? `${cross[0].toFixed(2)} ≤ 1.35 ≤ ${cross[1].toFixed(2)}` : "-");

console.log(fail ? `\n${fail} FAILURES` : "\nALL PASS");
process.exit(fail ? 1 : 0);

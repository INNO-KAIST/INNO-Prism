// R6: 신뢰 기준의 코드화 — "개형을 잘 따라가는가"가 아니라 "시드를 바꿔도 재현되는가".
// 같은 물리·같은 노이즈 크기에서 노이즈 실현만 바꿨을 때 s_max 가 요동하면
// rms 가 아무리 좋아도 보고할 수 없다. 두 개의 서로 다른 참 모델로 검증한다:
//   (1) H2(엔진의 모델족) 진실값  (2) Hill(로그-로지스틱) 진실값 — 모델족 밖
// (2)에서도 통과해야 "우리 모델족이라서 잘 나온 것"이 아님이 보장된다.
let F; try { F = require("../src/fit2.js"); } catch (e) { F = require("./fit2.js"); }

let fail = 0;
const check = (cond, msg) => { console.log((cond ? "  ok   " : "  FAIL ") + msg); if (!cond) fail++; };
const SEEDS = [1, 2, 3, 4, 5, 6];
const XLO = -3.2, XHI = -1.4, N = 90, DARK = 120;

/** Hill(로그-로지스틱): log10 I = A0 + (A−A0)/(1+10^{−q(x−xm)})
    기울기 프로파일이 종 모양이라 H2(고원형 기울기)로는 표현할 수 없다 — 진짜 '모델족 밖'.
    Chapman–Richards 는 x0 에서 도함수가 불연속(m<1) 이거나 꺾여서, 그 꺾임 자체가
    무엇을 재는지 모호해진다. 매끄러운 out-of-family 검증에는 Hill 이 적절하다. */
function hillY(x, P) {
  return P.A0 + (P.A - P.A0) / (1 + Math.pow(10, -P.q * (x - P.xm)));
}
/** H2 hinge: log10 I = c + k1·x + (k2−k1)w·softplus((x−t1)/w) − (k2−k3)v·softplus((x−t2)/v) */
function h2Y(x, P) {
  const sp = (z) => (z > 30 ? z : Math.log1p(Math.exp(z)));
  return P.c + P.k1 * x + (P.k2 - P.k1) * P.w * sp((x - P.t1) / P.w) - (P.k2 - P.k3) * P.v * sp((x - P.t2) / P.v);
}
function truthSmax(fy) {
  let best = -Infinity, at = NaN;
  const h = (XHI - XLO) / 20000;
  for (let x = XLO; x <= XHI; x += h) {
    const s = (fy(x + h) - fy(x - h)) / (2 * h);
    if (s > best) { best = s; at = x; }
  }
  return { sMax: best, at };
}
/** 진실 곡선 + Poisson(τ) + setpoint 간 드리프트 */
function makeBranch(fy, seed, tau, driftCV, nRep) {
  const rng = F.makeRng(seed);
  const pois = (lam) => {
    if (lam > 30) return Math.max(Math.round(lam + Math.sqrt(lam) * rng.normal()), 0);
    const L = Math.exp(-lam); let k = 0, p = 1;
    do { k++; p *= rng.uniform(); } while (p > L);
    return k - 1;
  };
  const P = [], I = [], reps = [];
  for (let i = 0; i < N; i++) {
    const xv = XLO + (XHI - XLO) * i / (N - 1);
    const rate = DARK + Math.pow(10, fy(xv));   // 실제 측정처럼 상수 암계수를 얹는다
    const drift = Math.exp(driftCV * rng.normal() - 0.5 * driftCV * driftCV);
    const r = [];
    for (let j = 0; j < nRep; j++) r.push(pois(rate * drift * tau) / tau);
    P.push(Math.pow(10, xv));
    I.push(r.reduce((a, b) => a + b, 0) / r.length);
    reps.push(r);
  }
  return { powerAvg: P, intensityAvg: I, powerStd: P.map(() => 0), intensityStd: I.map(() => 0),
           intensityReplicates: reps, acqTime: tau, counting: true };
}
function stats(v) {
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) * (b - m), 0) / Math.max(v.length - 1, 1));
  const so = v.slice().sort((a, b) => a - b);
  return { mean: m, sd, cv: sd / Math.max(Math.abs(m), 1e-12), med: so[so.length >> 1] };
}

const CASES = [
  { name: "H2 진실값", fy: (x) => h2Y(x, { c: 8.4, k1: 0.6, k2: 9.0, k3: 1.1, t1: -2.45, t2: -2.05, w: 0.10, v: 0.12 }) },
  // 변곡점 x0+ln(m)/k 를 측정창 한가운데(≈ −2.30)에 두고, x<x0 의 평탄부는
  // 평탄부(A0)는 암계수보다 위에 두어 신호가 전이 한참 전부터 검출권 안에 있게 한다
  // — 전이가 암계수 문턱과 겹치면 어떤 엔진도 s_max 를 결정할 수 없다(실데이터 병리와 동일)
  { name: "Hill 진실값 (모델족 밖)", fy: (x) => hillY(x, { A0: 2.6, A: 6.4, q: 3.0, xm: -2.30 }) },
];

for (const C of CASES) {
  const T = truthSmax(C.fy);
  const vals = [], bounds = [];
  for (const seed of SEEDS) {
    const a = F.analyze(makeBranch(C.fy, seed, 0.1, 0.05, 5), { monotone: true });
    vals.push(a.sMax);
    bounds.push(a.boundHits.map((b) => b.param + "@" + b.at).join("+") || "0");
  }
  const st = stats(vals);
  console.log(`\n[${C.name}] 참값 s_max = ${T.sMax.toFixed(3)} @ x=${T.at.toFixed(3)}`);
  console.log("  seeds: " + vals.map((v) => v.toFixed(3)).join(", ") + "   boundHits: " + bounds.join(" / "));
  check(st.cv < 0.15, `시드 간 변동 CV = ${(100 * st.cv).toFixed(1)}% (< 15%)`);
  check(Math.abs(st.med - T.sMax) / T.sMax < 0.15,
    `중앙값 ${st.med.toFixed(3)} vs 참값 ${T.sMax.toFixed(3)} — 오차 ${(100 * Math.abs(st.med - T.sMax) / T.sMax).toFixed(1)}% (< 15%)`);
  check(bounds.every((b) => b === "0"), `제약 경계 접촉 없음 (모두 0) — 값이 데이터에서 나왔다는 조건`);
}

console.log(fail ? `\ntest_seed_stability: ${fail} FAILED` : "\ntest_seed_stability: OK");
process.exit(fail ? 1 : 0);

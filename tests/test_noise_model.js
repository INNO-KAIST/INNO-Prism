// R5: 2성분 노이즈 모델(E2) 검증.
//  (a) 순수 계수 통계만 있는 데이터 → a1 이 Poisson 바닥 1/τ 를 회수하고 초과항은 0
//  (b) setpoint 간 드리프트를 주입 → 초과항 a2 가 회수되고 a1 은 그대로
// 어느 한쪽만 맞추는 구현은 반드시 하나에서 떨어진다.
let F; try { F = require("../src/fit2.js"); } catch (e) { F = require("./fit2.js"); }

let fail = 0;
const check = (cond, msg) => { console.log((cond ? "  ok   " : "  FAIL ") + msg); if (!cond) fail++; };

function poisson(rng, lam) {
  if (lam > 30) return Math.max(Math.round(lam + Math.sqrt(lam) * rng.normal()), 0);
  const L = Math.exp(-lam);
  let k = 0, p = 1;
  do { k++; p *= rng.uniform(); } while (p > L);
  return k - 1;
}
/** τ [s], nRep 반복, driftCV = setpoint 간 비례 드리프트 */
function makeCounting(seed, tau, nRep, driftCV, n) {
  const rng = F.makeRng(seed);
  n = n || 60;
  const xlo = -3, xhi = -1;
  const P = [], I = [], reps = [];
  for (let i = 0; i < n; i++) {
    const xv = xlo + (xhi - xlo) * i / (n - 1);
    // 완만한 S자 (전이 1회) — 노이즈 추정이 신호 곡률을 흡수하지 않는지 함께 본다
    const rate = Math.pow(10, 6.2 + 1.2 * xv + 2.2 * Math.log10(1 + Math.pow(10, (xv + 2.1) * 3)) / 3);
    const drift = driftCV > 0 ? Math.exp(driftCV * rng.normal() - 0.5 * driftCV * driftCV) : 1;
    const lam = rate * drift * tau;
    const r = [];
    for (let j = 0; j < nRep; j++) r.push(poisson(rng, lam) / tau);
    P.push(Math.pow(10, xv));
    I.push(r.reduce((a, b) => a + b, 0) / r.length);
    reps.push(r);
  }
  return { powerAvg: P, intensityAvg: I, powerStd: P.map(() => 0), intensityStd: I.map(() => 0),
           intensityReplicates: reps, acqTime: tau, counting: true };
}

for (const tau of [0.1, 0.02]) {
  const br = makeCounting(7, tau, 5, 0, 60);
  const a = F.analyze(br, { monotone: true });
  const floor = 1 / tau;
  check(a.noise.a1 > 0.6 * floor && a.noise.a1 < 1.6 * floor,
    `(a) τ=${tau}s 순수 계수: a1=${a.noise.a1.toFixed(2)} vs 1/τ=${floor.toFixed(1)}`);
  check(!(a.noise.a2Excess > 0.03),
    `(a) τ=${tau}s 초과항 = ${(a.noise.a2Excess || 0).toFixed(4)} (드리프트 없음 → 0 이어야)`);
}

for (const drift of [0.15, 0.30]) {
  const br = makeCounting(11, 0.1, 5, drift, 60);
  const a = F.analyze(br, { monotone: true });
  check(a.noise.a1 > 6 && a.noise.a1 < 16,
    `(b) 드리프트 ${(100 * drift).toFixed(0)}%: a1=${a.noise.a1.toFixed(2)} 유지 (1/τ=10)`);
  const ex = a.noise.a2Excess || 0, rej = a.noise.excessRejected || 0;
  const got = ex > 0 ? ex : rej;
  check(got > 0.5 * drift && got < 2.0 * drift,
    `(b) 초과항 회수 = ${got.toFixed(3)} vs 주입 ${drift.toFixed(2)}${ex > 0 ? "" : " (상한 게이트로 반려됨)"}`);
}

// 원시 반복이 없으면 구 경로(파일럿 잔차)로 폴백해야 한다 — 회귀 방지
{
  const br = makeCounting(3, 0.1, 5, 0, 60);
  delete br.intensityReplicates;
  const a = F.analyze(br, { monotone: true });
  check(/pilot-residual/.test(a.noise.source), `반복 없음 → 폴백 경로 유지 (${a.noise.source})`);
}

console.log(fail ? `test_noise_model: ${fail} FAILED` : "test_noise_model: OK");
process.exit(fail ? 1 : 0);

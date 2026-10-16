// R1: P-spline 기저의 단위분할(partition of unity) 검증.
// 회귀 대상: evalBasis()가 x === xhi 에서 두 구간을 동시에 켜던 버그
// (기저 합 = 2 → 마지막 격자점 폭주 + 설계행렬 행 오염 → 우측 deg+1 span 적합 붕괴).
let F; try { F = require("../src/fit2.js"); } catch (e) { F = require("./fit2.js"); }

let fail = 0;
const check = (cond, msg) => { if (!cond) { console.log("  FAIL " + msg); fail++; } };

for (const [xlo, xhi, nseg] of [[-3, -1, 12], [-3.431, -2.654, 22], [0, 1, 6], [-5, 2, 22]]) {
  const b = F.makeSplineBasis(xlo, xhi, nseg, 3);
  const xs = [xlo, xhi, xlo + 1e-15, xhi - 1e-15, 0.5 * (xlo + xhi)];
  for (let i = 0; i < 300; i++) xs.push(xlo + (xhi - xlo) * i / 299);
  let worst = 0, worstX = NaN, worstD = 0, worstDx = NaN;
  for (const xv of xs) {
    const s = b.evalBasis(xv, false).reduce((a, v) => a + v, 0);
    if (Math.abs(s - 1) > worst) { worst = Math.abs(s - 1); worstX = xv; }
    const d = b.evalBasis(xv, true).reduce((a, v) => a + v, 0);
    if (Math.abs(d) > worstD) { worstD = Math.abs(d); worstDx = xv; }
  }
  check(worst < 1e-9, `[${xlo},${xhi}] nseg=${nseg}: max |Σ N − 1| = ${worst.toExponential(3)} at x=${worstX}`);
  check(worstD < 1e-6, `[${xlo},${xhi}] nseg=${nseg}: max |Σ N'| = ${worstD.toExponential(3)} at x=${worstDx}`);
  console.log(`  basis[${xlo},${xhi}] nseg=${nseg}  max|ΣN−1|=${worst.toExponential(2)}  max|ΣN'|=${worstD.toExponential(2)}`);
}

// 우측 경계 건전성: 적합된 스플라인이 데이터 범위를 벗어나 폭주하지 않아야 한다.
for (const [name, s] of Object.entries({
  pure_n2: { order: 0, n: 40, k1: 2, k2: 2, k3: 2, c: 9, B: 50, a0: 30, a2: 0.04, xlo: -3, xhi: -1 },
  aval_mid: {},
  saturating: { order: 1, k1: 3, k2: 0.15, t1: -1.8, w: 0.12, c: 10, a2: 0.04 },
})) {
  const d = F.synth(s, 1);
  const a = F.analyze(d.branch || d, { monotone: true });
  const Imax = Math.max(...a.data.I);
  const last = a.splineCurve[a.splineCurve.length - 1];
  const prev = a.splineCurve[a.splineCurve.length - 2];
  check(Math.max(...a.splineCurve) < 10 * Imax, `${name}: splineCurve max ${Math.max(...a.splineCurve).toExponential(2)} > 10× data max ${Imax.toExponential(2)}`);
  check(last / prev < 3, `${name}: 경계 점프 splineCurve[last]/[last-1] = ${(last / prev).toExponential(2)}`);
  const truth = d.truth && isFinite(d.truth.sMax) ? d.truth.sMax : NaN;
  if (isFinite(truth)) check(Math.abs(a.sTotMax - truth) / truth < 0.12,
    `${name}: 비모수 sTotMax ${a.sTotMax.toFixed(3)} vs 참값 ${truth.toFixed(3)} (오차 ${(100 * Math.abs(a.sTotMax - truth) / truth).toFixed(1)}%)`);
  console.log(`  ${name.padEnd(11)} sTotMax=${a.sTotMax.toFixed(3)} truth=${isFinite(truth) ? truth.toFixed(3) : "—"}  splineEnd=${last.toExponential(2)} (data max ${Imax.toExponential(2)})`);
}

console.log(fail ? `test_spline_basis: ${fail} FAILED` : "test_spline_basis: OK");
process.exit(fail ? 1 : 0);

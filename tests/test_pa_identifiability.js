// R4: 실데이터 골든 픽스처 — PA 비식별성 '보고'를 검증한다.
// 이 파일(260803 WJ-0139c #4 Oil Blue)은 setpoint의 52%가 순수 암계수이고
// 점화 전선이 파워 격자보다 예리하며 측정범위 안에 포화가 없다. 따라서
// s_max 는 원리적으로 결정되지 않는다 — 특정 s_max 값을 assert 하면 안 되고,
// 엔진이 "결정 불가"를 이유와 함께 말하는지를 assert 해야 한다.
let F; try { F = require("../src/fit2.js"); } catch (e) { F = require("./fit2.js"); }
const d = require("./testdata/pa_wj0139c_down.json");

let fail = 0;
const check = (cond, msg) => { console.log((cond ? "  ok   " : "  FAIL ") + msg); if (!cond) fail++; };

const I1d = d.Iraw.map((r) => r.reduce((a, b) => a + b, 0) / r.length);
const trace = { P: d.P, I: I1d, W: d.W, Iraw: d.Iraw, acqTime: d.acqTime, counting: true };
const br = F.paHighStateBranch(trace.P, trace.I, trace.W, "down",
  { Iraw: trace.Iraw, acqTime: trace.acqTime, counting: true });

// --- E1: 원시 반복과 dwell 이 엔진까지 도달했는가 ---
check(!!br.intensityReplicates && br.intensityReplicates[0].length === d.nReps,
  `E1 원시 반복 전달 (nReps=${br.intensityReplicates ? br.intensityReplicates[0].length : 0})`);
check(br.acqTime === d.acqTime, `E1 acqTime 전달 (${br.acqTime} s)`);
// --- E7: 이 파일은 setpoint 당 행이 1개 → 고상태 max 집계가 실제로는 일어나지 않는다 ---
check(br.aggEffective === "none", `E7 aggEffective="${br.aggEffective}" (집계 없음을 정직하게 보고)`);

const a = F.analyze(br, { monotone: true, paTrace: trace });
const q = F.evaluate(a, null);

// --- E2: 노이즈 법칙이 Poisson 바닥과 setpoint 간 초과를 모두 회수하는가 ---
check(a.noise.source === "replicates+interset", `E2 노이즈 출처 = ${a.noise.source}`);
check(a.noise.a1 > 0.5 / d.acqTime && a.noise.a1 < 2 / d.acqTime,
  `E2 계수항 a1=${a.noise.a1.toFixed(2)} ≈ 1/τ=${(1 / d.acqTime).toFixed(1)}`);
check(a.noise.a2Excess > 0.04 && a.noise.a2Excess < 0.25,
  `E2 setpoint 간 초과 a2=${a.noise.a2Excess.toFixed(4)}`);
const rel = (Iv) => Math.sqrt(a.noise.a0 ** 2 + a.noise.a1 * Iv + (a.noise.a2 * Iv) ** 2) / Iv;
check(rel(125) > 0.22 && rel(125) < 0.38, `E2 암계수 상대오차 ${rel(125).toFixed(3)} (실측 Poisson ≈ 0.28)`);
check(rel(1.25e5) > 0.05 && rel(1.25e5) < 0.20, `E2 고출력 상대오차 ${rel(1.25e5).toFixed(3)}`);

// --- E4: 제약 접촉이 감지되고 보고 불가로 내려가는가 ---
check(a.boundHits.length > 0, `E4 boundHits=${JSON.stringify(a.boundHits.map((b) => b.param + "@" + b.at))}`);
check(a.sMaxIsLowerBound === true && a.sMaxBoundReason === "constraint", "E4 s_max 를 하한(제약)으로 표시");
check(q.reportable === false, `E4 reportable=false (품질 ${q.score.toFixed(1)} ${q.band})`);
// 주의: maxParamCorr 은 이 모델족에서 잘 맞는 적합도 0.99 를 넘는 것이 정상이므로
// 단독으로는 비식별성의 증거가 되지 않는다(합성 대조에서 확인). 참고 지표로만 본다.
check(a.diagnostics.maxParamCorr > 0.95, `(참고) maxParamCorr=${a.diagnostics.maxParamCorr.toFixed(3)} — 힌지 모델에서는 정상 범위`);

// --- E5: 점화 전선을 이상치로 버리지 않는가 ---
check(a.diagnostics.frontScatter.length >= 4,
  `E5 전선 산포 ${a.diagnostics.frontScatter.length}점 유지 [${a.diagnostics.frontScatter.join(",")}]`);
const xF = a.diagnostics.frontScatter.map((i) => a.data.x[i]);
check(!xF.length || (Math.min(...xF) > -3.05 && Math.max(...xF) < -2.85),
  `E5 유지된 점이 점화 전선 위치(log P ≈ −2.98)에 있음`);
check(a.diagnostics.outliers.length === 0,
  `E5 삭제된 점 ${a.diagnostics.outliers.length}개 (전선 점을 버리지 않음)`);

// --- PA 표준층: 격자 한계 하한은 변형에 무관하게 안정 ---
check(a.paSource === "jump" && a.paGridLimited === true, "PA = 미분해 점프 · grid-limited");
check(Math.abs(a.paJump.slope - 127.68) < 1.0, `PA_jump=${a.paJump.slope.toFixed(2)} (기준 127.68)`);
check(a.paJump.dlogP < 0.01, `Δlog₁₀P=${a.paJump.dlogP.toFixed(4)} — 한 파워 스텝 안에서 점화`);
check(Math.abs(Math.log10(a.paJump.pth) - Math.log10(1.05e-3)) < 0.05,
  `P_th=${a.paJump.pth.toExponential(3)} W`);

// --- E3 이후 비모수층은 안정 구간 안에 있어야 한다 ---
check(a.sTotMax > 18 && a.sTotMax < 32, `비모수 sTotMax=${a.sTotMax.toFixed(2)}`);
const Imax = Math.max(...a.data.I);
check(Math.max(...a.splineCurve) < 10 * Imax, `E3 스플라인 경계 건전 (max=${Math.max(...a.splineCurve).toExponential(2)})`);

console.log(fail ? `test_pa_identifiability: ${fail} FAILED` : "test_pa_identifiability: OK");
process.exit(fail ? 1 : 0);

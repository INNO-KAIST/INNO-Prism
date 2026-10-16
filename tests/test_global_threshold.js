// R7: v2.7 — 전역 탐색(G1) · 접선-교점 문턱(T1) · 신 플랫폼 픽스처 회귀.
//
// 이 픽스처(WJ-0075c)는 첫 픽스처와 성격이 다르다: 점화 이후 구간이 잘 표본화되어
// 분해 가능한 사후 기울기가 실제로 존재한다. 그리고 v2.6 엔진은 이 파일의 down branch 에서
// H0(순수 멱법칙, s_max 4.11, 문턱 NaN)로 파탄났다 — 모델 한계가 아니라 전역해 미탐색이
// 원인이었다(전역 탐색 시 H2, χ² 495,441 → 7,266).
let F; try { F = require("../src/fit2.js"); } catch (e) { F = require("./fit2.js"); }
const d = require("./testdata/pa_wj0075c_updown.json");

let fail = 0;
const check = (cond, msg) => { console.log((cond ? "  ok   " : "  FAIL ") + msg); if (!cond) fail++; };

const I1d = d.Iraw.map((r) => r.reduce((a, b) => a + b, 0) / r.length);
const trace = { P: d.P, I: I1d, W: d.W, Iraw: d.Iraw, acqTime: d.acqTime, counting: true };
const mk = (pass) => F.paHighStateBranch(trace.P, trace.I, trace.W, pass,
  { Iraw: trace.Iraw, acqTime: trace.acqTime, counting: true });

// ── 데이터가 기대한 성격인지 먼저 확인 (픽스처가 조용히 바뀌면 여기서 걸린다) ──
{
  const dark = I1d.slice(0, 60);
  const mean = dark.reduce((a, b) => a + b, 0) / dark.length;
  check(mean > 80 && mean < 200, `암계수 바닥 ${mean.toFixed(0)} cps`);
  check(d.acqTime === 0.1 && d.nReps === 5, `dwell ${d.acqTime}s · 반복 ${d.nReps}회`);
  const x = d.P.map(Math.log10);
  check(Math.max(...x) - Math.min(...x) > 0.7, `파워 범위 ${(Math.max(...x) - Math.min(...x)).toFixed(3)} dec`);
}

for (const pass of ["up", "down"]) {
  const br = mk(pass);
  console.log(`\n[${pass}-scan] n=${br.powerAvg.length}`);
  check(!!br.intensityReplicates, "원시 반복 전달됨");
  check(br.acqTime === d.acqTime, `dwell 전달됨 (${br.acqTime})`);

  const a = F.analyze(br, { monotone: true, paTrace: trace });
  const q = F.evaluate(a, null);

  // ── G1: 전역 탐색이 발산을 막는가 ──
  // v2.6 은 down branch 에서 H2 를 χ² 495,441(H0 보다 40배 나쁨)로 발산시켰다.
  // 차수가 무엇으로 선택되는지는 아래 S1 이 판정하므로 여기서는 발산만 본다.
  const h2 = a.fitsSummary[2];
  check(!h2 || h2.chi2 < 1e5, `H2 χ² = ${h2 ? h2.chi2.toFixed(0) : "-"} — 발산하지 않음 (v2.6 down: 495,441)`);

  // ── G1: 결정론 — 같은 입력이면 같은 결과 ──
  const a2 = F.analyze(br, { monotone: true, paTrace: trace });
  check(Math.abs(a2.sMax - a.sMax) < 1e-9 && a2.chosenOrder === a.chosenOrder,
    `재실행 완전 동일 (s_max ${a.sMax.toFixed(6)}) — 전역 탐색이 결정론적`);

  // ── S1: 이 파일은 옵티마이저 조건만 바꿔도 결과가 달라진다 → 반드시 불안정으로 잡혀야 한다 ──
  // 근거: 파워값에 상대 1e-12(측정 정밀도보다 9 자릿수 작은) 요동을 주면 선택 차수가
  // H0↔H2 로 뒤집히고 χ²(H2)가 7,266↔12,509 로 오간다. "더 잘 맞추기"로 해결할 수 없는
  // 성질이므로, 엔진은 이것을 값이 아니라 '보고 불가'로 표현해야 한다.
  check(a.stability && a.stability.checked, "선택 안정성 검사가 수행됨");
  check(a.stability && a.stability.stable === false,
    `불안정 감지: 차수집합 {${(a.stability.ordersSeen || []).map((o) => "H" + o).join(",")}} · s_max CV ${(a.stability.sMaxCV || 0).toFixed(2)}`);

  // ── T1: 접선-교점 문턱 ──
  const tg = a.thresholdTangent && a.thresholdTangent.spline;
  check(!!tg, "비모수 스플라인 기준 접선-교점 문턱 산출됨");
  if (tg) {
    check(tg.P > 1e-3 && tg.P < 4e-3, `I_th(접선) = ${tg.P.toExponential(3)} W`);
    check(tg.sBase < 1.0, `저출력 baseline 기울기 ${tg.sBase.toFixed(2)} — 암계수 바닥은 평탄해야 함`);
    check(tg.sMax > 15, `접선 기울기 ${tg.sMax.toFixed(1)}`);
  }

  // ── PA 표준층: 점화 전선은 여전히 격자 한계 ──
  check(a.paSource === "jump" && a.paGridLimited === true, "PA = 미분해 점프 · grid-limited");
  check(Math.abs(a.paJump.slope - 102.87) < 1.0, `PA_jump = ${a.paJump.slope.toFixed(2)} (기준 102.87)`);
  check(a.paJump.dlogP < 0.01, `Δlog₁₀P = ${a.paJump.dlogP.toFixed(4)}`);

  // ── 비모수층은 분해 가능한 사후 기울기를 본다 ──
  check(a.sTotMax > 25 && a.sTotMax < 60, `비모수 sTotMax = ${a.sTotMax.toFixed(2)}`);

  // ── E5: 전선 보호가 측정범위를 통째로 덮지 않아야 한다 ──
  const fs = a.diagnostics.frontScatter;
  const span = fs.length >= 2 ? a.data.x[fs[fs.length - 1]] - a.data.x[fs[0]] : 0;
  const total = a.data.x[a.data.x.length - 1] - a.data.x[0];
  check(span <= 0.35 * total,
    `전선 보호 폭 ${span.toFixed(3)} dec / 전체 ${total.toFixed(3)} dec = ${(100 * span / total).toFixed(0)}% (v2.6: 80%)`);

  check(q.reportable === false && q.unstable === true,
    `reportable=false · unstable=true (품질 ${q.score.toFixed(1)} ${q.band})`);
}

console.log(fail ? `\ntest_global_threshold: ${fail} FAILED` : "\ntest_global_threshold: OK");
process.exit(fail ? 1 : 0);

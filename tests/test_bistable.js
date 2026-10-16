// R9: v2.9 (BistableFit) — 쌍안정 모델족.
//
// 이 검사가 지키려는 명제는 하나다: **전환 폭 ω 가 아무리 좁아져도 보고량(n_low, n_high,
// P_switch, 대비비)은 그대로 회수된다.** s_max 를 결정 불가로 만든 축퇴가 이 보고량들에는
// 존재하지 않는다는 것이 모델족을 교체한 이유이고, 그 주장을 여기서 수치로 못 박는다.
// 대조군으로 같은 데이터의 H 족 s_max 가 실제로 발산하는 것을 함께 기록한다.
let F; try { F = require("../src/fit2.js"); } catch (e) { F = require("./fit2.js"); }
const d = require("./testdata/pa_wj0075c_updown.json");

let fail = 0;
const check = (cond, msg) => { console.log((cond ? "  ok   " : "  FAIL ") + msg); if (!cond) fail++; };
const relerr = (v, t) => Math.abs(v - t) / Math.abs(t);

// ── 1) 폭 불변성 (저상태가 보이는 경우) ──
console.log("\n[폭 불변성] 저상태 가지가 암계수 위로 보이는 경우 — 네 보고량 모두 회수되어야 한다");
{
  const SC = { aL: 2.9 };            // 저상태가 바닥 위로 솟는 시나리오
  const T = F.synthBistable(SC, 11).truth;
  const sMaxSeen = [];
  for (const w of [0.08, 0.02, 0.005, 0.001]) {
    const { branch } = F.synthBistable(Object.assign({ w }, SC), 11);
    const a = F.analyze(branch, { stabilityCheck: false, profileSlope: false, bistable: true });
    const b = a.bistable;
    check(!!b, `ω=${w}: 쌍안정 적합 생성`);
    if (!b) continue;
    sMaxSeen.push(a.sMax);
    console.log(`    ω=${String(w).padEnd(6)} n_L=${b.nLow.toFixed(3)} n_H=${b.nHigh.toFixed(3)} P_s=${b.pSwitch.toFixed(4)} log10R=${b.log10Contrast.toFixed(3)} ω̂=${b.switchWidthDec.toFixed(4)} | H족 s_max=${a.sMax.toFixed(2)}`);
    check(relerr(b.nHigh, T.nHigh) < 0.05, `ω=${w}: n_high 오차 ${(100 * relerr(b.nHigh, T.nHigh)).toFixed(1)}% < 5%`);
    check(relerr(b.pSwitch, T.pSwitch) < 0.02, `ω=${w}: P_switch 오차 ${(100 * relerr(b.pSwitch, T.pSwitch)).toFixed(2)}% < 2%`);
    check(relerr(b.log10Contrast, T.log10Contrast) < 0.10, `ω=${w}: log10 대비비 오차 ${(100 * relerr(b.log10Contrast, T.log10Contrast)).toFixed(1)}% < 10%`);
    check(relerr(b.nLow, T.nLow) < 0.20, `ω=${w}: n_low 오차 ${(100 * relerr(b.nLow, T.nLow)).toFixed(1)}% < 20%`);
    check(b.identifiability.lowVisible === true, `ω=${w}: 저상태 식별 가능 판정`);
    check(relerr(b.switchWidthDec, w) < 0.25, `ω=${w}: 전환 폭 회수 ω̂=${b.switchWidthDec.toFixed(4)}`);
  }
  // 대조: 같은 데이터에서 H 족 s_max 는 폭을 따라 배회한다 (이것이 교체의 이유)
  const spread = (Math.max(...sMaxSeen) - Math.min(...sMaxSeen)) / Math.min(...sMaxSeen);
  console.log(`    대조 — H족 s_max: ${sMaxSeen.map((v) => v.toFixed(1)).join(" / ")} (변동 ${(100 * spread).toFixed(0)}%)`);
  check(spread > 1.0, `H족 s_max 는 같은 조건에서 2배 이상 배회 (변동 ${(100 * spread).toFixed(0)}%) — 쌍안정 보고량과 대조됨`);
}

// ── 2) 저상태가 바닥 아래면 n_low·대비비는 '결정 불가'여야 한다 ──
console.log("\n[식별성 게이트] 저상태가 암계수 바닥 아래인 경우");
{
  for (const w of [0.08, 0.005]) {
    const { branch } = F.synthBistable({ w }, 11);   // 기본 시나리오 = 저상태가 묻힘
    const a = F.analyze(branch, { stabilityCheck: false, profileSlope: false, bistable: true });
    const b = a.bistable;
    if (!b) { check(false, `ω=${w}: 적합 실패`); continue; }
    check(b.identifiability.lowVisible === false, `ω=${w}: 저상태 결정 불가로 판정 (n_L 적합값 ${b.nLow.toFixed(3)})`);
    check(isFinite(b.log10ContrastLB), `ω=${w}: 대비비는 하한으로 보고 (≥ ${b.log10ContrastLB.toFixed(3)})`);
    // 결정 불가여도 전환 파워와 고상태 지수는 그대로 결정된다 — 이것이 핵심 이득이다
    check(relerr(b.pSwitch, 1.0) < 0.02, `ω=${w}: 저상태 미결정에도 P_switch 는 회수 (${b.pSwitch.toFixed(4)})`);
    check(relerr(b.nHigh, 1.8) < 0.05, `ω=${w}: 저상태 미결정에도 n_high 는 회수 (${b.nHigh.toFixed(3)})`);
  }
}

// ── 3) 포화 꺾임은 전환 파워 '위'에 있어야 한다 ──
console.log("\n[순서 제약] 포화 꺾임이 전환 아래로 내려가면 고상태 지수가 전환의 경사로가 된다");
{
  const { branch } = F.synthBistable({ w: 0.005 }, 11);
  const a = F.analyze(branch, { stabilityCheck: false, profileSlope: false, bistable: true });
  const b = a.bistable;
  if (b && b.chosenOrder >= 1) check(b.params.xsat > b.params.xs, `x_sat(${b.params.xsat.toFixed(4)}) > x_s(${b.params.xs.toFixed(4)})`);
  else check(true, `포화 없는 BS0 선택 — 순서 제약 해당 없음 (BS${b ? b.chosenOrder : "?"})`);
}

// ── 4) 실측 WJ-0075c — 두 분지 · 히스테리시스 ──
console.log("\n[WJ-0075c] 쌍안정 서술이 H 족보다 지지되는가 · 히스테리시스");
{
  const I1d = d.Iraw.map((r) => r.reduce((a, b) => a + b, 0) / r.length);
  const trace = { P: d.P, I: I1d, W: d.W, Iraw: d.Iraw, acqTime: d.acqTime, counting: true };
  const got = {};
  for (const pass of ["up", "down"]) {
    const br = F.paHighStateBranch(trace.P, trace.I, trace.W, pass,
      { Iraw: d.Iraw, acqTime: d.acqTime, counting: true });
    const a = F.analyze(br, { paTrace: trace, acqTime: d.acqTime, counting: true, stabilityCheck: false });
    const b = a.bistable;
    check(!!b, `${pass}: 게이트(미분해 점프)에서 쌍안정이 자동 실행됨`);
    if (!b) continue;
    got[pass] = b;
    console.log(`    [${pass}] H${a.chosenOrder} χ²=${a.fitsSummary[a.chosenOrder].chi2.toFixed(0)} → BS${b.chosenOrder} χ²=${b.chi2.toFixed(0)} (ΔAICc ${b.aiccVsH.toFixed(0)}) · P_s=${b.pSwitch.toExponential(4)} W · ω=${b.switchWidthDec.toExponential(2)}`);
    check(b.preferred === true, `${pass}: 쌍안정이 AICc 로 더 지지됨 (ΔAICc ${b.aiccVsH.toFixed(0)})`);
    check(b.chi2 < a.fitsSummary[a.chosenOrder].chi2 / 5, `${pass}: χ² 가 1/5 미만으로 감소`);
    check(b.identifiability.lowVisible === false, `${pass}: 저상태는 암계수 아래 — n_low 결정 불가로 정직하게 보고`);
    check(isFinite(b.pSwitch) && b.pSwitch > 1e-4 && b.pSwitch < 1e-1, `${pass}: 전환 파워 ${b.pSwitch.toExponential(3)} W 가 측정범위 안`);
    check(!!b.pSwitchBracket && b.pSwitchBracket[0] <= b.pSwitch && b.pSwitch <= b.pSwitchBracket[1],
      `${pass}: 전환 파워가 실측 두 점 사이에 있음`);
  }
  if (got.up && got.down) {
    const dec = got.up.logPSwitch - got.down.logPSwitch;
    const ratio = Math.pow(10, dec);
    console.log(`    히스테리시스 P_up/P_down = ${ratio.toFixed(3)} (${dec.toFixed(4)} dec)`);
    check(dec > 0, `상행 전환이 하행보다 높은 파워에서 일어남 (히스테리시스의 방향)`);
    // v2.7 접선-교점 문턱(up 2.76 mW / down 1.78 mW → 1.55)과 독립적으로 일치해야 한다
    check(Math.abs(ratio - 1.55) < 0.25, `접선-교점 문턱비(1.55)와 일치 — 독립 방법 교차검증 (${ratio.toFixed(3)})`);
  }
}

// ── 5) 비침습성: 게이트 밖에서는 돌지 않는다 ──
console.log("\n[비침습성]");
{
  const { branch } = F.synth({}, 7);
  const a = F.analyze(branch, { stabilityCheck: false, profileSlope: false });
  check(a.bistable === null, "점프 없는 일반 적합에서는 bistable=null");
  const b2 = F.analyze(branch, { stabilityCheck: false, profileSlope: false, bistable: false });
  check(b2.bistable === null, "bistable:false 로 강제 차단 가능");
}

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);

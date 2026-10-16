// R8: v2.8 (P1) — 고정-기울기 프로파일 우도.
//
// 이 검사가 지키려는 것은 하나다: "얕은 s_max 가 기각된다"는 진술이 실제 제약 최대우도에서
// 나와야 하며, 분해된 전선에서는 참값을 감싸는 하한을, 미분해 전선에서는 '위로 제한 못함'을
// 내야 한다. 이전 구현(k₂ 를 한 점에 고정)은 Δχ² 가 비단조·역방향으로 나와 폐기했다.
let F; try { F = require("../src/fit2.js"); } catch (e) { F = require("./fit2.js"); }
const d = require("./testdata/pa_wj0075c_updown.json");

let fail = 0;
const check = (cond, msg) => { console.log((cond ? "  ok   " : "  FAIL ") + msg); if (!cond) fail++; };

// ── 1) 합성 데이터: 참값을 감싸는 하한을 내는가 ──
console.log("\n[synthetic] 분해된 전선 — 하한이 참값을 감싸야 한다");
for (const [name, sc] of [
  ["k2=3 (얕음)", { k2: 3, w: 0.12, k3: 0.5 }],
  ["k2=8 (기본)", {}],
  ["k2=25 (가파름)", { k2: 25, w: 0.02, n: 80 }],
]) {
  const { branch, truth } = F.synth(sc, 7);
  const a = F.analyze(branch, { stabilityCheck: false, profileSlope: true });
  const sp = a.slopeProfile;
  check(!!sp, `${name}: 프로파일 생성됨`);
  if (!sp) continue;
  console.log(`    true s_max=${truth.sMax.toFixed(2)} fit=${a.sMax.toFixed(2)} verdict=${sp.verdict} floor=${sp.floor}`);
  check(sp.verdict === "bounded", `${name}: 유한한 하한이 잡힘 (verdict=${sp.verdict})`);
  check(sp.floor < truth.sMax, `${name}: 하한 ${sp.floor} < 참값 ${truth.sMax.toFixed(2)} (하한이 참값을 넘지 않음)`);
  check(!isFinite(sp.floorNext) || sp.floorNext >= truth.sMax * 0.9,
    `${name}: 기각이 멈춘 칸 ${sp.floorNext} 이 참값 근방 이상`);
  // Δχ² 는 상한에 대해 비증가여야 한다 (중첩 부분공간)
  let mono = true;
  for (let i = 1; i < sp.caps.length; i++) if (sp.caps[i].dChi2 > sp.caps[i - 1].dChi2 + 1e-6) mono = false;
  check(mono, `${name}: Δχ² 가 상한에 대해 단조 비증가`);
  check(sp.reportedRejected === false, `${name}: 보고된 s_max 가 기각되지 않음`);
}

// ── 2) 순수 멱법칙: 아무 상한도 기각되면 안 된다 ──
console.log("\n[synthetic] 순수 멱법칙 — 급격한 기울기를 요구하지 않아야 한다");
{
  const { branch } = F.synth({ order: 0, k1: 2, k2: 2, k3: 2 }, 7);
  const a = F.analyze(branch, { stabilityCheck: false, profileSlope: true });
  const sp = a.slopeProfile;
  check(!!sp && sp.verdict === "supported", `verdict=${sp ? sp.verdict : "null"} (기각 없음)`);
}

// ── 3) 실측 WJ-0075c: 미분해 전선 — 우도가 s_max 를 위로 제한하지 못해야 한다 ──
console.log("\n[WJ-0075c] 미분해 점화 전선");
{
  const I1d = d.Iraw.map((r) => r.reduce((a, b) => a + b, 0) / r.length);
  const trace = { P: d.P, I: I1d, W: d.W, Iraw: d.Iraw, acqTime: d.acqTime, counting: true };
  for (const pass of ["up", "down"]) {
    const br = F.paHighStateBranch(trace.P, trace.I, trace.W, pass,
      { Iraw: d.Iraw, acqTime: d.acqTime, counting: true });
    const a = F.analyze(br, { paTrace: trace, acqTime: d.acqTime, counting: true, stabilityCheck: false });
    console.log(`  [${pass}] H${a.chosenOrder} sMax=${a.sMax.toFixed(3)} paReport=${a.paReport.toFixed(2)} src=${a.paSource}`);
    // 게이트: jumpWins && paGridLimited 이면 옵션 없이도 자동으로 돌아야 한다
    check(!!a.slopeProfile, `${pass}: 게이트(미분해 점프)에서 프로파일이 자동 실행됨`);
    const sp = a.slopeProfile;
    if (!sp) continue;
    console.log(`    verdict=${sp.verdict} floor=${sp.floor} chi2Ref=${sp.chi2Ref.toFixed(1)}`);
    console.log(`    Δχ²: ${sp.caps.map((r) => `${r.cap}:${r.dChi2.toFixed(1)}`).join("  ")}`);
    check(sp.verdict === "unbounded", `${pass}: 우도가 s_max 를 위로 제한하지 못함`);
    check(sp.reportedRejected === true, `${pass}: 보고된 s_max=${a.sMax.toFixed(2)} 가 자기 우도로 기각됨`);
    // 가장 얕은 상한에서의 Δχ² 는 임계값보다 압도적으로 커야 한다 (경계 사례가 아님)
    check(sp.caps[0].dChi2 > 1000, `${pass}: 얕은 상한 기각이 압도적 (Δχ²=${sp.caps[0].dChi2.toFixed(0)})`);
    let mono = true;
    for (let i = 1; i < sp.caps.length; i++) if (sp.caps[i].dChi2 > sp.caps[i - 1].dChi2 + 1e-6) mono = false;
    check(mono, `${pass}: Δχ² 단조 비증가`);
  }
}

// ── 4) slopeCap 제약이 실제로 s_max 를 묶는가 (볼록결합 논거의 수치 확인) ──
console.log("\n[제약 정확성] slopeCap 이 s_max 를 실제로 묶는지");
{
  const { branch } = F.synth({ k2: 25, w: 0.02, n: 80 }, 7);
  const a = F.analyze(branch, { stabilityCheck: false, profileSlope: true });
  const sp = a.slopeProfile;
  let ok = true;
  for (const r of sp.caps) if (isFinite(r.sMax) && r.sMax > r.cap * (1 + 1e-6)) ok = false;
  check(ok, "모든 상한에서 적합된 s_max ≤ 상한");
}

// ── 5) 기본 경로에는 영향이 없어야 한다 (프로파일은 게이트에서만) ──
console.log("\n[비침습성] 게이트 밖에서는 프로파일이 돌지 않는다");
{
  const { branch } = F.synth({}, 7);
  const a = F.analyze(branch, { stabilityCheck: false });
  check(a.slopeProfile === null, "paTrace 없는 일반 적합에서는 slopeProfile=null");
  const b = F.analyze(branch, { stabilityCheck: false, profileSlope: false });
  check(b.slopeProfile === null, "profileSlope:false 로 강제 차단 가능");
}

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);

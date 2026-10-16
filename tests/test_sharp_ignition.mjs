/* =============================================================================
 * 급격한 점화(sharp ignition) 회귀 감시 — WJ-0141c up branch
 *
 * ★ 이 파일의 숫자는 **목표값이 아니다.** 여기에 맞추려고 모델을 조정하지 말 것.
 *   역할은 둘뿐이다: 수정 전 실패가 재현되는가 / 수정 후 같은 **양상**이 사라졌는가.
 *   통과 기준은 값 일치가 아니라 **자료 자신에 대한 관계**다.
 *
 * 사례가 둘인 이유:
 *   A. h5 원본 — 반복 측정이 살아 있어 노이즈 법칙이 측정된다. 보고된 반례 상태가
 *      그대로 재현되는 유일한 경로다.
 *   B. CSV fixture — 반복이 없다(I_std 열이 0). 같은 자료인데 노이즈 법칙이
 *      파일럿 residual 폴백으로 바뀌어 **적합 자체가 달라진다**(실측: s_max 13.1 → 30.0).
 *      그래서 B 에서는 자료 무관 불변식만 검사한다. 이 차이 자체가 기록할 사실이다.
 * ========================================================================== */
import h5wasm from "h5wasm/node";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import fs from "fs";
const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const SRC = (m) => join(here, "..", "src", m);
const DATA = (f) => join(here, "testdata", f);
const F = require(SRC("fit2.js"));

let fail = 0;
const check = (n, ok, info) => { console.log(`  ${ok ? "PASS" : "FAIL"} ${n}${info ? " — " + info : ""}`); if (!ok) fail++; };

/** 자료가 직접 말하는 암→점등 브래킷 (model-free, 검사의 기준선) */
function observedBracket(P, I) {
  const lowS = I.slice().sort((a, b) => a - b).slice(0, Math.floor(0.25 * I.length));
  const D = lowS[Math.floor(lowS.length / 2)];
  const m = lowS.reduce((s, v) => s + v, 0) / lowS.length;
  const sd = Math.sqrt(lowS.reduce((s, v) => s + (v - m) * (v - m), 0) / lowS.length);
  const gate = D + 8 * sd;
  let iLit = -1;
  for (let i = 1; i < I.length - 1; i++) if (I[i] > gate && I[i + 1] > gate) { iLit = i; break; }
  let iDark = -1;
  for (let i = iLit - 1; i >= 0; i--) if (I[i] <= gate) { iDark = i; break; }
  return { gate, iDark, iLit, pLo: P[iDark], pHi: P[iLit] };
}

/** 어떤 자료에서도 성립해야 하는 불변식 (요구사항 3·4) */
function invariants(a, tag) {
  check(`${tag} lower bound이면 paSource 가 'resolved' 가 아니다`,
    !a.sMaxIsLowerBound || a.paSource !== "resolved", `LB=${a.sMaxIsLowerBound} src=${a.paSource}`);
  check(`${tag} lower bound이면 slopeProfile 이 산출된다`,
    !a.sMaxIsLowerBound || a.slopeProfile !== null,
    a.slopeProfile ? `floor=${a.slopeProfile.floor} ${a.slopeProfile.verdict}` : "null");
  check(`${tag} 보고값이 산출된 모든 lower bound 이상이다`,
    a.paReport >= Math.max(a.sLowerBound ? a.sLowerBound.slope : -Infinity,
      a.slopeProfile && isFinite(a.slopeProfile.floor) ? a.slopeProfile.floor : -Infinity) - 1e-9,
    `paReport=${a.paReport.toFixed(3)}`);
  check(`${tag} secant lower bound basis 면 Δlog P 가 함께 나온다`,
    a.paReportBasis !== "secant" || isFinite(a.paReportDlogP), `Δlog P=${a.paReportDlogP}`);
  check(`${tag} bistable 경계 접촉이 호출자에게 노출된다`,
    !a.bistable || Array.isArray(a.bistable.boundHits),
    a.bistable ? `[${(a.bistable.boundHits || []).map((b) => b.param).join(",")}]` : "-");
  check(`${tag} 경계에 붙은 nu 는 nuAtBound 로 표시된다`,
    !a.bistable || a.bistable.nuAtBound === (a.bistable.boundHits || []).some((b) => b.param === "nu"));
}

/* ---- A. h5 원본 (반례 그 자체) ---------------------------------------- */
const H5 = DATA("260914_WJ-0141c_Oil_Blue_power_scan.h5");
if (!fs.existsSync(H5)) {
  console.log("SKIP(A) — testdata 에 반례 h5 가 없습니다:", H5);
} else {
  const H = require(SRC("h5layer.js"));
  await h5wasm.ready;
  const f = new h5wasm.File(H5, "r");
  const det = H.detectType(f);
  const tr = H.extractPATrace(f, det.type, 480, 680, det);
  const branch = F.paHighStateBranch(tr.P, tr.I, tr.W, "up", { Iraw: tr.Iraw, acqTime: tr.acqTime, counting: true });
  const a = F.analyze(branch, { monotone: true, lambdaFactor: 1, paTrace: tr, branchName: "up" });
  a.quality = F.evaluate(a, null);
  const ob = observedBracket(branch.powerAvg, branch.intensityAvg);
  console.log(`\n[A] h5 원본 (반복 살아 있음) — n=${branch.powerAvg.length}, 관측 브래킷 ${(ob.pLo*1e3).toFixed(4)}–${(ob.pHi*1e3).toFixed(4)} mW`);
  check("A 문턱이 관측 ignition bracket 안에 있다 (저파워로 끌리지 않는다)",
    isFinite(a.thresholdP) && a.thresholdP >= ob.pLo * 0.999 && a.thresholdP <= ob.pHi * 1.001,
    `thresholdP=${a.thresholdP.toExponential(5)} src=${a.thresholdSource}`);
  check("A 대체 시 모델 문턱이 보존된다", a.thresholdSource !== "ignition-bracket" || isFinite(a.thresholdPModel),
    `model=${(a.thresholdPModel || NaN).toExponential(5)}`);
  check("A model-free secant lower bound가 파라메트릭 s_max 를 넘는다 (point estimate가 refuted)",
    !!(a.sLowerBound && a.sLowerBound.slope > a.sMax),
    a.sLowerBound ? `≥${a.sLowerBound.slope.toFixed(2)} vs s_max=${a.sMax.toFixed(2)} (Δlog P=${a.sLowerBound.dlogP.toFixed(4)} dec)` : "null");
  check("A 그래서 lower bound로 보고한다", a.paSource === "lower-bound" && a.paReportBasis === "secant",
    `${a.paSource}/${a.paReportBasis} paReport=${a.paReport.toFixed(2)}`);
  check("A bistable θ 상자 경계가 잡힌다 (nu 가 값처럼 보고되지 않도록)",
    !!(a.bistable && a.bistable.boundHits.length > 0),
    a.bistable ? a.bistable.paramsAtBound.join(",") : "-");
  invariants(a, "A");
  console.log(`  참고(목표 아님): sMax=${a.sMax.toFixed(3)} paReport=${a.paReport.toFixed(3)} thr=${a.thresholdP.toExponential(4)} q=${a.quality.score.toFixed(1)}`);
  f.close();
}

/* ---- B. CSV fixture (반복 없음 — 불변식만) ---------------------------- */
const CSV = DATA("fixture_WJ-0141c_upbranch.csv");
if (!fs.existsSync(CSV)) {
  console.log("\nSKIP(B) — testdata 에 fixture CSV 가 없습니다");
} else {
  const lines = fs.readFileSync(CSV, "utf8").trim().split("\n");
  const head = lines[0].split(",");
  const iBr = head.indexOf("branch"), iP = head.indexOf("P_W"), iI = head.indexOf("I_counts");
  const P = [], I = [];
  for (let r = 1; r < lines.length; r++) {
    const c = lines[r].split(",");
    if (c[iBr] !== "up") continue;
    P.push(Number(c[iP])); I.push(Number(c[iI]));
  }
  const branch = { powerAvg: P, intensityAvg: I, powerStd: P.map(() => 0), intensityStd: I.map(() => 0),
    intensityReplicates: null, counting: true };
  const a = F.analyze(branch, { monotone: true, lambdaFactor: 1 });
  a.quality = F.evaluate(a, null);
  const ob = observedBracket(P, I);
  console.log(`\n[B] CSV fixture (반복 없음) — n=${P.length}, 관측 브래킷 ${(ob.pLo*1e3).toFixed(4)}–${(ob.pHi*1e3).toFixed(4)} mW`);
  check("B 문턱이 관측 ignition bracket 안에 있다",
    isFinite(a.thresholdP) && a.thresholdP >= ob.pLo * 0.999 && a.thresholdP <= ob.pHi * 1.001,
    `thresholdP=${a.thresholdP.toExponential(5)} src=${a.thresholdSource}`);
  invariants(a, "B");
  console.log(`  참고(목표 아님): sMax=${a.sMax.toFixed(3)} paReport=${a.paReport.toFixed(3)} — A 와 다른 것이 정상이다(반복 없음 → 노이즈 법칙 폴백)`);
}

console.log(fail ? `\n${fail} FAILURES` : "\nALL PASS");
process.exit(fail ? 1 : 0);

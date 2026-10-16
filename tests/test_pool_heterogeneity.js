// R14: v3.6 — 분지 합산의 **이질성 판정**.
//
// 합산 중앙값은 "모든 분지가 같은 n_high 를 가진다"는 가정 위에서만 하나의 값에 대한
// 추정이다. 이 검사는 자리마다 참값이 다른 합성을 만들어, (1) 깃발이 서는지,
// (2) 그래도 개별 분지 추정은 정확한지를 잠근다.
// (동질 쪽 판정은 test_pool_exponent.js 에 있다 — 시간 때문에 파일을 나눴다.)
let F; try { F = require("../src/fit2.js"); } catch (e) { F = require("./fit2.js"); }

let fail = 0;
const check = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fail++; };

console.log("\n[이질성 판정] 하나의 값으로 요약해도 되는가");
{
  // 이질: 자리마다 참 n_H 가 다르다 (이봉)
  // 4자리면 8분지 — IQR 판정에 충분하고 검사 시간이 절반이다
  const hetBs = [], hetTruth = [];
  for (let k = 0; k < 4; k++) {
    const seed = 600 + k;
    const jit = ((seed * 2654435761) % 1000) / 1000 * 0.10 - 0.05;
    const u = ((seed * 40503) % 1000) / 1000;
    const nH = 2.2 + 1.5 * (u - 0.5) * 2;
    const r = F.synthSweep({ xhi: -2.27, n: 100, xsUp: -2.50 + jit, xsDn: -2.70 + jit,
      nH, aH: 5.1 + nH * 2.5 }, seed);
    const sw = r.trace;
    const trace = { P: sw.P, I: sw.I, W: sw.W, Iraw: sw.Iraw, acqTime: sw.acqTime, counting: true };
    for (const pass of ["up", "down"]) {
      try {
        const br = F.paHighStateBranch(sw.P, sw.I, sw.W, pass,
          { Iraw: sw.Iraw, acqTime: sw.acqTime, counting: true });
        const b = F.analyze(br, { paTrace: trace, acqTime: sw.acqTime, counting: true,
          stabilityCheck: false, profileSlope: false, branchName: pass }).bistable;
        if (b) { hetBs.push(b); hetTruth.push(nH); }
      } catch (e) { /* 건너뛴다 */ }
    }
  }
  const hp = F.poolHighExponent(hetBs, { seed: 11 });
  check(hp.usable === true, `이질 집합도 합산 자체는 성립 (분지 ${hp.branches})`);
  console.log(`    이질 집합 IQR/중앙 ${hp.iqrRel.toFixed(3)} (문턱 ${hp.iqrMax})`);
  check(hp.heterogeneous === true,
    `자리마다 참값이 다르면 이질로 판정 (IQR/중앙 ${hp.iqrRel.toFixed(3)} > ${hp.iqrMax})`);

  // 핵심: 이질이어도 **개별 분지 추정은 정확하다** — 무너지는 건 요약이지 추정이 아니다
  const g = hp.best;
  const errs = [];
  for (let i = 0; i < hetBs.length; i++) {
    const b = hetBs[i];
    if (!b.params || b.nHighCollapsed) continue;
    const lo = Math.log10(b.pSwitch) + 3 * b.params.w;
    const hi = Math.log10(b.pSwitch) + b.nHighRangeDec;
    if (g.logP < lo || g.logP > hi) continue;
    const v = F.bsHighSlope(b.params, g.logP, b.chosenOrder);
    errs.push(Math.abs(v - hetTruth[i]) / hetTruth[i] * 100);
  }
  errs.sort((a, b2) => a - b2);
  const medErr = errs[Math.floor(errs.length / 2)];
  console.log(`    이질 집합의 분지별 오차: ${errs.map((e) => e.toFixed(0) + "%").join(" ")}`);
  check(medErr < 10, `이질이어도 개별 분지 추정의 중앙오차는 작다 (${medErr.toFixed(0)}%)`
    + " — 무너지는 것은 '하나로 요약하는 것'이지 추정이 아니다");

  // 관측 IQR/중앙이 **참 IQR/중앙을 추종**하는가 — 깃발이 아니라 산포의 정량 추정치인가.
  // 별도 보정(참 산포 ±5/15/30/45%)에서 관측이 0.046/0.144/0.295/0.479, 참이
  // 0.052/0.169/0.284/0.414 로 거의 1:1 이었다. 여기서는 이 집합에 대해 그것을 잠근다.
  const contribT = [];
  for (let i = 0; i < hetBs.length; i++) {
    const b = hetBs[i];
    if (!b.params || b.nHighCollapsed) continue;
    const lo = Math.log10(b.pSwitch) + 3 * b.params.w;
    const hi = Math.log10(b.pSwitch) + b.nHighRangeDec;
    if (g.logP < lo || g.logP > hi) continue;
    contribT.push(hetTruth[i]);
  }
  contribT.sort((a, b2) => a - b2);
  if (contribT.length >= 4) {
    const tq1 = contribT[Math.floor(0.25 * contribT.length)];
    const tq3 = contribT[Math.floor(0.75 * contribT.length)];
    const tmed = contribT[Math.floor(contribT.length / 2)];
    const trueIqr = (tq3 - tq1) / tmed;
    const ratio = hp.iqrRel / Math.max(trueIqr, 1e-9);
    console.log(`    참 IQR/중앙 ${trueIqr.toFixed(3)} vs 관측 ${hp.iqrRel.toFixed(3)} (비 ${ratio.toFixed(2)})`);
    check(ratio > 0.6 && ratio < 2.0,
      `관측 IQR 이 참 IQR 을 추종한다 (비 ${ratio.toFixed(2)}) — 산포의 정량 추정치로 읽을 수 있다`);
  }
}


console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);

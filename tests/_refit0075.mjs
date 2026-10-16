import { createRequire } from "module"; import fs from "fs";
const require = createRequire(import.meta.url);
const F = require("../src/fit2.js");
const D = JSON.parse(fs.readFileSync("./tests/testdata/wj0075c_in.json","utf8"));
const tr = D.paTrace;
const branch = F.paHighStateBranch(tr.P, tr.I, tr.W, D.branchName || "up",
  { Iraw: tr.Iraw || null, acqTime: D.acqTime, counting: !!D.counting });
console.log("branch n =", branch.powerAvg.length, " reps:", !!branch.intensityReplicates);
const r = F.analyze(branch,
  {monotone:true, global:true, paTrace:tr, acqTime:D.acqTime, counting:D.counting, branchName:D.branchName});
const f=(v,n=4)=>Number.isFinite(v)?v.toFixed(n):String(v);
console.log("paSource      :", r.paSource);
console.log("paReport      :", f(r.paReport,3), " basis:", r.paReportBasis, " ΔlogP:", f(r.paReportDlogP,5));
console.log("paJump        :", r.paJump? `${f(r.paJump.slope,3)} @ pth=${f(r.paJump.pth,6)} (하한에 밀림: ${r.paJump.supersededByBound})` : "null");
console.log("secant 하한   :", f(r.sLowerBound?.slope,3), `@ ${f(r.sLowerBound?.pLo,6)}→${f(r.sLowerBound?.pHi,6)}  (I ${r.sLowerBound?.iLoValue}→${r.sLowerBound?.iHiValue})`);
console.log("sMax          :", f(r.sMax,3), "@ P=", f(r.sMaxAtP,6), " lowerBound:", r.sMaxIsLowerBound, r.sMaxBoundReason);
console.log("sMaxObservable:", JSON.stringify({signal:Number(r.sMaxObservable.signal.toPrecision(3)),
  gate:Number(r.sMaxObservable.gate.toPrecision(4)), observable:r.sMaxObservable.observable, why:r.sMaxObservable.why}));
console.log("sMaxObs(관측가능 구간 한정):", f(r.sMaxObs,3), "@ P=", f(r.sMaxObsAtP,6));
console.log("threshold     :", f(r.thresholdP,6), " source:", r.thresholdSource);
if (r.quality) console.log("quality       :", f(r.quality.score,1), r.quality.band, " reportable:", r.quality.reportable);
console.log("chi2red:", f(r.diagnostics.chi2red,2), " runsP:", f(r.diagnostics.runsP,5), " params:", JSON.stringify(Object.fromEntries(Object.entries(r.params).map(([k,v])=>[k,Number(v.toPrecision(5))]))));
console.log("\n=== 중재 결과 (paSelect) ===");
const S = r.paSelect;
console.log(`  값 ${f(S.value,3)}  종류 ${S.kind}  출처 ${S.source}`);
console.log(`  위치 P=${f(S.location,6)} (${S.locationKind}) · 관측가능 ${S.locationObservable}`);
console.log("  주의:"); for (const n of S.notes) console.log("    · " + n);
console.log("  기각된 추정기:");
for (const q of S.rejected) console.log(`    · ${q.name.padEnd(15)} ${Number.isFinite(q.value)?q.value.toFixed(3).padStart(9):"   -"}  ${q.why}`);

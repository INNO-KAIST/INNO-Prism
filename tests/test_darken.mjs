import h5wasm from "h5wasm/node";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import fsx from "fs";
const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const SRC = (m) => join(here, "..", "src", m);
const DATA = (fn) => join(here, "testdata", fn.replace(/^testdata\//, ""));
/** 저장소에 없는 실측 데이터를 쓰는 검사는 **이유를 밝히고 건너뛴다**.
 *  실패로 처리하면 코드 결함이 아닌데 결함처럼 보인다. */
const needData = (names) => {
  const miss = names.filter((n) => !fsx.existsSync(DATA(n)));
  if (miss.length) {
    console.log(`SKIP — testdata/ 에 없는 파일: ${miss.join(", ")}`);
    console.log("  (이 검사는 저장소에 포함되지 않은 실측 h5 를 씁니다)");
    process.exit(0);
  }
};
needData(["darkening_ex1.h5","darkening_ex2.h5","darkening_ex3.h5"]);

const H = require(SRC("h5layer.js"));
const F = require(SRC("fit2.js"));
import fs from "fs";
import { openH5 } from "./h5open.mjs";
const Module = await h5wasm.ready;
let fail = 0;
const check = (n, ok, info) => { console.log(`  ${ok ? "PASS" : "FAIL"} ${n}${info ? " — " + info : ""}`); if (!ok) fail++; };
for (const fn of ["darkening_ex1.h5", "darkening_ex2.h5", "darkening_ex3.h5"]) {
  const f = openH5(h5wasm, Module, DATA(fn));
  const det = H.detectType(f);
  const d = H.extractDarkening(f, det.darkGroup);
  const a = F.darkenAnalyze(d, {});
  const s = a.summary;
  console.log(`${fn}: type=${det.type} traces=${d.traces.length} acq=${d.acqTime}s`);
  console.log(`  onset=${(s.onsetP * 1e6).toFixed(1)}uW maxLoss=${(100 * s.maxLoss).toFixed(1)}% @${(s.maxLossP * 1e6).toFixed(1)}uW t50=${s.maxLossT50?.toFixed(1)}s tauEff=${s.maxLossTauEff?.toFixed(1)}s dark=${s.nDark}/${s.nTraces}`);
  for (const r of a.perTrace) {
    console.log(`   ${(r.P * 1e6).toFixed(1).padStart(6)}uW  ${r.verdict.padEnd(11)} loss=${(100 * r.loss).toFixed(1).padStart(6)}%  t50=${r.free ? r.free.t50?.toFixed(1) : "-"}s  model=${r.fit ? r.fit.model : "-"}${r.fit && r.fit.params.beta ? " β=" + r.fit.params.beta.toFixed(2) : ""}`);
  }
  if (fn === "darkening_ex1.h5") {
    check("detected darkening", det.type === "darkening");
    check("13 traces", d.traces.length === 13);
    const low = a.perTrace[0], high = a.perTrace[12];
    check("low power stable", low.verdict === "stable", low.verdict);
    check("high power darkening", high.verdict === "darkening");
    check("high power loss ~44%", Math.abs(high.loss - 0.44) < 0.05, (100 * high.loss).toFixed(1) + "%");
    const a2 = F.darkenAnalyze(d, {});
    check("deterministic", JSON.stringify(a.summary) === JSON.stringify(a2.summary));
  }
  f.close();
}
console.log(fail ? `\n${fail} FAILURES` : "\nALL PASS");
process.exit(fail ? 1 : 0);

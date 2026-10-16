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

const H = require(SRC("h5layer.js"));
const F = require(SRC("fit2.js"));
import fs from "fs";
import { openH5 } from "./h5open.mjs";
const Module = await h5wasm.ready;
for (const fn of ["testdata/synth_rise_avalanche.h5", "testdata/synth_rise_exp.h5"]) {
  const f = openH5(h5wasm, Module, DATA(fn));
  const det = H.detectType(f);
  const d = H.extractRiseTime(f, det.riseGroup);
  const a = F.riseAnalyze({ t: d.t, c: d.c, gateOnIdx: d.gateOnIdx, gateOffIdx: d.gateOffIdx, dtMedian: d.dtMedian, spikes: d.spikes }, {});
  const r = a.rise;
  console.log(fn.split("/")[1], "| type:", det.type, "| spikes:", d.spikes.length, "| gateOn:", d.gateOnIdx, "off:", d.gateOffIdx);
  console.log("  verdict:", a.verdict.klass, "| model:", r.fit && r.fit.model,
    "| t10-90:", (r.free.t1090*1e3).toFixed(1)+"ms", "| rho:", r.free.induction.toFixed(3),
    r.fit && r.fit.model === "logistic_delay" ? "| r=" + r.fit.params.r.toFixed(2) + "/s tm=" + (r.fit.params.tm*1e3).toFixed(0) + "ms" : "",
    "| decay tau:", a.decay && a.decay.fit ? (a.decay.fit.tauEff*1e3).toFixed(1)+"ms" : "-");
  f.close();
}

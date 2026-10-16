import h5wasm from "h5wasm/node";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import fsx from "fs";
const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const SRC = (m) => join(here, "..", "src", m);
const DATA = (fn) => join(here, "testdata", fn.replace(/^testdata\//, ""));
/** 이 검사의 사례 목록은 저장소에 든 합성 파일과 저장소에 없는 실측 파일이 섞여 있다.
 *  없는 파일 하나 때문에 전체를 중단하면 있는 사례의 회귀까지 못 본다.
 *  따라서 **사례 단위로** 건너뛰고, 무엇을 건너뛰었는지 끝에 밝힌다. */
const haveData = (fn) => fsx.existsSync(DATA(fn));

const H = require(SRC("h5layer.js"));
const E = require(SRC("engine.js"));
const F = require(SRC("fit2.js"));
import fs from "fs";
import { openH5 } from "./h5open.mjs";
const Module = await h5wasm.ready;
let fail = 0;
const check = (n, ok, info) => { console.log(`  ${ok ? "PASS" : "FAIL"} ${n}${info ? " — " + info : ""}`); if (!ok) fail++; };

const cases = [
  // 기존 실측 파일 (회귀)
  ["260430_(power_scan)_WJ-0041c #1.h5", "power_apd", true],
  ["250623_145548_[20%Tm_AS-35]_(800nmPL_exp1s)_power_scan.h5", "power_emccd", true],
  ["apd_power_scan_example_01.h5", "power_apd", true],
  ["darkening_ex1.h5", "darkening", false],
  ["synth_rise_avalanche.h5", "rise_time", false],
  ["synth_wave2d.h5", "scan2d", false],
  // 새 플랫폼 변형
  ["nv1_snspd.h5", "power_apd", true],
  ["nv2_plain.h5", "power_apd", true],
  ["nv3_group.h5", "power_apd", true],
  ["nv4_spec.h5", "power_emccd", true],
  // 새 측정 플랫폼 실측 파일 (detector/_reps 스키마)
  ["newplat_power_scan.h5", "power_apd", true],
];
const skipped = [];
let ran = 0;
for (const [fn, want, isPower] of cases) {
  if (!haveData(fn)) { skipped.push(fn); continue; }
  ran++;
  const f = openH5(h5wasm, Module, DATA(fn));
  const det = H.detectType(f);
  const via = det.ps ? `구조탐지 ${det.ps.group}` : "레거시 고정경로";
  check(`${fn.slice(0, 42).padEnd(42)} → ${det.type}`, det.type === want, want === det.type ? via : `기대 ${want}`);
  if (isPower && det.type === want) {
    // 실제 로드 + 피팅까지 되는지
    try {
      let loaded;
      if (det.type === "power_apd") {
        const r = H.extractPowerScanAPD(f, det);
        loaded = E.buildLoadedFromAPD(r.count2D, r.power2D);
      } else {
        const r = H.extractPowerScanEMCCD(f, det);
        loaded = E.buildLoadedFromEMCCD(r.spectra, r.power2D, r.wls, 780, 820);
      }
      const br = E.splitBranches(loaded);
      const a = F.analyze(br.up || br.all, { monotone: true });
      check(`   └ 로드·피팅 (n=${loaded.xRawAvg.length}, s_max=${a.sMax.toFixed(3)})`, isFinite(a.sMax) && a.sMax > 0);
    } catch (e) { check("   └ 로드·피팅", false, e.message); }
  }
  f.close();
}
if (skipped.length) {
  console.log(`\nSKIP ${skipped.length}/${cases.length} 사례 — testdata/ 에 없는 실측 h5:`);
  for (const s of skipped) console.log("  · " + s);
}
console.log(fail ? `\n${fail} FAILURES (${ran} 사례 실행)` : `\nALL PASS (${ran} 사례 실행)`);
await new Promise((r) => setTimeout(r, 50));
process.exit(fail ? 1 : 0);

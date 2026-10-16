// Node test: run JS engine on example data, compare against Python reference.
const fs = require("fs");
const E = require("../src/engine.js");

/** 이 검사는 구형 Python 분석기의 참조 출력(py_reference.json)과 그때 쓴 입력
 *  (test_input.json) 이 둘 다 있어야 돈다. 입력은 저장소에 없다 —
 *  실측 h5 에서 뽑은 것이라 크기 때문에 넣지 않았다.
 *  없으면 **실패가 아니라 이유를 밝히고 건너뛴다**: 코드 결함과 데이터 부재를 섞지 않는다.
 *  재생성 방법은 py_reference.py 머리말에 있다. */
for (const need of ["test_input.json", "py_reference.json"]) {
  if (!fs.existsSync(__dirname + "/" + need)) {
    console.log(`SKIP — tests/${need} 없음 (구형 Python 분석기 대조용 입력·참조)`);
    console.log("  재생성: py_reference.py 머리말 참조");
    process.exit(0);
  }
}
const input = JSON.parse(fs.readFileSync(__dirname + "/test_input.json", "utf8"));
const ref = JSON.parse(fs.readFileSync(__dirname + "/py_reference.json", "utf8"));

function relDiff(a, b) {
  if (a == null || b == null || !isFinite(a) || !isFinite(b)) return NaN;
  return Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1e-12);
}
let failures = 0, checks = 0;
function check(label, a, b, tol, mode) {
  checks++;
  let ok;
  if (mode === "exact") ok = a === b;
  else {
    const d = relDiff(a, b);
    ok = isFinite(d) ? d <= tol : (a == null || !isFinite(a)) === (b == null || !isFinite(b));
  }
  if (!ok) { failures++; console.log(`  FAIL ${label}: js=${a} py=${b}`); }
  else console.log(`  ok   ${label}: js=${fmt(a)} py=${fmt(b)}`);
}
const fmt = (v) => (typeof v === "number" ? Number(v.toPrecision(6)) : v);

function runCase(refCase, loaded) {
  console.log(`\n=== ${refCase.file} [${refCase.branch}] ===`);
  const branches = E.splitBranches(loaded);
  check("scan_mode", branches.scanMode, refCase.scan_mode, 0, "exact");
  check("peak_index", branches.peakIndexAll, refCase.peak_index, 0, "exact");
  const branch = refCase.branch === "down" && branches.down ? branches.down : branches[refCase.branch] || branches.up;
  const settings = {
    smoothingLevel: 2, monotonicityTolerance: "medium", transitionMode: "auto",
    primaryFit: "constrained",
  };
  const analysis = E.analyzeBranch(branch, settings);
  const prep = analysis.prep;
  check("prep.n_analysis", prep.analysisPower.length, refCase.prep.n_analysis, 0, "exact");
  check("prep.nonmonotonic", prep.nonmonotonicPointCount, refCase.prep.nonmonotonic, 0, "exact");
  check("prep.dynamic_range", prep.dynamicRangeRatio, refCase.prep.dynamic_range_ratio, 1e-9);
  check("prep.baseline_est", prep.derivativeBaselineEstimate, refCase.prep.baseline_est, 1e-9);
  check("prep.transition_power", prep.transitionPower, refCase.prep.transition_power, 1e-6);
  // x/y arrays exact
  let xerr = 0;
  for (let i = 0; i < prep.analysisPower.length; i++) {
    xerr = Math.max(xerr, relDiff(prep.analysisPower[i], refCase.prep.x[i]) || 0,
                    relDiff(prep.analysisIntensity[i], refCase.prep.y[i]) || 0);
  }
  check("prep.xy_max_reldiff", xerr, 0, 1e-9);

  // segment fit on analysis arrays with same sigma
  const sigma = E.estimateSigmaLog(prep, prep.yFit, "replicate_hybrid", "gaussian_replicate");
  const seg = E.segmentFit3(prep.xFit, prep.yFit, sigma, 3);
  check("segment.pa_slope", seg.paSlope, refCase.segment.pa_slope, 1e-6);
  check("segment.pa_slope_err", seg.paSlopeErr, refCase.segment.pa_slope_err, 1e-3);
  check("segment.threshold_power", seg.thresholdPower, refCase.segment.threshold_power, 1e-6);
  check("segment.saturation_power", seg.saturationPower, refCase.segment.saturation_power, 1e-6);
  check("segment.sat_observed", seg.saturationObserved, refCase.segment.saturation_observed, 0, "exact");

  for (const [jsFit, refFit] of [[analysis.unconstrained, refCase.unconstrained], [analysis.constrained, refCase.constrained]]) {
    const tag = refFit.fit_name;
    check(`${tag}.success`, jsFit.success, refFit.success, 0, "exact");
    const refKind = (refFit.kind.match(/global_model_family:(\w+)/) || [])[1];
    check(`${tag}.family`, jsFit.kind, refKind, 0, "exact");
    check(`${tag}.pa_slope_segment`, jsFit.slopeAtTransition, refFit.pa_slope_segment, 1e-5);
    check(`${tag}.threshold`, jsFit.thresholdSegmentedIntersection, refFit.threshold_power, 1e-5);
    check(`${tag}.r2`, jsFit.r2, refFit.r2, 5e-3);
    check(`${tag}.bic`, jsFit.bic, refFit.bic, 0.05);
    check(`${tag}.baseline_B`, jsFit.baselineB, refFit.baseline_B, 0.15);
    check(`${tag}.n_exp(steepness)`, jsFit.steepnessK, refFit.steepness_k, 0.10);
  }
  check("primary", analysis.primaryFitName, refCase.primary, 0, "exact");
  check("quality.score", analysis.quality.score, refCase.quality.score, 0.05);
  check("quality.gof", analysis.quality.goodnessOfFit, refCase.quality.gof, 0.05);
  check("quality.consistency", analysis.quality.modelConsistency, refCase.quality.consistency, 0.1);
  return analysis;
}

// build loaded structures
const apdLoaded = E.buildLoadedFromAPD(input.apd.count2D, input.apd.power2D);
const emSpec = { n: input.emccd.n, reps: input.emccd.reps, pix: input.emccd.pix, data: Float64Array.from(input.emccd.spectra) };
const emLoaded = E.buildLoadedFromEMCCD(emSpec, input.emccd.power2D, input.emccd.wls, 480.0, 680.0);

const t0 = Date.now();
for (const rc of ref) {
  if (rc.error) { console.log(`(skipping ref error case ${rc.file} [${rc.branch}]: ${rc.error})`); continue; }
  const loaded = rc.data_type === "APD" ? apdLoaded : emLoaded;
  runCase(rc, loaded);
}
console.log(`\nElapsed ${(Date.now() - t0) / 1000}s — ${checks} checks, ${failures} failures`);
process.exit(failures ? 1 : 0);

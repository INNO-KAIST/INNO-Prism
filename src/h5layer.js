/* =============================================================================
 * INNO Prism — HDF5 access & measurement-type detection layer
 * Works on an opened h5wasm File in browser or node.
 * ========================================================================== */
"use strict";
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PrismH5 = api;
})(typeof self !== "undefined" ? self : this, function () {

const KEYS = {
  APD_COUNT: "measurement/power_scan/apd_counter_apd_count_rates_raw",
  APD_POWER: "measurement/power_scan/apd_counter_powers_raw",
  EMCCD_SPECTRA: "measurement/power_scan/emccd_spectra_raw",
  EMCCD_POWER: "measurement/power_scan/emccd_powers_raw",
  EMCCD_WLS: "measurement/power_scan/emccd_wls",
  EMCCD_READOUT: "measurement/emccd_readout",
};

function safeGet(file, path) {
  try { return file.get(path); } catch (e) { return null; }
}
function isGroup(obj) { return obj && typeof obj.keys === "function" && !("shape" in obj); }
function isDataset(obj) { return obj && "shape" in obj; }

/** Flat typed-array + shape read. Returns {shape, data} or null. */
function readDataset(file, path) {
  const d = safeGet(file, path);
  if (!isDataset(d)) return null;
  try {
    let v = d.value;
    const shape = Array.from(d.shape || []);
    if (ArrayBuffer.isView(v)) return { shape, data: v };
    if (Array.isArray(v)) {
      // strings or nested — flatten
      const flat = [];
      (function fl(a) { for (const x of a) Array.isArray(x) ? fl(x) : flat.push(x); })(v);
      return { shape, data: flat };
    }
    return { shape, data: [v] };
  } catch (e) { return null; }
}
/** n×m nested rows from a flat read (2D or (n,1,1)-style). */
function rows2D(read) {
  const { shape, data } = read;
  if (shape.length === 1) return Array.from(data, (v) => [Number(v)]);
  const nInner = shape.slice(1).reduce((a, b) => a * b, 1);
  const out = [];
  for (let i = 0; i < shape[0]; i++) {
    const row = new Array(nInner);
    for (let j = 0; j < nInner; j++) row[j] = Number(data[i * nInner + j]);
    out.push(row);
  }
  return out;
}
function attrsOf(obj) {
  const out = {};
  try {
    const a = obj.attrs || {};
    for (const k of Object.keys(a)) {
      try {
        let v = a[k] && "value" in a[k] ? a[k].value : a[k];
        if (ArrayBuffer.isView(v)) v = Array.from(v);
        out[k] = v;
      } catch (e) { /* skip */ }
    }
  } catch (e) { /* no attrs */ }
  return out;
}

/** Depth-limited tree walk → [{path, kind, shape, dtype, nAttrs}] */
function walkTree(file, maxNodes) {
  const out = [];
  const limit = maxNodes || 4000;
  function walk(group, prefix, depth) {
    if (out.length >= limit || depth > 8) return;
    let keys = [];
    try { keys = group.keys(); } catch (e) { return; }
    for (const k of keys) {
      if (out.length >= limit) return;
      let child = null;
      try { child = group.get(k); } catch (e) { continue; }
      const p = prefix ? `${prefix}/${k}` : k;
      if (isGroup(child)) {
        out.push({ path: p, kind: "group", nAttrs: Object.keys(attrsOf(child)).length });
        walk(child, p, depth + 1);
      } else if (isDataset(child)) {
        let dtype = "";
        try { dtype = String(child.dtype || ""); } catch (e) {}
        out.push({ path: p, kind: "dataset", shape: Array.from(child.shape || []), dtype, nAttrs: Object.keys(attrsOf(child)).length });
      }
    }
  }
  walk(file, "", 0);
  return out;
}

/** Find PLE-style group anywhere: needs excitation_wls, emission_wls, spectra_raw. */
function findPleGroup(file, tree) {
  const req = ["excitation_wls", "emission_wls", "spectra_raw"];
  const groups = {};
  for (const n of tree) {
    if (n.kind !== "dataset") continue;
    const idx = n.path.lastIndexOf("/");
    if (idx < 0) continue;
    const g = n.path.slice(0, idx), leaf = n.path.slice(idx + 1);
    (groups[g] = groups[g] || new Set()).add(leaf);
  }
  for (const g of Object.keys(groups)) {
    if (req.every((r) => groups[g].has(r))) return g;
  }
  return null;
}

/** Power-scan 그룹을 **구조로** 탐지 (데이터셋 이름 하드코딩 제거).
 *
 *  ScopeFoundry 규약: 한 measurement 그룹 안에
 *    <collector>_powers        (n,)        · <collector>_powers_raw      (n, reps)
 *    <collector>_<signal>      (n,)        · <collector>_<signal>_raw    (n, reps[, pix])
 *    wheel_positions           (n,)
 *  collector 이름(apd_counter / emccd / …)은 장비마다 다르므로 접두사를 고정하지
 *  않고, "power를 담은 배열"과 "선두 차원이 같은 신호 배열" 쌍으로 찾는다.
 *  이 덕분에 새 측정 플랫폼이 다른 검출기 이름(snspd_… 등)이나 _raw 없는 형식을
 *  써도 인식된다. polled_powers(레이스별 폴링값)와 시간/파장/휠 축은 제외.
 *  반환: {group, kind:"apd"|"emccd", powerRaw, power1, sigRaw, sig1, wl, n, reps}
 */
function findPowerScanGroup(file, tree) {
  const groups = {};
  for (const n of tree) {
    if (n.kind !== "dataset" || !/^measurement\//.test(n.path)) continue;
    const i = n.path.lastIndexOf("/");
    (groups[n.path.slice(0, i)] = groups[n.path.slice(0, i)] || [])
      .push({ leaf: n.path.slice(i + 1), shape: n.shape || [], path: n.path });
  }
  // 축·통계 배열: 신호/파워 후보에서 제외
  const isAxis = (d) => /wheel|positions?$|(^|_)times?$|acq_time|index|wavelength|wls?$|_array$|extent|corner/i.test(d.leaf);
  const isStat = (d) => /_(std|sem|err|error)$/i.test(d.leaf);
  const isPowerName = (d) => /power|irradiance|fluence/i.test(d.leaf) && !/polled/i.test(d.leaf);
  // 같은 물리량의 (평균, 반복, 통계) 세트를 한 묶음으로: powers / powers_reps / powers_std
  const baseOf = (leaf) => leaf.replace(/_(raw|reps)$/i, "");
  const bundle = (arr) => {
    const m = new Map();
    for (const d of arr) {
      const b = baseOf(d.leaf);
      const e = m.get(b) || { base: b, d1: null, d2: null, dN: null };
      if (d.shape.length === 1) e.d1 = e.d1 || d;
      else if (d.shape.length === 2) e.d2 = e.d2 || d;
      else e.dN = e.dN || d;
      m.set(b, e);
    }
    return Array.from(m.values());
  };
  let best = null;
  for (const g of Object.keys(groups)) {
    const ds = groups[g];
    // 2D 래스터 스캔 그룹은 제외 (위치 스트림 보유)
    if (ds.some((d) => /scan_h_positions/i.test(d.leaf)) && ds.some((d) => /scan_v_positions/i.test(d.leaf))) continue;
    const usable = ds.filter((d) => !isStat(d) && !isAxis(d) && d.shape.length >= 1);
    const powers = usable.filter(isPowerName);
    if (!powers.length) continue;
    const pB = bundle(powers).sort((a, b) =>
      ((b.d2 ? 2 : 0) + (b.d1 ? 1 : 0)) - ((a.d2 ? 2 : 0) + (a.d1 ? 1 : 0)))[0];
    const pAny = pB.d2 || pB.d1 || pB.dN;
    if (!pAny || !(pAny.shape[0] >= 4)) continue;
    const n = pAny.shape[0];
    // 신호 후보: 파워가 아니고 선두 차원(측정점 수)이 일치하는 모든 배열.
    // **이름 어휘에 의존하지 않는다** — 새 플랫폼이 detector·signal·sensor 등
    // 무엇으로 부르든 인식된다. 어휘 일치는 가점으로만 사용.
    const sigs = usable.filter((d) => !isPowerName(d) && d.shape[0] === n);
    if (!sigs.length) continue;
    const wl = ds.find((d) => d.shape.length === 1 && /wavelength|wls?$/i.test(d.leaf));
    // 마지막 축이 파장 길이와 같으면 스펙트럼 → EMCCD 계열
    const spec = wl ? sigs.filter((d) => d.shape.length >= 2 && d.shape[d.shape.length - 1] === wl.shape[0]) : [];
    let kind, sigRaw, sig1, sigScore;
    if (spec.length) {
      kind = "emccd";
      sigRaw = spec.sort((a, b) =>
        ((b.shape.length === 3 ? 4 : 0) + (/spect/i.test(b.leaf) ? 2 : 0)) -
        ((a.shape.length === 3 ? 4 : 0) + (/spect/i.test(a.leaf) ? 2 : 0)))[0];
      sig1 = null; sigScore = 6;
    } else {
      kind = "apd";
      const vocab = (b) => /count|rate|intensity|signal|photon|detect|sensor|adu|volt/i.test(b.base) ? 4 : 0;
      const sB = bundle(sigs).sort((a, b) =>
        (vocab(b) + (b.d2 ? 2 : 0) + (b.d1 ? 1 : 0)) - (vocab(a) + (a.d2 ? 2 : 0) + (a.d1 ? 1 : 0)))[0];
      if (!sB) continue;
      sigRaw = sB.d2; sig1 = sB.d1 || sB.dN;
      if (!sigRaw && !sig1) continue;
      sigScore = vocab(sB) + (sigRaw ? 2 : 0);
    }
    const score = (/power[_-]?scan/i.test(g) ? 10 : 0) + (pB.d2 ? 2 : 0) + sigScore +
      (ds.some((d) => /wheel_positions/i.test(d.leaf)) ? 2 : 0) + Math.min(n / 100, 2);
    if (!best || score > best.score) {
      best = { score, group: g, kind, powerRaw: pB.d2, power1: pB.d1, sigRaw, sig1, wl,
        n, reps: (sigRaw && sigRaw.shape[1]) || (pB.d2 && pB.d2.shape[1]) || 1 };
    }
  }
  return best;
}

/** Detect the measurement type of an open file. Returns {type, label, detail}. */
function detectType(file) {
  const tree = walkTree(file);
  const has = (p) => tree.some((n) => n.path === p);
  if (has(KEYS.APD_COUNT) && has(KEYS.APD_POWER)) {
    return { type: "power_apd", label: "Power scan · APD", tree };
  }
  if (has(KEYS.EMCCD_SPECTRA) && has(KEYS.EMCCD_POWER) && has(KEYS.EMCCD_WLS)) {
    return { type: "power_emccd", label: "Power scan · EMCCD", tree };
  }
  const pleGroup = findPleGroup(file, tree);
  if (pleGroup) return { type: "ple", label: "PLE scan", pleGroup, tree };
  // rise time (pulse response) — confirmed ScopeFoundry schema
  if (has("measurement/ni_daq_pulse_resp/times") && has("measurement/ni_daq_pulse_resp/counts")) {
    return { type: "rise_time", label: "Rise time (pulse response)", riseGroup: "measurement/ni_daq_pulse_resp", tree };
  }
  // photodarkening — per-power time traces under trace_counts/
  if (tree.some((n) => n.kind === "group" && n.path === "measurement/darkening_measurement/trace_counts")) {
    return { type: "darkening", label: "Photodarkening", darkGroup: "measurement/darkening_measurement", tree };
  }
  // EMCCD readout — 경로를 고정하지 않는다(측정 이름이 셋업마다 다르다: emccd_readout ·
  // andor_ccd_readout · …). 그리고 **shape 로 분기한다**: 1D 면 스펙트럼이지만 2D 면
  // 이미지이므로 여기서 잡지 않고 아래 imaging 판정으로 내려보낸다.
  const specNode = tree.find((n) => n.kind === "dataset" &&
    /^measurement\/[^/]+\/spectrum$/.test(n.path) &&
    (n.shape || []).filter((s) => s > 1).length === 1);
  if (specNode) {
    return { type: "emccd_readout", label: "EMCCD spectrum", tree,
      readoutGroup: specNode.path.slice(0, specNode.path.lastIndexOf("/")) };
  }
  // TCSPC / decay histogram: group with time_array + time_histogram
  const histGroups = {};
  for (const n of tree) {
    if (n.kind !== "dataset") continue;
    const idx = n.path.lastIndexOf("/");
    if (idx < 0) continue;
    const g = n.path.slice(0, idx), leaf = n.path.slice(idx + 1);
    (histGroups[g] = histGroups[g] || new Set()).add(leaf);
  }
  for (const g of Object.keys(histGroups)) {
    if (histGroups[g].has("time_array") && histGroups[g].has("time_histogram")) {
      return { type: "histogram", label: "TCSPC histogram", histGroup: g, tree };
    }
  }
  // 2D scan heuristic: measurement/* group whose name suggests a scan and holds a 2D+ map
  // 전용 스키마(PLE·rise·darkening·histogram)를 모두 통과한 뒤에야 구조 기반
  // power scan 판정. darkening 그룹도 powers/count_rates 배열을 갖고 있어
  // 구조만으로는 구분되지 않으므로 순서가 중요하다.
  const ps = findPowerScanGroup(file, tree);
  if (ps) {
    return ps.kind === "emccd"
      ? { type: "power_emccd", label: "Power scan · EMCCD", tree, ps }
      : { type: "power_apd", label: "Power scan · APD", tree, ps };
  }
  // 주의: "power_scan"도 "scan"을 포함하므로 이름만으로 2D 스캔이라 판단하면
  // power scan이 오분류된다. power scan 후보 그룹은 명시적으로 배제한다.
  const psGroup = (ps || {}).group;
  const scanGroups = tree.filter((n) => n.kind === "group" && n.path !== psGroup &&
    !/power/i.test(n.path.split("/").pop()) &&
    /measurement\/[^/]*(2d|scan|map|raster)[^/]*$/i.test(n.path));
  for (const g of scanGroups) {
    const maps = tree.filter((n) => n.kind === "dataset" && n.path.startsWith(g.path + "/") &&
      n.shape && n.shape.filter((s) => s >= 4).length >= 2);
    // waveform scans store only 1D streams — positions are enough to qualify
    const hasWave = tree.some((n) => n.path === `${g.path}/scan_h_positions`) &&
                    tree.some((n) => n.path === `${g.path}/scan_v_positions`);
    if (maps.length || hasWave) return { type: "scan2d", label: "2D scan map", scanGroup: g.path, tree };
  }
  // rise-time structural fallback: measurement/* group with a time axis, a
  // counts signal, and a gate voltage that actually toggles (pulse response)
  for (const g of Object.keys(histGroups)) {
    const keys = histGroups[g];
    if (!/^measurement\//.test(g)) continue;
    const lower = Array.from(keys, (k) => k.toLowerCase());
    if (lower.some((k) => k.startsWith("apd_counter_") || k.startsWith("emccd_"))) continue;
    const timeKey = Array.from(keys).find((k) => /time/i.test(k) && !/histogram/i.test(k));
    const hasSig = keys.has("counts") || keys.has("counts_2");
    if (!timeKey || !hasSig) continue;
    for (const k of keys) {
      if (!/volt/i.test(k)) continue;
      const v = readDataset(file, `${g}/${k}`);
      if (!v || !v.data.length) continue;
      let lo = Infinity, hi = -Infinity;
      for (const x of v.data) { const y = Number(x); if (isFinite(y)) { if (y < lo) lo = y; if (y > hi) hi = y; } }
      if (hi - lo > 0) {
        return { type: "rise_time", label: "Rise time (pulse response)", riseGroup: g, tree };
      }
    }
  }
  // 카메라 이미지 — **맨 마지막에** 둔다. 2D 스캔 맵도 (Ny, Nx) 이므로 구조만으로는
  // 구분되지 않는다. 전용 스키마를 전부 통과한 뒤에야 잡아야 기존 판정이 안 흔들린다.
  const img = findImagingGroup(file, tree);
  if (img) {
    return {
      type: "imaging", imaging: img, tree,
      label: img.kind === "stack" ? `이미지 스택 · ${img.n} 프레임` : "카메라 이미지",
    };
  }
  return { type: "generic", label: "H5 data", tree };
}

/* --------------------------- typed extractors ----------------------------- */
/**
 * Photodarkening extraction. Confirmed schema (measurement/darkening_measurement):
 *   trace_counts/NNN_XX.XuW  (1, N)  APD count rate vs time at fixed power
 *   trace_times/NNN_...      (1, N)  time axis [s]
 *   trace_powers/NNN_...     (1, N)  polled power [W]
 *   apd_counter_powers (nTraces)     setpoint powers [W] · wheel_positions
 *   apd_counter_acq_times            integration time per sample [s]
 * Returns {traces:[{label, P, t, c, pTrace}], acqTime, wheelPositions}.
 */
function extractDarkening(file, darkGroup) {
  const g = darkGroup || "measurement/darkening_measurement";
  const cg = safeGet(file, `${g}/trace_counts`);
  if (!cg || !isGroup(cg)) throw new Error("trace_counts 그룹이 없습니다");
  const keys = cg.keys().slice().sort();
  const powersR = readDataset(file, `${g}/apd_counter_powers`);
  const powers = powersR ? Array.from(powersR.data, Number) : null;
  const acqR = readDataset(file, `${g}/apd_counter_acq_times`);
  const acqTime = acqR && acqR.data.length ? Number(acqR.data[0]) : NaN;
  const wpR = readDataset(file, `${g}/wheel_positions`);
  const traces = [];
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const c = readDataset(file, `${g}/trace_counts/${k}`);
    const t = readDataset(file, `${g}/trace_times/${k}`);
    if (!c || !t) continue;
    const cArr = Array.from(c.data, Number), tArr = Array.from(t.data, Number);
    const n = Math.min(cArr.length, tArr.length);
    // 카운터 글리치 제거: 음수(32-bit 롤오버) 및 이웃 대비 5배 이상 고립 스파이크 → NaN
    for (let j = 0; j < n; j++) {
      const v = cArr[j];
      if (!isFinite(v) || v < 0) { cArr[j] = NaN; continue; }
      const L = j > 0 ? cArr[j - 1] : v, R = j < n - 1 ? cArr[j + 1] : v;
      const nb = Math.max(Math.abs(L) || 1, Math.abs(R) || 1);
      if (v > 5 * nb && v - Math.max(L, R) > 10 * Math.sqrt(nb)) cArr[j] = NaN;
    }
    // power: setpoint array by index, else parse from label "000_30.7uW"
    let P = powers && isFinite(powers[i]) ? powers[i] : NaN;
    if (!isFinite(P)) {
      const m = k.match(/([\d.]+)\s*u[wW]/);
      if (m) P = Number(m[1]) * 1e-6;
    }
    const pr = readDataset(file, `${g}/trace_powers/${k}`);
    traces.push({
      label: k, P,
      t: tArr.slice(0, n), c: cArr.slice(0, n),
      pMed: pr ? (() => { const a = Array.from(pr.data, Number).filter(isFinite).sort((x, y) => x - y); return a.length ? a[a.length >> 1] : NaN; })() : NaN,
    });
  }
  if (!traces.length) throw new Error("darkening 트레이스를 읽지 못했습니다");
  traces.sort((a, b) => a.P - b.P);
  return { traces, acqTime, wheelPositions: wpR ? Array.from(wpR.data, Number) : null, group: g };
}

/**
 * Rise-time (pulse response) extraction. Confirmed schema
 * (measurement/ni_daq_pulse_resp): 1D equal-length datasets
 *   times [s] · counts (Poisson, primary APD) · counts_2 (2nd APD, may be 0)
 *   set_voltages [V] (excitation gate command, toggles 0 ↔ ~4 V) · ai_voltages
 * Handles: DAQ turn-on single-sample spikes (counts[0] ~ 1e8) → NaN;
 * gate on/off edge indices parsed from set_voltages.
 */
function extractRiseTime(file, riseGroup) {
  const g = riseGroup || "measurement/ni_daq_pulse_resp";
  const rd = (k) => { const r = readDataset(file, `${g}/${k}`); return r ? Array.from(r.data, Number) : null; };
  let t = rd("times"), c = rd("counts");
  if (!t || !c) {
    // structural-fallback group: locate keys by pattern
    const obj = safeGet(file, g);
    if (!obj || !isGroup(obj)) throw new Error("rise-time group not found");
    const keys = obj.keys();
    const tk = keys.find((k) => /time/i.test(k) && !/histogram/i.test(k));
    const ck = keys.find((k) => k === "counts") || keys.find((k) => /count/i.test(k));
    if (!tk || !ck) throw new Error("rise-time group missing times/counts");
    t = rd(tk); c = rd(ck);
  }
  const n = Math.min(t.length, c.length);
  t = t.slice(0, n); c = c.slice(0, n);
  let c2 = rd("counts_2");
  if (c2 && !(c2.some((v) => isFinite(v) && v > 0))) c2 = null; // unused channel
  const setV = rd("set_voltages");
  // --- DAQ turn-on spike rejection (isolated huge samples) ---
  const finiteC = c.filter((v) => isFinite(v));
  const spikes = [];
  if (finiteC.length >= 8) {
    const sorted = [...finiteC].sort((a, b) => a - b);
    const med = sorted[sorted.length >> 1];
    const madv = (() => { const d = finiteC.map((v) => Math.abs(v - med)).sort((a, b) => a - b); return d[d.length >> 1] || 1; })();
    const bulkMax = sorted[Math.min(sorted.length - 1, Math.floor(0.999 * (sorted.length - 1)))];
    const thresh = Math.max(med + 30 * 1.4826 * madv, 5 * bulkMax);
    for (let i = 0; i < n; i++) {
      if (!(c[i] > thresh)) continue;
      const left = i > 0 ? c[i - 1] : 0, right = i < n - 1 ? c[i + 1] : 0;
      const neigh = Math.max(Math.abs(left), Math.abs(right), bulkMax);
      if (c[i] > 5 * neigh) spikes.push(i);
    }
    for (const i of spikes) c[i] = NaN;
  }
  // --- gate edges from set_voltages ---
  let gateOnIdx = null, gateOffIdx = null;
  if (setV && setV.length >= 4) {
    let lo = Infinity, hi = -Infinity;
    for (const v of setV) if (isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
    if (hi - lo > 0) {
      const thr = 0.5 * (lo + hi);
      for (let i = 1; i < Math.min(setV.length, n); i++) {
        if (gateOnIdx === null && setV[i - 1] <= thr && setV[i] > thr) gateOnIdx = i;
        else if (gateOnIdx !== null && gateOffIdx === null && setV[i - 1] > thr && setV[i] <= thr) { gateOffIdx = i; break; }
      }
    }
  }
  let dtMedian = NaN;
  if (n > 1) {
    const d = [];
    for (let i = 1; i < n; i++) d.push(t[i] - t[i - 1]);
    d.sort((a, b) => a - b);
    dtMedian = d[d.length >> 1];
  }
  return { t, c, c2, setV, spikes, gateOnIdx, gateOffIdx, dtMedian, group: g };
}

/** Acquisition-order PA trace: 1D powers/intensities + wheel_positions (setpoint key). */
/** dwell/적분시간을 측정 settings 속성에서 찾는다 (플랫폼마다 이름이 다르다) */
function readDwellAttr(file, base) {
  for (const g of [`${base}/settings`, base]) {
    let node = null;
    try { node = file.get(g); } catch (e) { node = null; }
    if (!node || !node.attrs) continue;
    for (const k of Object.keys(node.attrs)) {
      if (!/dwell|int_?time|integration|acq/i.test(k)) continue;
      const v = Number(node.attrs[k].value !== undefined ? node.attrs[k].value : node.attrs[k]);
      if (isFinite(v) && v > 0) return v;
    }
  }
  return NaN;
}
function extractPATrace(file, type, bandMin, bandMax, det) {
  const ps = det && det.ps;
  const base = ps ? ps.group : "measurement/power_scan";
  const wp = readDataset(file, `${base}/wheel_positions`);
  if (!wp) return null;
  const W = Array.from(wp.data, Number);
  if (type === "power_apd") {
    const P = readDataset(file, ps ? ((ps.power1 || ps.powerRaw).path) : `${base}/apd_counter_powers`);
    const I = readDataset(file, ps ? ((ps.sig1 || ps.sigRaw).path) : `${base}/apd_counter_apd_count_rates`);
    if (!P || !I) return null;
    // (n, reps) 형식이면 반복 평균으로 1D 트레이스 구성.
    // v2.6: 원시 반복(Iraw)과 dwell time(acqTime)을 함께 반환한다 — 노이즈 법칙은
    // 집계 전 원시 반복에서만 측정 가능하고, 계수 통계의 Poisson 바닥은 1/acqTime 이다.
    const flat1D = (r) => r.shape.length === 1 ? Array.from(r.data, Number)
      : rows2D(r).map((row) => row.reduce((a, b) => a + b, 0) / row.length);
    // 원시 반복은 2D 배열(sigRaw)에서 읽어야 한다. I 는 sig1(1D 평균)이 우선이므로
    // I.shape 로 판정하면 어떤 플랫폼에서도 항상 null 이 된다.
    const rawDs = ps && ps.sigRaw && ps.sigRaw.shape && ps.sigRaw.shape.length === 2
      ? readDataset(file, ps.sigRaw.path) : (I.shape.length === 2 ? I : null);
    let Iraw = null;
    if (rawDs && rawDs.shape.length === 2) {
      const rows = rows2D(rawDs).map((row) => Array.from(row, Number));
      // (n, reps) 와 (reps, n) 두 배치 모두 허용 — 측정점 수에 맞춰 방향을 고른다
      if (rows.length === P.shape[0]) Iraw = rows;
      else if (rows[0] && rows[0].length === P.shape[0]) Iraw = rows[0].map((_, j) => rows.map((r) => r[j]));
    }
    // dwell time: 전용 데이터셋 → 측정 settings 속성 순으로 찾는다.
    // 신 플랫폼(INNO Optics)은 acq_times 데이터셋 없이 settings/@detector_dwell 에 둔다.
    let acqTime = NaN;
    const acqR = readDataset(file, `${base}/apd_counter_acq_times`);
    if (acqR && acqR.data.length) acqTime = Number(acqR.data[0]);
    if (!(isFinite(acqTime) && acqTime > 0)) acqTime = readDwellAttr(file, base);
    return { P: flat1D(P), I: flat1D(I), W, Iraw, acqTime, counting: true };
  }
  // EMCCD: per-row band integral of the raw spectra (consistent with the viewer band)
  const P = readDataset(file, ps ? ((ps.power1 || ps.powerRaw).path) : `${base}/emccd_powers`);
  const sp = readDataset(file, ps ? ps.sigRaw.path : `${base}/emccd_spectra_raw`);
  const wl = readDataset(file, ps ? ps.wl.path : `${base}/emccd_wls`);
  if (!P || !sp || !wl || sp.shape.length !== 3) return null;
  const wls = Array.from(wl.data, Number);
  let i0 = 0, i1 = wls.length;
  if (isFinite(bandMin) && isFinite(bandMax)) {
    let b0 = 0, b1 = 0, d0 = Infinity, d1 = Infinity;
    for (let i = 0; i < wls.length; i++) {
      if (Math.abs(wls[i] - bandMin) < d0) { d0 = Math.abs(wls[i] - bandMin); b0 = i; }
      if (Math.abs(wls[i] - bandMax) < d1) { d1 = Math.abs(wls[i] - bandMax); b1 = i; }
    }
    i0 = Math.min(b0, b1); i1 = Math.max(b0, b1) + 1;
  }
  const [n, reps, pix] = sp.shape;
  const I = new Array(n);
  // v2.6: rep별 band 적분을 보존 (Iraw) — 평균으로 뭉개면 노이즈 법칙을 측정할 수 없다.
  const Iraw = reps > 1 ? new Array(n) : null;
  for (let i = 0; i < n; i++) {
    let s2 = 0;
    const row = Iraw ? new Array(reps) : null;
    for (let r = 0; r < reps; r++) {
      let sr = 0;
      for (let p2 = i0; p2 < i1; p2++) sr += Number(sp.data[(i * reps + r) * pix + p2]);
      if (row) row[r] = sr;
      s2 += sr;
    }
    if (Iraw) Iraw[i] = row;
    I[i] = s2 / reps;
  }
  return { P: Array.from(P.data, Number), I, W, Iraw, acqTime: NaN, counting: false };
}
function extractPowerScanAPD(file, det) {
  const ps = det && det.ps;
  // 구조 탐지 결과가 있으면 그 경로를, 없으면 레거시 고정 경로를 사용
  const count = readDataset(file, ps ? ((ps.sigRaw || ps.sig1).path) : KEYS.APD_COUNT);
  const power = readDataset(file, ps ? ((ps.powerRaw || ps.power1).path) : KEYS.APD_POWER);
  if (!count || !power) throw new Error("APD power-scan datasets missing");
  return { kind: "APD", count2D: rows2D(count), power2D: rows2D(power) };
}
function extractPowerScanEMCCD(file, det) {
  const ps = det && det.ps;
  const spectra = readDataset(file, ps ? ps.sigRaw.path : KEYS.EMCCD_SPECTRA);
  const power = readDataset(file, ps ? ((ps.powerRaw || ps.power1).path) : KEYS.EMCCD_POWER);
  const wls = readDataset(file, ps ? ps.wl.path : KEYS.EMCCD_WLS);
  if (!spectra || !power || !wls) throw new Error("EMCCD power-scan datasets missing");
  let sh = spectra.shape;
  // (n, pix) 형식(반복 없음)도 (n, 1, pix)로 승격해 동일 경로로 처리
  if (sh.length === 2 && sh[1] === wls.shape[0]) sh = [sh[0], 1, sh[1]];
  if (sh.length !== 3) throw new Error(`unexpected EMCCD spectra shape [${spectra.shape}]`);
  const data = spectra.data instanceof Float64Array ? spectra.data : Float64Array.from(spectra.data, Number);
  return {
    kind: "EMCCD",
    spectra: { n: sh[0], reps: sh[1], pix: sh[2], data },
    power2D: rows2D(power),
    wls: Array.from(wls.data, Number),
  };
}
function extractEmccdReadout(file, group) {
  const base = group || KEYS.EMCCD_READOUT;
  const spectrum = readDataset(file, `${base}/spectrum`);
  // 파장축 이름은 셋업마다 다르다: wavelengths(구) · wls(신) · wavelength
  const wl = readDataset(file, `${base}/wavelengths`) || readDataset(file, `${base}/wls`) ||
             readDataset(file, `${base}/wavelength`);
  const pixels = readDataset(file, `${base}/pixels`);
  const image = readDataset(file, `${base}/image`);
  const settings = safeGet(file, `${base}/settings`);
  return {
    spectrum: spectrum ? Array.from(spectrum.data, Number) : null,
    wavelengths: wl ? Array.from(wl.data, Number) : null,
    pixels: pixels ? Array.from(pixels.data, Number) : null,
    image: image ? { shape: image.shape, data: image.data } : null,
    settings: settings ? attrsOf(settings) : {},
  };
}
function extractPLE(file, pleGroup) {
  const ex = readDataset(file, `${pleGroup}/excitation_wls`);
  const em = readDataset(file, `${pleGroup}/emission_wls`);
  const z = readDataset(file, `${pleGroup}/spectra_raw`);
  if (!ex || !em || !z) throw new Error("PLE datasets missing");
  const exArr = Array.from(ex.data, Number), emArr = Array.from(em.data, Number);
  let zsh = z.shape, zdata = z.data;
  let nx = exArr.length, ny = emArr.length;
  // want z as [nx][ny]
  let zRows = null;
  if (zsh.length === 2 && zsh[0] === nx && zsh[1] === ny) {
    zRows = [];
    for (let i = 0; i < nx; i++) {
      const row = new Array(ny);
      for (let j = 0; j < ny; j++) row[j] = Number(zdata[i * ny + j]);
      zRows.push(row);
    }
  } else if (zsh.length === 2 && zsh[0] === ny && zsh[1] === nx) {
    zRows = [];
    for (let i = 0; i < nx; i++) {
      const row = new Array(ny);
      for (let j = 0; j < ny; j++) row[j] = Number(zdata[j * nx + i]);
      zRows.push(row);
    }
  } else throw new Error(`PLE spectra shape [${zsh}] does not match axes (${nx}, ${ny})`);
  return { excitation: exArr, emission: emArr, z: zRows, group: pleGroup };
}
function extractHistogram(file, histGroup) {
  const t = readDataset(file, `${histGroup}/time_array`);
  const h = readDataset(file, `${histGroup}/time_histogram`);
  if (!t || !h) throw new Error("histogram datasets missing");
  const time = Array.from(t.data, Number);
  const channels = [];
  if (h.shape.length === 1) {
    channels.push(Array.from(h.data, Number));
  } else {
    const nCh = h.shape[0], nT = h.shape[1];
    for (let c = 0; c < nCh; c++) {
      const row = new Array(nT);
      for (let i = 0; i < nT; i++) row[i] = Number(h.data[c * nT + i]);
      channels.push(row);
    }
  }
  let elapsed = null;
  const e = readDataset(file, `${histGroup}/elapsed_meas_time`);
  if (e && e.data.length) elapsed = Number(e.data[0]);
  return { time, channels, elapsed, group: histGroup };
}
/** Axes for a scan-2d map: try h_array/v_array or imshow_extent in the same group. */
function scanAxes(file, scanGroup, ny, nx) {
  const h = readDataset(file, `${scanGroup}/h_array`);
  const v = readDataset(file, `${scanGroup}/v_array`);
  if (h && v && h.data.length === nx && v.data.length === ny) {
    return { x: Array.from(h.data, Number), y: Array.from(v.data, Number), xLabel: "h (µm)", yLabel: "v (µm)" };
  }
  const ext = readDataset(file, `${scanGroup}/imshow_extent`);
  if (ext && ext.data.length === 4) {
    const [x0, x1, y0, y1] = Array.from(ext.data, Number);
    const xs = Array.from({ length: nx }, (_, i) => x0 + (x1 - x0) * i / Math.max(nx - 1, 1));
    const ys = Array.from({ length: ny }, (_, i) => y0 + (y1 - y0) * i / Math.max(ny - 1, 1));
    return { x: xs, y: ys, xLabel: "x", yLabel: "y" };
  }
  return null;
}
function extract2DMaps(file, tree, scanGroup) {
  // return candidate 2D maps under the scan group (squeeze singleton dims);
  // 3D stacks (channels/frames × Nv × Nh, leading dim ≤ 8) become per-slice entries
  const maps = [];
  for (const n of tree) {
    if (n.kind !== "dataset" || !n.path.startsWith(scanGroup + "/")) continue;
    if (n.shape.reduce((a, b) => a * b, 1) > 4_000_000) continue;
    const eff = n.shape.filter((s) => s > 1);
    if (eff.length === 2) { maps.push({ path: n.path, shape: n.shape }); continue; }
    if (eff.length === 3 && eff[0] <= 8 && eff[1] >= 4 && eff[2] >= 4) {
      for (let i = 0; i < eff[0]; i++) maps.push({ path: n.path, shape: n.shape, slice: i });
    }
  }
  maps.sort((a, b) => scoreMapName(b.path) - scoreMapName(a.path));
  return maps;
}

/**
 * Reconstruct 2D map(s) from a WAVEFORM scan: the stage streams
 * scan_h_positions / scan_v_positions (1D, one entry per sample — h is a
 * bidirectional triangle wave for serpentine rasters) alongside 1D signal
 * streams of the same length. Samples are binned onto the (v, h) grid
 * (h_array/v_array if present, else inferred from unique position steps)
 * and averaged; unvisited bins are null.
 * Returns {x, y, xLabel, yLabel, signals:[{name, z, nUsed, nOut}]} or null.
 */
function extractWaveScan(file, tree, scanGroup) {
  const rd = (k) => { const r = readDataset(file, `${scanGroup}/${k}`); return r ? Array.from(r.data, Number) : null; };
  const hp = rd("scan_h_positions"), vp = rd("scan_v_positions");
  if (!hp || !vp) return null;
  const N = Math.min(hp.length, vp.length);
  if (N < 16) return null;
  // grid axes: prefer stored h_array/v_array; else infer from unique steps
  const axisFrom = (stored, pos) => {
    if (stored && stored.length >= 2) return stored;
    const uniq = Array.from(new Set(pos.slice(0, N).map((v) => Math.round(v * 1e6) / 1e6))).sort((a, b) => a - b);
    if (uniq.length < 2) return uniq;
    const diffs = [];
    for (let i = 1; i < uniq.length; i++) diffs.push(uniq[i] - uniq[i - 1]);
    diffs.sort((a, b) => a - b);
    const step = diffs[diffs.length >> 1];
    if (!(step > 0)) return uniq;
    const lo = uniq[0], nBins = Math.round((uniq[uniq.length - 1] - lo) / step) + 1;
    if (nBins < 2 || nBins > 4096) return uniq;
    return Array.from({ length: nBins }, (_, i) => lo + i * step);
  };
  const xArr = axisFrom(rd("h_array"), hp);
  const yArr = axisFrom(rd("v_array"), vp);
  if (xArr.length < 2 || yArr.length < 2) return null;
  const xStep = (xArr[xArr.length - 1] - xArr[0]) / (xArr.length - 1);
  const yStep = (yArr[yArr.length - 1] - yArr[0]) / (yArr.length - 1);
  // signal candidates: 1D datasets of length N, not positions/axes/meta
  const EXCLUDE = /position|_array$|extent|corner|time|index/i;
  const signals = [];
  for (const n of tree) {
    if (n.kind !== "dataset" || !n.path.startsWith(scanGroup + "/")) continue;
    const leaf = n.path.slice(scanGroup.length + 1);
    if (EXCLUDE.test(leaf)) continue;
    const eff = n.shape.filter((s) => s > 1);
    if (eff.length !== 1 || Math.abs(eff[0] - N) > 2) continue;
    const sig = rd(leaf);
    if (!sig) continue;
    const Ny = yArr.length, Nx = xArr.length;
    const sum = new Float64Array(Ny * Nx), cnt = new Float64Array(Ny * Nx);
    let nUsed = 0, nOut = 0;
    for (let i = 0; i < N; i++) {
      const v = sig[i];
      if (!isFinite(v)) continue;
      const ix = Math.round((hp[i] - xArr[0]) / xStep);
      const iy = Math.round((vp[i] - yArr[0]) / yStep);
      // reject samples off-grid or far from bin centre (settle/flyback)
      if (ix < 0 || ix >= Nx || iy < 0 || iy >= Ny ||
          Math.abs(hp[i] - (xArr[0] + ix * xStep)) > 0.75 * Math.abs(xStep) ||
          Math.abs(vp[i] - (yArr[0] + iy * yStep)) > 0.75 * Math.abs(yStep)) { nOut++; continue; }
      sum[iy * Nx + ix] += v; cnt[iy * Nx + ix]++; nUsed++;
    }
    if (!nUsed) continue;
    const z = [];
    for (let y = 0; y < Ny; y++) {
      const row = new Array(Nx);
      for (let x = 0; x < Nx; x++) {
        const c = cnt[y * Nx + x];
        row[x] = c > 0 ? sum[y * Nx + x] / c : null;
      }
      z.push(row);
    }
    signals.push({ name: leaf, z, nUsed, nOut });
  }
  if (!signals.length) return null;
  // prefer count/rate/apd signals first
  signals.sort((a, b) => scoreMapName(b.name) - scoreMapName(a.name));
  return { x: xArr, y: yArr, xLabel: "h (µm)", yLabel: "v (µm)", signals };
}
function scoreMapName(p) {
  const s = p.toLowerCase();
  let sc = 0;
  if (/count|rate|intensity|image|map/.test(s)) sc += 5;
  if (/raw/.test(s)) sc -= 1;
  return sc;
}
/** Read any dataset squeezed to ≤2D for preview. */
function readForPreview(file, path, sliceIdx) {
  let r = readDataset(file, path);
  if (!r) return null;
  // 3D 스택에서 특정 슬라이스 선택 (첫 유효 축 기준)
  if (sliceIdx !== undefined && r.shape.filter((s) => s > 1).length >= 3) {
    let shape = r.shape.slice(), data = r.data;
    while (shape.length && shape[0] === 1) { shape = shape.slice(1); } // squeeze leading 1s
    const inner = shape.slice(1).reduce((a, b) => a * b, 1);
    const i0 = Math.max(0, Math.min(shape[0] - 1, sliceIdx));
    data = data.subarray ? data.subarray(i0 * inner, (i0 + 1) * inner) : data.slice(i0 * inner, (i0 + 1) * inner);
    r = { shape: shape.slice(1), data };
  }
  const eff = [], keepDims = [];
  r.shape.forEach((s, i) => { if (s > 1) { eff.push(s); keepDims.push(i); } });
  if (eff.length === 0) return { kind: "scalar", value: Number(r.data[0]) };
  if (eff.length === 1) {
    return { kind: "1d", y: Array.from(r.data, Number), n: eff[0] };
  }
  if (eff.length === 2) {
    const [ny, nx] = eff; // row-major: last dim fastest
    const zRows = [];
    for (let i = 0; i < ny; i++) {
      const row = new Array(nx);
      for (let j = 0; j < nx; j++) row[j] = Number(r.data[i * nx + j]);
      zRows.push(row);
    }
    return { kind: "2d", z: zRows, ny, nx };
  }
  // >2D: take middle slice of first axis repeatedly until 2D
  let shape = r.shape.slice(), data = r.data, offsetDims = shape.length;
  // simple approach: view as [shape[0], rest] and take slice 0 until 2 effective dims remain
  let cur = { shape, data };
  while (cur.shape.filter((s) => s > 1).length > 2) {
    const inner = cur.shape.slice(1).reduce((a, b) => a * b, 1);
    const mid = 0;
    cur = { shape: cur.shape.slice(1), data: cur.data.subarray ? cur.data.subarray(mid * inner, (mid + 1) * inner) : cur.data.slice(mid * inner, (mid + 1) * inner) };
  }
  const eff2 = cur.shape.filter((s) => s > 1);
  const [ny, nx] = eff2;
  const zRows = [];
  for (let i = 0; i < ny; i++) {
    const row = new Array(nx);
    for (let j = 0; j < nx; j++) row[j] = Number(cur.data[i * nx + j]);
    zRows.push(row);
  }
  return { kind: "2d", z: zRows, ny, nx, sliced: true };
}

/* --------------------------- imaging (widefield) --------------------------- */
/**
 * 카메라 이미지 측정 탐지 — **이름이 아니라 구조로** 판정한다.
 *
 * ScopeFoundry 측정 이름은 셋업마다 다르다 (andor_ccd_readout · time_trace_on_off ·
 * emccd_readout · …). 공통점은 한 measurement 그룹 안에
 *     (N, Ny, Nx) 3D 스택   또는   (Ny, Nx) 2D 프레임
 * 이 들어 있고 두 공간축이 모두 충분히 크다는 것뿐이므로, 그것만 본다.
 *
 * **`spectrum` 이라는 이름이 붙어도 shape 가 2D 면 이미지다.** andor_ccd_readout 은
 * readout_mode=Image 일 때 1024×1024 프레임을 `spectrum` 에 저장한다. 이름만 보고
 * 1D 스펙트럼 뷰어로 보내면 이미지 한 장이 1,048,576 점짜리 꺾은선이 된다.
 *
 * 반환: {group, path, kind:"stack"|"frame", n, ny, nx, timePath}
 */
function findImagingGroup(file, tree) {
  const MIN = 32;
  let best = null;
  for (const n of tree) {
    if (n.kind !== "dataset" || !/^measurement\//.test(n.path)) continue;
    const sh = (n.shape || []).filter((s) => s > 1);
    let kind = null, nF = 1, ny = 0, nx = 0;
    if (sh.length === 3 && sh[1] >= MIN && sh[2] >= MIN) { kind = "stack"; nF = sh[0]; ny = sh[1]; nx = sh[2]; }
    else if (sh.length === 2 && sh[0] >= MIN && sh[1] >= MIN) { kind = "frame"; ny = sh[0]; nx = sh[1]; }
    if (!kind) continue;
    const i = n.path.lastIndexOf("/");
    const group = n.path.slice(0, i), leaf = n.path.slice(i + 1);
    let timePath = null;
    if (kind === "stack") {
      // **잎 이름만** 본다. 전체 경로로 검사하면 그룹명(time_trace_on_off)이 걸려서
      // index_array 가 시간축으로 뽑히고 진짜 time_array 가 밀려난다.
      const cand = tree.filter((m) => m.kind === "dataset" && m.path.indexOf(group + "/") === 0 &&
        (m.shape || []).length === 1 && m.shape[0] === nF &&
        /(^|_)times?(_|$)|(^|_)t$/i.test(m.path.slice(group.length + 1)));
      if (cand.length) timePath = cand[0].path;
    }
    const score = (kind === "stack" ? 20 : 0) + (timePath ? 5 : 0) +
      (/image|frame|movie|stack|camera|ccd/i.test(leaf) ? 4 : 0) +
      (/spectrum/i.test(leaf) ? 2 : 0) + Math.min(Math.log10(ny * nx), 8);
    if (!best || score > best.score) best = { score, group, path: n.path, kind, n: nF, ny, nx, timePath };
  }
  return best;
}
function numOrNull(v) { const x = Number(v); return isFinite(x) ? x : null; }
/**
 * HDF5 불리언 속성 → JS 삼치(true/false/null).
 *
 * HDF5 에는 고유한 bool 형이 없어서 ScopeFoundry 는 enum/uint8 로 쓴다. h5wasm 은
 * 그것을 **숫자 1/0** (또는 길이 1 배열, 드물게 "True"/"b'True'" 문자열)로 돌려준다.
 * `v === true` 로 비교하면 **항상 거짓**이 되어, 연결된 장비를 미연결로 읽는다.
 * 값이 없거나 해석 불가면 null 을 돌려준다 — false 로 단정하지 않는다.
 */
function attrBool(v) {
  if (v === true || v === false) return v;
  if (v == null) return null;
  if (Array.isArray(v)) return v.length ? attrBool(v[0]) : null;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "bigint") return v !== 0n;
  if (typeof v === "string") {
    const t = v.replace(/^b?['"]|['"]$/g, "").trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(t)) return true;
    if (["false", "0", "no", "off"].includes(t)) return false;
  }
  return null;
}
/**
 * 프레임 **한 장만** 읽는다 (하이퍼슬랩).
 * (N, 1024, 1024) float32 는 프레임당 4 MB 다. 스택 전체를 올리면 프레임 수가
 * 조금만 늘어도 브라우저 탭이 죽는다. slice 를 지원하지 않는 빌드에서만 전수 읽기로
 * 후퇴한다.
 */
function readImageFrame(file, im, i) {
  const d = safeGet(file, im.path);
  if (!isDataset(d)) return null;
  const ny = im.ny, nx = im.nx, npx = ny * nx;
  let flat = null;
  if (im.kind === "stack") {
    const k = Math.max(0, Math.min(im.n - 1, i | 0));
    const sh = Array.from(d.shape || []);
    try {
      const ranges = []; let seen = 0;
      for (const s of sh) {
        if (s === 1) { ranges.push([0, 1]); continue; }
        ranges.push(seen === 0 ? [k, k + 1] : [0, s]);
        seen++;
      }
      flat = d.slice(ranges);
    } catch (e) { flat = null; }
    if (!flat || flat.length < npx) {
      const all = readDataset(file, im.path);
      if (!all) return null;
      const off = k * npx;
      flat = all.data.subarray ? all.data.subarray(off, off + npx) : all.data.slice(off, off + npx);
    }
  } else {
    const all = readDataset(file, im.path);
    if (!all) return null;
    flat = all.data;
  }
  const out = new Float32Array(npx);
  for (let j = 0; j < npx; j++) out[j] = Number(flat[j]);
  return out;
}
/** 이미징 측정의 축·설정·보조배열·카메라 정보. 프레임 화소는 포함하지 않는다. */
function extractImaging(file, det) {
  const im = det.imaging;
  const out = { group: im.group, path: im.path, kind: im.kind, n: im.n, ny: im.ny, nx: im.nx, time: null, aux: {} };
  if (im.timePath) {
    const t = readDataset(file, im.timePath);
    if (t) { out.time = Array.from(t.data, Number); out.timePath = im.timePath; }
  }
  const s = safeGet(file, im.group + "/settings");
  out.settings = s ? attrsOf(s) : {};
  // 파장축 후보: 길이가 가로축과 같은 1D 배열 (분광 모드일 때만 의미 있음)
  const wl = (det.tree || []).find((n) => n.kind === "dataset" && n.path.indexOf(im.group + "/") === 0 &&
    (n.shape || []).length === 1 && n.shape[0] === im.nx && /wl|wave|lambda/i.test(n.path));
  // 같은 그룹의 나머지 1D 배열 — 상태 기록 후보 (index_array · index_turn_on_array …).
  // 파장축은 상태 후보가 아니므로 뺀다.
  for (const n of (det.tree || [])) {
    if (n.kind !== "dataset" || n.path.indexOf(im.group + "/") !== 0) continue;
    if (n.path === im.path || n.path === im.timePath) continue;
    if (wl && n.path === wl.path) continue;
    if ((n.shape || []).length !== 1 || n.shape[0] > 4096) continue;
    const r = readDataset(file, n.path);
    if (r) out.aux[n.path.slice(im.group.length + 1)] = Array.from(r.data, Number);
  }
  if (wl) {
    const r = readDataset(file, wl.path);
    if (r) {
      const a = Array.from(r.data, Number);
      // 0,1,2,… 면 파장이 아니라 픽셀 번호다 (wl_calib='pixels')
      const isIndex = a.length > 2 && a.every((v, j) => v === j);
      out.wl = { path: wl.path, values: a, isIndex };
    }
  }
  out.camera = extractCameraMeta(file);
  out.hardware = extractHardwareSummary(file);
  return out;
}
/**
 * 카메라 설정 — hardware/* 중 "카메라로 보이는" 그룹에서 노출·게인·온도·ROI 를 모은다.
 * 장비 이름(andor_ccd · emccd · pixis …)을 고정하지 않는다. 같은 파일에 카메라
 * 그룹이 여럿 있을 수 있으므로(연결 안 된 것 포함) 점수가 가장 높은 하나만 쓴다.
 */
function extractCameraMeta(file) {
  const hw = safeGet(file, "hardware");
  if (!hw || !isGroup(hw)) return null;
  let keys = [];
  try { keys = hw.keys(); } catch (e) { return null; }
  const cands = [];
  for (const k of keys) {
    const s = safeGet(file, "hardware/" + k + "/settings");
    if (!s) continue;
    const a = attrsOf(s);
    const score = (a.exposure_time != null ? 3 : 0) + (a.em_gain != null ? 2 : 0) +
      (a.ccd_shape != null || a.readout_shape != null ? 2 : 0) +
      (a.temperature != null ? 1 : 0);
    if (score < 4) continue;
    cands.push({ score, name: k, a, connected: attrBool(a.connected) === true });
  }
  if (!cands.length) return null;
  // **연결된 후보가 하나라도 있으면 연결 안 된 것은 버린다.** ScopeFoundry 는 앱에
  // 등록된 하드웨어를 전부 h5 에 적으므로, 이 측정에 쓰이지 않은 카메라 그룹이
  // 그대로 남아 있을 수 있다(실측 파일에 속성 151개짜리 미연결 카메라가 있었다).
  // 연결 상태를 무시하면 쓰지도 않은 장비의 설정을 측정 조건으로 읽게 된다.
  const live = cands.filter((c) => c.connected);
  const pool = live.length ? live : cands;
  pool.sort((x, y) => y.score - x.score);
  const best = pool[0];
  const a = best.a;
  return {
    name: best.name, connected: best.connected,
    nCandidates: cands.length,
    rejected: cands.filter((c) => c !== best).map((c) => ({ name: c.name, connected: c.connected })),
    exposure: numOrNull(a.exposure_time), emGain: numOrNull(a.em_gain),
    temperature: numOrNull(a.temperature), tempStatus: a.temp_status != null ? String(a.temp_status) : null,
    readoutMode: a.readout_mode != null ? String(a.readout_mode) : null,
    outputAmp: numOrNull(a.output_amp),
    hbin: numOrNull(a.roi_img_hbin), vbin: numOrNull(a.roi_img_vbin),
    shape: Array.isArray(a.readout_shape) ? a.readout_shape.map(Number)
      : (Array.isArray(a.ccd_shape) ? a.ccd_shape.map(Number) : null),
    all: a,
  };
}

/**
 * hardware/ 그룹의 **연결 현황** 요약.
 *
 * ScopeFoundry 는 h5 에 그 앱에 등록된 하드웨어를 **전부** 적는다. 측정에 쓰이지 않은
 * 장비, 심지어 그 방에 없는 장비의 설정까지 그대로 남는다. 그래서 이름만 보고
 * "이 측정은 이 장비를 썼다"고 읽으면 틀린다 — 실측 파일에서 한 파워휠 항목은
 * `connected=False` 인 데다 **존재하지도 않는 서보**를 참조하고 있었다.
 * 이 함수는 연결 상태를 그대로 노출해 그 오독을 막는다. 판단은 하지 않는다.
 */
function extractHardwareSummary(file) {
  const hw = safeGet(file, "hardware");
  if (!hw || !isGroup(hw)) return null;
  let keys = [];
  try { keys = hw.keys(); } catch (e) { return null; }
  const rows = [];
  for (const k of keys) {
    const s = safeGet(file, "hardware/" + k + "/settings");
    const a = s ? attrsOf(s) : {};
    rows.push({
      name: k,
      connected: attrBool(a.connected),
      nAttrs: Object.keys(a).length,
      port: a.port != null ? String(a.port) : null,
    });
  }
  rows.sort((x, y) => (Number(y.connected === true) - Number(x.connected === true)) || x.name.localeCompare(y.name));
  return {
    rows,
    nConnected: rows.filter((r) => r.connected === true).length,
    nDisconnected: rows.filter((r) => r.connected === false).length,
  };
}

/** Gather key metadata for display: excitation wavelength, sample name, etc. */
function extractMeta(file) {
  const meta = {};
  try {
    const app = safeGet(file, "app/settings");
    if (app) {
      const a = attrsOf(app);
      if (a.sample) meta.sample = String(a.sample);
      // INNO Ledger 연동 attr 6종 중 나머지 (설계 확정본 §5 · INNO Optics Phase 7 이후 파일에만 존재)
      if (a.run_id) meta.run_id = String(a.run_id);
      if (a.specimen) meta.specimen = String(a.specimen);
      if (a.lambda_ex_nm != null && a.lambda_ex_nm !== "") meta.lambda_ex_nm = Number(a.lambda_ex_nm);
      if (a.objective) meta.objective = String(a.objective);
      if (a.calib_id) meta.calib_id = String(a.calib_id);
    }
    for (const hw of ["Inner_controller", "Outer_controller"]) {
      const s = safeGet(file, `hardware/${hw}/settings`);
      if (s) {
        const a = attrsOf(s);
        if (a.laser_state === "ON" || attrBool(a.laser_state) === true) {
          meta.laser = { name: hw, wavelength: a.wavelength ? String(a.wavelength) : "?", current: a.target_current };
          break;
        }
      }
    }
    const ps = safeGet(file, "measurement/power_scan/settings");
    if (ps) {
      const a = attrsOf(ps);
      meta.powerScanSettings = a;
    }
  } catch (e) { /* metadata best-effort */ }
  return meta;
}

return {
  KEYS, readDataset, rows2D, attrsOf, walkTree, detectType,
  extractPowerScanAPD, extractPowerScanEMCCD, extractEmccdReadout, extractPLE,
  extract2DMaps, readForPreview, extractMeta, findPleGroup, safeGet,
  extractHistogram, scanAxes, extractPATrace, findPowerScanGroup, extractRiseTime, extractWaveScan, extractDarkening,
  findImagingGroup, readImageFrame, extractImaging, extractCameraMeta, extractHardwareSummary, attrBool,
};
});

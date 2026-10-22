#!/usr/bin/env python3
"""INNO Prism v3.20 — 3D scan (z-stack) 뷰어 패치. 사용: python3 patch_scan3d.py <src>"""
import sys, pathlib
SRC = pathlib.Path(sys.argv[1])

def sub(text, old, new, name):
    n = text.count(old)
    if n != 1:
        raise SystemExit(f"[{name}] 앵커 {n}회:\n{old[:240]}")
    return text.replace(old, new, 1)

# ================================================================ h5layer.js
p = SRC / "h5layer.js"
h = p.read_text(encoding="utf-8")

h = sub(h, '''  for (const g of scanGroups) {
    const maps = tree.filter((n) => n.kind === "dataset" && n.path.startsWith(g.path + "/") &&''',
'''  for (const g of scanGroups) {
    // v3.20 — 3D(z-stack) 스캔을 먼저 본다. volume(Nz,Nv,Nh) 은 아래 2D 판정에도 걸리지만
    // extract2DMaps 는 앞 차원이 8 을 넘는 3D 를 채널로 보지 않아 버리므로, 여기서 잡지 않으면
    // "2D 맵" 으로 인식만 되고 맵이 하나도 없는 상태(축 배열 미리보기)가 된다.
    const vol = findScan3D(tree, g.path);
    if (vol) return { type: "scan3d", label: `3D scan · ${vol.nz} slice`, scanGroup: g.path, vol, tree };
    const maps = tree.filter((n) => n.kind === "dataset" && n.path.startsWith(g.path + "/") &&''', "detect scan3d")

h = sub(h, '''function extract2DMaps(file, tree, scanGroup) {''', '''/* ------------------------------ 3D (z-stack) scan ------------------------------ */
/**
 * ScopeFoundry scan_3d: volume (Nz, Nv, Nh) + h_array · v_array · stack_array.
 * 판정: 스캔 그룹 바로 아래의 3차원 데이터셋 중 (a) 첫 축 길이가 stack_array 와 같거나
 * (b) 이름이 volume/stack/3d/cube 인 것. 둘 다 아니면 3D 로 보지 않는다 — 채널×Nv×Nh
 * (앞 차원 ≤ 8) 묶음은 지금처럼 2D 맵의 slice 로 다룬다.
 */
function findScan3D(tree, group) {
  const ds = (leaf) => tree.find((n) => n.kind === "dataset" && n.path === `${group}/${leaf}`);
  const st = ds("stack_array");
  const nStack = st && st.shape ? st.shape.filter((s) => s > 1)[0] : undefined;
  let best = null;
  for (const n of tree) {
    if (n.kind !== "dataset" || !n.path.startsWith(group + "/")) continue;
    const leaf = n.path.slice(group.length + 1);
    if (leaf.includes("/")) continue;
    const eff = (n.shape || []).filter((s) => s > 1);
    if (eff.length !== 3 || eff[1] < 4 || eff[2] < 4) continue;
    const zMatch = nStack === eff[0];
    const named = /volume|stack|3d|cube/i.test(leaf);
    if (!zMatch && !named) continue;
    const score = (zMatch ? 10 : 0) + (named ? 5 : 0) + (leaf === "volume" ? 3 : 0);
    if (!best || score > best.score) best = { score, path: n.path, shape: Array.from(n.shape), nz: eff[0], ny: eff[1], nx: eff[2] };
  }
  return best;
}
/** 3D 스캔의 축·단위·상태(중단 여부·진행률)·설정. 화소는 포함하지 않는다. */
function extractScan3D(file, det) {
  const g = det.scanGroup, v = det.vol;
  const mA = attrsOf(safeGet(file, g) || {});
  const sA = attrsOf(safeGet(file, `${g}/settings`) || {});
  const uA = attrsOf(safeGet(file, `${g}/settings/units`) || {});
  const axis = (leaf, n, unitKey) => {
    const r = readDataset(file, `${g}/${leaf}`);
    const a = attrsOf(safeGet(file, `${g}/${leaf}`) || {});
    const ok = r && r.data.length === n;
    let unit = a.unit != null ? String(a.unit) : (uA[unitKey] != null ? String(uA[unitKey]) : null);
    if (unit && /^(um|µm|μm|micron)/i.test(unit)) unit = "µm";
    return { values: ok ? Array.from(r.data, Number) : Array.from({ length: n }, (_, i) => i), unit: ok ? unit : "px", fromFile: !!ok };
  };
  const xA = axis("h_array", v.nx, "h_range"), yA = axis("v_array", v.ny, "v_range"), zA = axis("stack_array", v.nz, "stack_range");
  const s = (k) => (sA[k] != null ? sA[k] : mA[k]);
  return {
    path: v.path, nz: v.nz, ny: v.ny, nx: v.nx,
    x: xA.values, y: yA.values, z: zA.values,
    xUnit: xA.unit, yUnit: yA.unit, zUnit: zA.unit,
    xName: String(s("h_axis") || "h"), yName: String(s("v_axis") || "v"), zName: String(s("stack_axis") || "z"),
    state: mA.state != null ? String(mA.state) : null,
    progress: numOrNull(mA.progress),
    currentSlice: numOrNull(sA.current_slice),
    detector: sA.detector_hw != null ? String(sA.detector_hw) : null,
    stage: sA.stage_hw != null ? String(sA.stage_hw) : null,
    dwell: numOrNull(sA.dwell), dwellUnit: uA.dwell != null ? String(uA.dwell) : null,
    bidirectional: attrBool(sA.bidirectional),
    settings: sA,
  };
}
/** k 번째 slice (Nv×Nh) → Float32Array. 측정되지 않은 화소는 NaN 그대로 둔다. */
function readScan3DSlice(file, det, k) {
  const v = det.vol, npx = v.ny * v.nx;
  const d = safeGet(file, v.path);
  if (!isDataset(d)) return null;
  let flat = null;
  try {
    const ranges = []; let seen = 0;
    for (const s of Array.from(d.shape || [])) {
      if (s === 1) { ranges.push([0, 1]); continue; }
      ranges.push(seen === 0 ? [k, k + 1] : [0, s]);
      seen++;
    }
    flat = d.slice(ranges);
  } catch (e) { flat = null; }
  if (!flat || flat.length < npx) {
    const all = readDataset(file, v.path);
    if (!all) return null;
    flat = all.data.subarray ? all.data.subarray(k * npx, (k + 1) * npx) : all.data.slice(k * npx, (k + 1) * npx);
  }
  const out = new Float32Array(npx);
  for (let j = 0; j < npx; j++) { const x = Number(flat[j]); out[j] = isFinite(x) ? x : NaN; }
  return out;
}
function extract2DMaps(file, tree, scanGroup) {''', "scan3d fns")

h = sub(h, '''  findImagingGroup, readImageFrame, extractImaging, extractCameraMeta, extractHardwareSummary, attrBool,
};''', '''  findImagingGroup, readImageFrame, extractImaging, extractCameraMeta, extractHardwareSummary, attrBool,
  findScan3D, extractScan3D, readScan3DSlice,
};''', "exports")
p.write_text(h, encoding="utf-8")
print("h5layer.js patched")

# ================================================================ app.js
p = SRC / "app.js"
a = p.read_text(encoding="utf-8")
a = sub(a, '''scan2d: 5, histogram: 6, generic: 7 };''', '''scan2d: 5, scan3d: 5.5, histogram: 6, generic: 7 };''', "TYPE_ORDER")
a = sub(a, '''    case "scan2d": return renderScan2D(rec);''', '''    case "scan2d": return renderScan2D(rec);
    case "scan3d": return renderScan3D(rec);''', "switch")
a = sub(a, '''scan2d: "2D 맵", histogram: "히스토그램",''', '''scan2d: "2D 맵", scan3d: "3D 스캔", histogram: "히스토그램",''', "tab name")
a = sub(a, '''ple: "PLE", scan2d: "2D 스캔",''', '''ple: "PLE", scan2d: "2D 스캔", scan3d: "3D 스캔 (z-stack)",''', "diag label")
a = sub(a, '''  } else if (d.type === "imaging") {
    const im = d.imaging;''', '''  } else if (d.type === "scan3d") {
    const v = d.vol;
    bits.push(`<b>판정 근거</b>: 스캔 그룹 <span class="mono">${esc(d.scanGroup)}</span> 의 3차원 데이터셋 ` +
      `<span class="mono">${esc(v.path.split("/").pop())}</span> <span class="t-shape">[${v.shape.join("×")}]</span> — ` +
      `첫 축(${v.nz})이 stack_array 길이와 같거나 이름이 volume/stack 입니다`);
  } else if (d.type === "imaging") {
    const im = d.imaging;''', "diag scan3d")

a = sub(a, '''/* ---------------------------- histogram view ------------------------------ */''', r'''/* ------------------------- 3D scan (z-stack) view --------------------------- */
/** v3.20 — ScopeFoundry scan_3d. 중단된 측정은 측정되지 않은 voxel 이 NaN 으로 남는다.
 *  slice 를 완료 / 부분 / 미측정으로 나누고, 부분 slice 는 측정된 행만 보여 주되
 *  초점 판정 같은 slice 간 비교에서는 뺀다(측정된 영역이 다르면 평균·선명도가 비교되지 않는다). */
function s3dPercentiles(arrs, qs, cap) {
  let n = 0;
  for (const a of arrs) for (let i = 0; i < a.length; i++) if (a[i] === a[i]) n++;
  if (!n) return qs.map(() => NaN);
  const stride = Math.max(1, Math.floor(n / (cap || 400000)));
  const buf = []; let c = 0;
  for (const a of arrs) for (let i = 0; i < a.length; i++) { const v = a[i]; if (v === v) { if (c % stride === 0) buf.push(v); c++; } }
  buf.sort((x, y) => x - y);
  return qs.map((q) => buf[Math.min(buf.length - 1, Math.max(0, Math.round(q * (buf.length - 1))))]);
}
function s3dSliceStats(arr, ny, nx) {
  let n = 0, sum = 0, max = -Infinity, rows = 0;
  for (let r = 0; r < ny; r++) {
    let any = false;
    for (let c = 0; c < nx; c++) { const v = arr[r * nx + c]; if (v === v) { n++; sum += v; if (v > max) max = v; any = true; } }
    if (any) rows++;
  }
  const st = { n, frac: n / (ny * nx), rows, mean: n ? sum / n : NaN, max: n ? max : NaN };
  st.status = n === 0 ? "empty" : (n === ny * nx ? "complete" : "partial");
  if (n) {
    // 선명도 = 정규화 분산(var/mean). 단일 화소 스파이크가 지배하지 않도록 p99.9 에서 자른다.
    const [p999] = s3dPercentiles([arr], [0.999]);
    let s1 = 0, s2 = 0;
    for (let i = 0; i < arr.length; i++) { const v0 = arr[i]; if (v0 === v0) { const v = Math.min(v0, p999); s1 += v; s2 += v * v; } }
    const m = s1 / n;
    st.sharp = m > 0 ? (s2 / n - m * m) / m : NaN;
    st.p99 = s3dPercentiles([arr], [0.99])[0];
  }
  return st;
}
function s3dState(rec) {
  if (rec.cache.s3d) return rec.cache.s3d;
  const m = PrismH5.extractScan3D(rec.h5, rec.det);
  const slices = [], stats = [];
  for (let k = 0; k < m.nz; k++) {
    const s = PrismH5.readScan3DSlice(rec.h5, rec.det, k) || new Float32Array(m.ny * m.nx).fill(NaN);
    slices.push(s); stats.push(s3dSliceStats(s, m.ny, m.nx));
  }
  const measured = stats.map((s, k) => (s.n ? k : -1)).filter((k) => k >= 0);
  const st = {
    m, slices, stats, measured,
    k: measured.length ? measured.filter((k) => stats[k].status === "complete").pop() ?? measured[measured.length - 1] : 0,
    mode: "slice", cmap: "Viridis", zscale: "lin", crange: "common", sb: true, probe: null,
  };
  // MIP (측정된 slice 의 최대 투영) — 기본 탐침 위치(가장 밝은 3×3 평균)를 찾는 데도 쓴다
  const mip = new Float32Array(m.ny * m.nx).fill(NaN);
  for (const k of measured) { const s = slices[k]; for (let i = 0; i < s.length; i++) { const v = s[i]; if (v === v && !(mip[i] >= v)) mip[i] = v; } }
  st.mip = mip;
  let best = -Infinity, bi = -1;
  for (let r = 1; r < m.ny - 1; r++) for (let c = 1; c < m.nx - 1; c++) {
    let s = 0, n = 0;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) { const v = mip[(r + dr) * m.nx + c + dc]; if (v === v) { s += v; n++; } }
    if (n >= 6 && s / n > best) { best = s / n; bi = r * m.nx + c; }
  }
  if (bi >= 0) st.probe = { r: Math.floor(bi / m.nx), c: bi % m.nx, auto: true };
  rec.cache.s3d = st;
  return st;
}
function s3dProbeValue(st, k, r, c) {
  const { ny, nx } = st.m, s = st.slices[k];
  let sum = 0, n = 0;
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
    const rr = r + dr, cc = c + dc;
    if (rr < 0 || cc < 0 || rr >= ny || cc >= nx) continue;
    const v = s[rr * nx + cc]; if (v === v) { sum += v; n++; }
  }
  return n ? sum / n : NaN;
}
function s3dRows(arr, ny, nx, log) {
  const z = new Array(ny);
  for (let r = 0; r < ny; r++) {
    const row = new Array(nx);
    for (let c = 0; c < nx; c++) { const v = arr[r * nx + c]; row[c] = v === v ? (log ? (v > 0 ? Math.log10(v) : null) : v) : null; }
    z[r] = row;
  }
  return z;
}
function s3dStatusHtml(st) {
  const m = st.m, S = st.stats;
  const nC = S.filter((s) => s.status === "complete").length, nP = S.filter((s) => s.status === "partial").length, nE = S.filter((s) => s.status === "empty").length;
  const interrupted = m.state && /interrupt|abort|stop|cancel/i.test(m.state);
  const parts = [];
  parts.push(interrupted
    ? `<span class="tag-Poor">측정 중단됨</span> <span class="muted">(state = ${esc(m.state)}${isFinite(m.progress) ? ` · 진행 ${fmt(m.progress, 3)}%` : ""})</span>`
    : (m.state ? `<span class="tag-Good">${esc(m.state)}</span>` : ""));
  parts.push(`slice <b>${nC}</b> 완료` + (nP ? ` · <b>${nP}</b> 부분` : "") + (nE ? ` · <b>${nE}</b> 미측정` : "") + ` <span class="muted">/ ${m.nz}</span>`);
  const P = S.findIndex((s) => s.status === "partial");
  if (P >= 0) parts.push(`<span class="muted">부분 slice #${P}: ${fmt(S[P].frac * 100, 3)}% 측정 (${S[P].rows}/${m.ny} 행)</span>`);
  return parts.filter(Boolean).join(" · ");
}
function renderScan3D(rec) {
  let st;
  try { st = s3dState(rec); }
  catch (e) { console.error(e); return renderGeneric(rec); }
  const m = st.m;
  const zU = m.zUnit || "", xyU = m.xUnit || "";
  const dz = m.nz > 1 ? (m.z[m.nz - 1] - m.z[0]) / (m.nz - 1) : NaN;
  const info = [
    `${m.nx}×${m.ny} px × ${m.nz} slice`,
    `${m.xName}·${m.yName} ${fmt(Math.abs(m.x[m.nx - 1] - m.x[0]), 4)}×${fmt(Math.abs(m.y[m.ny - 1] - m.y[0]), 4)} ${esc(xyU)}`,
    `${m.zName} ${fmt(m.z[0], 5)}–${fmt(m.z[m.nz - 1], 5)} ${esc(zU)} (간격 ${fmt(dz, 3)})`,
    m.dwell != null ? `dwell ${fmt(m.dwell, 3)} ${esc(m.dwellUnit || "s")}` : null,
    m.detector ? `검출기 ${esc(m.detector)}` : null,
    m.bidirectional != null ? (m.bidirectional ? "양방향" : "단방향") + " 래스터" : null,
  ].filter(Boolean).join(" · ");
  const chip = (k) => {
    const s = st.stats[k];
    const cls = s.status === "complete" ? "s3d-c" : s.status === "partial" ? "s3d-p" : "s3d-e";
    const tip = s.status === "empty" ? "측정되지 않음" : s.status === "partial" ? `부분 — ${fmt(s.frac * 100, 3)}% (${s.rows}행)` : "완료";
    return `<button class="s3d-chip ${cls}" data-k="${k}" ${s.status === "empty" ? "disabled" : ""} title="${esc(tip)}">#${k}<span>${fmt(m.z[k], 5)}</span></button>`;
  };
  $("#view").innerHTML = `
  <div class="panel"><h3>3D 스캔 <span class="muted small">${esc(rec.det.scanGroup)} · ${esc(m.path.split("/").pop())}</span></h3>
    <div class="s" style="margin-bottom:4px;">${s3dStatusHtml(st)}</div>
    <div class="small muted" style="margin-bottom:8px;">${info}</div>
    <div class="s3d-strip">${Array.from({ length: m.nz }, (_, k) => chip(k)).join("")}</div>
    <div class="small muted" style="margin-top:4px;">■ 완료 · ◧ 부분(측정된 행만 표시, slice 간 비교에서 제외) · □ 미측정 — ${esc(m.zName)} (${esc(zU)}) 값</div>
  </div>
  <div class="panel"><h3>XY 단면 <span id="s3d-xy-sub" class="muted small"></span></h3>
    <div class="flex small" style="margin-bottom:6px;flex-wrap:wrap;">
      <label class="ctl"><span>표시</span><select id="s3d-mode">
        <option value="slice">slice</option><option value="mip">최대 투영 (MIP)</option></select></label>
      <label class="ctl"><span>컬러맵</span><select id="s3d-cmap"><option>Viridis</option><option>Turbo</option><option>Greys</option><option>Hot</option></select></label>
      <label class="ctl"><span>Z 스케일</span><select id="s3d-z"><option value="lin">linear</option><option value="log">log</option></select></label>
      <label class="ctl"><span>색 범위</span><select id="s3d-cr">
        <option value="common">공통 — 측정 slice 전체 0.5–99.8%</option>
        <option value="slice">slice 별 0.5–99.8%</option>
        <option value="full">전체 최소–최대</option></select></label>
      <label class="ctl"><span>스케일바</span><select id="s3d-sb"><option value="1">표시</option><option value="0">숨김</option></select></label>
      <span class="right flex"><button id="s3d-png" class="small">그림 저장</button><button id="s3d-csv" class="small">slice CSV</button></span>
    </div>
    <div id="s3d-note" class="small muted" style="margin-bottom:4px;"></div>
    <div id="chart-s3d-xy" class="chart" style="height:540px;"></div>
    <div class="small muted">맵을 클릭하면 그 위치(3×3 평균)의 ${esc(m.zName)} 프로파일과 단면을 봅니다. 처음에는 MIP 에서 가장 밝은 지점이 선택됩니다.</div>
  </div>
  <div class="panel"><h3>${esc(m.zName)} 프로파일 · 초점 <span class="muted small">측정된 slice 만</span></h3>
    <div id="s3d-focus" class="s" style="margin-bottom:6px;"></div>
    <div id="chart-s3d-z" class="chart" style="height:320px;"></div>
    <div class="flex small" style="margin-top:4px;"><span class="muted">평균·p99 는 측정된 화소 기준 · 선명도 = 정규화 분산(var/mean, p99.9 에서 자름)</span>
      <span class="right"><button id="s3d-zcsv" class="small">프로파일 CSV</button></span></div>
  </div>
  <div class="panel"><h3>수직 단면 <span id="s3d-sec-sub" class="muted small"></span></h3>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
      <div id="chart-s3d-xz" class="chart" style="height:280px;"></div>
      <div id="chart-s3d-yz" class="chart" style="height:280px;"></div>
    </div>
    <div class="small muted">세로축(${esc(m.zName)})과 가로축의 배율은 같지 않습니다 — ${esc(m.zName)} 간격 ${fmt(dz, 3)} ${esc(zU)}, 가로 화소 ${fmt(Math.abs(m.x[1] - m.x[0]), 3)} ${esc(xyU)}.</div>
  </div>`;
  $("#s3d-mode").value = st.mode; $("#s3d-cmap").value = st.cmap; $("#s3d-z").value = st.zscale;
  $("#s3d-cr").value = st.crange; $("#s3d-sb").value = st.sb ? "1" : "0";
  const um = m.xUnit === "µm" && m.yUnit === "µm";
  if (!um) { $("#s3d-sb").disabled = true; $("#s3d-sb").title = "축 단위가 µm 로 기록되어 있지 않아 스케일바를 그릴 수 없습니다"; }
  const xyEl = $("#chart-s3d-xy");
  xyEl._prismScaleBarWhyNot = um ? "" : "축 단위가 µm 로 기록되어 있지 않아 스케일바를 그리지 않았습니다.";
  const common = {};
  const rangeFor = (arr, log) => {
    const tr = (v) => (log ? (v > 0 ? Math.log10(v) : NaN) : v);
    if (st.crange === "full") {
      let lo = Infinity, hi = -Infinity;
      for (const k of st.measured) { const s = st.slices[k]; for (let i = 0; i < s.length; i++) { const v = tr(s[i]); if (v === v) { if (v < lo) lo = v; if (v > hi) hi = v; } } }
      return [lo, hi];
    }
    if (st.crange === "common") {
      const key = log ? "log" : "lin";
      if (!common[key]) {
        const src = st.measured.map((k) => st.slices[k]);
        const [a, b] = s3dPercentiles(src, [0.005, 0.998]);
        common[key] = log ? [Math.log10(Math.max(a, 1e-9)), Math.log10(Math.max(b, 1e-9))] : [a, b];
      }
      return common[key];
    }
    const [a, b] = s3dPercentiles([arr], [0.005, 0.998]);
    return log ? [Math.log10(Math.max(a, 1e-9)), Math.log10(Math.max(b, 1e-9))] : [a, b];
  };
  const xLab = `${m.xName} (${xyU})`, yLab = `${m.yName} (${m.yUnit || ""})`, zLab = `${m.zName} (${zU})`;
  const drawXY = () => {
    const log = st.zscale === "log";
    const isMip = st.mode === "mip";
    const arr = isMip ? st.mip : st.slices[st.k];
    const s = st.stats[st.k];
    $("#s3d-xy-sub").textContent = isMip ? `— MIP (측정 slice ${st.measured.length}개)` : `— slice #${st.k} · ${m.zName} = ${fmt(m.z[st.k], 5)} ${zU}`;
    $("#s3d-note").innerHTML = !isMip && s.status === "partial"
      ? `<span class="tag-Poor">부분 slice</span> 측정이 이 slice 의 ${s.rows}/${m.ny} 행(${fmt(s.frac * 100, 3)}%)에서 멈췄습니다 — 빈 영역은 측정되지 않은 곳입니다.` : "";
    const cr = rangeFor(arr, log);
    const traces = [{
      z: s3dRows(arr, m.ny, m.nx, log), x: m.x, y: m.y, type: "heatmap",
      colorscale: cmapValue(st.cmap), zmin: cr[0], zmax: cr[1], zauto: false,
      colorbar: { outlinewidth: 0, thickness: 14, title: { text: (log ? "log₁₀ " : "") + (m.detector || "counts"), side: "right" } },
      hovertemplate: `${m.xName}=%{x:.3f}<br>${m.yName}=%{y:.3f}<br>값=%{z:.4g}<extra></extra>`,
    }];
    if (st.probe) traces.push({ x: [m.x[st.probe.c]], y: [m.y[st.probe.r]], mode: "markers", type: "scatter", name: "탐침",
      marker: { symbol: "cross-thin-open", size: 18, color: "#ff5c7a", line: { width: 2, color: "#ff5c7a" } }, hoverinfo: "skip", showlegend: false });
    newPlot(xyEl, traces, {
      xaxis: Object.assign(baseLayout().xaxis, { title: { text: xLab } }),
      yaxis: Object.assign(baseLayout().yaxis, { title: { text: yLab }, scaleanchor: "x" }),
      showlegend: false,
    }).then(() => {
      PrismReport.attachPlotlyScaleBar(xyEl, um ? { on: st.sb, umPerUnit: 1, source: "스테이지 좌표" } : null);
      xyEl.on("plotly_click", (ev) => {
        const pt = ev && ev.points && ev.points[0];
        if (!pt) return;
        const near = (arr, v) => { let bi = 0, bd = Infinity; arr.forEach((a, i) => { const d = Math.abs(a - v); if (d < bd) { bd = d; bi = i; } }); return bi; };
        st.probe = { r: near(m.y, pt.y), c: near(m.x, pt.x), auto: false };
        drawXY(); drawZ(); drawSections();
      });
    });
  };
  const drawZ = () => {
    const ks = st.measured, S = st.stats;
    const comp = ks.filter((k) => S[k].status === "complete");
    const part = ks.filter((k) => S[k].status === "partial");
    const traces = [];
    const add = (name, ksel, f, opts) => traces.push(Object.assign({ x: ksel.map((k) => m.z[k]), y: ksel.map(f), mode: "lines+markers", name, type: "scatter" }, opts));
    add("평균 (완료 slice)", comp, (k) => S[k].mean, { line: { color: PALETTE.blue, width: 2 }, marker: { size: 7 } });
    add("p99 (완료 slice)", comp, (k) => S[k].p99, { line: { color: PALETTE.orange, width: 1.6, dash: "dot" }, marker: { size: 6 } });
    add("선명도 var/mean", comp, (k) => S[k].sharp, { yaxis: "y2", line: { color: PALETTE.aqua, width: 2 }, marker: { size: 7, symbol: "diamond" } });
    if (part.length) add("평균 (부분 slice — 비교 제외)", part, (k) => S[k].mean, { mode: "markers", marker: { size: 9, color: PALETTE.blue, symbol: "circle-open", line: { width: 2 } } });
    if (st.probe) add(`탐침 (${fmt(m.x[st.probe.c], 4)}, ${fmt(m.y[st.probe.r], 4)}) 3×3`, ks, (k) => s3dProbeValue(st, k, st.probe.r, st.probe.c),
      { line: { color: "#ff5c7a", width: 2 }, marker: { size: 7 } });
    const shapes = st.mode === "slice" ? [{ type: "line", xref: "x", yref: "paper", x0: m.z[st.k], x1: m.z[st.k], y0: 0, y1: 1, line: { color: "#8b8a80", width: 1, dash: "dash" } }] : [];
    newPlot($("#chart-s3d-z"), traces, {
      xaxis: Object.assign(baseLayout().xaxis, { title: { text: zLab }, range: [m.z[0] - dz / 2, m.z[m.nz - 1] + dz / 2] }),
      yaxis: Object.assign(baseLayout().yaxis, { title: { text: m.detector || "counts" }, type: st.zscale === "log" ? "log" : "linear" }),
      yaxis2: Object.assign(baseLayout().yaxis, { title: { text: "선명도" }, overlaying: "y", side: "right", showgrid: false }),
      shapes, margin: { l: 62, r: 62, t: 34, b: 50 },
    });
    // 초점 판정 — 완료 slice 만 비교
    let html;
    if (comp.length < 2) html = `<span class="muted">완료된 slice 가 ${comp.length}개뿐이라 초점을 비교할 수 없습니다.</span>`;
    else {
      const arg = (f) => comp.reduce((b, k) => (f(k) > f(b) ? k : b), comp[0]);
      const kS = arg((k) => S[k].sharp), kM = arg((k) => S[k].mean);
      const edge = (k) => k === comp[0] || k === comp[comp.length - 1];
      const remaining = S.some((s) => s.status !== "complete");
      html = `선명도 최대 <b>${m.zName} = ${fmt(m.z[kS], 5)} ${esc(zU)}</b> (#${kS}) · 평균 강도 최대 ${fmt(m.z[kM], 5)} ${esc(zU)} (#${kM})` +
        (edge(kS) ? ` <span class="tag-Poor">측정 범위 끝</span> <span class="muted">최대가 완료 구간의 가장자리에 있어 실제 초점은 ${remaining ? "측정되지 않은 slice 쪽 또는 " : ""}범위 밖일 수 있습니다 — 극대가 아니라 경계값입니다.</span>` : "");
      if (st.probe) {
        const kP = arg((k) => s3dProbeValue(st, k, st.probe.r, st.probe.c));
        html += `<br>탐침 위치 강도 최대 <b>${fmt(m.z[kP], 5)} ${esc(zU)}</b> (#${kP})` + (edge(kP) ? ` <span class="tag-Poor">범위 끝</span>` : "");
      }
    }
    $("#s3d-focus").innerHTML = html;
  };
  const drawSections = () => {
    if (!st.probe) { $("#s3d-sec-sub").textContent = "— 맵을 클릭해 위치를 고르세요"; return; }
    const { r, c } = st.probe, log = st.zscale === "log";
    const cr = rangeFor(st.slices[st.k], log);
    const tr = (v) => (v === v ? (log ? (v > 0 ? Math.log10(v) : null) : v) : null);
    const xz = [], yz = [];
    for (let k = 0; k < m.nz; k++) {
      const s = st.slices[k];
      const rowX = new Array(m.nx), rowY = new Array(m.ny);
      for (let j = 0; j < m.nx; j++) rowX[j] = tr(s[r * m.nx + j]);
      for (let i = 0; i < m.ny; i++) rowY[i] = tr(s[i * m.nx + c]);
      xz.push(rowX); yz.push(rowY);
    }
    $("#s3d-sec-sub").textContent = `— ${m.yName} = ${fmt(m.y[r], 5)} (XZ) · ${m.xName} = ${fmt(m.x[c], 5)} (YZ) · 빈 줄 = 측정되지 않은 slice`;
    const hm = (z, xs, xl, title) => [{ z, x: xs, y: m.z, type: "heatmap", colorscale: cmapValue(st.cmap), zmin: cr[0], zmax: cr[1], zauto: false,
      showscale: false, hovertemplate: `${xl}=%{x:.3f}<br>${m.zName}=%{y:.4f}<br>값=%{z:.4g}<extra>${title}</extra>` }];
    const lay = (xl) => ({ xaxis: Object.assign(baseLayout().xaxis, { title: { text: xl } }), yaxis: Object.assign(baseLayout().yaxis, { title: { text: zLab } }),
      margin: { l: 62, r: 12, t: 12, b: 46 } });
    newPlot($("#chart-s3d-xz"), hm(xz, m.x, m.xName, "XZ"), lay(xLab));
    newPlot($("#chart-s3d-yz"), hm(yz, m.y, m.yName, "YZ"), lay(yLab));
  };
  const all = () => { drawXY(); drawZ(); drawSections(); };
  document.querySelectorAll(".s3d-chip").forEach((b) => b.addEventListener("click", () => {
    st.k = Number(b.dataset.k); st.mode = "slice"; $("#s3d-mode").value = "slice";
    document.querySelectorAll(".s3d-chip").forEach((x) => x.classList.toggle("on", Number(x.dataset.k) === st.k));
    all();
  }));
  document.querySelectorAll(".s3d-chip").forEach((x) => x.classList.toggle("on", Number(x.dataset.k) === st.k));
  $("#s3d-mode").addEventListener("change", (e) => { st.mode = e.target.value; drawXY(); drawZ(); });
  $("#s3d-cmap").addEventListener("change", (e) => { st.cmap = e.target.value; drawXY(); drawSections(); });
  $("#s3d-z").addEventListener("change", (e) => { st.zscale = e.target.value; all(); });
  $("#s3d-cr").addEventListener("change", (e) => { st.crange = e.target.value; drawXY(); drawSections(); });
  $("#s3d-sb").addEventListener("change", (e) => { st.sb = e.target.value === "1"; drawXY(); });
  $("#s3d-png").addEventListener("click", () => openReportForChart(xyEl));
  const stem = rec.name.replace(/\.h5$/i, "");
  $("#s3d-csv").addEventListener("click", () => {
    const arr = st.mode === "mip" ? st.mip : st.slices[st.k];
    const rows = [[`${m.yName}\\${m.xName}`, ...m.x]];
    for (let r = 0; r < m.ny; r++) { const row = [m.y[r]]; for (let c = 0; c < m.nx; c++) { const v = arr[r * m.nx + c]; row.push(v === v ? v : ""); } rows.push(row); }
    downloadText(`${stem}_${st.mode === "mip" ? "MIP" : "slice" + st.k}.csv`, rowsToCsv(rows), "text/csv");
  });
  $("#s3d-zcsv").addEventListener("click", () => {
    const head = ["slice", `${m.zName}_${zU}`, "status", "measured_fraction", "mean", "p99", "max", "sharpness_var_over_mean"];
    if (st.probe) head.push(`probe_3x3_at_${m.xName}${fmt(m.x[st.probe.c], 5)}_${m.yName}${fmt(m.y[st.probe.r], 5)}`);
    const rows = [head];
    for (let k = 0; k < m.nz; k++) {
      const s = st.stats[k];
      const row = [k, m.z[k], s.status, s.frac, s.n ? s.mean : "", s.n ? s.p99 : "", s.n ? s.max : "", s.n ? s.sharp : ""];
      if (st.probe) row.push(s.n ? s3dProbeValue(st, k, st.probe.r, st.probe.c) : "");
      rows.push(row);
    }
    downloadText(`${stem}_z_profile.csv`, rowsToCsv(rows), "text/csv");
  });
  all();
}

/* ---------------------------- histogram view ------------------------------ */''', "renderScan3D")
p.write_text(a, encoding="utf-8")
print("app.js patched")

# ================================================================ style.css
p = SRC / "style.css"
s = p.read_text(encoding="utf-8")
if ".s3d-strip" not in s:
    s = sub(s, '''.badge.scan2d { background: #c98500; color: #1a1a19; }''', '''.badge.scan2d { background: #c98500; color: #1a1a19; }
.badge.scan3d { background: #e0a020; color: #1a1a19; }''', "badge")
    s += '''
/* ---- v3.20 3D scan slice strip ---- */
.s3d-strip { display: flex; flex-wrap: wrap; gap: 5px; }
.s3d-chip { display: flex; flex-direction: column; align-items: center; gap: 1px; padding: 4px 8px; font-size: 11.5px; line-height: 1.2; min-width: 62px; }
.s3d-chip span { font-size: 10.5px; color: var(--text-muted); font-family: var(--mono); }
.s3d-chip.s3d-c { border-color: #199e70; }
.s3d-chip.s3d-p { border-color: #c98500; border-style: dashed; }
.s3d-chip.s3d-e { opacity: .45; border-style: dotted; }
.s3d-chip.on { background: var(--accent); border-color: var(--accent); color: #fff; }
.s3d-chip.on span { color: #e8ecff; }
'''
    p.write_text(s, encoding="utf-8")
print("style.css patched")

p = SRC / "build.py"
b = p.read_text(encoding="utf-8")
b = sub(b, 'VERSION = "3.19.0"', 'VERSION = "3.20.0"', "VERSION")
p.write_text(b, encoding="utf-8")
print("build.py patched")

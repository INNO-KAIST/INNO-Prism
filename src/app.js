/* =============================================================================
 * INNO Prism — application UI
 * ========================================================================== */
"use strict";

/* ------------------------------- state ----------------------------------- */
const App = {
  files: [],            // {id, name, size, vpath, h5, det, meta, cache:{}, error}
  activeId: null,
  activeTab: "view",
  worker: null,
  rpcSeq: 0,
  rpcPending: new Map(),
  h5Module: null,
  settings: {
    branch: "up",
    aggMode: "high",       // replicate 집계: "high"(고상태 max, 논문 표준) | "mean"
    monotone: true,        // 스플라인 단조 제약
    lambdaFactor: 1,       // 스무딩 배율 (1 = GCV 자동)
    bootstrapN: 150,
    bandMin: 480, bandMax: 680,
    xUnit: "W",            // "W" | "density" (mW/cm², needs calibration)
    fileSort: "name",      // 파일 목록 정렬: name(자연순) | added | type | size
    // v3.8 뷰어 레이어 — 기본은 **최소**: 분석 대상 branch + 피팅 곡선 + I_th + PA 위치.
    // (LAYER_DEFAULTS 와 같은 값이어야 한다. 두 벌이 어긋나면 저장본이 기본값을 덮어쓴다.)
    layers: { fit: true, pa: true, ith: true,
      resid: false, excluded: false, bistable: false, blink: false, other: false,
      envelope: false, spline: false, weights: false, bootband: false, norm: false },
    layersV: 2,            // 레이어 기본값 세대. 저장본이 더 낮으면 한 번 새 기본값으로 이관한다.
  },
  calib: {
    pairs: [{ pm: null, end: null }, { pm: null, end: null }, { pm: null, end: null }], // PM↔endpoint 측정쌍 (행 3~5개, 채운 만큼만 계산)
    pairRows: 3,                  // 표에 띄울 측정쌍 행 수 (CALIB_PAIR_MIN~CALIB_PAIR_MAX)
    cameraPitch: 6.45,            // 카메라 센서 픽셀 피치 (µm/px, ProgRes 기본)
    objectives: [],               // 보유 objective 목록 [{maker, model, mag, medium, na, f, wd}]
    objSel: -1,                   // 선택된 objective 인덱스 (-1 = 직접 입력)
    objMag: null,                 // 현재 배율 (선택 시 자동 입력, 직접 수정 가능)
    umPerPx: null,                // (구버전 호환) 직접 입력 유효 픽셀 스케일
    umPerPxMeasured: null,        // 눈금 타깃으로 **실측한** µm/px — 있으면 최우선
    displayGamma: 1,              // v3.11: 뷰어 표시 LUT 의 감마. 1 이면 보정 없음.
                                  //   저장본이 y = 255·(I/255)^(1/γ) 로 인코딩되어 있으면
                                  //   피팅 전에 I = 255·(y/255)^γ 로 되돌린다.
    beam: null,                   // fitGaussian2D 결과 (+binFactor)
    metrics: null,                // beamMetrics 결과
    densityMode: "peak",          // peak | e2avg | fwhm
    areaBasis: "auto",            // auto(측정 교차점으로 선택 · 기본) | d4sigma | gauss
    areaBasisUserSet: false,      // true면 사용자가 직접 고른 값 — 기본값 변경 시 덮어쓰지 않는다
    lensDbUrl: null,              // 공용 렌즈 목록 Firebase RTDB URL (빌드 내장값보다 우선)
    lambdaNm: 1064,               // 여기 파장 (회절 한계 대조용)
    /* v3.13 — 빔 이미지를 찍을 때 광로에 끼워둔 dichroic 과, 그 빔이 대표하는
     * 측정 채널. 서로 다른 dichroic 으로 찍은 빔은 **서로 다른 빔**이다(투과 파면·
     * 위치·크기가 모두 다르다). 그런데 보정값은 한 벌만 저장되므로, 한 채널에서
     * 얻은 A_peak 를 다른 채널 측정에 그대로 쓰는 사고가 조용히 일어난다
     * (실제로 600 DMSP 빔 면적으로 NIR 문턱을 계산해 1.38배 틀린 적이 있다).
     * 값만 저장하면 막을 수 없으므로 **출처를 기록하고 파일명과 대조**한다. */
    /* v3.16 — **촬영측** 감마. displayGamma(되돌리기)와 짝이지만 다른 값이다.
     * 260921 노출 선형성 실측으로 확정된 앵커는 둘뿐이다:
     *   ProgRes γ 슬라이더 0.33 → 선형 (되돌릴 것 없음, displayGamma = 1)
     *   ProgRes γ 슬라이더 0.50 → γ 2.01–2.06 (displayGamma ≈ 2.0)
     * **다른 슬라이더 값으로 외삽하지 않는다** — 앵커가 두 개뿐이므로 그 사이·바깥의
     * 거동은 측정되지 않았다. 기록해 두면 되돌리기 값과 어긋날 때 경고할 수 있다. */
    captureGamma: null,           // ProgRes 감마 슬라이더 값 ("" = 미기록)
    dichroic: "",                 // 자유 입력 라벨 (예: "950 DMSP")
    beamChannel: "",              // "" = 미기록 | Blue | NIR | UV | VIS
    enabled: false,
    // ---- INNO Ledger 연동 (설계 확정본 §4 항목4 · Phase 7) ----
    ledger: { projectId: "", apiKey: "", uid: "" },  // Firestore 접속 정보 (PC별 설정값, lensDbUrl와 동일 패턴)
    session: null,             // 현재 적용된 Ledger 보정 세션 요약값 (fetchLedgerCalib 결과)
    sessionActive: false,      // true면 calibCoefficient()가 session.coefficient를 우선 사용
    sessionError: null,        // 마지막 조회 실패 사유 (배지에 표시)
    sessionDetachedFor: null,  // 사용자가 명시적으로 해제한 calib_id — 같은 파일 재선택 시 자동 재적용 안 함
  },
};
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

/* ------------------------------ formatting -------------------------------- */
function fmt(v, digits = 4) {
  if (v == null || !isFinite(v)) return "–";
  // toPrecision 은 1~100 만 받는다 — 호출부 실수로 페이지 전체가 죽지 않게 막는다
  digits = Math.min(Math.max(Math.round(digits) || 4, 1), 100);
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-3 || a >= 1e5)) return v.toExponential(Math.max(digits - 1, 1));
  return Number(v.toPrecision(digits)).toString();
}
function fmtPow(v) { return fmt(v, 4); }
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function toast(msg, ms = 2600) {
  const t = $("#toast");
  t.textContent = msg; t.style.display = "block";
  clearTimeout(t._h); t._h = setTimeout(() => (t.style.display = "none"), ms);
}
function setProgress(frac) {
  const b = $("#progress-bar");
  b.style.width = frac == null ? "0" : `${Math.round(frac * 100)}%`;
  if (frac == null || frac >= 1) setTimeout(() => (b.style.width = "0"), 350);
}
function downloadBlob(name, blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
function downloadText(name, text, mime = "text/plain") {
  // BOM는 Excel가 CSV의 한글을 깨뜨리지 않게 하려는 것 → CSV/텍스트에만 붙인다.
  // JSON에 BOM가 붙으면 엄격한 파서(JSON.parse 등)가 거부한다.
  const bom = /json/i.test(mime) ? "" : "﻿";
  downloadBlob(name, new Blob([bom + text], { type: mime + ";charset=utf-8" }));
}
function csvEscape(v) {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function rowsToCsv(rows) { return rows.map((r) => r.map(csvEscape).join(",")).join("\r\n"); }

/* --------------------------- Plotly dark theme ---------------------------- */
/* matplotlib 'turbo' approximation — Plotly.js has no built-in Turbo */
const TURBO_SCALE = [[0, "#30123b"], [0.125, "#4669db"], [0.25, "#26bce1"], [0.375, "#32f298"],
  [0.5, "#a4fc3c"], [0.625, "#eecf3a"], [0.75, "#fb7e21"], [0.875, "#d02f05"], [1, "#7a0403"]];
function cmapValue(name) { return name === "Turbo" ? TURBO_SCALE : name; }
const PALETTE = { blue: "#3987e5", orange: "#d95926", aqua: "#199e70", yellow: "#c98500", magenta: "#d55181", green: "#008300", violet: "#9085e9", red: "#e66767" };
function baseLayout(overrides) {
  return Object.assign({
    paper_bgcolor: "#1a1a19", plot_bgcolor: "#1a1a19",
    font: { color: "#c3c2b7", size: 12.5, family: "-apple-system, 'Segoe UI', 'Malgun Gothic', sans-serif" },
    margin: { l: 62, r: 18, t: 34, b: 50 },
    xaxis: { gridcolor: "#2b2b28", zerolinecolor: "#3a3a36", linecolor: "#3a3a36", tickcolor: "#3a3a36" },
    yaxis: { gridcolor: "#2b2b28", zerolinecolor: "#3a3a36", linecolor: "#3a3a36", tickcolor: "#3a3a36" },
    legend: { orientation: "h", y: 1.09, x: 0, bgcolor: "rgba(0,0,0,0)", font: { size: 11.5 } },
    hovermode: "closest",
    colorway: Object.values(PALETTE),
  }, overrides || {});
}
/* v3.19 — 모드바 카메라(화면 크기 그대로 캡쳐)를 **보고서용 고정 판형 내보내기**로 대체한다.
 * 이전 캡쳐는 창 크기·브라우저 배율마다 가로세로비와 글자 크기가 달랐고 어두운 화면색 그대로였다. */
const PLOT_CONFIG = {
  responsive: true, displaylogo: false,
  modeBarButtonsToRemove: ["select2d", "lasso2d", "autoScale2d", "toImage"],
  modeBarButtonsToAdd: [PrismReport.modebarButton((gd) => reportMetaFor(gd))],
};
function newPlot(el, traces, layout) {
  return Plotly.newPlot(el, traces, baseLayout(layout), PLOT_CONFIG);
}

/* --------------------------- report figure export ------------------------- */
/** 한 패널에 그래프가 둘 이상이거나 패널 제목이 그림 제목으로 맞지 않는 경우의 기본 제목. */
const REPORT_TITLES = {
  "chart-ple-em": "PLE — 방출 스펙트럼 슬라이스",
  "chart-ple-ex": "PLE — 여기 스펙트럼 슬라이스",
  "cb-beam-chart": "빔 프로파일",
  "chart-tr": "ROI 트레이스",
};
function prismVersion() {
  const v = document.querySelector(".brand .ver");
  return v ? v.textContent.replace(/^v/, "").trim() : "";
}
/** 그래프를 담은 패널(또는 모달)의 제목 — 보조 설명(.muted)·버튼은 뺀다. */
function reportHeading(el) {
  const host = el.closest(".panel") || el.closest(".modal");
  const h = host && host.querySelector("h3, h2");
  if (!h) return "";
  const c = h.cloneNode(true);
  c.querySelectorAll(".muted, button, select, input, span[id]").forEach((n) => n.remove());
  return c.textContent.replace(/\s+/g, " ").replace(/[—–-]\s*$/, "").trim();
}
function reportMetaFor(gd) {
  const rec = App.files.find((f) => f.id === App.activeId);
  const inModal = !!gd.closest(".modal");
  const sb = gd._prismScaleBar;
  const ya = gd.layout && gd.layout.yaxis;
  const isMap = !!sb || !!(ya && ya.scaleanchor === "x");
  const stem = rec && !inModal ? rec.name.replace(/\.h5$/i, "") : (gd.id || "prism");
  return {
    kind: isMap ? "map" : "graph",
    key: gd.id || "",
    title: REPORT_TITLES[gd.id] || reportHeading(gd) || "Figure",
    subtitle: inModal ? "" : (rec ? rec.name.replace(/\.h5$/i, "") : ""),
    stem, version: prismVersion(),
    hasScaleBar: !!(sb && sb.on),
    scaleBarWhyNot: isMap && !(sb && sb.on) ? (gd._prismScaleBarWhyNot || "") : "",
  };
}
/** 그래프 옆 "PNG" 버튼들도 모두 같은 내보내기 창을 연다. */
function openReportForChart(el) {
  if (!el || !el.data) { toast("그래프가 아직 그려지지 않았습니다"); return; }
  PrismReport.openDialog(Object.assign({ provider: PrismReport.plotlyProvider(el) }, reportMetaFor(el)));
}

/* ------------------------------ worker RPC -------------------------------- */
function initWorker() {
  try {
    const src = document.getElementById("prism-fit2-src").textContent +
      "\nself.onmessage=function(e){const{id,cmd,payload}=e.data;" +
      "try{if(cmd==='analyze2'){const r=PrismFit.analyze(payload.branch,payload.options);self.postMessage({id,ok:true,result:r});}" +
      "else if(cmd==='boot2'){const r=PrismFit.bootstrap(payload.analysis,payload.options,function(f,l){self.postMessage({id,progress:f,label:l});});self.postMessage({id,ok:true,result:r});}" +
      "else if(cmd==='rise2'){const r=PrismFit.riseAnalyze(payload.input,payload.options);self.postMessage({id,ok:true,result:r});}" +
      "else if(cmd==='dark2'){const r=PrismFit.darkenAnalyze(payload.input,payload.options);self.postMessage({id,ok:true,result:r});}" +
      "else if(cmd==='riseboot2'){const r=PrismFit.riseBootstrap(payload.input,payload.analysis,payload.options,function(f,l){self.postMessage({id,progress:f,label:l});});self.postMessage({id,ok:true,result:r});}" +
      "else{self.postMessage({id,ok:false,error:'unknown cmd'});}}" +
      "catch(err){self.postMessage({id,ok:false,error:String(err&&err.message||err)});}};";
    App.worker = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
    App.worker.onmessage = (e) => {
      const { id, ok, result, error, progress, label } = e.data;
      const p = App.rpcPending.get(id);
      if (!p) return;
      if (progress !== undefined) { p.onProgress && p.onProgress(progress, label); return; }
      App.rpcPending.delete(id);
      ok ? p.resolve(result) : p.reject(new Error(error));
    };
  } catch (e) {
    console.warn("worker unavailable, falling back to main thread", e);
    App.worker = null;
  }
}
function rpc(cmd, payload, onProgress) {
  if (!App.worker) {
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        try {
          if (cmd === "analyze2") resolve(PrismFit.analyze(payload.branch, payload.options));
          else if (cmd === "boot2") resolve(PrismFit.bootstrap(payload.analysis, payload.options, onProgress));
          else if (cmd === "rise2") resolve(PrismFit.riseAnalyze(payload.input, payload.options));
          else if (cmd === "dark2") resolve(PrismFit.darkenAnalyze(payload.input, payload.options));
          else if (cmd === "riseboot2") resolve(PrismFit.riseBootstrap(payload.input, payload.analysis, payload.options, onProgress));
          else reject(new Error("unknown cmd"));
        } catch (err) { reject(err); }
      }, 10);
    });
  }
  const id = ++App.rpcSeq;
  return new Promise((resolve, reject) => {
    App.rpcPending.set(id, { resolve, reject, onProgress });
    App.worker.postMessage({ id, cmd, payload });
  });
}

/* ----------------------------- file loading ------------------------------- */
async function ensureH5() {
  if (App.h5Module) return App.h5Module;
  App.h5Module = await h5wasm.ready;
  return App.h5Module;
}
let fileSeq = 0;
/* HDF5 superblock 서명은 파일 오프셋 0, 512, 1024, 2048 … 중 한 곳에 있다 (HDF5 File Format Spec §II.A).
   h5wasm 은 서명이 없는 파일도 예외 없이 열어 "데이터셋 없음"으로 보였기 때문에, 열기 전에 확인한다. */
function hasHdf5Signature(buf) {
  const sig = [0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let off = 0; off + 8 <= buf.length; off = off ? off * 2 : 512) {
    let ok = true;
    for (let i = 0; i < 8; i++) if (buf[off + i] !== sig[i]) { ok = false; break; }
    if (ok) return true;
  }
  return false;
}
async function addFiles(fileList) {
  const files = Array.from(fileList).filter((f) => /\.(h5|hdf5)$/i.test(f.name));
  if (!files.length) { toast(".h5 파일이 없습니다"); return; }
  // 로드 순서도 자연 정렬 (진행 표시가 파일명 순서대로 보이도록)
  files.sort((a, b) => naturalCompare(a.webkitRelativePath || a.name, b.webkitRelativePath || b.name));
  const Module = await ensureH5();
  let firstNew = null;
  for (const f of files) {
    if (App.files.some((x) => x.name === f.name && x.size === f.size)) continue;
    const id = `f${++fileSeq}`;
    const rec = { id, seq: fileSeq, path: f.webkitRelativePath || f.name,
      name: f.name, size: f.size, vpath: `/work/${id}.h5`, h5: null, det: null, meta: null, cache: {}, error: null };
    try {
      const buf = new Uint8Array(await f.arrayBuffer());
      if (!hasHdf5Signature(buf)) throw new Error("HDF5 서명(\\x89HDF)이 없습니다 — .h5 형식이 아니거나 앞부분이 잘린 파일입니다");
      try { Module.FS.mkdir("/work"); } catch (e) {}
      Module.FS.writeFile(rec.vpath, buf);
      rec.h5 = new h5wasm.File(rec.vpath, "r");
      rec.det = PrismH5.detectType(rec.h5);
      rec.meta = PrismH5.extractMeta(rec.h5);
    } catch (e) {
      rec.error = String(e && e.message || e);
      rec.det = { type: "generic", label: "읽기 오류", tree: [] };
    }
    App.files.push(rec);
    if (!firstNew) firstNew = rec.id;
  }
  sortFileList();
  renderFileList();
  if (firstNew && !App.activeId) selectFile(firstNew);
  else renderFileList();
  toast(`${files.length}개 파일 로드됨`);
}
function clearAllFiles() {
  if (!App.files.length) return;
  const n = App.files.length;
  if (!confirm(`불러온 파일 ${n}개를 목록에서 모두 제거할까요?\n(디스크의 원본 .h5 파일은 삭제되지 않습니다)`)) return;
  for (const rec of App.files) {
    try { rec.h5 && rec.h5.close(); } catch (e) {}
    try { App.h5Module && App.h5Module.FS.unlink(rec.vpath); } catch (e) {}
  }
  App.files = [];
  App.activeId = null;
  renderAll();
  toast(`${n}개 파일을 목록에서 제거했습니다`);
}
function removeFile(id) {
  const i = App.files.findIndex((f) => f.id === id);
  if (i < 0) return;
  const rec = App.files[i];
  try { rec.h5 && rec.h5.close(); App.h5Module.FS.unlink(rec.vpath); } catch (e) {}
  App.files.splice(i, 1);
  if (App.activeId === id) { App.activeId = null; App.files.length ? selectFile(App.files[Math.max(0, i - 1)].id) : renderAll(); }
  renderFileList();
}

/* ------------------------------ file list --------------------------------- */
const TYPE_ORDER = { power_apd: 0, power_emccd: 1, emccd_readout: 2, imaging: 3, ple: 4, scan2d: 5, histogram: 6, generic: 7 };
/* ------------------------------ 파일 정렬 --------------------------------- */
/** 자연(숫자 인식) 정렬 — "파일2" < "파일10". 사전식 정렬은 문자 단위로 비교해
 *  "1, 10, 11, 2, 21"처럼 늘어놓으므로 측정 시퀀스 파일에서 특히 혼란스럽다.
 *  Intl.Collator({numeric:true})는 한글·영문·숫자 혼용 파일명에서도 안정적이고
 *  브라우저 네이티브라 대량 파일에서도 빠르다. */
const NAT_COLLATOR = (typeof Intl !== "undefined" && Intl.Collator)
  ? new Intl.Collator(undefined, { numeric: true, sensitivity: "base" })
  : null;
function naturalCompare(a, b) {
  const x = String(a == null ? "" : a), y = String(b == null ? "" : b);
  return NAT_COLLATOR ? NAT_COLLATOR.compare(x, y) : x.localeCompare(y, undefined, { numeric: true });
}
/** 정렬 키: 폴더 업로드 시 상대경로(폴더 그룹 유지) → 없으면 파일명 */
function fileSortKey(rec) { return rec.path || rec.name || ""; }
/** App.files를 현재 정렬 기준으로 제자리 정렬 (seq 타이브레이크 → 안정적) */
function sortFileList() {
  const byName = (a, b) => naturalCompare(fileSortKey(a), fileSortKey(b));
  const cmp = {
    name: byName,
    added: (a, b) => (a.seq || 0) - (b.seq || 0),
    type: (a, b) => naturalCompare((a.det && a.det.type) || "zz", (b.det && b.det.type) || "zz") || byName(a, b),
    size: (a, b) => (b.size || 0) - (a.size || 0) || byName(a, b),
  }[App.settings.fileSort] || byName;
  App.files.sort((a, b) => cmp(a, b) || ((a.seq || 0) - (b.seq || 0)));
}

function renderFileList() {
  const q = ($("#file-search").value || "").toLowerCase();
  const el = $("#file-list");
  const items = App.files
    .filter((f) => !q || f.name.toLowerCase().includes(q))
    .map((f) => {
      const badge = f.error ? `<span class="badge error">오류</span>` : `<span class="badge ${f.det.type}">${esc(f.det.label)}</span>`;
      return `<div class="file-item ${f.id === App.activeId ? "active" : ""}" data-id="${f.id}">
        <div class="fname">${f.path && f.path !== f.name ? `<span class="muted" style="font-size:11px">${esc(f.path.slice(0, f.path.length - f.name.length))}</span>` : ""}${esc(f.name)}</div>
        <div class="fmeta">${badge}<span>${(f.size / 1024).toFixed(0)} KB</span>
        <button class="small rm" data-rm="${f.id}" title="목록에서 제거" style="margin-left:auto;padding:0 6px;font-size:11px;">×</button></div>
      </div>`;
    });
  el.innerHTML = items.join("") || "";
  $("#drop-hint").style.display = App.files.length ? "none" : "block";
  $("#file-count").textContent = App.files.length ? `${App.files.length}` : "";
}
function selectFile(id) {
  App.activeId = id;
  App.activeTab = "view";
  // 모바일: 파일 선택 시 목록을 접어 콘텐츠 공간 확보
  if (window.matchMedia && window.matchMedia("(max-width: 820px)").matches) {
    const sb = document.getElementById("sidebar");
    if (sb) sb.classList.add("collapsed");
  }
  renderAll();
  const rec = App.files.find((f) => f.id === id);
  if (rec) maybeApplyLedgerSession(rec);
}

/* ------------------------------- rendering -------------------------------- */
function renderAll() {
  renderFileList();
  const rec = App.files.find((f) => f.id === App.activeId);
  const header = $("#file-header"), tabs = $("#tabs"), view = $("#view");
  if (!rec) {
    header.innerHTML = ""; tabs.innerHTML = "";
    view.innerHTML = `<div class="empty-state">
      <svg width="72" height="72" viewBox="0 0 24 24" fill="none"><path d="M12 3L3 19h18L12 3z" stroke="#3987e5" stroke-width="1.4"/><path d="M9.5 14.5l1.8-3.4 1.4 2.2 1.8-3.8" stroke="#c98500" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <div class="big">INNO Prism에 오신 것을 환영합니다</div>
      <div>.h5 광학 측정 파일을 열거나 이 창에 끌어다 놓으세요.<br>
      Power scan는 자동으로 Non-linearity 피팅이 수행됩니다.</div>
      <div class="flex"><button class="primary" onclick="document.getElementById('file-input').click()">파일 열기</button>
      <button onclick="document.getElementById('dir-input').click()">폴더 열기</button></div>
      <div class="muted small">모든 데이터는 이 PC의 브라우저 안에서만 처리됩니다 (오프라인 동작).</div>
    </div>`;
    return;
  }
  const metaBits = [];
  if (rec.meta && rec.meta.laser) metaBits.push(`여기 레이저 ${esc(rec.meta.laser.wavelength)}`);
  if (rec.meta && rec.meta.sample) metaBits.push(`시료 ${esc(rec.meta.sample)}`);
  header.innerHTML = `<span id="file-title">${esc(rec.name)}</span>
    <span class="badge ${rec.det.type}">${esc(rec.det.label)}</span>
    <span id="file-sub">${metaBits.join(" · ")}</span>`;
  const tabDefs = [["view", viewTabLabel(rec)], ["structure", "H5 구조"]];
  tabs.innerHTML = tabDefs.map(([k, l]) => `<div class="tab ${App.activeTab === k ? "active" : ""}" data-tab="${k}">${l}</div>`).join("");
  if (rec.error) {
    view.innerHTML = `<div class="panel err-state" role="alert"><h3>이 파일을 열 수 없습니다</h3>
      <div class="small">다음 중 하나일 가능성이 큽니다.</div>
      <ul class="small"><li>HDF5(.h5) 형식이 아니거나 확장자만 .h5인 파일</li><li>측정 중이거나 저장이 끝나지 않아 잘린 파일</li><li>복사 중 손상된 파일 — 원본에서 다시 복사해 보세요</li></ul>
      <details class="small"><summary class="muted">오류 원문</summary><div class="mono">${esc(rec.error)}</div></details>
      <div class="flex" style="margin-top:10px;"><button id="err-rm" class="small">목록에서 제거</button></div></div>`;
    const rb = document.getElementById("err-rm");
    if (rb) rb.addEventListener("click", () => { const b = document.querySelector(`#file-list [data-rm="${rec.id}"]`); if (b) b.click(); });
    return;
  }
  if (App.activeTab === "structure") return renderStructure(rec);
  switch (rec.det.type) {
    case "power_apd": case "power_emccd": return renderPowerScan(rec);
    case "emccd_readout": return renderEmccdReadout(rec);
    case "ple": return renderPLE(rec);
    case "scan2d": return renderScan2D(rec);
    case "histogram": return renderHistogram(rec);
    case "rise_time": return renderRiseTime(rec);
    case "darkening": return renderDarkening(rec);
    case "imaging": return renderImaging(rec);
    default: return renderGeneric(rec);
  }
}
/** v3.7 — 보고 상태 배지. 네 상태를 **다른 말로** 표시한다:
 *  lower bound(검증됨) / unidentified / 격자한계 점프 / point estimate. 셋을 한 색으로 칠하면 구분이 사라진다. */
function paBadge(a) {
  if (a.paSource === "lower-bound") return ' <span class="tag-Low">model-free lower bound</span>';
  if (a.paSource === "unresolved") return ' <span class="tag-Poor">unidentified — point estimate 아님</span>';
  if (a.paGridLimited) return ' <span class="tag-Low">grid-limited lower bound</span>';
  return "";
}
/** 왜 unidentified인가 — 판정 근거를 그대로 옮긴다(추측하지 않는다). */
function unresolvedWhy(a) {
  const bh = a.boundHits || [];
  if (bh.length) {
    const w = bh.find((b) => b.param === "w");
    if (w && w.at === "sub-grid") return `transition width가 파워 격자보다 좁습니다 (w=${fmt(w.value, 3)} < 격자/2=${fmt(w.bound, 3)} dec)`;
    if (w) return `transition width가 lower bound에 붙었습니다 (w=${fmt(w.value, 3)} dec = 모델 최소폭)`;
    return `constraint boundary 접촉: ${bh.map((b) => b.param).join(", ")}`;
  }
  if (a.sMaxEdge) return `기울기 최대가 측정범위 ${a.sMaxEdge === "left" ? "왼쪽" : "오른쪽"} 끝입니다`;
  return "식별 조건 미충족";
}
/** v3.8 — dark floor (검출기 암계수) 차감 상태.
 *  I = D + S 이므로 관측 기울기 = [S/(D+S)]·신호 기울기 로 **눌린다**. D 는 기기 artifact 이므로
 *  빼는 것이 맞지만, 과다 차감은 lower bound를 부풀리므로 평탄할 때만 · 3σ 덜 뺀다. */
function darkTxt(a) {
  const d = a.darkFloor;
  if (!d) return "";
  if (!d.flat) {
    return `<div class="s muted">dark floor 차감 안 함 — ${esc(d.why || "평탄하지 않음")}.
      pre-avalanche 발광이 이미 오르고 있으면 '상수 바닥'이 정의되지 않으므로 빼지 않습니다
      (억지로 빼면 낮은 점이 0 에 붙어 lower bound가 부풀려집니다).</div>`;
  }
  const raw = a.sLowerBoundRaw && isFinite(a.sLowerBoundRaw.slope) ? a.sLowerBoundRaw.slope : NaN;
  const cor = a.sLowerBound && isFinite(a.sLowerBound.slope) ? a.sLowerBound.slope : NaN;
  return `<div class="s">dark floor 차감됨: D = ${fmt(d.D, 4)} counts → ${fmt(d.Dsub, 4)} 만큼 차감
    <span class="muted">(D̂ − 3σ, 일부러 덜 뺌)</span>${isFinite(raw) && isFinite(cor) && cor > raw
      ? ` · lower bound ${fmt(raw, 4)} → <b>${fmt(cor, 4)}</b> (×${fmt(cor / raw, 3)})` : ""}</div>`;
}
/** v3.8 — 국소 점화 적합 (부차 보고). 헤드라인이 아닌 이유까지 함께 보인다. */
function localFitTxt(a) {
  const L = a.localFit;
  if (!L) return "";
  if (!L.usable) {
    return `<div class="s muted">국소 점화 적합 (local S-curve): ${isFinite(L.sMax) ? "n_max ≈ " + fmt(L.sMax, 4) : "산출 실패"}
      ${isFinite(L.nu) ? `· shape ν̂ = ${fmt(L.nu, 3)}` : ""} — <b>point estimate로 쓰지 않음</b>: ${esc(L.why || "-")}</div>`;
  }
  return `<div class="s">국소 점화 적합 (local S-curve): <b>n_max ≈ ${fmt(L.sMax, 4)}</b> @ P=${fmt(L.sMaxAtP, 4)} W
    · shape ν̂ = ${fmt(L.nu, 3)} · transition width ${fmt(L.w, 3)} dec · n_H = ${fmt(L.nH, 3)} (창 ${L.nWin}점)
    <span class="muted">— 점화 구간만 떼어 맞춘 값입니다. 전역 적합과 달리 암평탄부·포화의 영향을 받지 않지만,
    문턱 아래 tail 의 모양 가정에 의존합니다. 합성 검증 회수율 0.92~1.16배(모양이 표집된 조건).</span>
    ${L.usedForReport ? "" : `<div class="s muted">헤드라인에는 쓰지 않습니다 — 기본값은 보수적입니다
      (<code>localFitHeadline: true</code> 로 열 수 있습니다).</div>`}</div>`;
}
function viewTabLabel(rec) {
  return { power_apd: "분석 · Power scan", power_emccd: "분석 · Power scan", emccd_readout: "스펙트럼", ple: "PLE 맵", scan2d: "2D 맵", histogram: "히스토그램", rise_time: "분석 · Rise time", darkening: "분석 · Darkening", imaging: "이미징 · 단일입자", generic: "미리보기" }[rec.det.type] || "보기";
}

/* --------------------------- beam calibration ----------------------------- */
/** 1단계 파워 측정쌍의 **표시·입력 단위는 µW**, **저장 단위는 W** 로 고정한다.
 *  실측이 보통 µW~mW 대라 W 로 적으면 0.000622 처럼 앞자리 0 이 길어져 오타가 난다.
 *  저장을 W 로 두는 이유: 계수 C = end/pm 은 무차원이라 단위에 무관하지만,
 *  Ledger 로 내보내는 pairs 는 W 로 약속돼 있어 저장 단위를 바꾸면 연동이 깨진다. */
const CALIB_W_PER_UW = 1e-6;
const wToUw = (v) => (v == null || !isFinite(v) ? "" : Number((v / CALIB_W_PER_UW).toPrecision(12)));
const uwToW = (v) => (v === "" || v == null || !isFinite(Number(v)) ? null : Number(v) * CALIB_W_PER_UW);

/** 측정쌍 행 수의 lower bound·upper bound. lower bound는 "항상 보이는 행 수"일 뿐 입력 의무가 아니다 —
 *  계산은 **실제로 채운 개수**로만 한다(빈 행은 없는 것과 같다). */
const CALIB_PAIR_MIN = 3;
const CALIB_PAIR_MAX = 5;

/** pairs 배열과 pairRows 를 항상 유효한 상태로 맞춘다.
 *  - 구버전 저장본(행 3개 고정)이나 손상된 값이 들어와도 여기서 수습한다.
 *  - pairRows 가 없으면 **채워진 마지막 행 위치**에서 되살린다 — 5행을 쓰던 사람이
 *    다시 열었을 때 5행이 그대로 보여야 하기 때문이다. */
function normalizeCalibPairs(c) {
  if (!Array.isArray(c.pairs)) c.pairs = [];
  c.pairs = c.pairs.slice(0, CALIB_PAIR_MAX).map((q) => ({
    pm: q && isFinite(q.pm) ? Number(q.pm) : null,
    end: q && isFinite(q.end) ? Number(q.end) : null,
  }));
  let lastFilled = 0;
  c.pairs.forEach((q, i) => { if (q.pm != null || q.end != null) lastFilled = i + 1; });
  let rows = Number(c.pairRows);
  if (!isFinite(rows)) rows = lastFilled;          // 구버전 저장본: 데이터에서 복원
  rows = Math.max(CALIB_PAIR_MIN, Math.min(CALIB_PAIR_MAX, Math.round(rows) || 0));
  rows = Math.max(rows, lastFilled);               // 채워진 행이 숨겨지는 일은 없어야 한다
  c.pairRows = rows;
  while (c.pairs.length < rows) c.pairs.push({ pm: null, end: null });
  c.pairs.length = rows;
  return c;
}

/** C = P_sample / P_PM  from 1–CALIB_PAIR_MAX (PM, endpoint) pairs.
 *  1 pair → plain ratio; 2+ pairs → through-origin LSQ slope.
 *  3+ pairs → residual로 기울기 표준오차까지 낸다(원점 통과이므로 dof = n−1). */
function calibCoefficient() {
  const c0 = App.calib;
  if (c0.sessionActive && c0.session && isFinite(c0.session.coefficient)) {
    return { C: c0.session.coefficient, nPairs: 0, ratios: [], spreadPct: NaN, fromSession: true };
  }
  const pairs = (App.calib.pairs || []).filter((q) => isFinite(q.pm) && q.pm > 0 && isFinite(q.end) && q.end > 0);
  if (!pairs.length) return { C: NaN, nPairs: 0, ratios: [], spreadPct: NaN };
  const ratios = pairs.map((q) => q.end / q.pm);
  let C;
  if (pairs.length === 1) C = ratios[0];
  else {
    let sxy = 0, sxx = 0;
    for (const q of pairs) { sxy += q.pm * q.end; sxx += q.pm * q.pm; }
    C = sxy / sxx;
  }
  const spreadPct = ratios.length > 1 ? 100 * (Math.max(...ratios) - Math.min(...ratios)) / C : NaN;
  // 기울기 표준오차 — 점이 3개 이상일 때만 낸다. n=2 는 dof=1 이라 수치는 나오지만
  // 읽을 값이 못 된다(residual 하나로 spread를 추정하는 셈). 내지 않는 편이 정직하다.
  let seC = NaN;
  if (pairs.length >= 3) {
    let ss = 0, sxx2 = 0;
    for (const q of pairs) { const r = q.end - C * q.pm; ss += r * r; sxx2 += q.pm * q.pm; }
    seC = Math.sqrt(ss / (pairs.length - 1) / sxx2);
  }
  return { C, nPairs: pairs.length, ratios, spreadPct, seC };
}
/** 유효 픽셀 크기 (µm/px) = 카메라 피치 / objective 배율. 구버전 직접입력 fallback. */
/** 유효 픽셀 크기 (µm/px).
 *
 * v3.9 — **실측값이 있으면 그것을 쓴다.** pitch/배율 계산은 다음을 전부 모른다:
 *  · 무한보정 대물의 실제 배율은 M = f_경통렌즈 / f_대물 이라 **경통렌즈가 제조사
 *    표준(Nikon 200 · Olympus 180 · Zeiss 165 mm)과 다르면 표기 배율이 아니다.**
 *    Nikon 60× 를 180 mm 경통에 물리면 54× 다 → 스케일 11% · 면적 23% 오차.
 *  · 카메라 포트의 C-mount 어댑터 배율(0.5×/0.7×/1×). 0.7× 면 스케일 43% ·
 *    **면적 2배** → 파워밀도가 절반으로 틀린다.
 *  · 포트 안의 릴레이 광학계.
 * 눈금 타깃이나 크기를 아는 비드를 **같은 카메라 경로로** 찍어 재면 이 셋이 한 번에
 * 해결된다. 그래서 실측값을 최우선으로 둔다. */
function calibEffUmPerPx() {
  const c = App.calib;
  if (isFinite(c.umPerPxMeasured) && c.umPerPxMeasured > 0) return c.umPerPxMeasured;
  const pitch = isFinite(c.cameraPitch) && c.cameraPitch > 0 ? c.cameraPitch : 6.45;
  if (isFinite(c.objMag) && c.objMag > 0) return pitch / c.objMag;
  if (isFinite(c.umPerPx) && c.umPerPx > 0) return c.umPerPx; // legacy manual value
  return NaN;
}
/** 계산값 (실측이 있어도 대조용으로 필요) */
function calibNominalUmPerPx() {
  const c = App.calib;
  const pitch = isFinite(c.cameraPitch) && c.cameraPitch > 0 ? c.cameraPitch : 6.45;
  return (isFinite(c.objMag) && c.objMag > 0) ? pitch / c.objMag : NaN;
}
/** 밀도 계산에 실제로 쓸 빔 면적 메트릭 — Ledger 보정 세션이 활성이고 그 세션에
 * metrics(§4 항목2·4, Phase 8)가 있으면 그걸 우선 쓴다(다른 PC에서 이미 피팅해 둔 값도
 * 그대로 쓸 수 있게 됨 — "완전 자동" 파워밀도 환산의 핵심). 없으면 이 PC에서 직접 연
 * 빔 이미지의 로컬 피팅 결과(App.calib.metrics)로 되돌아간다(기존 동작 그대로). */
function activeCalibMetrics() {
  const c = App.calib;
  if (c.sessionActive && c.session && c.session.metrics) return c.session.metrics;
  return c.metrics;
}
function calibAreaCm2() {
  const m = activeCalibMetrics();
  if (!m) return NaN;
  const um2 = { peak: m.areaPeakUm2, e2avg: m.area1e2Um2, fwhm: m.areaFwhmUm2 }[App.calib.densityMode] || m.areaPeakUm2;
  return um2 * 1e-8;
}
/** 두 폭 정의(회전 Gaussian 1/e² vs ISO 11146 회전 D4σ) 비교 + 회전 무시 시
 *  발생하는 면적 과대평가량 + 품질 경고를 한 블록으로 렌더링. */
/** 선택된 렌즈의 사양(NA·매질·초점거리)과 회절 한계 대조.
 *  회절 한계 FWHM ≈ 0.51·λ/NA (침지 시에도 λ는 진공 파장, NA가 n를 포함).
 *  측정 FWHM가 이 값보다 작으면 물리적으로 불가능 → 배율·픽셀피치·NA 중
 *  하나가 잘못된 것이므로, 파워밀도가 조용히 틀리는 것을 여기서 잡아낸다. */
function lensInfoHtml(c) {
  const o = c.objSel >= 0 && c.objectives ? c.objectives[c.objSel] : null;
  if (!o) return "";
  const bits = [];
  if (isFinite(Number(o.na)) && o.na > 0) bits.push(`NA ${fmt(o.na, 3)}`);
  if (LENS_MEDIA[o.medium]) bits.push(LENS_MEDIA[o.medium]);
  if (isFinite(Number(o.wd)) && Number(o.wd) > 0) bits.push(`WD = ${fmt(o.wd, 3)} mm`);
  const f = lensFocalMm(o);
  if (f) bits.push(`f = ${fmt(f.mm, 4)} mm` + (f.derived ? ` <span class="muted">(경통렌즈 ${f.tube} mm ÷ ${fmt(o.mag, 4)}× 자동계산)</span>` : ` <span class="muted">(기록값)</span>`));
  let diag = "";
  const lam = Number(c.lambdaNm), na = Number(o.na);
  if (isFinite(lam) && lam > 0 && isFinite(na) && na > 0) {
    const dlFwhm = 0.51 * (lam * 1e-3) / na;            // µm
    diag = `<br>회절 한계 FWHM ≈ 0.51·λ/NA = <b>${fmt(dlFwhm, 3)} µm</b>`;
    const m = c.metrics;
    if (m && isFinite(m.fwhmXum) && isFinite(m.fwhmYum)) {
      const meas = Math.sqrt(m.fwhmXum * m.fwhmYum);     // 기하평균
      const r = meas / dlFwhm;
      const cls = r < 0.95 ? "tag-Poor" : r < 1.5 ? "tag-High" : r < 5 ? "tag-Low" : "tag-Poor";
      /* 원인 순서가 중요하다. ×N 이 크다고 곧바로 "정렬·초점" 을 의심하게 하면
       * 오진한다 — 실제로 겪었듯 스케일 3배 오류(면적 9배)나 되돌리지 않은
       * 표시 감마가 이 배수를 통째로 만들어낼 수 있다. 그래서 파일 무결성 →
       * 스케일 출처 → 광학계 순으로 짚고, 앞 단계가 걸리면 광학 진단을 유보한다. */
      const st = calibMetricsStale(c);
      const q = c.beam && c.beam.integrity;
      const gamOn = isFinite(c.displayGamma) && c.displayGamma > 1;
      const fileBad = [];
      if (q && q.blocking && q.blocking.blocked) fileBad.push("블록 압축(JPEG 계열)");
      if (q && q.upscale && q.upscale.ok && q.upscale.upscaled) fileBad.push(`화면 확대 ≈${fmt(q.upscale.L, 3)}×`);
      if (q && q.linearity && q.linearity.ok && q.linearity.verdict === "nonlinear" && !gamOn) fileBad.push("톤커브 미보정");
      const nominal = !(isFinite(c.umPerPxMeasured) && c.umPerPxMeasured > 0);
      let msg;
      if (r < 0.95) msg = "측정값이 회절 한계보다 작습니다 — 배율·픽셀 피치·NA 입력을 확인하세요(파워밀도가 과대평가됩니다)";
      else if (r < 1.5) msg = "회절 한계에 근접 — 정상적으로 집속됨";
      else if (st) msg = `이 수치는 <b>지금 설정과 다른 조건</b>에서 계산된 값입니다 (${esc(st.why)}) — 이미지를 다시 피팅한 뒤 판단하세요`;
      else if (fileBad.length) msg = `광학계를 의심하기 전에 <b>파일 문제부터</b>: ${fileBad.join(" · ")} — 이 배수는 광학계가 아니라 파일 탓일 수 있습니다`;
      else if (nominal) msg = (r < 5 ? "회절 한계의 수 배" : "회절 한계보다 훨씬 큼") +
        " — 다만 µm/px 가 <b>공칭값(피치÷배율)</b> 입니다. 경통렌즈·중간배율·배율 공차를 반영하지 않으므로, 눈금 타깃으로 실측하기 전에는 이 배수를 광학 진단의 근거로 쓰지 마세요";
      else msg = r < 5 ? "회절 한계의 수 배 — 언더필·디포커스·수차 순으로 확인 (dichroic 반사파면 포함)"
        : "회절 한계보다 훨씬 큼 — 의도적 확장빔이 아니라면 정렬·초점을 확인하세요";
      const prov = [];
      prov.push(`µm/px ${fmt(calibEffUmPerPx(), 4)} <span class="muted">(${nominal ? "공칭" : "실측"})</span>`);
      if (gamOn) prov.push(`γ=${fmt(c.displayGamma, 3)} 되돌림`);
      /* v3.16 — clean:true 만으로는 "검사를 통과함"과 "검사가 적용되지 않음"이 같아 보인다.
       * verified 로 무엇이 실제로 확인됐는지 구분해 표시한다. */
      if (q && q.clean) {
        const v = q.verified || {};
        const unver = [];
        if (v.linearity === false) unver.push("선형성");
        if (v.upscale === false) unver.push("업스케일");
        prov.push(unver.length
          ? `<span class="tag-High">무결성 OK</span><span class="muted" title="${esc(unver.join("·"))} 검사는 이 영상에 적용되지 않았습니다 — 통과한 것이 아니라 잴 수 없었다는 뜻입니다">(${esc(unver.join("·"))} 미검증)</span>`
          : `<span class="tag-High">무결성 OK</span>`);
      }
      diag += ` · 측정 ${fmt(meas, 3)} µm <b class="${cls}">(×${fmt(r, 3)})</b> — <span class="${cls}">${msg}</span>` +
        `<br><span class="muted">근거: ${prov.join(" · ")}</span>`;
    }
  }
  return `선택: <b>${esc(o.maker || "")} ${esc(o.model || "")}</b> ${fmt(o.mag, 4)}×` +
    (bits.length ? " · " + bits.join(" · ") : "") + diag;
}
/** v3.10 — 업로드 이미지 무결성 요약 (업스케일 / 톤커브).
 *  이 검사는 "빔이 이상한가"가 아니라 "이 파일을 물리량으로 쓸 수 있는가"를 묻는다.
 *  · 업스케일: 화면 캡쳐는 표시 배율 L 만큼 보간되어 µm/px 가 L 배 틀리고 면적은 L² 배 틀린다.
 *  · 톤커브: 감마/auto-contrast 가 씌워지면 픽셀값이 ADU 에 비례하지 않으므로 FWHM·D4σ·
 *    enclosed power 가 모두 무의미해진다 — 이건 나중에 나눠서 고칠 수 있는 오차가 아니다.
 *  배수를 µm/px 보정에 쓰라고 권고하는 것은 **선형성이 확인된 경우로 한정**한다
 *  (비선형 영상에서는 리샘플 커널과 톤커브가 얽혀 L 이 최대 ~35% 과대평가되기 때문). */
/** v3.12 — 보고값이 나온 **그 자리**를 돌려준다.
 *  이전에는 paSource 와 무관하게 언제나 모델의 sMaxAtP 에 별을 찍었다. 그런데
 *  sMaxAtP 는 모델의 *숨은 신호 성분* 기울기의 argmax 이고, 암구간에서 그 기울기는
 *  상수(k1)라서 argmax 가 **맨 왼쪽 점**을 집는다. 결과적으로 "최대 PA 위치" 가
 *  베이스라인 시작점에 찍혔다(WJ-0075c). 보고 경로마다 자기 위치를 쓰게 한다. */
function paMarkerX(a) {
  // v3.12 — 중재 결과(paSelect)가 유일한 출처. 차트가 카드와 다른 것을 가리킬 수 없다.
  if (a.paSelect && isFinite(a.paSelect.location)) return a.paSelect.location;
  if (a.paSource === "jump" && a.paJump && isFinite(a.paJump.pth)) return a.paJump.pth;   // 구버전 결과 호환
  if (a.paSource === "lower-bound" && a.sLowerBound && isFinite(a.sLowerBound.pLo) && isFinite(a.sLowerBound.pHi))
    return Math.sqrt(a.sLowerBound.pLo * a.sLowerBound.pHi);
  if (a.paSource === "local-fit" && a.localFit && isFinite(a.localFit.sMaxAtP)) return a.localFit.sMaxAtP;
  return a.sMaxAtP;
}
/** 모델 접선을 그려도 되는가 — 그 자리에서 모델 신호가 검출 한계 위인가. */
function paTangentDrawable(a) {
  if (a.paSelect && a.paSelect.locationObservable === false) return false;
  return !(a.sMaxObservable && a.sMaxObservable.observable === false);
}
/** v3.12 — 중재에서 기각된 추정기와 그 사유. 26배로 흩어진 숫자들을 숨기지 않고
 *  "왜 이것이 헤드라인이 아닌가" 를 그대로 보여준다. */
function paSelectHtml(a) {
  const S = a.paSelect;
  if (!S) return "";
  const rows = (S.rejected || []).slice().sort((u, v) => (v.value || 0) - (u.value || 0))
    .map((q) => `<tr><td>${esc(q.name)}</td><td class="num">${isFinite(q.value) ? fmt(q.value, 4) : "—"}</td><td>${esc(q.why || "")}</td></tr>`).join("");
  const notes = (S.notes || []).map((n) => `<div class="s" style="color:var(--s7)">⚠ ${esc(n)}</div>`).join("");
  const AS = S.anchorSensitivity;
  const sens = (AS && AS.blinking && isFinite(AS.slopeAtMin) && isFinite(AS.slopeAtMax))
    ? `<div class="s" style="color:var(--s7)">점멸 앵커 민감도 — 반복 [${AS.reps.join(", ")}] (CV ${fmt(100 * AS.cv, 3)}%):`
      + ` 최솟값 ${fmt(AS.slopeAtMin, 4)} · 평균 <b>${fmt(AS.slopeAtMean, 4)}</b> · 최댓값 ${fmt(AS.slopeAtMax, 4)}`
      + ` <span class="muted">— 이 폭이 보고값의 실질 불확실도입니다</span></div>` : "";
  return `<div class="s" style="margin-top:6px">PA 중재: <b>${fmt(S.value, 4)}</b>`
    + ` <span class="muted">(${S.kind === "bound" ? "하한" : S.kind === "point" ? "점추정" : "없음"} · 출처 ${esc(S.source || "-")}`
    + ` · 위치 P=${fmt(S.location, 4)} ${esc(S.locationKind || "")})</span></div>`
    + notes + sens
    + (rows ? `<table class="mini" style="margin-top:4px"><thead><tr><th>기각된 추정기</th><th class="num">값</th><th>사유</th></tr></thead><tbody>${rows}</tbody></table>` : "");
}
function integrityHtml(q, imgW) {
  if (!q) return "";
  if (q.error) return ` · <span class="tag-Low">무결성 검사 실패: ${esc(q.error)}</span>`;
  const bits = [];
  const up = q.upscale, lin = q.linearity;
  if (up && up.ok && up.upscaled) {
    const nom = calibNominalUmPerPx();
    const sug = (q.scaleSuggestion && isFinite(nom)) ? nom / q.scaleSuggestion.divideUmPerPxBy : NaN;
    bits.push(`<span class="tag-Poor">⚠ 원본이 아님 — 화면 배율 ≈ ${fmt(up.L, 3)}× (가로 ${fmt(up.Lx, 3)} · 세로 ${fmt(up.Ly, 3)})</span>` +
      `<span class="muted"> 배경 잡음의 상관길이로 측정 — 스케일바와 무관하게 결정됨</span>` +
      (isFinite(sug)
        ? ` · <b>실측 µm/px 에 ${fmt(sug, 4)} 입력 권장</b><span class="muted"> (공칭 ${fmt(nom, 4)} ÷ ${q.scaleSuggestion.divideUmPerPxBy}, 면적 ÷${q.scaleSuggestion.areaFactor})</span>`
        : ` · <span class="muted">선형성이 확인되지 않아 배수를 µm/px 보정에 쓰지 않는다 — 원본 재촬영 권장</span>`));
  } else if (up && up.ok) {
    bits.push(`<span class="tag-High">원본 1:1 (상관길이 ${fmt(up.L, 3)})</span>`);
  } else if (up) {
    bits.push(`<span class="tag-Low">업스케일 판정 불가: ${esc(up.reason || "")}</span>`);
  }
  if (lin && lin.ok && lin.verdict === "nonlinear") {
    const g = isFinite(lin.beta) ? 2 - lin.beta : NaN;
    const gSug = isFinite(lin.beta) ? 2 - lin.beta : NaN;
    bits.push(`<span class="tag-Poor">⚠ 톤커브 검출 — 픽셀값이 ADU 에 비례하지 않음</span>` +
      (isFinite(gSug) && gSug > 1.2 && (!App.calib || !(App.calib.displayGamma > 1))
        ? ` · <b>"표시 감마 보정 γ" 에 ${fmt(Math.round(gSug * 20) / 20, 3)} 시도 권장</b>` : "") +
      `<span class="muted"> 분산이 밝기에 따라 감소 (기울기 ${lin.b.toExponential(2)} ± ${lin.seB.toExponential(1)})` +
      (isFinite(g) && g > 1 ? `, 감마 ≈ ${fmt(g, 3)} 에 해당` : "") +
      ` — 선형 검출기로는 불가능. FWHM·D4σ·enclosed power 가 모두 편향됨</span>`);
  } else if (lin && lin.ok && lin.verdict === "linear") {
    bits.push(`<span class="tag-High">선형성 정합 (Var ∝ 신호, R²=${fmt(lin.r2, 3)})</span>` +
      `<span class="muted"> — γ ≲ 1.6 의 완만한 톤커브는 이 검사로 배제되지 않는다</span>`);
  } else if (lin && lin.applicable === false) {
    /* v3.16 — **적용 불가**와 **판정 보류**는 다른 말이다.
     * 적용 불가는 "이 영상으로는 잴 수 없다"이지 "수상하다"가 아니다. 같은 문구로
     * 쓰면 정상 파일에서도 경고가 떠서 진짜 경고가 묻힌다. */
    const why = lin.ok ? lin.indeterminateWhy : lin.reason;
    bits.push(`<span class="muted">선형성 검사 적용 안 됨</span><span class="muted"> — ${esc(why || "")}.` +
      ` 톤커브가 있다는 뜻도, 없다는 뜻도 아니다 — 확인하려면 빔을 일부러 디포커스해 넓게 편 프레임을 한 번 찍으면 된다</span>`);
  } else {
    const why = lin && lin.ok ? lin.indeterminateWhy : (lin ? lin.reason : "");
    bits.push(`<span class="tag-Low">선형성 판정 보류</span><span class="muted"> ${esc(why || "")}` +
      ` — 확인하려면 빔을 일부러 디포커스해 넓게 편 프레임을 한 번 찍으면 된다</span>`);
  }
  if (q.action) bits.push(`<b>${esc(q.action)}</b>`);
  return `<br><span class="muted">─ 업로드 무결성 ─</span> ` + bits.join(" · ");
}
function beamBasisCompareHtml(c) {
  const b = c.beam;
  if (!b || !b.moments) return "";
  const m = b.moments;
  const eff = calibEffUmPerPx();
  const s = isFinite(eff) ? eff * (b.binFactor || 1) : NaN;
  const um = (v) => isFinite(s) ? `${fmt(v * s, 4)} µm` : `${fmt(v, 4)} px`;
  const ratio = b.d4sAreaRatio;
  const naive = m.naiveAreaRatio;
  const bits = [];
  bits.push(`<span class="muted">─ 폭 정의 비교 ─</span>`);
  bits.push(`Gaussian 1/e² 지름: ${um(4 * b.sx)} × ${um(4 * b.sy)} (θ=${fmt(b.theta * 180 / Math.PI, 3)}°)` +
    ` · ISO D4σ: ${um(m.d4sMajor)} × ${um(m.d4sMinor)} (θ=${fmt(m.theta * 180 / Math.PI, 3)}°)`);
  if (isFinite(ratio)) {
    // 어느 기준이 참값에 가까운가는 **면적비가 정한다**. 합성 빔(가우시안 코어 + 넓은
    // 받침, 받침 비율 0~40%, 8시드)에서 peak irradiance 환산면적의 참값 대조:
    //   비 1.00 → Gaussian −0.1% / D4σ −0.6%      (동등)
    //   비 1.11 → Gaussian −9.4% / D4σ +1.0%      (D4σ 우세)
    //   비 1.28 → Gaussian −13.8% / D4σ +10.8%    (D4σ 우세, 경계)
    //   비 1.40 → Gaussian −15.2% / D4σ +19.0%    (역전)
    //   비 1.89 → Gaussian −18.2% / D4σ +54.8%    (Gaussian 우세)
    //   비 2.92 → Gaussian −20.9% / D4σ +131%     (D4σ 발산)
    // 2차 모멘트는 r² 가중이라 희미하고 넓은 받침이 지배한다 — 받침이 커질수록 D4σ 가
    // 급격히 무너진다. 교차점은 비 ≈ 1.35. 이 수치들이 아래 문턱의 근거다.
    const cls = ratio > 2 ? "tag-Poor" : ratio > 1.35 ? "tag-Low" : Math.abs(ratio - 1) > 0.07 ? "tag-Low" : "tag-High";
    const msg = ratio > 2
      ? "빔이 Gaussian에서 크게 벗어남 — <b>두 기준 모두 파워밀도를 신뢰할 수 없습니다</b>. " +
        "환산식(A=2πσxσy)이 Gaussian 항등식이라 비-Gaussian 빔에서는 어느 쪽도 참 peak irradiance 가 아닙니다. " +
        "정렬·초점을 먼저 확인하세요 (그래도 써야 한다면 이 구간에서는 Gaussian 피팅 쪽이 덜 틀립니다)"
      : ratio > 1.35
      ? "받침/날개가 뚜렷함 — <b>이 구간부터는 Gaussian 피팅이 더 정확합니다</b> (참값 대조 교차점 ≈ 1.35). " +
        "2차 모멘트는 r² 가중이라 넓은 받침에 끌려갑니다"
      : Math.abs(ratio - 1) > 0.07
      ? "약한 비-Gaussian성 — 이 구간에서는 <b>ISO D4σ(기본)가 더 정확합니다</b> (비 1.11 에서 D4σ +1% vs Gaussian −9%)"
      : "Gaussian와 잘 일치 (두 기준 등가 — 기본 D4σ 유지 권장)";
    bits.push(`면적비 D4σ/Gaussian = <b class="${cls}">${fmt(ratio, 4)}</b> — <span class="${cls}">${msg}</span>`);
  }
  // v3.9 — curve of growth: core 밖 빛의 양. 파워밀도 식은 P 전부가 core 에 든다고
  // 가정하므로, 이 비가 1 보다 크면 그만큼 **과대평가**된다.
  if (isFinite(b.enclosedRatio) && Array.isArray(b.growth) && b.growth.length) {
    const er = b.enclosedRatio;
    const cls2 = er > 2 ? "tag-Poor" : er > 1.3 ? "tag-Low" : "tag-High";
    const g = b.growth.map((q) => `${q.kSigma}σ:${fmt(q.ratio, 3)}`).join(" · ");
    /* v3.17.1 — enclosedRatio 는 **적합 상대량**이다: 조리개 반경이 적합된 σ 에 비례하고
     * (R = kσ·√(σx σy)), 분모인 core flux 도 적합된 A·σx·σy 다. 즉 분자와 분모가 **둘 다**
     * 적합에 따라 움직인다. 같은 빔이라도 감마 되돌리기 하나로 σ 가 바뀌면 이 값이 바뀌고,
     * 그 변화의 방향은 빔마다 다르다(실측: 한 빔은 3.074→3.588 로 늘었다).
     * 따라서 **두 세션의 enclosedRatio 를 직접 비교하면 안 된다.** 비교하려면 내보내기의
     * growth[].rUm 을 써서 같은 물리 반경에서 읽어야 한다. */
    bits.push(`<span class="muted">─ curve of growth (core 밖 빛) ─</span>`);
    bits.push(`포함 플럭스 / core 플럭스 = <b class="${cls2}">${fmt(er, 3)}</b> (반경 ${fmt(b.growthRadiusSigma, 2)}σ)`
      + ` <span class="muted">· 성장곡선 ${g}</span>`);
    if (er > 1.3) {
      bits.push(`<span class="${cls2}">core 밖에 빛이 있습니다 — 파워밀도 식 I₀ = P/A_peak 는 <b>측정한 P 전부가 core 에 든다</b>고 가정합니다.`
        + ` 이 halo 가 <b>시료면의 실제 빛</b>이라면 peak irradiance 는 약 <b>${fmt(100 / er, 3)}%</b> (÷${fmt(er, 3)}) 로 낮춰 읽어야 합니다.`
        + `<br><span class="muted">이 값은 <b>이 적합에 상대적</b>입니다 — 조리개 반경이 적합 σ 에 비례하므로`
        + ` 감마·비닝이 달라진 다른 세션의 값과 직접 비교하면 안 됩니다. 비교하려면 내보내기의`
        + ` <span class="mono">growth[].rUm</span> 으로 같은 물리 반경에서 읽으십시오.</span>`
        + ` 결상경로에서 생긴 산란/글레어라면 시료면에는 없으므로 보정하면 안 됩니다 —`
        + ` <b>레이저 차단 프레임</b>과 <b>노출시간 스케일링</b>으로 둘을 가릴 수 있습니다.</span>`);
      bits.push(`<span class="muted">이 추정은 바깥 annulus 가 halo 에 오염되어 halo 를 <b>과소</b>평가합니다`
        + ` (합성 검증: 참 대비 −15~−40%). 즉 실제 보정폭은 이보다 클 수 있습니다.</span>`);
    }
  }
  if (isFinite(naive)) {
    bits.push(`<span style="color:var(--s4)">회전 보정 효과</span>: 회전을 무시한 카메라축 D4σ` +
      ` (${um(4 * m.sigmaXlab)} × ${um(4 * m.sigmaYlab)}) 사용 시 유효면적 <b>+${fmt(100 * (naive - 1), 3)}%</b> 과대평가` +
      ` → 파워밀도 ${fmt(100 * (1 - 1 / naive), 3)}% 과소평가 (현재는 주축 보정 적용됨)`);
  }
  const warn = [];
  if (!m.converged) warn.push("모멘트 조리개 미수렴");
  if (m.apertureClipped) warn.push("조리개가 이미지 경계에 잘림");
  if (m.maskedFraction > 0.02) warn.push(`조리개 내 마스크 픽셀 ${fmt(100 * m.maskedFraction, 3)}% (주석/반사광 제거 영역 — D4σ 신뢰도 저하)`);
  if (warn.length) bits.push(`<span class="tag-Low">⚠ ${warn.join(" · ")}</span>`);
  return bits.join("<br>");
}

/** 선택된 면적 기준의 σ/θ (px) — Gaussian 피팅 또는 ISO 11146 회전 D4σ 모멘트.
 *  두 기준 모두 회전을 반영한 주축 σ를 쓰므로 면적이 과대평가되지 않는다. */
const BASIS_CROSSOVER = 1.35;   // v3.6.2 에서 참값 대조로 잰 교차점
function calibBasisSigma(beam) {
  const b = beam || App.calib.beam;
  if (!b) return null;
  const hasM = !!(b.moments && isFinite(b.moments.sigmaMajor));
  const ratio = b.d4sAreaRatio;
  // v3.9 — "auto": **측정된 교차점**으로 고른다.
  // v3.6.2 참값 대조: 면적비 ≤1.35 에서는 D4σ 가 정확하고(비 1.11 에서 D4σ +1% vs
  // Gaussian −9%), 그 위에서는 역전되어 비 2.92 에서 D4σ 가 +131% 로 발산한다.
  // 실측 빔에서 면적비 17.78 이 나온 사례가 있었고, 그때 d4sigma 고정이면 유효면적이
  // 17.78배 커져 파워밀도가 그만큼 과소평가된다 — 조용히 그러면 안 된다.
  let basis = App.calib.areaBasis || "auto";
  let autoPicked = null;
  if (basis === "auto") {
    autoPicked = (hasM && isFinite(ratio) && ratio <= BASIS_CROSSOVER) ? "d4sigma" : "gauss";
    basis = autoPicked;
  }
  if (basis === "d4sigma" && hasM) {
    return { sx: b.moments.sigmaMajor, sy: b.moments.sigmaMinor, theta: b.moments.theta,
             src: "d4sigma", autoPicked, ratio };
  }
  return { sx: b.sx, sy: b.sy, theta: b.theta, src: "gauss", autoPicked, ratio };
}
/** 현재 기준으로 beamMetrics 재계산 (µm 스케일 = 유효 px × 비닝) */
function calibComputeMetrics() {
  const c = App.calib;
  const eff = calibEffUmPerPx();
  const bs = calibBasisSigma();
  if (!c.beam || !bs || !isFinite(eff)) return null;
  /* v3.11.1 — 계산 조건을 도장으로 남긴다. 저장된 metrics 가 지금 설정과 다른
   * 조건(옛 µm/px, 감마 미보정 등)에서 나온 것인데도 회절한계 경고가 계속 뜨는
   * 일이 실제로 있었다. 값만 저장하면 그게 언제·무슨 전제로 나온 값인지 알 수 없다. */
  c.metricsStamp = {
    umPerPx: eff, umPerPxSource: (isFinite(c.umPerPxMeasured) && c.umPerPxMeasured > 0) ? "measured" : "nominal",
    displayGamma: (isFinite(c.displayGamma) && c.displayGamma > 1) ? c.displayGamma : 1,
    basis: (bs.src || null), binFactor: c.beam.binFactor || 1, at: Date.now(),
  };
  return PrismEngine.beamMetrics(bs, eff * (c.beam.binFactor || 1));
}
/** 저장된 metrics 가 **지금 설정과 같은 조건**에서 계산된 것인가. */
function calibMetricsStale(c) {
  const st = c.metricsStamp;
  if (!c.metrics) return null;
  if (!st) return { why: "계산 조건이 기록되지 않은 옛 세션" };
  const eff = calibEffUmPerPx();
  const gam = (isFinite(c.displayGamma) && c.displayGamma > 1) ? c.displayGamma : 1;
  const bs = calibBasisSigma();
  const diffs = [];
  if (isFinite(eff) && isFinite(st.umPerPx) && Math.abs(eff - st.umPerPx) / st.umPerPx > 1e-6)
    diffs.push(`µm/px ${fmt(st.umPerPx, 4)} → ${fmt(eff, 4)}`);
  if (gam !== st.displayGamma) diffs.push(`감마 ${st.displayGamma} → ${gam}`);
  if (bs && st.basis && bs.src !== st.basis) diffs.push(`면적 기준 ${st.basis} → ${bs.src}`);
  /* v3.15 — 비닝 배수는 stamp 에는 있었으나 비교에서 빠져 있었다. A_peak 는 µm 스케일에
   * 비닝 배수가 곱해져 들어가므로, 같은 파일을 다시 피팅해 f 가 바뀌면 저장된 metrics 는
   * 더 이상 지금 조건의 값이 아니다. 이걸 비교하지 않으면 옛 면적이 조용히 남는다. */
  const bf = (c.beam && c.beam.binFactor) || 1;
  if (isFinite(st.binFactor) && bf !== st.binFactor) diffs.push(`비닝 ${st.binFactor}× → ${bf}×`);
  return diffs.length ? { why: diffs.join(" · ") } : null;
}
/* ---------------- v3.13 · dichroic ↔ 측정 채널 가드 -----------------------
 * 파워밀도는 A_peak 로 나눈 값이므로, 빔 면적이 틀리면 결과 전체가 그 비율만큼
 * 조용히 틀린다. 그리고 그 "틀림"은 그래프 어디에도 나타나지 않는다 — 모양은
 * 그대로이고 축 숫자만 바뀌기 때문이다. 유일하게 남는 방어선은 **보정의 출처를
 * 기록해 두고 측정 파일과 대조하는 것**이다.
 * 파일명에서 채널을 읽어내되, 확신할 수 없으면(후보 0개 또는 2개 이상) 판정을
 * 보류한다 — 틀린 경고는 진짜 경고를 무시하게 만들기 때문에 침묵보다 나쁘다. */
const CALIB_CHANNELS = [
  { key: "Blue", label: "Blue", re: /(?:^|[_\-\s])blue(?:$|[_\-\s.])/i },
  { key: "NIR", label: "NIR", re: /(?:^|[_\-\s])nir(?:$|[_\-\s.])/i },
  { key: "UV", label: "UV", re: /(?:^|[_\-\s])uv(?:$|[_\-\s.])/i },
  { key: "VIS", label: "VIS/Green", re: /(?:^|[_\-\s])(?:vis|green)(?:$|[_\-\s.])/i },
];
function channelLabel(key) {
  const ch = CALIB_CHANNELS.find((q) => q.key === key);
  return ch ? ch.label : (key || "");
}
/** 파일명에서 측정 채널을 판정. 확신할 수 없으면 null. */
function detectFileChannel(name) {
  if (!name) return null;
  const hits = CALIB_CHANNELS.filter((ch) => ch.re.test(String(name)));
  return hits.length === 1 ? hits[0].key : null;
}
/** 지금 적용 중인 빔 보정이 이 파일의 채널과 맞는가.
 *  state: "match" | "mismatch" | "unset"(보정에 채널 미기록) | "unknown"(파일명 판정 불가) */
function calibChannelCheck(rec) {
  const beamCh = App.calib.beamChannel || null;
  const fileCh = detectFileChannel(rec && rec.name);
  let state;
  if (!beamCh) state = "unset";
  else if (!fileCh) state = "unknown";
  else state = beamCh === fileCh ? "match" : "mismatch";
  return { state, beamCh, fileCh, dichroic: App.calib.dichroic || "" };
}
/** 파워 스캔 화면 상단 배너. 경고할 것이 없으면 "" 를 돌려준다. */
/* ---------------- v3.16 · 촬영 감마 ↔ 되돌리기 감마 정합 -------------------
 * 260921 노출 선형성 실측으로 **앵커 두 개만** 확정됐다:
 *     ProgRes γ 0.33 → 선형        (되돌릴 것 없음 · displayGamma = 1)
 *     ProgRes γ 0.50 → γ 2.01–2.06 (displayGamma ≈ 2.0)
 * 그 사이나 바깥은 측정되지 않았으므로 **외삽하지 않는다** — 값을 제안하는 대신
 * "이 값은 측정된 앵커가 아니다"라고만 말한다. 지어낸 감마로 되돌리면 폭·면적이
 * 조용히 틀어지고, 그 틀어짐은 그래프 어디에도 나타나지 않는다.
 * 반환: null 또는 {level:"bad"|"warn"|"ok", msg} */
const CAPTURE_GAMMA_ANCHORS = [
  { cap: 0.33, display: 1, label: "선형 (되돌릴 것 없음)" },
  { cap: 0.50, display: 2.0, label: "γ ≈ 2.0 (실측 2.01–2.06)" },
];
function captureGammaCheck(c) {
  const cap = Number(c.captureGamma);
  if (!isFinite(cap) || cap <= 0) return null;
  const disp = (isFinite(c.displayGamma) && c.displayGamma > 1) ? c.displayGamma : 1;
  const anchor = CAPTURE_GAMMA_ANCHORS.find((a) => Math.abs(a.cap - cap) < 0.005);
  if (!anchor) {
    return { level: "warn", msg:
      `슬라이더 ${fmt(cap, 3)} 은 <b>실측된 앵커가 아닙니다</b> (확정된 값은 0.33 → 선형, 0.50 → γ 2.0 둘뿐). ` +
      `되돌리기 값을 여기서 추정하지 않습니다 — 외삽하면 폭·면적이 조용히 틀어집니다. ` +
      `이 조건으로 노출 선형성을 먼저 재거나, 0.33 으로 다시 촬영하십시오.` };
  }
  if (Math.abs(disp - anchor.display) < 0.05)
    return { level: "ok", msg: `슬라이더 ${fmt(cap, 3)} ↔ 되돌리기 γ ${fmt(disp, 3)} — 실측 앵커와 일치 (${esc(anchor.label)})` };
  return { level: "bad", msg:
    `슬라이더 ${fmt(cap, 3)} 이면 되돌리기 γ 는 <b>${fmt(anchor.display, 3)}</b> 이어야 하는데 지금 <b>${fmt(disp, 3)}</b> 입니다 ` +
    `(${esc(anchor.label)}). 이대로 두면 빔 폭·면적이 그만큼 틀어집니다.` };
}
function captureGammaHtml(c) {
  const q = captureGammaCheck(c);
  if (!q) return "";
  const cls = q.level === "bad" ? "tag-Poor" : q.level === "warn" ? "tag-Low" : "tag-High";
  const tag = q.level === "bad" ? "불일치" : q.level === "warn" ? "미측정 조건" : "정합";
  return `<div class="small" style="margin-top:6px;"><span class="${cls}">촬영 감마 ${tag}</span> ${q.msg}</div>`;
}
function calibChannelBannerHtml(rec) {
  if (!densityActive()) return "";           // 파워밀도를 안 쓰면 면적이 결과에 안 들어간다
  const q = calibChannelCheck(rec);
  const src = q.dichroic ? `${esc(q.dichroic)}` : "(dichroic 미기록)";
  if (q.state === "mismatch") {
    return `<div class="panel" style="border:2px solid var(--bad,#c0392b);background:rgba(192,57,43,0.08);">
      <b class="tag-Poor">채널 불일치 — 파워밀도를 그대로 쓰지 마세요</b>
      <div class="small" style="margin-top:4px;">
        지금 적용된 빔 보정은 <b>${esc(channelLabel(q.beamCh))}</b> 채널 빔 <span class="muted">[${src}]</span> 인데,
        이 파일은 <b>${esc(channelLabel(q.fileCh))}</b> 채널로 보입니다
        <span class="muted">(${esc(rec && rec.name ? rec.name : "")})</span>.<br>
        dichroic 이 다르면 시료 위 빔 자체가 다르므로 A<sub>peak</sub> 도 다릅니다 —
        보고값이 <b>면적비만큼</b> 틀립니다. 해당 채널로 찍은 빔 이미지로 다시 보정하세요.
      </div></div>`;
  }
  if (q.state === "unset") {
    const guess = q.fileCh ? ` 파일명은 <b>${esc(channelLabel(q.fileCh))}</b> 채널로 보입니다.` : "";
    return `<div class="panel" style="border:1px solid var(--warn,#b7791f);background:rgba(183,121,31,0.07);">
      <b class="tag-Low">빔 보정에 dichroic·채널 기록이 없습니다</b>
      <div class="small muted" style="margin-top:4px;">
        지금 파워밀도는 마지막으로 피팅한 빔 이미지의 면적을 씁니다 — 그 빔이 어느 채널 것인지 앱은 알 수 없습니다.${guess}
        보정 모달에서 기록해 두면 다음부터 이 대조를 자동으로 합니다.
      </div></div>`;
  }
  return "";
}
function densityFactor() {
  if (!App.calib.enabled) return NaN;
  const { C } = calibCoefficient();
  const m = activeCalibMetrics();
  const frac = m ? m.powerFraction[App.calib.densityMode] : 1;
  const A = calibAreaCm2();
  if (!isFinite(C) || !isFinite(A) || A <= 0) return NaN;
  return C * frac * 1000 / A;
}
function densityActive() { return isFinite(densityFactor()); }
/* 파워밀도 자동 단위: X축 전체 범위(최대 밀도)를 보고 mW/cm² ~ MW/cm² 중
 * "최댓값이 1 이상이 되는 가장 큰 단위"를 선택 (축·결과·요약 모두 일관 적용) */
const DENSITY_UNITS = [
  { name: "mW/cm²", div: 1 },
  { name: "W/cm²", div: 1e3 },
  { name: "kW/cm²", div: 1e6 },
  { name: "MW/cm²", div: 1e9 },
];
function densityUnitFor(maxMw) {
  let u = DENSITY_UNITS[0];
  if (!isFinite(maxMw)) return u;
  for (const c of DENSITY_UNITS) if (maxMw / c.div >= 1) u = c;
  return u;
}
/** 현재 활성 파일의 전체 파워 범위 기준 자동 단위 */
function activeDensityUnit() {
  const kd = densityFactor();
  if (!isFinite(kd)) return DENSITY_UNITS[0];
  let pmax = NaN;
  const rec = App.files.find((f) => f.id === App.activeId);
  if (rec) {
    const a = rec.cache[analysisKey()];
    if (a && a.data && a.data.P && a.data.P.length) {
      pmax = a.data.P.reduce((m, v) => (isFinite(v) && v > m ? v : m), -Infinity);
    } else {
      // 분석 전이면 로드된 원시 파워에서
      for (const key of Object.keys(rec.cache)) {
        if (!key.startsWith("loaded")) continue;
        const xs = rec.cache[key] && rec.cache[key].xRawAvg;
        if (xs && xs.length) pmax = xs.reduce((m, v) => (isFinite(v) && v > m ? v : m), isFinite(pmax) ? pmax : -Infinity);
      }
    }
  }
  return densityUnitFor(pmax * kd);
}
function xConv() { return App.settings.xUnit === "density" && densityActive() ? densityFactor() / activeDensityUnit().div : 1; }
function xUnitLabel() { return App.settings.xUnit === "density" && densityActive() ? `Power density (${activeDensityUnit().name})` : "Power (W)"; }
/** 값 자체에 맞춰 단위를 고르는 단품 포맷터 (모달 예시 등) */
function fmtDensityAuto(mwVal, digits = 4) {
  const u = densityUnitFor(Math.abs(mwVal));
  return `${fmt(mwVal / u.div, digits)} ${u.name}`;
}
/* ------------------- 공용 렌즈 목록 동기화 (Firebase RTDB) -------------------
 * 연구실 여러 PC/브라우저가 같은 대물렌즈 목록을 공유하기 위한 계층.
 *
 * 설계 원칙
 *  · SDK를 번들하지 않고 **REST + SSE(EventSource)** 만 사용한다. 앱의 오프라인
 *    단일 HTML 원칙을 지키면서(용량 증가 0) 진짜 실시간 push를 받는다.
 *  · localStorage 사본을 항상 유지한다 → 서버/네트워크가 없어도 목록이 보이고,
 *    origin가 달라져도(파일 vs GitHub Pages) 최소한 그 브라우저에서는 남는다.
 *  · 오프라인에서 추가한 항목은 pending로 표시하고 연결 시 자동 재전송한다.
 *  · 공유되는 것은 렌즈 제조사/모델/배율뿐이며, 측정 데이터는 전송하지 않는다.
 */
let refreshLensUI = null;   // 보정 모달이 열려 있을 때만 설정됨
const LensSync = {
  es: null, state: "off", err: "", server: null, retry: 0, timer: null,
  // 이 PC에서 삭제한 키. 서버가 삭제를 확인할 때까지 병합에서 제외한다.
  // (없으면: 삭제 직후 도착한 서버 이벤트가 항목을 'pending'으로 되살리고
  //  재전송까지 해서 삭제가 영구히 취소된다.)
  tomb: new Set(),
  gen: 0,   // 연결 세대 — 재설정 시 이전 시도의 늦은 응답이 새 상태를 덮지 않도록
};
/** 빌드 내장값(모두 같은 빌드를 쓰면 자동 연결) 또는 앱에서 입력한 값 */
function lensDbUrl() {
  const own = App.calib.lensDbUrl;
  // "" = 사용자가 이 PC에서 공유를 명시적으로 해제 (빌드 내장 URL도 무시)
  // null/undefined = 빌드 내장값 사용
  if (own === "") return null;
  const u = (own || (typeof PRISM_FIREBASE_URL !== "undefined" ? PRISM_FIREBASE_URL : "") || "").trim();
  return u ? u.replace(/\/+$/, "") : null;
}
/** Firebase 키 제약(. # $ [ ] / 불가)에 맞춘 안정적 식별자 */
function lensKey(o) {
  // 공백까지 _ 로 치환해 URL-safe 하게 만든다. 공백이 남으면 요청 시 %20으로
  // 인코딩되어 서버가 돌려주는 키와 어긋날 여지가 생긴다.
  return `${o.maker || ""}~${o.model || ""}~${o.mag}`
    .toLowerCase().replace(/[.#$/[\]]/g, "_").replace(/\s+/g, "_").trim().slice(0, 200);
}
const LENS_MEDIA = { air: "Air", oil: "Oil", water: "Water", glycerol: "Glycerol" };
/* 무한보정 대물렌즈의 초점거리는 배럴에 잘 적히지 않는다 — 독립 값이 아니라
 * f_obj = f_경통렌즈 / 배율 로 결정되고, 경통렌즈 초점거리는 제조사마다 고정이기
 * 때문. 그래서 제조사+배율로 자동 계산하고, 비표준 광학계나 스펙에 명시된 값이
 * 있을 때만 수동 입력으로 덮어쓴다. */
const TUBE_LENS_MM = {
  olympus: 180, evident: 180, nikon: 200, zeiss: 165, "carl zeiss": 165,
  leica: 200, mitutoyo: 200, thorlabs: 200, edmund: 200, motic: 200,
};
function lensTubeMm(maker) {
  const k = String(maker || "").trim().toLowerCase();
  if (TUBE_LENS_MM[k]) return { mm: TUBE_LENS_MM[k], maker: k };
  for (const name of Object.keys(TUBE_LENS_MM)) if (k.includes(name)) return { mm: TUBE_LENS_MM[name], maker: name };
  return null;
}
/** 초점거리(mm) — 수동 기록값 우선, 없으면 제조사 경통렌즈로 계산 */
function lensFocalMm(o) {
  if (isFinite(Number(o && o.f)) && Number(o.f) > 0) return { mm: Number(o.f), derived: false };
  const t = o && lensTubeMm(o.maker);
  if (t && isFinite(Number(o.mag)) && Number(o.mag) > 0) {
    return { mm: t.mm / Number(o.mag), derived: true, tube: t.mm };
  }
  return null;
}
function lensEntry(o) {
  const e = { maker: String(o.maker || "").trim(), model: String(o.model || "").trim(), mag: Number(o.mag) };
  const med = String(o.medium || "").toLowerCase();
  if (LENS_MEDIA[med]) e.medium = med;              // 미지정 렌즈(구버전)는 필드 자체를 생략
  if (isFinite(Number(o.na)) && Number(o.na) > 0) e.na = Number(o.na);
  if (isFinite(Number(o.f)) && Number(o.f) > 0) e.f = Number(o.f);   // 수동 기록 초점거리(mm)
  // 작동거리(WD, mm) — 초점거리와 달리 유도할 수 없는 순수 기록값이다. 배럴에 적힌
  // 스펙을 그대로 넣는다. 시료·커버글라스·크라이오스탯 창 두께가 이 값을 넘으면
  // 애초에 초점이 맺히지 않으므로, 측정 전 확인용으로 목록에 함께 남긴다.
  if (isFinite(Number(o.wd)) && Number(o.wd) > 0) e.wd = Number(o.wd);
  return e;
}
/** 목록 표시용 라벨: "Olympus MPLFLN100X (100×, NA 1.30, Oil)" */
function lensLabel(o) {
  const ex = [];
  if (isFinite(Number(o.na)) && Number(o.na) > 0) ex.push(`NA ${fmt(o.na, 3)}`);
  if (LENS_MEDIA[o.medium]) ex.push(LENS_MEDIA[o.medium]);
  if (isFinite(Number(o.wd)) && Number(o.wd) > 0) ex.push(`WD ${fmt(o.wd, 3)} mm`);
  return `${o.maker || ""} ${o.model || ""} (${fmt(o.mag, 4)}×${ex.length ? ", " + ex.join(", ") : ""})`;
}
/** 표시 목록 = 서버 정본 + (이 PC에서 아직 전송하지 못한 항목).
 *  서버에 연결돼 있는데 로컬에만 있는 항목은 두 가지 의미가 있으므로 구분한다.
 *   · _pending  : 이 PC에서 추가했으나 아직 전송 못 함  → 유지하고 재전송
 *   · 그 외      : 다른 PC에서 삭제된 것                → 로컬에서도 제거
 *  구분하지 않으면 원격 삭제가 매번 되살아난다. */
function lensMerge() {
  const c = App.calib;
  const local = c.objectives || [];
  const prevSel = c.objSel >= 0 ? local[c.objSel] : null;
  let out;
  if (!LensSync.server) {
    // 서버 스냅샷 없음(미설정·연결 전·오프라인) → 마지막 로컬 목록을 그대로 유지
    out = local.map((o) => ({ ...lensEntry(o), _key: o._key || lensKey(o), _pending: o._pending }));
  } else {
    out = [];
    const seen = new Set();
    for (const k of Object.keys(LensSync.server)) {
      if (LensSync.tomb.has(k)) continue;           // 삭제 요청 중 — 표시하지 않음
      const e = LensSync.server[k];
      if (!e || !isFinite(Number(e.mag))) continue;
      out.push({ ...lensEntry(e), _key: k }); seen.add(k);
    }
    for (const o of local) {
      const k = o._key || lensKey(o);
      if (seen.has(k) || LensSync.tomb.has(k)) continue;
      if (o._pending) out.push({ ...lensEntry(o), _key: k, _pending: true });
      // _pending가 아닌데 서버에 없다 = 다른 PC에서 삭제됨 → 제거
    }
  }
  out.sort((a, b) => String(a.maker || "").localeCompare(String(b.maker || ""), "ko") || (a.mag - b.mag));
  c.objectives = out;
  c.objSel = prevSel ? out.findIndex((x) => x._key === (prevSel._key || lensKey(prevSel))) : -1;
  saveCalib();
}
function lensSyncStatus() {
  const map = { live: ["● 실시간 공유 중", "var(--good)"], connecting: ["◌ 연결 중…", "var(--text-muted)"],
    error: ["⚠ 연결 실패 — 로컬 목록 사용 중", "var(--warn)"], off: ["○ 로컬 전용 (공유 미설정)", "var(--text-muted)"] };
  return map[LensSync.state] || map.off;
}
/** 서버 이벤트(put/patch) 적용 */
function lensApply(path, data, isPatch) {
  LensSync.server = LensSync.server || {};
  if (path === "/" || path === "") {
    if (isPatch) Object.assign(LensSync.server, data || {});
    else LensSync.server = data || {};
  } else {
    const k = path.replace(/^\//, "").split("/")[0];
    if (data === null || data === undefined) delete LensSync.server[k];
    else if (isPatch) LensSync.server[k] = Object.assign(LensSync.server[k] || {}, data);
    else LensSync.server[k] = data;
  }
  // 서버 스냅샷에서 사라진 키는 삭제가 확정된 것 → tombstone 해제
  for (const k of Array.from(LensSync.tomb)) {
    if (!LensSync.server || !(k in LensSync.server)) LensSync.tomb.delete(k);
  }
  lensMerge();
  if (typeof refreshLensUI === "function") refreshLensUI();
}
/** 연결 전 REST 사전점검 — 실패 원인을 구체적으로 알려준다.
 *  (EventSource는 onerror에 사유가 실리지 않아 "왜 안 되는지"를 알 수 없다) */
async function lensPreflight(base) {
  let r;
  try {
    r = await fetch(`${base}/lenses.json`, { method: "GET", cache: "no-store" });
  } catch (e) {
    return `서버에 연결할 수 없습니다 — URL 오타이거나 네트워크/방화벽 차단일 수 있습니다 (${e.message})`;
  }
  if (r.status === 401 || r.status === 403) {
    return "권한 거부 (401) — Firebase 콘솔 → Realtime Database → 규칙에서 lenses 경로의 .read 를 true 로 게시했는지 확인하세요";
  }
  if (r.status === 404) {
    return "주소를 찾을 수 없습니다 (404) — Realtime Database URL가 맞는지, 뒤에 /lenses 나 .json 을 붙이지 않았는지 확인하세요";
  }
  if (!r.ok) return `서버 응답 ${r.status}`;
  try { await r.json(); } catch (e) { return "응답을 해석할 수 없습니다 (Realtime Database 주소가 맞는지 확인하세요)"; }
  return null;   // 정상
}

/** 실시간 스트림 연결 (자동 재시도) */
async function lensSyncStart() {
  const base = lensDbUrl();
  lensSyncStop();
  if (!base) { LensSync.state = "off"; if (typeof refreshLensUI === "function") refreshLensUI(); return; }
  const gen = ++LensSync.gen;
  LensSync.state = "connecting"; LensSync.err = "";
  if (typeof refreshLensUI === "function") refreshLensUI();
  const problem = await lensPreflight(base);
  if (gen !== LensSync.gen) return;   // 그 사이 설정이 바뀜 → 이 결과는 폐기
  if (problem) {
    LensSync.state = "error"; LensSync.err = problem;
    if (typeof refreshLensUI === "function") refreshLensUI();
    const wait = Math.min(5000 * Math.pow(2, LensSync.retry++), 60000);
    LensSync.timer = setTimeout(lensSyncStart, wait);
    return;
  }
  try {
    const es = new EventSource(`${base}/lenses.json`);
    LensSync.es = es;
    es.addEventListener("put", (ev) => {
      if (gen !== LensSync.gen) return;
      try { const m = JSON.parse(ev.data); lensApply(m.path, m.data, false); } catch (e) {}
      LensSync.state = "live"; LensSync.retry = 0;
      lensFlushPending();
      if (typeof refreshLensUI === "function") refreshLensUI();
    });
    es.addEventListener("patch", (ev) => {
      if (gen !== LensSync.gen) return;
      try { const m = JSON.parse(ev.data); lensApply(m.path, m.data, true); } catch (e) {}
    });
    es.onerror = () => {
      if (gen !== LensSync.gen) { try { es.close(); } catch (e) {} return; }
      LensSync.state = "error";
      LensSync.err = "실시간 스트림이 끊겼습니다 — 자동 재연결 중 (목록은 계속 사용 가능)";
      if (typeof refreshLensUI === "function") refreshLensUI();
      try { es.close(); } catch (e) {}
      LensSync.es = null;
      // 지수 백오프 재시도 (최대 30초)
      const wait = Math.min(2000 * Math.pow(2, LensSync.retry++), 30000);
      LensSync.timer = setTimeout(lensSyncStart, wait);
    };
  } catch (e) {
    LensSync.state = "error"; LensSync.err = String(e && e.message || e);
    if (typeof refreshLensUI === "function") refreshLensUI();
  }
}
function lensSyncStop() {
  LensSync.gen++;                     // 진행 중인 연결 시도 무효화
  if (LensSync.timer) { clearTimeout(LensSync.timer); LensSync.timer = null; }
  if (LensSync.es) { try { LensSync.es.close(); } catch (e) {} LensSync.es = null; }
}
/** 렌즈 1건 서버 등록 (실패해도 로컬에는 남고 pending로 재시도) */
async function lensPush(o) {
  const base = lensDbUrl();
  if (!base) return false;
  const k = lensKey(o);
  const r = await fetch(`${base}/lenses/${encodeURIComponent(k)}.json`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...lensEntry(o), ts: Date.now() }),
  });
  if (!r.ok) throw new Error(`서버 응답 ${r.status}`);
  return true;
}
async function lensRemove(o) {
  const base = lensDbUrl();
  if (!base) return false;
  const k = o._key || lensKey(o);
  const r = await fetch(`${base}/lenses/${encodeURIComponent(k)}.json`, { method: "DELETE" });
  if (!r.ok) throw new Error(`서버 응답 ${r.status}`);
  return true;
}
/** 연결 복구 시 미전송 항목 자동 전송 */
async function lensFlushPending() {
  const pend = (App.calib.objectives || []).filter((o) => o._pending && !LensSync.tomb.has(o._key || lensKey(o)));
  for (const o of pend) {
    try { await lensPush(o); delete o._pending; } catch (e) { break; }
  }
  if (pend.length) saveCalib();
}

/* --------------------- Ledger 보정 세션 연동 (§4 항목4 · Phase 7) ----------------
 * h5의 calib_id attr(§5, INNO Optics Phase 7 이후 파일에만 존재)로 Ledger의
 * opt_calib 문서를 Firestore REST API로 직접 조회(문서 ID 단일 get — list 아님)해
 * App.calib에 적용한다. Ledger의 opt_calib는 "정보용 요약 필드"만 갖고 있고
 * 원본 pairs/beam(빔 이미지 피팅값)은 없으므로(설계 확정본 §4 항목2 Phase 5 메모),
 * 빔 면적(A)은 여전히 이 PC에서 빔 이미지를 직접 열어야 나온다 — 이 계층이 채우는
 * 것은 계수(C)·밀도정의·면적기준·카메라피치·렌즈 선택뿐이다(부분 자동).
 * renderCalibBadge()가 무엇이 채워졌고 무엇이 남았는지 항상 명시한다. */
function ledgerCfg() {
  const c = App.calib.ledger || {};
  const apiKey = (c.apiKey || "").trim(), uid = (c.uid || "").trim();
  if (!apiKey || !uid) return null;
  return { projectId: (c.projectId || "").trim() || "inno-nanoil", apiKey, uid };
}
function fsValue(v) {
  if (!v || typeof v !== "object") return null;
  if ("stringValue" in v) return v.stringValue;
  if ("doubleValue" in v) return Number(v.doubleValue);
  if ("integerValue" in v) return Number(v.integerValue);
  if ("booleanValue" in v) return !!v.booleanValue;
  if ("mapValue" in v) return fsMapToObj((v.mapValue || {}).fields || {});
  if ("arrayValue" in v) return ((v.arrayValue || {}).values || []).map(fsValue);
  if ("timestampValue" in v) return v.timestampValue;
  return null;
}
function fsMapToObj(fields) {
  const out = {};
  for (const k of Object.keys(fields || {})) out[k] = fsValue(fields[k]);
  return out;
}
const ledgerCalibCache = new Map();   // calibId -> {doc}|{error} — 탭이 열려 있는 동안만 캐시
async function fetchLedgerCalib(calibId) {
  if (ledgerCalibCache.has(calibId)) return ledgerCalibCache.get(calibId);
  const cfg = ledgerCfg();
  if (!cfg) return null;
  const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(cfg.projectId)}` +
    `/databases/(default)/documents/users/${encodeURIComponent(cfg.uid)}/opt_calib/${encodeURIComponent(calibId)}` +
    `?key=${encodeURIComponent(cfg.apiKey)}`;
  let result;
  try {
    const r = await fetch(url, { method: "GET", cache: "no-store" });
    if (r.status === 401 || r.status === 403) {
      result = { error: "권한 거부 — Ledger의 Firestore 보안규칙에서 opt_calib 문서 단일 조회(get)를 허용해야 합니다" };
    } else if (r.status === 404) {
      result = { error: "Ledger에서 이 calib_id의 보정 세션을 찾을 수 없습니다" };
    } else if (!r.ok) {
      result = { error: `서버 응답 ${r.status}` };
    } else {
      const j = await r.json();
      result = { doc: fsMapToObj(j.fields || {}) };
    }
  } catch (e) {
    result = { error: `연결 실패 (${e.message})` };
  }
  ledgerCalibCache.set(calibId, result);
  return result;
}
/** 현재 파일의 calib_id로 보정 세션을 조회해 App.calib에 적용(가능한 필드만). 비동기·조용히 실패(기존 동작 무변경). */
async function maybeApplyLedgerSession(rec) {
  const calibId = rec && rec.meta && rec.meta.calib_id;
  const c = App.calib;
  if (!calibId) { c.session = null; c.sessionActive = false; c.sessionError = null; renderCalibBadge(); return; }
  if (c.sessionDetachedFor === calibId) { renderCalibBadge(); return; }  // 이 세션을 이 파일에서 사용자가 명시적으로 해제함
  if (c.session && c.session.calibId === calibId) {
    c.sessionActive = true; renderCalibBadge();
    if (App.activeId === rec.id) renderAll();
    return;
  }
  const cfg = ledgerCfg();
  if (!cfg) { c.session = null; c.sessionActive = false; c.sessionError = null; renderCalibBadge(); return; }
  const result = await fetchLedgerCalib(calibId);
  if (App.activeId !== rec.id) return;   // 그 사이 다른 파일로 전환됨 — 적용하지 않음
  if (!result || result.error) {
    c.session = null; c.sessionActive = false; c.sessionError = (result && result.error) || "조회 실패";
    renderCalibBadge(); return;
  }
  const d = result.doc;
  // Phase 8: Ledger의 opt_calib 문서에 Prism가 내보낸 metrics(빔 면적 µm² 절대값 — 이미 유효
  // 픽셀 스케일이 반영돼 있어 재계산 없이 그대로 쓸 수 있음, exportCalibSession() 참고)가
  // 있으면 그대로 옮긴다. 필드 하나라도 숫자가 아니면(예: 사람이 실수로 다른 JSON를 가져온
  // 경우) 통째로 무시 — 절반만 채워진 면적값으로 조용히 틀린 계산을 하는 것보다 안전하다.
  const dm = d.metrics && typeof d.metrics === "object" ? d.metrics : null;
  const metricsOk = dm && ["areaPeakUm2", "area1e2Um2", "areaFwhmUm2"].every((k) => isFinite(Number(dm[k])));
  c.session = {
    calibId, at: d.at || null, lambdaNm: isFinite(Number(d.lambdaNm)) ? Number(d.lambdaNm) : null,
    lens: d.lens || null, coefficient: isFinite(Number(d.coefficient)) ? Number(d.coefficient) : null,
    transmission: isFinite(Number(d.transmission)) ? Number(d.transmission) : null,
    cameraPitch: isFinite(Number(d.cameraPitch)) ? Number(d.cameraPitch) : null,
    areaBasis: d.areaBasis || null, densityMode: d.densityMode || null,
    pathNote: d.pathNote || null, validUntil: d.validUntil || null,
    metrics: metricsOk ? {
      umPerPx: Number(dm.umPerPx), sigmaXum: Number(dm.sigmaXum), sigmaYum: Number(dm.sigmaYum),
      thetaDeg: Number(dm.thetaDeg), d1e2Xum: Number(dm.d1e2Xum), d1e2Yum: Number(dm.d1e2Yum),
      fwhmXum: Number(dm.fwhmXum), fwhmYum: Number(dm.fwhmYum),
      areaPeakUm2: Number(dm.areaPeakUm2), area1e2Um2: Number(dm.area1e2Um2), areaFwhmUm2: Number(dm.areaFwhmUm2),
      powerFraction: {
        peak: isFinite(Number((dm.powerFraction || {}).peak)) ? Number(dm.powerFraction.peak) : 1.0,
        e2avg: isFinite(Number((dm.powerFraction || {}).e2avg)) ? Number(dm.powerFraction.e2avg) : 0.8646647,
        fwhm: isFinite(Number((dm.powerFraction || {}).fwhm)) ? Number(dm.powerFraction.fwhm) : 0.5,
      },
    } : null,
  };
  c.sessionActive = true; c.sessionError = null;
  if (c.session.cameraPitch) c.cameraPitch = c.session.cameraPitch;
  if (c.session.areaBasis) c.areaBasis = c.session.areaBasis;
  if (c.session.densityMode) c.densityMode = c.session.densityMode;
  // h5 자체의 여기 파장이 있으면 그걸 우선 사용(현재 보고 있는 측정에 더 직접적)
  const h5Lambda = Number(rec.meta.lambda_ex_nm);
  c.lambdaNm = isFinite(h5Lambda) && h5Lambda > 0 ? h5Lambda : (c.session.lambdaNm || c.lambdaNm);
  // 렌즈(objective) 자동 선택 — h5의 objective(lensKey 형식) 또는 세션의 lens로 매칭
  const wantKey = rec.meta.objective || (d.lens && typeof d.lens === "object" ? lensKey(d.lens) : null);
  if (wantKey) {
    const idx = (c.objectives || []).findIndex((o) => (o._key || lensKey(o)) === wantKey);
    if (idx >= 0) { c.objSel = idx; c.objMag = c.objectives[idx].mag; }
  }
  c.metrics = calibComputeMetrics() || c.metrics;
  c.enabled = true;
  saveCalib();
  renderCalibBadge();
  if (App.activeId === rec.id) renderAll();
}
function detachLedgerSession() {
  const c = App.calib;
  if (!c.session) return;
  c.sessionDetachedFor = c.session.calibId;
  c.session = null; c.sessionActive = false;
  saveCalib(); renderCalibBadge(); renderAll();
  toast("Ledger 보정 세션을 해제했습니다 — 수동 보정으로 되돌아갑니다");
}
function renderCalibBadge() {
  const el = document.getElementById("ledger-calib-badge");
  if (!el) return;
  const c = App.calib;
  if (c.sessionActive && c.session) {
    const s = c.session;
    const lensTxt = s.lens && typeof s.lens === "object"
      ? `${s.lens.maker || ""} ${s.lens.model || ""} ${isFinite(Number(s.lens.mag)) ? fmt(s.lens.mag, 4) + "×" : ""}`.trim() : "";
    const areaFromSession = !!s.metrics;
    const areaReady = areaFromSession || !!c.metrics;
    el.style.display = "";
    el.className = "ledger-badge ok";
    el.title = "클릭하면 Ledger 보정 세션 연동을 해제합니다";
    el.innerHTML = `적용된 보정: ${esc(s.at ? String(s.at).slice(0, 10) : "")} · ${s.lambdaNm ? fmt(s.lambdaNm, 5) + " nm" : ""} ` +
      `${esc(lensTxt)} · C=${isFinite(s.coefficient) ? fmt(s.coefficient, 5) : "?"}` +
      (areaFromSession ? ` <span class="ledger-badge-ok2">· 빔 면적도 세션에서 자동 적용됨(완전 자동)</span>`
        : areaReady ? "" : ` <span class="ledger-badge-warn">· 빔 면적 미측정 — 밀도 환산엔 이 PC에서 빔 이미지가 필요하거나, 이 세션에 Prism 보정 내보내기를 가져와야 합니다</span>`);
  } else if (c.sessionError) {
    el.style.display = ""; el.className = "ledger-badge err"; el.title = "";
    el.innerHTML = `Ledger 보정 조회 실패 — ${esc(c.sessionError)}`;
  } else {
    el.style.display = "none"; el.innerHTML = "";
  }
}

function saveCalib() {
  try { localStorage.setItem("innoPrismCalib2", JSON.stringify(App.calib)); } catch (e) {}
}
function loadCalib() {
  try {
    const c = JSON.parse(localStorage.getItem("innoPrismCalib2") || "null");
    if (c && typeof c === "object") Object.assign(App.calib, c);
  } catch (e) {}
  normalizeCalibPairs(App.calib);
  // 면적 기준 기본값이 gauss → d4sigma 로 바뀌었다. **직접 고른 값은 건드리지 않는다** —
  // 옛 저장본에 남은 "gauss" 는 고른 것이 아니라 그때의 기본값일 뿐이므로 그것만 옮긴다.
  if (!App.calib.areaBasisUserSet && (App.calib.areaBasis === "gauss" || App.calib.areaBasis === "d4sigma")) App.calib.areaBasis = "auto";
}

function openCalibModal() {
  const c = App.calib;
  normalizeCalibPairs(c);
  const back = document.createElement("div");
  back.className = "modal-back";
  /** 행은 **항상 CALIB_PAIR_MAX 개를 그려 두고** 현재 행 수 밖은 숨긴다.
   *  행을 추가/삭제할 때마다 표를 다시 만들면 입력 리스너를 매번 다시 걸어야 하고,
   *  그 재바인딩이 빠지는 것이 이런 UI 에서 가장 흔한 결함이다. 숨기기는 그 위험이 없다.
   *  숨긴 행의 값은 삭제 시점에 지우므로, 보이지 않는 값이 계산에 섞이지 않는다. */
  const pairRow = (i) => `<tr class="cb-pair-row" data-i="${i}"${i < c.pairRows ? "" : ' style="display:none"'}>
    <td>#${i + 1}</td>
    <td><input class="cb-pm" data-i="${i}" type="number" step="any" value="${c.pairs[i] ? wToUw(c.pairs[i].pm) : ""}" style="width:130px"></td>
    <td><input class="cb-end" data-i="${i}" type="number" step="any" value="${c.pairs[i] ? wToUw(c.pairs[i].end) : ""}" style="width:130px"></td>
    <td class="mono small cb-ratio" data-i="${i}"></td></tr>`;
  back.innerHTML = `<div class="modal">
    <h2>빔 파워 보정 → 파워밀도 환산 <span class="muted small">(mW/cm² ~ MW/cm² 자동 단위)</span></h2>
    <details class="small" style="margin:6px 0 10px;"><summary class="muted" style="cursor:pointer;">Ledger 연동 (보정 세션 자동 조회 · §4 항목4)</summary>
      <div class="small muted" style="margin:6px 0;">h5 파일의 calib_id(INNO Optics Phase 7 이후 파일에만 존재)로 INNO Ledger의 보정 세션을 찾아
      계수(C)·밀도정의·면적기준·카메라피치·렌즈 선택을 자동으로 채웁니다. <b>빔 면적(2단계)은 Ledger에 없으므로</b> 이 PC에서
      빔 이미지를 직접 열어야 완전한 파워밀도 환산이 됩니다.</div>
      <div class="flex small">
        <input id="lg-project" type="text" placeholder="Firestore 프로젝트 ID (기본 inno-nanoil)" style="width:210px">
        <input id="lg-apikey" type="text" placeholder="Firebase API Key" style="width:220px">
        <input id="lg-uid" type="text" placeholder="Ledger 로그인 UID" style="width:200px">
        <button id="lg-save" class="small primary">저장</button>
        <button id="lg-clear" class="small">해제</button>
      </div>
      <div id="lg-status" class="small" style="margin-top:6px;"></div>
    </details>
    <div class="panel"><h3>1단계 · 파워 보정 (Powermeter ↔ 시료 위치 실측)</h3>
      <div class="small muted" style="margin-bottom:6px;">같은 조건에서 powermeter 표시값과 시료 직전(endpoint)에서 실측한 값을 입력하세요.
      기본 ${CALIB_PAIR_MIN}행이며 <b>최대 ${CALIB_PAIR_MAX}행</b>까지 늘릴 수 있습니다 — <b>채운 행 수에 맞춰 계산합니다</b>(빈 행은 무시).
      1행이면 그 비율을 그대로, 2행 이상이면 원점 통과 linear fit 기울기를 씁니다.
      ${CALIB_PAIR_MIN}행 이상 채우면 기울기의 <b>표준오차</b>까지 나옵니다.</div>
      <table class="res" style="max-width:520px;">
        <tr><th></th><th>Powermeter 표시값 (µW)</th><th>Endpoint 실측값 (µW)</th><th>비율</th></tr>
        ${pairRow(0)}${pairRow(1)}${pairRow(2)}${pairRow(3)}${pairRow(4)}
      </table>
      <div class="flex small" style="margin-top:6px;gap:8px;align-items:center;">
        <button id="cb-pair-add" class="small" title="측정쌍 행을 하나 늘립니다 (최대 ${CALIB_PAIR_MAX}행)">행 추가 +</button>
        <button id="cb-pair-del" class="small" title="마지막 행을 지웁니다 (최소 ${CALIB_PAIR_MIN}행). 그 행에 입력값이 있으면 함께 지워집니다">행 삭제 −</button>
        <span id="cb-pair-count" class="muted small"></span>
      </div>
      <div id="cb-coef" class="small mono" style="margin-top:6px;"></div></div>
    <div class="panel"><h3>2단계 · ProgRes 빔 이미지 → 유효 면적 (회전 타원 2D Gaussian + 배경, 포화픽셀 제외)</h3>
      <div class="flex small" style="gap:12px;">
        <label class="ctl"><span>카메라 픽셀 피치 (µm/px)</span><input id="cb-pitch" type="number" step="any" value="${c.cameraPitch ?? 6.45}" style="width:90px"></label>
        <label class="ctl"><span>Objective Lens</span><select id="cb-obj" style="min-width:220px"></select></label>
        <label class="ctl"><span>배율 (×)</span><input id="cb-mag" type="number" step="any" value="${c.objMag ?? ""}" style="width:80px"></label>
        <label class="ctl"><span>유효 픽셀 크기</span><span id="cb-effpx" class="mono" style="padding:6px 2px;"></span></label>
        <label class="ctl"><span>실측 µm/px <span class="muted">(눈금 타깃)</span></span>
          <input id="cb-umpx" type="number" step="any" min="0" style="width:96px"
            title="눈금 타깃이나 크기를 아는 비드를 같은 카메라 경로로 찍어 잰 값. 넣으면 배율 계산 대신 이 값을 씁니다 — 경통렌즈 불일치·C-mount 어댑터·릴레이를 한 번에 잡습니다."></label>
        <label class="ctl"><span>여기 파장 (nm)</span><input type="number" id="cb-lambda" step="any" min="0" style="width:92px" title="회절 한계 대조용 — 측정에 쓰는 여기 레이저 파장"></label>
      </div>
      <div id="cb-lens-info" class="small mono" style="margin-top:4px;color:var(--text-secondary);"></div>
      <details class="small" style="margin-top:6px;"><summary class="muted" style="cursor:pointer;">렌즈 목록 관리 (추가/삭제 · 연구실 공유)</summary>
        <div class="flex small" style="margin-top:6px;">
          <input id="cb-obj-maker" type="text" placeholder="제조사 (예: Olympus)" style="width:140px">
          <input id="cb-obj-model" type="text" placeholder="모델명 (예: MPLFLN100X)" style="width:170px">
          <input id="cb-obj-mag" type="number" step="any" placeholder="배율" style="width:72px">
          <input id="cb-obj-na" type="number" step="any" min="0" placeholder="NA" style="width:70px" title="개구수 (Numerical Aperture) — 선택 입력">
          <input id="cb-obj-f" type="number" step="any" min="0" placeholder="f (mm)" style="width:78px" title="초점거리 — 비워두면 제조사 경통렌즈 기준으로 자동 계산됩니다">
          <input id="cb-obj-wd" type="number" step="any" min="0" placeholder="WD (mm)" style="width:84px" title="작동거리 (Working Distance) — 렌즈 앞면에서 초점까지의 거리. 시료·커버글라스·창 두께가 이 값을 넘으면 초점이 맺히지 않습니다. 선택 입력">
          <select id="cb-obj-med" title="침지 매질" style="width:96px">
            <option value="air">Air</option>
            <option value="oil">Oil</option>
            <option value="water">Water</option>
            <option value="glycerol">Glycerol</option>
          </select>
          <button id="cb-obj-add" class="small">목록에 추가</button>
          <button id="cb-obj-del" class="small">선택 렌즈 삭제</button>
        </div>
        <div class="flex small" style="margin-top:8px;align-items:center;">
          <span id="cb-sync-state" class="small"></span>
          <span class="right flex">
            <button id="cb-lens-export" class="small" title="렌즈 목록을 JSON 파일로 저장">내보내기</button>
            <button id="cb-lens-import" class="small" title="JSON 파일에서 렌즈 목록 불러오기 (기존 목록에 병합)">가져오기</button>
            <input id="cb-lens-file" type="file" accept=".json,application/json" style="display:none">
            <button id="cb-sync-cfg" class="small">공유 설정</button>
          </span>
        </div>
        <div id="cb-sync-box" class="small" style="display:none;margin-top:8px;padding:8px;background:var(--surface-2);border-radius:8px;">
          <div class="muted" style="margin-bottom:6px;">Firebase Realtime Database URL를 입력하면 이 브라우저가 연구실 공용 목록에 실시간 연결됩니다.
          빌드에 내장하면(빌드 담당자에게 URL 전달) 모든 PC가 입력 없이 자동 연결됩니다.</div>
          <div class="flex">
            <input id="cb-sync-url" type="text" placeholder="https://your-project-default-rtdb.firebaseio.com" style="flex:1;min-width:220px">
            <button id="cb-sync-save" class="small primary">연결</button>
            <button id="cb-sync-clear" class="small">해제</button>
          </div>
          <div id="cb-sync-err" class="small" style="margin-top:6px;"></div>
        </div>
      </details>
      <div class="flex small" style="margin-top:8px;">
        <button id="cb-img" class="small">빔 이미지 열기 (PNG/JPG/BMP)</button>
        <input id="cb-img-input" type="file" accept="image/*,.bmp,.BMP,.png,.PNG,.tif,.tiff,.TIF,.TIFF" style="display:none">
        <label class="ctl"><span>밀도 정의</span><select id="cb-mode">
          <option value="peak">Peak irradiance I₀=2P/(π·wx·wy) (권장·논문 표준)</option>
          <option value="e2avg">1/e² 면적 내 평균 (86.5% power)</option>
          <option value="fwhm">FWHM 면적 내 평균 (50% power)</option></select></label>
        <label class="ctl"><span>면적 기준 (빔 폭 정의)</span><select id="cb-basis">
          <option value="auto">자동 — 면적비로 선택 (교차점 1.35, 참값 대조로 측정) · 기본</option>
          <option value="d4sigma">ISO 11146 회전 D4σ (2차 모멘트·모델 무가정)</option>
          <option value="gauss">회전 Gaussian 피팅 1/e² (모델 가정)</option></select></label>
        <label class="ctl" title="뷰어 표시 LUT 의 감마. 저장본이 y=(I)^(1/γ) 로 인코딩되어 있으면 피팅 전에 되돌린다. 1 = 보정 없음.&#10;표준 디스플레이 감마는 2.2. 무결성 검사가 톤커브를 검출하면 추정값을 제안한다.">
          <span>표시 감마 보정 γ</span>
          <input id="cb-gamma" type="number" step="0.05" min="1" max="4" style="width:96px"
                 placeholder="1 = 없음" value="${isFinite(c.displayGamma) && c.displayGamma > 1 ? c.displayGamma : ""}"></label>
        <label class="ctl" title="촬영 당시 ProgRes 감마 슬라이더 값. 실측 확정 앵커: 0.33 = 선형(되돌릴 것 없음), 0.50 = γ 2.0. 다른 값은 측정되지 않았으므로 외삽하지 않습니다.">
          <span>촬영 감마 (ProgRes)</span>
          <input id="cb-capgamma" type="number" step="0.01" min="0" max="2" style="width:110px"
                 placeholder="미기록" value="${isFinite(c.captureGamma) && c.captureGamma > 0 ? c.captureGamma : ""}"></label>
        <label class="ctl" title="이 빔 이미지를 찍을 때 광로에 끼워둔 dichroic. 라벨 그대로 적으면 됩니다 (예: 950 DMSP).">
          <span>빔 촬영 dichroic</span>
          <input id="cb-dichroic" type="text" style="width:130px" placeholder="예: 950 DMSP" value="${esc(c.dichroic || "")}"></label>
        <label class="ctl" title="이 빔이 대표하는 측정 채널. 기록해 두면 파일명과 자동 대조해 다른 채널 데이터에 이 보정을 쓰는 것을 막습니다.">
          <span>빔 채널</span>
          <select id="cb-channel">
            <option value="">미기록</option>
            ${CALIB_CHANNELS.map((q) => `<option value="${q.key}"${c.beamChannel === q.key ? " selected" : ""}>${q.label}</option>`).join("")}
          </select></label>
      </div>
      <div id="cb-ch-note" class="small" style="margin-top:6px;"></div>
      <div id="cb-capgamma-note">${captureGammaHtml(c)}</div>
      <div id="cb-beam-status" class="small muted" style="margin-top:6px;">${c.metrics ? "" : "이미지를 열면 자동으로 피팅됩니다."}</div>
      <div id="cb-beam-chart" class="chart" style="height:340px;display:${c.beam ? "" : "none"};"></div>
      <div id="cb-beam-out" class="small mono" style="margin-top:6px;"></div></div>
    <div class="panel"><h3>요약</h3><div id="cb-summary" class="small mono"></div>
      <div class="flex" style="margin-top:8px;">
        <label class="flex small"><input id="cb-enable" type="checkbox" ${c.enabled ? "checked" : ""}> 보정 활성화 (Power scan 축/결과에 파워밀도 표시 — 범위에 맞는 단위 자동 선택)</label>
      </div></div>
    <div class="flex"><span class="right"><button id="cb-export-session" class="small" title="이 보정 세션(계수+측정쌍+빔 이미지 피팅 결과)을 JSON로 내보내 INNO Ledger에 가져올 수 있게 합니다">보정 세션 내보내기 (Ledger용)</button> <button id="cb-close" class="primary">저장 후 닫기</button></span></div>
  </div>`;
  document.body.appendChild(back);
  const sortObjectives = (keep) => {
    // 제조사 이름순 → 배율순 자동 정렬 (추가 순서 무관)
    c.objectives = c.objectives || [];
    c.objectives.sort((a, b) =>
      String(a.maker || "").localeCompare(String(b.maker || ""), "ko") || (a.mag - b.mag));
    if (keep) c.objSel = c.objectives.indexOf(keep);
  };
  const fillObjSelect = () => {
    sortObjectives(c.objSel >= 0 ? c.objectives[c.objSel] : null);
    const sel = back.querySelector("#cb-obj");
    const opts = ['<option value="-1">직접 입력</option>'];
    (c.objectives || []).forEach((o, i) => {
      opts.push(`<option value="${i}">${esc(lensLabel(o))}${o._pending ? " · 미동기화" : ""}</option>`);
    });
    sel.innerHTML = opts.join("");
    sel.value = String(c.objSel != null ? c.objSel : -1);
  };
  const upd = () => {
    // 보이는 행만 읽는다 — c.pairs 의 길이 자체가 현재 행 수가 되므로,
    // 숨은 행의 잔재가 계수에 섞일 여지가 없다.
    c.pairs.length = c.pairRows;
    for (let i = 0; i < c.pairRows; i++) {
      const pmEl = back.querySelector(`.cb-pm[data-i="${i}"]`), enEl = back.querySelector(`.cb-end[data-i="${i}"]`);
      if (!pmEl || !enEl) continue;
      c.pairs[i] = { pm: uwToW(pmEl.value), end: uwToW(enEl.value) };   // 입력 µW → 저장 W
      const r = c.pairs[i].pm > 0 && c.pairs[i].end > 0 ? c.pairs[i].end / c.pairs[i].pm : NaN;
      back.querySelector(`.cb-ratio[data-i="${i}"]`).textContent = isFinite(r) ? "×" + fmt(r, 5) : "";
    }
    c.cameraPitch = Number(back.querySelector("#cb-pitch").value) || 6.45;
    c.objMag = back.querySelector("#cb-mag").value === "" ? null : Number(back.querySelector("#cb-mag").value);
    const umEl = back.querySelector("#cb-umpx");
    c.umPerPxMeasured = (umEl && umEl.value !== "" && Number(umEl.value) > 0) ? Number(umEl.value) : null;
    const gmEl = back.querySelector("#cb-gamma");
    c.displayGamma = (gmEl && gmEl.value !== "" && Number(gmEl.value) > 1) ? Number(gmEl.value) : 1;
    const cgEl = back.querySelector("#cb-capgamma");
    c.captureGamma = (cgEl && cgEl.value !== "" && Number(cgEl.value) > 0) ? Number(cgEl.value) : null;
    const cgNote = back.querySelector("#cb-capgamma-note");
    if (cgNote) cgNote.innerHTML = captureGammaHtml(c);
    const dicEl = back.querySelector("#cb-dichroic");
    if (dicEl) c.dichroic = String(dicEl.value || "").trim();
    const chEl = back.querySelector("#cb-channel");
    if (chEl) c.beamChannel = chEl.value || "";
    c.densityMode = back.querySelector("#cb-mode").value;
    const basisSel = back.querySelector("#cb-basis");
    if (basisSel && basisSel.value !== c.areaBasis) { c.areaBasis = basisSel.value; c.areaBasisUserSet = true; }
    c.enabled = back.querySelector("#cb-enable").checked;
    const lam = Number(back.querySelector("#cb-lambda").value);
    if (isFinite(lam) && lam > 0) c.lambdaNm = lam;
    const eff = calibEffUmPerPx();
    const nom = calibNominalUmPerPx();
    const measured = isFinite(c.umPerPxMeasured) && c.umPerPxMeasured > 0;
    back.querySelector("#cb-effpx").innerHTML = !isFinite(eff) ? "배율 입력 필요"
      : measured
        ? `<b>${fmt(eff, 5)} µm/px</b> <span class="muted">(실측)</span>`
          + (isFinite(nom) ? `<br><span class="${Math.abs(eff / nom - 1) > 0.05 ? "tag-Low" : "muted"}" style="font-size:10.5px">`
             + `계산값 ${fmt(nom, 5)} 대비 ${fmt(100 * (eff / nom - 1), 3)}% → 파워밀도 ×${fmt((nom / eff) ** 2, 4)}</span>` : "")
        : `${fmt(c.cameraPitch, 4)}/${fmt(c.objMag ?? NaN, 4)} = ${fmt(eff, 5)} µm/px`
          + `<br><span class="muted" style="font-size:10.5px">계산값 — 경통렌즈·C-mount 배율을 모릅니다. 눈금 타깃으로 실측 권장</span>`;
    c.metrics = calibComputeMetrics() || c.metrics;
    refreshCalibUI();
    saveCalib();
  };
  const refreshCalibUI = () => {
    const cc = calibCoefficient();
    back.querySelector("#cb-coef").innerHTML = cc.fromSession
      ? `계수 C = <b>${fmt(cc.C, 6)}</b> <span class="muted small">(Ledger 보정 세션에서 자동 적용됨 — 아래 측정쌍 입력은 지금 무시됩니다. 직접 입력하려면 상단 배지를 눌러 세션을 해제하세요)</span>`
      : cc.nPairs
      ? `계수 C = P<sub>시료</sub>/P<sub>PM</sub> = <b>${fmt(cc.C, 6)}</b> (${cc.nPairs}회 ${cc.nPairs > 1 ? "linear fit" : "단일 비율"})` +
        (isFinite(cc.spreadPct) ? ` · 회차 간 편차 ${fmt(cc.spreadPct, 3)}%` : "") +
        (isFinite(cc.seC) && cc.seC > 0
          ? ` · 기울기 표준오차 ±${fmt(cc.seC, 3)} (${fmt(100 * cc.seC / Math.abs(cc.C), 3)}%)`
          : cc.nPairs === 2 ? ` <span class="muted">· 표준오차는 ${CALIB_PAIR_MIN}회부터 (2회는 dof=1 이라 의미 없음)</span>` : "")
      : `<span class="muted">측정쌍을 입력하세요.</span>`;
    const cntEl = back.querySelector("#cb-pair-count");
    if (cntEl) {
      const filled = (c.pairs || []).filter((q) => isFinite(q.pm) && q.pm > 0 && isFinite(q.end) && q.end > 0).length;
      cntEl.textContent = `행 ${c.pairRows}개 (최소 ${CALIB_PAIR_MIN} · 최대 ${CALIB_PAIR_MAX}) · 채운 측정쌍 ${filled}개`;
    }
    const addBtn = back.querySelector("#cb-pair-add"), delBtn = back.querySelector("#cb-pair-del");
    if (addBtn) addBtn.disabled = c.pairRows >= CALIB_PAIR_MAX;
    if (delBtn) delBtn.disabled = c.pairRows <= CALIB_PAIR_MIN;
    const m = c.metrics;
    const infoEl = back.querySelector("#cb-lens-info");
    if (infoEl) infoEl.innerHTML = lensInfoHtml(c);
    const lamEl = back.querySelector("#cb-lambda");
    if (lamEl && document.activeElement !== lamEl) lamEl.value = c.lambdaNm || "";
    const bs0 = calibBasisSigma();
    const basisName = (bs0 && bs0.src === "gauss" ? "회전 Gaussian 1/e²" : "ISO 11146 회전 D4σ")
      + (bs0 && bs0.autoPicked ? " <span class=\"muted\">(자동 선택)</span>" : "");
    back.querySelector("#cb-beam-out").innerHTML = m ? [
      `<b>[${basisName}]</b> 지름 (4σ): <b>${fmt(m.d1e2Xum, 4)} × ${fmt(m.d1e2Yum, 4)} µm</b> (θ=${fmt(m.thetaDeg, 3)}°)`,
      `FWHM: ${fmt(m.fwhmXum, 4)} × ${fmt(m.fwhmYum, 4)} µm · σ: ${fmt(m.sigmaXum, 4)} × ${fmt(m.sigmaYum, 4)} µm`,
      `유효 면적 — peak: ${fmt(m.areaPeakUm2, 5)} µm² · 1/e²: ${fmt(m.area1e2Um2, 5)} µm² · FWHM: ${fmt(m.areaFwhmUm2, 5)} µm²`,
      c.beam ? `피팅 R²(ROI)=${fmt(c.beam.r2, 4)} · 포화 제외 ${c.beam.nSat}px` +
        (c.beam.nNear > 0 ? ` · 근접 반사 ${c.beam.nNear}개 분리` : "") +
        (c.beam.nClip > 0 ? ` · residual 클립 ${c.beam.nClip}px` : "") : "",
      beamBasisCompareHtml(c),
    ].filter(Boolean).join("<br>") : `<span class="muted">빔 이미지 미피팅 (배율 선택/입력 + 이미지 필요)</span>`;
    const k = densityFactor();
    back.querySelector("#cb-summary").innerHTML = isFinite(k)
      ? `환산식: <b>mW/cm² = P<sub>PM</sub>(W) × ${fmt(k, 6)}</b> <span class="muted small">(표시 단위는 데이터 범위에 맞춰 mW/cm²~MW/cm² 자동)</span><br>` +
        `(C=${fmt(cc.C, 5)} × power fraction ${fmt((c.metrics ? c.metrics.powerFraction[c.densityMode] : 1), 4)} × 1000 / A=${fmt(calibAreaCm2(), 5)} cm² [${c.densityMode}])<br>` +
        `예: PM 1 mW → <b>${fmtDensityAuto(0.001 * k, 5)}</b>`
      : `<span class="muted">계수(1단계)와 빔 면적(2단계)이 준비되면 환산식이 표시됩니다.</span>`;
    back.querySelector("#cb-mode").value = c.densityMode || "peak";
    back.querySelector("#cb-basis").value = c.areaBasis || "auto";
    const umEl2 = back.querySelector("#cb-umpx");
    if (umEl2 && document.activeElement !== umEl2) umEl2.value = isFinite(c.umPerPxMeasured) ? c.umPerPxMeasured : "";
    const gmEl2 = back.querySelector("#cb-gamma");
    if (gmEl2 && document.activeElement !== gmEl2) gmEl2.value = (isFinite(c.displayGamma) && c.displayGamma > 1) ? c.displayGamma : "";
    const dicEl2 = back.querySelector("#cb-dichroic");
    if (dicEl2 && document.activeElement !== dicEl2) dicEl2.value = c.dichroic || "";
    const chEl2 = back.querySelector("#cb-channel");
    if (chEl2 && document.activeElement !== chEl2) chEl2.value = c.beamChannel || "";
    const chNote = back.querySelector("#cb-ch-note");
    if (chNote) {
      const rec0 = App.files.find((f) => f.id === App.activeId);
      const fileCh = detectFileChannel(rec0 && rec0.name);
      if (!c.beamChannel) {
        chNote.innerHTML = `<span class="muted">빔 채널을 기록하면 파일명과 자동 대조해 "다른 dichroic 으로 찍은 빔 면적" 사고를 막습니다.`
          + (fileCh ? ` 지금 열려 있는 파일은 <b>${esc(channelLabel(fileCh))}</b> 채널로 보입니다.` : "") + `</span>`;
      } else if (fileCh && fileCh !== c.beamChannel) {
        chNote.innerHTML = `<span class="tag-Poor">불일치</span> 이 빔은 <b>${esc(channelLabel(c.beamChannel))}</b>`
          + (c.dichroic ? ` <span class="muted">[${esc(c.dichroic)}]</span>` : "")
          + ` 인데 열려 있는 파일은 <b>${esc(channelLabel(fileCh))}</b> 입니다 — 이 보정을 그 파일에 쓰면 파워밀도가 면적비만큼 틀립니다.`;
      } else {
        chNote.innerHTML = `<span class="muted">빔 채널 <b>${esc(channelLabel(c.beamChannel))}</b>`
          + (c.dichroic ? ` · dichroic <b>${esc(c.dichroic)}</b>` : " · dichroic 미기록")
          + (fileCh ? ` · 열려 있는 파일과 일치` : ` · 열려 있는 파일에서는 채널을 판정할 수 없음`) + `</span>`;
      }
    }
    if (c.beam) drawBeamChart();
  };
  const drawBeamChart = () => {
    const b = c.beam;
    if (!b || !b.preview) return;
    back.querySelector("#cb-beam-chart").style.display = "";
    const ell = (cx, cy, sx, sy, th) => {
      const pts = [];
      for (let t = 0; t <= 64; t++) {
        const a2 = 2 * Math.PI * t / 64;
        const ex = 2 * sx * Math.cos(a2), ey = 2 * sy * Math.sin(a2);
        pts.push([cx + ex * Math.cos(th) - ey * Math.sin(th), cy + ex * Math.sin(th) + ey * Math.cos(th)]);
      }
      return pts;
    };
    const gEll = ell(b.x0, b.y0, b.sx, b.sy, b.theta);
    const useD4 = c.areaBasis === "d4sigma";
    const traces = [
      { z: b.preview, type: "heatmap", colorscale: "Viridis", colorbar: { outlinewidth: 0, thickness: 12 }, hovertemplate: "x=%{x} y=%{y} I=%{z:.1f}<extra></extra>" },
      { x: gEll.map((q) => q[0]), y: gEll.map((q) => q[1]), mode: "lines",
        name: `Gaussian 1/e² 경계 (4σ)${useD4 ? "" : " — 유효면적 기준"}`,
        line: { color: "#e66767", width: useD4 ? 1.4 : 2.2, dash: useD4 ? "dot" : "solid" },
        hovertemplate: "Gaussian 피팅 1/e² 경계<extra></extra>" },
    ];
    if (b.moments && isFinite(b.moments.sigmaMajor)) {
      const m = b.moments;
      const mEll = ell(m.cx, m.cy, m.sigmaMajor, m.sigmaMinor, m.theta);
      traces.push({
        x: mEll.map((q) => q[0]), y: mEll.map((q) => q[1]), mode: "lines",
        name: `ISO 회전 D4σ 경계${useD4 ? " — 유효면적 기준" : ""}`,
        line: { color: "#38bdf8", width: useD4 ? 2.2 : 1.4, dash: useD4 ? "solid" : "dot" },
        hovertemplate: "ISO 11146 2차 모멘트 D4σ 경계<extra></extra>" });
      // 회전을 무시했을 때의 카메라축 D4σ (비교용, 항상 점선)
      const nEll = ell(m.cx, m.cy, m.sigmaXlab, m.sigmaYlab, 0);
      traces.push({
        x: nEll.map((q) => q[0]), y: nEll.map((q) => q[1]), mode: "lines",
        name: "회전 무시 D4σ (과대평가 — 참고)", line: { color: "#8b8a80", width: 1, dash: "dash" },
        hovertemplate: "회전 미보정 카메라축 D4σ<extra></extra>" });
    }
    const beamEl = back.querySelector("#cb-beam-chart");
    const effUm = calibEffUmPerPx();
    const umPerPrev = effUm * (b.binFactor || 1);
    const measuredUm = isFinite(c.umPerPxMeasured) && c.umPerPxMeasured > 0;
    newPlot(beamEl, traces, {
      margin: { l: 46, r: 10, t: 8, b: 36 },
      yaxis: Object.assign(baseLayout().yaxis, { scaleanchor: "x", autorange: "reversed" }),
      showlegend: true,
      legend: { orientation: "h", y: 1.08, x: 0, bgcolor: "rgba(0,0,0,0)", font: { size: 11 } },
    }).then(() => PrismReport.attachPlotlyScaleBar(beamEl, isFinite(umPerPrev) && umPerPrev > 0
      ? { on: true, umPerUnit: umPerPrev, source: `${measuredUm ? "실측" : "공칭"} ${fmt(effUm, 4)} µm/px × 비닝 ${fmt(b.binFactor || 1, 3)}` }
      : null));
  };
  /** 행 수 조절. 표시/숨김만 바꾸고 표를 다시 만들지 않으므로 리스너는 그대로 유효하다. */
  const setPairRows = (next) => {
    const rows = Math.max(CALIB_PAIR_MIN, Math.min(CALIB_PAIR_MAX, next));
    if (rows === c.pairRows) return;
    if (rows < c.pairRows) {
      // 지워지는 행의 입력값을 실제로 비운다 — 보이지 않는 값이 남아 나중에
      // 행을 다시 늘렸을 때 되살아나면, 사용자가 지운 줄 아는 값이 계수에 들어간다.
      let hadValue = false;
      for (let i = rows; i < c.pairRows; i++) {
        const pmEl = back.querySelector(`.cb-pm[data-i="${i}"]`), enEl = back.querySelector(`.cb-end[data-i="${i}"]`);
        if (pmEl && pmEl.value !== "") hadValue = true;
        if (enEl && enEl.value !== "") hadValue = true;
        if (pmEl) pmEl.value = "";
        if (enEl) enEl.value = "";
        const rEl = back.querySelector(`.cb-ratio[data-i="${i}"]`);
        if (rEl) rEl.textContent = "";
        c.pairs[i] = { pm: null, end: null };
      }
      if (hadValue) toast(`#${rows + 1}${c.pairRows > rows + 1 ? `~#${c.pairRows}` : ""} 행의 입력값도 함께 지웠습니다`, 3000);
    }
    c.pairRows = rows;
    back.querySelectorAll(".cb-pair-row").forEach((tr) => {
      tr.style.display = Number(tr.dataset.i) < rows ? "" : "none";
    });
    upd();
  };
  const addBtnEl = back.querySelector("#cb-pair-add"), delBtnEl = back.querySelector("#cb-pair-del");
  if (addBtnEl) addBtnEl.addEventListener("click", () => setPairRows(c.pairRows + 1));
  if (delBtnEl) delBtnEl.addEventListener("click", () => setPairRows(c.pairRows - 1));
  back.querySelectorAll(".cb-pm, .cb-end, #cb-pitch, #cb-mag, #cb-lambda, #cb-umpx, #cb-gamma, #cb-capgamma, #cb-dichroic, #cb-channel").forEach((el) => el.addEventListener("change", upd));
  fillObjSelect();
  back.querySelector("#cb-obj").addEventListener("change", () => {
    const i = Number(back.querySelector("#cb-obj").value);
    c.objSel = i;
    if (i >= 0 && c.objectives[i]) back.querySelector("#cb-mag").value = c.objectives[i].mag;
    upd();
  });
  back.querySelector("#cb-obj-add").addEventListener("click", async () => {
    const maker = back.querySelector("#cb-obj-maker").value.trim();
    const model = back.querySelector("#cb-obj-model").value.trim();
    const mag = Number(back.querySelector("#cb-obj-mag").value);
    const naRaw = back.querySelector("#cb-obj-na").value;
    const na = naRaw === "" ? null : Number(naRaw);
    const medium = back.querySelector("#cb-obj-med").value;
    const fRaw = back.querySelector("#cb-obj-f").value;
    const fMm = fRaw === "" ? null : Number(fRaw);
    const wdRaw = back.querySelector("#cb-obj-wd").value;
    const wdMm = wdRaw === "" ? null : Number(wdRaw);
    if (fMm !== null && !(isFinite(fMm) && fMm > 0)) { toast("초점거리는 0보다 큰 값이어야 합니다"); return; }
    // WD upper bound 50 mm — 시판 장초점 대물렌즈(저배율 Mitutoyo 계열)도 34 mm 안쪽이다.
    // 그보다 크면 µm/mm 단위 혼동일 가능성이 높다.
    if (wdMm !== null && !(isFinite(wdMm) && wdMm > 0 && wdMm <= 50)) { toast("작동거리는 0보다 크고 50 mm 이하여야 합니다 (단위: mm)"); return; }
    if (!(isFinite(mag) && mag > 0)) { toast("배율을 올바르게 입력하세요"); return; }
    if (na !== null && !(isFinite(na) && na > 0 && na < 2.0)) { toast("NA는 0보다 크고 2.0 미만이어야 합니다"); return; }
    if (na !== null && medium === "air" && na >= 1.0) { toast("Air 대물렌즈의 NA는 1.0 미만입니다 — 매질을 확인하세요"); return; }
    c.objectives = c.objectives || [];
    const entry = { maker, model, mag, medium, ...(na !== null ? { na } : {}), ...(fMm !== null ? { f: fMm } : {}),
      ...(wdMm !== null ? { wd: wdMm } : {}),
      _key: lensKey({ maker, model, mag }) };
    if (c.objectives.some((o) => (o._key || lensKey(o)) === entry._key)) { toast("이미 목록에 있는 렌즈입니다"); return; }
    // 로컬 먼저 반영(오프라인에서도 즉시 사용) → 서버 전송
    entry._pending = !!lensDbUrl();
    c.objectives.push(entry);
    sortObjectives(entry);
    back.querySelector("#cb-mag").value = mag;
    back.querySelector("#cb-obj-maker").value = ""; back.querySelector("#cb-obj-model").value = "";
    back.querySelector("#cb-obj-mag").value = ""; back.querySelector("#cb-obj-na").value = "";
    back.querySelector("#cb-obj-f").value = ""; back.querySelector("#cb-obj-wd").value = "";
    fillObjSelect(); upd();
    if (lensDbUrl()) {
      try { await lensPush(entry); delete entry._pending; saveCalib(); toast("공용 목록에 추가되어 연구실 전체에 공유됩니다"); }
      catch (e) { toast("서버 전송 실패 — 로컬에 저장했고 연결되면 자동 전송됩니다"); updateSyncUI(); }
    }
  });
  back.querySelector("#cb-obj-del").addEventListener("click", async () => {
    const i = Number(back.querySelector("#cb-obj").value);
    if (!(i >= 0 && c.objectives[i])) return;
    const victim = c.objectives[i];
    if (lensDbUrl() && !victim._pending &&
        !confirm(`"${lensLabel(victim)}"을(를) 연구실 공용 목록에서 삭제합니다.\n모든 PC에서 사라집니다. 계속할까요?`)) return;
    const vkey = victim._key || lensKey(victim);
    if (lensDbUrl()) LensSync.tomb.add(vkey);   // 서버 확인 전까지 되살아나지 않도록
    c.objectives.splice(i, 1);
    c.objSel = -1;
    fillObjSelect(); upd();
    if (lensDbUrl()) {
      try { await lensRemove(victim); }
      catch (e) {
        LensSync.tomb.delete(vkey);             // 실패 → 롤백(다음 병합에서 복구)
        lensMerge(); fillObjSelect();
        toast("서버 삭제 실패 — 목록을 되돌렸습니다: " + e.message);
      }
    }
  });
  // ---- 공용 렌즈 목록 동기화 UI ----
  const updateSyncUI = () => {
    const el = back.querySelector("#cb-sync-state");
    if (!el) return;
    const [txt, col] = lensSyncStatus();
    const nPend = (c.objectives || []).filter((o) => o._pending).length;
    el.innerHTML = `<span style="color:${col}">${esc(txt)}</span>` +
      (lensDbUrl() ? ` <span class="muted">· ${esc(lensDbUrl().replace(/^https?:\/\//, "").slice(0, 40))}</span>` : "") +
      (nPend ? ` <span class="tag-Low">· 미전송 ${nPend}건</span>` : "");
    const errEl = back.querySelector("#cb-sync-err");
    if (errEl) errEl.innerHTML = LensSync.err ? `<span class="tag-Low">${esc(LensSync.err)}</span>` : "";
  };
  refreshLensUI = () => { try { fillObjSelect(); updateSyncUI(); } catch (e) {} };
  updateSyncUI();
  // ---- Ledger 연동 설정 UI ----
  (() => {
    const pEl = back.querySelector("#lg-project"), kEl = back.querySelector("#lg-apikey"),
          uEl = back.querySelector("#lg-uid"), sEl = back.querySelector("#lg-status");
    if (!pEl) return;
    const lg = c.ledger || {};
    pEl.value = lg.projectId || ""; kEl.value = lg.apiKey || ""; uEl.value = lg.uid || "";
    const refreshLgStatus = () => {
      sEl.innerHTML = ledgerCfg()
        ? `<span style="color:var(--good)">● 설정됨</span> — calib_id가 있는 파일을 선택하면 자동 조회합니다`
        : `<span class="muted">○ 미설정 — API Key와 UID를 입력하면 활성화됩니다</span>`;
    };
    refreshLgStatus();
    back.querySelector("#lg-save").addEventListener("click", () => {
      c.ledger = { projectId: pEl.value.trim(), apiKey: kEl.value.trim(), uid: uEl.value.trim() };
      saveCalib(); refreshLgStatus();
      toast("Ledger 연동 설정을 저장했습니다");
      const rec = App.files.find((f) => f.id === App.activeId);
      if (rec) maybeApplyLedgerSession(rec);
    });
    back.querySelector("#lg-clear").addEventListener("click", () => {
      c.ledger = { projectId: "", apiKey: "", uid: "" };
      pEl.value = ""; kEl.value = ""; uEl.value = "";
      saveCalib(); refreshLgStatus();
      toast("Ledger 연동을 해제했습니다 (로컬 렌즈/계수 설정은 유지됩니다)");
    });
  })();
  back.querySelector("#cb-sync-cfg").addEventListener("click", () => {
    const box = back.querySelector("#cb-sync-box");
    box.style.display = box.style.display === "none" ? "" : "none";
    back.querySelector("#cb-sync-url").value = c.lensDbUrl === "" ? "" : (c.lensDbUrl || lensDbUrl() || "");
  });
  back.querySelector("#cb-sync-save").addEventListener("click", () => {
    const u = back.querySelector("#cb-sync-url").value.trim();
    // https 필수 (사내/로컬 테스트 서버만 http 허용)
    if (u && !/^https:\/\/[^\s]+$/i.test(u) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(u)) {
      toast("https:// 로 시작하는 URL를 입력하세요"); return;
    }
    c.lensDbUrl = u || "";  saveCalib();   // 빈 입력 = 공유 해제
    LensSync.server = null; LensSync.retry = 0;
    lensSyncStart();
    toast(u ? "공용 목록에 연결합니다" : "공유 해제 — 로컬 목록만 사용합니다");
  });
  back.querySelector("#cb-sync-clear").addEventListener("click", () => {
    c.lensDbUrl = ""; saveCalib();   // 빈 문자열 = 내장 URL도 사용하지 않음
    LensSync.server = null; lensSyncStop(); LensSync.state = "off"; LensSync.err = "";
    back.querySelector("#cb-sync-url").value = "";
    // 서버 사본 표시는 지우되 목록 자체는 로컬에 남긴다
    (c.objectives || []).forEach((o) => { delete o._pending; });
    fillObjSelect(); updateSyncUI(); saveCalib();
    toast("공유 해제됨 (목록은 이 브라우저에 유지)");
  });
  back.querySelector("#cb-lens-export").addEventListener("click", () => {
    const payload = { app: "INNO Prism", kind: "objective-lens-list", exportedAt: new Date().toISOString(),
      cameraPitch: c.cameraPitch,
      lenses: (c.objectives || []).map((o) => lensEntry(o)) };
    downloadText("INNO_Prism_lenses.json", JSON.stringify(payload, null, 1), "application/json");
  });
  back.querySelector("#cb-lens-import").addEventListener("click", () => back.querySelector("#cb-lens-file").click());
  back.querySelector("#cb-lens-file").addEventListener("change", async (e) => {
    const f = e.target.files[0]; e.target.value = "";
    if (!f) return;
    try {
      const j = JSON.parse(await f.text());
      const list = Array.isArray(j) ? j : (j.lenses || []);
      let added = 0;
      c.objectives = c.objectives || [];
      for (const raw of list) {
        const o = lensEntry(raw);
        if (!(isFinite(o.mag) && o.mag > 0)) continue;
        o._key = lensKey(o);
        if (c.objectives.some((x) => (x._key || lensKey(x)) === o._key)) continue;
        o._pending = !!lensDbUrl();
        c.objectives.push(o); added++;
        if (lensDbUrl()) { try { await lensPush(o); } catch (err) {} }
      }
      sortObjectives(null); fillObjSelect(); updateSyncUI(); upd();
      toast(added ? `${added}개 렌즈를 가져왔습니다${lensDbUrl() ? " (공용 목록에도 반영)" : ""}` : "새로 추가된 렌즈가 없습니다");
    } catch (err) { toast("가져오기 실패: " + err.message); }
  });
  back.querySelector("#cb-mode").addEventListener("change", upd);
  back.querySelector("#cb-basis").addEventListener("change", upd);
  back.querySelector("#cb-enable").addEventListener("change", upd);
  back.querySelector("#cb-img").addEventListener("click", () => back.querySelector("#cb-img-input").click());
  back.querySelector("#cb-img-input").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    back.querySelector("#cb-beam-status").textContent = "이미지 로드/피팅 중…";
    try {
      /* v3.17 — TIFF 는 **canvas 를 우회한다.**
       * 브라우저 canvas 는 TIFF 를 디코드하지 못하고, 된다 해도 getImageData 는
       * 채널당 8-bit 다. 12-bit 자료를 8-bit 로 깎으면 실측에서 Gaussian 면적이
       * +22.3 %, d4sAreaRatio 가 −35.8 % 틀어진다(양자화 계단 16 ADU 가 read
       * noise 1.89 ADU 의 8.4배라 꼬리가 뭉개진다).
       * 매직 바이트로 판정한다 — 확장자를 믿지 않는다. */
      const abuf = await file.arrayBuffer();
      let tif = null;
      if (PrismTiff.isTiff(abuf)) {
        try { tif = PrismTiff.decodeTiff(abuf); }
        catch (te) { throw new Error(te.message); }   // 이유를 그대로 사용자에게
      }
      let W0, H0, idata = null, gTif = null, rgbTif = null;
      let satLevelSrc = 254, quantStep = 1, depthNote = "";
      if (tif) {
        W0 = tif.w; H0 = tif.h; gTif = tif.data; rgbTif = tif.rgb;
        satLevelSrc = tif.satLevel; quantStep = tif.quantStep;
        depthNote = ` · <span class="tag-High">${tif.bitsPerSample}-bit TIFF 직접 읽기` +
          (tif.effectiveBits !== tif.bitsPerSample ? ` (유효 ${tif.effectiveBits}-bit)` : "") + `</span>`;
      } else {
        const bmp = await createImageBitmap(file);
        const cv = document.createElement("canvas");
        cv.width = bmp.width; cv.height = bmp.height;
        const ctx = cv.getContext("2d");
        ctx.drawImage(bmp, 0, 0);
        idata = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
        W0 = bmp.width; H0 = bmp.height;
      }
      // --- 측정 오버레이(원/선/텍스트) 자동 제거 ---
      // ProgRes 저장 이미지에는 반경 표시용 컬러 주석(노란 원, 초록 선 등)이
      // 박혀 있음. 빔 데이터는 흑백(R≈G≈B)이므로 채도(chroma)가 큰 픽셀은
      // 주석 → 마스크 처리. 안티앨리어싱 가장자리는 3×3 팽창으로 흡수.
      const CHROMA_THR = 28;
      const annMask = new Uint8Array(W0 * H0);
      let nAnnRaw = 0;
      // TIFF(RGB)도 같은 기준으로 본다. 단채널 TIFF 는 채도가 정의되지 않으므로 건너뛴다.
      const rgbAt = idata
        ? (i) => [idata[i * 4], idata[i * 4 + 1], idata[i * 4 + 2]]
        : (rgbTif ? (i) => [rgbTif.r[i], rgbTif.g[i], rgbTif.b[i]] : null);
      if (rgbAt) for (let i = 0; i < W0 * H0; i++) {
        const [r, g, b] = rgbAt(i);
        const chroma = Math.max(r, g, b) - Math.min(r, g, b);
        if (chroma > CHROMA_THR) { annMask[i] = 1; nAnnRaw++; }
      }
      if (nAnnRaw > 0) { // 3×3 dilation (1회)
        const dil = new Uint8Array(annMask);
        for (let y = 0; y < H0; y++) for (let x = 0; x < W0; x++) {
          if (!annMask[y * W0 + x]) continue;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const yy = y + dy, xx = x + dx;
            if (yy >= 0 && yy < H0 && xx >= 0 && xx < W0) dil[yy * W0 + xx] = 1;
          }
        }
        annMask.set(dil);
      }
      /* v3.10 — 업로드 무결성 검사는 **비닝 전 원해상도**에서 해야 한다.
       * 업스케일 검출은 이웃 픽셀의 잡음 상관을 보는 것인데, 아래에서 f배 비닝을
       * 하면 바로 그 상관구조가 지워져 버리기 때문이다. 화면 캡쳐(리샘플된 이미지)와
       * 톤커브(감마/auto-contrast)는 각각 면적을 L²배, 빔 형태 자체를 왜곡시키므로
       * 피팅 전에 걸러야 한다. */
      const grayFull = new Float64Array(W0 * H0);
      for (let i = 0; i < W0 * H0; i++) {
        if (annMask[i]) { grayFull[i] = NaN; continue; }
        if (gTif) { grayFull[i] = gTif[i]; continue; }   // 이미 0–255 환산 · 계조 유지
        const i4 = i * 4;
        grayFull[i] = 0.2126 * idata[i4] + 0.7152 * idata[i4 + 1] + 0.0722 * idata[i4 + 2];
      }
      let integrity = null;
      // 양자화 계단을 함께 넘긴다 — 12-bit 자료에 8-bit 바닥을 적용하면 멀쩡한 빈이 폐기된다
      try { integrity = PrismEngine.imageIntegrity(grayFull, W0, H0, { quantStep }); }
      catch (err) { integrity = { error: String(err && err.message || err) }; }

      /* v3.15 — 포화는 **원해상도에서, 감마 되돌리기 전에** 마스크한다.
       *
       * 두 가지가 동시에 틀려 있었다:
       *  (1) 비닝 뒤에 마스크하면 포화 화소 1개가 f²−1 개 이웃과 평균되어 문턱 아래로
       *      내려가 그냥 빠져나간다. f=5 면 255 짜리 1개가 이웃 평균 100 과 섞여 106 이
       *      되므로 `fitBeam(satLevel:254)` 이 볼 수 없다. fitBeam 내부 주석이 말하는
       *      "saturation must be masked BEFORE any correction" 이 앱 레벨에서 깨져 있었다.
       *  (2) 감마를 되돌린 뒤에 보면 254 → 255·(254/255)^γ 로 내려간다(γ=2.2 에서 252.8).
       *      문턱 판정은 저장된 원본 값에서 해야 한다.
       * 포화 화소는 값이 잘려 있어 **정보가 없다**. 평균에 섞으면 그 bin 전체가 낮아져
       * 빔 코어가 과소평가되므로 NaN 으로 빼고 비닝에서도 제외한다(이미 주석용 경로가 있다). */
      /* v3.17 — 포화 문턱을 **검출된 full scale 기준**으로. 8-bit canvas 는 254,
       * 12-bit TIFF(<<4 컨테이너)는 254.94 에 해당한다. 254 로 고정해 두면
       * 12-bit 자료에서 상위 0.4 % 를 통째로 포화로 오인해 코어를 도려낸다. */
      const SAT_LEVEL = satLevelSrc;
      let nSatFull = 0;
      for (let i = 0; i < W0 * H0; i++) {
        const v = grayFull[i];
        if (isFinite(v) && v >= SAT_LEVEL) { grayFull[i] = NaN; nSatFull++; }
      }

      /* v3.11 — 표시 감마 되돌리기.
       * 무결성 검사는 **원본 픽셀값**에 돌려야 한다(톤커브를 찾는 것이 그 일이므로).
       * 그 다음에 피팅·모멘트·enclosed power 가 쓰는 배열만 선형으로 되돌린다:
       *     저장본  y = 255·(I/255)^(1/γ)   →   복원  I = 255·(y/255)^γ
       * 배경(pedestal)은 감마 *이전*에 들어간 것으로 본다 — 표시 LUT 는 프레임
       * 전체에 걸리므로 암레벨도 같이 인코딩되기 때문이다. 따라서 절대 화소값을
       * 그대로 거듭제곱하고 배경은 빼지 않는다(배경 제거는 하류에서 한다). */
      const gamEl = back.querySelector("#cb-gamma");
      const gamDom = gamEl && gamEl.value !== "" ? Number(gamEl.value) : NaN;
      if (isFinite(gamDom) && gamDom > 1) c.displayGamma = gamDom;   // 리스너 누락에 의존하지 않는다
      const gam = (isFinite(c.displayGamma) && c.displayGamma > 1) ? c.displayGamma : 1;
      if (gam !== 1) {
        for (let i = 0; i < grayFull.length; i++) {
          const v = grayFull[i];
          if (!isFinite(v)) continue;
          grayFull[i] = 255 * Math.pow(Math.max(0, v) / 255, gam);
        }
      }

      /* v3.15 — 비닝 배수를 **스팟 크기를 보고** 정한다 (§A).
       * 이전 규칙 `ceil(max(W,H)/320)` 은 원본 크기만 보고 긴 변을 늘 ~320 px 로 줄였다.
       * 빔이 실제로 몇 화소인지는 보지 않으므로, 1:1 카메라 파일(빔 FWHM 9 px)에서
       * f=5 → 샘플링 FWHM 2.84 px 가 되어 **빔이 아니라 box 를 재게** 된다. */
      const binPick = PrismEngine.chooseBinFactor(grayFull, W0, H0, { satLevel: SAT_LEVEL });
      const f = binPick.f;
      const w = Math.floor(W0 / f), h = Math.floor(H0 / f);
      const gray = new Float64Array(w * h);
      let nAnn = 0;
      /* 비닝은 **grayFull 에서** 한다 — idata 를 다시 읽으면 위에서 되돌린 감마가
       * 반영되지 않는다(실제로 그 버그를 냈다). 그리고 감마 복원 *뒤에* 평균해야
       * 맞다: 비선형으로 인코딩된 값을 먼저 평균하면 그 평균은 물리량이 아니다. */
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let sum = 0, cnt = 0;
        for (let dy = 0; dy < f; dy++) for (let dx = 0; dx < f; dx++) {
          const v = grayFull[(y * f + dy) * W0 + (x * f + dx)];
          if (!isFinite(v)) continue;   // 주석(NaN) 픽셀 제외
          sum += v; cnt++;
        }
        if (cnt > 0) gray[y * w + x] = sum / cnt;
        else { gray[y * w + x] = NaN; nAnn++; } // bin 전체가 주석 → 피팅 제외
      }
      // 빔 피팅 파이프라인: 원거리 ghost blob 제거 → 주 빔에 붙은 근접
      // 반사광 watershed 분리 → 주 빔 주변 ROI 한정 → Gaussian 피팅 →
      // residual 이상픽셀(+4σ) 클리핑 재피팅
      const fit = PrismEngine.fitBeam({ w, h, data: gray }, { satLevel: SAT_LEVEL });
      if (!fit.success) throw new Error(fit.message || "Gaussian 피팅 실패");
      /* 샘플링 FWHM — **pf 로 나누기 전에** 잡는다. 이 값이 화면에 없었기 때문에
       * 언더샘플링이 오래 숨어 있었다. 4 px 미만이면 빔이 아니라 격자를 재는 것이다. */
      fit.sampledFwhmPx = 2.3548 * Math.min(fit.sx, fit.sy);
      fit.binChosenBy = binPick.by;            // "spot" | "cap" | "fallback"
      fit.binFwhmFullPx = binPick.fwhmFull ?? null;   // 1차 추정 원해상도 FWHM
      fit.binCap = binPick.fCap;
      fit.nSatFull = nSatFull;
      fit.source = tif
        ? { kind: "tiff", bitsPerSample: tif.bitsPerSample, effectiveBits: tif.effectiveBits,
            samples: tif.samples, fullScaleNative: tif.fullScaleNative, gcd: tif.gcd, quantStep }
        : { kind: "canvas8", bitsPerSample: 8, effectiveBits: 8, quantStep: 1 };
      const masked = fit.maskedData || gray;
      const pf = Math.max(1, Math.ceil(Math.max(w, h) / 160));
      const pw = Math.floor(w / pf), ph = Math.floor(h / pf);
      const prev = [];
      for (let y = 0; y < ph; y++) {
        const row = new Array(pw);
        for (let x = 0; x < pw; x++) {
          const v = masked[(y * pf) * w + x * pf];
          row[x] = isFinite(v) ? v : null; // 주석/ghost 제거 영역은 공백 표시
        }
        prev.push(row);
      }
      fit.preview = prev;
      delete fit.maskedData;
      fit.x0 = fit.x0 / pf; fit.y0 = fit.y0 / pf;
      fit.sx = fit.sx / pf; fit.sy = fit.sy / pf;
      /* v3.17.1 — **growth[].R 도 같이 환산한다.**
       * R = kσ·sqrt(sx·sy) 는 fitBeam 안에서 f-비닝 px 로 만들어지는데, 여기서 sx·sy 만
       * pf 로 나누면 R 만 옛 단위로 남는다. binFactor = f·pf 이므로 R 을 그대로
       * `umPerPx × binFactor` 로 환산하면 **pf 배(이 자료에서 5배) 틀린 µm** 가 나온다.
       * 지금은 R 을 아무도 쓰지 않아 드러나지 않을 뿐이고, 내보내기에 R 을 넣는 순간
       * 바로 틀린 값이 나간다. fit 안의 길이 단위를 하나로 맞춰 함정을 없앤다. */
      if (Array.isArray(fit.growth)) for (const q of fit.growth) if (isFinite(q.R)) q.R /= pf;
      // ISO 모멘트도 미리보기 스케일로 환산 (동일 px 기준 유지)
      if (fit.moments) {
        const m = fit.moments;
        m.cx /= pf; m.cy /= pf;
        m.sigmaMajor /= pf; m.sigmaMinor /= pf;
        m.d4sMajor /= pf; m.d4sMinor /= pf;
        m.sigmaXlab /= pf; m.sigmaYlab /= pf;
      }
      fit.binFactor = f * pf;
      fit.integrity = integrity;
      c.beam = fit;
      c.metrics = calibComputeMetrics() || c.metrics;
      const sfw = fit.sampledFwhmPx;
      const sfwHtml = isFinite(sfw)
        ? (sfw < 4
          ? ` · <span class="tag-Poor">샘플링 FWHM ${fmt(sfw, 3)} binned px — 언더샘플링. 빔이 아니라 비닝 격자를 재고 있을 수 있습니다</span>`
          : ` · 샘플링 FWHM ${fmt(sfw, 3)} binned px`)
        : "";
      const byTxt = { spot: "스팟 크기 기준", cap: "상한 규칙", fallback: "1차 피팅 실패 → 상한 규칙" }[fit.binChosenBy] || "";
      back.querySelector("#cb-beam-status").innerHTML = `피팅 완료 — ${W0}×${H0}px (${f}× 비닝<span class="muted">, ${esc(byTxt)}` +
        (isFinite(fit.binFwhmFullPx) ? ` · 추정 원해상도 FWHM ${fmt(fit.binFwhmFullPx, 3)} px` : "") + `</span>) · R²(ROI)=${fmt(fit.r2, 4)}` + sfwHtml +
        depthNote +
        (nSatFull > 0 ? ` · <span class="tag-Low">포화 ${nSatFull}px 원해상도에서 제외</span>` : "") +
        (nAnnRaw > 0 ? ` · <span style="color:var(--s4)">측정 주석(원/선/텍스트) ${nAnnRaw}px 자동 제거</span>` : "") +
        (fit.nStreakCols > 0 ? ` · <span style="color:var(--s7)">세로 잔광(판독 스미어) ${fit.nStreakCols}열 보정</span>` : "") +
        (fit.nStreakRows > 0 ? ` · <span style="color:var(--s7)">가로 잔광 ${fit.nStreakRows}행 보정</span>` : "") +
        (fit.nGhosts > 0 ? ` · <span style="color:var(--s5)">원거리 반사광 blob ${fit.nGhosts}개 제외</span>` : "") +
        (fit.nNear > 0 ? ` · <span style="color:var(--s5)">주 빔에 붙은 근접 반사 ${fit.nNear}개 분리 제거</span>` : "") +
        (fit.nClip > 0 ? ` · <span style="color:var(--s7)">residual 이상픽셀 ${fit.nClip}px 제외</span>` : "") +
        (fit.nSat > 0 ? ` · <span class="tag-Low">포화 픽셀 ${fit.nSat}개 제외</span>` : "") +
        (gam !== 1 ? ` · <span class="tag-High">표시 감마 γ=${fmt(gam, 3)} 되돌림 (피팅은 선형화 값 기준)</span>` : "") +
        integrityHtml(integrity, W0);
      upd();
    } catch (err) {
      back.querySelector("#cb-beam-status").innerHTML = `<span class="tag-Poor">실패: ${esc(err.message)}</span>`;
    }
    e.target.value = "";
  });
  back.querySelector("#cb-export-session").addEventListener("click", () => { upd(); exportCalibSession(); });
  back.querySelector("#cb-close").addEventListener("click", () => { upd(); refreshLensUI = null; back.remove(); if (App.activeId) renderAll(); });
  refreshCalibUI();
}
/* PHASE 8 — 설계 확정본 §4 항목2·4 업그레이드: 이 PC에서 확보한 보정 세션(측정쌍·계수·
 * 빔 이미지 피팅 결과)을 JSON로 내보내 INNO Ledger의 보정 세션 CRUD에 "가져오기"할 수 있게
 * 한다. App.calib 전체를 그대로 덤프하지 않고 이렇게 필드를 하나씩 골라 담는 이유는 Phase 7에서
 * 발견한 자격정보 유출 버그(exportPowerJson가 App.calib를 통째로 내보내면서 ledger.apiKey/uid도
 * 같이 나갈 뻔했던 것)를 애초에 재현하지 않기 위해서다 — App.calib.ledger/session는 이 함수가
 * 아예 읽지 않는다. beam.preview(빔 이미지 히트맵 원본, 수백 KB~수 MB일 수 있음)는 밀도 계산에
 * 필요 없으므로 제외한다 — 필요한 것은 이미 절대 µm 단위로 계산된 metrics뿐이다. */
function exportCalibSession() {
  const c = App.calib;
  const cc = calibCoefficient();
  if (!isFinite(cc.C) && !c.metrics) {
    toast("내보낼 보정값이 없습니다 — 1단계 측정쌍이나 2단계 빔 이미지를 먼저 입력하세요", 3600);
    return;
  }
  const o = c.objSel >= 0 && c.objectives ? c.objectives[c.objSel] : null;
  const payload = {
    kind: "inno_prism_beam_calib",
    exportedAt: new Date().toISOString(),
    lambdaNm: isFinite(Number(c.lambdaNm)) ? Number(c.lambdaNm) : null,
    lens: o ? { maker: o.maker || "", model: o.model || "", mag: isFinite(Number(o.mag)) ? Number(o.mag) : null,
      na: isFinite(Number(o.na)) ? Number(o.na) : null, medium: o.medium || "air" } : null,
    pairs: (c.pairs || []).filter((q) => isFinite(q.pm) && q.pm > 0 && isFinite(q.end) && q.end > 0),
    coefficient: isFinite(cc.C) ? cc.C : null,
    cameraPitch: isFinite(Number(c.cameraPitch)) ? Number(c.cameraPitch) : null,
    // v3.9 — 스케일 출처를 기록에 남긴다. 계산값(pitch/배율)은 경통렌즈·C-mount 배율을
    // 모르므로, 나중에 이 파일만 보고도 어느 쪽이었는지 알 수 있어야 한다.
    umPerPxMeasured: isFinite(Number(c.umPerPxMeasured)) ? Number(c.umPerPxMeasured) : null,
    umPerPxNominal: isFinite(calibNominalUmPerPx()) ? calibNominalUmPerPx() : null,
    umPerPxUsed: isFinite(calibEffUmPerPx()) ? calibEffUmPerPx() : null,
    umPerPxSource: (isFinite(Number(c.umPerPxMeasured)) && Number(c.umPerPxMeasured) > 0) ? "measured" : "nominal",
    // v3.11 — 되돌린 표시 감마. 1 이면 보정하지 않은 것. 이 값 없이는 아래 빔 수치를
    // 재현할 수 없으므로 반드시 함께 기록한다.
    displayGamma: (isFinite(Number(c.displayGamma)) && Number(c.displayGamma) > 1) ? Number(c.displayGamma) : 1,
    // v3.13 — 이 빔이 어느 dichroic·채널의 것인지. 이것 없이는 면적값을 다른 채널에
    // 잘못 쓰는 것을 나중에 확인할 방법이 없다.
    // v3.16 — 촬영측 감마. 되돌리기 값(displayGamma)과 짝으로 있어야 재현이 된다.
    captureGamma: isFinite(Number(c.captureGamma)) && Number(c.captureGamma) > 0 ? Number(c.captureGamma) : null,
    dichroic: c.dichroic || null,
    beamChannel: c.beamChannel || null,
    areaBasis: c.areaBasis, areaBasisUsed: (calibBasisSigma() || {}).src || null,
    densityMode: c.densityMode,
    beam: c.beam ? {
      sx: c.beam.sx, sy: c.beam.sy, theta: c.beam.theta, binFactor: c.beam.binFactor || 1,
      r2: c.beam.r2, nSat: c.beam.nSat, nNear: c.beam.nNear, nClip: c.beam.nClip,
      // v3.15 — 비닝 배수를 **어떤 근거로** 골랐는지. 이것 없이는 같은 파일의 두 세션이
      // 왜 다른 면적을 냈는지 나중에 알 수 없다 (v3.13 provenance 원칙).
      binChosenBy: c.beam.binChosenBy || null,
      binCap: c.beam.binCap ?? null,
      sampledFwhmPx: isFinite(c.beam.sampledFwhmPx) ? c.beam.sampledFwhmPx : null,
      binFwhmFullPx: isFinite(c.beam.binFwhmFullPx) ? c.beam.binFwhmFullPx : null,
      nSatFull: c.beam.nSatFull ?? null,
      // v3.17 — 8-bit canvas 로 읽었는지 16-bit TIFF 를 직접 읽었는지. 같은 파일이라도
      // 경로에 따라 면적이 20% 이상 달라지므로 기록 없이는 재현할 수 없다.
      source: c.beam.source || null,
      d4sAreaRatio: c.beam.d4sAreaRatio ?? null,
      enclosedRatio: c.beam.enclosedRatio ?? null,          // curve of growth (core 밖 빛)
      growthRadiusSigma: c.beam.growthRadiusSigma ?? null,
      /* v3.17.1 — 반경을 함께 남긴다. kσ 만 적어 두면 **다른 적합과 비교할 수 없다** —
       * 조리개가 적합된 σ 에 비례하므로 같은 kσ 라도 물리 반경이 다르다. */
      growth: Array.isArray(c.beam.growth) ? c.beam.growth.map((q) => ({
        kSigma: q.kSigma, ratio: q.ratio,
        rPx: isFinite(q.R) ? q.R : null,
        rUm: isFinite(q.R) && isFinite(calibEffUmPerPx()) ? q.R * calibEffUmPerPx() * (c.beam.binFactor || 1) : null,
      })) : null,
      // v3.10 — 이 파일의 숫자를 나중에 신뢰할 수 있는지 판단할 근거를 같이 남긴다.
      integrity: c.beam.integrity ? {
        upscaleL: c.beam.integrity.upscale?.ok ? c.beam.integrity.upscale.L : null,
        upscaleFactor: c.beam.integrity.upscale?.ok ? c.beam.integrity.upscale.factor : null,
        linearity: c.beam.integrity.linearity?.ok ? c.beam.integrity.linearity.verdict : "unknown",
        linearitySlope: c.beam.integrity.linearity?.ok ? c.beam.integrity.linearity.b : null,
        linearityR2: c.beam.integrity.linearity?.ok ? c.beam.integrity.linearity.r2 : null,
        clean: !!c.beam.integrity.clean,
        // v3.16 — "통과"와 "적용 안 됨"을 나중에 파일만 보고도 구분할 수 있어야 한다
        verified: c.beam.integrity.verified || null,
        notApplicable: Array.isArray(c.beam.integrity.notes)
          ? c.beam.integrity.notes.map((n) => n.kind) : null,
        action: c.beam.integrity.action || null,
      } : null,
    } : null,
    metrics: c.metrics || null,
  };
  downloadText(`inno_prism_beam_calib_${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(payload, null, 2), "application/json");
  toast(c.metrics
    ? "보정 세션을 내보냈습니다(계수+빔 면적 포함) — INNO Ledger의 보정 탭 \"가져오기\"로 불러오세요"
    : "보정 세션을 내보냈습니다(계수만 — 빔 이미지를 아직 피팅하지 않음) — INNO Ledger의 보정 탭 \"가져오기\"로 불러오세요", 4500);
}

/* --------------------------- power scan view (PrismFit 2) ----------------- */
function getLoaded(rec) {
  const key = rec.det.type === "power_emccd" ? `loaded:${App.settings.bandMin}-${App.settings.bandMax}` : "loaded";
  if (rec.cache[key]) return rec.cache[key];
  let loaded;
  if (rec.det.type === "power_apd") {
    if (!rec.cache.rawAPD) rec.cache.rawAPD = PrismH5.extractPowerScanAPD(rec.h5, rec.det);
    loaded = PrismEngine.buildLoadedFromAPD(rec.cache.rawAPD.count2D, rec.cache.rawAPD.power2D);
  } else {
    if (!rec.cache.rawEMCCD) rec.cache.rawEMCCD = PrismH5.extractPowerScanEMCCD(rec.h5, rec.det);
    const r = rec.cache.rawEMCCD;
    loaded = PrismEngine.buildLoadedFromEMCCD(r.spectra, r.power2D, r.wls, App.settings.bandMin, App.settings.bandMax);
  }
  rec.cache[key] = loaded;
  return loaded;
}
function getPATrace(rec) {
  const key = rec.det.type === "power_emccd" ? `patrace:${App.settings.bandMin}-${App.settings.bandMax}` : "patrace";
  if (rec.cache[key] !== undefined) return rec.cache[key];
  let tr = null;
  try { tr = PrismH5.extractPATrace(rec.h5, rec.det.type, App.settings.bandMin, App.settings.bandMax, rec.det); } catch (e) {}
  rec.cache[key] = tr;
  return tr;
}
function branchForSettings(loaded, rec) {
  const branches = PrismEngine.splitBranches(loaded);
  let name = App.settings.branch;
  if (name === "down" && !branches.down) name = "up";
  let branch = name === "all" ? branches.all : name === "down" ? branches.down : branches.up;
  let agg = "mean";
  if (App.settings.aggMode !== "mean" && rec) {
    const tr = getPATrace(rec);
    if (tr) {
      try {
        branch = PrismFit.paHighStateBranch(tr.P, tr.I, tr.W, name === "all" ? "all" : name,
          { Iraw: tr.Iraw || null, acqTime: tr.acqTime, counting: !!tr.counting });
        agg = "high";
      } catch (e) { /* fall back to mean */ }
    }
  }
  return { branches, branch, effName: name, agg };
}
function analysisKey() {
  const s = App.settings;
  return ["a26", s.branch, s.aggMode || "high", s.monotone ? 1 : 0, s.lambdaFactor, s.bandMin, s.bandMax].join("|");
}
function currentAnalysis(rec) { return rec.cache[analysisKey()]; }
/** v2.9 — 히스테리시스는 두 branch의 전환 파워 차이다. 같은 설정으로 이미 분석된 반대 branch가
 *  캐시에 있으면 그걸 쓴다(없으면 표시하지 않는다 — 없는 값을 추정하지 않는다). */
function counterpartAnalysis(rec, branchName) {
  if (!rec || !rec.cache) return null;
  const parts = analysisKey().split("|");
  parts[1] = branchName;
  const a = rec.cache[parts.join("|")];
  return a && a.bistable ? a : null;
}
/** v3.6 — 열려 있는 **모든 파일의 두 branch**에서 bistable 적합을 모은다.
 *  이미 분석돼 캐시에 있는 것만 쓴다 — 없는 값을 몰래 계산하지 않는다. */
function collectBistables() {
  const parts = analysisKey().split("|");
  const out = [], labels = [];
  for (const rec of App.files) {
    if (!rec || !rec.cache) continue;
    for (const br of ["up", "down"]) {
      parts[1] = br;
      const a = rec.cache[parts.join("|")];
      if (a && a.bistable) { out.push(a.bistable); labels.push((rec.name || "?") + " / " + br); }
    }
  }
  return { bistables: out, labels };
}
function hysteresisOf(rec, a) {
  if (!a || !a.bistable || !isFinite(a.bistable.logPSwitch)) return null;
  const me = a._branchUsed;
  if (me !== "up" && me !== "down") return null;
  const other = counterpartAnalysis(rec, me === "up" ? "down" : "up");
  if (!other || !isFinite(other.bistable.logPSwitch)) return null;
  const up = me === "up" ? a.bistable : other.bistable;
  const dn = me === "up" ? other.bistable : a.bistable;
  const dec = up.logPSwitch - dn.logPSwitch;
  return { dec, ratio: Math.pow(10, dec), pUp: up.pSwitch, pDown: dn.pSwitch };
}

function renderPowerScan(rec) {
  const isEmccd = rec.det.type === "power_emccd";
  const s = App.settings;
  $("#view").innerHTML = `
  ${calibChannelBannerHtml(rec)}
  <div class="panel">
    <div class="controls-row">
      <label class="ctl"><span>분석 branch</span>
        <select id="c-branch">
          <option value="up">up (증가 구간)</option><option value="down">down (감소 구간)</option><option value="all">all (전체)</option>
        </select></label>
      <label class="ctl"><span>스플라인 스무딩</span>
        <select id="c-lambda"><option value="1">자동 (GCV)</option><option value="3">부드럽게 ×3</option><option value="10">부드럽게 ×10</option><option value="0.3">민감하게 ×0.3</option></select></label>
      <label class="ctl" title="물리적으로 강도는 파워에 대해 비감소 — 스플라인에 단조 제약 적용"><span>단조 제약</span>
        <select id="c-mono"><option value="1">적용 (권장)</option><option value="0">해제</option></select></label>
      <label class="ctl" title="bistable 발광에서 setpoint별 반복측정은 저상태/고상태로 갈라짐 — 혼합 평균은 물리적 점이 아님. 논문 표준은 고상태(max) envelope"><span>replicate 집계</span>
        <select id="c-agg"><option value="high">고상태 max (논문 표준)</option><option value="mean">평균 (전통)</option></select></label>
      ${isEmccd ? `
      <label class="ctl"><span>적분 파장 min (nm)</span><input id="c-bandmin" type="number" step="1" value="${s.bandMin}"></label>
      <label class="ctl"><span>적분 파장 max (nm)</span><input id="c-bandmax" type="number" step="1" value="${s.bandMax}"></label>
      <button id="c-bandapply" class="small">적분범위 적용</button>` : ""}
      <label class="ctl" id="c-unit-wrap" style="display:${densityActive() ? "" : "none"};"><span>X축 단위</span>
        <select id="c-unit"><option value="W">W (원시)</option><option value="density">파워밀도 (자동 단위)</option></select></label>
      <button id="c-refit" class="primary">다시 피팅</button>
      <span class="ctl-global" title="branch · 스무딩 · 단조 제약 · 집계${isEmccd ? " · 적분 파장" : ""}은 열린 모든 파일에 함께 적용됩니다">모든 파일 공통 설정</span>
    </div>
  </div>
  <div class="panel pa-head" id="pa-headline" aria-live="polite"><div class="muted small">분석 중…</div></div>
  ${isEmccd ? `<div class="panel"><h3>EMCCD 스펙트럼 미리보기 <span class="muted small">(replicate 평균 · 회색 영역 = 적분범위)</span></h3>
    <div class="flex small" style="margin-bottom:6px;">
      <span>표시할 측정점:</span>
      <input id="spec-idx" type="range" min="0" max="1" value="0" style="flex:1;max-width:340px;">
      <span id="spec-idx-label" class="mono"></span>
    </div>
    <div id="chart-spec" class="chart chart-short"></div></div>` : ""}
  <div class="panel">
    <div class="flex"><h3 style="margin:0;">Log–Log Power Dependence <span id="fit-status" class="muted small"></span></h3>
      <span class="right flex small"><span id="m-out" class="mono small"></span>
        <details class="exp-menu"><summary>내보내기</summary><div class="exp-pop" role="menu">
          <button id="ex-png" class="small">그래프 PNG</button>
          <button id="ex-slope-png" class="small">기울기 곡선 PNG</button>
          <button id="ex-csv" class="small">데이터 + 피팅 CSV</button>
          <button id="ex-json" class="small">전체 결과 JSON</button>
          <button id="ex-copy" class="small">요약 복사</button>
        </div></details></span></div>
    <div class="chips" id="layer-chips">
      <span class="chip-grp">표시</span>
      <button class="chip" data-layer="segpa" title="SegPA: PA regime 구간(연한 띠)·Ith 브래킷(진한 띠)·PA 값">SegPA regime</button>
      <button class="chip" data-layer="fit" title="선택된 파라메트릭 모델 곡선">피팅 곡선</button>
      <button class="chip" data-layer="pa" title="최대 기울기 지점의 접선 — 접선이 데이터의 급경사와 겹치면 잘 맞은 것">PA 위치</button>
      <button class="chip" data-layer="ith" title="문턱 파워 I_th 와 포화 파워 P_sat 세로선">I_th 위치</button>
      <button class="chip" data-layer="resid" title="아래쪽 residual 패널 (dex) + ±1σ/±3σ 밴드">residual 패널</button>
      <button class="chip" data-layer="excluded" title="이상치로 제외된 점(X)과 전선 spread로 유지된 점(◇)">제외/전선점</button>
      <button class="chip" data-layer="bistable" title="bistable 서술: 저상태·고상태 두 멱법칙과 전환 파워 (이 서술이 더 지지될 때만 나타남)">bistable 곡선</button>
      <button class="chip" data-layer="blink" title="반복 측정이 계수통계보다 크게 흩어진 setpoint — 두 상태 사이를 점멸한 지점">점멸 setpoint</button>
      <button class="chip" data-layer="other" title="반대 branch (up↔down) 를 함께 표시 — 기본은 분석 대상 branch 만 보입니다">반대 branch</button>
      <span class="chip-sep"></span><span class="chip-grp">보기</span>
      <button class="chip" data-layer="norm" title="세로축을 I/모델 비율로 — 3 decade 축에서 숨는 오차가 전부 드러난다">정규화 뷰</button>
      <button class="chip" data-layer="weights" title="점 크기 ∝ 유효 가중치 — 곡선이 실제로 무엇에 맞춰졌는지">가중치 크기</button>
      <button class="chip" data-layer="spline" title="비모수 P-spline 교차검증 곡선">P-spline</button>
      <button class="chip" data-layer="envelope" title="고상태 max envelope (실제 집계가 일어난 파일에서만)">고상태 envelope</button>
      <span class="chip-sep"></span><span class="chip-grp">도구</span>
      <button class="chip" data-layer="manual" title="반투명 윈도우의 양쪽 끝을 드래그해 범위 조절 — 윈도우 내 최좌·최우 점을 이은 코드 기울기">수동 기울기</button>
    </div>
    <div id="chart-power" class="chart" style="height:430px;"></div>
  </div>
  <div class="panel">
    <h3>국소 기울기 곡선 s(P) = d log I / d log P <span class="muted small">— 비선형성의 전체 프로파일</span></h3>
    <div id="chart-slope" class="chart" style="height:330px;"></div>
  </div>
  <details class="panel fold" data-fold="segpa"${foldOpen("segpa") ? " open" : ""}><summary><h3>SegPA 구간 상세 <span class="muted small">— ${PrismFit.SEGPA_VERSION} · up/down 원자료 · regime 전체</span></h3></summary><div id="segpa-results"><div class="muted">분석 중…</div></div></details>
  <details class="panel fold" data-fold="fit"${foldOpen("fit") ? " open" : ""}><summary><h3>PrismFit 2.2 상세 <span class="muted small">— 모델 기반 결과 (참고)</span> <span id="fit-sum" class="fold-sum"></span></h3></summary><div id="fit-results"><div class="muted">피팅 중…</div></div></details>
  <div class="panel">
    <div class="flex">
      <h3 style="margin:0;">불확도 진단 (전체 파이프라인 부트스트랩)</h3>
      <span class="small muted">시드 고정 → 완전 재현 · 분산모델/모델선택까지 재실행하는 정직한 CI</span>
      <span class="right flex">
        <label class="ctl"><span>Bootstrap 횟수</span><input id="c-bootn" type="number" min="50" max="500" step="10" value="${s.bootstrapN}"></label>
        <button id="c-diag" class="primary">진단 실행</button>
      </span>
    </div>
    <div id="diag-results" class="small muted" style="margin-top:8px;">진단은 요청 시에만 실행됩니다 (수십 초). 실행 후 s_max·임계값에 95% CI가 붙고 기울기 곡선에 신뢰 밴드가 표시됩니다.</div>
  </div>
`;

  $("#c-branch").value = s.branch;
  $("#c-lambda").value = String(s.lambdaFactor ?? 1);
  $("#c-mono").value = s.monotone === false ? "0" : "1";
  $("#c-agg").value = s.aggMode === "mean" ? "mean" : "high";

  const rerun = () => {
    s.branch = $("#c-branch").value;
    s.lambdaFactor = Number($("#c-lambda").value) || 1;
    s.monotone = $("#c-mono").value === "1";
    s.aggMode = $("#c-agg").value;
    saveSettings();
    runPowerAnalysis(rec, true);
  };
  ["c-branch", "c-lambda", "c-mono", "c-agg"].forEach((id) => $("#" + id).addEventListener("change", rerun));
  $("#c-refit").addEventListener("click", () => runPowerAnalysis(rec, true));
  if (isEmccd) {
    $("#c-bandapply").addEventListener("click", () => {
      s.bandMin = Number($("#c-bandmin").value); s.bandMax = Number($("#c-bandmax").value);
      saveSettings(); renderEmccdSpecPreview(rec); runPowerAnalysis(rec, true);
    });
    renderEmccdSpecPreview(rec);
  }
  const unitSel = $("#c-unit");
  if (unitSel) {
    unitSel.value = densityActive() ? s.xUnit : "W";
    unitSel.addEventListener("change", () => {
      s.xUnit = unitSel.value;
      saveSettings();
      renderPowerScan(rec);
    });
  }
  // ---- v2.6 레이어 칩 ----
  const syncChips = () => {
    const L = layers();
    document.querySelectorAll("#layer-chips .chip").forEach((b) => {
      const key = b.dataset.layer;
      const on = key === "manual" ? !!rec.cache.manualOn : !!L[key];
      b.classList.toggle("on", on);
      if (key === "envelope") {
        const a = currentAnalysis(rec);
        b.style.display = (a && a.aggEffective === "max-of-N") ? "" : "none";
      }
    });
  };
  document.querySelectorAll("#layer-chips .chip").forEach((b) => {
    b.addEventListener("click", () => {
      const key = b.dataset.layer;
      if (key === "manual") { toggleManual(rec); } else {
        const L = layers();
        L[key] = !L[key];
        saveSettings();
        refreshPowerView(rec);
      }
      syncChips();
    });
  });
  rec.cache._syncChips = syncChips;
  syncChips();
  const toggleManual = (r) => {
    r.cache.manualOn = !r.cache.manualOn;
    if (r.cache.manualOn && !r.cache.manualRange) {
      // 기본 윈도우: x 범위 중앙 40%
      try {
        const a = currentAnalysis(r);
        const xs = a ? a.data.P : branchForSettings(getLoaded(r), r).branch.powerAvg;
        const lo = Math.min(...xs), hi = Math.max(...xs);
        const llo = Math.log10(lo), lhi = Math.log10(hi);
        r.cache.manualRange = { lo: Math.pow(10, llo + 0.3 * (lhi - llo)), hi: Math.pow(10, llo + 0.7 * (lhi - llo)) };
      } catch (e) { r.cache.manualOn = false; }
    }
    refreshPowerView(r);
  };
  document.querySelectorAll("#view details.fold").forEach((d) => d.addEventListener("toggle", () => { App.ui.fold[d.dataset.fold] = d.open; }));
  const em = document.querySelector("#view .exp-menu");
  if (em) em.addEventListener("click", (e) => { if (e.target.closest(".exp-pop button")) em.open = false; });
  $("#c-diag").addEventListener("click", () => runDiagnosticsUI(rec));
  $("#ex-png").addEventListener("click", () => exportChartPng(rec, "#chart-power", "_powerfit"));
  $("#ex-slope-png").addEventListener("click", () => exportChartPng(rec, "#chart-slope", "_slope"));
  $("#ex-csv").addEventListener("click", () => exportPowerCsv(rec));
  $("#ex-json").addEventListener("click", () => exportPowerJson(rec));
  $("#ex-copy").addEventListener("click", () => copySummary(rec));
  runPowerAnalysis(rec, false);
}

async function runPowerAnalysis(rec, force) {
  try { renderSegPA(rec); } catch (e) { const s0 = document.getElementById("segpa-results"); if (s0) s0.innerHTML = `<div class="tag-Poor">SegPA 실패: ${esc(e.message)}</div>`; }
  // SegPA 는 수 ms 라 PrismFit(수 초~수십 초)을 기다리지 않고 원자료 + regime 을 먼저 그린다.
  if (!rec.cache[analysisKey()]) { try { const ld = getLoaded(rec); drawPowerChart(rec, ld, branchForSettings(ld, rec).branches, null); } catch (e) {} }
  const key = analysisKey();
  const status = $("#fit-status");
  try {
    const loaded = getLoaded(rec);
    const { branches, branch, effName, agg } = branchForSettings(loaded, rec);
    if (rec.cache[key] && !force) {
      if (status) status.textContent = `완료 (캐시 · branch=${effName} · scan=${branches.scanMode})`;
      drawPowerChart(rec, loaded, branches, rec.cache[key]);
      drawSlopeChart(rec, rec.cache[key]);
      renderFitResults(rec, rec.cache[key]);
      if (rec.cache._syncChips) rec.cache._syncChips();
      return;
    }
    const pendingKey = "pending:" + key;
    if (rec.cache[pendingKey] && !force) return;
    if (status) status.textContent = "피팅 중…";
    const t0 = performance.now();
    rec.cache[pendingKey] = true;
    let analysis;
    try {
      analysis = await rpc("analyze2", {
        branch,
        options: { monotone: App.settings.monotone !== false, lambdaFactor: App.settings.lambdaFactor || 1,
          paTrace: getPATrace(rec) || undefined,
          // v3.2 — cross-branch occupancy는 지금 보는 branch가 무엇인지 알아야 계산된다
          branchName: effName },
      });
    } finally { delete rec.cache[pendingKey]; }
    analysis._branchUsed = effName;
    analysis._aggUsed = agg;
    analysis._elapsedMs = performance.now() - t0;
    analysis.quality = PrismFit.evaluate(analysis, null);
    rec.cache[key] = analysis;
    if (App.activeId !== rec.id) return;
    if (status) status.textContent = `완료 (${(analysis._elapsedMs / 1000).toFixed(1)}s · branch=${effName} · scan=${branches.scanMode} · PrismFit ${analysis.version})`;
    drawPowerChart(rec, loaded, branches, analysis);
    drawSlopeChart(rec, analysis);
    renderFitResults(rec, analysis);
    if (rec.cache._syncChips) rec.cache._syncChips();
  } catch (e) {
    if (status) status.textContent = "";
    const fr = $("#fit-results");
    if (fr) fr.innerHTML = `<div class="tag-Poor">피팅 실패: ${esc(e.message)}</div>`;
    try {
      const loaded = getLoaded(rec);
      const { branches } = branchForSettings(loaded);
      drawPowerChart(rec, loaded, branches, null);
    } catch (e2) {}
  }
}

function refreshPowerView(rec) {
  try {
    const loaded = getLoaded(rec);
    const branches = branchForSettings(loaded, rec).branches;
    const a = currentAnalysis(rec) || null;
    drawPowerChart(rec, loaded, branches, a);
    if (a) drawSlopeChart(rec, a);
  } catch (e) { /* view not ready */ }
}

/** 범위 내 최좌/최우 점 코드 기울기 + 참고 LSQ 기울기 (raw W 단위 범위) */
function computeManualSlope(rec) {
  const mr = rec.cache.manualRange;
  if (!mr) return null;
  const a = currentAnalysis(rec);
  let xs, ys;
  if (a && a.data) { xs = a.data.P; ys = a.data.I; }
  else {
    try {
      const { branch } = branchForSettings(getLoaded(rec), rec);
      xs = branch.powerAvg; ys = branch.intensityAvg;
    } catch (e) { return null; }
  }
  const pts = [];
  for (let i = 0; i < xs.length; i++) {
    if (isFinite(xs[i]) && isFinite(ys[i]) && xs[i] > 0 && ys[i] > 0 && xs[i] >= mr.lo && xs[i] <= mr.hi) pts.push([xs[i], ys[i]]);
  }
  if (pts.length < 2) return { n: pts.length };
  pts.sort((p, q) => p[0] - q[0]);
  const L = pts[0], R = pts[pts.length - 1];
  const chord = (Math.log10(R[1]) - Math.log10(L[1])) / (Math.log10(R[0]) - Math.log10(L[0]));
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const [px, py] of pts) {
    const lx = Math.log10(px), ly = Math.log10(py);
    sx += lx; sy += ly; sxx += lx * lx; sxy += lx * ly;
  }
  const nn = pts.length;
  const lsq = (nn * sxy - sx * sy) / Math.max(nn * sxx - sx * sx, 1e-30);
  return { n: nn, L, R, chord, lsq };
}

/* ---------------------------------------------------------------------------
 * v2.6 뷰어 (V1–V7)
 * 기본 화면은 "데이터 + 피팅 곡선 + PA 위치 + I_th 위치 + residual" 다섯 가지뿐이다.
 * 고상태 envelope / P-spline / 부트스트랩 밴드 / 가중치 표시는 칩으로 켤 때만 그린다.
 * PA 는 기울기이므로 점이 아니라 접선 선분으로 그린다 — 접선이 데이터의 실제 급경사와
 * 겹치는지가 눈으로 바로 보이는 피팅 검증이 된다.
 * ------------------------------------------------------------------------- */
// v3.8 — 기본값을 **최소**로 바꿨다. 좁은 화면에서 라벨이 겹치고 한눈에 안 들어온다는
// 문제가 실제로 있었다. 기본은 "타겟 branch 데이터 + 피팅 곡선 + I_th + PA 위치" 뿐이고,
// residual·제외점·bistable·점멸·반대 branch 는 칩을 눌러 켠다.
const LAYER_DEFAULTS = {
  segpa: true, fit: true, pa: true, ith: true,
  resid: false, excluded: false, bistable: false, blink: false, other: false,
  envelope: false, spline: false, weights: false, bootband: false, norm: false,
};
function layers() {
  const L = Object.assign({}, LAYER_DEFAULTS, App.settings.layers || {});
  App.settings.layers = L;
  return L;
}
/** 모델 곡선의 정확한 값 (격자 보간이 아니라 파라미터에서 직접) */
function modelAt(analysis, xv) {
  try { return PrismFit.modelI(analysis.params, xv, analysis.chosenOrder); } catch (e) { return NaN; }
}
/** 사용점 기준 dex residual와 ±1σ 폭 */
function residualsOf(analysis) {
  const d = analysis.data, out = [];
  for (let i = 0; i < d.x.length; i++) {
    const m = modelAt(analysis, d.x[i]);
    if (!(isFinite(m) && m > 0 && isFinite(d.I[i]))) continue;
    const Ii = Math.max(d.I[i], 1e-300);
    out.push({
      i, P: d.P[i], x: d.x[i], I: d.I[i],
      r: Math.log10(Ii) - Math.log10(m),
      s: d.sigI[i] / (Math.LN10 * Math.max(Ii, 1e-300)),
      used: analysis.mask ? !!analysis.mask[i] : true,
      ratio: d.I[i] / m,
    });
  }
  return out;
}
/** 연속 3점 이상 같은 부호로 2σ 초과 — 모델이 따라가지 못하는 구간 */
function misfitRuns(res) {
  const runs = [];
  let cur = null;
  for (const p of res) {
    const bad = p.used && isFinite(p.s) && p.s > 0 && Math.abs(p.r) > 2 * p.s;
    const sign = p.r > 0 ? 1 : -1;
    if (bad && cur && cur.sign === sign) { cur.hi = p.x; cur.n++; }
    else if (bad) { if (cur && cur.n >= 3) runs.push(cur); cur = { lo: p.x, hi: p.x, sign, n: 1 }; }
    else { if (cur && cur.n >= 3) runs.push(cur); cur = null; }
  }
  if (cur && cur.n >= 3) runs.push(cur);
  return runs;
}

/* ---------------------------------------------------------------------------
 * v3.18 — SegPA 1.0 (PA regime · Ith · PA 헤드라인 · 주 상승 기울기)
 * 원자료 up/down 분지에 직접 적용한다(고상태 envelope·스플라인·파라메트릭 모델과 독립).
 * 검증: 288 스캔 Python 기준 구현과 576/576 분지 동일(tests/test_segpa_parity.mjs),
 *       연구원 블라인드 판정 40건(Ith |Δ| 중위 0.012 dec, PA ±25% 이내 79%, "아니오" 5/5 regime 없음).
 * 분류: 헤드라인 PA ≥ 5 → "PA", 미만 → "S-bend(약한 비선형)" — 연구원 결정(2026-09-27).
 * ------------------------------------------------------------------------- */
function segpaFor(rec, name) {
  const key = `segpa|${name}|${App.settings.bandMin}|${App.settings.bandMax}`;
  if (rec.cache[key] !== undefined) return rec.cache[key];
  let out = null;
  try {
    const branches = PrismEngine.splitBranches(getLoaded(rec));
    const br = name === "down" ? branches.down : branches.up;
    if (!br) { rec.cache[key] = null; return null; }
    // down 분지는 최대 파워점을 up 과 공유한다 — 검증과 같게 down 에서는 그 점을 뺀다.
    const off = name === "down" ? 1 : 0;
    const P = br.powerAvg.slice(off);
    const reps = br.intensityReplicates ? br.intensityReplicates.slice(off) : null;
    const hasReps = !!reps && reps.some((r) => r && r.filter((v) => Number.isFinite(v)).length >= 2);
    let data;
    if (hasReps) data = { reps };
    else {
      const I = br.intensityAvg.slice(off);
      const tr = getPATrace(rec);
      const t = tr && tr.counting && tr.acqTime > 0 ? tr.acqTime : NaN;   // 광자 계수: Poisson SE = √(I·t)/t
      data = { I, se: I.map((v) => (Number.isFinite(t) ? Math.sqrt(Math.max(v * t, 1)) / t : Math.sqrt(Math.max(v, 1)))) };
    }
    out = PrismFit.segPA(P, data);
    out._branch = name;
  } catch (e) { out = { error: String((e && e.message) || e), regimes: [] }; }
  rec.cache[key] = out;
  return out;
}
function segpaSelectedName(rec) {
  let name = App.settings.branch === "down" ? "down" : "up";
  if (name === "down") { try { if (!PrismEngine.splitBranches(getLoaded(rec)).down) name = "up"; } catch (e) { name = "up"; } }
  return name;
}
function segpaFirst(sp) {            // 가장 낮은 파워의 regime = 점화
  if (!sp || !sp.regimes || !sp.regimes.length) return null;
  return sp.regimes.reduce((a, b) => (b.bracketW[0] < a.bracketW[0] ? b : a));
}
function segpaPaText(q) {
  const ge = q.status.startsWith("lower-bound") ? "≥ " : "";
  return `${ge}${fmt(q.head, 3)}`;
}
function segpaDens(w) {
  const kd = densityFactor(); if (!isFinite(kd)) return "";
  const du = activeDensityUnit(); return `${fmt(w * kd / du.div, 4)} ${du.name}`;
}
function renderSegPA(rec) {
  const el = document.getElementById("segpa-results");
  if (!el) return;
  const sel = segpaSelectedName(rec);
  const both = { up: segpaFor(rec, "up"), down: segpaFor(rec, "down") };
  const dens = densityActive();
  const rowsHtml = [];
  for (const name of ["up", "down"]) {
    const sp = both[name];
    if (!sp) continue;
    const mark = name === sel ? ' style="background:rgba(57,135,229,0.08)"' : "";
    if (sp.error) { rowsHtml.push(`<tr${mark}><td>${name}</td><td colspan="7" class="tag-Poor">실패: ${esc(sp.error)}</td></tr>`); continue; }
    if (!sp.regimes.length) { rowsHtml.push(`<tr${mark}><td>${name}</td><td colspan="7" class="muted">regime 없음 — 앞 구간 멱법칙보다 뚜렷하게(×2, +3) 가파른 구간이 없습니다</td></tr>`); continue; }
    const regs = sp.regimes.slice().sort((a, b) => a.bracketW[0] - b.bracketW[0]);
    regs.forEach((q, k) => {
      const tag = q.cls === "PA" ? `<b style="color:${PALETTE.red}">PA</b>` : `<span class="muted" title="헤드라인 PA < 5 — 약한 비선형, PA 판정 보류">S-bend</span>`;
      const br = `${fmt(q.bracketW[0], 4)} – ${fmt(q.bracketW[1], 4)} W` + (dens ? `<div class="s muted">${segpaDens(q.bracketW[0])} – ${segpaDens(q.bracketW[1])}</div>` : "");
      const main = q.main ? `${fmt(q.main.slope, 3)} <span class="muted small">(${q.main.n}점)</span>` : `<span class="muted">–</span>`;
      const st = q.status.startsWith("lower-bound") ? `하한 (${q.kind === "bridge" ? "한 간격 jump" : "2점"})` : "분해됨";
      rowsHtml.push(`<tr${mark}><td>${k === 0 ? name : ""}</td><td>${regs.length > 1 ? "#" + (k + 1) + " " : ""}${tag}</td><td class="num">${br}</td>
        <td class="num"><b>${segpaPaText(q)}</b></td><td class="num">${main}</td><td>${st}${q.status.includes("right-censored") ? " · 스캔 끝 검열" : ""}</td>
        <td class="num">${fmt(q.rise, 3)}</td><td class="num">K=${q.scale}</td></tr>`);
    });
  }
  const fu = segpaFirst(both.up), fd = segpaFirst(both.down);
  const hyst = fu && fd ? Math.sqrt(fu.bracketW[0] * fu.bracketW[1]) / Math.sqrt(fd.bracketW[0] * fd.bracketW[1]) : NaN;
  el.innerHTML = `
    <table class="res">
      <tr><th>분지</th><th>분류</th><th>Ith 브래킷</th><th>PA (헤드라인)</th><th>주 상승 기울기</th><th>상태</th><th>상승 (dec)</th><th>스케일</th></tr>
      ${rowsHtml.join("")}
    </table>
    <div class="small muted" style="margin-top:6px;line-height:1.55">
      <b>Ith 브래킷</b> = 점화 직전 마지막 점 ↔ 점화 후 첫 점. <b>PA (헤드라인)</b> = 데이터가 방어할 수 있는 가장 가파른 직선 구간의 기울기
      (≥ 는 한 간격 jump 또는 2점이라 참값이 그 이상이라는 뜻). <b>주 상승 기울기</b> = 0.7 decade 이상 오르는 가장 가파른 직선창 — jump 가 긴 상승 안에 있을 때 연구자가 자를 대는 값.
      분류: PA ≥ 5 → PA, 미만 → S-bend.
      ${isFinite(hyst) ? `<br><b>Ith↑/Ith↓</b> = ${fmt(hyst, 3)} (첫 regime 브래킷 기하평균 비 · &gt;1 쌍안정/지연형, &lt;1 광퇴색형)` : ""}
      <br>SegPA ${PrismFit.SEGPA_VERSION} · 구간 분할은 동적계획법 전역최적(국소해 없음) · 강조 행 = 현재 분석 branch
    </div>`;
  renderPaHeadline(rec);
}
/* ③ 재설계 — 결과 요약 카드. SegPA(헤드라인 방법)를 분지별로 한 줄씩, PrismFit 은 참고 한 줄.
   값은 아래 상세 표와 같은 함수(segpaFirst/segpaPaText)에서 가져온다 — 숫자를 새로 만들지 않는다. */
App.ui = App.ui || { fold: {} };
function foldOpen(k) { return !!(App.ui && App.ui.fold && App.ui.fold[k]); }
function fitWarnCount(a) {
  let n = 0;
  if ((a.boundHits || []).length) n++;
  if (a.stability && a.stability.checked && !a.stability.stable) n++;
  if (a.slopeProfile && a.slopeProfile.verdict === "unbounded") n++;
  return n;
}
function renderPaHeadline(rec) {
  const el = document.getElementById("pa-headline");
  if (!el) return;
  const sel = segpaSelectedName(rec);
  const dens = densityActive();
  const cells = [];
  for (const name of ["up", "down"]) {
    const sp = segpaFor(rec, name);
    if (!sp) continue;
    const on = name === sel;
    let body;
    if (sp.error) body = `<div class="ph-main"><span class="ph-v tag-Poor">SegPA 실패</span></div><div class="ph-s">${esc(sp.error)}</div>`;
    else if (!sp.regimes.length) body = `<div class="ph-main"><span class="ph-v ph-none">regime 없음</span></div><div class="ph-s">앞 구간보다 뚜렷하게 가파른 구간이 없습니다</div>`;
    else {
      const q = segpaFirst(sp), n = sp.regimes.length;
      const cls = q.cls === "PA" ? `<span class="ph-cls pa" title="헤드라인 PA ≥ 5">PA regime</span>` : `<span class="ph-cls sb" title="헤드라인 PA < 5 — 약한 비선형, PA 판정 보류">S-bend</span>`;
      const st = (q.status.startsWith("lower-bound") ? `하한 (${q.kind === "bridge" ? "한 간격 jump" : "2점"})` : "분해됨") + (q.status.includes("right-censored") ? " · 스캔 끝 검열" : "");
      body = `<div class="ph-main"><span class="ph-k">PA</span><span class="ph-v">${segpaPaText(q)}</span>${cls}</div>
        <div class="ph-line"><span class="ph-k">I<sub>th</sub></span><span class="ph-v2">${fmt(q.bracketW[0], 4)} – ${fmt(q.bracketW[1], 4)} W</span></div>
        ${dens ? `<div class="ph-s">${segpaDens(q.bracketW[0])} – ${segpaDens(q.bracketW[1])}</div>` : ""}
        <div class="ph-s">${st}${n > 1 ? ` · regime ${n}개 중 첫 점화` : ""}</div>`;
    }
    cells.push(`<div class="ph-cell${on ? " on" : ""}"><div class="ph-h">${name === "up" ? "up (증가)" : "down (감소)"}${on ? ' <span class="ph-tag">분석 대상</span>' : ""}</div>${body}</div>`);
  }
  const a = currentAnalysis(rec);
  let pf;
  if (!a) pf = `<span class="muted">PrismFit 피팅 중…</span>`;
  else {
    const q = a.quality || {}, boot = a.diag, w = fitWarnCount(a);
    const ge = a.paSource === "lower-bound" || a.paGridLimited ? "≥ " : "";
    pf = `PrismFit (참고) PA <b>${a.paSource === "unresolved" ? "unidentified" : ge + fmt(a.paReport, 4)}</b>`
      + (q.band ? ` · 품질 <span class="tag-${q.band}">${q.band}</span>` : "")
      + (boot && boot.ci && boot.ci.sMax && isFinite(boot.ci.sMax[0]) ? ` · s<sub>max</sub> 95% CI [${fmt(boot.ci.sMax[0], 3)}, ${fmt(boot.ci.sMax[1], 3)}]` : "")
      + (w ? ` · <a href="#" class="ph-warn" data-openfold="fit">⚠ 경고 ${w}건</a>` : "");
  }
  el.innerHTML = `<div class="ph-grid">${cells.join("") || '<div class="muted">SegPA 결과 없음</div>'}</div>
    <div class="ph-foot">${pf}<span class="ph-more"><a href="#" data-openfold="segpa">구간 상세</a></span></div>`;
  el.querySelectorAll("[data-openfold]").forEach((x) => x.addEventListener("click", (e) => {
    e.preventDefault();
    const d = document.querySelector(`#view details.fold[data-fold="${x.dataset.openfold}"]`);
    if (d) { d.open = true; d.scrollIntoView({ behavior: "smooth", block: "start" }); }
  }));
  const fs = document.getElementById("fit-sum");
  if (fs) fs.innerHTML = a ? `${a.quality && a.quality.band ? `<span class="tag-${a.quality.band}">${a.quality.band}</span>` : ""}${fitWarnCount(a) ? ` <span class="tag-Poor">⚠ ${fitWarnCount(a)}</span>` : ""}` : "";
}
function segpaSummaryText(rec) {
  const out = [];
  for (const name of ["up", "down"]) {
    const sp = segpaFor(rec, name);
    if (!sp || sp.error) continue;
    if (!sp.regimes.length) { out.push(`SegPA ${name}: regime 없음`); continue; }
    sp.regimes.slice().sort((a, b) => a.bracketW[0] - b.bracketW[0]).forEach((q, k) => {
      out.push(`SegPA ${name}${sp.regimes.length > 1 ? " #" + (k + 1) : ""}: ${q.cls} · Ith ${fmt(q.bracketW[0], 4)}–${fmt(q.bracketW[1], 4)} W · PA ${segpaPaText(q)}` +
        (q.main ? ` · 주 상승 ${fmt(q.main.slope, 3)}` : "") + ` · ${q.status}`);
    });
  }
  return out.join("\n");
}

function drawPowerChart(rec, loaded, branches, analysis) {
  const el = $("#chart-power");
  if (!el) return;
  const L = layers();
  const k = xConv();
  const traces = [], shapes = [], annots = [];
  const up = branches.up, down = branches.down;
  const res = analysis ? residualsOf(analysis) : [];
  const showResid = !!(analysis && L.resid && res.length);
  const norm = !!(analysis && L.norm);

  // ---- 원본 데이터 (정규화 뷰에서는 I/모델 비율로) ----
  const ratioOf = (Pv, Iv) => {
    if (!analysis) return NaN;
    const m = modelAt(analysis, Math.log10(Pv));
    return isFinite(m) && m > 0 ? Iv / m : NaN;
  };
  const mkData = (br, color, label) => {
    const xs = br.powerAvg.map((v) => v * k);
    const ys = norm ? br.powerAvg.map((v, i) => ratioOf(v, br.intensityAvg[i])) : br.intensityAvg;
    const t = {
      x: xs, y: ys, mode: "markers", type: "scatter", name: label,
      marker: { size: 6.5, color, symbol: "circle", line: { width: 1, color: "#1a1a19" } },
      hovertemplate: norm ? "P=%{x:.4g}<br>I/모델=%{y:.3f}<extra>" + label + "</extra>"
        : "P=%{x:.4g}<br>I=%{y:.4g}<extra>" + label + "</extra>",
    };
    if (!norm) t.error_y = { type: "data", array: br.intensityStd, visible: true, thickness: 1, width: 2, color: color + "88" };
    return t;
  };
  // 분석 대상 branch 만 기본 표시한다. 반대 branch 는 'other' 칩으로 켠다 —
  // 두 곡선이 겹치면 점화 위치가 어느 쪽 것인지 눈으로 구분되지 않는다.
  const used = analysis && analysis._branchUsed;
  if (down) {
    const tgt = used === "down" ? down : up;
    const oth = used === "down" ? up : down;
    const tgtName = used === "down" ? "down scan" : "up scan";
    const othName = used === "down" ? "up scan" : "down scan";
    traces.push(mkData(tgt, PALETTE.blue, tgtName + " (분석 대상)"));
    if (L.other) {
      const t2 = mkData(oth, PALETTE.orange, othName);
      t2.marker.size = 5; t2.marker.color = PALETTE.orange + "99";
      traces.push(t2);
    }
  } else {
    traces.push(mkData(branches.all, PALETTE.blue, "data"));
  }

  // ---- 가중치 크기: 이 곡선이 실제로 무엇에 맞춰졌는지 ----
  if (analysis && L.weights) {
    const d = analysis.data;
    const w = d.sigG.map((sg, i) => (analysis.mask && !analysis.mask[i] ? 0 : 1 / (sg * sg)));
    const pos = w.filter((v) => v > 0);
    const lw = pos.length ? pos.map(Math.log) : [0];
    const lo = Math.min(...lw), hi = Math.max(...lw), rng = Math.max(hi - lo, 1e-9);
    traces.push({
      x: d.P.map((v) => v * k), y: norm ? d.P.map((v, i) => ratioOf(v, d.I[i])) : d.I,
      mode: "markers", type: "scatter", name: "유효 가중치 ∝ 크기",
      marker: {
        size: w.map((v) => (v > 0 ? 4 + 11 * (Math.log(v) - lo) / rng : 3)),
        color: "rgba(57,135,229,0.30)", line: { width: 0 },
      },
      hovertemplate: "P=%{x:.4g}<br>상대 가중치=%{customdata:.3g}<extra>weight</extra>",
      customdata: w.map((v) => v / Math.max(...w)),
    });
  }

  // ---- 고상태 envelope: 실제로 집계가 일어났을 때만 (E7) ----
  if (analysis && !norm && L.envelope && analysis._aggUsed === "high" && analysis.aggEffective === "max-of-N") {
    traces.push({
      x: analysis.data.P.map((v) => v * k), y: analysis.data.I,
      mode: "markers", type: "scatter", name: "고상태 envelope (피팅 데이터)",
      marker: { size: 7.5, symbol: "circle-open", color: PALETTE.aqua, line: { width: 1.6, color: PALETTE.aqua } },
      hovertemplate: "P=%{x:.4g}<br>I(high)=%{y:.4g}<extra>envelope</extra>",
    });
  }

  if (analysis) {
    const Pgrid = analysis.grid.map((xv) => Math.pow(10, xv) * k);
    // ---- 피팅 곡선 (차수는 이름이 아니라 결과 카드에서 설명한다) ----
    if (L.fit) {
      traces.push({
        x: Pgrid, y: norm ? analysis.grid.map(() => 1) : analysis.modelCurve,
        mode: "lines", type: "scatter", name: norm ? "모델 (기준선)" : "피팅 곡선",
        line: { color: PALETTE.aqua, width: 2.6, dash: norm ? "dot" : "solid" },
        hovertemplate: norm ? "<extra></extra>" : "P=%{x:.4g}<br>모델=%{y:.4g}<extra>H" + analysis.chosenOrder + "</extra>",
      });
    }
    // ---- v2.9 bistable 서술: 두 상태의 멱법칙과 전환 파워 ----
    // 이 곡선이 데이터와 겹치고 H 곡선이 어긋나면, 전선이 '가파른 매끄러운 전이'가 아니라
    // '두 상태 사이의 전환'이라는 뜻이다. 두 점근선을 함께 그려야 그 판단이 눈으로 된다.
    if (L.bistable && !norm && analysis.bistable && analysis.bistable.curve) {
      const bs = analysis.bistable;
      traces.push({
        x: Pgrid, y: bs.curve, mode: "lines", type: "scatter",
        name: "bistable 모델" + (bs.preferred ? " (더 지지됨)" : ""),
        line: { color: PALETTE.violet, width: 2.6 },
        hovertemplate: "P=%{x:.4g}<br>bistable=%{y:.4g}<extra>BS" + bs.chosenOrder + "</extra>",
      });
      const Imin = Math.max(Math.min(...analysis.data.I.filter((v) => v > 0)), 1e-300);
      const Imax = Math.max(...analysis.data.I);
      const clip = (arr) => arr.map((v) => (isFinite(v) && v >= Imin * 0.05 && v <= Imax * 20 ? v : null));
      traces.push({
        x: Pgrid, y: clip(bs.highCurve), mode: "lines", type: "scatter", name: "고상태 멱법칙",
        line: { color: PALETTE.violet, width: 1.2, dash: "dash" }, hoverinfo: "skip", showlegend: true,
      });
      if (bs.identifiability && bs.identifiability.lowVisible) {
        traces.push({
          x: Pgrid, y: clip(bs.lowCurve), mode: "lines", type: "scatter", name: "저상태 멱법칙",
          line: { color: PALETTE.blue, width: 1.2, dash: "dash" }, hoverinfo: "skip", showlegend: true,
        });
      }
      if (isFinite(bs.pSwitch)) {
        traces.push({
          x: [bs.pSwitch * k, bs.pSwitch * k], y: [Imin * 0.3, Imax * 3],
          mode: "lines", type: "scatter", name: "전환 파워 P_s",
          line: { color: PALETTE.violet, width: 1.4, dash: "dot" },
          hovertemplate: "P_s=%{x:.4g}<extra>전환 파워</extra>",
        });
      }
    }
    // ---- v3.0 점멸 setpoint: 반복이 계수통계보다 크게 흩어진 지점 ----
    // 이 점들의 평균은 어떤 매끄러운 발광 가지 위의 값이 아니라 **두 상태의 혼합**이다.
    if (L.blink && !norm && analysis.occupancy && analysis.occupancy.checked) {
      const br = analysis.occupancy.rows.filter((r) => r.blink && isFinite(r.fMean));
      if (br.length) {
        traces.push({
          x: br.map((r) => r.P * k), y: br.map((r) => r.mean),
          mode: "markers", type: "scatter", name: `점멸 setpoint (${br.length})`,
          marker: { symbol: "circle-open", size: 15, color: PALETTE.yellow, line: { width: 2.2 } },
          customdata: br.map((r) => [r.fMean, r.kappa, r.ratioAdj]),
          hovertemplate: "P=%{x:.4g}<br>평균=%{y:.4g}<br>occupancy f̂=%{customdata[0]:.3f}"
            + "<br>κ̂=%{customdata[1]:.3f}<br>분산비=%{customdata[2]:.1f}<extra>점멸</extra>",
        });
      }
    }
    // ---- P-spline: 켤 때만, 확실히 뒤로 ----
    if (L.spline && !norm) {
      const Imax = Math.max(...analysis.data.I);
      const blown = analysis.splineCurve.map((v) => !(isFinite(v) && v < 10 * Imax));
      traces.push({
        x: Pgrid, y: analysis.splineCurve.map((v, i) => (blown[i] ? null : v)),
        mode: "lines", type: "scatter", name: "P-spline (비모수)",
        line: { color: "#6b6a62", width: 1.2, dash: "dot" },
        hovertemplate: "P=%{x:.4g}<br>spline=%{y:.4g}<extra>spline</extra>",
      });
      if (blown.some(Boolean)) annots.push({
        xref: "paper", yref: "paper", x: 0.99, y: 0.02, xanchor: "right",
        text: "⚠ 스플라인 경계 발산 — 해당 구간 비표시", showarrow: false,
        font: { size: 11, color: PALETTE.red }, bgcolor: "rgba(26,26,25,0.8)", borderpad: 3,
      });
    }
    // ---- 제외점 / 전선 spread ----
    if (L.excluded && !norm) {
      const out = analysis.diagnostics.outliers || [];
      if (out.length) traces.push({
        x: out.map((i) => analysis.data.P[i] * k), y: out.map((i) => analysis.data.I[i]),
        mode: "markers", type: "scatter", name: `제외 (${out.length})`,
        marker: { size: 10, symbol: "x-thin", color: PALETTE.red, line: { width: 2, color: PALETTE.red } },
        hovertemplate: "P=%{x:.4g}<br>I=%{y:.4g}<extra>이상치 제외</extra>",
      });
      const fs = analysis.diagnostics.frontScatter || [];
      if (fs.length) traces.push({
        x: fs.map((i) => analysis.data.P[i] * k), y: fs.map((i) => analysis.data.I[i]),
        mode: "markers", type: "scatter", name: `전선 spread (${fs.length}, 유지)`,
        marker: { size: 9, symbol: "diamond-open", color: PALETTE.yellow, line: { width: 1.6, color: PALETTE.yellow } },
        hovertemplate: "P=%{x:.4g}<br>I=%{y:.4g}<extra>bistable spread — 제외하지 않음</extra>",
      });
    }
  }

  // ---- V3: I_th / P_sat 라벨 달린 세로선 ----
  const kd = densityFactor(), du = activeDensityUnit();
  // 라벨 충돌 회피: 이미 놓인 라벨과 x 가 가까우면 층(row)을 하나 내린다.
  // 좁은 화면에서 I_th·P_sat 라벨이 겹쳐 읽히지 않던 문제의 직접 원인이었다.
  const placed = [];
  const xSpanDec = (() => {
    const P = analysis ? analysis.data.P : (branches.all ? branches.all.powerAvg : null);
    if (!P || !P.length) return 1;
    const lo = Math.log10(Math.min(...P)), hi = Math.log10(Math.max(...P));
    return Math.max(hi - lo, 1e-6);
  })();
  const marker = (xv, label, color, note) => {
    if (!(isFinite(xv) && xv > 0)) return;
    shapes.push({ type: "line", x0: xv * k, x1: xv * k, xref: "x", yref: "paper", y0: 0, y1: 1,
      line: { color, width: 1.8, dash: "dashdot" } });
    const dens = isFinite(kd) && densityActive() ? `<br><span style="font-size:10.5px">${fmt(xv * kd / du.div, 3)} ${du.name}</span>` : "";
    const lx = Math.log10(xv * k);
    // 화면 폭의 대략 18% 안에 다른 라벨이 있으면 겹친다고 본다
    const minGap = 0.18 * xSpanDec;
    let row = 0;
    while (placed.some((q) => q.row === row && Math.abs(q.x - lx) < minGap)) row++;
    placed.push({ x: lx, row });
    annots.push({
      x: lx, xref: "x", yref: "paper", y: 1.0, yanchor: "bottom", xanchor: "center",
      yshift: row * 34,
      text: `<b>${label}</b> = ${fmt(xv, 3)} W${note ? " " + note : ""}${dens}`,
      showarrow: false, font: { size: 12, color }, bgcolor: "rgba(26,26,25,0.85)", borderpad: 3,
    });
  };
  if (analysis && L.ith) {
    // v2.7 (T1): 접선-교점 문턱을 함께 표시한다. transition width 파라미터화에 의존하지 않으므로
    // 파라메트릭이 실패해(t₁ = NaN) 아무 문턱도 못 낼 때 이쪽이 주 보고값이 된다.
    const tg = analysis.thresholdTangent && analysis.thresholdTangent.spline;
    const t1ok = isFinite(analysis.thresholdP) && analysis.thresholdP > 0;
    // 기본은 **보고값 하나**만 — 접선-교점 대조는 P-spline 칩을 켤 때만 함께 보인다.
    const thLabel = analysis.thresholdSource === "ignition-bracket" ? "I_th (ignition bracket)" : "I_th (t₁)";
    if (t1ok) marker(analysis.thresholdP, thLabel, PALETTE.magenta, analysis.thresholdOutOfRange ? "<i>(외삽)</i>" : "");
    if (tg && (L.spline || !t1ok)) marker(tg.P, "I_th (접선)", t1ok ? "#c86fa0" : PALETTE.magenta,
      t1ok ? "" : "<i>(model-free)</i>");
    marker(analysis.saturationP, "P_sat", "#8b8a80", "");
  }

  // ---- V2: PA 위치 — 접선 선분(분해 front) 또는 구간 음영(unresolved jump) ----
  if (analysis && L.pa && !norm) {
    const jump = analysis.paSource === "jump" && analysis.paJump;
    if (jump) {
      const lo = Math.log10(analysis.paJump.pth) - analysis.paJump.dlogP / 2;
      const hi = Math.log10(analysis.paJump.pth) + analysis.paJump.dlogP / 2;
      shapes.push({ type: "rect", xref: "x", yref: "paper", layer: "below",
        x0: Math.pow(10, lo) * k, x1: Math.pow(10, hi) * k, y0: 0, y1: 1,
        fillcolor: "rgba(201,133,0,0.18)", line: { color: PALETTE.yellow, width: 1 } });
      annots.push({
        x: Math.log10(analysis.paJump.pth * k), xref: "x", yref: "paper", y: 0.5, xanchor: "left",
        text: `  <b>PA ≥ ${fmt(analysis.paReport, 4)}</b><br>  unresolved jump<br>  Δlog₁₀P = ${fmt(analysis.paJump.dlogP, 3)}`,
        showarrow: false, align: "left", font: { size: 12, color: PALETTE.yellow },
        bgcolor: "rgba(26,26,25,0.85)", borderpad: 4,
      });
    }
    // v3.12 — 모델 s_max 위치가 **관측 불가 구간**이면 접선도 별도 그리지 않는다.
    // 8×10⁻⁸ counts 짜리 성분의 기울기를 "PA 위치" 로 찍는 것은 오해만 만든다.
    if (!paTangentDrawable(analysis)) {
      const mx = paMarkerX(analysis);
      if (isFinite(mx)) {
        const Im = modelAt(analysis, Math.log10(mx));
        traces.push({
          x: [mx * k], y: [isFinite(Im) && Im > 0 ? Im : analysis.background || 1],
          mode: "markers", type: "scatter", name: "PA (점화 위치)",
          marker: { size: 14, symbol: "star", color: PALETTE.yellow, line: { width: 1.4, color: "#1a1a19" } },
          hovertemplate: `PA ≥ ${fmt(analysis.paReport, 4)}<br>P=%{x:.4g}<extra></extra>`,
        });
      }
      annots.push({
        x: Math.log10((isFinite(mx) ? mx : analysis.sMaxAtP) * k), xref: "x", yref: "paper", y: 0.06,
        xanchor: "center",
        text: `<b>모델 접선 생략</b><br><span style="font-size:10.5px">모델 s_max(${fmt(analysis.sMax, 3)})가 잡힌 자리는`
          + ` 신호가 검출 한계 아래<br>(${fmt(analysis.sMaxObservable.signal, 3)} counts vs 게이트 ${fmt(analysis.sMaxObservable.gate, 4)})`
          + ` — 외삽이라 표시하지 않음</span>`,
        showarrow: false, align: "center", font: { size: 11.5, color: "#c9a227" },
        bgcolor: "rgba(26,26,25,0.88)", borderpad: 4,
      });
    }
    // 분해 front 접선 (점프가 이기면 회색 보조선)
    if (paTangentDrawable(analysis) && isFinite(analysis.sMaxAtP) && isFinite(analysis.sMax)) {
      const xs = Math.log10(analysis.sMaxAtP), Is = modelAt(analysis, xs);
      if (isFinite(Is) && Is > 0) {
        const xr = analysis.data.x, half = 0.10 * (xr[xr.length - 1] - xr[0]);
        const col = jump ? "#8b8a80" : PALETTE.yellow;
        shapes.push({ type: "line", xref: "x", yref: "y", layer: "above",
          x0: Math.pow(10, xs - half) * k, y0: Is * Math.pow(10, -analysis.sMax * half),
          x1: Math.pow(10, xs + half) * k, y1: Is * Math.pow(10, analysis.sMax * half),
          line: { color: col, width: jump ? 2 : 3 } });
        traces.push({
          x: [analysis.sMaxAtP * k], y: [Is], mode: "markers", type: "scatter",
          name: jump ? "분해 front (보조)" : "PA (최대 기울기)",
          marker: { size: 13, symbol: "star", color: col, line: { width: 1.4, color: "#1a1a19" } },
          hovertemplate: `s_max=${fmt(analysis.sMax, 4)}<br>P=%{x:.4g}<extra></extra>`,
        });
        // 차트 라벨은 **카드와 같은 값**을 말해야 한다. 접선은 parametric s_max 로 그리지만
        // 보고값은 paReport 이므로, 둘이 다르면 그 사실을 라벨에 적는다.
        if (!jump) {
          const rep = analysis.paReport, ge = analysis.paSource === "lower-bound";
          const mkX = paMarkerX(analysis);
          const differs = isFinite(rep) && Math.abs(rep - analysis.sMax) / Math.max(analysis.sMax, 1e-12) > 1e-6;
          annots.push({
            x: Math.log10((isFinite(mkX) ? mkX : analysis.sMaxAtP) * k), y: Math.log10(Is), yshift: 30, xanchor: "center",
            text: `PA ${ge ? "≥" : "="} <b>${fmt(rep, 4)}</b>`
              + (analysis.paSource === "unresolved" ? " <i>(unidentified)</i>" : "")
              + (differs ? `<br><span style="font-size:10.5px">접선은 모델 s_max=${fmt(analysis.sMax, 3)}</span>` : ""),
            showarrow: false, align: "center", font: { size: 13, color: PALETTE.yellow },
            bgcolor: "rgba(26,26,25,0.85)", borderpad: 3,
          });
        }
      }
    }
  }

  // ---- V5: 미스핏 구간 하이라이트 ----
  if (analysis && showResid) {
    for (const r of misfitRuns(res)) {
      const pad = 0.3 * (r.hi - r.lo) + 0.004;
      shapes.push({ type: "rect", xref: "x", yref: "paper", layer: "below",
        x0: Math.pow(10, r.lo - pad) * k, x1: Math.pow(10, r.hi + pad) * k, y0: 0, y1: 1,
        fillcolor: "rgba(230,103,103,0.10)", line: { width: 0 } });
      annots.push({
        x: 0.5 * (r.lo + r.hi) + Math.log10(k), xref: "x", yref: "paper", y: 0.93, xanchor: "center",
        text: `이 구간을 따라가지 못함 (${r.n}점, ${r.sign > 0 ? "모델이 낮음" : "모델이 높음"})`,
        showarrow: false, font: { size: 10.5, color: PALETTE.red },
        bgcolor: "rgba(26,26,25,0.8)", borderpad: 2,
      });
    }
  }

  // ---- V4: residual 패널 (같은 figure 의 2행 subplot) ----
  if (showResid) {
    const xs = res.map((p) => p.P * k);
    const band = (mult, alpha) => {
      traces.push({
        x: [...xs, ...xs.slice().reverse()],
        y: [...res.map((p) => mult * p.s), ...res.map((p) => -mult * p.s).reverse()],
        fill: "toself", fillcolor: `rgba(195,194,183,${alpha})`, line: { width: 0 },
        type: "scatter", yaxis: "y2", hoverinfo: "skip", showlegend: false,
      });
    };
    band(3, 0.07); band(1, 0.11);
    const used = res.filter((p) => p.used), excl = res.filter((p) => !p.used);
    traces.push({
      x: used.map((p) => p.P * k), y: used.map((p) => p.r), yaxis: "y2",
      mode: "markers", type: "scatter", name: "residual (dex)", showlegend: false,
      marker: { size: 5, color: PALETTE.blue },
      hovertemplate: "P=%{x:.4g}<br>residual=%{y:.3f} dex<extra></extra>",
    });
    if (excl.length) traces.push({
      x: excl.map((p) => p.P * k), y: excl.map((p) => p.r), yaxis: "y2",
      mode: "markers", type: "scatter", showlegend: false,
      marker: { size: 8, symbol: "x-thin", color: PALETTE.red, line: { width: 1.6, color: PALETTE.red } },
      hovertemplate: "P=%{x:.4g}<br>residual=%{y:.3f} dex<extra>제외</extra>",
    });
    const rms = used.length ? Math.sqrt(used.reduce((s2, p) => s2 + p.r * p.r, 0) / used.length) : NaN;
    annots.push({
      xref: "paper", yref: "paper", x: 0.005, y: 0.255, xanchor: "left", yanchor: "top",
      text: `residual rms = ${fmt(rms, 3)} dex · 밴드 = ±1σ / ±3σ (점별)`,
      showarrow: false, font: { size: 10.5, color: "#8b8a80" },
    });
  }

  // ---- 수동 기울기 윈도우 ----
  let manWinIdx = -1;
  if (rec.cache.manualOn && rec.cache.manualRange && !norm) {
    const mr = rec.cache.manualRange;
    manWinIdx = shapes.length;
    shapes.push({ type: "rect", xref: "x", yref: "paper", x0: mr.lo * k, x1: mr.hi * k, y0: 0, y1: 1,
      fillcolor: "rgba(213,81,129,0.08)", line: { color: "rgba(213,81,129,0.55)", width: 1.5 } });
    const man = computeManualSlope(rec);
    const mOut = $("#m-out");
    if (man && man.chord !== undefined) {
      shapes.push({ type: "line", xref: "x", yref: "y", layer: "above",
        x0: man.L[0] * k, y0: man.L[1], x1: man.R[0] * k, y1: man.R[1],
        line: { color: PALETTE.magenta, width: 3 } });
      el._manAnnIdx = annots.length;
      annots.push({
        x: Math.log10(Math.sqrt(man.L[0] * man.R[0]) * k), xref: "x", yref: "paper", y: 0.015,
        text: `s = <b>${fmt(man.chord, 4)}</b>`, showarrow: false,
        font: { size: 12.5, color: "#f0a3c0" }, bgcolor: "rgba(26,26,25,0.75)", borderpad: 3,
      });
      if (mOut) mOut.innerHTML = `s = <b style="color:${PALETTE.magenta}">${fmt(man.chord, 5)}</b> · ${man.n}점 · LSQ ${fmt(man.lsq, 4)}`;
    } else {
      el._manAnnIdx = -1;
      if (mOut) mOut.innerHTML = `<span class="tag-Low">윈도우 내 점 부족</span>`;
    }
  } else {
    el._manAnnIdx = -1;
    const mOut = $("#m-out");
    if (mOut) mOut.textContent = "";
  }

  // ---- v3.18 SegPA overlay: regime 구간 · Ith 브래킷 · PA 라벨 ----
  if (L.segpa) {
    const sp = segpaFor(rec, segpaSelectedName(rec));
    if (sp && !sp.error) {
      sp.regimes.slice().sort((a, b) => a.bracketW[0] - b.bracketW[0]).forEach((q, idx) => {
        const isPA = q.cls === "PA";
        shapes.push({ type: "rect", xref: "x", yref: "paper", layer: "below", x0: Math.min(q.x0W, q.bracketW[0]) * k, x1: q.x1W * k, y0: 0, y1: 1,
          fillcolor: isPA ? "rgba(230,103,103,0.10)" : "rgba(160,160,150,0.10)", line: { width: 0 } });
        shapes.push({ type: "rect", xref: "x", yref: "paper", layer: "below", x0: q.bracketW[0] * k, x1: q.bracketW[1] * k, y0: 0, y1: 1,
          fillcolor: isPA ? "rgba(230,103,103,0.38)" : "rgba(160,160,150,0.35)", line: { width: 0 } });
        annots.push({ x: Math.log10(q.bracketW[1] * k), xref: "x", yref: "paper", y: 0.02 + 0.075 * idx, xanchor: "left", yanchor: "bottom", showarrow: false,
          text: `${isPA ? "PA" : "S-bend"} ${segpaPaText(q)}${q.main && Math.abs(q.main.slope - q.head) / q.head > 0.25 ? ` · 주상승 ${fmt(q.main.slope, 3)}` : ""}`,
          font: { size: 11, color: isPA ? PALETTE.red : "#a09f96" }, bgcolor: "rgba(26,26,25,0.75)" });
      });
    }
  }

  // ---- 축 구성 ----
  const ylab = rec.det.type === "power_apd" ? "APD count rate (Hz)" : `적분 강도 (${App.settings.bandMin}–${App.settings.bandMax} nm, a.u.)`;
  const base = baseLayout();
  const yTop = showResid ? [0.36, 1] : [0, 1];
  const layout = {
    xaxis: Object.assign(base.xaxis, { type: "log", title: { text: xUnitLabel() }, exponentformat: "power", anchor: showResid ? "y2" : "y" }),
    yaxis: Object.assign({}, base.yaxis, norm
      ? { type: "linear", title: { text: "I / 모델" }, domain: yTop, range: [0.4, 1.8], zeroline: false }
      : { type: "log", title: { text: ylab }, exponentformat: "power", domain: yTop }),
    shapes, annotations: annots,
    margin: { l: 66, r: 18, t: 46, b: 50 },
  };
  if (showResid) {
    layout.yaxis2 = Object.assign({}, base.yaxis, {
      domain: [0, 0.26], title: { text: "residual (dex)", font: { size: 11.5 } },
      zeroline: true, zerolinecolor: "#5a5a52", zerolinewidth: 1.5,
    });
  }
  el.style.height = (showResid ? 560 : 430) + "px";
  newPlot(el, traces, layout).then(() => {
    try { Plotly.Plots.resize(el); } catch (e) {}
    setupManualHandles(rec, el, manWinIdx >= 0);
  });
}
/* 수동 기울기 윈도우: 양쪽 끝 전용 드래그 핸들 (DOM 오버레이 — 두껍고 잡기 쉬움) */
function setupManualHandles(rec, el, active) {
  el.style.position = "relative";
  let hL = el.querySelector(".man-handle-l"), hR = el.querySelector(".man-handle-r");
  if (!active) {
    if (hL) hL.remove();
    if (hR) hR.remove();
    el.removeAllListeners && el.removeAllListeners("plotly_relayout");
    return;
  }
  const mk = (cls) => {
    const d = document.createElement("div");
    d.className = "man-handle " + cls;
    d.innerHTML = '<div class="man-grip"></div>';
    el.appendChild(d);
    return d;
  };
  if (!hL) hL = mk("man-handle-l");
  if (!hR) hR = mk("man-handle-r");
  const axes = () => {
    const fl = el._fullLayout;
    return { xa: fl.xaxis, ya: fl.yaxis };
  };
  const position = () => {
    const { xa, ya } = axes();
    const kk = xConv();
    const mr = rec.cache.manualRange;
    if (!mr) return;
    const pxL = xa._offset + xa.d2p(mr.lo * kk);
    const pxR = xa._offset + xa.d2p(mr.hi * kk);
    for (const [h, px] of [[hL, pxL], [hR, pxR]]) {
      h.style.left = (px - 8) + "px";
      h.style.top = ya._offset + "px";
      h.style.height = ya._length + "px";
      h.style.display = (px >= xa._offset - 10 && px <= xa._offset + xa._length + 10) ? "" : "none";
    }
  };
  position();
  el.removeAllListeners && el.removeAllListeners("plotly_relayout");
  el.on("plotly_relayout", position); // 줌/팬 시 핸들 재정렬
  const bindDrag = (h, side) => {
    h.onpointerdown = (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      h.setPointerCapture(ev.pointerId);
      const { xa } = axes();
      const rect = el.getBoundingClientRect();
      let raf = null;
      const move = (mv) => {
        const px = mv.clientX - rect.left - xa._offset;
        const val = xa.p2d(px); // log 축 → raw 데이터 값
        if (!isFinite(val) || val <= 0) return;
        const kk = xConv();
        const mr = rec.cache.manualRange;
        if (side === "l") mr.lo = Math.min(val / kk, mr.hi * 0.999);
        else mr.hi = Math.max(val / kk, mr.lo * 1.001);
        if (raf) return;
        raf = requestAnimationFrame(() => {
          raf = null;
          liveUpdateManual(rec, el);
          position();
        });
      };
      const up = (uv) => {
        h.releasePointerCapture(uv.pointerId);
        h.onpointermove = null; h.onpointerup = null;
        refreshPowerView(rec); // 최종 동기화
      };
      h.onpointermove = move;
      h.onpointerup = up;
    };
  };
  bindDrag(hL, "l");
  bindDrag(hR, "r");
}
/* 드래그 중 가벼운 갱신: 윈도우/코드 shape + 주석 + 판독값만 relayout */
function liveUpdateManual(rec, el) {
  const kk = xConv();
  const mr = rec.cache.manualRange;
  const man = computeManualSlope(rec);
  const shapes = (el.layout.shapes || []).slice();
  // 윈도우/코드 shape 인덱스: 뒤에서부터 (코드가 마지막, 윈도우가 그 앞 또는 마지막)
  let wIdx = -1, cIdx = -1;
  shapes.forEach((sh, i) => {
    if (sh.type === "rect" && sh.fillcolor === "rgba(213,81,129,0.08)") wIdx = i;
    if (sh.type === "line" && sh.line && sh.line.color === PALETTE.magenta) cIdx = i;
  });
  const upd = {};
  if (wIdx >= 0) { upd[`shapes[${wIdx}].x0`] = mr.lo * kk; upd[`shapes[${wIdx}].x1`] = mr.hi * kk; }
  const mOut = $("#m-out");
  if (man && man.chord !== undefined) {
    if (cIdx >= 0) {
      upd[`shapes[${cIdx}].x0`] = man.L[0] * kk; upd[`shapes[${cIdx}].y0`] = man.L[1];
      upd[`shapes[${cIdx}].x1`] = man.R[0] * kk; upd[`shapes[${cIdx}].y1`] = man.R[1];
    }
    const ai = el._manAnnIdx;
    if (ai >= 0) {
      upd[`annotations[${ai}].x`] = Math.log10(Math.sqrt(man.L[0] * man.R[0]) * kk);
      upd[`annotations[${ai}].text`] = `s = <b>${fmt(man.chord, 4)}</b>`;
    }
    if (mOut) mOut.innerHTML = `s = <b style="color:${PALETTE.magenta}">${fmt(man.chord, 5)}</b> · ${man.n}점 · LSQ ${fmt(man.lsq, 4)}`;
  } else if (mOut) {
    mOut.innerHTML = `<span class="tag-Low">윈도우 내 점 부족</span>`;
  }
  try { Plotly.relayout(el, upd); } catch (e) {}
}

function drawSlopeChart(rec, analysis) {
  const el = $("#chart-slope");
  if (!el || !analysis) return;
  const k = xConv();
  const Pg = analysis.grid.map((xv) => Math.pow(10, xv) * k);
  const traces = [];
  // bootstrap band first (below lines)
  const boot = analysis.diag;
  if (boot && boot.slopeBand && boot.slopeBand.x.length) {
    const bx = boot.slopeBand.x.map((xv) => Math.pow(10, xv) * k);
    traces.push({
      x: [...bx, ...bx.slice().reverse()],
      y: [...boot.slopeBand.hi, ...boot.slopeBand.lo.slice().reverse()],
      fill: "toself", fillcolor: "rgba(25,158,112,0.16)", line: { width: 0 },
      name: "95% 부트스트랩 밴드", hoverinfo: "skip", type: "scatter",
    });
  }
  traces.push({ x: Pg, y: analysis.sSig, mode: "lines", type: "scatter",
    name: "s_sig (파라메트릭, 배경 제외 신호)", line: { color: PALETTE.aqua, width: 2.4 },
    hovertemplate: "P=%{x:.4g}<br>s=%{y:.3f}<extra>parametric</extra>" });
  traces.push({ x: Pg, y: analysis.sTot, mode: "lines", type: "scatter",
    name: "s_tot (P-spline, 총 강도)", line: { color: PALETTE.blue, width: 1.5, dash: "dot" },
    hovertemplate: "P=%{x:.4g}<br>s=%{y:.3f}<extra>spline</extra>" });
  // s_max marker
  traces.push({
    x: [analysis.sMaxAtP * k], y: [analysis.sMax], mode: "markers+text", type: "scatter",
    name: "s_max", text: [`s_max=${fmt(analysis.sMax, 4)}${analysis.sMaxIsLowerBound ? " (lower bound)" : ""}`],
    textposition: "top center", textfont: { size: 12, color: PALETTE.yellow },
    marker: { size: 11, symbol: "star", color: PALETTE.yellow },
    hovertemplate: "s_max=%{y:.4f}<extra></extra>",
  });
  const shapes = [];
  for (const [xv, col] of [[analysis.thresholdP, "#c3c2b7"], [analysis.saturationP, "#8b8a80"]]) {
    if (isFinite(xv) && xv > 0) shapes.push({ type: "line", x0: xv * k, x1: xv * k, yref: "paper", y0: 0, y1: 1,
      line: { color: col, width: 1, dash: "dashdot" } });
  }
  newPlot(el, traces, {
    xaxis: Object.assign(baseLayout().xaxis, { type: "log", title: { text: xUnitLabel() }, exponentformat: "power" }),
    yaxis: Object.assign(baseLayout().yaxis, { title: { text: "local slope s(P)" }, rangemode: "tozero" }),
    shapes,
  });
}

function orderLabel(a) {
  const p = a.params;
  if (a.chosenOrder === 0) return `순수 멱법칙 (n=${fmt(p.k1, 3)})`;
  if (a.chosenOrder === 1) return p.k2 > p.k1 ? `기울기 상승 전이 (${fmt(p.k1, 3)} → ${fmt(p.k2, 3)})` : `포화형 (${fmt(p.k1, 3)} → ${fmt(p.k2, 3)})`;
  return `S-curve: ${fmt(p.k1, 3)} → ${fmt(p.k2, 3)} → ${fmt(p.k3, 3)}`;
}
function renderFitResults(rec, analysis) {
  const el = $("#fit-results");
  if (!el) return;
  try { renderPaHeadline(rec); } catch (e) {}
  const a = analysis, p = a.params, q = a.quality, d = a.diagnostics;
  const boot = a.diag;
  const kd = densityFactor();
  const ciStr = (pair, digits) => pair && isFinite(pair[0]) ? ` <span class="muted small">[${fmt(pair[0], digits || 3)}, ${fmt(pair[1], digits || 3)}]</span>` : "";
  const qb = q.band;
  const du = activeDensityUnit();
  const thDens = isFinite(kd) && isFinite(a.thresholdP) ? `<div class="s" style="color:var(--accent)">= ${fmt(a.thresholdP * kd / du.div, 4)} ${du.name}</div>` : "";
  const satDens = isFinite(kd) && isFinite(a.saturationP) ? ` (= ${fmt(a.saturationP * kd / du.div, 4)} ${du.name})` : "";
  const jumpWins = a.paSource === "jump";
  // v2.6 (V8): constraint boundary에 붙은 파라미터가 있으면 s_max 는 데이터가 아니라 제약의 산물이다.
  const bh = a.boundHits || [];
  const bhTxt = bh.map((b) => `${b.param}=${fmt(b.value, 4)} (${b.at === "floor" ? "lower bound" : b.at === "box" ? "박스 upper bound" : "격자 이하"})`).join(" · ");
  const warnBound = bh.length ? `<div class="warnbar">⚠ <b>제약 접촉</b> — ${esc(bhTxt)}<br>
    s_max 는 데이터가 아니라 제약이 결정한 값입니다. point estimate로 보고하지 마십시오.
    ${bh.some((b) => b.at === "sub-grid") ? `transition width가 파워 격자(Δlog₁₀P=${fmt(a.medianDlogP, 3)})보다 좁아 어떤 매끄러운 모델도 유한한 s_max 를 줄 수 없습니다.` : ""}</div>` : "";
  // v2.7 (S1): 수치 재현성 경고 — 옵티마이저 조건과 무의미한 수준(1e-9)의 데이터 지터만
  // 바꿔도 차수·s_max 가 달라지면 그 값은 데이터의 성질이 아니다.
  const st = a.stability;
  const warnUnstable = (st && st.checked && !st.stable)
    ? `<div class="warnbar">⚠ <b>수치적으로 재현되지 않습니다</b> — 측정 정밀도보다 훨씬 작은 요동(상대 ${st.jitterRel || 1e-9})만 줘도
        선택 차수가 {${(st.ordersSeen || []).map((x) => "H" + x).join(", ")}} 사이를 오가고 s_max 가 ${(st.sMaxValues || []).map((v) => fmt(v, 3)).join(" / ")} 로 갈립니다
        (변동계수 ${fmt(st.sMaxCV, 3)}).<br>이 s_max 는 데이터가 아니라 어느 국소해에 떨어졌는지를 반영합니다 — 보고하지 마십시오.
        아래 임계 파워(접선-교점·비모수)는 이 영향을 받지 않습니다.</div>` : "";
  const warnAgg = (analysis._aggUsed === "high" && a.aggEffective === "none")
    ? `<div class="warnbar muted-warn">이 파일은 setpoint 당 측정 행이 1개여서 <b>고상태 max 집계가 실제로 일어나지 않았습니다</b> — 값은 반복 평균과 동일합니다.</div>` : "";
  const nz = a.noise || {};
  const noiseTxt = nz.counting
    ? `계수 통계 a₁=${fmt(nz.counting.a1, 3)}${nz.poissonFloor ? ` (Poisson 바닥 1/τ=${fmt(nz.poissonFloor, 3)})` : ""} · setpoint 간 초과 a₂=${fmt(nz.a2Excess || 0, 3)}`
    : `폴백 추정 (원시 반복 없음) a₂=${fmt(nz.a2, 3)}`;
  // v2.8 (P1) — 고정-기울기 프로파일 우도의 진술. "얕은 s_max 가 자기 우도로 기각된다"는
  // 주장은 여기서만 나오며, 엔진이 실제로 제약 MLE 를 8~10회 풀어 얻은 Δχ² 에 근거한다.
  let profTxt = "";
  if (a.slopeProfile && a.slopeProfile.verdict) {
    const sp = a.slopeProfile;
    const ladder = `<details class="s"><summary class="muted">upper bound별 Δχ² 보기 (제약 최대우도 ${sp.caps.length + 1}회)</summary>
      <div class="muted" style="margin-top:4px">${sp.caps.map((r) => `s_max ≤ ${r.cap} → Δχ² = ${fmt(r.dChi2, 3)}`).join(" · ")}
      <br>기준 χ² = ${fmt(sp.chi2Ref, 5)} (upper bound ${sp.refCap}) · 공통 점집합 n = ${sp.nUsed}</div></details>`;
    if (sp.verdict === "unbounded") {
      profTxt = `<div class="warnbar">⚠ <b>우도가 s_max 를 위로 전혀 제한하지 못합니다</b> — 프로파일 우도(H${sp.order}) 결과,
        s_max ≤ ${sp.gridTop} 인 모든 모델이 기각됩니다 (Δχ² > ${sp.dChi2Crit}, 95%·1 dof).
        즉 매끄러운 모델의 s_max = ${fmt(a.sMax, 4)} 는 <b>이 데이터 자신의 우도가 기각한 값</b>이며 point estimate가 아닙니다.
        전선이 분해되지 않았다는 뜻이므로, 보고는 model-free 점프 lower bound를 씁니다.<br>${ladder}</div>`;
    } else if (sp.verdict === "bounded") {
      profTxt = `<div class="warnbar muted-warn">프로파일 우도(H${sp.order}): <b>s_max &gt; ${sp.floor}</b> 가 95% 로 요구됩니다
        (s_max ≤ ${sp.floor} 기각, ${isFinite(sp.floorNext) ? `≤ ${sp.floorNext} 는 허용`: "격자 끝"}).
        ${sp.reportedRejected ? `보고된 s_max = ${fmt(a.sMax, 4)} 는 이 lower bound 아래이므로 <b>기각</b>됩니다.` : `보고된 s_max = ${fmt(a.sMax, 4)} 는 이 lower bound와 모순되지 않습니다.`}
        <br>${ladder}</div>`;
    } else {
      profTxt = `<div class="warnbar muted-warn">프로파일 우도(H${sp.order}): 가장 얕은 upper bound(s_max ≤ ${sp.caps[0].cap})도 기각되지 않습니다 —
        우도가 급격한 기울기를 요구하지 않습니다.<br>${ladder}</div>`;
    }
  }
  // v2.9 — bistable 서술. s_max 가 유한하지 않은 상황에서 **유한한 보고량**을 주는 것이
  // 이 카드의 목적이다: 전환 파워·대비비·고상태 지수·히스테리시스.
  const bs = a.bistable;
  const hyst = hysteresisOf(rec, analysis);
  let bsBar = "", bsCard = "", poolCard = "";
  if (bs) {
    const better = bs.preferred;
    const lowOk = bs.identifiability && bs.identifiability.lowVisible;
    bsBar = better ? `<div class="warnbar muted-warn">bistable 서술이 <b>더 지지됩니다</b> —
      ΔAICc(bistable − H${a.chosenOrder}) = ${fmt(bs.aiccVsH, 5)} (χ² ${fmt(a.fitsSummary[a.chosenOrder] ? a.fitsSummary[a.chosenOrder].chi2 : NaN, 5)} → ${fmt(bs.chi2, 5)}).
      이 데이터의 전선은 '가파른 매끄러운 전이'가 아니라 <b>두 상태 사이의 전환</b>입니다.
      s_max 대신 아래의 전환 파워·대비비·고상태 지수를 보고하십시오.</div>` : "";
    bsCard = `
    <div class="card"><div class="k">전환 파워 P_s <span class="muted small">(bistable)</span></div>
      <div class="v">${fmt(bs.pSwitch, 5)} <span class="s">W</span></div>
      ${bs.pSwitchBracket ? `<div class="s muted">실측 두 점 사이: ${fmt(bs.pSwitchBracket[0], 4)} – ${fmt(bs.pSwitchBracket[1], 4)} W
        ${bs.widthSubGrid ? "— 전환 폭이 격자보다 좁아 위치는 이 구간 안에서만 결정됩니다" : ""}</div>` : ""}
      <div class="s">전환 폭 ω = ${fmt(bs.switchWidthDec, 3)} dec (격자 ${fmt(a.medianDlogP, 3)})${bs.widthAtFloor ? " — lower bound 접촉" : ""}</div>
      ${hyst ? `<div class="s" style="color:var(--accent)">히스테리시스 P_up/P_down = ${fmt(hyst.ratio, 4)} (${fmt(hyst.dec, 3)} dec)</div>` : `<div class="s muted">히스테리시스: 반대 branch를 같은 설정으로 분석하면 표시됩니다</div>`}
      ${a.occSourceUsed === "cross" ? `<div class="s muted">occupancy 제약: <b>cross-branch</b> ${a.occConstraintN}점
        ${isFinite(bs.chi2VsUnconstrained) ? ` · 세기 χ² 는 무제약 대비 <b>${fmt(bs.chi2VsUnconstrained, 3)}×</b>` : ""}</div>` : ""}
      ${bs.occWithdrawn ? `<div class="s tag-Low"><b>occupancy 제약을 철회했습니다.</b>
        측정된 occupancy를 만족시키려면 세기 적합을 <b>${fmt(bs.chi2VsUnconstrained, 3)}배</b> 악화시켜야 하는데,
        이는 검증 범위(합성 54건 최대 11.3배) 밖입니다. 위 값은 <b>제약 없는 적합</b>입니다 —
        이 branch에서는 세기 자료와 cross-branch occupancy가 양립하지 않습니다. 측정된 전환 폭
        ${fmt(a.crossOcc && a.crossOcc.width1090, 4)} dec 는 cross-branch 카드에서 그대로 읽으십시오.</div>`
        : (isFinite(bs.chi2VsUnconstrained) && bs.chi2VsUnconstrained > 5
          ? `<div class="s muted">제약이 세기 χ² 를 ${fmt(bs.chi2VsUnconstrained, 3)}배 늘렸습니다 — 합성 범위(중앙 1.8 · 최대 11.3배) 안입니다.</div>` : "")}</div>
    <div class="card"><div class="k">상태별 멱법칙 지수 <span class="muted small">(bistable)</span></div>
      <div class="v">n_high = ${isFinite(bs.nHighSingle) ? fmt(bs.nHighSingle, 4)
        : `<span class="tag-Low" style="font-size:13px">${bs.nHighCollapsed ? "결정 불가" : "단일값 아님"}</span>`}</div>
      ${bs.nHighCollapsed ? `<div class="s tag-Low">고상태 지수가 선형(${fmt(bs.nHighFloor, 2)}) 아래로 내려갔습니다 (n_H = ${fmt(bs.params ? bs.params.nH : NaN, 3)}).
        occupancy 제약이 전환을 전부 f 로 설명하고 고상태를 평탄하게 놓은 해입니다 — <b>고상태 지수로 보고하지 마십시오</b>.
        전환 파워·전환 폭은 그대로 유효합니다.</div>`
        : (isFinite(bs.nHighSingle) ? "" : `<div class="s muted">고상태 가지의 지수가 전환 위에서 변합니다 (변동 ${fmt(100 * bs.nHighSpread, 2)}%) — 위치를 명시해 보고하십시오:<br>
        ${bs.nHighProfile.map((r) => `${r.mult}×P_s (${fmt(r.P, 4)} W): <b>${fmt(r.n, 3)}</b>`).join(" · ")}</div>`)}
      <div class="s">n_low = ${lowOk ? `<b>${fmt(bs.nLow, 4)}</b>` : `<span class="tag-Low">결정 불가</span> — 저상태 가지가 암계수 바닥(${fmt(bs.identifiability.floorLevel, 4)}) 아래`}</div>
      <div class="s">log₁₀ 대비비 = ${lowOk ? fmt(bs.log10Contrast, 4) : `≥ ${fmt(bs.log10ContrastLB, 4)} (바닥 기준 lower bound)`}</div>
      ${bs.satAtGap ? `<div class="s tag-Low">고상태 포화 꺾임이 전환 바로 위(최소 간격)에 붙어 있습니다 — 그 아래 구간의 지수는 전환의 일부이지 고상태의 지수가 아닙니다</div>` : ""}
      ${bs.identifiability && !bs.identifiability.highResolved ? `<div class="s tag-Low">고상태 지수 미결정 —
        ${bs.rangeOk === false
          ? `문턱 위 측정 구간이 <b>${fmt(bs.nHighRangeDec, 3)} dec</b> 뿐입니다 (필요 ${fmt(bs.nHighRangeMin, 2)} dec).
             참값 대조: 0.16 dec 에서 국소지수 오차가 6–100%, 0.25 dec 이상에서는 12회 모두 ≤16% 였습니다.
             <b>스윕을 ${fmt(100 * (Math.pow(10, Math.max(bs.nHighRangeMin - bs.nHighRangeDec, 0)) - 1), 2)}% 더 높은 파워까지 확장</b>하면 이 값이 결정됩니다.`
          : `전환 위 측정점이 ${bs.identifiability.nHighPts}개뿐입니다.`}</div>` : ""}</div>`;
  }
  // v3.6 — branch 합산. 한 branch의 구간이 부족해도 여러 branch를 **절대 파워**로 묶으면
  // 고상태 지수를 낼 수 있다. 이미 분석돼 캐시에 있는 branch만 쓴다.
  {
    const col = collectBistables();
    if (col.bistables.length >= 3 && typeof PrismFit.poolHighExponent === "function") {
      let pool = null;
      try { pool = PrismFit.poolHighExponent(col.bistables); } catch (e) { pool = null; }
      if (pool && pool.usable && pool.best) {
        const g = pool.best;
        const het = pool.heterogeneous;
        poolCard = `
    <div class="card" style="grid-column:span 2"><div class="k">여러 branch 합산 고상태 지수
      <span class="muted small">(절대 파워 기준 · ${pool.branches}branch)</span></div>
      <div class="v">n_high = ${fmt(g.n, 4)} <span class="s">@ ${fmt(g.P, 4)} W</span></div>
      <div class="s">${het ? "branch 간 spread" : "90% 구간"} ${fmt(g.lo90, 4)} – ${fmt(g.hi90, 4)}
        · 이 파워에 겹치는 branch ${g.nBranch}개</div>
      <div class="s muted">문턱 위 구간(dec): ${pool.rangeDecs.map((v) => fmt(v, 2)).join(" · ")}</div>
      ${het
        ? `<div class="s tag-Low"><b>branch 간 heterogeneity 감지</b> — IQR/중앙 = ${fmt(pool.iqrRel, 3)}
           (동질 합성은 0.15 를 넘지 않습니다). 이 spread는 추정 잡음이 아니라 <b>자리마다 실제로 다르다</b>는 뜻입니다
           (관측 IQR 은 참 spread를 거의 1:1 로 추종합니다 — 참 ±5/15/30/45% → 관측 0.05/0.14/0.30/0.48).
           위 구간을 <b>하나의 값에 대한 신뢰구간으로 읽지 마십시오.</b>
           개별 branch 추정은 이질이어도 정확하므로(합성 중앙오차 0%), 분포로 보고하십시오:<br>
           ${g.values.map((v) => fmt(v, 3)).join(" · ")}</div>`
        : `<div class="s muted">branch 간 spread가 추정 잡음 범위 안입니다 (IQR/중앙 ${fmt(pool.iqrRel, 3)} ≤ ${fmt(pool.iqrMax, 2)})
           — 하나의 값으로 요약해도 됩니다.</div>`}
      <div class="s muted">참값 대조: 자리마다 전환 파워가 다른 합성에서 오차 0%, 90% 구간 ±1–2%.
        단 <b>긴 구간 branch가 하나는 있어야</b> 합니다 — 합산은 강건 추정이지 정보를 만들지 않습니다.
        ${col.labels.length ? `쓰인 branch: ${col.labels.join(" · ")}` : ""}</div></div>`;
      }
    } else if (col.bistables.length > 0 && col.bistables.length < 3) {
      poolCard = `
    <div class="card"><div class="k">여러 branch 합산 <span class="muted small">(v3.6)</span></div>
      <div class="s muted">branch ${col.bistables.length}개 — 합산에는 3개 이상이 필요합니다.
        다른 파일이나 반대 branch를 같은 설정으로 분석하면 여기에 합산 결과가 나옵니다.
        문턱 위 구간이 부족해 n_high 를 못 내는 경우의 우회로입니다.</div></div>`;
    }
  }
  // v3.0 — 점멸 관측층. 반복 분산은 노이즈가 아니라 신호다: 어떤 setpoint 가 두 상태의
  // 혼합인지, occupancy가 얼마인지, dwell 안에서 얼마나 평균화됐는지를 모델과 무관하게 말해준다.
  const occ = a.occupancy;
  let occBar = "", occCard = "";
  if (occ && occ.checked && occ.nBlink > 0) {
    const br = occ.rows.filter((r) => r.blink && isFinite(r.fMean));
    const kap = br.map((r) => r.kappa).filter(isFinite);
    const kMed = kap.length ? kap.sort((x1, x2) => x1 - x2)[kap.length >> 1] : NaN;
    // κ̂ 는 dwell 안에서 점멸이 얼마나 평균화됐는지를 말한다 — 값이 아니라 해석이 중요하다
    const kTxt = !isFinite(kMed) ? ""
      : kMed > 0.5 ? `κ̂ ≈ ${fmt(kMed, 2)} — 반복 한 번이 대체로 <b>한 상태에 머물렀습니다</b> (점멸 주기 ≳ dwell)`
      : `κ̂ ≈ ${fmt(kMed, 2)} — dwell 안에서 <b>여러 번 점멸해 평균화</b>되었습니다 (점멸 주기 ≪ dwell ${fmt(a.noise.acqTime, 3)} s)`;
    const cells = br.slice(0, 8).map((r) =>
      `<tr><td class="num">${fmt(r.P, 4)}</td><td class="num">${fmt(r.mean, 4)}</td>
       <td class="num"><b>${fmt(r.fMean, 3)}</b> ± ${fmt(r.fSd, 2)}</td>
       <td class="num muted">${fmt(r.fSdStat, 2)} / ${fmt(r.fSdSys, 2)}</td>
       <td class="num">${isFinite(r.kappa) ? fmt(r.kappa, 3) : "-"}</td><td class="num">${fmt(r.ratioAdj, 3)}</td></tr>`).join("");
    occCard = `
    <div class="card" style="grid-column:span 2"><div class="k">점멸 occupancy (반복 분산에서, model-free)</div>
      <div class="v">${occ.nBlink} <span class="s">/ ${occ.nRows} setpoint</span></div>
      <div class="s muted">계수통계 대비 과분산 — 이 점들의 평균은 어떤 발광 가지 위의 값이 아니라 <b>두 상태의 혼합</b>입니다.
        판정은 χ²<sub>ν=${occ.nu}</sub> 귀무분포 + BH-FDR ${fmt(occ.fdr, 2)} (임의 임계값 없음).
        ${occ.nOtherDispersed ? `과분산이지만 두 준위 혼합으로 설명되지 않는 점 ${occ.nOtherDispersed}개는 제외했습니다.` : ""}</div>
      ${kTxt ? `<div class="s">${kTxt}</div>` : ""}
      <table class="res" style="margin-top:6px"><tr><th>P (W)</th><th>평균</th><th>occupancy f̂</th><th class="muted">σ 통계/계통</th><th>κ̂</th><th>분산비</th></tr>${cells}</table>
      <div class="s muted">σ 의 <b>계통</b> 성분은 두 상태 준위를 외삽할 때 쓰는 이웃 점 개수(3·5·8)를 바꿔 얻은 spread입니다 —
        고상태 가지가 휘어 있으면 이 성분이 통계 오차를 압도합니다. 이것을 빼면 f̂ 의 정확도가 과장됩니다.</div>
      ${occ.fMonotone === false ? `<div class="s tag-Low">occupancy가 파워에 대해 <b>단조롭지 않습니다</b> — 실제 전환이라면 고상태 체류가 단조 증가해야 합니다.
        이 검출들은 전환이 아니라 잡음일 가능성이 있습니다.</div>` : ""}
      ${br.length > 8 ? `<div class="s muted">… 외 ${br.length - 8}개</div>` : ""}
      ${occ.global ? `<div class="s tag-Low">절반 이상의 setpoint 가 과분산입니다 — 국소적 bistable가 아니라 장치·측정 조건 문제일 가능성이 큽니다</div>` : ""}</div>`;
    const oc = bs && bs.occCheck;
    if (oc && oc.n && oc.agrees === false) {
      occBar = `<div class="warnbar muted-warn">적합된 전환과 관측된 점멸이 <b>완전히 일치하지는 않습니다</b> —
        모델 f(P) 와 측정 f̂ 의 최대 편차 |z| = ${fmt(oc.maxAbsZ, 3)} (n=${oc.n}, 준위 외삽 계통 포함).
        ${oc.rows.filter((r) => Math.abs(r.z) > 3).slice(0, 3).map((r) => `P=${fmt(r.P, 4)}W: 모델 ${fmt(r.fModel, 3)} vs 관측 ${fmt(r.fMeasured, 3)}`).join(" · ")}
        <br>모델 쪽이 더 빨리 포화하는 방향이며, 모델은 그 차이를 고상태 지수로 메울 수 있습니다 —
        n_high 를 단일값으로 읽을 때 주의하십시오.
        <br><span class="muted">다만 occupancy <b>형태</b>를 데이터에서 결정하려는 시도는 실패했습니다(형태 파라미터가 세기 데이터만으로
        식별되지 않음). 이 편차를 해소하려면 전환 구간을 더 촘촘히 측정해 고상태 가지를 전환 근처에서 직접 고정해야 합니다.</span></div>`;
    }
  }
  // v3.2 — cross-branch occupancy. 히스테리시스가 있으면 반대 branch가 같은 파워의 고상태를
  // **직접 측정**하므로 외삽이 필요 없다. branch 내 추정과 크게 다르면 그 자체가 결과다.
  const xo = a.crossOcc;
  let xoBar = "", xoCard = "";
  if (xo && xo.checked) {
    if (xo.valid) {
      const wTxt = isFinite(xo.width1090) ? `${fmt(xo.width1090, 3)} dec` : "측정범위 내 미완결";
      const bias = isFinite(xo.withinBiasMedian) ? xo.withinBiasMedian : NaN;
      const sampled = xo.rows.filter((r) => r.f > 0.02 && r.f < 1.02);
      const step = Math.max(1, Math.ceil(sampled.length / 8));
      xoCard = `
    <div class="card" style="grid-column:span 2"><div class="k">cross-branch occupancy <span class="muted small">(반대 branch를 고상태 기준으로 — 외삽 없음)</span></div>
      <div class="v">10→90% 폭 ${wTxt}</div>
      <div class="s muted">히스테리시스 구간에서 반대 branch는 <b>같은 파워의 점등 상태를 직접 측정</b>합니다 —
        고상태 준위를 전환 너머로 외삽할 필요가 없습니다. 유효점 ${xo.nPoints}개 ·
        반환점 연속성 ${fmt(xo.continuity, 4)} (편차 ${fmt(100 * xo.bleachFrac, 3)}% — f 에 계통으로 반영)</div>
      ${xo.absolute === false ? `<div class="s tag-Low">이 branch가 최고 파워에서도 포화하지 않았습니다 —
        f 는 <b>절대 occupancy가 아니라 반대 branch 대비 상대값</b>입니다. 더 높은 파워까지 스윕해야 절대값이 됩니다.</div>` : ""}
      <div class="s muted">연속성은 반환점의 <b>계단</b>만 잡습니다. 점진적 광퇴색은 계단을 만들지 않고,
        한 번의 루프로는 광퇴색과 발광준위 히스테리시스가 분리되지 않습니다 — 분리하려면 루프를 반복해
        두 번째가 첫 번째를 재현하는지 보아야 합니다.</div>
      ${isFinite(bias) && bias > 1.3 ? `<div class="s tag-Low">branch 내 occupancy가 <b>${fmt(bias, 3)}배 부풀어</b> 있습니다 —
        외삽에 쓴 '전환 직후' 점들이 아직 부분 점등이라 고상태가 과소평가된 탓입니다.</div>` : ""}
      ${xo.monotone === false ? `<div class="s tag-Low">cross-branch f 가 단조롭지 않습니다 — 광퇴색이나 기준 branch 불안정을 의심하십시오.</div>` : ""}
      <table class="res" style="margin-top:6px"><tr><th>P (W)</th><th>이 branch</th><th>반대 branch(고상태)</th><th>f</th></tr>
        ${sampled.filter((_, i) => i % step === 0).map((r) =>
          `<tr><td class="num">${fmt(r.P, 4)}</td><td class="num">${fmt(r.I, 4)}</td><td class="num">${fmt(r.Iref, 4)}</td><td class="num"><b>${fmt(r.f, 3)}</b> ± ${fmt(r.fSd, 2)}</td></tr>`).join("")}</table></div>`;
      if (isFinite(bias) && bias > 1.3) {
        xoBar = `<div class="warnbar muted-warn">occupancy는 <b>cross-branch 측정값</b>을 쓰십시오 —
          branch 내 추정은 고상태 준위를 외삽하는데, 그 외삽에 쓰는 전환 직후 점들이 아직 부분 점등이라
          f 가 <b>${fmt(bias, 3)}배</b> 부풀어 오릅니다.
          이 파일의 실제 전환 폭은 10→90% 기준 <b>${wTxt}</b> 로, 모델이 맞춘 폭(${bs && isFinite(bs.width1090Dec) ? fmt(bs.width1090Dec, 3) : "-"} dec)보다 훨씬 넓습니다.</div>`;
      }
    } else if (xo.reason) {
      xoCard = `
    <div class="card"><div class="k">cross-branch occupancy</div>
      <div class="v" style="font-size:16px">해당 없음</div>
      <div class="s muted">${esc(xo.reason)}<br>반환점 연속성 ${fmt(xo.continuity, 4)} · 겹침 유효점 ${xo.nPoints || 0}개</div></div>`;
    }
  }
  const cards = `
  ${warnUnstable}${warnBound}${warnAgg}${profTxt}${bsBar}${occBar}${xoBar}
  <div class="cards">
    <div class="card hero"><div class="k">보고 PA (논문 표준: max[분해 front, 점프])${paBadge(a)}</div>
      <div class="v">${a.paSource === "lower-bound" || a.paGridLimited ? "≥ " : ""}${fmt(a.paReport, 4)}</div>
      <div class="s">${jumpWins ? `unresolved jump (Δlog₁₀P=${fmt(a.paJump.dlogP, 3)}) @ P=${fmt(a.paJump.pth, 4)} W`
        : a.paSource === "lower-bound"
          ? `model-free lower bound (secant) · <b>Δlog₁₀P = ${fmt(a.paReportDlogP, 3)} dec</b> 에서 결정 · P ${fmt(a.sLowerBound.pLo, 4)}→${fmt(a.sLowerBound.pHi, 4)} W`
        : a.paSource === "unresolved"
          ? `unidentified — 파라메트릭 s_max 를 그대로 싣지만 <b>point estimate가 아닙니다</b>`
          : `분해 front (모델 s_max) · 집계=${analysis._aggUsed === "high" ? "고상태" : "평균"}`}</div>
      ${a.paSource === "lower-bound" ? `<div class="s tag-Low">파라메트릭 s_max = ${fmt(a.sMax, 4)} 는 이 lower bound보다 작습니다 —
        <b>모델과 무관하게 refuted 값</b>이므로 보고하지 마십시오. lower bound는 평균값 정리로 성립하며(잡음 ${a.sLowerBound.z}σ 선공제),
        전이를 분해하려면 이 구간에서 파워 간격을 ${fmt(a.paReportDlogP, 3)} dec 보다 촘촘히 해야 합니다.</div>` : ""}
      ${a.paSource === "unresolved" ? `<div class="s tag-Low">${esc(unresolvedWhy(a))} — 이 값을 논문에 point estimate로 싣지 마십시오.
        model-free secant lower bound는 ${a.sLowerBound ? fmt(a.sLowerBound.slope, 4) + " (이 값보다 작아 lower bound 역할을 못 함)" : "산출되지 않았습니다"}.</div>` : ""}
      ${darkTxt(a)}${localFitTxt(a)}
      ${jumpWins ? `<div class="s muted">파라메트릭 s_max = ${fmt(a.sMax, 4)} — <b>보고값 아님</b>. 전선이 한 파워 스텝 안에서 끝나
        (Δlog₁₀P=${fmt(a.paJump.dlogP, 3)} ≤ 격자 ${fmt(a.medianDlogP, 3)}) 매끄러운 모델의 최대 기울기는 transition width 제약이 정하는 값입니다.
        bistable 점화는 이론적으로 불연속에 가까울 수 있으므로, 이 상황에서 옳은 보고는 point estimate가 아니라 위의 lower bound입니다.</div>` : ""}
      ${a.paGridLimited ? `<div class="s tag-Low">한 파워 스텝 안에서 dark→signal 점화 — 실제 PA는 이 값 이상. 더 촘촘한 파워 간격으로 재측정 시 분해 가능</div>` : ""}
      ${paSelectHtml(a)}</div>
    <div class="card"><div class="k">분해 front s_max${
      a.sMaxBoundReason === "secant" ? ' <span class="tag-Poor">refuted</span>'
      : a.sMaxBoundReason === "constraint" ? ' <span class="tag-Poor">unidentified</span>'
      : a.sMaxBoundReason === "range-edge" ? ' <span class="tag-Low">범위 끝 절단</span>' : ""}</div>
      <div class="v">${fmt(a.sMax, 4)}${boot ? ciStr(boot.ci.sMax) : ""}</div>
      <div class="s">@ P=${fmt(a.sMaxAtP, 4)} W · 스플라인 교차검증 ${fmt(a.sTotMax, 3)}</div>
      ${a.sMaxBoundReason === "range-edge" ? `<div class="s tag-Low">기울기가 측정범위 ${a.sMaxEdge === "left" ? "왼쪽" : "오른쪽"} 끝에서 최대 — 실제 s_max는 범위 밖일 수 있음</div>` : ""}
      ${a.sMaxBoundReason === "constraint" ? `<div class="s tag-Low">constraint boundary에 걸림 (${esc((a.boundHits || []).map((b) => b.param + "@" + b.at).join(", "))})
        — <b>unidentified</b>입니다. 합성 검증에서 이 상태의 s_max 는 참값보다 작을 때도, 클 때도 있었으므로 lower bound로도 읽으면 안 됩니다.</div>` : ""}
      ${a.sMaxBoundReason === "secant" ? `<div class="s tag-Low">model-free secant lower bound(${fmt(a.sLowerBound.slope, 4)})이 이 값을 넘습니다 — refuted</div>` : ""}</div>
    <div class="card"><div class="k">임계 파워</div>
      ${(() => {
        const tg = a.thresholdTangent && a.thresholdTangent.spline;
        const t1ok = isFinite(a.thresholdP) && a.thresholdP > 0;
        // 파라메트릭이 실패했거나 제약에 걸렸으면 접선-교점(model-free)을 주 보고값으로 올린다
        // v3.7: 관측 ignition bracket가 쓰였으면 그것이 이미 thresholdP 에 들어 있다(엔진이 판정).
        const fromIgnition = a.thresholdSource === "ignition-bracket";
        const preferTangent = !fromIgnition && !!tg && (!t1ok || (a.boundHits || []).length > 0);
        const main = preferTangent ? tg.P : (t1ok ? a.thresholdP : NaN);
        const dens = isFinite(kd) && isFinite(main) ? `<div class="s" style="color:var(--accent)">= ${fmt(main * kd / du.div, 4)} ${du.name}</div>` : "";
        return `<div class="v">${isFinite(main) ? fmt(main, 4) : "해당 없음"}<span class="s">${isFinite(main) ? " W" : ""}</span>${!preferTangent && boot && t1ok ? ciStr(boot.ci.threshold) : ""}</div>
      <div class="s">${fromIgnition ? "관측 ignition bracket <span class=\"muted\">(암준위 → 점등 전이, model-free)</span>"
        : preferTangent ? "접선-교점 · 비모수 스플라인 기준 <span class=\"muted\">(transition width 파라미터화에 의존하지 않음)</span>" : "상승 전이 중심 t₁"}</div>
      ${fromIgnition && a.thresholdBracket ? `<div class="s">브래킷 ${fmt(a.thresholdBracket[0], 4)} – ${fmt(a.thresholdBracket[1], 4)} W
        <span class="muted">(마지막 배경점 → 첫 점등점, Δlog₁₀P=${fmt(a.ignition.dlogP, 3)} dec)</span></div>` : ""}
      ${fromIgnition && isFinite(a.thresholdPModel) ? `<div class="s tag-Low">파라메트릭 t₁ = ${fmt(a.thresholdPModel, 4)} W 는
        <b>관측과 모순</b>입니다 — 그 파워에서 신호가 연속 3점 배경(게이트 ${fmt(a.ignition.gate, 4)})에 머물러 있습니다. 보고값에서 제외했습니다.</div>` : ""}
      ${fromIgnition && !isFinite(a.thresholdPModel) ? `<div class="s muted">파라메트릭 층은 문턱을 내지 못했습니다 (H${a.chosenOrder})</div>` : ""}
      ${preferTangent && t1ok ? `<div class="s muted">파라메트릭 t₁ = ${fmt(a.thresholdP, 4)} W (제약 접촉 — 참고값)</div>` : ""}
      ${preferTangent && !t1ok ? `<div class="s tag-Low">파라메트릭 층은 문턱을 내지 못했습니다 (H${a.chosenOrder})</div>` : ""}
      ${!preferTangent && tg ? `<div class="s muted">접선-교점 대조: ${fmt(tg.P, 4)} W</div>` : ""}
      ${a.thresholdOutOfRange && !preferTangent ? '<div class="s tag-Low">측정범위 밖 — 외삽값</div>' : ""}${dens}`;
      })()}</div>
    <div class="card"><div class="k">포화 파워 (하강 전이 중심 t₂)</div>
      <div class="v">${isFinite(a.saturationP) ? fmt(a.saturationP, 4) : "미관측"}<span class="s">${isFinite(a.saturationP) ? " W" : ""}</span>${boot && isFinite(a.saturationP) ? ciStr(boot.ci.saturation) : ""}</div>
      <div class="s">${isFinite(a.saturationP) ? "" : "측정범위 내에서 포화 전이 없음"}${satDens}</div></div>
${bsCard}${poolCard}${occCard}${xoCard}
    <div class="card"><div class="k">선택 모델 (중첩 AICc)</div><div class="v" style="font-size:14px;">H${a.chosenOrder}</div>
      <div class="s">${esc(orderLabel(a))}</div>
      <div class="s">배경 B=${fmt(a.background, 3)}${boot ? ciStr(boot.ci.B, 3) : ""}</div>
      <div class="s muted">노이즈: ${esc(nz.source || "-")} · ${esc(noiseTxt)}</div></div>
    <div class="card"><div class="k">품질 지수</div><div class="v"><span class="tag-${qb}">${fmt(q.score, 3)}/100</span></div>
      <div class="s"><span class="tag-${qb}">${qb}</span> · ${q.reportable ? "보고 가능" : "보고 주의"}${boot ? "" : " · 진단 실행 시 확정"}</div>
      ${st && st.checked ? `<div class="s ${st.stable ? "muted" : "tag-Low"}">수치 재현성: ${st.stable ? "안정 (차수·s_max 유지)" : "불안정 — s_max 보고 불가"}</div>` : ""}
      <div class="qbar"><div class="q-${qb}" style="width:${Math.round(q.score)}%"></div></div></div>
  </div>`;
  const aiccRows = [0, 1, 2].map((o2) => {
    const f = a.fitsSummary[o2];
    if (!f) return "";
    const d2 = f.aicc - a.fitsSummary[a.chosenOrder].aicc;
    return `<tr class="${o2 === a.chosenOrder ? "sel" : ""}"><td>H${o2} (${["멱법칙", "전이 1회", "전이 2회"][o2]})</td>
      <td class="num">${fmt(f.aicc, 5)}</td><td class="num">${o2 === a.chosenOrder ? "선택" : "+" + fmt(d2, 3)}</td><td class="num">${f.k}</td></tr>`;
  }).join("") + (a.bistable ? (() => {
    const bb = a.bistable, ref = a.fitsSummary[a.chosenOrder].aicc;
    return Object.entries(bb.fitsSummary).map(([o2, f]) => {
      if (!f) return "";
      const d2 = f.aicc - ref;
      const sel = Number(o2) === bb.chosenOrder;
      return `<tr class="${sel && bb.preferred ? "sel" : ""}"><td>BS${o2} (bistable${o2 === "1" ? " + 포화" : ""})</td>
        <td class="num">${fmt(f.aicc, 5)}</td><td class="num">${d2 < 0 ? fmt(d2, 3) : "+" + fmt(d2, 3)}</td><td class="num">${f.k}</td></tr>`;
    }).join("");
  })() : "");
  const noiseLine = `노이즈 모델 (${esc(a.noise.source)}): Var(I) = (${fmt(a.noise.a0, 3)})² + ${fmt(a.noise.a1, 3)}·I + (${fmt(a.noise.a2, 4)}·I)²`;
  const diagLine = `residual runs-test p=${fmt(d.runsP, 3)} · χ²_red=${fmt(d.chi2red, 3)} · 사용점 ${d.nUsed}/${d.nTotal}` +
    (d.outliers && d.outliers.length ? ` · <span class="tag-Low">outlier ${d.outliers.length}개 자동 제외</span>` : "") +
    ` · 스플라인 edf=${fmt(a.spline.edf, 3)}`;
  const qComp = `품질 구성: 적합성 ${fmt(q.components.adequacy, 3)} · identifiability ${fmt(q.components.identifiability, 3)} · 데이터 커버리지 ${fmt(q.components.coverage, 3)} · 층간 일치 ${fmt(q.components.agreement, 3)}`;
  const notes = [
    `모델: I(P) = B + 10^h(log₁₀P), h는 smooth-hinge 체인 (H0⊂H1⊂H2 중첩 · AICc+절약 가드 ΔAICc>4)`,
    `s(P)는 파라메트릭 해석해와 단조 P-spline(GCV) 미분 두 경로로 독립 추정 → 상호 검증 (차이 ${fmt(a.agreement.sMaxGapPct, 3)}%)`,
    `가중치: 데이터에서 추정한 3성분 분산모델 → glog 변환 후 delta-method σ; Huber+bisquare IRLS로 outlier 내성`,
    `CI: 전체 파이프라인 파라메트릭 부트스트랩 (시드 고정) + basic CI + 벤치마크 보정 κ=1.6`,
  ];
  el.innerHTML = cards +
    `<table class="res" style="margin-top:10px;max-width:520px;">
      <tr><th>중첩 모델</th><th>AICc</th><th>ΔAICc</th><th>k</th></tr>${aiccRows}</table>
    <div class="small muted" style="margin-top:8px;">${noiseLine}</div>
    <div class="small muted">${diagLine}</div>
    <div class="small muted">${qComp}</div>
    ${a.bistable && a.bistable.preferred ? `<div class="small muted">품질 지수와 위 진단값은 <b>H 족 적합</b>에 대한 것입니다 — 이 데이터에서는 bistable 서술이 더 지지되므로(ΔAICc ${fmt(a.bistable.aiccVsH, 5)}) 낮은 점수는 'H 족이 이 데이터에 맞지 않는다'는 뜻으로 읽으십시오.</div>` : ""}
    <details style="margin-top:10px;"><summary class="small muted" style="cursor:pointer;">방법 노트</summary>
     <ul class="notes">${notes.map((n) => `<li>${n}</li>`).join("")}</ul></details>`;
}

async function runDiagnosticsUI(rec) {
  const key = analysisKey();
  const analysis = rec.cache[key];
  const out = $("#diag-results");
  if (!analysis) { toast("먼저 피팅을 완료하세요"); return; }
  App.settings.bootstrapN = Number($("#c-bootn").value) || 150;
  saveSettings();
  const btn = $("#c-diag");
  btn.disabled = true;
  out.innerHTML = `<span class="muted">진단 실행 중…</span>`;
  const t0 = performance.now();
  try {
    const res = await rpc("boot2", { analysis, options: { nBoot: App.settings.bootstrapN, seed: 20260808 } },
      (f, l) => { setProgress(f); out.innerHTML = `<span class="muted">진단 실행 중… ${esc(l || "")}</span>`; });
    setProgress(1);
    analysis.diag = res;
    analysis.quality = PrismFit.evaluate(analysis, res);
    const fmci = (pair, dg) => isFinite(pair[0]) ? `[${fmt(pair[0], dg || 4)}, ${fmt(pair[1], dg || 4)}]` : "–";
    out.innerHTML = `
    <table class="res" style="max-width:660px;">
      <tr><th></th><th>95% CI (부트스트랩 ${res.nSuccess}/${res.nBoot}회 성공)</th></tr>
      <tr><td>s_max</td><td class="num">${fmci(res.ci.sMax)}</td></tr>
      <tr><td>s_max 위치 P</td><td class="num">${fmci(res.ci.sMaxAtP)}</td></tr>
      <tr><td>임계 파워 t₁</td><td class="num">${fmci(res.ci.threshold)}</td></tr>
      <tr><td>포화 파워 t₂</td><td class="num">${fmci(res.ci.saturation)}</td></tr>
      <tr><td>배경 B</td><td class="num">${fmci(res.ci.B, 3)}</td></tr>
    </table>
    <div class="small muted" style="margin-top:6px;">${esc(res.method)} · 시드 ${res.seed} · 모델차수 변동 ${res.orderFlips}/${res.nSuccess}회 · 노이즈 스케일 보정 ×${fmt(res.scaleFactor, 3)} · ${((performance.now() - t0) / 1000).toFixed(0)}s</div>`;
    renderFitResults(rec, analysis);
    drawSlopeChart(rec, analysis);
  } catch (e) {
    out.innerHTML = `<span class="tag-Poor">진단 실패: ${esc(e.message)}</span>`;
  } finally { btn.disabled = false; setProgress(null); }
}

/* EMCCD spectrum preview with band shading */
function renderEmccdSpecPreview(rec) {
  const el = $("#chart-spec");
  if (!el) return;
  const raw = rec.cache.rawEMCCD || (rec.cache.rawEMCCD = PrismH5.extractPowerScanEMCCD(rec.h5, rec.det));
  const n = raw.spectra.n, pix = raw.spectra.pix, reps = raw.spectra.reps;
  const slider = $("#spec-idx");
  slider.max = String(n - 1);
  const draw = () => {
    const i = Number(slider.value);
    const spec = new Array(pix);
    for (let p2 = 0; p2 < pix; p2++) {
      let s = 0;
      for (let r = 0; r < reps; r++) s += raw.spectra.data[(i * reps + r) * pix + p2];
      spec[p2] = s / reps;
    }
    const loaded = getLoaded(rec);
    $("#spec-idx-label").textContent = `#${i} · P=${fmt(loaded.xRawAvg[i], 4)}`;
    newPlot(el, [{ x: raw.wls, y: spec, mode: "lines", type: "scatter", name: "spectrum",
      line: { color: PALETTE.blue, width: 1.6 }, hovertemplate: "λ=%{x:.1f} nm<br>I=%{y:.4g}<extra></extra>" }], {
      margin: { l: 62, r: 18, t: 10, b: 42 },
      xaxis: Object.assign(baseLayout().xaxis, { title: { text: "Wavelength (nm)" } }),
      yaxis: Object.assign(baseLayout().yaxis, { title: { text: "Counts (avg)" } }),
      showlegend: false,
      shapes: [{ type: "rect", x0: App.settings.bandMin, x1: App.settings.bandMax, yref: "paper", y0: 0, y1: 1,
        fillcolor: "rgba(195,194,183,0.13)", line: { width: 0 } }],
    });
  };
  slider.oninput = draw;
  draw();
}

/* ------------------------- power scan exports ----------------------------- */
function exportChartPng(rec, sel, suffix) {
  openReportForChart($(sel));
}
function exportPowerCsv(rec) {
  const a = currentAnalysis(rec);
  if (!a) { toast("피팅 결과가 없습니다"); return; }
  const kd = densityFactor();
  const rows = [["power_W", ...(isFinite(kd) ? ["power_density_mW_cm2"] : []), "intensity_avg", "sigma_I", "model_H" + a.chosenOrder, "excluded_outlier"]];
  for (let i = 0; i < a.data.P.length; i++) {
    const xv = a.data.x[i];
    // model at data x
    const mi = a.modelCurve[Math.round((xv - a.grid[0]) / (a.grid[a.grid.length - 1] - a.grid[0]) * (a.grid.length - 1))];
    rows.push([a.data.P[i], ...(isFinite(kd) ? [a.data.P[i] * kd] : []), a.data.I[i], a.data.sigI[i], mi, a.mask && !a.mask[i] ? 1 : 0]);
  }
  rows.push([]);
  rows.push(["# slope curve"]);
  rows.push(["power_W", "s_sig_parametric", "s_tot_spline"]);
  for (let i = 0; i < a.grid.length; i++) rows.push([Math.pow(10, a.grid[i]), a.sSig[i], a.sTot[i]]);
  downloadText(rec.name.replace(/\.h5$/i, "") + "_powerfit.csv", rowsToCsv(rows), "text/csv");
}
function exportPowerJson(rec) {
  const a = currentAnalysis(rec);
  if (!a) { toast("피팅 결과가 없습니다"); return; }
  const slim = JSON.parse(JSON.stringify(a, (k, v) => (v === undefined ? null : v)));
  const calib = Object.assign({}, App.calib, { beam: App.calib.beam ? Object.assign({}, App.calib.beam, { preview: undefined }) : null });
  delete calib.ledger;   // Firebase API Key/UID 등 연동 자격정보 — 내보내기 파일에 남기지 않는다
  const man = computeManualSlope(rec);
  downloadText(rec.name.replace(/\.h5$/i, "") + "_analysis.json",
    JSON.stringify({ app: "INNO Prism", engine: "PrismFit " + PrismFit.VERSION, file: rec.name, settings: App.settings,
      calibration: calib, densityFactor_mWcm2_per_W: densityFactor() || null,
      segpa: { up: segpaFor(rec, "up"), down: segpaFor(rec, "down") },
      manualSlope: man && man.chord !== undefined ? { range_W: rec.cache.manualRange, chord: man.chord, lsq: man.lsq, n: man.n } : null,
      analysis: slim }, null, 1), "application/json");
}
function summaryText(rec) {
  const a = currentAnalysis(rec);
  if (!a) return "(no result)";
  const q = a.quality, boot = a.diag, kd = densityFactor();
  const ci = (pair) => boot && pair && isFinite(pair[0]) ? ` [${fmt(pair[0], 4)}, ${fmt(pair[1], 4)}]` : "";
  const lines = [
    `INNO Prism power-scan fit (PrismFit ${a.version}) — ${rec.name}`,
    `REPORTED PA = ${a.paSource === "lower-bound" || a.paGridLimited ? ">= " : ""}${fmt(a.paReport, 4)} (${
      a.paSource === "jump" ? `unresolved jump, dlog10P=${fmt(a.paJump.dlogP, 3)}`
      : a.paSource === "lower-bound" ? `MODEL-FREE LOWER BOUND (secant), dlog10P=${fmt(a.paReportDlogP, 3)}`
      : a.paSource === "unresolved" ? `UNIDENTIFIED — not a point estimate (${(a.boundHits || []).map((b) => b.param).join(",") || a.sMaxEdge || "?"})`
      : "resolved front"}; agg=${a._aggUsed || "mean"})`,
    `branch=${a._branchUsed} · model=H${a.chosenOrder} (${orderLabel(a)})`,
    `s_max = ${fmt(a.sMax, 4)}${a.sMaxIsLowerBound ? " (lower bound, edge-censored)" : ""}${ci(boot && boot.ci.sMax)} @ P=${fmt(a.sMaxAtP, 4)} W`,
    `threshold t1 = ${isFinite(a.thresholdP) ? fmt(a.thresholdP, 5) + " W" : "n/a"}${ci(boot && boot.ci.threshold)}${isFinite(kd) && isFinite(a.thresholdP) ? ` = ${(() => { const u = activeDensityUnit(); return fmt(a.thresholdP * kd / u.div, 5) + " " + u.name; })()}` : ""}`,
    `saturation t2 = ${isFinite(a.saturationP) ? fmt(a.saturationP, 5) + " W" : "not observed"}${ci(boot && boot.ci.saturation)}${isFinite(kd) && isFinite(a.saturationP) ? ` = ${(() => { const u = activeDensityUnit(); return fmt(a.saturationP * kd / u.div, 5) + " " + u.name; })()}` : ""}`,
    `background B = ${fmt(a.background, 4)} · k1/k2/k3 = ${fmt(a.params.k1, 4)}/${fmt(a.params.k2, 4)}/${fmt(a.params.k3, 4)}`,
    `spline cross-check s_max = ${fmt(a.sTotMax, 4)} (gap ${fmt(a.agreement.sMaxGapPct, 3)}%)`,
    `runs-test p=${fmt(a.diagnostics.runsP, 3)} · chi2_red=${fmt(a.diagnostics.chi2red, 3)} · quality=${fmt(q.score, 3)}/100 (${q.band})`,
  ];
  if (a.slopeProfile && a.slopeProfile.verdict) {
    const sp = a.slopeProfile;
    lines.push(`fixed-slope profile likelihood (H${sp.order}, n=${sp.nUsed}, dchi2_crit=${sp.dChi2Crit}): verdict=${sp.verdict}`
      + (sp.verdict === "unbounded" ? ` — every cap up to ${sp.gridTop} rejected; reported s_max=${fmt(a.sMax, 4)} is rejected by its own likelihood`
        : sp.verdict === "bounded" ? ` — s_max > ${sp.floor}${isFinite(sp.floorNext) ? ` (<= ${sp.floorNext} allowed)` : ""}; reported s_max=${fmt(a.sMax, 4)} ${sp.reportedRejected ? "REJECTED" : "consistent"}`
        : ` — no cap rejected`));
    lines.push(`  dchi2 by cap: ${sp.caps.map((r) => `${r.cap}=${fmt(r.dChi2, 1)}`).join(", ")}`);
  }
  if (a.bistable) {
    const b = a.bistable;
    const lowOk = b.identifiability && b.identifiability.lowVisible;
    lines.push(`bistable (BS${b.chosenOrder}, n=${b.nUsed}): chi2=${fmt(b.chi2, 5)} AICc=${fmt(b.aicc, 5)} dAICc(vs H${a.chosenOrder})=${fmt(b.aiccVsH, 5)} preferred=${b.preferred}`);
    lines.push(`  P_switch = ${fmt(b.pSwitch, 5)} W` + (b.pSwitchBracket ? ` [${fmt(b.pSwitchBracket[0], 4)}, ${fmt(b.pSwitchBracket[1], 4)}]` : "")
      + ` · omega = ${fmt(b.switchWidthDec, 3)} dec${b.widthSubGrid ? " (sub-grid)" : ""}`);
    if (a.occSourceUsed && a.occSourceUsed !== "none") {
      lines.push(`  occupancy constraint: ${a.occSourceUsed} (${a.occConstraintN} pts)`
        + (isFinite(b.chi2VsUnconstrained) ? ` · intensity chi2 vs unconstrained = ${fmt(b.chi2VsUnconstrained, 3)}x` : "")
        + (b.occWithdrawn ? ` · WITHDRAWN (> ${fmt(b.occConflictMax, 2)}x) - values below are the UNCONSTRAINED fit` : ""));
    }
    lines.push(`  high-state range above P_s = ${fmt(b.nHighRangeDec, 3)} dec (need ${fmt(b.nHighRangeMin, 2)})`);
    lines.push(`  n_high = ${b.rangeOk === false ? `undetermined (range ${fmt(b.nHighRangeDec, 3)} dec < ${fmt(b.nHighRangeMin, 2)} - extend the sweep to higher power)`
      : b.nHighCollapsed ? `undetermined (n_H=${fmt(b.params ? b.params.nH : NaN, 3)} < floor ${fmt(b.nHighFloor, 2)} - flat high state)`
      : (isFinite(b.nHighSingle) ? fmt(b.nHighSingle, 4)
      : "not a single exponent [" + b.nHighProfile.map((r) => `${r.mult}x:${fmt(r.n, 3)}`).join(", ") + "]")}`
      + ` · n_low = ${lowOk ? fmt(b.nLow, 4) : "undetermined (low branch below dark floor)"}`);
    lines.push(`  log10 contrast = ${lowOk ? fmt(b.log10Contrast, 4) : ">= " + fmt(b.log10ContrastLB, 4)}`);
    const hy = hysteresisOf(rec, a);
    if (hy) lines.push(`  hysteresis P_up/P_down = ${fmt(hy.ratio, 4)} (${fmt(hy.dec, 3)} dec; up ${fmt(hy.pUp, 4)} W, down ${fmt(hy.pDown, 4)} W)`);
  }
  if (a.occupancy && a.occupancy.checked) {
    const o2 = a.occupancy;
    lines.push(`duty cycle (replicate dispersion, chi2_nu=${o2.nu} + BH-FDR ${fmt(o2.fdr, 2)}): ${o2.nBlink}/${o2.nRows} setpoints over-dispersed, f monotone=${o2.fMonotone}`
      + (o2.nOtherDispersed ? ` (+${o2.nOtherDispersed} over-dispersed but not two-level)` : "") + (o2.global ? " [GLOBAL - likely instrumental]" : ""));
    if (isFinite(o2.detectCoverage)) {
      lines.push(`  detection covers ${fmt(100 * o2.detectCoverage, 2)}% of the cross-branch transition`
        + (isFinite(o2.hiPointsOcc) ? ` · points used for the high level are f=${fmt(o2.hiPointsOcc, 3)} on` : "")
        + ` · partial-on screening ${o2.screened ? "ON" : "off"}`);
    }
    for (const r of o2.rows.filter((qq) => qq.blink && isFinite(qq.fMean)).slice(0, 12)) {
      lines.push(`  P=${fmt(r.P, 5)} W  mean=${fmt(r.mean, 5)}  f=${fmt(r.fMean, 3)}+-${fmt(r.fSd, 2)} (stat ${fmt(r.fSdStat, 2)} / sys ${fmt(r.fSdSys, 2)})  kappa=${isFinite(r.kappa) ? fmt(r.kappa, 3) : "-"}  varRatio=${fmt(r.ratioAdj, 3)}`);
    }
    if (a.bistable && a.bistable.occCheck && a.bistable.occCheck.n) {
      const c = a.bistable.occCheck;
      lines.push(`  model f(P) vs measured: chi2=${fmt(c.chi2, 4)} max|z|=${fmt(c.maxAbsZ, 3)} agrees=${c.agrees} constrained=${c.constrained}`);
    }
  }
  if (a.crossOcc && a.crossOcc.checked) {
    const c2 = a.crossOcc;
    lines.push(`cross-branch occupancy (${c2.branch}): valid=${c2.valid} absolute=${c2.absolute} continuity=${fmt(c2.continuity, 4)} turnaround-mismatch=${fmt(100 * c2.bleachFrac, 3)}%`
      + (c2.valid ? ` n=${c2.nPoints} width10-90=${isFinite(c2.width1090) ? fmt(c2.width1090, 4) + " dec" : "n/a"} monotone=${c2.monotone}` : ` - ${c2.reason}`));
    if (c2.valid && isFinite(c2.withinBiasMedian)) lines.push(`  within-branch occupancy inflated by x${fmt(c2.withinBiasMedian, 3)} (extrapolated high level is itself only partly on)`);
    if (c2.valid) for (const r of c2.rows.filter((q) => q.f > 0.02 && q.f < 1.02)) {
      lines.push(`  P=${fmt(r.P, 5)} W  I=${fmt(r.I, 5)}  I_ref=${fmt(r.Iref, 5)}  f=${fmt(r.f, 3)}+-${fmt(r.fSd, 2)}`);
    }
  }
  const man = computeManualSlope(rec);
  if (man && man.chord !== undefined) lines.push(`manual chord slope = ${fmt(man.chord, 5)} (n=${man.n}, LSQ=${fmt(man.lsq, 4)})`);
  return lines.join("\n");
}
function copySummary(rec) {
  navigator.clipboard.writeText([segpaSummaryText(rec), summaryText(rec)].filter(Boolean).join("\n")).then(() => toast("요약이 복사되었습니다"));
}

/* ------------------------- EMCCD readout view ----------------------------- */
function renderEmccdReadout(rec) {
  const d = rec.cache.readout || (rec.cache.readout = PrismH5.extractEmccdReadout(rec.h5));
  $("#view").innerHTML = `
  <div class="panel"><h3>EMCCD 스펙트럼</h3><div id="chart-em" class="chart chart-mid"></div>
    <div class="flex" style="margin-top:8px;">
      <label class="ctl"><span>적분 min (nm)</span><input id="em-min" type="number" value="${App.settings.bandMin}"></label>
      <label class="ctl"><span>적분 max (nm)</span><input id="em-max" type="number" value="${App.settings.bandMax}"></label>
      <button id="em-int" class="small">적분값 계산</button>
      <span id="em-int-out" class="mono small"></span>
      <span class="right"><button id="em-csv" class="small">CSV</button></span>
    </div></div>
  <div class="panel"><h3>취득 설정</h3><div class="attr-box mono small">${attrsHtml(d.settings)}</div></div>`;
  const wl = d.wavelengths, sp = d.spectrum;
  newPlot($("#chart-em"), [{ x: wl, y: sp, mode: "lines", name: "spectrum", line: { color: PALETTE.blue, width: 1.8 },
    hovertemplate: "λ=%{x:.2f} nm<br>I=%{y:.5g}<extra></extra>" }], {
    xaxis: Object.assign(baseLayout().xaxis, { title: { text: "Wavelength (nm)" } }),
    yaxis: Object.assign(baseLayout().yaxis, { title: { text: "Intensity (counts)" } }),
    showlegend: false,
  });
  $("#em-int").addEventListener("click", () => {
    const lo = Number($("#em-min").value), hi = Number($("#em-max").value);
    let s = 0, c = 0;
    for (let i = 0; i < wl.length; i++) if (wl[i] >= lo && wl[i] <= hi) { s += sp[i]; c++; }
    $("#em-int-out").textContent = `∑(${lo}–${hi} nm) = ${fmt(s, 6)} (${c} px)`;
  });
  $("#em-csv").addEventListener("click", () => {
    const rows = [["wavelength_nm", "intensity"]];
    for (let i = 0; i < wl.length; i++) rows.push([wl[i], sp[i]]);
    downloadText(rec.name.replace(/\.h5$/i, "") + "_spectrum.csv", rowsToCsv(rows), "text/csv");
  });
}
/** hardware/ 연결 현황. **이름을 광학계로 읽지 말라**는 경고가 본체다. */
function imgHardwareHtml(d) {
  const h = d.hardware;
  if (!h || !h.rows.length) return "";
  const cam = d.camera;
  const badge = (r) => r.connected === true ? '<span class="tag-High">연결됨</span>'
    : r.connected === false ? '<span class="muted">연결 안 됨</span>' : '<span class="muted">기록 없음</span>';
  const rows = h.rows.map((r) => `<tr${cam && r.name === cam.name ? ' style="background:rgba(57,135,229,.10)"' : ""}>
    <td class="mono">${esc(r.name)}${cam && r.name === cam.name ? " <b>← 이 측정의 카메라</b>" : ""}</td>
    <td>${badge(r)}</td><td class="mono">${r.nAttrs}</td><td class="mono muted">${r.port ? esc(r.port) : ""}</td></tr>`).join("");
  const rej = cam && cam.rejected && cam.rejected.length
    ? `<div class="s muted">카메라 후보가 ${cam.nCandidates}개였고 연결된 것을 택했습니다 —
        제외: ${cam.rejected.map((x) => `<span class="mono">${esc(x.name)}</span>(${x.connected ? "연결됨" : "미연결"})`).join(", ")}.</div>`
    : "";
  return `<details style="margin-top:8px;"><summary class="small">하드웨어 연결 현황 (${h.nConnected} 연결 · ${h.nDisconnected} 미연결)</summary>
    <div class="s" style="margin-top:6px;"><b>이름만 보고 이 측정의 광학계라고 읽지 마십시오.</b>
      ScopeFoundry 는 앱에 등록된 하드웨어를 <b>전부</b> h5 에 적습니다 — 이 측정에 쓰이지 않은 장비,
      다른 방의 구성, 실물이 없는 항목까지 설정이 그대로 남습니다.
      <b>연결 안 된 항목의 설정값은 이 측정에 대해 아무것도 말해 주지 않습니다.</b></div>
    <table class="res" style="margin-top:6px;"><thead><tr><th>hardware</th><th>연결</th><th>속성 수</th><th>port</th></tr></thead>
      <tbody>${rows}</tbody></table>${rej}</details>`;
}
function attrsHtml(attrs) {
  const keys = Object.keys(attrs || {});
  if (!keys.length) return `<span class="muted">속성 없음</span>`;
  return keys.sort().map((k) => `${esc(k)} = ${esc(attrValueText(attrs[k]))}`).join("<br>");
}
/** h5wasm 는 HDF5 int64 속성을 **BigInt** 로 돌려준다. JSON.stringify 는 BigInt 에서
 *  TypeError 를 던지므로(ScopeFoundry 의 num_cycle 등이 int64 다) 직접 문자열화한다.
 *  긴 배열은 앞부분만 보이고 길이를 밝힌다 — 속성 상자가 한 줄로 화면을 밀지 않도록. */
function attrValueText(v) {
  if (typeof v === "bigint") return String(v);
  if (v === null || v === undefined) return String(v);
  if (ArrayBuffer.isView(v)) v = Array.from(v);
  if (Array.isArray(v)) {
    const head = v.slice(0, 12).map(attrValueText).join(", ");
    return v.length > 12 ? `[${head}, … ] (${v.length}개)` : `[${head}]`;
  }
  if (typeof v === "object") {
    try { return JSON.stringify(v, (kk, vv) => (typeof vv === "bigint" ? String(vv) : vv)); }
    catch (e) { return String(v); }
  }
  return typeof v === "string" ? `"${v}"` : String(v);
}

/* ------------------------------ PLE view ---------------------------------- */
/* Faithful re-implementation of the original INNO Data Analyzer PLE viewer:
 * 2D map (X=excitation, Y=emission, turbo), 3D surface / line-spectrogram,
 * λ_ex/λ_em index-slice trace panels, and the full save bundle. */
function renderPLE(rec) {
  const d = rec.cache.ple || (rec.cache.ple = PrismH5.extractPLE(rec.h5, rec.det.pleGroup));
  const nEx = d.excitation.length, nEm = d.emission.length;
  if (!rec.cache.pleState) rec.cache.pleState = { exIdx: Math.floor(nEx / 2), emIdx: Math.floor(nEm / 2), cmap: "Turbo", scale: "lin", mode3d: "surface" };
  const st = rec.cache.pleState;
  $("#view").innerHTML = `
  <div class="panel"><h3>PLE 2D 맵 <span class="muted small">${esc(d.group)} · Z = counts</span></h3>
    <div class="flex small" style="margin-bottom:6px;">
      <label class="ctl"><span>컬러맵</span><select id="ple-cmap"><option>Turbo</option><option>Viridis</option><option>Greys</option><option>Hot</option></select></label>
      <label class="ctl"><span>스케일</span><select id="ple-scale"><option value="lin">linear</option><option value="log">log</option></select></label>
      <span class="muted small">맵 클릭 → 해당 λ_ex/λ_em 슬라이스 선택</span>
      <span class="right flex">
        <button id="ple-png-map" class="small">맵 PNG</button>
        <button id="ple-csv-matrix" class="small">Matrix CSV</button>
      </span>
    </div>
    <div id="chart-ple" class="chart" style="height:430px;"></div></div>
  <div class="panel"><h3>PLE 3D</h3>
    <div class="flex small" style="margin-bottom:6px;">
      <label class="ctl"><span>렌더 모드</span><select id="ple-3dmode"><option value="surface">Surface</option><option value="lines">Line spectrogram</option></select></label>
      <span class="right"><button id="ple-png-3d" class="small">3D PNG</button></span>
    </div>
    <div id="chart-ple3d" class="chart" style="height:460px;"></div></div>
  <div class="panel"><h3>슬라이스 트레이스</h3>
    <div class="flex small" style="margin-bottom:6px;flex-wrap:wrap;gap:14px;">
      <span>여기 λ_ex 인덱스: <input id="ple-ex-idx" type="range" min="0" max="${nEx - 1}" value="${st.exIdx}" style="width:200px;vertical-align:middle;">
        <span id="ple-ex-label" class="mono"></span></span>
      <span>방출 λ_em 인덱스: <input id="ple-em-idx" type="range" min="0" max="${nEm - 1}" value="${st.emIdx}" style="width:200px;vertical-align:middle;">
        <span id="ple-em-label" class="mono"></span></span>
      <span class="right flex">
        <button id="ple-png-em" class="small">방출스펙트럼 PNG</button>
        <button id="ple-png-ex" class="small">PLE PNG</button>
        <button id="ple-csv-slices" class="small">슬라이스 CSV</button>
      </span>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
      <div id="chart-ple-em" class="chart" style="height:300px;"></div>
      <div id="chart-ple-ex" class="chart" style="height:300px;"></div>
    </div></div>`;

  const zFor = () => st.scale === "log" ? d.z.map((row) => row.map((v) => Math.log10(Math.max(v, 1e-12)))) : d.z;
  const drawMap = () => {
    // original layout: X=excitation, Y=emission → z^T relative to our [ex][em]
    const zT = [];
    for (let j = 0; j < nEm; j++) { const row = new Array(nEx); for (let i = 0; i < nEx; i++) row[i] = zFor()[i][j]; zT.push(row); }
    newPlot($("#chart-ple"), [{ x: d.excitation, y: d.emission, z: zT, type: "heatmap", colorscale: cmapValue(st.cmap),
      colorbar: { title: { text: st.scale === "log" ? "log10 counts" : "Counts (a.u.)", side: "right" }, outlinewidth: 0, thickness: 14 },
      hovertemplate: "여기 %{x:.2f} nm<br>방출 %{y:.2f} nm<br>I=%{z:.5g}<extra></extra>" }], {
      xaxis: Object.assign(baseLayout().xaxis, { title: { text: "Excitation wavelength (nm)" } }),
      yaxis: Object.assign(baseLayout().yaxis, { title: { text: "Emission wavelength (nm)" } }),
    }).then(() => {
      const el = $("#chart-ple");
      el.removeAllListeners && el.removeAllListeners("plotly_click");
      el.on("plotly_click", (ev) => {
        const pt = ev.points[0];
        let bi = 0, bd = Infinity;
        d.excitation.forEach((v, i) => { const dd = Math.abs(v - pt.x); if (dd < bd) { bd = dd; bi = i; } });
        st.exIdx = bi;
        bd = Infinity;
        d.emission.forEach((v, j) => { const dd = Math.abs(v - pt.y); if (dd < bd) { bd = dd; st.emIdx = j; } });
        $("#ple-ex-idx").value = st.exIdx;
        $("#ple-em-idx").value = st.emIdx;
        drawTraces();
      });
    });
  };
  const draw3d = () => {
    const el = $("#chart-ple3d");
    if (st.mode3d === "lines") {
      // one 3D line per excitation wavelength, colored along a colormap
      const traces = [];
      const step = Math.max(1, Math.ceil(nEx / 80));
      for (let i = 0; i < nEx; i += step) {
        traces.push({
          type: "scatter3d", mode: "lines",
          x: new Array(nEm).fill(d.excitation[i]), y: d.emission, z: d.z[i],
          line: { width: 2.5, color: d.z[i], colorscale: cmapValue(st.cmap) },
          hovertemplate: `여기 ${d.excitation[i].toFixed(1)} nm<br>방출 %{y:.1f} nm<br>I=%{z:.4g}<extra></extra>`,
          showlegend: false,
        });
      }
      newPlot(el, traces, {
        scene: {
          xaxis: { title: { text: "Excitation λ (nm)" }, gridcolor: "#2b2b28", color: "#c3c2b7" },
          yaxis: { title: { text: "Emission λ (nm)" }, gridcolor: "#2b2b28", color: "#c3c2b7" },
          zaxis: { title: { text: "Counts (a.u.)" }, gridcolor: "#2b2b28", color: "#c3c2b7" },
          bgcolor: "#1a1a19",
          camera: { eye: { x: -1.4, y: -1.5, z: 0.9 } },
        },
        margin: { l: 0, r: 0, t: 8, b: 0 },
      });
    } else {
      const zT = [];
      for (let j = 0; j < nEm; j++) { const row = new Array(nEx); for (let i = 0; i < nEx; i++) row[i] = d.z[i][j]; zT.push(row); }
      newPlot(el, [{ type: "surface", x: d.excitation, y: d.emission, z: zT, colorscale: cmapValue(st.cmap),
        colorbar: { outlinewidth: 0, thickness: 12 },
        hovertemplate: "여기 %{x:.1f} nm<br>방출 %{y:.1f} nm<br>I=%{z:.4g}<extra></extra>" }], {
        scene: {
          xaxis: { title: { text: "Excitation λ (nm)" }, gridcolor: "#2b2b28", color: "#c3c2b7" },
          yaxis: { title: { text: "Emission λ (nm)" }, gridcolor: "#2b2b28", color: "#c3c2b7" },
          zaxis: { title: { text: "Counts (a.u.)" }, gridcolor: "#2b2b28", color: "#c3c2b7" },
          bgcolor: "#1a1a19",
          camera: { eye: { x: -1.4, y: -1.5, z: 0.9 } },
        },
        margin: { l: 0, r: 0, t: 8, b: 0 },
      });
    }
  };
  const drawTraces = () => {
    st.exIdx = Number($("#ple-ex-idx").value);
    st.emIdx = Number($("#ple-em-idx").value);
    $("#ple-ex-label").textContent = `${d.excitation[st.exIdx].toFixed(3)} nm`;
    $("#ple-em-label").textContent = `${d.emission[st.emIdx].toFixed(3)} nm`;
    newPlot($("#chart-ple-em"), [{ x: d.emission, y: d.z[st.exIdx], mode: "lines",
      line: { color: PALETTE.blue, width: 1.6 }, name: "emission",
      hovertemplate: "방출 %{x:.2f} nm<br>I=%{y:.5g}<extra></extra>" }], {
      margin: { l: 58, r: 12, t: 30, b: 44 },
      title: { text: `Emission spectrum @ λ_ex = ${d.excitation[st.exIdx].toFixed(3)} nm`, font: { size: 12.5 } },
      xaxis: Object.assign(baseLayout().xaxis, { title: { text: "Emission wavelength (nm)" } }),
      yaxis: Object.assign(baseLayout().yaxis, { title: { text: "Counts (a.u.)" } }),
      showlegend: false,
    });
    newPlot($("#chart-ple-ex"), [{ x: d.excitation, y: d.z.map((row) => row[st.emIdx]), mode: "lines",
      line: { color: PALETTE.orange, width: 1.6 }, name: "PLE",
      hovertemplate: "여기 %{x:.2f} nm<br>I=%{y:.5g}<extra></extra>" }], {
      margin: { l: 58, r: 12, t: 30, b: 44 },
      title: { text: `PLE spectrum @ λ_em = ${d.emission[st.emIdx].toFixed(3)} nm`, font: { size: 12.5 } },
      xaxis: Object.assign(baseLayout().xaxis, { title: { text: "Excitation wavelength (nm)" } }),
      yaxis: Object.assign(baseLayout().yaxis, { title: { text: "Counts (a.u.)" } }),
      showlegend: false,
    });
  };
  $("#ple-cmap").value = st.cmap;
  $("#ple-scale").value = st.scale;
  $("#ple-3dmode").value = st.mode3d;
  $("#ple-cmap").addEventListener("change", () => { st.cmap = $("#ple-cmap").value; drawMap(); draw3d(); });
  $("#ple-scale").addEventListener("change", () => { st.scale = $("#ple-scale").value; drawMap(); });
  $("#ple-3dmode").addEventListener("change", () => { st.mode3d = $("#ple-3dmode").value; draw3d(); });
  $("#ple-ex-idx").addEventListener("input", drawTraces);
  $("#ple-em-idx").addEventListener("input", drawTraces);
  const stem = rec.name.replace(/\.h5$/i, "");
  const pngOf = (sel) => openReportForChart($(sel));
  $("#ple-png-map").addEventListener("click", () => pngOf("#chart-ple", `${stem}_PLE_2D_map.png`));
  $("#ple-png-3d").addEventListener("click", () => pngOf("#chart-ple3d", `${stem}_PLE_3D.png`));
  $("#ple-png-em").addEventListener("click", () => pngOf("#chart-ple-em", `${stem}_PLE_emission_slice.png`));
  $("#ple-png-ex").addEventListener("click", () => pngOf("#chart-ple-ex", `${stem}_PLE_excitation_slice.png`));
  $("#ple-csv-matrix").addEventListener("click", () => {
    // original format: first row = excitation wavelengths; rows = emission λ
    const rows = [["emission_vs_excitation", ...d.excitation]];
    for (let j = 0; j < nEm; j++) rows.push([d.emission[j], ...d.z.map((row) => row[j])]);
    downloadText(`${stem}_PLE_matrix.csv`, rowsToCsv(rows), "text/csv");
  });
  $("#ple-csv-slices").addEventListener("click", () => {
    const r1 = [["emission_wavelength_nm", "counts"]];
    d.emission.forEach((wl, j) => r1.push([wl, d.z[st.exIdx][j]]));
    downloadText(`${stem}_PLE_emission_slice.csv`, rowsToCsv(r1), "text/csv");
    const r2 = [["excitation_wavelength_nm", "counts"]];
    d.excitation.forEach((wl, i) => r2.push([wl, d.z[i][st.emIdx]]));
    downloadText(`${stem}_PLE_excitation_slice.csv`, rowsToCsv(r2), "text/csv");
  });
  drawMap(); draw3d(); drawTraces();
}

/* ----------------------------- 2D scan view ------------------------------- */
function renderScan2D(rec) {
  const direct = rec.cache.maps || (rec.cache.maps = PrismH5.extract2DMaps(rec.h5, rec.det.tree, rec.det.scanGroup));
  if (rec.cache.waveScan === undefined) {
    try { rec.cache.waveScan = PrismH5.extractWaveScan(rec.h5, rec.det.tree, rec.det.scanGroup); }
    catch (e) { rec.cache.waveScan = null; }
  }
  const wave = rec.cache.waveScan;
  // unified selector entries: waveform reconstructions FIRST (they are the
  // real measurement for wave scans), then direct 2D datasets
  const entries = [];
  if (wave) for (let i = 0; i < wave.signals.length; i++) {
    const s = wave.signals[i];
    entries.push({ kind: "wave", i, label: `${s.name} (위치 스트림 재구성 ${wave.y.length}×${wave.x.length})` });
  }
  for (let i = 0; i < direct.length; i++) {
    const m = direct[i];
    entries.push({ kind: "direct", i, label: `${m.path.split("/").pop()}${m.slice !== undefined ? ` [slice ${m.slice}]` : ""} [${m.shape}]` });
  }
  if (!entries.length) return renderGeneric(rec);
  $("#view").innerHTML = `
  <div class="panel"><h3>2D 스캔 맵 <span class="muted small">${esc(rec.det.scanGroup)}</span></h3>
    <div class="flex small" style="margin-bottom:6px;">
      <label class="ctl"><span>데이터셋</span><select id="map-sel">${entries.map((e, i) => `<option value="${i}">${esc(e.label)}</option>`).join("")}</select></label>
      <label class="ctl"><span>컬러맵</span><select id="map-cmap"><option>Viridis</option><option>Turbo</option><option>Greys</option><option>Hot</option></select></label>
      <label class="ctl"><span>Z 스케일</span><select id="map-zscale"><option value="lin">linear</option><option value="log">log</option></select></label>
      <label class="ctl"><span>스케일바</span><select id="map-sb"><option value="1">표시</option><option value="0">숨김</option></select></label>
      <span class="right flex"><button id="map-png" class="small">그림 저장</button><button id="map-csv" class="small">CSV</button></span>
    </div>
    <div id="map-note" class="small muted" style="margin-bottom:4px;"></div>
    <div id="chart-map" class="chart chart-tall"></div></div>`;
  const draw = () => {
    const ent = entries[Number($("#map-sel").value)];
    let z, x, y, xLabel, yLabel, note = "", zName = "";
    if (ent.kind === "wave") {
      const s = wave.signals[ent.i];
      z = s.z; x = wave.x; y = wave.y; xLabel = wave.xLabel; yLabel = wave.yLabel; zName = s.name;
      note = `양방향 waveform 스캔 재구성 — 샘플 ${s.nUsed}개 → ${wave.y.length}×${wave.x.length} 격자 (픽셀당 평균)` +
        (s.nOut > 0 ? ` · 격자 밖/이동 중 샘플 ${s.nOut}개 제외` : "");
    } else {
      const m = direct[ent.i];
      const pv = PrismH5.readForPreview(rec.h5, m.path, m.slice);
      if (!pv || pv.kind !== "2d") { toast("2D 미리보기 실패"); return; }
      z = pv.z; zName = m.path.split("/").pop();
      const ax = PrismH5.scanAxes(rec.h5, rec.det.scanGroup, pv.ny, pv.nx);
      x = ax ? ax.x : undefined; y = ax ? ax.y : undefined;
      xLabel = ax ? ax.xLabel : "x (px)"; yLabel = ax ? ax.yLabel : "y (px)";
    }
    $("#map-note").textContent = note;
    const logZ = $("#map-zscale").value === "log";
    const zShow = logZ ? z.map((r) => r.map((v) => (v !== null && v > 0 ? Math.log10(v) : null))) : z;
    /* v3.19 — 스케일바. 축이 µm(스테이지 h/v 좌표)로 확인될 때만 그린다.
     * imshow_extent 만 있는 파일은 단위가 기록되어 있지 않으므로 지어내지 않는다. */
    const um = /µm/.test(xLabel) && /µm/.test(yLabel);
    const mapEl = $("#chart-map");
    $("#map-sb").disabled = !um;
    $("#map-sb").title = um ? "스테이지 좌표(µm)로 계산한 스케일바" : "축 단위가 파일에 없어 스케일바를 그릴 수 없습니다";
    mapEl._prismScaleBarWhyNot = um ? "" : "축 단위가 파일에 기록되어 있지 않아(h_array/v_array 없음) 스케일바를 그리지 않았습니다.";
    newPlot(mapEl, [{
      z: zShow, x, y, type: "heatmap",
      colorscale: cmapValue($("#map-cmap").value),
      colorbar: { outlinewidth: 0, thickness: 14, title: { text: (logZ ? "log₁₀ " : "") + zName, side: "right" } },
      hovertemplate: `${xLabel.split(" ")[0]}=%{x:.2f}<br>${yLabel.split(" ")[0]}=%{y:.2f}<br>값=%{z:.4g}<extra></extra>`,
    }], {
      xaxis: Object.assign(baseLayout().xaxis, { title: { text: xLabel } }),
      yaxis: Object.assign(baseLayout().yaxis, { title: { text: yLabel }, scaleanchor: "x" }),
    }).then(() => PrismReport.attachPlotlyScaleBar(mapEl,
      um ? { on: $("#map-sb").value === "1", umPerUnit: 1, source: "스테이지 좌표 h/v" } : null));
    $("#map-csv").onclick = () => {
      const rows = z.map((r) => r.map((v) => (v === null ? "" : v)));
      downloadText(rec.name.replace(/\.h5$/i, "") + "_map.csv", rowsToCsv(rows), "text/csv");
    };
  };
  $("#map-sel").addEventListener("change", draw);
  $("#map-cmap").addEventListener("change", draw);
  $("#map-zscale").addEventListener("change", draw);
  $("#map-sb").addEventListener("change", draw);
  $("#map-png").addEventListener("click", () => openReportForChart($("#chart-map")));
  draw();
}

/* ---------------------------- histogram view ------------------------------ */
function renderHistogram(rec) {
  const d = rec.cache.hist || (rec.cache.hist = PrismH5.extractHistogram(rec.h5, rec.det.histGroup));
  $("#view").innerHTML = `
  <div class="panel"><h3>TCSPC 히스토그램 <span class="muted small">${esc(d.group)}${d.elapsed ? ` · 측정 ${fmt(d.elapsed, 4)} s` : ""}</span></h3>
    <div class="flex small" style="margin-bottom:6px;">
      <label class="ctl"><span>Y 스케일</span><select id="h-scale"><option value="log">log</option><option value="lin">linear</option></select></label>
      <span class="right"><button id="h-csv" class="small">CSV</button></span>
    </div>
    <div id="chart-hist" class="chart chart-mid"></div></div>`;
  const colors = [PALETTE.blue, PALETTE.orange, PALETTE.aqua, PALETTE.yellow];
  const tScale = d.time.length && d.time[d.time.length - 1] > 1e-3 ? 1 : 1e9; // s→ns if tiny
  const xs = d.time.map((t) => t * tScale);
  const draw = () => {
    const traces = d.channels.map((ch, i) => ({
      x: xs, y: ch, mode: "lines", name: `ch ${i}`, line: { color: colors[i % colors.length], width: 1.3 },
      hovertemplate: "t=%{x:.3g}<br>counts=%{y}<extra>ch " + i + "</extra>",
    }));
    newPlot($("#chart-hist"), traces, {
      xaxis: Object.assign(baseLayout().xaxis, { title: { text: tScale === 1 ? "Time" : "Time (ns)" } }),
      yaxis: Object.assign(baseLayout().yaxis, { title: { text: "Counts" }, type: $("#h-scale").value === "log" ? "log" : "linear" }),
    });
  };
  $("#h-scale").addEventListener("change", draw);
  $("#h-csv").addEventListener("click", () => {
    const rows = [["time", ...d.channels.map((_, i) => `ch${i}`)]];
    for (let i = 0; i < d.time.length; i++) rows.push([d.time[i], ...d.channels.map((c) => c[i])]);
    downloadText(rec.name.replace(/\.h5$/i, "") + "_histogram.csv", rowsToCsv(rows), "text/csv");
  });
  draw();
}

/* ------------------------------ rise time --------------------------------- */
/** ms-first time formatting (rise times are ms-scale near threshold). */
function fmtT(s, digits = 4) {
  if (!isFinite(s)) return "–";
  if (Math.abs(s) < 1) return `${fmt(s * 1e3, digits)} ms`;
  return `${fmt(s, digits)} s`;
}
function fmtTCI(est, ci, key) {
  const base = fmtT(est);
  if (!ci || !ci[key]) return base;
  return `${base} <span class="muted small">[${fmt(ci[key].lo * 1e3, 3)}–${fmt(ci[key].hi * 1e3, 3)} ms]</span>`;
}
const RISE_MODEL_LABEL = {
  single_exp: "단일 지수", logistic_delay: "지연 로지스틱 (avalanche)",
  double_exp: "이중 지수", stretched_exp: "신장 지수", rise_relax: "상승-이완",
  exp_decay: "단일 지수 감쇠", double_decay: "이중 지수 감쇠", stretched_decay: "신장 지수 감쇠 (KWW)",
};
const RISE_VERDICT_STYLE = {
  avalanche: ["var(--accent)", "AVALANCHE"], exponential: ["var(--s3)", "지수형"],
  intermediate: ["var(--s4)", "중간형"], unresolved: ["var(--warn)", "미분해"], none: ["var(--text-muted)", "없음"],
};

function getRiseData(rec) {
  if (!rec.cache.riseData) rec.cache.riseData = PrismH5.extractRiseTime(rec.h5, rec.det.riseGroup);
  return rec.cache.riseData;
}

async function renderRiseTime(rec) {
  const view = $("#view");
  let d;
  try { d = getRiseData(rec); } catch (e) {
    view.innerHTML = `<div class="panel"><h3>Rise time 데이터 읽기 실패</h3><div class="mono">${esc(e.message)}</div></div>`;
    return;
  }
  const s = App.settings;
  const ch = s.riseChannel === "counts_2" && d.c2 ? "counts_2" : "counts";
  const nBins = s.riseBins || 160;
  view.innerHTML = `
  <div class="panel">
    <div class="controls-row">
      <label class="ctl"><span>채널</span><select id="r-ch">
        <option value="counts"${ch === "counts" ? " selected" : ""}>counts (APD 1)</option>
        ${d.c2 ? `<option value="counts_2"${ch === "counts_2" ? " selected" : ""}>counts_2 (APD 2)</option>` : ""}
      </select></label>
      <label class="ctl"><span>리비닝 (log-time bins)</span><select id="r-bins">
        ${[80, 160, 320].map((b) => `<option value="${b}"${b === nBins ? " selected" : ""}>${b}</option>`).join("")}
      </select></label>
      <label class="ctl"><span>X축</span><select id="r-xax"><option value="lin">linear</option><option value="log">log (상승 확대)</option></select></label>
      <label class="ctl"><span>부트스트랩 N</span><input type="number" id="r-nboot" value="${s.riseBootN || 150}" min="50" max="1000" step="50"></label>
      <button id="r-boot" class="small">신뢰구간 계산</button>
      <span class="right flex">
        <button id="r-csv" class="small">CSV</button>
        <button id="r-json" class="small">JSON</button>
      </span>
    </div>
  </div>
  <div class="panel"><h3>펄스 응답 <span class="muted small">${esc(d.group)} · dt ${fmt(d.dtMedian * 1e3, 3)} ms${d.spikes.length ? ` · DAQ 스파이크 ${d.spikes.length}개 제거` : ""}</span></h3>
    <div id="chart-rise" class="chart chart-tall"></div></div>
  <div class="panel"><h3>분석 결과 <span class="muted small" id="r-engine"></span></h3><div id="r-results"><span class="muted">분석 중…</span></div></div>`;

  const input = { t: d.t, c: ch === "counts_2" ? d.c2 : d.c, gateOnIdx: d.gateOnIdx, gateOffIdx: d.gateOffIdx, dtMedian: d.dtMedian, spikes: d.spikes };
  const cacheKey = `riseA:${ch}:${nBins}`;
  let a = rec.cache[cacheKey];
  if (!a) {
    try {
      a = await rpc("rise2", { input, options: { nBins } });
      rec.cache[cacheKey] = a;
    } catch (e) {
      $("#r-results").innerHTML = `<span class="tag-Poor">분석 실패: ${esc(e.message)}</span>`;
      return;
    }
  }
  if (!document.getElementById("chart-rise")) return; // view switched meanwhile
  $("#r-engine").textContent = a.engine;
  drawRiseChart(rec, d, input, a);
  renderRiseResults(rec, a, rec.cache[cacheKey + ":boot"] || null);

  $("#r-ch").addEventListener("change", (e) => { App.settings.riseChannel = e.target.value; saveSettings(); renderAll(); });
  $("#r-bins").addEventListener("change", (e) => { App.settings.riseBins = Number(e.target.value); saveSettings(); renderAll(); });
  $("#r-xax").addEventListener("change", () => drawRiseChart(rec, d, input, a));
  $("#r-boot").addEventListener("click", async () => {
    const btn = $("#r-boot");
    btn.disabled = true;
    const nBoot = Math.max(50, Math.min(1000, Number($("#r-nboot").value) || 150));
    App.settings.riseBootN = nBoot; saveSettings();
    try {
      const boot = await rpc("riseboot2", { input, analysis: a, options: { nBoot, seed: 20260810 } },
        (f) => { btn.textContent = `계산 중 ${Math.round(f * 100)}%`; });
      rec.cache[cacheKey + ":boot"] = boot;
      renderRiseResults(rec, a, boot);
      toast("부트스트랩 신뢰구간 계산 완료");
    } catch (e) { toast("부트스트랩 실패: " + e.message); }
    btn.disabled = false; btn.textContent = "신뢰구간 계산";
  });
  $("#r-csv").addEventListener("click", () => exportRiseCSV(rec, d, a));
  $("#r-json").addEventListener("click", () => {
    downloadText(rec.name.replace(/\.h5$/i, "") + "_risetime.json",
      JSON.stringify({ file: rec.name, channel: ch, analysis: a, bootstrap: rec.cache[cacheKey + ":boot"] || null }, null, 1), "application/json");
  });
}

function drawRiseChart(rec, d, input, a) {
  const el = document.getElementById("chart-rise");
  if (!el) return;
  const logx = ($("#r-xax") || {}).value === "log";
  const msScale = 1e3;
  const tOn = isFinite(a.gateOnT) ? a.gateOnT : d.t[0];
  // raw trace (decimated for display)
  const stride = Math.max(1, Math.ceil(d.t.length / 5000));
  const rx = [], ry = [];
  for (let i = 0; i < d.t.length; i += stride) {
    if (!isFinite(input.c[i])) continue;
    rx.push((d.t[i] - tOn) * msScale); ry.push(input.c[i]);
  }
  const traces = [{
    x: rx, y: ry, mode: "markers", name: "counts (원본)",
    marker: { color: "#8b8a80", size: 3, opacity: 0.45 },
    hovertemplate: "t=%{x:.4g} ms<br>%{y} counts<extra></extra>",
  }];
  const r = a.rise;
  if (r && r.binned) {
    traces.push({
      x: r.binned.t.map((t) => t * msScale), y: r.binned.c, mode: "lines+markers", name: "log-time 리비닝",
      marker: { color: PALETTE.aqua, size: 5 }, line: { color: PALETTE.aqua, width: 1.2 },
      hovertemplate: "t=%{x:.4g} ms<br>%{y:.3g}<extra>binned</extra>",
    });
  }
  if (r && r.fit) {
    traces.push({
      x: r.fit.curveT.map((t) => t * msScale), y: r.fit.curveY, mode: "lines",
      name: `상승 피팅: ${RISE_MODEL_LABEL[r.fit.model] || r.fit.model}`,
      line: { color: PALETTE.blue, width: 2.4 },
    });
  }
  if (a.decay && a.decay.fit && isFinite(a.gateOffT)) {
    const dOff = (a.gateOffT - tOn) * msScale;
    traces.push({
      x: a.decay.fit.curveT.map((t) => t * msScale + dOff), y: a.decay.fit.curveY, mode: "lines",
      name: `감쇠 피팅: ${RISE_MODEL_LABEL[a.decay.fit.model] || a.decay.fit.model}`,
      line: { color: PALETTE.orange, width: 2 },
    });
  }
  const shapes = [], annotations = [];
  const dtMs = (isFinite(a.dtMedian) ? a.dtMedian : 1e-3) * msScale;
  const xMin = logx ? dtMs / 2 : 0; // log axis cannot host x=0
  // gate-on region shading
  if (isFinite(a.gateOnT)) {
    const gEnd = isFinite(a.gateOffT) ? (a.gateOffT - tOn) * msScale : (d.t[d.t.length - 1] - tOn) * msScale;
    shapes.push({ type: "rect", x0: xMin, x1: gEnd, yref: "paper", y0: 0, y1: 1, fillcolor: "rgba(57,135,229,0.05)", line: { width: 0 } });
    if (!logx) {
      shapes.push({ type: "line", x0: 0, x1: 0, yref: "paper", y0: 0, y1: 1, line: { color: PALETTE.green, width: 1.2, dash: "dash" } });
      annotations.push({ x: 0, yref: "paper", y: 1.03, text: "게이트 ON", showarrow: false, font: { size: 10, color: PALETTE.green } });
    }
    if (isFinite(a.gateOffT)) {
      shapes.push({ type: "line", x0: gEnd, x1: gEnd, yref: "paper", y0: 0, y1: 1, line: { color: PALETTE.orange, width: 1.2, dash: "dash" } });
      annotations.push({ x: logx ? Math.log10(gEnd) : gEnd, yref: "paper", y: 1.03, text: "OFF", showarrow: false, font: { size: 10, color: PALETTE.orange } });
    }
  }
  if (r && r.ok) {
    // baseline & steady hlines
    shapes.push({ type: "line", xref: "paper", x0: 0, x1: 1, y0: r.baseline, y1: r.baseline, line: { color: "#55554f", width: 1, dash: "dot" } });
    shapes.push({ type: "line", xref: "paper", x0: 0, x1: 1, y0: r.steady, y1: r.steady, line: { color: "#55554f", width: 1, dash: "dot" } });
    // t10 / t50 / t90 markers
    const mkT = [["t10", r.free.t10], ["t50", r.free.t50], ["t90", r.free.t90]];
    for (const [lbl, tv] of mkT) {
      if (!isFinite(tv)) continue;
      const xv = tv * msScale;
      shapes.push({ type: "line", x0: logx ? xv : xv, x1: xv, yref: "paper", y0: 0, y1: 0.92, line: { color: PALETTE.magenta, width: 1, dash: "dot" } });
      annotations.push({ x: logx ? Math.log10(Math.max(xv, 1e-6)) : xv, yref: "paper", y: 0.96, text: lbl, showarrow: false, font: { size: 10, color: PALETTE.magenta } });
    }
  }
  const xaxis = Object.assign(baseLayout().xaxis, { title: { text: "게이트 ON 이후 시간 (ms)" }, type: logx ? "log" : "linear" });
  if (logx) {
    const tMaxMs = (d.t[d.t.length - 1] - tOn) * msScale;
    xaxis.range = [Math.log10(Math.max(dtMs / 2, 1e-6)), Math.log10(Math.max(tMaxMs, dtMs * 10))];
  }
  newPlot(el, traces, {
    xaxis,
    yaxis: Object.assign(baseLayout().yaxis, { title: { text: "Counts / bin" } }),
    shapes, annotations,
    legend: { orientation: "h", y: -0.18 },
  });
}

function renderRiseResults(rec, a, boot) {
  const el = document.getElementById("r-results");
  if (!el) return;
  const r = a.rise;
  const ci = boot && boot.ci;
  const [vColor, vTag] = RISE_VERDICT_STYLE[a.verdict.klass] || RISE_VERDICT_STYLE.none;
  let html = `<div style="border-left:3px solid ${vColor};padding:6px 10px;margin-bottom:10px;">
    <b style="color:${vColor}">${vTag}</b> <span class="small">${esc(a.verdict.text)}</span></div>`;
  if (r && r.ok) {
    const f = r.free;
    const cards = [];
    cards.push(`<div class="card hero"><div class="k">상승시간 t₁₀₋₉₀${r.unresolvedFast ? " (upper bound)" : ""}</div>
      <div class="v">${r.unresolvedFast ? "&lt; " : ""}${fmtTCI(f.t1090, ci, "t1090")}</div>
      <div class="s">10%→90% 도달 (모델프리·isotonic)</div></div>`);
    cards.push(`<div class="card"><div class="k">t(1−1/e)</div><div class="v">${fmtTCI(f.t1e, ci, "t1e")}</div><div class="s">63.2% 도달</div></div>`);
    cards.push(`<div class="card"><div class="k">반상승 t₅₀</div><div class="v">${fmtTCI(f.t50, ci, "t50")}</div><div class="s">50% 도달</div></div>`);
    cards.push(`<div class="card"><div class="k">유도 비율 ρ = t₁₀/t₉₀</div><div class="v">${fmt(f.induction, 3)}</div>
      <div class="s">순수 지수 0.046 · S자형 → 1</div></div>`);
    if (r.fit && r.fit.model === "logistic_delay") {
      const p = r.fit.params, se = r.fit.seNat || {};
      cards.push(`<div class="card" style="border-color:${vColor}"><div class="k">avalanche 성장률 r</div>
        <div class="v">${fmt(p.r, 4)} s⁻¹${isFinite(se.r) ? ` <span class="muted small">±${fmt(se.r, 2)}</span>` : ""}</div>
        <div class="s">순 루프 이득 (CR 피드백)</div></div>`);
      cards.push(`<div class="card"><div class="k">유도(반상승) 시간 t_m</div>
        <div class="v">${fmtTCI(p.tm, ci, "tm")}</div><div class="s">seed 증폭 지연 · r·t_m=${fmt(p.r * p.tm, 3)}</div></div>`);
    }
    if (isFinite(f.overshoot) && f.overshoot > 0) {
      cards.push(`<div class="card"><div class="k">과충격 (overshoot)</div><div class="v">${fmt(100 * f.overshoot, 3)}%</div>
        <div class="s">피크 ${fmtT(f.peakT)} — 광변색/재분포 신호 가능</div></div>`);
    }
    cards.push(`<div class="card"><div class="k">레벨</div><div class="v small" style="font-size:14px">${fmt(r.baseline, 4)} → ${fmt(r.steady, 4)}</div>
      <div class="s">baseline → steady (counts/bin)</div></div>`);
    if (a.decay && a.decay.ok && a.decay.fit) {
      cards.push(`<div class="card"><div class="k">감쇠 τ (게이트 OFF)</div><div class="v">${fmtT(a.decay.fit.tauEff)}</div>
        <div class="s">${RISE_MODEL_LABEL[a.decay.fit.model] || a.decay.fit.model}</div></div>`);
    }
    html += `<div class="cards">${cards.join("")}</div>`;
    // model comparison table
    if (r.aiccTable && r.aiccTable.length) {
      html += `<div style="margin-top:12px;"><table class="res"><tr><th>상승 모델</th><th>k</th><th>AICc</th><th>ΔAICc</th><th></th></tr>` +
        r.aiccTable.map((m) => `<tr${r.fit && m.model === r.fit.model ? ' class="sel"' : ""}>
          <td>${RISE_MODEL_LABEL[m.model] || m.model}</td><td class="num">${m.k}</td>
          <td class="num">${fmt(m.aicc, 5)}</td><td class="num">${fmt(m.dAicc, 3)}</td>
          <td>${r.fit && m.model === r.fit.model ? "✓ 선택 (절약 가드 ΔAICc≤4)" : ""}</td></tr>`).join("") + `</table></div>`;
    }
    if (r.fit) {
      const pStr = Object.entries(r.fit.params).map(([k, v]) => `${k}=${fmt(v, 5)}`).join(" · ");
      html += `<div class="small muted" style="margin-top:6px;">파라미터: ${pStr} · τ_eff(피팅 1−1/e)=${fmtT(r.fit.tauEff)}</div>`;
    }
    if (boot) {
      html += `<div class="small muted" style="margin-top:2px;">부트스트랩 ${boot.nBoot}회 (seed ${boot.seed}) · 모델 안정성: logistic ${fmt(100 * boot.modelStability.logisticFrac, 1)}%</div>`;
    }
  }
  const allNotes = [...(a.notes || []), ...((r && r.notes) || []), ...((a.decay && a.decay.notes) || [])];
  if (allNotes.length) html += `<ul class="notes" style="margin-top:8px;">${allNotes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>`;
  el.innerHTML = html;
}

function exportRiseCSV(rec, d, a) {
  const r = a.rise;
  const rows = [["# INNO Prism RiseFit", a.engine]];
  rows.push(["# file", rec.name]);
  if (r && r.ok) {
    rows.push(["# verdict", a.verdict.klass, a.verdict.text]);
    rows.push(["# t10_ms", r.free.t10 * 1e3], ["# t50_ms", r.free.t50 * 1e3], ["# t90_ms", r.free.t90 * 1e3]);
    rows.push(["# t10_90_ms", r.free.t1090 * 1e3], ["# t_1e_ms", r.free.t1e * 1e3], ["# induction_ratio", r.free.induction]);
    if (r.fit) {
      rows.push(["# model", r.fit.model, "aicc", r.fit.aicc]);
      for (const [k, v] of Object.entries(r.fit.params)) rows.push(["# param_" + k, v]);
    }
    if (a.decay && a.decay.fit) rows.push(["# decay_model", a.decay.fit.model, "tau_eff_ms", a.decay.fit.tauEff * 1e3]);
  }
  rows.push([]);
  rows.push(["t_ms_after_gate", "counts_binned", "n_samples", "fit_curve"]);
  if (r && r.binned) {
    for (let i = 0; i < r.binned.t.length; i++) {
      let fv = "";
      if (r.fit) {
        // interpolate dense curve
        const T = r.fit.curveT, Y = r.fit.curveY, tt = r.binned.t[i];
        let lo = 0, hi = T.length - 1;
        while (hi - lo > 1) { const m = (lo + hi) >> 1; if (T[m] <= tt) lo = m; else hi = m; }
        const fr = (tt - T[lo]) / Math.max(T[hi] - T[lo], 1e-30);
        fv = Y[lo] + fr * (Y[hi] - Y[lo]);
      }
      rows.push([r.binned.t[i] * 1e3, r.binned.c[i], r.binned.n[i], fv]);
    }
  }
  downloadText(rec.name.replace(/\.h5$/i, "") + "_risetime.csv", rowsToCsv(rows), "text/csv");
}

/* ----------------------------- darkening ---------------------------------- */
/** turbo colorscale sample (0..1) → css color (linear interp of stops) */
function turboColor(f) {
  const s = TURBO_SCALE;
  f = Math.max(0, Math.min(1, f));
  for (let i = 1; i < s.length; i++) {
    if (f <= s[i][0]) {
      const [f0, c0] = s[i - 1], [f1, c1] = s[i];
      const u = (f - f0) / Math.max(f1 - f0, 1e-9);
      const hex = (c) => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
      const a = hex(c0), b = hex(c1);
      return `rgb(${a.map((v, j) => Math.round(v + u * (b[j] - v))).join(",")})`;
    }
  }
  return s[s.length - 1][1];
}
const DARK_VERDICT = { darkening: ["다크닝", "var(--bad)"], brightening: ["광활성화↑", "var(--s3)"], stable: ["안정", "var(--text-muted)"] };

async function renderDarkening(rec) {
  const view = $("#view");
  let d;
  try { d = rec.cache.darkData || (rec.cache.darkData = PrismH5.extractDarkening(rec.h5, rec.det.darkGroup)); }
  catch (e) { view.innerHTML = `<div class="panel"><h3>Darkening 데이터 읽기 실패</h3><div class="mono">${esc(e.message)}</div></div>`; return; }
  view.innerHTML = `
  <div class="panel">
    <div class="controls-row">
      <label class="ctl"><span>표시</span><select id="dk-norm"><option value="norm">정규화 I(t)/I₀</option><option value="raw">원시 count rate</option></select></label>
      <label class="ctl"><span>트레이스 강조/피팅</span><select id="dk-sel"><option value="-1">전체 (강조 없음)</option>
        ${d.traces.map((tr, i) => `<option value="${i}">${fmt(tr.P * 1e6, 4)} µW</option>`).join("")}</select></label>
      <label class="ctl"><span>시간축</span><select id="dk-xax"><option value="lin">linear</option><option value="log">log</option></select></label>
      <label class="ctl"><span>요약 지표</span><select id="dk-metric"><option value="loss">손실률 (%)</option><option value="t50">다크닝 반감시간 t₅₀ (s)</option><option value="rate">초기 손실률 (%/s)</option></select></label>
      <span class="right flex"><button id="dk-csv" class="small">CSV</button><button id="dk-json" class="small">JSON</button></span>
    </div>
  </div>
  <div class="panel"><h3>출력별 시간 트레이스 <span class="muted small">${d.traces.length}개 · ${fmt(d.traces[0].t[d.traces[0].t.length - 1], 4)} s · dt ${fmt((d.acqTime || 0.1) * 1e3, 3)} ms</span></h3>
    <div id="chart-dark" class="chart chart-tall"></div></div>
  <div class="panel"><h3>출력 의존성 요약</h3><div id="chart-darksum" class="chart chart-short"></div></div>
  <div class="panel"><h3>분석 결과 <span class="muted small" id="dk-engine"></span></h3><div id="dk-results"><span class="muted">분석 중…</span></div></div>`;

  let a = rec.cache.darkA;
  if (!a) {
    try {
      a = await rpc("dark2", { input: { traces: d.traces, acqTime: d.acqTime }, options: {} });
      rec.cache.darkA = a;
    } catch (e) { const el = $("#dk-results"); if (el) el.innerHTML = `<span class="tag-Poor">분석 실패: ${esc(e.message)}</span>`; return; }
  }
  if (!document.getElementById("chart-dark")) return;
  $("#dk-engine").textContent = a.engine;
  const redraw = () => { drawDarkChart(rec, d, a); drawDarkSummary(rec, d, a); };
  renderDarkResults(rec, d, a);
  redraw();
  $("#dk-norm").addEventListener("change", () => drawDarkChart(rec, d, a));
  $("#dk-sel").addEventListener("change", () => drawDarkChart(rec, d, a));
  $("#dk-xax").addEventListener("change", () => drawDarkChart(rec, d, a));
  $("#dk-metric").addEventListener("change", () => drawDarkSummary(rec, d, a));
  $("#dk-csv").addEventListener("click", () => exportDarkCSV(rec, d, a));
  $("#dk-json").addEventListener("click", () => downloadText(rec.name.replace(/\.h5$/i, "") + "_darkening.json",
    JSON.stringify({ file: rec.name, analysis: { engine: a.engine, summary: a.summary, perTrace: a.perTrace.map((r) => ({ ...r, fit: r.fit ? { ...r.fit, curveT: undefined, curveY: undefined } : null })) } }, null, 1), "application/json"));
}

function drawDarkChart(rec, d, a) {
  const el = document.getElementById("chart-dark");
  if (!el) return;
  const norm = $("#dk-norm").value === "norm";
  const selIdx = Number($("#dk-sel").value);
  const logx = $("#dk-xax").value === "log";
  const traces = [];
  d.traces.forEach((tr, i) => {
    const rr = a.perTrace[i];
    const I0 = rr && isFinite(rr.I0eff) ? rr.I0eff : (rr && rr.I0) || 1;
    const stride = Math.max(1, Math.ceil(tr.t.length / 1500));
    const x = [], y = [];
    for (let j = 0; j < tr.t.length; j += stride) {
      x.push(tr.t[j]);
      y.push(isFinite(tr.c[j]) ? (norm ? tr.c[j] / I0 : tr.c[j]) : null);
    }
    const emph = selIdx === i, dim = selIdx >= 0 && !emph;
    traces.push({
      x, y, mode: "lines", name: `${fmt(tr.P * 1e6, 4)} µW`,
      line: { color: turboColor(i / Math.max(d.traces.length - 1, 1)), width: emph ? 2.6 : 1.2 },
      opacity: dim ? 0.25 : 0.95,
      hovertemplate: `t=%{x:.1f}s<br>${norm ? "I/I₀=%{y:.3f}" : "%{y:.4g} Hz"}<extra>${fmt(tr.P * 1e6, 4)} µW</extra>`,
    });
    if (emph && rr && rr.fit) {
      const I0n = norm ? I0 : 1;
      traces.push({
        x: rr.fit.curveT, y: rr.fit.curveY.map((v) => v / (norm ? I0 : 1)),
        mode: "lines", name: `피팅 (${rr.fit.model}${rr.fit.params.beta ? `, β=${fmt(rr.fit.params.beta, 3)}` : ""})`,
        line: { color: "#f4f4f0", width: 2, dash: "dash" },
      });
    }
  });
  newPlot(el, traces, {
    xaxis: Object.assign(baseLayout().xaxis, { title: { text: "시간 (s)" }, type: logx ? "log" : "linear" }),
    yaxis: Object.assign(baseLayout().yaxis, { title: { text: norm ? "정규화 강도 I(t)/I₀" : "APD count rate (Hz)" } }),
    showlegend: false,
  });
}

function drawDarkSummary(rec, d, a) {
  const el = document.getElementById("chart-darksum");
  if (!el) return;
  const metric = $("#dk-metric").value;
  const xs = [], ys = [], cols = [];
  a.perTrace.forEach((r, i) => {
    const v = metric === "loss" ? 100 * r.loss
      : metric === "t50" ? (r.verdict === "darkening" && r.free ? r.free.t50 : NaN)
      : (r.verdict === "darkening" && isFinite(r.initRate) ? 100 * r.initRate : NaN);
    if (!isFinite(v)) return;
    xs.push(r.P * 1e6); ys.push(v);
    cols.push(turboColor(i / Math.max(a.perTrace.length - 1, 1)));
  });
  const label = { loss: "손실률 (%)", t50: "t₅₀ (s)", rate: "초기 손실률 (%/s)" }[metric];
  const shapes = [];
  if (isFinite(a.summary.onsetP)) {
    shapes.push({ type: "line", x0: a.summary.onsetP * 1e6, x1: a.summary.onsetP * 1e6, yref: "paper", y0: 0, y1: 1, line: { color: PALETTE.yellow, width: 1.4, dash: "dash" } });
  }
  newPlot(el, [{
    x: xs, y: ys, mode: "lines+markers", marker: { size: 9, color: cols, line: { width: 1, color: "#1a1a19" } },
    line: { color: "#55554f", width: 1.2 },
    hovertemplate: "P=%{x:.4g} µW<br>%{y:.3g}<extra></extra>",
  }], {
    xaxis: Object.assign(baseLayout().xaxis, { title: { text: "Power (µW)" }, type: "log" }),
    yaxis: Object.assign(baseLayout().yaxis, { title: { text: label } }),
    shapes,
    annotations: isFinite(a.summary.onsetP) ? [{ x: Math.log10(a.summary.onsetP * 1e6), yref: "paper", y: 1.05, text: "다크닝 시작", showarrow: false, font: { size: 10.5, color: PALETTE.yellow } }] : [],
  });
}

function renderDarkResults(rec, d, a) {
  const el = document.getElementById("dk-results");
  if (!el) return;
  const s = a.summary;
  const kd = densityFactor();
  const dens = (P) => isFinite(kd) && isFinite(P) ? ` <span class="muted small">= ${fmtDensityAuto(P * kd, 4)}</span>` : "";
  const cards = [];
  cards.push(`<div class="card hero"><div class="k">다크닝 시작 출력 (onset)</div>
    <div class="v">${isFinite(s.onsetP) ? fmt(s.onsetP * 1e6, 4) + " µW" : "미검출"}</div>
    <div class="s">유의한 감쇠가 처음 나타나는 출력${isFinite(s.onsetP) ? dens(s.onsetP) : ""}</div></div>`);
  cards.push(`<div class="card"><div class="k">최대 손실</div>
    <div class="v">${fmt(100 * s.maxLoss, 4)}%</div>
    <div class="s">@ ${fmt(s.maxLossP * 1e6, 4)} µW · ${fmt(d.traces[0].t[d.traces[0].t.length - 1], 3)} s 노출${dens(s.maxLossP)}</div></div>`);
  cards.push(`<div class="card"><div class="k">최대출력 다크닝 반감시간 t₅₀</div>
    <div class="v">${isFinite(s.maxLossT50) ? fmt(s.maxLossT50, 4) + " s" : "–"}</div>
    <div class="s">손실의 50% 도달 시간 (모델프리)</div></div>`);
  cards.push(`<div class="card"><div class="k">판정 분포</div>
    <div class="v small" style="font-size:14px">다크닝 ${s.nDark} · 활성화 ${s.nBright} · 안정 ${s.nTraces - s.nDark - s.nBright}</div>
    <div class="s">${s.nTraces}개 출력 트레이스</div></div>`);
  let html = `<div class="cards">${cards.join("")}</div>`;
  html += `<div style="margin-top:12px;"><table class="res">
    <tr><th>출력 (µW)</th><th>판정</th><th>손실</th><th>t₅₀</th><th>t₉₀</th><th>모델</th><th>β</th><th>I₀ → I<sub>end</sub> (Hz)</th></tr>` +
    a.perTrace.map((r, i) => {
      const [vt, vc] = DARK_VERDICT[r.verdict] || DARK_VERDICT.stable;
      return `<tr${Number($("#dk-sel") && $("#dk-sel").value) === i ? ' class="sel"' : ""}>
        <td class="num">${fmt(r.P * 1e6, 4)}</td>
        <td style="color:${vc}">${vt}</td>
        <td class="num">${isFinite(r.loss) ? fmt(100 * r.loss, 3) + "%" : "–"}</td>
        <td class="num">${r.verdict !== "stable" && r.free ? fmt(r.free.t50, 3) + " s" : "–"}</td>
        <td class="num">${r.verdict !== "stable" && r.free ? fmt(r.free.t90, 3) + " s" : "–"}</td>
        <td>${r.fit ? (RISE_MODEL_LABEL[r.fit.model] || r.fit.model) : "–"}</td>
        <td class="num">${r.fit && isFinite(r.fit.params.beta) ? fmt(r.fit.params.beta, 3) : "–"}</td>
        <td class="num">${fmt(r.I0eff || r.I0, 4)} → ${fmt(r.Iend, 4)}</td></tr>`;
    }).join("") + `</table></div>
  <div class="small muted" style="margin-top:6px;">β&lt;1 (신장지수 KWW) = 불균일 앙상블 다크닝 · onset가 PA 임계 부근이면 avalanche 개체군 매개 손상, 완만한 멱법칙 증가면 직접 다광자 과정 시사 · Power scan 측정 시 이 onset 미만/짧은 dwell로 다크닝 왜곡 회피</div>`;
  el.innerHTML = html;
}

function exportDarkCSV(rec, d, a) {
  const rows = [["# INNO Prism DarkenFit", a.engine, rec.name]];
  const s = a.summary;
  rows.push(["# onset_uW", isFinite(s.onsetP) ? s.onsetP * 1e6 : ""], ["# max_loss_frac", s.maxLoss], ["# max_loss_at_uW", s.maxLossP * 1e6]);
  rows.push([]);
  rows.push(["power_uW", "verdict", "loss_frac", "t50_s", "t90_s", "t10_s", "tau_eff_s", "init_rate_frac_per_s", "model", "beta", "I0_Hz", "Iend_Hz", "duration_s"]);
  for (const r of a.perTrace) {
    rows.push([r.P * 1e6, r.verdict || "", isFinite(r.loss) ? r.loss : "",
      r.free ? r.free.t50 : "", r.free ? r.free.t90 : "", r.free ? r.free.t10 : "",
      r.fit ? r.fit.tauEff : "", isFinite(r.initRate) ? r.initRate : "",
      r.fit ? r.fit.model : "", r.fit && isFinite(r.fit.params.beta) ? r.fit.params.beta : "",
      r.I0eff || r.I0 || "", r.Iend || "", r.duration || ""]);
  }
  downloadText(rec.name.replace(/\.h5$/i, "") + "_darkening.csv", rowsToCsv(rows), "text/csv");
}

/* --------------------------- generic + structure -------------------------- */
function renderGeneric(rec) {
  // pick best previewable dataset: prefer 2D mid-size, then longest 1D
  const dsets = rec.det.tree.filter((n) => n.kind === "dataset");
  const scored = dsets.map((n) => {
    const eff = (n.shape || []).filter((s) => s > 1);
    let sc = 0;
    if (eff.length === 2 && eff[0] >= 4 && eff[1] >= 4) sc = 100 + Math.min(eff[0] * eff[1] / 1000, 50);
    else if (eff.length === 1 && eff[0] >= 8) sc = 50 + Math.min(eff[0] / 100, 30);
    if (/spectrum|count|intensity|map|histogram/i.test(n.path)) sc += 10;
    return { n, sc };
  }).filter((x) => x.sc > 0).sort((a, b) => b.sc - a.sc);
  $("#view").innerHTML = `
  <div class="panel"><h3>자동 미리보기</h3><div id="gen-preview">${scored.length ? "" : '<span class="muted">미리볼 수 있는 수치 데이터셋이 없습니다. H5 구조 탭에서 직접 선택하세요.</span>'}</div>
    <div id="chart-gen" class="chart chart-mid" style="${scored.length ? "" : "display:none"}"></div></div>`;
  if (scored.length) previewDataset(rec, scored[0].n.path, $("#chart-gen"), $("#gen-preview"));
}
function previewDataset(rec, path, chartEl, labelEl) {
  const pv = PrismH5.readForPreview(rec.h5, path);
  if (!pv) { if (labelEl) labelEl.innerHTML = `<span class="muted">읽기 실패: ${esc(path)}</span>`; return; }
  if (labelEl) labelEl.innerHTML = `<span class="mono small">${esc(path)}</span>`;
  if (pv.kind === "scalar") {
    chartEl.style.display = "none";
    if (labelEl) labelEl.innerHTML += ` <span class="mono">= ${fmt(pv.value, 8)}</span>`;
    return;
  }
  chartEl.style.display = "";
  if (pv.kind === "1d") {
    newPlot(chartEl, [{ y: pv.y, mode: "lines", line: { color: PALETTE.blue, width: 1.4 }, name: path.split("/").pop() }],
      { showlegend: false, xaxis: Object.assign(baseLayout().xaxis, { title: { text: "index" } }) });
  } else {
    newPlot(chartEl, [{ z: pv.z, type: "heatmap", colorscale: "Viridis", colorbar: { outlinewidth: 0, thickness: 14 } }],
      { yaxis: Object.assign(baseLayout().yaxis, { scaleanchor: pv.nx === pv.ny ? "x" : undefined }) });
  }
}
/** 측정 유형이 왜 그렇게 인식됐는지 설명 (새 측정 플랫폼 연동 시 진단용) */
function detectionDiagnosticHtml(rec) {
  const d = rec.det || {};
  const leaf = (x) => x ? esc(x.path.split("/").pop()) + ` <span class="t-shape">[${x.shape.join("×")}]</span>` : "–";
  const label = { power_apd: "Power scan · APD", power_emccd: "Power scan · EMCCD", ple: "PLE", scan2d: "2D 스캔",
    histogram: "TCSPC", rise_time: "Rise time", darkening: "Photodarkening", emccd_readout: "EMCCD 스펙트럼",
    imaging: "카메라 이미지 (widefield)", generic: "인식 실패 (범용 미리보기)" }[d.type] || d.type;
  const bits = [`<b>측정 유형</b>: ${esc(label)} <span class="muted">(${d.type})</span>`];
  if (d.ps) {
    bits.push(`<b>판정 근거</b>: 구조 탐지 — 그룹 <span class="mono">${esc(d.ps.group)}</span>` +
      ` · 측정점 ${d.ps.n}개 · 반복 ${d.ps.reps}회`);
    bits.push(`&nbsp;&nbsp;power 배열: <span class="mono">${leaf(d.ps.powerRaw || d.ps.power1)}</span>` +
      ` · 신호 배열: <span class="mono">${leaf(d.ps.sigRaw || d.ps.sig1)}</span>` +
      (d.ps.wl ? ` · 파장축: <span class="mono">${leaf(d.ps.wl)}</span>` : ""));
  } else if (d.type === "imaging") {
    const im = d.imaging;
    bits.push(`<b>판정 근거</b>: 구조 탐지 — <span class="mono">${esc(im.path)}</span> 가 ` +
      (im.kind === "stack" ? `3D 스택 [${im.n}×${im.ny}×${im.nx}]` : `2D 프레임 [${im.ny}×${im.nx}]`) +
      ` 이고 두 공간축이 모두 32 px 이상입니다`);
    bits.push(`&nbsp;&nbsp;<span class="muted">측정 이름(<span class="mono">${esc(im.group.split("/").pop())}</span>)이나 데이터셋 이름은 판정에 쓰지 않았습니다 —
      같은 이름(<span class="mono">spectrum</span>)이 셋업에 따라 1D 스펙트럼이기도 하고 2D 이미지이기도 하기 때문입니다.</span>`);
    if (im.timePath) bits.push(`&nbsp;&nbsp;시간축: <span class="mono">${esc(im.timePath)}</span>`);
  } else if (d.type === "power_apd" || d.type === "power_emccd") {
    bits.push(`<b>판정 근거</b>: 표준 경로 <span class="mono">measurement/power_scan/…</span> 정확 일치`);
  } else if (d.type === "generic") {
    bits.push(`<span class="tag-Low">Power scan로 인식되려면</span> 하나의 <span class="mono">measurement/&lt;그룹&gt;</span> 안에` +
      ` ① 이름에 <span class="mono">power</span>가 든 배열(측정점 n개)과` +
      ` ② 선두 차원이 같은 <span class="mono">count/rate/intensity/spectra</span> 계열 신호 배열이 필요합니다.` +
      ` 검출기 접두사·그룹명·<span class="mono">_raw</span> 유무는 자유입니다` +
      ` (<span class="mono">polled_powers</span>·시간축·<span class="mono">wheel_positions</span>는 축으로 간주되어 제외).`);
  } else {
    bits.push(`<b>판정 근거</b>: <span class="mono">${esc(d.darkGroup || d.riseGroup || d.scanGroup || d.pleGroup || d.histGroup || "전용 스키마 일치")}</span>`);
  }
  return `<div class="panel"><h3>측정 유형 감지 진단</h3><div class="small" style="line-height:1.7">${bits.join("<br>")}</div></div>`;
}

function renderStructure(rec) {
  const tree = rec.det.tree || [];
  const lines = [`<div class="tree">`];
  lines.push(`<div><span class="t-group" data-path="">/</span></div>`);
  for (const n of tree) {
    const depth = n.path.split("/").length;
    const pad = `<span class="indent" style="width:${depth * 16}px"></span>`;
    const name = n.path.split("/").pop();
    if (n.kind === "group") {
      lines.push(`<div>${pad}<span class="t-group" data-path="${esc(n.path)}">📁 ${esc(name)}</span>${n.nAttrs ? ` <span class="t-shape">(${n.nAttrs} attrs)</span>` : ""}</div>`);
    } else {
      lines.push(`<div>${pad}<span class="t-ds" data-path="${esc(n.path)}">${esc(name)}</span> <span class="t-shape">[${(n.shape || []).join("×") || "scalar"}] ${esc(n.dtype || "")}</span></div>`);
    }
  }
  lines.push("</div>");
  $("#view").innerHTML = detectionDiagnosticHtml(rec) + `
  <div class="panel"><h3>파일 구조 <span class="muted small">클릭하여 미리보기/속성 확인</span></h3>${lines.join("")}</div>
  <div class="panel" id="struct-detail" style="display:none;"><h3 id="sd-title"></h3>
    <div id="sd-attrs" class="attr-box mono small" style="display:none;"></div>
    <div id="sd-chart" class="chart chart-mid" style="display:none;"></div></div>`;
  $$(".tree .t-ds, .tree .t-group").forEach((el) => el.addEventListener("click", () => {
    const path = el.dataset.path;
    const panel = $("#struct-detail");
    panel.style.display = "";
    $("#sd-title").textContent = path || "/";
    const obj = path ? PrismH5.safeGet(rec.h5, path) : rec.h5;
    const attrs = PrismH5.attrsOf(obj);
    const ab = $("#sd-attrs");
    ab.style.display = ""; ab.innerHTML = attrsHtml(attrs);
    const isDs = el.classList.contains("t-ds");
    const ch = $("#sd-chart");
    if (isDs) { ch.style.display = ""; previewDataset(rec, path, ch, null); }
    else ch.style.display = "none";
    panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }));
}

/* ------------------------------- batch fit -------------------------------- */
async function runBatch() {
  const targets = App.files.filter((f) => !f.error && (f.det.type === "power_apd" || f.det.type === "power_emccd"));
  const riseTargets = App.files.filter((f) => !f.error && f.det.type === "rise_time");
  if (!targets.length && !riseTargets.length) { toast("Power scan / Rise time 파일이 없습니다"); return; }
  const back = document.createElement("div");
  back.className = "modal-back";
  back.innerHTML = `<div class="modal"><h2>일괄 피팅 <span class="muted small">(PrismFit 2 · branch=${App.settings.branch})</span></h2>
    <div id="batch-status" class="small muted" aria-live="polite">준비…</div>
    <div class="batch-prog" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i></i></div>
    <div style="overflow:auto;max-height:56vh;margin-top:8px;">
    ${targets.length ? `<table class="res" id="batch-table">
      <tr><th>파일</th><th>타입</th><th title="SegPA 헤드라인 (현재 branch 의 가장 낮은 파워 regime)">SegPA PA</th><th>분류</th><th>SegPA Ith (W)</th><th>주 상승</th><th>PrismFit 보고 PA</th><th>모델</th><th>s_max</th><th>점프</th><th>임계 (W)</th><th>포화 (W)</th><th>B</th><th>χ²_red</th><th>품질</th></tr>
    </table>` : ""}
    ${riseTargets.length ? `<h3 style="margin:14px 0 6px;">Rise time <span class="muted small">(RiseFit · 파일별 여기출력 순으로 τ 비교 → critical slowing/임계 판정)</span></h3>
    <table class="res" id="batch-rise-table">
      <tr><th>파일</th><th>t₁₀₋₉₀</th><th>t(1−1/e)</th><th>t₅₀</th><th>ρ 유도비</th><th>판정</th><th>모델</th><th>r (s⁻¹)</th><th>t_m</th><th>감쇠 τ</th></tr>
    </table>` : ""}
    </div>
    <div class="flex" style="margin-top:12px;">
      <button id="batch-csv" class="small" disabled>결과 CSV 저장</button>
      ${riseTargets.length ? `<button id="batch-rise-csv" class="small" disabled>Rise CSV 저장</button>` : ""}
      <span class="right"><button id="batch-close">닫기</button></span>
    </div></div>`;
  document.body.appendChild(back);
  /* 실행 중에 닫으면 중단한다(확인 후). 예전에는 창만 사라지고 루프가 계속 돌다가
     없어진 #batch-status 에 쓰려다 오류로 멈췄다. */
  let running = true, cancelled = false;
  const setStatus = (t) => { const el = back.querySelector("#batch-status"); if (el) el.textContent = t; };
  const nAll = targets.length + riseTargets.length;
  const setBar = (k) => { const pb = back.querySelector(".batch-prog"); if (!pb) return; const v = nAll ? Math.round(100 * k / nAll) : 100; pb.firstChild.style.width = v + "%"; pb.setAttribute("aria-valuenow", v); };
  back.addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-id]");
    if (!tr) return;
    if (running) { toast("일괄 피팅이 끝나면 열 수 있습니다"); return; }
    back.remove(); setProgress(null); selectFile(tr.dataset.id);
  });
  $("#batch-close").addEventListener("click", () => {
    if (running) {
      if (!confirm("일괄 피팅을 중단하고 닫을까요?\n(이미 피팅된 파일의 결과는 각 파일 화면에 남습니다)")) return;
      cancelled = true;
    }
    back.remove(); setProgress(null);
  });
  const table = back.querySelector("#batch-table");
  const results = [];
  for (let i = 0; i < targets.length; i++) {
    if (cancelled) return;
    const rec = targets[i];
    setStatus(`피팅 중 ${i + 1}/${targets.length}: ${rec.name}`); setBar(i);
    setProgress(i / targets.length);
    let row;
    try {
      const loaded = getLoaded(rec);
      const { branch, effName, agg } = branchForSettings(loaded, rec);
      const a = await rpc("analyze2", { branch, options: { monotone: App.settings.monotone !== false, lambdaFactor: App.settings.lambdaFactor || 1, paTrace: getPATrace(rec) || undefined } });
      a._branchUsed = effName;
      a._aggUsed = agg;
      a.quality = PrismFit.evaluate(a, null);
      results.push({ rec, a });
      const q = a.quality;
      const sq = segpaFirst(segpaFor(rec, segpaSelectedName(rec)));
      row = `<tr data-id="${rec.id}" title="클릭하면 이 파일을 엽니다"><td>${esc(rec.name)}</td><td>${rec.det.type === "power_apd" ? "APD" : "EMCCD"}</td>
        <td class="num"><b>${sq ? segpaPaText(sq) : "–"}</b></td><td>${sq ? sq.cls : "없음"}</td>
        <td class="num">${sq ? fmt(sq.bracketW[0], 4) + "–" + fmt(sq.bracketW[1], 4) : "–"}</td><td class="num">${sq && sq.main ? fmt(sq.main.slope, 3) : "–"}</td>
        <td class="num"><b>${a.paSource === "lower-bound" || a.paGridLimited ? "≥" : ""}${fmt(a.paReport, 4)}</b>${a.paSource === "unresolved" ? '<span class="tag-Poor" title="unidentified — point estimate 아님">?</span>' : ""}</td>
        <td>H${a.chosenOrder}</td>
        <td class="num">${fmt(a.sMax, 4)}${a.sMaxIsLowerBound ? "↑" : ""}</td>
        <td class="num">${a.paJump ? fmt(a.paJump.slope, 4) : "–"}</td>
        <td class="num">${isFinite(a.thresholdP) ? fmt(a.thresholdP, 4) : "–"}</td>
        <td class="num">${isFinite(a.saturationP) ? fmt(a.saturationP, 4) : "–"}</td>
        <td class="num">${fmt(a.background, 3)}</td>
        <td class="num">${fmt(a.diagnostics.chi2red, 3)}</td>
        <td class="tag-${q.band}">${fmt(q.score, 3)} (${q.band})</td></tr>`;
      rec.cache[analysisKey()] = a;
    } catch (e) {
      row = `<tr><td>${esc(rec.name)}</td><td colspan="13" class="tag-Poor">실패: ${esc(e.message)}</td></tr>`;
    }
    if (cancelled) return;
    table.insertAdjacentHTML("beforeend", row);
  }
  // --- rise-time files ---
  const riseResults = [];
  const riseTable = back.querySelector("#batch-rise-table");
  for (let i = 0; i < riseTargets.length; i++) {
    if (cancelled) return;
    const rec = riseTargets[i];
    setStatus(`Rise 분석 중 ${i + 1}/${riseTargets.length}: ${rec.name}`); setBar(targets.length + i);
    let row;
    try {
      const d = getRiseData(rec);
      const input = { t: d.t, c: d.c, gateOnIdx: d.gateOnIdx, gateOffIdx: d.gateOffIdx, dtMedian: d.dtMedian, spikes: d.spikes };
      const a = await rpc("rise2", { input, options: { nBins: App.settings.riseBins || 160 } });
      rec.cache[`riseA:counts:${App.settings.riseBins || 160}`] = a;
      riseResults.push({ rec, a });
      const r = a.rise;
      const [vc, vt] = RISE_VERDICT_STYLE[a.verdict.klass] || RISE_VERDICT_STYLE.none;
      const lg = r && r.fit && r.fit.model === "logistic_delay" ? r.fit.params : null;
      row = `<tr data-id="${rec.id}" title="클릭하면 이 파일을 엽니다"><td>${esc(rec.name)}</td>
        <td class="num"><b>${r && r.ok ? (r.unresolvedFast ? "&lt;" : "") + fmtT(r.free.t1090) : "–"}</b></td>
        <td class="num">${r && r.ok ? fmtT(r.free.t1e) : "–"}</td>
        <td class="num">${r && r.ok ? fmtT(r.free.t50) : "–"}</td>
        <td class="num">${r && r.ok ? fmt(r.free.induction, 3) : "–"}</td>
        <td style="color:${vc}">${vt}</td>
        <td>${r && r.fit ? (RISE_MODEL_LABEL[r.fit.model] || r.fit.model) : "–"}</td>
        <td class="num">${lg ? fmt(lg.r, 4) : "–"}</td>
        <td class="num">${lg ? fmtT(lg.tm) : "–"}</td>
        <td class="num">${a.decay && a.decay.fit ? fmtT(a.decay.fit.tauEff) : "–"}</td></tr>`;
    } catch (e) {
      row = `<tr><td>${esc(rec.name)}</td><td colspan="9" class="tag-Poor">실패: ${esc(e.message)}</td></tr>`;
    }
    if (riseTable) riseTable.insertAdjacentHTML("beforeend", row);
  }
  if (cancelled) return;
  running = false;
  if (riseResults.length) {
    const rb = back.querySelector("#batch-rise-csv");
    rb.disabled = false;
    rb.addEventListener("click", () => {
      const rows = [["file", "t10_90_ms", "t_1e_ms", "t50_ms", "t10_ms", "t90_ms", "induction_ratio", "verdict", "model",
        "r_per_s", "tm_ms", "overshoot_frac", "baseline", "steady", "decay_model", "decay_tau_ms", "unresolved_fast"]];
      for (const { rec, a } of riseResults) {
        const r = a.rise, lg = r && r.fit && r.fit.model === "logistic_delay" ? r.fit.params : null;
        rows.push([rec.name,
          r && r.ok ? r.free.t1090 * 1e3 : "", r && r.ok ? r.free.t1e * 1e3 : "", r && r.ok ? r.free.t50 * 1e3 : "",
          r && r.ok ? r.free.t10 * 1e3 : "", r && r.ok ? r.free.t90 * 1e3 : "",
          r && r.ok ? r.free.induction : "", a.verdict.klass, r && r.fit ? r.fit.model : "",
          lg ? lg.r : "", lg ? lg.tm * 1e3 : "", r && r.ok ? r.free.overshoot : "",
          r ? r.baseline : "", r ? r.steady : "",
          a.decay && a.decay.fit ? a.decay.fit.model : "", a.decay && a.decay.fit ? a.decay.fit.tauEff * 1e3 : "",
          r ? !!r.unresolvedFast : ""]);
      }
      downloadText("risetime_batch.csv", rowsToCsv(rows), "text/csv");
    });
  }
  setProgress(1); setTimeout(() => setProgress(null), 300); setBar(nAll);
  back.querySelector(".modal").classList.add("batch-done");
  setStatus(`완료 · 행을 누르면 그 파일을 엽니다 — Power scan ${results.length}/${targets.length}` +
    (riseTargets.length ? ` · Rise ${riseResults.length}/${riseTargets.length}` : "") +
    ` · s_max 뒤 ↑ 표시는 edge-censored lower bound`);
  const csvBtn = $("#batch-csv");
  csvBtn.disabled = !results.length;
  csvBtn.addEventListener("click", () => {
    const kd = densityFactor();
    const rows = [["file", "type", "branch", "segpa_n_regimes", "segpa_class", "segpa_pa_head", "segpa_pa_is_lower_bound", "segpa_pa_head_lo2sigma", "segpa_main_rise", "segpa_ith_lo_W", "segpa_ith_hi_W",
      ...(isFinite(kd) ? ["segpa_ith_lo_mW_cm2", "segpa_ith_hi_mW_cm2"] : []), "segpa_status", "segpa_all_regimes", "agg_mode", "pa_report", "pa_source", "pa_grid_limited", "pa_jump_slope", "pa_jump_dlogP", "model_order", "s_max", "s_max_is_lower_bound", "s_max_at_P_W",
      "threshold_W", ...(isFinite(kd) ? ["threshold_mW_cm2"] : []), "saturation_W", ...(isFinite(kd) ? ["saturation_mW_cm2"] : []),
      "background_B", "k1", "k2", "k3", "chi2_red", "runs_p", "n_outliers", "quality_score", "quality_band", "spline_sMax"]];
    for (const { rec, a } of results) {
      const spb = segpaFor(rec, segpaSelectedName(rec)), sq = segpaFirst(spb);
      const allR = spb && spb.regimes ? spb.regimes.slice().sort((x, y) => x.bracketW[0] - y.bracketW[0]).map((q) => `${q.cls}:${q.head.toFixed(3)}@${q.bracketW[0].toExponential(4)}-${q.bracketW[1].toExponential(4)}`).join(" | ") : "";
      rows.push([rec.name, rec.det.type, a._branchUsed, spb && spb.regimes ? spb.regimes.length : "", sq ? sq.cls : "none", sq ? sq.head : "", sq ? sq.status.startsWith("lower-bound") : "", sq ? sq.headLo : "",
        sq && sq.main ? sq.main.slope : "", sq ? sq.bracketW[0] : "", sq ? sq.bracketW[1] : "",
        ...(isFinite(kd) ? [sq ? sq.bracketW[0] * kd : "", sq ? sq.bracketW[1] * kd : ""] : []), sq ? sq.status : "", allR, a._aggUsed || "mean", a.paReport, a.paSource, a.paGridLimited,
        a.paJump ? a.paJump.slope : "", a.paJump ? a.paJump.dlogP : "", "H" + a.chosenOrder, a.sMax, a.sMaxIsLowerBound, a.sMaxAtP,
        a.thresholdP, ...(isFinite(kd) ? [isFinite(a.thresholdP) ? a.thresholdP * kd : ""] : []),
        a.saturationP, ...(isFinite(kd) ? [isFinite(a.saturationP) ? a.saturationP * kd : ""] : []),
        a.background, a.params.k1, a.params.k2, a.params.k3,
        a.diagnostics.chi2red, a.diagnostics.runsP, (a.diagnostics.outliers || []).length,
        a.quality.score, a.quality.band, a.sTotMax]);
    }
    downloadText("INNO_Prism_batch_fit.csv", rowsToCsv(rows), "text/csv");
  });
}

/* ------------------------------ persistence ------------------------------- */
function saveSettings() {
  try { localStorage.setItem("innoPrismSettings", JSON.stringify(App.settings)); } catch (e) {}
}
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem("innoPrismSettings") || "null");
    // v3.8 — 레이어 기본값이 '최소'로 바뀌었다. 옛 저장본은 v2.6 기본값(residual·제외점·
    // bistable·점멸 전부 켜짐)을 그대로 들고 있어 좁은 화면에서 라벨이 겹친다.
    // 세대가 낮으면 **한 번만** 새 기본값으로 이관한다(이후 사용자가 켠 것은 그대로 유지된다).
    if (s && typeof s === "object" && (s.layersV || 0) < 2) { delete s.layers; s.layersV = 2; }
    if (s && typeof s === "object") Object.assign(App.settings, s);
  } catch (e) {}
}

/* --------------------------------- boot ----------------------------------- */
function boot() {
  loadSettings();
  loadCalib();
  lensSyncStart();   // 공용 렌즈 목록 실시간 연결 (미설정이면 즉시 off)
  initWorker();
  $("#calib-btn").addEventListener("click", openCalibModal);
  $("#open-files").addEventListener("click", () => $("#file-input").click());
  $("#open-dir").addEventListener("click", () => $("#dir-input").click());
  $("#file-input").addEventListener("change", (e) => { addFiles(e.target.files); e.target.value = ""; });
  $("#dir-input").addEventListener("change", (e) => { addFiles(e.target.files); e.target.value = ""; });
  $("#batch-btn").addEventListener("click", runBatch);
  $("#clear-all").addEventListener("click", clearAllFiles);
  const sortSel = $("#file-sort");
  if (sortSel) {
    sortSel.value = App.settings.fileSort || "name";
    sortSel.addEventListener("change", () => {
      App.settings.fileSort = sortSel.value;
      saveSettings();
      sortFileList();
      renderFileList();
    });
  }
  $("#file-search").addEventListener("input", renderFileList);
  $("#file-search").addEventListener("focus", () => $("#sidebar").classList.remove("collapsed"));
  $("#side-toggle").addEventListener("click", () => $("#sidebar").classList.toggle("collapsed"));
  $("#file-list").addEventListener("click", (e) => {
    const rm = e.target.closest("[data-rm]");
    if (rm) { removeFile(rm.dataset.rm); e.stopPropagation(); return; }
    const item = e.target.closest(".file-item");
    if (item) selectFile(item.dataset.id);
  });
  $("#tabs").addEventListener("click", (e) => {
    const t = e.target.closest(".tab");
    if (t) { App.activeTab = t.dataset.tab; renderAll(); }
  });
  ["dragenter", "dragover"].forEach((ev) => document.body.addEventListener(ev, (e) => { e.preventDefault(); document.body.classList.add("dragging"); }));
  ["dragleave", "drop"].forEach((ev) => document.body.addEventListener(ev, (e) => { e.preventDefault(); if (ev === "drop" || e.target === document.body) document.body.classList.remove("dragging"); }));
  document.body.addEventListener("drop", (e) => { if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files); });
  renderAll();
  ensureH5().then(() => toast("INNO Prism 준비 완료 — .h5 파일을 열어주세요", 2000)).catch((e) => toast("HDF5 엔진 초기화 실패: " + e.message, 6000));
}
document.addEventListener("DOMContentLoaded", boot);

/* ========================= widefield imaging viewer ========================= */
/* v3.14 — 카메라 프레임(단일/스택) 뷰어.
 *
 * 이 뷰어가 답하려는 질문은 "이미지가 예쁘게 보이는가"가 아니라
 *   ① 어느 입자가, ② 언제, ③ 전체와 함께 변했는가 아니면 혼자 변했는가
 * 이다. 그래서 화면 구성도 그 순서를 따른다: 이미지 → ROI → 트레이스 →
 * 공통모드 분리 → 상태 배정 → 대비 → 차영상 → 파일 간 비교.
 *
 * 물리 해석(활성화냐 억제냐)은 수치에 박지 않는다. 지표는 부호중립으로 계산하고,
 * 이름표만 사용자가 고른 프리셋으로 바꾼다. 같은 측정 방식이 두 물리에 다 쓰이므로
 * 뷰어를 둘로 나누지 않고 하나로 두되, 방향을 단정하지 않는 쪽을 기본값으로 둔다.
 */

/* ------------------------------ colormaps --------------------------------- */
const IMG_CMAPS = {
  Grey: [[0, 0, 0], [255, 255, 255]],
  Viridis: [[68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37]],
  Turbo: [[48, 18, 59], [50, 166, 236], [122, 250, 137], [250, 186, 51], [122, 4, 3]],
  Hot: [[0, 0, 0], [180, 0, 0], [255, 140, 0], [255, 255, 160], [255, 255, 255]],
  Ice: [[3, 5, 26], [18, 58, 122], [40, 140, 190], [140, 210, 230], [255, 255, 255]],
};
const IMG_DIVERGING = [[33, 102, 172], [103, 169, 207], [247, 247, 247], [239, 138, 98], [178, 24, 43]];
function buildLut(stops) {
  const lut = new Uint8Array(256 * 3);
  const n = stops.length - 1;
  for (let i = 0; i < 256; i++) {
    const t = (i / 255) * n, k = Math.min(n - 1, Math.floor(t)), f = t - k;
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = Math.round(stops[k][c] + f * (stops[k + 1][c] - stops[k][c]));
  }
  return lut;
}
const LUT_CACHE = {};
function lutFor(name) { return LUT_CACHE[name] || (LUT_CACHE[name] = buildLut(name === "__div" ? IMG_DIVERGING : (IMG_CMAPS[name] || IMG_CMAPS.Grey))); }

/* ------------------------------ frame cache -------------------------------- */
/** 프레임은 요청한 것만 읽고 최대 MAXCACHE 장만 들고 있는다.
 *  1024² float32 = 4 MB/장이므로 스택 전체 보관은 프레임 수가 조금만 늘어도 위험하다. */
const IMG_MAXCACHE = 12;
function imgState(rec) {
  if (rec.cache.imgState) return rec.cache.imgState;
  const d = PrismH5.extractImaging(rec.h5, rec.det);
  const st = {
    d, frames: new Map(), order: [],
    // 표시 기본값 — EM gain 프레임은 증폭된 단일광자 스파이크가 화면을 뒤덮어서
    // 원본 그대로 두면 입자가 눈에 안 들어온다. **표시에만** 평활을 걸고(수치에는
    // 절대 쓰지 않는다) 하한을 중앙값 근처로 올린다.
    frame: 0, cmap: "Grey", scale: "sqrt", pLo: 50, pHi: 99.95, dispSmooth: 1.0,
    showRoi: true, source: "frame",
    rois: [], detInfo: null, basis: d.n > 1 ? "mean" : "frame",
    detOpt: { smooth: 1.5, k: 8, shapeMin: 4.0, minSep: 6, maxSpots: 40, apR: 3 },
    photOpt: { r: 3, rin: 5, rout: 9 },
    traces: null, blank: null, cm: null, evidence: null,
    assign: null, assignFrom: null, labels: "neutral",
    traceMode: "raw", diffA: 0, diffB: d.n > 1 ? 1 : 0, diffSigma: false,
    target: null, targetAuto: false, quietMax: 2.0,
    view: null, compare: null,
  };
  rec.cache.imgState = st;
  return st;
}
function imgFrame(rec, i) {
  const st = imgState(rec);
  const k = Math.max(0, Math.min(st.d.n - 1, i | 0));
  if (st.frames.has(k)) return st.frames.get(k);
  const f = PrismH5.readImageFrame(rec.h5, rec.det.imaging, k);
  if (!f) return null;
  st.frames.set(k, f); st.order.push(k);
  while (st.order.length > IMG_MAXCACHE) { const old = st.order.shift(); if (old !== k) st.frames.delete(old); }
  return f;
}
/** mean / max 투영 — 프레임을 하나씩 읽어 누적한다 (전체를 동시에 들지 않는다). */
function imgProjection(rec, kind) {
  const st = imgState(rec);
  const key = "proj_" + kind;
  if (st[key]) return st[key];
  let acc = null;
  for (let i = 0; i < st.d.n; i++) {
    const f = imgFrame(rec, i);
    if (!f) continue;
    acc = kind === "max" ? PrismImg.accMax(acc, f) : PrismImg.accSum(acc, f);
  }
  if (acc && kind === "mean") PrismImg.scaleInPlace(acc, 1 / st.d.n);
  st[key] = acc;
  return acc;
}
/** 현재 화면에 그릴 이미지 배열 */
function imgCurrent(rec) {
  const st = imgState(rec);
  if (st.source === "mean") return imgProjection(rec, "mean");
  if (st.source === "max") return imgProjection(rec, "max");
  return imgFrame(rec, st.frame);
}
function imgBasisImage(rec) {
  const st = imgState(rec);
  if (st.basis === "mean") return imgProjection(rec, "mean");
  if (st.basis === "max") return imgProjection(rec, "max");
  return imgFrame(rec, st.frame);
}

/* ------------------------------- main view --------------------------------- */
function renderImaging(rec) {
  const st = imgState(rec);
  const d = st.d, stack = d.n > 1;
  const cam = d.camera;
  const camBits = cam ? [
    `<b>${esc(cam.name)}</b>${cam.connected === false ? ' <span class="tag-Low">미연결</span>' : ""}`,
    cam.exposure != null ? `노출 ${fmt(cam.exposure, 3)} s` : null,
    cam.emGain != null ? `EM gain ${cam.emGain}` : null,
    cam.temperature != null ? `${cam.temperature} °C${cam.tempStatus ? " (" + esc(cam.tempStatus) + ")" : ""}` : null,
    cam.readoutMode ? `readout ${esc(cam.readoutMode)}` : null,
    cam.hbin && cam.vbin ? `binning ${cam.hbin}×${cam.vbin}` : null,
  ].filter(Boolean).join(" · ") : "";

  const wlNote = d.wl && d.wl.isIndex
    ? `<div class="s muted">이 파일의 <span class="mono">${esc(d.wl.path.split("/").pop())}</span> 는 0,1,2,… 즉 <b>픽셀 번호</b>이지 파장이 아닙니다
        (<span class="mono">wl_calib = pixels</span>). 분광 보정이 걸리지 않은 상태이므로 가로축을 파장으로 읽지 마십시오.</div>`
    : "";
  const nameNote = /spectrum$/.test(d.path) && d.kind === "frame"
    ? `<div class="s muted">데이터셋 이름은 <span class="mono">spectrum</span> 이지만 shape 가 ${d.ny}×${d.nx} 인 <b>2D 이미지</b>입니다
        (readout_mode = Image). 이름이 아니라 shape 로 판정했습니다.</div>`
    : "";

  $("#view").innerHTML = `
  <div class="panel"><h3>이미지 <span class="muted small">${esc(d.path)} · ${d.ny}×${d.nx}${stack ? ` · ${d.n} 프레임` : ""}</span></h3>
    <div class="flex small" style="margin-bottom:6px;flex-wrap:wrap;">
      <label class="ctl"><span>표시</span><select id="im-src">
        <option value="frame">프레임</option>
        ${stack ? '<option value="mean">mean projection</option><option value="max">max projection</option>' : ""}
      </select></label>
      <label class="ctl"><span>컬러맵</span><select id="im-cmap">${Object.keys(IMG_CMAPS).map((k) => `<option${k === st.cmap ? " selected" : ""}>${k}</option>`).join("")}</select></label>
      <label class="ctl"><span>밝기 스케일</span><select id="im-scale">
        <option value="lin">linear</option><option value="sqrt" selected>sqrt</option><option value="log">log</option></select></label>
      <label class="ctl"><span>하한 %</span><input id="im-plo" type="number" step="0.1" value="${st.pLo}" style="width:72px"></label>
      <label class="ctl"><span>상한 %</span><input id="im-phi" type="number" step="0.01" value="${st.pHi}" style="width:78px"></label>
      <label class="ctl"><span>표시 평활 σ</span><select id="im-smooth">
        <option value="0">없음 (원본 화소)</option>
        <option value="1" selected>1.0</option><option value="1.5">1.5</option><option value="2">2.0</option></select></label>
      <label class="ctl"><span>ROI 표시</span><select id="im-roi"><option value="1">표시</option><option value="0">숨김</option></select></label>
      <label class="ctl" title="파일에 µm/px 가 없으므로 스케일바는 여기 입력한 값으로만 그립니다 (저장 그림의 캡션에 '사용자 입력'으로 남습니다)">
        <span>µm/px <span class="muted">(스케일바)</span></span>
        <span class="flex" style="gap:4px"><input id="im-umpx" type="number" step="any" min="0" placeholder="미입력" style="width:84px" value="${st.umPerPx > 0 ? st.umPerPx : ""}">
        ${imgLastUmPerPx() > 0 && !(st.umPerPx > 0) ? `<button id="im-umpx-last" class="small" title="최근에 입력한 값 — 같은 광학계인지 확인하고 쓰세요">최근 ${fmt(imgLastUmPerPx(), 4)}</button>` : ""}</span></label>
      <span class="right flex">
        <button id="im-zoomout" class="small" title="축소 (−)">−</button>
        <span id="im-zoomlab" class="mono small" style="min-width:74px;text-align:center;align-self:center"></span>
        <button id="im-zoomin" class="small" title="확대 (+)">+</button>
        <button id="im-fit" class="small" title="전체가 보이도록 (0)">화면 맞춤</button>
        <button id="im-1to1" class="small" title="화소 1:1 (1)">1:1</button>
        <button id="im-png" class="small" title="보고서용 고정 판형 (컬러바·스케일바 포함)">그림 저장</button>
      </span>
    </div>
    ${stack ? `<div class="flex small" style="margin-bottom:6px;align-items:center;gap:8px;">
      <span style="min-width:64px">프레임</span>
      <input id="im-frame" type="range" min="0" max="${d.n - 1}" value="${st.frame}" style="flex:1">
      <span id="im-frame-lab" class="mono" style="min-width:190px"></span>
      <button id="im-play" class="small">▶ 재생</button>
    </div>` : ""}
    <div id="im-wrap" style="position:relative;background:#0d0d0c;border:1px solid var(--border);border-radius:6px;overflow:hidden;">
      <canvas id="im-canvas" style="display:block;width:100%;cursor:crosshair;"></canvas>
      <svg id="im-ovl" style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none;"></svg>
    </div>
    <div class="flex small" style="margin-top:6px;">
      <span id="im-readout" class="mono muted">커서 = 좌표·원본 화소값 · 휠/±키 = 확대·축소 · 드래그 = 이동 · 더블클릭 또는 0 키 = 화면 맞춤 · 1 키 = 화소 1:1 · Shift+클릭 = ROI 추가/삭제</span>
      <span id="im-stats" class="mono right"></span>
    </div>
    ${nameNote}${wlNote}
  </div>

  <div class="panel"><h3>입자(ROI) 검출</h3>
    <div class="flex small" style="margin-bottom:6px;flex-wrap:wrap;">
      ${stack ? `<label class="ctl"><span>검출 기준</span><select id="det-basis">
        <option value="mean"${st.basis === "mean" ? " selected" : ""}>mean projection</option>
        <option value="max"${st.basis === "max" ? " selected" : ""}>max projection</option>
        <option value="frame"${st.basis === "frame" ? " selected" : ""}>현재 프레임</option></select></label>` : ""}
      <label class="ctl"><span>평활 σ (px)</span><input id="det-smooth" type="number" step="0.1" value="${st.detOpt.smooth}" style="width:70px"></label>
      <label class="ctl"><span>문턱 k·σ</span><input id="det-k" type="number" step="0.5" value="${st.detOpt.k}" style="width:70px"></label>
      <label class="ctl"><span>모양 문턱</span><input id="det-shape" type="number" step="0.5" value="${st.detOpt.shapeMin}" style="width:70px"></label>
      <label class="ctl"><span>최소 간격 (px)</span><input id="det-sep" type="number" step="1" value="${st.detOpt.minSep}" style="width:80px"></label>
      <label class="ctl"><span>최대 개수</span><input id="det-max" type="number" step="5" value="${st.detOpt.maxSpots}" style="width:80px"></label>
      <label class="ctl"><span>조리개 r (px)</span><input id="det-apr" type="number" step="1" value="${st.photOpt.r}" style="width:80px"></label>
      <span class="right flex"><button id="det-run" class="small">검출</button><button id="det-clear" class="small">ROI 전체 지우기</button></span>
    </div>
    <div id="det-note" class="small"></div>
    <div id="det-table" style="margin-top:6px;"></div>
  </div>

  ${stack ? `
  <div class="panel"><h3>ROI 트레이스</h3>
    <div class="flex small" style="margin-bottom:6px;">
      <label class="ctl"><span>표시</span><select id="tr-mode">
        <option value="raw">원본 flux</option>
        <option value="norm">ROI 기준 정규화 (S/ref)</option>
        <option value="resid">공통모드 제거 후 잔차 (S/E)</option></select></label>
      <label class="ctl"><span>가로축</span><select id="tr-x"><option value="time">시간 (s)</option><option value="index">프레임 번호</option></select></label>
      <span class="right"><button id="tr-csv" class="small">CSV</button></span>
    </div>
    <div id="chart-tr" class="chart chart-mid"></div>
    <div id="tr-note" class="small muted"></div>
  </div>

  <div class="panel"><h3>공통모드 분리 <span class="muted small">전체가 함께 변했는가 · 한 입자만 변했는가</span></h3>
    <div id="cm-body"></div>
  </div>

  <div class="panel"><h3>변조 깊이 · 공간 선택성 <span class="muted small">표적만 반응했는가</span></h3>
    <div id="sel-body"></div>
  </div>

  <div class="panel"><h3>상태 배정 <span class="muted small">어느 프레임이 어떤 조작 뒤인가</span></h3>
    <div id="state-body"></div>
  </div>

  <div class="panel"><h3>두 상태 대비</h3>
    <div id="contrast-body"></div>
  </div>

  <div class="panel"><h3>차영상</h3>
    <div class="flex small" style="margin-bottom:6px;flex-wrap:wrap;">
      <label class="ctl"><span>기준 A</span><select id="df-a"></select></label>
      <label class="ctl"><span>빼는 값 B</span><select id="df-b"></select></label>
      <label class="ctl"><span>단위</span><select id="df-unit">
        <option value="counts">counts</option><option value="sigma">σ (같은 상태 프레임쌍에서 실측)</option></select></label>
      <span class="right"><button id="df-run" class="small">차영상 계산</button></span>
    </div>
    <div id="df-note" class="small muted"></div>
    <div id="df-wrap" style="position:relative;background:#0d0d0c;border:1px solid var(--border);border-radius:6px;overflow:hidden;margin-top:6px;display:none;">
      <canvas id="df-canvas" style="display:block;width:100%;"></canvas>
    </div>
  </div>` : ""}

  <div class="panel"><h3>다른 파일과 비교 <span class="muted small">같은 자리 반복 촬영 — 정합 후 ROI 전이</span></h3>
    <div id="cmp-body"></div>
  </div>

  <div class="panel"><h3>취득 설정</h3>
    ${camBits ? `<div class="s" style="margin-bottom:6px;">${camBits}</div>` : ""}
    <div class="attr-box mono small">${attrsHtml(d.settings)}</div>
    ${imgHardwareHtml(d)}
  </div>`;

  imgBindImage(rec);
  imgBindDetect(rec);
  if (stack) { imgBindTrace(rec); imgBindDiff(rec); }
  imgFillCompare(rec);
  imgRedraw(rec);
  if (!st.rois.length) imgRunDetect(rec, true);
  else imgRefreshAnalysis(rec);
}

/* ------------------------------ image canvas ------------------------------- */
/**
 * 이미지를 넣을 화면 상자(CSS px).
 *
 * 가로만 맞추면 1024² 이미지가 세로로 화면을 넘어가 한눈에 안 들어온다.
 * **뷰포트에 남은 높이**를 실제로 재서 세로도 같이 제한한다.
 * 상자를 넘지 않는 한 확대는 자유롭다 — 넘어가는 순간 잘라 보는 방식(view rect)으로
 * 바뀌므로 캔버스 자체는 절대 화면 밖으로 자라지 않는다.
 */
function imgFitBox(rec) {
  const wrap = $("#im-wrap");
  const panel = wrap && wrap.parentElement;
  const availW = Math.max(240, (panel ? panel.clientWidth : 700) - 2);
  let top = 0;
  try { top = wrap.getBoundingClientRect().top; } catch (e) { top = 200; }
  // 아래에 읽기값 줄·패널 여백이 들어갈 자리를 남긴다
  const reserve = 96;
  const availH = Math.max(240, Math.min(1600, (window.innerHeight || 900) - Math.max(80, top) - reserve));
  return { w: availW, h: availH };
}
/** view rect 를 점 (px, py) 기준으로 factor 배 확대(<1)/축소(>1). 경계를 벗어나지 않는다. */
function imgZoomBy(rec, factor, px, py) {
  const st = imgState(rec), d = st.d, v = st.view || (st.view = { x: 0, y: 0, w: d.nx, h: d.ny });
  const cx = px != null ? px : v.x + v.w / 2, cy = py != null ? py : v.y + v.h / 2;
  const minW = 16, minH = 16;
  let nw = v.w * factor, nh = v.h * factor;
  // 전체보다 커지지 않게, 또 너무 작아지지 않게 — 종횡비는 유지
  const capped = Math.min(d.nx / v.w, d.ny / v.h);
  if (factor > 1) { const f = Math.min(factor, capped); nw = v.w * f; nh = v.h * f; }
  if (nw < minW || nh < minH) { const f = Math.max(minW / v.w, minH / v.h); nw = v.w * f; nh = v.h * f; }
  v.x = Math.max(0, Math.min(d.nx - nw, cx - (cx - v.x) * (nw / v.w)));
  v.y = Math.max(0, Math.min(d.ny - nh, cy - (cy - v.y) * (nh / v.h)));
  v.w = nw; v.h = nh;
  imgRedraw(rec);
}
/** 전체가 보이도록 — view rect 를 이미지 전체로 되돌린다 (기본 상태). */
function imgFitAll(rec) {
  const st = imgState(rec), d = st.d;
  st.view = { x: 0, y: 0, w: d.nx, h: d.ny };
  imgRedraw(rec);
}
/** 화소 1:1 — 화면 상자만큼의 영역만 원래 화소 크기로 본다 (중심 유지). */
function imgOneToOne(rec) {
  const st = imgState(rec), d = st.d, v = st.view || (st.view = { x: 0, y: 0, w: d.nx, h: d.ny });
  const box = imgFitBox(rec);
  const cx = v.x + v.w / 2, cy = v.y + v.h / 2;
  const nw = Math.min(d.nx, Math.max(16, box.w)), nh = Math.min(d.ny, Math.max(16, box.h));
  st.view = {
    x: Math.max(0, Math.min(d.nx - nw, cx - nw / 2)),
    y: Math.max(0, Math.min(d.ny - nh, cy - nh / 2)),
    w: nw, h: nh,
  };
  imgRedraw(rec);
}
function imgRedraw(rec) {
  const st = imgState(rec), d = st.d;
  const img = imgCurrent(rec);
  const cv = $("#im-canvas");
  if (!img || !cv) return;
  // **표시 전용** 평활. 측광·검출·차영상은 전부 원본 화소로 계산한다 —
  // 여기서 만든 배열은 화면 밖으로 나가지 않는다.
  let shown = img;
  if (st.dispSmooth > 0) {
    const key = `${st.source}:${st.frame}:${st.dispSmooth}`;
    if (st._smKey !== key) { st._smImg = PrismImg.gaussBlur(img, d.nx, d.ny, st.dispSmooth); st._smKey = key; }
    shown = st._smImg;
  }
  const [lo, hi] = PrismImg.percentiles(shown, [st.pLo / 100, st.pHi / 100]);
  st._range = { lo, hi: hi === lo ? lo + 1 : hi }; // v3.19 — 보고서 컬러바 눈금용
  const bytes = PrismImg.scaleToBytes(shown, lo, hi === lo ? lo + 1 : hi, st.scale);
  const lut = lutFor(st.cmap);
  let off = st._off;
  if (!off || off.width !== d.nx || off.height !== d.ny) {
    off = st._off = document.createElement("canvas");
    off.width = d.nx; off.height = d.ny;
  }
  const octx = off.getContext("2d");
  const idata = octx.createImageData(d.nx, d.ny);
  const px = idata.data;
  for (let i = 0, j = 0; i < bytes.length; i++, j += 4) {
    const b = bytes[i] * 3;
    px[j] = lut[b]; px[j + 1] = lut[b + 1]; px[j + 2] = lut[b + 2]; px[j + 3] = 255;
  }
  octx.putImageData(idata, 0, 0);
  // view rect (확대 = 잘라 보는 영역) + 표시 크기 (그 영역을 화면 상자에 맞춤)
  if (!st.view) st.view = { x: 0, y: 0, w: d.nx, h: d.ny };
  const v = st.view;
  const box = imgFitBox(rec);
  // 가로·세로 **둘 다** 상자를 넘지 않도록 — 가로만 맞추면 1024² 가 세로로 화면을 넘는다
  const scale = Math.min(box.w / v.w, box.h / v.h);
  const dispW = Math.max(40, Math.round(v.w * scale));
  const dispH = Math.max(40, Math.round(v.h * scale));
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  cv.width = Math.round(dispW * dpr); cv.height = Math.round(dispH * dpr);
  cv.style.width = dispW + "px"; cv.style.height = dispH + "px";
  // 확대할 때는 화소를 또렷하게, 축소할 때는 부드럽게
  cv.style.imageRendering = scale >= 1 ? "pixelated" : "auto";
  const wrap = $("#im-wrap");
  wrap.style.width = dispW + "px";
  wrap.style.margin = "0 auto";
  st.disp = { w: dispW, h: dispH, scale };
  const ctx = cv.getContext("2d");
  ctx.imageSmoothingEnabled = scale < 1;
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.drawImage(off, v.x, v.y, v.w, v.h, 0, 0, cv.width, cv.height);
  const zl = $("#im-zoomlab");
  if (zl) zl.textContent = `${(scale * 100).toFixed(scale < 1 ? 0 : 0)}%` +
    (v.w < d.nx || v.h < d.ny ? ` · ${Math.round(v.w)}×${Math.round(v.h)}` : "");
  // stats + frame label
  const stt = PrismImg.robustStats(img);
  $("#im-stats").textContent = `원본 배경 ${fmt(stt.median, 5)} · σ(MAD) ${fmt(stt.sigma, 3)}` +
    ` · 표시범위 ${fmt(lo, 5)}–${fmt(hi, 5)}${st.dispSmooth > 0 ? ` (평활 σ=${st.dispSmooth} 적용된 화면 기준)` : ""}`;
  const fl = $("#im-frame-lab");
  if (fl) {
    const t = d.time && isFinite(d.time[st.frame]) ? `t = ${fmt(d.time[st.frame], 4)} s` : "시간 기록 없음";
    fl.textContent = st.source === "frame" ? `#${st.frame} · ${t}` : `(${st.source} projection 표시 중)`;
  }
  imgDrawOverlay(rec);
}
function imgDrawOverlay(rec) {
  const st = imgState(rec), d = st.d, svg = $("#im-ovl");
  if (!svg) return;
  const v = st.view, cv = $("#im-canvas");
  if (!v || !cv) { svg.innerHTML = ""; return; }
  // **표시 크기(CSS px)** 기준이어야 한다 — 캔버스 backing store 는 devicePixelRatio
  // 배율이 걸려 있어서 그걸 쓰면 hidpi 화면에서 ROI 원이 어긋난다.
  const dsp = st.disp || { w: cv.clientWidth || cv.width, h: cv.clientHeight || cv.height };
  const sx = dsp.w / v.w, sy = dsp.h / v.h;
  svg.setAttribute("viewBox", `0 0 ${dsp.w} ${dsp.h}`);
  const sbSvg = imgScaleBarSvg(st, dsp, sx);
  if (!st.showRoi || !st.rois.length) { svg.innerHTML = sbSvg; return; }
  const verd = st.cm && st.cm.ok ? st.cm.flags : null;
  const color = (i) => {
    if (!verd) return "#8fd0ff";
    const f = verd[i];
    if (!f) return "#8fd0ff";
    return f.verdict === "independent" ? "#ffb020" : (f.verdict === "unidentified" ? "#77776f" : "#8fd0ff");
  };
  const r = st.photOpt.r * Math.max(sx, 0.01);
  svg.innerHTML = st.rois.map((p, i) => {
    const cx = ((p.xc != null ? p.xc : p.x) - v.x) * sx, cy = ((p.yc != null ? p.yc : p.y) - v.y) * sy;
    if (cx < -20 || cy < -20 || cx > dsp.w + 20 || cy > dsp.h + 20) return "";
    const c = color(i);
    const rr = Math.max(4, r);
    // 표적 ROI 는 이중 원으로 표시 — 선택성 표의 기준점이 어디인지 그림에서 바로 보이게
    const tgt = i === st.target
      ? `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${(rr + 4).toFixed(1)}" fill="none" stroke="#ffb020" stroke-width="1.1" stroke-dasharray="3 2"/>` : "";
    return tgt + `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${rr.toFixed(1)}" fill="none" stroke="${c}" stroke-width="1.3"/>` +
      `<text x="${(cx + rr + 5).toFixed(1)}" y="${(cy - 3).toFixed(1)}" fill="${c}" font-size="10" font-family="monospace">${i}</text>`;
  }).join("") + sbSvg;
}
/* ------------------------- imaging: scale bar · report ------------------------ */
const IMG_UMPX_KEY = "innoPrismImgUmPerPx";
function imgLastUmPerPx() { try { return Number(localStorage.getItem(IMG_UMPX_KEY)) || 0; } catch (e) { return 0; } }
/** 화면 오버레이용 스케일바 (오른쪽 아래). µm/px 가 입력된 경우에만. */
function imgScaleBarSvg(st, dsp, sx) {
  if (!(st.umPerPx > 0) || !st.view) return "";
  const Lum = PrismReport.niceLength(st.view.w * st.umPerPx);
  const Lpx = Lum / st.umPerPx * sx;
  if (!(Lpx > 4)) return "";
  const x1 = dsp.w - Math.max(12, 0.05 * dsp.w), x0 = x1 - Lpx;
  const h = Math.max(4, Math.round(0.012 * dsp.h)), y1 = dsp.h - Math.max(12, 0.05 * dsp.h);
  return `<g><rect x="${x0.toFixed(1)}" y="${(y1 - h).toFixed(1)}" width="${Lpx.toFixed(1)}" height="${h}" fill="#fff" stroke="rgba(0,0,0,.55)" stroke-width="1"/>` +
    `<text x="${((x0 + x1) / 2).toFixed(1)}" y="${(y1 - h - 5).toFixed(1)}" text-anchor="middle" fill="#fff" font-size="13" font-weight="700"
      font-family="Arial, sans-serif" style="paint-order:stroke;stroke:rgba(0,0,0,.7);stroke-width:3px">${esc(PrismReport.fmtLength(Lum))}</text></g>`;
}
/** 컬러바 눈금값: 표시 변환(lin/sqrt/log)의 역변환으로, 막대 위치 f∈[0,1] 에 해당하는 원 강도. */
function imgInvScale(f, lo, hi, mode) {
  const span = hi - lo;
  if (mode === "log") return lo + Math.expm1(f * Math.log1p(span));
  if (mode === "sqrt") return lo + Math.pow(f * Math.sqrt(span), 2);
  return lo + f * span;
}
/** 보고서 본문: 보이는 영역(확대 상태 그대로) + 컬러바 + 스케일바 + ROI. 화면 크기와 무관한 고정 판형. */
function imgReportProvider(rec) {
  return {
    async body(opt, g, fmtKind) {
      const st = imgState(rec);
      imgRedraw(rec); // 오프스크린 컬러 이미지를 최신 상태로
      if (!st._off || !st.view) throw new Error("이미지가 아직 그려지지 않았습니다");
      const th = PrismReport.THEMES[opt.theme] || PrismReport.THEMES.light;
      const S = fmtKind === "svg" ? 2 : opt.scale;
      const cv = document.createElement("canvas");
      cv.width = Math.round(g.W * S); cv.height = Math.round(g.bodyH * S);
      const ctx = cv.getContext("2d");
      ctx.scale(S, S);
      ctx.fillStyle = th.bg; ctx.fillRect(0, 0, g.W, g.bodyH);
      const v = st.view, font = PrismReport.FONT;
      const pad = 22, cbW = 16, cbGap = 14, cbLab = 78;
      const boxW = g.W - 2 * pad - cbGap - cbW - cbLab, boxH = g.bodyH - 2 * pad;
      const k = Math.min(boxW / v.w, boxH / v.h);
      const iw = v.w * k, ih = v.h * k;
      const ix = pad + (boxW - iw) / 2, iy = pad + (boxH - ih) / 2;
      // 확대 저장일 때는 화소를 또렷하게 (보간으로 입자를 부풀리지 않는다)
      ctx.imageSmoothingEnabled = k < 1;
      ctx.drawImage(st._off, v.x, v.y, v.w, v.h, ix, iy, iw, ih);
      ctx.strokeStyle = th.axis; ctx.lineWidth = 1;
      ctx.strokeRect(ix - 0.5, iy - 0.5, iw + 1, ih + 1);
      // ROI
      if (st.showRoi && st.rois.length) {
        const r = Math.max(4, st.photOpt.r * k);
        ctx.font = `600 12px ${font}`;
        st.rois.forEach((p, i) => {
          const cx = ix + ((p.xc != null ? p.xc : p.x) - v.x) * k, cy = iy + ((p.yc != null ? p.yc : p.y) - v.y) * k;
          if (cx < ix || cy < iy || cx > ix + iw || cy > iy + ih) return;
          ctx.strokeStyle = i === st.target ? "#ffb020" : "#8fd0ff"; ctx.lineWidth = 1.4;
          ctx.beginPath(); ctx.arc(cx, cy, r, 0, 2 * Math.PI); ctx.stroke();
          ctx.fillStyle = ctx.strokeStyle; ctx.fillText(String(i), cx + r + 3, cy - 3);
        });
      }
      const notes = [];
      // 스케일바
      if (st.umPerPx > 0) {
        const Lum = PrismReport.niceLength(v.w * st.umPerPx);
        const Lpx = Lum / st.umPerPx * k;
        const x1 = ix + iw - 0.05 * iw, x0 = x1 - Lpx;
        const bh = Math.max(5, 0.014 * ih), y1 = iy + ih - 0.06 * ih;
        ctx.fillStyle = "#ffffff"; ctx.fillRect(x0, y1 - bh, Lpx, bh);
        ctx.strokeStyle = "rgba(0,0,0,0.55)"; ctx.lineWidth = 1; ctx.strokeRect(x0, y1 - bh, Lpx, bh);
        const lab = PrismReport.fmtLength(Lum);
        ctx.font = `700 17px ${font}`; ctx.textAlign = "center";
        ctx.lineWidth = 3; ctx.strokeStyle = "rgba(0,0,0,0.7)"; ctx.strokeText(lab, (x0 + x1) / 2, y1 - bh - 6);
        ctx.fillStyle = "#ffffff"; ctx.fillText(lab, (x0 + x1) / 2, y1 - bh - 6);
        ctx.textAlign = "left";
        notes.push(`스케일바 ${lab} (${fmt(st.umPerPx, 4)} µm/px · 사용자 입력)`);
      }
      // 컬러바 — 표시 범위와 변환(lin/sqrt/log)을 그대로 반영
      const lut = lutFor(st.cmap);
      const cbx = ix + iw + cbGap, cby = iy, cbh = ih;
      for (let i = 0; i < 256; i++) {
        const b = (255 - i) * 3;
        ctx.fillStyle = `rgb(${lut[b]},${lut[b + 1]},${lut[b + 2]})`;
        ctx.fillRect(cbx, cby + cbh * i / 256, cbW, cbh / 256 + 0.6);
      }
      ctx.strokeStyle = th.axis; ctx.lineWidth = 1; ctx.strokeRect(cbx - 0.5, cby - 0.5, cbW + 1, cbh + 1);
      const rg = st._range || { lo: 0, hi: 1 };
      ctx.fillStyle = th.ink; ctx.font = `400 13px ${font}`; ctx.textBaseline = "middle";
      for (const f of [0, 0.25, 0.5, 0.75, 1]) {
        const yy = cby + cbh * (1 - f);
        ctx.fillRect(cbx + cbW, yy - 0.5, 5, 1);
        ctx.fillText(fmt(imgInvScale(f, rg.lo, rg.hi, st.scale), 4), cbx + cbW + 8, yy);
      }
      ctx.textBaseline = "alphabetic";
      ctx.save();
      ctx.translate(g.W - 12, cby + cbh / 2); ctx.rotate(-Math.PI / 2);
      ctx.font = `400 14px ${font}`; ctx.textAlign = "center";
      ctx.fillText(`counts${st.scale !== "lin" ? ` (${st.scale} 표시)` : ""}`, 0, 0);
      ctx.restore();
      if (st.dispSmooth > 0) notes.push(`표시 평활 σ=${st.dispSmooth} px`);
      return { canvas: cv, note: notes.join(" · ") };
    },
  };
}
function imgOpenReport(rec) {
  const st = imgState(rec), d = st.d;
  const what = st.source === "frame" ? (d.n > 1 ? `frame #${st.frame}` : "") : `${st.source} projection`;
  PrismReport.openDialog({
    kind: "image", key: "im-canvas",
    title: "Widefield 이미지",
    subtitle: [rec.name.replace(/\.h5$/i, ""), what].filter(Boolean).join(" · "),
    stem: rec.name.replace(/\.h5$/i, "") + (st.source === "frame" ? `_f${st.frame}` : `_${st.source}`),
    version: prismVersion(),
    provider: imgReportProvider(rec),
    hasScaleBar: st.umPerPx > 0,
    scaleBarWhyNot: st.umPerPx > 0 ? "" : "µm/px 가 파일에 없어 스케일바를 넣지 않았습니다 — 이미지 도구줄의 µm/px 칸에 입력하면 들어갑니다.",
  });
}
function imgBindImage(rec) {
  const st = imgState(rec), d = st.d;
  const set = (id, ev, fn) => { const e = $(id); if (e) e.addEventListener(ev, fn); };
  set("#im-src", "change", (e) => { st.source = e.target.value; imgRedraw(rec); });
  set("#im-cmap", "change", (e) => { st.cmap = e.target.value; imgRedraw(rec); });
  set("#im-scale", "change", (e) => { st.scale = e.target.value; imgRedraw(rec); });
  set("#im-plo", "change", (e) => { st.pLo = Number(e.target.value); imgRedraw(rec); });
  set("#im-phi", "change", (e) => { st.pHi = Number(e.target.value); imgRedraw(rec); });
  set("#im-smooth", "change", (e) => { st.dispSmooth = Number(e.target.value); st._smKey = null; imgRedraw(rec); });
  set("#im-roi", "change", (e) => { st.showRoi = e.target.value === "1"; imgDrawOverlay(rec); });
  set("#im-fit", "click", () => imgFitAll(rec));
  set("#im-1to1", "click", () => imgOneToOne(rec));
  set("#im-zoomin", "click", () => imgZoomBy(rec, 1 / 1.4));
  set("#im-zoomout", "click", () => imgZoomBy(rec, 1.4));
  set("#im-frame", "input", (e) => {
    st.frame = Number(e.target.value);
    if (st.source !== "frame") { st.source = "frame"; $("#im-src").value = "frame"; }
    imgRedraw(rec);
  });
  set("#im-png", "click", () => imgOpenReport(rec));
  set("#im-umpx", "change", (e) => {
    const v = Number(e.target.value);
    st.umPerPx = v > 0 ? v : null;
    if (st.umPerPx) { try { localStorage.setItem(IMG_UMPX_KEY, String(st.umPerPx)); } catch (err) { /* 무시 */ } }
    const lb = $("#im-umpx-last"); if (lb) lb.remove();
    imgDrawOverlay(rec);
  });
  set("#im-umpx-last", "click", (e) => {
    st.umPerPx = imgLastUmPerPx();
    $("#im-umpx").value = st.umPerPx;
    e.target.remove();
    imgDrawOverlay(rec);
  });
  set("#im-play", "click", () => {
    if (st._timer) { clearInterval(st._timer); st._timer = null; $("#im-play").textContent = "▶ 재생"; return; }
    $("#im-play").textContent = "■ 정지";
    st._timer = setInterval(() => {
      const el = $("#im-frame");
      if (!el) { clearInterval(st._timer); st._timer = null; return; }
      st.frame = (st.frame + 1) % d.n; st.source = "frame";
      el.value = st.frame; $("#im-src").value = "frame";
      imgRedraw(rec);
    }, 600);
  });
  const cv = $("#im-canvas");
  if (!cv) return;
  const toImg = (ev) => {
    const r = cv.getBoundingClientRect(), v = st.view;
    return { x: v.x + (ev.clientX - r.left) / r.width * v.w, y: v.y + (ev.clientY - r.top) / r.height * v.h };
  };
  cv.addEventListener("mousemove", (ev) => {
    if (st._drag) {
      const r = cv.getBoundingClientRect(), v = st.view;
      const dx = (ev.clientX - st._drag.cx) / r.width * v.w, dy = (ev.clientY - st._drag.cy) / r.height * v.h;
      v.x = Math.max(0, Math.min(d.nx - v.w, st._drag.vx - dx));
      v.y = Math.max(0, Math.min(d.ny - v.h, st._drag.vy - dy));
      imgRedraw(rec);
      return;
    }
    const p = toImg(ev);
    const img = imgCurrent(rec);
    const ix = Math.floor(p.x), iy = Math.floor(p.y);
    if (img && ix >= 0 && iy >= 0 && ix < d.nx && iy < d.ny)
      $("#im-readout").textContent = `x=${ix} y=${iy} · 원본 화소값 ${fmt(img[iy * d.nx + ix], 6)}`;
  });
  cv.addEventListener("mousedown", (ev) => {
    if (ev.shiftKey) { imgToggleRoi(rec, toImg(ev)); return; }
    st._drag = { cx: ev.clientX, cy: ev.clientY, vx: st.view.x, vy: st.view.y };
    cv.style.cursor = "grabbing";
  });
  window.addEventListener("mouseup", () => { if (st._drag) { st._drag = null; cv.style.cursor = "crosshair"; } });
  cv.addEventListener("dblclick", () => imgFitAll(rec));
  cv.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    const p = toImg(ev);
    imgZoomBy(rec, ev.deltaY < 0 ? 0.8 : 1.25, p.x, p.y);
  }, { passive: false });
  // 키보드: + − 확대/축소 · 0 화면맞춤 · 1 화소 1:1
  if (!st._keyBound) {
    st._keyBound = (ev) => {
      if (!$("#im-canvas") || App.activeId !== rec.id || App.activeTab !== "view") return;
      const t = ev.target;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      if (ev.key === "+" || ev.key === "=") { ev.preventDefault(); imgZoomBy(rec, 1 / 1.4); }
      else if (ev.key === "-" || ev.key === "_") { ev.preventDefault(); imgZoomBy(rec, 1.4); }
      else if (ev.key === "0") { ev.preventDefault(); imgFitAll(rec); }
      else if (ev.key === "1") { ev.preventDefault(); imgOneToOne(rec); }
    };
    window.addEventListener("keydown", st._keyBound);
  }
  // 창 크기가 바뀌면 화면 상자도 바뀐다 → 다시 맞춘다 (연타 방지로 디바운스)
  if (!st._resizeBound) {
    st._resizeBound = () => {
      clearTimeout(st._resizeTimer);
      st._resizeTimer = setTimeout(() => {
        if ($("#im-canvas") && App.activeId === rec.id && App.activeTab === "view") imgRedraw(rec);
      }, 120);
    };
    window.addEventListener("resize", st._resizeBound);
  }
}
function imgToggleRoi(rec, p) {
  const st = imgState(rec);
  const sep = st.detOpt.minSep;
  const i = st.rois.findIndex((q) => Math.hypot((q.xc != null ? q.xc : q.x) - p.x, (q.yc != null ? q.yc : q.y) - p.y) < sep);
  if (i >= 0) st.rois.splice(i, 1);
  else st.rois.push({ x: Math.round(p.x), y: Math.round(p.y), xc: p.x, yc: p.y, manual: true, shape: NaN, flux: NaN });
  imgInvalidate(rec);
  imgRefreshAnalysis(rec);
  imgDrawOverlay(rec);
}
function imgInvalidate(rec) {
  const st = imgState(rec);
  st.traces = null; st.blank = null; st.cm = null; st.evidence = null; st.compare = null;
  if (st.targetAuto) st.target = null;   // 자동 제안이었다면 새 ROI 집합에서 다시 제안
}

/* ------------------------------ detection ---------------------------------- */
function imgBindDetect(rec) {
  const st = imgState(rec);
  const set = (id, fn) => { const e = $(id); if (e) e.addEventListener("change", fn); };
  set("#det-basis", (e) => { st.basis = e.target.value; });
  set("#det-smooth", (e) => { st.detOpt.smooth = Number(e.target.value); });
  set("#det-k", (e) => { st.detOpt.k = Number(e.target.value); });
  set("#det-shape", (e) => { st.detOpt.shapeMin = Number(e.target.value); });
  set("#det-sep", (e) => { st.detOpt.minSep = Number(e.target.value); });
  set("#det-max", (e) => { st.detOpt.maxSpots = Number(e.target.value); });
  set("#det-apr", (e) => { st.photOpt.r = Number(e.target.value); st.photOpt.rin = st.photOpt.r + 2; st.photOpt.rout = st.photOpt.r + 6; });
  $("#det-run").addEventListener("click", () => imgRunDetect(rec, false));
  $("#det-clear").addEventListener("click", () => {
    st.rois = []; st.detInfo = null; imgInvalidate(rec);
    imgRefreshAnalysis(rec); imgDrawOverlay(rec);
  });
}
function imgRunDetect(rec, quiet) {
  const st = imgState(rec), d = st.d;
  const base = imgBasisImage(rec);
  if (!base) { toast("검출 기준 이미지를 읽지 못했습니다"); return; }
  const r = PrismImg.detectSpots(base, d.nx, d.ny, st.detOpt);
  st.rois = r.spots.map((s) => Object.assign({}, s));
  st.detInfo = r;
  imgInvalidate(rec);
  imgRefreshAnalysis(rec);
  imgDrawOverlay(rec);
  if (!quiet) toast(`ROI ${st.rois.length}개 검출`);
}
function imgDetNoteHtml(rec) {
  const st = imgState(rec), r = st.detInfo;
  if (!r) return `<span class="muted">아직 검출하지 않았습니다.</span>`;
  const basisTxt = { mean: "mean projection", max: "max projection", frame: `프레임 #${st.frame}` }[st.basis] || st.basis;
  return `
  <div>기준 <b>${esc(basisTxt)}</b> · 국소최대 후보 <b>${r.nCandidates}</b>개 →
    모양 문턱(${fmt(r.params.shapeMin, 2)})으로 <b class="tag-Low">${r.nRejectedShape}개 기각</b> →
    최소간격·개수 제한으로 ${r.nDropped}개 제외 → <b>ROI ${st.rois.length}개</b></div>
  <div class="s muted">EM gain 이 걸린 프레임에서는 증폭된 <b>단일광자 사건이 화소 하나짜리 스파이크</b>로 찍혀
    화소 분포의 꼬리가 정규분포보다 훨씬 두껍습니다 — 이 자료에서도 중앙값+30σ 를 넘는 화소가 수백 개였습니다.
    그래서 σ 문턱만으로는 스파이크가 걸러지지 않고, <b>모양</b>(조리개합 ÷ 봉우리)으로 가릅니다.
    회절한계 입자는 여러 화소가 함께 밝아 이 값이 크고(실측 5.6–17), 스파이크는 1 근처입니다.
    <b>어두운 입자가 빠진 것 같으면 모양 문턱을 낮추십시오</b> — 대신 스파이크가 섞여 들어옵니다.</div>`;
}
function imgRoiTableHtml(rec) {
  const st = imgState(rec);
  if (!st.rois.length) return `<div class="s muted">ROI 가 없습니다. 「검출」을 누르거나 이미지에서 Shift+클릭으로 직접 추가하십시오.</div>`;
  const cm = st.cm, tr = st.traces, d = st.d;
  const verdTxt = (i) => {
    if (!cm || !cm.ok) return `<span class="muted">–</span>`;
    const f = cm.flags[i];
    if (f.verdict === "independent") return `<span class="tag-Low">개별 거동</span> <span class="muted">(z=${fmt(f.maxZ, 3)} @f${f.atFrame})</span>`;
    if (f.verdict === "unidentified") return `<span class="muted">판정 불가 (관측가능 ${f.nObservable}/${d.n})</span>`;
    return `<span class="tag-High">공통모드와 일치</span> <span class="muted">(z≤${fmt(f.maxZ, 3)})</span>`;
  };
  const rows = st.rois.map((p, i) => {
    const t = tr ? tr[i] : null;
    const nDet = t && st.blank ? t.filter((v, k) => v > 3 * st.blank[k]).length : null;
    return `<tr>
      <td>${i}</td>
      <td class="mono">${fmt(p.xc != null ? p.xc : p.x, 5)}, ${fmt(p.yc != null ? p.yc : p.y, 5)}</td>
      <td class="mono">${p.manual ? '<span class="muted">수동</span>' : fmt(p.shape, 3)}</td>
      <td class="mono">${t ? fmt(Math.max.apply(null, t), 5) : (isFinite(p.flux) ? fmt(p.flux, 5) : "–")}</td>
      ${d.n > 1 ? `<td class="mono">${nDet != null ? `${nDet}/${d.n}` : "–"}</td><td>${verdTxt(i)}</td>` : ""}
    </tr>`;
  }).join("");
  return `<table class="res"><thead><tr><th>#</th><th>x, y (px)</th><th>shape</th><th>${d.n > 1 ? "최대 flux" : "flux"}</th>
    ${d.n > 1 ? "<th>검출 프레임</th><th>판정</th>" : ""}</tr></thead><tbody>${rows}</tbody></table>`;
}

/* --------------------------- analysis refresh ------------------------------ */
function imgEnsureTraces(rec) {
  const st = imgState(rec), d = st.d;
  if (st.traces || !st.rois.length) return;
  const traces = st.rois.map(() => []);
  const blank = [];
  for (let k = 0; k < d.n; k++) {
    const f = imgFrame(rec, k);
    if (!f) { traces.forEach((t) => t.push(NaN)); blank.push(NaN); continue; }
    const ph = PrismImg.photometry(f, d.nx, d.ny, st.rois, st.photOpt);
    ph.forEach((p, i) => traces[i].push(p.sum));
    const bn = PrismImg.blankNoise(f, d.nx, d.ny, st.rois, st.photOpt);
    blank.push(bn.sigma);
  }
  st.traces = traces; st.blank = blank;
  if (d.n > 1) {
    st.cm = PrismImg.commonMode(traces, { sigmaBlank: blank });
    st.evidence = PrismImg.stateEvidence({
      n: d.n, time: d.time, aux: d.aux, settings: d.settings,
      level: st.cm && st.cm.ok ? st.cm.g : null,
    });
  }
}
function imgRefreshAnalysis(rec) {
  const st = imgState(rec);
  imgEnsureTraces(rec);
  $("#det-note").innerHTML = imgDetNoteHtml(rec);
  $("#det-table").innerHTML = imgRoiTableHtml(rec);
  if (st.d.n > 1) {
    imgDrawTraces(rec);
    $("#cm-body").innerHTML = imgCommonModeHtml(rec);
    $("#sel-body").innerHTML = imgSelectivityHtml(rec);
    imgBindSelectivity(rec);
    $("#state-body").innerHTML = imgStateHtml(rec);
    imgBindState(rec);
    $("#contrast-body").innerHTML = imgContrastHtml(rec);
    imgBindContrast(rec);
    imgFillDiffSelects(rec);
  }
  imgFillCompare(rec);
  imgDrawOverlay(rec);
}

/* ------------------------------- traces ------------------------------------ */
function imgBindTrace(rec) {
  const st = imgState(rec);
  $("#tr-mode").addEventListener("change", (e) => { st.traceMode = e.target.value; imgDrawTraces(rec); });
  $("#tr-x").addEventListener("change", () => imgDrawTraces(rec));
  $("#tr-csv").addEventListener("click", () => imgTraceCsv(rec));
}
function imgDrawTraces(rec) {
  const st = imgState(rec), d = st.d, el = $("#chart-tr");
  if (!el) return;
  imgEnsureTraces(rec);
  if (!st.traces || !st.traces.length) {
    el.innerHTML = ""; $("#tr-note").textContent = "ROI 가 없습니다.";
    Plotly.purge(el);
    return;
  }
  const useTime = ($("#tr-x") || {}).value !== "index" && d.time && d.time.length === d.n;
  const x = useTime ? d.time : Array.from({ length: d.n }, (_, i) => i);
  const cm = st.cm;
  const mode = st.traceMode;
  const traces = st.rois.map((p, i) => {
    let y = st.traces[i];
    if (mode === "norm" && cm && cm.ok) y = y.map((v) => v / cm.ref[i]);
    else if (mode === "resid" && cm && cm.ok) y = y.map((v, k) => (cm.exp[i][k] > 0 ? v / cm.exp[i][k] : NaN));
    const indep = cm && cm.ok && cm.flags[i].verdict === "independent";
    return {
      x, y, mode: "lines+markers", name: `#${i}`,
      line: { width: indep ? 2.4 : 1.2, color: indep ? "#ffb020" : undefined },
      marker: { size: indep ? 7 : 5 },
      hovertemplate: `#${i}<br>%{x}<br>%{y:.5g}<extra></extra>`,
    };
  });
  if (mode !== "resid" && cm && cm.ok) {
    traces.push({
      x, y: mode === "norm" ? cm.g : cm.g.map((v, k) => v * PrismImg.median(cm.ref)),
      mode: "lines", name: "공통모드 g", line: { color: "#e8ecff", width: 2.6, dash: "dot" },
      hovertemplate: "공통모드 g=%{y:.4g}<extra></extra>",
    });
  }
  const ylab = { raw: "조리개 flux (counts)", norm: "S / ref (ROI 기준 정규화)", resid: "S / E (공통모드 제거 후)" }[mode];
  newPlot(el, traces, {
    xaxis: Object.assign(baseLayout().xaxis, { title: { text: useTime ? "시간 (s)" : "프레임 번호" } }),
    yaxis: Object.assign(baseLayout().yaxis, { title: { text: ylab } }),
    showlegend: true,
  });
  const notes = [];
  if (mode === "resid") notes.push("잔차 1.0 = 공통모드만으로 설명됨. 1 에서 크게 벗어난 점이 개별 거동입니다.");
  if (st.blank && st.blank.every(isFinite))
    notes.push(`프레임별 측광 잡음 σ(빈 자리 실측) = ${st.blank.map((v) => fmt(v, 3)).join(" · ")} counts`);
  $("#tr-note").innerHTML = notes.join(" · ");
}
function imgTraceCsv(rec) {
  const st = imgState(rec), d = st.d;
  imgEnsureTraces(rec);
  const head = ["frame", "time_s", "sigma_blank"];
  st.rois.forEach((p, i) => head.push(`roi${i}_x`, `roi${i}_y`, `roi${i}_flux`));
  const rows = [head];
  for (let k = 0; k < d.n; k++) {
    const r = [k, d.time ? d.time[k] : "", st.blank ? st.blank[k] : ""];
    st.rois.forEach((p, i) => r.push(fmt(p.xc != null ? p.xc : p.x, 6), fmt(p.yc != null ? p.yc : p.y, 6), st.traces[i][k]));
    rows.push(r);
  }
  downloadText(rec.name.replace(/\.h5$/i, "") + "_roi_traces.csv", rowsToCsv(rows), "text/csv");
}

/* --------------------------- common mode panel ----------------------------- */
function imgCommonModeHtml(rec) {
  const st = imgState(rec), d = st.d, cm = st.cm;
  const intro = `<div class="s muted" style="margin-bottom:6px;">
    시야 전체가 같은 비율로 변한 성분(<b>공통모드</b> g)을 먼저 떼어 내고, 한 입자만의 변화는 잔차에 남깁니다.
    <b>공통모드는 "기기 탓"이라는 뜻이 아닙니다</b> — 전역 변화의 원인은 둘 다 가능합니다:
    기기 쪽(초점 이탈·빔 요동·시야 이동·셔터)과 시료 쪽(widefield 조사 자체가 시야의 모든 입자를
    함께 변화시키는 경우). <b>파일만으로는 이 둘을 구분할 수 없습니다.</b> 구분하려면 조사하지 않은
    영역을 함께 찍거나, 조사 세기를 바꿔 가며 반복해야 합니다.
    다만 어느 쪽이든 <b>그 변화를 단일입자 스위칭이라고 부를 수는 없다</b>는 점은 같고,
    이 분리는 그것을 막기 위한 것입니다.
  </div>`;
  if (!cm) return intro + `<div class="s muted">ROI 가 필요합니다.</div>`;
  if (!cm.ok) return intro + `<div class="s">분리하지 않았습니다 — ${esc(cm.why)}.</div>`;
  const gRow = cm.g.map((v, k) => `<td class="mono">${fmt(v, 4)}</td>`).join("");
  const obsRow = cm.g.map((v, k) => {
    const n = cm.flags.reduce((a, f, i) => a + (cm.observable[i][k] ? 1 : 0), 0);
    return `<td class="mono">${n}/${cm.nRoi}</td>`;
  }).join("");
  const indep = cm.flags.filter((f) => f.verdict === "independent");
  const unid = cm.flags.filter((f) => f.verdict === "unidentified");
  const verdict = cm.commonDominant
    ? `<div class="s"><b class="tag-Low">시야 전체가 함께 변했습니다</b> — 공통모드 진폭 ${fmt(cm.commonSwing, 4)}배
        (최대 g ÷ 최소 g). 표적 하나만 조작하는 측정이었다면 이 결과는 <b>의도와 다릅니다</b>:
        겨냥하지 않은 입자들까지 함께 변했다는 뜻이므로, 조작이 국소적이지 않았거나 시야 전체가
        같은 영향을 받았거나(예: widefield 조사 자체) 기기 조건이 바뀐 것입니다.
        개별 입자의 변화는 이 전역 변화 위에 얹혀 있으니 따로 떼어 읽어야 합니다.</div>`
    : `<div class="s"><b class="tag-High">시야 전체 수준은 거의 일정합니다</b> — 공통모드 진폭 ${fmt(cm.commonSwing, 4)}배.
        따라서 아래 개별 거동은 전역 요인으로 설명되지 않습니다.</div>`;
  const gate = `<div class="s muted">관측 가능성 게이트: 기대값 E = g·ref 가 잡음(${fmt(cm.kSig, 2)}σ) 아래인 점은
    <b>아무것도 구분하지 못하므로</b> 판정에서 뺐습니다 — 전체 ${cm.nPoints}점 중 <b>${cm.nObservable}점</b>만 사용.
    (이 게이트가 없으면 시야가 통째로 꺼진 프레임에서 잡음÷잡음 이 2 oct 씩 튀어 "개별 스위칭" 허위 경보가 납니다.)</div>`;
  const noise = `<div class="s muted">잡음 = √(σ_blank² + (${fmt(cm.relScatter, 3)}·E)²).
    σ_blank 는 각 프레임의 <b>빈 자리에 같은 조리개를 놓고 실측</b>한 값이고, 상대항 ${fmt(cm.relScatter, 3)} 은
    관측 가능한 점들의 잔차 산포에서 직접 잰 값입니다 — EM gain 통계를 가정하지 않습니다.</div>`;
  return intro + verdict + `
  <table class="res" style="margin:8px 0;"><thead><tr><th>프레임</th>${cm.g.map((v, k) => `<th>${k}</th>`).join("")}</tr></thead>
    <tbody><tr><td>공통모드 g</td>${gRow}</tr><tr><td>관측 가능 ROI</td>${obsRow}</tr></tbody></table>
  <div class="s">개별 거동 <b>${indep.length}</b>개 · 판정 불가 <b>${unid.length}</b>개 · 공통모드와 일치 ${cm.nRoi - indep.length - unid.length}개</div>
  ${indep.length ? `<ul class="s" style="margin:4px 0 0 18px;">${indep.map((f) =>
    `<li>ROI <b>#${f.roi}</b> — 프레임 ${f.atFrame} 에서 기대값의 <b>${fmt(f.ratioAtWorst, 3)}배</b> (z = ${fmt(f.maxZ, 3)}, 문턱 ${fmt(cm.kSig, 2)})</li>`).join("")}</ul>` : ""}
  ${unid.length ? `<div class="s muted" style="margin-top:4px;">판정 불가: ${unid.map((f) => `#${f.roi}(관측가능 ${f.nObservable}/${d.n})</span>`).join(", ")}
    — 비교할 수 있는 프레임이 2장 미만이라 "변화 없음"이라고도 말할 수 없습니다.</div>` : ""}
  ${gate}${noise}`;
}

/* ---------------------------- state assignment ----------------------------- */
const IMG_LABELSETS = {
  neutral: { name: "중립", a: "상태 A", b: "상태 B", note: "물리 방향을 가정하지 않습니다." },
  activation: { name: "활성화 (조작이 발광을 살림)", a: "activation ON", b: "activation OFF", note: "조작이 가해졌을 때 발광이 살아나는 구조로 읽습니다." },
  depletion: { name: "억제 (조작이 발광을 끔)", a: "depletion OFF", b: "depletion ON", note: "조작이 가해졌을 때 발광이 억제되는 구조로 읽습니다." },
  darkrec: { name: "darkening / recovery", a: "recovery 후", b: "darkening 후",
    note: "한 조작이 입자를 어둡게 하고 다른 조작이 되살리는 구조로 읽습니다. 어느 프레임이 어느 쪽인지는 파일에 없으므로 배정이 맞는지 트레이스로 확인하십시오." },
};
function imgStateHtml(rec) {
  const st = imgState(rec), d = st.d, ev = st.evidence;
  const head = `<div class="s muted" style="margin-bottom:6px;">
    <b>이 파일은 어느 프레임이 빔 on 인지 기록하지 않을 수 있습니다.</b> 그래서 배정을 자동으로 고르지 않고,
    네 경로의 근거를 나란히 보여 준 뒤 채택은 사용자가 합니다. 첫 프레임이 <b>조작 전 기준</b>이면
    어느 상태도 아니므로 제외(–)합니다 — 기준 프레임을 한쪽에 억지로 넣으면 그쪽 평균이 오염됩니다.
    근거들이 서로 어긋나면 그 자체가 결과입니다 —
    예컨대 간격은 A·B·A 를 가리키는데 밝기는 첫 프레임만 밝다면 "상태"가 아니라 <b>비가역적 소실</b>
    (퇴색·초점 이탈·이동)을 시사합니다.</div>`;
  if (!ev) return head + `<div class="s muted">ROI 와 트레이스가 필요합니다.</div>`;
  const row = (title, h, noteKey) => {
    if (!h) return `<tr><td>${title}</td><td class="muted" colspan="3">${esc(ev[noteKey] || "근거 없음")}</td></tr>`;
    return `<tr><td>${title}</td><td>${esc(h.strength || "–")}</td>
      <td class="s">${esc(h.note || h.from || "")}</td>
      <td class="mono">${h.assign.map((v) => (v === 0 ? "A" : "B")).join(" ")}
        <button class="small" data-adopt="${title}">채택</button></td></tr>`;
  };
  const schedRow = ev.schedule
    ? `<tr><td>측정 설정 구조</td><td>${esc(ev.schedule.strength)}</td><td class="s">${esc(ev.schedule.note)}</td>
        <td class="mono">${ev.schedule.assign.map((v) => (v < 0 ? "–" : v === 0 ? "A" : "B")).join(" ")}
        <button class="small" data-adopt="측정 설정 구조">채택</button></td></tr>`
    : `<tr><td>측정 설정 구조</td><td class="muted">없음</td><td class="s muted" colspan="2">${esc(ev.scheduleNote || "num_cycle 설정이 없습니다")}</td></tr>`;
  const fileRow = ev.file
    ? `<tr><td>파일 기록</td><td>확정</td><td class="s mono">${esc(ev.file.from)}</td>
        <td class="mono">${ev.file.assign.map((v) => (v === 0 ? "A" : "B")).join(" ")} <button class="small" data-adopt="파일 기록">채택</button></td></tr>`
    : `<tr><td>파일 기록</td><td class="muted">없음</td><td class="s muted" colspan="2">${(ev.fileNotes || []).map(esc).join(" / ") || "상태 배열이 없습니다"}</td></tr>`;
  const conflict = ev.conflict
    ? `<div class="s"><b class="tag-Low">근거들이 서로 어긋납니다.</b> 하나를 임의로 채택하면 그 불일치가 사라집니다 —
        무엇이 어긋났는지 확인한 뒤 고르십시오.</div>`
    : (ev.agree ? `<div class="s"><span class="tag-High">근거들이 서로 일치합니다.</span></div>` : "");
  const cur = st.assign
    ? `<div class="s" style="margin-top:6px;">현재 배정: <span class="mono">${st.assign.map((v) => (v === 0 ? "A" : v === 1 ? "B" : "–")).join(" ")}</span>
        <span class="muted">(– 는 어느 상태도 아님 — 조작 전 기준 프레임 등)</span>
        <span class="muted">(출처: ${esc(st.assignFrom || "수동")})</span></div>`
    : `<div class="s muted" style="margin-top:6px;">아직 배정하지 않았습니다 — 대비 지표는 배정 후에 계산됩니다.</div>`;
  const manual = `<div class="flex small" style="margin-top:8px;flex-wrap:wrap;align-items:flex-end;">
    <span style="align-self:center">수동 배정</span>
    ${Array.from({ length: d.n }, (_, k) => `<label class="ctl"><span>#${k}</span>
      <select data-frame="${k}" class="st-sel">
        <option value="-"${!st.assign || st.assign[k] === -1 ? " selected" : ""}>제외</option>
        <option value="0"${st.assign && st.assign[k] === 0 ? " selected" : ""}>A</option>
        <option value="1"${st.assign && st.assign[k] === 1 ? " selected" : ""}>B</option>
      </select></label>`).join("")}
    <label class="ctl"><span>용어</span><select id="st-labels">
      ${Object.keys(IMG_LABELSETS).map((k) => `<option value="${k}"${st.labels === k ? " selected" : ""}>${IMG_LABELSETS[k].name}</option>`).join("")}
    </select></label>
  </div>
  <div class="s muted">용어 선택은 <b>표시 문구만</b> 바꿉니다 — 숫자는 부호중립으로 계산되며 달라지지 않습니다.
    ${esc(IMG_LABELSETS[st.labels].note)}</div>`;
  return head + `<table class="res"><thead><tr><th>근거</th><th>강도</th><th>내용</th><th>배정 / 채택</th></tr></thead><tbody>
    ${fileRow}
    ${schedRow}
    ${row("프레임 간격", ev.cadence, "cadenceNote")}
    ${row("밝기 준위", ev.levels, "levelsNote")}
  </tbody></table>${conflict}${cur}${manual}`;
}
function imgBindState(rec) {
  const st = imgState(rec), ev = st.evidence;
  document.querySelectorAll("[data-adopt]").forEach((b) => b.addEventListener("click", () => {
    const k = b.getAttribute("data-adopt");
    const h = k === "파일 기록" ? ev.file
      : k === "측정 설정 구조" ? ev.schedule
      : k === "프레임 간격" ? ev.cadence : ev.levels;
    if (!h) return;
    st.assign = h.assign.slice(); st.assignFrom = k;
    $("#state-body").innerHTML = imgStateHtml(rec); imgBindState(rec);
    $("#contrast-body").innerHTML = imgContrastHtml(rec); imgBindContrast(rec);
    imgFillDiffSelects(rec);
  }));
  document.querySelectorAll(".st-sel").forEach((s) => s.addEventListener("change", () => {
    const n = st.d.n;
    if (!st.assign) st.assign = new Array(n).fill(-1);
    document.querySelectorAll(".st-sel").forEach((e) => {
      const k = Number(e.getAttribute("data-frame"));
      st.assign[k] = e.value === "-" ? -1 : Number(e.value);
    });
    st.assignFrom = "수동";
    $("#contrast-body").innerHTML = imgContrastHtml(rec); imgBindContrast(rec);
    imgFillDiffSelects(rec);
  }));
  const lb = $("#st-labels");
  if (lb) lb.addEventListener("change", (e) => {
    st.labels = e.target.value;
    $("#state-body").innerHTML = imgStateHtml(rec); imgBindState(rec);
    $("#contrast-body").innerHTML = imgContrastHtml(rec); imgBindContrast(rec);
  });
}

/* -------------------------------- contrast --------------------------------- */
function imgContrastHtml(rec) {
  const st = imgState(rec), L = IMG_LABELSETS[st.labels];
  if (!st.assign || !st.traces) return `<div class="s muted">상태를 배정하면 대비 지표가 계산됩니다.</div>`;
  const c = PrismImg.contrast(st.traces, st.assign);
  if (!c.idxA.length || !c.idxB.length)
    return `<div class="s muted">두 상태 모두에 최소 한 프레임씩 배정해야 합니다 (현재 A ${c.idxA.length} · B ${c.idxB.length}).</div>`;
  const s = c.summary;
  const cm = st.cm;
  const warn = s.mixedDirection
    ? `<div class="s"><b class="tag-Low">입자마다 방향이 갈립니다.</b> 일부는 A 에서, 일부는 B 에서 더 밝습니다 —
        "전체가 한 방향으로 스위칭한다"는 서술은 이 자료에 맞지 않습니다.</div>` : "";
  const cmWarn = cm && cm.ok && cm.commonDominant
    ? `<div class="s"><b class="tag-Low">주의 — 시야 전체가 ${fmt(cm.commonSwing, 4)}배로 함께 변한 상태입니다.</b>
        아래 대비는 그 전역 변화를 포함한 값이므로, 입자 고유의 대비로 읽으면 안 됩니다.</div>` : "";
  const rows = c.rows.map((r) => `<tr>
    <td>${r.roi}</td>
    <td class="mono">${fmt(r.meanA, 5)}${isFinite(r.sdA) ? ` <span class="muted">±${fmt(r.sdA, 3)}</span>` : ""}</td>
    <td class="mono">${fmt(r.meanB, 5)}${isFinite(r.sdB) ? ` <span class="muted">±${fmt(r.sdB, 3)}</span>` : ""}</td>
    <td class="mono">${fmt(r.ratioAB, 4)}</td><td class="mono">${fmt(r.ratioBA, 4)}</td>
    <td class="mono">${fmt(r.michelson, 4)}</td></tr>`).join("");
  return `${cmWarn}${warn}
  <div class="s">${esc(L.a)} 프레임 ${s.nA}장 · ${esc(L.b)} 프레임 ${s.nB}장 · ROI ${s.nRoi}개</div>
  <div class="s">Michelson 대비 (A−B)/(A+B): 중앙값 <b>${fmt(s.michelsonMedian, 4)}</b>
    · 범위 ${fmt(s.michelsonMin, 4)} ~ ${fmt(s.michelsonMax, 4)}${isFinite(s.michelsonIQR) ? ` · IQR ${fmt(s.michelsonIQR, 4)}` : ""}</div>
  <div class="s muted">A÷B 와 B÷A 를 <b>둘 다</b> 표시합니다. 어느 쪽이 "켜짐"인지는 파일이 말해 주지 않으므로
    방향을 골라 한쪽만 보여 주면 해석을 숫자에 박아 넣는 셈이 됩니다.
    Michelson 대비는 −1~+1 로 대칭·유계라서 방향 해석 없이 크기만 비교할 수 있습니다.</div>
  <table class="res" style="margin-top:6px;"><thead><tr><th>#</th><th>${esc(L.a)} 평균</th><th>${esc(L.b)} 평균</th>
    <th>A÷B</th><th>B÷A</th><th>Michelson</th></tr></thead><tbody>${rows}</tbody></table>
  <div class="flex small" style="margin-top:6px;"><span class="right"><button id="ct-csv" class="small">CSV</button></span></div>`;
}
function imgBindContrast(rec) {
  const b = $("#ct-csv");
  if (!b) return;
  b.addEventListener("click", () => {
    const st = imgState(rec);
    const c = PrismImg.contrast(st.traces, st.assign);
    const rows = [["roi", "x", "y", "n_A", "n_B", "mean_A", "mean_B", "sd_A", "sd_B", "ratio_A_over_B", "ratio_B_over_A", "michelson"]];
    c.rows.forEach((r, i) => {
      const p = st.rois[i];
      rows.push([r.roi, fmt(p.xc != null ? p.xc : p.x, 6), fmt(p.yc != null ? p.yc : p.y, 6),
        r.nA, r.nB, r.meanA, r.meanB, r.sdA, r.sdB, r.ratioAB, r.ratioBA, r.michelson]);
    });
    downloadText(rec.name.replace(/\.h5$/i, "") + "_contrast.csv", rowsToCsv(rows), "text/csv");
  });
}

/* ------------------------------- difference -------------------------------- */
function imgFillDiffSelects(rec) {
  const st = imgState(rec), d = st.d;
  const a = $("#df-a"), b = $("#df-b");
  if (!a || !b) return;
  const opts = [];
  for (let k = 0; k < d.n; k++) opts.push(`<option value="f${k}">프레임 #${k}</option>`);
  if (st.assign && st.assign.some((v) => v === 0) && st.assign.some((v) => v === 1)) {
    const L = IMG_LABELSETS[st.labels];
    opts.push(`<option value="A">${esc(L.a)} 평균</option>`, `<option value="B">${esc(L.b)} 평균</option>`);
  }
  a.innerHTML = opts.join(""); b.innerHTML = opts.join("");
  a.value = st.assign ? "A" : "f0";
  b.value = st.assign ? "B" : (d.n > 1 ? "f1" : "f0");
  imgDiffNote(rec);
}
function imgStateMean(rec, which) {
  const st = imgState(rec), d = st.d;
  const want = which === "A" ? 0 : 1;
  let acc = null, n = 0;
  for (let k = 0; k < d.n; k++) {
    if (!st.assign || st.assign[k] !== want) continue;
    const f = imgFrame(rec, k);
    if (!f) continue;
    acc = PrismImg.accSum(acc, f); n++;
  }
  if (acc && n > 1) PrismImg.scaleInPlace(acc, 1 / n);
  return { img: acc, n };
}
function imgPickImage(rec, key) {
  if (key === "A" || key === "B") return imgStateMean(rec, key).img;
  return imgFrame(rec, Number(String(key).slice(1)));
}
/** 같은 상태 프레임쌍이 2장 이상일 때만 σ 를 만들 수 있다. */
function imgSigmaPairs(rec) {
  const st = imgState(rec), d = st.d;
  const groups = {};
  for (let k = 0; k < d.n; k++) {
    const g = st.assign ? st.assign[k] : 0;
    if (g < 0) continue;
    (groups[g] = groups[g] || []).push(k);
  }
  for (const g of Object.keys(groups)) {
    if (groups[g].length >= 2) {
      const a = imgFrame(rec, groups[g][0]), b = imgFrame(rec, groups[g][1]);
      if (a && b) return { sigma: PrismImg.noiseFromPair(a, b), from: `프레임 #${groups[g][0]} − #${groups[g][1]} (같은 상태)` };
    }
  }
  return null;
}
function imgDiffNote(rec) {
  const sp = imgSigmaPairs(rec);
  const el = $("#df-note");
  if (!el) return;
  const u = $("#df-unit");
  if (!sp) {
    if (u) { u.value = "counts"; Array.from(u.options).forEach((o) => { if (o.value === "sigma") o.disabled = true; }); }
    el.innerHTML = `σ 단위는 쓸 수 없습니다 — <b>같은 상태에 배정된 프레임이 2장 이상이어야</b> 화소 잡음을 실측할 수 있습니다.
      여기서 광자전달 모형을 가정해 σ 를 지어내면 EM gain 초과잡음 때문에 유의성이 체계적으로 부풀려집니다.`;
  } else {
    if (u) Array.from(u.options).forEach((o) => { o.disabled = false; });
    el.innerHTML = `σ = ${fmt(sp.sigma, 4)} counts/화소 — ${esc(sp.from)} 의 차에서 실측(÷√2). 모형 가정 없음.`;
  }
}
function imgBindDiff(rec) {
  const st = imgState(rec);
  $("#df-a").addEventListener("change", () => imgDiffNote(rec));
  $("#df-b").addEventListener("change", () => imgDiffNote(rec));
  $("#df-run").addEventListener("click", () => {
    const A = imgPickImage(rec, $("#df-a").value), B = imgPickImage(rec, $("#df-b").value);
    if (!A || !B) { toast("두 이미지를 모두 고르십시오"); return; }
    const df = PrismImg.difference(A, B);
    let img = df.img, unit = "counts";
    if ($("#df-unit").value === "sigma") {
      const sp = imgSigmaPairs(rec);
      if (!sp || !(sp.sigma > 0)) { toast("σ 를 실측할 수 없습니다"); return; }
      img = Float32Array.from(df.img, (v) => v / sp.sigma); unit = "σ";
    }
    const d = st.d;
    const [p1, p99] = PrismImg.percentiles(img, [0.002, 0.998]);
    const m = Math.max(Math.abs(p1), Math.abs(p99)) || 1;
    const bytes = PrismImg.scaleDiverging(img, m);
    const lut = lutFor("__div");
    const cv = $("#df-canvas");
    const off = document.createElement("canvas"); off.width = d.nx; off.height = d.ny;
    const octx = off.getContext("2d"), idata = octx.createImageData(d.nx, d.ny), px = idata.data;
    for (let i = 0, j = 0; i < bytes.length; i++, j += 4) {
      const b = bytes[i] * 3; px[j] = lut[b]; px[j + 1] = lut[b + 1]; px[j + 2] = lut[b + 2]; px[j + 3] = 255;
    }
    octx.putImageData(idata, 0, 0);
    // 차영상도 세로가 화면을 넘지 않게 같은 상자 계산을 쓴다
    const dbox = imgFitBox(rec);
    const dscale = Math.min((($("#df-wrap").parentElement.clientWidth || 700) - 24) / d.nx, dbox.h / d.ny);
    const dw = Math.max(80, Math.round(d.nx * dscale)), dh = Math.max(80, Math.round(d.ny * dscale));
    cv.width = dw; cv.height = dh;
    cv.style.width = dw + "px"; cv.style.height = dh + "px";
    cv.style.imageRendering = dscale >= 1 ? "pixelated" : "auto";
    $("#df-wrap").style.width = dw + "px"; $("#df-wrap").style.margin = "6px auto 0";
    const dctx = cv.getContext("2d");
    dctx.imageSmoothingEnabled = dscale < 1;
    dctx.drawImage(off, 0, 0, cv.width, cv.height);
    $("#df-wrap").style.display = "";
    $("#df-note").innerHTML += `<div style="margin-top:4px;">표시범위 ±${fmt(m, 4)} ${unit} (파랑 = B 가 큼 · 빨강 = A 가 큼) ·
      차영상 배경 ${fmt(df.median, 4)} · σ(MAD) ${fmt(df.sigma, 4)} ${unit}</div>`;
  });
}

/* ---------------------------- cross-file compare ---------------------------- */
function imgCompareTargets(rec) {
  const st = imgState(rec);
  return App.files.filter((f) => !f.error && f.id !== rec.id && f.det && f.det.type === "imaging" &&
    f.det.imaging.nx === st.d.nx && f.det.imaging.ny === st.d.ny);
}
function imgFillCompare(rec) {
  const st = imgState(rec);
  const el = $("#cmp-body");
  if (!el) return;
  const targets = imgCompareTargets(rec);
  const intro = `<div class="s muted" style="margin-bottom:6px;">
    띠통과(DoG) 상호상관으로 이동량을 구한 뒤 현재 ROI 를 대상 파일로 옮기고, <b>입자마다</b> 상대가 있는지 따집니다.
    전역 "같은 자리인가" 판정 하나로 뭉뚱그리지 않습니다 — 시야가 조금만 이동해도 일부 입자는 넘어오고 일부는 밖으로 나가는데,
    그 둘을 구분하지 않으면 "사라진 입자"와 "화면 밖으로 나간 입자"가 섞입니다.
    <span class="muted">원본 화소 상관은 쓰지 않습니다: EM gain 프레임은 산탄잡음이 지배해 같은 자리끼리도 r ≈ 0.07 입니다.</span></div>`;
  if (!targets.length) {
    el.innerHTML = intro + `<div class="s muted">같은 크기(${st.d.ny}×${st.d.nx})의 다른 이미지 파일이 열려 있지 않습니다.</div>`;
    return;
  }
  el.innerHTML = intro + `
  <div class="flex small" style="margin-bottom:6px;flex-wrap:wrap;">
    <label class="ctl"><span>대상 파일</span><select id="cmp-sel" multiple size="${Math.min(6, targets.length)}" style="min-width:320px">
      ${targets.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join("")}</select></label>
    <label class="ctl"><span>최대 이동 (px)</span><input id="cmp-max" type="number" step="8" value="64" style="width:90px"></label>
    <span class="right"><button id="cmp-run" class="small">정합 및 ROI 전이</button></span>
  </div>
  <div id="cmp-out"></div>` + (st.compare ? "" : "");
  $("#cmp-run").addEventListener("click", () => imgRunCompare(rec));
  if (st.compare) $("#cmp-out").innerHTML = st.compare;
}
function imgRunCompare(rec) {
  const st = imgState(rec), d = st.d;
  if (!st.rois.length) { toast("먼저 ROI 를 검출하십시오"); return; }
  const sel = Array.from($("#cmp-sel").selectedOptions).map((o) => o.value);
  if (!sel.length) { toast("대상 파일을 고르십시오"); return; }
  const maxShift = Number($("#cmp-max").value) || 64;
  const base = imgBasisImage(rec);
  $("#cmp-out").innerHTML = `<div class="s muted">정합 중… (파일당 1–2초)</div>`;
  setTimeout(() => {
    const out = [];
    const baseBlank = PrismImg.blankNoise(base, d.nx, d.ny, st.rois, st.photOpt).sigma;
    const basePh = PrismImg.photometry(base, d.nx, d.ny, st.rois, st.photOpt);
    const cols = [];
    for (const id of sel) {
      const t = App.files.find((f) => f.id === id);
      if (!t) continue;
      let tImg = null;
      try {
        const tdet = t.det.imaging;
        if (tdet.kind === "stack") {
          let acc = null;
          for (let i = 0; i < tdet.n; i++) acc = PrismImg.accSum(acc, PrismH5.readImageFrame(t.h5, tdet, i));
          PrismImg.scaleInPlace(acc, 1 / tdet.n); tImg = acc;
        } else tImg = PrismH5.readImageFrame(t.h5, tdet, 0);
      } catch (e) { tImg = null; }
      if (!tImg) { out.push(`<div class="s">${esc(t.name)} — 읽기 실패</div>`); continue; }
      const reg = PrismImg.registerShift(base, tImg, d.nx, d.ny, { maxShift, roisA: st.rois });
      const bn = PrismImg.blankNoise(tImg, d.nx, d.ny, [], st.photOpt).sigma;
      const tr = PrismImg.transferRois(st.rois, reg, tImg, d.nx, d.ny, Object.assign({ sigmaBlank: bn }, st.photOpt));
      cols.push({ name: t.name, reg, tr, bn });
      const nDet = tr.filter((x) => x.detected === true).length;
      const nOut = tr.filter((x) => !x.inside).length;
      out.push(`<div class="s" style="margin-top:8px;"><b>${esc(t.name)}</b> —
        이동량 <span class="mono">(${reg.dx}, ${reg.dy}) px</span> ·
        상관 봉우리 ${fmt(reg.peak, 4)} <span class="muted">(무관한 이동에서 ${fmt(reg.nullLevel, 4)})</span> ·
        PSR ${fmt(reg.psr, 3)}σ
        ${reg.ok ? "" : `<br><span class="tag-Low">${esc(reg.why)}</span>`}
        <br>현재 ROI ${st.rois.length}개 중 <b>대응 검출 ${nDet}개</b>${nOut ? ` · 화면 밖 ${nOut}개` : ""}
        <span class="muted">(σ_blank ${fmt(bn, 3)}, 문턱 3σ)</span></div>`);
      if (reg.ok && nDet <= Math.max(1, Math.floor(st.rois.length * 0.2)))
        out.push(`<div class="s muted">이동량은 정해졌지만 <b>넘어온 입자가 거의 없습니다</b> —
          같은 영역을 다시 찍었다기보다 스테이지가 옮겨 가 대체로 다른 입자를 보고 있다는 뜻입니다.
          이 조합으로 "시간에 따른 변화"를 논하면 안 됩니다.</div>`);
    }
    if (cols.length) {
      const head = `<tr><th>#</th><th>x, y (기준)</th><th>기준 flux</th>${cols.map((c) => `<th>${esc(c.name.slice(0, 22))}</th>`).join("")}</tr>`;
      const rows = st.rois.map((p, i) => `<tr><td>${i}</td>
        <td class="mono">${fmt(p.xc != null ? p.xc : p.x, 5)}, ${fmt(p.yc != null ? p.yc : p.y, 5)}</td>
        <td class="mono">${fmt(basePh[i].sum, 5)}</td>
        ${cols.map((c) => {
          const x = c.tr[i];
          if (!x.inside) return `<td class="muted">화면 밖</td>`;
          const cls = x.detected ? "" : ' class="muted"';
          return `<td${cls}><span class="mono">${fmt(x.sum, 5)}</span>${x.detected ? "" : " <span class=\"muted\">(미검출)</span>"}</td>`;
        }).join("")}</tr>`).join("");
      out.push(`<table class="res" style="margin-top:8px;"><thead>${head}</thead><tbody>${rows}</tbody></table>
        <div class="s muted">기준 flux 는 현재 파일의 ${esc({ mean: "mean projection", max: "max projection", frame: "현재 프레임" }[st.basis])} 기준입니다.
          "미검출" 은 그 자리의 flux 가 그 파일의 3σ_blank 에 못 미친다는 뜻이며, 입자가 없어졌다는 판정이 아닙니다.</div>
        <div class="flex small" style="margin-top:6px;"><span class="right"><button id="cmp-csv" class="small">CSV</button></span></div>`);
      st._cmpCols = cols; st._cmpBase = basePh;
    }
    st.compare = out.join("");
    $("#cmp-out").innerHTML = st.compare;
    const cb = $("#cmp-csv");
    if (cb) cb.addEventListener("click", () => {
      const rows = [["roi", "x", "y", "base_flux"].concat(cols.map((c) => c.name), cols.map((c) => c.name + "_detected"))];
      st.rois.forEach((p, i) => rows.push([i, fmt(p.xc != null ? p.xc : p.x, 6), fmt(p.yc != null ? p.yc : p.y, 6), basePh[i].sum]
        .concat(cols.map((c) => c.tr[i].sum), cols.map((c) => String(c.tr[i].detected)))));
      downloadText(rec.name.replace(/\.h5$/i, "") + "_cross_file.csv", rowsToCsv(rows), "text/csv");
    });
  }, 30);
}

/* ------------------------------ selectivity -------------------------------- */
/** 변조 깊이 + 공간 선택성. 초점 빔으로 한 입자만 조작하는 실험의 핵심 지표다. */
function imgSelectivityHtml(rec) {
  const st = imgState(rec), d = st.d;
  const intro = `<div class="s muted" style="margin-bottom:6px;">
    초점 빔을 한 입자에 겨냥하는 측정이라면 <b>표적만 반응하고 이웃은 가만히 있어야</b> 합니다.
    반응하지 않은 <b>가장 가까운 이웃까지의 거리</b>가 그 빔의 유효 반경 상한이고,
    깊이가 거리에 따라 완만히 줄면 빔이 샜거나 초점이 넓다는 뜻입니다.
    거리는 화소 단위입니다 — µm/px 환산이 파일에 없으므로 여기서 지어내지 않습니다.</div>`;
  if (!st.traces || st.traces.length < 2) return intro + `<div class="s muted">ROI 가 2개 이상 필요합니다.</div>`;
  const dep = PrismImg.modulationDepth(st.traces, st.blank);
  if (st.target == null) {
    const sug = PrismImg.suggestTarget(dep);
    st.target = sug ? sug.index : 0;
    st.targetAuto = true;
  }
  const sel = PrismImg.selectivity(st.rois, dep, st.target);
  if (!sel.ok) return intro + `<div class="s muted">${esc(sel.why)}</div>`;
  const depTxt = (r) => (isFinite(r.depth) ? `${r.isLowerBound ? "≥" : ""}${fmt(r.depth, 3)}` : "–");
  const t = sel.target;
  const head = `<div class="flex small" style="margin-bottom:6px;align-items:flex-end;">
    <label class="ctl"><span>표적 ROI</span><select id="sel-target">
      ${st.rois.map((p, i) => `<option value="${i}"${i === st.target ? " selected" : ""}>#${i} (${Math.round(p.xc != null ? p.xc : p.x)}, ${Math.round(p.yc != null ? p.yc : p.y)})</option>`).join("")}
    </select></label>
    <label class="ctl"><span>'반응 없음' 기준 (배)</span><input id="sel-quiet" type="number" step="0.5" value="${sel.quietMax}" style="width:90px"></label>
    <span class="muted">${st.targetAuto ? "변조가 가장 큰 ROI 를 자동 제안했습니다 — 실제 겨냥 위치를 아시면 바꾸십시오." : ""}</span>
  </div>`;
  const verdict = isFinite(sel.ratioToOthers) && sel.ratioToOthers > 3
    ? `<div class="s"><b class="tag-High">표적만 반응했습니다</b> — 표적 변조 <b>${depTxt(t)}배</b>,
        나머지 ${sel.nOthers}개 중 최대 ${fmt(sel.maxOtherDepth, 3)}배 (<b>${fmt(sel.ratioToOthers, 3)}배</b> 차이).</div>`
    : `<div class="s"><b class="tag-Low">표적이 특별히 두드러지지 않습니다</b> — 표적 ${depTxt(t)}배 vs
        나머지 최대 ${fmt(sel.maxOtherDepth, 3)}배. 표적 지정이 틀렸거나, 조작이 국소적이지 않았거나,
        전체가 함께 변한 상황입니다(위 공통모드 패널을 함께 보십시오).</div>`;
  const bound = sel.nearestQuiet
    ? `<div class="s">반응하지 않은 가장 가까운 이웃: <b>#${sel.nearestQuiet.roi}</b>,
        거리 <b>${fmt(sel.nearestQuiet.dist, 4)} px</b> (변조 ${depTxt(sel.nearestQuiet)}배)
        → <b>조작의 유효 반경은 이보다 작습니다.</b>
        ${sel.nearestLoud ? `<span class="muted">단, 더 가까운 곳에 반응한 이웃 #${sel.nearestLoud.roi}(${fmt(sel.nearestLoud.dist, 4)} px)이 있으므로 상한으로만 읽으십시오.</span>` : ""}</div>`
    : `<div class="s muted">${sel.nOthers ? "기준 이하로 잠잠한 이웃이 없습니다 — 유효 반경 상한을 정할 수 없습니다." : "비교할 이웃이 없습니다."}</div>`;
  const trend = sel.trend
    ? `<div class="s ${sel.trend.graded ? "" : "muted"}">거리 추세: 가까운 절반 중앙값 ${fmt(sel.trend.near, 3)}배 ·
        먼 절반 ${fmt(sel.trend.far, 3)}배 (경계 ${fmt(sel.trend.splitAt, 4)} px)
        — ${sel.trend.graded ? "<b>가까울수록 크게 반응합니다. 조작이 표적에만 국한되지 않았을 수 있습니다.</b>" : "거리에 따른 경향이 뚜렷하지 않습니다."}</div>`
    : "";
  const rows = sel.rows.map((r) => `<tr${r.isTarget ? ' style="background:rgba(255,176,32,.10)"' : ""}>
    <td>${r.isTarget ? "<b>표적</b> " : ""}#${r.roi}</td>
    <td class="mono">${fmt(r.dist, 4)}</td>
    <td class="mono">${depTxt(r)}</td>
    <td class="mono">${fmt(st.traces[r.roi][dep[r.roi].kMax], 5)}</td>
    <td class="mono">${fmt(st.traces[r.roi][dep[r.roi].kMin], 5)}</td>
    <td class="muted">${r.isLowerBound ? "최저값이 잡음 아래 — 깊이는 하한" : ""}</td></tr>`).join("");
  return intro + head + verdict + bound + trend + `
  <table class="res" style="margin-top:8px;"><thead><tr><th>ROI</th><th>표적까지 (px)</th><th>변조 깊이</th>
    <th>최대</th><th>최소</th><th></th></tr></thead><tbody>${rows}</tbody></table>
  <div class="flex small" style="margin-top:6px;"><span class="right"><button id="sel-csv" class="small">CSV</button></span></div>`;
}
function imgBindSelectivity(rec) {
  const st = imgState(rec);
  const t = $("#sel-target");
  if (t) t.addEventListener("change", (e) => {
    st.target = Number(e.target.value); st.targetAuto = false;
    $("#sel-body").innerHTML = imgSelectivityHtml(rec); imgBindSelectivity(rec); imgDrawOverlay(rec);
  });
  const q = $("#sel-quiet");
  if (q) q.addEventListener("change", (e) => {
    st.quietMax = Number(e.target.value);
    $("#sel-body").innerHTML = imgSelectivityHtml(rec); imgBindSelectivity(rec);
  });
  const c = $("#sel-csv");
  if (c) c.addEventListener("click", () => {
    const dep = PrismImg.modulationDepth(st.traces, st.blank);
    const sel = PrismImg.selectivity(st.rois, dep, st.target, { quietMax: st.quietMax });
    const rows = [["roi", "x", "y", "dist_from_target_px", "is_target", "depth", "depth_is_lower_bound", "max_flux", "min_flux"]];
    sel.rows.forEach((r) => {
      const p = st.rois[r.roi];
      rows.push([r.roi, fmt(p.xc != null ? p.xc : p.x, 6), fmt(p.yc != null ? p.yc : p.y, 6),
        fmt(r.dist, 5), r.isTarget, r.depth, r.isLowerBound,
        st.traces[r.roi][dep[r.roi].kMax], st.traces[r.roi][dep[r.roi].kMin]]);
    });
    downloadText(rec.name.replace(/\.h5$/i, "") + "_selectivity.csv", rowsToCsv(rows), "text/csv");
  });
}

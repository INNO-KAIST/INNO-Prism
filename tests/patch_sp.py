#!/usr/bin/env python3
"""INNO Prism v3.21 — widefield 단일입자 판별 패널. 사용: python3 patch_sp.py <src>"""
import sys, pathlib
SRC = pathlib.Path(sys.argv[1])
def sub(t, a, b, name):
    n = t.count(a)
    if n != 1: raise SystemExit(f"[{name}] 앵커 {n}회")
    return t.replace(a, b, 1)

p = SRC / "app.js"
a = p.read_text(encoding="utf-8")

a = sub(a, '''    <div id="det-table" style="margin-top:6px;"></div>
  </div>
''', '''    <div id="det-table" style="margin-top:6px;"></div>
  </div>

  <div class="panel"><h3>단일입자 판별 <span class="muted small">밝기 정수배 + PSF 대칭 — Krajnik et al., Opt. Mater. 176 (2026) 118085</span></h3>
    <div class="flex small" style="margin-bottom:6px;flex-wrap:wrap;">
      <label class="ctl" title="PSF 비대칭 상한 ε = (σ장−σ단)/(σ장+σ단). 논문 기준 0.1"><span>ε 상한</span><input id="sp-eps" type="number" step="0.01" min="0.01" value="${st.spOpt.epsMax}" style="width:70px"></label>
      <label class="ctl" title="밝기 혼합모형에서 n=1(단일) 사후확률 하한"><span>P(n=1) 하한</span><input id="sp-p1" type="number" step="0.05" min="0.5" max="0.999" value="${st.spOpt.p1Min}" style="width:76px"></label>
      <label class="ctl" title="2D Gaussian 피팅 창 반경 (px). PSF σ 의 약 3배"><span>피팅 반경 (px)</span><input id="sp-R" type="number" step="1" min="3" value="${st.spOpt.R}" style="width:70px"></label>
      <label class="ctl" title="밝기 혼합모형에서 고려할 최대 응집 수 (BIC 로 선택)"><span>최대 응집 수</span><input id="sp-K" type="number" step="1" min="1" max="6" value="${st.spOpt.Kmax}" style="width:70px"></label>
      <label class="ctl" title="선택 — 이론 PSF 폭(0.51λ/NA) 비교용"><span>λ_em (nm)</span><input id="sp-lam" type="number" step="1" placeholder="선택" value="${st.spOpt.lambda || ""}" style="width:76px"></label>
      <label class="ctl" title="선택 — 대물렌즈 개구수"><span>NA</span><input id="sp-na" type="number" step="0.01" placeholder="선택" value="${st.spOpt.NA || ""}" style="width:64px"></label>
      <span class="right flex"><button id="sp-run" class="small">판별</button>
        <button id="sp-keep" class="small" title="'단일'로 판정된 ROI 만 남기고 나머지는 지웁니다">단일만 ROI 로 남기기</button>
        <button id="sp-csv" class="small">CSV</button></span>
    </div>
    <div id="sp-summary" class="s"></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:6px;">
      <div id="chart-sp-hist" class="chart" style="height:300px;"></div>
      <div id="chart-sp-scat" class="chart" style="height:300px;"></div>
    </div>
    <div id="sp-table" style="margin-top:6px;"></div>
  </div>
''', "panel")

a = sub(a, '''  imgBindImage(rec);
  imgBindDetect(rec);''', '''  imgBindImage(rec);
  imgBindDetect(rec);
  imgBindSingles(rec);''', "bind call")

# 상태 기본값 (renderImaging 이 st 를 만든 직후)
a = sub(a, '''function renderImaging(rec) {
  const st = imgState(rec);''', '''function renderImaging(rec) {
  const st = imgState(rec);
  if (!st.spOpt) st.spOpt = { epsMax: 0.10, p1Min: 0.90, R: 5, Kmax: 4, lambda: null, NA: null };''', "spOpt")

a = sub(a, '''  st.traces = null; st.blank = null; st.cm = null; st.evidence = null; st.compare = null;''',
'''  st.traces = null; st.blank = null; st.cm = null; st.evidence = null; st.compare = null;
  st.sp = null;   // v3.21 — ROI 집합이 바뀌면 단일입자 판별도 다시''', "invalidate")

a = sub(a, '''  imgFillCompare(rec);
  imgDrawOverlay(rec);
}''', '''  imgFillCompare(rec);
  imgRenderSingles(rec);
  imgDrawOverlay(rec);
}''', "refresh")

a = sub(a, '''  const verd = st.cm && st.cm.ok ? st.cm.flags : null;
  const color = (i) => {
    if (!verd) return "#8fd0ff";''', '''  const verd = st.cm && st.cm.ok ? st.cm.flags : null;
  const spc = st.sp && st.sp.results.length === st.rois.length ? st.sp.results : null;
  const color = (i) => {
    if (spc) return SP_CLASS[spc[i].cls].color;   // v3.21 — 단일입자 판별이 있으면 그 색
    if (!verd) return "#8fd0ff";''', "overlay color")

a = sub(a, '''/* --------------------------- analysis refresh ------------------------------ */''', r'''/* ---------------------- single-particle identification ---------------------- */
/** v3.21 — Krajnik et al. (2026) 이중 기준. 수치는 PrismImg.classifySingles. */
const SP_CLASS = {
  single: { label: "단일", color: "#43e08f", tag: "tag-High" },
  single_psf: { label: "단일 후보 (PSF만)", color: "#a6e3c0", tag: "tag-Moderate" },
  multi_bright: { label: "응집 (밝기)", color: "#ff5c7a", tag: "tag-Poor" },
  multi_shape: { label: "응집 (PSF 비대칭)", color: "#ff9f43", tag: "tag-Poor" },
  uncertain: { label: "판정 보류", color: "#9a998f", tag: "tag-Low" },
  rejected: { label: "피팅 실패", color: "#5a5a52", tag: "tag-Low" },
};
function imgRunSingles(rec) {
  const st = imgState(rec), d = st.d;
  if (!st.rois.length) { st.sp = null; return; }
  const base = imgBasisImage(rec);
  if (!base) return;
  st.sp = PrismImg.classifySingles(base, d.nx, d.ny, st.rois,
    { R: st.spOpt.R, epsMax: st.spOpt.epsMax, p1Min: st.spOpt.p1Min, Kmax: st.spOpt.Kmax });
  st.sp.basis = st.basis;
}
function imgBindSingles(rec) {
  const st = imgState(rec);
  const num = (id, key, ok) => { const e = $(id); if (e) e.addEventListener("change", () => {
    const v = e.value === "" ? null : Number(e.value);
    if (v === null || ok(v)) { st.spOpt[key] = v; st.sp = null; imgRenderSingles(rec); imgDrawOverlay(rec); } else e.value = st.spOpt[key] ?? ""; }); };
  num("#sp-eps", "epsMax", (v) => v > 0 && v < 1);
  num("#sp-p1", "p1Min", (v) => v >= 0.5 && v < 1);
  num("#sp-R", "R", (v) => v >= 3 && v <= 25);
  num("#sp-K", "Kmax", (v) => v >= 1 && v <= 6);
  num("#sp-lam", "lambda", (v) => v > 100 && v < 3000);
  num("#sp-na", "NA", (v) => v > 0.05 && v < 1.7);
  $("#sp-run").addEventListener("click", () => { st.sp = null; imgRenderSingles(rec); imgDrawOverlay(rec); });
  $("#sp-keep").addEventListener("click", () => {
    if (!st.sp) return;
    const keep = st.sp.results.filter((r) => r.cls === "single").map((r) => r.i);
    if (!keep.length) { toast("'단일'로 판정된 ROI 가 없습니다"); return; }
    st.rois = keep.map((i) => st.rois[i]);
    imgInvalidate(rec); imgRefreshAnalysis(rec);
    toast(`단일 ${keep.length}개만 남겼습니다`);
  });
  $("#sp-csv").addEventListener("click", () => imgSinglesCsv(rec));
}
function imgSinglesFwhm(st, s) {
  const px = 2.3548 * s;
  return st.umPerPx > 0 ? `${fmt(px, 3)} <span class="muted">(${fmt(px * st.umPerPx * 1000, 3)} nm)</span>` : fmt(px, 3);
}
function imgRenderSingles(rec) {
  const st = imgState(rec), d = st.d;
  const sumEl = $("#sp-summary");
  if (!sumEl) return;
  if (!st.rois.length) {
    sumEl.innerHTML = `<span class="muted">ROI 가 없습니다 — 먼저 입자를 검출하십시오.</span>`;
    $("#sp-table").innerHTML = ""; Plotly.purge($("#chart-sp-hist")); Plotly.purge($("#chart-sp-scat"));
    return;
  }
  if (!st.sp) imgRunSingles(rec);
  const S = st.sp; if (!S) return;
  const c = S.counts, mix = S.mix, R = S.results;
  const chip = (k) => `<span class="${SP_CLASS[k].tag}" style="border-left:4px solid ${SP_CLASS[k].color};padding-left:5px">${SP_CLASS[k].label} <b>${c[k]}</b></span>`;
  const basisTxt = { mean: "mean projection", max: "max projection", frame: `프레임 #${st.frame}` }[S.basis] || S.basis;
  const lines = [];
  lines.push(`<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:4px">${["single", "single_psf", "multi_bright", "multi_shape", "uncertain", "rejected"].filter((k) => c[k]).map(chip).join("")}
    <span class="muted">· ROI ${R.length}개 · 기준 이미지 ${esc(basisTxt)}${S.basis === "max" ? ' <span class="tag-Low">max projection 은 잡음 최대값이 더해져 밝기·폭이 치우칩니다 — mean 을 권장</span>' : ""}</span></div>`);
  if (mix.ok) {
    const weak = mix.dPrime < 2;
    lines.push(`<div><b>밝기 기준</b>: 정수배 혼합모형 K=${mix.K} (BIC) · 단일 μ₁ = <b>${fmt(mix.mu, 4)}</b> ± σ₁ ${fmt(mix.sigma, 3)} (CV ${fmt(mix.cv * 100, 3)}%) · n=${mix.N}
      · 단일↔이합체 분리도 d′ = ${fmt(mix.dPrime, 3)}${weak ? ` <span class="tag-Poor">겹침 큼</span> <span class="muted">단일입자 밝기 편차가 커서 이합체와 분포가 겹칩니다. 논문도 이질적 시료(크기·도핑 편차)에서 밝기 기준이 약해진다고 지적했습니다 — PSF 기준 비중이 커집니다.</span>` : ""}</div>`);
  } else {
    lines.push(`<div><b>밝기 기준</b>: <span class="tag-Low">적용 안 됨</span> <span class="muted">${esc(mix.why || "")} — 「입자(ROI) 검출」의 <b>최대 개수</b>를 늘리십시오. 논문은 희석 단계마다 250개 이상을 분석했습니다.</span></div>`);
  }
  const wpx = 2.3548 * S.widthRef;
  let wTxt = `<b>PSF</b>: 대칭 점의 FWHM 중앙값 ${fmt(wpx, 3)} px`;
  if (st.umPerPx > 0) {
    const nm = wpx * st.umPerPx * 1000;
    wTxt += ` = ${fmt(nm, 3)} nm`;
    if (st.spOpt.lambda > 0 && st.spOpt.NA > 0) {
      const th = 0.51 * st.spOpt.lambda / st.spOpt.NA;
      wTxt += ` · 이론 회절한계 0.51λ/NA = ${fmt(th, 3)} nm → <b>${fmt(nm / th, 3)}×</b>` +
        (nm / th > 1.5 ? ` <span class="tag-Low">넓음 — 초점·수차·µm/px 를 확인하십시오</span>` : "");
    }
  } else wTxt += ` <span class="muted">(µm/px 를 입력하면 nm 로도 표시)</span>`;
  wTxt += ` · ε 상한 ${fmt(S.params.epsMax, 3)} — ε 는 회전 Gaussian 의 <b>주축</b>으로 잽니다(가로·세로로 재면 45° 방향 이합체가 ε≈0 으로 통과합니다).`;
  lines.push(`<div>${wTxt}</div>`);
  if (isFinite(S.illumRho) && Math.abs(S.illumRho) >= 0.3) {
    lines.push(`<div><span class="tag-Poor">조명 불균일 의심</span> 밝기와 시야 중심 거리의 순위상관 ρ = ${fmt(S.illumRho, 3)}.
      밝기 기준은 "모든 단일입자가 같은 평균 밝기"를 전제합니다. widefield 여기광이 시야 안에서 균일하지 않으면 이 전제가 깨지고,
      <b>방출이 여기세기의 s 제곱으로 변하는 입자(PA 에서는 s ≫ 1)</b>에서는 작은 조명 차이도 밝기를 수 배 바꿉니다.
      이 경우 밝기 기준의 응집 판정은 신뢰하기 어렵고, 균일 조명 영역만 쓰거나 PSF 기준을 우선하십시오.</div>`);
  } else if (isFinite(S.illumRho)) {
    lines.push(`<div class="muted">밝기–시야 중심 거리 순위상관 ρ = ${fmt(S.illumRho, 3)} — 뚜렷한 조명 의존 없음. 단, 비선형(PA) 입자는 균일 조명 가정을 직접 확인하십시오.</div>`);
  }
  lines.push(`<div class="muted">판정 = <b>PSF 대칭(ε+2δ ≤ 상한) 그리고 밝기 P(n=1) ≥ ${fmt(S.params.p1Min, 2)}</b> 둘 다 통과.
    ε 의 불확도 δ 는 피팅 공분산에서 전파했고, 임계가 불확도 안에 있으면 보류합니다. 응집체의 밝기 폭은 독립 입자의 합이므로 √n·σ₁ 로 묶었습니다.
    논문의 보조 확인(SRRF)은 구현하지 않았습니다.</div>`);
  sumEl.innerHTML = lines.join("");
  // 히스토그램 + 혼합모형
  const okR = R.filter((r) => r.fit.ok && isFinite(r.flux));
  const fl = okR.map((r) => r.flux);
  const hEl = $("#chart-sp-hist"), sEl = $("#chart-sp-scat");
  if (fl.length) {
    const lo = 0, hi = Math.max(...fl) * 1.08;
    const nb = Math.max(12, Math.min(60, Math.round(Math.sqrt(fl.length) * 2)));
    const bw = (hi - lo) / nb;
    const traces = [];
    for (const k of Object.keys(SP_CLASS)) {
      const xs = okR.filter((r) => r.cls === k).map((r) => r.flux);
      if (!xs.length) continue;
      traces.push({ type: "histogram", x: xs, name: SP_CLASS[k].label, marker: { color: SP_CLASS[k].color, line: { width: 0 } },
        xbins: { start: lo, end: hi, size: bw }, opacity: 0.9 });
    }
    const shapes = [];
    if (mix.ok) {
      const xs = Array.from({ length: 300 }, (_, j) => lo + (hi - lo) * j / 299);
      const N = mix.N;
      let tot = xs.map(() => 0);
      for (let k = 0; k < mix.K; k++) {
        const m = (k + 1) * mix.mu, s = Math.sqrt(k + 1) * mix.sigma;
        const ys = xs.map((x) => N * bw * mix.w[k] * Math.exp(-0.5 * ((x - m) / s) ** 2) / (s * Math.sqrt(2 * Math.PI)));
        tot = tot.map((v, j) => v + ys[j]);
        traces.push({ x: xs, y: ys, mode: "lines", name: `n=${k + 1} (${fmt(mix.w[k] * 100, 2)}%)`, line: { width: 1.4, dash: "dot" } });
        shapes.push({ type: "line", xref: "x", yref: "paper", x0: m, x1: m, y0: 0, y1: 1, line: { color: "#8b8a80", width: 1, dash: "dash" } });
      }
      traces.push({ x: xs, y: tot, mode: "lines", name: "혼합모형 합", line: { color: "#e8ecff", width: 2 } });
    }
    newPlot(hEl, traces, {
      barmode: "stack",
      xaxis: Object.assign(baseLayout().xaxis, { title: { text: "적분 밝기 (2D Gaussian 부피, counts)" } }),
      yaxis: Object.assign(baseLayout().yaxis, { title: { text: "개수" } }),
      shapes, legend: { orientation: "h", y: 1.18, x: 0, font: { size: 10.5 } }, margin: { l: 52, r: 12, t: 46, b: 46 },
    });
    // 밝기 vs ε
    const st2 = [];
    for (const k of Object.keys(SP_CLASS)) {
      const rr = okR.filter((r) => r.cls === k);
      if (!rr.length) continue;
      st2.push({ x: rr.map((r) => r.flux), y: rr.map((r) => r.fit.eps), mode: "markers", type: "scatter", name: SP_CLASS[k].label,
        text: rr.map((r) => `#${r.i}`), marker: { color: SP_CLASS[k].color, size: 7, line: { width: 0.5, color: "#111" } },
        error_y: { type: "data", array: rr.map((r) => (isFinite(r.fit.epsErr) ? r.fit.epsErr : 0)), thickness: 0.8, width: 0, color: SP_CLASS[k].color },
        hovertemplate: "%{text}<br>밝기 %{x:.4g}<br>ε %{y:.3f}<extra></extra>" });
    }
    const sh2 = [{ type: "line", xref: "paper", yref: "y", x0: 0, x1: 1, y0: S.params.epsMax, y1: S.params.epsMax, line: { color: "#ff9f43", width: 1.2, dash: "dash" } }];
    if (mix.ok) for (let k = 1; k <= mix.K; k++) sh2.push({ type: "line", xref: "x", yref: "paper", x0: k * mix.mu, x1: k * mix.mu, y0: 0, y1: 1, line: { color: "#8b8a80", width: 1, dash: "dot" } });
    newPlot(sEl, st2, {
      xaxis: Object.assign(baseLayout().xaxis, { title: { text: "적분 밝기 (counts)" } }),
      yaxis: Object.assign(baseLayout().yaxis, { title: { text: "PSF 비대칭 ε (주축)" }, rangemode: "tozero" }),
      shapes: sh2, showlegend: false, margin: { l: 56, r: 12, t: 20, b: 46 },
    });
  } else { Plotly.purge(hEl); Plotly.purge(sEl); }
  // 표
  const rows = R.map((r) => {
    const f = r.fit, k = SP_CLASS[r.cls];
    return `<tr>
      <td>${r.i}</td><td><span class="${k.tag}" style="border-left:4px solid ${k.color};padding-left:4px">${k.label}</span></td>
      <td class="mono">${r.n != null ? r.n : "–"}</td>
      <td class="mono">${isFinite(r.p1) ? fmt(r.p1, 3) : "–"}</td>
      <td class="mono">${f.ok ? fmt(r.flux, 4) : "–"}</td>
      <td class="mono">${f.ok ? imgSinglesFwhm(st, f.sMaj) + " / " + imgSinglesFwhm(st, f.sMin) : "–"}</td>
      <td class="mono">${f.ok ? fmt(f.theta * 180 / Math.PI, 3) : "–"}</td>
      <td class="mono">${f.ok ? `${fmt(f.eps, 3)} ± ${isFinite(f.epsErr) ? fmt(f.epsErr, 2) : "?"}` : "–"}</td>
      <td class="mono">${f.ok ? fmt(f.epsLab, 3) : "–"}</td>
      <td class="mono">${f.ok ? fmt(f.snr, 3) : "–"}</td>
      <td class="small">${r.why.map(esc).join(" · ")}</td></tr>`;
  }).join("");
  $("#sp-table").innerHTML = `<details${R.length <= 40 ? " open" : ""}><summary class="small muted">ROI 별 결과 ${R.length}개</summary>
    <table class="res"><thead><tr><th>#</th><th>판정</th><th>n̂</th><th>P(n=1)</th><th>밝기</th><th>FWHM 장/단 (px)</th><th>θ (°)</th><th>ε ± δ (주축)</th><th>ε (가로·세로)</th><th>SNR</th><th>사유</th></tr></thead>
    <tbody>${rows}</tbody></table></details>`;
}
function imgSinglesCsv(rec) {
  const st = imgState(rec);
  if (!st.sp) return;
  const S = st.sp;
  const head = ["roi", "x_px", "y_px", "class", "n_hat", "p_single", "flux", "fwhm_major_px", "fwhm_minor_px", "theta_deg", "eps_principal", "eps_err", "eps_lab_axes", "snr", "nearest_px", "reasons"];
  if (st.umPerPx > 0) head.splice(9, 0, "fwhm_major_nm", "fwhm_minor_nm");
  const rows = [head];
  for (const r of S.results) {
    const f = r.fit, p = st.rois[r.i];
    const row = [r.i, f.ok ? f.x0 : (p.xc ?? p.x), f.ok ? f.y0 : (p.yc ?? p.y), r.cls, r.n ?? "", isFinite(r.p1) ? r.p1 : "",
      f.ok ? r.flux : "", f.ok ? 2.3548 * f.sMaj : "", f.ok ? 2.3548 * f.sMin : ""];
    if (st.umPerPx > 0) row.push(f.ok ? 2.3548 * f.sMaj * st.umPerPx * 1000 : "", f.ok ? 2.3548 * f.sMin * st.umPerPx * 1000 : "");
    row.push(f.ok ? f.theta * 180 / Math.PI : "", f.ok ? f.eps : "", f.ok && isFinite(f.epsErr) ? f.epsErr : "", f.ok ? f.epsLab : "", f.ok ? f.snr : "",
      isFinite(r.near) ? r.near : "", r.why.join(" | "));
    rows.push(row);
  }
  const meta = S.mix.ok ? `# mixture K=${S.mix.K} mu1=${S.mix.mu} sigma1=${S.mix.sigma} cv=${S.mix.cv} dprime=${S.mix.dPrime}` : `# mixture not applied: ${S.mix.why}`;
  downloadText(rec.name.replace(/\.h5$/i, "") + "_single_particle.csv",
    `# INNO Prism single-particle identification (Krajnik et al., Opt. Mater. 176 (2026) 118085) · eps_max=${S.params.epsMax} p1_min=${S.params.p1Min} R=${S.params.R}\n${meta}\n` + rowsToCsv(rows), "text/csv");
}

/* --------------------------- analysis refresh ------------------------------ */''', "sp code")
p.write_text(a, encoding="utf-8")
print("app.js patched")

p = SRC / "build.py"
b = p.read_text(encoding="utf-8")
b = sub(b, 'VERSION = "3.20.0"', 'VERSION = "3.21.0"', "VERSION")
p.write_text(b, encoding="utf-8")
print("build.py patched")

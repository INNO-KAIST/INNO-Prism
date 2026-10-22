/* INNO Prism — 보고서용 그림 내보내기 + 스케일바 (v3.19)
 *
 * 왜 따로 두는가
 *   이전에는 Plotly 모드바의 카메라 버튼이 **화면에 보이는 크기 그대로** PNG 를 떴다.
 *   그래서 창 크기·브라우저 배율·사이드바 접힘에 따라 매번 가로세로비와 글자 크기가 달라졌고,
 *   색도 어두운 화면용(검은 배경·회색 글자)이라 슬라이드에 붙이면 정제되지 않은 캡쳐처럼 보였다.
 *
 * 원칙
 *   1. **판형 고정.** 그림은 화면과 무관하게 논리 크기(그래프 1200×750, 맵·이미지 750×750)로 다시
 *      그리고, 해상도 배수(기본 2×)만 곱한다. 모든 판형의 높이를 750 으로 맞추어 서로 다른 그림을
 *      나란히 놓아도 글자 크기와 높이가 일치한다.
 *   2. **데이터는 건드리지 않는다.** 색·글꼴·축선만 바꾼다. 사용자가 확대해 둔 축 범위는 그대로
 *      따른다(보이는 것이 저장된다).
 *   3. **스케일바는 단위가 확인될 때만** 그린다. µm 단위 축(스테이지 좌표)이나 보정된 µm/px 가
 *      있을 때만 만들고, 출처(스테이지 좌표 / 공칭 / 실측 / 사용자 입력)를 캡션에 남긴다.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PrismReport = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const FONT = "Arial, 'Helvetica Neue', Helvetica, 'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif";
  /** 논리 판형. 높이는 모두 750 — 서로 다른 그림을 나란히 놓아도 글자 크기가 같다. */
  const PRESETS = {
    wide: { label: "16:10 · 그래프", w: 1200, h: 750 },
    std: { label: "4:3", w: 1000, h: 750 },
    square: { label: "1:1 · 맵·이미지", w: 750, h: 750 },
  };
  const THEMES = {
    light: { bg: "#ffffff", ink: "#1b1b19", sub: "#6b6a64", rule: "#e4e3de", axis: "#2a2a27", grid: "#ececea", zero: "#c9c8c2" },
    dark: { bg: "#1a1a19", ink: "#f4f4f0", sub: "#8b8a80", rule: "#2b2b28", axis: "#6b6a62", grid: "#2b2b28", zero: "#3a3a36" },
  };
  const HEADER_H = 64, FOOTER_H = 30, PAD_X = 28;
  const KEEP = /^prism-keep/; // 이 이름의 shape·annotation 은 재색칠하지 않는다 (스케일바 등)

  /* ------------------------------ preferences ------------------------------ */
  const PREF_KEY = "innoPrismReport1";
  const DEFAULT_PREFS = { theme: "light", caption: true, scale: 2, hideAxesMap: true, preset: { graph: "wide", map: "square", image: "square" }, titles: {} };
  function loadPrefs() {
    try {
      const p = JSON.parse(localStorage.getItem(PREF_KEY) || "null");
      if (p && typeof p === "object") return Object.assign({}, DEFAULT_PREFS, p, { preset: Object.assign({}, DEFAULT_PREFS.preset, p.preset || {}), titles: Object.assign({}, p.titles || {}) });
    } catch (e) { /* 저장소 차단 — 기본값 */ }
    return JSON.parse(JSON.stringify(DEFAULT_PREFS));
  }
  function savePrefs(p) { try { localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch (e) { /* 무시 */ } }

  /* --------------------------------- color --------------------------------- */
  const NAMED = { white: [255, 255, 255, 1], black: [0, 0, 0, 1], transparent: [0, 0, 0, 0] };
  function parseColor(s) {
    if (typeof s !== "string") return null;
    const t = s.trim().toLowerCase();
    if (NAMED[t]) return NAMED[t].slice();
    let m = /^#([0-9a-f]{3})$/.exec(t);
    if (m) return [...m[1]].map((c) => parseInt(c + c, 16)).concat(1);
    m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(t);
    if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)).concat(m[2] ? parseInt(m[2], 16) / 255 : 1);
    m = /^rgba?\(([^)]+)\)$/.exec(t);
    if (m) {
      const p = m[1].split(",").map((x) => parseFloat(x));
      if (p.length >= 3 && p.slice(0, 3).every(isFinite)) return [p[0], p[1], p[2], p.length > 3 && isFinite(p[3]) ? p[3] : 1];
    }
    return null;
  }
  function rgb2hsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
    if (mx === mn) return [0, 0, l];
    const d = mx - mn, s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    let h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h / 6, s, l];
  }
  function hsl2rgb(h, s, l) {
    if (s === 0) return [l, l, l].map((v) => Math.round(v * 255));
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    const f = (t) => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
    return [f(h + 1 / 3), f(h), f(h - 1 / 3)].map((v) => Math.round(v * 255));
  }
  /** 어두운 화면용 색 → 흰 바탕용 색.
   *  무채색(배경·글자·격자)은 명도를 뒤집고, 흰 바탕에서 안 보일 만큼 밝은 유채색만 명도를 낮춘다.
   *  데이터 계열색(중간 명도)은 그대로 둔다 — 화면과 그림의 계열색이 같아야 헷갈리지 않는다. */
  function toLight(s) {
    const c = parseColor(s);
    if (!c) return s;
    const [r, g, b, a] = c;
    const [h, sat, l] = rgb2hsl(r, g, b);
    const chroma = (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
    let out;
    if (sat < 0.18 || chroma < 0.08) {
      const L = Math.max(0, Math.min(1, 1.06 - l));
      out = hsl2rgb(0, 0, L);
    } else if (l > 0.64) {
      out = hsl2rgb(h, Math.min(1, sat), 0.46);
    } else return s;
    return a >= 0.999 ? `rgb(${out.join(",")})` : `rgba(${out.join(",")},${+a.toFixed(3)})`;
  }
  const COLOR_KEY = /color$/i;
  const SKIP_KEY = new Set(["colorscale", "z", "x", "y", "customdata", "text", "hovertext", "ids", "_input"]);
  function recolorTree(o, fn) {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) { for (const v of o) if (v && typeof v === "object") recolorTree(v, fn); return; }
    if (typeof o.name === "string" && KEEP.test(o.name)) return;
    for (const k of Object.keys(o)) {
      if (SKIP_KEY.has(k)) continue;
      const v = o[k];
      if (COLOR_KEY.test(k)) {
        if (typeof v === "string") o[k] = fn(v);
        else if (Array.isArray(v)) o[k] = v.map((x) => (typeof x === "string" ? fn(x) : x));
      } else if (v && typeof v === "object" && !ArrayBuffer.isView(v)) recolorTree(v, fn);
    }
  }
  /** 수치 배열(typed array, 숫자 배열)은 참조로 두고 객체만 복제한다 — 맵 z 를 통째로 복사하지 않는다. */
  function cloneFig(v) {
    if (v === null || typeof v !== "object") return v;
    if (ArrayBuffer.isView(v)) return v;
    if (Array.isArray(v)) {
      if (!v.some((x) => x && typeof x === "object" && !ArrayBuffer.isView(x) && !Array.isArray(x))) {
        // 숫자/문자 배열, 또는 배열의 배열(heatmap z) — 문자열 배열만 얕은 복사
        return v.some((x) => typeof x === "string") ? v.slice() : v;
      }
      return v.map(cloneFig);
    }
    const o = {};
    for (const k of Object.keys(v)) { if (k[0] === "_") continue; o[k] = cloneFig(v[k]); }
    return o;
  }

  /* ------------------------------- scale bar ------------------------------- */
  /** 보이는 폭의 약 1/4 이하에서 가장 큰 1·2·5×10ⁿ 길이 (µm). */
  function niceLength(spanUm) {
    if (!(spanUm > 0)) return NaN;
    const t = spanUm * 0.26;
    const p = Math.pow(10, Math.floor(Math.log10(t)));
    for (const m of [5, 2, 1]) if (m * p <= t * (1 + 1e-9)) return m * p;
    return p;
  }
  function fmtLength(um) {
    if (um >= 1000) return `${+(um / 1000).toPrecision(3)} mm`;
    if (um >= 1) return `${+um.toPrecision(3)} µm`;
    return `${Math.round(um * 1000)} nm`;
  }
  /** Plotly 데이터 좌표계의 스케일바 (오른쪽 아래).
   *  ext = {x0,x1,y0,y1} 보이는 범위(데이터 단위), yReversed = 화면 위쪽이 작은 y 인가,
   *  umPerUnit = 데이터 1 단위의 µm. 흰 막대 + 어두운 테두리 — 밝은 컬러맵에서도 보인다. */
  function plotlyScaleBar(ext, opt) {
    const o = Object.assign({ umPerUnit: 1, yReversed: false, fontSize: 13 }, opt || {});
    const xa = Math.min(ext.x0, ext.x1), xb = Math.max(ext.x0, ext.x1);
    const ya = Math.min(ext.y0, ext.y1), yb = Math.max(ext.y0, ext.y1);
    const w = xb - xa, h = yb - ya;
    if (!(w > 0 && h > 0 && o.umPerUnit > 0)) return null;
    const Lum = niceLength(w * o.umPerUnit);
    const L = Lum / o.umPerUnit;
    const right = xb - 0.06 * w, left = right - L;
    const t = Math.max(0.016 * h, 0.012 * w);
    const base = o.yReversed ? yb - 0.07 * h : ya + 0.07 * h;
    const top = o.yReversed ? base - t : base + t;
    return {
      lengthUm: Lum, label: fmtLength(Lum),
      shapes: [{ type: "rect", name: "prism-keep-scalebar", xref: "x", yref: "y", layer: "above",
        x0: left, x1: right, y0: Math.min(base, top), y1: Math.max(base, top),
        fillcolor: "#ffffff", line: { color: "rgba(0,0,0,0.55)", width: 1 } }],
      annotations: [{ name: "prism-keep-scalebar", xref: "x", yref: "y", x: (left + right) / 2, y: o.yReversed ? Math.min(base, top) : Math.max(base, top),
        yanchor: "bottom", yshift: 4, showarrow: false, text: `<b>${fmtLength(Lum)}</b>`,
        font: { color: "#ffffff", size: o.fontSize, family: FONT, shadow: "0px 0px 3px rgba(0,0,0,0.85)" } }],
    };
  }
  function stripScaleBar(layout) {
    const keep = (a) => !(a && typeof a.name === "string" && a.name === "prism-keep-scalebar");
    if (Array.isArray(layout.shapes)) layout.shapes = layout.shapes.filter(keep);
    if (Array.isArray(layout.annotations)) layout.annotations = layout.annotations.filter(keep);
  }
  /** 스케일바를 놓을 범위.
   *  확대하지 않았으면 **자료 범위**(heatmap 가장자리)를 쓴다 — scaleanchor 로 정사각 픽셀을 맞추면
   *  Plotly 가 화면 비율에 따라 축 범위를 자료 밖으로 늘리는데, 그 범위를 쓰면 막대가 맵 밖에 놓인다.
   *  확대했으면(autorange=false) 보이는 범위를 쓴다. */
  function dataExtent(gd) {
    const t = (gd.data || []).find((d) => d && d.type === "heatmap" && d.z);
    if (!t) return null;
    const ny = t.z.length, nx = ny ? t.z[0].length : 0;
    const edges = (arr, n) => {
      if (!arr || arr.length < 1) return [-0.5, n - 0.5];
      const a = Array.from(arr, Number).filter(isFinite);
      if (!a.length) return null;
      const lo = Math.min(...a), hi = Math.max(...a);
      const step = a.length > 1 ? (hi - lo) / (a.length - 1) : 1;
      return [lo - step / 2, hi + step / 2];
    };
    const ex = edges(t.x, nx), ey = edges(t.y, ny);
    if (!ex || !ey) return null;
    return { x0: ex[0], x1: ex[1], y0: ey[0], y1: ey[1] };
  }
  function visibleExtent(gd) {
    const L = gd.layout || {}, fl = gd._fullLayout || {};
    const yRev = L.yaxis && L.yaxis.autorange === "reversed" ||
      !!(fl.yaxis && fl.yaxis.range && +fl.yaxis.range[0] > +fl.yaxis.range[1]);
    const zoomed = (L.xaxis && L.xaxis.autorange === false) || (L.yaxis && L.yaxis.autorange === false);
    if (!zoomed) {
      const d = dataExtent(gd);
      if (d) return Object.assign(d, { yReversed: yRev });
    }
    if (!fl.xaxis || !fl.yaxis || !fl.xaxis.range || !fl.yaxis.range) return null;
    const xr = fl.xaxis.range, yr = fl.yaxis.range;
    return { x0: +xr[0], x1: +xr[1], y0: +yr[0], y1: +yr[1], yReversed: +yr[0] > +yr[1] };
  }
  /** 살아 있는 Plotly 맵에 스케일바를 넣고, 확대·이동할 때마다 보이는 범위에 맞춰 다시 그린다. */
  function attachPlotlyScaleBar(gd, spec) {
    if (!gd) return;
    gd._prismScaleBar = spec || null;
    const apply = () => {
      const s = gd._prismScaleBar;
      const lay = { shapes: (gd.layout.shapes || []).slice(), annotations: (gd.layout.annotations || []).slice() };
      stripScaleBar(lay);
      if (s && s.on) {
        const ext = visibleExtent(gd);
        const sb = ext && plotlyScaleBar(ext, { umPerUnit: s.umPerUnit, yReversed: ext.yReversed });
        if (sb) { lay.shapes.push(...sb.shapes); lay.annotations.push(...sb.annotations); }
      }
      gd._prismSbBusy = true;
      return Promise.resolve(Plotly.relayout(gd, lay)).finally(() => { gd._prismSbBusy = false; });
    };
    // Plotly.newPlot 은 purge 로 리스너를 모두 지운다 — 매번 다시 건다 (중복 방지 위해 이전 것 제거)
    if (gd.on) {
      if (gd._prismSbHandler && gd.removeListener) gd.removeListener("plotly_relayout", gd._prismSbHandler);
      gd._prismSbHandler = (ev) => {
        if (gd._prismSbBusy || !ev) return;
        if (Object.keys(ev).some((k) => /^(x|y)axis\.(range|autorange)/.test(k) || k === "autosize")) apply();
      };
      gd.on("plotly_relayout", gd._prismSbHandler);
    }
    return apply();
  }

  /* ---------------------------- figure theming ----------------------------- */
  /** 맵은 판형 안에서 자료 범위에 꼭 맞게(여백 없는 정사각 픽셀). 확대 상태면 그 범위를 유지. */
  function mapFit(layout, live) {
    for (const k of ["xaxis", "yaxis"]) {
      const ax = layout[k] = layout[k] || {};
      ax.constrain = "domain";
      const la = live[k] || {};
      if (la.autorange !== false) {
        delete ax.range;
        ax.autorange = la.autorange === "reversed" ? "reversed" : true;
      }
    }
  }
  function themedFigure(gd, opt) {
    const th = THEMES[opt.theme] || THEMES.light;
    // 화면 조작용 표식(탐침 십자 등, meta = "prism-ui-only")은 보고서 그림에 넣지 않는다
    const data = (gd.data || []).filter((t) => !(t && t.meta === "prism-ui-only")).map(cloneFig);
    const layout = cloneFig(gd.layout || {});
    delete layout.width; delete layout.height; delete layout.title;
    layout.autosize = false;
    // 스케일바: 저장 시점의 보이는 범위로 다시 계산 (글자도 판형 기준 크기로)
    stripScaleBar(layout);
    const sbSpec = gd._prismScaleBar;
    let sbInfo = null;
    if (sbSpec && sbSpec.on) {
      const ext = visibleExtent(gd);
      const sb = ext && plotlyScaleBar(ext, { umPerUnit: sbSpec.umPerUnit, yReversed: ext.yReversed, fontSize: 17 });
      if (sb) {
        layout.shapes = (layout.shapes || []).concat(sb.shapes);
        layout.annotations = (layout.annotations || []).concat(sb.annotations);
        sbInfo = { label: sb.label, source: sbSpec.source || "" };
      }
    }
    if (opt.theme === "light") { recolorTree(data, toLight); recolorTree(layout, toLight); }
    layout.paper_bgcolor = th.bg;
    layout.plot_bgcolor = th.bg;
    layout.font = { family: FONT, size: 15, color: th.ink };
    const hideAxes = opt.kind === "map" && opt.hideAxes && sbInfo;
    for (const k of Object.keys(layout)) {
      if (!/^[xy]axis\d*$/.test(k) || !layout[k] || typeof layout[k] !== "object") continue;
      const ax = layout[k];
      if (hideAxes) {
        Object.assign(ax, { visible: false, showgrid: false, zeroline: false });
        continue;
      }
      const title = ax.title && typeof ax.title === "object" ? ax.title : { text: typeof ax.title === "string" ? ax.title : "" };
      Object.assign(ax, {
        showline: true, mirror: true, linecolor: th.axis, linewidth: 1.2,
        ticks: "outside", ticklen: 6, tickwidth: 1.1, tickcolor: th.axis,
        gridcolor: th.grid, zerolinecolor: th.zero, automargin: true,
        tickfont: Object.assign({}, ax.tickfont || {}, { size: 14, color: th.ink, family: FONT }),
        title: Object.assign({}, title, { font: Object.assign({}, title.font || {}, { size: 17, color: th.ink, family: FONT }), standoff: 10 }),
      });
      // 맵(정사각 픽셀)은 격자선이 자료를 가린다
      if (opt.kind === "map") ax.showgrid = false;
    }
    if (opt.kind === "map") mapFit(layout, gd.layout || {});
    if (layout.scene) {
      for (const k of ["xaxis", "yaxis", "zaxis"]) {
        const ax = layout.scene[k] = layout.scene[k] || {};
        Object.assign(ax, { color: th.ink, gridcolor: th.grid, linecolor: th.axis, zerolinecolor: th.zero,
          tickfont: { size: 12, family: FONT, color: th.ink } });
      }
      layout.scene.bgcolor = th.bg;
    }
    if (layout.legend) {
      layout.legend = Object.assign({}, layout.legend, { bgcolor: "rgba(0,0,0,0)", font: Object.assign({}, layout.legend.font || {}, { size: 13.5, color: th.ink, family: FONT }) });
    }
    if (Array.isArray(layout.annotations)) {
      for (const a of layout.annotations) {
        if (!a || (typeof a.name === "string" && KEEP.test(a.name))) continue;
        a.font = Object.assign({}, a.font || {}, { family: FONT, size: Math.max(12, Math.round(((a.font && a.font.size) || 12) * 1.12)) });
      }
    }
    for (const t of data) {
      if (t && t.colorbar) {
        const cb = t.colorbar;
        const ct = cb.title && typeof cb.title === "object" ? cb.title : { text: typeof cb.title === "string" ? cb.title : "" };
        t.colorbar = Object.assign({}, cb, { outlinewidth: 0, thickness: 16, len: 0.9,
          tickfont: { size: 13, color: th.ink, family: FONT },
          title: Object.assign({}, ct, { font: { size: 14, color: th.ink, family: FONT } }) });
      }
    }
    const m = layout.margin || {};
    const hasLegend = layout.showlegend !== false && data.filter((t) => t && t.showlegend !== false && t.name).length > 1;
    layout.margin = hideAxes ? { l: 12, r: 12, t: 12, b: 12 }
      : { l: Math.max(70, m.l || 0), r: Math.max(28, m.r || 0), t: hasLegend ? Math.max(48, m.t || 0) : 22, b: Math.max(62, m.b || 0) };
    return { data, layout, scaleBar: sbInfo };
  }

  /* ------------------------------ composition ------------------------------ */
  function todayStr() {
    const d = new Date(), z = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
  }
  function geometry(opt) {
    const P = PRESETS[opt.preset] || PRESETS.wide;
    const head = opt.caption ? HEADER_H : 0, foot = opt.caption ? FOOTER_H : 0;
    return { W: P.w, H: P.h, head, foot, bodyH: P.h - head - foot };
  }
  function ellipsize(ctx, s, maxW) {
    if (ctx.measureText(s).width <= maxW) return s;
    let lo = 0, hi = s.length;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (ctx.measureText(s.slice(0, mid) + "…").width <= maxW) lo = mid; else hi = mid - 1; }
    return s.slice(0, lo) + "…";
  }
  function footerText(opt, extra) {
    const left = `INNO Prism${opt.version ? " v" + opt.version : ""} · ${todayStr()}`;
    const right = [opt.note, extra].filter(Boolean).join(" · ");
    return { left, right };
  }
  function drawChrome(ctx, opt, g, extraNote) {
    const th = THEMES[opt.theme] || THEMES.light;
    ctx.fillStyle = th.bg; ctx.fillRect(0, 0, g.W, g.H);
    if (!opt.caption) return;
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = th.ink; ctx.font = `700 22px ${FONT}`;
    ctx.fillText(ellipsize(ctx, opt.title || "", g.W - 2 * PAD_X), PAD_X, 32);
    if (opt.subtitle) {
      ctx.fillStyle = th.sub; ctx.font = `400 14px ${FONT}`;
      ctx.fillText(ellipsize(ctx, opt.subtitle, g.W - 2 * PAD_X), PAD_X, 52);
    }
    ctx.fillStyle = th.rule; ctx.fillRect(PAD_X, g.head - 1, g.W - 2 * PAD_X, 1);
    const f = footerText(opt, extraNote);
    ctx.font = `400 11.5px ${FONT}`; ctx.fillStyle = th.sub;
    const fy = g.H - 11;
    ctx.fillText(f.left, PAD_X, fy);
    if (f.right) {
      const lw = ctx.measureText(f.left).width;
      const r = ellipsize(ctx, f.right, g.W - 2 * PAD_X - lw - 24);
      ctx.fillText(r, g.W - PAD_X - ctx.measureText(r).width, fy);
    }
  }
  const xmlEsc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  function chromeSvg(opt, g, extraNote) {
    const th = THEMES[opt.theme] || THEMES.light;
    let s = `<rect width="${g.W}" height="${g.H}" fill="${th.bg}"/>`;
    if (!opt.caption) return s;
    const f = footerText(opt, extraNote);
    s += `<text x="${PAD_X}" y="32" font-family="${xmlEsc(FONT)}" font-size="22" font-weight="700" fill="${th.ink}">${xmlEsc(opt.title || "")}</text>`;
    if (opt.subtitle) s += `<text x="${PAD_X}" y="52" font-family="${xmlEsc(FONT)}" font-size="14" fill="${th.sub}">${xmlEsc(opt.subtitle)}</text>`;
    s += `<rect x="${PAD_X}" y="${g.head - 1}" width="${g.W - 2 * PAD_X}" height="1" fill="${th.rule}"/>`;
    s += `<text x="${PAD_X}" y="${g.H - 11}" font-family="${xmlEsc(FONT)}" font-size="11.5" fill="${th.sub}">${xmlEsc(f.left)}</text>`;
    if (f.right) s += `<text x="${g.W - PAD_X}" y="${g.H - 11}" text-anchor="end" font-family="${xmlEsc(FONT)}" font-size="11.5" fill="${th.sub}">${xmlEsc(f.right)}</text>`;
    return s;
  }
  function loadImage(url) {
    return new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error("이미지 합성 실패")); im.src = url; });
  }

  /* ------------------------------- providers ------------------------------- */
  /** Plotly 그래프 → 본문. fmt = "png" | "svg". */
  function plotlyProvider(gd) {
    return {
      async body(opt, g, fmt) {
        const fig = themedFigure(gd, opt);
        const url = await Plotly.toImage({ data: fig.data, layout: fig.layout, config: { staticPlot: true } },
          { format: fmt === "svg" ? "svg" : "png", width: g.W, height: g.bodyH, scale: fmt === "svg" ? 1 : opt.scale });
        const note = fig.scaleBar ? `스케일바 ${fig.scaleBar.label}${fig.scaleBar.source ? " (" + fig.scaleBar.source + ")" : ""}` : "";
        return { url, note };
      },
    };
  }

  /* --------------------------------- export -------------------------------- */
  async function renderPng(provider, opt) {
    const g = geometry(opt);
    const body = await provider.body(opt, g, "png");
    const cv = document.createElement("canvas");
    cv.width = Math.round(g.W * opt.scale); cv.height = Math.round(g.H * opt.scale);
    const ctx = cv.getContext("2d");
    ctx.scale(opt.scale, opt.scale);
    drawChrome(ctx, opt, g, body.note);
    if (body.canvas) ctx.drawImage(body.canvas, 0, g.head, g.W, g.bodyH);
    else ctx.drawImage(await loadImage(body.url), 0, g.head, g.W, g.bodyH);
    return { canvas: cv, w: cv.width, h: cv.height, note: body.note };
  }
  async function renderSvg(provider, opt) {
    const g = geometry(opt);
    const body = await provider.body(opt, g, "svg");
    let inner;
    if (body.url && /^data:image\/svg\+xml/.test(body.url)) {
      let txt = body.url.replace(/^data:image\/svg\+xml(;charset=[^,;]*)?(;base64)?,/, (m0, cs, b64) => (b64 ? "B64:" : ""));
      txt = txt.startsWith("B64:") ? atob(txt.slice(4)) : decodeURIComponent(txt);
      txt = txt.replace(/<\?xml[^>]*>/, "");
      inner = txt.replace(/<svg\b/, `<svg x="0" y="${g.head}"`);
    } else {
      const url = body.canvas ? body.canvas.toDataURL("image/png") : body.url;
      inner = `<image x="0" y="${g.head}" width="${g.W}" height="${g.bodyH}" href="${url}"/>`;
    }
    const svg = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${g.W}" height="${g.H}" viewBox="0 0 ${g.W} ${g.H}">` +
      chromeSvg(opt, g, body.note) + inner + `</svg>`;
    return new Blob([svg], { type: "image/svg+xml" });
  }
  const slug = (s) => String(s || "figure").replace(/<[^>]*>/g, "").replace(/[\\/:*?"<>|]+/g, "").replace(/\s+/g, "_").slice(0, 60);

  /* --------------------------------- dialog -------------------------------- */
  /** 내보내기 창.
   *  meta = { kind: "graph"|"map"|"image", title, subtitle, note, stem, version, provider, hasScaleBar } */
  function openDialog(meta) {
    const prefs = loadPrefs();
    const kind = meta.kind || "graph";
    const opt = {
      kind, theme: prefs.theme, caption: prefs.caption, scale: prefs.scale,
      preset: prefs.preset[kind] || (kind === "graph" ? "wide" : "square"),
      hideAxes: prefs.hideAxesMap,
      // 그래프별로 고친 제목은 기억한다 (학회용 영문 제목을 한 번만 입력하면 되도록)
      title: (meta.key && prefs.titles[meta.key]) || meta.title || "", subtitle: meta.subtitle || "",
      note: meta.note || "", version: meta.version || "",
    };
    const back = document.createElement("div");
    back.className = "modal-back rpt-back";
    const presetOpts = Object.entries(PRESETS).map(([k, p]) => `<option value="${k}"${k === opt.preset ? " selected" : ""}>${p.label} (${p.w}×${p.h})</option>`).join("");
    back.innerHTML = `<div class="modal rpt-modal">
      <div class="rpt-head"><h2>보고서용 그림 저장</h2><button class="small rpt-x" title="닫기 (Esc)">✕</button></div>
      <div class="rpt-grid">
        <div class="rpt-prev"><div class="rpt-stage"><img alt="미리보기"></div><div class="rpt-dim mono small muted"></div></div>
        <div class="rpt-ctl">
          <label class="ctl"><span>제목</span><input type="text" class="rpt-title"></label>
          <label class="ctl"><span>부제 (시료·파일)</span><input type="text" class="rpt-sub"></label>
          <label class="ctl"><span>판형 <span class="muted">(모든 판형의 높이가 같아 나란히 놓아도 글자 크기가 일치)</span></span><select class="rpt-preset">${presetOpts}</select></label>
          <label class="ctl"><span>해상도</span><select class="rpt-scale">
            <option value="2">2× — 슬라이드용</option><option value="3">3× — 포스터·인쇄</option><option value="4">4× — 고해상 인쇄</option></select></label>
          <label class="ctl"><span>테마</span><select class="rpt-theme">
            <option value="light">라이트 — 보고서·슬라이드</option><option value="dark">다크 — 화면과 동일</option></select></label>
          <label class="rpt-chk"><input type="checkbox" class="rpt-cap"> 제목·캡션 포함</label>
          ${kind === "map" && meta.hasScaleBar ? `<label class="rpt-chk"><input type="checkbox" class="rpt-hide"> 축 숨김 — 스케일바만 (현미경 이미지 형식)</label>` : ""}
          <div class="rpt-note small muted"></div>
          <div class="rpt-actions">
            <button class="primary rpt-png">PNG 저장</button>
            <button class="rpt-svg">SVG 저장</button>
            <button class="rpt-copy" title="PowerPoint 등에 바로 붙여넣기">클립보드 복사</button>
          </div>
        </div>
      </div></div>`;
    document.body.appendChild(back);
    const q = (s) => back.querySelector(s);
    q(".rpt-title").value = opt.title;
    q(".rpt-sub").value = opt.subtitle;
    q(".rpt-scale").value = String(opt.scale);
    q(".rpt-theme").value = opt.theme;
    q(".rpt-cap").checked = !!opt.caption;
    if (q(".rpt-hide")) q(".rpt-hide").checked = !!opt.hideAxes;
    if (!meta.hasScaleBar && (kind === "map" || kind === "image") && meta.scaleBarWhyNot) q(".rpt-note").textContent = meta.scaleBarWhyNot;

    let seq = 0, last = null, timer = null;
    const persist = () => {
      const p = loadPrefs();
      p.theme = opt.theme; p.caption = opt.caption; p.scale = opt.scale;
      p.preset = Object.assign({}, p.preset, { [kind]: opt.preset });
      if (q(".rpt-hide")) p.hideAxesMap = opt.hideAxes;
      if (meta.key) {
        if (opt.title && opt.title !== meta.title) p.titles[meta.key] = opt.title;
        else delete p.titles[meta.key];
      }
      savePrefs(p);
    };
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const my = ++seq;
        try {
          // 미리보기는 1× 로 빠르게, 저장은 선택한 배수로
          const r = await renderPng(meta.provider, Object.assign({}, opt, { scale: 1 }));
          if (my !== seq) return;
          q(".rpt-stage img").src = r.canvas.toDataURL("image/png");
          const g = geometry(opt);
          q(".rpt-dim").textContent = `저장 크기 ${Math.round(g.W * opt.scale)} × ${Math.round(g.H * opt.scale)} px` +
            (r.note ? ` · ${r.note}` : "");
          q(".rpt-stage").style.aspectRatio = `${g.W} / ${g.H}`;
        } catch (e) {
          q(".rpt-dim").textContent = "미리보기 실패: " + (e && e.message || e);
        }
      }, 120);
    };
    const bind = (sel, ev, fn) => { const el = q(sel); if (el) el.addEventListener(ev, () => { fn(el); persist(); refresh(); }); };
    bind(".rpt-title", "input", (el) => { opt.title = el.value; });
    bind(".rpt-sub", "input", (el) => { opt.subtitle = el.value; });
    bind(".rpt-preset", "change", (el) => { opt.preset = el.value; });
    bind(".rpt-scale", "change", (el) => { opt.scale = Number(el.value) || 2; });
    bind(".rpt-theme", "change", (el) => { opt.theme = el.value; });
    bind(".rpt-cap", "change", (el) => { opt.caption = el.checked; });
    bind(".rpt-hide", "change", (el) => { opt.hideAxes = el.checked; });
    const close = () => { document.removeEventListener("keydown", onKey); back.remove(); };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    back.addEventListener("mousedown", (e) => { if (e.target === back) close(); });
    q(".rpt-x").addEventListener("click", close);
    const name = (ext) => `${meta.stem ? meta.stem + "_" : ""}${slug(opt.title)}.${ext}`;
    const busy = (b) => back.querySelectorAll(".rpt-actions button").forEach((x) => { x.disabled = b; });
    const save = (blob, fname) => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = fname; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    };
    q(".rpt-png").addEventListener("click", async () => {
      busy(true);
      try {
        const r = await renderPng(meta.provider, opt);
        await new Promise((res) => r.canvas.toBlob((b) => { save(b, name("png")); res(); }, "image/png"));
      } catch (e) { alert("저장 실패: " + (e && e.message || e)); } finally { busy(false); }
    });
    q(".rpt-svg").addEventListener("click", async () => {
      busy(true);
      try { save(await renderSvg(meta.provider, opt), name("svg")); }
      catch (e) { alert("저장 실패: " + (e && e.message || e)); } finally { busy(false); }
    });
    q(".rpt-copy").addEventListener("click", async () => {
      busy(true);
      try {
        const r = await renderPng(meta.provider, opt);
        const blob = await new Promise((res) => r.canvas.toBlob(res, "image/png"));
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        q(".rpt-note").textContent = "클립보드에 복사했습니다 — 슬라이드에 바로 붙여넣으세요.";
      } catch (e) {
        q(".rpt-note").textContent = "이 브라우저에서는 이미지 클립보드 복사가 막혀 있습니다 — PNG 저장을 쓰세요.";
      } finally { busy(false); }
    });
    refresh();
    return { close, opt, back };
  }

  /** 모드바 카메라 버튼을 대체하는 버튼 정의 (Plotly config.modeBarButtonsToAdd 용). */
  function modebarButton(getMeta) {
    return {
      name: "report-png", title: "보고서용 그림 저장 (고정 판형)",
      icon: (typeof Plotly !== "undefined" && Plotly.Icons) ? Plotly.Icons.camera : undefined,
      click: (gd) => openDialog(Object.assign({ provider: plotlyProvider(gd) }, getMeta(gd))),
    };
  }

  return {
    PRESETS, THEMES, FONT, HEADER_H, FOOTER_H,
    toLight, parseColor, recolorTree, cloneFig, themedFigure,
    niceLength, fmtLength, plotlyScaleBar, attachPlotlyScaleBar, stripScaleBar,
    geometry, drawChrome, renderPng, renderSvg, plotlyProvider, openDialog, modebarButton,
    loadPrefs, savePrefs,
  };
});

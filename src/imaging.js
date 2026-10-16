/* =============================================================================
 * INNO Prism — widefield imaging numeric layer  (v3.14)
 *
 * 카메라 프레임(단일/스택)에 대한 **DOM 없는 순수 수치 계층**.
 * 화면 그리기는 app.js 가 하고, 여기서는 값만 만든다 (Node 에서 그대로 검사 가능).
 *
 * 설계 원칙 — 이 파일 전체를 관통한다:
 *  1) 파일이 기록하지 않은 것을 추론으로 채우지 않는다. 상태(빔 on/off)가 파일에
 *     없으면 "없다"고 말하고, 가설은 **근거와 함께 가설로** 내놓는다.
 *  2) 전체가 함께 움직인 변화(common mode)와 한 입자만 움직인 변화(independent)를
 *     먼저 분리한다. 이 구분 없이 "스위칭"이라고 부르면 초점 이탈·빔 요동·시야 이동이
 *     전부 단일입자 현상으로 둔갑한다. 허위 경보는 침묵보다 나쁘다.
 *  3) 물리 해석(활성화인가 억제인가)을 수치에 박지 않는다. 지표는 부호중립으로
 *     정의하고(양방향 비 + Michelson), 이름표는 표시 계층에서만 붙인다.
 * ========================================================================== */
"use strict";
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PrismImg = api;
})(typeof self !== "undefined" ? self : this, function () {

/* ------------------------------ basic stats ------------------------------- */
function quantileSorted(s, q) {
  const n = s.length;
  if (!n) return NaN;
  if (n === 1) return s[0];
  const p = (n - 1) * q, lo = Math.floor(p), hi = Math.ceil(p);
  return lo === hi ? s[lo] : s[lo] + (p - lo) * (s[hi] - s[lo]);
}
function quantile(arr, q) { return quantileSorted(Array.from(arr).sort((a, b) => a - b), q); }
function median(arr) { return quantile(arr, 0.5); }

/** 로버스트 배경·잡음. MAD → σ 는 정규분포 가정 환산계수 1.4826.
 *  밝은 점이 섞여 있어도 중앙값·MAD 는 거의 흔들리지 않으므로 표준편차 대신 쓴다.
 *  큰 이미지는 stride 표본만 본다(1024² 전수 정렬은 표시 반응성을 해친다). */
function robustStats(img, maxSamples) {
  const N = img.length, want = maxSamples || 60000;
  const step = Math.max(1, Math.floor(N / want));
  const s = [];
  for (let i = 0; i < N; i += step) { const v = img[i]; if (isFinite(v)) s.push(v); }
  s.sort((a, b) => a - b);
  const med = quantileSorted(s, 0.5);
  const dev = new Array(s.length);
  for (let i = 0; i < s.length; i++) dev[i] = Math.abs(s[i] - med);
  dev.sort((a, b) => a - b);
  const mad = quantileSorted(dev, 0.5);
  return { median: med, mad, sigma: mad * 1.4826, n: s.length, step };
}
function percentiles(img, qs, maxSamples) {
  const N = img.length, want = maxSamples || 60000;
  const step = Math.max(1, Math.floor(N / want));
  const s = [];
  for (let i = 0; i < N; i += step) { const v = img[i]; if (isFinite(v)) s.push(v); }
  s.sort((a, b) => a - b);
  return qs.map((q) => quantileSorted(s, q));
}

/* ------------------------------ image ops --------------------------------- */
/** 분리형 가우시안 평활. 반경은 3σ 에서 끊는다(꼬리 기여 <0.3%). */
function gaussBlur(src, nx, ny, sigma) {
  const r = Math.max(1, Math.ceil(3 * sigma));
  const k = new Float32Array(2 * r + 1);
  let s = 0;
  for (let i = -r; i <= r; i++) { const v = Math.exp(-(i * i) / (2 * sigma * sigma)); k[i + r] = v; s += v; }
  for (let i = 0; i < k.length; i++) k[i] /= s;
  const tmp = new Float32Array(nx * ny), out = new Float32Array(nx * ny);
  for (let y = 0; y < ny; y++) {
    const row = y * nx;
    for (let x = 0; x < nx; x++) {
      let acc = 0;
      for (let i = -r; i <= r; i++) {
        let xx = x + i; if (xx < 0) xx = -xx; if (xx >= nx) xx = 2 * nx - 2 - xx;
        acc += k[i + r] * src[row + xx];
      }
      tmp[row + x] = acc;
    }
  }
  for (let x = 0; x < nx; x++) {
    for (let y = 0; y < ny; y++) {
      let acc = 0;
      for (let i = -r; i <= r; i++) {
        let yy = y + i; if (yy < 0) yy = -yy; if (yy >= ny) yy = 2 * ny - 2 - yy;
        acc += k[i + r] * tmp[yy * nx + x];
      }
      out[y * nx + x] = acc;
    }
  }
  return out;
}
/** 원소별 최대 누적 — 프레임을 하나씩 읽으며 호출한다(스택 전체를 메모리에 안 올림). */
function accMax(acc, frame) {
  if (!acc) return Float32Array.from(frame);
  for (let i = 0; i < acc.length; i++) if (frame[i] > acc[i]) acc[i] = frame[i];
  return acc;
}
function accSum(acc, frame) {
  if (!acc) return Float32Array.from(frame);
  for (let i = 0; i < acc.length; i++) acc[i] += frame[i];
  return acc;
}
function scaleInPlace(a, f) { for (let i = 0; i < a.length; i++) a[i] *= f; return a; }

/* ------------------------------ spot finding ------------------------------ */
/**
 * 입자(회절한계 점) 검출.
 *   평활 → 국소최대 → **모양 판별** → 최소간격 강제 → 광속(flux)순 절단
 *
 * ── 왜 σ 문턱만으로는 안 되는가 (이 카메라 자료에서 실측한 사실) ────────────
 * EM gain 이 걸린 프레임의 화소 분포는 정규분포가 **전혀** 아니다. 증폭된 단일광자
 * 사건이 화소 하나짜리 스파이크로 찍혀 꼬리가 극단적으로 두껍다.
 * 실측(1024², 평활 σ=1.5): 중앙값+6σ 초과 4,961 px · +15σ 초과 1,220 px ·
 * +30σ 초과 735 px. 정규분포라면 +6σ 조차 0개여야 한다.
 * 그러므로 문턱을 아무리 올려도 스파이크는 남는다 — **문턱이 아니라 모양으로** 가른다.
 *
 * ── 모양 판별: shape = 조리개합 / 봉우리 ──────────────────────────────────
 * 회절한계 점은 PSF 폭에 걸쳐 여러 화소가 함께 밝다 → 합/봉우리 ≫ 1.
 * 단일광자 스파이크는 밝은 화소가 하나뿐이다 → 합/봉우리 ≈ 1.
 * 실측 분포(후보 166개): 스파이크 중앙값 1.94 · p90 3.83 / 실제 입자 5.6–17.0.
 * 기본 문턱 4.0 은 두 무리 사이에 있다. **기각 개수를 항상 함께 반환**하므로
 * 문턱이 과하면 사용자가 즉시 알아채고 낮출 수 있다.
 *
 * ── 검출 기준 이미지 (호출자가 고른다) ────────────────────────────────────
 * mean projection  — 스파이크가 1/N 로 줄어 가장 깨끗. 스택의 기본값.
 * max projection   — 한 프레임에만 켜진 입자도 잡지만 스파이크도 전부 모은다.
 * 단일 프레임       — 그 프레임에서 꺼져 있던 입자는 ROI 목록에서 통째로 빠진다.
 * 어느 쪽도 공짜가 아니므로 기본값을 강요하지 않고 개수를 나란히 보여 준다.
 */
function detectSpots(img, nx, ny, opt) {
  const o = Object.assign({ smooth: 1.5, k: 8, minSep: 6, maxSpots: 60, edge: 4,
    shapeMin: 4.0, apR: 3 }, opt || {});
  const sm = gaussBlur(img, nx, ny, o.smooth);
  const st = robustStats(sm);
  const rawBg = robustStats(img).median;
  const thr = st.median + o.k * st.sigma;
  const w = Math.max(1, Math.round(o.minSep / 2));
  const cand = [];
  for (let y = o.edge; y < ny - o.edge; y++) {
    for (let x = o.edge; x < nx - o.edge; x++) {
      const v = sm[y * nx + x];
      if (!(v > thr)) continue;
      let isMax = true;
      for (let dy = -w; dy <= w && isMax; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= ny) continue;
        for (let dx = -w; dx <= w; dx++) {
          const xx = x + dx; if (xx < 0 || xx >= nx) continue;
          if (dx === 0 && dy === 0) continue;
          const u = sm[yy * nx + xx];
          if (u > v || (u === v && (yy * nx + xx) < (y * nx + x))) { isMax = false; break; }
        }
      }
      if (!isMax) continue;
      // 모양 판별은 **원본** 프레임에서 한다 (평활은 스파이크를 PSF 처럼 퍼뜨린다)
      let flux = 0, rpk = -Infinity;
      const R = o.apR, R2 = R * R;
      for (let dy = -R; dy <= R; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= ny) continue;
        for (let dx = -R; dx <= R; dx++) {
          if (dx * dx + dy * dy > R2) continue;
          const xx = x + dx; if (xx < 0 || xx >= nx) continue;
          const u = img[yy * nx + xx] - rawBg;
          flux += u;
          if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1 && u > rpk) rpk = u;
        }
      }
      const shape = rpk > 0 ? flux / rpk : 0;
      cand.push({ x, y, peak: v - st.median, snr: (v - st.median) / (st.sigma || 1), flux, shape });
    }
  }
  const nCandidates = cand.length;
  const passed = cand.filter((c) => c.shape >= o.shapeMin);
  const nRejectedShape = nCandidates - passed.length;
  // 광속순으로 고른다 — 봉우리는 PSF 폭에 따라 흔들리지만 조리개합은 물리량이다
  passed.sort((a, b) => b.flux - a.flux);
  const keep = [];
  for (const c of passed) {
    if (keep.length >= o.maxSpots) break;
    let ok = true;
    for (const q of keep) {
      const dx = q.x - c.x, dy = q.y - c.y;
      if (dx * dx + dy * dy < o.minSep * o.minSep) { ok = false; break; }
    }
    if (ok) keep.push(c);
  }
  // 무게중심으로 위치 정밀화 (평활 이미지, 배경 제거 후)
  for (const c of keep) {
    const r = Math.max(2, Math.round(o.minSep / 2));
    let sw = 0, sx = 0, sy = 0;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const xx = c.x + dx, yy = c.y + dy;
      if (xx < 0 || yy < 0 || xx >= nx || yy >= ny) continue;
      const v = sm[yy * nx + xx] - st.median;
      if (v <= 0) continue;
      sw += v; sx += v * xx; sy += v * yy;
    }
    if (sw > 0) { c.xc = sx / sw; c.yc = sy / sw; } else { c.xc = c.x; c.yc = c.y; }
  }
  return {
    spots: keep, threshold: thr, background: st.median, sigma: st.sigma, rawBackground: rawBg,
    nCandidates, nRejectedShape, nPassed: passed.length,
    nDropped: Math.max(0, passed.length - keep.length), params: o,
  };
}

/* ------------------------------ photometry -------------------------------- */
/**
 * 조리개 + 환형배경 광도측정.
 *   S = Σ_aperture − n_ap · median(annulus)
 *
 * 배경은 평균이 아니라 **중앙값**으로 뺀다. 고리 안에 이웃 입자 꼬리나 우주선(cosmic
 * ray)이 걸리면 평균은 끌려가고 중앙값은 버틴다.
 *
 * sigmaLow 는 **잡음의 하한**이다. 고리 화소의 산포만 반영하므로 밝은 화소의
 * 산탄잡음(EM gain 이 걸리면 초과잡음까지)은 들어 있지 않다. 판정에 쓸 때는
 * 하한임을 반드시 함께 보고한다 — 이걸 실제 σ 로 쓰면 유의성이 부풀려진다.
 */
function photometry(img, nx, ny, rois, opt) {
  const o = Object.assign({ r: 3, rin: 5, rout: 9 }, opt || {});
  const out = [];
  const r2 = o.r * o.r, rin2 = o.rin * o.rin, rout2 = o.rout * o.rout;
  for (const roi of rois) {
    const cx = Math.round(roi.xc != null ? roi.xc : roi.x);
    const cy = Math.round(roi.yc != null ? roi.yc : roi.y);
    let sum = 0, nap = 0, peak = -Infinity;
    const ring = [];
    for (let dy = -o.rout; dy <= o.rout; dy++) {
      const yy = cy + dy; if (yy < 0 || yy >= ny) continue;
      for (let dx = -o.rout; dx <= o.rout; dx++) {
        const xx = cx + dx; if (xx < 0 || xx >= nx) continue;
        const d2 = dx * dx + dy * dy;
        const v = img[yy * nx + xx];
        if (d2 <= r2) { sum += v; nap++; if (v > peak) peak = v; }
        else if (d2 >= rin2 && d2 <= rout2) ring.push(v);
      }
    }
    const bg = ring.length ? median(ring) : 0;
    let mad = 0;
    if (ring.length > 4) {
      const dev = ring.map((v) => Math.abs(v - bg)).sort((a, b) => a - b);
      mad = quantileSorted(dev, 0.5);
    }
    const sigPix = mad * 1.4826;
    out.push({
      sum: sum - bg * nap, raw: sum, bg, nap, nring: ring.length,
      peak: isFinite(peak) ? peak - bg : NaN,
      sigmaLow: sigPix * Math.sqrt(nap),   // 하한 — 조리개 안 산탄잡음 미포함
      clipped: nap === 0,
    });
  }
  return out;
}

/* ------------------------------ blank noise ------------------------------- */
/**
 * 빈 자리 조리개 측광의 산포 = 그 프레임에서 **측광 1회의 실제 잡음**.
 *
 * 고리 배경의 MAD(photometry 의 sigmaLow)는 하한일 뿐이다 — EM gain 초과잡음도,
 * 배경의 공간 구조도 들어 있지 않다. 그래서 잡음을 모형으로 세우는 대신, 같은
 * 프레임의 **아무것도 없는 자리**에 같은 조리개를 놓고 실제로 재 본다.
 * 가정이 없으므로 게인·증폭 통계를 몰라도 된다.
 *
 * 난수는 고정 씨앗 LCG 를 쓴다 — 같은 파일을 두 번 열면 같은 값이 나와야 한다.
 */
function blankNoise(img, nx, ny, rois, opt) {
  const o = Object.assign({ r: 3, rin: 5, rout: 9, nSample: 240, seed: 20260921, clear: 16 }, opt || {});
  let s = o.seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const pad = o.rout + 2;
  const pts = [];
  let guard = 0;
  while (pts.length < o.nSample && guard++ < o.nSample * 20) {
    const x = pad + Math.floor(rnd() * (nx - 2 * pad));
    const y = pad + Math.floor(rnd() * (ny - 2 * pad));
    let near = false;
    for (const q of rois) {
      const dx = (q.xc != null ? q.xc : q.x) - x, dy = (q.yc != null ? q.yc : q.y) - y;
      if (dx * dx + dy * dy < o.clear * o.clear) { near = true; break; }
    }
    if (!near) pts.push({ x, y });
  }
  if (pts.length < 20) return { sigma: NaN, n: pts.length, why: "빈 자리 표본이 부족합니다" };
  const ph = photometry(img, nx, ny, pts, { r: o.r, rin: o.rin, rout: o.rout });
  const v = ph.map((p) => p.sum).filter(isFinite);
  const med = median(v);
  const dev = v.map((x) => Math.abs(x - med)).sort((a, b) => a - b);
  return { sigma: quantileSorted(dev, 0.5) * 1.4826, median: med, n: v.length };
}

/* --------------------- common mode vs independent ------------------------- */
/**
 * 시야 전체가 함께 움직인 변화와 한 입자만 움직인 변화를 나눈다.
 * **이 분리 없이 "스위칭"이라 부르면 초점 이탈·빔 요동·시야 이동이 전부 단일입자
 * 현상으로 둔갑한다.**
 *
 *   ref_i  = 상위 절반 프레임의 평균            (입자 i 의 "켜진 수준")
 *   u_ik   = S_ik / ref_i                       (입자별 정규화 트레이스)
 *   g_k    = median_i u_ik                      (공통모드 — 시야 전체의 배율)
 *   E_ik   = g_k · ref_i                        (공통모드만으로 기대되는 값)
 *
 * 전부가 같은 비율로 꺼지면 g 가 그것을 흡수해 S ≈ E 가 되어 **공통모드**로,
 * 한 입자만 꺼지면 g 는 그대로이고 그 입자만 S ≪ E 가 되어 **개별**로 분류된다.
 *
 * ── 관측 가능성 게이트 (v3.12 에서 확립한 원칙의 재적용) ────────────────────
 * **E_ik 가 잡음 아래면 그 점은 아무것도 구분하지 못한다.** 시야 전체가 꺼진
 * 프레임에서는 모든 ROI 가 잡음 위를 떠다니므로 비(比)를 계산하면 잡음/잡음이
 * 되어 |log₂| 가 2 oct 씩 튀고, 그 결과 "전체가 함께 꺼졌는데 개별 스위칭 5건"
 * 같은 허위 경보가 나온다(실측 110553 에서 실제로 나왔다).
 * 그래서 E_ik > kSig·σ_blank 인 점만 판정에 쓰고, 나머지는 `unidentified` 로
 * 남긴다 — 값을 숨기지 않고 기각 사유와 함께 노출한다.
 *
 * ── 잡음 모형 ──────────────────────────────────────────────────────────────
 *   noise(E) = √( σ_blank² + (relScatter·E)² )
 * σ_blank 는 같은 프레임의 빈 자리에서 실측하고(blankNoise), relScatter 는
 * 관측 가능한 점들의 상대 잔차 산포에서 직접 잰다. 둘 다 데이터에서 나오므로
 * EM gain 통계를 가정하지 않는다.
 *
 * ROI 가 3개 미만이면 median 이 의미를 잃는다 → 분리하지 않고 사유를 반환한다.
 */
function commonMode(traces, opt) {
  const o = Object.assign({ kSig: 3, relFloor: 0.15, sigmaBlank: null }, opt || {});
  const nRoi = traces.length, nF = nRoi ? traces[0].length : 0;
  const res = { nRoi, nF, ok: false, why: "" };
  if (nRoi < 3) { res.why = `ROI 가 ${nRoi}개뿐입니다 — 공통모드를 정의하려면 최소 3개가 필요합니다`; return res; }
  if (nF < 2) { res.why = "프레임이 1장뿐입니다 — 비교할 상대가 없습니다"; return res; }
  const sb = [];
  for (let k = 0; k < nF; k++) {
    const v = Array.isArray(o.sigmaBlank) ? o.sigmaBlank[k] : o.sigmaBlank;
    sb.push(isFinite(v) && v > 0 ? v : NaN);
  }
  const haveBlank = sb.every((v) => isFinite(v));
  const ref = [], u = [];
  for (let i = 0; i < nRoi; i++) {
    const s = Array.from(traces[i], Number);
    const srt = s.slice().sort((a, b) => b - a);
    const top = Math.max(1, Math.ceil(nF / 2));
    let m = 0; for (let j = 0; j < top; j++) m += srt[j];
    m /= top;
    ref.push(m);
    u.push(s.map((v) => (m > 0 ? v / m : NaN)));
  }
  const usable = [];
  for (let i = 0; i < nRoi; i++) if (isFinite(ref[i]) && ref[i] > 0) usable.push(i);
  if (usable.length < 3) { res.why = "기준 수준(ref)이 정의되는 ROI 가 3개 미만입니다"; return res; }
  const g = [];
  for (let k = 0; k < nF; k++) {
    const col = [];
    for (const i of usable) { const v = u[i][k]; if (isFinite(v)) col.push(v); }
    g.push(col.length ? median(col) : NaN);
  }
  // 기대값과 관측 가능성
  const exp = [], obs = [];
  for (let i = 0; i < nRoi; i++) {
    const e = [], ob = [];
    for (let k = 0; k < nF; k++) {
      const E = isFinite(g[k]) && isFinite(ref[i]) ? g[k] * ref[i] : NaN;
      e.push(E);
      ob.push(isFinite(E) && (!haveBlank || E > o.kSig * sb[k]));
    }
    exp.push(e); obs.push(ob);
  }
  // 상대 산포 — 관측 가능한 점에서만 (잡음 구간이 섞이면 산포가 부풀고 문턱이 무의미해진다)
  const rel = [];
  for (const i of usable) for (let k = 0; k < nF; k++) {
    if (!obs[i][k]) continue;
    const E = exp[i][k];
    if (!(E > 0)) continue;
    rel.push((traces[i][k] - E) / E);
  }
  const relMed = rel.length ? median(rel) : 0;
  const relScatter = rel.length > 3
    ? Math.max(o.relFloor, quantile(rel.map((v) => Math.abs(v - relMed)), 0.5) * 1.4826)
    : o.relFloor;
  const flags = [];
  let nObsTotal = 0;
  for (let i = 0; i < nRoi; i++) {
    let worst = 0, worstK = -1, nObs = 0, worstRatio = NaN;
    for (let k = 0; k < nF; k++) {
      if (!obs[i][k]) continue;
      nObs++; nObsTotal++;
      const E = exp[i][k], S = traces[i][k];
      const noise = Math.sqrt((haveBlank ? sb[k] * sb[k] : 0) + Math.pow(relScatter * E, 2));
      const z = noise > 0 ? Math.abs(S - E) / noise : 0;
      if (z > worst) { worst = z; worstK = k; worstRatio = E > 0 ? S / E : NaN; }
    }
    flags.push({
      roi: i, nObservable: nObs, maxZ: nObs ? worst : NaN, atFrame: worstK, ratioAtWorst: worstRatio,
      // **관측 가능한 점이 2개 미만이면 "변화 없음"이라고 말할 수 없다.** 비교할
      // 상대가 없는 것을 consistent 로 적으면 침묵해야 할 자리에서 결론을 내는 셈이다.
      verdict: nObs < 2 ? "unidentified" : (worst > o.kSig ? "independent" : "consistent"),
      independent: nObs >= 2 && worst > o.kSig,
    });
  }
  const gf = g.filter((v) => isFinite(v) && v > 0);
  res.ok = true;
  res.g = g; res.u = u; res.ref = ref; res.exp = exp; res.observable = obs; res.flags = flags;
  res.sigmaBlank = sb; res.haveBlank = haveBlank; res.relScatter = relScatter;
  res.kSig = o.kSig; res.usable = usable;
  res.nObservable = nObsTotal; res.nPoints = nRoi * nF;
  res.commonSwing = gf.length ? Math.max.apply(null, gf) / Math.min.apply(null, gf) : NaN;
  res.nIndependent = flags.filter((f) => f.verdict === "independent").length;
  res.nUnidentified = flags.filter((f) => f.verdict === "unidentified").length;
  // 전체가 함께 움직였는가 — g 의 진폭이 개별 잔차 문턱을 크게 넘는가
  res.commonDominant = isFinite(res.commonSwing) && res.commonSwing > 1 + 3 * relScatter;
  return res;
}

/* ---------------------- modulation depth & selectivity --------------------- */
/**
 * 입자별 변조 깊이.
 *
 * darkening ↔ recovery 실험에서 가장 직접적인 양은 "이 입자가 몇 배로 오르내렸는가"다.
 * 그런데 꺼진 쪽이 잡음 아래로 내려가면 비의 분모가 정해지지 않는다 — 그때는
 * 분모를 잡음 문턱으로 막고 **하한으로** 보고한다(`isLowerBound`).
 * 0 으로 나눠 무한대를 적거나, 측정되지 않은 작은 값을 그대로 쓰는 것은 둘 다 거짓이다.
 */
function modulationDepth(traces, sigmaBlank, opt) {
  const o = Object.assign({ kSig: 3 }, opt || {});
  const sb = Array.isArray(sigmaBlank) ? sigmaBlank : null;
  const floorOf = (k) => {
    const v = sb ? sb[k] : sigmaBlank;
    return isFinite(v) && v > 0 ? o.kSig * v : NaN;
  };
  return traces.map((t) => {
    let maxS = -Infinity, minS = Infinity, kMax = -1, kMin = -1;
    for (let k = 0; k < t.length; k++) {
      const v = t[k];
      if (!isFinite(v)) continue;
      if (v > maxS) { maxS = v; kMax = k; }
      if (v < minS) { minS = v; kMin = k; }
    }
    const fl = floorOf(kMin);
    const lowFloored = isFinite(fl) ? Math.max(minS, fl) : minS;
    const isLowerBound = isFinite(fl) && minS < fl;
    const depth = lowFloored > 0 ? maxS / lowFloored : NaN;
    const hiFl = floorOf(kMax);
    return {
      maxS, minS, kMax, kMin, depth, isLowerBound,
      // 위쪽이 잡음 위에 있어야 변조를 논할 수 있다
      significant: isFinite(hiFl) ? maxS > hiFl : null,
      floor: fl,
    };
  });
}
/**
 * 공간 선택성 — **초점 빔 실험의 핵심 질문**에 답한다:
 * 표적 입자 하나만 반응했는가, 아니면 주변도 함께 반응했는가.
 *
 * 초점 빔이 한 입자만 때렸다면 표적의 변조 깊이가 주변보다 압도적으로 커야 하고,
 * 반응하지 않은 **가장 가까운 이웃까지의 거리**가 그 빔의 유효 반경 상한이 된다.
 * 반대로 깊이가 거리에 따라 완만히 줄면 빔이 샜거나 초점이 넓다는 뜻이다.
 *
 * 거리는 화소 단위다 — µm/px 환산이 파일에 없으므로 여기서 지어내지 않는다.
 */
function selectivity(rois, depths, targetIdx, opt) {
  const o = Object.assign({ quietMax: 2.0 }, opt || {});
  const px = (r) => (r.xc != null ? r.xc : r.x), py = (r) => (r.yc != null ? r.yc : r.y);
  if (targetIdx == null || !rois[targetIdx]) return { ok: false, why: "표적 ROI 가 지정되지 않았습니다" };
  const tx = px(rois[targetIdx]), ty = py(rois[targetIdx]);
  const rows = rois.map((r, i) => ({
    roi: i, dist: Math.hypot(px(r) - tx, py(r) - ty),
    depth: depths[i] ? depths[i].depth : NaN,
    isLowerBound: depths[i] ? depths[i].isLowerBound : false,
    isTarget: i === targetIdx,
  })).sort((a, b) => a.dist - b.dist);
  const others = rows.filter((r) => !r.isTarget && isFinite(r.depth));
  const tgt = rows.find((r) => r.isTarget);
  const quiet = others.filter((r) => r.depth <= o.quietMax);
  const loud = others.filter((r) => r.depth > o.quietMax);
  const maxOther = others.length ? Math.max.apply(null, others.map((r) => r.depth)) : NaN;
  return {
    ok: true, rows, target: tgt, nOthers: others.length,
    maxOtherDepth: maxOther,
    ratioToOthers: isFinite(maxOther) && maxOther > 0 ? tgt.depth / maxOther : NaN,
    nearestQuiet: quiet.length ? quiet[0] : null,
    nearestLoud: loud.length ? loud[0] : null,
    quietMax: o.quietMax,
    // 거리에 따른 추세: 가까운 절반과 먼 절반의 깊이 중앙값 비교
    trend: (() => {
      if (others.length < 4) return null;
      const half = Math.floor(others.length / 2);
      const near = median(others.slice(0, half).map((r) => r.depth));
      const far = median(others.slice(half).map((r) => r.depth));
      return { near, far, splitAt: others[half].dist, graded: near > far * 1.5 };
    })(),
  };
}
/** 변조가 가장 큰 ROI — 표적 자동 제안용. 판정이 아니라 **제안**이다. */
function suggestTarget(depths) {
  let best = -1, bd = -Infinity;
  depths.forEach((d, i) => {
    if (!d || !isFinite(d.depth)) return;
    if (d.significant === false) return;
    if (d.depth > bd) { bd = d.depth; best = i; }
  });
  return best >= 0 ? { index: best, depth: bd } : null;
}

/* --------------------------- state assignment ----------------------------- */
/**
 * "어느 프레임이 빔 on 인가" — 세 경로를 **각각 근거와 함께** 반환한다. 고르지 않는다.
 *
 *  (1) file    : 파일이 상태를 기록했는가
 *  (2) cadence : 프레임 간격이 두 값으로 교대하는가 (교대 = 한 주기에 두 위상)
 *  (3) levels  : 프레임 밝기가 두 준위로 갈라지는가
 *
 * 셋이 어긋나면 그것 자체가 결과다. 예컨대 간격은 A·B·A 를 가리키는데 밝기는
 * 첫 프레임만 밝다면, 그건 "상태가 아니라 비가역적 소실(퇴색·초점이탈·이동)"을
 * 시사한다 — 여기서 하나를 임의로 채택하면 그 정보가 사라진다.
 */
function stateEvidence(input) {
  const { n, time, aux, level, settings } = input;
  const ev = { n, file: null, schedule: null, cadence: null, levels: null, agree: null };

  // (0) 측정 설정 구조 — 파일이 직접 적어 둔 값에서 나온다(추정이 아니다).
  //     ScopeFoundry time_trace_on_off 은 주기당 두 조작을 수행하므로
  //     프레임 수 n = 2·num_cycle + 1 이면 "첫 장 = 기준 상태, 이후 두 조작이 교대"가
  //     **산술적으로 확인된다.** 이 경우 첫 프레임은 어느 상태도 아니므로 제외한다 —
  //     기준 프레임을 한쪽 상태에 억지로 넣으면 그쪽 평균이 오염된다.
  const nc = settings && settings.num_cycle != null ? Number(settings.num_cycle) : NaN;
  if (isFinite(nc) && nc >= 1 && n === 2 * nc + 1) {
    const assign = new Array(n).fill(-1);
    for (let k = 1; k < n; k++) assign[k] = (k % 2 === 1) ? 0 : 1;
    ev.schedule = {
      assign, numCycle: nc, strength: "구조 일치",
      note: `설정의 num_cycle = ${nc} 이고 프레임이 ${n}장 = 2×${nc}+1 입니다 — ` +
        `첫 장은 조작 전 기준이고 이후 두 조작이 교대합니다. 어느 쪽이 어떤 조작인지는 파일에 없습니다.`,
    };
  } else if (isFinite(nc) && nc >= 1) {
    ev.scheduleNote = `설정의 num_cycle = ${nc} 인데 프레임이 ${n}장입니다 (2×${nc}+1 = ${2 * nc + 1} 아님) — ` +
      `주기 구조를 프레임 수로 확인할 수 없습니다.`;
  } else {
    ev.scheduleNote = "측정 설정에 num_cycle 이 없습니다 — 주기 구조를 확인할 수 없습니다.";
  }

  // (1) 파일 기록
  const notes = [];
  if (aux) for (const key of Object.keys(aux)) {
    const a = aux[key];
    if (!Array.isArray(a) && !ArrayBuffer.isView(a)) continue;
    const arr = Array.from(a, Number);
    if (arr.length !== n) { notes.push(`${key}: 길이 ${arr.length} ≠ 프레임 ${n}`); continue; }
    const uniq = Array.from(new Set(arr));
    if (uniq.length < 2) { notes.push(`${key}: 값이 ${uniq.length === 1 ? String(uniq[0]) : "없음"} 하나뿐`); continue; }
    if (uniq.length === n && arr.every((v, i) => v === arr[0] + i)) { notes.push(`${key}: 단순 일련번호`); continue; }
    if (uniq.length === 2) {
      const lo = Math.min.apply(null, uniq);
      ev.file = { assign: arr.map((v) => (v === lo ? 0 : 1)), from: key, strength: "확정" };
      break;
    }
    notes.push(`${key}: 서로 다른 값 ${uniq.length}개 — 2상태로 볼 수 없음`);
  }
  if (!ev.file) ev.fileNotes = notes;

  // (2) 간격 교대
  if (time && time.length === n && n >= 3) {
    const dt = [];
    for (let i = 1; i < n; i++) dt.push(time[i] - time[i - 1]);
    const even = dt.filter((_, i) => i % 2 === 0), odd = dt.filter((_, i) => i % 2 === 1);
    if (even.length && odd.length) {
      const me = mean(even), mo = mean(odd);
      const spread = Math.max(spreadOf(even), spreadOf(odd));
      const gap = Math.abs(me - mo);
      const rel = gap / Math.max(1e-9, (me + mo) / 2);
      const strong = gap > 3 * spread && rel > 0.05;
      const weak = rel > 0.05;
      if (weak) {
        ev.cadence = {
          assign: Array.from({ length: n }, (_, i) => i % 2),
          dtEven: me, dtOdd: mo, spread, rel,
          strength: strong ? (even.length > 1 && odd.length > 1 ? "강함" : "약함 (각 위상 1구간뿐)") : "약함",
          note: `프레임 간격이 ${fmtN(me)} s 와 ${fmtN(mo)} s 로 교대합니다 (차이 ${(rel * 100).toFixed(1)}%)`,
        };
      } else {
        ev.cadenceNote = `프레임 간격이 균일합니다 (${fmtN(me)} s) — 교대 구조의 근거가 없습니다`;
      }
    }
  } else if (!time) ev.cadenceNote = "시간축이 없습니다";

  // (3) 준위 분리
  if (level && level.length === n && n >= 3) {
    const v = Array.from(level, Number).filter(isFinite);
    if (v.length === n && v.every((x) => x > 0)) {
      const lg = v.map((x) => Math.log2(x));
      const idx = lg.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]);
      let bestGap = -Infinity, cutAt = -1;
      const gaps = [];
      for (let i = 1; i < n; i++) { const gp = idx[i][0] - idx[i - 1][0]; gaps.push(gp); if (gp > bestGap) { bestGap = gp; cutAt = i; } }
      // 최대 간격을 **나머지 간격들과** 비교한다. 나머지에 자기 자신을 포함시키면
      // 프레임이 적을 때 비가 구조적으로 눌려서(n=3 이면 최대 2.0) 진짜 이봉분포도
      // 문턱을 못 넘는다.
      const others = gaps.filter((_, gi) => gi !== cutAt - 1).sort((a, b) => a - b);
      const medGap = others.length ? quantileSorted(others, 0.5) : 0;
      const ratio = medGap > 0 ? bestGap / medGap : Infinity;
      if (cutAt > 0 && bestGap > 0.3 && ratio > 3) {
        const assign = new Array(n).fill(0);
        for (let i = cutAt; i < n; i++) assign[idx[i][1]] = 1;  // 1 = 밝은 쪽
        ev.levels = { assign, gap: bestGap, ratio, strength: ratio > 6 ? "강함" : "보통",
          note: `프레임 밝기가 두 준위로 갈라집니다 (간격 ${bestGap.toFixed(2)} oct, 다음 간격의 ${ratio.toFixed(1)}배)` };
      } else {
        ev.levelsNote = `프레임 밝기가 두 준위로 갈라지지 않습니다 (최대 간격 ${isFinite(bestGap) ? bestGap.toFixed(2) : "–"} oct, 다음 간격의 ${isFinite(ratio) ? ratio.toFixed(1) : "–"}배)`;
      }
    } else ev.levelsNote = "밝기 기준값에 0 이하/비유한 값이 있어 준위 분리를 적용할 수 없습니다";
  }

  // 가설 간 일치 여부
  const hyps = [["file", ev.file], ["schedule", ev.schedule], ["cadence", ev.cadence], ["levels", ev.levels]].filter((h) => h[1]);
  if (hyps.length >= 2) {
    const pairs = [];
    for (let i = 0; i < hyps.length; i++) for (let j = i + 1; j < hyps.length; j++) {
      const a = hyps[i][1].assign, b = hyps[j][1].assign;
      // 한쪽이 제외(-1)로 둔 프레임은 비교 대상이 아니다 — 기준 프레임 유무만 다른
      // 두 가설을 "불일치"로 적으면 실제 충돌과 구별되지 않는다.
      let same = 0, flip = 0, cmp = 0;
      for (let k = 0; k < n; k++) {
        if (a[k] < 0 || b[k] < 0) continue;
        cmp++;
        if (a[k] === b[k]) same++; else flip++;
      }
      pairs.push({ a: hyps[i][0], b: hyps[j][0], nCompared: cmp, agree: cmp > 0 && Math.max(same, flip) === cmp });
    }
    ev.agree = pairs;
    ev.conflict = pairs.some((p) => !p.agree);
  }
  return ev;
}
function mean(a) { let s = 0; for (const v of a) s += v; return s / a.length; }
function spreadOf(a) { if (a.length < 2) return 0; return Math.max.apply(null, a) - Math.min.apply(null, a); }
function fmtN(v) { return Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2); }

/* ------------------------------- contrast --------------------------------- */
/**
 * 두 상태 대비 — **부호중립**. 어느 쪽이 "켜짐"인지 모르는 채로도 쓸 수 있어야 한다.
 *   ratioAB = A/B,  ratioBA = B/A     (둘 다 보고한다)
 *   michelson = (A−B)/(A+B) ∈ [−1, 1]  (대칭·유계 — 방향 해석 없이 크기 비교 가능)
 * 활성화 구조냐 억제 구조냐는 여기서 정하지 않는다. 이름표는 표시 계층의 몫이다.
 */
function contrast(traces, assign, opt) {
  const o = Object.assign({}, opt || {});
  const nRoi = traces.length, nF = nRoi ? traces[0].length : 0;
  const idxA = [], idxB = [];
  for (let k = 0; k < nF; k++) { if (assign[k] === 0) idxA.push(k); else if (assign[k] === 1) idxB.push(k); }
  const rows = [];
  for (let i = 0; i < nRoi; i++) {
    const a = idxA.map((k) => traces[i][k]).filter(isFinite);
    const b = idxB.map((k) => traces[i][k]).filter(isFinite);
    const mA = a.length ? mean(a) : NaN, mB = b.length ? mean(b) : NaN;
    const sA = a.length > 1 ? sd(a) : NaN, sB = b.length > 1 ? sd(b) : NaN;
    rows.push({
      roi: i, nA: a.length, nB: b.length, meanA: mA, meanB: mB, sdA: sA, sdB: sB,
      ratioAB: mB !== 0 ? mA / mB : NaN,
      ratioBA: mA !== 0 ? mB / mA : NaN,
      michelson: (mA + mB) !== 0 ? (mA - mB) / (mA + mB) : NaN,
      log2AB: mA > 0 && mB > 0 ? Math.log2(mA / mB) : NaN,
    });
  }
  const mich = rows.map((r) => r.michelson).filter(isFinite);
  const summary = {
    nRoi, nA: idxA.length, nB: idxB.length,
    michelsonMedian: mich.length ? median(mich) : NaN,
    michelsonIQR: mich.length > 3 ? quantile(mich, 0.75) - quantile(mich, 0.25) : NaN,
    michelsonMin: mich.length ? Math.min.apply(null, mich) : NaN,
    michelsonMax: mich.length ? Math.max.apply(null, mich) : NaN,
    // 방향이 입자마다 갈리는가 — 갈린다면 "전체가 한 방향으로 스위칭"이라는 서술은 틀렸다
    mixedDirection: mich.length ? (mich.some((v) => v > 0.1) && mich.some((v) => v < -0.1)) : false,
  };
  return { rows, summary, idxA, idxB };
}
function sd(a) { const m = mean(a); let s = 0; for (const v of a) s += (v - m) * (v - m); return Math.sqrt(s / (a.length - 1)); }

/* ------------------------- FOV matching (registration) -------------------- */
/**
 * 띠통과(band-pass) 상호상관으로 두 프레임 사이의 **이동량**을 구한다.
 *
 * ── 왜 원본 화소 상관은 못 쓰는가 ──────────────────────────────────────────
 * EM gain 이 걸린 프레임은 산탄잡음이 지배해서, **같은 자리끼리도** 원본 상관계수가
 * 0.07 밖에 안 나온다(실측). 잡음은 상관되지 않으면서 정규화 분모만 키우기 때문이다.
 *
 * ── 왜 띠통과가 필요한가 ───────────────────────────────────────────────────
 * 평활만 하면 조명 포락선(램프·빔의 넓은 밝기 분포)이 상관을 지배한다. 서로 다른
 * 자리끼리도 포락선이 겹쳐 peak 0.43 이 나왔다. σ=1.5 와 σ=8 의 차(DoG)로
 * **PSF 크기의 구조만** 남기면 포락선 기여가 사라진다.
 *
 * ── 반환값을 이분법으로 쓰지 말 것 ─────────────────────────────────────────
 * 실측에서 "다른 자리"로 보였던 두 묶음은 사실 ~65 px 이동한 **부분 겹침**이었다
 * (상관 0.14–0.17 @ (65,−5), 엉뚱한 이동에서는 0.00). 그래서 이 함수는 "같은
 * 자리인가"를 판정하지 않는다 — 이동량과 그 신뢰도(PSR)만 준다. 입자별로 상대가
 * 있는지는 transferRois 가 ROI 단위로 따로 따진다.
 *
 * 2단 탐색: bin 축소 격자(전역) → 원해상도 미세 탐색(ROI 주변 상자만).
 */
function bandpass(img, nx, ny, s1, s2) {
  const a = gaussBlur(img, nx, ny, s1 || 1.5), b = gaussBlur(img, nx, ny, s2 || 8);
  const out = new Float32Array(img.length);
  for (let i = 0; i < out.length; i++) out[i] = a[i] - b[i];
  return out;
}
function binDown(a, nx, ny, bin) {
  const bx = Math.floor(nx / bin), by = Math.floor(ny / bin), out = new Float32Array(bx * by);
  for (let y = 0; y < by; y++) for (let x = 0; x < bx; x++) {
    let s = 0;
    for (let j = 0; j < bin; j++) for (let i = 0; i < bin; i++) s += a[(y * bin + j) * nx + x * bin + i];
    out[y * bx + x] = s / (bin * bin);
  }
  return { a: out, nx: bx, ny: by };
}
function corrAt(A, B, nx, ny, dx, dy, box) {
  const y0 = Math.max(box ? box.y0 : 0, Math.max(0, -dy));
  const y1 = Math.min(box ? box.y1 : ny, Math.min(ny, ny - dy));
  const x0 = Math.max(box ? box.x0 : 0, Math.max(0, -dx));
  const x1 = Math.min(box ? box.x1 : nx, Math.min(nx, nx - dx));
  let s = 0, na = 0, nb = 0;
  for (let y = y0; y < y1; y++) {
    const ra = y * nx, rb = (y + dy) * nx;
    for (let x = x0; x < x1; x++) { const u = A[ra + x], v = B[rb + x + dx]; s += u * v; na += u * u; nb += v * v; }
  }
  return s / (Math.sqrt(na * nb) || 1e-9);
}
function registerShift(imgA, imgB, nx, ny, opt) {
  const o = Object.assign({ maxShift: 64, bin: 4, s1: 1.5, s2: 8, roisA: null, margin: 40, psrMin: 6 }, opt || {});
  const A = bandpass(imgA, nx, ny, o.s1, o.s2), B = bandpass(imgB, nx, ny, o.s1, o.s2);
  const ba = binDown(A, nx, ny, o.bin), bb = binDown(B, nx, ny, o.bin);
  const m = Math.max(1, Math.round(o.maxShift / o.bin));
  const surf = [];
  for (let dy = -m; dy <= m; dy++) for (let dx = -m; dx <= m; dx++)
    surf.push({ dx, dy, c: corrAt(ba.a, bb.a, ba.nx, ba.ny, dx, dy, null) });
  surf.sort((p, q) => q.c - p.c);
  const top = surf[0];
  const side = surf.filter((r) => Math.hypot(r.dx - top.dx, r.dy - top.dy) > 3);
  const sm = side.length ? side.reduce((a, r) => a + r.c, 0) / side.length : 0;
  const ssd = side.length ? Math.sqrt(side.reduce((a, r) => a + (r.c - sm) * (r.c - sm), 0) / side.length) : 0;
  const psr = ssd > 0 ? (top.c - sm) / ssd : NaN;
  let box = null;
  if (o.roisA && o.roisA.length) {
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const r of o.roisA) {
      const x = r.xc != null ? r.xc : r.x, y = r.yc != null ? r.yc : r.y;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    box = { x0: Math.max(0, Math.floor(x0 - o.margin)), x1: Math.min(nx, Math.ceil(x1 + o.margin)),
      y0: Math.max(0, Math.floor(y0 - o.margin)), y1: Math.min(ny, Math.ceil(y1 + o.margin)) };
  }
  const cx = top.dx * o.bin, cy = top.dy * o.bin, w = o.bin + 2;
  let best = { c: -Infinity, dx: cx, dy: cy };
  for (let dy = cy - w; dy <= cy + w; dy++) for (let dx = cx - w; dx <= cx + w; dx++) {
    const c = corrAt(A, B, nx, ny, dx, dy, box);
    if (c > best.c) best = { c, dx, dy };
  }
  const nulls = [[120, 120], [-150, 90], [200, -60], [90, -200]]
    .map(([dx, dy]) => corrAt(A, B, nx, ny, dx, dy, box)).filter(isFinite);
  const nullMean = nulls.length ? nulls.reduce((a, b) => a + b, 0) / nulls.length : 0;
  const ok = isFinite(psr) && psr >= o.psrMin;
  return {
    dx: best.dx, dy: best.dy, peak: best.c, coarsePeak: top.c, psr, sideMean: sm, sideSd: ssd,
    nullLevel: nullMean, box, ok,
    why: ok ? "" : `이동량을 확정할 수 없습니다 — 상관 봉우리가 배경 대비 ${isFinite(psr) ? psr.toFixed(1) : "–"}σ 로 기준 ${o.psrMin}σ 에 못 미칩니다. 겹치는 영역이 없거나 이동량이 ±${o.maxShift} px 를 넘습니다.`,
  };
}
/**
 * ROI 를 다른 프레임으로 옮기고 **입자별로** 상대가 실제로 있는지 따진다.
 * 전역 "같은 자리인가" 판정 하나로 뭉뚱그리지 않는 이유: 시야가 조금만 이동해도
 * 일부 입자만 넘어오고 일부는 밖으로 나간다. 그 경계를 흐리면 "사라진 입자"와
 * "화면 밖으로 나간 입자"가 구별되지 않는다.
 */
function transferRois(rois, shift, imgB, nx, ny, opt) {
  const o = Object.assign({ r: 3, rin: 5, rout: 9, kSig: 3, sigmaBlank: null }, opt || {});
  const moved = rois.map((r) => ({
    xc: (r.xc != null ? r.xc : r.x) + shift.dx,
    yc: (r.yc != null ? r.yc : r.y) + shift.dy,
  }));
  const inside = moved.map((p) => p.xc >= o.rout && p.yc >= o.rout && p.xc < nx - o.rout && p.yc < ny - o.rout);
  const probe = moved.map((p, i) => (inside[i] ? p : { xc: o.rout, yc: o.rout }));
  const ph = photometry(imgB, nx, ny, probe, { r: o.r, rin: o.rin, rout: o.rout });
  const sig = isFinite(o.sigmaBlank) && o.sigmaBlank > 0 ? o.sigmaBlank : NaN;
  return rois.map((r, i) => ({
    roi: i, x: moved[i].xc, y: moved[i].yc, inside: inside[i],
    sum: inside[i] ? ph[i].sum : NaN,
    snr: inside[i] && isFinite(sig) ? ph[i].sum / sig : NaN,
    detected: inside[i] && isFinite(sig) ? ph[i].sum > o.kSig * sig : null,
    note: inside[i] ? "" : "이동 후 화면 밖 — 없어진 것이 아니라 시야를 벗어났습니다",
  }));
}

/**
 * 두 이미지가 **같은 자리인지** 입자 배치(별자리)로 판정하고, 맞다면 정수 이동량을 준다.
 *
 * 상관계수로 판정하면 안 된다 — EM gain 이 걸린 프레임은 산탄잡음이 지배해서
 * 같은 자리끼리도 r ≈ 0.07 밖에 안 나온다(실측). 반면 입자 좌표는 잡음에 강하다.
 *
 * 후보 이동량은 "A 의 밝은 점 하나 ↔ B 의 밝은 점 하나" 쌍에서만 만들고, 각 후보에
 * 대해 tol 안에서 짝이 맞는 점 수(inlier)를 센다. inlier 가 minInliers 미만이면
 * **판정 보류**로 돌려준다 — 다른 자리를 억지로 겹쳐 비교하는 것이 이 기능에서
 * 나올 수 있는 최악의 허위 경보다.
 */
function matchConstellation(spotsA, spotsB, opt) {
  const o = Object.assign({ tol: 2.5, maxShift: 80, topK: 12, minInliers: 3 }, opt || {});
  const A = spotsA.slice(0, Math.max(o.topK, 4)), B = spotsB.slice(0, Math.max(o.topK, 4));
  const px = (s) => (s.xc != null ? s.xc : s.x), py = (s) => (s.yc != null ? s.yc : s.y);
  let best = { dx: 0, dy: 0, inliers: 0, rms: NaN };
  for (const a of A) for (const b of B) {
    const dx = px(b) - px(a), dy = py(b) - py(a);
    if (Math.abs(dx) > o.maxShift || Math.abs(dy) > o.maxShift) continue;
    let inl = 0, se = 0;
    for (const p of spotsA) {
      const tx = px(p) + dx, ty = py(p) + dy;
      let bd = Infinity;
      for (const q of spotsB) {
        const ex = px(q) - tx, ey = py(q) - ty;
        const d = ex * ex + ey * ey;
        if (d < bd) bd = d;
      }
      if (bd <= o.tol * o.tol) { inl++; se += bd; }
    }
    if (inl > best.inliers) best = { dx, dy, inliers: inl, rms: inl ? Math.sqrt(se / inl) : NaN };
  }
  best.nA = spotsA.length; best.nB = spotsB.length;
  best.ok = best.inliers >= o.minInliers;
  best.minInliers = o.minInliers;
  best.why = best.ok ? "" :
    `같은 자리로 볼 근거가 부족합니다 — 겹치는 입자 ${best.inliers}개 (기준 ${o.minInliers}개 이상). 다른 시야이거나 이동량이 ±${o.maxShift} px 를 넘습니다.`;
  return best;
}

/* ------------------------------ difference -------------------------------- */
/**
 * 차영상. 두 프레임(또는 두 상태 평균)의 차 + σ 단위 환산.
 *
 * σ 는 **같은 상태 프레임쌍의 차**에서만 경험적으로 잰다. 같은 상태 프레임이
 * 두 장 미만이면 σ 를 만들 근거가 없으므로 null 을 돌려주고 σ 모드를 막는다.
 * 여기서 광자전달 모형을 가정해 σ 를 지어내면, EM gain 초과잡음(이론상 √2 배,
 * 실제 게인에 따라 다름) 때문에 유의성이 체계적으로 부풀려진다.
 */
function difference(imgA, imgB) {
  const n = imgA.length, out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = imgA[i] - imgB[i];
  const st = robustStats(out);
  return { img: out, median: st.median, sigma: st.sigma };
}
/** 같은 상태 프레임쌍의 차로 화소 잡음 σ 를 잰다. 차의 σ 를 √2 로 나눈다. */
function noiseFromPair(imgA, imgB) {
  const d = difference(imgA, imgB);
  return d.sigma / Math.SQRT2;
}

/* ------------------------------ display prep ------------------------------ */
/** 표시용 0–255 환산. mode: lin | log | sqrt. lo/hi 는 원본 단위. */
function scaleToBytes(img, lo, hi, mode) {
  const n = img.length, out = new Uint8ClampedArray(n);
  const span = hi - lo;
  if (!(span > 0)) return out;
  if (mode === "log") {
    const d = Math.log1p(span);
    for (let i = 0; i < n; i++) { const v = img[i] - lo; out[i] = v <= 0 ? 0 : 255 * Math.log1p(v) / d; }
  } else if (mode === "sqrt") {
    const d = Math.sqrt(span);
    for (let i = 0; i < n; i++) { const v = img[i] - lo; out[i] = v <= 0 ? 0 : 255 * Math.sqrt(v) / d; }
  } else {
    for (let i = 0; i < n; i++) out[i] = 255 * (img[i] - lo) / span;
  }
  return out;
}
/** 발산 표시용: −m..+m 을 0..255 로, 0 이 128 에 오도록. */
function scaleDiverging(img, m) {
  const n = img.length, out = new Uint8ClampedArray(n);
  if (!(m > 0)) return out;
  for (let i = 0; i < n; i++) out[i] = 128 + 127 * Math.max(-1, Math.min(1, img[i] / m));
  return out;
}

return {
  quantile, median, robustStats, percentiles,
  gaussBlur, accMax, accSum, scaleInPlace,
  detectSpots, photometry, blankNoise,
  commonMode, stateEvidence, contrast, modulationDepth, selectivity, suggestTarget,
  matchConstellation, registerShift, transferRois, bandpass, difference, noiseFromPair,
  scaleToBytes, scaleDiverging,
};
});

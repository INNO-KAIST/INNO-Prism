/* =============================================================================
 * PrismFit 2.0 — Power-dependence non-linearity engine, built from first
 * principles. Self-contained (no dependency on the legacy engine).
 *
 * DESIGN
 * ------
 * The physically meaningful object for a power scan is the local log–log slope
 * function  s(x) = d log10 I_signal / d log10 P  (x = log10 P). The reported
 * quantities — non-linearity order, avalanche threshold, saturation — are all
 * functionals of s(x). The engine estimates s(x) by two independent routes and
 * cross-checks them:
 *
 *  A. NONPARAMETRIC LAYER (assumption-light, field standard):
 *     penalized B-spline (P-spline, Eilers–Marx 1996) of y = glog10(I) vs x,
 *     optional monotone shape constraint via asymmetric penalty (Bollaerts
 *     2006), smoothing λ chosen by GCV; s_tot(x) is the analytic derivative.
 *
 *  B. PARAMETRIC LAYER (interpretable, strictly nested → no cross-family
 *     model-selection instability):
 *       I(P) = B + 10^{h(x)}
 *       H0: h = c + k1·x                                   (pure power law)
 *       H1: h = c + k1·x + (k2−k1)·w·ln(1+e^{(x−t1)/w})    (one slope change)
 *       H2: H1 − (k2−k3)·v·ln(1+e^{(x−t2)/v})              (rise then fall)
 *     giving the analytic slope
 *       s_sig(x) = k1 + (k2−k1)·σ((x−t1)/w) − (k2−k3)·σ((x−t2)/v).
 *     H0 ⊂ H1 ⊂ H2; order chosen by small-sample AICc with a parsimony guard
 *     (a more complex order must win by ΔAICc > 4). The family spans every
 *     physically expected shape: pure power law, saturating, avalanche
 *     S-curve — with an additive background B (dark counts / baseline).
 *
 * NOISE MODEL (estimated from data, never assumed):
 *   Var(I) ≈ a0² + a1·I + (a2·I)²   (additive + shot + multiplicative)
 *   from replicate variances when available, else from difference-based
 *   pseudo-residuals (Gasser–Sroka–Jennen). Fitting is done on the
 *   generalized log  glog10(I) = log10((I+√(I²+λ²))/2), λ = 3·a0: identical
 *   to log10 I for I ≫ λ but well-defined and variance-stabilized near/below
 *   zero (EMCCD baseline-subtracted data). Weights 1/σ_g² by the delta
 *   method; Huber IRLS (c = 1.345) gives outlier resistance in both layers.
 *
 * UNCERTAINTY: seeded residual bootstrap (studentized residuals resampled and
 * rescaled by the local σ) → CIs for s_max, P_threshold, P_saturation, B, and
 * a pointwise band for s(x). Fully reproducible.
 *
 * DIAGNOSTICS: Wald–Wolfowitz runs test on x-ordered residual signs, reduced
 * chi², robust (sandwich) parameter covariance → identifiability, and
 * spline↔parametric s_max / threshold agreement. Quality score has fully
 * transparent arithmetic (documented in evaluate()).
 * ========================================================================== */
"use strict";
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PrismFit = api;
})(typeof self !== "undefined" ? self : this, function () {

const VERSION = "2.2.0";
const LN10 = Math.log(10);

/* ------------------------------ small utils ------------------------------- */
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
function finite(arr) { const o = []; for (const v of arr) if (isFinite(v)) o.push(v); return o; }
function median(arr) {
  const a = finite(arr); if (!a.length) return NaN;
  a.sort((x, y) => x - y); const m = a.length >> 1;
  return a.length % 2 ? a[m] : 0.5 * (a[m - 1] + a[m]);
}
function mad(arr) {
  const m = median(arr); if (!isFinite(m)) return NaN;
  return 1.4826 * median(arr.map((v) => Math.abs(v - m)));
}
function mean(arr) { const a = finite(arr); return a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN; }
function quantile(arr, q) {
  const a = finite(arr); if (!a.length) return NaN;
  a.sort((x, y) => x - y);
  const i = (a.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? a[lo] : a[lo] + (a[hi] - a[lo]) * (i - lo);
}
function softplus(u) { return u > 30 ? u : Math.log1p(Math.exp(u)); }
function invSoftplus(k) { return k > 30 ? k : Math.log(Math.expm1(Math.max(k, 1e-12))); }
function sigmoid(z) { return z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)); }
function makeRng(seed) {
  let a = seed >>> 0;
  const u = () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  let sp = null;
  const normal = () => { if (sp !== null) { const v = sp; sp = null; return v; } let u1; do { u1 = u(); } while (u1 <= 1e-12); const u2 = u(); const r = Math.sqrt(-2 * Math.log(u1)); sp = r * Math.sin(2 * Math.PI * u2); return r * Math.cos(2 * Math.PI * u2); };
  return { uniform: u, normal, int: (n) => Math.floor(u() * n) };
}
function solveLinear(A, b) {
  const n = b.length, M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-300) return null;
    if (p !== c) { const t = M[p]; M[p] = M[c]; M[c] = t; }
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      if (!f) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}
function invSym(A) {
  const n = A.length;
  for (let att = 0; att < 4; att++) {
    const lam = att === 0 ? 0 : Math.pow(10, -10 + 3 * att) * (1 + Math.abs(A[0][0]));
    const cols = []; let ok = true;
    for (let j = 0; j < n; j++) {
      const e = new Array(n).fill(0); e[j] = 1;
      const x = solveLinear(A.map((r, i) => r.map((v, k) => v + (i === k ? lam : 0))), e);
      if (!x || x.some((v) => !isFinite(v))) { ok = false; break; }
      cols.push(x);
    }
    if (ok) { const inv = []; for (let i = 0; i < n; i++) { inv.push(new Array(n)); for (let j = 0; j < n; j++) inv[i][j] = cols[j][i]; } return inv; }
  }
  return null;
}
/** Levenberg–Marquardt with box clamp. */
function lm(residFn, t0, lo, hi, opts) {
  const maxIter = opts?.maxIter ?? 200, ftol = opts?.ftol ?? 1e-12;
  const np = t0.length;
  let th = t0.map((v, i) => clamp(v, lo[i], hi[i]));
  let r = residFn(th);
  let cost = r.reduce((s, v) => s + v * v, 0);
  if (!isFinite(cost)) return { theta: th, cost: Infinity, iter: 0 };
  let lambda = 1e-3;
  for (let it = 0; it < maxIter; it++) {
    const m = r.length, J = [];
    for (let j = 0; j < np; j++) {
      const hstep = Math.max(Math.abs(th[j]) * 1e-7, 1e-9);
      const tp = th.slice();
      tp[j] = clamp(th[j] + hstep, lo[j], hi[j]);
      const he = tp[j] - th[j];
      if (Math.abs(he) < 1e-15) { J.push(new Array(m).fill(0)); continue; }
      const rp = residFn(tp), col = new Array(m);
      for (let i = 0; i < m; i++) col[i] = (rp[i] - r[i]) / he;
      J.push(col);
    }
    const JtJ = [], Jtr = new Array(np).fill(0);
    for (let a = 0; a < np; a++) { JtJ.push(new Array(np).fill(0)); for (let i = 0; i < m; i++) Jtr[a] += J[a][i] * r[i]; }
    for (let a = 0; a < np; a++) for (let b = a; b < np; b++) {
      let s = 0; for (let i = 0; i < m; i++) s += J[a][i] * J[b][i];
      JtJ[a][b] = s; JtJ[b][a] = s;
    }
    let improved = false;
    for (let att = 0; att < 8; att++) {
      const A = JtJ.map((row, a) => row.map((v, b) => v + (a === b ? lambda * Math.max(v, 1e-12) : 0)));
      const d = solveLinear(A, Jtr.map((v) => -v));
      if (!d || d.some((v) => !isFinite(v))) { lambda *= 10; continue; }
      const tn = th.map((v, i) => clamp(v + d[i], lo[i], hi[i]));
      const rn = residFn(tn);
      const cn = rn.reduce((s, v) => s + v * v, 0);
      if (isFinite(cn) && cn < cost) {
        const rel = (cost - cn) / Math.max(cost, 1e-300);
        th = tn; r = rn; cost = cn; lambda = Math.max(lambda / 3, 1e-12); improved = true;
        if (rel < ftol) return { theta: th, cost, iter: it + 1 };
        break;
      }
      lambda *= 10;
      if (lambda > 1e13) break;
    }
    if (!improved) break;
  }
  return { theta: th, cost, iter: maxIter };
}

/* --------------------------- generalized log ------------------------------ */
function glog10(I, lam) { return Math.log10(Math.max(0.5 * (I + Math.sqrt(I * I + lam * lam)), 1e-300)); }
function dglog10(I, lam) { return 1 / (LN10 * Math.sqrt(I * I + lam * lam)); }

/* ----------------------------- variance model ----------------------------- */
function estimateVarianceModel(x, I, reps) {
  const n = I.length;
  let ptVar = new Array(n).fill(NaN);
  let source;
  const hasReps = reps && reps.some((r) => r && finite(r).length >= 2);
  if (hasReps) {
    source = "replicates";
    for (let i = 0; i < n; i++) {
      const r = reps[i] ? finite(reps[i]) : [];
      if (r.length >= 2) {
        const m = r.reduce((s, v) => s + v, 0) / r.length;
        ptVar[i] = r.reduce((s, v) => s + (v - m) * (v - m), 0) / (r.length - 1);
      }
    }
  } else {
    source = "difference-based";
    const ord = Array.from({ length: n }, (_, i) => i).sort((a, b) => x[a] - x[b]);
    for (let k = 1; k < n - 1; k++) {
      const e = (I[ord[k - 1]] - 2 * I[ord[k]] + I[ord[k + 1]]) / Math.sqrt(6);
      ptVar[ord[k]] = e * e; // 1-dof; pooled fit below smooths it
    }
  }
  const pts = [];
  for (let i = 0; i < n; i++) if (isFinite(ptVar[i]) && ptVar[i] > 0 && isFinite(I[i])) pts.push([Math.max(I[i], 0), ptVar[i]]);
  const law = fitVarianceLaw(pts, I, ptVar, source);
  // v2.6: 반복 분산은 자유도가 (nRep−1) 뿐이라 개별 추정이 매우 시끄럽고,
  // log-분산 최소제곱이 전체 스케일을 크게 빗나갈 수 있다(합성 검증에서 4.5배 관측).
  // 법칙은 '모양'만 제공하고 전체 스케일은 데이터가 다시 못박게 한다 —
  // 파일럿 residual 경로가 이미 쓰는 것과 같은 보정이다.
  // 보정 기준: median(χ²_ν/ν) (ν = nRep−1). ν≤0 이거나 점이 적으면 보정하지 않는다.
  if (source === "replicates" && pts.length >= 6) {
    const nu = Math.max(median(reps.map((r) => Math.max(finite(r || []).length, 1))) - 1, 1);
    const medChi = 1 - 2 / (9 * nu);                       // Wilson–Hilferty 근사
    const ratios = [];
    for (const [Ii, v] of pts) {
      const lv = law.sigmaOfI(Ii);
      if (isFinite(lv) && lv > 0) ratios.push(v / (lv * lv));
    }
    const c = ratios.length ? clamp((median(ratios) || medChi) / medChi, 0.05, 20) : 1;
    if (isFinite(c) && Math.abs(Math.log(c)) > 0.05) {
      law.a0 *= Math.sqrt(c); law.a1 *= c; law.a2 *= Math.sqrt(c);
      const A0 = law.a0, A1 = law.a1, A2 = law.a2;
      law.sigmaOfI = (Ii) => Math.sqrt(Math.max(A0 * A0 + A1 * Math.max(Ii, 0) + A2 * A2 * Ii * Ii, 1e-300));
      law.scaleCal = c;
    }
  }
  return law;
}
/** Robust fit of Var(I) = a0² + a1·I + (a2·I)² to (I, var) points. */
function fitVarianceLaw(pts, I, ptVar, source) {
  let a0 = 0, a1 = 0, a2 = 0;
  if (pts.length >= 4) {
    const resid = (th) => {
      const A0 = softplus(th[0]), A1 = softplus(th[1]), A2 = softplus(th[2]);
      return pts.map(([Ii, v]) => Math.log(Math.max(v, 1e-300)) - Math.log(Math.max(A0 * A0 + A1 * Ii + A2 * A2 * Ii * Ii, 1e-300)));
    };
    const vLo = Math.sqrt(Math.max(quantile(pts.map((p) => p[1]), 0.15), 1e-300));
    const relHi = Math.sqrt(Math.max(quantile(pts.map((p) => p[1] / Math.max(p[0] * p[0], 1e-300)), 0.85), 1e-300));
    const s0 = [invSoftplus(Math.max(vLo, 1e-9)), invSoftplus(1e-9), invSoftplus(Math.max(relHi, 1e-6))];
    const starts = [s0,
      [s0[0], invSoftplus(Math.max(vLo, 1e-9)), invSoftplus(1e-6)],
      [invSoftplus(1e-9), invSoftplus(1e-9), s0[2]],
      [s0[0], invSoftplus(1e-9), invSoftplus(1e-9)]];
    let best = null;
    for (const s of starts) {
      const r = lm(resid, s, s.map(() => -45), s.map(() => 45), { maxIter: 150 });
      if (!best || r.cost < best.cost) best = r;
    }
    a0 = softplus(best.theta[0]); a1 = softplus(best.theta[1]); a2 = softplus(best.theta[2]);
  } else {
    const scale = mad(I) || Math.abs(median(I)) || 1;
    a0 = 0.02 * scale; a2 = 0.05;
  }
  const sigmaOfI = (Ii) => Math.sqrt(Math.max(a0 * a0 + a1 * Math.max(Ii, 0) + a2 * a2 * Ii * Ii, 1e-300));
  return { a0, a1, a2, sigmaOfI, ptVar, source };
}

/* ------------------------- B-spline (Cox–de Boor) -------------------------- */
function makeSplineBasis(xlo, xhi, nseg, deg) {
  const dx = (xhi - xlo) / nseg;
  const knots = [];
  for (let i = -deg; i <= nseg + deg; i++) knots.push(xlo + i * dx);
  const m = nseg + deg;
  function evalBasis(xv, derivative) {
    // returns array of m basis (or derivative) values at xv
    const x = clamp(xv, xlo, xhi);
    const out = new Array(m).fill(0);
    // zeroth order
    let N = new Array(knots.length - 1).fill(0);
    // half-open segments; make the last knot inclusive
    // 정확히 하나의 구간만 켜져야 한다 (partition of unity).
    // x === xhi 에서 특례와 일반 규칙이 동시에 참이 되면 기저 합이 2가 되고,
    // 그 행이 설계행렬에 들어가면 최소제곱해가 우측 deg+1 span에 걸쳐 오염된다.
    for (let i = 0; i < knots.length - 1; i++) {
      if (x >= knots[i] && x < knots[i + 1]) { N[i] = 1; break; }
    }
    if (x >= xhi) {
      N.fill(0);
      for (let i = 0; i < knots.length - 1; i++) {
        if (Math.abs(knots[i + 1] - xhi) < 1e-12 && knots[i] < xhi) { N[i] = 1; break; }
      }
    }
    for (let d = 1; d <= deg; d++) {
      const Nn = new Array(knots.length - 1 - d).fill(0);
      for (let i = 0; i < Nn.length; i++) {
        const den1 = knots[i + d] - knots[i], den2 = knots[i + d + 1] - knots[i + 1];
        if (derivative && d === deg) {
          const t1 = den1 > 0 ? d / den1 * N[i] : 0;
          const t2 = den2 > 0 ? d / den2 * N[i + 1] : 0;
          Nn[i] = t1 - t2;
        } else {
          const t1 = den1 > 0 ? (x - knots[i]) / den1 * N[i] : 0;
          const t2 = den2 > 0 ? (knots[i + d + 1] - x) / den2 * N[i + 1] : 0;
          Nn[i] = t1 + t2;
        }
      }
      N = Nn;
    }
    for (let i = 0; i < m; i++) out[i] = N[i] || 0;
    return out;
  }
  return { m, dx, evalBasis, xlo, xhi };
}
function diffMatrix(m, order) {
  // order-th difference matrix ((m-order) × m)
  let D = [];
  for (let i = 0; i < m - 1; i++) { const row = new Array(m).fill(0); row[i] = -1; row[i + 1] = 1; D.push(row); }
  for (let o = 2; o <= order; o++) {
    const D2 = [];
    for (let i = 0; i < D.length - 1; i++) {
      const row = new Array(m).fill(0);
      for (let j = 0; j < m; j++) row[j] = D[i + 1][j] - D[i][j];
      D2.push(row);
    }
    D = D2;
  }
  return D;
}
/**
 * Weighted P-spline with optional monotone constraint.
 * x, y, w (weights = 1/σ²). Returns {coef, fitAt, slopeAt, edf, gcv, lambda}.
 */
function fitPSpline(x, y, w, opts) {
  const n = x.length;
  const gcvStep = opts && opts.fast ? 1.0 : 0.5;
  const nseg = clamp(Math.floor(n / 4), 6, 22);
  const deg = 3;
  const xlo = Math.min(...x), xhi = Math.max(...x);
  const basis = makeSplineBasis(xlo, xhi, nseg, deg);
  const m = basis.m;
  const B = x.map((xv) => basis.evalBasis(xv, false));
  const D = diffMatrix(m, 2);
  const D1 = diffMatrix(m, 1);
  // precompute BtWB, BtWy
  const BtWB = [], BtWy = new Array(m).fill(0);
  for (let a = 0; a < m; a++) BtWB.push(new Array(m).fill(0));
  for (let i = 0; i < n; i++) {
    const bi = B[i], wi = w[i];
    for (let a = 0; a < m; a++) {
      if (!bi[a]) continue;
      BtWy[a] += wi * bi[a] * y[i];
      for (let b = a; b < m; b++) {
        if (!bi[b]) continue;
        BtWB[a][b] += wi * bi[a] * bi[b];
      }
    }
  }
  for (let a = 0; a < m; a++) for (let b = 0; b < a; b++) BtWB[a][b] = BtWB[b][a];
  const DtD = [];
  for (let a = 0; a < m; a++) DtD.push(new Array(m).fill(0));
  for (const row of D) for (let a = 0; a < m; a++) {
    if (!row[a]) continue;
    for (let b = 0; b < m; b++) if (row[b]) DtD[a][b] += row[a] * row[b];
  }
  const scaleRef = Math.max(...BtWB.map((r, i) => r[i])) || 1;
  const solveFor = (lambda, extraPen) => {
    const A = BtWB.map((row, a) => row.map((v, b) => v + lambda * DtD[a][b] + (extraPen ? extraPen[a][b] : 0)));
    return solveLinear(A, BtWy);
  };
  const edfFor = (lambda) => {
    // trace of hat matrix: sum_j [ (A^-1 BtWB)_jj ]
    const A = BtWB.map((row, a) => row.map((v, b) => v + lambda * DtD[a][b]));
    const Ainv = invSym(A);
    if (!Ainv) return NaN;
    let tr = 0;
    for (let a = 0; a < m; a++) for (let b = 0; b < m; b++) tr += Ainv[a][b] * BtWB[b][a];
    return tr;
  };
  // GCV over λ grid (relative to problem scale)
  let bestLam = null, bestGcv = Infinity;
  const grid = [];
  for (let e = -5; e <= 6; e += gcvStep) grid.push(Math.pow(10, e) * scaleRef * 1e-4);
  const lamOverride = opts && isFinite(opts.lambdaFactor) ? opts.lambdaFactor : 1;
  if (opts && isFinite(opts.targetEdf)) {
    // deterministic pilot mode: pick λ whose edf is closest to the target
    let bl = grid[0], bd = Infinity;
    for (const lamv of grid) {
      const ed = edfFor(lamv);
      if (!isFinite(ed)) continue;
      const dd = Math.abs(ed - opts.targetEdf);
      if (dd < bd) { bd = dd; bl = lamv; }
    }
    bestLam = bl / Math.max(lamOverride, 1e-12); // neutralize override below
  }
  for (const lamv of (opts && isFinite(opts.targetEdf) ? [] : grid)) {
    const c = solveFor(lamv, null);
    if (!c) continue;
    let rss = 0;
    for (let i = 0; i < n; i++) {
      let f = 0;
      const bi = B[i];
      for (let a = 0; a < m; a++) if (bi[a]) f += bi[a] * c[a];
      const r = y[i] - f;
      rss += w[i] * r * r;
    }
    const edf = edfFor(lamv);
    if (!isFinite(edf) || edf >= n - 1) continue;
    const gcv = (n * rss) / ((n - edf) * (n - edf));
    if (gcv < bestGcv) { bestGcv = gcv; bestLam = lamv; }
  }
  if (bestLam == null) bestLam = scaleRef * 1e-3;
  const lambda = bestLam * lamOverride;
  // monotone constraint via asymmetric penalty on negative 1st differences
  let coef = solveFor(lambda, null);
  if (opts && opts.monotone && coef) {
    const kappa = 1e4 * scaleRef;
    for (let it = 0; it < 20; it++) {
      const pen = [];
      for (let a = 0; a < m; a++) pen.push(new Array(m).fill(0));
      let nViol = 0;
      for (const row of D1) {
        let d = 0;
        for (let a = 0; a < m; a++) if (row[a]) d += row[a] * coef[a];
        if (d < 0) {
          nViol++;
          for (let a = 0; a < m; a++) {
            if (!row[a]) continue;
            for (let b = 0; b < m; b++) if (row[b]) pen[a][b] += kappa * row[a] * row[b];
          }
        }
      }
      if (!nViol) break;
      const c2 = solveFor(lambda, pen);
      if (!c2) break;
      coef = c2;
    }
  }
  const edf = edfFor(lambda);
  const fitAt = (xv) => {
    const b = basis.evalBasis(xv, false);
    let f = 0;
    for (let a = 0; a < m; a++) if (b[a]) f += b[a] * coef[a];
    return f;
  };
  const slopeAt = (xv) => {
    const b = basis.evalBasis(xv, true);
    let f = 0;
    for (let a = 0; a < m; a++) if (b[a]) f += b[a] * coef[a];
    return f;
  };
  return { coef, fitAt, slopeAt, edf, gcv: bestGcv, lambda, basis };
}

/* ----------------------- parametric hinge models --------------------------- */
/* θ parameterization (unconstrained):
   H0: [c, u1]                      k1=softplus(u1)
   H1: [c, u1, u2, t1, uw]         k2=softplus(u2), w=0.02+softplus(uw)... width via softplus+floor
   H2: [c, u1, u2, u3, t1, ud, uw, uv]  t2=t1+0.02+softplus(ud)
   B handled separately: uB with B=softplus(uB) (scaled). Full θ = [uB, ...].
*/
const H_NPARAMS = { 0: 3, 1: 6, 2: 9 };
/* v2.6 (E4): transition width w 의 lower bound. 0.02 는 실측 점화 전선(0.01 dec 급)보다 3–4배 넓어
   s_max 를 데이터가 아니라 제약이 결정하게 만들었다. lower bound를 낮추는 대신
   analyze() 에서 "격자보다 좁은 전이" 게이트와 boundHits 경고를 함께 낸다. */
const W_FLOOR_DEFAULT = 0.005;
const W_FLOOR = { v: W_FLOOR_DEFAULT };
const THETA_BOX = 60;
/** 차수별 θ 인덱스 중 '기울기'(softplus 인자)인 것들 — 프로파일 우도에서 upper bound를 거는 대상.
 *  H2 의 기울기 함수 s(x) = k1(1−σ1) + k2(σ1−σ2) + k3σ2 는 σ1 ≥ σ2 이므로
 *  k1·k2·k3 의 볼록결합이다. 따라서 세 값을 모두 X 로 제한하면 s_max ≤ X 가 보장된다 —
 *  이것이 "s_max ≤ X 인 모델 전체"에 대한 제약 최대우도를 구할 수 있는 근거다. */
const SLOPE_IDX = { 0: [2], 1: [2, 3], 2: [2, 3, 4] };
/** 프로파일 우도에서만 허용하는 기울기 파라미터 upper bound(θ 공간). 본 적합의 상자는 THETA_BOX 그대로. */
const SLOPE_BOX_MAX = 2000;
/** 프로파일을 평가할 s_max upper bound 격자와, 기준 χ² 를 얻는 '사실상 무제약' upper bound. */
const PROFILE_CAPS = [2, 4, 8, 15, 30, 60, 120, 250, 500];
const PROFILE_REF_CAP = 1200;
/** χ² 1 자유도 95% 임계값 — 제약 우도비 검정(Δχ² > 3.84 → 해당 upper bound 기각). */
const DCHI2_95 = 3.84;
function unpackH(order, th, scaleB) {
  const WF = W_FLOOR.v;
  const B = softplus(th[0]) * scaleB;
  if (order === 0) {
    return { B, c: th[1], k1: softplus(th[2]), k2: softplus(th[2]), k3: softplus(th[2]), t1: NaN, t2: NaN, w: NaN, v: NaN };
  }
  if (order === 1) {
    const k1 = softplus(th[2]), k2 = softplus(th[3]);
    const w = WF + softplus(th[5]);
    return { B, c: th[1], k1, k2, k3: k2, t1: th[4], t2: NaN, w, v: NaN };
  }
  const k1 = softplus(th[2]), k2 = softplus(th[3]), k3 = softplus(th[4]);
  const w = WF + softplus(th[7]), v = WF + softplus(th[8]);
  const t1 = th[5], t2 = th[5] + WF + softplus(th[6]);
  return { B, c: th[1], k1, k2, k3, t1, t2, w, v };
}
function hOf(p, x, order) {
  let h = p.c + p.k1 * x;
  if (order >= 1) {
    const z = (x - p.t1) / p.w;
    h += (p.k2 - p.k1) * p.w * (z > 30 ? z : Math.log1p(Math.exp(z)));
  }
  if (order >= 2) {
    const z = (x - p.t2) / p.v;
    h -= (p.k2 - p.k3) * p.v * (z > 30 ? z : Math.log1p(Math.exp(z)));
  }
  return h;
}
function slopeOf(p, x, order) {
  let s = p.k1;
  if (order >= 1) s += (p.k2 - p.k1) * sigmoid((x - p.t1) / p.w);
  if (order >= 2) s -= (p.k2 - p.k3) * sigmoid((x - p.t2) / p.v);
  return s;
}
function modelI(p, x, order) { return p.B + Math.pow(10, clamp(hOf(p, x, order), -300, 300)); }

/**
 * v2.7 (G1) — 결정론적 차분진화(Differential Evolution) 전역 탐색.
 *
 * 왜 필요한가: 기존 경로는 스플라인에서 유도한 소수의 결정론적 시작점 + LM 뿐이라
 * 힌지 모델의 다봉(multimodal) 우도면에서 전역해를 놓친다. 실측(WJ-0075c down
 * branch)에서 H1 은 H0 로 붕괴하고 H2 는 χ² 495,441 로 발산해, 엔진이 순수 멱법칙
 * H0(s_max 4.11, 문턱 NaN)를 골랐다. 같은 모델을 전역 탐색으로 적합하면 χ² 5,903
 * (84배 개선)이고 차수 선택도 H2 로 바뀐다.
 *
 * 설계 원칙 3가지:
 *  1) 기존 시작점을 '대체'하지 않고 '추가'한다 — DE 결과와 기존 다중시작 LM 결과 중
 *     비용이 낮은 쪽을 쓰므로, 기존에 잘 되던 파일이 나빠질 수 없다.
 *  2) 완전 결정론 — makeRng(고정 시드)만 쓴다. 시드가 결과를 바꾸면 재현성 기준
 *     ①(시드를 바꿔도 s_max 가 재현되는가)을 스스로 위반하게 된다.
 *  3) 초기 집단에 기존 hingeStarts 를 심는다 — 좋은 출발점을 버리지 않으면서
 *     그 branch(basin) 밖을 탐색한다.
 *
 * DE/rand/1/bin, F=0.7, CR=0.9. 평가 1회는 O(n)이므로 popsize×maxiter 예산이
 * 곧 비용이다. 부트스트랩은 draw 마다 analyze()를 다시 돌리므로(냉시작 원칙)
 * 예산이 150배로 곱해진다 — DE_BUDGET 을 만질 때 반드시 함께 고려할 것.
 */
function deSearch(costFn, lo, hi, seeds, opts) {
  const np = lo.length;
  const o = Object.assign({ popsize: Math.min(10 + 2 * np, 34), maxiter: 160, F: 0.7, CR: 0.9, seed: 20260914 }, opts);
  const NP = Math.max(o.popsize, 5);
  const rng = makeRng(o.seed);
  const clampVec = (v) => v.map((t, j) => clamp(t, lo[j], hi[j]));
  const pop = [], cost = [];
  for (const s of (seeds || []).slice(0, Math.floor(NP / 2))) {
    if (!s || s.length !== np) continue;
    pop.push(clampVec(s.slice()));
  }
  while (pop.length < NP) pop.push(lo.map((l, j) => l + (hi[j] - l) * rng.uniform()));
  for (const v of pop) { const c = costFn(v); cost.push(isFinite(c) ? c : Infinity); }
  let bi = 0;
  for (let i = 1; i < NP; i++) if (cost[i] < cost[bi]) bi = i;
  const trial = new Array(np);
  for (let g = 0; g < o.maxiter; g++) {
    for (let i = 0; i < NP; i++) {
      let a = i, b = i, c = i;
      while (a === i) a = rng.int(NP);
      while (b === i || b === a) b = rng.int(NP);
      while (c === i || c === a || c === b) c = rng.int(NP);
      const jr = rng.int(np);
      for (let j = 0; j < np; j++) {
        trial[j] = (rng.uniform() < o.CR || j === jr)
          ? clamp(pop[a][j] + o.F * (pop[b][j] - pop[c][j]), lo[j], hi[j])
          : pop[i][j];
      }
      const ct = costFn(trial);
      if (isFinite(ct) && ct < cost[i]) {
        pop[i] = trial.slice(); cost[i] = ct;
        if (ct < cost[bi]) bi = i;
      }
    }
  }
  return { theta: pop[bi].slice(), cost: cost[bi] };
}

/**
 * v2.9 — 모델족과 무관한 강건 적합 코어.
 *
 * 왜 뽑아내는가: v2.9 에서 bistable 모델족이 추가되는데 IRLS·다중시작·전역탐색·후보비교는
 * 모델과 무관한 절차다. 복제하면 두 족이 서로 다른 방식으로 최소화되어 AICc 비교가
 * 무의미해진다 — 비교가 성립하려면 **같은 기준으로 최소화된 χ²** 여야 한다.
 * 그래서 코어를 하나로 두고 족마다 `predict(θ) → μ 배열` 과 상자만 바꿔 넣는다.
 *
 * 절차는 v2.7 에서 확정된 것 그대로다:
 *  1) 결정론적 다중시작 LM  2) 전역탐색 DE(같은 기준)  3) 각 후보를 IRLS 전 과정에 통과
 *  4) 공통 마스크 χ² 로 비교 — 차수 선택(AICc)이 소비하는 바로 그 양이다.
 */
function robustFitCore(o) {
  const { n, lo, hi, starts, predict, I, sigG, lamG, huberC, useMask, globalOpts, allowGlobal } = o;
  const TUKEY_C = 4.685;
  /** v3.0 — 선택적 추가 residual 블록(관측된 occupancy 등). **최적화 목적함수에 포함**되고
   *  DE·후보비교도 같은 양을 쓴다 — 최소화하는 것과 비교하는 것이 다르면 차수/후보 선택이
   *  뒤틀린다(v2.7 G1 에서 실측한 실패). 보고용 χ²(AICc 가 소비하는 값)는 호출자가
   *  평균 residual만으로 따로 계산한다. 없으면 이 함수는 이전과 완전히 동일하게 동작한다. */
  const extraResid = typeof o.extraResid === "function" ? o.extraResid : null;
  const extraOf = (th) => {
    if (!extraResid) return null;
    const e = extraResid(th);
    return e && e.length ? e : null;
  };
  /** 표준화 residual (IRLS 가중 이전) */
  const rawOf = (th) => {
    const mu = predict(th);
    const r = new Array(n);
    for (let i = 0; i < n; i++) r[i] = (glog10(I[i], lamG) - glog10(mu[i], lamG)) / sigG[i];
    return r;
  };
  /** 후보 비교·전역 탐색의 단일 기준: 공통 마스크 위의 χ².
   *  강건 기준(Huber)으로 고르면 χ² 가 나빠진 해가 선택되어 차수 선택이 뒤틀린다
   *  (실측: Huber 기준으로 χ² 5,829 → 7,432 로 악화). 이상치 처리는 이 기준이 아니라
   *  상위의 공통 마스크(파일럿 플래그)와 IRLS 가 담당한다. */
  const chi2Common = (th) => {
    const rs = rawOf(th);
    let c = 0;
    for (let i = 0; i < n; i++) if (useMask[i]) c += rs[i] * rs[i];
    const ex = extraOf(th);
    if (ex) for (const v of ex) if (isFinite(v)) c += v * v;
    return isFinite(c) ? c : Infinity;
  };
  /** 한 시작점에서 LM + IRLS 전 과정을 수행 (irlsW 는 이 호출에 지역적) */
  const refine = (theta0) => {
    const irlsW = useMask.map((m) => (m ? 1 : 0));
    const residFn = (th) => {
      const mu = predict(th);
      const r = new Array(n);
      for (let i = 0; i < n; i++) {
        r[i] = Math.sqrt(irlsW[i]) * (glog10(I[i], lamG) - glog10(mu[i], lamG)) / sigG[i];
      }
      const ex = extraOf(th);
      return ex ? r.concat(ex) : r;
    };
    let cur = lm(residFn, theta0, lo, hi, { maxIter: 250, ftol: 1e-12 });
    if (!isFinite(cur.cost)) cur = { theta: theta0.slice(), cost: Infinity };
    for (let pass = 0; pass < 4; pass++) {
      const rs = rawOf(cur.theta);
      const sHat = Math.max(mad(rs.filter((_, i) => useMask[i])) || 1, 1e-9);
      let changed = false;
      for (let i = 0; i < n; i++) {
        if (!useMask[i]) continue;
        const u = Math.abs(rs[i]) / sHat;
        let wNew;
        if (pass === 0) wNew = u <= huberC ? 1 : huberC / u;
        else { const z = u / TUKEY_C; wNew = z >= 1 ? 0 : Math.pow(1 - z * z, 2); }
        if (Math.abs(wNew - irlsW[i]) > 1e-3) changed = true;
        irlsW[i] = wNew;
      }
      if (!changed && pass > 0) break;
      const r = lm(residFn, cur.theta, lo, hi, { maxIter: 150 });
      if (isFinite(r.cost)) cur = r;
    }
    return { theta: cur.theta, irlsW, score: chi2Common(cur.theta) };
  };

  // ── 후보 1: 결정론적 다중시작 LM ──
  let seed0 = null, seedCost = Infinity;
  const residPlain = (th) => {
    const base = rawOf(th).map((r, i) => (useMask[i] ? r : 0));
    const ex = extraOf(th);
    return ex ? base.concat(ex) : base;
  };
  for (const t0 of starts) {
    const r = lm(residPlain, t0, lo, hi, { maxIter: 250, ftol: 1e-12 });
    if (isFinite(r.cost) && r.cost < seedCost) { seedCost = r.cost; seed0 = r.theta; }
  }
  if (!seed0 && starts.length) seed0 = starts[0].slice();
  if (!seed0) return null;
  let outcome = refine(seed0);

  // ── 후보 2: 전역 탐색(DE). 같은 기준으로 평가하고 전 과정을 다시 통과시킨 뒤
  //    최종 점수로 비교한다 → 기존 경로보다 나빠질 수 없다. ──
  if (globalOpts && allowGlobal) {
    const de = deSearch(chi2Common, lo, hi, starts, globalOpts);
    if (isFinite(de.cost)) {
      const alt = refine(de.theta);
      if (alt.score < outcome.score) outcome = alt;
    }
  }
  return { theta: outcome.theta, irlsW: outcome.irlsW, score: outcome.score };
}

/**
 * Robust weighted fit of order H on (x, I) with glog residuals.
 * IRLS: Huber pass then Tukey bisquare passes (redescending → gross outliers
 * get ~0 weight). `mask[i]=false` points are excluded entirely.
 * χ²/AICc are computed on points with final weight ≥ 0.1 (accepted set) so
 * that a few gross outliers cannot poison model comparison.
 */
function fitHinge(order, x, I, sigG, lamG, scaleB, starts, huberC, mask, globalOpts, slopeCap) {
  const n = x.length;
  const useMask = mask || new Array(n).fill(true);
  const np = H_NPARAMS[order];
  const lo = new Array(np).fill(-THETA_BOX), hi = new Array(np).fill(THETA_BOX);
  // 프로파일 우도용: 기울기 파라미터에만 upper bound를 걸어 s_max ≤ slopeCap 인 부분공간으로 제한.
  // slopeCap 이 기본 상자(THETA_BOX)보다 크면 기울기 방향으로만 상자를 넓힌다 — 프로파일의
  // 기준 χ²(사실상 무제약 MLE)를 얻으려면 필요하다. 본 적합 경로는 slopeCap 을 주지 않으므로
  // 영향받지 않는다(본 적합에서 상자를 넓히면 branch 마다 결과가 엇갈리는 것을 실측했다).
  if (isFinite(slopeCap) && slopeCap > 0) {
    const u = clamp(invSoftplus(slopeCap), -THETA_BOX, SLOPE_BOX_MAX);
    for (const j of (SLOPE_IDX[order] || [])) hi[j] = u;
  }
  const xlo = Math.min(...x), xhi = Math.max(...x);
  if (order >= 1) { lo[4] = xlo - 1.5; hi[4] = xhi + 1.5; }
  if (order === 2) { lo[5] = xlo - 1.5; hi[5] = xhi + 1.5; }
  const predictH = (th) => {
    const p = unpackH(order, th, scaleB);
    const mu = new Array(n);
    for (let i = 0; i < n; i++) mu[i] = modelI(p, x[i], order);
    return mu;
  };
  // H0 는 다봉이 아니므로 전역 탐색을 생략한다(v2.7 에서 확정된 조건 그대로).
  const outcome = robustFitCore({ n, lo, hi, starts, predict: predictH, I, sigG, lamG, huberC,
    useMask, globalOpts, allowGlobal: order >= 1 });
  if (!outcome) return null;
  const best = { theta: outcome.theta, cost: outcome.score };
  const irlsW = outcome.irlsW;
  // metrics on the ACCEPTED set (weight ≥ 0.1)
  const p = unpackH(order, best.theta, scaleB);
  const rawResid = new Array(n);
  const accepted = [];
  for (let i = 0; i < n; i++) {
    rawResid[i] = (glog10(I[i], lamG) - glog10(modelI(p, x[i], order), lamG)) / sigG[i];
    if (useMask[i] && irlsW[i] >= 0.1) accepted.push(i);
  }
  let chi2 = 0;
  for (const i of accepted) chi2 += rawResid[i] * rawResid[i];
  const nAcc = accepted.length, k = np;
  const aicc = nAcc > k + 1 ? chi2 + 2 * k + (2 * k * (k + 1)) / (nAcc - k - 1) : Infinity;
  return { order, theta: best.theta, params: p, cost: best.cost, chi2, aicc, k, rawResid, irlsW, accepted, nAccepted: nAcc };
}

/** deterministic starts derived from the spline slope curve */
function hingeStarts(order, x, I, spline, lamG, scaleB, darkPrior, nearStep) {
  const xlo = Math.min(...x), xhi = Math.max(...x);
  const span = Math.max(xhi - xlo, 0.3);
  const grid = [];
  for (let i = 0; i <= 60; i++) grid.push(xlo + span * i / 60);
  const sv = grid.map((xv) => spline.slopeAt(xv));
  const sLo = median(sv.slice(0, 12)), sHi = median(sv.slice(-12));
  let sMax = -Infinity, xMax = grid[0];
  for (let i = 0; i < grid.length; i++) if (sv[i] > sMax) { sMax = sv[i]; xMax = grid[i]; }
  const Imin = Math.max(quantile(I, 0.05), 1e-300);
  const yLow = glog10(Math.max(quantile(I.slice(0, Math.max(3, I.length / 5 | 0)), 0.3), 1e-300), lamG);
  // c: choose so that h(x_mid) matches data mid
  const uB0 = invSoftplus(Math.max(Imin / scaleB, 1e-9));
  const uBsmall = invSoftplus(Math.max(0.05 * Imin / scaleB, 1e-12));
  // v2.6 (E6): 암계수 D 를 알면 배경 B 의 시작값으로 쓴다. B 를 0 근처에서 출발시키면
  // 평탄한 암계수 바닥을 "기울기 0인 멱법칙"(k1→0)으로 표현하게 되어 B↔k1 축퇴가 생긴다.
  const uBdark = isFinite(darkPrior) && darkPrior > 0 ? invSoftplus(Math.max(darkPrior / scaleB, 1e-9)) : null;
  const uBs = uBdark === null ? [uB0, uBsmall] : [uBdark, uB0, uBsmall];
  const mkC = (k1) => yLow - k1 * xlo;
  const S = [];
  if (order === 0) {
    for (const k1 of [Math.max(sMax, 0.2), Math.max(sLo, 0.2), 1, 2]) {
      for (const uB of uBs) S.push([uB, mkC(k1), invSoftplus(k1)]);
    }
  } else if (order === 1) {
    for (const [k1, k2] of [[Math.max(sLo, 0.05), Math.max(sMax, sLo + 0.3)], [Math.max(sMax, 0.3), Math.max(sHi, 0.02)], [1, 3], [2, 0.3]]) {
      for (const t1 of [xMax, xlo + span * 0.35, xlo + span * 0.65]) {
        for (const uB of uBs) {
          S.push([uB, mkC(k1), invSoftplus(k1), invSoftplus(k2), t1, invSoftplus(0.13)]);
        }
      }
    }
  } else {
    const k1c = Math.max(Math.min(sLo, sMax * 0.5), 0.02);
    const k3c = Math.max(Math.min(sHi, sMax * 0.5), 0.02);
    for (const k2 of [Math.max(sMax, 1), Math.max(sMax * 1.4, 2)]) {
      for (const [t1, t2] of [[xMax - 0.35 * span * 0.5, xMax + 0.35 * span * 0.5], [xMax - 0.15, xMax + 0.2], [xlo + 0.3 * span, xlo + 0.7 * span]]) {
        for (const uB of uBs) {
          S.push([uB, mkC(k1c), invSoftplus(k1c), invSoftplus(k2), invSoftplus(k3c), t1, invSoftplus(Math.max(t2 - t1 - W_FLOOR.v, 0.05)), invSoftplus(0.11), invSoftplus(0.11)]);
        }
      }
    }
  }
  // v2.8 — '계단 근방' 시작점 가족 (프로파일 우도 전용, nearStep=true 일 때만).
  // 기존 시작점은 전부 스플라인 기울기에서 유도되는데 스플라인은 격자보다 예리해질 수 없어
  // k₂ 후보가 데이터 분해능에 갇힌다. upper bound를 높게 열어도 시작점이 그 영역에 없으면 못 찾는다.
  // 그래서 실측에서 가장 가파른 '한 스텝'을 찾아 그 위치에 폭이 lower bound인 전이를 심는다.
  // 본 적합 경로에는 넣지 않는다 — 넣었을 때 branch 마다 결과가 엇갈리는 것을 실측했다.
  if (nearStep && order >= 1) {
    let stepBest = -Infinity, xStep = NaN;
    for (let i2 = 0; i2 + 1 < x.length; i2++) {
      const h = x[i2 + 1] - x[i2];
      if (!(h > 0) || !(I[i2] > 0) || !(I[i2 + 1] > 0)) continue;
      const sl = (Math.log10(I[i2 + 1]) - Math.log10(I[i2])) / h;
      if (sl > stepBest) { stepBest = sl; xStep = 0.5 * (x[i2] + x[i2 + 1]); }
    }
    if (isFinite(xStep) && stepBest > 1) {
      const wNear = invSoftplus(Math.max(W_FLOOR.v, 1e-6));
      const k1n = Math.max(Math.min(sLo, 1), 0.02);
      const k3n = Math.max(Math.min(sHi, 5), 0.05);
      for (const kk of [stepBest * 0.5, stepBest, stepBest * 3]) {
        const k2n = Math.max(kk, 1);
        if (order === 1) S.push([uB0, mkC(k1n), invSoftplus(k1n), invSoftplus(k2n), xStep, wNear]);
        else {
          for (const dd of [0.05, 0.25]) {
            S.push([uB0, mkC(k1n), invSoftplus(k1n), invSoftplus(k2n), invSoftplus(k3n),
              xStep, invSoftplus(dd), wNear, invSoftplus(0.08)]);
          }
        }
      }
    }
  }
  return S;
}

/**
 * v2.8 (P1) — 고정-기울기 프로파일 우도 (fixed-slope profile likelihood).
 *
 * 무엇을 하는가: "s_max ≤ X" 라는 제약 아래에서의 최대우도 적합을 여러 X 에 대해 구하고,
 * 사실상 무제약인 기준 적합과의 Δχ² 를 낸다. Δχ²(X) > 3.84 이면 "s_max ≤ X" 가 95% 로
 * 기각된다 — 즉 s_max 의 **모델 기반 lower bound**이 된다.
 *
 * 왜 이렇게 구현하는가 (이전 시도가 실패한 두 이유를 각각 고친다):
 *  (1) k₂ 를 한 점에 고정(lo==hi)하면 남은 파라미터가 그 고정값을 보상하지 못해
 *      Δχ² 가 비단조·역방향으로 나왔다. 대신 **부등식 제약**(k₁,k₂,k₃ ≤ X)을 건다.
 *      H2 의 s(x) = k₁(1−σ₁) + k₂(σ₁−σ₂) + k₃σ₂ 는 σ₁ ≥ σ₂ 이므로 세 k 의 볼록결합이고,
 *      따라서 세 값을 모두 X 로 제한하는 것은 정확히 "s_max ≤ X" 인 부분공간이다.
 *      그 안에서의 최적해가 곧 제약 MLE 다.
 *  (2) 기준 χ² 를 엔진의 기본 적합에서 가져오면, 기본 적합 자체가 이미 얕은 해에 갇혀 있어
 *      아무것도 기각되지 않는다. 기준은 **upper bound를 크게 연 적합**에서 따로 구해야 한다.
 *      그리고 upper bound만 열어서는 부족하다 — 시작점이 전부 스플라인 기울기에서 나오므로
 *      격자보다 예리한 영역에 후보가 없다. 그래서 nearStep 시작점 가족을 함께 쓴다.
 *
 * 단조성 강제: upper bound가 큰 부분공간은 작은 부분공간을 포함하므로 χ²(X) 는 X 에 대해
 * 비증가여야 한다. 최적화가 큰 X 에서 실패하면 이 성질이 깨지는데, 작은 X 의 해는 큰 X 에서도
 * 실행가능하므로 상향 누적최솟값으로 덮어쓴다(보수적이며 항상 타당).
 *
 * 반환: { caps:[{cap, chi2, chi2Eff, dChi2, sMax}], ref, chi2Ref, floor, ... }
 *       floor = Δχ² > 임계값인 가장 큰 upper bound = "적어도 이만큼은 가파르다"는 lower bound.
 */
function profileSlopeFloor(order, x, I, sigG, lamG, scaleB, huberC, mask, globalOpts, spline, darkPrior, opts) {
  const op = opts || {};
  if (!(order >= 1)) return null;
  const caps = (op.caps || PROFILE_CAPS).slice().sort((a, b) => a - b);
  const refCap = isFinite(op.refCap) ? op.refCap : PROFILE_REF_CAP;
  const dcrit = isFinite(op.dChi2) ? op.dChi2 : DCHI2_95;
  const n = x.length;
  const useMask = mask || new Array(n).fill(true);
  let starts;
  try { starts = hingeStarts(order, x, I, spline, lamG, scaleB, darkPrior, true); }
  catch (e) { return null; }
  if (!starts || !starts.length) return null;
  const run = (cap) => {
    let f = null;
    try { f = fitHinge(order, x, I, sigG, lamG, scaleB, starts, huberC, useMask, globalOpts, cap); }
    catch (e) { f = null; }
    if (!f) return { cap, chi2: Infinity, sMax: NaN };
    let c = 0;
    for (let i = 0; i < n; i++) if (useMask[i]) c += f.rawResid[i] * f.rawResid[i];
    let sm = -Infinity;
    for (let i = 0; i < n; i++) { const sv = slopeOf(f.params, x[i], order); if (isFinite(sv) && sv > sm) sm = sv; }
    return { cap, chi2: isFinite(c) ? c : Infinity, sMax: isFinite(sm) ? sm : NaN };
  };
  const rows = caps.map(run);
  const ref = run(refCap);
  let running = Infinity;
  for (const r of rows) { running = Math.min(running, r.chi2); r.chi2Eff = running; }
  const chi2Ref = Math.min(running, ref.chi2);
  ref.chi2Eff = chi2Ref;
  if (!isFinite(chi2Ref)) return null;
  for (const r of rows) r.dChi2 = r.chi2Eff - chi2Ref;
  let floor = NaN, floorIdx = -1;
  for (let i = 0; i < rows.length; i++) if (rows[i].dChi2 > dcrit) { floor = rows[i].cap; floorIdx = i; }
  const censored = floorIdx === rows.length - 1;
  return {
    order, caps: rows, ref, refCap, chi2Ref, dChi2Crit: dcrit, floor,
    // 격자의 맨 위까지 기각되면 lower bound는 '적어도 그 값' 이상이라는 뜻(검열된 lower bound)
    floorCensored: censored,
    rejectedNone: floorIdx < 0,
    gridTop: rows[rows.length - 1].cap,
    // 기각이 멈춘 바로 위 칸 — lower bound의 격자 분해능을 그대로 드러낸다(참값은 이 사이에 있다)
    floorNext: floorIdx >= 0 && floorIdx + 1 < rows.length ? rows[floorIdx + 1].cap : NaN,
    /** 세 가지 판정 —
     *  "supported": 격자 최저값도 기각되지 않음 → 얕은 s_max 를 우도가 지지한다.
     *  "bounded"  : 어떤 upper bound에서 기각이 멈춤 → s_max 의 유한한 lower bound가 존재하고 그 위는 허용된다.
     *  "unbounded": 격자 끝까지 전부 기각 → 우도가 s_max 를 위로 전혀 제한하지 못한다.
     *               이것이 '전선이 분해되지 않았다'의 우도적 정의이며, 이때 파라메트릭 s_max 는
     *               point estimate가 아니다(width floor·격자가 정한 값일 뿐). 보고는 model-free 점프 lower bound로. */
    verdict: floorIdx < 0 ? "supported" : (censored ? "unbounded" : "bounded"),
    nUsed: useMask.reduce((a, m) => a + (m ? 1 : 0), 0),
  };
}

/**
 * v2.7 (T1) — 접선-교점 문턱 (tangent-intersection threshold).
 *
 * 정의: 최대기울기 지점의 접선과 저출력 baseline 직선의 교점.
 * t₁(시그모이드 중심)과 달리 **transition width 파라미터화에 의존하지 않고**, 곡선만 있으면
 * 계산된다 — 그래서 파라메트릭 층이 실패해도 비모수 스플라인에 그대로 적용된다.
 * 실측(WJ-0075c): 파라메트릭이 H0 로 파탄나 t₁ = NaN 인 down branch 에서도
 * 스플라인 기준으로 I_th = 1.78 mW 를 냈다(up 2.76 mW, 차이는 실제 히스테리시스).
 *
 * grid: log10 P 등간격 배열, y: 같은 격자의 log10 I, sArr: 같은 격자의 기울기.
 * 기울기를 밖에서 받는 이유 — 수치미분은 배경 위로 신호가 솟는 지점에서 발산한다
 * (실측 744,500). 해석적 기울기(sSig)나 스플라인 도함수(sTot)를 쓰라는 뜻이다.
 */
function tangentThreshold(grid, y, sArr) {
  const n = grid.length;
  if (!(n >= 8) || y.length !== n || sArr.length !== n) return null;
  let iMax = 0;
  for (let i = 1; i < n; i++) if (isFinite(sArr[i]) && sArr[i] > sArr[iMax]) iMax = i;
  const nLow = Math.max(3, Math.floor(n / 10));
  const sBase = median(sArr.slice(0, nLow).filter(isFinite));
  const sMax = sArr[iMax];
  if (!(isFinite(sBase) && isFinite(sMax))) return null;
  const den = sMax - sBase;
  // 전이가 없으면(기울기가 사실상 평탄) 교점은 의미가 없다
  if (!(den > 1.0)) return null;
  const y0 = y[0], x0 = grid[0], xm = grid[iMax], ym = y[iMax];
  let lth = ((y0 - sBase * x0) - (ym - sMax * xm)) / den;
  // 문턱은 최대기울기 지점의 왼쪽에 있어야 한다
  if (!(isFinite(lth))) return null;
  const clamped = lth > xm;
  if (clamped) lth = xm;
  return { P: Math.pow(10, lth), logP: lth, sMax, sBase, sMaxAtP: Math.pow(10, xm),
           clamped, outOfRange: lth < grid[0] };
}

/* ------------------------------ diagnostics -------------------------------- */
function runsTest(residOrdered) {
  const signs = residOrdered.filter((r) => r !== 0).map((r) => (r > 0 ? 1 : -1));
  const n = signs.length;
  if (n < 10) return { p: NaN, z: NaN, runs: NaN };
  let runs = 1, n1 = signs[0] > 0 ? 1 : 0;
  for (let i = 1; i < n; i++) { if (signs[i] !== signs[i - 1]) runs++; if (signs[i] > 0) n1++; }
  const n2 = n - n1;
  if (!n1 || !n2) return { p: 0, z: Infinity, runs };
  const mu = 1 + 2 * n1 * n2 / n;
  const va = (2 * n1 * n2 * (2 * n1 * n2 - n)) / (n * n * (n - 1));
  const z = (runs - mu) / Math.sqrt(Math.max(va, 1e-12));
  const p = 2 * (1 - normCdf(Math.abs(z)));
  return { p, z, runs, expectedRuns: mu };
}
function normCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  let pr = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - pr : pr;
}

/* ------------------------------ main analyze ------------------------------- */
/**
 * branch: {powerAvg, intensityAvg, powerStd, intensityStd, intensityReplicates}
 * opts: {monotone=true, huberC=1.345, lambdaFactor=1, aiccGuard=4, maxOrder=2,
 *        nGrid=240, seed}
 */
function analyze(branch, opts) {
  const o = Object.assign({ monotone: true, huberC: 1.345, lambdaFactor: 1, aiccGuard: 4, maxOrder: 2, nGrid: 240, fast: false, global: true }, opts);
  // dwell time / 계수형 검출기 여부는 branch 에 실려 오면 그대로 상속 (opts 가 우선)
  if (!isFinite(o.acqTime) && branch && isFinite(branch.acqTime)) o.acqTime = branch.acqTime;
  if (o.counting === undefined && branch) o.counting = !!branch.counting;
  // ---- curation: finite, P>0; keep I of any sign; sort by x ----
  const P0 = branch.powerAvg, I0 = branch.intensityAvg;
  const reps0 = branch.intensityReplicates || null;
  const idx = [];
  for (let i = 0; i < P0.length; i++) if (isFinite(P0[i]) && P0[i] > 0 && isFinite(I0[i])) idx.push(i);
  if (idx.length < 8) throw new Error(`분석 가능한 점이 ${idx.length}개 — 최소 8개 필요`);
  idx.sort((a, b) => P0[a] - P0[b]);
  const P = idx.map((i) => P0[i]);
  const I = idx.map((i) => I0[i]);
  const reps = reps0 ? idx.map((i) => reps0[i]) : null;
  const x = P.map((v) => Math.log10(v));
  const n = x.length;

  // ---- noise model & glog scale ----
  // v2.6 (E2): 노이즈는 2성분이다.
  //   σ²(I) = [a0² + a1·I]   계수 통계 — 원시 반복에서 측정, Poisson 바닥 a1 ≥ 1/τ,
  //                            반복 평균으로 1/nRep 만큼 줄어든다
  //         + (a2·I)²        setpoint 간 초과(드리프트/점멸) — 파일럿 residual에서 측정,
  //                            반복을 늘려도 줄지 않는다
  // 어느 한쪽만 쓰면 반드시 틀린다: 반복만 쓰면 밝은 구간 가중이 5배 과대(χ²/dof 폭주),
  // 파일럿만 쓰면 암계수 구간 상대오차가 과소평가되어 정보량 0인 점들이 피팅을 지배한다.
  const vm = estimateVarianceModel(x, I, reps);
  const nRepsArr = reps ? reps.map((r) => Math.max(finite(r || []).length, 1)) : new Array(n).fill(1);
  // max-of-N 집계가 실제로 일어난 점의 극값 보정 계수 (정규 근사; 부트스트랩은 극값에 비일관)
  const EV_C = { 1: 1, 2: 0.8256, 3: 0.7480, 4: 0.7011, 5: 0.6690, 6: 0.6457, 7: 0.6278, 8: 0.6136, 9: 0.6019, 10: 0.5922 };
  const evFactor = (N) => (N <= 1 ? 1 : (EV_C[N] !== undefined ? EV_C[N] : Math.max(1 / Math.sqrt(2 * Math.log(N)), 0.35)));
  const aggN0 = branch.aggApplied || null;
  const aggArr = aggN0 ? idx.map((i) => Math.max(Number(aggN0[i]) || 1, 1)) : new Array(n).fill(1);
  const cAgg = aggArr.map(evFactor);
  // 계수 통계 성분 (원시 반복이 있을 때만 분리 가능)
  const cnt = vm.source === "replicates" ? { a0: vm.a0, a1: vm.a1, a2: vm.a2 } : null;
  if (cnt && o.counting && isFinite(o.acqTime) && o.acqTime > 0) {
    cnt.a1 = Math.max(cnt.a1, 1 / o.acqTime);   // 광자 계수의 Poisson 바닥은 물리 lower bound
    vm.a1 = cnt.a1;
  }
  const noiseBox = { a0: vm.a0, a1: vm.a1, a2: vm.a2, cnt, source: vm.source, excess: NaN };
  const sigI = new Array(n), y = new Array(n), sigG = new Array(n), wgt = new Array(n);
  const lamGBox = { v: 0 };
  // 총 1회 관측 표준편차 (보고/부트스트랩용) — 성분 분리와 무관한 단일 법칙
  const sigmaTotOf = (Ii) => {
    const N = noiseBox;
    return Math.sqrt(Math.max(N.a0 * N.a0 + N.a1 * Math.max(Ii, 0) + N.a2 * N.a2 * Ii * Ii, 1e-300));
  };
  // 실제 가중치에 쓰는 점별 표준오차: 계수 성분만 √nRep 로 줄이고, 비례 성분은 그대로 둔다.
  const sigPointOf = (Ii, i) => {
    const N = noiseBox;
    if (!N.cnt) return Math.sqrt(Math.max(sigmaTotOf(Ii) * sigmaTotOf(Ii) / Math.max(nRepsArr[i], 1), 1e-300));
    // setpoint 내부 성분(계수 통계 + 반복이 실제로 본 비례 spread)은 반복 평균으로 1/nRep 줄어들고,
    // setpoint 간 초과 성분만 그대로 남는다. a2_cnt 를 비축소항에 넣으면 σ 가 과대평가되어
    // χ²/dof 가 1 아래로 내려가고 AICc 절약 가드가 옳은 차수까지 눌러버린다.
    const c0 = N.cnt.a0, c1 = N.cnt.a1, c2 = N.cnt.a2;
    const vIn = (c0 * c0 + c1 * Math.max(Ii, 0) + c2 * c2 * Ii * Ii) * cAgg[i] * cAgg[i] / Math.max(nRepsArr[i], 1);
    const vEx = isFinite(N.excess) ? N.excess * N.excess * Ii * Ii : 0;
    return Math.sqrt(Math.max(vIn + vEx, 1e-300));
  };
  const applyNoise = () => {
    lamGBox.v = Math.max(3 * noiseBox.a0, 1e-12 * Math.max(Math.abs(quantile(I, 0.9)), 1));
    for (let i = 0; i < n; i++) {
      sigI[i] = sigPointOf(I[i], i);
      y[i] = glog10(I[i], lamGBox.v);
      sigG[i] = Math.max(sigI[i] * dglog10(I[i], lamGBox.v), 1e-5);
      wgt[i] = 1 / (sigG[i] * sigG[i]);
    }
  };
  applyNoise();

  // ---- Layer A: P-spline in glog space (pilot; refit after outlier flags) ----
  let spline = fitPSpline(x, y, wgt, { monotone: o.monotone, lambdaFactor: o.lambdaFactor, fast: o.fast });
  // Replicate-free variance estimation. Difference-based estimates leak
  // signal curvature into the noise term, so instead:
  //  (1) deliberately UNDERSMOOTHED unit-weight pilot spline (basis dimension
  //      m«n bounds overfitting; residuals ≈ noise, mildly shrunk),
  //  (2) per-intensity-bin robust MAD scale (no chi-square log bias),
  //  (3) 3-component law fit → noise SHAPE over I,
  //  (4) global scale calibration so median |studentized residual| = 0.6745
  //      (the law provides the shape; the data pins the scale).
  {
    // v2.6: 반복 유무와 무관하게 항상 실행한다. 반복이 있으면 이 블록의 결과에서
    // 계수 성분을 뺀 나머지가 setpoint 간 초과 성분이 된다.
    // λ0 for the pilot must sit on the ADDITIVE-NOISE scale. Negative
    // intensities (baseline-subtracted CCD data) are pure noise → their
    // robust scale estimates σ_add directly; else use the spread of the
    // lowest-intensity fifth.
    const negs = I.filter((v) => v < 0);
    let sigAdd0;
    if (negs.length >= 5) sigAdd0 = 1.4826 * median(negs.map(Math.abs));
    else {
      const low = I.slice().sort((q, w) => q - w).slice(0, Math.max(5, (n / 5) | 0));
      sigAdd0 = mad(low);
    }
    if (!(isFinite(sigAdd0) && sigAdd0 > 0)) sigAdd0 = Math.max(1e-3 * Math.abs(quantile(I, 0.5)), 1e-12);
    const lam0 = Math.max(3 * sigAdd0, 1e-12);
    const y0 = I.map((Ii) => glog10(Ii, lam0));
    const mBasis = clamp(Math.floor(n / 4), 6, 22) + 3;
    const sp0 = fitPSpline(x, y0, y0.map(() => 1), { monotone: false, targetEdf: Math.min(mBasis - 2, Math.max(8, n / 3)), fast: o.fast });
    const edfInfl = Math.sqrt(n / Math.max(n - sp0.edf, 2));
    const recs = [];
    for (let i = 0; i < n; i++) {
      const yfit = sp0.fitAt(x[i]);
      const Imod = Math.pow(10, yfit);
      const rY = (y0[i] - yfit) * edfInfl;
      const sigIi = Math.abs(rY) / Math.max(dglog10(Math.max(Imod, lam0), lam0), 1e-300);
      if (isFinite(sigIi) && isFinite(Imod)) recs.push([Math.max(Imod, 0), sigIi, rY]);
    }
    recs.sort((a2, b2) => a2[0] - b2[0]);
    const nBins = clamp(Math.floor(recs.length / 10), 4, 8);
    const pts2 = [];
    for (let b2 = 0; b2 < nBins; b2++) {
      const lo2 = Math.floor(b2 * recs.length / nBins), hi2 = Math.floor((b2 + 1) * recs.length / nBins);
      const seg = recs.slice(lo2, hi2);
      if (seg.length < 4) continue;
      const Ictr = median(seg.map((r) => r[0]));
      const sigBin = 1.4826 * median(seg.map((r) => Math.abs(r[1])));
      if (isFinite(Ictr) && isFinite(sigBin) && sigBin > 0) pts2.push([Ictr, sigBin * sigBin]);
    }
    if (pts2.length >= 3) {
      const vm2 = fitVarianceLaw(pts2, I, null, "pilot-residual");
      // global scale calibration
      const studs = recs.map(([Imod, sigIi, rY]) => {
        const sg = Math.max(vm2.sigmaOfI(Imod) * dglog10(Math.max(Imod, lam0), lam0), 1e-300);
        return Math.abs(rY) / sg;
      });
      const c = clamp((median(studs) || 0.6745) / 0.6745, 0.2, 20);
      const a0n = vm2.a0 * c, a1n = vm2.a1 * c * c, a2n = vm2.a2 * c;
      const varPilotOf = (Ii) => Math.max(a0n * a0n + a1n * Math.max(Ii, 0) + a2n * a2n * Ii * Ii, 1e-300);
      const ok = isFinite(varPilotOf(quantile(I, 0.1))) && varPilotOf(quantile(I, 0.9)) > 0;
      if (ok && !cnt) {
        // 반복 없음 — 구 동작 그대로: 파일럿 법칙이 곧 총 노이즈 법칙
        noiseBox.a0 = a0n; noiseBox.a1 = a1n; noiseBox.a2 = a2n;
        noiseBox.source = "pilot-residual(calibrated)";
        applyNoise();
        spline = fitPSpline(x, y, wgt, { monotone: o.monotone, lambdaFactor: o.lambdaFactor, fast: o.fast });
      } else if (ok && cnt) {
        // 반복 있음 — 파일럿 residual는 '보고된 I(반복 평균)'의 총 spread이므로
        //   var_excess(I) = var_pilot(I) − σ_cnt²(I)·c_agg²/nRep
        // 이 setpoint 간 초과 성분이다. 다만 두 가지를 반드시 막아야 한다:
        //  (1) 총 이상치가 residual를 부풀려 노이즈 모델에 흡수되는 것 → 상위 10% residual 절사,
        //  (2) 추정 잡음 수준의 미미한 초과를 실재로 오인하는 것 → 증거 게이트(ρ ≥ 3).
        // 게이트를 통과하지 못하면 초과항은 0 이고 순수 반복 법칙을 쓴다(구 동작과 동일).
        const nRepTyp = Math.max(median(nRepsArr) || 1, 1);
        const cTyp = median(cAgg) || 1;
        const cut = quantile(recs.map((r) => Math.abs(r[2])), 0.90);
        const clean = recs.filter((r) => Math.abs(r[2]) <= cut);
        const nB = clamp(Math.floor(clean.length / 12), 4, 8);
        const ratios = [], exRel = [];
        for (let b3 = 0; b3 < nB; b3++) {
          const seg = clean.slice(Math.floor(b3 * clean.length / nB), Math.floor((b3 + 1) * clean.length / nB));
          if (seg.length < 4) continue;
          const Ic = median(seg.map((r) => r[0]));
          const sg = 1.4826 * median(seg.map((r) => Math.abs(r[1])));
          if (!(isFinite(Ic) && Ic > 0 && isFinite(sg) && sg > 0)) continue;
          const vP = sg * sg;
          const vC = (cnt.a0 * cnt.a0 + cnt.a1 * Math.max(Ic, 0) + cnt.a2 * cnt.a2 * Ic * Ic) * cTyp * cTyp / nRepTyp;
          ratios.push(vP / Math.max(vC, 1e-300));
          exRel.push(Math.max(vP - vC, 0) / (Ic * Ic));
        }
        // 초과항은 I 에 비례하므로 낮은 I 구간에서는 원리적으로 보이지 않는다.
        // 따라서 증거는 상위 I 구간(bin 의 위쪽 절반)에서만 판정한다 — 전 구간 중앙값을
        // 쓰면 암계수 구간이 증거를 희석해 실재하는 초과를 놓친다.
        const half = Math.floor(ratios.length / 2);
        const rHi = ratios.slice(half), eHi = exRel.slice(half);
        const rhoMed = rHi.length ? median(rHi) : 0;
        if (o.debugNoise) console.log("  [noise] nB=%d rho=%s exRel=%s rhoHi=%s", nB, ratios.map((v) => v.toFixed(2)).join(","), exRel.map((v) => Math.sqrt(v).toFixed(4)).join(","), rhoMed.toFixed(2));
        // upper bound 게이트: setpoint 간 드리프트가 25% 를 넘는다는 것은 물리적으로 비현실적이며,
        // 그 정도 residual는 노이즈가 아니라 (a) 총 이상치이거나 (b) 모델이 곡선을 못 따라가는 것이다.
        // 그것을 σ 에 흡수시키면 이상치 처리와 차수 선택이 무력화된다 — 노이즈를 신호로 읽는 것의
        // 정확한 반대 실수다. 그런 경우 초과항을 버리고 순수 반복 법칙으로 되돌아간다.
        const EXCESS_MAX = 0.25;
        const exRaw = (ratios.length >= 4 && rHi.length >= 2 && rhoMed >= 3) ? Math.sqrt(Math.max(median(eHi), 0)) : 0;
        const a2Excess = exRaw > EXCESS_MAX ? 0 : exRaw;
        if (exRaw > EXCESS_MAX) noiseBox.excessRejected = exRaw;
        noiseBox.excess = a2Excess;
        noiseBox.rho = rhoMed;
        noiseBox.a0 = cnt.a0; noiseBox.a1 = cnt.a1;
        noiseBox.a2 = Math.sqrt(cnt.a2 * cnt.a2 + a2Excess * a2Excess);
        noiseBox.source = a2Excess > 0 ? "replicates+interset" : "replicates";
        applyNoise();
        spline = fitPSpline(x, y, wgt, { monotone: o.monotone, lambdaFactor: o.lambdaFactor, fast: o.fast });
      }
    }
  }
  vm.a0 = noiseBox.a0; vm.a1 = noiseBox.a1; vm.a2 = noiseBox.a2; vm.source = noiseBox.source;
  const lamGFinal = lamGBox.v;
  const xlo = x[0], xhi = x[n - 1];
  // v2.6 (E4): 전이 width floor. 격자 간격보다 훨씬 좁은 w 는 물리적 의미가 없으므로
  // lower bound 자체는 낮추되(0.005) 격자 대비 게이트를 별도로 둔다.
  const dxs = [];
  for (let i = 1; i < n; i++) if (x[i] - x[i - 1] > 0) dxs.push(x[i] - x[i - 1]);
  const medianDx = dxs.length ? median(dxs) : 0.01;
  W_FLOOR.v = isFinite(o.wFloor) && o.wFloor > 0 ? o.wFloor : W_FLOOR_DEFAULT;
  // v2.6 (E5): 점화 전선을 모델과 무관하게 데이터에서 직접 식별한다.
  // 인접점 국소 기울기 (Δlog10 I / Δlog10 P) 의 최대값을 찾고, 그 절반을 넘는
  // 연속 구간 ±2점을 "전이 전선"으로 본다. 파일럿 t1 에 의존하면 파일럿이
  // 전이를 엉뚱한 곳에 놓았을 때 보호가 통째로 빗나간다.
  const frontMask = new Array(n).fill(false);
  {
    const step = new Array(Math.max(n - 1, 0)).fill(-Infinity);
    for (let i = 0; i + 1 < n; i++) {
      const h = x[i + 1] - x[i];
      if (h > 0 && I[i] > 0 && I[i + 1] > 0) step[i] = (Math.log10(I[i + 1]) - Math.log10(I[i])) / h;
    }
    let sBest = -Infinity, iBest = -1;
    for (let i = 0; i < step.length; i++) if (step[i] > sBest) { sBest = step[i]; iBest = i; }
    if (iBest >= 0 && sBest > 1) {
      const thr = 0.5 * sBest;
      let lo2 = iBest, hi2 = iBest;
      while (lo2 - 1 >= 0 && step[lo2 - 1] > thr) lo2--;
      while (hi2 + 1 < step.length && step[hi2 + 1] > thr) hi2++;
      // 전이 구간은 급상승 구간 자체보다 넓다 — 양쪽으로 0.04 decade(최소 2점, 최대 n의 10%)를 덧댄다
      const pad = clamp(Math.ceil(0.04 / Math.max(medianDx, 1e-6)), 2, Math.max(2, Math.floor(0.1 * n)));
      for (let i = Math.max(lo2 - pad, 0); i <= Math.min(hi2 + 1 + pad, n - 1); i++) frontMask[i] = true;
    }
  }
  const grid = [];
  for (let i = 0; i < o.nGrid; i++) grid.push(xlo + (xhi - xlo) * i / (o.nGrid - 1));

  // ---- Layer B: nested hinge fits with global outlier handling ----
  const scaleB = Math.max(Math.abs(quantile(I, 0.2)), lamGFinal, 1e-9);
  // v2.6 (E6): 암계수 사전값 — paTrace 가 있으면 거기서, 없으면 하위 10% 분위수
  let darkPrior = NaN;
  if (o.paTrace && o.paTrace.P && o.paTrace.P.length >= 5) {
    try { darkPrior = paDarkOf(o.paTrace.P, o.paTrace.I, o.paTrace.W).D; } catch (e) { darkPrior = NaN; }
  }
  if (!(isFinite(darkPrior) && darkPrior > 0)) darkPrior = Math.max(quantile(I, 0.10), 0) || NaN;
  // pilot: most flexible order with redescending IRLS → global outlier flags.
  // (Only the flexible model may flag points: a rigid model must never be
  //  allowed to call real structure an "outlier".)
  let pilotStarts = hingeStarts(o.maxOrder, x, I, spline, lamGFinal, scaleB, darkPrior);
  if (o.fast) pilotStarts = pilotStarts.slice(0, 4);
  if (o.warmTheta && o.warmOrder === o.maxOrder) pilotStarts.unshift(o.warmTheta.slice());
  // v2.7 (G1) 전역 탐색 예산. 부트스트랩은 draw 마다 analyze()를 냉시작으로 다시 돌리므로
  // (의도적 설계 — 웜스타트는 분산을 절반으로 숨긴다) 이 예산이 nBoot 배로 곱해진다.
  // 추정량은 본 적합과 draw 가 동일해야 하므로 draw 에서만 줄이지 않는다.
  const globalOpts = o.global === false ? null
    : { popsize: o.fast ? 16 : 26, maxiter: o.fast ? 60 : 140, seed: isFinite(o.deSeed) ? o.deSeed : 20260914 };
  const pilot = fitHinge(o.maxOrder, x, I, sigG, lamGFinal, scaleB, pilotStarts, o.huberC, null, globalOpts);
  let mask = new Array(n).fill(true);
  let outlierIdx = [], frontScatter = [];
  if (pilot) {
    // v2.6 (E5): 점화 전선 근방(t1 ± 3·max(w, 2Δx))의 점은 이상치가 아니라 측정 대상이다.
    // bistable 점멸로 spread가 크게 나오지만 제거하면 전이 자체를 버리게 된다.
    const t1P = pilot.params ? pilot.params.t1 : NaN, wP = pilot.params ? pilot.params.w : NaN;
    // v2.7 (E5-fix): halo 에 절대 upper bound를 건다. 파일럿이 전이를 넓게 잡으면
    // 3·w 가 측정범위 전체를 덮어(실측: 0.614 dec = 범위의 80%, 91점 중 73점 보호)
    // 강건 이상치 처리가 통째로 꺼진다. 보호는 '전선 근방'이라는 뜻이어야 하므로
    // 0.06 dec 와 측정범위의 15% 중 작은 쪽을 upper bound로 삼는다.
    const haloCap = Math.min(0.06, 0.15 * (xhi - xlo));
    const halo = Math.min(3 * Math.max(isFinite(wP) ? wP : 0, 2 * medianDx), haloCap);
    // 데이터가 지목한 전선 ∪ 파일럿 t1 근방 — 둘 중 하나라도 걸리면 보호한다
    const inFront = (i) => frontMask[i] || (isFinite(t1P) && Math.abs(x[i] - t1P) <= halo);
    const flagged = [];
    for (let i = 0; i < n; i++) if (pilot.irlsW[i] < 0.1) flagged.push([i, Math.abs(pilot.rawResid[i])]);
    flagged.sort((a, b) => b[1] - a[1]);
    frontScatter = flagged.filter(([i]) => inFront(i)).map((f) => f[0]).sort((a, b) => a - b);
    const cand = flagged.filter(([i]) => !inFront(i));
    const cap = Math.max(1, Math.floor(0.1 * n));
    outlierIdx = (cand.length <= Math.floor(0.1 * n) ? cand : cand.slice(0, cap)).map((f) => f[0]);
    for (const i of outlierIdx) mask[i] = false;
  }
  // refit spline without outliers (their weight → 0)
  let splineC = spline;
  if (outlierIdx.length) {
    const w2 = wgt.map((w, i) => (mask[i] ? w : 0));
    splineC = fitPSpline(x, y, w2, { monotone: o.monotone, lambdaFactor: o.lambdaFactor, fast: o.fast });
  }
  const fits = {};
  for (let order = 0; order <= o.maxOrder; order++) {
    let starts = hingeStarts(order, x, I, splineC, lamGFinal, scaleB, darkPrior);
    if (o.fast) starts = starts.slice(0, 4);
    if (pilot && order === o.maxOrder) starts.unshift(pilot.theta.slice());
    if (o.warmTheta && o.warmOrder === order) starts.unshift(o.warmTheta.slice());
    fits[order] = fitHinge(order, x, I, sigG, lamGFinal, scaleB, starts, o.huberC, mask, globalOpts);
  }
  // FAIR nested comparison: χ²/AICc for every order over the SAME point set
  // (the common mask), so a fit cannot improve its criterion by self-
  // downweighting structure it fails to describe.
  const nMask = mask.reduce((s, m) => s + (m ? 1 : 0), 0);
  for (let order = 0; order <= o.maxOrder; order++) {
    const f = fits[order];
    if (!f) continue;
    let chi2 = 0;
    for (let i = 0; i < n; i++) if (mask[i]) chi2 += f.rawResid[i] * f.rawResid[i];
    f.chi2 = chi2;
    f.aicc = nMask > f.k + 1 ? chi2 + 2 * f.k + (2 * f.k * (f.k + 1)) / (nMask - f.k - 1) : Infinity;
  }
  // nested selection with parsimony guard
  let chosen = 0;
  for (let order = 1; order <= o.maxOrder; order++) {
    if (fits[order] && fits[chosen] && fits[order].aicc < fits[chosen].aicc - o.aiccGuard) chosen = order;
  }
  const fit = fits[chosen];
  if (!fit) throw new Error("파라메트릭 피팅 실패");
  const p = fit.params;

  // slope of TOTAL intensity in log10 I per log10 P: chain rule from glog
  const sTot = grid.map((xv) => {
    const yv = splineC.fitAt(xv);
    const Iv = Math.max(Math.pow(10, yv), 1e-300); // ≈ I for I>>λ
    const corr = Math.sqrt(Iv * Iv + lamGFinal * lamGFinal) / Iv;
    return splineC.slopeAt(xv) * corr;
  });

  // ---- headline quantities ----
  const sSig = grid.map((xv) => slopeOf(p, xv, chosen));
  let sMax = -Infinity, xAtMax = grid[0];
  for (let i = 0; i < grid.length; i++) if (sSig[i] > sMax) { sMax = sSig[i]; xAtMax = grid[i]; }
  let sTotMax = -Infinity, xTotMax = grid[0];
  for (let i = 0; i < grid.length; i++) if (sTot[i] > sTotMax) { sTotMax = sTot[i]; xTotMax = grid[i]; }
  // threshold: P at max signal slope (only meaningful if slope actually varies)
  const slopeVaries = chosen >= 1 && (p.k2 - p.k1 > 0.2 || p.k2 - p.k3 > 0.2);
  const thresholdP = chosen >= 1 && p.k2 > p.k1 + 0.2 ? Math.pow(10, p.t1) : NaN;
  const saturationP = chosen === 2 && p.k2 > p.k3 + 0.2 ? Math.pow(10, p.t2) : (chosen === 1 && p.k2 < p.k1 - 0.2 ? Math.pow(10, p.t1) : NaN);
  const sMaxAtP = Math.pow(10, xAtMax);
  /* ------------------------------------------------------------------ v3.12
   * **관측 가능성 게이트.**  이 모델은 I = B + 10^h(x) 이고 sSig = dh/dx 는
   * *숨은 신호 성분* 10^h 의 기울기다. 암구간에서는 10^h ≪ 잡음 이므로 관측된
   * 곡선은 B 에서 평평하고, 데이터가 말하는 것은 "10^h 가 잡음보다 작다"는
   * **부등식**뿐이다. 그 구간의 k1 은 식별되지 않는다 — 충분히 작기만 하면
   * 어떤 값이든 똑같이 잘 맞는다. 그런데 dh/dx = k1 은 그 평평한 구간 전체에서
   * 일정하므로 argmax 가 **맨 왼쪽 점**을 집고, 그 결과 "최대 PA 위치" 가
   * 베이스라인 시작점에 찍힌다. (WJ-0075c: 보고 위치에서 모델 신호 성분이
   * 8×10⁻⁸ counts — 암레벨 122 counts 의 10⁻⁹ 배였다.)
   * 그래서 보고 위치에서 모델 신호가 검출 게이트를 넘는지 함께 낸다. */
  const sigAtMax = modelI(p, xAtMax, chosen) - (isFinite(p.B) ? p.B : 0);
  const sMaxObservable = { signal: sigAtMax, gate: NaN, observable: true, why: null };
  // edge-censoring: slope still rising (or falling) at the boundary of the
  // measured range → sMax is only a bound; threshold outside measured range.
  const edgeTol = 0.02 * (xhi - xlo);
  // a falling-only model (H0, or H1/H2 without a rising segment) has its
  // slope maximum at the left edge BY CONSTRUCTION — that is the low-power
  // power-law order, not a censored estimate. Warn only when an actual
  // rising transition's peak is pinned to the range boundary.
  const hasRise = chosen >= 1 && p.k2 > Math.max(p.k1, chosen === 2 ? p.k3 : -Infinity) + 0.2;
  const sMaxAtLeftEdge = hasRise && xAtMax <= xlo + edgeTol;
  const sMaxAtRightEdge = hasRise && xAtMax >= xhi - edgeTol;
  let thresholdOutOfRange = isFinite(thresholdP) && (Math.log10(thresholdP) < xlo || Math.log10(thresholdP) > xhi);

  // ---- v2.6 (E4): constraint boundary 접촉 감지 ----
  // 최적화 박스나 lower bound에 붙어서 나온 값은 데이터의 정보가 아니라 제약의 산물이다.
  const boundHits = [];
  const BTOL = 1e-3;
  if (chosen >= 1 && isFinite(p.w) && p.w - W_FLOOR.v < BTOL)
    boundHits.push({ param: "w", at: "floor", value: p.w, bound: W_FLOOR.v });
  if (chosen === 2 && isFinite(p.v) && p.v - W_FLOOR.v < BTOL)
    boundHits.push({ param: "v", at: "floor", value: p.v, bound: W_FLOOR.v });
  if (chosen === 2 && isFinite(p.t2) && isFinite(p.t1) && (p.t2 - p.t1) - W_FLOOR.v < BTOL)
    boundHits.push({ param: "t2-t1", at: "floor", value: p.t2 - p.t1, bound: W_FLOOR.v });
  {
    const names = chosen === 0 ? { 0: "B", 1: "c", 2: "k1" }
      : chosen === 1 ? { 0: "B", 1: "c", 2: "k1", 3: "k2", 4: "t1", 5: "w" }
      : { 0: "B", 1: "c", 2: "k1", 3: "k2", 4: "k3", 5: "t1", 6: "t2-t1", 7: "w", 8: "v" };
    const already = new Set(boundHits.map((b) => b.param));
    fit.theta.forEach((t, j) => {
      const nm = names[j] || ("theta[" + j + "]");
      // softplus lower bound에 붙은 파라미터는 θ = −BOX 로도 나타난다 — 같은 사실을 두 번 세지 않는다
      if (t < 0 && already.has(nm)) return;
      // lower bound 쪽 접촉(θ = −BOX)은 병리가 아니다: B→0(배경 없음), k→0(기울기 0) 은
      // 모두 물리적으로 정상인 해다. 파라미터가 발산해 upper bound에 붙는 경우만 보고한다.
      if (!(t > 0 && Math.abs(t - THETA_BOX) < 0.05)) return;
      // 기울기 파라미터가 upper bound에 붙어도, 보고값 s_max 가 upper bound 근처가 아니면
      // 그 upper bound는 보고값에 영향을 주지 않는다(전이가 t2 에서 잘려 실효 기울기가 작은 경우).
      // "어떤 파라미터가 경계에 있는가"가 아니라 "경계가 보고값을 결정했는가"로 판정한다.
      if (/^k[123]$/.test(nm) && !(sMax > 0.5 * THETA_BOX)) return;
      boundHits.push({ param: nm, at: "box", value: t, bound: THETA_BOX });
    });
  }
  // 격자보다 좁은 전이: 어떤 매끄러운 모델도 s_max 에 유한한 값을 줄 수 없다
  const wSubGrid = chosen >= 1 && isFinite(p.w) && p.w < 0.5 * medianDx;
  if (wSubGrid) boundHits.push({ param: "w", at: "sub-grid", value: p.w, bound: 0.5 * medianDx });

  // ---- v3.7: model-free s_max lower bound (secant) · v3.8: 암준위 차감 ----
  // 파라메트릭 s_max 가 이 lower bound보다 작으면, 그 값은 **모델과 무관하게** refuted 것이다.
  // 어떤 모델이 맞는지는 말하지 않는다 — "현재 값이 너무 작다"만 말한다.
  let darkInfo = null;
  try { darkInfo = darkFloor(x, I); } catch (e) { darkInfo = null; }
  let sLowerBoundRaw = null, sLowerBound = null;
  try {
    sLowerBoundRaw = secantSlopeLowerBound(x, I, sigI, { z: 3 });
    sLowerBound = (darkInfo && darkInfo.flat && darkInfo.Dsub > 0)
      ? secantSlopeLowerBound(x, I, sigI, { z: 3, dark: darkInfo.Dsub, sigDark: darkInfo.sd })
      : sLowerBoundRaw;
    // 차감은 lower bound를 조여야 한다. 혹시 더 작아지면(수치·표본 사정) 강한 쪽을 쓴다.
    if (sLowerBoundRaw && sLowerBound && sLowerBoundRaw.slope > sLowerBound.slope) sLowerBound = sLowerBoundRaw;
  } catch (e) { sLowerBound = sLowerBoundRaw; }
  const secantExceeds = !!(sLowerBound && isFinite(sLowerBound.slope) && sLowerBound.slope > sMax);

  // ---- v3.7: ignition bracket와 문턱 모순 판정 ----
  let ignition = null, thresholdBracket = null, thresholdSource = "model", thresholdPModel = thresholdP;
  let thresholdUsed = thresholdP;
  try { ignition = ignitionBracket(x, I, {}); } catch (e) { ignition = null; }
  /* v3.12 — 검출 게이트가 정해진 뒤에 관측 가능성을 판정한다. */
  let sMaxObs = NaN, sMaxObsAtP = NaN;
  {
    const gate = ignition && isFinite(ignition.gate) ? ignition.gate
      : (darkInfo && isFinite(darkInfo.D) && isFinite(darkInfo.sd) ? darkInfo.D + 5 * darkInfo.sd : NaN);
    const Bv = isFinite(p.B) ? p.B : 0;
    sMaxObservable.gate = gate;
    if (isFinite(gate)) {
      sMaxObservable.observable = (sMaxObservable.signal + Bv) >= gate;
      if (!sMaxObservable.observable)
        sMaxObservable.why = "보고 위치에서 모델 신호 성분이 검출 한계 아래 — 이 기울기는 외삽이며 데이터가 식별하지 못한다";
      // 관측 가능 구간(모델이 게이트를 넘는 곳)으로 한정한 최대 신호기울기
      let best = -Infinity, bestX = NaN;
      for (let i = 0; i < grid.length; i++) {
        if (modelI(p, grid[i], chosen) < gate) continue;
        if (sSig[i] > best) { best = sSig[i]; bestX = grid[i]; }
      }
      if (isFinite(best) && best > -Infinity) { sMaxObs = best; sMaxObsAtP = Math.pow(10, bestX); }
    }
  }
  // ---- v3.8: 국소 점화 적합 ----
  let localFit = null;
  if (!o.internal && o.localFit !== false && !o.fast) {
    try { localFit = localIgnitionFit(x, I, sigI, ignition, darkInfo); } catch (e) { localFit = { usable: false, why: "예외: " + e.message }; }
  }
  if (ignition && ignition.usable) {
    thresholdBracket = [ignition.pLo, ignition.pHi];
    // 모델 문턱이 관측된 점화 구간보다 **아래**이고, 그 위치에서 신호가 연속 3점 배경이면
    // 모델 문턱은 데이터와 모순이다. 그때만 관측 브래킷으로 대체한다.
    if (isFinite(thresholdP) && thresholdP < ignition.pLo
        && thresholdContradicted(x, I, thresholdP, ignition.gate, 2)) {
      thresholdUsed = ignition.pMid;
      thresholdSource = "ignition-bracket";
    } else if (!isFinite(thresholdP)) {
      // 모델이 문턱을 내지 못한 경우에도 관측 브래킷은 남는다 (코퍼스의 '산출 실패' 153건)
      thresholdUsed = ignition.pMid;
      thresholdSource = "ignition-bracket";
    }
  }

  // ---- diagnostics ----
  const maskedResid = fit.rawResid.filter((_, i) => mask[i]);
  const rt = runsTest(maskedResid);
  const chi2red = fit.chi2 / Math.max(nMask - fit.k, 1);
  // sandwich covariance for identifiability
  let paramSE = null, maxCorr = NaN;
  try {
    const np = fit.theta.length, m = n;
    const residPlain = (th) => {
      const pp = unpackH(chosen, th, scaleB);
      const r = new Array(m);
      for (let i = 0; i < m; i++) r[i] = (glog10(I[i], lamGFinal) - glog10(modelI(pp, x[i], chosen), lamGFinal)) / sigG[i];
      return r;
    };
    const r0 = residPlain(fit.theta);
    const J = [];
    for (let j = 0; j < np; j++) {
      const h = Math.max(Math.abs(fit.theta[j]) * 1e-6, 1e-8);
      const tp = fit.theta.slice(); tp[j] += h;
      const rp = residPlain(tp);
      J.push(rp.map((v, i) => (v - r0[i]) / h));
    }
    const JtJ = [];
    for (let a = 0; a < np; a++) { JtJ.push(new Array(np).fill(0)); }
    for (let a = 0; a < np; a++) for (let b = a; b < np; b++) {
      let s = 0; for (let i = 0; i < m; i++) s += J[a][i] * J[b][i];
      JtJ[a][b] = s; JtJ[b][a] = s;
    }
    const bread = invSym(JtJ);
    if (bread) {
      const meat = [];
      for (let a = 0; a < np; a++) meat.push(new Array(np).fill(0));
      for (let a = 0; a < np; a++) for (let b = a; b < np; b++) {
        let s = 0; for (let i = 0; i < m; i++) s += J[a][i] * J[b][i] * r0[i] * r0[i];
        meat[a][b] = s; meat[b][a] = s;
      }
      const cov = [];
      for (let a = 0; a < np; a++) {
        cov.push(new Array(np).fill(0));
        for (let b = 0; b < np; b++) {
          let s = 0;
          for (let c1 = 0; c1 < np; c1++) for (let c2 = 0; c2 < np; c2++) s += bread[a][c1] * meat[c1][c2] * bread[c2][b];
          cov[a][b] = s;
        }
      }
      paramSE = cov.map((row, a) => Math.sqrt(Math.max(row[a], 0)));
      maxCorr = 0;
      for (let a = 0; a < np; a++) for (let b = a + 1; b < np; b++) {
        const c = Math.abs(cov[a][b]) / Math.max(Math.sqrt(cov[a][a] * cov[b][b]), 1e-300);
        if (isFinite(c) && c > maxCorr) maxCorr = c;
      }
    }
  } catch (e) { /* identifiability optional */ }

  // spline↔parametric agreement (only over region both defined)
  const agree = {
    sMaxSpline: sTotMax, sMaxParam: sMax,
    sMaxGapPct: 100 * Math.abs(sTotMax - sMax) / Math.max(Math.abs(sMax), Math.abs(sTotMax), 1e-12),
    xMaxGapDec: Math.abs(xTotMax - xAtMax),
  };

  // ---- PA standard layer (paper convention): unresolved-jump term ----
  let paJump = null, paDark = NaN;
  if (o.paTrace && o.paTrace.P && o.paTrace.P.length >= 5) {
    try {
      paJump = paJumpTerm(o.paTrace.P, o.paTrace.I, o.paTrace.W);
      paDark = paDarkOf(o.paTrace.P, o.paTrace.I, o.paTrace.W).D;
    } catch (e) { paJump = null; }
  }
  const jumpWins = paJump && isFinite(paJump.slope) && paJump.slope > sMax;
  const paGridLimited = !!(jumpWins && paJump.slope > PA_CONST.JUMP_DOMINANCE * Math.max(sMax, 1e-12));

  // ---- v3.7: lower bound 상태의 단일 정의 ----
  // 지금까지 'lower bound'은 세 군데에서 따로 판정됐고(가장자리 · constraint boundary · 점프), 그 중
  // 점프만 보고 경로(paSource)와 프로파일 우도에 연결돼 있었다. 그래서 constraint boundary에
  // 붙은 141c 가 sMaxIsLowerBound=true 인 채로 paSource="resolved" 로 나왔다.
  // 판정을 한 곳으로 모아 **lower bound이면 반드시 lower bound이라고 말하게** 한다.
  let sMaxLowerBound = sMaxAtLeftEdge || sMaxAtRightEdge || boundHits.length > 0 || secantExceeds;
  const lbSlope = sLowerBound && isFinite(sLowerBound.slope) ? sLowerBound.slope : -Infinity;
  // paSource 의 의미를 네 가지로 **분리**한다. 합성 격자가 가르쳐 준 구분이다:
  //   "jump"        격자가 전이를 덮어 한 스텝 안에서 끝났다 (기존)
  //   "lower-bound" **검증된 lower bound가 실제로 있다** — secant lower bound가 파라메트릭 값을 넘었다.
  //                 paReport 는 그 lower bound이고, 어떤 Δlog P 에서 나왔는지 함께 낸다.
  //   "unresolved"  파라메트릭 값이 제약·가장자리로 신뢰할 수 없지만 **더 강한 진술이 없다**.
  //                 paReport = s_max 이나 point estimate로 읽으면 안 된다.
  //   "resolved"    point estimate
  // 이전 판에서는 "제약에 걸렸으면 s_max 는 lower bound"이라고 보았는데, 합성에서 그 s_max 가
  // 참값을 1.10배 **넘는** 칸이 나왔다(w=0.03, 상승구간 5점). 제약 접촉은 값이 못 미더움을
  // 뜻할 뿐 아래쪽 보증이 아니다 — 그래서 "unresolved" 를 따로 둔다.
  // v3.8 — 국소 적합이 **식별 가능**할 때만 point estimate로 쓴다.
  // 식별 조건: ν 가 상자에 붙지 않았고, transition width가 lower bound가 아니며, ν 자유/고정 해가 2배 안.
  // 그리고 model-free lower bound와 모순되면(lower bound보다 작으면) 쓰지 않는다 — lower bound가 더 강한 진술이다.
  // **국소 적합은 헤드라인으로 쓰지 않는다** — 족 간 검증에서 남은 실패가 있다:
  //   · 전이가 격자보다 훨씬 좁으면서 모양이 비대칭이면 0.30배로 과소 보고(ν̂ 가 작게 나옴)
  //   · 문턱 아래 꼬리가 지수보다 빨리 죽으면(erf) 참 s_signal 자체가 유한하지 않다
  // 가드(ν 상자·width floor·모양비)가 경성 계단은 전부 거르지만 위 둘은 못 거른다.
  // 헤드라인이 틀리는 것보다 부차 보고로 두는 편이 낫고, 요구사항 §0 과도 맞는다.
  // 사용자는 localFit 로 값을 그대로 볼 수 있고, 무엇에 의존하는지도 함께 본다.
  const localAgreesWithBound = !!(localFit && localFit.usable && isFinite(localFit.sMax)
    && localFit.sMax >= (isFinite(lbSlope) ? lbSlope : -Infinity) - 1e-9);
  if (localFit) localFit.agreesWithBound = localAgreesWithBound;
  // o.localFitHeadline === true 로 **명시적으로** 열 수 있다. 기본은 꺼짐.
  // 자동 선택(개형을 보고 기본값을 바꾸는 것)은 판별자를 찾지 못해 보류했다 —
  // ν̂ 상자·모양비·"전이 안 점 개수" 셋 다 0.30배 실패 칸을 좋은 칸과 갈라내지 못했다
  // (전이 안 점 개수: 좋은 칸 1개 vs 실패 칸 2개 — 문턱이 존재하지 않는다).
  /* v3.12 — jump 와 secant lower bound 는 **둘 다 하한**이다. 따라서 더 큰 쪽이
   * 더 강한 진술이고, 작은 쪽을 먼저 집을 이유가 없다. 게다가 비대칭이 있다:
   *   · secant 는 두 앵커가 모두 게이트 위이고 Z=3 잡음 여유를 뺀 **엄밀한** 하한이다.
   *   · jump 는 아래쪽 앵커가 정의상 암구간(footBand)에 있어 rise 가 암잡음을
   *     그대로 물려받는다 — 같은 데이터에서 암점이 130 대신 110 으로 읽혔으면
   *     102.9 가 아니라 111.6 이 나온다(WJ-0075c 실측).
   * 그래서 jump 가 secant 보다 작으면 secant 를 쓴다. */
  /* ---- v3.12: 중재를 selectPA() 한 곳으로 ---- */
  const jumpSlope = paJump && isFinite(paJump.slope) ? paJump.slope : -Infinity;
  // occupancy·slopeProfile·bistable 은 이 지점보다 **뒤**에서 계산되므로
  // 중재에는 늦게 합류시킨다 (아래 paSelectLateJoin).
  const estimators = [
    { name: "secant", kind: "bound", value: lbSlope, basis: "secant",
      dlogP: sLowerBound ? sLowerBound.dlogP : null,
      location: sLowerBound && isFinite(sLowerBound.pLo) && isFinite(sLowerBound.pHi)
        ? Math.sqrt(sLowerBound.pLo * sLowerBound.pHi) : NaN,
      locationKind: "secant", locationObservable: true,
      bracketsTransition: false,   // 아래 앵커가 이미 점등 — 전이 내부
      ok: isFinite(lbSlope) },
    { name: "jump", kind: "bound", value: jumpSlope, basis: "jump",
      dlogP: paJump ? paJump.dlogP : null,
      location: paJump ? paJump.pth : NaN, locationKind: "ignition", locationObservable: true,
      bracketsTransition: true,    // 암 → 점등 을 감싼다 (PA 차수의 정의)
      ok: !!paJump && isFinite(jumpSlope) },
    { name: "local-fit", kind: o.localFitHeadline === true ? "point" : "diagnostic",
      value: localFit ? localFit.sMax : NaN, basis: "local", prefer: 2,
      location: localFit ? localFit.sMaxAtP : NaN, locationKind: "local", locationObservable: true,
      ok: !!(localFit && localFit.usable && localAgreesWithBound),
      why: o.localFitHeadline === true ? (localFit && localFit.why) || "식별 조건 미충족"
        : "기본 비활성 — 족 간 검증에서 남은 실패(비대칭 협전이 0.30배 과소, erf 꼬리) 때문" },
    { name: "parametric", kind: sMaxLowerBound ? "diagnostic" : "point", value: sMax,
      basis: "parametric", prefer: 1,
      location: sMaxAtP, locationKind: "model",
      locationObservable: sMaxObservable.observable !== false,
      ok: !sMaxLowerBound && sMaxObservable.observable !== false,
      why: sMaxObservable.observable === false ? sMaxObservable.why
        : (sMaxLowerBound ? `제약·가장자리에 걸림(${boundHits.length ? "constraint" : (secantExceeds ? "secant" : "range-edge")}) — 점추정으로 읽을 수 없다` : null) },
    { name: "spline-total", kind: "diagnostic", value: sTotMax, location: Math.pow(10, xTotMax),
      why: "총기울기(신호+암)라 항상 신호기울기 이하 — 교차검증용" },
  ];
  /* v3.12.1 — 결정 앵커가 **점멸 점**이면 그 숫자가 얼마나 무른지 같이 낸다.
   * 반복측정의 최솟값/평균/최댓값을 앵커로 두었을 때의 기울기 범위를 보고한다.
   * 값을 바꾸지는 않는다 — 보고값의 불확실도를 숨기지 않는 것이 목적이다. */
  let anchorSensitivity = null;
  try {
    const trP = o.paTrace && o.paTrace.P, trI = o.paTrace && o.paTrace.I, trR = o.paTrace && o.paTrace.Iraw;
    if (paJump && trP && trI && trR && isFinite(paJump.pth)) {
      let iHi = -1, bestD = Infinity;
      for (let i = 1; i < trP.length; i++) {
        const mid = Math.sqrt(trP[i] * trP[i - 1]);
        const dd = Math.abs(Math.log10(mid / paJump.pth));
        if (dd < bestD && trI[i] > trI[i - 1]) { bestD = dd; iHi = i; }
      }
      if (iHi > 0 && Array.isArray(trR[iHi]) && trR[iHi].length >= 3) {
        const reps = trR[iHi].filter(isFinite).slice().sort((a2, b2) => a2 - b2);
        const mu = reps.reduce((a2, b2) => a2 + b2, 0) / reps.length;
        const sd = Math.sqrt(reps.reduce((a2, v) => a2 + (v - mu) * (v - mu), 0) / reps.length);
        const cv = mu > 0 ? sd / mu : NaN;
        const D0 = trI[iHi - 1], h = Math.log10(trP[iHi] / trP[iHi - 1]);
        const sl = (v) => (v > 0 && D0 > 0 && h > 0) ? Math.log10(v / D0) / h : NaN;
        anchorSensitivity = {
          iAnchor: iHi, P: trP[iHi], reps, cv,
          blinking: isFinite(cv) && cv > 0.35,
          slopeAtMin: sl(reps[0]), slopeAtMean: sl(mu), slopeAtMax: sl(reps[reps.length - 1]),
        };
      }
    }
  } catch (e) { anchorSensitivity = null; }
  const paSelect = selectPA(estimators, {});
  if (paJump) paJump.supersededByBound = !!(paSelect.source === "secant" && isFinite(jumpSlope) && jumpSlope < lbSlope);
  paSelect.anchorSensitivity = anchorSensitivity;
  if (anchorSensitivity && anchorSensitivity.blinking && isFinite(anchorSensitivity.slopeAtMin) && isFinite(anchorSensitivity.slopeAtMax))
    paSelect.notes.unshift(`결정 앵커가 점멸 점(CV ${(100 * anchorSensitivity.cv).toFixed(0)}%) — 그 점을 반복 최솟값/최댓값으로 두면 기울기가 `
      + `${anchorSensitivity.slopeAtMin.toFixed(1)} ~ ${anchorSensitivity.slopeAtMax.toFixed(1)} 로 움직인다. 보고값의 자릿수를 신뢰하지 말 것`);
  let paReport = paSelect.value, paReportDlogP = paSelect.dlogP, paReportBasis = paSelect.basis || "parametric";
  let paSource;
  if (paSelect.source === "jump") paSource = "jump";
  else if (paSelect.source === "secant") paSource = "lower-bound";
  else if (paSelect.source === "local-fit") paSource = "local-fit";
  else if (paSelect.kind === "point") paSource = "resolved";
  else { paSource = "unresolved"; paReport = sMax; paReportBasis = "parametric"; }
  if (localFit) localFit.usedForReport = paSelect.source === "local-fit";

  // ---- v2.8 (P1): 고정-기울기 프로파일 우도 ----
  // 점프가 이기는(=전선이 분해되지 않은) 경우, 파라메트릭 s_max 는 "데이터가 지지하는 값"이
  // 아니라 "격자·폭lower bound가 허용한 값"일 수 있다. 그 얕은 값이 자기 우도로 기각되는지를
  // 제약 우도비로 직접 확인한다. 비용이 크므로(적합 8회) 이 조건에서만 돌린다.
  // internal:true 는 내부 재실행(부트스트랩 draw · S1 지터 · branch B)의 표식이다.
  // stabilityCheck:false 로 대신 판별하면 안 된다 — 그 값은 '이번 실행에서 안정성 검사를
  // 할지'를 뜻할 뿐이라 외부 호출자가 비용을 아끼려고 끄면 프로파일까지 조용히 꺼진다.
  let slopeProfile = null;
  // v3.7: 게이트를 '점프가 이긴 경우'에서 **lower bound 상태 전체**로 넓힌다.
  // 프로파일 우도가 필요한 상황은 "s_max 가 데이터가 아니라 제약이 정한 값일 때"이고,
  // 점프 우세는 그 여러 경로 중 하나일 뿐이다. constraint boundary(width floor)로 붙은 경우가
  // 코퍼스의 다수인데 바로 그 경우에 꺼져 있었다.
  const wantProfile = !o.internal
    && (o.profileSlope === true
        || (o.profileSlope !== false && !o.fast && ((jumpWins && paGridLimited) || sMaxLowerBound)));
  if (wantProfile) {
    // 프로파일은 '데이터가 무엇을 지지하는가'를 묻는 것이므로 가장 유연한 족(maxOrder)에서
    // 수행한다. 선택 차수로 하면 파시모니 가드가 떨어뜨린 H0/H1 에서 프로파일을 돌리게 되어
    // '그 족이 계단을 표현할 수 없다'는 사실만 재확인한다(실측: down branch H1 은 모든 upper bound에서
    // 같은 해, Δχ²=0). 같은 족 안의 중첩 제약이므로 우도비 진술은 그대로 유효하다.
    const profOrder = Math.max(chosen, Math.max(o.maxOrder, 1));
    try {
      slopeProfile = profileSlopeFloor(profOrder, x, I, sigG, lamGFinal, scaleB, o.huberC,
        mask, globalOpts, splineC, darkPrior, o.profileOpts);
    } catch (e) { slopeProfile = null; }
    if (slopeProfile) {
      slopeProfile.reportedSMax = sMax;
      // 보고된 s_max 가 프로파일 lower bound보다 얕으면 그 값은 자기 우도로 기각된 것이다
      slopeProfile.reportedRejected = isFinite(slopeProfile.floor) && sMax <= slopeProfile.floor;
    }
  }
  // 프로파일 우도 lower bound(slopeProfile.floor)은 **보고값에 넣지 않는다.**
  // 합성 격자에서 이 값이 참값을 초과하는 칸이 나왔다 — 상승 구간에 점이 3개일 때
  // 참 17.68 에 대해 floor 30, 심한 칸은 250 (14배). 원인: 족이 자료를 표현하지 못하면
  // 그 부적합이 Δχ² 를 부풀려 낮은 upper bound들이 **거짓으로 기각**된다. 즉 우도 진술 자체가
  // 오지정 아래에서 교정돼 있지 않다. lower bound를 자처하면서 참값을 넘는 것은 point estimate 오차보다
  // 나쁘므로, 이 값은 진단으로만 남기고 paReport 에서는 뺀다.
  // (secant lower bound는 같은 격자 178칸에서 참값 초과 0건이었다 — 그래서 그쪽만 쓴다.)
  if (slopeProfile) slopeProfile.usedForReport = false;

  // ---- v3.0: 점멸(duty cycle) 관측층 ----
  // 반복 측정의 분산은 지금까지 노이즈 법칙 추정에만 쓰고 버렸다. bistable 점멸이 있는
  // setpoint 에서는 그 분산이 **신호**다 — 어떤 점이 두 상태의 혼합인지, occupancy가 얼마인지,
  // dwell 안에서 얼마나 평균화됐는지를 모델과 무관하게 알려준다.
  // internal:true(부트스트랩 draw · S1 지터 · branch B)에서는 계산하지 않는다 —
  // 그 경로는 이 결과를 소비하지 않는데 draw 마다 비용만 곱해진다.
  // ---- v3.2: cross-branch occupancy ----
  // 히스테리시스가 있으면 반대 branch가 같은 파워의 고상태를 **직접 측정**한다.
  // branch 내 추정(위)은 그 준위를 외삽해야 하는데, 외삽에 쓰는 점들이 아직 부분 점등이면
  // 준위가 과소평가되어 f̂ 가 1 쪽으로 부풀어 오른다 — 이쪽이 그 계통을 원리적으로 없앤다.
  let crossOcc = null;
  if (o.crossBranch !== false && o.paTrace && !o.internal
      && (o.branchName === "up" || o.branchName === "down")) {
    try { crossOcc = crossBranchOccupancy(o.paTrace, o.branchName, { bleachLimit: o.bleachLimit }); }
    catch (e) { crossOcc = null; }
  }
  let occupancy = null;
  if (o.occupancy !== false && reps && !o.internal) {
    try {
      occupancy = occupancyFromReplicates(x, I, reps, sigmaTotOf,
        { fdr: o.occFdr, crossOcc, screenOcc: o.screenOcc });
    }
    catch (e) { occupancy = null; }
  }
  // 두 추정이 같은 파워에서 얼마나 다른가 — v3.0/v3.1 의 branch 내 값이 편향됐음을 드러낸다
  if (crossOcc && crossOcc.checked && crossOcc.valid && occupancy && occupancy.checked) {
    const byIdx = new Map(crossOcc.rows.map((r) => [Math.round(r.x * 1e6), r]));
    const cmp = [];
    for (const r of occupancy.rows) {
      if (!r.blink || !isFinite(r.fMean)) continue;
      let best = null, bd = Infinity;
      for (const c of crossOcc.rows) { const dd = Math.abs(c.x - r.x); if (dd < bd) { bd = dd; best = c; } }
      if (best && bd < 0.002) cmp.push({ P: r.P, fWithin: r.fMean, fCross: best.f, ratio: r.fMean / Math.max(best.f, 1e-9) });
    }
    crossOcc.vsWithin = cmp;
    crossOcc.withinBiasMedian = cmp.length ? median(cmp.map((c) => c.ratio)) : NaN;
  }

  // ---- v2.9: bistable 서술 (BistableFit) ----
  // H 족이 전선을 매끄러운 시그모이드로 근사하는 한 s_max 는 유한하지 않다(v2.8 프로파일).
  // 같은 데이터를 '저상태 멱법칙 + 고상태 멱법칙 + 전환 파워 + 전환 폭'으로 서술하면
  // 보고량이 전부 유한해진다. 두 족은 같은 강건 코어·같은 공통 마스크 χ² 를 쓰므로
  // AICc 로 직접 비교할 수 있다(robustFitCore 를 공유하는 이유).
  let bistable = null;
  // ── v3.4: occupancy 제약의 출처 결정 ──
  // cross-branch f 는 반대 branch가 **같은 파워의 고상태를 직접 측정**한 값이므로 외삽이 없다.
  // 그것이 유효하고(간극 있음·계단형 광퇴색 없음) 절대 occupancy로 읽을 수 있을 때만 쓴다.
  // 참값 대조(합성 11조건×3씨앗, 제약이 걸린 33건):
  //   n_high 중앙오차 517% → 18% · P_s 11% → 0% · 폭 73% → 11%.
  //   대가: n_high 붕괴(<0.5) 0건 → 2건(6%). 그 2건은 NHIGH_FLOOR 로 unidentified 처리된다.
  // 게이트가 거부한 조건에서는 v3.3 과 완전히 동일하게 동작한다.
  let occConstraint = null, occSourceUsed = "none";
  const crossUsable = !!(crossOcc && crossOcc.checked && crossOcc.valid && crossOcc.absolute);
  const useOccEff = o.useOccupancy === false ? false
    : (o.useOccupancy === true ? true : crossUsable);
  const skewEff = o.skew === false ? false : (o.skew === true ? true : crossUsable);
  if (useOccEff && crossUsable && o.occSource !== "within") {
    const a2 = crossOcc.rows
      .filter((r) => isFinite(r.f) && isFinite(r.fSd) && r.fSd > 0 && r.f > -0.05 && r.f < 1.05)
      .map((r) => ({ x: r.x, f: clamp(r.f, 0, 1), sd: r.fSd }));
    if (a2.length >= 4) { occConstraint = a2; occSourceUsed = "cross"; }
  }
  if (useOccEff && !occConstraint && occupancy && occupancy.checked) occSourceUsed = "within";
  const wantBistable = !o.internal && o.bistable !== false && !o.fast
    && (o.bistable === true
      || (paJump && isFinite(paJump.slope) && paJump.slope > 3)
      || (slopeProfile && slopeProfile.verdict === "unbounded")
      || boundHits.length > 0);
  if (wantBistable) {
    try {
      bistable = bistableAnalyze(x, I, sigG, lamGFinal, scaleB, o.huberC, mask, globalOpts,
        splineC, darkPrior, medianDx,
        // **branch 내** occupancy 제약은 여전히 기본 꺼짐이다(v3.1 재확인: 개선 4·악화 1·무변화 7 —
        // 사실상 무변화). 기본으로 켠 것은 **cross-branch** 제약뿐이다(위 occSourceUsed 참조).
        // 두 추정의 차이는 실측에서 ×2.87 이며, 그 기원은 v3.3 에서 세 가설을 모두 기각한 뒤
        // **미상으로 남아 있다** — 재현되는 불일치만 확립되어 있다.
        { aiccGuard: o.aiccGuard, fast: o.fast,
          useOccupancy: occSourceUsed === "within",
          skew: skewEff, occData: occConstraint },
        occupancy);
    } catch (e) { bistable = null; }
    if (bistable) {
      const hA = fits[chosen] ? fits[chosen].aicc : Infinity;
      bistable.aiccVsH = bistable.aicc - hA;
      bistable.hAicc = hA;
      // 어느 서술이 더 지지되는가 — parsimony guard 와 같은 문턱을 쓴다
      bistable.preferred = isFinite(hA) && bistable.aicc < hA - o.aiccGuard;
      bistable.curve = grid.map((xv) => bistableI(bistable.params, xv, bistable.chosenOrder));
      bistable.lowCurve = grid.map((xv) => Math.pow(10, clamp(bistable.params.aL + bistable.params.nL * xv, -300, 300)));
      bistable.highCurve = grid.map((xv) => Math.pow(10, clamp(bsHighH(bistable.params, xv, bistable.chosenOrder), -300, 300)));
      bistable.fCurve = grid.map((xv) => bsOcc(bistable.params, xv));
      // ── 적합된 전환과 **관측된 occupancy**이 맞는가 ──
      // 제약으로 넣지 않더라도 이 대조는 공짜로 얻어진다. 어긋나면 그 자체가 결과다:
      // 모델이 그린 전환이 실제 점멸 관측과 다르다는 뜻이다.
      if (occupancy && occupancy.checked) {
        const rws = occupancy.rows.filter((r) => r.blink && r.mixtureConsistent
          && isFinite(r.fMean) && isFinite(r.fSd) && r.fSd > 0);
        const chk = rws.map((r) => {
          const fm = bsOcc(bistable.params, r.x);
          return { i: r.i, P: r.P, fMeasured: r.fMean, fSd: r.fSd, fModel: fm,
            z: (fm - r.fMean) / r.fSd };
        });
        const zs = chk.map((c) => c.z).filter(isFinite);
        bistable.occCheck = {
          n: chk.length, rows: chk,
          chi2: zs.reduce((a2, z) => a2 + z * z, 0),
          maxAbsZ: zs.length ? Math.max(...zs.map(Math.abs)) : NaN,
          // |z| > 3 인 점이 있으면 모델의 전환과 관측된 점멸이 어긋난 것이다
          agrees: zs.length ? Math.max(...zs.map(Math.abs)) <= 3 : null,
          constrained: !!bistable.occUsed,
        };
      }
    }
  }

  // ---- v2.7 (S1): 선택 안정성 검사 (전체 파이프라인 재실행) ----
  // 이 엔진에서 실제로 위험한 실패는 "못 맞춘다"가 아니라 "우연히 어느 branch에 떨어졌는가로
  // 보고값이 바뀐다"이다. 실측(WJ-0075c down): 파워값에 상대 1e-12 — 측정 정밀도보다
  // 9 자릿수 작은 — 요동을 주면 선택 차수가 H0↔H2 로 뒤집히고 χ²(H2)가 7,266↔12,509 로
  // 오간다. 이런 결과는 "더 잘 맞추기"가 아니라 "보고 불가"로 처리해야 한다.
  //
  // 왜 적합 단계만 흔들면 안 되는가: 이 불안정은 적합 하나가 아니라 파이프라인 전체
  // (노이즈 법칙 → 스플라인 → 이상치 마스크 → 시작점 → 적합)를 타고 증폭된다. 실제로
  // 적합 단계에만 1e-9 지터를 주면 아무것도 잡히지 않고, 전체를 다시 돌려야 드러난다.
  // 그래서 비용(analyze 2회 추가)을 감수하고 전 과정을 재실행한다. 부트스트랩 draw 에는
  // stabilityCheck:false 로 꺼 둔다(본 적합의 성질이지 draw 마다 볼 것이 아니다).
  let stability = { checked: false };
  if (o.stabilityCheck !== false) {
    const seen = new Set([chosen]);
    const sVals = [sMax];
    for (const [jSeed, dSeed] of [[7331, 20260915], [9137, 20261001]]) {
      const jr = makeRng(jSeed);
      const jit = (arr) => arr.map((v) => v * (1 + 1e-9 * jr.normal()));
      const bJ = {
        powerAvg: jit(branch.powerAvg), intensityAvg: jit(branch.intensityAvg),
        powerStd: branch.powerStd, intensityStd: branch.intensityStd,
        intensityReplicates: branch.intensityReplicates, aggApplied: branch.aggApplied,
        aggEffective: branch.aggEffective, acqTime: branch.acqTime, counting: branch.counting,
      };
      try {
        const aj = analyze(bJ, Object.assign({}, o, { stabilityCheck: false, internal: true, deSeed: dSeed, nGrid: 120 }));
        seen.add(aj.chosenOrder); sVals.push(aj.sMax);
      } catch (e) { /* 재실행 실패 자체가 불안정의 증거는 아니므로 무시 */ }
    }
    const fin = sVals.filter(isFinite);
    const mu = fin.length ? fin.reduce((a2, b2) => a2 + b2, 0) / fin.length : NaN;
    const sd = fin.length > 1 ? Math.sqrt(fin.reduce((a2, v) => a2 + (v - mu) * (v - mu), 0) / (fin.length - 1)) : 0;
    const cv = isFinite(mu) && Math.abs(mu) > 1e-12 ? sd / Math.abs(mu) : NaN;
    stability = {
      checked: true, ordersSeen: Array.from(seen).sort(), orderStable: seen.size === 1,
      sMaxValues: fin, sMaxCV: cv, sMaxStable: !(cv > 0.10),
      stable: seen.size === 1 && !(cv > 0.10), jitterRel: 1e-9,
    };
  }

  /* v3.12 — 늦게 계산되는 층을 중재 결과에 합류시킨다. 이 셋은 전부 진단용이지만
   * "왜 헤드라인이 아닌가" 를 기록으로 남겨야 사용자가 26배 흩어진 숫자들을 보고
   * 혼란스러워하지 않는다. blinking 은 값이 아니라 **주의**로 붙는다. */
  {
    const blinkAtIgnition = !!(occupancy && Array.isArray(occupancy.blinkIdx) && ignition && ignition.usable
      && occupancy.blinkIdx.some((i) => i >= ignition.iDark - 1 && i <= ignition.iLit + 2));
    if (blinkAtIgnition)
      paSelect.notes.unshift("점화 구간의 반복측정이 과분산 — 확률적 스위칭(blinking). 그 점의 평균은 재현되지 않는다");
    paSelect.blinkAtIgnition = blinkAtIgnition;
    if (slopeProfile && isFinite(slopeProfile.floor))
      paSelect.rejected.push({ name: "profile-floor", value: slopeProfile.floor,
        why: "프로파일 우도 floor 는 희소표본 칸에서 참값을 최대 14배 넘겼다(v2.8 검증) — 진단용" });
    if (bistable && bistable.params && isFinite(bistable.params.nH))
      paSelect.rejected.push({ name: "bistable-nHigh", value: bistable.params.nH,
        why: "쌍안정 족의 고상태 지수 — 다른 모델족의 값이라 직접 비교 대상 아님" });
  }

  const modelCurve = grid.map((xv) => modelI(p, xv, chosen));
  const splineCurve = grid.map((xv) => {
    const yv = splineC.fitAt(xv);
    return Math.pow(10, yv); // display in I units (≈ exact for I>>λ)
  });

  return {
    engine: "PrismFit", version: VERSION, options: o,
    data: { P, I, x, sigI, sigG, y, nReps: nRepsArr },
    noise: { a0: vm.a0, a1: vm.a1, a2: vm.a2, source: vm.source, lamG: lamGFinal,
      counting: noiseBox.cnt ? { a0: noiseBox.cnt.a0, a1: noiseBox.cnt.a1, a2: noiseBox.cnt.a2 } : null,
      a2Excess: noiseBox.excess, excessRho: noiseBox.rho !== undefined ? noiseBox.rho : null, excessRejected: noiseBox.excessRejected !== undefined ? noiseBox.excessRejected : null, acqTime: isFinite(o.acqTime) ? o.acqTime : null,
      poissonFloor: (o.counting && isFinite(o.acqTime) && o.acqTime > 0) ? 1 / o.acqTime : null },
    spline: { lambda: splineC.lambda, edf: splineC.edf, monotone: !!o.monotone },
    grid, sTot, sSig, modelCurve, splineCurve,
    sMaxObservable, sMaxObs, sMaxObsAtP, paSelect, anchorSensitivity,
    fitsSummary: Object.fromEntries(Object.entries(fits).map(([k2, f]) => [k2, f ? { aicc: f.aicc, chi2: f.chi2, k: f.k } : null])),
    chosenOrder: chosen, params: p, theta: fit.theta, paramSE,
    paReport, paSource, paGridLimited, paReportDlogP, paReportBasis,
    paJump, paDark, darkPrior,
    paThreshold: jumpWins ? paJump.pth : (isFinite(thresholdUsed) ? thresholdUsed : sMaxAtP),
    sMax, sMaxAtP, sTotMax, sTotMaxAtP: Math.pow(10, xTotMax),
    sMaxIsLowerBound: sMaxLowerBound,
    sMaxEdge: sMaxAtLeftEdge ? "left" : (sMaxAtRightEdge ? "right" : null),
    sMaxBoundReason: boundHits.length ? "constraint"
      : (secantExceeds ? "secant" : ((sMaxAtLeftEdge || sMaxAtRightEdge) ? "range-edge" : null)),
    sLowerBound, sLowerBoundRaw, secantExceeds, darkFloor: darkInfo, localFit,
    boundHits, wFloor: W_FLOOR.v, medianDlogP: medianDx, stability,
    slopeProfile,
    bistable, occupancy, crossOcc, occSourceUsed,
    occConstraintN: occConstraint ? occConstraint.length : 0,
    aggEffective: branch.aggEffective || "none", aggApplied: aggArr.slice(),
    thresholdOutOfRange,
    thresholdP: thresholdUsed, thresholdPModel, thresholdSource, thresholdBracket, ignition,
    saturationP, background: p.B, slopeVaries,
    // v2.7 (T1) 접선-교점 문턱. spline 쪽은 파라메트릭과 독립이므로 파라메트릭이
    // 실패해도 값이 남는다 — 결과 카드·뷰어는 t1 이 NaN 이거나 boundHits 가 있을 때
    // 이쪽을 주 보고값으로 쓴다.
    thresholdTangent: {
      model: tangentThreshold(grid, modelCurve.map((v) => Math.log10(Math.max(v, 1e-300))), sSig),
      spline: tangentThreshold(grid, splineCurve.map((v) => Math.log10(Math.max(v, 1e-300))), sTot),
    },
    diagnostics: { runsP: rt.p, runsZ: rt.z, chi2red, maxParamCorr: maxCorr, nUsed: nMask, nTotal: n, outliers: outlierIdx.slice(), frontScatter: frontScatter.slice(), huberDownweighted: fit.irlsW.filter((w, i) => mask[i] && w < 0.999).length },
    mask,
    agreement: agree,
    rawResid: fit.rawResid,
  };
}

/* ------------------------------ bootstrap --------------------------------- */
/**
 * Seeded residual bootstrap: e*_i drawn from studentized residual pool,
 * y*_i = model_i + e*_i·σ_g,i (in glog space), inverse-mapped to I*, refit
 * the SELECTED order with warm start. Returns CIs and s(x) band.
 */
function bootstrap(analysis, opts, progressCb) {
  const o = Object.assign({ nBoot: 150, seed: 20260808 }, opts);
  const { data, noise, chosenOrder, theta, options, mask } = analysis;
  const lamG = noise.lamG;
  // cleaned data (fitted set)
  const P = [], I = [], sigG = [], nReps = [];
  for (let i = 0; i < data.x.length; i++) {
    if (!mask || mask[i]) { P.push(data.P[i]); I.push(data.I[i]); sigG.push(data.sigG[i]); nReps.push(data.nReps[i]); }
  }
  const n = P.length;
  const x = P.map((v) => Math.log10(v));
  const p0 = analysis.params;
  const modelG = x.map((xv) => glog10(modelI(p0, xv, chosenOrder), lamG));
  // noise scale correction: robust std of studentized residuals with global
  // degrees-of-freedom inflation (variance model may under/over-estimate)
  const kPar = (theta || []).length || 3;
  const resid = x.map((xv, i) => (glog10(I[i], lamG) - modelG[i]) / sigG[i]);
  const scaleFactor = Math.max(0.7, (mad(resid) || 1) * Math.sqrt(n / Math.max(n - kPar, 1)));

  /* FULL-PIPELINE bootstrap: each draw regenerates replicate-level data from
   * the fitted model + variance model, then repeats the ENTIRE analysis
   * (variance-model estimation, spline, outlier flags, all nested fits and
   * order selection). Conditioning on any of those steps was measured to
   * hide ~75% of the estimator variance — so nothing is conditioned on. */
  const rows = [];
  const sGridRows = [];
  const gridSub = analysis.grid.filter((_, i) => i % 4 === 0);
  let orderFlips = 0;
  for (let b = 0; b < o.nBoot; b++) {
    const rng = makeRng(o.seed + b * 104729);
    const reps = [], means = [];
    for (let i = 0; i < n; i++) {
      const mu = modelI(p0, x[i], chosenOrder);
      // single-replicate sd from the variance model, rescaled
      const sd1 = Math.sqrt(Math.max(noise.a0 * noise.a0 + noise.a1 * Math.max(mu, 0) + noise.a2 * noise.a2 * mu * mu, 1e-300)) * scaleFactor;
      const row = [];
      const nr = Math.max(nReps[i] | 0, 1);
      for (let rI = 0; rI < nr; rI++) row.push(mu + sd1 * rng.normal());
      reps.push(row);
      means.push(row.reduce((a2, b2) => a2 + b2, 0) / row.length);
    }
    const branchB = { powerAvg: P.slice(), intensityAvg: means, powerStd: P.map(() => 0), intensityStd: means.map(() => 0), intensityReplicates: reps };
    let ab;
    try {
      // COLD full re-analysis: warm-starting at th-hat was measured to halve
      // the bootstrap dispersion (basin lock-in) — do not warm-start.
      // 안정성 검사는 '본 적합의 성질'이므로 draw 마다 돌리지 않는다(비용 3배 × nBoot).
      ab = analyze(branchB, Object.assign({}, options, { fast: false, nGrid: 120, stabilityCheck: false, internal: true }));
    } catch (e) { continue; }
    if (ab.chosenOrder !== chosenOrder) orderFlips++;
    rows.push({
      sMax: ab.sMax, sMaxAtP: ab.sMaxAtP,
      threshold: ab.thresholdP, saturation: ab.saturationP,
      B: ab.background, k1: ab.params.k1, k2: ab.params.k2, k3: ab.params.k3,
    });
    // slope on shared grid (order may differ per draw — honest)
    sGridRows.push(gridSub.map((xv) => slopeOf(ab.params, xv, ab.chosenOrder)));
    if (progressCb && b % 5 === 4) progressCb((b + 1) / o.nBoot, `bootstrap ${b + 1}/${o.nBoot}`);
  }
  // BASIC (reflected) CI — first-order bias corrected; log-space for scale
  // quantities. Half-widths are inflated by KAPPA, a dispersion calibration
  // factor measured on the synthetic benchmark suite (the bootstrap of a
  // sharp-transition max-functional is intrinsically underdispersed even
  // when the full pipeline is re-run; κ=1.6 restores ≥90% empirical
  // coverage across benchmark scenarios — see tests/test_fit2.js).
  const KAPPA = 1.6;
  const basicCI = (key, hat, logScale, nonneg) => {
    const vals = finite(rows.map((r) => r[key]));
    if (vals.length < 10 || !isFinite(hat)) return [NaN, NaN];
    if (logScale) {
      const lh = Math.log10(Math.max(hat, 1e-300));
      const lo0 = 2 * lh - Math.log10(Math.max(quantile(vals, 0.975), 1e-300));
      const hi0 = 2 * lh - Math.log10(Math.max(quantile(vals, 0.025), 1e-300));
      const c = 0.5 * (lo0 + hi0);
      return [Math.pow(10, c - KAPPA * (c - lo0)), Math.pow(10, c + KAPPA * (hi0 - c))];
    }
    const lo0 = 2 * hat - quantile(vals, 0.975), hi0 = 2 * hat - quantile(vals, 0.025);
    const c = 0.5 * (lo0 + hi0);
    let lo2 = c - KAPPA * (c - lo0), hi2 = c + KAPPA * (hi0 - c);
    if (nonneg) { lo2 = Math.max(lo2, 0); hi2 = Math.max(hi2, 0); }
    return [lo2, hi2];
  };
  const band = gridSub.map((xv, gi) => {
    const col = finite(sGridRows.map((row) => row[gi]));
    return col.length >= 10 ? [quantile(col, 0.025), quantile(col, 0.975)] : [NaN, NaN];
  });
  return {
    nBoot: o.nBoot, nSuccess: rows.length, seed: o.seed, deterministic: true,
    method: "full-pipeline parametric (replicate-level), basic CI",
    scaleFactor, orderFlips,
    ci: {
      sMax: basicCI("sMax", analysis.sMax, false, true),
      sMaxAtP: basicCI("sMaxAtP", analysis.sMaxAtP, true),
      threshold: basicCI("threshold", analysis.thresholdP, true),
      saturation: basicCI("saturation", analysis.saturationP, true),
      B: basicCI("B", analysis.background, true),
      k2: basicCI("k2", analysis.params.k2, false, true),
    },
    slopeBand: { x: gridSub, lo: band.map((b) => b[0]), hi: band.map((b) => b[1]) },
  };
}

/* ------------------------------- evaluate ---------------------------------- */
/**
 * Transparent quality score (0–100), components documented:
 *  adequacy   40% : runs-test p (systematic misfit) + reduced chi² window
 *  identify   25% : bootstrap (or sandwich) relative CI of s_max & threshold
 *  coverage   20% : decades spanned, points/decade, points near threshold
 *  agreement  15% : spline↔parametric s_max gap
 */
function evaluate(analysis, boot) {
  const d = analysis.diagnostics;
  // adequacy
  const pRuns = d.runsP;
  const aRuns = isFinite(pRuns) ? clamp(pRuns / 0.10, 0, 1) : 0.5; // p≥0.10 → full
  const c2 = d.chi2red;
  const aChi = isFinite(c2) ? clamp(1 - Math.abs(Math.log(Math.max(c2, 1e-6))) / Math.log(8), 0, 1) : 0.5; // full at 1, zero at ×8 off
  const adequacy = 100 * (0.6 * aRuns + 0.4 * aChi);
  // identifiability
  let ident = 50;
  if (boot && boot.ci) {
    const rel = (ciPair, val) => {
      if (!isFinite(val) || !isFinite(ciPair[0]) || !isFinite(ciPair[1])) return NaN;
      return (ciPair[1] - ciPair[0]) / 2 / Math.max(Math.abs(val), 1e-12);
    };
    const rS = rel(boot.ci.sMax, analysis.sMax);
    const rT = isFinite(analysis.thresholdP) ? (Math.log10(Math.max(boot.ci.threshold[1], 1e-300)) - Math.log10(Math.max(boot.ci.threshold[0], 1e-300))) / 2 : NaN;
    const iS = isFinite(rS) ? clamp(1 - (rS - 0.05) / 0.45, 0, 1) : 0.5;   // ≤5% rel half-width → full, ≥50% → 0
    const iT = isFinite(rT) ? clamp(1 - (rT - 0.05) / 0.45, 0, 1) : iS;     // decades half-width
    ident = 100 * (0.6 * iS + 0.4 * iT);
  } else if (isFinite(d.maxParamCorr)) {
    ident = 100 * clamp(1 - Math.max(d.maxParamCorr - 0.95, 0) / 0.05, 0, 1) * 0.8;
  }
  // v2.6 (E4): constraint boundary에 붙은 파라미터가 있으면 s_max 는 point estimate가 아니다.
  const nBound = (analysis.boundHits || []).length;
  if (nBound > 0) ident = Math.min(ident, 100 * clamp(0.30 - 0.10 * (nBound - 1), 0, 1));
  // v2.7 (S1): 옵티마이저 조건만 바꿔도 차수·s_max 가 달라지면 그 값은 데이터의 성질이 아니다.
  const st = analysis.stability;
  const unstable = !!(st && st.checked && !st.stable);
  if (unstable) ident = Math.min(ident, 10);
  // coverage
  const x = analysis.data.x;
  const decades = x[x.length - 1] - x[0];
  const ptsPerDec = analysis.data.x.length / Math.max(decades, 0.1);
  let nearTh = 0;
  if (isFinite(analysis.thresholdP)) {
    const t = Math.log10(analysis.thresholdP);
    nearTh = x.filter((xv) => Math.abs(xv - t) <= 0.3).length;
  } else nearTh = 6;
  const cDec = clamp(decades / 2, 0, 1);
  const cPts = clamp(ptsPerDec / 8, 0, 1);
  const cTh = clamp(nearTh / 6, 0, 1);
  const coverage = 100 * (0.4 * cDec + 0.3 * cPts + 0.3 * cTh);
  // agreement
  const g = analysis.agreement.sMaxGapPct;
  const agreement = isFinite(g) ? 100 * clamp(1 - (g - 5) / 45, 0, 1) : 50;
  const score = 0.40 * adequacy + 0.25 * ident + 0.20 * coverage + 0.15 * agreement;
  const band = score >= 85 ? "High" : score >= 65 ? "Moderate" : score >= 45 ? "Low" : "Poor";
  return {
    score, band, reportable: score >= 60 && nBound === 0 && !unstable,
    components: { adequacy, identifiability: ident, coverage, agreement },
    boundHits: analysis.boundHits || [], stability: st || null, unstable,
    detail: { runsP: pRuns, chi2red: c2, decades, ptsPerDec, pointsNearThreshold: nearTh, sMaxGapPct: g, nBoundHits: nBound },
  };
}

/* ------------------------ synthetic data (validation) ---------------------- */
function synth(scenario, seed) {
  const rng = makeRng(seed || 1);
  const s = Object.assign({
    n: 60, reps: 3, xlo: -3, xhi: -1.2,
    B: 100, c: 8.5, k1: 0.3, k2: 8, k3: 0.4, t1: -2.2, t2: -1.7, w: 0.08, v: 0.10, order: 2,
    a0: 20, a1: 0.5, a2: 0.03, outlierFrac: 0,
  }, scenario);
  const p = { B: s.B, c: s.c, k1: s.k1, k2: s.k2, k3: s.k3, t1: s.t1, t2: s.t2, w: s.w, v: s.v };
  const P = [], I = [], reps = [];
  for (let i = 0; i < s.n; i++) {
    const x = s.xlo + (s.xhi - s.xlo) * i / (s.n - 1);
    const Pi = Math.pow(10, x);
    const mu = modelI(p, x, s.order);
    const sd = Math.sqrt(s.a0 * s.a0 + s.a1 * mu + s.a2 * s.a2 * mu * mu);
    const row = [];
    for (let rIdx = 0; rIdx < s.reps; rIdx++) {
      let v = mu + rng.normal() * sd;
      if (s.outlierFrac > 0 && rng.uniform() < s.outlierFrac) v = mu * (1 + 3 * rng.normal());
      row.push(v);
    }
    P.push(Pi); reps.push(row);
    I.push(row.reduce((a, b) => a + b, 0) / row.length);
  }
  // true headline values
  const grid = [];
  for (let i = 0; i < 400; i++) grid.push(s.xlo + (s.xhi - s.xlo) * i / 399);
  let sm = -Infinity, xm = grid[0];
  for (const xv of grid) { const sl = slopeOf(p, xv, s.order); if (sl > sm) { sm = sl; xm = xv; } }
  return {
    branch: { powerAvg: P, intensityAvg: I, powerStd: P.map(() => 0), intensityStd: I.map(() => 0), intensityReplicates: reps },
    truth: { sMax: sm, sMaxAtP: Math.pow(10, xm), threshold: s.order >= 1 && s.k2 > s.k1 ? Math.pow(10, s.t1) : NaN, B: s.B, params: p, order: s.order },
  };
}


/* ==================== 점멸(duty cycle) 관측층 — v3.0 =========================
 *
 * 무엇을 보는가: 한 setpoint 안의 **반복 측정 분산**. 지금까지 엔진은 반복을 노이즈 법칙
 * 추정에만 쓰고 버렸다. 그런데 bistable 점멸이 일어나는 setpoint 에서는 반복이 저상태와
 * 고상태 사이에서 갈리므로 분산이 계수통계 기대치를 크게 넘는다 — 이것은 노이즈가 아니라
 * **신호**다.
 *
 * 왜 필요한가(v2.9 가 남긴 축퇴): 점화 중간 준위(예: 저 130 → 중간 984 → 고 13,748 cps)를
 * 모델은 두 가지로 설명할 수 있다 — (a) occupancy f 가 중간값, (b) 고상태 멱법칙이 그 점을
 * 지나도록 가팔라짐. 둘이 유연성을 나눠 쓰는 한 n_high 가 결정되지 않는다.
 * 반복 분산은 이 둘을 가른다: (a)이면 과분산, (b)이면 계수통계 그대로.
 *
 * ── 단일 파일에 맞추지 않기 위한 설계 규칙 ──
 *  1) 임계값을 눈으로 고르지 않는다. 귀무분포는 s²·ν/σ² ~ χ²_ν 로 **알려져 있다**.
 *  2) 기준 분산 σ² 는 이 파일의 노이즈 법칙에서 온다(계수·드리프트 성분 포함) — 검출기가
 *     바뀌어도 자동으로 맞춰진다. 계수 자료가 아니어도 같은 절차가 성립한다.
 *  3) 척도는 **중앙값으로 자가보정**한다. 애프터펄싱·레이저 요동처럼 전 구간에 고르게
 *     깔린 초과분산은 귀무에 흡수되고, 국소적으로 튀는 setpoint 만 남는다.
 *  4) 다중검정은 BH-FDR 로 통제한다 — 거짓양성률이 '설계된 값'이지 관측된 값이 아니다.
 *  5) 절반 이상이 걸리면 그것은 bistable가 아니라 장치 문제다 — 그렇게 보고한다.
 */
/** 정규화 하부 불완전 감마 P(a, x) — 급수/연분수. χ² CDF 에 쓴다. */
function lowerGammaP(a, xv) {
  if (!(xv > 0) || !(a > 0)) return 0;
  const lg = lnGamma(a);
  if (xv < a + 1) {
    let ap = a, sum = 1 / a, del = sum;
    for (let i = 0; i < 500; i++) {
      ap += 1; del *= xv / ap; sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-14) break;
    }
    return sum * Math.exp(-xv + a * Math.log(xv) - lg);
  }
  let b = xv + 1 - a, c = 1e300, d = 1 / b, h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a);
    b += 2; d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d; const del = d * c; h *= del;
    if (Math.abs(del - 1) < 1e-14) break;
  }
  return 1 - Math.exp(-xv + a * Math.log(xv) - lg) * h;
}
function lnGamma(z) {
  const g = [676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012,
    9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z);
  z -= 1;
  let a2 = 0.99999999999980993;
  const t = z + 7.5;
  for (let i = 0; i < g.length; i++) a2 += g[i] / (z + i + 1);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a2);
}
/** χ²_ν 상측 꼬리 확률 */
function chi2SF(xv, nu) {
  if (!(nu > 0)) return NaN;
  if (!(xv > 0)) return 1;
  return 1 - lowerGammaP(nu / 2, xv / 2);
}
/** Benjamini–Hochberg: p 값 배열에서 FDR q 를 만족하는 기각 집합의 p 임계값 */
function bhThreshold(ps, q) {
  const m = ps.length;
  if (!m) return 0;
  const srt = ps.slice().sort((a, b) => a - b);
  let thr = 0;
  for (let k = 0; k < m; k++) if (srt[k] <= ((k + 1) / m) * q) thr = srt[k];
  return thr;
}

/**
 * setpoint 별 과분산 판정과 occupancy 추정.
 *
 * 반환 rows[i] = { i, x, P, mean, varObs, varNull, ratio, p, blink,
 *                  fMean, fVar, kappa, loLevel, hiLevel }
 *  - fMean : 평균에서 나온 occupancy = (R − R_lo)/(R_hi − R_lo) — **값**을 준다
 *  - blink : 과분산 판정 — 그 값이 '혼합 해석으로 읽어도 되는가'의 **타당성**을 준다
 *  - kappa : 관측 초과분산 / 완전 이산 점멸이 낼 분산 f(1−f)ΔR².
 *            1 에 가까우면 dwell 안에서 한 상태에 머물렀다는 뜻, 0 에 가까우면
 *            dwell 안에서 여러 번 점멸해 평균화됐다는 뜻. 둘 다 물리적으로 의미가 있다.
 */
function occupancyFromReplicates(x, I, reps, sigmaOfI, opts) {
  const o = opts || {};
  const q = isFinite(o.fdr) ? o.fdr : 0.01;
  const minRep = isFinite(o.minRep) ? o.minRep : 3;
  const n = x.length;
  if (!reps || !reps.length) return { checked: false, reason: "반복 측정 없음" };
  const rows = [];
  for (let i = 0; i < n; i++) {
    const r = (reps[i] || []).filter((v) => isFinite(v));
    if (r.length < minRep) continue;
    const m = r.reduce((a, b) => a + b, 0) / r.length;
    let v = 0;
    for (const vv of r) v += (vv - m) * (vv - m);
    v /= (r.length - 1);
    const sN = sigmaOfI(Math.max(m, 0));
    if (!(isFinite(sN) && sN > 0)) continue;
    rows.push({ i, x: x[i], P: Math.pow(10, x[i]), mean: m, varObs: v, nRep: r.length,
      nu: r.length - 1, varNull: sN * sN, ratio: v / (sN * sN) });
  }
  if (rows.length < 6) return { checked: false, reason: `유효 setpoint ${rows.length}개 — 판정 불가` };
  // ── 척도 자가보정 ──
  // 요구사항이 두 개이고 서로 반대 방향으로 실패한다:
  //  (1) 전역 중앙값 하나 → 노이즈 법칙의 **모양**이 세기에 따라 어긋나면 흡수하지 못한다.
  //      (실측: 곱셈 잡음 a₂=3% 인 '점멸 없는' 합성에서 거짓양성 8.3%, 설계 FDR 1%)
  //  (2) 국소 중앙값(창) → 전환이 창보다 **넓으면** 창 전체가 점멸 구간이어서
  //      신호를 귀무에 흡수해 버린다. (실측: ω=0.03 에서 전환이 12 setpoint 에 걸치자
  //      원시 분산비 17~94 인 점들이 보정 후 ~1 이 되어 한 점도 검출되지 않음)
  // 둘 다 피하려면 **모든 점을 쓰되 이상점에 끌리지 않는** 추세 추정이 필요하다.
  // log r 을 log R 의 1차식으로 Theil–Sen(반복 중앙값 기울기)으로 맞춘다 —
  // 붕괴점이 ~29% 이므로 전환 구간이 점의 1/4 이하이면 추세가 오염되지 않고,
  // 세기에 따라 기우는 법칙 오차는 추세가 그대로 흡수한다. 창 크기 같은 임의 상수가 없다.
  const nuMed = median(rows.map((r) => r.nu));
  const medChi = Math.max(1 - 2 / (9 * nuMed), 1e-6);   // median(χ²_ν/ν) 근사
  {
    const lr = rows.map((r) => Math.log(Math.max(r.ratio, 1e-12)));
    const lR = rows.map((r) => Math.log10(Math.max(r.mean, 1e-12)));
    const m2 = rows.length;
    let beta = 0;
    if (m2 >= 8) {
      const slopes = [];
      // 쌍이 많으면 규칙적으로 솎아 O(n²) 를 제한한다(결정론적)
      const step = Math.max(1, Math.floor(m2 / 60));
      for (let a4 = 0; a4 < m2; a4 += step) {
        for (let b4 = a4 + step; b4 < m2; b4 += step) {
          const dx2 = lR[b4] - lR[a4];
          if (Math.abs(dx2) > 1e-9) slopes.push((lr[b4] - lr[a4]) / dx2);
        }
      }
      if (slopes.length >= 5) beta = median(slopes);
      if (!isFinite(beta)) beta = 0;
      // 추세가 터무니없이 가파르면(자료가 부족하거나 이상) 평탄으로 되돌린다
      if (Math.abs(beta) > 5) beta = 0;
    }
    const resid = rows.map((r, k) => lr[k] - beta * lR[k]);
    const alpha = median(resid);
    for (let k = 0; k < rows.length; k++) {
      const pred = Math.exp(alpha + beta * lR[k]);
      const sc = isFinite(pred) && pred > 0 ? pred / medChi : 1;
      rows[k].nullScale = sc;
      rows[k].ratioAdj = rows[k].ratio / sc;
      rows[k].p = chi2SF(rows[k].ratioAdj * rows[k].nu, rows[k].nu);
    }
    rows.trendBeta = beta;
  }
  const globalMed = median(rows.map((r) => r.ratio));
  const scale = isFinite(globalMed) && globalMed > 0 ? globalMed / medChi : 1;
  const thr = bhThreshold(rows.map((r) => r.p), q);
  for (const r of rows) r.blink = r.p <= thr && r.ratioAdj > 1;
  // 두 가지 문턱을 **다른 목적에** 쓴다.
  //  blink   : FDR 통제 — '점멸이라고 보고할 것인가'. 엄격해야 한다(거짓발견 통제).
  //  suspect : 느슨한 선별 — '두 상태 준위를 재는 데 이 점을 써도 되는가'. 여기서는
  //            놓치는 쪽이 더 해롭다. 전환 가장자리의 f≈0.03/0.97 점은 FDR 문턱을 못 넘지만
  //            이미 부분적으로 켜져 있어, 준위 회귀에 넣으면 저/고 준위가 서로 끌려간다
  //            (실측: 넓은 전환에서 '두 준위 미분리' 38건의 주원인).
  for (const r of rows) r.suspect = r.blink || r.p < 0.2;
  let nBlink = rows.filter((r) => r.blink).length;
  let frac = nBlink / rows.length;
  // ── 두 상태의 준위를 setpoint **자기 파워에서** 평가한다 ──
  // 이웃 점의 값을 그대로 쓰면 안 된다: 점화 구간에서는 고상태 가지가 setpoint 몇 개
  // 사이에 몇 배로 오르므로, 블록 바깥의 이웃 값을 쓰면 f̂ 가 통째로 틀린다
  // (실측 WJ-0075c up: 걸린 네 점이 모두 고준위 39,096 을 공유 — 네 setpoint 떨어진 값).
  // 그래서 블록 양옆의 **깨끗한 점들**로 국소 멱법칙을 세우고 그 자리로 외삽한다.
  // 모델이 아니라 데이터에서만 나오므로, 이 값으로 모델을 제약해도 순환이 아니다.
  for (const r of rows) {
    r.fMean = NaN; r.fVar = NaN; r.kappa = NaN; r.loLevel = NaN; r.hiLevel = NaN;
    r.mixtureConsistent = null;
  }
  // 연속으로 걸린 구간을 블록으로 묶는다
  // 블록은 suspect 기준으로 묶는다 — 가장자리의 약한 점이 블록을 둘로 쪼개면
  // 그 사이 점이 '깨끗한 이웃'으로 오인된다.
  const blocks = [];
  for (let k = 0; k < rows.length; k++) {
    if (!rows[k].suspect) continue;
    if (blocks.length && blocks[blocks.length - 1][1] >= k - 1) blocks[blocks.length - 1][1] = k;
    else blocks.push([k, k]);
  }
  // ── 준위 외삽의 계통 오차를 **측정해서** σ_f 에 넣는다 ──
  // 고상태 가지는 휘어 있으므로(실측 WJ-0075c up: 점화 직후 국소 기울기 25→11→10→6)
  // 직선 로그-로그 외삽의 결과가 몇 점을 쓰느냐에 따라 달라진다. 실측 민감도:
  // NEI 2→12 에서 마지막 점의 f̂ 가 0.847→0.638 로 33% 이동했다. 한 값을 골라 쓰면
  // 그 임의성이 통째로 숨는다. 그래서 여러 NEI 로 계산해 **중앙값을 값으로, spread를
  // 계통 불확실성으로** 쓴다. 통계 오차(반복 SEM)와 제곱합해 σ_f 를 만든다.
  const NEI_SET = Array.isArray(o.neighborsSet) ? o.neighborsSet : [3, 5, 8];
  const chi2Inv99 = (nu2) => {
    let a3 = nu2, b3 = nu2 * 20;
    for (let it = 0; it < 80; it++) { const m2 = 0.5 * (a3 + b3); if (chi2SF(m2, nu2) > 0.01) a3 = m2; else b3 = m2; }
    return 0.5 * (a3 + b3);
  };
  const localLaw = (idxs) => {
    const xs2 = [], ys = [];
    for (const k of idxs) {
      if (rows[k].mean > 0) { xs2.push(rows[k].x); ys.push(Math.log10(rows[k].mean)); }
    }
    if (!xs2.length) return null;
    if (xs2.length === 1) return { at: () => Math.pow(10, ys[0]), rmsDex: 0.15 };
    const fit = logLogLS(xs2, ys);
    if (!fit || !isFinite(fit.slope)) return { at: () => Math.pow(10, median(ys)), rmsDex: 0.15 };
    let ss = 0;
    for (let t = 0; t < xs2.length; t++) { const e = ys[t] - (fit.intercept + fit.slope * xs2[t]); ss += e * e; }
    return { at: (xv) => Math.pow(10, clamp(fit.intercept + fit.slope * xv, -300, 300)),
      rmsDex: Math.sqrt(ss / Math.max(xs2.length - 2, 1)) };
  };
  // ── v3.5: 고준위 법칙에 쓰는 점이 **정말 다 켜져 있는가** ──
  //
  // branch 내 f̂ 가 cross-branch f̂ 보다 실측에서 ×2.87 크다는 사실은 v3.0 부터 알려져 있었고,
  // v3.3 은 그 기전에 대한 세 가설을 모두 기각한 채 '원인 미상'으로 남겼다. 원인은 이것이다:
  //
  //   점멸 검출(FDR)은 전환 구간 **전체**를 잡지 못한다. dwell 안에서 텔레그래프가 빠르게
  //   평균화되면(κ 큼) 반복 분산이 작아져 전환의 일부만 걸린다. 그러면 블록 바로 위의
  //   '깨끗한' 점들이 아직 부분 점등 상태이고, 그 점들로 세운 멱법칙은 기울기에 occupancy
  //   상승분을 포함한다(겉보기 지수 ~20). 그것을 블록 쪽으로 되외삽하면 고준위가
  //   과소평가된다.
  //
  // 실측 WJ-0075c up: 최대 블록이 전환폭의 43% 만 덮고, 위쪽 '깨끗한' 점 8개의 cross-branch
  // f 가 0.594…0.984 (중앙 0.821). 고준위 외삽 24k–39k vs 반대branch 실측 82k–97k → ×3.03.
  // 편향을 분해하면 분자항(저준위) ×1.000 · 분모항(고준위) ×3.03 으로, 전부 여기서 나온다.
  //
  // v3.3 이 이 기전을 기각한 이유도 밝혀졌다: 생성기의 blinkNsw=30 에서는 검출이 전환의
  // 92–100% 를 덮어 기전이 발현될 수 없다(편향 ×1.2–1.7). 점멸을 빠르게 하면 재현된다 —
  // nsw=300 에서 덮는비율 47% · 위쪽점 f 0.80 · 편향 ×2.95 로 실측과 정량적으로 일치한다.
  //
  // cross-branch 층이 있으면 그 f 로 **부분 점등 점을 걸러낸다**. 없으면(단방향 스윕)
  // 걸러낼 수단이 없으므로 진단만 보고한다.
  const xoRows = (o.crossOcc && o.crossOcc.checked && o.crossOcc.valid && o.crossOcc.absolute)
    ? o.crossOcc.rows : null;
  const HI_ON_MIN = isFinite(o.hiOnMin) ? o.hiOnMin : 0.95;
  const crossFAt = (xv) => {
    if (!xoRows) return NaN;
    let best = null, bd = Infinity;
    for (const c of xoRows) { const dd = Math.abs(c.x - xv); if (dd < bd) { bd = dd; best = c; } }
    return best && bd < 0.002 ? best.f : NaN;
  };
  const fullyOn = (k) => {
    const fc = crossFAt(rows[k].x);
    return !isFinite(fc) ? true : fc >= HI_ON_MIN;
  };
  const screen = o.screenOcc !== false && !!xoRows;
  // 한 NEI 값에 대한 (저준위, 고준위) 쌍
  const levelsFor = (b0, b1, nei) => {
    const loIdx = [], hiIdx = [];
    for (let k = b0 - 1; k >= 0 && loIdx.length < nei; k--) if (!rows[k].suspect) loIdx.push(k);
    for (let k = b1 + 1; k < rows.length && hiIdx.length < nei; k++) {
      if (!rows[k].suspect && (!screen || fullyOn(k))) hiIdx.push(k);
    }
    const lawLo = localLaw(loIdx), lawHi = localLaw(hiIdx);
    if (!lawLo || !lawHi) return null;
    return { lawLo, lawHi };
  };
  for (const [b0, b1] of blocks) {
    const variants = NEI_SET.map((nei) => levelsFor(b0, b1, nei)).filter(Boolean);
    if (!variants.length) { for (let k = b0; k <= b1; k++) rows[k].mixtureConsistent = false; continue; }
    for (let k = b0; k <= b1; k++) {
      const r = rows[k];
      const fs = [], los = [], his = [];
      for (const v of variants) {
        const Rlo = v.lawLo.at(r.x), Rhi = v.lawHi.at(r.x);
        if (!(isFinite(Rlo) && isFinite(Rhi) && Rhi > Rlo * 1.2 && r.mean > Rlo && r.mean < Rhi)) continue;
        fs.push(clamp((r.mean - Rlo) / (Rhi - Rlo), 0, 1)); los.push(Rlo); his.push(Rhi);
      }
      // **모든** NEI 변형에서 혼합 해석이 성립해야 한다. '하나라도 통과'로 완화하면
      // 검출력은 오르지만 결론이 임의의 외삽 선택에 의존하게 된다 — 실측 대가:
      // 곱셈 잡음 3% 에서 거짓양성 0.22%→0.96%, WJ-0139c down 에서 f̂ 가 비단조로
      // 7점 검출(실제 전환이라면 파워에 대해 단조여야 한다).
      if (fs.length < variants.length) {
        // 어느 NEI 로도 두 준위 사이에 들어오지 않으면 혼합 해석이 성립하지 않는다
        const v0 = variants[0];
        const Rlo0 = v0.lawLo.at(r.x), Rhi0 = v0.lawHi.at(r.x);
        r.mixtureConsistent = false;
        r.rejectReason = !(isFinite(Rlo0) && isFinite(Rhi0)) ? "준위 미확정"
          : !(Rhi0 > Rlo0 * 1.2) ? "두 준위 미분리"
          : (r.mean <= Rlo0 ? "평균이 저준위 아래" : "평균이 고준위 위");
        continue;
      }
      const Rlo = median(los), Rhi = median(his), dR = Rhi - Rlo;
      r.loLevel = Rlo; r.hiLevel = Rhi;
      r.fMean = median(fs);
      // 계통: NEI 에 따른 f̂ spread (반폭). 한 변형만 살아남으면 계통을 알 수 없으므로
      // 준위 회귀의 residual spread로 대체한다.
      const fSys = fs.length >= 2 ? 0.5 * (Math.max(...fs) - Math.min(...fs)) : NaN;
      const LN10 = Math.LN10;
      const sMean = Math.sqrt(r.varObs / r.nRep);
      const vMid = variants[Math.min(1, variants.length - 1)];
      const sLo = Rlo * LN10 * (vMid.lawLo.rmsDex || 0);
      const sHi = Rhi * LN10 * (vMid.lawHi.rmsDex || 0);
      const fv = r.fMean;
      const sStat = Math.sqrt(sMean * sMean + (1 - fv) * (1 - fv) * sLo * sLo + fv * fv * sHi * sHi) / dR;
      r.fSdStat = sStat;
      r.fSdSys = isFinite(fSys) ? fSys : sStat;
      r.fSd = Math.sqrt(sStat * sStat + r.fSdSys * r.fSdSys);
      r.fSpread = fs.length >= 2 ? [Math.min(...fs), Math.max(...fs)] : null;
      if (!(isFinite(r.fSd) && r.fSd > 0)) r.fSd = NaN;
      const excess = r.varObs - r.varNull;
      if (excess > 0) {
        const maxVar = Math.max(fv * (1 - fv) * dR * dR, 1e-300);
        r.kappa = excess / maxVar;
        r.mixtureConsistent = r.kappa <= chi2Inv99(r.nu) / r.nu;
        if (!r.mixtureConsistent) r.rejectReason = "κ̂ upper bound 초과 (혼합으로 설명 불가)";
        const disc = 1 - 4 * excess / (dR * dR);
        r.fVar = disc >= 0 ? 0.5 * (1 - Math.sqrt(disc)) : 0.5;
      } else r.mixtureConsistent = true;
    }
  }
  // 혼합으로 설명되지 않는 점은 과분산이되 점멸이 아니다 — 따로 표시한다
  for (const r of rows) {
    if (r.blink && r.mixtureConsistent === false) { r.blink = false; r.overdispersedOther = true; }
  }
  // occupancy는 파워에 대해 단조 증가해야 한다(전환을 지나며 고상태 체류가 늘어난다).
  // 비단조면 그 검출들은 실제 전환이 아닐 가능성이 크다 — 거르지 않고 **표시**한다.
  let fMonotone = true;
  {
    let prev = NaN;
    for (const r of rows) {
      if (!r.blink || !isFinite(r.fMean)) continue;
      if (isFinite(prev) && r.fMean < prev - 2 * (isFinite(r.fSd) ? r.fSd : 0)) fMonotone = false;
      prev = r.fMean;
    }
  }
  nBlink = rows.filter((r) => r.blink).length;
  frac = nBlink / rows.length;
  // ── 편향 진단 (v3.5) ──
  // 검출 블록이 전환의 몇 %를 덮는가. 낮으면 고준위 법칙이 부분 점등 점으로 세워진다.
  // 이 진단은 **실제 점멸 검출이 있고** cross-branch 전환폭이 정의될 때만 뜻이 있다.
  //  - nBlink = 0 이면 블록은 느슨한 suspect(p<0.2) 잡음이지 전환 구간이 아니다.
  //    (실측 WJ-0128c #20 up: nBlink=0 인데 덮는비율 136%, 위쪽 점 occupancy 0.009 가 나왔다.)
  //  - 전환이 격자보다 예리하면 width1090 이 블록 폭보다 작아 비가 1 을 넘는다.
  //    그때 '덮는 비율'은 의미가 없으므로 1 로 자르고 별도로 표시한다.
  let detectCoverage = NaN, hiPointsOcc = NaN, coverageDegenerate = false;
  if (xoRows && nBlink >= 2 && isFinite(o.crossOcc.width1090) && o.crossOcc.width1090 > 0) {
    let big = 0, bb = null;
    for (const [b0, b1] of blocks) {
      const sp = rows[b1].x - rows[b0].x;
      if (sp > big) { big = sp; bb = [b0, b1]; }
    }
    const rawCov = big / o.crossOcc.width1090;
    coverageDegenerate = rawCov > 1;
    detectCoverage = Math.min(rawCov, 1);
    if (bb) {
      const vs = [];
      for (let k = bb[1] + 1; k < rows.length && vs.length < 8; k++) {
        if (rows[k].suspect) continue;
        const fc = crossFAt(rows[k].x);
        if (isFinite(fc)) vs.push(fc);
      }
      if (vs.length) hiPointsOcc = median(vs);
    }
  }
  return {
    checked: true, fdr: q, pThreshold: thr, dispersionScale: scale,
    screened: screen, hiOnMin: HI_ON_MIN, detectCoverage, hiPointsOcc, coverageDegenerate,
    nOtherDispersed: rows.filter((r) => r.overdispersedOther).length,
    fMonotone,
    nu: nuMed, nRows: rows.length, nBlink, fracBlink: frac,
    // 절반 이상이 걸리면 국소 현상이 아니다 — bistable이라고 부르면 안 된다
    global: frac > 0.5,
    rows,
    blinkIdx: rows.filter((r) => r.blink).map((r) => r.i),
  };
}

/**
 * v3.2 — cross-branch occupancy (cross-branch occupancy).
 *
 * 왜 필요한가: branch 내 occupancy(v3.0)은 고상태 준위를 **전환 구간 너머에서 외삽**해야 하고,
 * 그 외삽에 쓰는 점들이 아직 부분 점등이면 준위가 과소평가되어 f̂ 가 1 쪽으로 부풀어 오른다.
 * 실측(WJ-0075c up, 3.12 mW): branch 내 외삽 준위 ≈ 22,500 vs 하행 실측 86,403 → f̂ 0.478 vs 0.158.
 * **3배 차이**이고, 방향이 계통적이다.
 *
 * 무엇을 하는가: 히스테리시스가 있으면 반대 branch는 **같은 파워에서 이미 점등된 상태**를
 * 직접 측정한다. 그러면 고상태 준위를 외삽하지 않고 실측값으로 쓸 수 있다:
 *
 *     f(P) = (I_this(P) − D) / (I_other(P) − D)
 *
 * 성립 조건이 있고, 파일마다 다르다 — 그래서 게이트를 둔다:
 *  (1) **반환점 연속성**: 상행 끝과 하행 시작의 세기가 이어져야 한다. 어긋나면 스윕 중
 *      광퇴색이 있었다는 뜻이고, 그 배율이 f 에 그대로 실린다.
 *      실측: WJ-0075c 0.965(3.5% 오차) vs WJ-0139c 0.901(10%).
 *  (2) **실제 간극**: f 가 의미 있게 1 아래인 점이 있어야 한다. WJ-0139c 는 f 가 어디서나
 *      1.0~1.3 이어서 발광준위 히스테리시스가 없고, 이 방법이 줄 정보가 없다.
 *  (3) 기준 branch가 암계수 위에 있어야 한다.
 */
function crossBranchOccupancy(trace, branchName, opts) {
  const o = opts || {};
  if (!trace || !trace.P || !trace.I || trace.P.length < 20) return { checked: false, reason: "트레이스 부족" };
  if (branchName !== "up" && branchName !== "down") return { checked: false, reason: "branch 미지정" };
  const P0 = trace.P, I0 = trace.I, raw = trace.Iraw || null;
  const n = P0.length;
  let peak = 0;
  for (let i = 1; i < n; i++) if (P0[i] > P0[peak]) peak = i;
  if (peak < 8 || n - peak < 8) return { checked: false, reason: "단방향 스윕 — 반대 branch 없음" };
  const mk = (lo, hi) => {
    const a = [];
    for (let i = lo; i <= hi; i++) {
      if (isFinite(P0[i]) && P0[i] > 0 && isFinite(I0[i])) {
        a.push({ i, x: Math.log10(P0[i]), I: I0[i], reps: raw && raw[i] ? raw[i].filter(isFinite) : null });
      }
    }
    a.sort((p, q) => p.x - q.x);
    return a;
  };
  const upArr = mk(0, peak), dnArr = mk(peak + 1, n - 1);
  if (upArr.length < 8 || dnArr.length < 8) return { checked: false, reason: "branch 점 수 부족" };
  const self = branchName === "up" ? upArr : dnArr;
  const other = branchName === "up" ? dnArr : upArr;
  // ── 게이트 (1): 반환점 연속성 — 광퇴색 검사 ──
  const K = 3;
  const tailUp = median(upArr.slice(-K).map((p) => p.I));
  const headDn = median(dnArr.slice(-K).map((p) => p.I));
  const continuity = isFinite(tailUp) && tailUp > 0 ? headDn / tailUp : NaN;
  let bleachFrac = isFinite(continuity) ? Math.abs(1 - continuity) : NaN;
  const bleachLimit = isFinite(o.bleachLimit) ? o.bleachLimit : 0.10;
  // **방향이 진단을 가른다** (합성 생성기가 잡아낸 결함):
  //  continuity < 1 → 나중 branch가 어둡다 = 광퇴색. 기준 branch를 그대로 쓸 수 없다.
  //  continuity > 1 → 나중 branch가 **밝다**. 광퇴색으로는 불가능하다.
  //    상행이 최고 파워에서도 아직 다 켜지지 않았다는 뜻이다(스윕이 충분히 높지 않았다).
  //    이때도 f 는 계산되지만 '절대 occupancy'이 아니라 **반대 branch 대비 상대값**이다 —
  //    기준 branch가 f=1 이라는 보장이 없기 때문이다. 거부하지 않고 그렇게 표시한다.
  //  (이전 판은 둘을 모두 '광퇴색 의심'으로 묶어 넓은 전환 케이스를 오진하며 거부했다.)
  const refNotSaturated = isFinite(continuity) && continuity > 1 + bleachLimit;
  // 로그-로그 보간 — 값과 **불확도**를 함께 낸다(v3.5).
  // f 의 분모가 이 값이므로, 여기의 불확도를 빼면 σ_f 가 과소평가된다.
  // 두 성분: (α) 양 끝점의 측정잡음, (β) 선형보간 자체의 모델오차(국소 곡률).
  // ── 반복 표본에서 평균의 표준오차 (v3.5) ──
  // 표본 SEM 을 그대로 쓰면 안 된다. 반복이 5회뿐인데 우연히 값이 모두 같게 나오면
  // SEM 이 0 근처로 **붕괴**한다. 점화 직전처럼 점등 확률이 낮은 setpoint 에서 이 일이
  // 실제로 일어난다(측정: f_true=0.0048 인 점에서 복제 5개가 모두 0 → σ=7×10⁻⁵, z=−63).
  // 두 가지 바닥을 둔다.
  //  (1) 계수통계 바닥: 계수율 I 를 시간 τ 로 적분해 n 회 평균했으면 분산은 최소 I/(τ·n).
  //      이것은 추정이 아니라 **아는 값**이다.
  //  (2) 소표본 보정: s² ~ σ²·χ²_{n−1}/(n−1) 이므로 표본 s 는 σ 의 point estimate일 뿐이다.
  //      한쪽 84% upper bound로 올려 보수적으로 쓴다(n=5 이면 약 1.56 배).
  const CHI2_LO_16 = { 1: 0.0403, 2: 0.3475, 3: 0.9008, 4: 1.6488, 5: 2.5165,
    6: 3.4746, 7: 4.5024, 8: 5.5849, 9: 6.7116, 10: 7.8751 };
  const smallSampleInflation = (n) => {
    if (!(n > 1)) return 1;
    const dof = n - 1;
    const c = CHI2_LO_16[dof];
    // dof 가 크면 χ²_{0.16,ν} ≈ ν·(1 − 2/(9ν) − 0.994·√(2/(9ν)))³ (Wilson–Hilferty)
    const q = c !== undefined ? c
      : dof * Math.pow(1 - 2 / (9 * dof) - 0.9945 * Math.sqrt(2 / (9 * dof)), 3);
    return q > 0 ? Math.sqrt(dof / q) : 1;
  };
  const countingFloorSem = (mean, n) => {
    // 계수 자료일 때만. acqTime 은 트레이스에서 온다.
    if (!trace.counting || !(trace.acqTime > 0) || !(mean > 0) || !(n > 0)) return 0;
    return Math.sqrt(mean / (trace.acqTime * n));
  };
  const semOf = (reps, mean) => {
    const n = reps ? reps.length : 0;
    const m = isFinite(mean) ? mean
      : (n ? reps.reduce((a, b) => a + b, 0) / n : NaN);
    let sem = NaN;
    if (n >= 2) {
      let v = 0;
      for (const q of reps) v += (q - m) * (q - m);
      sem = Math.sqrt(v / (n - 1) / n) * smallSampleInflation(n);
    }
    const floor = countingFloorSem(m, Math.max(n, 1));
    if (!isFinite(sem)) return floor > 0 ? floor : NaN;
    return Math.max(sem, floor);
  };
  const LN10 = Math.LN10;
  const refAtFull = (xv) => {
    if (!(xv > other[0].x) || !(xv < other[other.length - 1].x)) return null;
    let k = 0;
    while (k + 1 < other.length && other[k + 1].x < xv) k++;
    const a = other[k], b = other[k + 1];
    if (!(a.I > 0 && b.I > 0) || !(b.x > a.x)) return null;
    const h = b.x - a.x, t = (xv - a.x) / h;
    const ga = Math.log10(a.I), gb = Math.log10(b.I);
    const g = ga * (1 - t) + gb * t;
    const Iref = Math.pow(10, g);
    // (α) 끝점 잡음 → log10 공간
    const sa = semOf(a.reps, a.I), sb = semOf(b.reps, b.I);
    const lga = isFinite(sa) ? sa / (LN10 * a.I) : NaN;
    const lgb = isFinite(sb) ? sb / (LN10 * b.I) : NaN;
    let vAlpha = 0, haveAlpha = false;
    if (isFinite(lga)) { vAlpha += (1 - t) * (1 - t) * lga * lga; haveAlpha = true; }
    if (isFinite(lgb)) { vAlpha += t * t * lgb * lgb; haveAlpha = true; }
    // (β) 보간 모델오차: 선형보간 오차는 (1/2)|g''|·t(1−t)·h².
    // g'' 는 이웃 점을 쓴 나눗셈 차분으로 추정한다(양쪽이 있으면 큰 쪽을 택해 보수적으로).
    let curv = 0;
    const sec = (i0, i1, i2) => {
      const p0 = other[i0], p1 = other[i1], p2 = other[i2];
      if (!p0 || !p1 || !p2 || !(p0.I > 0 && p1.I > 0 && p2.I > 0)) return NaN;
      const d1 = (Math.log10(p1.I) - Math.log10(p0.I)) / (p1.x - p0.x);
      const d2 = (Math.log10(p2.I) - Math.log10(p1.I)) / (p2.x - p1.x);
      const dx = (p2.x - p0.x) / 2;
      return dx > 0 ? Math.abs(d2 - d1) / dx : NaN;
    };
    for (const c3 of [sec(k - 1, k, k + 1), sec(k, k + 1, k + 2)]) {
      if (isFinite(c3) && c3 > curv) curv = c3;
    }
    const lgBeta = 0.5 * curv * t * (1 - t) * h * h;
    const sLog = Math.sqrt((haveAlpha ? vAlpha : 0) + lgBeta * lgBeta);
    return { Iref, sd: isFinite(sLog) ? Iref * LN10 * sLog : NaN,
      sdStat: haveAlpha ? Iref * LN10 * Math.sqrt(vAlpha) : NaN,
      sdInterp: Iref * LN10 * lgBeta };
  };
  const refAt = (xv) => { const r = refAtFull(xv); return r ? r.Iref : NaN; };
  // ── 광퇴색에 대해 이 지표가 할 수 있는 말의 한계 ──
  // `continuity` 는 반환점의 **계단**만 잡는다. 실제 광퇴색은 스윕 내내 연속적으로 진행하므로
  // 계단을 만들지 않는다 — 합성으로 확인했다(bleach 45% 인데 연속성 0.986).
  // 그러면 같은 파워에서 두 branch를 비교하면 되지 않을까? 그것도 안 된다:
  // 나중 branch가 어두운 원인이 (a) 누적 광퇴색인지 (b) 발광준위 히스테리시스인지
  // **한 번의 루프로는 분리되지 않는다**(둘 다 같은 부호로 나타난다). 고파워 구간을 써도
  // 그쪽은 시간 간격이 가장 짧아 광퇴색 영향이 최소이고, 상행이 아직 포화 전이면
  // 비가 1/f 로 오염된다(실측 합성: 어떤 bleach 값에서도 비가 ~1.2 로 고정).
  // 분리하려면 **루프를 반복**해 두 번째 루프가 첫 번째를 재현하는지 봐야 한다.
  // 따라서 여기서는 계단만 보고하고, 그 이상을 주장하지 않는다.
  const bleachSuspect = isFinite(continuity) && continuity < 1 - bleachLimit;
  // 암계수: 자기 branch의 저출력 끝
  const nDark = Math.max(6, Math.floor(self.length * 0.25));
  const darkPts = self.slice(0, nDark).map((p) => p.I);
  const D = median(darkPts);
  // 암준위 자체의 불확도 — v3.5. 중앙값의 표준오차는 평균의 것보다 √(π/2)≈1.2533 배 크다.
  // 저출력 끝이 완전히 평탄하지 않으면 이 spread가 그 기울기까지 담는데, 그쪽으로 틀리는 편이
  // 안전하다(불확도를 과소평가하는 것보다 낫다).
  let sdD = NaN;
  if (darkPts.length >= 3) {
    const mD = darkPts.reduce((a, b) => a + b, 0) / darkPts.length;
    let vD = 0;
    for (const q of darkPts) vD += (q - mD) * (q - mD);
    sdD = 1.2533 * Math.sqrt(vD / (darkPts.length - 1) / darkPts.length);
  }
  const rows = [];
  for (const p of self) {
    const rf = refAtFull(p.x);
    const Iref = rf ? rf.Iref : NaN;
    if (!isFinite(Iref) || !(Iref > D * 10)) continue;
    const den = Iref - D;
    if (!(den > 0)) continue;
    const f = (p.I - D) / den;
    if (!(f > -0.10 && f < 1.40)) continue;
    // ── v3.5: f = (I − D)/(I_ref − D) 의 완전 전파 ──
    //   ∂f/∂I = 1/den · ∂f/∂D = (f − 1)/den · ∂f/∂I_ref = −f/den
    // v3.4 까지는 첫 항만 있었다. 그래서 f≈0 구간의 σ 가 10⁻⁴ 로 내려가 사실상
    // 경성 제약이 됐고(측정: 피복률 0.795, RMS z 40.9), 전환 구간은 더 나빴다
    // (피복률 0.840, RMS z 88.7 — 분모가 가장 빠르게 변하는 곳이 보간오차도 가장 크다).
    const sI = semOf(p.reps, p.I);
    const vSelf = isFinite(sI) ? (sI / den) * (sI / den) : 0;
    const vDark = isFinite(sdD) ? ((1 - f) * sdD / den) * ((1 - f) * sdD / den) : 0;
    const vRef = rf && isFinite(rf.sd) ? (f * rf.sd / den) * (f * rf.sd / den) : 0;
    const sd = Math.sqrt(vSelf + vDark + vRef);
    // 광퇴색 배율은 f 에 그대로 실리므로 계통으로 더한다
    const sys = isFinite(bleachFrac) ? bleachFrac * Math.abs(f) : 0;
    rows.push({ i: p.i, x: p.x, P: Math.pow(10, p.x), I: p.I, Iref, f,
      fSdStat: sd, fSdSys: sys,
      fSdSelf: Math.sqrt(vSelf), fSdDark: Math.sqrt(vDark), fSdRef: Math.sqrt(vRef),
      fSd: Math.sqrt(sd * sd + sys * sys) });
  }
  if (rows.length < 5) return { checked: false, reason: `겹침 구간 유효점 ${rows.length}개`, continuity };
  // ── 게이트 (2): 실제 간극이 있는가 ──
  const nBelow = rows.filter((r) => r.f < 0.80).length;
  const gap = nBelow >= 3;
  // 단조성과 10→90% 폭
  let monotone = true;
  for (let k = 1; k < rows.length; k++) if (rows[k].f < rows[k - 1].f - 0.08) monotone = false;
  const r10 = rows.find((r) => r.f > 0.1), r90 = rows.find((r) => r.f > 0.9);
  const width1090 = r10 && r90 && r90.P > r10.P ? Math.log10(r90.P / r10.P) : NaN;
  const valid = gap && !bleachSuspect;
  return {
    checked: true, branch: branchName, rows, dark: D, darkSd: sdD,
    continuity, bleachFrac, bleachSuspect, refNotSaturated,
    // 기준 branch가 완전히 점등됐다고 볼 수 있을 때만 f 를 '절대 occupancy'로 읽는다
    absolute: valid && !refNotSaturated,
    nPoints: rows.length, nBelow, gap, monotone, width1090, valid,
    reason: valid
      ? (refNotSaturated
        ? "상행이 최고 파워에서도 포화하지 않았다 — f 는 절대 occupancy가 아니라 반대 branch 대비 상대값이다"
        : null)
      : (!gap ? "발광준위 히스테리시스 간극 없음 — 이 방법이 줄 정보가 없다"
        : "반환점에서 나중 branch가 계단처럼 어둡다 — 기준 branch를 그대로 쓸 수 없다"),
  };
}

/* ==================== bistable 모델족 (v2.9, BistableFit) ====================
 *
 * 왜 새 족이 필요한가 — v2.8 프로파일 우도가 증명한 것:
 * 매끄러운 시그모이드로 계단을 근사하는 한 최대기울기 s_max 에는 **upper bound가 없다**
 * (WJ-0075c 두 branch 모두 s_max ≤ 500 까지 전부 기각, turnover 없음). 이것은 최적화
 * 실패가 아니라 **보고량 선택의 오류**다: 불연속에 가까운 점화에서 "기울기의 최댓값"은
 * transition width 파라미터가 정하는 값이지 데이터가 정하는 값이 아니다.
 *
 * 해결은 모델을 더 유연하게/더 경직되게 만드는 것이 아니라 **보고량이 유한해지도록
 * 매개화를 바꾸는 것**이다. bistable 점화의 물리 서술은 다음과 같다:
 *
 *   I(P) = B + (1−f)·10^(a_L + n_L·x) + f·10^(h_H(x)),   f = σ((x − x_s)/ω)
 *
 *   저상태 멱법칙 n_L · 고상태 멱법칙 n_H · 전환 파워 P_s = 10^x_s · 전환 폭 ω
 *   (선택) 고상태 포화: h_H = a_H + n_H·x + (n_H2 − n_H)·v·softplus((x − x_sat)/v)
 *
 * 핵심: **ω → 0 이어도 n_L, n_H, P_s, 대비비는 전부 유한하고 그대로 회수된다.**
 * s_max 를 죽인 축퇴가 이 보고량들에는 존재하지 않는다. 계단이 예리하다는 사실은
 * 병리가 아니라 ω 가 작다는 측정 결과가 된다.
 *
 * 히스테리시스: 상행·하행 branch를 각각 적합하면 전환 파워가 두 개 나오고
 * 그 로그 차이가 히스테리시스 폭이다 — bistable성의 직접 관측량.
 */
/** 전환 폭의 lower bound. H 족의 W_FLOOR 와 달리 **격자보다 훨씬 작아도 된다** —
 *  이 족에서는 ω 가 보고량을 결정하지 않기 때문이다. 0 으로 두지 않는 이유는 순전히
 *  수치적이다(σ 의 도함수가 정확히 0/∞ 이 되면 LM 이 진행하지 못한다). */
const BS_W_FLOOR = 1e-3;
/** 파라미터 수: [차수][비대칭 여부]. 비대칭이면 형태 파라미터 ν 가 θ 끝에 하나 붙는다. */
const BS_NPARAMS = { 0: 7, 1: 10 };
const bsNParams = (order, skew) => BS_NPARAMS[order] + (skew ? 1 : 0);
/** ν 의 upper bound — 무한히 가파른 상승 꼬리는 ω→0 과 같은 축퇴를 만든다. */
const BS_NU_MAX = 200;
/** 고상태 멱지수의 물리 바닥 — 이 아래면 '고상태'가 아니므로 unidentified로 보고한다(v3.4). */
const NHIGH_FLOOR = 1.0;
/** 고상태 지수를 보고하기 위해 필요한 **문턱 위 측정 구간**(decade) — v3.5.
 *
 *  v3.4 는 "고상태 매개화(멱법칙 + 포화 힌지 하나)가 경직돼서 실측을 표현하지 못한다"고
 *  적었다. 참값 대조가 그것을 **기각**했다: 고상태 준위를 힌지 하나(sat1) · 유리형 완만
 *  압축(soft) · 힌지 둘(two) 로 만든 합성에서, 현행 형태족은 국소지수를 중앙오차
 *  0–15% 로 회수한다 — **단, 문턱 위 구간이 충분할 때만.**
 *
 *  구간 길이를 바꿔가며 잰 결과(격자 간격은 고정, power·soft 두 모양 × 3 씨앗):
 *    0.08 dec — 프로파일이 아예 나오지 않거나 76·100% 오차
 *    0.16 dec — 6 · 12 · 19 · 25 · 37 · 100% (8회 중 4회가 25% 초과)
 *    0.28 dec — 2 · 2 · 3 · 11 · 11 · 16%
 *    0.60 dec — 0 · 1 · 1 · 7 · 8 · 13%
 *  0.25 dec 를 경계로 두면 그 위 12회는 전부 ≤16% 이고 불필요한 억제가 없다.
 *
 *  점 개수(nHighPts ≥ 5)만으로는 걸러지지 않는다: 0.16 dec 케이스도 점은 9–10개다.
 *  구간 길이가 점 개수와 다른 정보를 담고 있다. */
const NHIGH_RANGE_MIN = 0.25;
/** occupancy 제약을 **철회**하는 갈등 문턱 (v3.5).
 *
 *  제약이 정당하게 편향을 고칠 때도 세기 χ² 는 나빠진다. 그래서 갈등비 자체를 문턱으로
 *  쓰는 것은 v3.4 에서 명시적으로 거부했다. 그러나 그때는 분포를 몰랐다. 이제 안다:
 *  합성 54건(참값 대조 배터리 33 + 고상태 모양 배터리 21)에서 갈등비는
 *  중앙 1.8 · 90분위 3.7 · **최대 11.3** 이다. 20배는 그 최대의 1.8배다.
 *
 *  20배를 넘으면 그 자료는 이 방법이 검증된 영역 밖에 있다는 뜻이므로, 제약을 적용한
 *  결과를 내놓는 대신 **무제약 적합으로 되돌리고 갈등을 크게 보고한다**. 값을 조용히
 *  바꾸는 것보다 "이 branch에서는 두 자료가 양립하지 않는다"고 말하는 편이 정직하다.
 *  합성 54건 중 이 문턱에 걸리는 것은 0건이다(거짓양성 없음). 실측에서는
 *  WJ-0075c 상행만 걸린다(87배). */
const OCC_CONFLICT_MAX = 20;
/** θ(BS0) = [uB, aL, uNL, aH, uNH, xs, uW]
 *  θ(BS1) = [...BS0, uNH2, uDsat, uV]   (x_sat 은 x_s 로부터의 **양의 오프셋**)
 *
 *  왜 x_sat 을 자유 파라미터로 두지 않는가: 그러면 포화 꺾임이 전환 파워 **아래**로
 *  내려앉아, 고상태 멱법칙 구간이 전환 자체를 그리는 경사로로 쓰인다. 실측(WJ-0075c up):
 *  n_high = 21.9, x_sat 이 x_s 보다 낮게 나왔다 — s_max 를 망가뜨렸던 축퇴가
 *  포화 힌지로 자리만 옮긴 것이다. 오프셋을 양수로 강제하고 최소 한 격자 간격을 띄우면
 *  고상태 지수는 전환 **이후** 점들로만 결정된다. */
function unpackBS(order, th, scaleB, dxMin, skew) {
  const B = softplus(th[0]) * scaleB;
  const p = {
    B, aL: th[1], nL: softplus(th[2]), aH: th[3], nH: softplus(th[4]),
    xs: th[5], w: BS_W_FLOOR + softplus(th[6]),
    nH2: NaN, xsat: NaN, v: NaN, nu: 1,
  };
  if (skew) {
    // v3.1 — occupancy 형태 파라미터. f = [1+exp(−z)]^(−ν) 에서 상승 꼬리 속도는 ν/ω,
    // 포화 꼬리 속도는 1/ω 이다(수치 확인). 즉 ν 가 **두 꼬리를 분리**한다 —
    // ν>1 이면 '가파른 점화 + 느린 포화'가 된다. ν=1 이 로지스틱(기존 모델)이므로
    // 중첩 비교가 성립하고, 추가할 가치가 있는지는 AICc 가 정한다.
    p.nu = Math.min(softplus(th[order >= 1 ? 10 : 7]), BS_NU_MAX);
  }
  if (order >= 1) {
    const gap = Math.max(isFinite(dxMin) && dxMin > 0 ? dxMin : 0, W_FLOOR.v);
    p.nH2 = softplus(th[7]);
    p.xsat = p.xs + gap + softplus(th[8]);
    p.v = W_FLOOR.v + softplus(th[9]);
  }
  return p;
}
/** 고상태 가지의 log10 세기 */
function bsHighH(p, x, order) {
  let h = p.aH + p.nH * x;
  if (order >= 1) h += (p.nH2 - p.nH) * p.v * softplus((x - p.xsat) / p.v);
  return h;
}
function bsLowH(p, x) { return p.aL + p.nL * x; }
/** 고상태 가지의 국소 지수 d log10 I_high / d log10 P (해석적).
 *  포화 힌지가 있으면 n_H → n_H2 로 옮겨가므로 **한 개의 수가 아니다** — 그래서 보고는
 *  '전환 파워의 몇 배에서 얼마'라는 프로파일로 한다. */
function bsHighSlope(p, x, order) {
  if (!(order >= 1)) return p.nH;
  return p.nH + (p.nH2 - p.nH) * sigmoid((x - p.xsat) / p.v);
}
/** occupancy f(x) — ν=1 이면 로지스틱과 정확히 같다. */
function bsOcc(p, x) {
  const z = (x - p.xs) / p.w;
  const nu = isFinite(p.nu) && p.nu > 0 ? p.nu : 1;
  if (nu === 1) return sigmoid(z);
  // (1+e^{-z})^{-ν} 를 로그 공간에서 — z 가 크게 음수여도 수치적으로 안전하다
  const le = z >= 0 ? Math.log1p(Math.exp(-z)) : (-z + Math.log1p(Math.exp(z)));
  return Math.exp(clamp(-nu * le, -700, 0));
}
/** f = 0.5 가 되는 위치 (ν≠1 이면 x_s 가 중점이 아니다) */
function bsHalfX(p) {
  const nu = isFinite(p.nu) && p.nu > 0 ? p.nu : 1;
  if (nu === 1) return p.xs;
  const t = Math.pow(2, 1 / nu) - 1;
  return t > 0 ? p.xs - p.w * Math.log(t) : p.xs;
}
/** 10→90% 전환 폭 (dec) — 형태가 달라도 비교 가능한 폭 정의 */
function bsWidth1090(p) {
  const nu = isFinite(p.nu) && p.nu > 0 ? p.nu : 1;
  const zAt = (q) => { const t = Math.pow(q, -1 / nu) - 1; return t > 0 ? -Math.log(t) : NaN; };
  const z1 = zAt(0.1), z9 = zAt(0.9);
  return isFinite(z1) && isFinite(z9) ? p.w * (z9 - z1) : NaN;
}
function bistableI(p, x, order) {
  const f = bsOcc(p, x);
  const lo = Math.pow(10, clamp(bsLowH(p, x), -300, 300));
  const hi = Math.pow(10, clamp(bsHighH(p, x, order), -300, 300));
  return p.B + (1 - f) * lo + f * hi;
}
/** 참고용 유효 기울기(보고량이 아님) — 곡선 겹쳐 그리기와 진단에만 쓴다. */
function bistableSlope(p, x, order, h) {
  const dx = h || 1e-4;
  const a = bistableI(p, x - dx, order), b = bistableI(p, x + dx, order);
  if (!(a > 0 && b > 0)) return NaN;
  return (Math.log10(b) - Math.log10(a)) / (2 * dx);
}

/** 한쪽 구간의 로그-로그 최소제곱 (시작점 유도용) */
function logLogLS(xs2, ys2) {
  const m = xs2.length;
  if (m < 2) return null;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < m; i++) { sx += xs2[i]; sy += ys2[i]; sxx += xs2[i] * xs2[i]; sxy += xs2[i] * ys2[i]; }
  const den = m * sxx - sx * sx;
  if (!(Math.abs(den) > 1e-12)) return null;
  const slope = (m * sxy - sx * sy) / den;
  return { slope, intercept: (sy - slope * sx) / m };
}

/** 결정론적 시작점. 전환 위치는 '실측에서 가장 가파른 한 스텝'에서 찾는다 —
 *  스플라인 기울기에서 유도하면 격자보다 예리한 전이를 찾을 수 없다(v2.8 에서 확인). */
function bistableStarts(order, x, I, spline, scaleB, darkPrior, mask, skew) {
  const n = x.length;
  const use = mask || new Array(n).fill(true);
  const idx = [];
  for (let i = 0; i < n; i++) if (use[i]) idx.push(i);
  if (idx.length < 8) return [];
  const xlo = x[idx[0]], xhi = x[idx[idx.length - 1]];
  // 전환 위치 후보: 최급 단일 스텝 · 스플라인 최대기울기 지점
  let stepBest = -Infinity, xStep = NaN;
  for (let a = 0; a + 1 < idx.length; a++) {
    const i = idx[a], j = idx[a + 1];
    const h = x[j] - x[i];
    if (!(h > 0) || !(I[i] > 0) || !(I[j] > 0)) continue;
    const sl = (Math.log10(I[j]) - Math.log10(I[i])) / h;
    if (sl > stepBest) { stepBest = sl; xStep = 0.5 * (x[i] + x[j]); }
  }
  let xSpl = NaN;
  try {
    let sm = -Infinity;
    for (let k = 0; k <= 60; k++) {
      const xv = xlo + (xhi - xlo) * k / 60, sv = spline.slopeAt(xv);
      if (isFinite(sv) && sv > sm) { sm = sv; xSpl = xv; }
    }
  } catch (e) { xSpl = NaN; }
  const xsCands = [xStep, xSpl, 0.5 * (xlo + xhi)].filter(isFinite);
  const B0 = isFinite(darkPrior) && darkPrior > 0 ? darkPrior : Math.max(quantile(I, 0.10), 1e-12);
  const uB0 = invSoftplus(Math.max(B0 / scaleB, 1e-9));
  const dxs = [];
  for (let a = 1; a < idx.length; a++) dxs.push(x[idx[a]] - x[idx[a - 1]]);
  const mdx = Math.max(median(dxs) || 0.01, 1e-4);
  const S = [];
  for (const xs0 of xsCands) {
    // 양쪽 구간에서 로그-로그 LS 로 지수·절편 초기값
    const loX = [], loY = [], hiX = [], hiY = [];
    for (const i of idx) {
      const net = I[i] - B0;
      if (x[i] < xs0 - mdx) { if (net > 0) { loX.push(x[i]); loY.push(Math.log10(net)); } }
      else if (x[i] > xs0 + mdx) { if (I[i] > 0) { hiX.push(x[i]); hiY.push(Math.log10(I[i])); } }
    }
    const fitLo = logLogLS(loX, loY), fitHi = logLogLS(hiX, hiY);
    const nH0 = fitHi && isFinite(fitHi.slope) ? clamp(fitHi.slope, 0.05, 30) : 2;
    const aH0 = fitHi && isFinite(fitHi.intercept) ? clamp(fitHi.intercept, -THETA_BOX, THETA_BOX)
      : (hiY.length ? hiY[0] - nH0 * hiX[0] : 0);
    const nLcands = fitLo && isFinite(fitLo.slope) ? [clamp(fitLo.slope, 0.02, 20), 1, 2] : [1, 2, 0.3];
    for (const nL0 of nLcands) {
      const aL0 = fitLo && isFinite(fitLo.intercept) && nL0 === clamp(fitLo.slope, 0.02, 20)
        ? clamp(fitLo.intercept, -THETA_BOX, THETA_BOX)
        : clamp(Math.log10(Math.max(B0, 1e-12)) - nL0 * xs0, -THETA_BOX, THETA_BOX);
      for (const w0 of [mdx * 0.3, mdx * 1.5, 0.05]) {
        const base = [uB0, aL0, invSoftplus(nL0), aH0, invSoftplus(nH0), xs0,
          invSoftplus(Math.max(w0 - BS_W_FLOOR, 1e-6))];
        if (order === 0) S.push(base);
        else {
          // x_sat 은 x_s 로부터의 오프셋으로 매개화되어 있다(위 unpackBS 참조)
          const gap0 = Math.max(mdx, W_FLOOR.v);
          for (const dsat of [0.35 * Math.max(xhi - xs0, mdx), Math.max(xhi - xs0 - 0.1 * (xhi - xlo), mdx)]) {
            S.push(base.concat([invSoftplus(Math.max(nH0 * 0.35, 0.05)),
              invSoftplus(Math.max(dsat - gap0, 1e-6)),
              invSoftplus(Math.max(0.08 - W_FLOOR.v, 1e-6))]));
          }
        }
      }
    }
  }
  if (!skew) return S;
  // 비대칭 모델의 시작점: ν = 1(로지스틱)과 '가파른 점화' 후보 몇 개
  const out = [];
  for (const t0 of S) for (const nu0 of [1, 5, 20]) out.push(t0.concat([invSoftplus(nu0)]));
  return out;
}

/** bistable 적합 — 강건 코어를 H 족과 공유하므로 χ²/AICc 가 직접 비교 가능하다. */
function fitBistable(order, x, I, sigG, lamG, scaleB, starts, huberC, mask, globalOpts, dxMin, occData, skew) {
  const n = x.length;
  const useMask = mask || new Array(n).fill(true);
  const np = bsNParams(order, skew);
  if (!starts || !starts.length) return null;
  const lo = new Array(np).fill(-THETA_BOX), hi = new Array(np).fill(THETA_BOX);
  const xlo = Math.min(...x), xhi = Math.max(...x);
  lo[5] = xlo - 0.5; hi[5] = xhi + 0.5;                 // 전환 파워는 측정범위 근방
  const predict = (th) => {
    const p = unpackBS(order, th, scaleB, dxMin, skew);
    const mu = new Array(n);
    for (let i = 0; i < n; i++) mu[i] = bistableI(p, x[i], order);
    return mu;
  };
  // v3.0 — 관측된 occupancy를 제약으로 넣는다. f(x) 는 모델이 이미 가진 함수이므로
  // 새 파라미터가 늘지 않는다. 이것이 '점화 중간 준위를 f 로 볼 것인가 고상태 지수로
  // 볼 것인가'의 축퇴를 끊는다 — 반복 분산이 그 답을 데이터로 정해 주기 때문이다.
  const occ = (occData || []).filter((dd) => isFinite(dd.x) && isFinite(dd.f) && isFinite(dd.sd) && dd.sd > 0);
  const extraResid = occ.length ? (th) => {
    const p = unpackBS(order, th, scaleB, dxMin, skew);
    return occ.map((dd) => (bsOcc(p, dd.x) - dd.f) / dd.sd);
  } : null;
  const outcome = robustFitCore({ n, lo, hi, starts, predict, I, sigG, lamG, huberC, useMask,
    globalOpts, allowGlobal: true, extraResid });
  if (!outcome) return null;
  const p = unpackBS(order, outcome.theta, scaleB, dxMin, skew);
  const rawResid = new Array(n);
  const accepted = [];
  for (let i = 0; i < n; i++) {
    rawResid[i] = (glog10(I[i], lamG) - glog10(bistableI(p, x[i], order), lamG)) / sigG[i];
    if (useMask[i] && outcome.irlsW[i] >= 0.1) accepted.push(i);
  }
  let chi2 = 0;
  for (const i of accepted) chi2 += rawResid[i] * rawResid[i];
  const nAcc = accepted.length, k = np;
  const aicc = nAcc > k + 1 ? chi2 + 2 * k + (2 * k * (k + 1)) / (nAcc - k - 1) : Infinity;
  // occupancy residual는 **AICc 에 넣지 않는다**: H 족은 f 라는 양이 없어 같은 자료로 평가할 수
  // 없기 때문이다. 대신 bistable 쪽만 이 제약을 지고 평균 적합 χ² 로 비교받는다 —
  // 제약은 평균 χ² 를 나쁘게만 만들 수 있으므로, 그래도 이기면 정당한 승리다.
  let chi2Occ = 0;
  if (occ.length) {
    for (const dd of occ) {
      const e = (bsOcc(p, dd.x) - dd.f) / dd.sd;
      if (isFinite(e)) chi2Occ += e * e;
    }
  }
  // ---- v3.7: θ 상자 경계 접촉 노출 ----
  // H 족에는 boundHits 가 있는데 bistable 적합에는 없었다. 그래서 θ 가 THETA_BOX 에
  // 붙어 나온 값(예: nu = 60 = THETA_BOX)이 **적합값처럼** 호출자에게 전달됐다.
  // 우연히 참값 근처면 더 위험하다 — 경계값을 물리량으로 착각하게 된다.
  //
  // softplus 로 감싼 양수 파라미터는 θ → −BOX 가 '그 파라미터 → 0' 이라는 정상 해이므로
  // 보고하지 않는다(H 족과 같은 관례). 생짜 절편(aL, aH)은 아래쪽 경계도 병리이므로 본다.
  // xs(θ[5])는 자체 상자(측정범위 근방)를 쓰므로 여기서 세지 않는다.
  const bsNameOf = (j) => {
    const nuIdx = order >= 1 ? 10 : 7;
    if (j === nuIdx && skew) return "nu";
    return { 0: "B", 1: "aL", 2: "nL", 3: "aH", 4: "nH", 5: "xs", 6: "w", 7: "nH2", 8: "xsat", 9: "v" }[j]
      || ("theta[" + j + "]");
  };
  const RAW_PARAMS = new Set(["aL", "aH"]);
  const boundHits = [];
  const BSTOL = 0.05;
  outcome.theta.forEach((t, j) => {
    if (j === 5) return;                                   // xs 는 별도 상자
    if (!isFinite(t)) return;
    const nm = bsNameOf(j);
    const hi2 = t > 0 && Math.abs(t - THETA_BOX) < BSTOL;
    const lo2 = t < 0 && Math.abs(t + THETA_BOX) < BSTOL && RAW_PARAMS.has(nm);
    if (!hi2 && !lo2) return;
    boundHits.push({ param: nm, at: hi2 ? "box-hi" : "box-lo", theta: t, bound: THETA_BOX,
                     value: p[nm] });
  });
  return { order, skew: !!skew, theta: outcome.theta, params: p, cost: outcome.score, chi2, aicc, k,
    chi2Occ, nOcc: occ.length, boundHits,
    rawResid, irlsW: outcome.irlsW, accepted, nAccepted: nAcc };
}

/**
 * bistable 서술의 드라이버: BS0/BS1 을 적합하고 AICc 로 고른 뒤, **유한한 보고량**과
 * 그 identifiability 판정을 함께 낸다.
 *
 * identifiability 판정이 왜 보고량만큼 중요한가: 저상태 가지가 암계수 바닥 아래에 있으면
 * n_L 과 대비비는 원리적으로 결정되지 않는다(WJ-0075c 가 정확히 이 경우다 — 점화 직전
 * 신호가 암계수와 구별되지 않는다). 그때도 **전환 파워 P_s 와 고상태 지수 n_H 는
 * 그대로 식별된다.** 무엇이 결정되고 무엇이 결정되지 않는지를 분리해 보고하는 것이
 * 이 족의 실질적 이득이다 — s_max 는 통째로 결정되지 않았다.
 */
function bistableAnalyze(x, I, sigG, lamG, scaleB, huberC, mask, globalOpts, spline, darkPrior, medianDx, opts, occupancy) {
  const o = opts || {};
  const n = x.length;
  const useMask = mask || new Array(n).fill(true);
  const nMask = useMask.reduce((a, m) => a + (m ? 1 : 0), 0);
  const guard = isFinite(o.aiccGuard) ? o.aiccGuard : 4;
  // 관측된 occupancy — 걸렸고, 혼합으로 설명되며, 마스크를 통과한 setpoint 만 쓴다
  // 제약의 출처는 두 가지다: (a) 호출자가 준비해 준 배열(v3.4 — cross-branch occupancy),
  // (b) branch 내 반복 분산(v3.0). (a) 가 있으면 그것을 쓴다 — cross-branch 쪽은 고상태 준위를
  // 외삽하지 않으므로 계통이 원리적으로 없다(v3.2 에서 측정).
  const occData = (Array.isArray(o.occData) && o.occData.length)
    ? o.occData.filter((dd) => isFinite(dd.x) && isFinite(dd.f) && isFinite(dd.sd) && dd.sd > 0)
    : ((occupancy && occupancy.checked && o.useOccupancy !== false)
      ? occupancy.rows.filter((r) => r.blink && r.mixtureConsistent && isFinite(r.fMean)
          && isFinite(r.fSd) && r.fSd > 0 && useMask[r.i])
          .map((r) => ({ x: r.x, f: r.fMean, sd: r.fSd, i: r.i }))
      : []);
  const maxOrder = o.maxOrder === 0 ? 0 : 1;
  // v3.1 — 후보는 두 축이다: 고상태 포화(order 0/1) × occupancy 형태(로지스틱 / 비대칭 ν).
  // `skew:false` 로 끄면 v3.0 과 동일한 두 후보만 본다.
  // **비대칭 축은 기본 꺼짐**. 측정: 로지스틱 생성 데이터 12회 중 3회(25%)가 잘못 선택되고
  // 그때 파라미터가 무너진다(ν=60, P_s 오차 63%). 참으로 비대칭(ν=8)인 데이터에서도 5/12 만
  // 선택되고 ν 중앙오차 650%, n_high 중앙오차 111% 로 오히려 나빠진다. 비용도 3배.
  // 즉 형태 파라미터는 세기 데이터만으로 식별되지 않는다. `skew:true` 로만 켠다.
  const allowSkew = o.skew === true;
  const fits = {};
  const keyOf = (order, sk) => `${order}${sk ? "s" : ""}`;
  for (let order = 0; order <= maxOrder; order++) {
    for (const sk of (allowSkew ? [false, true] : [false])) {
      let starts = bistableStarts(order, x, I, spline, scaleB, darkPrior, useMask, sk);
      if (o.fast) starts = starts.slice(0, sk ? 12 : 6);
      fits[keyOf(order, sk)] = fitBistable(order, x, I, sigG, lamG, scaleB, starts, huberC,
        useMask, globalOpts, medianDx, occData, sk);
    }
  }
  // 공통 마스크 위의 χ²/AICc — H 족과 같은 점집합·같은 기준이라야 비교가 성립한다
  for (const k2 of Object.keys(fits)) {
    const f = fits[k2];
    if (!f) continue;
    let c = 0;
    for (let i = 0; i < n; i++) if (useMask[i]) c += f.rawResid[i] * f.rawResid[i];
    f.chi2 = c;
    f.aicc = nMask > f.k + 1 ? c + 2 * f.k + (2 * f.k * (f.k + 1)) / (nMask - f.k - 1) : Infinity;
  }
  // 단순한 것부터 시작해 **가드보다 확실히 나을 때만** 복잡한 쪽으로 옮긴다
  // (H 족의 중첩 선택 규칙을 두 축으로 일반화).
  const cands = Object.keys(fits).filter((k2) => fits[k2]).sort((a2, b2) => fits[a2].k - fits[b2].k);
  if (!cands.length) return null;
  let bestKey = cands[0];
  for (const k2 of cands.slice(1)) if (fits[k2].aicc < fits[bestKey].aicc - guard) bestKey = k2;
  const fit0 = fits[bestKey];
  // 대조는 **같은 key** 가 아니라 제약 없이 다시 고른 최선의 후보여야 한다 —
  // 제약은 어느 후보가 선택되는지까지 바꾸기 때문이다(실측: 제약 시 key=0s, 무제약 시 key=1).
  // 같은 key 로만 비교하면 갈등의 크기를 과소평가한다(2.7× vs 실제 38×).
  let chi2Unconstrained = NaN, unconstrainedFit = null;
  if (occData.length) {
    try {
      let bestU = null;
      for (let ord = 0; ord <= maxOrder; ord++) {
        for (const sk of (allowSkew ? [false, true] : [false])) {
          let st2 = bistableStarts(ord, x, I, spline, scaleB, darkPrior, useMask, sk);
          if (o.fast) st2 = st2.slice(0, sk ? 12 : 6);
          const uf = fitBistable(ord, x, I, sigG, lamG, scaleB, st2, huberC,
            useMask, globalOpts, medianDx, [], sk);
          if (!uf) continue;
          let c2 = 0;
          for (let i = 0; i < n; i++) if (useMask[i]) c2 += uf.rawResid[i] * uf.rawResid[i];
          const kk = bsNParams(ord, sk);
          const ai = nMask > kk + 1 ? c2 + 2 * kk + (2 * kk * (kk + 1)) / (nMask - kk - 1) : Infinity;
          if (!bestU || ai < bestU.aicc - guard) bestU = { aicc: ai, chi2: c2, fit: uf };
        }
      }
      if (bestU) { chi2Unconstrained = bestU.chi2; unconstrainedFit = bestU.fit; }
    } catch (e) { chi2Unconstrained = NaN; }
  }
  // ── 제약 철회 ──
  const conflictRatio = isFinite(chi2Unconstrained) && chi2Unconstrained > 0
    ? fit0.chi2 / chi2Unconstrained : NaN;
  const occWithdrawn = isFinite(conflictRatio) && conflictRatio > OCC_CONFLICT_MAX
    && !!unconstrainedFit;
  // 철회되면 **무제약 적합을 그대로 보고한다** — 제약이 바꾼 값을 조용히 내놓지 않는다.
  const fit = occWithdrawn ? unconstrainedFit : fit0;
  const chosen = fit.order;
  const chosenSkew = !!fit.skew;
  const p = fit.params;

  // ── 보고량 ──
  // 전환 파워는 **f = 0.5 지점**으로 정의한다 — ν≠1 이면 x_s 는 중점이 아니다.
  const xHalf = bsHalfX(p);
  const hL = bsLowH(p, xHalf), hH = bsHighH(p, xHalf, chosen);
  const log10Contrast = hH - hL;
  // 전환 파워를 감싸는 실측 두 점 — ω 가 격자보다 작으면 x_s 는 이 구간 안에서만 결정된다
  let bracket = null;
  const idx = [];
  for (let i = 0; i < n; i++) if (useMask[i]) idx.push(i);
  for (let a = 0; a + 1 < idx.length; a++) {
    if (x[idx[a]] <= xHalf && xHalf <= x[idx[a + 1]]) {
      bracket = [Math.pow(10, x[idx[a]]), Math.pow(10, x[idx[a + 1]])];
      break;
    }
  }
  // ── identifiability ──
  let nLowPts = 0, nHighPts = 0, xLastLow = NaN;
  for (const i of idx) {
    if (x[i] < xHalf - 3 * p.w) { nLowPts++; if (!(xLastLow > x[i])) xLastLow = x[i]; }
    else if (x[i] > xHalf + 3 * p.w) nHighPts++;
  }
  // 바닥은 **데이터에서 온 암계수**를 우선한다. 적합된 B 를 쓰면 배경이 저상태 멱법칙으로
  // 흡수되는 축퇴해(B→0, n_L→0)에서 "저상태가 바닥 위에 있다"는 거짓 판정이 난다
  // (실측: n_L=0.09 인 평탄해가 lowVisible=true 로 통과했다).
  const darkFloor = isFinite(darkPrior) && darkPrior > 0 ? darkPrior : p.B;
  const floorLevel = Math.max(darkFloor, 0);
  const lowLevelAtEdge = isFinite(xLastLow) ? Math.pow(10, clamp(bsLowH(p, xLastLow), -300, 300)) : NaN;
  // 저상태 가지가 (1) 암계수 바닥 위로 확실히 솟고 (2) 평탄하지 않아야 n_L·대비비가 결정된다.
  // 평탄함(n_L → 0)은 저상태가 아니라 배경을 그린 것이다.
  const lowVisible = nLowPts >= 4 && isFinite(lowLevelAtEdge)
    && lowLevelAtEdge > 1.5 * floorLevel && p.nL > 0.10;
  // 문턱 위 측정 구간 — 이것이 짧으면 어떤 형태족을 써도 고상태 지수는 결정되지 않는다
  const xMaxAll = idx.length ? x[idx[idx.length - 1]] : NaN;
  const nHighRangeDec = isFinite(xMaxAll) ? xMaxAll - xHalf : NaN;
  const rangeOk = isFinite(nHighRangeDec) && nHighRangeDec >= NHIGH_RANGE_MIN;
  const highResolved = nHighPts >= 5 && rangeOk;
  // ── 고상태 지수는 '한 개의 수'가 아닐 수 있다 ──
  // 실측(WJ-0075c up): 점화 직후 국소 기울기가 25 → 11 → 10 → 6 으로 떨어진다. 이때
  // n_high 하나를 보고하면 어느 구간의 값인지 알 수 없다. 그래서 전환 파워의 배수 위치에서
  // 고상태 가지의 국소 지수를 표로 낸다 — 매개화(포화 힌지 유무)에 의존하지 않는 양이다.
  const xMaxData = idx.length ? x[idx[idx.length - 1]] : NaN;
  const nHighProfile = [];
  for (const mlt of [1.2, 1.5, 2, 3, 5]) {
    const xv = xHalf + Math.log10(mlt);
    if (isFinite(xMaxData) && xv <= xMaxData) {
      nHighProfile.push({ mult: mlt, P: Math.pow(10, xv), n: bsHighSlope(p, xv, chosen) });
    }
  }
  const nvals = nHighProfile.map((r) => r.n).filter(isFinite);
  const nSpread = nvals.length >= 2
    ? (Math.max(...nvals) - Math.min(...nvals)) / Math.max(Math.abs(Math.max(...nvals)), 1e-12) : 0;
  const nHighVaries = nSpread > 0.25;
  // 포화 꺾임이 강제된 최소 간격에 붙어 있으면, 그 위의 n_high 는 전환의 일부를 그리는
  // 경사로이지 고상태의 지수가 아니다 — 단일값으로 보고하면 안 된다.
  const satGap = chosen >= 1 ? p.xsat - p.xs : NaN;
  const gapFloor = Math.max(isFinite(medianDx) && medianDx > 0 ? medianDx : 0, W_FLOOR.v);
  const satAtGap = chosen >= 1 && isFinite(satGap) && satGap <= gapFloor * 1.05;
  // ── v3.4: n_high 물리 바닥 ──
  // occupancy 제약이 걸리면 적합은 전환 예산을 f 에 몰아주고 고상태를 **평탄하게**(n_H→0)
  // 놓아버릴 수 있다. 그러면 전환 이후의 멱법칙 상승이 통째로 오차로 남는데도
  // 기존 identifiability 층은 nHighVaries=false·highResolved=true 로 그 0 을 **단일값으로 승인**한다
  // (실측 WJ-0075c up 에서 nHighSingle=0.00 이 그렇게 보고됐다).
  // 판정: PA 고상태의 멱지수가 선형(1) 아래로 내려가면 그것은 고상태가 아니다.
  // 참값 대조(합성 11조건×3씨앗, 제약이 걸린 33건): 오차<50% 인 24건 중 오표시 0건,
  // 오차≥50% 인 9건 중 6건 포착. 거짓양성 0% · 민감도 67%.
  // 한계: 배터리의 참 n_H 는 2.2 / 4 / 8 뿐이다. 진짜로 n_high < 1 인 물질에서는
  // 이 문턱이 옳은 값을 가릴 수 있다 — 그 영역은 검증되지 않았다.
  const nHighCollapsed = isFinite(p.nH) && p.nH < NHIGH_FLOOR;
  // 제약이 걸렸을 때, **같은 후보를 제약 없이** 한 번 더 적합해 세기 χ² 를 대조한다.
  // 제약이 정당하게 편향을 고칠 때도 세기 χ² 는 나빠지므로(합성 중앙 1.5배, 최대 9.8배)
  // 이 비를 문턱으로 쓰지는 않는다 — 수치로만 보고한다. 실측 WJ-0075c up 은 38배였다.
  return {
    engine: "BistableFit",
    chosenOrder: chosen, chosenSkew,
    chosenKey: (occWithdrawn ? keyOf(chosen, chosenSkew) : bestKey) + (occWithdrawn ? "(철회)" : ""),
    nu: p.nu, width1090Dec: bsWidth1090(p),
    // ---- v3.7: 어떤 파라미터가 θ 상자 경계에 붙었는가 ----
    // 경계에 붙은 값은 적합값이 아니라 제약의 산물이므로 **값으로 보고하면 안 된다**.
    // 판정은 여기서 하고, 표시는 호출자가 한다(엔진은 화면을 모른다).
    boundHits: fit.boundHits || [],
    paramsAtBound: (fit.boundHits || []).map((b) => b.param),
    nuAtBound: (fit.boundHits || []).some((b) => b.param === "nu"),
    nHighAtBound: (fit.boundHits || []).some((b) => b.param === "nH" || b.param === "nH2"),
    nLowAtBound: (fit.boundHits || []).some((b) => b.param === "nL" || b.param === "aL"),
    fitsSummary: Object.fromEntries(Object.entries(fits).map(([k2, f]) => [k2, f ? { aicc: f.aicc, chi2: f.chi2, k: f.k, order: f.order, skew: !!f.skew } : null])),
    theta: fit.theta, params: p, chi2: fit.chi2, aicc: fit.aicc, k: fit.k,
    chi2Occ: fit.chi2Occ, nOcc: fit.nOcc, occUsed: occData.length,
    rawResid: fit.rawResid, irlsW: fit.irlsW, nUsed: nMask,
    // 유한한 보고량들 — ω 가 아무리 작아도 이 값들은 결정된다
    nLow: p.nL, nHigh: p.nH, nHigh2: chosen >= 1 ? p.nH2 : NaN,
    nHighProfile, nHighVaries, nHighSpread: nSpread, satAtGap, satGapDec: satGap,
    // 단일값으로 보고해도 되는 경우에만 채운다
    nHighSingle: (!nHighVaries && !satAtGap && highResolved && !nHighCollapsed)
      ? (nvals.length ? nvals[nvals.length - 1] : p.nH) : NaN,
    nHighCollapsed, nHighFloor: NHIGH_FLOOR,
    chi2Unconstrained, chi2VsUnconstrained: conflictRatio,
    occWithdrawn, occConflictMax: OCC_CONFLICT_MAX,
    pSwitch: Math.pow(10, xHalf), logPSwitch: xHalf, pSwitchBracket: bracket,
    pSaturation: chosen >= 1 ? Math.pow(10, p.xsat) : NaN,
    log10Contrast, contrast: Math.pow(10, clamp(log10Contrast, -300, 300)),
    // 저상태가 바닥 아래면 대비비는 lower bound이다 (분모를 바닥으로 대체)
    log10ContrastLB: hH - Math.log10(Math.max(floorLevel, 1e-300)),
    switchWidthDec: p.w,
    widthAtFloor: p.w <= BS_W_FLOOR * 1.05,
    widthSubGrid: isFinite(medianDx) ? p.w < medianDx : null,
    background: p.B,
    nHighRangeDec, nHighRangeMin: NHIGH_RANGE_MIN, rangeOk,
    identifiability: { lowVisible, highResolved, nLowPts, nHighPts, floorLevel, lowLevelAtEdge,
      nHighCollapsed, nHighRangeDec, rangeOk },
  };
}

/**
 * 여러 branch의 고상태 국소지수를 **절대 파워 격자**에서 합산한다 (v3.6).
 *
 * 왜 필요한가: 한 branch의 문턱 위 구간이 0.25 dec 에 못 미치면 n_high 는 결정되지 않는다
 * (NHIGH_RANGE_MIN). 실측 16 branch 중 14개가 그렇다 — 스윕을 더 높은 파워까지 늘리지
 * 못하는 상황에서는 **여러 branch를 묶는 것**이 유일한 우회로다.
 *
 * **P_s 배수가 아니라 절대 파워로 묶어야 한다.** branch마다 전환 파워가 다르므로
 * "1.2×P_s" 는 branch마다 다른 절대 파워를 가리킨다. 실측 WJ-0128c 12 branch를 1.2×P_s 로
 * 묶으면 상행 2.9 · 하행 5.6 으로 갈려 지수가 파워에 세게 의존하는 것처럼 보이지만,
 * 절대 파워로 묶으면 0.010–0.013 mW 에서 3.75–3.94 로 평탄하다. 그 '의존성'은 artifact 였다.
 *
 * 참값 검증(자리마다 P_s 를 흩뿌린 합성 6자리 × 2 branch = 11 branch, 구간 0.10–0.47 dec):
 * 네 파워 모두 **오차 0%**, 90% 구간 ±1–2%.
 *
 * 왜 되는가 — 평균이 나쁜 branch를 고치기 때문이 아니다. **하행 branch는 전환 파워가 낮아
 * 문턱 위 구간이 길고 그래서 잘 결정되며**(합성: 하행 6개가 2.17–2.22, 참값 2.20),
 * 중앙값이 짧은 상행의 이상치(1.25)에 끌리지 않기 때문이다. 즉 이 방법은
 * "긴 구간 branch가 하나라도 있으면 그것을 찾아내는" 강건 추정이지 마법이 아니다.
 *
 * @param bistables analyze() 결과의 .bistable 배열 (붕괴·구간없음은 알아서 걸러낸다)
 * @returns { grid: [{P, n, lo90, hi90, nBranch, values}], branches, usable }
 */
/** branch 간 사분범위/중앙값이 이 값을 넘으면 '하나의 n_high' 가정이 깨진 것으로 본다.
 *  동질 합성 9조건에서 0.012–0.141, 이질(이봉) 합성에서 0.811. */
const POOL_IQR_MAX = 0.20;

function poolHighExponent(bistables, opts) {
  const o = opts || {};
  const minBranch = isFinite(o.minBranch) ? o.minBranch : 3;
  const nBoot = isFinite(o.nBoot) ? o.nBoot : 2000;
  const segs = [];
  for (const b of (bistables || [])) {
    if (!b || !b.params || b.nHighCollapsed) continue;
    if (!isFinite(b.pSwitch) || !(b.pSwitch > 0) || !isFinite(b.nHighRangeDec)) continue;
    const xHalf = Math.log10(b.pSwitch);
    const lo = xHalf + 3 * b.params.w;          // 전환이 끝난 뒤부터
    const hi = xHalf + b.nHighRangeDec;         // 측정된 최고 파워까지
    if (!(hi > lo)) continue;
    segs.push({ lo, hi, params: b.params, order: b.chosenOrder, rangeDec: hi - lo });
  }
  if (segs.length < minBranch) {
    return { usable: false, branches: segs.length, minBranch, grid: [] };
  }
  const gLo = Math.min(...segs.map((s2) => s2.lo));
  const gHi = Math.max(...segs.map((s2) => s2.hi));
  const step = 0.005;
  const rng = makeRng(isFinite(o.seed) ? o.seed : 12345);
  const grid = [];
  for (let x = gLo; x <= gHi + 1e-9; x += step) {
    const vals = [];
    for (const s2 of segs) {
      if (x < s2.lo || x > s2.hi) continue;
      const v = bsHighSlope(s2.params, x, s2.order);
      if (isFinite(v)) vals.push(v);
    }
    if (vals.length < minBranch) continue;
    const med = median(vals);
    // 결정론적 부트스트랩으로 중앙값의 90% 구간
    const ms = [];
    for (let t = 0; t < nBoot; t++) {
      const pick = [];
      for (let i = 0; i < vals.length; i++) pick.push(vals[Math.floor(rng.uniform() * vals.length)]);
      ms.push(median(pick));
    }
    ms.sort((a2, b2) => a2 - b2);
    grid.push({ P: Math.pow(10, x), logP: x, n: med,
      lo90: ms[Math.floor(0.05 * nBoot)], hi90: ms[Math.floor(0.95 * nBoot)],
      nBranch: vals.length, values: vals.slice().sort((a2, b2) => a2 - b2) });
  }
  // 가장 많은 branch가 겹치는 지점을 대표값으로 고른다
  let best = null;
  for (const g of grid) if (!best || g.nBranch > best.nBranch) best = g;
  // ── heterogeneity 판정 (v3.6) ──
  //
  // 합산 중앙값은 "모든 branch가 같은 n_high 를 가진다"는 가정 위에서만 하나의 값에 대한
  // 추정이다. 자리마다 실제로 다르면 중앙값은 **분포의 요약**일 뿐이고, 90% 구간을
  // 신뢰구간으로 읽으면 안 된다.
  //
  // 판정은 **branch 간 사분범위를 중앙값으로 나눈 값**으로 한다. 동질 합성에서 이 값이
  // 얼마나 나오는지를 재서 문턱을 잡았다 (6자리 × 2 branch, 9개 조건):
  //   n_H 1.5 / 2.2 / 4.0 / 8.0 · 고상태 soft · 잡음 0.05 · 광퇴색 8% · 반복 3 · 힌지 sat1
  //   → 0.012 · 0.016 · 0.028 · 0.032 · 0.034 · 0.037 · 0.064 · 0.101 · 0.141
  // 즉 **동질이면 0.15 를 넘지 않는다.** 참 n_H 가 자리마다 다른 합성(1.6 다섯 · 3.1 다섯)
  // 에서는 0.811 이 나온다. 0.20 을 문턱으로 둔다.
  //
  // 이 깃발이 서면 두 가지 중 하나다 — 자리마다 실제로 다르거나, 일부 적합이 불안정하거나
  // (느린 점멸에서 시드에 따라 IQR 2.694 가 나온 적이 있다). 어느 쪽이든 **구간을
  // 하나의 값에 대한 신뢰구간으로 읽으면 안 된다**는 결론은 같다.
  //
  // 중요: 이질적이어도 **개별 branch 추정은 정확하다**(위 합성에서 branch별 오차
  // 0·0·0·0·0·1·3·6%). 무너지는 것은 '하나의 값으로 요약하는 것'이지 추정 자체가 아니다.
  let iqrRel = NaN;
  if (best && best.values.length >= 4) {
    const v = best.values;
    const q1 = v[Math.floor(0.25 * v.length)], q3 = v[Math.floor(0.75 * v.length)];
    iqrRel = Math.abs(q3 - q1) / Math.max(Math.abs(best.n), 1e-12);
  }
  const heterogeneous = isFinite(iqrRel) && iqrRel > POOL_IQR_MAX;
  return { usable: grid.length > 0, branches: segs.length, minBranch,
    rangeDecs: segs.map((s2) => s2.rangeDec).sort((a2, b2) => a2 - b2),
    iqrRel, heterogeneous, iqrMax: POOL_IQR_MAX,
    grid, best };
}

/** bistable 합성 데이터 생성기 — 참값을 알고 회수 여부를 판정하기 위한 것.
 *  전환 폭 ω 만 바꿔가며 같은 실험을 반복하는 것이 v2.9 의 결정적 검증이다. */
function synthBistable(scenario, seed) {
  const rng = makeRng(seed || 1);
  const s = Object.assign({
    n: 90, reps: 5, xlo: -1.2, xhi: 0.6,
    B: 120, aL: 1.6, nL: 1.0, aH: 4.1, nH: 1.8, xs: 0.0, w: 0.02,
    nH2: 1.0, xsat: 0.4, v: 0.08,         // order ≥ 1 일 때만 쓰인다
    nu: 1,                                // occupancy 형태 (1 = 로지스틱)
    a0: 12, a1: 10, a2: 0.02, order: 0,
  }, scenario);
  const p = { B: s.B, aL: s.aL, nL: s.nL, aH: s.aH, nH: s.nH, xs: s.xs, w: s.w,
    nH2: s.nH2, xsat: s.xsat, v: s.v };
  const P = [], I = [], reps = [], fTrue = [];
  // blinkNsw 를 주면 전환 구간의 반복을 **telegraph 과정**으로 만든다:
  // dwell 당 전환 횟수 N_sw 가 작으면 반복이 두 상태로 갈리고, 크면 dwell 안에서 평균화된다.
  // 이것이 실제 데이터의 과분산 서명을 만든다 — occupancy 제약을 검증하려면 필수다.
  const nSw = isFinite(s.blinkNsw) ? s.blinkNsw : NaN;
  const dwellOcc = (f) => {
    if (!(nSw > 0)) return f;
    const kon = nSw * f, koff = nSw * (1 - f), steps = 200, dt = 1 / steps;
    let st = rng.uniform() < f ? 1 : 0, acc = 0;
    for (let t = 0; t < steps; t++) {
      if (st === 1) { if (rng.uniform() < koff * dt) st = 0; }
      else if (rng.uniform() < kon * dt) st = 1;
      acc += st;
    }
    return acc / steps;
  };
  for (let i = 0; i < s.n; i++) {
    const x = s.xlo + (s.xhi - s.xlo) * i / (s.n - 1);
    const f = bsOcc({ xs: s.xs, w: s.w, nu: isFinite(s.nu) ? s.nu : 1 }, x);
    const loR = Math.pow(10, clamp(p.aL + p.nL * x, -300, 300));
    const hiR = Math.pow(10, clamp(bsHighH(p, x, s.order), -300, 300));
    const row = [];
    for (let r = 0; r < s.reps; r++) {
      const fd = (nSw > 0 && f > 1e-6 && f < 1 - 1e-6) ? dwellOcc(f) : f;
      const mu = s.B + (1 - fd) * loR + fd * hiR;
      const sd = Math.sqrt(s.a0 * s.a0 + s.a1 * Math.max(mu, 0) + s.a2 * s.a2 * mu * mu);
      row.push(mu + rng.normal() * sd);
    }
    P.push(Math.pow(10, x)); reps.push(row); fTrue.push(f);
    I.push(row.reduce((a, b) => a + b, 0) / row.length);
  }
  const hL = s.aL + s.nL * s.xs, hH = s.aH + s.nH * s.xs;
  return {
    branch: { powerAvg: P, intensityAvg: I, powerStd: P.map(() => 0), intensityStd: I.map(() => 0), intensityReplicates: reps },
    truth: { nLow: s.nL, nHigh: s.nH, pSwitch: Math.pow(10, s.xs), logPSwitch: s.xs,
      log10Contrast: hH - hL, switchWidthDec: s.w, B: s.B, params: p, order: s.order,
      nHigh2: s.nH2, pSaturation: isFinite(s.xsat) ? Math.pow(10, s.xsat) : NaN, f: fTrue },
  };
}

/**
 * v3.3 — 양방향 스윕 합성 생성기 (발광준위 히스테리시스 포함).
 *
 * 왜 필요한가: cross-branch occupancy(v3.2)은 두 방향 스윕이 있어야 성립하는데 기존
 * `synthBistable` 은 단일 branch만 만든다. 참값 대조가 불가능하면 그 추정기가 맞는지,
 * 제약으로 써도 되는지를 **측정으로** 결정할 수 없다.
 *
 * 물리 서술 (실측 WJ-0075c 가 보여준 것을 그대로 매개화):
 *   I(P) = B + (1−f)·10^(aL + nL·x) + f·10^(aH + nH·x)
 *   f 는 **이력 의존**이다:
 *     상행: f_up(x) = Richards((x − xs_up)/w_up, ν_up)
 *     하행: f_dn(x) = Richards((x − xs_dn)/w_dn, ν_dn)
 *   xs_up > xs_dn 이면 전환 파워 히스테리시스, w_up ≫ w_dn 이면 상행이 완만하게 켜진다
 *   (실측: 상행 10→90% 폭 0.135 dec 가 모델이 맞춘 0.011 dec 보다 12배 넓었다).
 *
 * cross-branch 추정기의 참값은 **f_up(x) 자체**다 — 겹침 구간에서 f_dn ≈ 1 이므로
 * (I_up − D)/(I_dn − D) → f_up. f_dn 이 1 에서 벗어난 만큼이 그 추정기의 원리적 편향이고,
 * 이 생성기로 그 크기를 직접 잴 수 있다.
 *
 * 추가 요소: 전환 구간의 telegraph 점멸(반복 과분산), 스윕 전체에 걸친 광퇴색(반환점 불연속).
 */
function synthSweep(scenario, seed) {
  const rng = makeRng(seed || 1);
  const s = Object.assign({
    n: 100,                       // 편도 setpoint 수 (전체 = 2n)
    reps: 5, tau: 0.1,
    xlo: -3.05, xhi: -2.27,       // log10 P (W) — 0.9 ~ 5.4 mW 근방
    B: 120, aL: -0.6, nL: 1.0, aH: 10.6, nH: 2.2,
    xsUp: -2.50, wUp: 0.030, nuUp: 8,     // 상행: 늦게·완만하게 켜짐
    xsDn: -2.70, wDn: 0.010, nuDn: 1,     // 하행: 더 낮은 파워까지 켜져 있음
    blinkNsw: 30,                 // dwell 당 전환 횟수 (점멸 속도)
    hiShape: "power",             // 고상태 준위 모양: power | sat1 | soft | two
    hiN2: 1.0, hiN3: 0.5,         // 꺾임 뒤의 지수
    hiXsat: -2.42, hiXsat2: -2.34, hiV: 0.05, hiM: 1.0,
    bleach: 0,                    // 스윕 전체에 걸친 세기 감소 비율 (0.10 이면 끝에서 10% 감소)
    a2: 0.02,                     // 곱셈 잡음
  }, scenario);
  const occ = (x, xs, w, nu) => bsOcc({ xs, w, nu }, x);
  // ── v3.5: 고상태 준위의 모양을 고를 수 있게 한다 ──
  // v3.4 까지 생성기의 고상태는 **순수 멱법칙**이었다. 그것은 BS order 0 이 정확히
  // 표현하는 형태이므로, 배터리가 "고상태 매개화가 충분한가"를 물어본 적이 없다.
  // 실측 WJ-0075c 는 반대 branch의 겹침 구간 곡선이 멱법칙+힌지 하나로 표현되지 않는다
  // (비 0.68–2.87). 그 상황을 참값과 함께 만들기 위한 선택지다.
  //   power : 10^(aH+nH·x)                          — 종전(대조군)
  //   sat1  : 힌지 하나 (BS order 1 이 정확히 표현) — 대조군
  //   soft  : 유리형 완만 압축 1/(1+(P/Psat)^m)^(1/m) — 힌지로 근사되지 않는 곡률
  //   two   : 힌지 둘 (꺾임이 두 번)                 — order 1 로는 부족
  const softplusJs = (u) => (u > 30 ? u : Math.log1p(Math.exp(u)));
  const hiLevel = (x) => {
    const base = s.aH + s.nH * x;
    const shape = s.hiShape || "power";
    if (shape === "power") return base;
    if (shape === "sat1") {
      const v = isFinite(s.hiV) ? s.hiV : 0.05;
      return base + (s.hiN2 - s.nH) * v * softplusJs((x - s.hiXsat) / v);
    }
    if (shape === "two") {
      const v = isFinite(s.hiV) ? s.hiV : 0.05;
      return base + (s.hiN2 - s.nH) * v * softplusJs((x - s.hiXsat) / v)
        + (s.hiN3 - s.hiN2) * v * softplusJs((x - s.hiXsat2) / v);
    }
    if (shape === "soft") {
      // log10 I = aH + nH·x − (1/m)·log10(1 + (P/Psat)^m)
      // m 이 작을수록 꺾임이 넓게 퍼져 힌지(softplus)로 근사되지 않는다.
      const m = isFinite(s.hiM) ? s.hiM : 1.0;
      const u = m * (x - s.hiXsat);
      const lg = u > 30 ? u / Math.LN10 * Math.LN10 : Math.log10(1 + Math.pow(10, u));
      return base - (s.nH - s.hiN2) / m * lg;
    }
    return base;
  };
  const dwellOcc = (f) => {
    if (!(s.blinkNsw > 0) || !(f > 1e-6 && f < 1 - 1e-6)) return f;
    const kon = s.blinkNsw * f, koff = s.blinkNsw * (1 - f), steps = 120, dt = 1 / steps;
    let st = rng.uniform() < f ? 1 : 0, acc = 0;
    for (let t = 0; t < steps; t++) {
      if (st === 1) { if (rng.uniform() < koff * dt) st = 0; }
      else if (rng.uniform() < kon * dt) st = 1;
      acc += st;
    }
    return acc / steps;
  };
  const pois = (lam) => (lam < 30
    ? (() => { let L = Math.exp(-lam), k = 0, p = 1; do { k++; p *= rng.uniform(); } while (p > L); return k - 1; })()
    : Math.max(0, Math.round(lam + Math.sqrt(lam) * rng.normal())));
  // W 는 감쇠 휠 각도다 — paHighState 가 이 값으로 같은 setpoint 의 반복 읽기를 묶는다.
  // 상수로 두면 전 구간이 한 setpoint 로 병합되므로, 실측처럼 스윕을 따라 단조 변화시킨다.
  const P = [], I = [], Iraw = [], Wh = [], truth = [];
  const total = 2 * s.n;
  let step = 0;
  const emit = (x, dir) => {
    const f = dir === "up" ? occ(x, s.xsUp, s.wUp, s.nuUp) : occ(x, s.xsDn, s.wDn, s.nuDn);
    const L = Math.pow(10, clamp(s.aL + s.nL * x, -300, 300));
    const H = Math.pow(10, clamp(hiLevel(x), -300, 300));
    // 광퇴색: 스윕 진행에 따라 단조 감소 (상행 끝과 하행 시작의 불연속을 만들지 않는다 —
    // 실제 광퇴색도 연속이며, 반환점 '이후'까지 누적되어 나타난다)
    const decay = 1 - s.bleach * (step / Math.max(total - 1, 1));
    const row = [];
    let fRealSum = 0;
    for (let r = 0; r < s.reps; r++) {
      const fd = dwellOcc(f);
      fRealSum += fd;
      const mu = (s.B + (1 - fd) * L + fd * H) * decay * (1 + s.a2 * rng.normal());
      row.push(pois(Math.max(mu * s.tau, 0)) / s.tau);
    }
    // **실현** occupancy — 이 스윕에서 실제로 일어난 dwell 평균의 반복 평균.
    // 공칭 f 는 앙상블 기댓값이고, 느린 점멸에서는 둘이 크게 다르다(f=0.056 인데
    // 5회 반복이 모두 꺼진 채로 나오는 일이 실제로 일어난다). 세기 자료는 실현값을
    // 담고 있으므로, occupancy 추정기를 채점할 때 비교 대상은 **실현값**이어야 한다.
    const fReal = fRealSum / s.reps;
    P.push(Math.pow(10, x)); Iraw.push(row);
    Wh.push(220 + 50 * (x - s.xlo) / Math.max(s.xhi - s.xlo, 1e-9));
    I.push(row.reduce((a, b) => a + b, 0) / row.length);
    truth.push({ x, dir, f, fReal, L, H, decay });
    step++;
  };
  for (let i = 0; i < s.n; i++) emit(s.xlo + (s.xhi - s.xlo) * i / (s.n - 1), "up");
  for (let i = s.n - 1; i >= 0; i--) emit(s.xlo + (s.xhi - s.xlo) * i / (s.n - 1), "down");
  const wid = (xs, w, nu) => {
    const zAt = (q) => { const t = Math.pow(q, -1 / nu) - 1; return t > 0 ? -Math.log(t) : NaN; };
    return w * (zAt(0.9) - zAt(0.1));
  };
  return {
    trace: { P, I, Iraw, W: Wh, acqTime: s.tau, counting: true },
    truth: {
      fUp: truth.filter((t) => t.dir === "up").map((t) => ({ x: t.x, P: Math.pow(10, t.x), f: t.f, fReal: t.fReal })),
      fDn: truth.filter((t) => t.dir === "down").map((t) => ({ x: t.x, P: Math.pow(10, t.x), f: t.f, fReal: t.fReal })),
      pSwitchUp: Math.pow(10, bsHalfX({ xs: s.xsUp, w: s.wUp, nu: s.nuUp })),
      pSwitchDn: Math.pow(10, bsHalfX({ xs: s.xsDn, w: s.wDn, nu: s.nuDn })),
      width1090Up: wid(s.xsUp, s.wUp, s.nuUp), width1090Dn: wid(s.xsDn, s.wDn, s.nuDn),
      nLow: s.nL, nHigh: s.nH, B: s.B, bleach: s.bleach, params: s,
      hiShape: s.hiShape, hiLevel,
    },
  };
}

/* ==================== PA standard layer (paper: pa_universal v2) ============
 * Port of the two-scale decomposition from the standardization-paper package
 * (pa_universal.py, validated on 38 expert-valued scans, log-corr 0.990):
 *  - HIGH-STATE envelope: ANP emission is bistable near threshold; replicate
 *    reads at one setpoint split into low/high states. The mean of a mixture
 *    is not a physical point on the PA branch — the high state (max per
 *    setpoint) is. Used as the PA-standard aggregation.
 *  - near-duplicate power merge (effective replicates, not real steps),
 *  - dark D + Poisson SNR gate,
 *  - UNRESOLVED-JUMP term: a converged smooth fit provably shaves a 1-step
 *    dark→signal jump (penalty ∝ J/h vs misfit ∝ h), so grid-limited fronts
 *    (expert PA 150–312+) need a dedicated finite-step estimator with
 *    foot-in-dark-band, landing-above-gate, persistence, and ≥JUMP_DECADES
 *    raw-rise gates. Reported PA = max(resolved s_max, S_jump), with the
 *    grid-limited lower-bound flag when the jump dominates.
 * Constants identical to the paper package (calibrated on the 38-file corpus).
 * ========================================================================== */
const PA_CONST = { MERGE_FRAC: 0.25, DARK_FRAC: 0.25, KAPPA: 8.0, JUMP_DECADES: 0.5, JUMP_DOMINANCE: 2.0 };

/** Upper (high-state) branch: max intensity per nominal setpoint, sorted by median power. */
function paHighState(P, I, W) {
  const groups = new Map();
  for (let i = 0; i < P.length; i++) {
    if (!isFinite(P[i]) || !isFinite(I[i]) || !isFinite(W[i])) continue;
    const k = W[i];
    if (!groups.has(k)) groups.set(k, { Ps: [], Imax: -Infinity, arg: -1, n: 0 });
    const g = groups.get(k);
    g.Ps.push(P[i]);
    g.n++;
    if (I[i] > g.Imax) { g.Imax = I[i]; g.arg = i; }   // v2.6: 승자 원본 인덱스 추적
  }
  const rows = [];
  for (const g of groups.values()) rows.push([median(g.Ps), g.Imax, g.arg, g.n]);
  rows.sort((a, b) => a[0] - b[0]);
  return { Ps: rows.map((r) => r[0]), Ih: rows.map((r) => r[1]),
           src: rows.map((r) => r[2]), nAgg: rows.map((r) => r[3]) };
}
/** Merge consecutive setpoints whose log-power gap < frac × median gap. */
function paMergeClose(x, I, frac, src, nAgg) {
  if (!x.length) return { x: [], I: [], src: [], nAgg: [] };
  const dx = [];
  for (let i = 1; i < x.length; i++) if (x[i] - x[i - 1] > 0) dx.push(x[i] - x[i - 1]);
  const md = dx.length ? median(dx) : 1.0;
  const thr = frac * md;
  const at = (a, i, d) => (a && a[i] !== undefined ? a[i] : d);
  const xs = [x[0]], Is = [I[0]], ss = [at(src, 0, -1)], ns = [at(nAgg, 0, 1)];
  for (let i = 1; i < x.length; i++) {
    const last = xs.length - 1;
    if (x[i] - xs[last] < thr) {
      ns[last] += at(nAgg, i, 1);
      if (I[i] > Is[last]) { Is[last] = I[i]; ss[last] = at(src, i, -1); }  // 승자 갱신 시 출처도 갱신
      xs[last] = 0.5 * (xs[last] + x[i]);
    } else { xs.push(x[i]); Is.push(I[i]); ss.push(at(src, i, -1)); ns.push(at(nAgg, i, 1)); }
  }
  return { x: xs, I: Is, src: ss, nAgg: ns };
}
/* ---------------------------------------------------------------------------
 * model-free s_max lower bound — secant(secant) 기울기
 *
 * 평균값 정리: 미분 가능한 s 에 대해 임의의 두 점 i<j 에서
 *     (log10 I_j − log10 I_i) / (x_j − x_i)  ≤  max_{[x_i,x_j]} s(x)
 * 즉 **어떤 secant 기울기도 s_max 의 lower bound**이다. 모델도, 매끄러움 가정도 필요 없다.
 * 이것이 "격자가 전이를 분해하지 못할 때 무엇을 말할 수 있는가"의 정답이다 —
 * point estimate는 불가능하지만 lower bound는 언제나 가능하다.
 *
 * 잡음 처리: I 는 관측값이므로 아래쪽 점이 우연히 낮게 튀면 secant가 부풀려진다.
 * 그래서 상승량에서 **Z·σ 만큼을 먼저 깎는다**(단측 신뢰lower bound). 깎고도 남는 것만
 * lower bound로 쓴다 — 잡음으로 부풀릴 수 없고, 참값을 넘을 확률은 Z 로 통제된다.
 * 배경 평탄부의 무의미한 비(114→190 같은)는 σ 가 커서 자동으로 걸러진다.
 *
 * 원시(raw) I 를 쓴다 — paJumpOnTrace 와 같은 관례이며, 배경을 빼면 뺀 값의
 * 불확실도가 다시 들어와 lower bound가 lower bound가 아니게 될 수 있다.
 */
function secantSlopeLowerBound(x, I, sigI, opts) {
  const o = opts || {};
  const Z = isFinite(o.z) ? o.z : 3;
  const n = x.length;
  if (n < 3) return null;
  const LN10 = Math.LN10;
  // v3.8 — 암준위 차감(선택). 차감하면 s_signal 을 직접 겨냥하므로 lower bound가 조여진다.
  // 차감량의 불확실도 sigDark 도 여유에 함께 넣는다.
  const dark = isFinite(o.dark) && o.dark > 0 ? o.dark : 0;
  const sigDark = isFinite(o.sigDark) && o.sigDark > 0 ? o.sigDark : 0;
  const y = new Array(n), sy = new Array(n);
  for (let i = 0; i < n; i++) {
    const Ii = I[i] - dark;
    if (!isFinite(Ii) || Ii <= 0) { y[i] = NaN; sy[i] = NaN; continue; }
    y[i] = Math.log10(Ii);
    const s = isFinite(sigI[i]) && sigI[i] > 0 ? Math.sqrt(sigI[i] * sigI[i] + sigDark * sigDark) : NaN;
    sy[i] = isFinite(s) ? s / (Ii * LN10) : NaN;      // log10 공간 σ
  }
  let best = null;
  for (let i = 0; i < n - 1; i++) {
    if (!isFinite(y[i]) || !isFinite(sy[i])) continue;
    for (let j = i + 1; j < n; j++) {
      if (!isFinite(y[j]) || !isFinite(sy[j])) continue;
      const h = x[j] - x[i];
      if (!(h > 0)) continue;
      const rise = y[j] - y[i] - Z * Math.sqrt(sy[i] * sy[i] + sy[j] * sy[j]);
      if (!(rise > 0)) continue;
      const slope = rise / h;
      if (!best || slope > best.slope) {
        best = { slope, dlogP: h, iLo: i, iHi: j, pLo: Math.pow(10, x[i]), pHi: Math.pow(10, x[j]),
                 iLoValue: I[i], iHiValue: I[j], z: Z, dark, sigDark };
      }
    }
  }
  if (!best) return null;
  // 같은 lower bound를 주는 가장 **좁은** 구간을 함께 알려 준다 — "Δlog P 얼마에서 나온 lower bound인가"가
  // 물리적으로 의미 있는 정보이기 때문이다(요구사항 2).
  return best;
}

/* ---------------------------------------------------------------------------
 * 암준위(검출기 dark count) 추정과 **평탄성 검정** — v3.8
 *
 * 왜 필요한가: s = Δlog10 I / Δlog10 P 인데 I = D + S 이므로
 *     d log10 I/dx = [S/(D+S)] · d log10 S/dx = f_S · s_signal ,  f_S < 1
 * 즉 **관측 기울기는 신호 기울기보다 항상 작다**. 점화 직전에는 S ~ D 라 f_S ≈ 0.5,
 * 기울기가 절반으로 눌린다. D 는 검출기 암계수(기기 artifact)이지 신호가 아니므로
 * 빼는 것이 맞다.
 *
 * 그런데 **과다 차감은 위험하다**: I_i − D 에서 D 가 크면 낮은 점이 0 에 가까워져
 * log 비가 폭발하고, lower bound가 참값을 넘을 수 있다(합성에서 실제로 발생). 반대로 과소
 * 차감은 lower bound를 약하게 할 뿐이다. 그래서 두 겹으로 보수적으로 간다.
 *   (1) 암평탄부가 **평탄하지 않으면 아예 빼지 않는다.** 전-사태 발광이 이미 오르고
 *       있는 자료(완만한 전이)에서는 '상수 바닥'이 원리적으로 정의되지 않는다.
 *   (2) 평탄해도 D̂ − 3σ 로 **일부러 덜 뺀다.**
 * 합성 검증: 차감 후 lower bound가 참 s_signal 을 넘은 건수 0/15, lower bound는 1.09~1.56배 조여졌다.
 */
function darkFloor(x, I) {
  const n = x.length;
  if (n < 10) return null;
  const { D: D0, sig: sd0, gate } = paDarkAndGate(I);
  if (!isFinite(gate) || !(gate > 0)) return null;
  let iLit = -1;
  for (let i = 1; i < n - 1; i++) if (I[i] > gate && I[i + 1] > gate) { iLit = i; break; }
  const upTo = iLit > 0 ? iLit : n;
  const idx = [];
  for (let i = 0; i < upTo; i++) if (isFinite(I[i]) && I[i] <= gate) idx.push(i);
  if (idx.length < 6) return { D: D0, sd: sd0, flat: false, nDark: idx.length, gate, Dsub: 0, why: "암평탄부 점 부족" };
  const vals = idx.map((i) => I[i]);
  const xs = idx.map((i) => x[i]);
  const medOf = (a) => { const b = a.slice().sort((p2, q2) => p2 - q2);
    return b.length % 2 ? b[(b.length - 1) / 2] : 0.5 * (b[b.length / 2 - 1] + b[b.length / 2]); };
  const seOf = (a) => { const m = medOf(a); const mad = 1.4826 * medOf(a.map((v) => Math.abs(v - m)));
    return (mad > 0 ? mad : Math.sqrt(Math.max(m, 1))) / Math.sqrt(a.length); };
  const h = Math.floor(idx.length / 2);
  const lo = vals.slice(0, h), hi = vals.slice(h);
  const delta = medOf(hi) - medOf(lo);
  const sDelta = Math.sqrt(seOf(lo) * seOf(lo) + seOf(hi) * seOf(hi));
  const span = xs[xs.length - 1] - xs[0];
  const flat = Math.abs(delta) <= 3 * sDelta && span >= 0.10;
  const D = medOf(vals), sd = seOf(vals);
  return { D, sd, flat, delta, sDelta, span, nDark: idx.length, gate,
    Dsub: flat ? Math.max(0, D - 3 * sd) : 0,
    why: flat ? null : (span < 0.10 ? "암평탄부 구간이 0.10 dec 미만" : `암평탄부가 기울어 있음 (Δ=${(delta / sDelta).toFixed(1)}σ)`) };
}

/* ---------------------------------------------------------------------------
 * ignition bracket — 배경 평탄부에서 점등으로 넘어간 구간을 **관측으로만** 집는다.
 * 모델을 쓰지 않으므로, 모델이 낸 문턱이 이 구간 밖(저파워 쪽)에 있으면
 * 그것은 데이터와 모순이라는 것을 판정할 수 있다.
 * 완만한 전이에서는 "배경이 평탄하다가 갑자기 켜진다"는 조건 자체가 성립하지 않아
 * usable=false 로 물러난다 — 기존 동작을 건드리지 않기 위한 설계다.
 */
function ignitionBracket(x, I, opts) {
  const o = opts || {};
  const n = x.length;
  if (n < 10) return null;
  const { D, sig, gate } = paDarkAndGate(I);
  if (!isFinite(gate) || !(gate > 0)) return null;
  const lit = (i) => isFinite(I[i]) && I[i] > gate;
  // 첫 '점등' = 게이트를 넘고 다음 점에서도 넘어 있는 첫 점(지속성)
  let iLit = -1;
  for (let i = 1; i < n - 1; i++) if (lit(i) && lit(i + 1)) { iLit = i; break; }
  if (iLit <= 0) return null;
  // 그 앞의 마지막 배경점
  let iDark = -1;
  for (let i = iLit - 1; i >= 0; i--) if (isFinite(I[i]) && I[i] <= gate) { iDark = i; break; }
  if (iDark < 0) return null;
  // 배경 평탄부가 실재하는가 (최소 5점) · 점등부가 실재하는가 (게이트의 10배 이상까지)
  let nDark = 0;
  for (let i = 0; i <= iDark; i++) if (isFinite(I[i]) && I[i] <= gate) nDark++;
  let iMax = 0;
  for (let i = 0; i < n; i++) if (isFinite(I[i]) && I[i] > I[iMax]) iMax = i;
  const usable = nDark >= 5 && I[iMax] > 10 * gate && iMax > iLit;
  return {
    usable, D, sig, gate, nDark, iDark, iLit,
    pLo: Math.pow(10, x[iDark]), pHi: Math.pow(10, x[iLit]),
    pMid: Math.pow(10, 0.5 * (x[iDark] + x[iLit])),
    dlogP: x[iLit] - x[iDark],
  };
}

/* ---------------------------------------------------------------------------
 * 국소 점화 적합 — v3.8
 *
 * 왜: 전역 H 적합은 암평탄부(점 수십 개)·점화·멱법칙·포화를 한 벌의 꺾은선으로
 * 동시에 맞춰야 해서 점화를 넓게 퍼뜨린다(141c: 0.03 dec 점화를 0.33 dec 로).
 * PA 비선형성은 **전이의 국소 성질**이므로 그 구간만 스위치 모형으로 맞추는 편이 낫다.
 *
 * 순환을 피하기 위한 규칙:
 *  · 창은 **적합 전에 자료로만** 정한다 — 기울기가 큰 곳을 골라 창을 잡으면 선택 편향이
 *    그대로 추정치에 들어간다. 여기서는 관측 ignition bracket(암→점등)에서 고정 여유를 준다.
 *  · D 는 암평탄부에서, n_H 는 점화 위 멱법칙에서 **각각 따로** 고정한다.
 *  · 창 안에서 자유로운 것은 (A, x_s, w, ν) 네 개뿐이다.
 *
 *   S(x) = A · g^ν · 10^{n_H (x−x_s)},  g = [1+exp(−(x−x_s)/w)]^{−1}
 *   s_signal(x) = n_H + (ν/(w ln10))·(1−g)
 *
 * ν 를 **반드시 자유롭게 둔다**. 족 간 검증에서 ν=1 고정은 생성 모양이 다르면
 * 0.43~1.65배로 빗나갔고(과대 쪽으로도 빗나간다), ν 를 풀면 0.91~1.12배로 회복됐다.
 *
 * 그리고 **회복이 불가능한 영역이 있다**: 문턱 아래 꼬리가 지수보다 빨리 죽으면
 * (erf·경성 계단) 참 s_signal 자체가 유한하지 않다. 그 영역에서는 ν̂ 가 상자에 붙고
 * seed 간 spread가 폭발한다 — 그것을 감지해 **point estimate를 내지 않는다**.
 */
const LF_NU_MAX = 50, LF_NU_MIN = 0.02, LF_W_FLOOR = 5e-4;
function localIgnitionFit(x, I, sigI, ign, dk) {
  if (!ign || !ign.usable) return { usable: false, why: "ignition bracket 없음" };
  const D = dk && isFinite(dk.D) ? dk.D : ign.D;
  const { iDark, iLit } = ign;
  // n_H — 점화보다 0.15 dec 위의 멱법칙에서 따로 잰다
  const hi = [];
  for (let i = 0; i < x.length; i++) if (x[i] >= x[iLit] + 0.15 && I[i] - D > 0) hi.push(i);
  if (hi.length < 3) return { usable: false, why: "점화 위 멱법칙 구간이 3점 미만" };
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const i of hi) { const yy = Math.log10(I[i] - D); sx += x[i]; sy += yy; sxx += x[i] * x[i]; sxy += x[i] * yy; }
  const nH = (hi.length * sxy - sx * sy) / (hi.length * sxx - sx * sx);
  if (!isFinite(nH)) return { usable: false, why: "n_H 추정 실패" };
  // 창: 마지막 배경점 −0.05 dec ~ 첫 점등점 +0.15 dec (자료로만 정해진다)
  const win = [];
  for (let i = 0; i < x.length; i++) if (x[i] >= x[iDark] - 0.05 && x[i] <= x[iLit] + 0.15) win.push(i);
  if (win.length < 8) return { usable: false, why: `창 안 점이 ${win.length}개 (8개 필요)` };
  const LN10 = Math.LN10;
  const mk = (q) => ({ A: Math.exp(clamp(q[0], -50, 50)), xs: q[1],
    w: LF_W_FLOOR + Math.abs(q[2]), nu: clamp(Math.exp(clamp(q[3], -6, 6)), LF_NU_MIN, LF_NU_MAX) });
  const cost = (q) => {
    const p = mk(q); let c = 0;
    for (const i of win) {
      const z = (x[i] - p.xs) / p.w;
      const g = z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z));
      const mu = D + p.A * Math.pow(g, p.nu) * Math.pow(10, nH * (x[i] - p.xs));
      const Ii = Math.max(I[i], 1e-9);
      const sg = (isFinite(sigI[i]) && sigI[i] > 0 ? sigI[i] : Math.sqrt(Math.max(Ii, 1))) / (Ii * LN10);
      const r = (Math.log10(Ii) - Math.log10(Math.max(mu, 1e-12))) / sg;
      c += r * r;
    }
    return isFinite(c) ? c : 1e300;
  };
  const xs0 = 0.5 * (x[iDark] + x[iLit]);
  let best = null;
  // 시작점: 폭 3개 × 진폭 2개 × 모양 3개 = 18회. 48회(2200 iter)와 결과가 같고 3배 빠르다
  // (족 간 검증에서 회수율 동일). 비용이 288건 일괄 처리에서 직접 문제가 된다.
  for (const w0 of [0.002, 0.015, 0.08]) for (const A0 of [10, 500]) for (const nu0 of [0.3, 1, 3]) {
    const r = nelderMead(cost, [Math.log(A0), xs0, w0, Math.log(nu0)], [0.7, 0.03, w0 * 0.7, 0.6], 1800);
    if (!best || r.f < best.f) best = r;
  }
  const p = mk(best.q);
  const sMaxAt = (pp) => {
    let sm = -Infinity, xm = x[win[0]];
    for (let i = 0; i <= 400; i++) {
      const xx = x[win[0]] + (x[win[win.length - 1]] - x[win[0]]) * i / 400;
      const z = (xx - pp.xs) / pp.w;
      const g = z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z));
      const sv = nH + (pp.nu / (pp.w * LN10)) * (1 - g);
      if (sv > sm) { sm = sv; xm = xx; }
    }
    return { sMax: sm, at: Math.pow(10, xm) };
  };
  const r0 = sMaxAt(p);
  // ---- identifiability 판정 ----
  const nuAtBox = p.nu >= 0.95 * LF_NU_MAX || p.nu <= 1.05 * LF_NU_MIN;
  const wAtFloor = p.w <= 1.05 * LF_W_FLOOR;
  // ν 고정(=1) 해와 비교 — 모양이 자료로 정해졌는지의 직접 검사.
  // 크게 갈리면 '모양이 답을 정한 것'이므로 point estimate를 내지 않는다.
  let shapeRatio = NaN;
  {
    const cost1 = (q) => cost([q[0], q[1], q[2], 0]);
    let b1 = null;
    for (const w0 of [0.002, 0.02]) {
      const r = nelderMead(cost1, [Math.log(100), xs0, w0], [0.7, 0.03, w0 * 0.7], 1200);
      if (!b1 || r.f < b1.f) b1 = r;
    }
    const p1 = mk([b1.q[0], b1.q[1], b1.q[2], 0]);
    const s1 = sMaxAt(p1).sMax;
    shapeRatio = Math.max(r0.sMax, s1) / Math.max(Math.min(r0.sMax, s1), 1e-12);
  }
  const usable = !nuAtBox && !wAtFloor && isFinite(r0.sMax) && r0.sMax > 0 && shapeRatio <= 2.0;
  return {
    usable, sMax: r0.sMax, sMaxAtP: r0.at, xs: p.xs, w: p.w, nu: p.nu, nH, A: p.A,
    nWin: win.length, nHi: hi.length, chi2: best.f, D, shapeRatio, nuAtBox, wAtFloor,
    why: usable ? null
      : nuAtBox ? `모양 파라미터 ν 가 상자 경계(${p.nu.toFixed(2)}) — 문턱 아래 꼬리가 결정되지 않음`
      : wAtFloor ? "transition width가 lower bound에 붙음"
      : shapeRatio > 2.0 ? `모양 가정이 답을 좌우함 (ν 자유/고정 해가 ${shapeRatio.toFixed(1)}배 차이)`
      : "수치 실패",
  };
}
/** 결정론적 Nelder–Mead (국소 적합 전용 — 전역 탐색은 상위 층이 맡는다) */
function nelderMead(fn, q0, step, iters) {
  const n = q0.length;
  let S = [q0.slice()];
  for (let i = 0; i < n; i++) { const q = q0.slice(); q[i] += step[i]; S.push(q); }
  let fv = S.map(fn);
  for (let it = 0; it < iters; it++) {
    const o = fv.map((v, i) => i).sort((a, b) => fv[a] - fv[b]);
    S = o.map((i) => S[i]); fv = o.map((i) => fv[i]);
    const c = new Array(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) c[j] += S[i][j] / n;
    const r = c.map((cc, j) => cc + (cc - S[n][j])); const fr = fn(r);
    if (fr < fv[0]) { const e = c.map((cc, j) => cc + 2 * (cc - S[n][j])); const fe = fn(e);
      if (fe < fr) { S[n] = e; fv[n] = fe; } else { S[n] = r; fv[n] = fr; } }
    else if (fr < fv[n - 1]) { S[n] = r; fv[n] = fr; }
    else { const co = c.map((cc, j) => cc + 0.5 * (S[n][j] - cc)); const fc = fn(co);
      if (fc < fv[n]) { S[n] = co; fv[n] = fc; }
      else for (let i = 1; i <= n; i++) { S[i] = S[i].map((v, j) => S[0][j] + 0.5 * (v - S[0][j])); fv[i] = fn(S[i]); } }
  }
  const b = fv.map((v, i) => i).sort((a, b2) => fv[a] - fv[b2])[0];
  return { q: S[b], f: fv[b] };
}

/** 모델 문턱이 관측과 모순인가 — 주장한 문턱에서 그 뒤 m 점까지 모두 배경이면 모순이다.
 *  (완만한 전이에서는 참 문턱에서 이미 신호가 들려 있으므로 이 조건이 서지 않는다.) */
function thresholdContradicted(x, I, thrP, gate, m) {
  if (!isFinite(thrP) || !isFinite(gate)) return false;
  const xt = Math.log10(thrP);
  let iTh = -1;
  for (let i = 0; i < x.length; i++) if (x[i] <= xt) iTh = i;
  if (iTh < 0) return true;                       // 문턱이 측정범위보다 아래
  const need = isFinite(m) ? m : 2;
  let k = 0;
  for (let i = iTh; i < x.length && k <= need; i++, k++) {
    if (!(isFinite(I[i]) && I[i] <= gate)) return false;
  }
  return k > need;
}

function paDarkAndGate(Ih) {
  const ns = Math.max(3, Math.floor(PA_CONST.DARK_FRAC * Ih.length));
  const low = Ih.slice().sort((a, b) => a - b).slice(0, ns);
  const D = median(low);
  const m = low.reduce((s2, v) => s2 + v, 0) / low.length;
  const sig = Math.sqrt(low.reduce((s2, v) => s2 + (v - m) * (v - m), 0) / low.length) + 1e-9; // np.std ddof=0
  return { D, sig, gate: D + PA_CONST.KAPPA * sig };
}
/** Candidate traces for the jump term, best-first (ignition/up pass first). */
function paJumpCandidates(P, I, W, depth) {
  depth = depth === undefined ? 2 : depth;
  const idxs = [];
  for (let i = 0; i < P.length; i++) if (isFinite(P[i]) && isFinite(I[i]) && isFinite(W[i])) idxs.push(i);
  if (!idxs.length) return [[P, I, W]];
  let imax = idxs[0];
  for (const i of idxs) if (P[i] > P[imax]) imax = i;
  const cutSlice = (a, b) => [P.slice(a, b), I.slice(a, b), W.slice(a, b)];
  const okPart = (a, b) => {
    let nFin = 0;
    const uw = new Set();
    for (let i = a; i < b; i++) if (isFinite(P[i]) && isFinite(I[i]) && isFinite(W[i])) { nFin++; uw.add(W[i]); }
    return nFin >= 5 && uw.size >= 3;
  };
  const upOk = okPart(0, imax + 1), downOk = okPart(imax + 1, P.length);
  if (upOk && downOk) return [cutSlice(0, imax + 1), cutSlice(imax + 1, P.length)];
  if (!upOk && downOk && depth > 0) {
    const [P2, I2, W2] = cutSlice(imax + 1, P.length);
    return paJumpCandidates(P2, I2, W2, depth - 1);
  }
  return [[P, I, W]];
}
/* ============================================================================
 * v3.12 — PA 보고값 **중재(arbitration)** 를 한 곳에 모은다.
 *
 * 문제의 기원: 같은 양(PA)을 재는 추정기가 일곱 개로 늘었는데(파라메트릭 s_max,
 * 스플라인 s_tot, jump, secant 하한, 국소 S-curve, 프로파일 우도 floor,
 * bistable n_high — WJ-0075c 에서 21.9 ~ 580.6, 26배 범위), 그들 사이의 선택은
 * 손으로 짠 if/else 체인이었고 차트는 그 체인이 **이미 기각한** 추정기에서
 * 마커 위치를 가져왔다. 그래서 "최대 PA 위치" 가 베이스라인 시작점에 찍혔다.
 *
 * 규칙을 코드 한 곳에 명시하고, 차트·카드·CSV 가 **이 결과만** 읽게 한다.
 * 그러면 "그림과 카드가 서로 다른 것을 가리킴" 은 구조적으로 불가능해진다.
 *
 * 각 추정기는 스스로 무엇인지 선언한다:
 *   kind "bound"      — 참값이 이 값 **이상**이다 (부등식). 여럿이면 max 가 최선.
 *   kind "point"      — 점추정. 하한과 모순되면(하한보다 작으면) 탈락.
 *   kind "diagnostic" — 헤드라인 후보가 아니다. 이유와 함께 남긴다.
 * 그리고 자기 **위치**와 그 위치가 관측 가능한지도 같이 선언한다.
 * ========================================================================= */
function selectPA(est, ctx) {
  const cand = est.filter((e) => e && isFinite(e.value));
  const rejected = [];
  const keep = [];
  for (const e of cand) {
    if (e.kind === "diagnostic") { rejected.push({ name: e.name, value: e.value, why: e.why || "진단용 — 헤드라인 후보 아님" }); continue; }
    if (e.ok === false) { rejected.push({ name: e.name, value: e.value, why: e.why || "사용 조건 미충족" }); continue; }
    keep.push(e);
  }
  /* 하한끼리의 선택 — v3.12.1 정정.
   * 처음엔 "둘 다 하한이니 큰 쪽이 더 강한 진술" 로 두었는데 **틀렸다**. 그 규칙은
   * 두 하한이 똑같이 잘 정의되어 있을 때만 성립하고, 점화 근처의 확률적 스위칭이
   * 바로 그 전제를 깬다. WJ-0075c 에서 두 추정기가 **같은 점멸 점**(CV 76%)을
   * 앵커로 쓰는데, 그 점을 최솟값/평균/최댓값 중 무엇으로 두느냐에 따라
   *     jump   29.0 → 102.8 → 147.1
   *     secant 180.6 → 116.5 →  78.0
   * 으로 **순서가 뒤집힌다**. 크기 비교는 동전 던지기였다.
   *
   * 그래서 크기가 아니라 **구간이 무엇을 감싸는가** 로 고른다:
   *   · jump   구간 = 암 → 점등 — 물리적 전이를 **감싼다**
   *   · secant 구간 = 부분점등 → 완전점등 — 전이 **내부**이고, 아래 앵커가
   *     부분 점화 상태들의 평균이라 시스템이 실제로 존재한 적 없는 상태다.
   * 전이를 감싸는 구간이 PA 차수의 정의에 맞으므로 jump 를 우선한다. */
  const bounds = keep.filter((e) => e.kind === "bound");
  const brackets = bounds.filter((e) => e.bracketsTransition);
  let best = null;
  if (brackets.length) { for (const e of brackets) if (!best || e.value > best.value) best = e; }
  else { for (const e of bounds) if (!best || e.value > best.value) best = e; }
  for (const e of bounds) {
    if (e === best) continue;
    rejected.push({ name: e.name, value: e.value,
      why: (best && best.bracketsTransition && !e.bracketsTransition)
        ? `구간이 전이 내부(부분점등→완전점등)라 PA 차수의 정의에 맞지 않음 — 전이를 감싸는 ${best.name}=${best.value.toFixed(3)} 채택`
        : `더 강한 하한(${best.name} = ${best.value.toFixed(3)})에 밀림` });
  }
  const bound = best;
  // 점추정은 "하한과 모순되지 않을 때만" 살아남는다 — 하한이 더 강한 진술이기 때문.
  const points = [];
  for (const e of keep.filter((q) => q.kind === "point")) {
    if (bound && e.value < bound.value - 1e-9) {
      rejected.push({ name: e.name, value: e.value, why: `검증된 하한(${bound.value.toFixed(3)})보다 작아 모순 — 하한이 더 강한 진술` });
      continue;
    }
    points.push(e);
  }
  let winner = null, kind = "none";
  if (points.length) {
    winner = points.reduce((a, b) => (b.prefer || 0) > (a.prefer || 0) ? b : a);
    kind = "point";
    for (const e of points) if (e !== winner) rejected.push({ name: e.name, value: e.value, why: "우선순위 낮음" });
  } else if (bound) { winner = bound; kind = "bound"; }
  const notes = [];
  if (ctx && ctx.blinkAtIgnition) notes.push("점화 구간의 반복측정이 과분산 — 확률적 스위칭(blinking). 그 점의 평균은 재현되지 않는다");
  if (kind === "bound") notes.push("하한이다 — 상한은 없다. 전이가 표본 간격보다 좁으면 참값은 이 값 이상 어디든 가능하다");
  if (!cand.length) notes.push("사용 가능한 추정기가 없다");
  return {
    value: winner ? winner.value : NaN,
    kind, source: winner ? winner.name : null, basis: winner ? (winner.basis || null) : null,
    dlogP: winner && isFinite(winner.dlogP) ? winner.dlogP : null,
    location: winner && isFinite(winner.location) ? winner.location : NaN,
    locationKind: winner ? (winner.locationKind || null) : null,
    locationObservable: winner ? (winner.locationObservable !== false) : false,
    rejected, notes,
  };
}

function paJumpOnTrace(Pb, Ib, Wb) {
  const { Ps, Ih } = paHighState(Pb, Ib, Wb);
  if (Ps.length < 5) return null;
  const x0 = Ps.map((v) => Math.log10(Math.max(v, 1e-30)));
  const { x: xm, I: Im } = paMergeClose(x0, Ih, PA_CONST.MERGE_FRAC);
  const { D, sig, gate } = paDarkAndGate(Im);
  const footBand = D + 2.0 * PA_CONST.KAPPA * sig;
  let best = null;
  for (let i = 0; i < xm.length - 1; i++) {
    if (Im[i] <= 0 || Im[i] > footBand || Im[i + 1] <= gate || Im[i + 1] <= Im[i]) continue;
    // persistence: a real avalanche stays lit at the next setpoint
    if (i + 2 < xm.length && Im[i + 2] <= gate) continue;
    const h = xm[i + 1] - xm[i];
    if (h <= 0) continue;
    const rise = Math.log10(Im[i + 1]) - Math.log10(Im[i]); // RAW step (expert convention)
    if (rise < PA_CONST.JUMP_DECADES) continue;
    const slope = rise / h;
    if (!best || slope > best.slope) best = { slope, pth: Math.pow(10, 0.5 * (xm[i] + xm[i + 1])), dlogP: h };
  }
  return best;
}
function paJumpTerm(P, I, W) {
  for (const [Pb, Ib, Wb] of paJumpCandidates(P, I, W)) {
    const best = paJumpOnTrace(Pb, Ib, Wb);
    if (best) return best;
  }
  return null;
}
/** dark level of the merged whole-trace high-state envelope (report/diagnostic). */
function paDarkOf(P, I, W) {
  const { Ps, Ih } = paHighState(P, I, W);
  if (Ps.length < 5) return { D: NaN, n: Ps.length };
  const x0 = Ps.map((v) => Math.log10(Math.max(v, 1e-30)));
  const m = paMergeClose(x0, Ih, PA_CONST.MERGE_FRAC);
  return { D: paDarkAndGate(m.I).D, n: m.x.length };
}
/**
 * High-state branch for the RESOLVED layer: per acquisition pass (up = prefix
 * to power max, down = suffix), take the high-state envelope. Returns a
 * branch object consumable by analyze() (no replicates: envelope points).
 */
function paHighStateBranch(P, I, W, pass, opts) {
  const idxs = [];
  for (let i = 0; i < P.length; i++) if (isFinite(P[i]) && isFinite(I[i]) && isFinite(W[i])) idxs.push(i);
  if (!idxs.length) throw new Error("no finite points for high-state branch");
  let imax = idxs[0];
  for (const i of idxs) if (P[i] > P[imax]) imax = i;
  let a = 0, b = P.length;
  if (pass === "up") b = imax + 1;
  else if (pass === "down") a = imax + 1;
  if (pass === "down" && P.length - a < 8) { a = 0; b = imax + 1; } // fall back to up
  const hs = paHighState(P.slice(a, b), I.slice(a, b), W.slice(a, b));
  const x0 = hs.Ps.map((v) => Math.log10(Math.max(v, 1e-30)));
  const m = paMergeClose(x0, hs.Ih, PA_CONST.MERGE_FRAC, hs.src, hs.nAgg);
  const Pm = m.x.map((v) => Math.pow(10, v));
  // v2.6 (E1): 원시 반복을 살려 보낸다. 이것이 없으면 노이즈 법칙을 측정할 수 없고
  // 엔진은 파일럿 residual 폴백으로 떨어져 a1(계수 통계 성분)을 0으로 몰아버린다.
  // src[j] 는 (a..b) 슬라이스 기준 인덱스이므로 +a 로 원본 좌표계로 되돌린다.
  const Iraw = opts && opts.Iraw ? opts.Iraw : null;
  const reps = Iraw ? m.src.map((j) => (j >= 0 && Iraw[j + a] ? Iraw[j + a].slice() : null)) : null;
  const hasReps = !!(reps && reps.some((r) => r && r.length >= 2));
  return {
    powerAvg: Pm, intensityAvg: m.I,
    powerStd: Pm.map(() => 0), intensityStd: m.I.map(() => 0),
    intensityReplicates: hasReps ? reps : null,
    aggApplied: m.nAgg.slice(),                       // 이 점이 몇 개 행의 max 인지
    aggEffective: m.nAgg.some((v) => v > 1) ? "max-of-N" : "none",
    acqTime: opts && isFinite(opts.acqTime) ? opts.acqTime : NaN,
    counting: !!(opts && opts.counting),
  };
}

/* =============================================================================
 * RiseFit — ANP rise-time (pulse-response) kinetics engine
 *
 * Physics context: a true photon avalanche is identified by (1) an excitation
 * threshold, (2) giant nonlinearity s(P), and (3) SLOW emission rise with
 * critical slowing down — τ_rise grows by orders of magnitude as P → P_th.
 * Near/above threshold the reduced PA rate equations (weak GSA seeding + CR
 * feedback loop) yield delayed-logistic population growth: an induction phase
 * (seed amplification at net gain rate r), a rapid S-transition, then
 * saturation. A single exponential CANNOT represent this; the induction delay
 * is the avalanche fingerprint.
 *
 * Design (mirrors PrismFit's dual-layer philosophy):
 *  A) MODEL-FREE metrics on a Poisson-weighted log-time-rebinned curve:
 *     t10/t50/t90, t10-90, t(1−1/e), integral time, overshoot, and the
 *     induction ratio ρ = t10/t90 (pure exponential → 0.046; delayed S-rise
 *     → 1). Reproducible, no model assumption — the primary report.
 *  B) PARAMETRIC cross-check, AICc + parsimony guard (simplest model within
 *     ΔAICc ≤ 4 of the best wins):
 *       single_exp      y0 + A(1−e^{−kt})                (non-avalanche / far above P_th)
 *       logistic_delay  y0 + A·(σ(r(t−tm))−σ(−r·tm))/(1−σ(−r·tm))
 *                       — the avalanche model; r = net loop gain rate [1/s],
 *                       tm = half-rise (induction) time; exact y(0)=y0 anchor
 *       double_exp      two-component rise (population intermediates)
 *       stretched_exp   ensemble heterogeneity (particle size/dopant spread)
 *       rise_relax      overshoot-then-settle (photodarkening interplay)
 *  C) Seeded FULL-PIPELINE Poisson parametric bootstrap for CIs (rebinning,
 *     model-free metrics, and model selection re-run per draw).
 * ========================================================================== */

function trapzArr(y, x) {
  let s = 0;
  for (let i = 1; i < x.length; i++) s += 0.5 * (y[i] + y[i - 1]) * (x[i] - x[i - 1]);
  return s;
}
function med3(a) {
  if (a.length < 3) return a.slice();
  const o = a.slice();
  for (let i = 1; i < a.length - 1; i++) {
    const x = a[i - 1], y = a[i], z = a[i + 1];
    o[i] = Math.max(Math.min(x, y), Math.min(Math.max(x, y), z));
  }
  return o;
}
/** Weighted isotonic (nondecreasing) regression — pool adjacent violators.
 *  Parameter-free monotone fit; robust crossings for noisy low-count traces. */
function pavaInc(y, w) {
  const n = y.length, val = [], wt = [], cnt = [];
  for (let i = 0; i < n; i++) {
    let v = y[i], ww = Math.max(w[i], 1e-12), c = 1;
    while (val.length && val[val.length - 1] > v) {
      const pv = val.pop(), pw = wt.pop(), pc = cnt.pop();
      v = (v * ww + pv * pw) / (ww + pw); ww += pw; c += pc;
    }
    val.push(v); wt.push(ww); cnt.push(c);
  }
  const out = new Array(n);
  let k = 0;
  for (let b = 0; b < val.length; b++) for (let i = 0; i < cnt[b]; i++) out[k++] = val[b];
  return out;
}

function poissonDraw(rng, lam) {
  if (!(lam > 0)) return 0;
  if (lam > 30) return Math.max(0, Math.round(lam + Math.sqrt(lam) * rng.normal()));
  const L = Math.exp(-lam);
  let k = 0, p = 1;
  do { k++; p *= rng.uniform(); } while (p > L);
  return k - 1;
}

/** Poisson-aware log-time rebinning (fine near t=0). t must start at 0. */
function riseLogRebin(t, c, nBins) {
  const T = [], C = [];
  for (let i = 0; i < t.length; i++) if (isFinite(t[i]) && isFinite(c[i])) { T.push(t[i]); C.push(c[i]); }
  if (T.length < 4) return { tb: T, cb: C, wb: C.map((v) => Math.max(v, 1)) };
  const tmax = T[T.length - 1];
  let tminPos = Infinity;
  for (const v of T) if (v > 0 && v < tminPos) tminPos = v;
  if (!isFinite(tminPos)) tminPos = tmax / nBins;
  const tmin = Math.max(tminPos, tmax / (50 * nBins));
  const edges = [0];
  const g = Math.pow(tmax / tmin, 1 / (nBins - 1));
  for (let i = 0; i < nBins; i++) edges.push(tmin * Math.pow(g, i));
  const tb = [], cb = [], wb = [], nb = [];
  let j = 0;
  const lastK = edges.length - 2;
  for (let k = 0; k <= lastK; k++) {
    let s = 0, cnt = 0, tot = 0;
    while (j < T.length && (T[j] < edges[k + 1] || k === lastK)) {
      if (T[j] >= edges[k]) { s += C[j]; cnt++; tot += Math.max(C[j], 0); }
      j++;
    }
    if (cnt > 0) { tb.push(0.5 * (edges[k] + edges[k + 1])); cb.push(s / cnt); wb.push(tot); nb.push(cnt); }
  }
  return { tb, cb, wb, nb };
}

const RISE_MODELS = {
  single_exp: {
    k: 3, names: ["y0", "A", "k"],
    f: (p, t) => p[0] + p[1] * (1 - Math.exp(-Math.exp(p[2]) * t)),
    raw: (p) => ({ y0: p[0], A: p[1], k: Math.exp(p[2]), tau: 1 / Math.exp(p[2]) }),
  },
  logistic_delay: {
    k: 4, names: ["y0", "A", "r", "tm"],
    f: (p, t) => {
      const r = Math.exp(p[2]), tm = Math.exp(p[3]);
      const s0 = sigmoid(-r * tm);
      return p[0] + p[1] * (sigmoid(r * (t - tm)) - s0) / (1 - s0);
    },
    raw: (p) => ({ y0: p[0], A: p[1], r: Math.exp(p[2]), tm: Math.exp(p[3]) }),
  },
  double_exp: {
    k: 5, names: ["y0", "A1", "k1", "A2", "k2"],
    f: (p, t) => p[0] + p[1] * (1 - Math.exp(-Math.exp(p[2]) * t)) + p[3] * (1 - Math.exp(-Math.exp(p[4]) * t)),
    raw: (p) => ({ y0: p[0], A1: p[1], tau1: 1 / Math.exp(p[2]), A2: p[3], tau2: 1 / Math.exp(p[4]) }),
  },
  stretched_exp: {
    k: 4, names: ["y0", "A", "k", "beta"],
    f: (p, t) => p[0] + p[1] * (1 - Math.exp(-Math.pow(Math.max(Math.exp(p[2]) * t, 0), clamp(p[3], 0.2, 2.5)))),
    raw: (p) => ({ y0: p[0], A: p[1], tau: 1 / Math.exp(p[2]), beta: clamp(p[3], 0.2, 2.5) }),
  },
  rise_relax: {
    k: 5, names: ["y0", "A", "kr", "B", "kd"],
    f: (p, t) => p[0] + p[1] * (1 - Math.exp(-Math.exp(p[2]) * t)) - p[3] * (1 - Math.exp(-Math.exp(p[4]) * t)),
    raw: (p) => ({ y0: p[0], A: p[1], tauR: 1 / Math.exp(p[2]), B: p[3], tauD: 1 / Math.exp(p[4]) }),
  },
  exp_decay: {
    k: 3, names: ["yf", "A", "k"],
    f: (p, t) => p[0] + p[1] * Math.exp(-Math.exp(p[2]) * t),
    raw: (p) => ({ yf: p[0], A: p[1], tau: 1 / Math.exp(p[2]) }),
  },
  double_decay: {
    k: 5, names: ["yf", "A1", "k1", "A2", "k2"],
    f: (p, t) => p[0] + p[1] * Math.exp(-Math.exp(p[2]) * t) + p[3] * Math.exp(-Math.exp(p[4]) * t),
    raw: (p) => ({ yf: p[0], A1: p[1], tau1: 1 / Math.exp(p[2]), A2: p[3], tau2: 1 / Math.exp(p[4]) }),
  },
  stretched_decay: { // KWW — heterogeneous ensembles (photodarkening standard)
    k: 4, names: ["yf", "A", "k", "beta"],
    f: (p, t) => p[0] + p[1] * Math.exp(-Math.pow(Math.max(Math.exp(p[2]) * t, 0), clamp(p[3], 0.2, 2.5))),
    raw: (p) => ({ yf: p[0], A: p[1], tau: 1 / Math.exp(p[2]), beta: clamp(p[3], 0.2, 2.5) }),
  },
};

function riseAICc(rss, n, k) {
  if (n <= k + 1 || !(rss > 0)) return Infinity;
  return n * Math.log(rss / n) + 2 * k + (2 * k * (k + 1)) / (n - k - 1);
}

/** Fit one candidate model on binned data with inverse-variance Poisson
 *  weights (Var[bin mean] = λ/n → w = n/max(λref, 0.5), λref from the
 *  model-free isotonic reference — NOT the noisy data); multi-start. */
function riseFitModel(key, tb, cb, nb, lamRef, starts, boundsFn) {
  const M = RISE_MODELS[key];
  const wInv = cb.map((_, i) => Math.max(nb[i], 1e-12) / Math.max(lamRef[i], 0.5));
  const wm = mean(wInv) || 1;
  const sw = wInv.map((w) => Math.sqrt(w / wm));
  const residFn = (p) => tb.map((t, i) => (cb[i] - M.f(p, t)) * sw[i]);
  let best = null;
  const { lo, hi } = boundsFn(M);
  for (const p0 of starts) {
    const res = lm(residFn, p0, lo, hi, { maxIter: 300, ftol: 1e-12 });
    if (isFinite(res.cost) && (!best || res.cost < best.cost)) best = res;
  }
  if (!best) return null;
  const n = tb.length;
  const aicc = riseAICc(best.cost, n, M.k);
  // parameter SE via JᵀJ at optimum
  let se = null;
  try {
    const r0 = residFn(best.theta);
    const J = [];
    for (let j = 0; j < M.k; j++) {
      const h = Math.max(Math.abs(best.theta[j]) * 1e-6, 1e-8);
      const tp = best.theta.slice(); tp[j] += h;
      const r1 = residFn(tp);
      J.push(r1.map((v, i) => (v - r0[i]) / h));
    }
    const JTJ = [];
    for (let a = 0; a < M.k; a++) { JTJ.push(new Array(M.k)); for (let b = 0; b < M.k; b++) { let s = 0; for (let i = 0; i < n; i++) s += J[a][i] * J[b][i]; JTJ[a][b] = s; } }
    const C = invSym(JTJ);
    if (C) {
      const s2 = best.cost / Math.max(n - M.k, 1);
      se = C.map((row, i) => Math.sqrt(Math.max(row[i] * s2, 0)));
    }
  } catch (e) { /* SE unavailable */ }
  return { key, theta: best.theta, cost: best.cost, aicc, k: M.k, se, raw: M.raw(best.theta) };
}

/** Analyze one edge (rise or decay). t is shifted so the edge is at t=0. */
function riseAnalyzeEdge(tArr, cArr, kind, baseline, baselineSD, opts) {
  const nBins = (opts && opts.nBins) || 160;
  const t = [], c = [];
  for (let i = 0; i < tArr.length; i++) if (isFinite(tArr[i]) && isFinite(cArr[i]) && tArr[i] >= 0) { t.push(tArr[i]); c.push(cArr[i]); }
  const out = { kind, ok: false, n: t.length, baseline, baselineSD, notes: [] };
  if (t.length < 12) { out.notes.push("포인트 부족 (<12)"); return out; }
  const tmax = t[t.length - 1];
  // steady state: robust level over the final 10% of the window
  const tail = [];
  for (let i = 0; i < t.length; i++) if (t[i] >= 0.9 * tmax) tail.push(c[i]);
  const steady = median(tail);
  const tailSD = mad(tail) || Math.sqrt(Math.max(Math.abs(steady), 1));
  const span = steady - baseline;
  out.steady = steady; out.span = span;
  const noise = Math.max(isFinite(baselineSD) ? baselineSD : 0, tailSD, 1e-12);
  if (!(Math.abs(span) > 4 * noise / Math.sqrt(Math.max(tail.length, 1)) && Math.abs(span) > 1e-12)) {
    out.notes.push(kind === "rise" ? "베이스라인 대비 유의한 상승 없음" : "유의한 감쇠 없음");
    return out;
  }
  // Poisson-aware log-time rebin
  const { tb, cb, wb, nb } = riseLogRebin(t, c, nBins);
  out.binned = { t: tb, c: cb, w: wb, n: nb };
  if (tb.length < 8) { out.notes.push("리비닝 후 포인트 부족"); return out; }
  const prog = cb.map((v) => (v - baseline) / span);
  const progSm = med3(prog);
  // overshoot detection (rise only) — SIGNIFICANCE-GATED so a low-count noise
  // peak cannot truncate the isotonic range (that produced NaN crossings)
  let pk = progSm.length - 1, overshoot = 0, peakT = NaN;
  if (kind === "rise") {
    let pkc = 0;
    for (let i = 1; i < progSm.length; i++) if (progSm[i] > progSm[pkc]) pkc = i;
    // significance from a POOLED window around the peak (t within ×/÷1.5),
    // not a single (possibly 1-sample) bin
    let sc = 0, sn = 0;
    for (let i = 0; i < tb.length; i++) {
      if (tb[i] >= tb[pkc] / 1.5 && tb[i] <= tb[pkc] * 1.5) { sc += cb[i] * nb[i]; sn += nb[i]; }
    }
    const poolMean = sn > 0 ? sc / sn : cb[pkc];
    const osPool = (poolMean - baseline) / span - 1;
    const sePool = Math.sqrt(Math.max(poolMean, 0.5) / Math.max(sn, 1)) / Math.abs(span);
    if (pkc < 0.9 * progSm.length && osPool > Math.max(0.03, 3 * sePool)) {
      pk = pkc; overshoot = Math.max(osPool, progSm[pkc] - 1); peakT = tb[pkc];
    }
  }
  // weighted isotonic regression up to the (significant) peak → robust crossings
  const wIso = prog.map((_, i) => Math.max(nb[i], 1e-12) / Math.max(cb[i], 0.5));
  const iso = pavaInc(prog.slice(0, pk + 1), wIso.slice(0, pk + 1));
  // model-free smooth reference λ(t) for fit weights: using λ̂ from the DATA
  // correlates weight with noise (down-fluctuations overweighted → biased-slow
  // fits); the isotonic reference removes that correlation.
  const lamRef = cb.map((v, i) => i < iso.length
    ? Math.max(baseline + iso[i] * span, 0.02)
    : Math.max(v, 0.5));
  const cross = (frac) => {
    for (let i = 0; i < iso.length; i++) {
      if (iso[i] >= frac) {
        if (i === 0) return tb[0];
        const f = (frac - iso[i - 1]) / Math.max(iso[i] - iso[i - 1], 1e-30);
        return tb[i - 1] + clamp(f, 0, 1) * (tb[i] - tb[i - 1]);
      }
    }
    return NaN;
  };
  const t10 = cross(0.10), t50 = cross(0.50), t90 = cross(0.90), t1e = cross(1 - 1 / Math.E);
  out.free = {
    t10, t50, t90, t1e,
    t1090: isFinite(t10) && isFinite(t90) ? t90 - t10 : NaN,
    induction: isFinite(t10) && isFinite(t90) && t90 > 0 ? t10 / t90 : NaN,
    tIntegral: trapzArr(iso.map((p) => 1 - clamp(p, 0, 1)), tb.slice(0, iso.length)),
  };
  if (kind === "rise") {
    out.free.overshoot = overshoot;
    out.free.peakT = peakT;
  }
  out.ok = true;
  // --- parametric candidates ---
  const A0 = span, tau0 = isFinite(t1e) && t1e > 0 ? t1e : tmax / 5;
  const dB = Math.max(isFinite(baselineSD) ? baselineSD : 0, 0.05 * Math.abs(span), 1e-9);
  const mkBounds = (M) => {
    const lo = [], hi = [];
    for (const nm of M.names) {
      if (nm === "y0") { lo.push(baseline - dB); hi.push(baseline + dB); }
      else if (nm === "yf") { lo.push(steady - Math.abs(span)); hi.push(steady + Math.abs(span)); }
      else if (nm === "beta") { lo.push(0.2); hi.push(2.5); }
      else if (nm === "tm") { lo.push(Math.log(Math.max(tmax / 1e5, 1e-9))); hi.push(Math.log(2 * tmax)); }
      else if (/^k/.test(nm) || nm === "r") { lo.push(Math.log(1 / (20 * tmax))); hi.push(Math.log(1e4 / Math.max(tau0, tmax / 1e4))); }
      else { lo.push(0); hi.push(5 * Math.abs(A0) + 10); } // amplitudes ≥ 0
    }
    return { lo, hi };
  };
  const lnk0 = Math.log(1 / tau0);
  const fits = [];
  const tryFit = (key, starts) => {
    const r = riseFitModel(key, tb, cb, nb, lamRef, starts, mkBounds);
    if (r) fits.push(r);
  };
  if (kind === "rise") {
    tryFit("single_exp", [[baseline, Math.abs(A0), lnk0], [baseline, Math.abs(A0), lnk0 + 1.5]]);
    const tm0 = isFinite(t50) && t50 > 0 ? t50 : tau0;
    const r0s = isFinite(out.free.t1090) && out.free.t1090 > 0 ? 4.4 / out.free.t1090 : 2 / tau0;
    tryFit("logistic_delay", [
      [baseline, Math.abs(A0), Math.log(r0s), Math.log(tm0)],
      [baseline, Math.abs(A0), Math.log(2 * r0s), Math.log(Math.max(tm0 / 3, tmax / 1e5))],
      [baseline, Math.abs(A0), Math.log(Math.max(r0s / 4, 1e-9)), Math.log(Math.min(2 * tm0, tmax))],
    ]);
    tryFit("double_exp", [
      [baseline, 0.6 * Math.abs(A0), lnk0, 0.4 * Math.abs(A0), lnk0 - Math.log(5)],
      [baseline, 0.5 * Math.abs(A0), lnk0 + Math.log(3), 0.5 * Math.abs(A0), lnk0 - Math.log(3)],
    ]);
    tryFit("stretched_exp", [[baseline, Math.abs(A0), lnk0, 1.0], [baseline, Math.abs(A0), lnk0, 0.6]]);
    if (out.free.overshoot > 0.03) {
      tryFit("rise_relax", [[baseline, (1 + out.free.overshoot) * Math.abs(A0), lnk0,
        out.free.overshoot * Math.abs(A0), lnk0 - Math.log(10)]]);
    }
  } else {
    tryFit("exp_decay", [[steady, Math.abs(span), lnk0], [steady, Math.abs(span), lnk0 + 1.5]]);
    tryFit("stretched_decay", [[steady, Math.abs(span), lnk0, 1.0], [steady, Math.abs(span), lnk0, 0.6]]);
    tryFit("double_decay", [
      [steady, 0.6 * Math.abs(span), lnk0, 0.4 * Math.abs(span), lnk0 - Math.log(5)],
    ]);
  }
  if (fits.length) {
    fits.sort((a, b) => a.k - b.k);
    let bestA = Infinity;
    for (const f of fits) if (f.aicc < bestA) bestA = f.aicc;
    let chosen = null;
    for (const f of fits) if (f.aicc <= bestA + 4) { chosen = f; break; } // simplest within guard
    out.aiccTable = fits.map((f) => ({ model: f.key, k: f.k, aicc: f.aicc, dAicc: f.aicc - bestA }));
    if (chosen) {
      const M = RISE_MODELS[chosen.key];
      // dense curve: log-spaced (fine near 0) + 0
      const td = [0];
      const dlo = Math.max(tmax / 2e4, 1e-9);
      const gg = Math.pow(tmax / dlo, 1 / 599);
      for (let i = 0; i < 600; i++) td.push(dlo * Math.pow(gg, i));
      const yd = td.map((tt) => M.f(chosen.theta, tt));
      // model-agnostic effective 1/e time of the FITTED curve
      let tauEff = NaN;
      const y0d = yd[0], yendd = yd[yd.length - 1], spand = yendd - y0d;
      if (Math.abs(spand) > 1e-12) {
        const target = y0d + (1 - 1 / Math.E) * spand;
        for (let i = 0; i < yd.length; i++) {
          if ((spand > 0 && yd[i] >= target) || (spand < 0 && yd[i] <= target)) { tauEff = td[i]; break; }
        }
      }
      // SEs on natural-scale params (delta method for log-params)
      const seNat = {};
      if (chosen.se) {
        M.names.forEach((nm, i) => {
          const v = chosen.theta[i], s = chosen.se[i];
          if (/^k/.test(nm) || nm === "r" || nm === "tm") seNat[nm] = Math.exp(v) * s;
          else seNat[nm] = s;
        });
      }
      out.fit = {
        model: chosen.key, k: chosen.k, aicc: chosen.aicc, params: chosen.raw, seNat,
        curveT: td, curveY: yd, tauEff,
      };
    }
  }
  return out;
}

/**
 * Top-level rise-time analysis.
 * input: {t, c, gateOnIdx, gateOffIdx, dtMedian} (from PrismH5.extractRiseTime;
 *        c may contain NaN from spike rejection)
 * opts:  {nBins}
 */
function riseAnalyze(input, opts) {
  const { t, c } = input;
  const o = opts || {};
  const notes = [];
  let onIdx = input.gateOnIdx, offIdx = input.gateOffIdx;
  if (onIdx == null) {
    onIdx = 0;
    notes.push("게이트 신호 없음 — 트레이스 시작을 상승 기점으로 가정");
  }
  // pre-pulse baseline
  let baseline, baselineSD;
  if (onIdx >= 3) {
    const pre = [];
    for (let i = Math.max(0, onIdx - 40); i < onIdx; i++) if (isFinite(c[i])) pre.push(c[i]);
    baseline = median(pre);
    baselineSD = mad(pre) || Math.sqrt(Math.max(baseline, 1));
  } else {
    const head = [];
    for (let i = 0; i < Math.max(5, Math.floor(0.02 * t.length)); i++) if (isFinite(c[i])) head.push(c[i]);
    baseline = median(head);
    baselineSD = mad(head) || Math.sqrt(Math.max(baseline, 1));
    notes.push("게이트 전 구간이 짧아 초기 샘플로 베이스라인 추정");
  }
  const tOn = t[onIdx];
  const end = offIdx != null ? offIdx : t.length;
  const tw = [], cw = [];
  for (let i = onIdx; i < end; i++) { tw.push(t[i] - tOn); cw.push(c[i]); }
  const rise = riseAnalyzeEdge(tw, cw, "rise", baseline, baselineSD, o);
  // temporal resolution censoring
  const dt = input.dtMedian;
  if (rise.ok && isFinite(dt) && isFinite(rise.free.t1e) && rise.free.t1e < 3 * dt) {
    rise.unresolvedFast = true;
    rise.notes.push(`상승이 시간 분해능(${(dt * 1e3).toPrecision(3)} ms/샘플)에 근접 — 보고값은 upper bound`);
  }
  // decay after gate-off
  let decay = null;
  if (!o.skipDecay && offIdx != null && t.length - offIdx >= 16) {
    const preOff = [];
    for (let i = Math.max(onIdx, offIdx - 40); i < offIdx; i++) if (isFinite(c[i])) preOff.push(c[i]);
    const onLevel = median(preOff);
    const onSD = mad(preOff) || Math.sqrt(Math.max(onLevel, 1));
    const tOff = t[offIdx];
    const td = [], cd = [];
    for (let i = offIdx; i < t.length; i++) { td.push(t[i] - tOff); cd.push(c[i]); }
    decay = riseAnalyzeEdge(td, cd, "decay", onLevel, onSD, o);
  }
  // --- avalanche verdict (직관성) ---
  let verdict = { klass: "none", text: "상승 미검출" };
  if (rise.ok) {
    const rho = rise.free.induction;
    const isLogistic = rise.fit && rise.fit.model === "logistic_delay";
    const strongDelay = isLogistic && rise.fit.params.r * rise.fit.params.tm > 2;
    if (rise.unresolvedFast) {
      verdict = { klass: "unresolved", text: "상승이 분해능보다 빠름 (τ upper bound만 보고) — 임계 위 멀리이거나 비-avalanche" };
    } else if (strongDelay || rho > 0.25) {
      verdict = { klass: "avalanche", text: "S자형 유도기 검출 — avalanche형 상승 (임계 근방 동작)" };
    } else if (rho >= 0 && rho < 0.12) {
      verdict = { klass: "exponential", text: "지수형 상승 — 비-avalanche 경로 또는 임계에서 먼 조건" };
    } else {
      verdict = { klass: "intermediate", text: "중간형 상승 — 임계 접근 중이거나 혼합 동역학" };
    }
  }
  return {
    engine: "RiseFit 1.0", nBins: (o.nBins || 160),
    gateOnT: onIdx != null && t[onIdx] != null ? t[onIdx] : NaN,
    gateOffT: offIdx != null ? t[offIdx] : NaN,
    dtMedian: dt, notes, rise, decay, verdict,
    nSpikes: input.spikes ? input.spikes.length : 0,
  };
}

/**
 * Seeded full-pipeline Poisson parametric bootstrap.
 * Resamples raw counts around the best available reference curve (chosen
 * model if any, else interpolated binned curve), re-runs the ENTIRE pipeline
 * (baseline, rebin, model-free, model selection) per draw.
 */
function riseBootstrap(input, analysis, bootOpts, onProgress) {
  const nBoot = (bootOpts && bootOpts.nBoot) || 200;
  const seed = (bootOpts && bootOpts.seed) || 20260810;
  const { t, c } = input;
  const r = analysis.rise;
  if (!r || !r.ok) return null;
  const onIdx = input.gateOnIdx != null ? input.gateOnIdx : 0;
  const offIdx = input.gateOffIdx != null ? input.gateOffIdx : t.length;
  const tOn = t[onIdx];
  // reference λ(t) for each raw sample
  const refAt = (tt) => {
    if (tt < 0) return Math.max(analysis.rise.baseline, 0.02);
    if (r.fit) {
      const M = RISE_MODELS[r.fit.model];
      // reconstruct theta from curve? keep closure: interpolate dense curve
      const T = r.fit.curveT, Y = r.fit.curveY;
      if (tt >= T[T.length - 1]) return Math.max(Y[Y.length - 1], 0.02);
      let lo = 0, hi = T.length - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (T[m] <= tt) lo = m; else hi = m; }
      const f = (tt - T[lo]) / Math.max(T[hi] - T[lo], 1e-30);
      return Math.max(Y[lo] + f * (Y[hi] - Y[lo]), 0.02);
    }
    const B = r.binned;
    let lo = 0, hi = B.t.length - 1;
    if (tt <= B.t[0]) return Math.max(B.c[0], 0.02);
    if (tt >= B.t[hi]) return Math.max(B.c[hi], 0.02);
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (B.t[m] <= tt) lo = m; else hi = m; }
    const f = (tt - B.t[lo]) / Math.max(B.t[hi] - B.t[lo], 1e-30);
    return Math.max(B.c[lo] + f * (B.c[hi] - B.c[lo]), 0.02);
  };
  const keys = ["t1090", "t1e", "t50", "tauEffFit", "r", "tm"];
  const draws = { t1090: [], t1e: [], t50: [], tauEffFit: [], r: [], tm: [] };
  let logisticCount = 0;
  for (let b = 0; b < nBoot; b++) {
    const rng = makeRng(seed + b * 7919);
    const cs = c.slice();
    for (let i = 0; i < Math.min(t.length, offIdx); i++) {
      if (!isFinite(c[i])) continue;
      const lam = i < onIdx ? Math.max(analysis.rise.baseline, 0.02) : refAt(t[i] - tOn);
      cs[i] = poissonDraw(rng, lam);
    }
    const a = riseAnalyze({ ...input, c: cs }, { nBins: analysis.nBins, skipDecay: true });
    if (a.rise && a.rise.ok) {
      draws.t1090.push(a.rise.free.t1090);
      draws.t1e.push(a.rise.free.t1e);
      draws.t50.push(a.rise.free.t50);
      if (a.rise.fit) {
        draws.tauEffFit.push(a.rise.fit.tauEff);
        if (a.rise.fit.model === "logistic_delay") {
          logisticCount++;
          draws.r.push(a.rise.fit.params.r);
          draws.tm.push(a.rise.fit.params.tm);
        }
      }
    }
    if (onProgress && (b + 1) % 20 === 0) onProgress((b + 1) / nBoot, `rise bootstrap ${b + 1}/${nBoot}`);
  }
  const ci = {};
  const est = {
    t1090: r.free.t1090, t1e: r.free.t1e, t50: r.free.t50,
    tauEffFit: r.fit ? r.fit.tauEff : NaN,
    r: r.fit && r.fit.model === "logistic_delay" ? r.fit.params.r : NaN,
    tm: r.fit && r.fit.model === "logistic_delay" ? r.fit.params.tm : NaN,
  };
  for (const k of keys) {
    const v = finite(draws[k]);
    if (v.length >= 20 && isFinite(est[k])) {
      // basic (reflected) CI, nonneg-clipped
      const lo = Math.max(2 * est[k] - quantile(v, 0.975), 0);
      const hi = Math.max(2 * est[k] - quantile(v, 0.025), 0);
      ci[k] = { lo, hi, sd: mad(v), nDraws: v.length };
    }
  }
  return { nBoot, seed, ci, modelStability: { logisticFrac: logisticCount / nBoot } };
}

/* =============================================================================
 * DarkenFit — ANP photodarkening analysis
 *
 * Physics context: under sustained excitation ANP emission can decay over
 * seconds–minutes (photodarkening: trap/color-center formation, charge
 * migration to surface quenchers). For avalanching particles this matters
 * three ways: (1) the giant nonlinearity AMPLIFIES any absorption/quenching
 * change, so darkening near threshold collapses emission disproportionately;
 * (2) darkening during a power scan corrupts s(P)/PA values (exposure-history
 * artifacts, up/down hysteresis) — the safe dwell/power budget must be known;
 * (3) applications need a photostability budget (loss %/time at operating
 * power) and the DARKENING ONSET POWER, whose position relative to P_th
 * discriminates mechanism (avalanche-population-driven vs direct multiphoton).
 *
 * Per-power trace analysis reuses the RiseFit edge machinery (isotonic
 * model-free crossings + AICc model selection incl. KWW stretched
 * exponential — the standard heterogeneous-ensemble darkening law).
 * Reported per trace: loss fraction, t50/t90 darkening half-time, τ_eff,
 * model + params, direction verdict (다크닝/브라이트닝/안정).
 * Summary: onset power (first significant loss), loss(P), τ(P).
 * ========================================================================== */
function darkenAnalyze(input, opts) {
  const o = opts || {};
  const nBins = o.nBins || 140;
  const out = { engine: "DarkenFit 1.0", perTrace: [], summary: null, acqTime: input.acqTime };
  for (const tr of input.traces) {
    const t = [], c = [];
    for (let i = 0; i < tr.t.length; i++) if (isFinite(tr.t[i]) && isFinite(tr.c[i])) { t.push(tr.t[i]); c.push(tr.c[i]); }
    const rec = { label: tr.label, P: tr.P, n: t.length, ok: false };
    out.perTrace.push(rec);
    if (t.length < 20) { rec.note = "포인트 부족"; continue; }
    const t0 = t[0];
    const ts = t.map((v) => v - t0);
    // robust initial level from the first 2% (≥5 samples)
    const nHead = Math.max(5, Math.floor(0.02 * ts.length));
    const head = c.slice(0, nHead);
    const I0 = median(head);
    const I0sd = mad(head) || Math.sqrt(Math.max(I0, 1));
    rec.I0 = I0;
    // direction pre-test → pick the edge family (decay models can't fit a
    // BRIGHTENING trace with nonneg amplitudes; use the rise family there)
    const tail0 = [];
    for (let i = Math.floor(0.9 * c.length); i < c.length; i++) tail0.push(c[i]);
    const kindGuess = median(tail0) < I0 ? "decay" : "rise";
    const edge = riseAnalyzeEdge(ts, c, kindGuess, I0, I0sd, { nBins });
    rec.Iend = edge.steady;
    rec.span = edge.span; // steady − I0 : negative → darkening
    rec.duration = ts[ts.length - 1];
    // I(0): the 2% head median UNDERESTIMATES fast decays, and KWW (β<0.5)
    // extrapolation to t=0 is singular/overestimates. Honest choice: the
    // MEASURED initial level — median of the first 3 samples (counts are
    // large → relative noise ≲0.5%), taking whichever of {first-3, head}
    // lies further in the pre-transition direction.
    const m3 = median(c.slice(0, 3));
    const I0eff = edge.span < 0 ? Math.max(m3, I0) : Math.min(m3, I0);
    rec.I0eff = I0eff;
    rec.loss = isFinite(edge.steady) && I0eff > 0 ? 1 - edge.steady / I0eff : NaN;
    if (!edge.ok) {
      rec.verdict = "stable";
      rec.note = "유의한 변화 없음";
      rec.ok = true;
      continue;
    }
    rec.ok = true;
    rec.verdict = edge.span < 0 ? "darkening" : "brightening";
    rec.free = edge.free;          // t10/t50/t90/t1e (진행도 기준), induction 등
    rec.fit = edge.fit || null;    // model, params, tauEff, curve
    rec.aiccTable = edge.aiccTable || null;
    // model-free initial rate: fractional loss per second over the first
    // decile of the transition (robust, from isotonic crossings)
    if (edge.free && isFinite(edge.free.t10) && edge.free.t10 > 0) {
      rec.initRate = 0.1 * Math.abs(I0eff - edge.steady) / I0eff / edge.free.t10; // frac/s
    }
  }
  // ---- summary over powers ----
  const sig = out.perTrace.filter((r) => r.ok && r.verdict !== "stable");
  const dark = sig.filter((r) => r.verdict === "darkening");
  let onset = null;
  for (const r of out.perTrace) { // first significant DARKENING by power order
    if (r.verdict === "darkening") { onset = r; break; }
  }
  let worst = null;
  for (const r of dark) if (!worst || r.loss > worst.loss) worst = r;
  out.summary = {
    nTraces: out.perTrace.length,
    nDark: dark.length,
    nBright: sig.length - dark.length,
    onsetP: onset ? onset.P : NaN,
    maxLoss: worst ? worst.loss : 0,
    maxLossP: worst ? worst.P : NaN,
    maxLossT50: worst && worst.free ? worst.free.t50 : NaN,
    maxLossTauEff: worst && worst.fit ? worst.fit.tauEff : NaN,
  };
  return out;
}

/* =============================================================================
 * SegPA 1.0 — globally optimal piecewise power-law segmentation (v3.18)
 *
 * Reference implementation: tests/segpa_proto/segpa.py (validated 2026-09-27 on
 * synthetic grids, 288 up/down scans, the 22-row manual sheet and a 40-case blind
 * judgement by the researcher). This port must stay numerically identical to it;
 * tests/test_segpa_parity.mjs checks that on every branch of the 288 corpus.
 *
 *  1. log10 I vs log10 P is split into K straight segments by exact dynamic
 *     programming — the global optimum over every breakpoint placement, so there
 *     are no local minima. K ≤ K_BIC.
 *  2. Between segments a "bridge" (one sampling interval, raw two-point secant)
 *     carries a 1-jump. Mean-value theorem: a secant never exceeds the true
 *     maximum slope, so a bridge value is a valid LOWER BOUND.
 *  3. A regime is a significant peak of the slope chain: above both valleys by
 *     z·σ, ≥ min_ratio× and ≥ +min_prom over the pre-regime power law, rising
 *     ≥ min_rise decades and staying lit. Candidates are collected over every
 *     scale K ≤ K_BIC (a stochastic-switching staircase becomes one ruler at a
 *     coarser scale); overlapping candidates keep the best slope lower bound.
 *  4. Reported per regime: Ith bracket (last pre-regime point ↔ first point
 *     clearly above it), headline PA (steepest defensible element; "≥" when it is
 *     a bridge or two points), class (PA if headline ≥ T_class = 5, else S-bend
 *     — researcher's decision 2026-09-27), and the auxiliary MAIN-RISE slope: the
 *     steepest straight window that carries ≥ 0.7 decades of rise — what a
 *     researcher reads when a single jump sits inside a longer steep rise.
 * ========================================================================== */
const SEGPA_VERSION = "1.0.0";
const SEGPA_DEFAULTS = { z: 2.0, minRise: 0.3, minProm: 3.0, minRatio: 2.0, TClass: 5.0, mainD: 0.7, mainExt: 0.15, Kmax: 9 };

function sp_median(a) {
  const b = a.filter((v) => !Number.isNaN(v)).slice().sort((p, q) => p - q);
  const n = b.length; if (!n) return NaN;
  return n % 2 ? b[(n - 1) / 2] : 0.5 * (b[n / 2 - 1] + b[n / 2]);
}
function sp_ls(x, y, i, j) {           // unweighted least-squares slope on points i..j
  let sx = 0, sy = 0; const n = j - i + 1;
  for (let k = i; k <= j; k++) { sx += x[k]; sy += y[k]; }
  const mx = sx / n, my = sy / n; let sxx = 0, sxy = 0;
  for (let k = i; k <= j; k++) { sxx += (x[k] - mx) * (x[k] - mx); sxy += (x[k] - mx) * (y[k] - my); }
  return sxy / sxx;
}
function sp_wfit(xs, ys, ws) {         // weighted LS line (weights on squared residuals): {a, b}
  let S = 0, Sx = 0, Sy = 0, Sxx = 0, Sxy = 0;
  for (let k = 0; k < xs.length; k++) { const w = ws[k]; S += w; Sx += w * xs[k]; Sy += w * ys[k]; Sxx += w * xs[k] * xs[k]; Sxy += w * xs[k] * ys[k]; }
  const D = S * Sxx - Sx * Sx; const b = (S * Sxy - Sx * Sy) / D; return { a: (Sy - b * Sx) / S, b };
}

/** P + either reps (n × r) or I with standard error se. Sort, merge near-duplicate setpoints. */
function segPrep(P, reps, I, se) {
  const n0 = P.length; let m = new Array(n0), s = new Array(n0);
  if (reps) {
    const sd = new Array(n0), nr = new Array(n0);
    for (let i = 0; i < n0; i++) {
      const r = (reps[i] || []).filter((v) => Number.isFinite(v)); nr[i] = r.length;
      const mu = r.length ? r.reduce((a, v) => a + v, 0) / r.length : NaN; m[i] = mu;
      if (r.length > 1) { let q = 0; for (const v of r) q += (v - mu) * (v - mu); sd[i] = Math.sqrt(q / (r.length - 1)); }
      else sd[i] = Math.sqrt(Math.max(mu, 1));
    }
    const a = sp_median(sd.map((v, i) => v * v / Math.max(m[i], 1)));
    for (let i = 0; i < n0; i++) s[i] = Math.sqrt(Math.max(sd[i] * sd[i], a * Math.max(m[i], 1))) / Math.sqrt(Math.max(nr[i], 1));
  } else { m = Array.from(I, Number); s = Array.from(se, Number); }
  let idx = []; for (let i = 0; i < n0; i++) idx.push(i);
  idx.sort((p, q) => P[p] - P[q]);
  idx = idx.filter((i) => Number.isFinite(P[i]) && P[i] > 0 && Number.isFinite(m[i]));
  let Ps = idx.map((i) => P[i]), ms = idx.map((i) => m[i]), ss = idx.map((i) => s[i]);
  const xx = Ps.map((v) => Math.log10(v));
  const gaps = []; for (let k = 1; k < xx.length; k++) { const g = xx[k] - xx[k - 1]; if (g > 0) gaps.push(g); }
  const md = gaps.length ? sp_median(gaps) : 1.0;
  const Pm = [Ps[0]], mm = [ms[0]], sm = [ss[0]]; const grp = [[0]];
  for (let k = 1; k < Ps.length; k++) {
    if (xx[k] - Math.log10(Pm[Pm.length - 1]) < 0.25 * md) {
      const g = grp[grp.length - 1]; g.push(k);
      let W = 0, Wm = 0, lx = 0;
      for (const q of g) { const w = 1 / Math.pow(Math.max(ss[q], 1e-12), 2); W += w; Wm += w * ms[q]; lx += xx[q]; }
      Pm[Pm.length - 1] = Math.pow(10, lx / g.length); mm[mm.length - 1] = Wm / W; sm[sm.length - 1] = 1 / Math.sqrt(W);
    } else { Pm.push(Ps[k]); mm.push(ms[k]); sm.push(ss[k]); grp.push([k]); }
  }
  const x = [], y = [], sy = [];
  for (let k = 0; k < Pm.length; k++) {
    const Ipos = Math.max(mm[k], Math.max(sm[k], 1e-9));
    x.push(Math.log10(Pm[k])); y.push(Math.log10(Ipos)); sy.push(Math.max(sm[k] / (Ipos * Math.LN10), 1e-4));
  }
  return { x, y, sy, m: mm, se: sm };
}

function segSegment(x, y, sy, Kmax, Kforce) {
  const n = x.length, minlen = 2;
  const pf = { S: [0], Sx: [0], Sy: [0], Sxx: [0], Sxy: [0], Syy: [0] };
  for (let i = 0; i < n; i++) {
    const w = 1 / (sy[i] * sy[i]);
    pf.S.push(pf.S[i] + w); pf.Sx.push(pf.Sx[i] + w * x[i]); pf.Sy.push(pf.Sy[i] + w * y[i]);
    pf.Sxx.push(pf.Sxx[i] + w * x[i] * x[i]); pf.Sxy.push(pf.Sxy[i] + w * x[i] * y[i]); pf.Syy.push(pf.Syy[i] + w * y[i] * y[i]);
  }
  const seg = (i, j) => {
    const g = (k) => pf[k][j + 1] - pf[k][i];
    const S = g("S"), Sx = g("Sx"), Sy = g("Sy"), Sxx = g("Sxx"), Sxy = g("Sxy"), Syy = g("Syy");
    const D = S * Sxx - Sx * Sx;
    if (D <= 1e-300) return { rss: 0, a: NaN, b: NaN, se: NaN };
    const b = (S * Sxy - Sx * Sy) / D, a = (Sy - b * Sx) / S;
    const rss = Math.max(Syy - 2 * a * Sy - 2 * b * Sxy + a * a * S + 2 * a * b * Sx + b * b * Sxx, 0);
    return { rss, a, b, se: Math.sqrt(S / D) };
  };
  const C = []; for (let i = 0; i < n; i++) { C.push(new Float64Array(n).fill(Infinity)); for (let j = i + minlen - 1; j < n; j++) C[i][j] = seg(i, j).rss; }
  const F = [], arg = [];
  for (let k = 0; k <= Kmax; k++) { F.push(new Float64Array(n).fill(Infinity)); arg.push(new Int32Array(n)); }
  for (let j = 0; j < n; j++) F[1][j] = C[0][j];
  for (let k = 2; k <= Kmax; k++) {
    for (let j = 0; j < n; j++) {
      if (j === 0) { F[k][j] = Infinity; arg[k][j] = 1; continue; }
      let best = Infinity, bt = 0;
      for (let t = 0; t < j; t++) { const v = F[k - 1][t] + C[t + 1][j]; if (v < best) { best = v; bt = t; } }
      F[k][j] = best; arg[k][j] = bt + 1;
    }
  }
  const Kfeas = []; for (let k = 1; k <= Kmax; k++) if (Number.isFinite(F[k][n - 1])) Kfeas.push(k);
  const kf = Kfeas[Kfeas.length - 1];
  const phi = Math.max(F[kf][n - 1] / Math.max(n - (3 * kf - 1), 1), 1.0);
  let K = Kfeas[0], bestBic = Infinity;
  for (const k of Kfeas) { const b = F[k][n - 1] / phi + (3 * k - 1) * Math.log(n); if (b < bestBic) { bestBic = b; K = k; } }
  if (Kforce != null) K = Kforce;
  const cuts = []; { let j = n - 1, k = K; while (k > 1) { const s0 = arg[k][j]; cuts.push(s0); j = s0 - 1; k--; } }
  cuts.sort((p, q) => p - q);
  const starts = [0].concat(cuts), ends = starts.slice(1).map((v) => v - 1).concat([n - 1]);
  const segs = starts.map((i, q) => { const r = seg(i, ends[q]); return { i, j: ends[q], a: r.a, b: r.b, se: r.se * Math.sqrt(phi) }; });
  return { segs, phi, K };
}

function segMainRise(x, y, lo, hi, D) {
  const idx = []; for (let k = 0; k < x.length; k++) if (x[k] >= lo - 1e-9 && x[k] <= hi + 1e-9) idx.push(k);
  let best = null;
  for (let a = 0; a < idx.length; a++) {
    for (let b = a + 1; b < idx.length; b++) {
      const i = idx[a], j = idx[b];
      if (y[j] - y[i] >= D) {
        const sl = sp_ls(x, y, i, j);
        if (!best || sl > best.slope) best = { slope: sl, x0: x[i], x1: x[j], n: j - i + 1 };
        break;
      }
    }
  }
  return best;
}

/**
 * segPA(P, {reps} | {I, se}, opts) → {version, regimes:[...], dark, K, Kbic, tau, spikes, segs, x, y}
 * P in W. Each regime: {cls, kind, status, head, headLo, main, bracketW:[lo,hi], xThW, x0W, x1W, rise, …}
 */
function segPA(P, data, opts) {
  const o = Object.assign({}, SEGPA_DEFAULTS, opts || {});
  let { x, y, sy, m, se } = segPrep(P, data.reps || null, data.I, data.se);
  if (x.length < 8) throw new Error(`SegPA: 분석 가능한 점이 ${x.length}개 — 최소 8개 필요`);
  // isolated whole-setpoint excursions are not transitions
  const keep = x.map(() => true), spikes = [];
  for (let i = 1; i < x.length - 1; i++) {
    const d1 = y[i] - y[i - 1], d2 = y[i + 1] - y[i];
    const s_ = Math.sqrt(sy[i] * sy[i] + 0.5 * (sy[i - 1] * sy[i - 1] + sy[i + 1] * sy[i + 1]));
    const dev = y[i] - 0.5 * (y[i - 1] + y[i + 1]);
    if (Math.sign(d1) !== Math.sign(d2) && Math.abs(dev) > 6 * s_ && Math.abs(y[i + 1] - y[i - 1]) < Math.abs(dev) / 3) { keep[i] = false; spikes.push(x[i]); }
  }
  const sel = (arr) => arr.filter((_, i) => keep[i]);
  x = sel(x); y = sel(y); sy = sel(sy); m = sel(m); se = sel(se);
  const n = x.length;
  // local noise from 3rd-difference pseudo-residuals, robust rolling scale (11 points)
  let tau = 0;
  if (n >= 7) {
    const e = new Array(n).fill(0), d3 = [];
    for (let k = 0; k + 3 < n; k++) d3.push((y[k + 3] - 3 * y[k + 2] + 3 * y[k + 1] - y[k]) / Math.sqrt(20));
    for (let k = 0; k < d3.length; k++) e[k + 1] = d3[k];
    e[0] = d3[0]; e[n - 2] = d3[d3.length - 1]; e[n - 1] = d3[d3.length - 1];
    const loc = [];
    for (let k = 0; k < n; k++) loc.push(1.4826 * sp_median(e.slice(Math.max(0, k - 5), k + 6).map(Math.abs)));
    tau = sp_median(loc.map((v, k) => Math.sqrt(Math.max(v * v - sy[k] * sy[k], 0))));
    sy = sy.map((v, k) => Math.sqrt(Math.max(v * v, loc[k] * loc[k])));
  }
  const z = o.z;
  const detect = (segs) => {
    const s0 = segs[0]; let dark = null;
    if (Math.abs(s0.b) < Math.max(z * s0.se, 0.5) && s0.j - s0.i >= 3) {
      const v = m.slice(s0.i, s0.j + 1), mu = v.reduce((a, q) => a + q, 0) / v.length;
      dark = { D: mu, sd: Math.sqrt(v.reduce((a, q) => a + (q - mu) * (q - mu), 0) / (v.length - 1)) };
    }
    const el = [];
    segs.forEach((s, k) => {
      el.push({ kind: "seg", k, lo: s.b - z * s.se, hi: s.b + z * s.se, s: s.b, i: s.i, j: s.j });
      if (k < segs.length - 1) {
        const i = s.j, j = segs[k + 1].i, h = x[j] - x[i];
        const dr = y[j] - y[i], sdr = Math.hypot(sy[i], sy[j]);
        el.push({ kind: "bridge", k, lo: (dr - z * sdr) / h, hi: (dr + z * sdr) / h, s: dr / h, i, j, raw: dr / h, rawLo: (dr - z * sdr) / h });
      }
    });
    const S = el.map((e) => e.s), LO = el.map((e) => e.lo), HI = el.map((e) => e.hi), N = el.length;
    const regimes = [];
    for (let p = 0; p < N; p++) {
      const side = (step) => {
        let q = p + step, vmin = Infinity, vhi = Infinity;
        while (q >= 0 && q < N) {
          if (LO[q] > S[p]) return [vmin, vhi, false];
          if (S[q] < vmin) vmin = S[q];
          vhi = Math.min(vhi, HI[q]); q += step;
        }
        return [vmin, vhi, true];
      };
      const [lv, lhi, lb] = side(-1), [rv, rhi, rb] = side(+1);
      if (!Number.isFinite(lv)) continue;
      if (!Number.isFinite(rv) && !rb) continue;
      const rightCens = rb && !Number.isFinite(rv);
      if (LO[p] <= lhi || (Number.isFinite(rv) && LO[p] <= rhi)) continue;
      if (LO[p] <= 1.0) continue;
      if (LO[p] - lhi < o.minProm) continue;
      const lseg = [];
      for (let q = p - 1; q >= 0; q--) { if (LO[q] > S[p]) break; if (el[q].kind === "seg") lseg.push(el[q].s); }
      const base = Math.max(lseg.length ? Math.min(...lseg) : lv, 0);
      if (S[p] < o.minRatio * Math.max(base, 0.5) || S[p] - base < o.minProm) continue;
      if (!lb && lv > 0.5 * S[p]) continue;
      if (!rb && rv > 0.5 * S[p]) continue;
      const flank = Number.isFinite(rv) ? Math.max(lv, rv) : lv;
      const half = (S[p] + flank) / 2;
      let a = p; while (a - 1 >= 0 && S[a - 1] > half) a--;
      let b = p; while (b + 1 < N && S[b + 1] > half) b++;
      const i0 = el[a].i, j0 = el[b].j, rise = y[j0] - y[i0];
      if (rise < o.minRise) continue;
      const post = y.slice(j0 + 1, j0 + 4);
      if (post.length && sp_median(post) < y[j0] - 0.5 * rise) continue;
      const pre = segs.find((sg) => sg.i <= i0 - 1 && i0 - 1 <= sg.j);
      if (pre) { const b0 = Math.max(pre.b, 0); if (S[p] < o.minRatio * Math.max(b0, 0.5) || S[p] - b0 < o.minProm) continue; }
      const pk = el[p];
      regimes.push({ i: i0, j: j0, peak: pk.kind === "bridge" ? pk.raw : S[p], peakLo: pk.kind === "bridge" ? pk.rawLo : LO[p],
        kind: pk.kind, prom: S[p] - flank, rightCens, rise });
    }
    regimes.sort((p, q) => q.peakLo - p.peakLo);
    const kept = [];
    for (const r of regimes) if (kept.every((k) => r.j < k.i || r.i > k.j)) kept.push(r);
    const out = kept.map((r) => {
      const ii = []; for (let q = r.i; q <= r.j; q++) ii.push(q);
      const fit = sp_wfit(ii.map((q) => x[q]), ii.map((q) => y[q]), ii.map((q) => 1 / (sy[q] * sy[q])));
      const ps = segs.find((s) => s.i <= r.i - 1 && r.i - 1 <= s.j) || null;
      const xt = ps && fit.b !== ps.b ? (ps.a - fit.a) / (fit.b - ps.b) : NaN;
      let paSig = NaN;
      if (dark) {
        const Dm = dark.D - 3 * dark.sd, jj = ii.filter((q) => m[q] - dark.D > 3 * Math.max(dark.sd, se[q]));
        if (jj.length >= 2) { const ly = jj.map((q) => Math.log10(m[q] - Dm)), lx = jj.map((q) => x[q]); paSig = sp_ls(lx, ly, 0, jj.length - 1); }
      }
      const lower = ii.length <= 2 || r.kind === "bridge";
      let br = [x[r.i - 1], x[r.i]];
      const nearDark = !!dark && y[r.i] < Math.log10(dark.D) + 1.0;
      if (nearDark) {
        const lit = []; for (let q = Math.max(r.i - 2, 0); q <= r.j; q++) if (m[q] - dark.D > 3 * dark.sd) lit.push(q);
        if (lit.length && lit[0] > 0) br = [x[lit[0] - 1], x[lit[0]]];
      }
      const head = nearDark && Number.isFinite(paSig) && paSig > r.peak ? paSig : r.peak;
      const main = segMainRise(x, y, br[0], br[1] + o.mainExt, o.mainD);
      return { kind: r.kind, head, headLo: r.peakLo, peak: r.peak, regimeSlope: fit.b, darkSub: paSig, nPts: ii.length,
        xTh: xt, bracket: br, x0: x[r.i], x1: x[r.j], rise: r.rise, prom: r.prom, nearDark,
        main, cls: head >= o.TClass ? "PA" : "S-bend",
        status: (lower ? "lower-bound" : "resolved") + (r.rightCens ? " / right-censored" : "") };
    });
    out.sort((p, q) => q.headLo - p.headLo);
    return { dark, regimes: out };
  };
  const first = segSegment(x, y, sy, o.Kmax, null);
  const Kbic = first.K;
  let base = null; const cands = [];
  for (let Kc = Kbic; Kc > 1; Kc--) {
    const sc = Kc === Kbic ? first.segs : segSegment(x, y, sy, o.Kmax, Kc).segs;
    const r2 = detect(sc);
    if (!base) base = Object.assign({ segs: sc }, r2);
    for (const q of r2.regimes) { q.scale = Kc; cands.push(q); }
  }
  cands.sort((p, q) => q.headLo - p.headLo);
  const dxs = []; for (let k = 1; k < x.length; k++) dxs.push(x[k] - x[k - 1]);
  const gap = 2.5 * sp_median(dxs);
  const chosen = [];
  for (const q of cands) if (chosen.every((c) => q.x1 + gap < c.x0 || q.x0 > c.x1 + gap)) chosen.push(q);
  const W = (v) => Math.pow(10, v);
  for (const q of chosen) {
    q.bracketW = [W(q.bracket[0]), W(q.bracket[1])]; q.xThW = W(q.xTh); q.x0W = W(q.x0); q.x1W = W(q.x1);
    if (q.main) { q.main.x0W = W(q.main.x0); q.main.x1W = W(q.main.x1); }
  }
  return {
    engine: "SegPA", version: SEGPA_VERSION, options: o,
    regimes: chosen, K: base.segs.length, Kbic, tau, spikes: spikes.map(W),
    dark: base.dark, segs: base.segs.map((s) => ({ x0W: W(x[s.i]), x1W: W(x[s.j]), slope: s.b, se: s.se, a: s.a })),
    data: { P: x.map(W), I: y.map((v) => Math.pow(10, v)) },
  };
}


return {
  VERSION,
  // SegPA 1.0 (v3.18) — globally optimal piecewise power-law regime detector
  segPA, SEGPA_VERSION, SEGPA_DEFAULTS, segPrep, segSegment, segMainRise,
  analyze, bootstrap, evaluate, synth,
  // RiseFit (ANP rise-time kinetics)
  riseAnalyze, riseBootstrap, riseLogRebin, RISE_MODELS,
  // DarkenFit (photodarkening)
  darkenAnalyze,
  // PA standard layer (paper port)
  PA_CONST, paHighState, paMergeClose, paDarkAndGate, paJumpTerm, paJumpOnTrace,
  paJumpCandidates, paHighStateBranch, paDarkOf,
  // internals exposed for tests
  glog10, estimateVarianceModel, makeSplineBasis, fitPSpline, fitHinge, unpackH, modelI, slopeOf, hingeStarts,
  runsTest, makeRng, lm, median, mad, quantile, tangentThreshold, deSearch, profileSlopeFloor,
  secantSlopeLowerBound, ignitionBracket, darkFloor, localIgnitionFit, selectPA,
  robustFitCore, unpackBS, bistableI, bistableSlope, bsHighSlope, bsOcc, bsHalfX, bsWidth1090, bistableStarts, fitBistable, bistableAnalyze, synthBistable, synthSweep, BS_W_FLOOR,
  poolHighExponent,
  occupancyFromReplicates, chi2SF, bhThreshold, crossBranchOccupancy,
};
});

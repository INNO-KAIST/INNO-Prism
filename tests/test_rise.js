/* RiseFit synthetic validation: 7 scenarios covering ANP rise-time regimes. */
"use strict";
const F = require("../src/fit2.js");

function mkTrace(cfg) {
  // cfg: {dt, tPre, tOn, tOff(optional→end), total, model(t)->rate, baseRate, seed, spike}
  const rng = F.makeRng(cfg.seed || 1);
  const poisson = (lam) => {
    if (!(lam > 0)) return 0;
    if (lam > 30) return Math.max(0, Math.round(lam + Math.sqrt(lam) * rng.normal()));
    const L = Math.exp(-lam); let k = 0, p = 1;
    do { k++; p *= rng.uniform(); } while (p > L);
    return k - 1;
  };
  const n = Math.round(cfg.total / cfg.dt);
  const t = [], c = [], setV = [];
  const onIdx = Math.round(cfg.tOn / cfg.dt);
  const offIdx = cfg.tOff ? Math.round(cfg.tOff / cfg.dt) : null;
  for (let i = 0; i < n; i++) {
    const tt = i * cfg.dt;
    t.push(tt);
    const gateOn = i >= onIdx && (offIdx === null || i < offIdx);
    setV.push(gateOn ? 4 : 0);
    let lam = cfg.baseRate;
    if (gateOn) lam = cfg.model(tt - cfg.tOn);
    else if (offIdx !== null && i >= offIdx) lam = cfg.decayModel ? cfg.decayModel(tt - cfg.tOff) : cfg.baseRate;
    c.push(poisson(lam * cfg.dt)); // counts per bin
  }
  if (cfg.spike) c[0] = 1e8;
  return { t, c, gateOnIdx: onIdx, gateOffIdx: offIdx, dtMedian: cfg.dt, spikes: cfg.spike ? [0] : [] };
}

const sig = (x) => 1 / (1 + Math.exp(-x));
let fail = 0;
const check = (name, ok, info) => { console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${info ? " — " + info : ""}`); if (!ok) fail++; };

// counts are per-bin; engine works on per-bin counts.
// S1: below-threshold single-exponential rise, τ = 20 ms (realistic APD rates)
{
  const tau = 0.020, B = 2000, A = 40000;
  const inp = mkTrace({
    dt: 5e-4, tPre: 0.05, tOn: 0.05, tOff: 0.55, total: 0.8, seed: 11,
    baseRate: B, model: (t) => B + A * (1 - Math.exp(-t / tau)),
    decayModel: (t) => B + A * Math.exp(-t / 0.030),
  });
  // low-count variant sanity: engine stays unbiased in MEDIAN across seeds
  // (individual low-count fits are data-limited; see scale sweep in dev log)
  const a = F.riseAnalyze(inp, {});
  const r = a.rise;
  console.log(`S1 exp: model=${r.fit?.model} tauEff=${(r.fit?.tauEff * 1e3).toFixed(2)}ms t1e=${(r.free.t1e * 1e3).toFixed(2)}ms rho=${r.free.induction?.toFixed(3)} verdict=${a.verdict.klass}`);
  check("S1 model = single_exp", r.fit && r.fit.model === "single_exp");
  check("S1 tau within 15%", Math.abs(r.fit.params.tau - tau) / tau < 0.15, `tau=${(r.fit.params.tau * 1e3).toFixed(2)}ms`);
  check("S1 verdict exponential", a.verdict.klass === "exponential");
  check("S1 decay tau within 20%", a.decay && a.decay.fit && Math.abs(a.decay.fit.params.tau - 0.030) / 0.030 < 0.2,
    a.decay && a.decay.fit ? `tauD=${(a.decay.fit.params.tau * 1e3).toFixed(2)}ms` : "no decay fit");
}

// S2: avalanche near threshold — delayed logistic, r=15/s, tm=250ms (slow!)
{
  const B = 150, A = 30000, r0 = 15, tm = 0.25;
  const s0 = sig(-r0 * tm);
  const inp = mkTrace({
    dt: 2e-3, tOn: 0.1, tOff: null, total: 1.6, seed: 22,
    baseRate: B, model: (t) => B + A * (sig(r0 * (t - tm)) - s0) / (1 - s0),
  });
  const a = F.riseAnalyze(inp, {});
  const r = a.rise;
  console.log(`S2 aval: model=${r.fit?.model} r=${r.fit?.params.r?.toFixed(2)}/s tm=${(r.fit?.params.tm * 1e3)?.toFixed(1)}ms rho=${r.free.induction?.toFixed(3)} verdict=${a.verdict.klass}`);
  check("S2 model = logistic_delay", r.fit && r.fit.model === "logistic_delay");
  check("S2 r within 15%", r.fit && Math.abs(r.fit.params.r - r0) / r0 < 0.15, `r=${r.fit?.params.r?.toFixed(2)}`);
  check("S2 tm within 10%", r.fit && Math.abs(r.fit.params.tm - tm) / tm < 0.10);
  check("S2 verdict avalanche", a.verdict.klass === "avalanche");
  check("S2 induction ratio > 0.25", r.free.induction > 0.25, `rho=${r.free.induction?.toFixed(3)}`);
}

// S3: unresolved fast rise (τ ~ dt/2)
{
  const B = 100, A = 20000, tau = 1e-3;
  const inp = mkTrace({
    dt: 2e-3, tOn: 0.05, tOff: 0.4, total: 0.5, seed: 33,
    baseRate: B, model: (t) => B + A * (1 - Math.exp(-t / tau)),
    decayModel: () => 100,
  });
  const a = F.riseAnalyze(inp, {});
  console.log(`S3 fast: t1e=${(a.rise.free.t1e * 1e3).toFixed(3)}ms dt=${(a.rise ? 2 : 0)}ms verdict=${a.verdict.klass}`);
  check("S3 flagged unresolved", a.rise.unresolvedFast === true && a.verdict.klass === "unresolved");
}

// S4: overshoot then settle (photodarkening-like)
{
  const B = 200, A = 12000, tauR = 0.01, Bv = 3000, tauD = 0.15;
  const inp = mkTrace({
    dt: 1e-3, tOn: 0.05, tOff: null, total: 1.0, seed: 44,
    baseRate: B, model: (t) => B + A * (1 - Math.exp(-t / tauR)) - Bv * (1 - Math.exp(-t / tauD)),
  });
  const a = F.riseAnalyze(inp, {});
  const r = a.rise;
  console.log(`S4 over: model=${r.fit?.model} overshoot=${(100 * r.free.overshoot).toFixed(1)}% peakT=${(r.free.peakT * 1e3).toFixed(1)}ms`);
  check("S4 overshoot detected > 10%", r.free.overshoot > 0.10);
  check("S4 model = rise_relax", r.fit && r.fit.model === "rise_relax");
}

// S5: heterogeneous stretched rise (β = 0.55)
{
  const B = 150, A = 8000, tau = 0.05, beta = 0.55;
  const inp = mkTrace({
    dt: 1e-3, tOn: 0.05, tOff: null, total: 2.0, seed: 55,
    baseRate: B, model: (t) => B + A * (1 - Math.exp(-Math.pow(t / tau, beta))),
  });
  const a = F.riseAnalyze(inp, {});
  const r = a.rise;
  console.log(`S5 str : model=${r.fit?.model} beta=${r.fit?.params.beta?.toFixed(2)} tauEff=${(r.fit?.tauEff * 1e3).toFixed(1)}ms`);
  check("S5 model = stretched_exp", r.fit && r.fit.model === "stretched_exp");
  check("S5 beta within 0.15", r.fit && Math.abs(r.fit.params.beta - beta) < 0.15, `beta=${r.fit?.params.beta?.toFixed(3)}`);
}

// S6: DAQ spike + no gate-off; spike must not corrupt baseline/steady
{
  const B = 2000, A = 50000, tau = 0.03;
  const inp = mkTrace({
    dt: 1e-3, tOn: 0.05, tOff: null, total: 0.6, seed: 66, spike: true,
    baseRate: B, model: (t) => B + A * (1 - Math.exp(-t / tau)),
  });
  inp.c[0] = NaN; // extractRiseTime NaNs spikes — emulate
  const a = F.riseAnalyze(inp, {});
  check("S6 rise ok with spike NaN", a.rise.ok && Math.abs(a.rise.fit.params.tau - tau) / tau < 0.2,
    `tau=${(a.rise.fit?.params.tau * 1e3)?.toFixed(2)}ms`);
}

// S7: no significant rise (gate on but dark) → honest none
{
  const inp = mkTrace({
    dt: 1e-3, tOn: 0.05, tOff: null, total: 0.5, seed: 77,
    baseRate: 200, model: () => 200,
  });
  const a = F.riseAnalyze(inp, {});
  check("S7 no-rise verdict none", !a.rise.ok && a.verdict.klass === "none");
}

// S8: determinism + bootstrap sanity on S2
{
  const B = 150, A = 30000, r0 = 15, tm = 0.25;
  const s0 = sig(-r0 * tm);
  const inp = mkTrace({
    dt: 2e-3, tOn: 0.1, tOff: null, total: 1.6, seed: 22,
    baseRate: B, model: (t) => B + A * (sig(r0 * (t - tm)) - s0) / (1 - s0),
  });
  const a1 = F.riseAnalyze(inp, {});
  const a2 = F.riseAnalyze(inp, {});
  check("S8 deterministic", JSON.stringify(a1.rise.free) === JSON.stringify(a2.rise.free));
  const t0 = Date.now();
  const boot = F.riseBootstrap(inp, a1, { nBoot: 100, seed: 42 });
  const ms = Date.now() - t0;
  const ci = boot.ci.t1e;
  console.log(`S8 boot: ${ms}ms t1e CI=[${(ci.lo * 1e3).toFixed(1)}, ${(ci.hi * 1e3).toFixed(1)}]ms est=${(a1.rise.free.t1e * 1e3).toFixed(1)}ms logisticFrac=${boot.modelStability.logisticFrac}`);
  check("S8 CI brackets estimate", ci.lo <= a1.rise.free.t1e && a1.rise.free.t1e <= ci.hi);
  check("S8 CI width sane (<40% of est)", (ci.hi - ci.lo) / a1.rise.free.t1e < 0.4);
  check("S8 model stable in bootstrap", boot.modelStability.logisticFrac > 0.8);
  const boot2 = F.riseBootstrap(inp, a1, { nBoot: 100, seed: 42 });
  check("S8 bootstrap deterministic", JSON.stringify(boot.ci) === JSON.stringify(boot2.ci));
}

console.log(fail ? `\n${fail} FAILURES` : "\nALL PASS");
process.exit(fail ? 1 : 0);

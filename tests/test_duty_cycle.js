// R10: v3.0 — 점멸(duty cycle) 관측층.
//
// 이 검사의 설계 원칙: **단일 파일에 맞추지 않는다.** 그래서 실측 두 파일보다 먼저
// 조건을 바꿔가며 만든 합성 배터리에서 거짓양성률과 검출력을 재고, 그 다음에야 실측을 본다.
// 특히 아래 두 회귀는 실제로 겪은 실패라서 영구 검사로 남긴다:
//   (a) 곱셈 잡음(레이저 요동)에서 거짓양성 8.3% — 전역 척도 하나로 보정했을 때
//   (b) 전환이 넓으면 검출 0 — 국소 창으로 보정했을 때 창이 통째로 점멸 구간이라
// 둘 다 Theil–Sen 추세 보정으로 해결했고, 두 조건을 모두 배터리에 넣어 둔다.
let F; try { F = require("../src/fit2.js"); } catch (e) { F = require("./fit2.js"); }

let fail = 0;
const check = (cond, msg) => { console.log((cond ? "  ok   " : "  FAIL ") + msg); if (!cond) fail++; };
const poissonish = (rng, lam) => (lam < 30
  ? (() => { let L = Math.exp(-lam), k = 0, p = 1; do { k++; p *= rng.uniform(); } while (p > L); return k - 1; })()
  : Math.max(0, Math.round(lam + Math.sqrt(lam) * rng.normal())));

// ── 0) χ² 꼬리 확률이 정확한가 (판정의 근거) ──
console.log("\n[χ² 분포] 판정 임계값은 이 함수에서 나온다");
for (const [xv, nu, exp] of [[3.841, 1, 0.05], [9.488, 4, 0.05], [23.209, 10, 0.01], [2, 2, 0.3679]]) {
  const v = F.chi2SF(xv, nu);
  check(Math.abs(v - exp) < Math.max(2e-3, 0.02 * exp), `chi2SF(${xv}, ${nu}) = ${v.toFixed(5)} ≈ ${exp}`);
}

// ── 1) 거짓양성: 점멸이 없는 데이터 ──
function cleanScan(seed, { n = 90, reps = 5, tau = 0.1, a2 = 0, steep = 6 } = {}) {
  const rng = F.makeRng(seed);
  const x = [], I = [], R = [];
  for (let i = 0; i < n; i++) {
    const xv = -1.2 + 1.8 * i / (n - 1);
    const mu = 120 + Math.pow(10, 3.2 + steep * 0.5 * (xv + 0.6)) / (1 + Math.pow(10, -2 * (xv + 0.2)));
    const row = [];
    for (let r = 0; r < reps; r++) row.push(poissonish(rng, Math.max(mu * (a2 > 0 ? 1 + a2 * rng.normal() : 1) * tau, 0)) / tau);
    x.push(xv); R.push(row); I.push(row.reduce((a, b) => a + b, 0) / row.length);
  }
  return { x, I, reps: R, tau };
}
console.log("\n[거짓양성] 점멸 없는 데이터 · 조건 6종 × 시드 15개 · 설계 FDR 1%");
{
  const CONDS = [["순수 Poisson", {}], ["nRep 3", { reps: 3 }], ["τ 1.0", { tau: 1.0 }],
    ["곱셈 잡음 3% (과거 8.3% 실패)", { a2: 0.03 }], ["곱셈 잡음 10%", { a2: 0.10 }], ["완만한 곡선", { steep: 2 }]];
  let worst = 0, worstName = "";
  for (const [name, cfg] of CONDS) {
    let flagged = 0, total = 0;
    for (let s = 0; s < 15; s++) {
      const d = cleanScan(1000 + s * 7919, cfg);
      const vm = F.estimateVarianceModel(d.x, d.I, d.reps, { counting: true, acqTime: d.tau });
      const occ = F.occupancyFromReplicates(d.x, d.I, d.reps, vm.sigmaOfI, { fdr: 0.01 });
      if (!occ.checked) continue;
      flagged += occ.nBlink; total += occ.nRows;
    }
    const rate = total ? flagged / total : 0;
    if (rate > worst) { worst = rate; worstName = name; }
    console.log(`    ${name.padEnd(30)} ${flagged}/${total} = ${(100 * rate).toFixed(3)}%`);
  }
  check(worst <= 0.02, `최악 거짓양성률 ${(100 * worst).toFixed(3)}% ≤ 2% (${worstName})`);
}

// ── 2) 검출력과 κ̂ 의 물리적 의미 ──
function dwellOcc(rng, f, nSw, steps) {
  const kon = nSw * f, koff = nSw * (1 - f), dt = 1 / steps;
  let st = rng.uniform() < f ? 1 : 0, acc = 0;
  for (let t = 0; t < steps; t++) {
    if (st === 1) { if (rng.uniform() < koff * dt) st = 0; } else if (rng.uniform() < kon * dt) st = 1;
    acc += st;
  }
  return acc / steps;
}
function blinkScan(seed, { n = 90, reps = 5, tau = 0.1, nSw = 3, Rlo = 130, Rhi = 13000, fs = [0.06, 0.55], a2 = 0.02 } = {}) {
  const rng = F.makeRng(seed);
  const iSw = Math.floor(n * 0.55);
  const x = [], I = [], R = [], truth = [];
  for (let i = 0; i < n; i++) {
    const xv = -1.2 + 1.8 * i / (n - 1), k = i - iSw;
    let fTrue = null, base;
    if (k < 0) base = Rlo * Math.pow(10, 0.5 * (xv + 1.2));
    else if (k >= fs.length) base = Rhi * Math.pow(10, 1.8 * (xv - (-1.2 + 1.8 * (iSw + fs.length) / (n - 1))));
    else fTrue = fs[k];
    const row = [];
    for (let r = 0; r < reps; r++) {
      const rate = fTrue === null ? base : (() => { const fd = dwellOcc(rng, fTrue, nSw, 200); return Rlo * (1 - fd) + Rhi * fd; })();
      row.push(poissonish(rng, Math.max(rate * (1 + a2 * rng.normal()) * tau, 0)) / tau);
    }
    x.push(xv); R.push(row); I.push(row.reduce((a, b) => a + b, 0) / row.length); truth.push(fTrue);
  }
  return { x, I, reps: R, tau, truth };
}
const runBlink = (cfg, nseed = 15) => {
  let hit = 0, tot = 0, fp = 0, clean = 0; const kaps = [], ferr = [];
  for (let s = 0; s < nseed; s++) {
    const d = blinkScan(2000 + s * 6247, cfg);
    const vm = F.estimateVarianceModel(d.x, d.I, d.reps, { counting: true, acqTime: d.tau });
    const occ = F.occupancyFromReplicates(d.x, d.I, d.reps, vm.sigmaOfI, { fdr: 0.01 });
    if (!occ.checked) continue;
    const byI = new Map(occ.rows.map((r) => [r.i, r]));
    for (let i = 0; i < d.x.length; i++) {
      const r = byI.get(i); if (!r) continue;
      if (d.truth[i] !== null) { tot++; if (r.blink) { hit++; if (isFinite(r.kappa)) kaps.push(r.kappa); if (isFinite(r.fMean)) ferr.push(Math.abs(r.fMean - d.truth[i])); } }
      else { clean++; if (r.blink) fp++; }
    }
  }
  return { rate: hit / tot, fp: fp / clean, kappa: kaps.length ? F.median(kaps) : NaN, ferr: ferr.length ? F.median(ferr) : NaN };
};
console.log("\n[검출력] 점멸 있는 데이터");
{
  const fast = runBlink({ nSw: 30 }), mid = runBlink({ nSw: 3 }), slow = runBlink({ nSw: 0.3 });
  for (const [n2, r] of [["빠른 점멸 N_sw=30", fast], ["중간 N_sw=3", mid], ["느린 N_sw=0.3", slow]]) {
    console.log(`    ${n2.padEnd(22)} 검출 ${(100 * r.rate).toFixed(0)}% · 거짓양성 ${(100 * r.fp).toFixed(2)}% · κ̂ ${r.kappa.toFixed(2)} · f̂오차 ${r.ferr.toFixed(3)}`);
  }
  check(fast.rate > 0.7, `빠른 점멸 검출률 ${(100 * fast.rate).toFixed(0)}% > 70%`);
  check(mid.rate > 0.6, `중간 점멸 검출률 ${(100 * mid.rate).toFixed(0)}% > 60%`);
  check(fast.fp < 0.02 && mid.fp < 0.02, `점멸이 있어도 깨끗한 점의 거짓양성 < 2%`);
  // κ̂ 는 'dwell 안에서 몇 번 점멸했는가'를 반영해야 한다 — 값이 아니라 순서가 핵심
  check(fast.kappa < mid.kappa && mid.kappa < slow.kappa,
    `κ̂ 가 점멸 속도 순서를 반영 (빠름 ${fast.kappa.toFixed(2)} < 중간 ${mid.kappa.toFixed(2)} < 느림 ${slow.kappa.toFixed(2)})`);
  check(fast.kappa < 0.3, `빠른 점멸에서 κ̂ ≪ 1 — dwell 안 평균화를 정량화 (${fast.kappa.toFixed(2)})`);
  check(slow.kappa > 0.7, `느린 점멸에서 κ̂ ≈ 1 — 반복 한 번이 한 상태에 머묾 (${slow.kappa.toFixed(2)})`);
  check(fast.ferr < 0.10, `빠른 점멸에서 f̂ 중앙오차 ${fast.ferr.toFixed(3)} < 0.10`);
}

// ── 3) 회귀: 전환이 창보다 넓어도 검출되어야 한다 ──
console.log("\n[회귀] 넓은 전환 — 국소 창 보정이 무너졌던 조건");
{
  const wide = runBlink({ nSw: 30, fs: [0.02, 0.05, 0.09, 0.15, 0.23, 0.33, 0.44, 0.56, 0.67, 0.77, 0.85, 0.91, 0.95, 0.98] }, 12);
  console.log(`    14점 전환: 검출 ${(100 * wide.rate).toFixed(0)}% · 거짓양성 ${(100 * wide.fp).toFixed(2)}%`);
  check(wide.rate > 0.3, `넓은 전환에서도 검출됨 ${(100 * wide.rate).toFixed(0)}% > 30% (창 보정 시절 0%)`);
}

// ── 4) 혼합이 아닌 과분산은 점멸로 부르지 않는다 ──
console.log("\n[특이성] 매끄러운 가지 위의 스파이크는 점멸이 아니다");
{
  let called = 0, detected = 0;
  for (let s = 0; s < 15; s++) {
    const d = cleanScan(5000 + s * 3121, {});
    const k = 60;
    const rng = F.makeRng(9000 + s);
    d.reps[k] = d.reps[k].map((v, j) => (j === 0 ? v * 3 : v));   // 한 반복만 튀는 스파이크
    d.I[k] = d.reps[k].reduce((a, b) => a + b, 0) / d.reps[k].length;
    const vm = F.estimateVarianceModel(d.x, d.I, d.reps, { counting: true, acqTime: d.tau });
    const occ = F.occupancyFromReplicates(d.x, d.I, d.reps, vm.sigmaOfI, { fdr: 0.01 });
    if (!occ.checked) continue;
    const r = occ.rows.find((q) => q.i === k);
    if (r && (r.blink || r.overdispersedOther)) detected++;
    if (r && r.blink) called++;
  }
  console.log(`    스파이크 15건 중: 과분산 감지 ${detected} · '점멸'로 오인 ${called}`);
  check(called <= 2, `매끄러운 가지의 스파이크를 점멸로 부르지 않음 (${called}/15)`);
}

// ── 5) 실측 두 파일 — 서로 다른 답이 나와야 한다 ──
console.log("\n[실측] 두 파일은 성격이 다르다 — 같은 이야기를 강요하면 안 된다");
{
  const res = {};
  for (const [tag, file] of [["WJ-0075c", "pa_wj0075c_updown.json"], ["WJ-0139c", "pa_wj0139c_down.json"]]) {
    const d = require("./testdata/" + file);
    const I1d = d.Iraw.map((r) => r.reduce((a, b) => a + b, 0) / r.length);
    const trace = { P: d.P, I: I1d, W: d.W, Iraw: d.Iraw, acqTime: d.acqTime, counting: true };
    for (const pass of ["up", "down"]) {
      let br; try { br = F.paHighStateBranch(trace.P, trace.I, trace.W, pass, { Iraw: d.Iraw, acqTime: d.acqTime, counting: true }); } catch (e) { continue; }
      const a = F.analyze(br, { paTrace: trace, acqTime: d.acqTime, counting: true, stabilityCheck: false });
      const o = a.occupancy;
      res[tag + "/" + pass] = { occ: o, a };
      console.log(`    [${tag} ${pass}] 점멸 ${o && o.checked ? o.nBlink : "-"}/${o && o.checked ? o.nRows : "-"}` +
        (o && o.checked && o.nBlink ? ` · f̂ ${o.rows.filter((r) => r.blink).map((r) => r.fMean.toFixed(2)).join(" → ")}` : ""));
    }
  }
  const up = res["WJ-0075c/up"];
  check(!!up && up.occ.checked && up.occ.nBlink >= 2, `WJ-0075c up: 점화 근방에서 점멸 검출 (${up.occ.nBlink}개)`);
  check(up.occ.fracBlink < 0.2 && !up.occ.global, `WJ-0075c up: 국소 현상으로 판정 (${(100 * up.occ.fracBlink).toFixed(1)}%)`);
  // 점유율은 단조 증가해야 한다 (전환을 지나며 고상태 체류가 늘어난다)
  const fs = up.occ.rows.filter((r) => r.blink && isFinite(r.fMean)).map((r) => r.fMean);
  let mono = true; for (let i = 1; i < fs.length; i++) if (fs[i] < fs[i - 1] - 1e-9) mono = false;
  check(mono, `WJ-0075c up: 점유율이 파워에 대해 단조 증가 (${fs.map((v) => v.toFixed(2)).join(" → ")})`);
  const k0139 = res["WJ-0139c/up"];
  check(!!k0139 && k0139.occ.checked && k0139.occ.fracBlink < 0.05,
    `WJ-0139c up: 점멸이 거의 없다고 판정 (${k0139 ? k0139.occ.nBlink : "-"}개) — 파일마다 다른 답이 나온다`);
  // 적합된 전환과 관측 점유율의 대조가 실제로 계산되는가
  const oc = up.a.bistable && up.a.bistable.occCheck;
  check(!!oc && oc.n > 0 && isFinite(oc.maxAbsZ), `적합 f(P) 대 관측 f̂ 대조가 산출됨 (max|z| = ${oc ? oc.maxAbsZ.toFixed(1) : "-"})`);
  check(oc.constrained === false, `점유율 제약은 기본 꺼짐 (측정이 지지하지 않으므로)`);
}

// ── 5b) v3.1: f̂ 의 계통 불확실성과 단조성 ──
console.log("\n[v3.1] 준위 외삽 계통 · 점유율 단조성");
{
  const d2 = require("./testdata/pa_wj0075c_updown.json");
  const I1d = d2.Iraw.map((r) => r.reduce((a, b) => a + b, 0) / r.length);
  const trace = { P: d2.P, I: I1d, W: d2.W, Iraw: d2.Iraw, acqTime: d2.acqTime, counting: true };
  const br = F.paHighStateBranch(trace.P, trace.I, trace.W, "up",
    { Iraw: d2.Iraw, acqTime: d2.acqTime, counting: true });
  const a = F.analyze(br, { paTrace: trace, acqTime: d2.acqTime, counting: true, stabilityCheck: false });
  const rows = a.occupancy.rows.filter((r) => r.blink && isFinite(r.fMean));
  // σ_f 는 통계 성분과 계통 성분(NEI 민감도)으로 분해되어 보고되어야 한다
  check(rows.every((r) => isFinite(r.fSdStat) && isFinite(r.fSdSys)),
    "σ_f 가 통계/계통 성분으로 분해되어 보고됨");
  const tail = rows[rows.length - 1];
  check(tail.fSdSys > tail.fSdStat,
    `꼬리 점에서 계통이 통계보다 큼 (계통 ${tail.fSdSys.toFixed(3)} > 통계 ${tail.fSdStat.toFixed(3)}) — 이 계통을 빼면 불일치가 과장된다`);
  // v3.0 은 이 계통을 빼고 max|z|=12.1 로 보고했다. 계통을 넣으면 4 근처가 되어야 한다.
  const oc = a.bistable && a.bistable.occCheck;
  check(!!oc && oc.maxAbsZ < 6,
    `모델 f 대 관측 f̂ 의 max|z| = ${oc ? oc.maxAbsZ.toFixed(1) : "-"} (v3.0 의 12.1 은 계통 누락으로 과장된 값이었다)`);
  check(a.occupancy.fMonotone === true, "WJ-0075c up: 점유율 단조 판정 true");
  // 모든 NEI 변형에서 혼합 해석이 성립해야 한다 — 결론이 외삽 선택에 의존하면 안 된다
  const d3 = require("./testdata/pa_wj0139c_down.json");
  const I3 = d3.Iraw.map((r) => r.reduce((a2, b2) => a2 + b2, 0) / r.length);
  const tr3 = { P: d3.P, I: I3, W: d3.W, Iraw: d3.Iraw, acqTime: d3.acqTime, counting: true };
  const br3 = F.paHighStateBranch(tr3.P, tr3.I, tr3.W, "down",
    { Iraw: d3.Iraw, acqTime: d3.acqTime, counting: true });
  const a3 = F.analyze(br3, { paTrace: tr3, acqTime: d3.acqTime, counting: true, stabilityCheck: false });
  check(a3.occupancy.nBlink <= 3,
    `WJ-0139c down: 엄격 규칙에서 ${a3.occupancy.nBlink}개만 검출 (완화 규칙에서는 7개가 비단조로 나왔다)`);
  check(a3.occupancy.fMonotone === true, "WJ-0139c down: 남은 검출은 단조");
}

// ── 6) 반복이 없으면 조용히 비활성 ──
console.log("\n[폴백]");
{
  const { branch } = F.synth({}, 7);
  delete branch.intensityReplicates;
  const a = F.analyze(branch, { stabilityCheck: false, profileSlope: false });
  check(a.occupancy === null, "반복 없는 데이터에서 occupancy=null (오류 없이 비활성)");
}

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);

// R13: v3.6 — 여러 분지의 고상태 국소지수 합산.
//
// 배경: 실측 16분지 중 14개가 문턱 위 구간 0.25 dec 에 못 미쳐 n_high 를 보고하지 못한다.
// 스윕을 늘릴 수 없는 상황에서 유일한 우회로가 **여러 분지를 묶는 것**이다.
// 이 검사는 (1) 절대 파워로 묶어야 한다는 것, (2) 참값을 회수한다는 것,
// (3) 왜 되는지(긴 구간 분지가 끌어준다)를 잠근다.
let F; try { F = require("../src/fit2.js"); } catch (e) { F = require("./fit2.js"); }

let fail = 0;
const check = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fail++; };

// 자리마다 전환 파워가 다른 짧은 스윕들 — 실측과 같은 상황
const spots = (n, base) => {
  const out = [];
  for (let k = 0; k < n; k++) {
    const seed = base + k;
    const jit = ((seed * 2654435761) % 1000) / 1000 * 0.10 - 0.05;
    const r = F.synthSweep({ xhi: -2.27, n: 100, xsUp: -2.50 + jit, xsDn: -2.70 + jit }, seed);
    out.push(r);
  }
  return out;
};
const analyzeAll = (sweeps) => {
  const bs = [], meta = [];
  for (const r of sweeps) {
    const sw = r.trace;
    const trace = { P: sw.P, I: sw.I, W: sw.W, Iraw: sw.Iraw, acqTime: sw.acqTime, counting: true };
    for (const pass of ["up", "down"]) {
      let b = null;
      try {
        const br = F.paHighStateBranch(sw.P, sw.I, sw.W, pass,
          { Iraw: sw.Iraw, acqTime: sw.acqTime, counting: true });
        b = F.analyze(br, { paTrace: trace, acqTime: sw.acqTime, counting: true,
          stabilityCheck: false, profileSlope: false, branchName: pass }).bistable;
      } catch (e) { /* 건너뛴다 */ }
      if (b) { bs.push(b); meta.push(pass); }
    }
  }
  return { bs, meta };
};

console.log("\n[입력 방어]");
{
  check(F.poolHighExponent(null).usable === false, "빈 입력 → usable=false");
  check(F.poolHighExponent([]).branches === 0, "분지 0개");
  const r = F.poolHighExponent([{ params: { w: 0.01 }, pSwitch: 1, nHighRangeDec: 0.3, chosenOrder: 0 }]);
  check(r.usable === false && r.branches === 1, `분지가 minBranch 미만이면 거부 (${r.branches} < ${r.minBranch})`);
}

const sweeps = spots(5, 300);
const { bs, meta } = analyzeAll(sweeps);
const truth = sweeps[0].truth;
const ts = (x) => { const h = 1e-3; return (truth.hiLevel(x + h) - truth.hiLevel(x - h)) / (2 * h); };

console.log("\n[참값 회수] 자리마다 P_s 가 다른 짧은 분지들을 절대 파워로 묶는다");
const pooled = F.poolHighExponent(bs, { seed: 7 });
check(pooled.usable === true, `합산 성립 (분지 ${pooled.branches}개)`);
console.log(`    유효구간(dec): ${pooled.rangeDecs.map((v) => v.toFixed(2)).join(" ")}`);
{
  const g = pooled.best;
  const t = ts(g.logP);
  const err = Math.abs(g.n - t) / Math.abs(t) * 100;
  console.log(`    대표 P=${g.P.toFixed(5)} · 분지 ${g.nBranch}개 · n=${g.n.toFixed(3)}`
    + ` [${g.lo90.toFixed(3)}, ${g.hi90.toFixed(3)}] · 참값 ${t.toFixed(3)} · 오차 ${err.toFixed(1)}%`);
  check(err < 10, `대표값이 참값의 10% 이내 (${err.toFixed(1)}%)`);
  check(g.lo90 <= t && t <= g.hi90, "90% 구간이 참값을 덮는다");
  check(g.nBranch >= 6, `대표 지점에 분지 ${g.nBranch}개가 겹친다`);
}

console.log("\n[왜 되는가] 긴 구간 분지(하행)가 잘 결정되고 중앙값이 이상치에 끌리지 않는다");
{
  // 같은 파워에서 상행/하행을 나눠 본다
  const g = pooled.best;
  const up = [], dn = [];
  for (let i = 0; i < bs.length; i++) {
    const b = bs[i];
    if (!b.params || b.nHighCollapsed) continue;
    const lo = Math.log10(b.pSwitch) + 3 * b.params.w;
    const hi = Math.log10(b.pSwitch) + b.nHighRangeDec;
    if (g.logP < lo || g.logP > hi) continue;
    const v = F.bsHighSlope(b.params, g.logP, b.chosenOrder);
    (meta[i] === "up" ? up : dn).push({ v, rng: hi - lo });
  }
  const med = (a) => { const s = a.slice().sort((p, q) => p - q); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
  const t = ts(g.logP);
  for (const [nm, arr] of [["상행", up], ["하행", dn]]) {
    if (!arr.length) continue;
    console.log(`    ${nm} ${arr.length}개 · 구간 중앙 ${med(arr.map((q) => q.rng)).toFixed(2)} dec`
      + ` · 값 ${arr.map((q) => q.v.toFixed(2)).sort().join(" ")}`);
  }
  check(dn.length >= 3 && med(dn.map((q) => q.rng)) > med(up.map((q) => q.rng)),
    "하행 분지의 문턱 위 구간이 상행보다 길다 (전환 파워가 낮으므로)");
  const eDn = Math.abs(med(dn.map((q) => q.v)) - t) / Math.abs(t) * 100;
  check(eDn < 5, `하행만으로도 참값의 5% 이내 (${eDn.toFixed(1)}%) — 합산이 마법이 아님을 보인다`);
}

console.log("\n[절대 파워로 묶어야 한다] P_s 배수로 묶으면 가짜 파워 의존성이 생긴다");
{
  // 같은 분지들을 1.2×P_s 로 묶으면 상행/하행이 갈린다
  const at = (b, mult) => {
    if (!b.params || b.nHighCollapsed) return NaN;
    const x = Math.log10(b.pSwitch) + Math.log10(mult);
    const lo = Math.log10(b.pSwitch) + 3 * b.params.w;
    const hi = Math.log10(b.pSwitch) + b.nHighRangeDec;
    if (x < lo || x > hi) return NaN;
    return F.bsHighSlope(b.params, x, b.chosenOrder);
  };
  const pu = [], pd = [];
  for (let i = 0; i < bs.length; i++) {
    const v = at(bs[i], 1.2);
    if (isFinite(v)) (meta[i] === "up" ? pu : pd).push(v);
  }
  // 절대 파워 기준에서는 두 무리의 중앙값이 가까워야 한다
  const g = pooled.best;
  const au = [], ad = [];
  for (let i = 0; i < bs.length; i++) {
    const b = bs[i];
    if (!b.params || b.nHighCollapsed) continue;
    const lo = Math.log10(b.pSwitch) + 3 * b.params.w;
    const hi = Math.log10(b.pSwitch) + b.nHighRangeDec;
    if (g.logP < lo || g.logP > hi) continue;
    (meta[i] === "up" ? au : ad).push(F.bsHighSlope(b.params, g.logP, b.chosenOrder));
  }
  const med = (a) => { const s = a.slice().sort((p, q) => p - q); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
  console.log(`    1.2×P_s 기준: 상행 중앙 ${med(pu).toFixed(2)} (n=${pu.length}) · 하행 ${med(pd).toFixed(2)} (n=${pd.length})`);
  console.log(`    절대 파워 기준: 상행 중앙 ${med(au).toFixed(2)} (n=${au.length}) · 하행 ${med(ad).toFixed(2)} (n=${ad.length})`);
  if (au.length && ad.length) {
    const rel = Math.abs(med(au) - med(ad)) / Math.max(Math.abs(med(ad)), 1e-9) * 100;
    check(rel < 25, `절대 파워 기준에서는 상·하행이 ${rel.toFixed(0)}% 이내로 일치한다`);
  }
}

console.log("\n[이질성 깃발] 동질 집합에서는 서지 않는다");
check(pooled.iqrRel < pooled.iqrMax,
  `IQR/중앙 ${pooled.iqrRel.toFixed(3)} < ${pooled.iqrMax} — 동질`);
check(pooled.heterogeneous === false, "heterogeneous=false");

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);

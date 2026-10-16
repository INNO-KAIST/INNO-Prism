// R11: v3.2 — 교차분지 점유율.
//
// 핵심 명제: 히스테리시스 구간에서 **반대 분지가 같은 파워의 고상태를 직접 측정**하므로,
// 고상태 준위를 외삽하지 않아도 된다. 그리고 그 외삽이 실제로 계통 편향을 만들고 있었다 —
// 외삽에 쓰는 '전환 직후' 점들이 아직 부분 점등이기 때문이다.
// 이 검사는 두 실측 파일에서 **같은 방향의 편향**이 재현되는지, 그리고 게이트가
// 성립하지 않는 분지를 정확히 거부하는지를 본다(한 파일 결론을 일반화하지 않기 위해).
let F; try { F = require("../src/fit2.js"); } catch (e) { F = require("./fit2.js"); }

let fail = 0;
const check = (cond, msg) => { console.log((cond ? "  ok   " : "  FAIL ") + msg); if (!cond) fail++; };

const load = (file) => {
  const d = require("./testdata/" + file);
  const I1d = d.Iraw.map((r) => r.reduce((a, b) => a + b, 0) / r.length);
  return { d, trace: { P: d.P, I: I1d, W: d.W, Iraw: d.Iraw, acqTime: d.acqTime, counting: true } };
};
// ê°ì (íì¼, ë¶ì§, ì ë³) ì¡°í©ì í ë²ë§ ë¶ìíë¤ — ì¤ì¸¡ í ê±´ì´ 15~20ì´ë¼
// ìºìê° ìì¼ë©´ ì´ ê²ì¬ë§ 5ë¶ì ëê¸´ë¤.
const _anCache = new Map();
const runBranchOpt = (file, pass, screenOcc) => {
  const key = file + "|" + pass + "|" + String(screenOcc);
  if (_anCache.has(key)) return _anCache.get(key);
  const { d, trace } = load(file);
  const br = F.paHighStateBranch(trace.P, trace.I, trace.W, pass,
    { Iraw: d.Iraw, acqTime: d.acqTime, counting: true });
  const opt = { paTrace: trace, acqTime: d.acqTime, counting: true,
    stabilityCheck: false, profileSlope: false, branchName: pass };
  if (screenOcc === false) opt.screenOcc = false;
  const a = F.analyze(br, opt);
  _anCache.set(key, a);
  return a;
};
const runBranch = (file, pass) => runBranchOpt(file, pass, undefined);

// ── 1) 함수가 없는 입력에 대해 조용히 비활성 ──
console.log("\n[입력 방어]");
{
  const r1 = F.crossBranchOccupancy(null, "up");
  check(r1 && r1.checked === false, "트레이스 없음 → checked=false");
  const { trace } = load("pa_wj0075c_updown.json");
  const r2 = F.crossBranchOccupancy(trace, "bogus");
  check(r2 && r2.checked === false, "분지 이름이 잘못되면 checked=false");
  // 단방향 스윕(하행을 잘라낸 트레이스)은 거부되어야 한다
  let peak = 0;
  for (let i = 1; i < trace.P.length; i++) if (trace.P[i] > trace.P[peak]) peak = i;
  const oneWay = { P: trace.P.slice(0, peak + 1), I: trace.I.slice(0, peak + 1),
    Iraw: trace.Iraw.slice(0, peak + 1), acqTime: trace.acqTime, counting: true };
  const r3 = F.crossBranchOccupancy(oneWay, "up");
  check(r3 && r3.checked === false && /단방향/.test(r3.reason || ""), `단방향 스윕 거부 (${r3.reason})`);
}

// ── 2) 게이트: 어떤 분지에서 성립하고 어떤 분지에서 성립하지 않는가 ──
console.log("\n[게이트] 성립 여부는 파일·분지마다 다르다 — 같은 이야기를 강요하면 안 된다");
const got = {};
for (const [tag, file] of [["WJ-0075c", "pa_wj0075c_updown.json"], ["WJ-0139c", "pa_wj0139c_down.json"]]) {
  for (const pass of ["up", "down"]) {
    const a = runBranch(file, pass);
    const c = a.crossOcc;
    got[tag + "/" + pass] = c;
    console.log(`    [${tag} ${pass}] checked=${c && c.checked} valid=${c && c.valid}`
      + (c && c.checked ? ` · 연속성 ${c.continuity.toFixed(4)} · f<0.8 인 점 ${c.nBelow}` : "")
      + (c && c.checked && !c.valid ? ` · ${c.reason}` : ""));
  }
}
check(got["WJ-0075c/up"].valid === true, "WJ-0075c up: 유효 (발광준위 히스테리시스 존재)");
check(got["WJ-0075c/down"].valid === false, "WJ-0075c down: 거부 — 기준 분지 자신이므로 간극이 없다");
check(got["WJ-0139c/up"].valid === false, "WJ-0139c up: 거부 — 이 파일 상행에는 간극이 없다");
check(got["WJ-0139c/down"].valid === true, "WJ-0139c down: 유효 — 간극이 반대 분지에 있다");

// ── 3) 재현되는 계통: 분지내 추정이 양쪽 파일에서 같은 방향으로 부풀어 있는가 ──
console.log("\n[재현성] 분지내 외삽의 편향이 두 파일에서 재현되는가 (선별 전)");
{
  // v3.5 부터 부분 점등 선별이 기본이므로, **선별을 끈** 값으로 재현성을 본다.
  const raw = {};
  for (const [key, file, pass] of [["WJ-0075c/up", "pa_wj0075c_updown.json", "up"],
                                   ["WJ-0139c/down", "pa_wj0139c_down.json", "down"]]) {
    raw[key] = runBranchOpt(file, pass, false).crossOcc.withinBiasMedian;
    check(isFinite(raw[key]) && raw[key] > 1.5,
      `${key}: 선별 전 분지내 점유율이 ${raw[key].toFixed(2)}배 과대`);
  }
  const b1 = raw["WJ-0075c/up"], b2 = raw["WJ-0139c/down"];
  check(Math.abs(b1 - b2) / Math.max(b1, b2) < 0.35,
    `두 파일의 편향 크기가 비슷 (${b1.toFixed(2)} vs ${b2.toFixed(2)}) — 한 파일 인공물이 아니다`);
  // 선별이 두 파일 모두를 1 쪽으로 옮기는가
  for (const key of ["WJ-0075c/up", "WJ-0139c/down"]) {
    const scr = got[key].withinBiasMedian;
    console.log(`    ${key}: 선별 전 ×${raw[key].toFixed(2)} → 선별 후 ×${scr.toFixed(2)}`);
    check(Math.abs(scr - 1) < Math.abs(raw[key] - 1),
      `${key}: 선별이 편향을 1 쪽으로 옮긴다`);
  }
}

// ── 4) 전환 폭 — 제약이 유지되는 분지에서 모델 폭이 측정 폭에 가까운가 ──
// 이력: v3.2 는 "측정 폭이 모델 폭보다 12배 넓다"를 **결함의 서술**로 잠갔고, v3.4 는
// 제약을 걸어 그 간극이 닫힌 것을 잠갔다(0.0111 → 0.0803, 비 1.68×). v3.5 에서 σ_f 를
// 올바르게 보정하자 WJ-0075c 상행은 갈등비 87× 로 **제약이 철회**된다 — 그 분지에서는
// 모델 폭을 측정 폭과 비교하는 것 자체가 성립하지 않는다. 그래서 이 검사는 제약이
// 실제로 유지되는 분지(WJ-0139c 하행)로 옮긴다.
console.log("\n[전환 폭] 제약이 유지되는 분지에서 모델 폭이 측정 폭에 가까운가");
{
  const c = got["WJ-0075c/up"];
  check(isFinite(c.width1090) && c.width1090 > 0.05,
    `WJ-0075c up: 10→90% 폭 ${c.width1090.toFixed(4)} dec`);
  check(c.monotone === true, "WJ-0075c up: 교차분지 f 가 단조");
  const a = runBranch("pa_wj0075c_updown.json", "up");
  check(a.occSourceUsed === "cross", `기본 출처가 교차분지 (${a.occSourceUsed}, 제약점 ${a.occConstraintN})`);
  const d = runBranch("pa_wj0139c_down.json", "down");
  const cd = got["WJ-0139c/down"];
  check(d.occSourceUsed === "cross" && d.bistable && !d.bistable.occWithdrawn,
    `WJ-0139c down: 제약이 유지된다 (갈등 ${d.bistable ? d.bistable.chi2VsUnconstrained.toFixed(1) : "?"}×)`);
  if (d.bistable && isFinite(d.bistable.width1090Dec) && isFinite(cd.width1090)) {
    const rat = Math.max(cd.width1090 / d.bistable.width1090Dec, d.bistable.width1090Dec / cd.width1090);
    console.log(`    모델 폭 ${d.bistable.width1090Dec.toFixed(4)} dec vs 측정 ${cd.width1090.toFixed(4)} dec (비 ${rat.toFixed(2)}×)`);
    check(rat < 1.5, `모델 폭과 측정 폭이 1.5배 이내 — 제약이 전환 폭을 실제로 잡는다`);
  }
  // f 는 0 근처에서 시작해 1 근처까지 올라가야 한다
  const fs = c.rows.map((r) => r.f);
  check(Math.min(...fs) < 0.1 && Math.max(...fs) > 0.9, `f 가 ${Math.min(...fs).toFixed(3)} ~ ${Math.max(...fs).toFixed(3)} 범위를 덮는다`);
}

// ── 4b) v3.5 식별성 게이트: 구간 · 붕괴 · 제약 철회 ──
console.log("\n[식별성 게이트] 결정되지 않은 것을 숫자로 내놓지 않는다");
{
  const a = runBranch("pa_wj0075c_updown.json", "up");
  const b = a.bistable;
  check(!!b, "쌍안정 적합이 나온다");
  if (b) {
    console.log(`    문턱 위 구간 ${b.nHighRangeDec.toFixed(3)} dec (필요 ${b.nHighRangeMin.toFixed(2)})`
      + ` · 갈등 ${b.chi2VsUnconstrained.toFixed(1)}× · 철회=${b.occWithdrawn}`
      + ` · 단일값=${isFinite(b.nHighSingle) ? b.nHighSingle.toFixed(2) : "미보고"}`);
    // 구간 게이트 — 두 실측 분지 모두 0.25 dec 에 못 미친다
    check(b.rangeOk === false && b.nHighRangeDec < b.nHighRangeMin,
      `문턱 위 구간 부족으로 n_high 미보고 (${b.nHighRangeDec.toFixed(3)} < ${b.nHighRangeMin.toFixed(2)} dec)`);
    check(!isFinite(b.nHighSingle), "구간이 부족하면 단일값을 내지 않는다");
    // 제약 철회 — 합성 54건 최대 11.3× 대비 87× 는 검증 범위 밖
    check(b.occWithdrawn === true && b.chi2VsUnconstrained > b.occConflictMax,
      `갈등 ${b.chi2VsUnconstrained.toFixed(1)}× > ${b.occConflictMax}× → 제약 철회`);
    check(/철회/.test(b.chosenKey), `철회가 chosenKey 에 표시된다 (${b.chosenKey})`);
  }
  // 구간이 충분한 분지에서는 보고된다
  const dn = runBranch("pa_wj0075c_updown.json", "down");
  check(dn.bistable && dn.bistable.rangeOk === true && isFinite(dn.bistable.nHighSingle),
    `WJ-0075c down: 구간 ${dn.bistable ? dn.bistable.nHighRangeDec.toFixed(3) : "?"} dec 로 충분 → n_high=${dn.bistable && isFinite(dn.bistable.nHighSingle) ? dn.bistable.nHighSingle.toFixed(2) : "미보고"}`);
  // 게이트가 거부한 분지는 제약이 걸리지 않는다
  const d = runBranch("pa_wj0139c_down.json", "up");
  check(d.occSourceUsed === "none" && d.occConstraintN === 0,
    "간극이 없는 분지에서는 제약이 걸리지 않는다");
}

// ── 4c) v3.5 분지내 편향의 기원 ──
// v3.3 은 세 가설을 기각하고 '원인 미상'으로 남겼다. 원인은 점멸 검출이 전환 구간의
// 일부만 덮는다는 것이고, 그래서 고준위 법칙이 **아직 부분 점등인 점**으로 세워진다.
console.log("\n[분지내 편향의 기원] 검출이 전환을 다 덮지 못한다");
{
  const a = runBranch("pa_wj0075c_updown.json", "up");
  const o = a.occupancy;
  check(!!(o && o.checked), "분지내 점유율 층이 동작");
  if (o && o.checked) {
    console.log(`    검출이 전환의 ${(100 * o.detectCoverage).toFixed(0)}% 를 덮음`
      + ` · 고준위 법칙에 쓰이는 점들의 점유율 ${o.hiPointsOcc.toFixed(3)}`
      + ` · 선별 ${o.screened ? "ON" : "off"}`);
    check(o.detectCoverage < 0.6,
      `검출이 전환 전체를 덮지 못한다 (${(100 * o.detectCoverage).toFixed(0)}%)`);
    check(isFinite(o.hiPointsOcc) && o.hiPointsOcc < 0.95,
      `고준위 법칙에 쓰이는 점들이 아직 부분 점등 (f=${o.hiPointsOcc.toFixed(3)})`);
    check(o.screened === true, "교차분지가 유효하면 부분 점등 점을 선별한다");
  }
}

// ── 5) 광퇴색 계통이 σ 에 반영되는가 ──
console.log("\n[광퇴색 계통]");
{
  const c = got["WJ-0139c/down"];
  check(c.bleachFrac > 0.05, `WJ-0139c: 반환점 불연속 ${(100 * c.bleachFrac).toFixed(1)}% 감지`);
  const mid = c.rows.filter((r) => r.f > 0.3 && r.f < 0.9);
  check(mid.length > 0 && mid.every((r) => r.fSdSys > 0),
    "광퇴색 배율이 f 의 계통 성분으로 반영됨");
  const c0 = got["WJ-0075c/up"];
  check(c0.bleachFrac < c.bleachFrac, `WJ-0075c 쪽이 더 안정 (${(100*c0.bleachFrac).toFixed(1)}% < ${(100*c.bleachFrac).toFixed(1)}%)`);
}

// ── 6) v3.3: 양방향 합성 생성기로 **참값 대조** ──
// 실측만으로는 추정기가 맞는지 알 수 없다. 여기서 참 f_up 을 알고 비교한다.
console.log("\n[참값 대조] 양방향 합성 스윕 — 교차분지 f̂ 이 진짜 f_up 을 회수하는가");
{
  const errOf = (cfg, seed) => {
    const { trace, truth } = F.synthSweep(cfg, seed);
    const xo = F.crossBranchOccupancy(trace, "up", {});
    if (!xo.checked || !xo.rows) return { xo, errs: [], truth };
    const errs = [];
    for (const r of xo.rows) {
      if (!(r.f > 0.05 && r.f < 0.95)) continue;
      const t = truth.fUp.reduce((b, q) => Math.abs(q.x - r.x) < Math.abs(b.x - r.x) ? q : b, truth.fUp[0]);
      if (Math.abs(t.x - r.x) < 1e-6) errs.push(r.f - t.f);
    }
    return { xo, errs, truth };
  };
  for (const [name, cfg, tol] of [
    ["기준", {}, 0.05],
    ["빠른 점멸", { blinkNsw: 100 }, 0.05],
    ["느린 점멸", { blinkNsw: 1 }, 0.06],
    ["nRep 10", { reps: 10 }, 0.04],
    ["광퇴색 20%", { bleach: 0.20 }, 0.06],
  ]) {
    const all = [11, 977, 1801].map((s2) => errOf(cfg, s2));
    const es = [].concat(...all.map((r) => r.errs));
    const bias = es.length ? F.median(es) : NaN;
    console.log(`    ${name.padEnd(14)} 유효 ${all.filter((r) => r.xo.valid).length}/3 · 대조점 ${es.length} · 편향 ${isFinite(bias) ? (bias >= 0 ? "+" : "") + bias.toFixed(3) : "-"}`);
    check(all.every((r) => r.xo.valid), `${name}: 세 시드 모두 유효 판정`);
    check(isFinite(bias) && Math.abs(bias) < tol, `${name}: 참값 대비 편향 ${Math.abs(bias).toFixed(3)} < ${tol}`);
  }
  // 폭 회수
  const { trace, truth } = F.synthSweep({}, 11);
  const xo = F.crossBranchOccupancy(trace, "up", {});
  check(isFinite(xo.width1090) && Math.abs(xo.width1090 - truth.width1090Up) / truth.width1090Up < 0.20,
    `10→90% 폭 회수: 측정 ${xo.width1090.toFixed(4)} vs 참 ${truth.width1090Up.toFixed(4)} dec`);
}

// ── 7) v3.3: 게이트가 참값 기준으로 옳은가 ──
console.log("\n[게이트 정확도] 참값을 알 때 게이트가 맞는 판정을 하는가");
{
  // 히스테리시스가 없으면 거부해야 한다 — 억지로 쓰면 크게 틀린다
  const { trace: t0 } = F.synthSweep({ xsDn: -2.50, wDn: 0.030, nuDn: 8 }, 11);
  const x0 = F.crossBranchOccupancy(t0, "up", {});
  check(x0.checked && x0.valid === false && /간극/.test(x0.reason || ""),
    `히스테리시스 없음 → 거부 (${x0.reason})`);
  // **점진적 광퇴색은 이 지표로 잡히지 않는다** — 그리고 그것이 옳은 동작이다.
  // 실제 광퇴색은 연속적이라 반환점에 계단을 만들지 않는다. 합성으로 확인:
  const { trace: t1 } = F.synthSweep({ bleach: 0.45 }, 11);
  const x1 = F.crossBranchOccupancy(t1, "up", {});
  console.log(`    점진 광퇴색 45%: 연속성 ${x1.continuity.toFixed(3)} (계단이 생기지 않는다)`);
  check(Math.abs(x1.continuity - 1) < 0.10,
    `점진 광퇴색은 반환점 계단을 만들지 않음 — continuity 로는 검출 불가(한계로 명시)`);
  check(x1.valid === true,
    "점진 광퇴색 케이스도 f 자체는 잘 회수되므로 거부하지 않는다 (편향 +0.013, 위 대조 참조)");
  // **방향 구분**: 상행이 포화하지 않으면 연속성 > 1 — 광퇴색으로 오진하면 안 된다
  const { trace: t2, truth: tr2 } = F.synthSweep({ nuUp: 20, wUp: 0.045 }, 11);
  const x2 = F.crossBranchOccupancy(t2, "up", {});
  console.log(`    상행 미포화: 연속성 ${x2.continuity.toFixed(3)} · 참 f_up 최대 ${Math.max(...tr2.fUp.map((q) => q.f)).toFixed(3)}`);
  check(x2.continuity > 1, "상행 미포화 → 연속성 > 1 (광퇴색으로는 불가능한 방향)");
  check(x2.bleachSuspect === false, "광퇴색으로 오진하지 않음");
  check(x2.refNotSaturated === true && x2.valid === true,
    "미포화로 판정하고 거부하지 않음 — f 는 계산되되 상대값으로 표시");
  check(x2.absolute === false, "absolute=false — 절대 점유율로 읽지 말 것");
  // 정상 케이스는 absolute
  const { trace: t3 } = F.synthSweep({}, 11);
  const x3 = F.crossBranchOccupancy(t3, "up", {});
  check(x3.absolute === true, "포화·무퇴색 케이스는 absolute=true");
}

// ── 8) v3.3: 분지내 편향의 **원인은 아직 미상**이라는 사실을 고정한다 ──
// v3.2 는 "외삽에 쓰는 전환 직후 점들이 부분 점등이라서"라고 단정했다. 합성으로 검증하니
// 그 메커니즘으로는 실측의 ×2.7~2.9 가 재현되지 않는다(합성 최대 ×1.3).
// 검증된 것은 '불일치가 실측 두 파일에서 재현된다'는 사실뿐이다. 그 구분을 검사로 남긴다.
console.log("\n[기원 확정] 편향은 점멸 검출이 전환을 다 덮지 못해서 생긴다");
{
  // v3.3 은 이 편향이 "합성으로 재현되지 않는다(최대 ×1.29), 원인 미상"으로 잠갔다.
  // 그 결론 자체가 생성기 artifact 였다: 기본 blinkNsw=30 에서는 검출이 전환의 92–100% 를
  // 덮어 기전이 발현될 수 없다. dwell 평균화를 빠르게 하면(blinkNsw 큼) 검출 구간이
  // 전환의 일부로 줄고, 블록 위 '깨끗한' 점이 부분 점등이 되어 편향이 자란다.
  const out = [];
  for (const nsw of [30, 300]) {
    const { trace } = F.synthSweep({ blinkNsw: nsw, wUp: 0.030 }, 11);
    const br = F.paHighStateBranch(trace.P, trace.I, trace.W, "up",
      { Iraw: trace.Iraw, acqTime: trace.acqTime, counting: true });
    const a = F.analyze(br, { paTrace: trace, acqTime: trace.acqTime, counting: true,
      stabilityCheck: false, profileSlope: false, branchName: "up", screenOcc: false });
    if (!(a.crossOcc && a.crossOcc.valid && a.occupancy && a.occupancy.checked)) continue;
    out.push({ nsw, cov: a.occupancy.detectCoverage, hiF: a.occupancy.hiPointsOcc,
      bias: a.crossOcc.withinBiasMedian });
  }
  for (const r of out) {
    console.log(`    blinkNsw=${r.nsw}: 검출이 전환의 ${(100 * r.cov).toFixed(0)}% 를 덮음`
      + ` · 위쪽 점 f=${isFinite(r.hiF) ? r.hiF.toFixed(3) : "—"} · 편향 ×${r.bias.toFixed(2)}`);
  }
  check(out.length === 2, "두 점멸 속도에서 모두 산출됨");
  if (out.length === 2) {
    const slow = out[0], fast = out[1];
    check(fast.cov < slow.cov,
      `점멸이 빠를수록 검출이 전환을 덜 덮는다 (${(100 * slow.cov).toFixed(0)}% → ${(100 * fast.cov).toFixed(0)}%)`);
    check(fast.bias > slow.bias,
      `덮는 비율이 낮을수록 편향이 크다 (×${slow.bias.toFixed(2)} → ×${fast.bias.toFixed(2)})`);
    check(fast.bias > 2.0,
      `실측 규모(×2.87)가 합성으로 재현된다 — v3.3 의 '재현 불가·원인 미상'을 정정 (×${fast.bias.toFixed(2)})`);
  }
}

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);

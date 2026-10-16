/* INNO Prism — widefield imaging layer 검사 (v3.14)
 *
 * 실측 파일은 저장소에 없으므로 **합성 자료**로 회귀를 잡는다. 합성은 실측에서
 * 관찰한 성질을 그대로 재현하도록 만든다:
 *   · EM gain 단일광자 스파이크(화소 1개, 지수분포 꼬리)
 *   · 회절한계 PSF 입자
 *   · 시야 전체가 함께 꺼지는 경우 / 한 입자만 꺼지는 경우
 * 이 둘을 **구별해서** 판정하는지가 이 계층의 존재 이유다.
 *
 * 실행: node tests/test_imaging.mjs
 */
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const I = require(join(here, "..", "src", "imaging.js"));

let fail = 0;
const check = (n, ok, info) => { console.log(`  ${ok ? "PASS" : "FAIL"} ${n}${info ? " — " + info : ""}`); if (!ok) fail++; };

/* ------------------------- 합성 프레임 생성기 ------------------------------ */
function lcg(seed) { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }
/** bg + 가우스 읽기잡음 + EM 스파이크 + PSF 입자 */
function synthFrame(nx, ny, particles, opt) {
  const o = Object.assign({ bg: 100, read: 3, spikeRate: 0.004, spikeMean: 120, psf: 1.3, seed: 7 }, opt || {});
  const rnd = lcg(o.seed);
  const img = new Float32Array(nx * ny);
  const gauss = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  for (let i = 0; i < img.length; i++) {
    img[i] = o.bg + o.read * gauss();
    // EM gain 단일광자 사건: 화소 하나에 지수분포 진폭 — 실측 꼬리의 원인
    if (rnd() < o.spikeRate) img[i] += -o.spikeMean * Math.log(Math.max(1e-9, rnd()));
  }
  const s2 = 2 * o.psf * o.psf;
  for (const p of particles) {
    if (!(p.amp > 0)) continue;
    const R = Math.ceil(3 * o.psf);
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const x = Math.round(p.x) + dx, y = Math.round(p.y) + dy;
      if (x < 0 || y < 0 || x >= nx || y >= ny) continue;
      img[y * nx + x] += p.amp * Math.exp(-(dx * dx + dy * dy) / s2);
    }
  }
  return img;
}

const NX = 256, NY = 256;
const BASE = [
  { x: 60, y: 70 }, { x: 120, y: 90 }, { x: 180, y: 60 }, { x: 90, y: 160 },
  { x: 150, y: 180 }, { x: 200, y: 140 }, { x: 70, y: 200 }, { x: 210, y: 210 },
];

/* ============================ 1. 모양 판별 ================================= */
console.log("\n[1] EM 스파이크 배제 — 문턱이 아니라 모양으로 가르는가");
{
  const parts = BASE.map((p) => Object.assign({ amp: 900 }, p));
  const img = synthFrame(NX, NY, parts, { seed: 11, spikeRate: 0.01, spikeMean: 150 });
  const withShape = I.detectSpots(img, NX, NY, { shapeMin: 4 });
  const noShape = I.detectSpots(img, NX, NY, { shapeMin: 0, maxSpots: 400 });
  const found = (r) => parts.filter((p) => r.spots.some((s) => Math.hypot(s.xc - p.x, s.yc - p.y) < 3)).length;
  check("실제 입자 8개를 모두 찾는다", found(withShape) === 8, `${found(withShape)}/8`);
  check("모양 문턱이 스파이크를 대량 기각한다", withShape.nRejectedShape > 10, `기각 ${withShape.nRejectedShape}개`);
  check("모양 문턱 없으면 스파이크가 대거 섞인다", noShape.spots.length > withShape.spots.length + 10,
    `문턱없음 ${noShape.spots.length}개 vs 문턱적용 ${withShape.spots.length}개`);
  check("기각 개수를 항상 보고한다 (사용자가 문턱을 조정할 수 있게)",
    typeof withShape.nRejectedShape === "number" && typeof withShape.nCandidates === "number");
}

/* ================= 2. 공통모드 vs 개별 — 핵심 분기 ========================= */
console.log("\n[2] 공통모드 분리 — 전역 변화를 단일입자 스위칭으로 오독하지 않는가");
function stackTraces(ampFn, nF, seed0) {
  const rois = BASE.map((p) => ({ x: p.x, y: p.y, xc: p.x, yc: p.y }));
  const traces = rois.map(() => []), blanks = [];
  for (let k = 0; k < nF; k++) {
    const parts = BASE.map((p, i) => ({ x: p.x, y: p.y, amp: ampFn(i, k) }));
    const img = synthFrame(NX, NY, parts, { seed: seed0 + k * 17 });
    const ph = I.photometry(img, NX, NY, rois, {});
    ph.forEach((q, i) => traces[i].push(q.sum));
    blanks.push(I.blankNoise(img, NX, NY, rois, {}).sigma);
  }
  return { traces, blanks, rois };
}
{
  // (a) 시야 전체가 함께 꺼짐 — 실측 110553 의 성질
  // 실측 110553 에서 입자들은 3% 로 준 것이 아니라 **잡음 수준까지 사라졌다**.
  // 합성도 그렇게 해야 관측가능성 게이트가 실제로 시험된다.
  const g = [1, 0, 0];
  const a = stackTraces((i, k) => 900 * g[k], 3, 101);
  const cmA = I.commonMode(a.traces, { sigmaBlank: a.blanks });
  check("(a) 전역 소등 → 공통모드 우세로 판정", cmA.ok && cmA.commonDominant === true, `swing=${cmA.commonSwing.toFixed(1)}`);
  check("(a) 개별 스위칭 허위 경보 0건", cmA.nIndependent === 0, `${cmA.nIndependent}건`);
  check("(a) 잡음 아래 점은 판정에서 제외 (관측가능성 게이트)", cmA.nObservable < cmA.nPoints,
    `관측가능 ${cmA.nObservable}/${cmA.nPoints}`);

  // (b) 한 입자만 꺼짐 — 실측 110820 의 성질
  const b = stackTraces((i, k) => (i === 3 && (k === 2 || k === 4) ? 20 : 900), 5, 201);
  const cmB = I.commonMode(b.traces, { sigmaBlank: b.blanks });
  check("(b) 전역 수준 일정 → 공통모드 우세 아님", cmB.ok && cmB.commonDominant === false, `swing=${cmB.commonSwing.toFixed(3)}`);
  check("(b) 꺼진 입자 1개만 개별 거동으로 지목", cmB.nIndependent === 1, `${cmB.nIndependent}건`);
  check("(b) 지목된 ROI 가 실제로 그 입자", cmB.flags.findIndex((f) => f.independent) === 3,
    `#${cmB.flags.findIndex((f) => f.independent)}`);

  // (c) ROI 부족 → 분리 거부
  const cmC = I.commonMode([[1, 2], [2, 4]], { sigmaBlank: [1, 1] });
  check("(c) ROI 3개 미만이면 분리하지 않고 사유를 밝힌다", cmC.ok === false && /3개/.test(cmC.why), cmC.why);

  // (d) 관측 가능한 점이 1개뿐이면 '일치'라고 말하지 않는다
  const one = cmA.flags.every((f) => f.nObservable >= 2 || f.verdict === "unidentified");
  check("(d) 비교할 프레임이 2장 미만이면 '변화 없음'이라 하지 않는다", one);
}

/* ========================= 3. 상태 배정 근거 =============================== */
console.log("\n[3] 상태 배정 — 없는 것을 지어내지 않는가");
{
  // 실측 파일과 같은 형태: index_array 는 전부 0, index_turn_on_array 는 길이 0
  const ev = I.stateEvidence({
    n: 5, time: [1.5, 7.5, 15.5, 21.5, 29.5],
    aux: { index_array: [0, 0, 0, 0, 0], index_turn_on_array: [] },
    level: [1, 1, 1, 1, 1],
  });
  check("파일에 상태 기록이 없음을 올바로 보고", ev.file === null && ev.fileNotes.length === 2,
    (ev.fileNotes || []).join(" / "));
  check("간격 교대(6/8 s)를 강한 근거로 인식", ev.cadence && ev.cadence.strength === "강함",
    ev.cadence && ev.cadence.note);
  check("교대 배정이 0,1,0,1,0", ev.cadence && ev.cadence.assign.join("") === "01010");
  check("밝기가 평탄하면 준위 분리 근거 없음이라고 말한다", !ev.levels && /갈라지지 않습니다/.test(ev.levelsNote || ""));

  // 균일 간격 → 교대 근거 없음
  const ev2 = I.stateEvidence({ n: 4, time: [0, 5, 10, 15], aux: {}, level: [1, 1, 1, 1] });
  check("간격이 균일하면 교대 근거를 만들지 않는다", !ev2.cadence && /균일/.test(ev2.cadenceNote || ""));

  // 파일 기록이 있으면 확정으로 채택 가능
  const ev3 = I.stateEvidence({ n: 4, time: [0, 5, 10, 15], aux: { beam_on: [0, 1, 0, 1] }, level: null });
  check("2값 상태 배열이 있으면 확정 근거로 쓴다", ev3.file && ev3.file.assign.join("") === "0101", ev3.file && ev3.file.from);

  // 근거 충돌 감지
  const ev4 = I.stateEvidence({
    n: 3, time: [1.5, 7.5, 15.5], aux: {},
    level: [1, 0.02, 0.02],   // 간격은 A·B·A 인데 밝기는 첫 장만 밝다
  });
  check("근거가 어긋나면 conflict 로 표시", ev4.cadence && ev4.levels && ev4.conflict === true,
    `cadence=${ev4.cadence && ev4.cadence.assign.join("")} levels=${ev4.levels && ev4.levels.assign.join("")}`);
}


/* ================= 3b. 변조 깊이 · 공간 선택성 ============================= */
console.log("\n[3b] 선택성 — 초점 조작이 표적에만 국한됐는가");
{
  // 표적 하나만 껐다 켰다 하는 상황 (실측 110820 ROI#1 의 성질)
  const sel1 = stackTraces((i, k) => (i === 3 ? (k % 2 === 0 ? 900 : 0) : 900), 5, 301);
  const dep1 = I.modulationDepth(sel1.traces, sel1.blanks);
  const sug = I.suggestTarget(dep1);
  check("변조가 가장 큰 ROI 를 표적으로 제안", sug && sug.index === 3, `#${sug && sug.index}`);
  check("꺼진 쪽이 잡음 아래면 깊이를 하한으로 보고", dep1[3].isLowerBound === true, `깊이 ≥${dep1[3].depth.toFixed(1)}`);
  const s1 = I.selectivity(sel1.rois, dep1, 3);
  check("표적이 나머지보다 압도적", s1.ratioToOthers > 3, `${s1.target.depth.toFixed(1)} vs ${s1.maxOtherDepth.toFixed(2)}`);
  check("반응 없는 최근접 이웃으로 유효반경 상한 제시", !!s1.nearestQuiet,
    s1.nearestQuiet ? `#${s1.nearestQuiet.roi} @ ${s1.nearestQuiet.dist.toFixed(1)} px` : "없음");
  check("거리 추세 없음 (조작이 국소적)", s1.trend && s1.trend.graded === false);

  // 전체가 함께 꺼지는 상황 → 표적이 두드러지지 않아야 한다
  const sel2 = stackTraces((i, k) => (k === 0 ? 900 : 0), 3, 311);
  const dep2 = I.modulationDepth(sel2.traces, sel2.blanks);
  const s2 = I.selectivity(sel2.rois, dep2, I.suggestTarget(dep2).index);
  check("전역 소등이면 표적이 두드러지지 않는다", !(s2.ratioToOthers > 3), `비 ${s2.ratioToOthers.toFixed(2)}`);
  check("잠잠한 이웃이 없으면 유효반경 상한을 주지 않는다", s2.nearestQuiet === null);

  // 빔이 새는 상황: 거리에 따라 깊이가 줄어든다
  const near = [3, 4, 7];   // 표적 3 의 이웃으로 쓸 인덱스
  const sel3 = stackTraces((i, k) => {
    const f = i === 3 ? 1 : (near.includes(i) ? 0.6 : 0);
    return k % 2 === 0 ? 900 : 900 * (1 - f);
  }, 5, 321);
  const dep3 = I.modulationDepth(sel3.traces, sel3.blanks);
  const s3 = I.selectivity(sel3.rois, dep3, 3);
  check("주변까지 반응하면 반응한 이웃을 지목한다", !!s3.nearestLoud,
    s3.nearestLoud ? `#${s3.nearestLoud.roi} @ ${s3.nearestLoud.dist.toFixed(1)} px, 깊이 ${s3.nearestLoud.depth.toFixed(2)}` : "없음");
}

/* ============== 3c. 측정 설정 구조 근거 (num_cycle) ======================== */
console.log("\n[3c] 측정 설정 구조 — 파일이 적어 둔 값으로 기준 프레임을 가려내는가");
{
  const ev = I.stateEvidence({ n: 5, time: [1.5, 7.5, 15.5, 21.5, 29.5], aux: {},
    level: null, settings: { num_cycle: 2 } });
  check("n = 2·num_cycle+1 이면 첫 장을 기준으로 제외", ev.schedule && ev.schedule.assign.join(",") === "-1,0,1,0,1",
    ev.schedule && ev.schedule.assign.join(","));
  check("설정 근거와 간격 근거가 일치로 나온다 (제외 프레임은 비교에서 뺀다)",
    ev.conflict === false && ev.agree && ev.agree.some((p) => p.a === "schedule" && p.agree),
    JSON.stringify(ev.agree));
  const ev2 = I.stateEvidence({ n: 4, time: [0, 5, 10, 15], aux: {}, level: null, settings: { num_cycle: 2 } });
  check("프레임 수가 구조와 안 맞으면 근거를 만들지 않고 사유를 밝힌다",
    !ev2.schedule && /확인할 수 없습니다/.test(ev2.scheduleNote || ""), ev2.scheduleNote);
  const ev3 = I.stateEvidence({ n: 5, time: [0, 5, 10, 15, 20], aux: {}, level: null, settings: {} });
  check("num_cycle 이 없으면 그렇게 말한다", !ev3.schedule && /num_cycle/.test(ev3.scheduleNote || ""), ev3.scheduleNote);
}

/* =========================== 4. 대비 — 부호중립 ============================ */
console.log("\n[4] 대비 지표 — 방향을 숫자에 박지 않는가");
{
  const traces = [[100, 10], [100, 10], [10, 100]];
  const c = I.contrast(traces, [0, 1]);
  check("A÷B 와 B÷A 를 모두 낸다", isFinite(c.rows[0].ratioAB) && isFinite(c.rows[0].ratioBA),
    `${c.rows[0].ratioAB.toFixed(1)} / ${c.rows[0].ratioBA.toFixed(3)}`);
  check("Michelson 은 대칭·유계", Math.abs(c.rows[0].michelson) <= 1 && c.rows[0].michelson > 0 && c.rows[2].michelson < 0);
  check("입자마다 방향이 갈리면 mixedDirection 으로 경고", c.summary.mixedDirection === true);
  const c2 = I.contrast([[100, 10], [90, 9]], [0, 1]);
  check("한 방향이면 mixedDirection 은 거짓", c2.summary.mixedDirection === false);
}

/* ========================= 5. 정합 · ROI 전이 ============================== */
console.log("\n[5] 정합 — 이동량 회수와 '넘어오지 않은 입자' 구분");
{
  const parts = BASE.map((p) => Object.assign({ amp: 900 }, p));
  const A = synthFrame(NX, NY, parts, { seed: 31 });
  const SX = 12, SY = -7;
  const shifted = parts.map((p) => ({ x: p.x + SX, y: p.y + SY, amp: p.amp }));
  const B = synthFrame(NX, NY, shifted, { seed: 32 });
  const reg = I.registerShift(A, B, NX, NY, { maxShift: 32, bin: 2 });
  check("알려진 이동량 (12, −7) 회수", reg.ok && Math.abs(reg.dx - SX) <= 1 && Math.abs(reg.dy - SY) <= 1,
    `(${reg.dx}, ${reg.dy}) peak=${reg.peak.toFixed(3)} PSR=${reg.psr.toFixed(1)}`);
  check("무관한 이동에서의 상관은 0 근처", Math.abs(reg.nullLevel) < 0.05, reg.nullLevel.toFixed(4));

  const rois = BASE.map((p) => ({ xc: p.x, yc: p.y }));
  const bn = I.blankNoise(B, NX, NY, [], {}).sigma;
  const tr = I.transferRois(rois, reg, B, NX, NY, { sigmaBlank: bn });
  const nDet = tr.filter((t) => t.detected === true).length;
  check("전이 후 대부분의 입자에 상대가 있다", nDet >= 6, `${nDet}/8`);

  // 완전히 다른 배치 → 상대 없음
  const other = [{ x: 30, y: 30, amp: 900 }, { x: 220, y: 40, amp: 900 }, { x: 40, y: 220, amp: 900 }];
  const C = synthFrame(NX, NY, other, { seed: 33 });
  const reg2 = I.registerShift(A, C, NX, NY, { maxShift: 32, bin: 2 });
  const tr2 = I.transferRois(rois, reg2, C, NX, NY, { sigmaBlank: I.blankNoise(C, NX, NY, [], {}).sigma });
  check("다른 배치로는 대응 입자가 거의 없다", tr2.filter((t) => t.detected === true).length <= 1,
    `${tr2.filter((t) => t.detected === true).length}/8`);

  // 화면 밖으로 나간 ROI 는 '없어졌다'가 아니라 '시야 밖'으로 구분
  const tr3 = I.transferRois([{ xc: 10, yc: 10 }], { dx: -40, dy: -40 }, B, NX, NY, { sigmaBlank: bn });
  check("시야를 벗어난 ROI 는 미검출이 아니라 '화면 밖'", tr3[0].inside === false && /시야를 벗어/.test(tr3[0].note));
}

/* ========================== 6. 차영상 잡음 ================================= */
console.log("\n[6] 차영상 σ — 모형을 가정하지 않는가");
{
  const parts = BASE.map((p) => Object.assign({ amp: 900 }, p));
  const A = synthFrame(NX, NY, parts, { seed: 41, spikeRate: 0 });
  const B = synthFrame(NX, NY, parts, { seed: 42, spikeRate: 0 });
  const s = I.noiseFromPair(A, B);
  check("같은 상태 프레임쌍에서 읽기잡음 σ≈3 회수", Math.abs(s - 3) < 0.6, s.toFixed(3));
  const d = I.difference(A, B);
  check("차영상 중앙값은 0 근처", Math.abs(d.median) < 0.6, d.median.toFixed(3));
}

/* ============================ 7. 표시 환산 ================================= */
console.log("\n[7] 표시 환산");
{
  const a = Float32Array.from([0, 50, 100]);
  const lin = I.scaleToBytes(a, 0, 100, "lin");
  check("linear 환산 단조·경계", lin[0] === 0 && lin[2] === 255 && lin[1] > 100 && lin[1] < 160, Array.from(lin).join(","));
  const sq = I.scaleToBytes(a, 0, 100, "sqrt");
  check("sqrt 는 어두운 쪽을 끌어올린다", sq[1] > lin[1], `${sq[1]} > ${lin[1]}`);
  const dv = I.scaleDiverging(Float32Array.from([-10, 0, 10]), 10);
  check("발산 환산에서 0 이 중앙", dv[1] === 128 && dv[0] === 1 && dv[2] === 255, Array.from(dv).join(","));
}

console.log(fail ? `\n${fail}건 실패` : "\n전부 통과");
process.exit(fail ? 1 : 0);

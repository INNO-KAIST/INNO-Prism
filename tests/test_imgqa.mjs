/* 합성 격자 검증 — 특정 실측 이미지에 의존하지 않는다.
 * 파이프라인: 선형 광자수 → (톤커브 k) → 8bit 양자화 → (업스케일 U) → 검사 */
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { imageIntegrity } = require("../src/engine.js");

let seed = 12345;
function rnd() { // mulberry32 — 32bit 정확 연산
  seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function gauss() { let u = 0, v = 0; while (u === 0) u = rnd(); while (v === 0) v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

/** 선형 장면: 배경 + 여러 크기의 Gaussian (밝기 동적범위 확보) */
function scene(w, h, bgE, peakE, blobsIn) {
  const a = new Float64Array(w * h);
  const blobs = blobsIn || [[0.30, 0.35, 14, 1.0], [0.62, 0.30, 26, 0.55], [0.45, 0.68, 40, 0.28], [0.78, 0.72, 9, 0.8]];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = bgE;
    for (const [fx, fy, sg, amp] of blobs) {
      const dx = x - fx * w, dy = y - fy * h;
      s += peakE * amp * Math.exp(-(dx * dx + dy * dy) / (2 * sg * sg));
    }
    a[y * w + x] = s;
  }
  return a;
}
function shot(a, readE) { const o = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) o[i] = a[i] + Math.sqrt(a[i]) * gauss() + readE * gauss(); return o; }
function tone(a, k, fullE) { const o = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) { const t = Math.max(0, a[i]) / fullE;
    o[i] = Math.min(255, Math.round(255 * Math.pow(Math.min(1, t), k))); } return o; }
function affine(a, gain, off) { const o = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) o[i] = Math.min(255, Math.max(0, Math.round(a[i] * gain + off))); return o; }
function upscale(a, w, h, U, mode) {
  if (U === 1) return { d: a, w, h };
  const W = w * U, H = h * U, o = new Float64Array(W * H);
  for (let Y = 0; Y < H; Y++) for (let X = 0; X < W; X++) {
    if (mode === "nearest") { o[Y * W + X] = a[Math.min(h - 1, Math.floor(Y / U)) * w + Math.min(w - 1, Math.floor(X / U))]; continue; }
    const sx = (X + 0.5) / U - 0.5, sy = (Y + 0.5) / U - 0.5;
    const x0 = Math.floor(sx), y0 = Math.floor(sy), tx = sx - x0, ty = sy - y0;
    const cl = (v, m) => Math.min(m - 1, Math.max(0, v));
    const g = (xx, yy) => a[cl(yy, h) * w + cl(xx, w)];
    o[Y * W + X] = Math.round(
      g(x0, y0) * (1 - tx) * (1 - ty) + g(x0 + 1, y0) * tx * (1 - ty) +
      g(x0, y0 + 1) * (1 - tx) * ty + g(x0 + 1, y0 + 1) * tx * ty);
  }
  return { d: o, w: W, h: H };
}

/* JPEG 계열 블록 압축 모사 — 8×8 DCT-II → 양자화 → 역변환.
 * 실제 JPEG 인코더를 의존성으로 들이지 않고 **기구(mechanism) 자체**를 재현한다. */
const JPEG_Q50 = [
  16,11,10,16,24,40,51,61, 12,12,14,19,26,58,60,55, 14,13,16,24,40,57,69,56,
  14,17,22,29,51,87,80,62, 18,22,37,56,68,109,103,77, 24,35,55,64,81,104,113,92,
  49,64,78,87,103,121,120,101, 72,92,95,98,112,100,103,99];
function blockQuantize(a, w, h, quality) {
  const sc = quality < 50 ? 5000 / quality : 200 - 2 * quality;
  const Q = JPEG_Q50.map((v) => Math.max(1, Math.floor((v * sc + 50) / 100)));
  const C = (u) => (u === 0 ? Math.SQRT1_2 : 1);
  const cosT = [];
  for (let x = 0; x < 8; x++) { cosT.push([]); for (let u = 0; u < 8; u++)
    cosT[x].push(Math.cos((2 * x + 1) * u * Math.PI / 16)); }
  const o = Float64Array.from(a);
  const blk = new Float64Array(64), co = new Float64Array(64);
  for (let by = 0; by + 8 <= h; by += 8) for (let bx = 0; bx + 8 <= w; bx += 8) {
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) blk[y * 8 + x] = a[(by + y) * w + bx + x] - 128;
    for (let v = 0; v < 8; v++) for (let u = 0; u < 8; u++) {
      let s = 0;
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) s += blk[y * 8 + x] * cosT[x][u] * cosT[y][v];
      co[v * 8 + u] = Math.round(0.25 * C(u) * C(v) * s / Q[v * 8 + u]) * Q[v * 8 + u];
    }
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      let s = 0;
      for (let v = 0; v < 8; v++) for (let u = 0; u < 8; u++) s += C(u) * C(v) * co[v * 8 + u] * cosT[x][u] * cosT[y][v];
      o[(by + y) * w + bx + x] = Math.min(255, Math.max(0, Math.round(0.25 * s + 128)));
    }
  }
  return o;
}

const W0 = 460, H0 = 340, FULL = 4000;
function build({ U = 1, mode = "bilinear", k = 1, bgE = 30, peakE = 3400, readE = 3, gain = null, off = 0, blobs = null, jpegQ = null }) {
  const lin = shot(scene(W0, H0, bgE, peakE, blobs), readE);
  let img = gain !== null ? affine(lin, gain, off) : tone(lin, k, FULL);
  const r = upscale(img, W0, H0, U, mode);
  if (jpegQ) r.d = blockQuantize(r.d, r.w, r.h, jpegQ);
  return r;
}

const cases = [];
for (const U of [1, 2, 3, 4]) for (const mode of ["bilinear", "nearest"])
  cases.push({ name: `U=${U} ${mode} k=1`, opt: { U, mode }, expUp: U, expLin: "linear" });
// β = 2 − γ 이므로 γ > 2 만 "증명" 가능하고 1 < γ ≤ 2 는 read noise 지배와
// 구분되지 않는다(판정 보류). 이것이 이 검사의 원리적 검출 하한이다.
for (const g of [2.6, 2.2]) {
  cases.push({ name: `U=1 gamma=${g}`, opt: { k: 1 / g }, expUp: 1, expLin: "nonlinear" });
  // 알려진 한계: bilinear 리샘플 + 강한 톤커브가 겹치면 L 이 ~35% 과대평가된다.
  // 업스케일 "검출" 은 성공하지만 배수는 부정확 → 이 경우 배수를 µm/px 보정에
  // 쓰라고 권고하지 않는다(scaleSuggestion = null). 권고는 재촬영 하나뿐.
  cases.push({ name: `U=3 gamma=${g} (배수 부정확·문서화)`, opt: { U: 3, k: 1 / g }, expUp: ">=3", expLin: "nonlinear" });
}
// 검출 하한: γ ≲ 1.6 에서는 분산이 여전히 증가(b>0)하므로 read noise 지배와
// 구분되지 않는다. 미탐으로 **문서화**하고 임의 문턱으로 억지 판정하지 않는다.
cases.push({ name: "U=1 gamma=1.8 (하한 근처)", opt: { k: 1 / 1.8 }, expUp: 1, expLin: "판정불가" });
cases.push({ name: "U=1 gamma=1.5 (하한 아래·미탐)", opt: { k: 1 / 1.5 }, expUp: 1, expLin: "linear" });
cases.push({ name: "U=1 k=2.2 (역감마)", opt: { k: 2.2 }, expUp: 1, expLin: "nonlinear" });
cases.push({ name: "auto-contrast (affine)", opt: { gain: 0.062, off: 8 }, expUp: 1, expLin: "linear" });
cases.push({ name: "read-noise 지배 (선형)", opt: { bgE: 60, peakE: 1200, readE: 90 }, expUp: 1, expLin: "판정불가" });
cases.push({ name: "저동적범위 배경만", opt: { peakE: 6, bgE: 30, readE: 3 }, expUp: 1, expLin: "판정불가" });
// 실제 빔 프로파일 캡쳐의 기하: 넓은 배경에 σ≈3 px 단일 빔 + halo
const BEAMLIKE = [[0.52, 0.48, 3.2, 1.0], [0.52, 0.48, 9, 0.06]];
cases.push({ name: "빔형 U=1 선형", opt: { blobs: BEAMLIKE }, expUp: 1, expLin: "linear" });
// 문서화된 한계 ②: 작고 날카로운 빔을 업스케일하면 보간이 잡음을 뭉개서
// "분산 대 밝기" 관계 자체가 무너진다 → 선형성 검증 불가. 즉 화면 캡쳐는
// 스케일만 틀리는 게 아니라 **선형성을 검증할 근거까지 없앤다**.
// 선형성을 확인하려면 빔을 일부러 디포커스해 넓게 편 프레임을 한 번 찍어야 한다.
cases.push({ name: "빔형 U=3 bilinear 선형(검증불가)", opt: { U: 3, blobs: BEAMLIKE }, expUp: 3, expLin: "판정불가" });
cases.push({ name: "빔형 U=3 bilinear γ=2.6(검증불가)", opt: { U: 3, k: 1 / 2.6, blobs: BEAMLIKE }, expUp: ">=3", expLin: "판정불가" });
// 블록 압축(JPEG 계열): 무손실이면 L=1 인 영상이 압축만으로 업스케일 오탐을 낸다.
// 게이트는 이를 검출해 배수 보고를 **보류**해야 하고, 선형성 판정은 유지되어야 한다.
// 문서화된 한계 ③: 압축이 잡음을 거의 지워버리면(구조 가드가 모든 빈을 폐기)
// 선형성 검증 자체가 불가능해진다. 안전한 방향의 미판정이므로 그대로 둔다.
cases.push({ name: "블록압축 q85 · 선형(검증불가)", opt: { jpegQ: 85 }, expUp: "blocked", expLin: "판정불가" });
cases.push({ name: "블록압축 q70 · 선형 · U=1", opt: { jpegQ: 70 }, expUp: "blocked", expLin: "linear" });
cases.push({ name: "블록압축 q85 · gamma=2.6", opt: { jpegQ: 85, k: 1 / 2.6 }, expUp: "blocked", expLin: "nonlinear" });
cases.push({ name: "U=2 nearest gamma=2.6", opt: { U: 2, mode: "nearest", k: 1 / 2.6 }, expUp: 2, expLin: "nonlinear" });

let fail = 0;
console.log("case                              L      factor  exp   β         b      R²   판정        기대        결과");
for (const c of cases) {
  seed = 4242;
  const im = build(c.opt);
  const r = imageIntegrity(im.d, im.w, im.h);
  const up = r.upscale, li = r.linearity;
  const fac = up.ok ? up.factor : NaN;
  const verdict = !li.ok ? "판정불가" : (li.verdict === "indeterminate" ? "판정불가" : li.verdict);
  const okUp = c.expUp === "blocked" ? (!!r.blocking?.blocked && up.ok && up.factor === null)
    : c.expUp === "any" ? true : c.expUp === ">=3" ? (up.ok && fac >= 3 && r.scaleSuggestion === null) : (up.ok && fac === c.expUp);
  const okLin = verdict === c.expLin;
  if (!okUp || !okLin) fail++;
  console.log(
    c.name.padEnd(32) +
    (up.ok ? up.L.toFixed(2) : "  - ").padStart(6) +
    String(fac).padStart(7) + String(c.expUp).padStart(6) + "  " +
    (li.ok ? li.beta.toFixed(2) : "  -").padStart(6) +
    (li.ok ? (li.b>=0?"+":"") + li.b.toExponential(1) : "  -").padStart(10) +
    (li.ok ? li.r2.toFixed(2) : "  -").padStart(6) + "  " +
    verdict.padEnd(11) + c.expLin.padEnd(11) +
    ((okUp && okLin) ? "PASS" : `FAIL${okUp ? "" : " up"}${okLin ? "" : " lin"}`) +
    (li.ok ? "" : "  <" + li.reason + ">"));
}
console.log(`\n${cases.length - fail}/${cases.length} PASS`);
process.exit(fail ? 1 : 0);

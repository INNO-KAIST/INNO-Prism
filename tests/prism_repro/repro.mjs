/* INNO Prism — 감마테스트 데이터가 드러낸 결함 재현 하네스 (2026-09-21)
 *
 * 실행:  node repro.mjs [engine.js 경로]
 *   자동 탐색: ../src/engine.js → ../../src/engine.js → ../../../Develop--INNO Prism/src/engine.js
 *   또는 환경변수 PRISM_ENGINE 로 지정.
 *
 * 입력:  beam_full_gray16.bin.gz  (1360×1024 uint16, 12-bit 값이 <<4 된 컨테이너)
 *        260921 E0032_L_g033_16b.TIF 의 채널 0. γ=0.33 선형·12-bit·포화 없음.
 *
 * 이 스크립트는 **현재 동작을 고정**한다. 수정 후에는 [TARGET] 행이 통과해야 하고
 * [CURRENT] 행은 바뀌어도 된다(바뀌는 것이 목적).
 */
import { createRequire } from "module";
import fs from "fs"; import zlib from "zlib"; import path from "path";
import { fileURLToPath } from "url";
const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const CANDIDATES = [
  process.argv[2], process.env.PRISM_ENGINE,
  path.resolve(here, "../src/engine.js"),                       // 저장소 tests/ 에 둔 경우
  path.resolve(here, "../../src/engine.js"),
  path.resolve(here, "../../../Develop--INNO Prism/src/engine.js"), // device_bash 마운트
].filter(Boolean);
const engPath = CANDIDATES.find((p) => fs.existsSync(p));
if (!engPath) { console.error("engine.js 를 찾지 못했습니다. 경로를 인자로 주세요.\n시도:\n  " + CANDIDATES.join("\n  ")); process.exit(2); }
const E = require(engPath);
console.log("engine:", engPath, "\n");

const W = 1360, H = 1024, N = W * H;
const raw = zlib.gunzipSync(fs.readFileSync(path.join(here, "beam_full_gray16.bin.gz")));
const v16 = new Uint16Array(raw.buffer, raw.byteOffset, N);
const v12 = Float64Array.from(v16, (v) => v / 16);              // 12-bit ADU
const g8  = Float64Array.from(v12, (v) => Math.round(v / 16));  // canvas 8-bit 경로
const g12 = Float64Array.from(v12, (v) => v * (255 / 4095));    // 12-bit 계조 유지

const UM = 0.1075;   // 명목 µm/px. 절대값은 미확정이나 비교는 비로만 한다.
let fail = 0;
const ck = (tag, name, ok, info) => {
  console.log(`  ${ok ? "PASS" : "FAIL"} [${tag}] ${name}${info ? " — " + info : ""}`);
  if (!ok) fail++;
};
const near = (a, b, rel) => Math.abs(a / b - 1) <= rel;

function bin(src, w0, h0, f) {
  if (f === 1) return { w: w0, h: h0, data: src };
  const w = Math.floor(w0 / f), h = Math.floor(h0 / f), o = new Float64Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0, c = 0;
    for (let dy = 0; dy < f; dy++) for (let dx = 0; dx < f; dx++) {
      const v = src[(y * f + dy) * w0 + (x * f + dx)];
      if (isFinite(v)) { s += v; c++; }
    }
    o[y * w + x] = c ? s / c : NaN;
  }
  return { w, h, data: o };
}
const curBin = (w, h) => Math.max(1, Math.ceil(Math.max(w, h) / 320));   // app.js:1853 현행 규칙

/** 제안하는 2-pass 비닝 선택 (설계안) */
const TARGET_FWHM = 6;
function chooseBin(src, w, h) {
  const fCap = curBin(w, h);
  const f0 = Math.max(1, Math.min(fCap, Math.ceil(Math.max(w, h) / 640)));
  const p1 = E.fitBeam(bin(src, w, h, f0), { satLevel: 254 });
  if (!p1.success) return { f: fCap, f0, fallback: true };
  const sMin = Math.min(p1.sx, p1.sy) * f0;                     // 원해상도 px
  const sTrue = Math.sqrt(Math.max(sMin * sMin - f0 * f0 / 12, 1e-6));  // box 분산 역보정
  const fwhm = 2.3548 * sTrue;
  return { f: Math.max(1, Math.min(fCap, Math.floor(fwhm / TARGET_FWHM))), f0, fwhmFull: fwhm, fCap };
}
function run(src, w, h, f, um) {
  const fit = E.fitBeam(bin(src, w, h, f), { satLevel: 254 });
  if (!fit.success) return null;
  const m = E.beamMetrics({ sx: fit.sx, sy: fit.sy, theta: fit.theta, src: "gauss" }, um * f);
  const md = E.beamMetrics({ sx: fit.moments.sigmaMajor, sy: fit.moments.sigmaMinor,
                             theta: fit.moments.theta, src: "d4sigma" }, um * f);
  return { f, A: m.areaPeakUm2, Ad4: md.areaPeakUm2, sampledFwhm: 2.3548 * Math.min(fit.sx, fit.sy),
           r2: fit.r2, ratio: fit.d4sAreaRatio };
}
/** 화면 캡쳐 모사: 캔버스 크기 유지, 센서 1/U 영역을 U배 확대 */
function screenZoom(src, w, h, U, cx, cy) {
  const o = new Float64Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sx = Math.round(cx + (x - w / 2) / U), sy = Math.round(cy + (y - h / 2) / U);
    o[y * w + x] = (sx >= 0 && sx < w && sy >= 0 && sy < h) ? src[sy * w + sx] : 0;
  }
  return o;
}

console.log("── A. 비닝 언더샘플링 ─────────────────────────────────────────");
const fCur = curBin(W, H);
const aCur = run(g8, W, H, fCur, UM);
const aOne = run(g8, W, H, 1, UM);
const pick = chooseBin(g8, W, H);
const aNew = run(g8, W, H, pick.f, UM);
console.log(`   현행 f=${fCur}: A_peak=${aCur.A.toFixed(4)} µm²  샘플링 FWHM=${aCur.sampledFwhm.toFixed(2)} binned px  d4sRatio=${aCur.ratio.toFixed(3)}`);
console.log(`   f=1     : A_peak=${aOne.A.toFixed(4)} µm²  샘플링 FWHM=${aOne.sampledFwhm.toFixed(2)} px          d4sRatio=${aOne.ratio.toFixed(3)}`);
console.log(`   2-pass f=${pick.f}: A_peak=${aNew.A.toFixed(4)} µm²  (1차 f0=${pick.f0}, 추정 FWHM_full=${pick.fwhmFull.toFixed(2)} px)`);
ck("CURRENT", "현행 규칙이 f=5 를 고른다", fCur === 5, `f=${fCur}`);
ck("CURRENT", "현행 f 에서 샘플링 FWHM < 4 px (언더샘플링)", aCur.sampledFwhm < 4, `${aCur.sampledFwhm.toFixed(2)} px`);
ck("CURRENT", "현행 A_peak 가 f=1 대비 2배 이상", aCur.A / aOne.A > 2, `×${(aCur.A / aOne.A).toFixed(3)}`);
ck("TARGET",  "2-pass 가 샘플링 FWHM ≥ 6 px 를 확보", aNew.sampledFwhm >= 6, `${aNew.sampledFwhm.toFixed(2)} px`);
ck("TARGET",  "2-pass A_peak 가 f=1 과 5% 이내", near(aNew.A, aOne.A, 0.05), `${aNew.A.toFixed(4)} vs ${aOne.A.toFixed(4)}`);

console.log("\n── A'. 경로 무관성 (1:1 원본 vs 3× 화면캡쳐 모사) ─────────────");
const z = screenZoom(g8, W, H, 3, 685, 508);
const zPick = chooseBin(z, W, H);
const zCur = run(z, W, H, curBin(W, H), UM / 3);
const zNew = run(z, W, H, zPick.f, UM / 3);
console.log(`   현행  : 원본 ${aCur.A.toFixed(4)}  vs  화면캡쳐 ${zCur.A.toFixed(4)}   불일치 ×${(aCur.A / zCur.A).toFixed(3)}`);
console.log(`   2-pass: 원본 ${aNew.A.toFixed(4)}  vs  화면캡쳐 ${zNew.A.toFixed(4)} (f=${zPick.f})  불일치 ×${(aNew.A / zNew.A).toFixed(3)}`);
ck("CURRENT", "현행은 같은 빔을 두 경로에서 2배 이상 다르게 잰다", aCur.A / zCur.A > 2, `×${(aCur.A / zCur.A).toFixed(3)}`);
ck("TARGET",  "2-pass 는 두 경로가 10% 이내로 일치", near(aNew.A, zNew.A, 0.10), `×${(aNew.A / zNew.A).toFixed(3)}`);

console.log("\n── B. 비트깊이 (canvas 8-bit vs 12-bit 유지, f=1) ─────────────");
const b8 = run(g8, W, H, 1, UM), b12 = run(g12, W, H, 1, UM);
console.log(`   8-bit : Gauss ${b8.A.toFixed(4)}  D4σ ${b8.Ad4.toFixed(4)}  ratio ${b8.ratio.toFixed(3)}  R²=${b8.r2.toFixed(3)}`);
console.log(`   12-bit: Gauss ${b12.A.toFixed(4)}  D4σ ${b12.Ad4.toFixed(4)}  ratio ${b12.ratio.toFixed(3)}  R²=${b12.r2.toFixed(3)}`);
ck("CURRENT", "8-bit 경로가 Gaussian 면적을 20% 이상 부풀린다", b8.A / b12.A > 1.20, `+${(100 * (b8.A / b12.A - 1)).toFixed(1)}%`);
ck("CURRENT", "8-bit 경로가 d4sAreaRatio 를 30% 이상 바꾼다", Math.abs(b8.ratio / b12.ratio - 1) > 0.30, `${b8.ratio.toFixed(3)} vs ${b12.ratio.toFixed(3)}`);

console.log("\n── C / D. imageIntegrity ──────────────────────────────────────");
const q = E.imageIntegrity(g8, W, H);
console.log(`   upscale L=${q.upscale.L.toFixed(3)} upscaled=${q.upscale.upscaled} · blocking ratio=${q.blocking.ratio.toFixed(3)} blocked=${q.blocking.blocked}`);
console.log(`   linearity verdict=${q.linearity.verdict ?? "(ok:false)"} · clean=${q.clean} · issues=${q.issues.map(i => i.kind).join(",") || "none"}`);
ck("D·OK",    "1:1 카메라 파일을 업스케일로 오판하지 않는다", q.upscale.ok && !q.upscale.upscaled, `L=${q.upscale.L.toFixed(3)}`);
ck("D·OK",    "블록 압축으로 오판하지 않는다", q.blocking.ok && !q.blocking.blocked, `ratio=${q.blocking.ratio.toFixed(3)}`);
ck("CURRENT", "정상 파일인데 선형성 판정에 실패한다", !q.linearity.ok || q.linearity.verdict === "indeterminate",
   q.linearity.ok ? q.linearity.indeterminateWhy : q.linearity.reason);
ck("CURRENT", "그 결과 clean=false 가 된다", q.clean === false, `issues: ${q.issues.map(i => i.kind + "/" + i.severity).join(", ")}`);
ck("TARGET",  "수정 후: 구조적 판정불가는 clean 을 내리지 않아야 한다", q.clean === true,
   "← 수정 전에는 FAIL 이 정상. 이 줄이 PASS 가 되면 C 완료");

console.log(`\n${fail} FAIL / ${fail === 0 ? "모두 통과" : "위 [TARGET] 항목이 수정 대상"}`);

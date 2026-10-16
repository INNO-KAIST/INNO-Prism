/* INNO Prism — 비닝 배수 2-pass 선택 검사 (v3.15)
 *
 * `prism_repro/repro.mjs` 는 **설계안 프로토타입**을 검증한다. 이 검사는 실제로
 * 출하되는 `engine.js` 의 `chooseBinFactor()` 를 같은 실측 데이터로 검증한다.
 * 둘을 나눠 두는 이유: 프로토타입이 통과해도 앱이 그걸 쓰지 않으면 아무 의미가 없다.
 *
 * 실측 입력: 260921 E0032_L_g033_16b.TIF 채널 0 (1360×1024, γ=0.33 선형, 12-bit, 포화 없음)
 * 실행: node tests/test_binpick.mjs
 */
import { createRequire } from "module";
import fs from "fs"; import zlib from "zlib"; import path from "path";
import { fileURLToPath } from "url";
const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const E = require(path.resolve(here, "../src/engine.js"));
const DATA = path.resolve(here, "prism_repro/beam_full_gray16.bin.gz");

let fail = 0, skipped = 0;
const ck = (n, ok, info) => { console.log(`  ${ok ? "PASS" : "FAIL"} ${n}${info ? " — " + info : ""}`); if (!ok) fail++; };
const near = (a, b, rel) => Math.abs(a / b - 1) <= rel;

/* ---------------------- 합성 자료: 실측 없이도 도는 부분 ------------------- */
function synthBeam(w, h, sigma, opt) {
  const o = Object.assign({ amp: 180, bg: 12, noise: 1.2, seed: 5 }, opt || {});
  let s = o.seed >>> 0;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  const g = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const d = new Float64Array(w * h);
  const cx = w / 2, cy = h / 2, s2 = 2 * sigma * sigma;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = x - cx, dy = y - cy;
    d[y * w + x] = o.bg + o.amp * Math.exp(-(dx * dx + dy * dy) / s2) + o.noise * g();
  }
  return d;
}

console.log("[1] 규칙의 성질 (합성)");
{
  const W = 1360, H = 1024;
  const cap = Math.max(1, Math.ceil(Math.max(W, H) / 320));   // 이전 규칙 = 5

  // 작은 스팟(σ=4 → FWHM 9.4 px): 비닝하면 안 된다
  const small = E.chooseBinFactor(synthBeam(W, H, 4), W, H, { satLevel: 254 });
  ck("작은 스팟은 f=1 을 고른다", small.f === 1 && small.by === "spot", `f=${small.f} (${small.by}, FWHM≈${small.fwhmFull?.toFixed(1)})`);

  // 큰 스팟(σ=30 → FWHM 70 px): 비닝해도 샘플링이 남으므로 상한까지 쓴다
  const big = E.chooseBinFactor(synthBeam(W, H, 30), W, H, { satLevel: 254 });
  ck("큰 스팟은 상한까지 비닝한다", big.f === cap && big.by === "cap", `f=${big.f}/${cap} (${big.by}, FWHM≈${big.fwhmFull?.toFixed(1)})`);

  // 중간 스팟: 비닝 후에도 targetFwhm 이상이 남아야 한다
  for (const sig of [8, 12, 18, 25]) {
    const src = synthBeam(W, H, sig);
    const p = E.chooseBinFactor(src, W, H, { satLevel: 254 });
    const fit = E.fitBeam(E.binDown(src, W, H, p.f), { satLevel: 254 });
    const sampled = 2.3548 * Math.min(fit.sx, fit.sy);
    ck(`σ=${sig}: 비닝 후 샘플링 FWHM ≥ 6 px`, sampled >= 6, `f=${p.f} → ${sampled.toFixed(2)} px`);
  }

  // **이전 규칙을 절대 넘지 않는다** — 비용·메모리가 나빠지지 않아야 한다
  let overCap = 0;
  for (const sig of [3, 5, 8, 12, 18, 25, 40]) {
    const p = E.chooseBinFactor(synthBeam(W, H, sig), W, H, { satLevel: 254 });
    if (p.f > cap || p.f < 1) overCap++;
  }
  ck("선택한 f 가 언제나 [1, 이전규칙] 안에 있다", overCap === 0, `상한 ${cap}`);

  // 상한이 1인 작은 이미지는 1차 피팅 없이 즉시 반환 (불필요한 비용 금지)
  const tiny = E.chooseBinFactor(synthBeam(200, 200, 5), 200, 200, { satLevel: 254 });
  ck("상한이 1이면 1차 피팅을 돌리지 않는다", tiny.f === 1 && tiny.by === "cap" && tiny.f0 === 1);

  // 피팅이 실패하는 입력(빔 없음) → 이전 규칙으로 후퇴하고 그렇게 표시한다
  const flat = new Float64Array(W * H).fill(10);
  const fb = E.chooseBinFactor(flat, W, H, { satLevel: 254 });
  ck("1차 피팅 실패 시 이전 규칙으로 후퇴하고 by='fallback'", fb.f === cap && fb.by === "fallback", `f=${fb.f} (${fb.by})`);
}

console.log("\n[2] box 분산 역보정이 실제로 작동하는가 (합성)");
{
  // 비닝 = 폭 f 의 box convolution → σ_meas² ≈ σ_true² + f²/12.
  // 역보정이 없으면 f 가 커질수록 추정 FWHM 이 부풀려진다.
  const W = 1360, H = 1024, SIG = 10;
  const src = synthBeam(W, H, SIG);
  const truth = 2.3548 * SIG;
  const p = E.chooseBinFactor(src, W, H, { satLevel: 254 });
  ck("추정 원해상도 FWHM 이 참값의 10% 이내", near(p.fwhmFull, truth, 0.10),
    `${p.fwhmFull.toFixed(2)} vs 참값 ${truth.toFixed(2)}`);
}

console.log("\n[3] 실측 — 260921 감마테스트 빔");
if (!fs.existsSync(DATA)) {
  console.log(`  SKIP — ${path.relative(here, DATA)} 가 없습니다 (prism_repro 키트 미복사)`);
  skipped++;
} else {
  const W = 1360, H = 1024;
  const raw = zlib.gunzipSync(fs.readFileSync(DATA));
  const v16 = new Uint16Array(raw.buffer, raw.byteOffset, W * H);
  const g8 = Float64Array.from(v16, (v) => Math.round(v / 16 / 16));   // canvas 8-bit 경로
  const UM = 0.1075;

  const run = (src, w, h, f, um) => {
    const fit = E.fitBeam(E.binDown(src, w, h, f), { satLevel: 254 });
    const m = E.beamMetrics({ sx: fit.sx, sy: fit.sy, theta: fit.theta, src: "gauss" }, um * f);
    return { A: m.areaPeakUm2, sampled: 2.3548 * Math.min(fit.sx, fit.sy), r2: fit.r2 };
  };
  const cap = Math.max(1, Math.ceil(Math.max(W, H) / 320));
  const pick = E.chooseBinFactor(g8, W, H, { satLevel: 254 });
  const aNew = run(g8, W, H, pick.f, UM);
  const aOne = run(g8, W, H, 1, UM);
  const aOld = run(g8, W, H, cap, UM);
  console.log(`   이전 규칙 f=${cap}: A=${aOld.A.toFixed(4)} µm² · 샘플링 FWHM ${aOld.sampled.toFixed(2)} px`);
  console.log(`   f=1          : A=${aOne.A.toFixed(4)} µm² · 샘플링 FWHM ${aOne.sampled.toFixed(2)} px`);
  console.log(`   2-pass f=${pick.f}   : A=${aNew.A.toFixed(4)} µm² · 추정 원해상도 FWHM ${pick.fwhmFull.toFixed(2)} px (${pick.by})`);

  ck("실측 빔에서 f=1 을 고른다", pick.f === 1, `f=${pick.f}`);
  ck("샘플링 FWHM ≥ 6 px 확보", aNew.sampled >= 6, `${aNew.sampled.toFixed(2)} px`);
  ck("A_peak 가 f=1 과 5% 이내", near(aNew.A, aOne.A, 0.05), `${aNew.A.toFixed(4)} vs ${aOne.A.toFixed(4)}`);
  ck("이전 규칙은 이 빔을 2배 이상 부풀렸다 (결함 재현)", aOld.A / aOne.A > 2, `×${(aOld.A / aOne.A).toFixed(3)}`);

  // 경로 무관성 — 같은 빔을 3× 화면캡쳐로 찍은 것처럼 만들어 비교
  const zoom = (src, w, h, U, cx, cy) => {
    const o = new Float64Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const sx = Math.round(cx + (x - w / 2) / U), sy = Math.round(cy + (y - h / 2) / U);
      o[y * w + x] = (sx >= 0 && sx < w && sy >= 0 && sy < h) ? src[sy * w + sx] : 0;
    }
    return o;
  };
  const z = zoom(g8, W, H, 3, 685, 508);
  const zPick = E.chooseBinFactor(z, W, H, { satLevel: 254 });
  const zNew = run(z, W, H, zPick.f, UM / 3);
  const zOld = run(z, W, H, cap, UM / 3);
  console.log(`   경로 불일치 — 이전 ×${(aOld.A / zOld.A).toFixed(3)} · 2-pass ×${(aNew.A / zNew.A).toFixed(3)} (화면캡쳐 f=${zPick.f})`);
  ck("2-pass 는 1:1 원본과 3× 화면캡쳐가 10% 이내로 일치", near(aNew.A, zNew.A, 0.10), `×${(aNew.A / zNew.A).toFixed(3)}`);
  ck("이전 규칙은 두 경로가 2배 이상 어긋났다 (결함 재현)", aOld.A / zOld.A > 2, `×${(aOld.A / zOld.A).toFixed(3)}`);
}

console.log("\n[4] 포화 마스킹 순서 (E)");
{
  // 원해상도에서 마스크하지 않으면 포화 화소가 비닝 평균에 묻혀 문턱을 빠져나간다.
  const W = 640, H = 640, SAT = 254;
  const src = synthBeam(W, H, 18, { amp: 400, bg: 20, noise: 0.8 });   // 코어가 포화
  for (let i = 0; i < src.length; i++) if (src[i] > SAT) src[i] = 255;  // 센서 클리핑 모사
  const nSat = src.reduce((a, v) => a + (v >= SAT ? 1 : 0), 0);
  ck("합성 입력에 포화 화소가 있다", nSat > 50, `${nSat}px`);

  const f = 4;
  // (a) 비닝 후 마스킹 — 옛 순서
  const after = E.binDown(src, W, H, f);
  const nSatAfter = after.data.reduce((a, v) => a + (v >= SAT ? 1 : 0), 0);
  // (b) 원해상도 마스킹 후 비닝 — 새 순서
  const pre = Float64Array.from(src, (v) => (v >= SAT ? NaN : v));
  const before = E.binDown(pre, W, H, f);
  const nNaN = before.data.reduce((a, v) => a + (isFinite(v) ? 0 : 1), 0);

  ck("옛 순서: 포화가 비닝 평균에 묻혀 문턱을 빠져나간다",
    nSatAfter < nSat / (f * f), `비닝 후 ${nSatAfter}개 (원해상도 ${nSat}개 → ${f}²로 나누면 ${Math.round(nSat / (f * f))}개여야)`);
  ck("새 순서: 포화가 NaN 으로 남아 피팅에서 제외된다", nNaN > 0, `NaN bin ${nNaN}개`);
  // 그리고 σ 추정이 달라진다 — 포화를 섞으면 코어가 눌려 σ 가 커진다
  const fitAfter = E.fitBeam(after, { satLevel: SAT });
  const fitBefore = E.fitBeam(before, { satLevel: SAT });
  const dSig = Math.abs(Math.min(fitAfter.sx, fitAfter.sy) / Math.min(fitBefore.sx, fitBefore.sy) - 1);
  console.log(`   σ_min: 옛 순서 ${Math.min(fitAfter.sx, fitAfter.sy).toFixed(4)} · 새 순서 ${Math.min(fitBefore.sx, fitBefore.sy).toFixed(4)} (차이 ${(dSig * 100).toFixed(1)}%)`);
  ck("두 순서가 실제로 다른 σ 를 낸다 (순서가 무의미하지 않다)", dSig > 0.005, `${(dSig * 100).toFixed(2)}%`);
}

console.log(fail ? `\n${fail}건 실패` : `\n전부 통과${skipped ? ` (${skipped}건 건너뜀)` : ""}`);
process.exit(fail ? 1 : 0);

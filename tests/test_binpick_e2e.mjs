/* INNO Prism — 비닝 2-pass · 포화 마스킹 E2E (v3.15)
 *
 * `test_binpick.mjs` 는 engine 계층만 본다. 이 검사는 **실제 업로드 핸들러**를 통과시켜
 * 앱이 그 계층을 정말 쓰는지, 그리고 산출값이 화면·내보내기에 실제로 나오는지 확인한다.
 * 계층은 고쳤는데 앱이 옛 경로를 그대로 쓰는 사고를 막기 위한 것이다.
 *
 * fixture: `tests/prism_repro/beam_full_gray16.bin.gz` → 무손실 24-bit BMP 로 변환해 사용.
 *   260921 E0032_L_g033_16b.TIF 채널 0 (1360×1024, γ=0.33 선형, 12-bit, 포화 없음)
 *   canvas 8-bit 경로와 같은 값이 되도록 12-bit → 8-bit 로 낮춰 기록한다.
 *
 * 실행: node tests/test_binpick_e2e.mjs
 *   (Playwright 는 클라우드 컨테이너에만 있다. chromium 은 /opt/pw-browsers/chromium)
 */
import { chromium } from "playwright";
import fs from "fs"; import zlib from "zlib";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { writeBmp, tmpDir } from "./fixture_bmp.mjs";
const here = dirname(fileURLToPath(import.meta.url));
const HTML = "file://" + join(here, "..", "INNO Prism.html").replace(/\\/g, "/");
const SRC = join(here, "prism_repro", "beam_full_gray16.bin.gz");
let fail = 0;
const ck = (n, ok, i) => { console.log(`  ${ok ? "PASS" : "FAIL"} ${n}${i ? " — " + i : ""}`); if (!ok) fail++; };

if (!fs.existsSync(SRC)) {
  console.log(`SKIP — ${SRC} 가 없습니다 (prism_repro 키트 미복사)`);
  process.exit(0);
}

/* ---- fixture: 무손실 BMP 로 기록 (JPEG 등 손실 포맷이면 무결성 검사가 걸린다) ---- */
const W = 1360, H = 1024;
const raw = zlib.gunzipSync(fs.readFileSync(SRC));
const v16 = new Uint16Array(raw.buffer, raw.byteOffset, W * H);
const g8 = Uint8Array.from(v16, (v) => Math.max(0, Math.min(255, Math.round(v / 16 / 16))));
const tmp = tmpDir("bin");
const BMP = join(tmp, "beam_repro.bmp");
writeBmp(BMP, g8, W, H);
// 포화를 일부러 심은 사본 — E(포화 마스킹 순서) 확인용
const gSat = Uint8Array.from(g8);
let planted = 0;
{
  // 빔 코어 근처 9×9 를 255 로 — 센서 클리핑 모사
  let bx = 0, by = 0, bv = -1;
  for (let i = 0; i < g8.length; i++) if (g8[i] > bv) { bv = g8[i]; bx = i % W; by = (i / W) | 0; }
  for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
    const x = bx + dx, y = by + dy;
    if (x >= 0 && y >= 0 && x < W && y < H) { gSat[y * W + x] = 255; planted++; }
  }
}
const BMP_SAT = join(tmp, "beam_repro_sat.bmp");
writeBmp(BMP_SAT, gSat, W, H);
console.log(`fixture: ${W}×${H} BMP · 포화 심은 사본 ${planted}px\n`);

const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
const p = await (await b.newContext()).newPage();
const perr = [];
p.on("pageerror", (e) => perr.push(e.message.slice(0, 200)));
await p.goto(HTML);
await p.waitForFunction(() => window.PrismEngine && window.PrismFit, null, { timeout: 60000 });
await p.click("#calib-btn");
for (const [sel, v] of [["#cb-pitch", "6.45"], ["#cb-mag", "60"], ["#cb-lambda", "1064"]]) {
  if (await p.$(sel)) { await p.fill(sel, v); await p.dispatchEvent(sel, "change"); }
}

async function upload(file) {
  /* 업로드 대기의 **경쟁 조건 방지.** 상태줄에는 이전 업로드의 "피팅 완료" 가 그대로
   * 남아 있으므로, setInputFiles 직후 바로 폴링하면 조건이 이미 참이라 **이전 파일의
   * 상태를 읽고 끝난다**(실제로 음성 대조가 직전 파일 결과를 읽어 오판했다).
   * 업로드 전에 표식을 넣어 "이번 업로드가 끝났는지"를 본다. */
  await p.evaluate(() => { document.querySelector("#cb-beam-status").textContent = "__PENDING__"; });
  await p.setInputFiles("#cb-img-input", file);
  await p.waitForFunction(() => {
    const t = document.querySelector("#cb-beam-status").textContent || "";
    return !t.includes("__PENDING__") && (t.includes("피팅 완료") || t.includes("실패"));
  }, null, { timeout: 240000 });
  return p.evaluate(() => ({
    html: document.querySelector("#cb-beam-status").innerHTML,
    text: document.querySelector("#cb-beam-status").textContent,
    beam: {
      sx: App.calib.beam.sx, sy: App.calib.beam.sy, binFactor: App.calib.beam.binFactor,
      sampledFwhmPx: App.calib.beam.sampledFwhmPx, binChosenBy: App.calib.beam.binChosenBy,
      binFwhmFullPx: App.calib.beam.binFwhmFullPx, binCap: App.calib.beam.binCap,
      nSatFull: App.calib.beam.nSatFull, nSat: App.calib.beam.nSat, r2: App.calib.beam.r2,
    },
    m: App.calib.metrics,
    stamp: App.calib.metricsStamp,
  }));
}

console.log("[1] 1:1 카메라 파일 — 2-pass 가 앱에서 실제로 쓰이는가");
const t0 = Date.now();
const a = await upload(BMP);
const dt = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`   f 선택=${a.beam.binChosenBy} · 샘플링 FWHM ${a.beam.sampledFwhmPx?.toFixed(2)} px · 추정 원해상도 FWHM ${a.beam.binFwhmFullPx?.toFixed(2)} px · ${dt}s`);
console.log(`   A_peak = ${a.m.areaPeakUm2.toFixed(4)} µm²  R²=${a.beam.r2.toFixed(3)}`);

ck("스팟 크기로 f 를 골랐다 (상한 규칙이 아니라)", a.beam.binChosenBy === "spot", a.beam.binChosenBy);
ck("이전 규칙의 상한이 5 로 기록됐다", a.beam.binCap === 5, String(a.beam.binCap));
ck("샘플링 FWHM ≥ 6 px 확보", a.beam.sampledFwhmPx >= 6, `${a.beam.sampledFwhmPx?.toFixed(2)} px`);
ck("샘플링 FWHM 이 화면에 표시된다", /샘플링 FWHM/.test(a.text), "");
ck("언더샘플링 경고가 뜨지 않는다", !/언더샘플링/.test(a.text), "");
ck("f 선택 근거가 화면에 표시된다", /스팟 크기 기준/.test(a.text), "");
// A_peak: engine 계층 검사에서 확인한 f=1 값 1.3700 µm² (µm/px 0.1075 기준)
ck("A_peak 가 f=1 기준값과 5% 이내", Math.abs(a.m.areaPeakUm2 / 1.3700 - 1) <= 0.05,
  `${a.m.areaPeakUm2.toFixed(4)} vs 1.3700`);
ck("metricsStamp 에 비닝 배수가 남는다", isFinite(a.stamp.binFactor) && a.stamp.binFactor === a.beam.binFactor,
  `stamp ${a.stamp.binFactor} · beam ${a.beam.binFactor}`);

console.log("\n[2] 내보내기 provenance");
const ex = await p.evaluate(() => {
  let out = null; const o = window.downloadText;
  window.downloadText = (n, t) => { out = t; };
  exportCalibSession(); window.downloadText = o; return out;
});
const j = JSON.parse(ex);
ck("binChosenBy 가 기록된다", j.beam.binChosenBy === "spot", String(j.beam.binChosenBy));
ck("sampledFwhmPx 가 기록된다", isFinite(j.beam.sampledFwhmPx) && j.beam.sampledFwhmPx >= 6, String(j.beam.sampledFwhmPx));
ck("binCap · binFwhmFullPx 가 기록된다", isFinite(j.beam.binCap) && isFinite(j.beam.binFwhmFullPx),
  `cap=${j.beam.binCap} fwhmFull=${j.beam.binFwhmFullPx?.toFixed(2)}`);
ck("nSatFull 이 기록된다", j.beam.nSatFull === 0, String(j.beam.nSatFull));

console.log("\n[3] 포화 마스킹 순서 (E) — 원해상도에서 잡히는가");
const s = await upload(BMP_SAT);
console.log(`   nSatFull=${s.beam.nSatFull} · 비닝 후 nSat=${s.beam.nSat} · f=${s.beam.binChosenBy}`);
ck("원해상도에서 포화 화소를 잡는다", s.beam.nSatFull >= planted * 0.9, `${s.beam.nSatFull} / 심은 ${planted}`);
ck("포화 제외가 화면에 표시된다", /포화 .*원해상도에서 제외/.test(s.text), "");

console.log("\n[4] metricsStale — 비닝 배수가 바뀌면 옛 metrics 를 stale 로 본다");
const stale = await p.evaluate(() => {
  const c = App.calib;
  const before = calibMetricsStale(c);
  const keep = c.beam.binFactor;
  c.beam.binFactor = keep + 1;                 // 같은 파일을 다른 f 로 다시 피팅한 상황 모사
  const after = calibMetricsStale(c);
  c.beam.binFactor = keep;
  return { before: before && before.why, after: after && after.why };
});
ck("바뀌기 전에는 stale 아님", !stale.before, String(stale.before));
ck("비닝이 바뀌면 stale 로 잡는다", /비닝/.test(stale.after || ""), String(stale.after));

ck("페이지 오류 없음", perr.length === 0, perr.slice(0, 2).join(" | "));
await b.close();
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
console.log(fail ? `\n${fail} FAILURES` : "\nALL PASS");
process.exit(fail ? 1 : 0);

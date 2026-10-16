/* INNO Prism — 선형성 적용가능성 분리 · 촬영 감마 정합 E2E (v3.16)
 *
 * 확인하는 것:
 *   1) 정상 1:1 파일이 "선형성 검사 적용 안 됨" 으로 나오고 clean 을 내리지 않는다
 *   2) 그런데 **통과했다고 말하지도 않는다** — verified.linearity=false 가 화면에 남는다
 *   3) 리샘플·블록압축된 영상에서는 면제되지 않는다 (같은 증상이지만 원인이 다르다)
 *   4) 촬영 감마 ↔ 되돌리기 감마 정합 경고가 실측 앵커(0.33·0.50)대로 동작한다
 *
 * 실행: node tests/test_linapply_e2e.mjs
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

if (!fs.existsSync(SRC)) { console.log(`SKIP — ${SRC} 없음`); process.exit(0); }

const W = 1360, H = 1024;
const raw = zlib.gunzipSync(fs.readFileSync(SRC));
const v16 = new Uint16Array(raw.buffer, raw.byteOffset, W * H);
const g8 = Uint8Array.from(v16, (v) => Math.max(0, Math.min(255, Math.round(v / 16 / 16))));
const tmp = tmpDir("lin");
const BMP = join(tmp, "ok.bmp");
writeBmp(BMP, g8, W, H);

/* 3× bilinear 업스케일본 — 같은 "기울기 식별 불가" 증상을 내지만 원인은 리샘플이다.
 * 이 경우까지 면제해 버리면 바로 그 검사가 잡아야 할 조작을 놓친다. */
const U = 3;
const up = new Uint8Array(W * H);
{
  const cx = 685, cy = 508;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const fx = cx + (x - W / 2) / U, fy = cy + (y - H / 2) / U;
    const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
    const at = (xx, yy) => (xx >= 0 && yy >= 0 && xx < W && yy < H) ? g8[yy * W + xx] : 0;
    const v = at(x0, y0) * (1 - tx) * (1 - ty) + at(x0 + 1, y0) * tx * (1 - ty)
            + at(x0, y0 + 1) * (1 - tx) * ty + at(x0 + 1, y0 + 1) * tx * ty;
    up[y * W + x] = Math.max(0, Math.min(255, Math.round(v)));
  }
}
const BMP_UP = join(tmp, "up3.bmp");
writeBmp(BMP_UP, up, W, H);

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
  return p.evaluate(() => {
    const q = App.calib.beam.integrity;
    return {
      text: document.querySelector("#cb-beam-status").textContent,
      clean: q.clean, verified: q.verified,
      issues: (q.issues || []).map((i) => i.kind),
      notes: (q.notes || []).map((n) => n.kind),
      verdict: q.linearity?.verdict, kind: q.linearity?.indeterminateKind,
      applicable: q.linearity?.applicable, L: q.upscale?.L, upscaled: q.upscale?.upscaled,
    };
  });
}

console.log("[1] 정상 1:1 파일 — 적용 불가를 issue 로 올리지 않는다");
const a = await upload(BMP);
console.log(`   verdict=${a.verdict}/${a.kind} applicable=${a.applicable} L=${a.L?.toFixed(3)} clean=${a.clean}`);
console.log(`   issues=[${a.issues.join(",")}] notes=[${a.notes.join(",")}]`);
ck("clean 이 내려가지 않는다", a.clean === true, `clean=${a.clean}`);
ck("linearity-unverified 가 issue 에 없다", !a.issues.includes("linearity-unverified"), a.issues.join(","));
ck("notes 에 linearity-not-applicable 로 남는다", a.notes.includes("linearity-not-applicable"), a.notes.join(","));
ck("applicable=false 로 표시된다", a.applicable === false, String(a.applicable));
ck("verified.linearity 는 false — 통과했다고 말하지 않는다", a.verified.linearity === false, JSON.stringify(a.verified));
ck("화면에 '적용 안 됨' 으로 나온다", /선형성 검사 적용 안 됨/.test(a.text), "");
ck("'판정 보류' 문구는 쓰지 않는다", !/선형성 판정 보류/.test(a.text), "");
ck("톤커브가 있다는 뜻이 아님을 명시", /톤커브가 있다는 뜻도, 없다는 뜻도 아니다/.test(a.text), "");

console.log("\n[2] 3× bilinear 업스케일본 — 같은 증상이지만 면제하지 않는다");
const u = await upload(BMP_UP);
console.log(`   verdict=${u.verdict}/${u.kind} applicable=${u.applicable} L=${u.L?.toFixed(3)} upscaled=${u.upscaled} clean=${u.clean}`);
ck("업스케일로 판정된다", u.upscaled === true || u.L > 1.5, `L=${u.L?.toFixed(3)}`);
ck("리샘플본은 선형성 면제를 받지 못한다", u.applicable !== false || u.issues.includes("upscale"),
  `applicable=${u.applicable} issues=[${u.issues.join(",")}]`);
ck("clean 은 내려간다 (업스케일이 잡혔으므로)", u.clean === false, `clean=${u.clean}`);

console.log("\n[3] 촬영 감마 ↔ 되돌리기 감마 정합 (실측 앵커 0.33 · 0.50)");
async function gam(cap, disp) {
  await p.fill("#cb-capgamma", cap === null ? "" : String(cap));
  await p.dispatchEvent("#cb-capgamma", "change");
  await p.fill("#cb-gamma", disp === 1 ? "" : String(disp));
  await p.dispatchEvent("#cb-gamma", "change");
  return p.evaluate(() => ({
    html: document.querySelector("#cb-capgamma-note").innerHTML,
    text: document.querySelector("#cb-capgamma-note").textContent,
    state: App.calib.captureGamma,
  }));
}
const g1 = await gam(0.33, 1);
ck("0.33 + γ1 → 일치", /일치/.test(g1.text) && /tag-High/.test(g1.html), g1.text.slice(0, 70));
const g2 = await gam(0.33, 2.2);
ck("0.33 인데 γ2.2 → 경고", /tag-Poor/.test(g2.html) && /1\b/.test(g2.text), g2.text.slice(0, 90));
const g3 = await gam(0.5, 2.0);
ck("0.50 + γ2.0 → 일치", /일치/.test(g3.text) && /tag-High/.test(g3.html), g3.text.slice(0, 70));
const g4 = await gam(0.5, 1);
ck("0.50 인데 보정 안 함 → 경고", /tag-Poor/.test(g4.html), g4.text.slice(0, 90));
const g5 = await gam(0.42, 1);
ck("측정되지 않은 값은 외삽하지 않고 그렇게 말한다",
  /실측된 앵커가 아닙니다/.test(g5.text) && /외삽/.test(g5.text), g5.text.slice(0, 100));
const g6 = await gam(null, 1);
ck("미기록이면 아무 말도 하지 않는다", g6.text.trim() === "" && g6.state === null, `"${g6.text.trim()}"`);

console.log("\n[4] 내보내기");
// [2] 에서 업스케일본을 올렸으므로 정상 파일 상태로 되돌린 뒤 확인한다
await upload(BMP);
await gam(0.33, 1);
const j = JSON.parse(await p.evaluate(() => {
  let out = null; const o = window.downloadText;
  window.downloadText = (n, t) => { out = t; };
  exportCalibSession(); window.downloadText = o; return out;
}));
ck("captureGamma 가 기록된다", j.captureGamma === 0.33, String(j.captureGamma));
ck("integrity.verified 가 기록된다", j.beam.integrity && j.beam.integrity.verified
  && j.beam.integrity.verified.linearity === false, JSON.stringify(j.beam?.integrity?.verified));
ck("notApplicable 목록이 기록된다",
  Array.isArray(j.beam.integrity.notApplicable) && j.beam.integrity.notApplicable.includes("linearity-not-applicable"),
  JSON.stringify(j.beam?.integrity?.notApplicable));

ck("페이지 오류 없음", perr.length === 0, perr.slice(0, 2).join(" | "));
await b.close();
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
console.log(fail ? `\n${fail} FAILURES` : "\nALL PASS");
process.exit(fail ? 1 : 0);

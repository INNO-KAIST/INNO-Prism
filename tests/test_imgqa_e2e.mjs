/* 업로드 무결성 게이트 E2E — 실제 캡쳐 파일이 앱의 업로드 경로를 그대로 지나
 * 경고를 띄우는지, 그리고 원본 1:1 합성 이미지에서는 오탐이 없는지 확인한다. */
import { chromium } from "playwright";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import fs from "fs";
import { PNG } from "pngjs";
const here = dirname(fileURLToPath(import.meta.url));
const HTML = "file://" + join(here, "..", "INNO Prism.html").replace(/\\/g, "/");
const UP = "/root/.claude/uploads/3654bf44-3ccd-56b1-b701-3d4ab07ce8d8";
let fail = 0;
const check = (n, ok, i) => { console.log(`  ${ok ? "PASS" : "FAIL"} ${n}${i ? " — " + i : ""}`); if (!ok) fail++; };

/* 오탐 대조군: 원본 1:1 · 선형 shot-noise 합성 빔 (앱 밖에서 만든 독립 파일) */
const W = 700, H = 520, tmp = "/tmp/native_beam.png";
{
  let sd = 987654321;
  const rnd = () => { sd |= 0; sd = (sd + 0x6D2B79F5) | 0; let t = Math.imul(sd ^ (sd >>> 15), 1 | sd);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const gs = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const png = new PNG({ width: W, height: H });
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const dx = x - W * 0.5, dy = y - H * 0.5;
    const s = 40 + 3200 * Math.exp(-(dx * dx + dy * dy) / (2 * 25)) + 260 * Math.exp(-(dx * dx + dy * dy) / (2 * 400));
    const e = s + Math.sqrt(s) * gs() + 3 * gs();
    const v = Math.max(0, Math.min(255, Math.round(255 * e / 4000)));
    const i = (y * W + x) * 4; png.data[i] = png.data[i+1] = png.data[i+2] = v; png.data[i+3] = 255;
  }
  fs.writeFileSync(tmp, PNG.sync.write(png));
}

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
const p = await (await browser.newContext()).newPage();
p.on("pageerror", (e) => console.log("[perr]", e.message.slice(0, 200)));
await p.goto(HTML);
await p.waitForFunction(() => window.PrismFit, null, { timeout: 60000 });
await p.click("#calib-btn");

async function upload(file) {
  await p.setInputFiles("#cb-img-input", file);
  await p.waitForFunction(() => {
    const t = document.querySelector("#cb-beam-status").textContent || "";
    return t.includes("피팅 완료") || t.includes("실패");
  }, null, { timeout: 120000 });
  return p.evaluate(() => ({
    html: document.querySelector("#cb-beam-status").innerHTML,
    q: (App.calib.beam && App.calib.beam.integrity) ? {
      L: App.calib.beam.integrity.upscale?.L,
      factor: App.calib.beam.integrity.upscale?.factor,
      lin: App.calib.beam.integrity.linearity?.ok ? App.calib.beam.integrity.linearity.verdict : "판정불가",
      sug: App.calib.beam.integrity.scaleSuggestion,
      action: App.calib.beam.integrity.action,
    } : null,
  }));
}

console.log("[원본 1:1 · 선형 합성 빔 — 오탐이 없어야 한다]");
let r = await upload(tmp);
console.log("   ", JSON.stringify(r.q));
check("업스케일 미검출", r.q && r.q.factor === 1, `factor=${r.q?.factor} L=${r.q?.L?.toFixed(2)}`);
check("경고 없음", !!r.q && !r.q.action, `action=${r.q?.action}`);
check("상태줄에 '원본 1:1' 표시", r.html.includes("원본 1:1"));

for (const [tag, f] of [["600 DMSP", "0553fe87-image.png"], ["950 DMSP", "8381d253-image.png"]]) {
  console.log(`[${tag} 실제 캡쳐 — 3× 업스케일이 잡혀야 한다]`);
  r = await upload(join(UP, f));
  console.log("   ", JSON.stringify(r.q));
  check("업스케일 3× 검출", r.q && r.q.factor === 3, `factor=${r.q?.factor} L=${r.q?.L?.toFixed(2)}`);
  check("재촬영 권고", !!(r.q && r.q.action && r.q.action.includes("재촬영")));
  check("선형성 미확인이면 µm/px 보정 제안 안 함",
    r.q.lin === "linear" ? !!r.q.sug : r.q.sug === null, `lin=${r.q.lin} sug=${JSON.stringify(r.q.sug)}`);
  check("상태줄에 '원본이 아님' 표시", r.html.includes("원본이 아님"));
}
await browser.close();
console.log(fail ? `\n${fail} FAILURES` : "\nALL PASS");
process.exit(fail ? 1 : 0);

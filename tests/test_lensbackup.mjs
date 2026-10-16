/* 공유 미설정(로컬 전용) 상태에서의 안전망: 내보내기 → 가져오기 왕복 */
import { chromium } from "playwright";
import fs from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
const here = dirname(fileURLToPath(import.meta.url));
const HTML = "file://" + join(here, "..", "INNO Prism.html").replace(/\\/g, "/");

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
let fail = 0;
const check = (n, ok, i) => { console.log(`  ${ok ? "PASS" : "FAIL"} ${n}${i ? " — " + i : ""}`); if (!ok) fail++; };
const ctx = await browser.newContext({ acceptDownloads: true });
const p = await ctx.newPage();
p.on("pageerror", (e) => console.log("[perr]", e.message.slice(0, 200)));
await p.goto(HTML);
await p.waitForFunction(() => window.PrismFit, null, { timeout: 60000 });
// 이 테스트는 "공유 해제(로컬 전용)" 상태의 안전망을 검증한다
await p.evaluate(() => { App.calib.lensDbUrl = ""; saveCalib(); lensSyncStart(); });
await p.click("#calib-btn"); await p.click('summary:has-text("렌즈 목록 관리")');
check("공유 미설정 시 로컬 전용 표시", (await p.$eval("#cb-sync-state", (e) => e.textContent)).includes("로컬 전용"),
  await p.$eval("#cb-sync-state", (e) => e.textContent));
for (const [mk, md, mg] of [["Olympus", "MPLFLN50X", 50], ["Nikon", "CFI60-2", 20]]) {
  await p.fill("#cb-obj-maker", mk); await p.fill("#cb-obj-model", md); await p.fill("#cb-obj-mag", String(mg));
  await p.click("#cb-obj-add");
}
const dl = await Promise.all([p.waitForEvent("download"), p.click("#cb-lens-export")]);
const path = "/tmp/lenses_export.json";
await dl[0].saveAs(path);
const j = JSON.parse(fs.readFileSync(path, "utf8"));
check("내보내기 JSON 구조", j.kind === "objective-lens-list" && j.lenses.length === 2, JSON.stringify(j.lenses));
// 새 브라우저(=목록 없는 PC)에서 가져오기
const p2 = await (await browser.newContext()).newPage();
await p2.goto(HTML);
await p2.waitForFunction(() => window.PrismFit, null, { timeout: 60000 });
await p2.evaluate(() => { App.calib.lensDbUrl = ""; saveCalib(); lensSyncStart(); });
await p2.click("#calib-btn"); await p2.click('summary:has-text("렌즈 목록 관리")');
check("새 PC는 목록이 비어 있음", (await p2.$$eval("#cb-obj option", (o) => o.length)) === 1);
await p2.setInputFiles("#cb-lens-file", path);
await p2.waitForFunction(() => (App.calib.objectives || []).length === 2, null, { timeout: 10000 });
const names = await p2.$$eval("#cb-obj option", (o) => o.map((x) => x.textContent));
check("가져오기 복원", names.some((t) => t.includes("MPLFLN50X")) && names.some((t) => t.includes("CFI60-2")), names.join(" / "));
// 중복 가져오기 → 늘어나지 않음
await p2.setInputFiles("#cb-lens-file", path);
await p2.waitForTimeout(600);
check("중복 가져오기 방지", (await p2.evaluate(() => App.calib.objectives.length)) === 2);
console.log(fail ? `\n${fail} FAILURES` : "\nALL PASS");
await browser.close();
process.exit(fail ? 1 : 0);

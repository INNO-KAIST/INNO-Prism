/* 연구실 공용 렌즈 목록 실시간 공유 검증.
 * 서로 다른 브라우저 컨텍스트 = 서로 다른 PC(독립 localStorage)로 시뮬레이션.
 * 사전 준비: node mock_rtdb.mjs (Firebase RTDB REST+SSE 최소 구현) */
import { chromium } from "playwright";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
const here = dirname(fileURLToPath(import.meta.url));
const HTML = "file://" + join(here, "..", "INNO Prism.html").replace(/\\/g, "/");

const DB = "http://127.0.0.1:8765";
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
let fail = 0;
// 픽스처 자체 시드 (외부 상태에 의존하지 않도록)
await fetch(`${DB}/lenses.json`, { method: "DELETE" }).catch(() => {});
await fetch(`${DB}/lenses/nikon~cfi60~40.json`, {
  method: "PUT", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ maker: "Nikon", model: "CFI60", mag: 40, medium: "air", na: 0.75 }),
});

const check = (n, ok, info) => { console.log(`  ${ok ? "PASS" : "FAIL"} ${n}${info ? " — " + info : ""}`); if (!ok) fail++; };
const openPC = async (name) => {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  p.on("pageerror", (e) => console.log(`[${name}]`, e.message.slice(0, 160)));
  p.on("dialog", (d) => d.accept());
  await p.goto(HTML);
  await p.waitForFunction(() => window.PrismFit, null, { timeout: 60000 });
  await p.evaluate((db) => { App.calib.lensDbUrl = db; saveCalib(); lensSyncStart(); }, DB);
  await p.waitForFunction(() => LensSync.state === "live", null, { timeout: 20000 });
  await p.click("#calib-btn");
  await p.click('summary:has-text("렌즈 목록 관리")');
  return p;
};
const names = (p) => p.$$eval("#cb-obj option", (o) => o.map((x) => x.textContent));
const addLens = async (p, maker, model, mag) => {
  await p.fill("#cb-obj-maker", maker); await p.fill("#cb-obj-model", model);
  await p.fill("#cb-obj-mag", String(mag)); await p.click("#cb-obj-add");
};
const hasModel = (p, m) => p.waitForFunction(
  (mm) => (App.calib.objectives || []).some((o) => o.model === mm), m, { timeout: 15000 });
const lacksModel = (p, m) => p.waitForFunction(
  (mm) => !(App.calib.objectives || []).some((o) => o.model === mm), m, { timeout: 15000 });

const A = await openPC("A"), B = await openPC("B");
check("두 PC 실시간 연결(SSE)", true);
await hasModel(A, "CFI60");
check("기존 공용 렌즈 수신", (await names(A)).some((t) => t.includes("CFI60")), (await names(A)).join(" / "));

// 1) A 추가 → B 실시간 반영 (새로고침 없음)
await addLens(A, "Olympus", "MPLFLN100X", 100);
await hasModel(B, "MPLFLN100X");
check("A 추가 → B 즉시 반영", true, (await names(B)).join(" / "));
check("전송 완료 후 '미동기화' 표시 없음", !(await names(A)).some((t) => t.includes("미동기화")));

// 2) B 삭제 → A 실시간 반영
const idx = await B.evaluate(() => App.calib.objectives.findIndex((o) => o.model === "MPLFLN100X"));
await B.selectOption("#cb-obj", String(idx));
await B.click("#cb-obj-del");
await lacksModel(B, "MPLFLN100X");
await lacksModel(A, "MPLFLN100X");
check("B 삭제 → A 즉시 반영", true);

// 3) 오프라인: 서버 없이 추가해도 목록 유지 + 미동기화 표시
await A.evaluate(() => { App.calib.lensDbUrl = "http://127.0.0.1:9999"; saveCalib(); LensSync.server = null; lensSyncStart(); });
await A.waitForTimeout(900);
await addLens(A, "Zeiss", "EC Plan-Neofluar", 63);
check("오프라인 추가 — 목록에 남음", (await names(A)).some((t) => t.includes("Neofluar")));
check("오프라인 추가 — 미동기화 표시", (await names(A)).some((t) => t.includes("미동기화")), (await names(A)).join(" / "));

// 4) 재연결 시 미전송분 자동 전송 → 다른 PC에 전파
await A.evaluate((db) => { App.calib.lensDbUrl = db; saveCalib(); LensSync.server = null; lensSyncStart(); }, DB);
await A.waitForFunction(() => LensSync.state === "live", null, { timeout: 20000 });
await hasModel(B, "EC Plan-Neofluar");
check("재연결 → 미전송분 자동 전송 → B 반영", true, (await names(B)).join(" / "));

// 5) 새 PC는 열자마자 공용 목록을 받는다 (localStorage 없어도)
const C = await openPC("C");
await hasModel(C, "EC Plan-Neofluar");
check("새 PC 최초 접속 시 공용 목록 수신", (await names(C)).some((t) => t.includes("Neofluar")), (await names(C)).join(" / "));

await A.screenshot({ path: "shot26_lenssync.png" });
console.log(fail ? `\n${fail} FAILURES` : "\nALL PASS");
await browser.close();
process.exit(fail ? 1 : 0);

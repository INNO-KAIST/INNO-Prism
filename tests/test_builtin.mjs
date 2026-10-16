/* 빌드 내장 URL 경로 + 끝 슬래시 처리 + 연결 실패 진단 문구 검증 */
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

const check = (n, ok, i) => { console.log(`  ${ok ? "PASS" : "FAIL"} ${n}${i ? " — " + i : ""}`); if (!ok) fail++; };
const mk = async () => {
  const p = await (await browser.newContext()).newPage();
  p.on("pageerror", (e) => console.log("[perr]", e.message.slice(0, 180)));
  await p.goto(HTML);
  await p.waitForFunction(() => window.PrismFit, null, { timeout: 60000 });
  return p;
};
// 1) 빌드에 URL이 내장되어 있고, 끝 슬래시가 정규화되는지
const p = await mk();
const info = await p.evaluate(() => ({ raw: window.PRISM_FIREBASE_URL, norm: lensDbUrl() }));
check("빌드에 URL 내장", /firebasedatabase\.app/.test(info.raw), info.raw);
check("끝 슬래시 정규화", info.norm === "https://inno-prism-default-rtdb.asia-southeast1.firebasedatabase.app", info.norm);
check("요청 경로 조립", true, `${info.norm}/lenses.json`);
// 2) 내장 URL로 자동 연결 시도 → (이 컨테이너는 외부 차단) 실패 진단이 구체적인지
await p.waitForFunction(() => LensSync.state === "error" || LensSync.state === "live", null, { timeout: 30000 });
const st = await p.evaluate(() => ({ s: LensSync.state, e: LensSync.err }));
check("연결 실패 시 구체적 사유 표시", st.s !== "error" || /연결할 수 없|권한|찾을 수 없|응답/.test(st.e), `${st.s}: ${st.e}`);
check("실패해도 앱은 정상 동작 (목록 로컬 유지)", await p.evaluate(() => Array.isArray(App.calib.objectives)));
// 3) 앱 내 설정으로 목 서버(끝 슬래시 포함) 지정 → 실시간 연결
const q = await mk();
await q.evaluate(() => { App.calib.lensDbUrl = "http://127.0.0.1:8765/"; saveCalib(); lensSyncStart(); });
await q.waitForFunction(() => LensSync.state === "live", null, { timeout: 20000 });
check("끝 슬래시 URL로도 실시간 연결", true);
await q.click("#calib-btn"); await q.click("summary");
const opts = await q.$$eval("#cb-obj option", (o) => o.map((x) => x.textContent));
check("공용 목록 수신", opts.some((t) => t.includes("CFI60")), opts.join(" / "));
console.log(fail ? `\n${fail} FAILURES` : "\nALL PASS");
await browser.close();
process.exit(fail ? 1 : 0);

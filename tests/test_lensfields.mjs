/* NA / 침지매질 / 초점거리 / 작동거리(WD) 기록 + 회절 한계 대조 검증 */
import { chromium } from "playwright";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
const here = dirname(fileURLToPath(import.meta.url));
const HTML = "file://" + join(here, "..", "INNO Prism.html").replace(/\\/g, "/");

const DB = "http://127.0.0.1:8765";
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
let fail = 0;
const check = (n, ok, i) => { console.log(`  ${ok ? "PASS" : "FAIL"} ${n}${i ? " — " + i : ""}`); if (!ok) fail++; };
const mk = async (shared) => {
  const p = await (await browser.newContext()).newPage();
  p.on("pageerror", (e) => console.log("[perr]", e.message.slice(0, 180)));
  p.on("dialog", (d) => d.accept());
  await p.goto(HTML);
  await p.waitForFunction(() => window.PrismFit, null, { timeout: 60000 });
  await p.evaluate((db) => { App.calib.lensDbUrl = db; saveCalib(); lensSyncStart(); }, shared ? DB : "");
  if (shared) await p.waitForFunction(() => LensSync.state === "live", null, { timeout: 20000 });
  await p.click("#calib-btn"); await p.click('summary:has-text("렌즈 목록 관리")');
  return p;
};
const add = async (p, mk_, md, mag, na, med, f, wd) => {
  await p.fill("#cb-obj-maker", mk_); await p.fill("#cb-obj-model", md); await p.fill("#cb-obj-mag", String(mag));
  await p.fill("#cb-obj-na", na === null ? "" : String(na));
  await p.selectOption("#cb-obj-med", med);
  await p.fill("#cb-obj-f", f === null ? "" : String(f));
  await p.fill("#cb-obj-wd", wd === undefined || wd === null ? "" : String(wd));
  await p.click("#cb-obj-add");
};

const A = await mk(true);
await add(A, "Olympus", "UPLSAPO100XO", 100, 1.4, "oil", null, 0.12);
await add(A, "Nikon", "CFI Plan Apo 40X", 40, 0.95, "air", null);   // WD 미입력 — 선택 필드임을 확인
const opts = await A.$$eval("#cb-obj option", (o) => o.map((x) => x.textContent));
check("목록 라벨에 NA·매질 표시", opts.some((t) => t.includes("NA 1.4") && t.includes("Oil")), opts.join(" / "));
check("목록 라벨에 WD 표시", opts.some((t) => t.includes("WD 0.12 mm")), opts.join(" / "));
check("WD 미입력 항목은 라벨에 WD 없음",
  opts.some((t) => t.includes("CFI Plan Apo 40X") && !t.includes("WD")), opts.join(" / "));

// 초점거리 자동 계산 (Olympus 경통렌즈 180 / 100× = 1.8 mm)
await A.selectOption("#cb-obj", await A.evaluate(() => String(App.calib.objectives.findIndex((o) => o.mag === 100))));
await A.waitForTimeout(300);
let info = await A.$eval("#cb-lens-info", (e) => e.textContent);
check("초점거리 자동 계산 (Olympus 100× → 1.8 mm)", /f = 1\.8/.test(info) && /180/.test(info), info.slice(0, 130));
check("NA·매질 표시", /NA 1\.4/.test(info) && /Oil/.test(info));
check("선택 렌즈 정보줄에 WD 표시", /WD = 0\.12 mm/.test(info), (info.match(/WD[^·]{0,20}/) || [])[0]);

// 회절 한계 (λ=1064nm, NA=1.4 → 0.51*1.064/1.4 = 0.3876 µm)
check("회절 한계 계산 (0.51·1.064/1.4 = 0.388 µm)", /회절 한계 FWHM/.test(info) && /0\.388/.test(info), (info.match(/회절 한계.{0,40}/) || [])[0]);

// 수동 초점거리 우선
await add(A, "Mitutoyo", "M Plan Apo 20X", 20, 0.42, "air", 12.5, 20);
await A.selectOption("#cb-obj", await A.evaluate(() => String(App.calib.objectives.findIndex((o) => o.mag === 20))));
await A.waitForTimeout(300);
info = await A.$eval("#cb-lens-info", (e) => e.textContent);
check("수동 초점거리 우선 (기록값)", /f = 12\.5/.test(info) && /기록값/.test(info), info.slice(0, 120));

// 유효성: WD 범위 밖 거부 (µm/mm 단위 혼동 방어)
await A.fill("#cb-obj-maker", "Y"); await A.fill("#cb-obj-model", "BadWD"); await A.fill("#cb-obj-mag", "50");
await A.fill("#cb-obj-na", "0.5"); await A.selectOption("#cb-obj-med", "air");
await A.fill("#cb-obj-f", ""); await A.fill("#cb-obj-wd", "120");
await A.click("#cb-obj-add"); await A.waitForTimeout(400);
check("WD 50 mm 초과 입력 거부", !(await A.evaluate(() => App.calib.objectives.some((o) => o.model === "BadWD"))));
await A.fill("#cb-obj-wd", "");

// 유효성: Air인데 NA≥1.0 거부
await A.fill("#cb-obj-maker", "X"); await A.fill("#cb-obj-model", "Bad"); await A.fill("#cb-obj-mag", "60");
await A.fill("#cb-obj-na", "1.3"); await A.selectOption("#cb-obj-med", "air"); await A.click("#cb-obj-add");
await A.waitForTimeout(400);
check("Air + NA≥1.0 입력 거부", !(await A.evaluate(() => App.calib.objectives.some((o) => o.model === "Bad"))));

// 공유: 다른 PC에 NA/매질/초점거리까지 전파
const B = await mk(true);
await B.waitForFunction(() => (App.calib.objectives || []).some((o) => o.model === "UPLSAPO100XO"), null, { timeout: 15000 });
const rec = await B.evaluate(() => App.calib.objectives.find((o) => o.model === "UPLSAPO100XO"));
check("NA·매질 실시간 공유", rec.na === 1.4 && rec.medium === "oil", JSON.stringify(rec));
check("WD 실시간 공유", rec.wd === 0.12, JSON.stringify(rec));
const rec2 = await B.evaluate(() => App.calib.objectives.find((o) => o.model === "M Plan Apo 20X"));
check("수동 초점거리 실시간 공유", rec2 && rec2.f === 12.5, JSON.stringify(rec2));
check("장초점 렌즈 WD 공유 (20 mm)", rec2 && rec2.wd === 20, JSON.stringify(rec2));
const recNoWd = await B.evaluate(() => App.calib.objectives.find((o) => o.model === "CFI Plan Apo 40X"));
check("WD 미입력 항목은 필드 자체가 없음", recNoWd && !("wd" in recNoWd), JSON.stringify(recNoWd));

// 구버전 항목(NA/매질 없음) 호환
const legacyLabel = await B.evaluate(() => lensLabel({ maker: "Legacy", model: "Old10X", mag: 10 }));
check("구버전 항목 호환 (필드 없어도 정상 표시)", legacyLabel === "Legacy Old10X (10×)", legacyLabel);

// 내보내기/가져오기 왕복에서 WD 보존 (lensEntry 경유 여부 확인)
const round = await A.evaluate(() => {
  const src = App.calib.objectives.find((o) => o.model === "UPLSAPO100XO");
  return lensEntry(JSON.parse(JSON.stringify(lensEntry(src))));
});
check("내보내기→가져오기 왕복에서 WD 보존", round.wd === 0.12, JSON.stringify(round));

await A.screenshot({ path: "shot27_lensfields.png" });
console.log(fail ? `\n${fail} FAILURES` : "\nALL PASS");
await browser.close();
process.exit(fail ? 1 : 0);

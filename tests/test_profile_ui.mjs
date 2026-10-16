/* R8-UI: 빌드본에서 프로파일 우도 진술이 실제로 렌더되는지 확인.
 * 엔진 단위 테스트(test_slope_profile.js)와 별개로, 번들에 들어간 코드가
 * 결과 카드에 문장을 실제로 그리는지를 브라우저에서 본다. */
import { chromium } from "playwright";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
const here = dirname(fileURLToPath(import.meta.url));
const htmlPath = join(here, "..", "INNO Prism.html");
const fixture = JSON.parse(readFileSync(join(here, "testdata", "pa_wj0075c_updown.json"), "utf8"));

let fail = 0;
const check = (n, ok, info) => { console.log(`  ${ok ? "PASS" : "FAIL"} ${n}${info ? " — " + info : ""}`); if (!ok) fail++; };

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
const page = await browser.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));
page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text().slice(0, 200)); });
await page.goto("file://" + htmlPath.replace(/\\/g, "/"));
await page.waitForFunction(() => typeof PrismFit !== "undefined" && typeof renderFitResults === "function", { timeout: 30000 });
// 결과 카드 컨테이너는 파일을 열어야 생기므로 검증용으로 직접 만든다
await page.evaluate(() => { if (!document.getElementById("fit-results")) { const d = document.createElement("div"); d.id = "fit-results"; document.body.appendChild(d); } });
check("페이지 부팅 (치명적 오류 없음)", errs.filter((e) => !/h5wasm|HDF5|WebAssembly/i.test(e)).length === 0,
  errs.slice(0, 2).join(" | "));

const out = await page.evaluate(async (d) => {
  const I1d = d.Iraw.map((r) => r.reduce((a, b) => a + b, 0) / r.length);
  const trace = { P: d.P, I: I1d, W: d.W, Iraw: d.Iraw, acqTime: d.acqTime, counting: true };
  const br = PrismFit.paHighStateBranch(trace.P, trace.I, trace.W, "up",
    { Iraw: d.Iraw, acqTime: d.acqTime, counting: true });
  const a = PrismFit.analyze(br, { paTrace: trace, acqTime: d.acqTime, counting: true, stabilityCheck: false });
  a.quality = PrismFit.evaluate(a);
  a._aggUsed = "high"; a._branchUsed = "up";
  renderFitResults({ name: "WJ-0075c", det: { type: "apd" }, cache: {} }, a);
  // 상한별 Δχ² 는 접힘(details) 안에 있다 — 펼쳐야 텍스트로 보인다
  const det = document.querySelector("#fit-results details");
  const collapsedFirst = det ? !det.open : null;
  if (det) det.open = true;
  return {
    collapsedFirst,
    verdict: a.slopeProfile ? a.slopeProfile.verdict : null,
    floor: a.slopeProfile ? a.slopeProfile.floor : null,
    sMax: a.sMax,
    text: document.getElementById("fit-results").innerText,
  };
}, fixture);

check("엔진 판정 unbounded", out.verdict === "unbounded", `verdict=${out.verdict} floor=${out.floor}`);
check("카드에 '프로파일 우도' 문장 렌더", /프로파일 우도/.test(out.text));
check("카드에 '모든 모델이 기각' 표시", /모든 모델이 기각/.test(out.text));
check("Δχ² 사다리는 기본 접힘", out.collapsedFirst === true);
check("펼치면 상한별 Δχ² 표시", /s_max ≤ 2 → Δχ² =/.test(out.text));
check("기존 hero(보고 PA) 유지", /보고 PA/.test(out.text));
const snip = (out.text.match(/우도가 s_max[^\n]*/) || out.text.match(/프로파일 우도[^\n]*/) || [""])[0];
console.log("    → " + snip.slice(0, 200));

await browser.close();
console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);

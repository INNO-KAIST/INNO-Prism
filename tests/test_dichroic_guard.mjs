/* v3.13 — dichroic ↔ 측정 채널 가드
 * 검증 대상: 파일명 채널 판정(확신 없으면 보류), 4가지 state, 배너 문구,
 * 그리고 "특정 파일명에 맞춘 하드코딩이 아닌가"를 반증하는 negative case. */
import { chromium } from "playwright";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
const here = dirname(fileURLToPath(import.meta.url));
const HTML = "file://" + join(here, "..", "INNO Prism.html").replace(/\\/g, "/");

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
let fail = 0;
const check = (n, ok, i) => { console.log(`  ${ok ? "PASS" : "FAIL"} ${n}${i ? " — " + i : ""}`); if (!ok) fail++; };

const p = await (await browser.newContext()).newPage();
p.on("pageerror", (e) => console.log("[perr]", e.message.slice(0, 200)));
await p.goto(HTML);
await p.waitForFunction(() => window.PrismFit, null, { timeout: 60000 });

/* ---- 1. 파일명 → 채널 판정 ---- */
const cases = [
  ["260702_power_scan_WJ-0128c_9_Oil_NIR.h5", "NIR"],
  ["260702_power_scan_WJ-0128c_3_Oil_Blue.h5", "Blue"],
  ["250101_scan_UV_sample.h5", "UV"],
  ["x_green_y.h5", "VIS"],
  ["260702_power_scan_WJ-0128c_9_Oil.h5", null],      // 채널 토큰 없음 → 보류
  ["scan_blue_and_nir_overlay.h5", null],             // 후보 2개 → 보류
  ["nirvana_sample.h5", null],                        // 부분일치는 채널이 아님
  ["blueberry_test.h5", null],
  ["UV.h5", "UV"],                                    // 토큰이 파일명 전체여도 인식
  ["scan-NIR-2.h5", "NIR"],                           // 하이픈 구분자
];
const got = await p.evaluate((cs) => cs.map(([n]) => detectFileChannel(n)), cases);
for (let i = 0; i < cases.length; i++)
  check(`detectFileChannel("${cases[i][0]}")`, got[i] === cases[i][1], `${got[i]} (기대 ${cases[i][1]})`);

/* ---- 2. state 4종 ---- */
const st = await p.evaluate(() => {
  const out = {};
  const set = (ch, dic) => { App.calib.beamChannel = ch; App.calib.dichroic = dic; };
  set("NIR", "950 DMSP"); out.match = calibChannelCheck({ name: "a_Oil_NIR.h5" }).state;
  set("Blue", "600 DMSP"); out.mismatch = calibChannelCheck({ name: "a_Oil_NIR.h5" }).state;
  set("Blue", "600 DMSP"); out.unknown = calibChannelCheck({ name: "a_Oil.h5" }).state;
  set("", ""); out.unset = calibChannelCheck({ name: "a_Oil_NIR.h5" }).state;
  return out;
});
check("일치 → match", st.match === "match", st.match);
check("600 DMSP 보정 + NIR 파일 → mismatch", st.mismatch === "mismatch", st.mismatch);
check("파일명 판정 불가 → unknown", st.unknown === "unknown", st.unknown);
check("채널 미기록 → unset", st.unset === "unset", st.unset);

/* ---- 3. 배너: 파워밀도를 쓸 때만, 그리고 mismatch/unset 에서만 ---- */
const ban = await p.evaluate(() => {
  const real = window.densityActive;
  const out = {};
  window.densityActive = () => false;
  App.calib.beamChannel = "Blue"; App.calib.dichroic = "600 DMSP";
  out.offMismatch = calibChannelBannerHtml({ name: "a_Oil_NIR.h5" });
  window.densityActive = () => true;
  out.onMismatch = calibChannelBannerHtml({ name: "a_Oil_NIR.h5" });
  out.onMatch = calibChannelBannerHtml({ name: "a_Oil_Blue.h5" });
  out.onUnknown = calibChannelBannerHtml({ name: "a_Oil.h5" });
  App.calib.beamChannel = ""; App.calib.dichroic = "";
  out.onUnset = calibChannelBannerHtml({ name: "a_Oil_NIR.h5" });
  window.densityActive = real;
  return out;
});
check("파워밀도 미사용 시 배너 없음", ban.offMismatch === "", ban.offMismatch.slice(0, 60));
check("mismatch 배너 표시", /채널 불일치/.test(ban.onMismatch));
check("mismatch 배너에 양쪽 채널·dichroic 명시",
  /600 DMSP/.test(ban.onMismatch) && /Blue/.test(ban.onMismatch) && /NIR/.test(ban.onMismatch));
check("일치 시 배너 없음", ban.onMatch === "", ban.onMatch.slice(0, 60));
check("파일명 판정 불가 시 배너 없음(허위경보 방지)", ban.onUnknown === "", ban.onUnknown.slice(0, 60));
check("미기록 시 안내 배너", /기록이 없습니다/.test(ban.onUnset));

/* ---- 4. 내보내기에 출처가 남는가 ---- */
const exp = await p.evaluate(() => {
  App.calib.beamChannel = "NIR"; App.calib.dichroic = "950 DMSP";
  let captured = null;
  const real = window.downloadText;
  window.downloadText = (fn, txt) => { captured = txt; };
  App.calib.pairs = [{ pm: 1e-3, end: 3.32e-3 }, { pm: 2e-3, end: 6.65e-3 }, { pm: 3e-3, end: 9.97e-3 }];
  try { exportCalibSession(); } catch (e) { return { err: String(e) }; }
  window.downloadText = real;
  return captured ? JSON.parse(captured) : { err: "no download" };
});
check("내보내기에 dichroic 기록", exp.dichroic === "950 DMSP", JSON.stringify(exp.dichroic ?? exp.err));
check("내보내기에 beamChannel 기록", exp.beamChannel === "NIR", JSON.stringify(exp.beamChannel ?? exp.err));

await browser.close();
console.log(fail ? `\n${fail} FAILED` : "\nALL PASS");
process.exit(fail ? 1 : 0);

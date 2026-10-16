/* R9-UI: 빌드본에서 쌍안정 카드·곡선·히스테리시스가 실제로 렌더되는지.
 * 히스테리시스는 두 분지 분석이 모두 캐시에 있을 때만 나와야 하므로, 캐시를 채운 경우와
 * 채우지 않은 경우를 둘 다 본다. */
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
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));
page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|ERR_TUNNEL|firebase/i.test(m.text())) errs.push("console: " + m.text().slice(0, 200)); });
await page.goto("file://" + htmlPath.replace(/\\/g, "/"));
await page.waitForFunction(() => typeof PrismFit !== "undefined" && typeof renderFitResults === "function", { timeout: 30000 });

const out = await page.evaluate((d) => {
  const host = document.querySelector("main") || document.body;
  const div = document.createElement("div"); div.id = "fit-results"; host.appendChild(div);
  const I1d = d.Iraw.map((r) => r.reduce((a, x) => a + x, 0) / r.length);
  const trace = { P: d.P, I: I1d, W: d.W, Iraw: d.Iraw, acqTime: d.acqTime, counting: true };
  const mk = (pass, named) => {
    const br = PrismFit.paHighStateBranch(trace.P, trace.I, trace.W, pass, { Iraw: d.Iraw, acqTime: d.acqTime, counting: true });
    const opt = { paTrace: trace, acqTime: d.acqTime, counting: true, stabilityCheck: false };
    // 앱(app.js)은 branchName 을 넘긴다 — 그래야 교차분지 점유율이 계산되고,
    // v3.4 에서는 그것이 쌍안정 적합의 점유율 제약으로 **기본 연결**된다.
    if (named) opt.branchName = pass;
    const a = PrismFit.analyze(br, opt);
    a.quality = PrismFit.evaluate(a); a._aggUsed = "high"; a._branchUsed = pass;
    return a;
  };
  const up = mk("up"), down = mk("down");
  const rec = { name: "WJ-0075c", det: { type: "apd" }, cache: {} };
  // (1) 상행만 있는 상태 — 히스테리시스는 나오면 안 된다
  App.settings.branch = "up";
  rec.cache[analysisKey()] = up;
  renderFitResults(rec, up);
  const soloText = document.getElementById("fit-results").innerText;
  // (2) 하행도 캐시에 넣은 뒤 — 히스테리시스가 나와야 한다
  const kUp = analysisKey();
  App.settings.branch = "down";
  rec.cache[analysisKey()] = down;
  App.settings.branch = "up";
  renderFitResults(rec, up);
  const bothText = document.getElementById("fit-results").innerText;
  // (3) v3.4 — branchName 을 넘긴 실제 앱 경로
  const upN = mk("up", true);
  rec.cache[analysisKey()] = upN;
  renderFitResults(rec, upN);
  const namedText = document.getElementById("fit-results").innerText;
  const namedErrs = namedText.length > 50 ? 0 : 1;

  // (4) v3.6 — 분지 합산 카드. collectBistables() 는 App.files 를 걷는다.
  //     분지 2개(파일 1개)면 '3개 이상 필요' 안내, 4개(파일 2개)면 합산 카드가 나와야 한다.
  const kUp2 = analysisKey();
  App.settings.branch = "down";
  const kDn2 = analysisKey();
  App.settings.branch = "up";
  const mkRec = (nm) => {
    const r2 = { id: nm, name: nm, det: { type: "apd" }, cache: {} };
    r2.cache[kUp2] = upN; r2.cache[kDn2] = down;
    return r2;
  };
  const savedFiles = App.files.slice();
  App.files = [mkRec("파일A")];
  renderFitResults(rec, upN);
  const pool2Text = document.getElementById("fit-results").innerText;
  App.files = [mkRec("파일A"), mkRec("파일B")];
  renderFitResults(rec, upN);
  const pool4Text = document.getElementById("fit-results").innerText;
  App.files = savedFiles;
  return {
    soloText, bothText, namedText, namedErrs, pool2Text, pool4Text,
    preferred: up.bistable ? up.bistable.preferred : null,
    dAicc: up.bistable ? up.bistable.aiccVsH : null,
    occSource: upN.occSourceUsed, occN: upN.occConstraintN,
    collapsed: upN.bistable ? upN.bistable.nHighCollapsed : null,
    conflict: upN.bistable ? upN.bistable.chi2VsUnconstrained : null,
    withdrawn: upN.bistable ? upN.bistable.occWithdrawn : null,
    rangeOk: upN.bistable ? upN.bistable.rangeOk : null,
    rangeDec: upN.bistable ? upN.bistable.nHighRangeDec : null,
    widthModel: upN.bistable ? upN.bistable.width1090Dec : null,
    widthMeas: upN.crossOcc ? upN.crossOcc.width1090 : null,
  };
}, fixture);

check("페이지 부팅 (치명적 오류 없음)", errs.length === 0, errs.slice(0, 2).join(" | "));
check("엔진: 쌍안정이 더 지지됨", out.preferred === true, `ΔAICc=${out.dAicc && out.dAicc.toFixed(0)}`);
check("카드: 전환 파워 P_s 표시", /전환 파워 P_s/.test(out.soloText));
check("카드: 상태별 멱법칙 지수 표시", /상태별 멱법칙 지수/.test(out.soloText));
check("카드: n_low 결정 불가로 표시", /결정 불가/.test(out.soloText));
check("카드: 대비비를 하한으로 표시", /log₁₀ 대비비 = ≥/.test(out.soloText));
check("경고바: 쌍안정이 더 지지된다는 진술", /쌍안정 서술이 더 지지됩니다/.test(out.soloText));
check("한쪽 분지만 있으면 히스테리시스 미표시", !/히스테리시스 P_up/.test(out.soloText) && /반대 분지를 같은 설정으로/.test(out.soloText));
check("양쪽 분지가 있으면 히스테리시스 표시", /히스테리시스 P_up\/P_down/.test(out.bothText));
const hy = (out.bothText.match(/히스테리시스 P_up\/P_down = ([\d.]+)/) || [])[1];
check("히스테리시스 값이 접선 문턱비와 일치", hy && Math.abs(Number(hy) - 1.55) < 0.25, `P_up/P_down = ${hy}`);
console.log("    → " + (out.soloText.match(/전환 파워 P_s[\s\S]{0,180}/) || [""])[0].replace(/\n/g, " | "));

// ── 앱이 실제로 쓰는 경로(branchName 전달)에서 v3.5 게이트가 화면에 나오는가 ──
// 이력: v3.4 는 이 자리에서 "모델 폭이 측정 폭에 근접" 과 "n_high 붕괴 판정" 을 잠갔다.
// v3.5 에서 σ_f 를 보정하자 이 분지는 갈등 87× 로 **제약이 철회**되므로 둘 다 성립하지
// 않는다. 대신 철회 고지와 구간 게이트가 화면에 나오는지를 잠근다.
console.log("\n[v3.5 게이트가 화면에 나오는가]");
check("교차분지 제약이 기본으로 계산된다", out.occSource === "cross" && out.occN >= 4,
  `출처=${out.occSource} 제약점=${out.occN}`);
check("갈등이 검증 범위를 넘으면 제약을 철회한다", out.withdrawn === true && out.conflict > 20,
  `${out.conflict && out.conflict.toFixed(1)}× > 20×`);
check("카드가 철회를 고지한다", /점유율 제약을 철회했습니다/.test(out.namedText)
  && /제약 없는 적합/.test(out.namedText));
check("카드가 제약 출처를 표시", /점유율 제약: 교차분지/.test(out.namedText));
check("문턱 위 구간이 부족하다고 판정", out.rangeOk === false && out.rangeDec < 0.25,
  `${out.rangeDec && out.rangeDec.toFixed(3)} dec < 0.25`);
check("카드가 구간 부족을 실행 가능한 문구로 표시", /고상태 지수 미결정/.test(out.namedText)
  && /더 높은 파워까지 확장/.test(out.namedText));
check("치명적 렌더 오류 없음 (fmt 자릿수 등)", out.namedErrs === 0, `errs=${out.namedErrs}`);
console.log("    → " + (out.namedText.match(/고상태 지수 미결정[\s\S]{0,180}/) || [""])[0].replace(/\n/g, " | "));

// ── v3.6: 분지 합산 카드가 화면에 나오는가 ──
console.log("\n[v3.6 분지 합산 카드]");
check("분지 2개면 '3개 이상 필요' 안내", /합산에는 3개 이상이 필요합니다/.test(out.pool2Text));
check("분지 4개면 합산 카드가 뜬다", /여러 분지 합산 고상태 지수/.test(out.pool4Text)
  && /절대 파워 기준/.test(out.pool4Text));
check("합산 카드가 이질성 판정을 표시", /IQR\/중앙/.test(out.pool4Text));
check("합산 카드가 쓰인 분지를 밝힌다", /쓰인 분지/.test(out.pool4Text));
check("합산이 강건추정임을 명시", /정보를 만들지 않습니다/.test(out.pool4Text));
console.log("    → " + (out.pool4Text.match(/여러 분지 합산 고상태 지수[\s\S]{0,200}/) || [""])[0].replace(/\n/g, " | "));

await browser.close();
console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);

/* 빔 보정 측정쌍 행 3~5개 (v3.6 후속)
 *
 * 잠그는 것:
 *  1) 기본 3행, 최대 5행까지 늘어나고 최소 3행 아래로는 안 내려간다 (버튼 비활성 포함)
 *  2) 계산은 **채운 개수**로만 한다 — 빈 행은 없는 것과 같다
 *  3) 4·5행 값이 실제로 계수에 들어간다 (참값 대조: 원점 통과 최소제곱 해와 일치)
 *  4) 행을 줄이면 그 행의 값이 **실제로 지워진다** — 숨겨진 채 계수에 남지 않는다
 *  5) 저장 후 다시 열면 행 수가 유지된다 (구버전 저장본도 데이터에서 복원)
 *  6) 표준오차는 3회부터만 나온다 (2회는 dof=1)
 */
import { chromium } from "playwright";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
const here = dirname(fileURLToPath(import.meta.url));
const HTML = "file://" + join(here, "..", "INNO Prism.html").replace(/\\/g, "/");

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
let fail = 0;
const check = (n, ok, i) => { console.log(`  ${ok ? "PASS" : "FAIL"} ${n}${i ? " — " + i : ""}`); if (!ok) fail++; };
const near = (a, b, tol) => isFinite(a) && isFinite(b) && Math.abs(a - b) <= tol * Math.max(Math.abs(b), 1e-12);

const ctx = await browser.newContext();
const p = await ctx.newPage();
p.on("pageerror", (e) => console.log("[perr]", e.message.slice(0, 200)));
await p.goto(HTML);
await p.waitForFunction(() => window.PrismFit, null, { timeout: 60000 });

const visibleRows = () => p.$$eval(".cb-pair-row", (rs) => rs.filter((r) => r.style.display !== "none").length);
const UW = (w) => String(Number((w * 1e6).toPrecision(12)));   // 입력은 µW
const setPair = async (i, pm, end) => {
  await p.fill(`.cb-pm[data-i="${i}"]`, UW(pm));
  await p.fill(`.cb-end[data-i="${i}"]`, UW(end));
  await p.dispatchEvent(`.cb-end[data-i="${i}"]`, "change");
  await p.dispatchEvent(`.cb-pm[data-i="${i}"]`, "change");
};

await p.click("#calib-btn");

console.log("[행 수 조절]");
check("기본 3행", (await visibleRows()) === 3, `보이는 행 ${await visibleRows()}`);
check("3행에서는 삭제 버튼이 잠긴다", await p.$eval("#cb-pair-del", (e) => e.disabled));
await p.click("#cb-pair-add");
check("4행으로 늘어남", (await visibleRows()) === 4);
await p.click("#cb-pair-add");
check("5행으로 늘어남", (await visibleRows()) === 5);
check("5행에서는 추가 버튼이 잠긴다", await p.$eval("#cb-pair-add", (e) => e.disabled));
check("행 수 안내 문구", (await p.$eval("#cb-pair-count", (e) => e.textContent)).includes("행 5개"),
  await p.$eval("#cb-pair-count", (e) => e.textContent));

console.log("\n[채운 개수만큼 계산 · 참값 대조]");
// 참값 C=0.62 에 작은 잡음을 섞은 5쌍
const PM  = [1.00e-3, 2.00e-3, 3.00e-3, 4.00e-3, 5.00e-3];
const END = [6.22e-4, 1.238e-3, 1.863e-3, 2.472e-3, 3.105e-3];
const slope = (n) => {
  let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { sxy += PM[i] * END[i]; sxx += PM[i] * PM[i]; }
  return sxy / sxx;
};
for (let i = 0; i < 3; i++) await setPair(i, PM[i], END[i]);
let cc = await p.evaluate(() => calibCoefficient());
check("3쌍만 채우면 nPairs=3", cc.nPairs === 3, `nPairs=${cc.nPairs}`);
check("3쌍 계수가 원점통과 LSQ 참값과 일치", near(cc.C, slope(3), 1e-9), `${cc.C} vs ${slope(3)}`);
check("5행이어도 빈 2행은 무시된다", cc.nPairs === 3 && (await visibleRows()) === 5);

await setPair(3, PM[3], END[3]);
cc = await p.evaluate(() => calibCoefficient());
check("4번째 쌍이 계수에 실제로 반영됨", cc.nPairs === 4 && near(cc.C, slope(4), 1e-9), `${cc.C} vs ${slope(4)}`);
await setPair(4, PM[4], END[4]);
cc = await p.evaluate(() => calibCoefficient());
check("5번째 쌍이 계수에 실제로 반영됨", cc.nPairs === 5 && near(cc.C, slope(5), 1e-9), `${cc.C} vs ${slope(5)}`);
check("계수가 참값 0.62 부근", near(cc.C, 0.62, 0.01), String(cc.C));

console.log("\n[표준오차]");
check("5회에서 표준오차가 나온다", isFinite(cc.seC) && cc.seC > 0, String(cc.seC));
const seTruth = (() => {   // 원점통과 LSQ, dof = n−1
  const C = slope(5);
  let ss = 0, sxx = 0;
  for (let i = 0; i < 5; i++) { const r = END[i] - C * PM[i]; ss += r * r; sxx += PM[i] * PM[i]; }
  return Math.sqrt(ss / 4 / sxx);
})();
check("표준오차가 residual 기반 참값과 일치", near(cc.seC, seTruth, 1e-9), `${cc.seC} vs ${seTruth}`);
check("계수 표시줄에 표준오차 렌더", (await p.$eval("#cb-coef", (e) => e.textContent)).includes("표준오차"),
  (await p.$eval("#cb-coef", (e) => e.textContent)).slice(0, 120));

console.log("\n[행 삭제 시 값이 실제로 지워지는가]");
await p.click("#cb-pair-del");      // 5 → 4
cc = await p.evaluate(() => calibCoefficient());
check("4행으로 줄면 5번째 값이 계수에서 빠진다", cc.nPairs === 4 && near(cc.C, slope(4), 1e-9), `nPairs=${cc.nPairs} C=${cc.C}`);
await p.click("#cb-pair-add");      // 4 → 5 (되살아나면 안 된다)
cc = await p.evaluate(() => calibCoefficient());
check("다시 5행으로 늘려도 지운 값은 되살아나지 않는다", cc.nPairs === 4, `nPairs=${cc.nPairs}`);
check("되살린 5번째 입력칸이 비어 있다", (await p.$eval('.cb-pm[data-i="4"]', (e) => e.value)) === "");

console.log("\n[저장·복원]");
await p.click("#cb-pair-del");      // 5 → 4 로 맞춰 두고 저장
await p.evaluate(() => saveCalib());
const stored = await p.evaluate(() => JSON.parse(localStorage.getItem("innoPrismCalib2")));
check("저장본에 행 수가 남는다", stored.pairRows === 4, `pairRows=${stored.pairRows}`);
check("저장본 pairs 길이 = 행 수", stored.pairs.length === 4, `len=${stored.pairs.length}`);

// 구버전 저장본(pairRows 없음 + 5쌍) → 데이터에서 5행으로 복원되어야 한다
// 1) 정규화 함수 자체를 직접 본다 (행 복원 규칙의 단위 검사)
const norm = await p.evaluate((pm) => {
  const c = { pairs: pm.map((v) => ({ pm: v, end: v * 0.62 })) };   // pairRows 없음 = 구버전
  normalizeCalibPairs(c);
  return { rows: c.pairRows, len: c.pairs.length };
}, PM);
check("구버전 객체(행 수 없음)를 5행으로 복원", norm.rows === 5 && norm.len === 5, JSON.stringify(norm));
const clamp = await p.evaluate(() => {
  const over = { pairs: Array.from({ length: 9 }, (_, i) => ({ pm: i + 1, end: (i + 1) * 0.5 })), pairRows: 9 };
  normalizeCalibPairs(over);
  const under = { pairs: [{ pm: 1, end: 0.5 }], pairRows: 1 };
  normalizeCalibPairs(under);
  const junk = { pairs: "망가진 값", pairRows: "x" };
  normalizeCalibPairs(junk);
  return { over: over.pairRows, overLen: over.pairs.length, under: under.pairRows, junk: junk.pairRows, junkLen: junk.pairs.length };
});
check("upper bound 초과 저장본은 5행으로 잘린다", clamp.over === 5 && clamp.overLen === 5, JSON.stringify(clamp));
check("lower bound 미만 저장본은 3행으로 채워진다", clamp.under === 3, `pairRows=${clamp.under}`);
check("손상된 저장본도 3행 기본으로 수습된다", clamp.junk === 3 && clamp.junkLen === 3, JSON.stringify(clamp));

// 2) 정말 새로 뜬 페이지에서도 그런지 — 로드 전에 localStorage 를 심는다
//    (file:// 는 context storageState 로 localStorage 가 옮겨가지 않아 addInitScript 를 쓴다)
const ctx3 = await browser.newContext();
await ctx3.addInitScript((pm) => {
  localStorage.setItem("innoPrismCalib2", JSON.stringify({ pairs: pm.map((v) => ({ pm: v, end: v * 0.62 })) }));
}, PM);
const p3 = await ctx3.newPage();
await p3.goto(HTML);
await p3.waitForFunction(() => window.PrismFit, null, { timeout: 60000 });
const restored = await p3.evaluate(() => ({ rows: App.calib.pairRows, n: calibCoefficient().nPairs, C: calibCoefficient().C }));
check("새 페이지에서 구버전 저장본 5행 복원", restored.rows === 5, `pairRows=${restored.rows}`);
check("구버전 저장본의 5쌍이 모두 계산에 들어감", restored.n === 5 && near(restored.C, 0.62, 1e-9), `nPairs=${restored.n} C=${restored.C}`);
await p3.click("#calib-btn");
check("복원된 화면도 5행 표시",
  (await p3.$$eval(".cb-pair-row", (rs) => rs.filter((r) => r.style.display !== "none").length)) === 5);


console.log("\n[단위: 입력·표시 µW / 저장 W]");
// 앞 절의 4쌍이 남아 있으면 계수가 그 4쌍의 기울기가 되므로, 깨끗한 페이지에서 본다
const ctxU = await browser.newContext();
const pU = await ctxU.newPage();
await pU.goto(HTML);
await pU.waitForFunction(() => window.PrismFit, null, { timeout: 60000 });
await pU.click("#calib-btn");
await pU.fill('.cb-pm[data-i="0"]', UW(1.00e-3));
await pU.fill('.cb-end[data-i="0"]', UW(6.22e-4));
await pU.dispatchEvent('.cb-end[data-i="0"]', "change");
await pU.dispatchEvent('.cb-pm[data-i="0"]', "change");
const u = await pU.evaluate(() => ({
  pm: App.calib.pairs[0].pm, end: App.calib.pairs[0].end,
  shownPm: document.querySelector('.cb-pm[data-i="0"]').value,
  head: Array.from(document.querySelectorAll(".modal table.res th")).map((e) => e.textContent).join(" | "),
}));
check("표 머리가 µW", u.head.includes("(µW)") && !u.head.includes("(W)"), u.head);
check("입력 µW → 저장은 W", Math.abs(u.pm - 1.00e-3) < 1e-12 && Math.abs(u.end - 6.22e-4) < 1e-12,
  `pm=${u.pm} end=${u.end}`);
check("저장 W → 화면은 µW (1000)", u.shownPm === "1000", u.shownPm);
const cU = await pU.evaluate(() => calibCoefficient().C);
check("1쌍만 있을 때 계수 = end/pm = 0.622 (단위 무관)", near(cU, 0.622, 1e-9), String(cU));
// 옛 저장본(W)이 µW 로 제대로 보이는지 — 단위 전환이 기존 값을 망치지 않는다
const ctx4 = await browser.newContext();
await ctx4.addInitScript(() => {
  localStorage.setItem("innoPrismCalib2", JSON.stringify({
    pairs: [{ pm: 1e-3, end: 6.2e-4 }, { pm: 2e-3, end: 1.24e-3 }, { pm: 5e-6, end: 3.1e-6 }],
  }));
});
const p4 = await ctx4.newPage();
await p4.goto(HTML);
await p4.waitForFunction(() => window.PrismFit, null, { timeout: 60000 });
await p4.click("#calib-btn");
const shown = await p4.$$eval(".cb-pm", (es) => es.slice(0, 3).map((e) => e.value));
check("옛 W 저장본이 µW 로 표시됨", shown.join(",") === "1000,2000,5", shown.join(","));
check("옛 저장본 계수 보존", near(await p4.evaluate(() => calibCoefficient().C), 0.62, 2e-3),
  String(await p4.evaluate(() => calibCoefficient().C)));

console.log("\n[면적 기준 기본값 = auto (측정된 교차점 1.35 로 선택)]");
const basis = await p4.evaluate(() => ({
  v: App.calib.areaBasis, sel: document.querySelector("#cb-basis").value,
  first: document.querySelector("#cb-basis option").value,
  userSet: App.calib.areaBasisUserSet,
}));
// v3.9 — 기본값이 auto 로 바뀌었다. 고정 d4sigma 는 면적비가 큰 실측 빔(관측 17.78)에서
// 유효면적을 그만큼 부풀려 파워밀도를 조용히 과소평가했다. auto 는 v3.6.2 에서 참값
// 대조로 잰 교차점(1.35)으로 고른다.
check("기본 면적 기준이 auto", basis.v === "auto" && basis.sel === "auto", JSON.stringify(basis));
check("선택지 첫 항목이 기본값", basis.first === "auto", basis.first);
check("옛 저장본(gauss, 직접 고른 적 없음)은 새 기본값으로 이관", basis.userSet !== true);
// 직접 고른 값은 보존되어야 한다
const ctx5 = await browser.newContext();
await ctx5.addInitScript(() => {
  localStorage.setItem("innoPrismCalib2", JSON.stringify({ areaBasis: "gauss", areaBasisUserSet: true }));
});
const p5 = await ctx5.newPage();
await p5.goto(HTML);
await p5.waitForFunction(() => window.PrismFit, null, { timeout: 60000 });
check("직접 고른 gauss 는 이관하지 않는다", (await p5.evaluate(() => App.calib.areaBasis)) === "gauss",
  await p5.evaluate(() => App.calib.areaBasis));
// 사용자가 바꾸면 표시가 남는다
await p5.goto(HTML); await p5.waitForFunction(() => window.PrismFit, null, { timeout: 60000 });
await p5.evaluate(() => { App.calib.areaBasis = "d4sigma"; App.calib.areaBasisUserSet = false; saveCalib(); });
await p5.click("#calib-btn");
await p5.selectOption("#cb-basis", "gauss");
await p5.dispatchEvent("#cb-basis", "change");
check("직접 고르면 userSet 표시가 남는다", (await p5.evaluate(() => App.calib.areaBasisUserSet)) === true);

console.log(fail ? `\n${fail} FAILURES` : "\nALL PASS");
await browser.close();
process.exit(fail ? 1 : 0);

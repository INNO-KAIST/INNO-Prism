import { chromium } from "playwright";
import fs from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
const here = dirname(fileURLToPath(import.meta.url));
const HTML = "file://" + join(here, "..", "INNO Prism.html").replace(/\\/g, "/");

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on("pageerror", (e) => console.log("[perr]", e.message.slice(0, 200)));
await page.goto(HTML);
await page.waitForFunction(() => window.h5wasm && window.PrismFit, null, { timeout: 60000 });
let fail = 0;
const check = (n, ok, info) => { console.log(`  ${ok ? "PASS" : "FAIL"} ${n}${info ? " — " + info : ""}`); if (!ok) fail++; };

// 1) 순수 비교 함수 검증 (한글/영문/숫자/제로패딩/소수점 혼용)
const r = await page.evaluate(() => {
  const t = (arr) => arr.slice().sort(naturalCompare);
  return {
    plain: t(["s10", "s9", "s1", "s21", "s2"]),
    pad:   t(["003_x", "10_x", "2_x", "001_x"]),
    kor:   t(["시료10", "시료2", "시료1"]),
    mixed: t(["260430_p2.h5", "260430_p10.h5", "250623_p1.h5"]),
    uw:    t(["012_190.9uW", "002_36.0uW", "000_30.7uW", "010_130.2uW"]),
    dot:   t(["v1.10.h5", "v1.9.h5", "v1.2.h5"]),
  };
});
check("숫자 자연순", JSON.stringify(r.plain) === JSON.stringify(["s1","s2","s9","s10","s21"]), r.plain.join(","));
// 제로패딩은 수치값 기준: 001=1 < 2 < 003=3 < 10
check("제로패딩 혼용", JSON.stringify(r.pad) === JSON.stringify(["001_x","2_x","003_x","10_x"]), r.pad.join(","));
check("한글 파일명", JSON.stringify(r.kor) === JSON.stringify(["시료1","시료2","시료10"]), r.kor.join(","));
check("날짜 접두 파일명", JSON.stringify(r.mixed) === JSON.stringify(["250623_p1.h5","260430_p2.h5","260430_p10.h5"]), r.mixed.join(","));
check("uW 트레이스 라벨", JSON.stringify(r.uw) === JSON.stringify(["000_30.7uW","002_36.0uW","010_130.2uW","012_190.9uW"]), r.uw.join(","));

// 2) 폴더 경로 그룹화 + 정렬 (webkitRelativePath 모사)
const g = await page.evaluate(() => {
  const mk = (path, seq, size, type) => ({ path, name: path.split("/").pop(), seq, size, det: { type } });
  App.files = [
    mk("B_folder/run2.h5", 1, 100, "power_apd"), mk("A_folder/run10.h5", 2, 300, "ple"),
    mk("A_folder/run2.h5", 3, 200, "power_apd"), mk("B_folder/run1.h5", 4, 50, "darkening"),
  ];
  const out = {};
  for (const m of ["name", "added", "type", "size"]) {
    App.settings.fileSort = m; sortFileList();
    out[m] = App.files.map((f) => f.path);
  }
  App.files = [];
  return out;
});
check("폴더 그룹 + 자연순", JSON.stringify(g.name) === JSON.stringify(["A_folder/run2.h5","A_folder/run10.h5","B_folder/run1.h5","B_folder/run2.h5"]), g.name.join(" "));
check("불러온 순 유지", JSON.stringify(g.added) === JSON.stringify(["B_folder/run2.h5","A_folder/run10.h5","A_folder/run2.h5","B_folder/run1.h5"]));
// 종류 알파벳순(darkening < ple < power_apd), 동일 종류 내부는 경로 자연순
check("측정 종류순", JSON.stringify(g.type) === JSON.stringify(["B_folder/run1.h5","A_folder/run10.h5","A_folder/run2.h5","B_folder/run2.h5"]), g.type.join(" "));
check("크기순(내림)", JSON.stringify(g.size) === JSON.stringify(["A_folder/run10.h5","A_folder/run2.h5","B_folder/run2.h5","B_folder/run1.h5"]), g.size.join(" "));

// 3) 실제 로드 후 App.files 순서 = 표시 순서 (일괄 피팅이 따르는 순서)
// 정렬 검증용 번호 파일 21개를 필요 시 생성 (1..21)
const seqDir = join(here, "testdata", "seq");
if (!fs.existsSync(seqDir)) {
  fs.mkdirSync(seqDir, { recursive: true });
  // 이 검사는 **정렬 순서**만 보므로 내용은 아무 h5 나 상관없다.
  // 저장소에 있는 것 중 아무거나 쓴다(예전엔 저장소에 없는 실측 파일을 참조했다).
  const src = ["synth_wave2d.h5", "synth_rise_exp.h5", "synth_rise_avalanche.h5"]
    .map((n) => join(here, "testdata", n)).find((n) => fs.existsSync(n));
  if (!src) { console.log("SKIP — testdata/ 에 h5 가 없어 정렬용 더미를 만들 수 없음"); process.exit(0); }
  for (let i = 1; i <= 21; i++) fs.copyFileSync(src, `${seqDir}/Sample_${i}.h5`);
}
const files = fs.readdirSync(seqDir).sort().map((f) => seqDir + "/" + f);
await page.setInputFiles("#file-input", files);
await page.waitForFunction((n) => document.querySelectorAll(".file-item").length >= n, files.length, { timeout: 120000 });
const same = await page.evaluate(() => {
  const shown = Array.from(document.querySelectorAll(".file-item")).map((e) => e.dataset.id);
  const state = App.files.map((f) => f.id);
  return { equal: JSON.stringify(shown) === JSON.stringify(state), first: App.files.slice(0, 3).map((f) => f.name) };
});
check("App.files 순서 = 화면 순서 (일괄 피팅 동일 순서)", same.equal, same.first.join(" "));
console.log(fail ? `\n${fail} FAILURES` : "\nALL PASS");
await browser.close();
process.exit(fail ? 1 : 0);

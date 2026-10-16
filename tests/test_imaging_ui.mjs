import { chromium } from "playwright";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
const here = dirname(fileURLToPath(import.meta.url));
const APP = "file://" + join(here, "..", "INNO Prism.html");
const DATA = (f) => join(here, "testdata", f);  // 실측 8파일을 tests/testdata/ 에 두고 실행
let fail = 0;
const check = (n, ok, info) => { console.log(`  ${ok ? "PASS" : "FAIL"} ${n}${info ? " — " + info : ""}`); if (!ok) fail++; };

const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const pg = await b.newPage();
const errs = [];
pg.on("pageerror", (e) => errs.push(String(e)));
pg.on("console", (m) => { if (m.type() === "error" && !/ERR_TUNNEL|favicon|ERR_NAME/.test(m.text())) errs.push("console: " + m.text()); });
await pg.goto(APP);
await pg.waitForFunction(() => typeof window.PrismH5 !== "undefined" && typeof window.PrismImg !== "undefined", null, { timeout: 30000 });
check("앱 로드 · PrismImg 노출", true);

await pg.setInputFiles("#file-input", [
  DATA("260827_110820_time_trace_on_off.h5"),
  DATA("260827_110553_time_trace_on_off.h5"),
  DATA("260827_112056_andor_ccd_readout.h5"),
  DATA("260827_112112_andor_ccd_readout.h5"),
  DATA("260827_113315_andor_ccd_readout.h5"),
]);
await pg.waitForFunction(() => typeof App!=="undefined" && App.files.length === 5, null, { timeout: 60000 });
const types = await pg.evaluate(() => App.files.map(f => ({n:f.name, t:f.det.type, l:f.det.label})));
check("5개 파일 모두 imaging 으로 인식", types.every(t => t.t === "imaging"), types.map(t=>`${t.n.slice(7,13)}:${t.t}`).join(" "));

// stack file
await pg.evaluate(() => selectFile(App.files.find(f=>/110820/.test(f.name)).id));
await pg.waitForSelector("#im-canvas", { timeout: 20000 });
await pg.waitForFunction(() => { const r=App.files.find(f=>/110820/.test(f.name)); return r.cache.imgState && r.cache.imgState.rois.length>0; }, null, {timeout:60000});
const s1 = await pg.evaluate(() => {
  const r = App.files.find(f=>/110820/.test(f.name)), st = r.cache.imgState;
  return { n: st.d.n, rois: st.rois.length, cmOk: st.cm && st.cm.ok, swing: st.cm && st.cm.commonSwing,
    indep: st.cm && st.cm.nIndependent, cad: st.evidence && !!st.evidence.cadence,
    cadStr: st.evidence && st.evidence.cadence && st.evidence.cadence.strength,
    fileRec: st.evidence && !!st.evidence.file, canvasW: document.querySelector("#im-canvas").width };
});
check("110820 스택 · 프레임 5 · ROI 검출됨", s1.n===5 && s1.rois>5, `ROI ${s1.rois}`);
check("캔버스 렌더됨", s1.canvasW > 100, `width=${s1.canvasW}`);
check("공통모드 계산됨 · swing≈1 (전역 변화 없음)", s1.cmOk && s1.swing < 1.2, `swing=${s1.swing?.toFixed(3)}`);
check("개별 거동 ROI 정확히 1개 (494,504 입자)", s1.indep === 1, `${s1.indep}개`);
check("파일에 상태 기록 없음을 올바로 보고", s1.fileRec === false);
check("간격 교대 근거 '강함'", s1.cadStr === "강함", String(s1.cadStr));

// adopt cadence hypothesis → contrast
await pg.evaluate(() => { const bs=[...document.querySelectorAll("[data-adopt]")]; const t=bs.find(b=>b.getAttribute("data-adopt")==="프레임 간격"); t && t.click(); });
await pg.waitForTimeout(400);
const s2 = await pg.evaluate(() => {
  const st = App.files.find(f=>/110820/.test(f.name)).cache.imgState;
  const body = document.querySelector("#contrast-body").textContent;
  return { assign: st.assign, from: st.assignFrom, hasTable: /Michelson/.test(body), both: /A÷B/.test(body) && /B÷A/.test(body) };
});
check("가설 채택 → 배정 반영", JSON.stringify(s2.assign)==="[0,1,0,1,0]", JSON.stringify(s2.assign));
check("대비표 · 양방향 비 둘 다 표시", s2.hasTable && s2.both);

// collapsed-field file
await pg.evaluate(() => selectFile(App.files.find(f=>/110553/.test(f.name)).id));
await pg.waitForFunction(() => { const r=App.files.find(f=>/110553/.test(f.name)); return r.cache.imgState && r.cache.imgState.cm; }, null, {timeout:60000});
const s3 = await pg.evaluate(() => {
  const st = App.files.find(f=>/110553/.test(f.name)).cache.imgState;
  return { swing: st.cm.commonSwing, dom: st.cm.commonDominant, indep: st.cm.nIndependent,
    unid: st.cm.nUnidentified, obs: st.cm.nObservable, pts: st.cm.nPoints,
    txt: document.querySelector("#cm-body").textContent.slice(0,200) };
});
check("110553 · 시야 전체가 함께 꺼짐으로 판정", s3.dom === true && s3.swing > 5, `swing=${s3.swing.toFixed(1)}`);
check("허위 '개별 스위칭' 0건 (관측가능성 게이트 작동)", s3.indep === 0, `${s3.indep}건`);
check("꺼진 프레임은 판정불가로 남김", s3.unid > 0 && s3.obs < s3.pts, `관측가능 ${s3.obs}/${s3.pts}, 판정불가 ${s3.unid}`);

// single frame file: no stack panels, still works
await pg.evaluate(() => selectFile(App.files.find(f=>/112056/.test(f.name)).id));
await pg.waitForFunction(() => { const r=App.files.find(f=>/112056/.test(f.name)); return r.cache.imgState && r.cache.imgState.rois.length>0; }, null, {timeout:60000});
const s4 = await pg.evaluate(() => {
  const st = App.files.find(f=>/112056/.test(f.name)).cache.imgState;
  return { n: st.d.n, rois: st.rois.length, hasTrace: !!document.querySelector("#chart-tr"),
    hasCmp: !!document.querySelector("#cmp-sel"), note: document.querySelector("#det-note").textContent.replace(/\s+/g," ").slice(0,160),
    nameNote: document.querySelector("#view").textContent.includes("2D 이미지") };
});
check("단일 프레임 · 스택 전용 패널 숨김", s4.n===1 && !s4.hasTrace);
check("spectrum 이름이지만 2D 이미지임을 고지", s4.nameNote);
check("비교 패널에 같은 크기 파일 목록 제공", s4.hasCmp);
console.log("   det-note:", s4.note);

// cross-file compare
await pg.evaluate(() => {
  const sel = document.querySelector("#cmp-sel");
  const ids = App.files.filter(f=>/112112|113315/.test(f.name)).map(f=>f.id);
  [...sel.options].forEach(o => { o.selected = ids.includes(o.value); });
  document.querySelector("#cmp-run").click();
});
await pg.waitForFunction(() => /이동량/.test(document.querySelector("#cmp-out").textContent), null, {timeout:90000});
const s5 = await pg.evaluate(() => document.querySelector("#cmp-out").textContent.replace(/\s+/g," "));
check("정합 결과 출력", /이동량/.test(s5) && /PSR/.test(s5));
check("넘어온 입자 거의 없는 조합에 경고", /넘어온 입자가 거의 없습니다/.test(s5) || !/113315/.test(s5), "");
console.log("   compare:", s5.slice(0, 420));

check("페이지 오류 없음", errs.length === 0, errs.slice(0,3).join(" | "));
await b.close();
console.log(fail ? `\n${fail}건 실패` : "\n전부 통과");
process.exit(fail?1:0);

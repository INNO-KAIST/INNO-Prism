import { chromium } from "playwright";
import { fileURLToPath } from "url"; import { dirname, join } from "path";
const here = dirname(fileURLToPath(import.meta.url));
const DATA=(f)=>join(here,"testdata",f);  // 실측 h5 를 tests/testdata/ 에 두고 실행
let fail=0; const check=(n,ok,i)=>{console.log(`  ${ok?"PASS":"FAIL"} ${n}${i?" — "+i:""}`);if(!ok)fail++;};
const b=await chromium.launch({executablePath:"/opt/pw-browsers/chromium"});
const pg=await b.newPage(); const errs=[];
pg.on("pageerror",e=>errs.push(String(e)));
pg.on("console",m=>{if(m.type()==="error"&&!/ERR_TUNNEL|favicon|ERR_NAME/.test(m.text()))errs.push(m.text());});
await pg.goto("file://"+join(here,"..","INNO Prism.html"));
await pg.waitForFunction(()=>typeof App!=="undefined"&&window.PrismImg,null,{timeout:30000});
await pg.setInputFiles("#file-input",["260827_110820_time_trace_on_off.h5","260827_110553_time_trace_on_off.h5"].map(DATA));
await pg.waitForFunction(()=>typeof App!=="undefined"&&App.files.length===2,null,{timeout:60000});
await pg.evaluate(()=>selectFile(App.files.find(f=>/110820/.test(f.name)).id));
await pg.waitForFunction(()=>{const r=App.files.find(f=>/110820/.test(f.name));return r.cache.imgState&&r.cache.imgState.cm;},null,{timeout:60000});

const s=await pg.evaluate(()=>{
  const st=App.files.find(f=>/110820/.test(f.name)).cache.imgState;
  const dep=PrismImg.modulationDepth(st.traces, st.blank);
  const sel=PrismImg.selectivity(st.rois, dep, st.target);
  return {target:st.target, tx:Math.round(st.rois[st.target].xc), ty:Math.round(st.rois[st.target].yc),
    tDepth:sel.target.depth, tLB:sel.target.isLowerBound, maxOther:sel.maxOtherDepth,
    ratio:sel.ratioToOthers, nq:sel.nearestQuiet&&{roi:sel.nearestQuiet.roi,d:sel.nearestQuiet.dist},
    sched:st.evidence.schedule&&st.evidence.schedule.assign, schedNote:st.evidence.schedule&&st.evidence.schedule.note,
    conflict:st.evidence.conflict, agree:st.evidence.agree,
    body:document.querySelector("#sel-body").textContent.replace(/\s+/g," ").slice(0,300)};
});
check("표적 자동 제안 = (494,504) 입자", s.tx===494&&s.ty===504, `#${s.target} (${s.tx},${s.ty})`);
check("표적 변조 깊이가 하한으로 보고됨 (최저값이 잡음 아래)", s.tLB===true, `깊이 ≥${s.tDepth.toFixed(1)}`);
check("표적이 나머지보다 압도적", s.ratio>3, `표적 ${s.tDepth.toFixed(1)} vs 나머지 최대 ${s.maxOther.toFixed(2)} (${s.ratio.toFixed(1)}배)`);
check("반응 없는 최근접 이웃으로 유효반경 상한 제시", !!s.nq, s.nq?`#${s.nq.roi} @ ${s.nq.d.toFixed(1)} px`:"없음");
check("num_cycle=2 · 5프레임 → 첫 장 기준 제외 배정", JSON.stringify(s.sched)==="[-1,0,1,0,1]", JSON.stringify(s.sched));
check("설정 근거와 간격 근거가 일치", s.conflict===false, JSON.stringify(s.agree));
console.log("   sel-body:", s.body);

await pg.evaluate(()=>{const t=[...document.querySelectorAll("[data-adopt]")].find(b=>b.getAttribute("data-adopt")==="측정 설정 구조");t&&t.click();});
await pg.waitForTimeout(400);
const c=await pg.evaluate(()=>{
  const st=App.files.find(f=>/110820/.test(f.name)).cache.imgState;
  const ct=PrismImg.contrast(st.traces, st.assign);
  return {assign:st.assign, from:st.assignFrom, t:ct.rows[st.target], body:document.querySelector("#contrast-body").textContent.replace(/\s+/g," ").slice(0,200)};
});
check("설정 근거 채택 → 기준 프레임 제외 배정", JSON.stringify(c.assign)==="[-1,0,1,0,1]", JSON.stringify(c.assign));
check("표적의 두 상태 대비가 크게 갈림", Math.abs(c.t.michelson)>0.8, `A=${c.t.meanA.toFixed(0)} B=${c.t.meanB.toFixed(0)} Michelson=${c.t.michelson.toFixed(3)}`);

// darkening/recovery 프리셋
await pg.evaluate(()=>{const s=document.querySelector("#st-labels");s.value="darkrec";s.dispatchEvent(new Event("change"));});
await pg.waitForTimeout(300);
const p=await pg.evaluate(()=>document.querySelector("#contrast-body").textContent.replace(/\s+/g," "));
check("darkening/recovery 용어 프리셋 적용", /recovery 후/.test(p)&&/darkening 후/.test(p));

// 110553 — 전역
await pg.evaluate(()=>selectFile(App.files.find(f=>/110553/.test(f.name)).id));
await pg.waitForFunction(()=>{const r=App.files.find(f=>/110553/.test(f.name));return r.cache.imgState&&r.cache.imgState.cm;},null,{timeout:60000});
const g=await pg.evaluate(()=>{
  const st=App.files.find(f=>/110553/.test(f.name)).cache.imgState;
  return {dom:st.cm.commonDominant, indep:st.cm.nIndependent, conflict:st.evidence.conflict,
    sched:st.evidence.schedule&&st.evidence.schedule.assign,
    cm:document.querySelector("#cm-body").textContent.replace(/\s+/g," "),
    sel:document.querySelector("#sel-body").textContent.replace(/\s+/g," ")};
});
check("110553 · 전역 변화로 판정 · 개별 0건", g.dom===true&&g.indep===0);
check("공통모드 설명이 '기기 탓' 단정을 하지 않음", /기기 탓.*아닙니다/.test(g.cm)&&/시료 쪽/.test(g.cm));
check("110553 · 표적이 두드러지지 않음을 명시", /두드러지지 않습니다/.test(g.sel), g.sel.slice(-260));
check("110553 · num_cycle=1 · 3프레임 배정", JSON.stringify(g.sched)==="[-1,0,1]", JSON.stringify(g.sched));
check("110553 · 근거 충돌 표시", g.conflict===true);
check("페이지 오류 없음", errs.length===0, errs.slice(0,2).join(" | "));
await b.close();
console.log(fail?`\n${fail}건 실패`:"\n전부 통과");
process.exit(fail?1:0);

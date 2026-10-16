import { chromium } from "playwright";
import { fileURLToPath } from "url"; import { dirname, join } from "path";
const here=dirname(fileURLToPath(import.meta.url));
let fail=0; const check=(n,ok,i)=>{console.log(`  ${ok?"PASS":"FAIL"} ${n}${i?" — "+i:""}`);if(!ok)fail++;};
const b=await chromium.launch({executablePath:"/opt/pw-browsers/chromium"});
const pg=await b.newPage(); const errs=[];
pg.on("pageerror",e=>errs.push(String(e)));
pg.on("console",m=>{if(m.type()==="error"&&!/ERR_TUNNEL|favicon|ERR_NAME/.test(m.text()))errs.push(m.text());});
await pg.goto("file://"+join(here,"..","INNO Prism.html"));
await pg.waitForFunction(()=>typeof App!=="undefined"&&window.PrismImg,null,{timeout:30000});
await pg.setInputFiles("#file-input",[join(here,"testdata","260827_110820_time_trace_on_off.h5")]);
await pg.waitForFunction(()=>typeof App!=="undefined"&&App.files.length===1,null,{timeout:60000});
await pg.waitForFunction(()=>{const r=App.files[0];return r.cache.imgState&&r.cache.imgState.cm;},null,{timeout:60000});
const r=await pg.evaluate(()=>{
  const d=App.files[0].cache.imgState.d;
  const det=document.querySelector("details");
  if(det) det.open=true;
  return {cam:d.camera.name, camConn:d.camera.connected, nCand:d.camera.nCandidates,
    rejected:d.camera.rejected, nConn:d.hardware.nConnected, nDis:d.hardware.nDisconnected,
    rows:d.hardware.rows.map(x=>`${x.name}:${x.connected}`),
    txt:document.querySelector("#view").textContent.replace(/\s+/g," ")};
});
check("연결된 카메라를 골랐다 (미연결 emccd 제외)", r.cam==="andor_ccd"&&r.camConn===true, `${r.cam} (후보 ${r.nCand}개)`);
// emccd 그룹은 속성 이름이 PascalCase 라 카메라 후보 점수에 못 미친다 → 후보 1개가 정상.
check("카메라 후보가 1개면 제외 목록은 비어 있다", r.rejected.length===0, JSON.stringify(r.rejected));
check("쓰이지 않은 emccd 그룹도 표에 미연결로 노출된다", r.rows.includes("emccd:false"));
check("연결/미연결 집계", r.nConn===5&&r.nDis===6, `연결 ${r.nConn} · 미연결 ${r.nDis}`);
check("side_beam_power_wheel 이 미연결로 표시됨", r.rows.includes("side_beam_power_wheel:false"));
check("이름을 광학계로 읽지 말라는 경고가 있다", /이름만 보고 이 측정의 광학계라고 읽지 마십시오/.test(r.txt));
check("미연결 항목 설정이 무의미함을 명시", /연결 안 된 항목의 설정값은 이 측정에 대해 아무것도 말해 주지 않습니다/.test(r.txt));
check("용어 프리셋에 특정 장비명(side beam) 이 없다", !/side beam/i.test(r.txt), (r.txt.match(/side beam[^.]*/i)||[""])[0]);
check("페이지 오류 없음", errs.length===0, errs.slice(0,2).join(" | "));
await b.close();
console.log(fail?`\n${fail}건 실패`:"\n전부 통과");
process.exit(fail?1:0);

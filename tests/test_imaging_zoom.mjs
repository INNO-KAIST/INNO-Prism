import { chromium } from "playwright";
import { fileURLToPath } from "url"; import { dirname, join } from "path";
const here=dirname(fileURLToPath(import.meta.url));
let fail=0; const check=(n,ok,i)=>{console.log(`  ${ok?"PASS":"FAIL"} ${n}${i?" — "+i:""}`);if(!ok)fail++;};
const VP={width:1440,height:900};
const b=await chromium.launch({executablePath:"/opt/pw-browsers/chromium"});
const pg=await b.newPage({viewport:VP}); const errs=[];
pg.on("pageerror",e=>errs.push(String(e)));
pg.on("console",m=>{if(m.type()==="error"&&!/ERR_TUNNEL|favicon|ERR_NAME/.test(m.text()))errs.push(m.text());});
await pg.goto("file://"+join(here,"..","INNO Prism.html"));
await pg.waitForFunction(()=>typeof App!=="undefined"&&window.PrismImg,null,{timeout:30000});
await pg.setInputFiles("#file-input",[join(here,"testdata","260827_110820_time_trace_on_off.h5")]);
await pg.waitForFunction(()=>typeof App!=="undefined"&&App.files.length===1,null,{timeout:60000});
await pg.waitForSelector("#im-canvas");
await pg.waitForFunction(()=>{const r=App.files[0];return r.cache.imgState&&r.cache.imgState.disp;},null,{timeout:60000});

const geom=()=>pg.evaluate(()=>{
  const cv=document.querySelector("#im-canvas"), r=cv.getBoundingClientRect();
  const st=App.files[0].cache.imgState;
  return {top:Math.round(r.top),bottom:Math.round(r.bottom),w:Math.round(r.width),h:Math.round(r.height),
    vh:window.innerHeight, view:{...st.view}, scale:st.disp.scale, lab:document.querySelector("#im-zoomlab").textContent};
});
let g=await geom();
check("기본값에서 이미지 전체가 뷰포트 안에 들어온다", g.bottom<=g.vh, `캔버스 하단 ${g.bottom}px · 뷰포트 ${g.vh}px`);
check("기본값은 전체 영역(자르지 않음)", g.view.w===1024&&g.view.h===1024, `view ${g.view.w}×${g.view.h}`);
check("정사각 이미지가 정사각으로 표시", Math.abs(g.w-g.h)<=1, `${g.w}×${g.h}`);
check("배율 표시", /%/.test(g.lab), g.lab);
const fitScale=g.scale, fitW=g.w;

await pg.click("#im-zoomin"); await pg.waitForTimeout(150);
let z=await geom();
check("확대 → 보는 영역이 좁아지고 배율이 커진다", z.view.w<1024&&z.scale>fitScale, `view ${Math.round(z.view.w)} · ${Math.round(z.scale*100)}%`);
check("확대해도 캔버스가 화면을 넘지 않는다", z.bottom<=z.vh&&z.w<=fitW+2, `하단 ${z.bottom} · 폭 ${z.w}`);

await pg.click("#im-zoomout"); await pg.click("#im-zoomout"); await pg.waitForTimeout(150);
let o=await geom();
check("축소는 전체 이상으로 넘어가지 않는다", o.view.w<=1024&&o.view.h<=1024, `view ${Math.round(o.view.w)}×${Math.round(o.view.h)}`);

await pg.click("#im-zoomin"); await pg.click("#im-zoomin"); await pg.click("#im-fit"); await pg.waitForTimeout(150);
let f=await geom();
check("화면 맞춤 = 원상복구", f.view.w===1024&&f.view.h===1024&&Math.abs(f.scale-fitScale)<1e-6, `view ${f.view.w} · ${Math.round(f.scale*100)}%`);

await pg.click("#im-1to1"); await pg.waitForTimeout(150);
let one=await geom();
check("1:1 은 화소 대 화소", Math.abs(one.scale-1)<0.02, `${(one.scale*100).toFixed(1)}%`);
check("1:1 에서도 화면을 넘지 않는다", one.bottom<=one.vh, `하단 ${one.bottom}px`);

await pg.keyboard.press("0"); await pg.waitForTimeout(150);
let k=await geom();
check("0 키 = 화면 맞춤", k.view.w===1024, `view ${k.view.w}`);
await pg.keyboard.press("1"); await pg.waitForTimeout(150);
check("1 키 = 화소 1:1", Math.abs((await geom()).scale-1)<0.02);
await pg.keyboard.press("0"); await pg.waitForTimeout(150);

// 작은 창
await pg.setViewportSize({width:1100,height:620}); await pg.waitForTimeout(400);
let sm=await geom();
check("창을 줄이면 자동으로 다시 맞춘다", sm.bottom<=sm.vh&&sm.scale<fitScale, `하단 ${sm.bottom}/${sm.vh} · ${Math.round(sm.scale*100)}%`);

// ROI 오버레이 정렬 (hidpi)
await pg.setViewportSize(VP); await pg.waitForTimeout(400);
const ov=await pg.evaluate(()=>{
  const st=App.files[0].cache.imgState, cv=document.querySelector("#im-canvas");
  const svg=document.querySelector("#im-ovl"), c=svg.querySelector("circle");
  const vb=svg.getAttribute("viewBox").split(" ").map(Number);
  const p=st.rois[0], v=st.view;
  const expect=((p.xc)-v.x)*(st.disp.w/v.w);
  return {vbW:vb[2], dispW:st.disp.w, cvW:cv.width, cx:Number(c.getAttribute("cx")), expect};
});
check("오버레이 viewBox 가 표시 크기(CSS px) 기준", ov.vbW===ov.dispW, `viewBox ${ov.vbW} · disp ${ov.dispW} · backing ${ov.cvW}`);
check("ROI 원 위치가 어긋나지 않는다", Math.abs(ov.cx-ov.expect)<1.5, `${ov.cx.toFixed(1)} vs ${ov.expect.toFixed(1)}`);
check("페이지 오류 없음", errs.length===0, errs.slice(0,2).join(" | "));
await b.close();
console.log(fail?`\n${fail}건 실패`:"\n전부 통과");
process.exit(fail?1:0);

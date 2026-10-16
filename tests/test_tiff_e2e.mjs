import { chromium } from "playwright";
import fs from "fs"; import { fileURLToPath } from "url"; import { dirname, join } from "path";
const here=dirname(fileURLToPath(import.meta.url));
const TIF=join(here,"prism_repro","beam_crop512_rgb48.tif");
let fail=0; const ck=(n,ok,i)=>{console.log(`  ${ok?"PASS":"FAIL"} ${n}${i?" — "+i:""}`);if(!ok)fail++;};
if(!fs.existsSync(TIF)){console.log("SKIP — fixture 없음");process.exit(0);}
const b=await chromium.launch({executablePath:"/opt/pw-browsers/chromium",args:["--no-sandbox"]});
const p=await (await b.newContext()).newPage();
const perr=[]; p.on("pageerror",e=>perr.push(e.message.slice(0,200)));
await p.goto("file://"+join(here,"..","INNO Prism.html").replace(/\\/g,"/"));
await p.waitForFunction(()=>window.PrismTiff&&window.PrismEngine,null,{timeout:60000});
await p.click("#calib-btn");
for(const [s,v] of [["#cb-pitch","6.45"],["#cb-mag","60"],["#cb-lambda","1064"]]) if(await p.$(s)){await p.fill(s,v);await p.dispatchEvent(s,"change");}
await p.setInputFiles("#cb-img-input",TIF);
await p.waitForFunction(()=>{const t=document.querySelector("#cb-beam-status").textContent||"";return !t.includes("__PENDING__") && (t.includes("피팅 완료")||t.includes("실패"));},null,{timeout:240000});
const r=await p.evaluate(()=>({
  text:document.querySelector("#cb-beam-status").textContent,
  src:App.calib.beam.source, sat:App.calib.beam.nSatFull,
  q:App.calib.beam.integrity.quantStep, clean:App.calib.beam.integrity.clean,
  bin:App.calib.beam.binChosenBy, sfw:App.calib.beam.sampledFwhmPx,
  A:App.calib.metrics.areaPeakUm2, r2:App.calib.beam.r2,
}));
console.log(`   ${JSON.stringify(r.src)}`);
console.log(`   quantStep=${r.q?.toFixed(5)} A_peak=${r.A.toFixed(4)} R²=${r.r2.toFixed(3)} f선택=${r.bin} 샘플링FWHM=${r.sfw?.toFixed(2)}`);
ck("TIFF 가 canvas 우회로 열린다", r.src && r.src.kind==="tiff", JSON.stringify(r.src));
ck("16-bit 컨테이너를 인식", r.src.bitsPerSample===16, String(r.src.bitsPerSample));
ck("유효 12-bit 를 검출", r.src.effectiveBits===12, String(r.src.effectiveBits));
ck("양자화 계단이 8-bit(1.0) 가 아니다", r.q<0.1, String(r.q));
ck("화면에 비트깊이가 표시된다", /16-bit TIFF 직접 읽기/.test(r.text)&&/유효 12-bit/.test(r.text), "");
ck("포화 오인이 없다 (peak 149/255)", r.sat===0, String(r.sat));
const j=JSON.parse(await p.evaluate(()=>{let o=null;const d=window.downloadText;window.downloadText=(n,t)=>{o=t};exportCalibSession();window.downloadText=d;return o;}));
ck("내보내기에 source 가 기록된다", j.beam.source && j.beam.source.kind==="tiff" && j.beam.source.effectiveBits===12, JSON.stringify(j.beam?.source));
ck("페이지 오류 없음", perr.length===0, perr.slice(0,2).join(" | "));
await b.close();
console.log(fail?`\n${fail} FAILURES`:"\nALL PASS");
process.exit(fail?1:0);

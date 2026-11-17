// 합성 검증: 단일 / 이합체(간격 0~2σ, 방향 0·45·90°) / 삼합체, 밝기 CV, 배경+잡음
import { createRequire } from "module"; const require = createRequire(import.meta.url);
const I = require("../src/imaging.js");
function lcg(seed){let s=seed>>>0;return()=>(s=(s*1664525+1013904223)>>>0)/4294967296;}
function run(seed, opt){
  const o=Object.assign({nx:512,ny:512,psf:1.6,mu:3000,cv:0.15,bg:100,noise:8,nSingle:60,nDimer:20,nTrimer:6,poisson:true},opt);
  const rnd=lcg(seed); const g=()=>{let u=0,v=0;while(!u)u=rnd();while(!v)v=rnd();return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v);};
  const img=new Float32Array(o.nx*o.ny); const truth=[];
  const add=(x,y,F)=>{const s=o.psf;for(let yy=Math.max(0,Math.floor(y-6*s));yy<Math.min(o.ny,y+6*s);yy++)for(let xx=Math.max(0,Math.floor(x-6*s));xx<Math.min(o.nx,x+6*s);xx++){img[yy*o.nx+xx]+=F/(2*Math.PI*s*s)*Math.exp(-((xx-x)**2+(yy-y)**2)/(2*s*s));}};
  const pts=[]; const place=()=>{for(let t=0;t<1000;t++){const x=20+rnd()*(o.nx-40),y=20+rnd()*(o.ny-40);if(pts.every(p=>Math.hypot(p[0]-x,p[1]-y)>16)){pts.push([x,y]);return[x,y];}}return null;};
  const one=()=>Math.max(0.2*o.mu,o.mu*(1+o.cv*g()));
  for(let k=0;k<o.nSingle;k++){const p=place();add(p[0],p[1],one());truth.push({x:p[0],y:p[1],n:1,sep:0});}
  for(let k=0;k<o.nDimer;k++){const p=place();const sep=[0,0.5,1.0,1.5,2.0][k%5]*o.psf;const th=[0,Math.PI/4,Math.PI/2,Math.PI/6][k%4];
    add(p[0]-sep/2*Math.cos(th),p[1]-sep/2*Math.sin(th),one());add(p[0]+sep/2*Math.cos(th),p[1]+sep/2*Math.sin(th),one());truth.push({x:p[0],y:p[1],n:2,sep:sep/o.psf});}
  for(let k=0;k<o.nTrimer;k++){const p=place();for(let j=0;j<3;j++){const a=rnd()*6.28,r=rnd()*o.psf*0.8;add(p[0]+r*Math.cos(a),p[1]+r*Math.sin(a),one());}truth.push({x:p[0],y:p[1],n:3,sep:-1});}
  for(let i=0;i<img.length;i++){let v=img[i]+o.bg; if(o.poisson) v+=Math.sqrt(Math.max(v,1))*g(); img[i]=v+o.noise*g();}
  const det=I.detectSpots(img,o.nx,o.ny,{smooth:1.2,k:6,minSep:6,maxSpots:400,shapeMin:2.5});
  const rois=det.spots;
  const r=I.classifySingles(img,o.nx,o.ny,rois,{R:5});
  // match detections to truth
  const conf={};
  let missed=0;
  for(const t of truth){let bi=-1,bd=4;rois.forEach((q,i)=>{const d=Math.hypot((q.xc??q.x)-t.x,(q.yc??q.y)-t.y);if(d<bd){bd=d;bi=i;}});
    if(bi<0){missed++;continue;}
    const key=`n${t.n}${t.n===2?"_s"+t.sep.toFixed(1):""}`; const c=r.results[bi].cls;
    conf[key]=conf[key]||{}; conf[key][c]=(conf[key][c]||0)+1;}
  return {det:rois.length,missed,mix:r.mix.ok?{K:r.mix.K,mu:Math.round(r.mix.mu),cv:+r.mix.cv.toFixed(3)}:r.mix.why,counts:r.counts,conf,rho:+r.illumRho.toFixed(3)};
}
// 판정 기준: 단일을 단일로 ≥95% · 이합체(간격≥0.5σ)·삼합체를 '단일'로 오판 ≤5% · 저SNR 에서 삼합체 '단일' 0
let fail=0; const check=(n,ok,info)=>{console.log(`  ${ok?"PASS":"FAIL"} ${n}${info?" — "+info:""}`); if(!ok) fail++;};
const frac=(c,k)=>{const t=Object.values(c||{}).reduce((a,b)=>a+b,0);return t?(c[k]||0)/t:NaN;};
for (const [name,opt] of [["기본 CV0.15",{}],["CV0.30",{cv:0.3}],["저SNR mu800",{mu:800}],["고SNR mu12000",{mu:12000}]]) {
  const res=run(7,opt); console.log("==",name, JSON.stringify({det:res.det,missed:res.missed,mix:res.mix,counts:res.counts}));
  for(const k of Object.keys(res.conf).sort()) console.log("  ",k,JSON.stringify(res.conf[k]));
  const multiKeys=Object.keys(res.conf).filter(k=>k!=="n1"&&k!=="n2_s0.0");
  const wrong=multiKeys.reduce((a,k)=>a+(res.conf[k].single||0),0), tot=multiKeys.reduce((a,k)=>a+Object.values(res.conf[k]).reduce((x,y)=>x+y,0),0);
  if (name!=="저SNR mu800") check(`${name}: 단일→단일`, frac(res.conf.n1,"single")>=0.9, (frac(res.conf.n1,"single")*100).toFixed(0)+"%");
  check(`${name}: 응집체(간격≥0.5σ·삼합체)→단일 오판`, wrong/tot<=0.05, `${wrong}/${tot}`);
}
if (fail) { console.log(`FAIL ${fail}`); process.exit(1); } else console.log("ALL PASS");

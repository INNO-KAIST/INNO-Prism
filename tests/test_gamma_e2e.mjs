/* v3.11 표시 감마 보정 E2E — 실제 무손실 BMP 로 확인 */
import { chromium } from "playwright";
import fsx from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { materialize, tmpDir } from "./fixture_bmp.mjs";
const here = dirname(fileURLToPath(import.meta.url));
const HTML = "file://" + join(here, "..", "INNO Prism.html").replace(/\\/g, "/");
/* 픽스처는 **저장소 안**에 둔다. 옛 기본값 `/home/claude/reg2/beam950.bmp` 는 클라우드
 * 컨테이너 경로라 세션마다 사라졌고, 그 파일은 연결 폴더 어디에도 없다.
 * 저장 형태는 BMP 가 아니라 **8-bit gray 평면(gz)** 이다 — 복원본은 원본 BMP 와
 * 바이트 단위로 동일하므로(`fixture_bmp.mjs` 참고) 단정은 하나도 바뀌지 않는다.
 *   beam_gamma050 — ProgRes gamma 0.50 실촬영(16-bit TIFF → ÷256 → 24bpp BMP). 양성 대조
 *   beam_g033     — 같은 장면·같은 노출 gamma 0.33(선형). **음성 대조** */
const FIXW = 1360, FIXH = 1024;
const TMP = tmpDir("gamma");
const BMP = process.env.BEAM_BMP
  || materialize(TMP, join(here, "testdata", "beam_gamma050_gray8.bin.gz"), "beam_gamma050.bmp", FIXW, FIXH);
const BMP_LINEAR = process.env.BEAM_BMP_LINEAR
  || materialize(TMP, join(here, "testdata", "beam_g033_gray8.bin.gz"), "beam_g033.bmp", FIXW, FIXH);
if (!BMP) { console.log("SKIP — testdata/beam_gamma050_gray8.bin.gz 없음"); process.exit(0); }
let fail = 0;
const check=(n,ok,i)=>{console.log(`  ${ok?"PASS":"FAIL"} ${n}${i?" — "+i:""}`); if(!ok)fail++;};
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
const p = await (await b.newContext()).newPage();
p.on("pageerror", e => console.log("[perr]", e.message.slice(0,200)));
await p.goto(HTML); await p.waitForFunction(()=>window.PrismFit,null,{timeout:60000});
await p.click("#calib-btn");
// 대물렌즈: 6.45/60 이 되도록 objMag 를 직접 세팅
// upd() 는 DOM 을 읽으므로 상태를 직접 세팅하면 덮어써진다 — 입력칸을 채운다
for (const [sel, v] of [["#cb-pitch","6.45"],["#cb-mag","60"],["#cb-lambda","1064"]]) {
  if (await p.$(sel)) { await p.fill(sel, v); await p.dispatchEvent(sel, "change"); }
}
console.log("   eff µm/px =", await p.evaluate(()=>calibEffUmPerPx()));

async function run(gamma, file = BMP) {
  await p.fill("#cb-gamma", gamma === 1 ? "" : String(gamma));
  await p.dispatchEvent("#cb-gamma", "change");
  /* 업로드 대기의 **경쟁 조건 방지.** 상태줄에는 이전 업로드의 "피팅 완료" 가 그대로
   * 남아 있으므로, setInputFiles 직후 바로 폴링하면 조건이 이미 참이라 **이전 파일의
   * 상태를 읽고 끝난다**(실제로 음성 대조가 직전 파일 결과를 읽어 오판했다).
   * 업로드 전에 표식을 넣어 "이번 업로드가 끝났는지"를 본다. */
  await p.evaluate(() => { document.querySelector("#cb-beam-status").textContent = "__PENDING__"; });
  await p.setInputFiles("#cb-img-input", file);
  await p.waitForFunction(()=>{const t=document.querySelector("#cb-beam-status").textContent||"";return !t.includes("__PENDING__") && (t.includes("피팅 완료")||t.includes("실패"));},null,{timeout:180000});
  return p.evaluate(()=>({
    html: document.querySelector("#cb-beam-status").innerHTML,
    gamma: App.calib.displayGamma,
    sx: App.calib.beam.sx, sy: App.calib.beam.sy, bin: App.calib.beam.binFactor,
    r2: App.calib.beam.r2, enc: App.calib.beam.enclosedRatio,
    m: App.calib.metrics,
    basis: (calibBasisSigma() || {}).src, ratio: App.calib.beam.d4sAreaRatio,
    encK: App.calib.beam.growthRadiusSigma,
    growth: (App.calib.beam.growth || []).map((q) => ({ k: q.kSigma, R: q.R, ratio: q.ratio })),
    umPerPx: calibEffUmPerPx(),
    L: App.calib.beam.integrity?.upscale?.L,
    lin: App.calib.beam.integrity?.linearity?.verdict,
    beta: App.calib.beam.integrity?.linearity?.beta,
    blocked: App.calib.beam.integrity?.blocking?.blocked,
  }));
}
const DL = 0.51*1.064/1.42;
console.log("[γ=1 — 보정 없음]");
const a1 = await run(1);
console.log(`   L=${a1.L?.toFixed(3)}  블록압축=${a1.blocked}  선형성=${a1.lin} (β=${a1.beta?.toFixed(3)})`);
console.log(`   FWHM ${a1.m.fwhmXum.toFixed(3)} × ${a1.m.fwhmYum.toFixed(3)} µm = ${(a1.m.fwhmXum/DL).toFixed(2)}× / ${(a1.m.fwhmYum/DL).toFixed(2)}× 회절한계   A_peak ${a1.m.areaPeakUm2.toFixed(4)} µm²  enc=${a1.enc?.toFixed(3)}`);
check("무압축 원본에서 업스케일 없음", Math.abs(a1.L-1)<0.05, `L=${a1.L?.toFixed(3)}`);
check("블록압축 없음", a1.blocked===false||a1.blocked===undefined, String(a1.blocked));
check("톤커브 검출됨", a1.lin==="nonlinear", a1.lin);
check("감마 제안 문구 표시", a1.html.includes("표시 감마 보정"), "");

console.log("[γ=2.2 — 되돌림]");
const a2 = await run(2.2);
console.log(`   FWHM ${a2.m.fwhmXum.toFixed(3)} × ${a2.m.fwhmYum.toFixed(3)} µm = ${(a2.m.fwhmXum/DL).toFixed(2)}× / ${(a2.m.fwhmYum/DL).toFixed(2)}× 회절한계   A_peak ${a2.m.areaPeakUm2.toFixed(4)} µm²  enc=${a2.enc?.toFixed(3)}`);
check("γ 가 상태에 저장됨", a2.gamma===2.2, String(a2.gamma));
check("상태줄에 되돌림 표시", a2.html.includes("되돌림"), "");
check("FWHM 이 줄어듦 (감마는 폭을 부풀린다)", a2.m.fwhmXum < a1.m.fwhmXum && a2.m.fwhmYum < a1.m.fwhmYum,
  `${a1.m.fwhmXum.toFixed(3)}→${a2.m.fwhmXum.toFixed(3)}, ${a1.m.fwhmYum.toFixed(3)}→${a2.m.fwhmYum.toFixed(3)}`);
/* halo(enclosedRatio) 단정은 **삭제했다.** 물리 법칙이 아니기 때문이다:
 * 조리개 반경이 적합 σ 에 비례하고(R = kσ·√(σx σy)) 분모인 core flux 도 적합 A·σx·σy 라,
 * 분자와 분모가 둘 다 적합에 따라 움직인다. γ 를 되돌리면 코어가 좁아지며 조리개도 같이
 * 좁아지므로 비의 **방향은 빔마다 다르다** — 이 빔은 3.074 → 3.588 로 늘어난다.
 * 진단 출력으로만 남긴다. */
console.log(`   [진단] halo(enclosedRatio @${a1.encK}σ→@${a2.encK}σ) ${a1.enc?.toFixed(3)} → ${a2.enc?.toFixed(3)}`
  + ` — 조리개가 적합 σ 에 비례하므로 두 적합 사이에서 비교 가능한 양이 아니다`);

/* 대신 **γ>1 인코딩을 되돌릴 때 반드시 일어나는 것**만 단정한다.
 * 멱함수 I = 255·(y/255)^γ (γ>1) 은 볼록·단조라 저계조를 더 눌러 프로파일을 가파르게 한다.
 * 배경 0 인 이상 Gaussian 이면 σ → σ/√γ 로 정확히 줄어든다. 실빔은 배경·halo 때문에
 * 그 값을 따르지 않지만 **방향은 따른다.** */
check("A_peak 이 줄어듦", a2.m.areaPeakUm2 < a1.m.areaPeakUm2,
  `${a1.m.areaPeakUm2.toFixed(4)} → ${a2.m.areaPeakUm2.toFixed(4)} µm²`);
/* 면적 기준(basis)이 두 실행 사이에서 바뀌는 것을 **드러내 놓고 고정**한다.
 * 이 픽스처에서 A_peak 6.1배 감소는 폭 축소만의 결과가 아니라 auto-basis 가
 * d4sigma(d4sAreaRatio 0.946) → gauss(4.233) 로 넘어간 것이 함께 들어간 값이다.
 * 이걸 단정하지 않으면 그 전환이 A_peak 숫자 뒤에 숨는다. */
check("면적 기준 전환이 그대로다 (d4sigma → gauss)", a1.basis === "d4sigma" && a2.basis === "gauss",
  `${a1.basis}(ratio ${a1.ratio?.toFixed(3)}) → ${a2.basis}(ratio ${a2.ratio?.toFixed(3)})`);
check("회절한계 배수가 줄어든다", (a2.m.fwhmXum / DL) < (a1.m.fwhmXum / DL),
  `${(a1.m.fwhmXum / DL).toFixed(2)}× → ${(a2.m.fwhmXum / DL).toFixed(2)}×`);
/* 아래는 **이 픽스처에 고정한 값**이지 빔 독립적 법칙이 아니다 — 다른 빔은 정당하게
 * 4배를 넘을 수 있다. 픽스처를 바꾸면 이 줄을 같이 고쳐야 한다. */
check("[픽스처 고정] 되돌린 뒤 회절한계 4배 미만", (a2.m.fwhmXum / DL) < 4,
  `${(a2.m.fwhmXum / DL).toFixed(2)}×`);
check("무결성 판정은 원본 기준 유지 (γ 를 넣어도 여전히 톤커브 검출)", a2.lin==="nonlinear", a2.lin);
const ex = await p.evaluate(()=>{ let out=null; const o=window.downloadText; window.downloadText=(n,t)=>{out=t;}; exportCalibSession(); window.downloadText=o; return out; });
const j = JSON.parse(ex);
check("내보내기 JSON 에 displayGamma 기록", j.displayGamma===2.2, String(j.displayGamma));
check("내보내기 JSON 에 integrity 기록", !!(j.beam&&j.beam.integrity), JSON.stringify(j.beam?.integrity||null).slice(0,120));
/* ---- 음성 대조: 같은 장면·같은 노출, gamma 0.33(선형) ----------------------
 * 양성 대조만 있으면 "톤커브를 검출한다"는 것만 확인되고 **선형 파일을 가만히 두는지**는
 * 확인되지 않는다. v3.16 의 C 수정(구조적 판정불가는 clean 을 내리지 않는다)을
 * 합성물이 아니라 **실촬영본으로** 고정한다. */
console.log("[음성 대조 — gamma 0.33 선형]");
if (!BMP_LINEAR) {
  console.log("   SKIP — testdata/beam_g033_gray8.bin.gz 없음");
} else {
  const a0 = await run(1, BMP_LINEAR);
  const q = await p.evaluate(() => {
    const g = App.calib.beam.integrity;
    return { clean: g.clean, verdict: g.linearity?.verdict, applicable: g.linearity?.applicable,
      issues: (g.issues || []).map((i) => i.kind), notes: (g.notes || []).map((n) => n.kind),
      verified: g.verified, L: g.upscale?.L, blocked: g.blocking?.blocked };
  });
  console.log(`   L=${q.L?.toFixed(3)} blocked=${q.blocked} linearity=${q.verdict ?? "(ok:false)"} clean=${q.clean}`);
  console.log(`   issues=[${q.issues.join(",")}] notes=[${q.notes.join(",")}]`);
  check("선형 파일을 톤커브로 오판하지 않는다", q.verdict !== "nonlinear", String(q.verdict));
  check("구조적 판정불가가 clean 을 내리지 않는다 (v3.16 C)", q.clean === true, `clean=${q.clean}`);
  check("그래도 '검증됨' 이라고 말하지 않는다", q.verified && q.verified.linearity === false,
    JSON.stringify(q.verified));
  check("적용 불가를 notes 로만 올린다", q.notes.includes("linearity-not-applicable")
    && !q.issues.includes("linearity-unverified"), `issues=[${q.issues.join(",")}]`);
}

/* ---- growth 반경 단위 (v3.17.1) --------------------------------------------
 * kσ 만으로는 다른 적합과 비교할 수 없다. 내보내기에 물리 반경이 실려야 하고,
 * 그 값이 pf(미리보기 비닝)만큼 틀어지지 않아야 한다. */
const ex2 = await p.evaluate(() => { let o = null; const d = window.downloadText;
  window.downloadText = (n, t) => { o = t; }; exportCalibSession(); window.downloadText = d; return o; });
const j2 = JSON.parse(ex2);
const gg = j2.beam && j2.beam.growth;
check("내보내기 growth 에 물리 반경이 실린다", Array.isArray(gg) && gg.length
  && isFinite(gg[0].rUm) && isFinite(gg[0].rPx), JSON.stringify(gg && gg[0]));
if (Array.isArray(gg) && gg.length) {
  /* rUm = rPx × umPerPxUsed × binFactor 가 성립해야 한다. growth[].R 을 pf 로 환산하지
   * 않으면 이 관계가 pf 배(이 자료 5배) 깨진다 — 그게 v3.17.1 에서 고친 함정이다. */
  const want = gg[0].rPx * j2.umPerPxUsed * j2.beam.binFactor;
  check("rUm 이 rPx × µm/px × binFactor 와 일치 (pf 단위 함정)",
    Math.abs(gg[0].rUm / want - 1) < 1e-9, `${gg[0].rUm?.toFixed(4)} vs ${want.toFixed(4)}`);
  /* 1σ 조리개 반경이 적합 σ 와 같은 스케일인지 — 단위가 어긋나면 여기서 드러난다 */
  const sigUm = Math.sqrt(j2.beam.sx * j2.beam.sy) * j2.umPerPxUsed * j2.beam.binFactor;
  check("1σ 반경이 √(σx σy) 와 일치", Math.abs(gg[0].rUm / sigUm - 1) < 0.02,
    `${gg[0].rUm?.toFixed(4)} µm vs √(σxσy)=${sigUm.toFixed(4)} µm`);
}

await b.close();
try { fsx.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
console.log(fail?`\n${fail} FAILURES`:"\nALL PASS");
process.exit(fail?1:0);

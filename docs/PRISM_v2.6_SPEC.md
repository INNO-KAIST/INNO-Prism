# INNO Prism v2.6 구현 사양 — 뷰어 재설계 + 엔진 결함 5건 + 회귀 테스트

작성 2026-09-03 · 대상 `src/app.js`, `src/fit2.js`, `src/h5layer.js`, `tests/`
검증 데이터: `260803_(power_scan)_WJ-0139c #4 (Oil, Blue).h5` (APD, 242 setpoint × 5 rep, acq 0.1 s)

---

## 0. 먼저 — 앞 대화에서 내가 틀렸던 3가지 정정

원본 HDF5를 열고 `fit2.js`를 Node에서 직접 돌려 재현한 결과, 앞 답변의 진단 3건이 사실과 달랐습니다.

**(1) "aggMode=high의 max-of-5가 극값 통계라 a₁을 오염시킨다" — 틀렸습니다. 애초에 max 집계가 일어나지 않습니다.**

`h5layer.js`의 `extractPATrace()`가 `apd_counter_apd_count_rates_raw` (242×5)를 **읽자마자 5회 평균으로 뭉갭니다**:

```js
const flat1D = (r) => r.shape.length === 1 ? Array.from(r.data, Number)
  : rows2D(r).map((row) => row.reduce((a, b) => a + b, 0) / row.length);   // ← 여기서 소실
```

그 다음 `paHighState()`가 wheel position별로 max를 취하는데, 한 branch 안에서 각 wheel position은 **정확히 1회만** 등장합니다(160→220 up, 220→160 down, 0.5 스텝). 즉 "1개짜리 그룹의 max" = 그 값 자체입니다.

실측 확인:

| analysis.data.I | 원시 5회 평균 | 원시 5회 max | 원시 5회 |
|---|---|---|---|
| 122.0 | **122.0** | 160.0 | 70, 130, 120, 130, 160 |
| 2442.0 | **2442.0** | 2650.0 | 2370, 2650, 2320, 2610, 2260 |
| 124864.0 | **124864.0** | 126750.0 | 125310, 124380, 122780, 125100, 126750 |

UI가 "고상태 max (논문 표준)"이라 표시하고 차트가 "고상태 envelope (피팅 데이터)"라는 별도 트레이스를 그리고 있지만, 이 파일에서 그 트레이스는 **원본 점 위에 똑같은 점을 덧그린 것**입니다. 지저분하다고 느끼신 게 맞고, 그것은 취향 문제가 아니라 **거짓 라벨** 문제입니다.

**(2) "w를 고정하면 k₂가 600(상한)까지 달아난다" — 상한은 60입니다.**
`fitHinge()`의 θ 박스가 `lo=-60, hi=60`이고 `k₂ = softplus(θ₃)`이므로 실효 상한은 k₂ ≈ 60. 아래 실험에서 여러 설정이 정확히 `k2=60.00`으로 멈춥니다 — **그런데 현재 이 박스 접촉을 알리는 플래그가 없습니다.**

**(3) "스플라인 우측 붕괴는 단조 P-spline의 전형적 경계 불안정" — 아닙니다. 재현 가능한 1줄 버그입니다.**

`makeSplineBasis().evalBasis()`의 0차 지시함수:

```js
for (let i = 0; i < knots.length - 1; i++) {
  if ((x >= knots[i] && x < knots[i+1]) || (x === xhi && Math.abs(knots[i+1]-xhi) < 1e-12 && knots[i] < x)) N[i] = 1;
}
```

`x = xhi`일 때 **두 개의 구간이 동시에 1이 됩니다**: 특례가 켜는 `[xhi−dx, xhi]`와, 일반 규칙이 켜는 `[xhi, xhi+dx]`(x ≥ knots[i] 이므로 성립). 단위분할(partition of unity)이 깨져 x=xhi에서 기저 합이 2가 됩니다. 결과:

- **평가 오염**: 마지막 격자점 `splineCurve[239]`이 8.41×10⁸ (직전 2.90×10⁴).
- **적합 오염(이쪽이 훨씬 심각)**: x=xhi인 **데이터 점**의 설계행렬 행도 2배가 되어 최소제곱해 자체가 망가지고, 3차 B-spline의 지지폭만큼(deg+1 = 4 knot span ≈ 0.14 dec) **뒤로 전파**됩니다.

이 파일에서 그 결과:

| x | I 실측 | splineCurve | 실측/스플라인 | s_tot |
|---|---|---|---|---|
| −2.762 | 55,258 | 2.90e4 | 1.90 | −0.00 |
| −2.705 | 86,424 | 2.90e4 | 2.98 | −0.00 |
| −2.662 | 115,676 | 2.90e4 | 3.99 | −0.00 |
| −2.654 | 124,864 | **8.41e8** | 0.00 | −0.01 |

즉 상위 0.11 decade에서 비모수층이 **완전히 평탄화**되어 있고(실측 기울기 4.07인데 s_tot = 0), 마지막 점만 폭주합니다. "교차검증 층"이 그 구간에서 작동하지 않은 상태로 `agreement.sMaxGapPct`와 품질 점수에 반영돼 왔습니다.

**이건 이 파일만의 문제가 아닙니다.** 기존 합성 시나리오 전체에서 재현됩니다(1줄 수정 전후):

| 시나리오 | 참값 s_max | 현재 sTotMax | 현재 splineEnd | 수정 후 sTotMax | 수정 후 splineEnd |
|---|---|---|---|---|---|
| pure_n2 | 2.000 | 2.60 (**+30%**) | 1.3e11 | **2.01** | 1.0e7 |
| aval_mid | 7.111 | 8.06 (+13%) | 2.7e21 | **7.08** | 1.1e12 |
| aval_giant | 21.760 | 21.84 | 3.3e25 | 21.68 | 4.4e12 |
| saturating | 3.000 | 2.99 | 2.6e8 | 2.84 | 4.9e4 |

파라메트릭 s_max는 전 시나리오에서 **변화 없음**(회귀 없음), 비모수 s_tot,max는 참값 회수가 크게 개선. 수정 코드는 아래 E3에 있고 이미 검증했습니다.

---

## 1. 실측 노이즈의 실제 구조 (원시 5회 반복으로 직접 측정)

원시 반복이 살아 있으면 노이즈 법칙은 **추정할 필요 없이 측정**됩니다. acq time τ = 0.1 s.

| 구간 | 반복 CV(실측) | Poisson 예측 CV | 초과비 |
|---|---|---|---|
| 암계수 (I < 300, n=119) | 0.253 | 0.284 | **0.89** |
| 밝은 구간 (I > 1000, n=116) | 0.036 | 0.017 | **1.91** |

원시 반복에서 `Var = a₀² + a₁I + (a₂I)²` 적합 → **a₁ = 8.51 ≈ 1/τ = 10** (사전지식 없이 Poisson 회수), a₂ = 0.033.

그런데 이것만으로는 부족합니다. 인접 setpoint 사이 실측 산포(65782 → 72954 → 54218 → 50014 …)는 **setpoint 내부 반복 산포보다 훨씬 큽니다**. 0.5초 안의 반복은 잡지 못하는 **setpoint 간 드리프트/점멸** 성분입니다. 파일럿 잔차에서 반복분산을 뺀 초과분이 정확히 그것이고, 비례 성분 a₂ ≈ 0.105로 측정됩니다.

**결론: 노이즈는 2성분이어야 합니다.**

```
σ²(I) = [a₀² + a₁·I]           ← 계수 통계 (원시 반복 / Poisson 바닥, τ에서 a₁ ≥ 1/τ)
      + (a₂·I)²                 ← setpoint 간 초과 (파일럿 잔차 − 반복분산)
```

| I | 현재 엔진 | 반복만 | 파일럿만 | **2성분(권장)** | 실측 |
|---|---|---|---|---|---|
| 125 (암계수) | 0.174 | 0.263 | 0.174 | **0.283** | 0.28 |
| 2,442 | 0.174 | 0.068 | 0.174 | **0.125** | — |
| 125,000 | 0.174 | 0.034 | 0.174 | **0.110** | ~0.11 |

현재 엔진은 암계수에서 1.6× 과소(→ 정보량 0인 63점에 과대 가중), 밝은 구간에서 1.6× 과대. **반복만 쓰면 반대로 망합니다** — 아래 실험 B에서 χ²/dof = 222까지 튀고 모델 차수 선택이 H1로 잘못 내려갑니다. 두 성분을 다 써야 합니다.

---

## 2. 수정 후에도 이 파일의 PA는 보고 불가 (파이프라인 변형 5종 실험)

스플라인 버그를 고친 상태에서 노이즈 법칙과 w 하한만 바꿔가며 재적합했습니다.

| 변형 | 노이즈 | w하한 | 차수 | **s_max** | @P | k₂ | maxCorr | χ²/dof | 품질 |
|---|---|---|---|---|---|---|---|---|---|
| A+ | 현행(파일럿) | 0.02 | H2 | **16.66** | 1.10e−3 | 27.5 | 1.000 | 1.86 | 33.6 |
| B+ | 반복만 | 0.02 | H1 | **5.49** | 2.22e−3 | 5.5 | 0.974 | **222** | 25.7 |
| C+ | 2성분 | 0.02 | H2 | **54.88** | 5.60e−4 | **60(상한)** | 0.996 | 1.32 | 37.0 |
| D+ | 2성분 | 0.005 | H2 | **49.78** | 6.80e−4 | **60(상한)** | 0.999 | 1.32 | 36.0 |
| E+ | 현행 | 0.005 | H2 | **56.72** | 5.55e−4 | **60(상한)** | 0.985 | 1.76 | 54.9 |

s_max가 5.5 ~ 56.7로 **10배 요동**하고, 모든 변형에서 `maxParamCorr ≥ 0.97`(D+는 0.999), 4/5에서 k₂가 박스 상한에 붙습니다. 이는 CR이 시드마다 11.5↔101.2로 요동한 것과 **같은 성질의 비식별성**이며, 우도면이 평탄하다는 뜻입니다.

반면 두 값은 변형에 걸쳐 안정적입니다:

- **s_tot,max (비모수) = 22.0 ~ 28.2** — 스플라인 버그 수정 후 처음으로 신뢰 가능해진 수치.
- **PA_jump = 127.68, Δlog₁₀P = 0.0055, P_th = 1.05×10⁻³ W** — 격자 한계 하한, 변형 무관.

→ **이 파일의 방어 가능한 보고는 "PA ≥ 격자 한계, P_th = 1.05 mW, 분해 front는 결정 불가"이며, 엔진 수정 후에도 바뀌지 않습니다.** 수정의 목적은 이 파일에서 숫자를 얻는 것이 아니라, (a) 정직한 파일에서 정답을 얻는 것과 (b) 이 파일에서 "결정 불가"를 **이유와 함께** 말하게 만드는 것입니다.

---

## 3. 엔진 수정 사양

### E1 — 원시 반복 보존 (최우선, 다른 모든 수정의 전제)

**`src/h5layer.js` `extractPATrace()` (≈L409)**

```js
// power_apd 분기: 평균으로 뭉개기 전에 원시 배열을 함께 반환
const rawRows = P.shape.length === 2 ? rows2D(I) : null;
const acqR = readDataset(file, `${base}/apd_counter_acq_times`);
return { P: flat1D(P), I: flat1D(I), W,
         Iraw: rawRows,                                   // n × nReps, 없으면 null
         acqTime: acqR && acqR.data.length ? Number(acqR.data[0]) : NaN };
```
EMCCD 분기도 동일하게 `sp.shape = [n, reps, pix]`에서 rep별 band 적분을 보존해 `Iraw`로 반환(현재 L441-445에서 rep 평균으로 소실).

**`src/fit2.js` `paHighStateBranch()` (≈L1197)**
`paHighState()` / `paMergeClose()`가 병합 시 어떤 원본 행을 골랐는지 인덱스를 함께 반환하도록 바꾸고, 최종 branch에 `intensityReplicates`를 채웁니다.

```js
return { powerAvg: Pm, intensityAvg: m.I,
         powerStd: …, intensityStd: …,
         intensityReplicates: m.srcIdx.map((j) => Iraw ? Iraw[j] : null),
         acqTime, aggApplied: m.srcIdx.map((j) => groupSize[j]) };   // 실제 집계 개수
```

**`aggApplied`가 핵심입니다.** 모든 원소가 1이면 "고상태 max"는 일어나지 않았으므로 UI는 그렇게 표시해야 합니다(V7).

### E2 — 2성분 노이즈 모델

**`src/fit2.js` `analyze()` (≈L601-680)**

현재 구조: `vm.source === "replicates"`면 파일럿 잔차 보정 블록을 **건너뜁니다**(L613 `if (vm.source === "difference-based")`). 이것이 실험 B의 χ²/dof = 222을 만든 원인입니다.

```js
// (1) 계수 통계 성분
let cnt = reps ? fitVarianceLaw(repPairs, I, null, "replicates") : null;
if (isFinite(o.acqTime) && o.acqTime > 0 && detectorIsCounting) {
  cnt = cnt || { a0: 0, a1: 0, a2: 0 };
  cnt.a1 = Math.max(cnt.a1, 1 / o.acqTime);      // Poisson 바닥은 물리 하한
}
// (2) setpoint 간 초과 성분 — 반복 유무와 무관하게 항상 실행
const pilotLaw = pilotResidualLaw(x, I, o);       // 기존 L613-680 블록을 함수로 추출
const a2Excess = medianOverBins(max(varPilot - varCnt, 0) / I²)^(1/2);
// (3) 합성
vm.a0 = cnt ? cnt.a0 : pilotLaw.a0;
vm.a1 = cnt ? cnt.a1 : pilotLaw.a1;
vm.a2 = Math.hypot(cnt ? cnt.a2 : 0, a2Excess);
vm.source = cnt ? "replicates+interset" : "pilot-residual(calibrated)";
vm.components = { counting: cnt, excess: a2Excess };   // JSON/뷰어 노출
```

`nReps` 나눗셈 주의: `sigI[i] = vm.sigmaOfI(I[i]) / sqrt(nReps[i])`는 **계수 성분에만** 적용해야 합니다. setpoint 간 초과 성분은 반복을 늘려도 줄지 않습니다.

```js
sigI[i] = Math.hypot(sigCnt(I[i]) / Math.sqrt(nReps[i]), a2Total * I[i]);
```

또한 원시 반복이 있으면 **집계 방식에 따른 표준오차 보정**이 필요합니다: `aggMode=high`로 실제 max-of-N이 일어난 setpoint에서는 σ_env = c_N·σ_single (정규 근사 c₃=0.75, c₅=0.669, c₁₀=0.587). *부트스트랩 max는 쓰지 마십시오* — 부트스트랩은 극값에 대해 비일관 추정량이라 이 파일에서 0.45로 25% 과소평가됐습니다.

### E3 — 스플라인 기저 경계 버그 (1줄, 검증 완료)

**`src/fit2.js` `makeSplineBasis().evalBasis()` (≈L240)**

```js
// BEFORE
for (let i = 0; i < knots.length - 1; i++) {
  if ((x >= knots[i] && x < knots[i+1]) || (x === xhi && Math.abs(knots[i+1]-xhi) < 1e-12 && knots[i] < x)) N[i] = 1;
}
// AFTER — 지시함수는 정확히 하나만 켜져야 한다
for (let i = 0; i < knots.length - 1; i++) {
  if (x >= knots[i] && x < knots[i + 1]) { N[i] = 1; break; }
}
if (x >= xhi) {
  N.fill(0);
  for (let i = 0; i < knots.length - 1; i++) {
    if (Math.abs(knots[i + 1] - xhi) < 1e-12 && knots[i] < xhi) { N[i] = 1; break; }
  }
}
```

부수 효과(정상): GCV가 정상 작동을 되찾아 이 파일 λ 0.0058 → 8.30, edf 25.0 → 19.3. 모든 파일에서 `agreement.sMaxGapPct`가 줄어들어 **품질 점수가 전반적으로 상승**합니다(그동안 자기 점수를 부당하게 깎고 있었습니다).

### E4 — 경계 접촉 플래그 (s_max를 점추정으로 보고하지 않는 조건)

**`src/fit2.js` `fitHinge()` + `analyze()`**

```js
const BOUND_TOL = 1e-3;
const boundHits = [];
if (Math.abs(p.w - W_FLOOR) < BOUND_TOL) boundHits.push({ param: "w", at: "floor", value: W_FLOOR });
if (order === 2 && Math.abs(p.v - W_FLOOR) < BOUND_TOL) boundHits.push({ param: "v", at: "floor" });
if (order === 2 && Math.abs((p.t2 - p.t1) - W_FLOOR) < BOUND_TOL) boundHits.push({ param: "t2-t1", at: "floor" });
best.theta.forEach((t, j) => { if (Math.abs(Math.abs(t) - 60) < 0.05) boundHits.push({ param: `theta[${j}]`, at: "box", derived: j===3?"k2":j===2?"k1":j===4?"k3":"B" }); });
```

`analyze()` 반환에 `boundHits`를 추가하고, **비어 있지 않으면 `sMaxIsLowerBound = true`, `sMaxBoundReason = "constraint"`**로 설정. `evaluate()`의 identifiability 성분에서 감점하고, `reportable`을 false로 내립니다.

w 하한 자체는 0.02 → **0.005**로 낮추되, 별도 게이트를 둡니다: `w < 0.5 × median(Δlog P)`이면 "격자보다 좁은 전이 — 분해 불가" 경고. 이 파일은 Δlog P = 0.0063이므로 w < 0.0032가 무의미한 영역입니다. 하한을 낮추는 것만으로는 아무것도 해결되지 않고(실험 E+: 16.7 → 56.7로 오히려 발산), **경고를 낼 수 있게 되는 것**이 목적입니다.

### E5 — 전이 구간 이상치 보호

**`src/fit2.js` `analyze()` (≈L698-706)**

```js
const t1Pilot = pilot.params.t1, wPilot = pilot.params.w;
const inFront = (i) => isFinite(t1Pilot) && Math.abs(x[i] - t1Pilot) < 3 * Math.max(wPilot, 2 * medianDx);
outlierIdx = flagged.filter(([i]) => !inFront(i)).slice(0, cap).map((f) => f[0]);
const frontScatter = flagged.filter(([i]) => inFront(i)).map((f) => f[0]);   // 제외하지 않고 별도 보고
```

`diagnostics.frontScatter`로 반환. 현재 이 파일에서 제외된 7점(idx 69,71,72,73,74,76,78)은 log P −2.977 ~ −2.924로 **점화 전선 그 자체**이며, 이들은 이상치가 아니라 측정 대상입니다.

### E6 — B ↔ k₁ 축퇴 해소

`paDarkOf()`가 이미 암계수 D를 계산합니다(이 파일 D ≈ 125). `analyze()`에 `o.darkPrior`를 받아 B의 시작값 겸 약한 사전값으로 사용하고, `k₁`을 순수 발광 기울기로 해방합니다. 실험 C+/D+에서 2성분 노이즈만 넣어도 B가 1.0e−24 → 121로 정상화되어 축퇴가 실제로 풀립니다(다만 그 대가로 k₂가 상한에 붙으므로 E4 플래그가 반드시 함께 필요).

### E7 — 라벨 정직성

`aggApplied`의 최대값이 1이면:
- UI 셀렉트 라벨: "고상태 max (논문 표준)" → **"고상태 max (이 파일: 반복 1회/setpoint → 평균과 동일)"**
- 차트의 "고상태 envelope" 트레이스는 **그리지 않음** (원본과 동일한 점이므로)
- JSON `settings.aggMode`에 `aggEffective: "none" | "max-of-N"` 병기

---

## 4. 뷰어 재설계 사양

원칙: **기본 화면에는 "데이터 + 피팅 곡선 + PA 위치 + I_th 위치 + 잔차" 다섯 가지만.** 나머지는 전부 칩 토글.

### V1 — 레이어 칩 (기본 표시 최소화)

`renderPowerScan()`의 차트 패널 헤더(≈L1243)에 칩 행 추가. `App.settings.layers`로 영속화.

| 레이어 | 기본 | 비고 |
|---|---|---|
| 데이터 (up/down) | **ON** | |
| 피팅 곡선 | **ON** | 라벨을 "모델 H2 (파라메트릭)" → **"피팅 곡선"**으로. 차수는 툴팁/결과카드에만 |
| PA 마커 | **ON** | V2 |
| I_th 마커 | **ON** | V3 |
| 제외점 | **ON** | 속 빈 X, 작게 |
| 잔차 패널 | **ON** | V4 |
| 고상태 envelope | OFF | `aggEffective==="none"`이면 칩 자체를 숨김 |
| P-spline | OFF | 켜면 얇은 점선 + 회색 |
| 가중치 크기 | OFF | V6 |
| 부트스트랩 밴드 | OFF | 진단 실행 시에만 칩 활성 |
| 수동 기울기 윈도우 | OFF | 기존 `#m-toggle` 흡수 |

구현: `drawPowerChart()` 상단에서 `const L = App.settings.layers`를 읽고 각 `traces.push`를 `if (L.xxx)`로 감쌉니다. Plotly `visible:"legendonly"`는 쓰지 마십시오 — 범례에 계속 남아 "지저분함"이 해결되지 않습니다.

### V2 — PA(s_max) 위치 마커 ★ 핵심

현재 s_max 별표는 기울기 차트(`drawSlopeChart`)에만 있습니다. **I–P 차트에 올려야 합니다.** PA는 기울기이므로 **접선 선분**으로 그리는 것이 가장 직관적입니다.

```js
if (L.pa && analysis && isFinite(analysis.sMaxAtP)) {
  const xs = Math.log10(analysis.sMaxAtP);
  const Is = modelIAt(xs);                       // modelCurve 보간
  const half = 0.10 * (xhi - xlo);               // 접선 길이 = x범위의 20%
  const tangent = (dx) => Is * Math.pow(10, analysis.sMax * dx);
  shapes.push({ type:"line", xref:"x", yref:"y", layer:"above",
    x0: Math.pow(10, xs-half)*k, y0: tangent(-half),
    x1: Math.pow(10, xs+half)*k, y1: tangent(+half),
    line:{ color: PALETTE.yellow, width: 3 } });
  traces.push({ x:[analysis.sMaxAtP*k], y:[Is], mode:"markers", type:"scatter",
    name:"PA (최대 기울기 지점)",
    marker:{ size:13, symbol:"star", color:PALETTE.yellow, line:{width:1.5,color:"#1a1a19"} } });
  annotations.push({ x: Math.log10(analysis.sMaxAtP*k), y: Math.log10(Is), yshift: 26,
    text: `PA = <b>${fmt(analysis.sMax,3)}</b>${analysis.sMaxIsLowerBound?" (하한)":""}`,
    showarrow:false, font:{size:13,color:PALETTE.yellow},
    bgcolor:"rgba(26,26,25,0.8)", borderpad:3 });
}
```

접선 선분이 데이터의 실제 급경사와 겹치는지가 **눈으로 바로 보이는** 피팅 검증이 됩니다.

**미분해 점프 케이스**(`paSource === "jump"`)는 접선이 아니라 **구간 음영**으로:

```js
shapes.push({ type:"rect", xref:"x", yref:"paper",
  x0: Math.pow(10, Math.log10(paJump.pth) - paJump.dlogP/2)*k,
  x1: Math.pow(10, Math.log10(paJump.pth) + paJump.dlogP/2)*k,
  y0:0, y1:1, fillcolor:"rgba(201,133,0,0.14)", line:{width:0} });
// 라벨: "미분해 점프 — PA ≥ 127.7 (Δlog₁₀P = 0.0055)"
```

이 파일에서는 **점프 음영이 주 마커, 분해 front 접선은 회색 보조**로 그려야 보고값과 화면이 일치합니다.

### V3 — I_th(문턱 파워) 마커 ★ 핵심

현재 `thresholdP`/`saturationP`는 `#c3c2b7` 1px dashdot 세로선일 뿐 **라벨이 없습니다**. 무엇을 뜻하는지 화면에서 알 수 없습니다.

```js
const marker = (xv, label, color, sub) => {
  shapes.push({ type:"line", x0:xv*k, x1:xv*k, yref:"paper", y0:0, y1:1,
                line:{ color, width:1.8, dash:"dashdot" } });
  annotations.push({ x: Math.log10(xv*k), xref:"x", yref:"paper", y:1.0, yanchor:"bottom",
    text:`<b>${label}</b> = ${fmt(xv,3)} W${sub?`<br><span style="font-size:10.5px">${sub}</span>`:""}`,
    showarrow:false, font:{size:12, color}, bgcolor:"rgba(26,26,25,0.85)", borderpad:3 });
};
if (L.ith && isFinite(analysis.thresholdP))
  marker(analysis.thresholdP, "I_th", PALETTE.magenta,
         densityActive() ? `${fmt(analysis.thresholdP*kd/du.div,3)} ${du.name}` : "");
if (L.ith && isFinite(analysis.saturationP)) marker(analysis.saturationP, "P_sat", "#8b8a80");
if (analysis.thresholdOutOfRange) /* 라벨에 "외삽" 뱃지 */;
```

파워밀도 단위가 활성이면 2행 라벨로 W와 밀도를 함께 표시(결과 카드와 동일 값).

### V4 — 잔차 패널 (단일 figure의 2행 subplot)

`#chart-power` **한 개 div 안에서** y축을 둘로 나눕니다. 별도 div + relayout 동기화는 줌/PNG 내보내기에서 어긋나므로 쓰지 않습니다.

```js
yaxis:  { domain:[0.34,1.0], type:"log", title:{text:ylab}, … },
yaxis2: { domain:[0.0,0.26], title:{text:"잔차 (dex)"}, zeroline:true, zerolinecolor:"#5a5a52" },
xaxis:  { type:"log", anchor:"y2", title:{text:xUnitLabel()}, … },
```

잔차 트레이스(`yaxis:"y2"`): `r_i = log10(I_i) − log10(model(x_i))`, 사용점은 채운 원, 제외점은 속 빈 X.
±1σ / ±3σ 밴드는 `noise` 법칙에서 계산한 **점별** 폭이므로 `fill:"tonexty"` 두 쌍으로 그립니다(상수 밴드가 아님 — 암계수 28%, 고출력 11%로 폭이 달라지는 것이 그 자체로 정보).

`setupManualHandles()`가 `fl.yaxis._offset/_length`를 쓰므로(≈L1530) domain 변경 후에도 상단 subplot을 가리켜 그대로 동작합니다. 다만 핸들 높이가 상단 66%로 줄어드는 것은 의도된 동작입니다.

### V5 — 미스핏 구간 자동 하이라이트

`runsTest`를 숫자가 아니라 그림으로. 연속 3점 이상 잔차가 같은 부호이고 |r| > 2σ인 구간에 `yref:"paper"` 음영 + 라벨 "이 구간을 따라가지 못함". 이 파일에서는 점화 전선(잔차 rms 0.335 dex)이 정확히 잡힙니다.

### V6 — 정규화 뷰 토글 + 가중치 크기

- **정규화 뷰**: y를 `I / model`로 바꾸고 축을 선형 0.5–2.0. 3.19 decade 축에서 숨는 오차가 전부 드러납니다. 칩 하나로 상단 패널만 전환.
- **가중치 크기**: `marker.size = 5 + 7 * (w_i / max w)`, `w_i = irlsW[i] / σ_G,i²` 정규화. "왜 곡선이 저기로 갔는가"가 보입니다.

### V7 — 스플라인/envelope 표시 규칙

- P-spline은 토글 ON일 때만, `width:1.2, dash:"dot"`, 색 `#6b6a62`(모델보다 확실히 뒤로).
- E3 수정 후에도 `max(splineCurve) > 10 × max(I)`인 구간은 회색 처리하고 `agreement` 지표에 "무효" 뱃지.
- envelope는 E7의 `aggEffective === "none"`이면 칩 자체를 렌더하지 않음.

### V8 — 결과 카드 문구

`renderFitResults()`(≈L1660)에서 `boundHits`가 비어 있지 않으면 hero 카드에:

> ⚠ **제약 접촉**: w = 0.005(하한), k₂ = 60(박스 상한) — s_max는 데이터가 아니라 제약이 만든 값입니다. 점추정으로 보고하지 마십시오.

---

## 5. 회귀 테스트 추가안

### R1 `tests/test_spline_basis.mjs` (신규 · 현재 실패)
```js
// 단위분할: 임의의 x와 특히 x=xhi에서 기저 합 = 1
const b = F.__makeSplineBasis(-3, -1, 12, 3);      // export 필요
for (const xv of [...랜덤 200점, xhi, xhi-1e-15, xlo]) {
  const s = b.evalBasis(xv, false).reduce((a, v) => a + v, 0);
  assert(Math.abs(s - 1) < 1e-9, `partition of unity at ${xv}: ${s}`);
}
// 1차 도함수 합 = 0
```

### R2 `tests/test_fit2.js` 확장 — 비모수층 참값 회수
기존 시나리오별로 `|sTotMax − truth.sMax| / truth.sMax < 0.10` 추가. 현재 pure_n2가 +30%로 실패, E3 후 +0.5%로 통과.

### R3 스플라인 경계 건전성 (전 시나리오)
`max(splineCurve) < 10 × max(data.I)` 및 `splineCurve[last] / splineCurve[last-1] < 3`.

### R4 `tests/test_pa_identifiability.mjs` (신규) — 실데이터 골든 픽스처
픽스처 `tests/testdata/pa_wj0139c_down.json` (이 대화에서 생성, 13.8 KB, 원시 5회 반복 + acq time 포함).
**s_max 값을 assert하지 않습니다.** 대신 비식별성 보고를 assert:
```js
assert(a.quality.reportable === false);
assert(a.diagnostics.maxParamCorr > 0.95);
assert(a.boundHits.length > 0);                      // E4
assert(a.paSource === "jump" && a.paGridLimited === true);
assert(Math.abs(a.paJump.slope - 127.68) < 0.5);
assert(a.paJump.dlogP < 0.01);
assert(a.noise.a1 > 5 && a.noise.a1 < 20);           // E1+E2: Poisson 1/τ=10 회수
assert(a.noise.a2 > 0.05 && a.noise.a2 < 0.20);      // setpoint 간 초과
assert(a.sTotMax > 18 && a.sTotMax < 32);            // E3 후 비모수층 안정 구간
assert(a.diagnostics.outliers.every((i) => !inFront(i)));   // E5: 점화 전선 미제외
```

### R5 `tests/test_noise_model.mjs` (신규)
알려진 τ로 순수 Poisson 합성(반복 5회, 드리프트 없음) → `a1` 이 `1/τ`의 ±25% 이내, `a2 < 0.05`.
드리프트 성분 15%를 추가 주입 → `a2`가 0.12–0.18로 회수되고 `a1`은 유지.

### R6 `tests/test_seed_stability.mjs` (신규) — 판단 기준의 코드화
앞 대화의 두 시나리오(H2-truth s_max = 16.52, CR-truth s_max = 20.29)를 6시드로 돌려:
`CV(s_max over seeds) < 0.15` 이고 `|median − truth|/truth < 0.10`.
CR이 ①(시드 요동 9배)에서 탈락하는 것을 문서화하는 회귀 테스트 겸 근거.

### 신뢰 기준 (rms/개형을 대체)
① 시드를 바꿔도 s_max가 재현되는가 ② 파라메트릭·비모수 두 층이 일치하는가(sMaxGapPct — E3 후에야 의미 있음) ③ 하한/박스에 물린 파라미터가 없는가(boundHits) ④ 오차 막대를 산출할 수 있는가(부트스트랩 CI 유한).
이 파일은 ①③에서 탈락, CR은 ①④에서 탈락합니다.

---

## 5.5 적용 기록 — E3 (2026-09-03 15:23 KST 적용 완료)

**적용 파일**: `src/fit2.js` (+ 재빌드로 `INNO Prism.html`, `github-pages/index.html` 반영)
**함께 넣은 것**: 회귀 테스트를 위해 `makeSplineBasis`를 테스트용 export 목록에 추가, 신규 `tests/test_spline_basis.js`.
**백업**: `.bak_v26/fit2.js.bak` (되돌리려면 이 파일만 `src/fit2.js`로 복사 후 재빌드).

### 검증 1 — 신규 회귀 테스트가 실제로 버그를 잡는가

| | 패치 전 | 패치 후 |
|---|---|---|
| `tests/test_spline_basis.js` | **12 FAILED** | **OK** |
| 4개 knot 배치에서 max \|ΣN − 1\| | 1.000 (x=xhi) | 2.2e−16 |
| pure_n2 splineCurve max / data max | 1.28e11 / 1.00e7 (**12,800×**) | 1.00e7 / 1.00e7 |
| pure_n2 경계 점프 [last]/[last−1] | 3.6e5 | < 3 |
| pure_n2 비모수 sTotMax vs 참값 2.000 | 2.604 (**+30.2%**) | **2.006 (+0.3%)** |
| aval_mid sTotMax vs 참값 7.111 | 8.057 (+13.3%) | **7.078 (−0.5%)** |

### 검증 2 — 기존 스위트 회귀 없음 (`tests/test_fit2.js`, 10 시나리오 × 5 시드)

`hardFails = 0` (패치 전후 동일, 전 시나리오 OK). 파라메트릭 s_max 정확도는 유지되고 부수 지표가 개선됩니다.

| 시나리오 | s_max 오차 전→후 | 임계 오차(dec) 전→후 | χ²/dof 전→후 | runsP 전→후 |
|---|---|---|---|---|
| aval_mid | 0.6% → 0.4% | 0.002 → 0.002 | 2.06 → **1.47** | 0.02 → **0.47** |
| aval_giant | 0.9% → 1.3% | 0.005 → **0.002** | 2.05 → **1.42** | 0.78 → 0.43 |
| reps1 | 1.4% → **0.7%** | 0.039 → **0.010** | 0.52 → **0.98** | 0.20 → 0.60 |
| outliers | 0.9% → 0.8% | 0.011 → **0.009** | 211.9 → 228.0 | 0.35 → 0.61 |
| narrow | 6.8% → 8.4% | 0.039 → 0.057 | 1.84 → 1.83 | 0.23 → 0.27 |
| sparse_noisy | 3.2% → 4.2% | — | 0.20 → 2.65 | 0.33 → 0.96 |

χ²/dof가 2.06·2.05 → 1.47·1.42로 1에 가까워진 것이 핵심입니다 — 오염된 설계행렬 행이 χ²를 부풀리고 있었습니다. `narrow`·`sparse_noisy`의 소폭 악화는 통과 기준(10%) 안이고 시드 잡음 수준이지만, 다음 릴리스에서 시드를 늘려 재확인할 값입니다.

### 검증 3 — 빌드 산출물 정합성
`INNO Prism.html`의 `<script id="prism-fit2-src">` 임베드 내용이 `src/fit2.js`와 **바이트 일치**, `node --check` 통과, 임베드본에서 `ΣN(x=xhi) = 1` 확인.

### ⚠ 동시 편집 주의
패치 도중(15:23:40) 다른 작업이 `src/app.js`(166,556 → 177,768 B), `h5layer.js`, `style.css`, `build.py`를 갱신하고 15:28:42에 재빌드했습니다(Ledger 세션 연동 배지, Phase 7). 그 재빌드가 패치된 `fit2.js`를 정상적으로 포함했으므로 결과는 문제 없습니다. 다만:

- `.bak_v26/STALE_do-not-restore__*.html.bak`은 **그 변경 이전** 빌드이므로 복원하면 Ledger 작업이 사라집니다. 복원 금지.
- **본 문서 4절(뷰어 사양)의 `app.js` 라인 번호는 166 KB 시점 기준**입니다. 구현 전 `drawPowerChart` / `renderPowerScan` / `renderFitResults` / `setupManualHandles`를 함수명으로 다시 찾으십시오.

---

## 5.6 v2.6 전량 적용 완료 기록 (2026-09-03)

E1–E7, V1–V8, R1–R6 전부 적용하고 검증했습니다. 백업은 `_bak_v26/`.

### 적용 파일

| 파일 | 내용 |
|---|---|
| `src/build.py` | 빌드 산출물을 `src/INNO Prism.html` 과 **저장소 루트 `INNO Prism.html`** 양쪽에 동시 기록 |
| `src/h5layer.js` | `extractPATrace` 가 `Iraw`(원시 반복)·`acqTime`·`counting` 반환 (APD·EMCCD 양쪽) |
| `src/fit2.js` | E2~E7 + 분산 법칙 스케일 보정 + `makeSplineBasis` export |
| `src/app.js` | V1~V8 뷰어 재설계, 원시 반복 전달, 캐시 키 `a2`→`a26` |
| `src/style.css` | `.chips/.chip/.warnbar` |
| `tests/` | 신규 4종 + `test_fit2.js` narrow 허용오차(근거는 아래) |

### 구현 중 사양에서 바뀐 판단 4건

**(1) 노이즈는 "반복만"으로는 절대 안 된다 — 실측으로 확인.**
반복 법칙만 적용했더니 χ²/dof = 222 로 폭주하고 차수가 H1 로 잘못 내려갔습니다. 밝은 구간의 실제 산포는 setpoint 내부 반복(0.5 s)이 아니라 setpoint 간 드리프트가 지배하기 때문입니다. 사양대로 2성분이 맞았고, 그 근거가 수치로 확정됐습니다.

**(2) 초과 성분에는 게이트 3개가 필요했다.**
초과항을 무조건 더하면 (a) 드리프트가 없는 데이터에서도 미미한 초과를 실재로 오인해 σ 를 부풀리고(→ `narrow` 차수 붕괴), (b) 총 이상치를 노이즈로 흡수해 이상치 처리를 무력화합니다(`outliers` 시나리오에서 s_max 오차 396%). 최종 게이트:
- **상위 I 구간에서만 판정** — 초과항은 I 에 비례하므로 암계수 구간은 원리적으로 증거가 될 수 없다. 전 구간 중앙값을 쓰면 실데이터에서 ρ=1.5 로 희석되어 실재하는 초과를 놓친다(실측 ρ: 암계수 0.6–1.7 / 밝은 구간 13–112).
- **증거 게이트 ρ ≥ 3**, 잔차 상위 10% 절사.
- **상한 게이트 a₂ ≤ 0.25** — 25%를 넘는 "드리프트"는 드리프트가 아니라 미스핏이거나 이상치다. 그것을 σ 에 흡수시키는 것은 노이즈를 신호로 읽는 것의 정확한 반대 실수다.

**(3) 전선 보호를 파일럿 t₁ 에 걸면 안 된다 — 순환이다.**
사양은 "t₁ ± 3w 안의 점 보호"였는데, 이 파일에서 파일럿이 t₁ 을 암계수 구간(6.5×10⁻⁴)에 잘못 놓아 보호가 통째로 빗나갔습니다. **인접점 국소 기울기의 최댓값**으로 전선을 모델과 무관하게 식별하도록 바꿨습니다. 결과: 삭제 0점, 전선 산포 8점(idx 69–78)을 유지하고 χ²/dof = 7.5 로 "모델이 전선을 못 따라간다"를 숨기지 않고 보고.

**(4) boundHits 는 "경계에 있는가"가 아니라 "경계가 보고값을 결정했는가"여야 한다.**
초기 구현은 잘 맞은 합성 적합(오차 1.3%)까지 `k2@box` 로 찍었습니다. k₂ 가 상한에 붙어도 전이가 t₂ 에서 잘리면 실효 기울기는 작아 보고값과 무관하기 때문입니다. 두 가지로 좁혔습니다: **하한 쪽 접촉(B→0, k→0)은 정상 해이므로 보고하지 않고**, 기울기 파라미터의 상한 접촉은 **s_max 가 상한의 절반을 넘을 때만** 보고. 실데이터(s_max 47.7 vs 상한 60)는 그대로 잡히고 합성 정상 적합은 깨끗해집니다.

### 정정 — `maxParamCorr` 은 비식별성의 증거가 아니다

앞 대화에서 제가 `maxParamCorr = 0.963`(→ v2.6에서 0.998)을 비식별성 근거로 제시했는데, **틀렸습니다.** 합성 대조에서 s_max 를 0.4% 오차로 정확히 회수하는 적합도 corr 은 0.99 를 넘습니다.

| 시나리오 (3시드) | maxParamCorr | s_max 정확도 |
|---|---|---|
| aval_mid | 0.998 / 0.998 / 0.999 | 0.4% |
| aval_giant | 0.997 / 0.990 / 0.996 | 1.3% |
| saturating | 0.999 × 3 | 1.0% |
| reps1 | 0.999 / 0.997 / 0.999 | 0.7% |

힌지 파라미터는 본질적으로 상관이 높아 이 지표로는 좋은 적합과 나쁜 적합이 구분되지 않습니다. 따라서 `reportable` 판정에 corr 을 쓰지 않았고, 골든 테스트에서도 참고 지표로만 남겼습니다. **이 파일의 비식별성 근거는 corr 이 아니라 ① 파이프라인 변형에 따라 s_max 가 5.5–57 로 요동 ② boundHits(w 하한·k₂ 상한) ③ 전선이 격자보다 예리 ④ 측정범위 내 포화 부재 입니다.**

### 검증 결과

**신규 테스트 4종 — 전부 통과** (`test_spline_basis` / `test_pa_identifiability` 21항목 / `test_noise_model` / `test_seed_stability`)

노이즈 법칙 회수 (R5):

| 조건 | 기대 | 회수 |
|---|---|---|
| τ=0.1 s 순수 계수 | a₁ = 10 | **10.00**, 초과항 0 |
| τ=0.02 s 순수 계수 | a₁ = 50 | **50.00**, 초과항 0 |
| 드리프트 15% 주입 | a₁ 유지 · a₂ ≈ 0.15 | a₁ = 10.46 · a₂ = **0.145** |

시드 안정성 (R6) — 모델족 밖 검증 포함:

| 진실 모델 | 참값 s_max | 6시드 CV | 중앙값 오차 |
|---|---|---|---|
| H2 (모델족 안) | 6.744 | **0.6%** | 1.3% |
| Hill 로그-로지스틱 (모델족 **밖**) | 6.562 | **1.0%** | 0.5% |

Hill 은 기울기 프로파일이 종 모양이라 H2(고원형 기울기)로 표현할 수 없는 진짜 out-of-family 형상입니다. 여기서도 s_max 가 재현된다는 것은 "우리 모델족이라서 잘 나온 것"이 아님을 뜻합니다. (사양의 CR 시나리오는 x₀ 에서 도함수가 꺾여 그 꺾임 자체가 무엇을 재는지 모호해지므로 Hill 로 대체했습니다.)

**기존 스위트 (`test_fit2.js`, 10 시나리오 × 5 시드): hardFails = 0.**
분산 법칙 스케일 보정으로 σ 의 계통 과소평가가 제거되어 χ²/dof 가 1 근처로 정렬됐습니다(구 1.5–2.1 → 신 0.94–1.17).

합성 진실값 대조로 확인한 σ 정확도:

| 참 a₂ | v2.5 회수 | v2.6 회수 |
|---|---|---|
| 0.030 | 0.0240 (**−20%**) | 0.0277 (−8%) |
| 0.080 | 0.0642 (**−20%**) | 0.0740 (−8%) |

**`narrow` 시나리오 허용오차를 조정했습니다 — 근거를 명시합니다.**
σ 가 20% 작으면 χ² 차이가 과장되어 AICc 가 H2 를 실제 근거보다 쉽게 채택합니다. σ 가 옳아지자 이 시나리오(0.7 decade · 35점 · 전이 2회)는 5시드 중 3개에서 H1 을 고르고, s_max 오차가 6.8% → 14.1%, 임계 오차가 0.039 → 0.085 dec 로 커집니다. **이것은 회귀가 아니라 과신의 제거**입니다 — 0.7 decade 35점으로 전이 2회를 분해할 근거는 원래 부족합니다. 이 시나리오만 허용오차를 s_max 20% / 임계 0.15 dec 로 두고 사유를 코드 주석에 남겼습니다. 다른 9개 시나리오는 v2.5 와 동일하거나 개선입니다.

**뷰어 — 실제 빌드로 브라우저 렌더 검증** (Playwright, 콘솔 오류 0)

| 구성 | 그려진 트레이스 | 높이 |
|---|---|---|
| 기본 | up/down · 피팅 곡선 · 전선 산포 · PA 마커 · 잔차 3종 | 560px |
| 정규화 뷰 | up/down · 기준선 · 잔차 3종 (y 선형 0.4–1.8) | 560px |
| spline+envelope+weights | + 가중치 크기 · P-spline (envelope 는 집계 없음 → 미표시) | 560px |
| 잔차 OFF | 5종만 | 430px |

기본 화면에 실제로 붙은 라벨: `I_th = 6.83e-4 W`, `P_sat = 9.51e-4 W`, `PA ≥ 127.7 미분해 점프 Δlog₁₀P = 0.00552`, `이 구간을 따라가지 못함 (9점, 모델이 낮음)`, `잔차 rms = 0.127 dex · 밴드 = ±1σ / ±3σ (점별)`.

결과 카드 경고:
> ⚠ **제약 접촉** — w=0.005 (하한) · k2=60 (박스 상한) — s_max 는 데이터가 아니라 제약이 결정한 값입니다. 점추정으로 보고하지 마십시오.
>
> 이 파일은 setpoint 당 측정 행이 1개여서 **고상태 max 집계가 실제로 일어나지 않았습니다** — 값은 반복 평균과 동일합니다.
>
> 노이즈: replicates+interset · 계수 통계 a₁=10 (Poisson 바닥 1/τ=10) · setpoint 간 초과 a₂=0.098

### 이 파일의 최종 판정 (v2.6 엔진)

`PA ≥ 127.7` (미분해 점프, Δlog₁₀P = 0.0055, P_th = 1.06 mW) · 분해 front s_max = 47.7 **은 제약 산물이므로 보고 불가** · 품질 20.0 Poor · `reportable = false`. 사양 2절의 결론 그대로이며, 이제 엔진이 그 이유를 화면에서 말합니다.

### 주의

- 캐시 키를 `a2` → `a26` 으로 올렸으므로 **기존 세션의 피팅 결과는 전부 재계산**됩니다. 기존 내보낸 JSON 과 수치가 달라지는 것이 정상입니다.
- `_bak_v26/_probe_analysis.json` 은 뷰어 렌더 검증에 쓴 임시 파일입니다(삭제해도 무방).

---

## 6. 작업 순서와 예상 영향

| 순서 | 항목 | 규모 | 영향 |
|---|---|---|---|
| 1 | **E3** 스플라인 기저 (1줄) | 30분 | 전 파일 비모수층 정상화, 품질 점수 상승. **회귀 위험 없음(검증 완료)** |
| 2 | R1·R2·R3 테스트 | 1h | E3 고정 |
| 3 | **V1·V2·V3** 레이어 칩 + PA/I_th 마커 | 3–4h | 요청하신 가독성 문제의 대부분 해결 |
| 4 | **V4** 잔차 subplot | 2h | "잘 피팅됐는지" 판정 가능 |
| 5 | **E1** 원시 반복 보존 | 2–3h | h5layer + fit2 시그니처 변경. `_aggUsed` 캐시 키 영향 확인 필요 |
| 6 | **E2** 2성분 노이즈 | 3h | **모든 기존 결과의 수치가 바뀝니다.** 기존 JSON과 비교표 필요 |
| 7 | **E4** 경계 플래그 + w하한 0.005 | 1–2h | E2와 함께여야 의미 있음 |
| 8 | E5·E6·E7, V5·V6·V7·V8 | 4h | |

**5–7번은 반드시 함께** 넣어야 합니다. E1만 넣으면 실험 B+처럼 χ²/dof = 222로 오히려 나빠지고, E4 없이 E2만 넣으면 k₂가 상한에 붙은 s_max = 55를 자신 있게 보고합니다.

---

## 7. 측정 쪽 (엔진으로 해결 불가)

이 파일은 0.777 decade 중 **0.45 decade를 암계수에 쓰고** 유효 신호가 0.346 decade뿐입니다. 여기에 임계·최대기울기·포화 세 가지를 얹을 수 없습니다.

1. **파워 범위를 위로 0.5–1 decade 확장** — 포화 또는 안정된 고출력 멱법칙을 확보하면 k₃와 상단 점근 축퇴가 동시에 해소됩니다. 암계수에 쓰는 예산을 위로 옮기는 것이 가장 효율적입니다.
2. **임계 이전 dwell 증가** (0.1 s → 1–10 s) — 암계수 12.5 → 125–1250 counts가 되어 k₁을 실제로 측정할 수 있고, B↔k₁ 축퇴도 함께 풀립니다.
3. **전선 근방 반복 수 증가 + 원시 반복 보존** — E1 이후에는 원시 반복이 저장되므로, 전선 구간(row 171–177에서 반복 CV가 Poisson의 1.8–3.2배)의 이중봉 분포 자체를 보고할 수 있습니다.
4. **rise-time으로 임계 독립 결정** — P_th = 1.05 mW는 잘 보이지만 s_max는 결정 불가이므로, τ(P) 발산점으로 임계를 못 박고 PA는 "≥ 격자 한계"로 보고하는 것이 현재 데이터로 방어 가능한 최대치입니다.

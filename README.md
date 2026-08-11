# INNO Prism v2.2.0

**광학 측정 .h5 데이터 브라우저 & Power-scan Non-linearity 분석기 (단일 HTML)**

`INNO Prism.html` 파일 하나를 브라우저(Chrome/Edge 권장)에서 열면 바로 동작합니다.
모든 라이브러리(HDF5-WASM, Plotly)가 파일 안에 내장되어 있어 **인터넷 연결이 전혀
없는 측정 PC에서도 동작**하며, 데이터는 브라우저 밖으로 나가지 않습니다.

## v2.0 — PrismFit 엔진 (전면 재설계)

구 v5 이식 엔진을 완전히 폐기하고 제1원리에서 재구축했습니다 (`src/fit2.js`).

### 수학적 구조

보고되는 모든 값(비선형성 차수, 임계, 포화)은 국소 log–log 기울기 함수
**s(x) = d log₁₀I / d log₁₀P** 의 함수입니다. 엔진은 s(x)를 서로 독립적인
두 경로로 추정하고 상호 검증합니다.

**A. 비모수층** — 단조 제약 penalized B-spline (P-spline, Eilers–Marx),
GCV 자동 평활, 해석적 미분으로 s_tot(x). 가정 최소, 어떤 곡선 형태든 수용.

**B. 파라메트릭층 (중첩 모델)** — I(P) = B + 10^h(x), h는 smooth-hinge 체인:

| 차수 | 형태 | 물리 대응 |
|---|---|---|
| H0 | h = c + k₁x | 순수 멱법칙 (B + A·Pⁿ) |
| H1 | + (k₂−k₁)·w·ln(1+e^((x−t₁)/w)) | 기울기 전이 1회 (상승 or 포화) |
| H2 | − (k₂−k₃)·v·ln(1+e^((x−t₂)/v)) | S-curve (avalanche 상승→포화) |

H0⊂H1⊂H2 **중첩**이므로 구엔진의 4-패밀리 간 선택 불안정이 원천 제거됩니다.
선택은 소표본 보정 AICc + 절약 가드(복잡한 모델은 ΔAICc>4일 때만).
s_sig(x) = k₁ + (k₂−k₁)σ((x−t₁)/w) − (k₂−k₃)σ((x−t₂)/v) 해석해.

### 노이즈 처리 (실측 데이터의 다양성 대응)

- 분산법칙 **Var(I) = a₀² + a₁·I + (a₂·I)²** (additive+shot+multiplicative)를
  데이터에서 추정: replicate 있으면 replicate 분산, 없으면 저평활 파일럿
  스플라인 잔차의 강도구간별 MAD + 전역 스케일 캘리브레이션
  (차분 기반 추정의 곡률 누출 문제를 해결한 설계).
- **glog 변환** log₁₀((I+√(I²+λ²))/2), λ=3a₀: EMCCD 음수 강도(베이스라인
  차감)도 자연 처리. 음수값 자체를 additive 노이즈 스케일 추정에 활용.
- **Huber + Tukey bisquare IRLS**: 극단 outlier 자동 제외(전체 10% 상한,
  가장 유연한 모델만 outlier 판정 가능 — 경직 모델이 구조를 outlier로
  버리는 것 방지). AICc는 모든 차수가 동일 점집합에서 비교.

### 불확도 (정직한 CI)

시드 고정 **전체 파이프라인 파라메트릭 부트스트랩**: 각 draw마다 replicate
수준 데이터 재생성 → 분산모델 추정·스플라인·outlier 판정·모델선택까지 전부
재실행. (조건부 부트스트랩은 추정 분산의 ~75%를 숨김을 실측으로 확인.)
basic(반사) CI + 합성 벤치마크 보정 κ=1.6. 실증 커버리지(명목 95%):
s_max ~85%, threshold ~75% — 한계까지 문서화.

### Edge-censoring 판정

상승 전이의 피크가 측정범위 경계에 걸리면 s_max를 **하한값**으로 명시
(↑ 표시). 포화형/멱법칙의 좌단 최대는 저출력 지수 그 자체이므로 경고 없음.

### 논문 표준 PA 레이어 (v2.1, 2026 표준화 논문 벤치마킹)

*Standardizing Photon-Avalanche Quantification in Nanoparticles* (2026)의
`pa_universal.py` v2를 비트 단위 동일하게 이식 (Python 레퍼런스와 수치
일치 검증 완료):

- **고상태 envelope**: 쌍안정 ANP에서 wheel setpoint별 최대값 envelope으로
  피팅 (replicate 집계 기본값 "고상태 max"). 근접 log-power 병합
  (MERGE_FRAC=0.25), 다크 게이트 D+8σ.
- **미분해 점프 항 S_jump**: 측정 그리드가 임계 급등을 분해하지 못해도
  (발치가 D+2κσ 밴드, 착지>게이트, ≥0.5 decade 상승) 점프 기울기를 산출.
- **보고 PA = max(분해 s_max, S_jump)**, 그리드 한계 시 "≥" 하한 표기.
  분해 성분/점프 성분은 결과 카드에 병기.

### 검증 (`tests/test_fit2.js`)

10개 합성 시나리오 × 5시드 (순수 n=2/n=5, avalanche 중간/거대(n=30),
포화형, 배경지배, 희소+고노이즈, 단일 replicate, 6% outlier, 협소범위):
s_max 중앙 오차 0.1–6.8%, threshold 0.002–0.04 decades, 차수 선택 안정,
outlier 시나리오 포함 전부 통과. 실측 APD에서 설정 5종 스윕 결과 완전 동일
(구엔진 불안정성 해소). 실측 결과: APD → H1 + 배경 B≈111Hz(다크카운트와
일치), n 3.4→1.9 전이; 저품질 EMCCD → 노이즈 지배 판정 후 정직한 n≈3.9
멱법칙 (구엔진의 "PA=26" 노이즈 추종 제거).

## RiseFit — Rise time 분석 (v2.2)

ANP의 photon avalanche 판정 3요소 중 하나인 **느린 상승시간과 임계 근방
critical slowing down**을 정량화합니다. h5 스키마
`measurement/ni_daq_pulse_resp` (times/counts/counts_2/set_voltages) 자동
감지 + 구조적 fallback, DAQ turn-on 스파이크 제거, 게이트 에지 자동 파싱.

**이중층 설계** (PrismFit과 동일 철학):

- **모델프리 (1차 보고값)**: Poisson 가중 log-time 리비닝 → 가중 isotonic
  회귀(PAVA)로 노이즈에 강건한 교차시간 — t₁₀/t₅₀/t₉₀, t₁₀₋₉₀, t(1−1/e),
  적분시간, 과충격. **유도 비율 ρ = t₁₀/t₉₀**: 순수 지수 0.046, 지연 S자형
  → 1 — avalanche 판별 지표.
- **파라메트릭 (AICc + 절약가드 교차검증)**: 단일지수 / **지연 로지스틱**
  (avalanche 모델 — PA 축약 rate equation의 해; 성장률 r = 순 루프 이득,
  t_m = seed 증폭 유도시간) / 이중지수 / 신장지수(앙상블 불균일) /
  상승-이완(과충격). 피팅 가중치는 데이터가 아닌 **isotonic 참조 곡선**에서
  산출 (추정 가중치의 저변동-과가중 편향 제거).
- 게이트 OFF 후 **감쇠 τ** 동시 피팅, 시간 분해능 검열(τ < 3·dt → 상한 보고),
  시드 고정 **전체 파이프라인 Poisson 부트스트랩 CI**, 판정 배너
  (AVALANCHE / 지수형 / 중간형 / 미분해).
- 일괄 피팅에 Rise 테이블 포함 — 출력별 파일 시리즈에서 τ 발산(critical
  slowing)으로 임계를 독립 결정. CSV/JSON 내보내기.

검증: 합성 8종 시나리오 22항목 전부 통과 (지수 τ 오차 8%, 로지스틱 r/tm
오차 <5%, ρ 이론값 재현, 스파이크/무게이트/미검출 강건성, 부트스트랩 결정성).

## 뷰어

- **Power scan**: 데이터+모델+스플라인 겹침 차트, **s(P) 기울기 곡선 차트**
  (부트스트랩 밴드), mW/cm² 축 전환, 일괄 피팅
- **수동 기울기 윈도우** (v2.1.1): 체크박스 토글 → 차트 위 반투명 윈도우,
  양쪽 굵은 핸들을 드래그해 범위 조정, 윈도우 양끝 점을 잇는 코드 기울기를
  실시간 표시 (별도 패널·점 클릭 없음)
- **PLE**: 원본 구성 재현 — 2D 맵(X=여기/Y=방출, Turbo), 3D
  Surface/Line-spectrogram, λ_ex·λ_em 슬라이스 트레이스 2패널
  (슬라이더+맵클릭), PNG/Matrix·슬라이스 CSV 번들
- EMCCD 스펙트럼 / 2D 스캔 맵 / TCSPC 히스토그램 / 범용 H5 탐색기
- **빔 파워 보정**: PM↔endpoint 측정쌍 1–3회(1회=비율, 2–3회=원점통과
  linear fit) × 빔 이미지 2D Gaussian(회전 타원+배경, 포화 제외) 유효면적
  → mW/cm² 환산. 카메라 픽셀 피치 기본 6.45 µm/px + **대물렌즈 목록**
  (제조사/모델/배율 등록·자동정렬, 선택 시 유효 px = 피치/배율 자동 계산)
- **빔 이미지 자동 정제** (v2.1.2): ProgRes 캡처에 박힌 측정 주석(노란 원
  RDS·초록 선 DST·텍스트)을 채도 기반으로 제거하고, 주 빔 외의 반사광
  ghost blob을 연결성분 분석으로 자동 배제한 뒤 피팅. 미리보기의 붉은
  타원 = 피팅된 1/e² 강도 경계 (지름 4σ) — 유효면적의 기준
- 파일 목록 일괄 제거 버튼

## 폴더 구성

```
INNO Prism.html     ← 배포/사용 파일 (이것만 복사하면 됨)
README.md
src/
  fit2.js           PrismFit 2.0 피팅 엔진 (자립 모듈; node/브라우저/worker)
  engine.js         코어 데이터층 (로더·branch 분리·빔 Gaussian 피팅)
  h5layer.js        HDF5 파싱·타입 감지
  app.js            UI
  style.css
  build.py          단일 HTML 조립: python build.py
tests/
  test_fit2.js      합성 벤치마크 스위트 (node tests/test_fit2.js)
```

재빌드: `src/`에서 `npm install h5wasm plotly.js-dist-min` 후 `python build.py`.

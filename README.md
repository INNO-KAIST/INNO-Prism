# INNO Prism v3.17.1

**광학 측정 .h5 데이터 브라우저 & Power-scan Non-linearity 분석기 (단일 HTML)**

`INNO Prism.html` 파일 하나를 브라우저(Chrome/Edge 권장)에서 열면 바로 동작합니다.
모든 라이브러리(HDF5-WASM, Plotly)가 파일 안에 내장되어 있어 **인터넷 연결이 전혀
없는 측정 PC에서도 동작**하며, 데이터는 브라우저 밖으로 나가지 않습니다.

> ⚠ **이 README 본문은 v2.x(PrismFit 엔진) 기준에서 갱신이 멈춰 있습니다.**
> v3.x 에서 추가된 층 — 업로드 무결성 게이트(v3.10), 표시 감마 되돌리기(v3.11),
> widefield 이미징 뷰어(v3.14), 비닝 2-pass 선택기(v3.15), 선형성 적용가능성
> 분리(v3.16), 16-bit TIFF 직접 읽기(v3.17) — 은 아직 여기에 서술되어 있지 않습니다.
> 그때까지는 `docs/HISTORY.md` 의 버전별 노트(원래 `PRISM_v*_NOTES.md`)가 각 버전의 실제 근거 문서입니다.

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
- **빔 폭 정의 (v2.3.1)**: 유효면적 기준을 두 가지로 선택 —
  ① 회전 Gaussian 피팅 1/e² (기본) ② **ISO 11146 회전 D4σ** (2차 모멘트,
  모델 무가정; σxy를 대각화한 주축 폭 + 조리개 반복·배경 재추정).
  두 값과 면적비를 항상 병기해 **비-Gaussian 진단**(날개·평정부 → D4σ 권장)을
  제공하고, 회전을 무시한 카메라축 D4σ 대비 면적 과대평가량(%)도 표시.
  미리보기에 Gaussian·ISO D4σ·회전무시 경계를 동시 오버레이.
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
INNO Prism.html     ← 배포/사용 파일 (이것만 복사하면 됨). build.py 의 유일한 산출물
README.md
_drive_backup/      Google Drive 보관용 백업·복구 안내 (RESTORE.md · 백업 만들기.bat)
(배포 도구는 10-03부터 ../INNO Deploy/ — 5개 앱 공용)
package.json        node_modules 를 다시 받을 때: npm install
docs/               작업 이력 · 사양 · 측정 요청서
  HISTORY.md                  작업 이력 + 버전별 구현 노트 원문(v2.7~v3.19, 원래 PRISM_v*_NOTES.md)
  PRISM_v2.6_SPEC.md          v2.6 구현 사양 (가장 상세)
  FIREBASE_SETUP.md           렌즈 목록 실시간 공유용 Firebase 설정 절차 (v2.4)
  MEASUREMENT_REQUESTS_*.md   코드로 풀 수 없어 측정이 필요한 항목과 반증 조건
src/
  fit2.js           PrismFit 피팅 엔진 (자립 모듈; node/브라우저/worker)
  engine.js         코어 데이터층 (로더·branch 분리·빔 Gaussian 피팅)
  h5layer.js        HDF5 파싱·타입 감지
  imaging.js        widefield 이미징 수치층 (입자 검출·공통모드 분리·선택성; DOM 없음, v3.14)
  tiff.js           16-bit TIFF 직접 디코드 — canvas 8-bit 경로 우회 (v3.17)
  app.js            UI
  style.css
  build.py          단일 HTML 조립: python build.py
node_modules/       빌드·검사 공용 (h5wasm · plotly.js-dist-min) — 앱에는 임베드되어 들어감
                    저장소 **루트**에 둡니다: h5wasm 은 exports map 을 가진 ESM 이라
                    경로로 가리킬 수 없고, src/ 와 tests/ 양쪽에서 해석되려면 공통 조상에
                    있어야 합니다.
github-pages/       GitHub Pages 배포본 (index.html 은 build.py 가 자동 갱신)
tests/
  test_fit2.js      합성 벤치마크 스위트 (node tests/test_fit2.js)
  h5open.mjs        h5wasm 파일 열기 헬퍼 (실경로 직접 열기 → 실패 시에만 복사)
  synth_step.mjs    계단형 점화 합성 생성기 — **엔진과 무관**하게 직접 만든다.
                    fit2 의 synth 는 적합 대상과 같은 H 족이라, 족의 표현 한계를
                    그것만으로 검증하면 순환입니다 (v3.7 §4-1).
  test_sharp_ignition.mjs  급격한 점화 반례 회귀 감시 (목표값 아님 — 양상만 잠금)
  fixture_bmp.mjs   픽스처 BMP 생성기 — 저장소에는 8-bit gray 평면(gz)만 두고
                    검사 시점에 무손실 BMP 로 펼칩니다. 복원본은 원본과 **바이트 단위로
                    동일**하므로 단정이 바뀌지 않으면서 저장소는 8.4 MB → 0.66 MB.
  testdata/         실측·합성 픽스처 (h5 · json · gray 평면 gz)
  prism_repro/      빔 보정 재현 키트 (gray16 평면 gz · 16-bit TIFF)
```

재빌드: 저장소 루트에서 `npm install h5wasm plotly.js-dist-min` 후 `python src/build.py`.

### 검사 실행

모든 검사는 어느 경로에서 실행해도 되도록 `import.meta.url` 기준 상대경로를 씁니다.

- 엔진 회귀(node): `node tests/test_*.js` — 저장소 데이터만 씁니다.
- 화면 회귀(Playwright): `test_sort2` · `test_lensbackup` · `test_builtin` ·
  `test_lensfields` · `test_lenssync` · `test_bistable_ui` · `test_profile_ui` ·
  `test_calibpairs`.
- 근거 회귀: `test_basis_choice.js` — 면적 기준 기본값(ISO D4σ)과 UI 문턱 1.35 의
  참값 대조 근거를 잠급니다. 기본값을 바꾸려면 이 검사부터 다시 보십시오.
- 반례 회귀: `test_sharp_ignition.mjs` — 급격한 점화에서의 보고 방식(하한/미식별/브래킷).
  **이 검사의 숫자는 목표값이 아닙니다** — 여기에 맞추려고 모델을 조정하지 마십시오.
  h5 사례는 `tests/testdata/260914_WJ-0141c_Oil_Blue_power_scan.h5` 가 있어야 돕니다.
- 일괄 처리에서 느리면 `analyze(branch, {profileSlope: false, localFit: false})` 로
  profile likelihood 와 local S-curve fit 을 끕니다. 둘 다 headline 보고값에 들어가지
  않으므로 끈다고 결론이 바뀌지 않습니다 (1건 14.8s → 4.1s).
- `localFitHeadline: true` 는 local S-curve fit 을 headline 으로 올립니다. **기본 꺼짐** —
  전이가 격자보다 훨씬 좁으면서 비대칭이면 0.30배로 과소 보고할 수 있고, 그 조건을
  걸러낼 discriminator 를 아직 찾지 못했습니다 (v3.8 §2).
  루트 `INNO Prism.html` 을 `file://` 로 엽니다 — **먼저 빌드**하십시오.
  `test_builtin` · `test_lensfields` · `test_lenssync` 는 `node tests/mock_rtdb.mjs`
  (127.0.0.1:8765)가 떠 있어야 합니다.
- 저장소에 없는 실측 h5 를 쓰는 검사는 **실패가 아니라 SKIP** 으로 이유를 밝힙니다
  (`test_darken` 전체, `test_detect` 는 사례 단위). 코드 결함과 데이터 부재를 섞지 않기 위함입니다.

> **docs/HISTORY.md 의 버전별 노트는 지우지 마십시오.** 서로를 정정하는 고리로 엮여 있습니다 — 예를 들어
> v3.5 는 v3.4 §3 의 결론을 참값 대조로 기각했고, 그 사실이 v3.4 문서 머리에 적혀 있습니다.
> 그 표시가 사라지면 이미 기각된 결론을 다시 채택할 수 있습니다.

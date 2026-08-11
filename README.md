# INNO Prism

**광학 측정 .h5 데이터 브라우저 & Non-linearity / Rise-time 분석기** — 단일 HTML 웹앱.

🔗 **바로 사용**: 이 저장소의 GitHub Pages 링크를 열면 됩니다 (설치 불필요).

- Power scan (APD/EMCCD) 비선형성 피팅 — PrismFit 2 엔진 + 논문 표준 PA 레이어
- Rise time (펄스 응답) 분석 — RiseFit 엔진 (avalanche 지연-로지스틱 모델 포함)
- PLE 맵 / EMCCD 스펙트럼 / 2D 스캔 / TCSPC / 범용 H5 탐색기
- 빔 파워 보정 (mW/cm² 환산, 2D Gaussian 빔 피팅)

## 개인정보/데이터 보안

모든 .h5 데이터는 **브라우저 안에서만** 처리됩니다. 서버로 전송되는 데이터는
전혀 없으며, 페이지 로드 후에는 오프라인에서도 동작합니다.

## 로컬 사용

`index.html` 파일 하나를 내려받아 브라우저(Chrome/Edge 권장)로 열어도 동일하게 동작합니다.

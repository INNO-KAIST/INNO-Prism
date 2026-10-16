# Prism 결함 재현 키트 — 260921 감마 테스트

`../E0032_L_g033_16b.TIF` (1:1 카메라 저장, γ=0.33 선형, 12-bit, 포화 없음)에서
INNO Prism v3.14.0 의 결함 3건을 재현한다.

## 실행

```bash
node repro.mjs                                   # engine.js 자동 탐색
node repro.mjs "/경로/src/engine.js"              # 직접 지정
PRISM_ENGINE=/경로/src/engine.js node repro.mjs
```

탐색 순서: `../src/engine.js` → `../../src/engine.js` → `../../../Develop--INNO Prism/src/engine.js`
(즉 이 폴더를 저장소 `tests/` 밑에 통째로 복사해도 그대로 돌아간다.)

## 읽는 법

| 태그 | 뜻 |
|---|---|
| `[CURRENT]` | **현재 동작을 고정**하는 항목. 수정하면 FAIL 로 바뀌는 게 정상 |
| `[TARGET]` | **수정 후 PASS 해야 하는** 항목 |
| `[D·OK]` | 이미 정상 — 회귀 방지용. 항상 PASS 여야 한다 |

수정 전 기준선: **1 FAIL** (C 항목의 `[TARGET]` 한 줄).
그 줄이 PASS 로 바뀌고 `[D·OK]` 가 유지되면 C 완료.

## 파일

| 파일 | 내용 |
|---|---|
| `beam_full_gray16.bin.gz` | 1360×1024 uint16 (12-bit 값 <<4). 원본 TIFF 채널 0. 1.1 MB |
| `beam_crop512_rgb48.tif` | 512×512 RGB48 무압축 TIFF. **TIFF 디코더 단위시험용**. 빔 중심 crop |
| `repro.mjs` | 재현 하네스 |

`beam_crop512_rgb48.tif` 구조: `II`, BitsPerSample (16,16,16), Compression 1(없음),
단일 strip, StripOffsets 128, StripByteCounts 1572864. 원본 ProgRes 파일과 같은 형식.

## 재현되는 것

```
A.  비닝 언더샘플링   현행 f=5 → 샘플링 FWHM 2.84 px, A_peak 가 f=1 대비 ×2.148
A'. 경로 의존성       같은 빔을 1:1 원본 vs 3× 화면캡쳐에서 ×2.466 다르게 잰다
                      (2-pass 적용 시 ×1.036 으로 수렴)
B.  비트깊이          canvas 8-bit 가 Gaussian 면적 +22.3%, d4sAreaRatio 2.600 vs 4.052
C.  선형성 검사       정상 파일이 indeterminate → clean=false
D.  정상 동작 확인    업스케일 L=1.040 (미판정), 블록 ratio=1.003 (미판정)
```

상세 근거·수정 방향: 프로젝트 문서
`claude/Prism수정필요-감마테스트가드러낸비닝언더샘플링·16bit경로·선형성검사-0921.md`

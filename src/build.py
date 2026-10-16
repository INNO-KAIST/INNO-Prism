#!/usr/bin/env python3
"""Assemble the single-file INNO Prism.html (fully offline: libs embedded)."""
from pathlib import Path

ROOT = Path(__file__).parent
VERSION = "3.19.0"

# ---------------------------------------------------------------------------
# 연구실 공용 대물렌즈 목록 (Firebase Realtime Database)
#   여기에 URL을 넣고 빌드하면 이 빌드를 쓰는 모든 PC가 입력 없이 자동 연결된다.
#   비워두면 로컬 전용으로 동작하며, 앱 안 "공유 설정"에서 개별 입력도 가능.
#   예: "https://inno-prism-default-rtdb.asia-southeast1.firebasedatabase.app"
# ---------------------------------------------------------------------------
FIREBASE_DB_URL = "https://inno-prism-default-rtdb.asia-southeast1.firebasedatabase.app/"

style = (ROOT / "style.css").read_text(encoding="utf-8")
# INNO suite 공통 UX 층 (2026-09-29): 대화창·키보드·앱 전환. 6개 앱이 같은 inno-ux.js 를 쓴다.
style += "\n" + (ROOT / "inno-ux.css").read_text(encoding="utf-8")
ux_cfg = (ROOT / "ux-config.js").read_text(encoding="utf-8")
ux_js = (ROOT / "inno-ux.js").read_text(encoding="utf-8")
engine = (ROOT / "engine.js").read_text(encoding="utf-8")
fit2 = (ROOT / "fit2.js").read_text(encoding="utf-8")
h5layer = (ROOT / "h5layer.js").read_text(encoding="utf-8")
imaging = (ROOT / "imaging.js").read_text(encoding="utf-8")
tiff = (ROOT / "tiff.js").read_text(encoding="utf-8")
report = (ROOT / "report.js").read_text(encoding="utf-8")
app = (ROOT / "app.js").read_text(encoding="utf-8")
# node_modules 는 **저장소 루트**에 있다 (v3.6에서 src/ 에서 올림).
# 관례적 위치이기도 하고, 그래야 tests/ 에서도 Node 가 위로 올라가며 자동 해석한다
# (h5wasm 은 ESM exports 맵이라 경로를 직접 지정하는 방식이 깔끔하지 않다).
def _dep(rel):
    for base in (ROOT.parent, ROOT):
        p = base / "node_modules" / rel
        if p.is_file():
            return p.read_text(encoding="utf-8")
    raise SystemExit(f"의존성을 찾을 수 없습니다: node_modules/{rel}\n"
                     f"  저장소 루트에서: npm install h5wasm plotly.js-dist-min")

plotly = _dep("plotly.js-dist-min/plotly.min.js")
h5wasm = _dep("h5wasm/dist/iife/h5wasm.js")

def guard(name, src):
    if "</script" in src.lower():
        raise SystemExit(f"{name} contains literal </script> — would break inline embedding")

for name, src in [("ux_cfg", ux_cfg), ("ux_js", ux_js), ("engine", engine), ("fit2", fit2), ("h5layer", h5layer), ("imaging", imaging), ("tiff", tiff), ("report", report), ("app", app)]:
    guard(name, src)
# minified libs may contain "</script>" split-safe forms; check anyway
for name, src in [("plotly", plotly), ("h5wasm", h5wasm)]:
    if "</script>" in src:
        src2 = src.replace("</script>", "<\\/script>")
        if name == "plotly":
            plotly = src2
        else:
            h5wasm = src2

# 브랜드 마크 (INNO suite 아이콘 체계, 2026-09-29) — 원본은 src/brand/*.svg
# 헤더 마크와 파비콘은 같은 그림. 그라디언트 id 는 둘이 서로 달라야 한다(bpe / pfav).
prism_svg = (ROOT / "brand" / "header.svg").read_text(encoding="utf-8").strip()

# favicon: prism-spectrum mark (data: URL — no external file)
import urllib.parse
_favicon_svg = (ROOT / "brand" / "favicon.svg").read_text(encoding="utf-8").strip()
favicon_href = "data:image/svg+xml," + urllib.parse.quote(_favicon_svg)

html = f"""<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>INNO Prism — Optical Data Browser &amp; Non-linearity Analyzer</title>
<link rel="icon" href="{favicon_href}" type="image/svg+xml">
<link rel="icon" href="favicon.ico" sizes="48x48">
<link rel="apple-touch-icon" href="apple-touch-icon.png">
<style>
{style}
</style>
</head>
<body>
<div id="progress-bar"></div>
<div id="toast"></div>
<div id="app">
  <header>
    <div class="brand">{prism_svg} INNO <span class="brand-accent">Prism</span> <span class="ver">v{VERSION}</span></div>
    <button id="open-files">파일 열기</button>
    <button id="open-dir">폴더 열기</button>
    <button id="batch-btn">일괄 피팅</button>
    <button id="calib-btn">빔 보정</button>
    <span id="ledger-calib-badge" class="ledger-badge" style="display:none" onclick="detachLedgerSession()" title=""></span>
    <div class="spacer"></div>
    <span class="muted small">.h5 데이터는 브라우저 안에서만 처리됩니다 · 오프라인 동작</span>
  </header>
  <div id="main">
    <aside id="sidebar">
      <div class="side-head">
        <button id="side-toggle" class="small" title="파일 목록 접기/펼치기">☰</button>
        <input id="file-search" type="text" placeholder="파일 검색…">
        <span id="file-count" class="muted small"></span>
        <select id="file-sort" class="small" title="파일 목록 정렬 기준">
          <option value="name">이름순 (1,2,…,10)</option>
          <option value="added">불러온 순</option>
          <option value="type">측정 종류순</option>
          <option value="size">크기순 (큰 것부터)</option>
        </select>
        <button id="clear-all" class="small" title="불러온 파일 전체 제거 (원본은 삭제되지 않음)">전체 제거</button>
      </div>
      <div id="drop-hint">.h5 파일을<br>여기로 드래그하세요</div>
      <div id="file-list"></div>
    </aside>
    <div id="content">
      <div id="file-header"></div>
      <div id="tabs"></div>
      <div id="view"></div>
    </div>
  </div>
</div>
<input id="file-input" type="file" accept=".h5,.hdf5" multiple style="display:none">
<input id="dir-input" type="file" webkitdirectory style="display:none">

<script>window.PRISM_FIREBASE_URL = "{FIREBASE_DB_URL}";</script>
<!-- h5wasm (HDF5 → WASM, wasm embedded, offline) -->
<script>
{h5wasm}
</script>
<!-- Plotly (offline) -->
<script>
{plotly}
</script>
<!-- INNO Prism core data layer -->
<script id="prism-engine-src">
{engine}
</script>
<!-- PrismFit 2.0 non-linearity engine (shared by main thread and Web Worker) -->
<script id="prism-fit2-src">
{fit2}
</script>
<!-- HDF5 measurement-type layer -->
<script>
{h5layer}
</script>
<!-- minimal TIFF decoder (16-bit path, canvas 우회) -->
<script>
{tiff}
</script>
<!-- widefield imaging numeric layer -->
<script>
{imaging}
</script>
<!-- report figure export + scale bar (v3.19) -->
<script>
{report}
</script>
<!-- application -->
<script>
{app}
</script>
<!-- INNO suite UX layer -->
<script>
{ux_cfg}
</script>
<script>
{ux_js}
</script>
</body>
</html>
"""

# 빌드 산출물은 **저장소 루트의 INNO Prism.html 하나**다 (v3.6에서 정리).
#
# v2.6 까지는 src/INNO Prism.html 에도 같은 10.6 MB 를 썼다. 루트 사본을 수동 복사에
# 맡기면 구 버전이 배포되는 사고가 나서 자동화한 것인데, 그 뒤 루트 쪽이 실제로 여는
# 파일이자 tests/test_bistable_ui.mjs 가 읽는 대상이 되면서 src 사본은 아무도 참조하지
# 않는 중복이 됐다(같은 파일이 루트·src·github-pages 에 3벌, 합 32 MB).
# 그래서 src 쪽 출력을 끊는다. github-pages/index.html 은 배포본이므로 그대로 갱신한다.
targets = [(ROOT.parent if ROOT.parent != ROOT else ROOT) / "INNO Prism.html"]
for out in targets:
    out.write_text(html, encoding="utf-8")
    print(f"built {out} ({out.stat().st_size/1e6:.2f} MB)")

# GitHub Pages 배포본 자동 갱신 (github-pages/index.html)
for pages_dir in (ROOT / "github-pages", ROOT.parent / "github-pages"):
    if pages_dir.is_dir():
        (pages_dir / "index.html").write_text(html, encoding="utf-8")
        print(f"updated {pages_dir / 'index.html'}")
        break

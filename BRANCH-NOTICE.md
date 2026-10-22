# source 브랜치 — INNO Prism 소스 백업

이 브랜치는 **소스 백업 전용**입니다. GitHub Pages는 `main`만 서빙하므로 사이트에 영향이 없습니다.

- 배포 산출물(`github-pages/index.html`)은 `main`에 있습니다. 빌드: `python src/build.py`
- 갱신: `push <키>` 를 하면 **배포 뒤 이 브랜치도 자동으로 따라옵니다**(manifest의 `after` 연계).
  배포에 변경이 없어도(문서·테스트만 고친 날) 이 브랜치는 갱신됩니다.

## ⚠ 복구 시

Slack 웹훅 등 **비밀 URL**이 `REPLACE_WITH_REAL_…` 로 치환돼 있을 수 있습니다.

개인 이메일 주소가 `ALLOWED_EMAIL_1@example.com` 식 자리표시자로 치환돼 있을 수 있습니다(이 저장소가 공개이기 때문입니다). 서로 다른 주소는 서로 다른 번호를 받으므로 구별은 보존됩니다.

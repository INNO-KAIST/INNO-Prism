# 연구실 공용 대물렌즈 목록 설정 (Firebase Realtime Database)

렌즈 목록을 연구실 전체가 실시간으로 공유하기 위한 1회 설정입니다.
**측정 데이터(.h5)는 전송되지 않습니다.** 공유되는 것은 렌즈 제조사·모델·배율뿐입니다.
무료 Spark 요금제로 충분합니다(렌즈 목록은 수 KB, 동시 접속 100개 한도).

---

## 1. Firebase 프로젝트 만들기 (약 3분)

1. https://console.firebase.google.com 접속 → **프로젝트 추가**
2. 프로젝트 이름: 예 `inno-prism` → Google 애널리틱스는 **사용 안 함** 선택 가능
3. 생성 완료 후 좌측 메뉴 **빌드 → Realtime Database** → **데이터베이스 만들기**
4. 위치: **asia-southeast1 (싱가포르)** 권장 (한국에서 가장 가까움)
5. 보안 규칙: 일단 **잠금 모드**로 시작 → 다음 단계에서 교체

## 2. 보안 규칙 설정

Realtime Database → **규칙** 탭에서 아래 중 하나를 붙여넣고 **게시**합니다.

### 방식 A — 연구실 전원이 앱에서 추가·삭제 (권장)

```json
{
  "rules": {
    "lenses": {
      ".read": true,
      ".write": true,
      "$key": {
        ".validate": "newData.hasChildren(['maker','model','mag']) && newData.child('mag').isNumber() && newData.child('maker').isString() && newData.child('model').isString() && newData.child('model').val().length < 120 && (!newData.hasChild('na') || (newData.child('na').isNumber() && newData.child('na').val() > 0 && newData.child('na').val() < 2)) && (!newData.hasChild('f') || newData.child('f').isNumber()) && (!newData.hasChild('medium') || newData.child('medium').isString())"
      }
    },
    "$other": { ".read": false, ".write": false }
  }
}
```

`lenses` 경로만 열리고 데이터 형식까지 검증합니다. URL을 아는 사람은
누구나 렌즈를 추가·삭제할 수 있으니, 사내 공유 정도로 생각하시면 됩니다.

### 방식 B — 읽기만 공유, 추가·삭제는 관리자만

```json
{
  "rules": {
    "lenses": { ".read": true, ".write": false },
    "$other": { ".read": false, ".write": false }
  }
}
```

앱은 목록을 받아오기만 하고, 추가·삭제는 Firebase 콘솔의 데이터 탭에서
직접 합니다. (앱에서 추가하면 "미동기화"로 남습니다.)

## 3. 데이터베이스 URL 확인

Realtime Database **데이터** 탭 상단에 표시되는 주소입니다.

```
https://inno-prism-default-rtdb.asia-southeast1.firebasedatabase.app
```

⚠️ 뒤에 `/lenses`나 `.json`을 붙이지 말고 **최상위 주소만** 사용하세요.

## 4. 앱에 연결

### 지금 바로 테스트 (PC 한 대씩)
앱 → **빔 보정** → *렌즈 목록 관리* 펼치기 → **공유 설정** →
URL 붙여넣기 → **연결**. 상태가 `● 실시간 공유 중`으로 바뀌면 성공입니다.

### 모든 PC에 자동 적용 (권장)
`src/build.py` 상단의 다음 줄에 URL을 넣고 다시 빌드하면, 그 빌드를 쓰는
모든 PC가 아무 설정 없이 자동 연결됩니다.

```python
FIREBASE_DB_URL = "https://inno-prism-default-rtdb.asia-southeast1.firebasedatabase.app"
```

```
python build.py
```

GitHub Pages로 배포 중이라면 새로 생성된 `github-pages/index.html`을
저장소에 다시 업로드하면 됩니다.

---

## 동작 방식 (알아두면 좋은 점)

- **실시간**: Firebase의 스트리밍(SSE)에 연결되어, 누가 렌즈를 추가하면
  다른 PC 화면에 **새로고침 없이** 즉시 나타납니다.
- **오프라인 안전**: 인터넷이 없거나 서버에 못 붙어도 목록은 그대로 보이고
  사용할 수 있습니다. 그때 추가한 렌즈는 `· 미동기화`로 표시되며,
  연결이 복구되면 **자동으로 전송**됩니다.
- **삭제**: 공용 목록에서 지우면 모든 PC에서 사라지므로 확인 창이 뜹니다.
- **백업**: *내보내기* 버튼으로 목록을 JSON 파일로 저장하고, 다른 PC에서
  *가져오기* 로 복원할 수 있습니다(중복은 자동으로 걸러집니다).
- **기록 항목**: 제조사·모델·배율에 더해 **NA·침지 매질(Air/Oil/Water/Glycerol)·
  초점거리**를 함께 공유합니다. 초점거리는 비워두면 제조사 경통렌즈 기준으로
  자동 계산되고(Olympus 180 / Nikon·Leica·Mitutoyo 200 / Zeiss 165 mm ÷ 배율),
  스펙에 명시된 값이 있으면 입력해서 덮어쓸 수 있습니다.
- **SDK를 쓰지 않습니다**: REST + 스트리밍만 사용하므로 앱 용량이 늘지 않고,
  오프라인 단일 HTML 원칙이 유지됩니다.

## 문제가 생기면

| 증상 | 확인할 것 |
|---|---|
| `⚠ 연결 실패` | URL 오타, 뒤에 `/lenses`·`.json`이 붙지 않았는지, 규칙 게시 여부 |
| 목록이 안 올라감 | 규칙이 방식 B(읽기 전용)인지 확인 |
| 추가는 되는데 다른 PC에 안 보임 | 두 PC가 같은 URL을 쓰는지 (공유 설정에 표시됨) |
| 목록이 비어 보임 | 콘솔 데이터 탭에 `lenses` 노드가 있는지 |

# FhGate 계약 v0 — 화면(JS) ↔ 네이티브 어댑터 ↔ 관문 (2026-10-13, B1 준비)

상태: Android 초안 코드 + 순수 mock 시험(JVM 14/14) + 정적 빌드만. **실서버·에뮬·실기기 호출 0.** iOS 는 계약·인계만(빌드 통과 주장 없음).
소유: 이 계약과 `mobile/**` 네이티브 = 모바일 mentor · 화면 쪽 사용(`ui/**`)과 서버 S1~S4 구현 = UI mentor(앱 Codex 10-13 지정). 이름·필드·코드를 바꿀 때는 이 문서를 먼저 고치고 서로 알린다.
설계 근거: `mobile/docs/B-BUNDLED-DESIGN.md` 2판. 코드: `android/app/src/main/java/org/footholdproject/app/FhGateCore.java`(핵심, 안드로이드 의존 없음) · `FhGatePlugin.java`(JS 연결 + Keystore 보관) · 시험 `android/app/src/test/java/org/footholdproject/app/FhGateCoreTest.java`.

## 1. JS 쪽 타입 (화면이 `registerPlugin<FhGate>('FhGate')` 로 쓴다 — bundled 에서는 `@capacitor/core` 를 번들에 넣을 수 있음)

```ts
export type FhCode =
  | 'bad_input' | 'no_gate' | 'no_session' | 'bad_state' | 'stale'
  | 'tls' | 'net' | 'unknown' | 'auth' | 'origin' | 'busy' | 'redirect' | 'server' | 'too_big' | 'bad_type';

export interface FhState { origin: string | null; loggedIn: boolean; account: string | null; device6: string | null; exp: number | null; gen: number }

export interface FhGate {
  state(): Promise<FhState>;
  setGate(o: { origin: string }): Promise<FhState>;                       // 바뀌면 로컬 로그아웃(gen+1)·기기 값 삭제
  login(o: { user: string; pw: string; label?: string }): Promise<{ account: string; device6: string; exp: number; gen: number }>;
  request(o: { op: 'whoami' | 'docs.get' | 'docs.post' | 'media.list'; body?: object }): Promise<{ status: number; body: string; gen: number }>;
  photo(o: { path: string }): Promise<{ status: 200 | 404; gen: number; mime?: 'image/jpeg'; base64?: string }>;
  wsTicket(): Promise<{ url: string; gen: number }>;                        // wss://<관문>/api/app/ws?t=<1회용 표>
  logout(o?: { reason?: string }): Promise<{ ok: true; server: 'pending' | 'none'; gen: number }>;
  addListener(e: 'logoutResult', f: (v: { server: 'ok' | 'failed' | 'none'; reason: string; gen: number }) => void): Promise<{ remove(): Promise<void> }>;
  addListener(e: 'sessionEnded', f: (v: { reason: 'expired'; gen: number }) => void): Promise<{ remove(): Promise<void> }>;
}
```

- 실패는 Promise reject, `err.code` 가 위 `FhCode` 하나. `err.message` 는 사람이 읽는 짧은 한국어(토큰·비밀번호 없음).
- `request().body` 는 관문 응답 본문 글 그대로 — 화면이 `JSON.parse`. `docs.post` 는 200·400·403·404·409(`cur`)·500·503 을 **reject 하지 않고** `status` 로 넘긴다(기존 `/api/docs` 화면 처리 그대로). 어댑터는 어느 요청도 재시도하지 않는다.
- `photo` 는 `path` 가 `^media/photos/\d{8}/[\w.-]+\.jpg$`(ASCII) 일 때만 네트워크에 간다. 화면: `base64` → `Uint8Array` → `Blob` → `URL.createObjectURL`, 목록에서 빠질 때·화면 떠날 때·로그아웃 때 `revokeObjectURL`.
- 저장(`saveFile`)은 B2 — 이번 초안에 없다. CSV·JSON 자료 만드는 JS 는 그대로 두고 저장 단계만 나중에 바꾼다.

## 2. 연결 세대 `gen`

- 어댑터는 로그아웃·관문 주소 변경·401 때 `gen += 1`. 모든 성공 결과에 그 호출이 **시작될 때의** `gen` 을 붙이고, 끝날 때 바뀌었으면 결과를 버리고 `stale` 로 reject(옛 로그인의 토큰은 저장하지 않고, 서버에 생긴 그 세션에 로그아웃 1회).
- 화면 규칙: 현재 `gen` 을 들고 있다가 결과·이벤트의 `gen` 이 다르면 버린다. `wsTicket().gen !== 현재` 면 WS 를 열지 않는다. 열린 WS 는 `logout`·`setGate`·`sessionEnded` 를 받으면 닫는다.
- 로그아웃·주소변경·만료 순서(화면이 먼저 하는 것): 누름 버림·20 Hz 멈춤 → (열려 있으면) `{op:'hidden'}` 최선 → WS close → `FhGate.logout()` / `setGate()` → 로그인 화면. 어댑터는 `logout` 즉시 토큰을 지우고 서버 알림은 뒤에서 한 번(`logoutResult`). `server:'failed'` 는 «이 기기에서는 로그아웃됨 · 서버 세션 종료 확인 못 함» 으로 표시한다.
- `sessionEnded`: 어떤 요청이 401 을 받으면 어댑터가 이미 로컬 폐기·`gen+1` 을 마친 뒤 보낸다. 화면은 위 순서의 나머지(WS close·로그인 화면)를 한다.

## 3. 관문 쪽 경로 (S1~S4 — UI mentor 구현, 기존 쿠키 경로·`/ws`·`same_origin` 은 손대지 않음)

모든 `/api/app/*` 요청 헤더: `Origin: https://localhost`(Android) 또는 `capacitor://localhost`(iOS) — 서버는 이 둘의 **정확 일치**만 받고 다르면 403. Origin 은 신원이 아니다. 인증은 `Authorization: Bearer <token>` 만 보고 쿠키는 무시(반대로 기존 `/api/*`·`/ws` 는 Authorization 을 무시). 3xx 를 보내지 않는다(어댑터는 3xx 를 `redirect` 오류로 끝냄).

| 경로 | 요청 | 200 응답(JSON) | 그 밖 |
|---|---|---|---|
| `POST /api/app/login` | `{user(1~64자), pw(1~256자), label?(≤64), device?}` — `device` 는 이전에 받은 값 | `{token, device, account, exp}` · `token`·`device` = `[A-Za-z0-9_-]{16,256}` · `exp` = epoch 초 | 400 형식 · 401 계정/비번 · 403 Origin · 429 실패 제한·동시 로그인 |
| `GET /api/app/whoami` | bearer | 기존 `/api/whoami` 와 같음 | 401 → 어댑터 로컬 폐기 |
| `GET /api/app/docs` · `POST /api/app/docs` | bearer, POST 본문은 기존 `/api/docs` 와 같음 | 기존과 같음 | POST: 400·403·404·409·500·503 은 본문과 함께 화면까지 · 쓰기 작성자는 세션 계정·기기(기존 `X-FH-Actor` 와 같게) |
| `GET /api/app/media` | bearer | 기존 `/api/media` 와 같음 | 502 v2_link 없음 → `server` |
| `GET /api/app/media/photos/<8자리>/<이름>.jpg` | bearer | `Content-Type: image/jpeg` 바이트(≤5 MB 임시 상한) | 404 는 화면까지 |
| `POST /api/app/ws-ticket` | bearer, 빈 본문 | `{ticket, ttl_s}` · `ticket` = `[A-Za-z0-9_-]{16,128}` · ttl ≤30 s | 401 · 429 보관 상한 |
| `GET /api/app/ws?t=<ticket>` (WebSocket) | WebView 가 보내는 Origin(앱 두 값 정확 일치) | 기존 Bridge 와 같은 중계, 보기 전용 시작 | 표 없음·사용됨·만료·결속 불일치 → 4401 · 허용 안 된 메시지 → 4403 · 세션 끝 → 4401. 표 질의는 접근 로그에서 지움 |
| `POST /api/app/logout` | bearer | `{ok:true}` → 세션 끝 + 그 세션 앱 WS 4401 + 남은 표 폐기 | 401(이미 끝남)도 어댑터는 `ok` 로 본다 |

표 결속(서버): 계정·기기·세션 토큰·대상 관문 Host·앱 origin·엔드포인트. 원자적 1회 소비. 표 발급·WS 접속은 take/resume 을 보내지 않는다.

## 4. Android 초안이 지키는 것 (코드 위치)

| 항목 | 어떻게 | 시험 |
|---|---|---|
| 토큰은 네이티브만 | `FhGateCore` 필드 + `KeystoreVault`(Android Keystore AES-256-GCM 키, 내보낼 수 없음) 로 감싼 SharedPreferences. resolve·reject·이벤트·로그에 토큰 없음 | `loginKeepsTokenNativeAndSendsExactOrigin` |
| 주소 규칙 | `gateOrigin` = `scripts/gate-profile.mjs` 와 같은 규칙(+대문자 호스트 거부), 보관본 복원 때도 재검사 | `gateOriginSameRulesAsGateProfile` (3 통과·17 거부) · `restoreDropsExpiredAndRechecksOrigin` |
| 고정 op·경로만 | `OPS` 4개 + `photo` 정규식 + `ws-ticket`·`login`·`logout` | `requestUses…` · `photoPathCheckedBeforeAnyNetwork` |
| TLS 기본 검사·redirect 금지 | `HttpsTransport`: `HttpsURLConnection` 기본 신뢰·호스트 검사(교체 없음), `setInstanceFollowRedirects(false)`, https 아니면 거부, 본문 상한 | `httpsTransportRefusesPlainHttp` · 3xx → `redirect` |
| 오류 분류 | `classify`: SSL/인증서 계열 → `tls`, 이름·연결·시간 초과 → `net`, 나머지 `unknown`(추측 안 함) | `classifyNativeErrors` |
| gen·stale·401 | `authed`·`login`·`wsTicket` 의 시작/끝 gen 비교, 401 → `endLocal` | `staleLoginIsDroppedNotStored` · `staleRequestResultIsDropped` · `unauthorizedEnds…` |
| 로그아웃 로컬 먼저 | `logout` 이 `endLocal` 후 resolve, `serverLogout` 은 io 스레드에서 1회, 실패는 `failed` | `logoutIsLocalFirst…` |
| 주소 변경 | 다른 origin 이면 토큰·기기 값 삭제 + 옛 관문에 로그아웃 1회 | `gateChangeWipesSessionAndDevice` |

검증 명령(이 PC, 실서버·에뮬 없음): `cd mobile/android && JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 ANDROID_HOME=~/Android/Sdk ./gradlew :app:testDebugUnitTest :app:assembleDebug :app:lintDebug` → FhGateCoreTest 14/14, lint 오류 0(경고: `ApplySharedPref` 3 — 토큰 폐기를 즉시 디스크에 쓰려고 `commit` 을 일부러 씀).
시험용 의존 하나: `testImplementation "org.json:json:20240303"`(JVM 시험에 Android org.json 구현이 없어서. 앱 실행 때는 Android 내장).

## 5. 미확인 (실측 전 주장하지 않음)

- Android `HttpsURLConnection` 이 `Origin` 헤더를 그대로 보내는지(JDK 는 제한 헤더로 막지만 Android 구현은 다름) — 실서버 격리 통합 때 서버 로그로 확인.
- Keystore 키 생성·복호 실패(기기 잠금 변경·백업 복원 등) 때 «로그아웃 상태로 시작» 동작 — 에뮬·실기기 미실행.
- 사진 base64 브리지 비용·상한(1 MB JSON·5 MB 사진은 임시값), 동시 요청 2 스레드의 충분성.
- `logout` 의 로컬 폐기가 진행 중인 요청보다 먼저 끝나도 그 요청이 `stale` 로 끝나는 것은 mock 으로만 확인.
- WebView WS 의 TLS 오류는 JS `error` 이벤트에 원인이 없음(WHATWG) → 화면은 `request({op:'whoami'})` 로 원인을 다시 잰다(설계만).

## 6. iOS 인계 (같은 계약, 빌드·서명 환경 없음 → 코드 없음)

- 출처 `capacitor://localhost` 를 `Origin` 에 명시. `URLSession` + delegate 의 `willPerformHTTPRedirection` 에서 `completionHandler(nil)`(redirect 금지). 인증서 검사는 기본 그대로 — `didReceive challenge` 에서 신뢰를 바꾸지 않는다.
- **인증서 신뢰**: ATS 기본(예외 키 `NSAllowsArbitraryLoads` 등 없음). 사설 CA 관문을 쓸지·어떻게 믿게 할지는 배포처별 결정 — 미정.
- **비밀 보관**: 세션 덩어리를 Keychain `kSecClassGenericPassword`, `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`(기기 백업으로 옮겨지지 않게). Keychain 은 인증서 신뢰와 무관.
- 오류 분류: `NSURLErrorServerCertificate*`·`NSURLErrorSecureConnectionFailed` → `tls`, `CannotFindHost`·`CannotConnectToHost`·`TimedOut`·`NotConnectedToInternet` → `net`, 그 밖 `unknown`.
- 순수 로직(`gateOrigin`·사진 정규식·OPS·gen·상태 코드 매핑)은 `FhGateCoreTest` 의 같은 표를 XCTest 로 옮긴다. Mac·Xcode·서명 환경 확보 전에는 «iOS 준비됨»으로 표시하지 않는다.

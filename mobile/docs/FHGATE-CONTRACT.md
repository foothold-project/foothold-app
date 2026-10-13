# FhGate 계약 v0.1 — 화면(JS) ↔ 네이티브 어댑터 ↔ 관문 (2026-10-13, B1 준비)

상태: Android 초안 코드 + 순수 mock 시험(JVM 25/25, 경합 반례 포함) + 정적 빌드만. v0.1 = 앱 Codex B1 코드검수 7건(호출 문맥 고정·동시 로그인·오류 gen 결속·파괴 무효화·저장 결과·형식 엄격·대기 상한) 반영. **실서버·에뮬·실기기 호출 0.** iOS 는 계약·인계만(빌드 통과 주장 없음).
소유: 이 계약과 `mobile/**` 네이티브 = 모바일 mentor · 화면 쪽 사용(`ui/**`)과 서버 S1~S4 구현 = UI mentor(앱 Codex 10-13 지정). 이름·필드·코드를 바꿀 때는 이 문서를 먼저 고치고 서로 알린다.
설계 근거: `mobile/docs/B-BUNDLED-DESIGN.md` 2판. 코드: `android/app/src/main/java/org/footholdproject/app/FhGateCore.java`(핵심, 안드로이드 의존 없음) · `FhGatePlugin.java`(JS 연결 + Keystore 보관) · 시험 `android/app/src/test/java/org/footholdproject/app/FhGateCoreTest.java`.

## 1. JS 쪽 타입 (화면이 `registerPlugin<FhGate>('FhGate')` 로 쓴다 — bundled 에서는 `@capacitor/core` 를 번들에 넣을 수 있음)

```ts
export type FhCode =
  | 'bad_input' | 'no_gate' | 'no_session' | 'bad_state' | 'stale'
  | 'tls' | 'net' | 'unknown' | 'auth' | 'origin' | 'busy' | 'redirect' | 'server' | 'too_big' | 'bad_type'
  | 'storage' | 'internal';

export interface FhState {
  origin: string | null; loggedIn: boolean; account: string | null; device6: string | null; exp: number | null;
  stored: boolean | null;   // 세션이 디스크에도 있나(false = 메모리만 — 앱 다시 켜면 재로그인)
  locked: boolean;          // 로컬 폐기가 디스크에 반영 안 됨 — 로그인·요청 거부, 다시 logout 해야 풀림
  gen: number;
}
export interface FhErr { code: FhCode; message: string; data: { gen: number } }   // data.gen = 이 오류가 속한 호출의 gen

export interface FhGate {
  state(): Promise<FhState>;
  setGate(o: { origin: string }): Promise<FhState & { wiped: boolean }>;  // 바뀌면 로컬 로그아웃(gen+1)·기기 값 삭제
  login(o: { user: string; pw: string; label?: string }): Promise<{ account: string; device6: string; exp: number; gen: number; stored: boolean }>;   // gen = 로그인 뒤 새 gen
  request(o: { op: 'whoami' | 'docs.get' | 'docs.post' | 'media.list'; body?: object }): Promise<{ status: number; body: string; gen: number }>;
  photo(o: { path: string }): Promise<{ status: 200 | 404; gen: number; mime?: 'image/jpeg'; base64?: string }>;
  wsTicket(): Promise<{ url: string; gen: number }>;                        // wss://<관문>/api/app/ws?t=<1회용 표>
  logout(o?: { reason?: string }): Promise<{ ok: boolean; server: 'pending' | 'none'; gen: number }>;   // ok = 디스크 폐기까지, gen = 새 gen
  addListener(e: 'logoutResult', f: (v: { server: 'ok' | 'failed' | 'none'; reason: string; gen: number }) => void): Promise<{ remove(): Promise<void> }>;
  addListener(e: 'sessionEnded', f: (v: { reason: 'expired'; gen: number }) => void): Promise<{ remove(): Promise<void> }>;
}
```

- 실패는 Promise reject, `err.code` 가 위 `FhCode` 하나, `err.data.gen` 은 그 호출을 받은 순간의 gen. `err.message` 는 사람이 읽는 짧은 한국어(토큰·비밀번호 없음).
- `busy`: 같은 gen 에 로그인이 이미 진행 중, 또는 대기 칸(실행 2 + 대기 8) 이 참 — 바로 거부, 재시도는 화면 판단. `internal`: 예기치 않은 네이티브 예외(Promise 를 남기지 않으려는 고정 코드) — 호출 문맥이 현재일 때만. 이미 옛 문맥이면 `stale`(gen 은 호출 문맥 그대로, `unexpectedIsInternalOnlyForCurrentContext`). `storage`: `locked` 상태.
- `request().body` 는 관문 응답 본문 글 그대로 — 화면이 `JSON.parse`. `docs.post` 는 200·400·403·404·409(`cur`)·500·503 을 **reject 하지 않고** `status` 로 넘긴다(기존 `/api/docs` 화면 처리 그대로). 어댑터는 어느 요청도 재시도하지 않는다.
- `photo` 는 `path` 가 `^media/photos/\d{8}/[\w.-]{1,80}\.jpg$`(ASCII) 이고 `..` 가 없을 때만(v2_link 문서 검사 `PHOTO` 와 같은 꼴 — `/api/media` 의 `url` 이 이 모양) 네트워크에 간다. 화면: `base64` → `Uint8Array` → `Blob` → `URL.createObjectURL`, 목록에서 빠질 때·화면 떠날 때·로그아웃 때 `revokeObjectURL`.
- 저장(`saveFile`)은 B2 — 이번 초안에 없다. CSV·JSON 자료 만드는 JS 는 그대로 두고 저장 단계만 나중에 바꾼다.

## 2. 연결 세대 `gen`·호출 문맥·수명

- 어댑터는 로그인 성공·로그아웃·관문 주소 변경·401 때 `gen += 1`.
- **호출 문맥**: 플러그인이 호출을 받는 순간(io 큐에 넣기 전) gen·관문·세션을 고정한다. 실행 직전에 현재와 다르면 `stale` — 네트워크 0(옛 계정·비밀번호가 새 관문으로 가지 않음, 옛 세션 요청이 새 세션 토큰으로 나가지 않음). 응답 뒤·resolve 직전에도 다시 대조해 다르면 버리고 `stale`. 옛 문맥의 IO 오류도 원인 대신 `stale`.
- 로그인: 같은 gen 에 하나만(두 번째는 `busy`). 늦게 온 옛 로그인 응답은 새 로그인을 덮지 않고, 그 응답으로 생긴 서버 세션에 로그아웃 1회. 응답 형식이 틀려도(만료 지남·31 일 넘음·숫자가 글·기기 값 형식) 토큰을 받았으면 그 세션에 로그아웃 1회 후 `server`.
- 오류·이벤트의 gen 은 그 사건이 속한 호출의 gen 그대로 — 현재 gen 으로 고쳐 붙이지 않는다. `sessionEnded.gen` = 401 로 끝난 그 세션의 gen. 로그인 실패 401(비밀번호 틀림)은 `sessionEnded` 를 내지 않는다.
- 화면 규칙: 현재 `gen` 을 들고 있다가 결과·오류·이벤트의 `gen` 이 다르면 버린다. `login`·`logout`·`setGate` 결과의 `gen` 이 새 현재 값. `wsTicket().gen !== 현재` 면 WS 를 열지 않는다. 열린 WS 는 `logout`·`setGate`·(자기 gen 의) `sessionEnded` 를 받으면 닫는다.
- 로그아웃·주소변경·만료 순서(화면이 먼저 하는 것): 누름 버림·20 Hz 멈춤 → (열려 있으면) `{op:'hidden'}` 최선 → WS close → `FhGate.logout()` / `setGate()` → 로그인 화면. 어댑터의 로컬 폐기는 io 큐를 거치지 않고 호출 스레드에서 바로 한다. 서버 알림은 뒤에서 한 번(`logoutResult`), 큐가 차 있으면 `failed`. `server:'failed'` 는 «이 기기에서는 로그아웃됨 · 서버 세션 종료 확인 못 함» 으로 표시.
- `logout().ok === false`(디스크 폐기 실패): 메모리에서는 지워졌지만 보관본에 옛 토큰이 남았을 수 있다 → `locked`, 로그인·요청 `storage` 거부, 조종 잠금 유지, 화면은 «기기 로그아웃 저장 실패 — 다시 로그아웃» 표시. 성공으로 단정하지 않는다.
- 로그인 `stored === false`: 세션은 메모리에만 — 앱을 다시 켜면 재로그인. 화면에 그렇게 알린다.
- **Activity 파괴**(재생성 포함): 그 인스턴스는 닫힘 — 대기 작업은 실행돼도 `stale`(네트워크 0), 진행 중 응답은 보관소·상태를 못 바꾼다. 보관 세션은 지우지 않는다(사용자 로그아웃 아님). 새 Activity 의 새 인스턴스가 보관본을 다시 엄격 검사해 읽는다(관문 규칙·기기·계정·`exp` 숫자·만료·31 일 상한).

## 3. 관문 쪽 경로 (S1~S4 — UI mentor 구현, 기존 쿠키 경로·`/ws`·`same_origin` 은 손대지 않음)

모든 `/api/app/*` 요청 헤더: `Origin: https://localhost`(Android) 또는 `capacitor://localhost`(iOS) — 서버는 이 둘의 **정확 일치**만 받고 다르면 403. Origin 은 신원이 아니다. 인증은 `Authorization: Bearer <token>` 만 보고 쿠키는 무시(반대로 기존 `/api/*`·`/ws` 는 Authorization 을 무시). 3xx 를 보내지 않는다(어댑터는 3xx 를 `redirect` 오류로 끝냄).

| 경로 | 요청 | 200 응답(JSON) | 그 밖 |
|---|---|---|---|
| `POST /api/app/login` | `{user(1~64자), pw(1~256자), label?(≤64), device?}` — `device` 는 이전에 받은 값 | `{token, device, account, exp}` · `token`·`device` = `[A-Za-z0-9_-]{16,256}` · `exp` = epoch 초 **숫자**(글 거부), 지금보다 뒤·31 일 이내 | 400 형식 · 401 계정/비번 · 403 Origin · 429 실패 제한·동시 로그인 |
| `GET /api/app/whoami` | bearer | 기존 `/api/whoami` 와 같음 | 401 → 어댑터 로컬 폐기 |
| `GET /api/app/docs` · `POST /api/app/docs` | bearer, POST 본문은 기존 `/api/docs` 와 같음 | 기존과 같음 | POST: 400·403·404·409·500·503 은 본문과 함께 화면까지 · 쓰기 작성자는 세션 계정·기기(기존 `X-FH-Actor` 와 같게) |
| `GET /api/app/media` | bearer | 기존 `/api/media` 와 같음 | 502 v2_link 없음 → `server` |
| `GET /api/app/media/photos/<8자리>/<이름>.jpg` | bearer | `Content-Type: image/jpeg` 바이트(≤5 MB 임시 상한) | 404 는 화면까지 |
| `POST /api/app/ws-ticket` | bearer, 빈 본문 | `{ticket, ttl_s}` · `ticket` = `[A-Za-z0-9_-]{16,128}` · `ttl_s` 숫자, 0 < ttl ≤ 30 | 401 · 429 보관 상한 |
| `GET /api/app/ws?t=<ticket>` (WebSocket) | WebView 가 보내는 Origin(앱 두 값 정확 일치) | 기존 Bridge 와 같은 중계, 보기 전용 시작 | 표 없음·사용됨·만료·결속 불일치 → 4401 · 허용 안 된 메시지 → 4403 · 세션 끝 → 4401. 표 질의는 접근 로그에서 지움 |
| `POST /api/app/logout` | bearer | `{ok:true}` → 세션 끝 + 그 세션 앱 WS 4401 + 남은 표 폐기 | 401(이미 끝남)도 어댑터는 `ok` 로 본다 |

표 결속(서버): 계정·기기·세션 토큰·대상 관문 Host·앱 origin·엔드포인트. 원자적 1회 소비. 표 발급·WS 접속은 take/resume 을 보내지 않는다.

## 4. Android 초안이 지키는 것 (코드 위치 · 시험)

| 항목 | 어떻게 | 시험(`FhGateCoreTest`) |
|---|---|---|
| 토큰은 네이티브만 | `FhGateCore` 필드 + `KeystoreVault`(Android Keystore AES-256-GCM 키, 내보낼 수 없음) 로 감싼 SharedPreferences. resolve·reject·이벤트·로그에 토큰 없음 | `loginKeepsTokenNativeAndSendsExactOrigin` |
| 주소 규칙 | `gateOrigin` = `scripts/gate-profile.mjs` 와 같은 규칙(+대문자 호스트·포트 65536 이상 거부), 보관본 복원 때도 재검사 | `gateOriginSameRulesAsGateProfile`(4 통과·20 거부) |
| 호출 문맥 고정 | 플러그인 메서드 첫 줄 `core.ctx()` → io 실행 직전 `live`·응답 뒤 `staleCheck`·resolve 직전 대조 — request·photo·wsTicket 은 `current(c)`, login 은 성공이 gen 을 올리므로 `confirm(l, c)`(새 gen l.gen 이 아직 현재·닫힘 아님). 대조와 resolve 사이 두 줄 틈은 남음(화면은 gen 비교 유지) | `loginCommittedThenEndedIsStaleAtResolve`(커밋 뒤 로그아웃·주소 변경·파괴 → stale)·`queuedLoginAfterLogout…`·`queuedLoginAfterGateChange…`·`queuedRequestFromOldSession…`·`ioErrorOfOldContextIsStale` |
| 동시 로그인 | `loginGen`(진행 중 로그인의 gen) — 같은 gen 두 번째는 `busy`, 늦은 응답은 덮지 않고 서버 로그아웃 | `concurrentLoginSameGenIsBusy`·`lateFirstLoginDoesNotOverwriteNewerLogin` |
| 오류 gen 결속 | `GateError.gen`·`sessionEnded`(401 로 끝난 세션만) | `unauthorizedEndsOnlyItsOwnSessionWithItsGen`·`late401AfterNewLoginDoesNotEndNewSession` |
| 파괴 무효화 | `handleOnDestroy` → `core.close()`(이후 stale·보관 쓰기 없음) + `io.shutdown()` | `closeInvalidatesPending…`·`loginInFlightWhenClosedIsNotStored`·`late401AfterCloseDoesNotTouchVault` |
| 저장 결과 | `Vault.save/clear` 가 commit 결과를 돌려줌, 폐기 저장 실패 → `clear` 재시도 → 그래도 실패면 `locked` | `loginSaveFailureIsMemoryOnly`·`logoutWipeFailureLocksUntilWiped`·`logoutSaveFailureFallsBackToClear` |
| 형식 엄격 | `strictStr/strictNum`(org.json 의 글↔숫자 자동 변환 거부), `exp` 유한·미래·31 일 이내, `ttl_s` 0<·≤30, 검사 끝난 값만 한꺼번에 대입 | `loginFailuresMapToCodes…`(나쁜 응답 9종)·`wsTicketUrlAndTtlValidation`·`restoreIsStrict`(6종) |
| 대기 상한 | `ThreadPoolExecutor` 실행 2 + 대기 8(`ArrayBlockingQueue`), 넘치면 `busy`, 예기치 않은 예외 `internal` — 2 스레드는 처리량일 뿐 우선 처리 보장 아님 | 정적 빌드만(플러그인은 Android 의존이라 JVM 시험 밖) |
| 시한 | 연결 5 s · 읽기 1회 10 s · 본문 읽는 동안 전체 20 s(`deadline` → `net`). 응답 헤더 전까지는 연결·읽기 시한만 적용 | `classifyNativeErrors` |
| 고정 op·경로·TLS·redirect | `OPS` 4개 + 사진 정규식(v2_link 와 같은 꼴) + `HttpsURLConnection` 기본 검사·`setInstanceFollowRedirects(false)` | `requestUses…`·`photoPathCheckedBeforeAnyNetwork`·`httpsTransportRefusesPlainHttp` |
| 로그아웃·주소 변경 | 로컬 먼저, 서버는 뒤에서 1회(실패 = `failed`), 다른 origin 이면 기기 값도 삭제·옛 관문으로 로그아웃 | `logoutIsLocalFirst…`·`gateChangeWipesSessionAndDevice` |

검증 명령(이 PC, 실서버·에뮬 없음): `cd mobile/android && JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 ANDROID_HOME=~/Android/Sdk ./gradlew :app:testDebugUnitTest :app:assembleDebug :app:lintDebug` → FhGateCoreTest 25/25, lint 오류 0(경고 `ApplySharedPref` — 토큰 폐기를 즉시 디스크에 쓰려고 `commit` 을 일부러 씀). 변이 확인 1회: `live` 의 gen 대조를 빼면 경합 시험 3개 실패(원복 md5 확인).
시험용 의존 하나: `testImplementation "org.json:json:20240303"`(JVM 시험에 Android org.json 구현이 없어서. 앱 실행 때는 Android 내장).

## 5. 미확인 (실측 전 주장하지 않음)

- Android `HttpsURLConnection` 이 `Origin` 헤더를 그대로 보내는지(JDK 는 제한 헤더로 막지만 Android 구현은 다름) — 실서버 격리 통합 때 서버 로그로 확인.
- Keystore 키 생성·복호 실패(기기 잠금 변경·백업 복원 등) 때 «로그아웃 상태로 시작» 동작 — 에뮬·실기기 미실행.
- 사진 base64 브리지 비용·상한(1 MB JSON·5 MB 사진은 임시값), 실행 2·대기 8 의 충분성.
- 플러그인 층(Ctx 를 큐 전에 잡기·`done` 대조·거부 → `busy`/`stale`·파괴 순서)은 정적 빌드만 — JVM 시험은 Core 까지. Activity 재생성 때 옛 `handleOnDestroy` 가 새 `load` 보다 먼저인지는 미측정(먼저가 아니어도 옛 인스턴스는 닫힌 뒤 보관소를 못 씀).
- 경합(큐 재정렬·동시 로그인·늦은 401·파괴 중 응답)은 mock 으로 순서를 고정해 확인 — 실제 스레드 경합 시험은 아님.
- WebView WS 의 TLS 오류는 JS `error` 이벤트에 원인이 없음(WHATWG) → 화면은 `request({op:'whoami'})` 로 원인을 다시 잰다(설계만).

## 6. iOS 인계 (같은 계약, 빌드·서명 환경 없음 → 코드 없음)

- 출처 `capacitor://localhost` 를 `Origin` 에 명시. `URLSession` + delegate 의 `willPerformHTTPRedirection` 에서 `completionHandler(nil)`(redirect 금지). 인증서 검사는 기본 그대로 — `didReceive challenge` 에서 신뢰를 바꾸지 않는다.
- **인증서 신뢰**: ATS 기본(예외 키 `NSAllowsArbitraryLoads` 등 없음). 사설 CA 관문을 쓸지·어떻게 믿게 할지는 배포처별 결정 — 미정.
- **비밀 보관**: 세션 덩어리를 Keychain `kSecClassGenericPassword`, `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`(기기 백업으로 옮겨지지 않게). Keychain 은 인증서 신뢰와 무관.
- 오류 분류: `NSURLErrorServerCertificate*`·`NSURLErrorSecureConnectionFailed` → `tls`, `CannotFindHost`·`CannotConnectToHost`·`TimedOut`·`NotConnectedToInternet` → `net`, 그 밖 `unknown`.
- 순수 로직(`gateOrigin`·사진 정규식·OPS·gen·상태 코드 매핑)은 `FhGateCoreTest` 의 같은 표를 XCTest 로 옮긴다. Mac·Xcode·서명 환경 확보 전에는 «iOS 준비됨»으로 표시하지 않는다.

# 최종 bundled B 연결 — 결정안 초안 2판 (2026-10-13, 설계만)

상태: **설계 초안(앱 Codex 방향검수 통과 733044e).** 서버·운영 변경 0, 실서버·에뮬 실행 0. 이 문서만으로 B 가 됐다고 하지 않는다. B1 Android 어댑터 초안·계약은 `mobile/docs/FHGATE-CONTRACT.md`.
소유: 서버 쪽(S1~S4) 구현 = UI mentor(앱 Codex 10-13 지정) · `mobile/**` 설계와 네이티브 경계 = 모바일 mentor. 구현 GO 는 앱 Codex 판정 뒤.
1판(3fc9dc3) 대비: 앱 Codex 방향검수 7건 반영 — 토큰을 JS 에 주지 않는 어댑터, 사진·내려받기 경로, 로그아웃·주소변경·만료 순서와 연결 세대, WS 표 결속, Origin 명시·redirect 금지·CSRF 단정 삭제, 네이티브 TLS 오류 분류, S1~S4 계약.

읽은 근거
- 관문: `sim/v2_gate.py`(2dfc0e9) — 쿠키 `fh2_s`·`fh2_dev` `HttpOnly; Secure; SameSite=Strict; Path=/`, `--ttl` 기본 12 h(메모리 세션), 로그인 동시 2·실패 제한, `/ws` `check_origin`=`same_origin`, 로그아웃·만료 때 그 세션 WS 4401, 허용 안 된 메시지 4403, 사진은 `/(api/media|media/photos/\d{8}/[\w.-]+\.jpg)` GET 만 로그인 뒤 중계. `phone_gate.py` `same_origin`·`Sessions`(읽기만).
- 화면(recovered UI, 판 미확인): 사진 `<img src={x.url}>`(x.url = `media/photos/…`), 목록 `fetch('api/media', {credentials:'same-origin'})`, CSV·JSON 은 이미 받은 자료로 JS 가 만들어 `saveBlob`(`<a download>` + blob URL), WS 는 `new URL('ws', location.href)`.
- 공식: Capacitor HTTP https://capacitorjs.com/docs/apis/http (JS 에 `HttpResponse.data`·`headers` 반환, `disableRedirects`) · WHATWG WebSockets https://websockets.spec.whatwg.org/ (생성자는 `url`·`protocols` 만, 헤더 못 붙임, `error` 이벤트에 원인 없음) · Capacitor 설정 https://capacitorjs.com/docs/config (`server.url` 은 production 용 아님) · Android 네트워크 보안 설정 https://developer.android.com/privacy-and-security/security-config.

## 1. 왜 A 를 최종으로 못 쓰나

bundled 화면 출처는 Android `https://localhost`, iOS `capacitor://localhost`. 지금 관문은 Strict 쿠키라 앱 출처 요청에 쿠키가 안 실리고, `same_origin` 이 Origin = `https://<관문 Host>` 만 받는다 → 로그인·쓰기·WS 전부 거부. **서버 변경 없이 B 불가.** 기존 브라우저 경로(쿠키·Strict·same_origin)는 그대로 두고 앱 전용 경로를 **따로** 둔다. `SameSite=None`·Origin 와일드카드·`null` 허용·SSL proceed 는 어느 경우에도 없다.

## 2. 결정안

### 2.1 토큰은 JS 로 넘기지 않는다 — 네이티브 어댑터(opaque)

표준 CapacitorHttp 로 로그인하면 응답 본문(토큰)이 JS `response.data` 로 그대로 온다 → «토큰은 네이티브에만»과 맞지 않는다. 그래서 **앱 안 로컬 플러그인 `FhGate`**(npm 의존 추가 없음, `mobile/**` 안 Java/Swift) 하나가 세션 토큰의 발급 수신·보관·사용·폐기를 전부 맡는다.

| 어댑터 호출(JS→네이티브) | JS 가 받는 것 | JS 가 못 받는 것 |
|---|---|---|
| `setGate(origin)` | 정규화된 origin 또는 거부 이유 | — |
| `login(user, pw, label)` | `{account, device6, exp}` | 세션 토큰·기기 id 원값 |
| `request(op, body?)` — op 은 고정 목록(`whoami`·`docs.get`·`docs.post`·`media.list`) | 응답 JSON·상태 코드 | Authorization 값 |
| `photo(path)` | 바이트(크기 상한 안) — §2.2 | — |
| `wsTicket()` | `{url, gen}` — 1회용 표가 든 WS 주소(≤30 s) | 세션 토큰 |
| `logout(reason)` | 즉시 `{ok:true, server:'pending'}`, 뒤에 `server` 결과 이벤트 | — |
| `saveFile({name, base64})` — 정본 `FHGATE-CONTRACT.md` §1 «저장»(B2 `d4e5002`, mime 은 확장자로) | `{saved, bytes, gen}` — close 뒤에만 | 저장 위치·URI·경로 |

- 세션 수명은 관문 TTL(12 h) 그대로. refresh·JWT 같은 새 구조는 넣지 않는다(1판의 «짧은 수명» 표현 삭제).
- 보관: 토큰은 어댑터 메모리 + 플랫폼 보안 저장소(Android Keystore 로 감싼 저장, iOS Keychain). JS 저장소·쿠키·로그·크래시 보고에 두지 않는다. 저장 방식은 구현 때 라이브러리 없이 플랫폼 API 로(추가 의존이 필요하면 그때 따로 판정).
- **한계(명시)**: 토큰을 숨겨도 WebView 안의 JS 가 오염되면(XSS) 그 JS 는 어댑터를 «호출»할 수 있다 — 앱이 켜져 있는 동안 정해진 op 범위의 인증 요청은 가능하다. 보안 저장소 설치만으로 XSS 를 막지 못한다. 줄이는 것: op 고정 목록·임의 URL/메서드 거부·관문 origin 고정·사진 경로 검사, 그리고 bundled 화면에 외부 스크립트 로드 0(CSP). 줄이는 것은 **장수명 세션 토큰이 JS 에 직접 노출되는 것**까지다. 1회용 WS 표는 JS 에 노출되고(≤30 s·1회), 오염된 JS 의 어댑터 호출은 막지 못하므로 재사용 위험은 남는다.

### 2.2 사진·보고서·CSV

| 대상 | 지금(A·브라우저) | B |
|---|---|---|
| 사진 목록 | `fetch('api/media')` + 쿠키 | `request('media.list')` |
| 사진 보기·다시 열기 | `<img src="media/photos/…">` — B 에서는 `https://localhost/media/…`(앱 번들)로 가서 안 뜨고, 관문 주소를 직접 넣어도 `<img>` 에는 bearer 를 못 붙인다 | `photo(path)` → 어댑터가 path 를 관문과 **같은 정규식** `^media/photos/\d{8}/[\w.-]+\.jpg$` 로 검사(외 거부·임의 URL 없음) → bearer GET → 크기 상한·`image/jpeg` 확인 → 바이트 → JS 가 Blob URL. 목록에서 빠지거나 화면을 떠날 때·로그아웃 때 `revokeObjectURL` |
| CSV·JSON 내려받기 | JS 가 이미 받은 자료로 Blob 생성 → `<a download>` | 자료 만드는 JS 는 재사용. 저장은 `saveFile` (Android 공유/저장 인텐트, iOS 공유 시트). WebView 의 blob `<a download>` 는 Capacitor 기본 Activity 에서 저장된다는 근거 없음 → 어댑터 경로를 기본으로, 파일 이름은 `[\w.-]` 만·길이 상한 |
| 실시간 영상 | 인증 WS 의 JPEG | 그대로 인증 WS(§2.4). 별도 사진 경로를 만들지 않는다 |

- 상한값(사진 1장 바이트·한 번에 여는 장수)은 구현 때 실측으로 정한다. 썸네일 다수를 브리지(base64)로 넘기는 비용은 미측정 — 느리면 썸네일 크기 축소를 서버 S1 에 추가 요청.

### 2.3 로그아웃·관문 주소 변경·인증 만료 — 같은 순서

1. 로컬 누름 즉시 버림 · 20 Hz 보내기 멈춤(서버 응답 안 기다림)
2. WS 가 열려 있으면 `{op:'hidden'}` 한 번(최선, 기다리지 않음)
3. WS 즉시 close
4. 어댑터: 연결 세대 `gen += 1` → 토큰·남은 표를 메모리·보안 저장소에서 폐기
5. 로그인 화면(주소 변경이면 주소 입력부터)
6. 로그아웃이면 폐기 전에 꺼내 둔 토큰으로 S4 를 백그라운드 1회. 실패·시간 초과면 «이 기기에서는 로그아웃됨 · 서버 세션 종료 확인 못 함(관문 TTL 또는 재시작 때 끝남)» 으로 표시 — 성공으로 표시하지 않는다

역할 분리: **움직임 안전**은 WS 끊김 → v2_link 의 조종권 해제·0·STOP 잠금(deadman·링크 해제)이 맡고, **세션 12 h TTL**은 인증 만료만 맡는다. 명령 0·STOP 은 물리 정지 보장이 아니다(A 실측 3.6 s·0.32 m 더 이동, 원인 미확정).

연결 세대: 어댑터는 모든 호출 결과에 시작 때의 `gen` 을 붙이고, 끝났을 때 `gen` 이 바뀌었으면 결과를 버린다(취소된 옛 login 응답의 토큰은 저장하지 않고 즉시 폐기, 옛 `wsTicket` 주소는 반환하지 않음). JS 도 `wsTicket().gen` 이 현재와 다르면 그 WS 를 열지 않고, 열린 뒤 바뀌면 닫는다. 401(만료) 수신도 위 1~5 와 같다.

### 2.4 WS 1회용 표

- 별도 엔드포인트 **`/api/app/ws`** — 브라우저 `/ws` 의 `check_origin` 을 넓히지 않는다. 메시지 거르기(`gate_msg`)·중계·4401/4403 규칙은 같은 코드를 재사용.
- 표 결속: (계정, 기기, 세션 토큰, 대상 관문 Host, 허용 앱 origin, 엔드포인트 `/api/app/ws`). 접속 때 원자적으로 꺼내 지움(1회), 발급 후 ≤30 s, 세션이 끝났거나 만료면 거부, 세션당·전체 보관 상한. 표가 든 질의 문자열은 접근 로그에 찍지 않는다(대안: `protocols` 인자로 전달 — 구현 때 둘 중 하나로 확정).
- 표 발급도 WS 접속도 조종 요청(take/resume)을 보내지 않는다. 연결은 늘 보기 전용으로 시작(UI 묶음3 계약).

### 2.5 Origin·쿠키/bearer 분리·redirect

- 네이티브 HTTP 가 Origin 을 자동으로 붙인다고 가정하지 않는다. 어댑터가 플랫폼별 정확한 값(Android `https://localhost`, iOS `capacitor://localhost`)을 명시하고, 서버 `/api/app/*` 는 그 두 값 정확 일치만 받는다. **Origin 은 신원이 아니다** — 신원은 bearer 만.
- 경로로 분리: `/api/app/*` 는 bearer 만 보고 쿠키는 무시, 기존 `/api/*`·`/ws` 는 쿠키만 보고 Authorization 은 무시. 브라우저 쿠키로 앱 엔드포인트를 대신 인증하지 않는다.
- 어댑터: HTTPS 와 설정된 `gateOrigin` 한 곳만, redirect 따라가지 않음(3xx 는 오류), 다른 host 로 Authorization 을 보내지 않는다.
- S2(앱 origin CORS)는 이번 기본 경로(네이티브 HTTP)에 필요 없다 → 미정 선택지로 뒤로 미룸. 1판의 «쿠키가 없으니 CSRF 경로가 없다» 단정은 삭제 — 앱 경로의 위조 요청 위험은 §2.1 의 한계(어댑터 호출 가능 범위)로 다룬다.

### 2.6 인증서·연결 오류

- B 의 주요 통신은 네이티브 HTTP(어댑터)와 WebView WS 라서, WebView 페이지 로드용 `GateSslClient` 만 고쳐서는 그 오류를 못 받는다.
- 어댑터 오류 분류(JS 에 원인 종류만): `tls`(Android `SSLHandshakeException`·`CertPathValidatorException`, iOS `NSURLErrorServerCertificate*` 계열) · `net`(이름 풀이·연결 거부·시간 초과) · `auth`(401) · `origin`(403) · `busy`(429) · `server`(5xx). WS 는 WHATWG 상 `error` 이벤트에 원인이 없다 → «연결 실패(원인 모름)» 으로 두고 어댑터 `request('whoami')` 한 번으로 원인을 다시 잰다.
- 어느 경우든 앱 안 연결 안내 화면(로그인·명령 차단). OS TLS 거부는 그대로, proceed·인증서 무시·사용자 CA 전체 허용 없음.
- CA: 개발은 A 와 같은 exact CA `debug-overrides`. 최종은 공인 인증서 관문 기본, 사설 CA 를 써야 하면 그 한 장을 release 설정에 넣는 것은 배포처별 결정. 네이티브 HTTP 는 Android 네트워크 보안 설정을 따른다. iOS 는 **인증서 신뢰**(ATS 전송 규칙 + 사설 CA 를 어떻게 믿게 할지 — 배포처별 결정)와 **비밀 보관**(Keychain = 세션 토큰 저장, 인증서 신뢰와 무관)을 따로 검증한다.
- `GateSslClient` 의 cancel 은 WebView 용으로 재사용, B 의 «관문 주소 비교» 분기·네이티브 TLS·iOS ATS 는 각각 재검증.

### 2.7 서버 주소

빌드에 굽지 않는다. 첫 실행 설정 화면 → `gateOrigin`(`scripts/gate-profile.mjs`) 과 같은 규칙(https·origin 하나·사용자정보/경로/와일드카드/localhost 거부)을 어댑터 `setGate` 가 네이티브에서 다시 검사. 바꾸면 §2.3 순서.

## 3. S1~S4 계약 초안 (서버 구현 = UI mentor, 상세 필드는 FHGATE-CONTRACT.md §3)

| | 요청 | 성공 | 실패 |
|---|---|---|---|
| **S1** 앱 로그인 + bearer 조회 | `POST /api/app/login` Origin=앱 정확값, `{user, pw, label?, device?}`(device = 이전에 받은 opaque 기기 값) | 200 `{token, device, account, exp}` — token·device 는 어댑터만 보관, JS 에는 `{account, device6, exp}` | 400 형식 · 401 계정/비번 · 403 Origin · 429 실패 제한/동시 로그인 |
| | `GET /api/app/whoami`·`GET·POST /api/app/docs`·`GET /api/app/media`·`GET /api/app/media/photos/<8자리>/<이름>.jpg`, `Authorization: Bearer` | 기존 `/api/*` 와 같은 본문. `docs.post` 는 기존 400·403·404·409(`cur` 포함)·500·503 상태와 본문을 그대로 화면에 넘기고 **재시도 없음** | 401 토큰 없음/만료/폐기 · 403 Origin · 502 v2_link 없음. 쓰기 작성자는 세션의 계정·기기로(기존 `X-FH-Actor` 와 같음) |
| **S2** (미정·뒤로) 앱 origin CORS | — | — | 이번 기본 경로엔 불필요 |
| **S3** WS 표 + 앱 WS | `POST /api/app/ws-ticket` bearer | 200 `{ticket, ttl_s≤30}` | 401 세션 끝남 · 429 보관 상한 |
| | `GET /api/app/ws?t=<ticket>`(WS) Origin=앱 정확값 | 열림 → 기존 Bridge 와 같은 중계·보기 전용 시작 | 표 없음/사용됨/만료/결속 불일치 → 4401 · Origin → 거부 · 허용 안 된 메시지 → 4403 · 세션 로그아웃/만료 → 4401 |
| **S4** 앱 로그아웃 | `POST /api/app/logout` bearer | 200 → 세션 끝 + 그 세션 앱 WS 4401 + 남은 표 폐기 | 401(이미 끝남) — 앱은 어느 응답이든 기기 쪽 폐기를 이미 마친 상태(§2.3) |

공통: 오래된 응답은 앱이 연결 세대로 버린다(§2.3). 기존 쿠키 경로·`same_origin`·`/ws` 는 손대지 않는다. 메모리 세션이라 관문 재시작이면 모든 앱 세션이 401 → §2.3.

## 4. A → B 재사용 / 다시 검증

| 항목 | A 에서 확인 | B |
|---|---|---|
| `gateOrigin` 주소 규칙 | selftest 3 통과·16 거부 | 규칙 재사용, 네이티브 `setGate` 재구현·재검증 |
| exact CA `debug-overrides`, cleartext·mixed 금지 | Android 에뮬 5회차 | WebView 쪽 재사용, 네이티브 HTTP·iOS ATS 는 새로 |
| `GateSslClient` cancel | 5회차 다른 CA PASS | WebView 용 재사용, 주소 비교 분기 수정·재검증. 네이티브 TLS 분류(§2.6)는 새로 |
| 로컬 오류 화면 | 끊김(-100)·다른 CA(-202) | 화면 안 상태로 다시 설계 |
| `Plugins.App` 신호·순서 | pause 가 hidden 보다 1965 ms 먼저(1회) | 재사용, bundled 에서 다시 측정 |
| 로그인·세션·WS·로그아웃·사진·내려받기 | 관문 쿠키 경로 | **전부 새로**(어댑터·표·세대·폐기·재시작·TTL·사진 검사·파일 저장) |
| iOS | 프로젝트만, IPA 0 | **전부 새로** — Mac 없음 → 빌드·서명 환경 확보가 먼저 |

## 5. 지금 하지 않는 것

B1(Android 로컬 어댑터 초안 + 순수 mock 시험 + 정적 빌드)만 진행. 하지 않는 것: npm 플러그인 추가, 서버 코드 수정, 실서버 호출, 에뮬·실기기·실시뮬 실행, 계정·인증서 설치·릴리스 키·스토어, CI 원격 기동. 서버 변경 연결·사용자 체험은 B1 코드 검수 + 격리 통합 뒤.

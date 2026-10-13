# 최종 bundled B 연결 — 결정안 초안 (2026-10-13, 설계만)

상태: **초안. 코드·서버·운영 변경 0, 실행 0.** 이 문서만으로 B 가 됐다고 하지 않는다. 서버 쪽 변경(아래 S1~S4)은 서버 담당·앱 Codex 검수 뒤에만.
근거로 읽은 것: `sim/v2_gate.py`(마지막 변경 커밋 2dfc0e9), `phone_gate.py` 의 `same_origin`·`Sessions`(읽기만), Capacitor 8.5.2 설치본, A 검증 1~5회차(`mobile/README.md`).

## 1. 왜 A 를 그대로 최종으로 못 쓰나

- Capacitor 공식 설정 문서: `server.url` 은 live reload·개발용이지 production 용이 아니다. 최종 앱은 화면을 앱 안(bundled)에 싣는다.
- bundled 화면의 출처는 Android `https://localhost`, iOS `capacitor://localhost` 다. 지금 관문은
  - 쿠키 `fh2_s`·`fh2_dev` = `HttpOnly; Secure; SameSite=Strict; Path=/` → 다른 출처(앱)에서 보낸 요청에는 실리지 않는다.
  - `same_origin`: Origin 이 정확히 `https://<Host>` 이고 Host 가 관문 주소 목록 안이어야 한다 → 앱 Origin 은 로그인·로그아웃·문서 쓰기·WS 모두 403/거부.
- 그래서 B 는 **서버 변경 없이는 불가능**하다. 아래 결정안의 조건: 기존 브라우저 경로(쿠키·Strict·same_origin)는 그대로 두고, 앱 전용 경로를 **따로** 더한다. 쿠키를 `SameSite=None` 으로 바꾸거나 Origin 와일드카드·`null` 허용은 하지 않는다.

## 2. 결정안 (경계별 한 줄 + 근거)

| 경계 | 결정안 | 근거·하지 않는 것 |
|---|---|---|
| 로그인 | 앱 전용 `POST /api/app/login`(S1) → 짧은 수명 **앱 세션 토큰**(bearer) 발급. 계정 확인·실패 제한(`RateLimit`)·기기 id 는 기존 것을 재사용 | 쿠키 경로를 넓히지 않는다. Origin 은 «앱 출처 정확히 두 개» 일 때만 받되, Origin 은 신원 근거가 아니다(같은 PC 의 다른 https://localhost 페이지도 보낼 수 있음) — 신원은 토큰으로만 |
| 세션 보관 | 토큰은 **네이티브 보안 저장소**(Android Keystore 로 감싼 저장, iOS Keychain)에만. JS `localStorage`·쿠키·로그에 두지 않는다 | 저장 플러그인 선택·버전 고정은 B 구현 때(지금 추가 0). 기기 분실 대비로 서버 TTL(지금 12 h, 메모리 세션 — 관문 재시작이면 전부 무효)을 그대로 따른다 |
| API 요청 | 화면 → 네이티브 → 관문으로 `Authorization: Bearer`. 브라우저 CORS 를 열지 않으려면 네이티브 HTTP(CapacitorHttp) 경유가 기본, CORS 를 열 경우는 정확한 두 출처·자격증명 없음만(S2) | 쿠키 자동 전송이 없으니 CSRF 경로가 생기지 않는다. 토큰이 JS 로 넘어오는 범위는 B 구현 검수에서 다시 정한다 |
| WS | WebView 의 WebSocket 은 헤더를 못 붙인다 → 토큰으로 **1회용 WS 표(ticket)** 를 받고(S3, 수명 ≤30 s·한 번 쓰면 폐기) `wss://관문/ws?t=…` 로 연결. 관문 `check_origin` 은 앱 두 출처를 정확히, 표 없으면 4401 | 표는 로그에 남기지 않는다(URL 질의가 접근 로그에 찍히지 않게 S3 에 명시). 조종 op 걸러내기·4401/4403 규칙은 지금 Bridge 그대로 |
| 인증서(CA) | 개발: A 와 같은 exact CA `debug-overrides`. 최종: **공인 인증서 관문**이 기본. 사설 CA 를 써야 하면 그 CA 한 장을 release `base-config` 에 넣는 것은 배포처별 결정(user CA 전체 허용·proceed·호스트 이름 검사 끄기는 어느 경우에도 없음) | `GateSslClient` 의 «모든 SSL cancel» 은 그대로. 단 B 에서는 `server.url` 이 없어 지금의 «관문 origin 이면 안내 화면» 분기가 동작하지 않는다 → 설정된 관문 주소와 비교하게 바꿔야 함(재검증 대상) |
| 서버 주소 | 빌드에 굽지 않는다. 첫 실행 설정 화면에서 입력(이후 QR 은 별도) → `gate-profile.mjs` 의 `gateOrigin` 과 같은 규칙(https·origin 하나·사용자정보/경로/와일드카드/localhost 거부)으로 검사, 일반 설정 저장소에 | 주소를 바꾸면 토큰·표를 즉시 폐기하고 보기 전용으로 |
| 앱 수명 | UI 묶음3 계약 그대로: `pause` 즉시 누름 폐기 + `hidden`, `resume`·재연결·첫 로드는 보기 전용. bundled 에서는 `@capacitor/core` 를 번들에 넣을 수 있어 `registerPlugin` 경로도 쓸 수 있다(A 와 다름) | 재생성 뒤 리스너는 Capacitor 가 로드마다 지움(`onPageStarted → bridge.reset()`) → 로드마다 등록. 조종 중 숨김 → 해제·래치 실측은 아직 없음 |
| 로그아웃 | `POST /api/app/logout`(S4, bearer) → 서버 세션 끝 + 그 세션 WS 4401. 앱은 **응답과 무관하게** 저장소 토큰·남은 표를 지우고 로그인 화면으로 | 네트워크 실패여도 기기 쪽 폐기는 한다. 서버 쪽 세션은 TTL·관문 재시작으로 끝남을 문서에 적는다 |

필요한 서버 변경(서버 담당 소유, 이 문서는 요청 초안): **S1** 앱 로그인(토큰 발급) · **S2** (선택) 앱 두 출처 정확 일치 CORS · **S3** WS 표 발급 + `/ws` 의 표 확인 + 앱 두 출처 `check_origin` · **S4** 앱 로그아웃. 기존 쿠키 경로·`same_origin` 은 손대지 않는다.

## 3. A → B 재사용 / 다시 검증

| 항목 | A 에서 확인한 것 | B 에서 |
|---|---|---|
| `gateOrigin` 주소 규칙 | selftest 3 통과·16 거부 | 재사용(설정 화면 입력 검사) — 재검증은 입력 경로만 |
| exact CA `debug-overrides`, cleartext·mixed content 금지 | Android 에뮬 5회차 | 재사용 — release 신뢰 방식은 새로 결정·검증 |
| `GateSslClient` cancel | 5회차 B(다른 CA) PASS | cancel 은 재사용, 안내 분기(관문 주소 비교)는 수정·재검증 |
| 로컬 오류 화면 | 끊김(-100)·다른 CA(-202) 에서 표시 | bundled 에서는 화면이 앱 안이라 오류는 화면 안 상태로 — 다시 설계 |
| `Plugins.App` 신호·순서 | 원격 페이지에서 pause/appStateChange 수신, pause 가 hidden 보다 1965 ms 먼저(1회) | 재사용하되 bundled 페이지에서 다시 측정 |
| 로그인·세션·WS·로그아웃 | 관문 쿠키 경로(A) | **전부 새로 검증**(토큰·표·폐기·관문 재시작·TTL) |
| iOS | 프로젝트만 | **전부 새로**: `capacitor://localhost` 출처, ATS, Keychain, CA 신뢰. Mac 없음 → 빌드·서명 환경 확보가 먼저 |

## 4. 지금 하지 않는 것

새 플러그인 추가, 서버 코드 수정, 에뮬·실기기·실시뮬 실행, 릴리스 키·스토어, CI 원격 기동. B 착수는 UI 조종 이식(묶음3)과 서버 담당의 S1~S4 합의 뒤.

# bundled B 통합 시험안 — 1기동 1회 (2026-10-13, **실행 0 · 계획만**)

목적: B1 네이티브 어댑터(`404da91`, 계약 `FHGATE-CONTRACT.md` v0.1)와 UI 전송 어댑터를 **한 번의 앱 기동·설치**로 처음부터 끝까지 묶어 본다 — 앱 출처 Origin · 로그인 · Keystore 복원 · 1회용 WS 표 · take→잡고 있기→HOME 해제 · 로그아웃.
A(원격 관문 페이지, 쿠키) 의 실행 원물(`runs/mobile-a-gate-*`)과 **섞지 않는다**: 출력 폴더 `runs/mobile-b-bundled-<날짜>-<N>`, `results.json` 의 `scope = "bundled-b"`. A HOME 실패·성공 근거를 B 판정에 쓰지 않고, B 결과로 A 를 고치지 않는다.

## 0. 고정할 판(실행 전 확정)

| 항목 | 값 | 상태 |
|---|---|---|
| 모바일 | `less82/app-contract-storage` B1 `404da91` 이상(현재 B2 `d4e5002` 포함 — 저장은 이번 시험 범위 밖) | 고정 |
| UI | `aa320c5`(전송 어댑터) + Codex 보완 3건 판. 후보 `aeb07dd`(«B 어댑터 보완(검수 3건)») | **Codex 가 보완 해시 확인 뒤 고정** — 그 전에는 실행 안 함 |
| 관문·링크 | UI 판의 `sim/v2_gate.py`(`--spa` 아님 — bundled 는 화면을 앱이 갖는다)·`sim/app_auth.py`·`sim/v2_link.py` 를 `git archive` 로 임시 폴더에 | UI 판과 함께 |
| 화면 번들 | 같은 UI 판에서 `npm run build` → `node scripts/sync-web.mjs <dist>`(`FH_UI_REV`) → `www/SOURCE.json`, APK 안 번들 sha 기록 | A pause 와 같은 방식 |

## 1. 실행 전 전제(하나라도 아니면 실행 안 함)

- **P1 fixture CA 신뢰 — 지금 없음(구현 필요).** bundled `debug` 빌드는 `networkSecurityConfig` 가 없어 시스템 신뢰만 → 네이티브 `HttpsURLConnection` 이 fixture 관문에 `tls` 로 끝난다. 안: `gate` 와 같은 방식의 빌드 종류 `fixture`(initWith debug, 별도 앱 id `.fixture`, `server.url` 없음) + `debug-overrides` 에 그 실행의 fixture CA 한 장(`@raw/fh_gate_ca`, 생성물·git 제외). release·main 은 시스템 신뢰 그대로. 사용자 설치 CA 전체 허용·SSL proceed 없음.
- **P2 포트·도메인 인계**: `18453`(관문)·`18790`(링크)·`9339`·`emulator-5554`·ROS domain `89`(LOCALHOST) 를 UI mentor 와 다시 확인(UI 는 8791·5181·domain 88 만). `listening()` 사전 검사가 하나라도 걸리면 중단.
- **P3 자원**: A pause 6회차와 같은 설치 전 부하 관문 그대로(완화 없음). 걸리면 그 회차는 «설치 전 전제 실패»로 끝, 바로 재시도 없음.
- **P4 몸 상태는 mock**: `v2_link` 의 시뮬 상태. `applied`·`latch` 는 서버 계산값이지 물리 정지가 아니다.

## 2. 한 번의 기동 흐름(앱 설치 1회, 단계 실패 = 그 자리 종료·뒤 단계 «미실행»)

| # | 동작 | PASS 조건(원물) |
|---|---|---|
| B0 | 설치 → 첫 기동(관문 주소 없음) | CDP 출처 `https://localhost`, `#/MLogin`, 첫 안내가 «관문 주소를 먼저 정하세요»(UI 보완 #2) · 서버 요청 0 |
| B1 | 로그인 화면 «바꾸기» → `https://127.0.0.1:18453`(adb reverse) | `FhGate.state().origin` = 그 값, `loggedIn=false` |
| B2 | fixture 계정 로그인(`#mid`/`#mpw`) | 관문 로그 `POST /api/app/login` 200 — `app_auth.ORIGINS` 정확 일치라 **성공 자체가 Origin `https://localhost` 근거**. JS 쪽 어디에도 토큰 없음(CDP 로 `localStorage`·`sessionStorage`·`document.cookie`·전역 검색 0) |
| B3 | `am force-stop` → 다시 기동 | 재로그인 없이 `state().loggedIn=true`·`stored=true`, `request('whoami')` 200 → **Keystore 복원 근거** |
| B4 | `#/MDrive` → `wsTicket` → WS | 관문 로그 `/api/app/ws` 101(질의 표는 로그에서 지워짐), 같은 표 재사용 0, status 행 수신 |
| B5 | take → 스틱 잡고 있기(CDP touch) | `holder`=이 기기, `applied` 비영(A 와 같은 `row_ok`·`nonzero`) |
| B6 | HOME | logcat `App paused` + 서버 `released`(holder None·0·latch True) · 위반 0 · 간격 ≤ 1 s. 서버 쪽 해제 원인은 INFO |
| B7 | 앱으로 돌아옴 | 읽기 전용(자동 take·resume 0) |
| B8 | 로그아웃 | resolve `ok=true`, `logoutResult.server='ok'`, 다시 기동하면 `#/MLogin`(보관본 없음) |
| 끝 | 관문·링크 INT 종료, `adb reverse --remove`, 에뮬 종료 | 남은 프로세스 0(강제 kill 없음) |

- 판정은 A 와 같은 술어(누락·NaN 을 0 으로 치지 않음). CDP 도구 오류는 `TOOL_ERROR` — 앱 PASS/FAIL 과 섞지 않는다.
- `manifest`: 모바일·UI 판, APK sha, `www/SOURCE.json` sha, 관문 명령 전문, 포트·도메인, CA 지문(키는 남기지 않음).
- 재시도 사슬 없음. 첫 FAIL·도구 오류가 그 회차의 결과.

## 3. 이 시험으로 주장하지 않는 것

실시간성 · 물리 정지(STOP 명령 0 ≠ 정지, mock `body_still` 은 근거 아님) · WebView WS TLS 오류 원인(WHATWG `error` 에 원인 없음) · B2 저장 창(별도) · 실기기·iOS(Mac 없음) · 운영 관문·실계정 · 네이티브 pause 의 A 쪽 근거.

## 4. 남은 일(순서)

1. Codex 가 UI 보완 해시 확인 → 0절 UI 판 고정.
2. P1 `fixture` 빌드 종류 구현(`mobile/**`, 순수 빌드·lint) → 좁은 검수.
3. 러너: `gate-emulator-e2e.py` 에 `FH_E2E_SCOPE=bundled` 하나 추가(새 파일 없음, A 흐름 함수 재사용) → mock 정적 점검.
4. P2 인계 확인 뒤 1회 실행(승인 범위는 Codex 판정에 따름).

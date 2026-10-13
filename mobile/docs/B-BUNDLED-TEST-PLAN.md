# bundled B 통합 시험안 — 1기동 1회 (2026-10-13, 1회차 B4 에서 멈춤 → 수정 → 2회차 미완료, 2-1절)

목적: B1 네이티브 어댑터(`404da91`, 계약 `FHGATE-CONTRACT.md` v0.1)와 UI 전송 어댑터를 **한 번의 앱 기동·설치**로 처음부터 끝까지 묶어 본다 — 앱 출처 Origin · 로그인 · Keystore 복원 · 1회용 WS 표 · take→잡고 있기→HOME 해제 · 로그아웃.
A(원격 관문 페이지, 쿠키) 의 실행 원물(`runs/mobile-a-gate-*`)과 **섞지 않는다**: 출력 폴더 `runs/mobile-b-bundled-<날짜>-<N>`, `results.json` 의 `scope = "bundled-b"`. A HOME 실패·성공 근거를 B 판정에 쓰지 않고, B 결과로 A 를 고치지 않는다.

## 0. 고정할 판(실행 전 확정)

| 항목 | 값 | 상태 |
|---|---|---|
| 모바일 | `less82/app-contract-storage` B1 `404da91` 이상(현재 B2 `d4e5002` 포함 — 저장은 이번 시험 범위 밖) | 고정 |
| UI | **`28392b0`**(B1 최종 — aa320c5→aeb07dd→28392b0, 앱 Codex 읽기 검수 통과). B2 저장 UI `51d912f` 는 **제외** | 고정(10-13) |
| 관문·링크 | UI 판의 `sim/v2_gate.py`(`--spa` 아님 — bundled 는 화면을 앱이 갖는다)·`sim/app_auth.py`·`sim/v2_link.py` 를 `git archive` 로 임시 폴더에 | UI 판과 함께 |
| 화면 번들 | 같은 UI 판에서 `npm run build` → `node scripts/sync-web.mjs <dist>`(`FH_UI_REV`) → `www/SOURCE.json`, APK 안 번들 sha 기록 | A pause 와 같은 방식 |

## 1. 실행 전 전제(하나라도 아니면 실행 안 함)

- **P1 fixture CA 신뢰 — 구현됨(코드·정적 빌드만).** bundled `debug` 빌드는 `networkSecurityConfig` 가 없어 시스템 신뢰만이라, 빌드 종류 `fixture`(initWith debug, 앱 id `org.footholdproject.app.fixture`, `server.url` 없음 — main 설정 그대로) + `debug-overrides` 에 그 실행의 fixture CA 한 장(`@raw/fh_fixture_ca`, `node scripts/gate-profile.mjs --fixture` 가 생성, git 제외 — CA 없으면 fixture 빌드는 실패). release·main·debug 불변, 사용자 설치 CA 전체 허용·SSL proceed 없음. 출처 확인 `runs/mobile-b-fixture-check-20261013-3`(UI 28392b0 번들, 16항목 PASS: 앱 id·NSC·raw 자원 = 생성 CA 한 장·config server.url 없음·debug 와 config 동일·SOURCE.json = 로컬·파일 141개 sha 일치·debug APK 에 fixture 자원 없음). `-1` 은 NSC 주석의 `--` 로 빌드 실패, `-2` 는 검사 쪽 결함(debuggable 기대값)으로 FAIL — 둘 다 보존.
- **P2 포트·도메인 인계**: `18453`(관문)·`18790`(링크)·`9339`·`emulator-5554`·ROS domain `89`(LOCALHOST) 를 UI mentor 와 다시 확인(UI 는 8791·5181·domain 88 만). `listening()` 사전 검사가 하나라도 걸리면 중단. **에뮬 소유**(1회 뒤 추가): 시작 전 `adb devices` 빈 목록·`qemu-system` 프로세스 0·5554/5555 비어 있음, 기동 뒤 5554 를 연 pid 가 이 러너가 띄운 에뮬(또는 그 자식)·`ANDROID_AVD_HOME` = 이 회차 임시 폴더·adb 기기 = `emulator-5554` 하나 — 아니면 중단(남의 에뮬·앱에 설치·force-stop 안 함).
- **P3 자원**: A pause 6회차와 같은 설치 전 부하 관문 그대로(완화 없음). 걸리면 그 회차는 «설치 전 전제 실패»로 끝, 바로 재시도 없음.
- **P4 몸 상태는 mock**: `v2_link` 의 시뮬 상태. `applied`·`latch` 는 서버 계산값이지 물리 정지가 아니다.

## 2. 한 번의 기동 흐름(앱 설치 1회, 단계 실패 = 그 자리 종료·뒤 단계 «미실행»)

| # | 동작 | PASS 조건(원물) |
|---|---|---|
| B0 | 설치 → 첫 기동(관문 주소 없음) | CDP 출처 `https://localhost`, `#/MLogin`, 첫 안내가 «관문 주소를 먼저 정하세요»(UI 보완 #2) · 서버 요청 0 |
| B1 | 로그인 화면 «바꾸기» → `https://127.0.0.1:18453`(adb reverse) | `FhGate.state().origin` = 그 값, `loggedIn=false` |
| B2 | fixture 계정 로그인(`#mid`/`#mpw`) | 관문 로그 `POST /api/app/login` 200. **Origin 근거의 범위**: 관문이 `app_auth.ORIGINS` 정확 일치만 받는다는 설정(고정 판 sha) + 로그인 성공 — 보낸 헤더 원값을 패킷으로 직접 읽은 근거는 아니다. JS 쪽 어디에도 토큰 없음(CDP 로 `localStorage`·`sessionStorage`·`document.cookie`·전역 검색 0) |
| B3 | `am force-stop` → 다시 기동 | 재로그인 없이 `state().loggedIn=true`·`stored=true`, `request('whoami')` 200 → **Keystore 복원의 정상 경로만**(키 손상·복호 실패·실기기는 이 시험 밖) |
| B4 | `#/MDrive` → `wsTicket` → WS | **B3 재시작 뒤 구간의** 관문 접근 로그 `200 POST /api/app/ws-ticket` ≥ 1·`101 GET /api/app/ws` ≥ 1·표 수 ≥ 101 수, `거부(`·4xx/5xx ws 0(같은 표 재사용은 101 뒤 «거부(로그인 없음)»+4401 — 루프백 반례로 확인), `연결 e2e`, 로그 어디에도 `?t=` 없음. 접근 로그는 러너 래퍼(logging INFO + runpy, sim 무수정)로 켬. 앱이 받은 status 는 직접 안 읽음 — 앱 WS 동작은 B5 take 로 |
| B5 | take → 스틱 잡고 있기(CDP touch) | `holder`=이 기기, `applied` 비영(A 와 같은 `row_ok`·`nonzero`) |
| B6 | HOME | **대체 관측(사전 명시)**: `android.loggingBehavior=none` 으로 Capacitor `App paused` 로그가 없어짐 → ① OS: events 버퍼 `wm_on_paused_called` 의 이 앱 Activity 건수 증가(구성요소 이름뿐) ② 페이지: B4 PROBE 가 붙인 `Plugins.App` pause·`appStateChange(false)` 를 복귀 뒤 `window.__fh` 에서 읽음(콘솔 안 씀, 페이지가 다시 읽히면 FAIL — 다른 근거로 대신 안 함). + 서버 `released`(holder None·0·latch True) · 위반 0 · 간격 ≤ 1 s. 서버 쪽 해제 원인은 INFO. `wm_on_paused_called` 가 이 이미지(android-34 google_apis)에서 찍히는지는 미실측 |
| B7 | 앱으로 돌아옴 | 읽기 전용(자동 take·resume 0) |
| B8 | 로그아웃 | resolve `ok=true`, `logoutResult.server='ok'`, 관문 `200 POST /api/app/logout`, 다시 기동하면 `#/MLogin`(보관본 없음). **네이티브 `logout` 직접 호출 근거 — 화면 버튼 경로 통과 아님** |
| 끝 | 관문·링크 INT 종료, `adb reverse --remove`, 에뮬 종료 | 남은 프로세스 0(강제 kill 없음) |

- 판정은 A 와 같은 술어(누락·NaN 을 0 으로 치지 않음). CDP 도구 오류는 `TOOL_ERROR` — 앱 PASS/FAIL 과 섞지 않는다.
- `manifest`: 모바일·UI 판, APK sha, `www/SOURCE.json` sha, 관문 명령 전문, 포트·도메인, CA 지문(키는 남기지 않음).
- 재시도 사슬 없음. 첫 FAIL·도구 오류가 그 회차의 결과.

## 2-1. 1회차 결과와 고친 것 (`runs/mobile-b-bundled-20261013-1`, UI 28392b0 + mobile 4c43dcd)

- B0~B3 PASS(번들 로드·네이티브 로그인·정상 Keystore 복원). **B4 첫 비PASS → B5~B8 미실행.** A 원물과 섞지 않음.
- B4: 러너 판정 결함 — 고정 판 `v2_gate` 의 접근 로그(`access_log.info`)가 logging 미설정으로 안 나와 `200 POST …` 줄이 없음. 표 발급·재사용 0 미증명이라 FAIL 유지.
- 결과 폴더 비밀번호 검사 FAIL: Capacitor 기본 `loggingBehavior=debug` 가 debug 계열 빌드에서 `FhGate.login` 인자(pw 포함)를 `V/Capacitor` 로 찍음. 회차 난수 fixture 값, 원본 `logcat.txt` 0600 보존, 검사용 정제본 `logcat.redacted.txt`(+NOTE) 따로. → `capacitor.config.json` `android.loggingBehavior='none'`(최상위 아님 — iOS 는 안 건드림·미빌드). debug·fixture·gate APK 최종 설정 대조 `runs/mobile-b-logging-check-20261013-1` ALL PASS.
- 영향: A(gate 빌드) 쪽 «App paused» 판정도 다음 실행부터 성립 안 함 — A 재실행 계획 없음, 다시 돌리면 B6 과 같은 대체 관측으로 바꿔야 함. 이 수정 전 빌드 APK 는 실계정에 쓰지 않는다.

## 3. 이 시험으로 주장하지 않는 것

실시간성 · 물리 정지(STOP 명령 0 ≠ 정지, mock `body_still` 은 근거 아님) · WebView WS TLS 오류 원인(WHATWG `error` 에 원인 없음) · B2 저장 창(별도) · 실기기·iOS(Mac 없음) · 운영 관문·실계정 · 네이티브 pause 의 A 쪽 근거.

## 4. 남은 일(순서)

1. ~~UI 판 고정~~ 28392b0(10-13). 2. ~~P1 fixture 빌드 종류~~ 구현·출처 확인 → 좁은 검수 대기.
3. ~~러너~~ `gate-emulator-e2e.py` 에 `FH_E2E_SCOPE=bundled`(B0~B8, 필수 27항목, 빌드 뒤 APK 출처 확인·생성 CA 삭제). 정적 점검: 필수 이름 27개 ↔ 코드 need/check 일치, `apk_provenance` 양성 1·음성 2(다른 CA·다른 UI 판). 실행 0. 로그아웃은 네이티브 직접 호출(화면 버튼 경로 아님), 옛 손가락은 이 범위 밖.
4. ~~1회 실행~~ 10-13 B4 에서 멈춤(2-1절). 5. 관문 로그·에뮬 소유·loggingBehavior·B6 대체 관측 수정 → 2회차 `runs/mobile-b-bundled-20261013-2` **INCOMPLETE**(35 PASS·3 FAIL): B0~B5·HOME 서버 해제 0.34 s PASS, HOME OS 신호(`wm_on_paused_called`) 빈 결과 FAIL(원인 미확인), 다음 단계에서 러너가 응답 없이 멈춰 INT 정리 — B7·B8 미실행. 6. 러너 CDP 연결·명령 20 s·시나리오 900 s 상한(`c2ecab3`, 가짜 CDP 반례 6건 PASS·에뮬 0). 새 회차 여부는 Codex 판단.

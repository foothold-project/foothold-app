# mobile — Android/iOS 외피 (Capacitor 8)

`ui/dist`(React 번들)를 **그대로** 실어 앱으로 감싼다. 화면을 다시 만들지 않는다. 화면은 UI 담당, 이 폴더는 외피·빌드·연결 설계만 맡는다.

## 상태 (2026-10-14)

**설치용 개발 APK(10-14)**: `out/foothold-android-dev-20261014.apk`(git 제외, sha256 `263b1bbe2fdb…c3550`) — 앱 id `org.footholdproject.app.dev`, UI `75c0611`, 운영 관문 공개 CA 한 장 신뢰, 로그 끔. 빌드·APK 구조 대조만(실제 휴대폰 0). **로그인은 `/api/app/*` 가 있는 관문에서만**(운영 체크아웃 83b25ca 엔 없음 · 10-14 01:00 UI 75c0611 사본 관문이 8453 에 떠 있음, 실폰 미검증) — 설치·미확인·연결 조건은 `docs/INSTALL-DEV.md`.

| 구분 | 내용 |
|---|---|
| **만든 것** | `package.json`(버전 고정) · `capacitor.config.json` · `scripts/sync-web.mjs`(ui/dist → www, 파일별 sha256 을 `SOURCE.json` 에) · `scripts/make-icons.py`(브랜드 공식 래스터 → 앱 아이콘) · `android/`·`ios/` 프로젝트(`cap add` 생성물 + appId·아이콘만 변경) |
| **이 PC 에서 확인** | ① **기본 bundled 외피**(server.url 없음, 서버 연결 없음·보기 전용): 86ef8d4 빌드 + Android 14 에뮬레이터(API 34)에서 설치·실행. 화면 캡처 `emulator-api34-first.png` 는 블루투스 시스템 대화상자가 가린 **부분 증거**. appId·아이콘 뒤는 빌드만. ② **A 개발 연결**(관문 주소 로드, gate 빌드 타입): fixture 관문·가짜 상태로 에뮬레이터에서 로그인·읽기 화면·WS·로그아웃·끊김 안내(4회차) + **다른 CA → 거부·로컬 안내 화면**(5회차 PASS). 이것은 **읽기·연결 검증**이지 조종 검증이 아니다 |
| **확인 안 함** | 실제 휴대폰 · **조종 중 숨김(네이티브 pause → 해제·래치)** · 화면 재생성 뒤 리스너 재등록 · 런처 아이콘 모양 · 릴리스 서명 · bundled B 연결 끝까지(에뮬 2회차 `runs/mobile-b-bundled-20261013-2` **미완료** — B0~B5·HOME 서버 해제 PASS, HOME OS 신호 FAIL, 복귀·로그아웃 미실행. 시험안 `docs/B-BUNDLED-TEST-PLAN.md`) · **iOS: 지금 Mac 이 없다 → 프로젝트 생성만, IPA 0.** 빌드·서명 환경 확보가 먼저다. iPhone Safari 로 관문 웹에 접속하는 것은 UI 팀의 웹 경로 확인이지 iOS 네이티브 앱의 근거가 아니다 |

### APK 별 판 (전부 debug 서명·git 무시, `runs/` 아래 — 10-14 dev 판만 `out/`)

| APK (sha256 앞 12자) | 빌드 | 외피 판 | 앱 안 화면(www) | 실제로 보이는 화면·서버 연결 | 검증 환경 |
|---|---|---|---|---|---|
| `mobile-shell-20261013/app-debug-86ef8d4.apk` (`b96841160f17`) | debug | 86ef8d4 | React `feature/react-platform-oh` e618139(브랜드 적용 전) | 앱 안 React 번들, 서버 없음 | 에뮬 API 34 설치·실행(캡처는 부분 증거) |
| `mobile-icon-appid-20261013/app-debug-icon-appid.apk` (`3a821941de4c`) | debug | 96b600f 와 같은 소스(커밋 전 빌드) | e618139 | 같음 | 빌드만 |
| `mobile-a-gate-e2e-20261013/app-gate.apk` (`59e4bd2dd42d`) | gate | 1512a93 와 같은 외피 소스(커밋 전 빌드) | recovered UI(판 미확인: 8022969 + 미커밋) — **A 에서는 안 쓰임** | **관문의 옛 웹 화면(`web/`, live.js) 원격 로드**, fixture 관문 127.0.0.1:18453 | 1회차 설치 시한 초과 FAIL |
| `mobile-a-gate-e2e-20261013-3/app-gate.apk` (`8f771bfd4fc0`) | gate | 같음 | 같음 | 같음 | 3회차 FAIL(재생성으로 도구 끊김) |
| `mobile-a-gate-e2e-20261013-4/app-gate.apk` (`576bc9fc6444`) | gate | 1512a93(=5d29bd3, 외피 변경 없음) | 같음 | 같음 | 4회차 FAIL(다른 CA 단계 도구 예외) |
| `mobile-a-gate-ssl-20261013-5/app-gate.apk` (`8a026b536769`) | gate | 3885275(`GateSslClient`) | 같음 | 같음 | 5회차 PASS(A 로그인·읽기 → 다른 CA 거부·안내) |
| `out/foothold-android-dev-20261014.apk` (`263b1bbe2fdb`) | dev | c2ecab3 + dev 빌드 타입 커밋 | UI 75c0611(B2·주소 저장 포함) | 앱 안 React 번들, 관문 주소는 사용자가 입력 · 운영 공개 CA 한 장 · `loggingBehavior=none` | 빌드·구조 대조만(`runs/mobile-dev-apk-20261014-1`) |

- 10-13 이전 빌드(위 표의 dev 판 위 행 전부)는 Capacitor 로그가 켜져 있어 로그인 인자가 기기 로그에 찍힌다 — 실계정에 쓰지 않는다. dev 판은 끔(구조 대조로 확인, 실제 휴대폰 미확인).
- 기본 bundled 번들은 아직 e618139(브랜드 전)다. 최신 React 번들 + 네이티브 lifecycle 이 합의되면 다시 빌드한다.
- A 빌드 안의 www(recovered UI)는 `server.url` 때문에 화면에 쓰이지 않는다. A 에서 보이는 것은 관문이 내주는 **옛 웹 화면**(fixture 관문이 이 체크아웃의 `web/` 을 서빙, 마지막 변경 커밋 2dfc0e9)이다.
- 화면이 PC 폭으로 배치되는 것은 UI 쪽 범위다.

## 버전과 근거

| 항목 | 값 | 근거 |
|---|---|---|
| Capacitor | 8.5.2 (core·cli·android·ios) | npm `latest` 는 8.5.3(10-07 배포, 6일 됨). 그래서 한 달 된 8.5.2 로 고정. cli 의 `engines.node >=22` |
| Node | 22 이상 | 시스템 node 18 은 쓰지 않는다. 사용자 폴더의 node 22 를 쓴다(전역 업데이트 없음) |
| JDK | 21 | Capacitor android `JavaVersion.VERSION_21`. 시스템 openjdk 21.0.12 |
| Android | compileSdk 36 · targetSdk 36 · minSdk 24 · AGP 8.13.0 · Gradle 8.14.3 | `android/variables.gradle`·`build.gradle`·wrapper(생성물 그대로) |
| iOS | 최소 OS 15.0 · SPM(`CapApp-SPM`, CocoaPods 없음) · bundle id `org.footholdproject.app`(임시) | `ios/App/App.xcodeproj`. 빌드 도구는 **Xcode 26.0 이상**(공식 문서 capacitorjs.com/docs/ios 「Xcode 26.0+ is required」, 10-13 확인) — 최소 OS 와 다른 값 |
| @capacitor/app | 8.1.1 | 앱 배경·복귀(`pause`·`resume`) 신호. 8.1.2 는 10-02 배포라 한 달 된 8.1.1 로 고정 |

React 쪽(Vite 5)은 지금처럼 node 18 로 빌드해도 된다. 외피만 node 22 가 필요하다.

## 빌드 (Linux, sudo 없이)

```
# 1) UI 번들 (ui 폴더에서, UI 담당 절차 그대로)
cd ui && npm ci && npm run build

# 2) 외피 (mobile 폴더에서)
export PATH=~/.local/opt/node-v22.23.3-linux-x64/bin:$PATH
export JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 ANDROID_HOME=~/Android/Sdk
cd mobile && npm ci
FH_UI_DIST=<UI 체크아웃>/ui/dist npm run apk:debug     # ui/dist → www → cap sync android → gradlew assembleDebug
# 결과: android/app/build/outputs/apk/debug/app-debug.apk (debug 키 서명)
```

- UI 번들 정본은 UI 담당 체크아웃(`app-ui-react-recovered`)의 `ui/dist` 다. 이 모바일 체크아웃의 `ui/` 는 옛 판이라 쓰지 않는다.
- `www/SOURCE.json` 의 `ui_rev` 는 그 번들의 판이다. `FH_UI_REV` 로 정확히 주거나, 주지 않으면 dist 가 든 체크아웃에서 자동 확인한다. 모바일 자기 체크아웃·ui 미커밋 변경·HEAD 보다 오래된 dist 이면 «미확인»으로 남기고 이유를 `ui_rev_from` 에 쓴다. 모바일 HEAD 를 UI 판으로 적지 않는다.
- 소스맵(`*.map`)은 빼고, 로컬 경로는 APK 에 넣지 않는다.
- 처음 빌드하면 Gradle 8.14.3 을 내려받는다. AGP 가 Build-Tools 35 를 `~/Android/Sdk` 에 자동으로 설치한다(사용자 폴더, 라이선스는 이미 동의된 상태).
- `www/`·`node_modules/`·`android/app/src/main/assets/public` 은 생성물이라 git 에서 제외한다.

## iOS — Mac 인계

1. Mac 에 **Xcode 26.0 이상**과 Node 22 를 준비한다(앱 최소 OS 는 iOS 15 — 별개 값). 위 1)과 같이 UI 번들을 만든다.
2. `cd mobile && npm ci && node scripts/sync-web.mjs && npx cap sync ios && npx cap open ios`
3. Xcode 에서 App 타깃 → Signing & Capabilities 로 가서 Team 을 고른다. **현민님 Apple 계정 입력이 필요하다.** 프로젝트는 자동 서명(`CODE_SIGN_STYLE = Automatic`)이고 Team 은 비어 있다.
4. 시뮬레이터에서 실행해 본 뒤 실기기에서 실행한다. Archive·IPA 는 서명이 끝난 뒤에 만든다. 이 Linux 에서는 iOS 를 하나도 빌드하거나 실행하지 않았다.

## 서버 연결 — A 는 개발·체험용, 최종 번들 B 는 별도 설계

앱 WebView 의 출처는 Android `https://localhost`, iOS `capacitor://localhost` 다. 관문(v2_gate)은 로그인 세션과 **같은 출처(Origin) 검사**로 쓰기·WS 를 막는다. 그래서 번들을 그대로 실은 기본 빌드에서 `/api/*`·`/ws` 요청은 관문에 닿지 않는다(에뮬레이터 로그에서 `https://localhost/api/docs` 로 나감).

| 방식 | 하는 일 | 쓰임 |
|---|---|---|
| **A. 관문 주소 로드** | `server.url` 을 관문 HTTPS origin 으로 둔다. WebView 가 관문의 로그인·화면을 그대로 연다. 같은 출처·세션 쿠키·Origin 검사를 그대로 쓴다 | **개발·체험 전용.** Capacitor 공식 설정 문서(capacitorjs.com/docs/config)는 `server.url`·`allowNavigation` 을 live reload·개발용으로 두고 production 용이 아니라고 한다. 원격 `server.url` 에 기대는 배포판은 만들지 않는다 |
| **B. 번들 + 분리 어댑터** | 번들은 앱 안에, `/api`·`/ws` 만 관문 절대주소로 | **최종 패키지 번들은 별도 설계.** 관문 Origin 허용 목록·교차 출처 세션이 걸려 **서버 신뢰 경계를 바꾸는 일**이다. 관문 검사 설계부터 다시 검수한 뒤에만 |

A·B 모두 같은 출처·세션·CA 검사를 풀지 않는다. 앱이라는 이유로 예외를 만들지 않는다.

B 결정안 초안(설계만, 서버 변경 요청 S1~S4 포함): `docs/B-BUNDLED-DESIGN.md`. 이 초안만으로 B 완료라고 하지 않는다.

### A 개발 프로필 (Android `gate` 빌드 타입)

- 기본 빌드(`assembleDebug`)는 그대로 bundled — `server.url` 없음. A 는 별도 빌드 타입 `gate`(debug 서명, 앱 id `org.footholdproject.app.gate`)에서만 쓴다.
- `scripts/gate-profile.mjs` 가 환경값으로 생성물 두 개를 만든다(둘 다 git 제외 — 실제 IP·호스트·CA 는 저장소에 없다):
  - `android/app/src/gate/assets/capacitor.config.json` = main 설정 + `server.url`(origin 하나) · `appStartPath /MLogin.dc.html?live=v2` · `errorPath fh-offline.html` · `cleartext false` · `allowMixedContent false` · `allowNavigation` 없음(넓히지 않음)
  - `android/app/src/gate/res/raw/fh_gate_ca.pem` = 그 관문 CA **한 장**
- 주소 검사: https 만, origin 하나만. 사용자정보·경로·질의·조각·와일드카드·localhost·대소문자 다른 표기는 거부(`node scripts/gate-profile.mjs --selftest`, 3 통과·16 거부). CA 는 인증서 정확히 한 장·개인키 없음·CA:TRUE·만료 아님.
- 인증서 신뢰: 기본은 OS 신뢰 저장소만(`base-config`, cleartext 금지). 그 CA 한 장은 `debug-overrides` 로만 — debuggable 빌드에서만 적용되고 release 에는 들어가지 않는다. user CA 전체 허용·인증서 오류 무시·호스트 이름 검사 끄기는 쓰지 않는다.
- 관문에 닿지 못하면 앱 안의 `fh-offline.html`(스크립트 없음, CSP `default-src 'none'`)을 보여 준다. 명령을 보내지 않고, 로봇 상태는 «측정 못 함»으로만 쓴다(STOPPED 단정 없음).
- **시작 경로를 공개 로그인 화면으로 둔 이유:** Capacitor Android 는 `server.url` 의 문서 요청을 앱이 대신 받아(HttpURLConnection) 리다이렉트를 안에서 따라간다. 그러면 WebView 주소는 원래 경로로 남아, 관문이 `/` 를 로그인 화면으로 보낸 뒤에도 `live.js` 의 `PAGE` 가 어긋난다. 그래서 관문이 리다이렉트하지 않는 공개 경로에서 바로 시작한다.

```
# mobile 폴더에서, 위 빌드 환경 그대로
FH_UI_DIST=<UI 체크아웃>/ui/dist node scripts/sync-web.mjs && npx cap sync android
FH_GATE_URL=https://<관문 호스트>:<포트> FH_GATE_CA=<관문 CA 인증서> node scripts/gate-profile.mjs
cd android && ./gradlew assembleGate        # → app/build/outputs/apk/gate/app-gate.apk
node scripts/gate-profile.mjs --clean       # 끝나면 생성물 삭제
```

- **iOS A 는 구현·검증하지 않았다.** iOS 의 CA 신뢰는 별도 설계가 필요하다. Android 결과를 iOS 통과로 보지 않는다.
- **A 는 읽기 검증까지만.** 조종 화면은 UI 담당의 네이티브 `pause`·숨김·`pagehide` 처리(입력 버림 + `hidden`, 복귀는 보기 전용)가 연결·검수된 뒤에만 연다.

### A 에뮬레이터 검증 기록 (fixture 관문·가짜 상태 domain 88, Android 14 에뮬레이터 API 34)

`scripts/gate-emulator-e2e.py` — 운영 관문·운영 링크·실계정·실시뮬 없이 fixture 만 쓴다. 최종 FAIL·예외·정리 실패면 종료코드 1, 강제 kill 없음(INT→TERM, 남으면 «정리 미완료» + 임시 원물 보존).

| 회차 | 결과 | 원인·비고 |
|---|---|---|
| 1 `runs/mobile-a-gate-e2e-20261013/` | **FAIL** — `adb install` 180 s 초과, 시나리오 미실행(옛 러너는 이래도 종료코드 0) | 실행 중 PC 부하 평균 27~33(12코어), 에뮬레이터 로그 「hanging thread QEMU2 CPU… 15–16 s」. 부하 출처는 완전히 가르지 못함 |
| 2 `…-2/` | **중단**(부팅 중 직접 멈춤, 결과 없음) | 러너 수정 요구가 와서 그 판으로는 끝까지 돌리지 않음 |
| 3 `…-3/` | **FAIL**(종료코드 1) — 16 PASS · 2 FAIL | 아래 |
| 4 `…-4/` | **FAIL**(종료코드 1) — 23 PASS · 2 FAIL | 아래. 3회차 결과는 소급해 고치지 않는다 |
| 5 `runs/mobile-a-gate-ssl-20261013-5/` | **PASS**(종료코드 0) — 22 PASS · 0 FAIL, 범위 `FH_E2E_SCOPE=ssl` | 3885275 의 인증서 오류 안내 좁은 실측. 아래 |

3회차(러너 수정 뒤: 시작·설치 전 부하 ≤ 코어/2 확인, 에뮬 2코어·2 GB, 부팅 완료·패키지 관리자 준비 뒤에만 설치, 설치 시한 180 s 그대로):
- PASS: 빌드 · 관문 127.0.0.1 기동 · 설치(1 s) · **미인증 → 관문 로그인 화면** · **fixture 로그인 → 읽기 화면** · 읽기 화면 WS 가 관문 거쳐 연결 · 세션 쿠키 whoami 200 · 정리(INT/TERM) · 결과 폴더 비밀번호 없음. 런처 화면 `00-launcher.png` 은 대화상자 없이 깨끗하다.
- **원격 페이지가 네이티브 App 플러그인을 받는지(실측):** 관문에서 받은 페이지에서도 `Capacitor.isNativePlatform()` = true, `isPluginAvailable('App')` = true, `Capacitor.Plugins.App.addListener` 사용 가능. `registerPlugin` 은 없다(원격 페이지는 `@capacitor/core` 를 싣지 않음 → 쓰려면 `Capacitor.Plugins.App` 경로). 배경으로 보냈을 때 logcat 에 `App paused`·`appStateChange {isActive:false}` 가 원격 페이지 콜백으로 전달됨.
- **FAIL — 복귀 때 화면이 새로 만들어짐:** 홈으로 보낸 뒤 다시 열자 같은 프로세스(pid 그대로)에서 `App destroyed` → `Starting BridgeActivity` → 관문 시작 경로(로그인 화면)를 다시 불러왔다. 그래서 검사 도구(CDP) 연결이 끊겨 예외로 멈췄고, 복귀 뒤·로그아웃·관문 끊김 오류 화면·다른 CA 거부 7개 항목은 **실행되지 않았다(미확인).** Activity 를 없앤 원인은 미확정(ActivityTaskManager 로그를 받지 않음). 안전 쪽 의미: 복귀하면 페이지가 새로 떠서 보기 전용으로 시작한다(이전 입력 복원 없음) — 단 «재생성 없이 이어지는 경우»는 이번에 보지 못했다.
- 링크 사건 기록(`link-events.jsonl`)은 비어 있다 — 이 회차에서는 서버 쪽 hidden 사건 근거가 없다.
4회차(3회차 뒤 러너만 수정 — CDP 재부착, 복귀 분류, 서버 status 로 조종권·출력 기록. 복귀 수락 기준 정정은 아래):
- 복귀 기준 정정(앱 Codex 10-13, 4회차부터): 옛 기준 «복귀 때 같은 페이지·자동 재로드 없음»은 플랫폼 보장이 아니다. Activity·WebView 재생성도 정상으로 보고, **«보존 또는 재로그인 → 보기 전용» + «이전 조종권·비영 명령 자동 복원 0»** 을 수락 기준으로 둔다. 유지·재생성·로그인 재요청은 각각 기록한다.
- 이번 복귀 = **유지**(pid 5376 그대로, Activity 재생성 없음, 같은 URL, whoami 200). 원격 페이지가 받은 신호(페이지 시각 ms): 배경 `App.pause` 10300 → `document.pause` 10332 → `appStateChange:false` 12181 → `visibilitychange` hidden 12265 / 복귀 `appStateChange:true` 17228 → `App.resume` 17234 → `visibilitychange` visible 17475 → `document.resume` 17591. **hidden 이 `App.pause` 보다 1965 ms 늦게 왔다**(window.__fh 의 performance.now 값, `results.json` 「복귀 결과」 원자료). 에뮬레이터 1회 관찰이라 실기기·다른 WebView 판의 순서 보장은 아니다 — 입력 버림을 `pause` 에도 거는 근거로만 쓴다. 재생성 경우는 이번에 다시 나오지 않아 «재생성 뒤 리스너 재부착»은 미측정(3회차 한 번 관찰)
- PASS: 복귀 뒤 보기 전용 · **읽기 화면 왕복 중 조종권·비영 출력 자동 발생 없음**(서버 status 1014건, holder 는 처음부터 None — 실제 조종권을 잡았다 끊고 복구하는 시험은 아직 아니다) · 로그아웃 200 → whoami 401 · 관문 로그에 로그아웃 · 관문 A 정상 종료 · **관문 없음 → 로컬 오류 화면**(`https://localhost/fh-offline.html`, 명령 없음 문구, STOPPED 단정 없음)
- **FAIL — 다른 CA 단계에서 러너 예외:** 인증서는 거부됐다(logcat `CertPathValidatorException: Trust anchor … not found`·`net_error -202`, 관문 B 로그 `alert certificate unknown`, 로그인 기록 없음). 그런데 인증서 오류에는 Capacitor `errorPath` 가 불리지 않아 로컬 오류 화면으로 가지 않았고, 러너가 CDP 대상을 https 페이지로만 골라 대상이 비었고 `IndexError` 로 멈췄다(그때 WebView 의 실제 주소는 기록 못 함). 화면 캡처(06) 없음 → **인증서 거부는 로그 근거만, 그때의 앱 화면은 미확인.** 필수 항목은 FAIL 그대로 둔다.
- 4회차 `gate.log` 는 관문 B 의 로그뿐이다 — 같은 파일 이름으로 B 를 띄우며 A 로그를 덮어썼다. A 관련 PASS(로그인·연결·로그아웃 기록)는 실행 중 그 파일을 읽어 판정한 것이고, 폴더에는 원자료가 남지 않았다. 다음 회차부터 `gate-A.log`·`gate-B.log` 로 나눈다.

증거별 유효 범위(4회차까지):

| 증거 | 말할 수 있는 것 | 말할 수 없는 것 |
|---|---|---|
| logcat `Trust anchor`·`-202` + 관문 B `alert certificate unknown` | 앱이 다른 CA 관문의 인증서를 거부했다 | 그때 앱 화면, 사용자 안내 |
| 서버 status holder None·비영 0 | 읽기 화면 왕복 중 조종권·출력이 저절로 생기지 않았다 | 조종 중 숨김 → 해제·래치, 조종권 복구 금지 |
| `window.__fh` 신호 순서 | 이 에뮬레이터 1회의 순서 | 실기기 순서, 재생성 뒤 리스너 재부착 |
| 관문 없음 → `fh-offline.html` | 연결 실패(`-100`)에 로컬 안내가 뜬다 | 인증서 거부 때의 안내(아래 보완 전) |

### 인증서 오류 안내 보완 (코드·정적 빌드만 — 에뮬레이터 미실행)

- `GateSslClient`(`android/app/src/main/java/org/footholdproject/app/`) — Capacitor 8.5.2 `BridgeWebViewClient` 상속, `onReceivedSslError` 하나만 더한다. `MainActivity` 가 `bridge.setWebViewClient(...)`(8.5.2 공개 API)로 교체한다. `shouldInterceptRequest`·브리지·생명주기·`onReceivedError/HttpError` 의 errorPath 는 부모 그대로.
- 근거(설치본 8.5.2 소스): `BridgeWebViewClient` 에 `onReceivedSslError` 가 없다 → WebViewClient 기본(취소)만, errorPath 없음. 4회차 logcat 에서도 `-202` 뒤 로컬 화면 요청이 없었다.
- 동작: **모든 SSL 오류는 `handler.cancel()`** — proceed 는 어떤 경로에도 없다. 오류 URL 이 관문(server.url) origin 이면 로컬 errorPath(보기 전용 연결 오류 안내)로 보낸다 → 관문 화면·로그인·WS 가 열리지 않는다. 다른 origin 하위 리소스는 취소만(화면 이동 없음). 이미 안내 화면이면 다시 부르지 않는다(안내 화면은 `https://localhost` 로컬이라 SSL 이 없다). bundled 기본 빌드(server.url 없음)는 취소만 — 기존과 같다.
- 메인 프레임/하위 리소스: `onReceivedSslError` 는 `WebResourceRequest` 를 받지 않아 `isForMainFrame` 을 알 수 없다. 그래서 origin 으로 가른다(관문 origin 의 인증서 실패 = 관문 전체를 신뢰 못 함 → 화면 전체를 안내로).
- 확인: 단위시험 `GateSslClientTest`(origin 비교 9개) 통과, `assembleDebug` 성공.
- **5회차 실측(에뮬레이터 1회, 같은 빌드에서 긍정 A → 부정 B):** 범위는 A 로그인 화면·fixture 로그인·읽기 WS·whoami 200 → 관문 A 정상 종료 → B(다른 CA) 만. 홈·로그아웃·끊김은 반복하지 않았고 조종 버튼은 누르지 않았다.
  - A: 관문 A 로그(`gate-A.log`)에 로그인·연결 각 1건.
  - B: logcat(`logcat-B-ssl.txt`) `Loading app` → `Trust anchor … not found` → `net_error -202` → **`Handling local request: https://localhost/fh-offline.html`**(오류 뒤 약 0.4 s). 관문 B 로그(`gate-B.log`)는 `alert certificate unknown` 뿐, 로그인·연결 0. CDP 로 본 주소 `https://localhost/fh-offline.html`, 로그인 칸 없음, 「명령도 보내지 않습니다」 문구. 화면 `06-wrong-ca.png`·화면계층 `06-wrong-ca-uihierarchy.xml`.
  - 새 프로세스의 첫 로드에서 난 SSL 오류를 새 클라이언트가 받았다 — 첫 로드 타이밍은 **이 1회에서는** 문제없었다(경쟁 조건이 없다는 증명은 아님).
  - 판정은 origin 기준이지 메인 프레임 기준이 아니다(위). APK sha256 `8a026b53…0d36`.
- **조종 화면 노출 주의:** A 는 관문의 기존 화면을 그대로 열기 때문에 읽기 화면에 「조종권 받기」 버튼이 보인다(`02-read-after-login.png`). 시험에서는 누르지 않았다. A 빌드 자체가 조종을 막지는 않으므로, 조종 개방 전 조건(위 «A 는 읽기 검증까지만»)은 운영 규칙이지 앱이 강제하는 것이 아니다.

## 숨김·백그라운드·재연결 — 번들을 재사용하는 조건

조종 화면을 앱에서 쓰려면 아래가 **모두** 성립해야 한다. 지금 React `link.ts` 에는 숨김 처리가 없다. 기존 `web/live.js` 에만 있다(126–127, 350행).

1. 화면이 숨겨지거나(`visibilitychange` hidden), 페이지를 떠나거나(`pagehide`), 앱이 백그라운드로 가면(Capacitor `pause`) → 누르고 있던 입력을 모두 버리고 `{op:'hidden'}` 을 보낸다. 서버는 조종권을 해제하고 명령 0 + STOP 잠금으로 처리한다(`Core.drop`). `blur`·화면 회전에도 입력을 버린다.
2. 다시 앞으로 오거나(`resume`) 다시 연결되면 → 보기 전용으로 시작한다. 이전의 비영(0 아님) 입력은 **자동으로 복원하지 않는다.** 조종권 획득과 STOP 해제는 사용자가 다시 직접 눌러야 한다(서버도 새 조종권에 손 뗌·래치를 요구한다).
3. 연결이 끊기면(`onclose`) 입력을 버리고 보기 전용으로 바꾼다. 재연결을 해도 명령을 다시 보내지 않는다.
4. 위 규칙이 「통과했다」고 말하는 근거는 서버 사건 로그로만 삼는다. 실제 휴대폰에서 백그라운드로 보냈을 때 `hidden` 사건이 남는지 확인해야 한다. 에뮬레이터 4회차에서는 hidden 도 왔지만 `App.pause` 보다 1965 ms 늦었다(1회 관찰, 실기기 미확인). 그래서 Capacitor `pause`(`@capacitor/app` 8.1.1, 원격 페이지에서 `Capacitor.Plugins.App`)도 같이 듣는다 — UI 쪽 연결은 아직 안 됨.
5. 실시간 보장은 아니다. 최종 안전망은 받는 쪽 명령 TTL 이다. STOP 명령 0 은 물리 정지가 아니다(실험에서 3.6 s·0.32 m 를 더 이동, 원인 미확정).

## 앱 아이콘 (브랜드 공식 래스터 파생)

- 출처: `foothold-project/foothold-brand` 커밋 `7afd2416d266f9a2d6d6166c66e576eacef524b9`
  - `assets/raster/v1/logo/foothold-favicon.png` 512×512, sha256 `fdfa03e1…45d7` (원본 `assets/logo/v1/foothold-favicon.svg`)
  - `assets/raster/v1/logo/foothold-symbol-brand.png` 512×587, sha256 `a2f555a4…ef7d` (원본 `assets/logo/v1/foothold-symbol-brand.svg`)
  - 두 sha256 은 브랜드 `assets/raster/v1/manifest.json` 값과 같다. 스크립트가 다르면 멈춘다.
- 원본 PNG 는 저장소에 넣지 않았다(브랜드 저장소가 정본). 다시 만들 때: 위 두 파일을 받아 한 폴더에 두고 `python3 -I scripts/make-icons.py <그 폴더>`.
- 하는 일은 축소(LANCZOS)·가운데 배치·배경 채움뿐이다. 다시 그리기·늘이기·색 바꾸기는 하지 않는다. 배경색은 favicon 바탕과 같은 `#F6F5F1`.

| 파일 | 원본 | 여백·배경 |
|---|---|---|
| Android `ic_launcher.png`(48~192 px) | favicon | 그대로 축소(둥근 정사각 + 투명 모서리) |
| Android `ic_launcher_round.png` | symbol | `#F6F5F1` 원 + 심볼 대각선 72% |
| Android 적응형 `ic_launcher_foreground.png`(108dp) + 배경색 `#F6F5F1` | symbol | 투명, 심볼 대각선 60% → 안전 원(66dp) 안 |
| iOS `AppIcon-512@2x.png` 1024 | symbol | `#F6F5F1` 꽉 찬 정사각, 불투명(모서리는 iOS 가 깎음), 대각선 72% |

- 스플래시(`drawable*/splash.png`)는 Capacitor 기본 그대로다. 바꾸지 않았다.

## 남은 결정

- **appId `org.footholdproject.app`:** 저장소 조직(`foothold-project`)의 역도메인을 근거로 한 **개발용 임시 값**이다. 상용 ID 를 정하기 전까지 임시로 둔다. 스토어에 올린 뒤에는 바꿀 수 없어서, 게시 전에 정한다. 서명 키·스토어 등록은 하지 않았다.
- **서버 연결:** A 는 첫 개발·체험 연결로만 결정됐다(앱 Codex 검수, 96b600f 리뷰). 최종 번들 B 는 관문 검사 설계 검수 뒤 별도로. 보안을 완화하는 변경은 자동으로 하지 않는다.
- **릴리스 서명 키:** 만들지 않았다. 만들게 되면 키는 저장소 밖에 두고 비밀번호도 기록하지 않는다.

## 기록 손실 (새 시험 결과와 구분)

- `runs/backend-review-20261013/`(백엔드 검수 때의 `pytest-full.txt`·`pytest-followup.txt`)는 10-13 세션 이동 중 이전 worktree 폴더가 삭제되면서 **사라졌다.** 복구하지 않았고 다시 만든 것도 없다. 그 결과를 인용할 때는 `docs/PROGRESS-contract-storage.md` 에 적힌 숫자가 유일한 기록이다.
- 지금 `runs/` 에 있는 `mobile-shell-20261013/`·`mobile-icon-appid-20261013/` 는 폴더를 다시 만든 뒤 새로 만든 결과다.

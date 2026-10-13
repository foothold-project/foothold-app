# mobile — Android/iOS 외피 (Capacitor 8)

`ui/dist`(React 번들)를 **그대로** 실어 앱으로 감싼다. 화면을 다시 만들지 않는다. 화면은 UI 담당, 이 폴더는 외피·빌드·연결 설계만 맡는다.

## 상태 (2026-10-13)

| 구분 | 내용 |
|---|---|
| **만든 것** | `package.json`(버전 고정) · `capacitor.config.json` · `scripts/sync-web.mjs`(ui/dist → www, 파일별 sha256 을 `SOURCE.json` 에) · `scripts/make-icons.py`(브랜드 공식 래스터 → 앱 아이콘) · `android/`·`ios/` 프로젝트(`cap add` 생성물 + appId·아이콘만 변경) |
| **이 PC 에서 확인** | **debug APK = 서버 없는 설치 외피·보기 전용.** 86ef8d4: 빌드 성공(Linux, 1분 46초) + Android 14 에뮬레이터(API 34, x86_64)에서 설치·실행해 React 번들 화면이 뜸. 서버가 없어서 「링크 연결 중 · 잠금 상태 미확인 · 보기 전용」으로 표시됨. 증거 `runs/mobile-shell-20261013/`(APK sha256 `b9684116…772e`). appId·아이콘 변경 뒤에는 **빌드만** 다시 함(에뮬레이터 실행 없음): 패키지 `org.footholdproject.app`, 증거 `runs/mobile-icon-appid-20261013/`(APK sha256 `3a821941…e431`). 둘 다 git 무시 |
| **확인 안 함** | 실제 휴대폰 · **iOS = 프로젝트 생성만**(Mac·Xcode 필요, 이 Linux 에서는 빌드·IPA 없음) · 관문 서버 연결·로그인 · 런처에서 보이는 아이콘 모양(기기·런처마다 마스크가 다름) · 릴리스 서명 · 백그라운드 동작 |

APK 를 만든 번들은 `feature/react-platform-oh` e618139 이다(브랜드 적용 전). 화면이 PC 폭으로 배치되는 것은 UI 쪽 범위다.

## 버전과 근거

| 항목 | 값 | 근거 |
|---|---|---|
| Capacitor | 8.5.2 (core·cli·android·ios) | npm `latest` 는 8.5.3(10-07 배포, 6일 됨). 그래서 한 달 된 8.5.2 로 고정. cli 의 `engines.node >=22` |
| Node | 22 이상 | 시스템 node 18 은 쓰지 않는다. 사용자 폴더의 node 22 를 쓴다(전역 업데이트 없음) |
| JDK | 21 | Capacitor android `JavaVersion.VERSION_21`. 시스템 openjdk 21.0.12 |
| Android | compileSdk 36 · targetSdk 36 · minSdk 24 · AGP 8.13.0 · Gradle 8.14.3 | `android/variables.gradle`·`build.gradle`·wrapper(생성물 그대로) |
| iOS | 15.0 이상 · SPM(`CapApp-SPM`, CocoaPods 없음) · bundle id `org.footholdproject.app`(임시) | `ios/App/App.xcodeproj` |

React 쪽(Vite 5)은 지금처럼 node 18 로 빌드해도 된다. 외피만 node 22 가 필요하다.

## 빌드 (Linux, sudo 없이)

```
# 1) UI 번들 (ui 폴더에서, UI 담당 절차 그대로)
cd ui && npm ci && npm run build

# 2) 외피 (mobile 폴더에서)
export PATH=~/.local/opt/node-v22.23.3-linux-x64/bin:$PATH
export JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 ANDROID_HOME=~/Android/Sdk
cd mobile && npm ci
FH_UI_REV=$(git rev-parse HEAD) npm run apk:debug     # ui/dist → www → cap sync android → gradlew assembleDebug
# 결과: android/app/build/outputs/apk/debug/app-debug.apk (debug 키 서명)
```

- `node scripts/sync-web.mjs <다른 dist 경로>` 로 다른 곳의 번들도 실을 수 있다. 소스맵(`*.map`)은 빼고, 로컬 경로는 APK 에 넣지 않는다.
- 처음 빌드하면 Gradle 8.14.3 을 내려받는다. AGP 가 Build-Tools 35 를 `~/Android/Sdk` 에 자동으로 설치한다(사용자 폴더, 라이선스는 이미 동의된 상태).
- `www/`·`node_modules/`·`android/app/src/main/assets/public` 은 생성물이라 git 에서 제외한다.

## iOS — Mac 인계

1. Mac 에 Xcode(iOS 15 SDK 이상)와 Node 22 를 준비한다. 위 1)과 같이 UI 번들을 만든다.
2. `cd mobile && npm ci && node scripts/sync-web.mjs && npx cap sync ios && npx cap open ios`
3. Xcode 에서 App 타깃 → Signing & Capabilities 로 가서 Team 을 고른다. **현민님 Apple 계정 입력이 필요하다.** 프로젝트는 자동 서명(`CODE_SIGN_STYLE = Automatic`)이고 Team 은 비어 있다.
4. 시뮬레이터에서 실행해 본 뒤 실기기에서 실행한다. Archive·IPA 는 서명이 끝난 뒤에 만든다. 이 Linux 에서는 iOS 를 하나도 빌드하거나 실행하지 않았다.

## 서버 연결 설계 (문서만 — 코드·서버 변경 없음)

앱 WebView 의 출처는 Android `https://localhost`, iOS `capacitor://localhost` 다. 관문(v2_gate)은 로그인 세션과 **같은 출처(Origin) 검사**로 쓰기·WS 를 막는다. 그래서 번들을 그대로 실은 지금 상태에서 `/api/*`·`/ws` 요청은 관문에 닿지 않는다. 에뮬레이터 로그에서도 `https://localhost/api/docs` 로 나갔다.

| 방식 | 하는 일 | 지켜지는 것 | 필요한 것 | 판정 |
|---|---|---|---|---|
| **A. 관문 주소 로드** | `capacitor.config.json` 의 `server.url` 을 관문 HTTPS 주소로 둔다. WebView 가 관문의 로그인·화면을 그대로 연다 | 같은 출처·세션 쿠키·Origin 검사를 그대로 쓴다. `link.ts` 는 `location` 으로 WS 주소를 만들어서 수정할 필요가 없다 | 휴대폰이 관문 인증서를 신뢰해야 한다(사설 CA 를 기기에 설치하거나 공인 인증서). `cleartext:false`(http 금지). `allowNavigation` 은 관문 호스트만 | **첫 연결로 권장**. 서버 계약 변경 0 |
| B. 번들 + 분리 어댑터 | 번들은 앱 안에 두고, `/api`·`/ws` 만 관문 절대주소로 보낸다(`link.ts`·fetch 의 기준 주소를 주입하는 어댑터 하나) | 오프라인에서도 화면이 뜬다 | 관문 Origin 허용 목록에 `https://localhost`·`capacitor://localhost` 를 추가하고, 교차 출처 세션(쿠키 `SameSite=None; Secure` 또는 토큰)이 필요하다 → **서버 신뢰 경계를 바꾸는 일** | 지금 하지 않는다. 하려면 관문 검사 설계부터 다시 검수 |

- A 로 가더라도 `server.url`·인증서·`allowNavigation` 값은 기기 시험 때 정한다. 실제 IP·호스트는 저장소에 넣지 않는다(빌드할 때 환경값으로 주입).
- A·B 모두 같은 출처 검사나 세션 검사를 풀지 않는다. 앱이라는 이유로 예외를 만들지 않는다.
- WSS 는 관문 인증서를 그대로 쓴다. Android 는 사설 CA 를 쓰려면 `network_security_config` 에서 user CA 를 허용해야 한다. 이건 기기 시험 때 판단한다.

## 숨김·백그라운드·재연결 — 번들을 재사용하는 조건

조종 화면을 앱에서 쓰려면 아래가 **모두** 성립해야 한다. 지금 React `link.ts` 에는 숨김 처리가 없다. 기존 `web/live.js` 에만 있다(126–127, 350행).

1. 화면이 숨겨지거나(`visibilitychange` hidden), 페이지를 떠나거나(`pagehide`), 앱이 백그라운드로 가면(Capacitor `pause`) → 누르고 있던 입력을 모두 버리고 `{op:'hidden'}` 을 보낸다. 서버는 조종권을 해제하고 명령 0 + STOP 잠금으로 처리한다(`Core.drop`). `blur`·화면 회전에도 입력을 버린다.
2. 다시 앞으로 오거나(`resume`) 다시 연결되면 → 보기 전용으로 시작한다. 이전의 비영(0 아님) 입력은 **자동으로 복원하지 않는다.** 조종권 획득과 STOP 해제는 사용자가 다시 직접 눌러야 한다(서버도 새 조종권에 손 뗌·래치를 요구한다).
3. 연결이 끊기면(`onclose`) 입력을 버리고 보기 전용으로 바꾼다. 재연결을 해도 명령을 다시 보내지 않는다.
4. 위 규칙이 「통과했다」고 말하는 근거는 서버 사건 로그로만 삼는다. 실제 휴대폰에서 백그라운드로 보냈을 때 `hidden` 사건이 남는지 확인해야 한다. Android WebView 가 백그라운드에서 `visibilitychange` 를 확실히 보내는지는 **미확인**이라 Capacitor `pause` 도 같이 듣는다(`@capacitor/app` 추가는 그때).
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
- **서버 연결 A/B:** 위 설계는 비교만 했다. 앱 Codex 가 인증·Origin·CA 계약을 읽고 검수한 뒤 결정한다. 그 전에는 어느 쪽도 구현하지 않고, 보안을 완화하는 변경은 자동으로 하지 않는다.
- **릴리스 서명 키:** 만들지 않았다. 만들게 되면 키는 저장소 밖에 두고 비밀번호도 기록하지 않는다.

## 기록 손실 (새 시험 결과와 구분)

- `runs/backend-review-20261013/`(백엔드 검수 때의 `pytest-full.txt`·`pytest-followup.txt`)는 10-13 세션 이동 중 이전 worktree 폴더가 삭제되면서 **사라졌다.** 복구하지 않았고 다시 만든 것도 없다. 그 결과를 인용할 때는 `docs/PROGRESS-contract-storage.md` 에 적힌 숫자가 유일한 기록이다.
- 지금 `runs/` 에 있는 `mobile-shell-20261013/`·`mobile-icon-appid-20261013/` 는 폴더를 다시 만든 뒤 새로 만든 결과다.

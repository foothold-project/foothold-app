# Unitree Go 앱 비교 분석 · FOOTHOLD 개선 제안 (r2.1, 2026-10-14 UI mentor)

> 분석·제안 문서입니다. 구현하지 않았고, 운영 서버·APK·화면은 바꾸지 않았습니다.
> 원자료(APK·XAPK, REA 출력, 공식 이미지 사본)는 `runs/rea-unitree-20261014/`(gitignore)에만 두고 커밋하지 않습니다.
> r1은 `runs/rea-unitree-20261014/REVIEW-r1-snapshot.md`(sha256 5d239f60…e323)에 그대로 보존했습니다. r2에서 새로 생긴 근거는 §5·§6에 새 절로 추가했고, r1의 증거를 고쳐 쓰지 않았습니다.
> r2.1: 문서 오류 3건만 정정(§2 #4 지원 범위·P1 구현 범위 구분·XAPK split 개수) + §5 근거 수준 줄 추가. 분석 재실행 0.

## 0. 범위 — 먼저 읽어 주세요
| 항목 | 내용 |
|---|---|
| 사용자 기준 | **iPhone · Unitree Go**. App Store「Unitree Go - Embodied AI」(bundle `com.unitree.go2`, 2.0.0, 2026-08-03, 판매자 Hangzhou YuShu TECHNOLOGY CO.,LTD.) |
| iOS 바이너리 | **REA 분석 안 함**(Mac·IPA 없음). iOS 근거는 App Store 공식 스크린샷 6장과 설명문뿐입니다 |
| Go Android(참고) | Play `com.unitree.doggo2` 1.12.10. 공식 경로에서 APK를 찾지 못해, 지정받은 서드파티 1곳(APKPure XAPK)에서 1회 내려받아 base APK만 정적 분석했습니다(§5). **iOS 판과 같은 코드라고 단정하지 않습니다** |
| Explore(별도 참고) | 공식 사이트 Go2 국제판 Android QR → Unitree Explore 2.2.3(`com.unitree.b2dog`). Go와 다른 package입니다. 보호 포장 때문에 본체를 정적으로 확인하지 못했습니다(§4) |
| 우리 쪽 기준 | React dev `eb46259`(운영 8453 = serve-eb46259). 근거는 소스 위치입니다 |
| 하지 않은 것 | 로그인·바인딩·로봇 연결·조종·OTA, 보호 해제·해독·런타임 덤프, 앱 설치·실행·에뮬레이터, 다른 미러, Explore 특징을 Go에 옮겨 적는 일, «공식 앱 코드에 있으니 SDK·센서·자율 기능 가능» 같은 단정 |

근거 표기: **[iOS-사진]** App Store 공식 스크린샷 · **[G-사진]** Play·사이트·매뉴얼 공식 이미지 · **[GA-REA]** Go Android 1.12.10 base APK REA 결과(참고) · **[E-REA]** Explore(별도 참고) · **[우리-코드]** 우리 소스 · **미확인** = 확인하지 못함.

## 1. 공식 화면에서 관찰한 것 (사진 관찰 — 실행 관찰 아님)
증거 파일은 모두 `runs/rea-unitree-20261014/public/` 아래에 있습니다.
- **iOS (ios/ios-shot1~6, URL은 ios/shots.txt)**: ios3 «Precise Control»은 카메라 전체 화면에 좌·우 엄지 막대 2개를 둡니다. 아래 가운데에 동작 버튼 두 줄, 왼쪽 아래에 점군 미니맵, 오른쪽에 사진·녹화 버튼이 있습니다. 위쪽 띠에는 배터리 80%·높이·온도·통신 패널(«543mb/s»)과 빨간 «« STOP» 탭이 있습니다. ios2는 영상과 점군을 반반으로 나눈 화면입니다. ios4는 점군이 전체 화면이고 영상이 미니 창으로 바뀐 상태입니다(주·보조 화면 맞바꿈). ios5는 블록 프로그래밍, ios6은 OTA 진행(«배터리 20% 이상·약 3분» 안내) 화면입니다.
- **Android Play(play-shot1~5)**는 위 iOS 사진과 거의 같은 마케팅 이미지입니다. 같은 화면 디자인으로 보이지만 판 일치는 **미확인**입니다.
- **Go2 User Manual V4.3(manual-go2/p09~p11)**:
  - M9 홈 화면: GUIDE·GALLERY·EMPLACE·FUNCTION 카드, «Add robodog», «GO» 버튼.
  - M9 로봇 추가: Bluetooth 스캔 목록에서 로봇을 고르고 이름·메모를 입력한 뒤 bind합니다.
  - M9 연결 방식: «Router mode / Wi-Fi connected mode» 두 카드와 단계 그림 안내가 있습니다.
  - M10: 연결 진행 → 성공 화면, 그리고 결과를 문장으로 적은 해제 확인창(«After unbinding, the robot dog cannot be controlled through the app»)이 있습니다.
  - M11: 경고 삼각형을 누르면 목록이 펼쳐집니다(«Abnormal control equipment / DDS communication abnormality / MCU communication abnormality», 항목별 색 배지). 화면 안에 손가락 안내(«Double finger sliding switching mode»)와 사진 썸네일이 보입니다.

## 2. 비교·개선표 (우선순위 순 · 현재 디자인 안에서)
P1 = 운영 안전·혼란과 직결됨(필요한 구현 범위는 행마다 «필요한 것» 칸에 따로 적음 — #2·#3 은 기존 상태만 쓰는 화면, #1 은 일부가 새 네이티브 인터페이스 필요). P2 = 쓸모 크지만 서버 필드·센서 필요. P3 = 참고. 공통 원칙: 앱 전면 변경 없음. 기존 19화면·브랜드와 **현재 사용자 승인 막대 배치를 유지**하며, Go의 좌우 배치를 복제하지 않습니다.

| # | Go에서 관찰 | 우리 현재 [우리-코드] | 불편·차이 | 구체 개선 | 순위 | 의존 | 디자인 유지·보존 조건 |
|---|---|---|---|---|---|---|---|
| 1 | 연결 방식 2카드·단계 그림·진행→성공 화면 (M9·M10) | 관문 주소 직접 입력, 형식만 검사(`data/auth.ts:33`, `app/login.tsx:44`) | 개발 포트(8792 등 127.0.0.1 전용)나 틀린 주소를 넣으면 «연결 실패»만 보여 원인을 모름 | ① **접속 프로필**(LAN / Tailscale) 선택 → 올바른 관문 주소 자동 채움. QR로 주소 받기도 가능. 지금 관문은 8453이지만 **영구 고정 포트가 아니므로** 프로필 값으로 둡니다 ② 로그인 **전에** 도달·인증서 확인 단계 표시(비밀번호 없이: 주소 형식 → 도달 → 인증서 일치 → 로그인 → 링크) ③ 실패 이유를 단계 이름으로 보여 줌 ④ «주소 저장됨»과 «연결 성공»은 다른 상태로 표시 | **P1** | 나눠서 봄: ㉠ 실패 단계 이름·«저장됨≠성공» 표시와 프로필 수동 선택·주소 안내 = 화면만 가능 ㉡ 로그인 **전** 도달·인증서 확인과 카메라 QR 스캔 = 새 제한 네이티브 FhGate 인터페이스·권한·전송 계약이 필요할 수 있음(현재 OPS 고정). QR로 만든 링크·주소 붙여넣기(카메라 0)와 카메라 스캔은 구분. 로그인 요청으로 몰래 연결 시험하지 않음 ㉢ 주소 기억은 네이티브 저장소(mobile mentor 영역). 비밀 0 | 기존 서버 카드·`.inp/.btn` 그대로 |
| 2 | 경고 삼각형 → 펼친 목록, 항목별 색 배지 (M11·ios3) | 가운데 알림이 문장으로 쌓임(`screens/MDrive.tsx:48-63`) | 원인이 여러 개면 한 덩어리가 됨. 무엇이 «막는 것»인지 순서가 안 보임 | 상단에 경고 아이콘 + 개수를 둡니다. 누르면 목록(막힘·주의·정보 3색). 지금의 `msgs` 배열을 그대로 항목으로 씁니다 | **P1** | 화면만 | `hud()` 칩·`--warn/--bad` 토큰. 목록이 **STOP을 가리지 않음** |
| 3 | 빨간 «STOP» 탭이 늘 오른쪽 위 (M11·ios3) | STOP 상시 + «조종권 받기 → STOP 해제 → 다시 누름» 3단(`MDrive.tsx:59-63`, `app/drive.tsx:6-13`) | 안전 의도는 맞지만, 처음 쓰는 사람은 지금 몇 단계인지 모름 | STOP 옆 한 줄에 단계 표시 «보기 → 조종권 → 해제 → 조종»(현재 단계 강조). 서버 `st.role/latch/resume_pending`만 씁니다. **서버 명령 정지(명령 0)와 몸 정지는 다르다는 문구 유지**(`RELURCH`) | **P1** | 화면만 | 기존 `big()` 버튼·pill. 단계 표시는 텍스트 한 줄 |
| 4 | 첫 사용 손가락 안내 (M11) | 안내는 메뉴 ⓘ 안 문장(`MDrive.tsx:95`) | 처음 쓸 때 막대 규칙을 모름 | 첫 진입 1회만 막대 위에 안내를 띄웁니다. 내용은 **현재 지원 capability 기준**: 전진·이동하며 회전 지원(시험값 앞 0.6 m/s·회전 ±0.5 rad/s) / 후진·단독 회전·옆걸음 미검증·차단(지금 서버가 0으로 막는 것)을 표시합니다. 막대 배치는 현재 사용자 승인 배치를 유지합니다. Go의 **두 손가락 슬라이드 제스처는 채택하지 않습니다**. 우리 독립 pointerId·두 곳까지·세 번째 입력 시 전부 폐기 규칙(`drive.tsx:7`)과 충돌할 수 있기 때문입니다 | P2 | 화면만 | 기존 토큰, 장식 0. 닫으면 기억 |
| 5 | 결과 문장이 든 해제 확인창 (M10) | `confirm()`에 결과를 적음(`MDrive.tsx:32`, `map/MapStartBox.tsx:27`) — 이미 비슷 | 브라우저 기본 confirm이라 폰에서 작고 버튼 이름이 «확인/취소» | 원장 소모·세계 전환처럼 되돌릴 수 없는 동작만 자체 확인창으로 바꿉니다. 버튼에는 동작 이름(«시뮬 30분 시작»)을 씁니다 | P2 | 화면만 | `Drawer` 재사용. 열기 전 **`dropAll()` 유지·낡은 누름 복원 0·STOP 가림 0** |
| 6 | 영상·점군 분할, 주·보조 맞바꿈 (ios2·ios4) | 조종 화면에 작은 지도(`MapCanvas`), 지도 탭은 별도. 점군 없음 | 지도를 크게 보려면 탭을 옮겨야 해 조종 흐름이 끊김 | 미니맵을 탭하면 반반(영상|지도) 또는 맞바꿈. 지도 보기 잠금 규칙(sel≠GT면 GT 레이어 끔)은 그대로 둡니다 | P2 | 화면만(점군 표시는 P3·센서 의존) | `MapCanvas`·`useMapPick` 재사용. 전환 때 **`dropAll()`·STOP 가림 0** |
| 7 | 사진 썸네일이 조종 화면 안에 바로 (M11·ios3), 홈 GALLERY (M9) | 📷 → 서버 저장 + 토스트(`MDrive.tsx:35`), 기록 보기는 메뉴 안(`:97`) | 찍은 결과를 바로 못 봄 | 마지막 사진 썸네일을 📷 옆에 작게 둡니다. 누르면 기록 화면의 해당 항목으로 갑니다 | P2 | 서버 사진 목록(이미 있음 — 표시만) | `sq()` 크기. 이동 전 **`dropAll()`** |
| 8 | 배터리·온도·속도·통신속도 숫자 (ios3·site) | «배터리 미연결» 고정(`MDrive.tsx:78`) | 실기가 붙어도 칸이 비어 있음 | 계약에 선택 필드(`battery_pct`·`link_rtt_ms` 등)를 추가하면 칩에 숫자를 보여 줍니다. 값이 없거나 낡으면 «미확인», 시뮬은 «시뮬» | P2 | 서버·실기 상태 소스 | `hud()` 칩 |
| 9 | 녹화 버튼 (ios3) | 없음 | — | 필요하면 서버 측 녹화(증거 보존 목적) | P3 | 서버 | — |
| 10 | 동작 버튼 두 줄(춤·악수 등)·순회·충전 계열 | 없음(이동만) | 우리 목적은 현장 임무 | **도입 안 함.** 순회·충전·후진·댄스는 로봇 지원이 검증되지 않았습니다. 공식 앱 코드에 있다는 이유로 우리 앱에서 실행을 열지 않습니다 | — | — | — |
| 11 | 전체화면 가로 (ios2~4) | 전체화면 + 가로 고정 시도(`MDrive.tsx:37-43`) | 이미 있음 | 유지. 고정이 안 되는 iOS Safari에서는 «가로로 돌려 주세요» 안내만 | P3 | — | 진입·나옴 전 `dropAll()`(이미 있음) |

## 3. 미확인 (실제 화면·기기가 필요)
- Go의 실제 동작: 경고 목록이 뜨는 조건, STOP 탭이 몸 정지인지 명령 정지인지, 막대 감도, 끊김·복귀 문구. 사진은 마케팅·매뉴얼 이미지라 실제 판과 다를 수 있습니다.
- iOS 2.0.0과 Android 1.12.10이 같은 웹 조종 묶음을 쓰는지(§5는 Android 기준).
- 세로 막대 2개와 높이 수치의 의미(사진 판독 한계).

## 4. Explore 2.2.3 REA 결과 (별도 참고 · Go 근거 아님) [E-REA]
- 출처·서명: `runs/rea-unitree-20261014/PROVENANCE.md`(sha256 242e5398…f647, v2 서명 cert e39de366…ea90. 서명 검증과 공식 출처 증거는 따로 적었습니다).
- `rea inspect-android-package`: activity 180, 권한 40, 여러 기종(Go2·G1·H1/H2·A2·R1) 화면 이름이 한 앱에 들어 있습니다(manifest 기준).
- `rea search-android-classes ""`: 9959 클래스 중 `com.unitree` 앱 코드는 `R` 하나입니다. application = `com.sagittarius.v6.StubApplication`, assets에 `baiduprotect*` 파일이 있습니다 → **보호 포장으로 본체를 정적으로 확인하지 못함**(암호화 방식이나 본체 전체가 암호화됐는지는 직접 확인하지 않았습니다). 보호 해제·덤프 0.

## 5. Go Android 1.12.10 base APK 정적 참고 (r2 신규 · 서드파티 출처) [GA-REA]
- **출처**: APKPure `https://apkpure.net/unitree-go/com.unitree.doggo2/download` → 302 → 파일 `Unitree Go_1.12.10_APKPure.xapk`. 1회 다운로드(2026-10-14T11:24:22~30+09:00, 184,324,925 B, sha256 039347d5…6de5). 사이트의 «safe» 문구는 근거로 쓰지 않았습니다. **Play 배포본과 바이트가 같은지는 미확인**입니다.
- **XAPK**: 안전 인벤토리 결과 22항목(경로 탈출 0, 총 184 MB). base `com.unitree.doggo2.apk`(sha256 da00ca3c…cf06) + split 19개(언어 17 + `arm64_v8a` + `xxxhdpi` = 19, 각 SHA는 runs에 기록) — APK 20개 + `icon.png` + `manifest.json` = 22항목. 병합·수정 0이며, **분석은 base만** 했습니다. 리소스·네이티브 split이 빠졌으므로 언어 문자열·.so 근거는 없습니다.
- **직접 검사(aapt2·apksigner)**: package `com.unitree.doggo2`, versionCode 146, versionName 1.12.10, label «Unitree Go», targetSdk 35. 서명은 v3로 «Verifies», 인증서 sha256 019a60db…e85d(DN이 «CN=Android, O=Google Inc.» — Play 앱 서명 형식). **Source Stamp 검증 통과**, 타임스탬프 2026-06-11T11:08+09:00로 Play «Updated on Jun 11, 2026»과 날짜가 맞습니다. 이는 Play 배포 흔적이지 Play 바이트 일치 증명은 아닙니다. split 3개도 같은 인증서입니다.
- **REA 6.4.0 + JADX 0.7.1**(heap 3072 MiB, CPU 4, timeout 300 s, nice 10, 호출마다 약 14 s, RSS 약 1.2~1.4 GB, 명령 전문은 `out/COMMANDS.log`):
  - `inspect-android-package`: activity 101, 권한 36, 클래스 12036. application = `com.unitree.doggo2.core.MainApplication`(보호 stub 아님).
  - `search-android-classes com.unitree`: 1519개. Explore와 달리 앱 코드가 정적으로 보입니다.
  - `inspect-android-class …fragment.web.WebRTCFragment`: 멤버 64. `initWebView`·`jumpUrl`·`checkAndConnect`·`sendRemoteResult`·`pressBack` 등이 있습니다.
  - `inspect-android-method … initWebView`: AgentWeb WebView를 만들고 `this.webUrl`을 엽니다(file URL 접근 허용 설정 포함).
  - `inspect-android-method … initView`: `webUrl = CommonExtKt.getRTCH5(BaseConstant.RTC_OPERATION_TEST, …)`.
  - `inspect-android-method baselibrary.ext.CommonExtKt getRTCH5`: `url + "?w=<화면폭dp>&h=<화면높이dp>"`.
- **근거 수준**: ⓐ Android 메서드에서 WebView 생성·`webUrl` 로드 = REA 메서드 근거로 **확인** ⓑ 그 WebView 가 조종 route(`#/operation`)를 연다 = 자산·문자열로 **판정**(더 약함).
- **판정(정적, 참고)**: Go Android의 조종 화면은 네이티브 위젯이 아니라 **APK 안 웹 묶음(`assets/dist`, Vite 빌드·legacy 판 동봉)을 WebView로 띄우는 구조**로 보입니다. dex 문자열에 `http://localhost:19978/#/operation`이 있고, dist에 `slam`·`PCDLoader`(점군)·`Programming`·`simulator`·`imageRemoteControl`·`joystick_body` 자산이 있습니다. `RTC_OPERATION_TEST` 상수가 이 문자열과 같은지는 **미확인**입니다(상수 값을 직접 보지 않음). 네이티브 쪽에도 `JoystickView`·`ErrorsDrawerPop`(경고 서랍)·`Map3DActivity`·`PictureActivity` 클래스 이름이 있습니다.
- **막힌 곳**: dist의 주 JS(`main-*.js` 11.7 MB, `slam/*.js`)는 평문이 아닙니다(바이트 엔트로피 8.0, 인쇄 가능 문자 37%). 그래서 조종 화면의 문구·끊김/복귀 메시지·STOP 로직은 **정적으로 확인하지 못했습니다**. 해독은 시도하지 않았습니다.
- **우리와의 관계(설계 참고만)**: 우리도 React 화면을 WebView APK에 싣는 구조라, «웹 조종 화면 + 네이티브 연결·경고 서랍» 분담이 같은 방향입니다. 다만 이것은 기능 근거가 아니며, Go의 기능을 우리 앱에서 열 근거로 쓰지 않습니다.

## 6. 다음
1. 사용자가 요청하면 §2 P1(1 접속 프로필·도달/인증서 단계, 2 경고 목록, 3 STOP 단계 표시)부터 현 디자인 안에서 시안을 냅니다. 지금은 구현하지 않습니다.
2. iOS 실제 화면 확인은 사용자의 iPhone 화면 녹화·캡처가 있을 때만 합니다(로그인·바인딩·조종 요청 0).

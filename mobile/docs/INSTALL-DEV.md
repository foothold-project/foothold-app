# 개발용 Android APK 설치 안내 (2026-10-14)

**스토어 판이 아니다.** 개발·시험용(debug 키 서명, 앱 id `org.footholdproject.app.dev`). Android 전용 — iPhone 용은 없다(Mac 없음).

## 파일

| 항목 | 값 |
|---|---|
| 파일 | `mobile/out/foothold-android-dev-20261014-mapopen.apk`(git 제외) · 사본 `~/Downloads/foothold-android-dev-20261014-mapopen.apk` |
| SHA-256 | `71b5c93d79d35e02b5a47f034fcc92e03ea75bd253d67e188f358f96916c2631` |
| 화면(UI) 판 | `7e644fa04f88ea15c23b46562143b6e45bf59ad2` — 새 지도 열기·PIP·높이 표시 포함 검수판, 파일 143개 sha 일치(목록 sha `0ae06fac…`) |
| 모바일 판 | `cdc9493`(quad 와 같음 — 이번 UI 변경은 WS 내용 처리뿐이라 네이티브 변경 0, 작업 트리 깨끗한 상태로 빌드) |
| 옛 판 | `-20261014`·`-maps`·`-maplive`·`-ux`·`-nearby`·`-quad`(UI b57e58f, sha `f779312d…`) APK 는 보존만 — 새로 설치할 것은 위 `-mapopen` 하나. quad 와 mapopen 은 앱 id 가 같아 위에 덮어 설치된다(로그인 유지 여부는 실폰 미확인) |
| 버전 이름 | `1.0-dev` |

설치: 휴대폰으로 파일을 옮겨 열고 «출처를 알 수 없는 앱 설치»를 그 파일 관리자에만 허용한다. 기존 `org.footholdproject.app`(옛 debug 판)과 **별개 앱**으로 깔린다.

## 무엇이 되는가

- 앱이 화면을 직접 갖고 있다(관문 웹 페이지를 불러오지 않음). 처음 켜면 «관문 주소를 먼저 정하세요».
- 로그인 화면 «바꾸기»에서 관문 주소를 직접 넣는다. 형식 `https://<관문 PC 주소>:<포트>` — 그 주소가 관문 인증서에 적힌 이름(SAN)과 맞아야 한다.
- 이미 있는 계정으로 로그인한다. 로그인은 휴대폰 Keystore 에 보관되어 앱을 다시 켜도 유지된다.
- 앱으로 돌아와도 자동으로 조종을 잡거나(take) 다시 움직이지 않는다(읽기 전용으로 시작).

## 신뢰하는 인증서

- 휴대폰 기본(시스템) 인증서 + **운영 관문 공개 CA 한 장**(유효 2029-01-08 까지). 사용자가 설치한 CA 전체·인증서 오류 무시·암호화 안 된 http 는 쓰지 않는다.
- 관문이 다른 CA 로 바뀌면 연결이 거부된다(새 APK 필요).
- 앱 로그(Capacitor)는 꺼져 있다(`loggingBehavior=none`) — 로그인 인자가 기기 로그에 안 찍힌다. 10-13 이전 빌드(로그 켜짐)는 실계정에 쓰지 않는다.

## 연결이 안 되는 경우

- **관문 서버가 꺼져 있으면 연결 안 됨.** 앱은 서버 없이 조종하지 못한다.
- 이 앱은 `/api/app/*` 경로가 있는 관문(`sim/v2_gate.py` + `sim/app_auth.py` 판)에만 로그인된다. 옛 정본 운영 체크아웃(83b25ca)에만 이 경로가 없다. **현재 사용자용 서버(10-14 17:16, r8)**: UI `7e644fa` 관문이 같은 운영 CA 로 포트 8453 에 떠 있고 앱 경로(B, `/api/app/*`)가 준비됨(UI mentor 1회 확인: LAN·tailnet 두 주소 CA 검증 200, `/api/app/health` 200, 서빙 143개 sha 목록 일치, 원물 UI 쪽 `runs/ui-improve-20261014/MANIFEST-serve-r8.md`) — **그 관문이 꺼지면 연결 안 됨.** (역사: 10-14 01:00 에는 UI `75c0611` 사본 관문이 같은 CA·포트로 떠 있었다 — 지금 서버 아님.) 주소 값은 이 문서에 적지 않는다 — 이 PC 의 `mobile/out/INSTALL-LOCAL-20261014.txt`(git 제외)에 있다.
- 넣은 주소가 인증서 이름과 다르면 인증서 오류로 거부된다(무시하고 진행하는 버튼 없음).

## 확인 안 한 것

실제 휴대폰 설치·실행 · 실폰 QR 스캔·카메라 권한 창·WebView BarcodeDetector · 네이티브 probe 실호출 · iOS(빌드 없음) · 이 dev 빌드의 실계정 로그인 · B2 저장 창 · 관문 주소 수정 · 실기기에서 운영 CA 신뢰 · HOME(앱 숨김) 때 앱 쪽 신호 · 앱 복귀(B7)·로그아웃(B8) 실행 · 물리 정지(STOP 명령 0 ≠ 정지).
에뮬레이터 bundled 시험 2회차(`runs/mobile-b-bundled-20261013-2`, fixture 빌드)는 **미완료**: 로그인·Keystore 복원·WS 표·take·HOME 서버 해제까지 PASS, HOME 때 OS 신호 FAIL, 복귀·로그아웃은 실행 전 멈춤.
이 APK 는 빌드·APK 구조 대조만 했다(`runs/mobile-dev-apk-20261014-mapopen-1` 30항목 ALL PASS — 앱 id·서명(옛 dev 판과 같은 인증서)·NSC·CA 한 장·권한 3개·`server.url` 없음·로그 끔·UI 번들 143개 sha·Go2Direct 연결부 0). 새 지도 열기·PIP·높이 표시의 실제 화면 동작은 이 문서 범위 밖(UI 쪽 검수).

## 다시 빌드할 때

`FH_GATE_CA=<운영 관문 ca.crt> node scripts/gate-profile.mjs --dev`(공개 CA 한 장만 검사해 `android/app/src/dev/res/raw/` 에 생성, git 제외) → `./gradlew assembleDev` → 끝나면 `--clean`. 실제 쓴 스크립트 사본 `runs/mobile-dev-apk-20261014-mapopen-1/dev-build-mapopen.sh`. 개인키·계정·토큰 파일은 읽지 않는다.

## 새 APK 전달(10-14~)

새 frozen APK 가 완성되면 원물 경로·SHA-256·UI/native 판·변경점·검증 한계를 한 묶음으로 **위키 단독 담당**에게 «게재 요청 + 검증 원물»로 넘긴다(위키 다운로드 탭에 버전별 게재). 앱 Codex 에도 같은 보고. 위키 사이트 수정·배포는 위키 담당만 하고, 모바일 쪽은 GitHub push·PR·사이트 업로드를 하지 않는다. 이 문서에는 파일 경로·SHA 만 적고 실주소는 적지 않는다.

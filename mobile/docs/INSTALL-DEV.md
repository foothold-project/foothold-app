# 개발용 Android APK 설치 안내 (2026-10-14)

**스토어 판이 아니다.** 개발·시험용(debug 키 서명, 앱 id `org.footholdproject.app.dev`). Android 전용 — iPhone 용은 없다(Mac 없음).

## 파일

| 항목 | 값 |
|---|---|
| 파일 | `mobile/out/foothold-android-dev-20261014.apk`(git 제외) · 사본 `~/Downloads/foothold-android-dev-20261014.apk` |
| SHA-256 | `263b1bbe2fdb4b01bfa8a3b28a6a442e1a88403ac1927628f1a012688b8c3550` |
| 화면(UI) 판 | `75c06111e829a799b9930095b366dc613df6eba8` — B2 저장·관문 주소 저장 포함 검수판, 파일 141개 sha 일치 |
| 모바일 판 | 이 문서를 넣은 커밋(dev 빌드 타입). 빌드 당시 소스 = `c2ecab3` + 이 커밋의 dev 변경 |
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
- 이 앱은 `/api/app/*` 경로가 있는 관문(`sim/v2_gate.py` + `sim/app_auth.py` 판)에만 로그인된다. 운영 체크아웃(83b25ca)에는 이 경로가 없다. 10-14 01:00 에 UI `75c0611` 사본 관문이 같은 운영 CA 로 포트 8453 에 떠 있다(UI mentor 확인: LAN·tailnet 주소 둘 다 인증서 SAN 일치, 서버 인증서 만료 2027-11-07, 몸 상태 링크는 빈 상태) — **그 관문이 꺼지면 연결 안 됨.** 주소 값은 이 문서에 적지 않는다.
- 넣은 주소가 인증서 이름과 다르면 인증서 오류로 거부된다(무시하고 진행하는 버튼 없음).

## 확인 안 한 것

실제 휴대폰 설치·실행 · 이 dev 빌드의 실계정 로그인 · B2 저장 창 · 관문 주소 수정 · 실기기에서 운영 CA 신뢰 · HOME(앱 숨김) 때 앱 쪽 신호 · 앱 복귀(B7)·로그아웃(B8) 실행 · 물리 정지(STOP 명령 0 ≠ 정지).
에뮬레이터 bundled 시험 2회차(`runs/mobile-b-bundled-20261013-2`, fixture 빌드)는 **미완료**: 로그인·Keystore 복원·WS 표·take·HOME 서버 해제까지 PASS, HOME 때 OS 신호 FAIL, 복귀·로그아웃은 실행 전 멈춤.
이 APK 는 빌드·APK 구조 대조만 했다(`runs/mobile-dev-apk-20261014-1` ALL PASS — 앱 id·서명·NSC·CA 한 장·`server.url` 없음·로그 끔·UI 번들 sha).

## 다시 빌드할 때

`FH_GATE_CA=<운영 관문 ca.crt> node scripts/gate-profile.mjs --dev`(공개 CA 한 장만 검사해 `android/app/src/dev/res/raw/` 에 생성, git 제외) → `./gradlew assembleDev` → 끝나면 `--clean`. 실제 쓴 스크립트 사본 `runs/mobile-dev-apk-20261014-1/dev-build.sh`. 개인키·계정·토큰 파일은 읽지 않는다.

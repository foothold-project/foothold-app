# GitHub 작업 방식 — 앱(UI + mobile) (2026-10-14)

이 저장소는 **공개(PUBLIC)** 다. 올린 것은 누구나 본다. 아래는 앱 코드(ui·mobile 과 그 통합)에만 적용한다. 팀 inbox·학습·다른 저장소는 해당 없음.

## 1. 브랜치

| 브랜치 | 내용 | 누가 |
|---|---|---|
| `feature/two-device` | 저장소 기본 브랜치(현재). `main` 은 없다 | 기본 브랜치·`main` 설정 변경 0 |
| `less82/app-ui-react-recovered` | UI·서버·계약·시뮬 개발 | UI 담당 |
| `less82/app-contract-storage` | `mobile/**`(Capacitor 외피·네이티브 플러그인) 개발 | 모바일 담당 |
| `less82/app-platform-integration` | **UI final 위에 `mobile/**` 만 얹은 단일 통합.** Draft PR 은 이 브랜치 하나 | 통합 담당, 출처는 `docs/PROVENANCE-app-platform-integration.md` |

- 통합 브랜치는 **처음 한 번만** UI final 커밋에서 만들고 `mobile/**`(+ 이 문서·출처 문서·`.gitignore` 보강)만 더한다(+ 루트 `README.md` 맨 앞 «현재 통합 개발판» 안내 — 기존 본문 보존). `server/`·`contracts/`·`sim/`·`ui/` 는 UI final 그대로 — 옛 모바일 브랜치 판으로 덮지 않는다.
- **그 뒤에는 앞으로만 전진한다**(원격 통합 브랜치를 다시 만들거나 force push 하지 않는다): 기존 통합 HEAD 에 검토된 새 UI final 을 로컬에서 일반 merge(또는 선택 반영)하고, 현재 모바일 출처의 `mobile/` 트리 스냅샷을 새 커밋으로 얹는다. 이 «로컬 통합 merge» 는 원격 기본 브랜치·PR 의 merge 와 다르다.
- merge 충돌은 파일별로 검토한다. 범위 밖(`mobile/`·두 문서·`.gitignore`·`README.md` 밖) 충돌이면 멈추고 보고한다. 옛 모바일 브랜치의 `server/`·`contracts/`·`sim/` 은 들이지 않는다.
- 검사(매 통합 커밋, 그때의 출처 기준): `HEAD:mobile` 트리 = 현재 모바일 출처 커밋의 `mobile` 트리, `HEAD:ui` 트리 = 현재 UI final 의 `ui` 트리, `git diff --name-only <현재 UI final> HEAD` 는 `mobile/`·이 두 문서·`.gitignore`·`README.md` 뿐.

## 2. 커밋·push·PR

- 커밋은 **의미 있는 기능 단위**(시험 통과 여부와 무관하게 «무엇이 바뀌었나» 하나). 메시지 첫 줄에 영역(`mobile:`·`ui:` 등), 본문에 검증 상태(아래 4절)를 적는다.
- 개발 브랜치는 일반 push(`git push origin <브랜치>`). force push 0. 검증 안 된 커밋은 본문에 «미검증»을 명시한다.
- 통합은 Draft PR 하나: `less82/app-platform-integration` → base `feature/two-device`(현재 기본, 2dfc0e9) 그대로. 새 UI final 은 위 1절대로 통합 브랜치에 전진 반영하고 출처 문서를 갱신한다.
- **이번 작업 범위에서는** PR merge·기본 브랜치·`main` 설정 변경 0. 앞으로 검증된 PR 을 기준 브랜치에 반영하는 일은 저장소 소유자의 검토·권한에 따라 별도로 정한다.
- 기존 UI PR(#1)은 UI 담당 소유 — 상태 최신화와 통합 PR 연결만. 닫기·merge·기본 브랜치·`main` 설정 0.
- 통합 브랜치는 `mobile/**` 선택 스냅샷이다. 옛 모바일 브랜치의 `sim/`·`server/`·`contracts/` 이력을 merge 하지 않는다.
- 작성자는 GitHub noreply 메일만. 개인 메일·실명 메일 0.

## 3. APK 배포(GitHub prerelease)

- 태그 하나 = APK 하나: `dev-YYYYMMDD-<이름>`(예 `dev-20261014-center`), 최종 통합 커밋에 단다. **prerelease 로만**(latest·정식 release 0). 공개(published)는 통합 책임자의 별도 GO 뒤.
- 첨부는 셋뿐: APK 1개 · `SHA256SUMS.txt` · 공개용 `BUILD-INFO.md`(UI·native·통합 커밋 해시, 빌드 OS, debug 서명(개발 키, 정식 서명 아님), 관문 CA 공개 지문, 검증 상태와 미검증 범위). 원시 `runs/`·비공개 자료·빌드 `dist`·APK 는 git 커밋 0.
- **버전:** APK 마다 `versionCode` +1, `versionName` 은 `1.0.N`(dev 판 표시 `1.0.N-dev`). 바꾸는 곳은 `mobile/android/app/build.gradle` 두 값뿐. 첫 판 `dev-20261014-center` = code 2 · `1.0.1-dev`. 그 전 개발 APK 7개는 code 1 · `1.0-dev` 로 이력 유지(GitHub 재업로드 없음, 위키 링크 보존).
- 이미 올린 태그·첨부는 지우거나 바꾸지 않는다(링크 보존). 고칠 일이 생기면 새 태그.
- 위키 다운로드 탭은 버전 목록으로 이 prerelease 들을 가리킨다(위키 담당이 관리, 기존 URL 보존).
- iOS IPA 없음(Mac 없음).

## 4. 검증 상태 표기

| 표기 | 뜻 |
|---|---|
| 미검증 | 빌드·정적 검사까지. 실행 안 함 |
| 에뮬 검증 | Android 에뮬레이터에서 정한 시나리오 통과. 실폰 아님 |
| 실폰 검증 | 실제 휴대폰 설치·실행 확인(기종·Android 판 명시) |
| 실기 검증 | 실제 로봇과 연결 확인 |

- «release 완료»·«전체 검증 통과»라고 쓰지 않는다. STOP 명령 송신 0 은 물리 정지가 아니다.
- 현재 한계: Go2Direct 는 순수 코어·시험만이고 Android 플러그인·실제 UDP/HTTP Port 는 미구현(실로봇 연결 불가).

## 5. 올리지 않는 것

- `.gate/`(관문 CA·키·계정·토큰) · `runs/` · 영상·사진·지도·점군(`media/`·`maps/`) · 빌드 생성물(`dist/`·`www/`·`out/`·`build/`) · `node_modules/`·`venv/` · APK/AAB · 생성 CA·인증서·개인키(`*.pem`·`*.key`·`*.crt`) · 서명 키(`*.jks`·`*.keystore`·`*.p12`) · `local.properties`.
- 실 IP(LAN·tailnet)·호스트 이름·사용자 홈 경로·계정·비밀번호. 시험 코드의 주소는 사설 대역 예시 값만.
- 브랜드 아이콘은 공식 브랜드 저장소 래스터에서 파생(출처 커밋·sha 는 `mobile/README.md`). 원본은 브랜드 저장소가 정본.
- push 전: `git diff --name-only <원격 끝> HEAD` 와 추가 줄에서 위 항목을 검사한다.

## 6. 되돌리기

- 코드: 문제 커밋을 `git revert` 해서 새 커밋으로 push. 이력 덮기(force)·삭제 0.
- APK 되돌리기의 기본 경로: 앞의 안정 UI·native 소스로 **새 APK 를 다시 빌드**해 versionCode 를 더 올린 새 태그로 낸다. 같은 개발 키 서명이라 덮어 설치(업데이트)되고 사용자 데이터는 지워지지 않는다(실폰 미확인). 앞 prerelease 는 그대로 남는다.
- 참고(기본 경로 아님): versionCode 가 낮은 옛 APK 는 Android 가 덮어 설치를 막는다. 앱 삭제를 되돌리기 방법으로 권하지 않는다.

## 7. 코드 push ≠ 앱 업데이트

- push 해도 이미 깔린 앱은 바뀌지 않는다. 화면(UI 번들)은 APK 안에 들어 있어 새 APK 를 설치해야 바뀐다. 자동 업데이트·원격 코드 내려받기 없음.
- 반대로 관문(서버) 쪽 변경은 APK 를 바꾸지 않아도 앱 동작(로그인·데이터)에 영향을 줄 수 있다. 서버 판과 APK 판을 같이 적는다.

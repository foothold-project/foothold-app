# 통합 브랜치 출처 — less82/app-platform-integration

이 브랜치는 **UI final 위에 `mobile/**` 스냅샷만 얹은 것**이다(옛 모바일 브랜치와의 merge 아님 — 최초는 UI final 에서 생성, 이후 새 UI final 은 로컬 일반 merge 로 전진). 옛 모바일 브랜치의 `sim/`·`server/`·`contracts/` 판과 그 이력은 가져오지 않는다.

| 부분 | 출처 커밋 | 트리 해시 | 비고 |
|---|---|---|---|
| 현재 최종 UI — `ui/`·`server/`·`contracts/`·`sim/`·`web/`·`tests/`·`tools/` 등 | `83154335e92d000d278ec2297517631523d5675a` (`less82/app-ui-react-recovered`, 부모 `ebe65e5` 직전 APK13 판, 중간 후보 `eeadd77` 을 대신하는 최종판 — `ui/` 12파일 + ui 밖 11파일(`contracts/v1` 문서·스키마·ts, `server/runcas.py`, `sim/v2_link.py`, `tests/backend` 2) — ui 밖 11파일은 backend 호환 판 `902c916` 과 같음) | `ui` = `ea3b74d882d15aa8a0df6a7805972f522938bc98` | 그대로(ui·server·sim·contracts·tools·tests 트리 = `8315433`) |
| `mobile/**` | `59cf3b25edb5321ccd166bb59e6addae945557f5` (`less82/app-contract-storage`) | `mobile` = `9922832a3a50bc0eb47293db47cffb0c9adfb8a9` | 파일 단위 변경 0. 직전 `b84c32e`(트리 `1269dfe`, APK13) 대비 build.gradle 두 줄: versionCode 14 · `1.0.13` (`-dev` suffix 그대로) — native 소스·권한·인증·관문 op·서명 변경 0 |
| `docs/PROVENANCE-app-platform-integration.md`(이 문서) · `docs/GITHUB-WORKFLOW.md` · 루트 `.gitignore` 경로 보강 · 루트 `README.md`: 맨 위는 UI 후보의 새 머리 그대로, 그 아래 «이전 통합 개발판 기록(2026-10-17 · APK10)» 절에 직전 통합 머리 전체 보존, 옛 web 기록 1벌(10-18 merge 충돌 해소) | 이 브랜치에서 추가 | — | 작업 방식은 GITHUB-WORKFLOW.md |

검사(통합 커밋마다): `git rev-parse HEAD:mobile` = 위 mobile 트리, `git rev-parse HEAD:ui` = 위 ui 트리, `git diff --name-only 83154335e92d000d278ec2297517631523d5675a HEAD` 는 `mobile/`·위 두 문서·`.gitignore`·`README.md` 뿐. (APK10 빌드 통합 `c0f031e` 의 기준은 `e0abe98` — 그 뒤 서버 fix merge 로 `sim/`·`tools/` 만 달라졌고 ui·mobile 트리는 같다.)

서버 사진 저장 fix `0ae1245`(10-17, 부모 UI `e0abe98`): 사진 저장 처리의 미정의 변수 오류(NameError) 1줄 수정 + 회귀 시험. 서버 쪽 코드라 APK 와 무관 — APK10 `dev-20261017-slamstart` 은 이 fix 전 `e0abe98` 화면 파일로 빌드한 그대로이고, 사진 응답은 연결한 운영 서버 판에 따른다. 운영 반영은 10-17 서버 교체 뒤 운영 쪽 상태 점검 통과까지(실제 사진 촬영 동작 확인은 아님).

native 변경(10-18 `fcb212e`): `FhGateCore` 고정 op 에 `rehearsal.get`(GET `/api/app/rehearsal`, 200 만 통과)·`rehearsal.post`(POST 같은 경로, 200·400·403·404·409·413·422·500·503·507 은 status 로 화면까지) 두 개만 추가. 권한·인증·토큰·WS·주소·서명·TTL·STOP·본문 상한(1 MiB) 변경 0, 재시도 0. 시험 `FhGateCoreTest` 34/34(JVM 단위 — Android 빌드·실폰 아님). 리허설 화면은 계획 작성 기능이며 실제 연결 로봇·Gazebo 물리 리허설·Nav2 결과가 아니다.

한계(이 판): Go2Direct 는 순수 코어·JVM 시험만 — Android 플러그인과 실제 UDP/HTTP Port 는 미구현(실로봇 연결 불가). 실폰·iOS·실기 확인 0.

## 다음 판 준비 — Android 개발 APK code 14 · `1.0.13-dev` (10-19, **빌드 0**)

이 통합 커밋은 빌드 전 준비다. APK 빌드·구조 대조·실행은 아직 하지 않았다. push·tag·공개 업로드 0. 아래 APK13 절의 «이 절을 쓴 문서 커밋» 은 `58ffa44` 를 말하며, APK13 빌드 입력(`3076979`)·APK·BUILD-INFO·SUMS 는 바뀌지 않는다.

- 예정 입력: 이 브랜치 통합 커밋(ui 트리 `ea3b74d882d15aa8a0df6a7805972f522938bc98` = 최종 웹 `83154335e92d000d278ec2297517631523d5675a`, mobile 트리 `9922832a3a50bc0eb47293db47cffb0c9adfb8a9` = `59cf3b2`) + frozen 화면 파일 `frozen-8315433`(184개 — `.map` 38 제외 146개가 번들 예정, 목록 TSV sha256 `d656fe738e49768dab8b240d3bb55fc6fe271699be2b3310880c778ec4987dfd`, index.html sha256 `e5032a42020dc94fb934fe8ed105741b97b617d1e4f48a2eadf13dabca25c5cb`). 중간 후보 `eeadd77`·`f13e0a2` 의 화면 파일과 섞지 않는다
- 최종 UI 통합: `8315433` 은 `eeadd77` 의 후손이 아니라 `ebe65e5` 의 단일 부모 최종판이라, normal merge 에서 `eeadd77` 과 다른 3파일(`ui/src/screens/PcPlan.tsx`·`PcPlan.view.tsx`·`ui/tests/unit/pcplan2d_mount.test.ts`)이 충돌했고 그 3파일만 `8315433` 원문으로 해소했다(merge `138c556`). 결과 ui 트리 = `8315433` ui 트리, ui 밖 코드 = `8315433`, mobile 트리 = `59cf3b2`
- 서버 호환 근거: APK-COMPAT `0b18a806` 및 최종 `8315433` 후속 `6b39a072`. Mission·Run 종료 방식 선택 키를 서버 계약에 추가, native 호출면·새 op 변경 0. 새 계획 종료 방식이 있는 자료는 새 서버가 필요하고 APK13 으로 진행하면 409 가 날 수 있다
- 화면 변경 범위(UI 판 기준, 이 문서는 요약만): 임무 탭의 첫 동작 = 새 임무 만들기(지형·층 → 2D 지도 → 목적지·지점 → 할 일 프리셋 → 종료/복귀 방식 확인 → 이름 붙여 저장 → 다시 열어 수정). 서버 쪽은 종료/복귀를 이름·메모 추정이 아닌 계약 구조로 저장하는 최소 계약
- 미포함(단정): 새 임무는 **계획 생성·저장·수동 진행** 범위다 — 실제 자동 이동·도착 사진·자동 복귀 엔진은 미구현·미검증이다. 도면 업로드·세계 생성·Gazebo 기동·Nav2 실행은 이 판에 없다
- 미완료: 715 최종 후보 검토 · 670 화면 QA(E8·E9) · R33 · 운영 웹 반영. 끝나기 전에는 빌드하지 않는다

## 로컬 빌드 — Android 개발 APK code 13 · `1.0.12-dev` (10-18, **로컬 빌드 1회 · 공개 0**)

빌드 입력은 통합 `3076979c1dbe087f1786eab1050da06f0e692e70`(ui 트리 `cb2e269dc56266b99af06cf814c72b2422a04662` = 최종 웹 `ebe65e5859504466856be0616c1759c497c38145`, mobile 트리 `1269dfe2a7dcd71a451059865591cd087a77eac4` = `b84c32e`)과 frozen 화면 파일 `frozen-ebe65e5`(184개 — `.map` 38 제외 146개가 번들, 목록 TSV sha256 `ac11ed9809662ccff1553e71608e418a2f41e553838c2d34f6a4291c1516b37c`, index.html sha256 `8fd5f0e468c719729e08e4e914ad492a57ada6acd775e95dd622a924a3eea190`)이다. 이 절을 쓴 문서 커밋은 문서만 바꿔 ui·mobile 트리가 빌드 입력과 같다. push·tag·공개 업로드 0.

| 무엇 | 대상 | 결과 | 범위·한계 |
|---|---|---|---|
| APK 구조 대조 | `foothold-android-dev-20261018-floor-mission.apk` sha256 `dbece68e6f4d82049cc2c4745af54a516c08261c42b7ffeb5cd2746efa47b27b`(7579182 bytes) | 28/28 통과 | 앱 id·버전 13·`1.0.12-dev`·서명(옛 개발판과 같은 디버그 인증서)·CA 한 장·권한·server.url 없음·관문 고정 op `rehearsal` 2개·SOURCE ui 판 `ebe65e5`·화면 파일: frozen 원본 184개 sha 일치(빌드 뒤 무변경) + APK 번들 .map 제외 146개 파일별 sha 일치. 실행 동작은 이 대조 범위 밖 |
| 빌드 자원 한도 | 전용 사용자 scope(메모리 2 GiB·swap 0·CPU 200%·프로세스 384·최대 300 s) 안에서 한 번 | 빌드 rc 0 · OOM 0 · 프로세스 한도 도달 0 · 빌드 뒤 남은 프로세스 0 · scope 메모리 최고 약 1.11 GiB | 빌드 전 여유 메모리 기준은 4000 MiB(이 판 한정, 이 scope 한도와 함께일 때만 — APK12 같은 scope 실측 근거) · 디스크 2048 MiB·load 기준·힙·작업자 수 그대로 |

- 화면 변경 범위(UI 판 기준, 요약): 시뮬은 늘 새 SLAM 으로 시작하고(기존 `map_start` slam 형식) 같은 층 저장 지도 그림을 먼저 보여 준 뒤 검증된 실시간 지도로 바꾼다 · 시작 상자의 저장 지도/새 지도 선택 삭제 · 위쪽 시뮬 메뉴 삭제(초기화는 본문 시뮬 칸) · 메뉴 «관제» = 전체 관제, 지도 편집은 지도 화면에서 진입 · 임무 화면은 기존 계획 화면 2열 재배치. 서버 쪽은 저장 지도 meta reason `floor_leave` 허용뿐 — 새 WS op·native 변경 0
- 미포함(단정): 저장 지도 그림 표시 ≠ SLAM graph 복원·현재 위치 정합·이어 그리기. 임무 화면의 가스 측정·AI 탐지·자동 주행·자동 후퇴는 작동 기능이 아니다. Fleet·지도 편집기의 로봇 추가/경로·배치 비교는 계획 작성 기능이다

미측정: 이 APK 실행(에뮬·실폰·WebView)·실 로그인·파일 저장·실기·Nav2·물리 리허설·실제 Gazebo 기동·층 이탈 자동 저장의 실제 도착(APK 를 새로 만든 것 ≠ 서버 지원).

## 로컬 빌드 — Android 개발 APK code 12 · `1.0.11-dev` (10-18, **로컬 빌드 1회 · 공개 0**)

빌드 입력은 통합 `544817cfa21abf8fe8c2fcefe1ee7d746d3708a5`(ui 트리 `f5ace9fba99f75f649b1db81bacfa97824da7008` = 최종 웹 `59e0c5a5827991358611761326cbe47f1402c49d`, mobile 트리 `9b38ccc9c6610ad3643f71d7c998ff762e90eb14` = `03c2a52`)과 frozen 화면 파일 `frozen-59e0c5a`(184개 — `.map` 38 제외 146개가 번들, 목록 TSV sha256 `0c87b818571baaf052244ca3400f32831459ffe161f0903b67a51362ef19e0f3`, index.html sha256 `47eeb8305c8c24e07f37c00500290188c8824fc9fdb634a674d1632b0eaa1c93`)이다. 이 절을 쓴 문서 커밋은 문서만 바꿔 ui·mobile 트리가 빌드 입력과 같다. push·tag·공개 업로드 0.

| 무엇 | 대상 | 결과 | 범위·한계 |
|---|---|---|---|
| APK 구조 대조 | `foothold-android-dev-20261018-savedmap.apk` sha256 `79e6da0e7bdfd9ef02383aa844f2c8ebf93f46f2b5031393832c2587ade4a0fc`(7582418 bytes) | 28/28 통과 | 앱 id·버전 12·`1.0.11-dev`·서명(옛 개발판과 같은 디버그 인증서)·CA 한 장·권한·server.url 없음·관문 고정 op `rehearsal` 2개·SOURCE ui 판 `59e0c5a`·화면 파일: frozen 원본 184개 sha 일치(빌드 뒤 무변경) + APK 번들 .map 제외 146개 파일별 sha 일치. 실행 동작은 이 대조 범위 밖 |
| 빌드 자원 한도 | 전용 사용자 scope(메모리 2 GiB·swap 0·CPU 200%·프로세스 384·최대 300 s) 안에서 한 번 | 빌드 rc 0 · OOM 0 · 프로세스 한도 도달 0 · 빌드 뒤 남은 프로세스 0 · scope 메모리 최고 약 1.34 GiB | 빌드 전 여유 메모리 기준은 5000 MiB(이 scope 한도와 함께일 때만) · 디스크 2048 MiB·load 기준·힙·작업자 수 그대로 |

- 화면 변경 범위: PC 메뉴 아이콘·이름 가독성 복구 · 시뮬 시작의 «시작 지도» 기본 = 고른 지형·층의 저장 SLAM 지도로 열기(기존 `map_start` static + 목록에 있는 `map_version`), «새 지도 만들기» 는 직접 고를 때만. 서버·계약·native op·센서 변경 0
- 미포함(단정): 저장 지도 열기는 **저장 지도를 그림으로 보기**만 기본으로 한다 — 로봇 현재 위치를 그 지도에 맞추기(정합)·이어 그리기·다른 층 지도 자동 복원은 포함하지 않는다. 실제 Gazebo 기동은 이 판에서 측정하지 않았다

미측정: 이 APK 실행(에뮬·실폰·WebView)·실 로그인·파일 저장·실기·Nav2·물리 리허설·실제 Gazebo 기동(APK 를 새로 만든 것 ≠ 서버 지원).

## 로컬 빌드 — Android 개발 APK code 11 · `1.0.10-dev` (10-18, **로컬 빌드 1회 · 공개 0**)

빌드 입력은 통합 `6d6cfdecf42d5fc94079020552d0219a88d26a30`(ui 트리 `c415ca3`, mobile 트리 `5769f47`)과 frozen 화면 파일(UI `0314495`, 184개 — `.map` 38 제외 146개가 번들)이다. 이 문서 커밋은 문서만 바꿔 ui·mobile 트리가 빌드 입력과 같다. push·tag·공개 업로드 0.

| 무엇 | 대상 | 결과 | 범위·한계 |
|---|---|---|---|
| APK 구조 대조 | `foothold-android-dev-20261018-fleet.apk` sha256 `ae2a73f9ce5fd3abc597c8408755e6ec0b282a2b9f565bb33d10ce1743904267`(7579798 bytes) | 28/28 통과 | 앱 id·버전 11·`1.0.10-dev`·서명(옛 개발판과 같은 디버그 인증서)·CA 한 장·권한·server.url 없음·관문 고정 op `rehearsal` 2개·화면 파일: frozen 원본 184개 sha 일치(빌드 뒤 무변경) + APK 번들 .map 제외 146개 파일별 sha 일치. 실행 동작은 이 대조 범위 밖 |

미측정: 이 APK 실행(에뮬·실폰·WebView)·실 로그인·리허설 저장/파일 저장·실기·Nav2·물리 리허설. 새 화면의 저장·분석은 새 서버 API 가 필요하다(APK 를 새로 만든 것 ≠ 서버 지원).

## 검증 실행 범위 — Android 개발 APK `dev-20261017-slamstart` (10-17)

APK 출처: **APK = frozen 화면 파일(UI `e0abe98`, 화면 파일 174개 — `.map` 33 제외 141개가 번들) + native(`mobile/` 위 트리)만.** 이 브랜치의 `server/`·`sim/`·`contracts/` 는 APK 에 들어가지 않고, 이 통합에서 실행·운영 반영하지 않는다.

| 무엇 | 대상 | 결과 | 범위·한계 |
|---|---|---|---|
| UI 코드 좁은 검토 | UI `e0abe98`(직전 `e825600` 대비 화면 5파일 + 시험 6파일) | 지정 범위 통과 | 시작 확인 수명·같은 기기 STOP 취소·요청 결과 문구. 다른 기기 STOP 세대·카메라 지원 변화 전 범위는 보장 범위 밖. UI 쪽 제출 기록(이 통합에서 재실행 0) |
| UI 화면 QA | UI `e0abe98` 웹 화면 · Chrome PC 폭·폰 폭 390 · 격리 시험 서버·가짜 응답(시작 요청은 보내기 전 차단) | 지정 범위 측정 통과 | 시작 확인 3경로 각 요청 1건 · 취소 3경로 보낸 것 0 · 확인창 8개 화면 안·겹침 0. 전체화면 중 확인창 미측정 · 폰 폭 결과 줄은 서랍 아래. 실제 서버 수락·Gazebo/SLAM 기동·실폰 범위 밖 |
| 운영 서버 호환 | UI `e0abe98` ↔ 운영 기준판 `5f39a23` | 소스 읽기 대조 일치 | `sim`·`server`·`contracts`·`tools`·`ui/package.json`·잠금 파일·빌드 설정 트리 해시 같음 · 화면 송신 명령 21종 모두 서버에 있음(`e825600` 대비 `sim_start` 한 줄 빠짐) · 네이티브 플러그인 호출면 `e825600` 과 같음. 지도 시작 때 센서 구성은 운영 PC 쪽 시작 스크립트가 정함(APK 무관). 알려진 서버 결함: 사진 저장 처리 기존 오류(APK 로 해결 안 됨) |
| APK 구조 대조 | `foothold-android-dev-20261017-slamstart.apk` sha256 `f10fbd348ff1ff103a5d652286cd1fec78cc6cbe08d8b9350b227027d70f9f62`(7533883 bytes, 통합 `c0f031e` 에서 빌드, 이 문서 커밋과 ui·mobile 트리 같음) | 27/27 통과 | 앱 id·버전 10·`1.0.9-dev`·서명(옛 개발판과 같은 디버그 인증서)·CA 한 장·권한·server.url 없음·화면 파일: frozen 원본 174개(.map 33 포함) sha 일치 + APK 번들 .map 제외 141개 파일별 sha 일치. 실행 동작은 이 대조 범위 밖 |
| 실APK 실행(에뮬) | 위 APK | 실행 0 | 디스크 여유가 에뮬 조건(8192 MiB)에 못 미침 |
| 빌드 자원 | 저메모리 1회 빌드(Gradle daemon 없음·작업자 1·힙 1024 MiB, 시작 기준 여유 메모리 5500 MiB) | 빌드 rc 0, 남은 Gradle daemon 0 | 1 s 관측: 빌드 프로세스 RSS 최대 734 MiB · 시스템 여유 메모리 최소 5157 MiB(관측 기록이지 상한 보장 아님) |

### 직전 공개 판 — Android 개발 APK `dev-20261016-simplify` (10-16)

APK 출처: **APK = frozen 화면 파일(UI `e825600`, 화면 파일 174개 — `.map` 33 제외 141개가 번들) + native(`mobile/` 위 트리)만.** 이 브랜치의 `server/`·`sim/`·`contracts/` 는 APK 에 들어가지 않고, 이 통합에서 실행·운영 반영하지 않는다. 통합 뒤 backend 쪽 파일이 바뀌어도 APK 내용과 무관하다.

| 무엇 | 대상 | 결과 | 범위·한계 |
|---|---|---|---|
| UI 코드 좁은 검토 | UI `e825600`(직전 `055824d` 대비 6파일 +76/−11) | 지정 범위 통과 | UI 단위 시험 영향 21파일 166/166 · 전체 44파일 369/369 · 빌드 exit 0 은 UI 쪽 제출 기록(이 통합에서 재실행 0) |
| UI 화면 QA | UI `e825600` 웹 화면 · Chrome 화면 폭 1440·1280·390·844 · 격리 시험 서버·가짜 생산자 | 지정 범위 새 차단 0 | 남은 관찰: PC 첫 화면 «설정» 메뉴 아래로 밀림(스크롤 접근 가능) · 사건 기록 아래로 감(배치 요청대로) · 큰 칸(PIP)·전체화면 누름 미측정. 관제 STOP 사각형 높이 52 px(지도 화면 64 px 검사와 별개). 실 로그인·명령·로봇 정지 범위 밖 |
| 운영 서버 호환 | UI `e825600` ↔ 운영 기준판 `5f39a23` | 소스 읽기 대조 일치 | `sim`·`server`·`contracts`·`tools`·`ui/package.json`·잠금 파일 트리 해시 같음 · 화면 송신 명령·HTTP 경로·문서 판 번호 필드 같음 · 네이티브 플러그인 호출면 `53aba2f` 와 같은 7종. 운영 실제 응답·지금 운영 판 재확인은 범위 밖 |
| APK 구조 대조 | `foothold-android-dev-20261016-simplify.apk` sha256 `a7c2eeb251252e221fadb32d1ff11c7be095383644e36b191e7f98bb96f2ddd1`(7533299 bytes, 통합 `120870a` 에서 빌드, 이 문서 커밋과 ui·mobile 트리 같음) | 27/27 통과 | 앱 id·버전 9·`1.0.8-dev`·서명(옛 개발판과 같은 디버그 인증서)·CA 한 장·권한·server.url 없음·화면 파일: frozen 원본 174개(.map 33 포함) sha 일치 + APK 번들 .map 제외 141개 파일별 sha 일치. 실행 동작은 이 대조 범위 밖 |
| 실APK 실행(에뮬) | 위 APK | 실행 0 | 디스크 여유가 에뮬 조건(8192 MiB)에 못 미침 |
| 빌드 자원 | 저메모리 1회 빌드(Gradle daemon 없음·작업자 1·힙 1024 MiB) | 빌드 rc 0, 남은 Gradle daemon 0 | 1 s 관측: 빌드 프로세스 RSS 최대 764 MiB · 시스템 여유 메모리 최소 5164 MiB(관측 기록이지 상한 보장 아님). APK 바이트가 빌드 옵션과 무관함은 비교하지 않음 |

### 이전 공개 판 — Android 개발 APK `dev-20261015-viewfix` (10-15)

| 무엇 | 대상 | 결과 | 범위·한계 |
|---|---|---|---|
| UI 최종 소비자 검수 | UI `53aba2f`(화면 파일 143개, `.map` 제외) | 통과 | 이 행은 가짜 생산자·격리 연결 검사 범위 — 실제 생산자(실 Gazebo·SLAM·라이다) 연결은 이 검사에서 다루지 않음(실제 Gazebo 조종 1회는 아래 행) |
| APK 구조 대조 | `foothold-android-dev-20261015-viewfix.apk` sha256 `7f381ae4e13afdd84076bf929a3b19c1cf63290f93125a14f686adf65e4411d0`(통합 `ecf388b` 에서 빌드, 이 문서 커밋과 ui·mobile 트리 같음) | 27/27 통과 | 앱 id·버전 8·`1.0.7-dev`·서명·CA 한 장·번들 파일별 sha(143)·server.url 없음 등. 실행 동작은 이 대조 범위 밖 |
| 실APK 실행(에뮬) | 위 APK | 실행 0 | 디스크 여유가 에뮬 조건(8192 MiB)에 못 미쳐 이번 판은 실행하지 않음 |
| 실제 Gazebo 조종 1회 | 개발 관문 웹 화면 = UI `53aba2f`(APK 아님) · 임시 시험 계정 · PC Chrome 1280×800 / Chrome iPhone 390×844 에뮬레이션 각 1회 | 조종 시작 확인 1회·앞 누름 서버 적용·놓은 뒤 출력 0·STOP 잠금·조종권 반납·넘어짐 0 통과. RGB 수신 3.65 / 3.50 fps, 1 s 넘는 공백 0, 동시 RTF 중앙 0.356 / 0.339(원인 미정) | 물리 정지 아님: PC 회차 놓은 뒤 STOP 전후 약 4 s 이동(회차 전체 0.267 m, 기울기 최대 19.1°), 이후 약 25 s 사이 0.054 m 되돌아옴, 폰 회차 약 0.05 m — 원인 미확인, 완전 정지 통과로 세지 않음. 실 사용자 계정·실폰·Android WebView·라이다 1 scan 화면(누적 모드였음)·층 전환 재주행 미확인 |
| 외부 엔진 적용 판 | `live_map.py` `d7171ae69c909aa1008e83e96c4c8c1e1ca1e82833e1a7f24f447253296a598b` · `points_view.py` `66b3431e5a0b912d75c0693a39be0b2455d27fa13116214bb0da92e762cf1ce1` · `connected.py` `645cc0791f196d2fd20d66d23b449501d9e315b6714b585c8e136ce2625633cb` | 10-15 16:21 적용 | 저장소 밖. 이 저장소 코드와 별개 |
| 개발 관문 웹 화면 | UI `53aba2f`(r15) | 교체 | 운영 주소·계정·CA 는 저장소에 없음 |

### 직전 미공개 검수 빌드 — Android 개발 APK `dev-20261015-stability`(code 7, 공개 안 함) (10-15)

| 무엇 | 대상 | 결과 | 범위·한계 |
|---|---|---|---|
| UI 단위·계약 시험 | UI `a2f5c40` | tsc · vitest 96/96 · 계약 생성물 16 일치 · pytest 130 통과 1 건너뜀 · 연결 중계 자체 시험 | UI 쪽 실행 |
| 합성 화면 시험 | 합성 발행기(실 SLAM·실 Gazebo 아님) → 이 판 연결 중계 → 시험 관문 → 헤드리스 Chrome 두 화면 | PASS — 격자 65장(큰 격자 4), 정상 확장 구간 지도 빈칸 0 · 3인칭·점군 끊김 0 · 진짜 경계 뒤 옛 그림 0 · STOP 가림 0 · 페이지 예외 0 | 수정 되돌림 변이 6종 검출. 해독 지연은 주입한 비관 조건 — «갱신 중» 표본 약 61%는 실제 비율 아님. 실 SLAM 주행 확장 미확인 |
| APK 구조 대조 | `foothold-android-dev-20261015-stability.apk` sha256 `328e9781c8033292dc67731022390c365bf8303f154c9747bef59e09cec59217`(통합 `22ebf7c` 에서 빌드, 이 문서 커밋과 ui·mobile 트리 같음) | 27/27 통과 | 앱 id·버전·서명·CA 한 장·번들 파일별 sha(143)·server.url 없음 등 |
| 실APK 실행(에뮬) | 위 APK | 아직 안 함 | 별도 검수 뒤 1회만 예정 |

### 앞 판 — Android 개발 APK `dev-20261015-mapview` (10-15)

| 무엇 | 대상 | 결과 | 범위·한계 |
|---|---|---|---|
| APK 구조 대조 | `foothold-android-dev-20261015-mapview.apk` sha256 `4cfb6abfbb071f15ef9a9447b9ae9c3ef0fc62fcdf00d4b096dfc8d07fca8c41`(통합 `e6bb5e4` 에서 빌드, 이 문서 커밋과 ui·mobile 트리 같음) | 27/27 통과 | 앱 id·버전·서명·CA 한 장·번들 파일별 sha·server.url 없음 등 |
| Android 에뮬레이터 실APK 실행 | 같은 APK · 실측 센서 기록 재생(외부 Gazebo 1차 런 녹화) · 임시 관문 | 3회차 rc 2(FAIL 0, 미확인 3) | 현재층·3D 실시간 결속·저장은 재생이라 미확인. 화면 클릭은 DOM 처리(실손가락 아님). 1회차 INCOMPLETE(디스크 부족)·2회차 FAIL(시험 도구 입력 결함) 원물 보존 |
| 외부 Gazebo 검증 | 저장소 밖 엔진·보행 정책(이 저장소·APK 에 없음) | 1~3차 FAIL, 4차 통과(범위 = 시작·저장·리셋·정리만) | 런마다 따로 — 합쳐서 «전체 통과»로 세지 않는다. 경사로·층별 복원 근거는 3차, 저장·리셋 근거는 4차. 보행 정책 낙상 가능(2차) |
| 외부 엔진 적용 판 | `connected.py` `645cc0791f196d2fd20d66d23b449501d9e315b6714b585c8e136ce2625633cb` · `live_map.py` `4f2acab267fcff64cb01892cdbfd8efdff4d5b3254863121654c29038242149b` | 10-15 04:08 적용 | 저장소 밖. 이 저장소 코드와 별개 |
| 개발 관문 웹 화면 | UI `4bcf014`(r12) | 교체 | 운영 주소·계정·CA 는 저장소에 없음 |

확인 안 함: 실폰·iOS(IPA 없음)·Go2Direct 실제 연결(없음)·실로봇·실손가락 터치. STOP 송신은 물리 정지 보장이 아니다.

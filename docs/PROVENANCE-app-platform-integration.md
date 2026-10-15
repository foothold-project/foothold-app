# 통합 브랜치 출처 — less82/app-platform-integration

이 브랜치는 **UI final 위에 `mobile/**` 스냅샷만 얹은 것**이다(옛 모바일 브랜치와의 merge 아님 — 최초는 UI final 에서 생성, 이후 새 UI final 은 로컬 일반 merge 로 전진). 옛 모바일 브랜치의 `sim/`·`server/`·`contracts/` 판과 그 이력은 가져오지 않는다.

| 부분 | 출처 커밋 | 트리 해시 | 비고 |
|---|---|---|---|
| 현재 UI final — `ui/`·`server/`·`contracts/`·`sim/`·`web/`·`tests/`·`tools/` 등 | `a2f5c4023a0ec442a275a7771725598271b4d3ce` (`less82/app-ui-react-recovered`) | `ui` = `03d276a646bd749b65a7eaf5d8defb1e2772c168` | 그대로 |
| `mobile/**` | `4975747dd459789fe19ed0c901b6ec683bb3be0a` (`less82/app-contract-storage`) | `mobile` = `f6e52659cd2ca70b341ecc7c371655eebb14fba4` | 파일 단위 변경 0 |
| `docs/PROVENANCE-app-platform-integration.md`(이 문서) · `docs/GITHUB-WORKFLOW.md` · 루트 `.gitignore` 경로 보강 · 루트 `README.md` 맨 앞 «현재 통합 개발판» 안내(기존 본문 그대로, «기존 웹 구현 기록»으로 구분) | 이 브랜치에서 추가 | — | 작업 방식은 GITHUB-WORKFLOW.md |

검사(통합 커밋마다): `git rev-parse HEAD:mobile` = 위 mobile 트리, `git rev-parse HEAD:ui` = 위 ui 트리, `git diff --name-only a2f5c4023a0ec442a275a7771725598271b4d3ce HEAD` 는 `mobile/`·위 두 문서·`.gitignore`·`README.md` 뿐.

한계(이 판): Go2Direct 는 순수 코어·JVM 시험만 — Android 플러그인과 실제 UDP/HTTP Port 는 미구현(실로봇 연결 불가). 실폰·iOS·실기 확인 0.

## 검증 실행 범위 — Android 개발 APK `dev-20261015-stability` (10-15)

| 무엇 | 대상 | 결과 | 범위·한계 |
|---|---|---|---|
| UI 단위·계약 시험 | UI `a2f5c40` | tsc · vitest 96/96 · 계약 생성물 16 일치 · pytest 130 통과 1 건너뜀 · 연결 중계 자체 시험 | UI 쪽 실행 |
| 합성 화면 시험 | 합성 발행기(실 SLAM·실 Gazebo 아님) → 이 판 연결 중계 → 시험 관문 → 헤드리스 Chrome 두 화면 | PASS — 격자 65장(큰 격자 4), 정상 확장 구간 지도 빈칸 0 · 3인칭·점군 끊김 0 · 진짜 경계 뒤 옛 그림 0 · STOP 가림 0 · 페이지 예외 0 | 수정 되돌림 변이 6종 검출. 해독 지연은 주입한 비관 조건 — «갱신 중» 표본 약 61%는 실제 비율 아님. 실 SLAM 주행 확장 미확인 |
| APK 구조 대조 · 실APK 실행 | `foothold-android-dev-20261015-stability.apk`(이 통합 뒤 빌드) | 빌드 뒤 기록 | 에뮬 실행은 별도 검수 뒤 1회만 예정 — 아직 안 함 |

### 앞 판 — Android 개발 APK `dev-20261015-mapview` (10-15)

| 무엇 | 대상 | 결과 | 범위·한계 |
|---|---|---|---|
| APK 구조 대조 | `foothold-android-dev-20261015-mapview.apk` sha256 `4cfb6abfbb071f15ef9a9447b9ae9c3ef0fc62fcdf00d4b096dfc8d07fca8c41`(통합 `e6bb5e4` 에서 빌드, 이 문서 커밋과 ui·mobile 트리 같음) | 27/27 통과 | 앱 id·버전·서명·CA 한 장·번들 파일별 sha·server.url 없음 등 |
| Android 에뮬레이터 실APK 실행 | 같은 APK · 실측 센서 기록 재생(외부 Gazebo 1차 런 녹화) · 임시 관문 | 3회차 rc 2(FAIL 0, 미확인 3) | 현재층·3D 실시간 결속·저장은 재생이라 미확인. 화면 클릭은 DOM 처리(실손가락 아님). 1회차 INCOMPLETE(디스크 부족)·2회차 FAIL(시험 도구 입력 결함) 원물 보존 |
| 외부 Gazebo 검증 | 저장소 밖 엔진·보행 정책(이 저장소·APK 에 없음) | 1~3차 FAIL, 4차 통과(범위 = 시작·저장·리셋·정리만) | 런마다 따로 — 합쳐서 «전체 통과»로 세지 않는다. 경사로·층별 복원 근거는 3차, 저장·리셋 근거는 4차. 보행 정책 낙상 가능(2차) |
| 외부 엔진 적용 판 | `connected.py` `645cc0791f196d2fd20d66d23b449501d9e315b6714b585c8e136ce2625633cb` · `live_map.py` `4f2acab267fcff64cb01892cdbfd8efdff4d5b3254863121654c29038242149b` | 10-15 04:08 적용 | 저장소 밖. 이 저장소 코드와 별개 |
| 개발 관문 웹 화면 | UI `4bcf014`(r12) | 교체 | 운영 주소·계정·CA 는 저장소에 없음 |

확인 안 함: 실폰·iOS(IPA 없음)·Go2Direct 실제 연결(없음)·실로봇·실손가락 터치. STOP 송신은 물리 정지 보장이 아니다.

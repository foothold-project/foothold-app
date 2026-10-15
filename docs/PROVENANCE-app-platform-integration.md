# 통합 브랜치 출처 — less82/app-platform-integration

이 브랜치는 **UI final 위에 `mobile/**` 스냅샷만 얹은 것**이다(옛 모바일 브랜치와의 merge 아님 — 최초는 UI final 에서 생성, 이후 새 UI final 은 로컬 일반 merge 로 전진). 옛 모바일 브랜치의 `sim/`·`server/`·`contracts/` 판과 그 이력은 가져오지 않는다.

| 부분 | 출처 커밋 | 트리 해시 | 비고 |
|---|---|---|---|
| 현재 UI final — `ui/`·`server/`·`contracts/`·`sim/`·`web/`·`tests/`·`tools/` 등 | `53aba2f5db70f9acaecc3f46499de24cb02e6cd2` (`less82/app-ui-react-recovered`) | `ui` = `c7797d402bcb3bf90089918e3ff70d2286d5752c` | 그대로 |
| `mobile/**` | `926d5494c30c272ceefc92c04baaa12e856421f4` (`less82/app-contract-storage`) | `mobile` = `81ca7ec527fec6084d3e91c2dfcea45f7d314c5b` | 파일 단위 변경 0 |
| `docs/PROVENANCE-app-platform-integration.md`(이 문서) · `docs/GITHUB-WORKFLOW.md` · 루트 `.gitignore` 경로 보강 · 루트 `README.md` 맨 앞 «현재 통합 개발판» 안내(기존 본문 그대로, «기존 웹 구현 기록»으로 구분) | 이 브랜치에서 추가 | — | 작업 방식은 GITHUB-WORKFLOW.md |

검사(통합 커밋마다): `git rev-parse HEAD:mobile` = 위 mobile 트리, `git rev-parse HEAD:ui` = 위 ui 트리, `git diff --name-only 53aba2f5db70f9acaecc3f46499de24cb02e6cd2 HEAD` 는 `mobile/`·위 두 문서·`.gitignore`·`README.md` 뿐.

한계(이 판): Go2Direct 는 순수 코어·JVM 시험만 — Android 플러그인과 실제 UDP/HTTP Port 는 미구현(실로봇 연결 불가). 실폰·iOS·실기 확인 0.

## 검증 실행 범위 — Android 개발 APK `dev-20261015-viewfix` (10-15)

| 무엇 | 대상 | 결과 | 범위·한계 |
|---|---|---|---|
| UI 최종 소비자 검수 | UI `53aba2f`(화면 파일 143개, `.map` 제외) | 통과 | 가짜 생산자·격리 연결 기준. 실제 생산자(실 Gazebo·SLAM·라이다) 연결·실시간 갱신 속도·실센서 경계 미확인 |
| APK 구조 대조 | `foothold-android-dev-20261015-viewfix.apk` sha256 `7f381ae4e13afdd84076bf929a3b19c1cf63290f93125a14f686adf65e4411d0`(통합 `ecf388b` 에서 빌드, 이 문서 커밋과 ui·mobile 트리 같음) | 27/27 통과 | 앱 id·버전 8·`1.0.7-dev`·서명·CA 한 장·번들 파일별 sha(143)·server.url 없음 등. 실행 동작은 이 대조 범위 밖 |
| 실APK 실행(에뮬) | 위 APK | 실행 0 | 디스크 여유가 에뮬 조건(8192 MiB)에 못 미쳐 이번 판은 실행하지 않음 |
| 실제 Gazebo 조종 1회 | 개발 관문 웹 화면 = UI `53aba2f`(APK 아님) · 임시 시험 계정 · PC Chrome 1280×800 / Chrome iPhone 390×844 에뮬레이션 각 1회 | 조종 시작 확인 1회·앞 누름 서버 적용·놓은 뒤 출력 0·STOP 잠금·조종권 반납·넘어짐 0 통과. RGB 수신 3.65 / 3.50 fps, 1 s 넘는 공백 0, 동시 RTF 중앙 0.356 / 0.339(원인 미정) | 물리 정지 아님: PC 회차 놓은 뒤 STOP 전후 약 4 s 이동(회차 전체 0.267 m, 기울기 최대 19.1°), 이후 약 25 s 사이 0.054 m 되돌아옴, 폰 회차 약 0.05 m — 원인 미확인, 완전 정지 통과로 세지 않음. 실 사용자 계정·실폰·Android WebView·라이다 1 scan 화면(누적 모드였음)·층 전환 재주행 미확인 |
| 외부 엔진 적용 판 | `live_map.py` `d7171ae69c909aa1008e83e96c4c8c1e1ca1e82833e1a7f24f447253296a598b` · `points_view.py` `66b3431e5a0b912d75c0693a39be0b2455d27fa13116214bb0da92e762cf1ce1` · `connected.py` `645cc0791f196d2fd20d66d23b449501d9e315b6714b585c8e136ce2625633cb` | 10-15 16:21 적용 | 저장소 밖. 이 저장소 코드와 별개 |
| 개발 관문 웹 화면 | UI `53aba2f`(r15) | 교체 | 운영 주소·계정·CA 는 저장소에 없음 |

### 앞 판 — Android 개발 APK `dev-20261015-stability` (10-15)

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

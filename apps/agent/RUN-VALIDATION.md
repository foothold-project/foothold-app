# scenario/1 직결 실행기 검증

기준: dev `c03b648` / 계약 PR #101. 소유 범위는 `apps/agent/**`다.

## 구현과 안전 경계

- Hub가 기존 한 Session/Core/sink를 유지한다. 실행기는 새 명령 송신기나 sink를 만들지 않는다.
  Core와 기존 안전 셀프테스트의 기대값은 수정하지 않았다.
- `run.start/control/confirm`은 fh-phone/1의 4 KiB 봉투에서 검증한다. 상태는
  `run.update`와 `state.run`으로 제공한다. confirm/return은 미지원이다.
- 시작은 현재 control 연결의 USER lease, STOP 해제 피드백, 신선한 중립 뒤에만 가능하다.
  실제 에이전트 simulation 설정이 true여야 한다. 실기 시작은 FORBIDDEN이며 PC hello/프레임에는
  PR #97의 WEB_SIM_ONLY 재검사가 계속 적용된다.
- NavExecutor/action 준비 포트가 없으면 NAV_UNAVAILABLE로 거부한다. 기본 ROS bridge 진입점은
  Nav2를 생성하지 않는다. 따라서 이 PR만으로 기본 시뮬 주행이 켜지지 않는다.
- ScenarioSource는 명시적인 데이터 origin에서 agent Bearer 인증으로
  `GET /agent/scenarios/{id}?version=n`만 조회한다. 리디렉션은 거부한다.
  서버 고정 판, 단일 층/지도 판, finite 좌표, 순서와 finish를 검사한다.
  실시간 지도/월드 바인딩 대조는 별도 로컬 `run_context` 포트가 담당하며 생략하면 시작 불가다.
- 도착은 현재 목표 세대의 SUCCEEDED와 로컬 `arrival_evidence`가 제공하는 같은 세대·판의
  신선한 측정 pose/body_still 증거를 함께 요구한다. 도착 사건과 DISPLAY_ONLY 기록만 만들며
  실제 임무 동작은 수행하지 않는다. finish 이동은 추가 임무로 세지 않는다.
- 실행 화면의 단조 ping 수신 간격 >=3 s, 소켓 종료, 출입증 만료/회수는 0·목표 취소·잠금과
  PAUSED로 전이한다. 다른 연결/서버/실행기 입력은 화면 감시 시각을 갱신하지 않는다.
- RUN 비영 수동 입력은 RUN_ACTIVE다. 명시적 pause 뒤 취소 완료 확인, 새 USER lease,
  STOP 확인·명시 unlock·해제 피드백·새 중립을 거쳐 수동 전환한다. 종료 뒤에도 취소 ACK가
  없으면 새 USER lease를 주지 않는다. 0/STOP/release는 실행 상태 때문에 차단하지 않는다.
- 재개는 user/device/surface/screen_id/256-bit 난수 증명과 새 안전 관문을 요구한다.
  실행기는 증명의 해시를 보관하고 재개 때 회전한다. 최초 start 응답은 원 연결 Peer의
  응답 재전송 캐시에만 보관하며 연결 제거 시 사라진다. 공개 상태/보고/디스크에는 증명이 없다.
- `run_pause_timeout_s` 기본 600, 양의 유한 초다. 연속 PAUSED의 STOP/pause/재접속이
  마감을 연장하지 않는다. 오프라인에서도 만료 시 CANCELED/PAUSE_TIMEOUT으로 닫는다.
  서명 run_cancel=true는 PAUSED 취소만 허용하며 조종·해제·재개 권한을 주지 않는다.
- RunOutbox는 기동 UUID·1부터 증가하는 report_seq·monotonic_s로 전이/지점 사건을 기록한다.
  별도 스레드의 SQLite FULL commit 뒤 보고하며 run.recorded ACK 뒤 삭제한다.
  재접속에는 같은 식별자로 재전송한다. 영속 실행 tombstone으로 재시작 시 기존 실행을
  FAILED/AGENT_RESTARTED로 닫고 자동 재개/ID 재사용을 막는다. 저장 실패/용량 초과는
  PAUSED/RECORDING_UNAVAILABLE와 잠금을 유지한다. 초기 기록 commit 전 목표를 제출하지 않는다.

## 구성

기본 진입점의 선택 환경 변수:

- `FOOTHOLD_RUN_OUTBOX_PATH`: 프로세스 소유 0600 영속 SQLite 경로. `:memory:`는 운영 구성에서 거부.
- `FOOTHOLD_SCENARIO_DATA_ORIGIN`: 경로 없는 HTTPS origin. HTTP는 loopback만 허용.
- `FOOTHOLD_RUN_PAUSE_TIMEOUT_S`: `run_pause_timeout_s` 값, 기본 600.

Nav2/action readiness/cancel-confirmation, 지도 바인딩 및 측정 도착 근거는 Hub 생성자의
명시적 로컬 포트다. 아직 기본 진입점에 구성하지 않는다. 앱/서버/화면 통합과 지도·정지 허용치
검증 전에 모의 포트를 실제 실행 허가로 대체해서는 안 된다.

## 초기 구현 검사 (r1 이전)

설치 없이 기존 시험용 Python(웹소켓 15.0.1·pytest·Pydantic)을 읽기 전용으로 사용했다.
로컬 비추적 socket fence로 수신 포트를 9580~9589에 한정했다. 기존 시험이 고정한 이전
포트는 이 범위로 바꾸어 bind하고, 연결 목적지는 loopback의 이 범위만 허용했다.
다중 출발지 시험의 loopback 클라이언트 source port는 OS가 배정했다.

- 최종 집중: `pytest apps/agent/tests/test_scenario_run.py -q` — **48 passed**.
- STOP/일시정지 우선 처리 수정 뒤 기존 직결 회귀 포함:
  `pytest apps/agent/tests/test_scenario_run.py apps/agent/tests/test_phone.py apps/agent/tests/test_web_sim_gate.py -q`
  — **135 passed** (이 시점 시나리오 42개, 이후 기록/계약/저장 실패 검사 6개 추가).
- 에이전트 전체 1회: `if [ "$(awk '/MemAvailable/ {print $2}' /proc/meminfo)" -ge 2621440 ]; then ... -m pytest apps/agent -q; fi`
  — **1403 passed, 1 skipped, 4 failed**, 54.42 s. 4개는 로컬 fence의 환경 문제:
  FH_TEST_PORT_RANGE 누락 1개, 다중 loopback 출발지를 제한한 3개였다.
  설정을 바로잡은 뒤 해당 4개만 재실행하여 **4 passed**. 전체 시험을 반복하지 않았다.
- 안전 변이: `python apps/agent/tools/check_run_mutations.py` — **2/2 탐지**.
  같은 화면 증명 생략, 반복 STOP의 PAUSED 마감 연장. assertion 실패만 탐지로 인정한다.
- 계약 모델: AgentScenario/RunPlan/PhoneState/PhoneRunUpdate/AgentRunUpdate/AgentEvent를
  생성한 실제 모의 데이터로 검증한다. 영속 outbox 재개방·ACK·재시작 기록도 모의 시험이다.
- 기본 시스템 Python의 초기 직결 시험은 웹소켓 미설치로 3 failed, 89 passed, 1 skipped였다.
  기존 의존성 환경으로 다시 실행한 직결 시험에서는 통과했다. 패키지는 설치하지 않았다.

## r1 검토 수정과 검사

- Codex P1: `Hub._emit`이 모든 출력 전에 Nav2 원수신 마감을 검사한다.
  만료 시 기존 실행 중단 경로로 0·잠금·목표 취소·FAILED/NAV_TIMEOUT을 적용하고,
  이미 계산된 옛 effects는 버린다. 소비 시각으로 원수신 마감을 연장하지 않는다.
- Codex P1 / Claude R2: RUN 진입(start/resume)은 대기 USER 양도를 CANCELED로
  알리고 취소한다. `lease.respond`에도 RUN_ACTIVE, 실행 주체, 취소 확인 관문을 적용하며,
  PAUSED에서도 다른 주체로의 수락을 거부한다.
- Claude R1: `Hub.stop`의 finally에서 Session STOP을 보장한다.
  Nav2/action 취소가 실패해도 STOP·0을 출력한 뒤 원래 예외를 전달한다.
- 새 회귀 5건: t=0 수신→t=.25 소비→t=.300001 로봇 피드백만으로 0,
  대기 양도→RUN→accept 거부와 양쪽 취소 알림, 응답 관문 독립 검사 2건,
  action 취소 예외에도 Session STOP 출력 1건. 기존 안전 셀프테스트 기대값 변경 0.
- 집중 1회: `python -m pytest apps/agent/tests/test_scenario_run.py -q -p no:cacheprovider`
  — **53 passed**.
- 이번 수정 변이: `PYTHONPATH=apps/agent:apps/agent/tools python apps/agent/tools/check_run_mutations.py --r1`
  — **1/1 DETECTED**. 공통 출력 관문만 메모리에서 제거하면 위 로봇 피드백 회귀가
  assertion으로 실패한다. tracked 소스·기대값은 변이 실행 중 수정하지 않는다.

- 에이전트 전체 **1회**: 실제 `if [ "$(awk '/MemAvailable/ {print $2}' /proc/meminfo)" -ge 2621440 ]; then ...; fi`
  안에서 실행(실행 직전 MemAvailable 6176260 kB).
  `python -m pytest apps/agent -q -p no:cacheprovider`
  — **1418 passed, 1 skipped, 2 failed**, 49.27 s.
  실패 2건은 전달받은 `FH_TEST_PORT_RANGE=9580-9589`를 기존 도우미가 콜론으로
  해석하면서 발생한 ValueError다. `9580:9589`로 환경만 바로잡은 뒤 해당 telemetry
  2건을 재검사하여 **2 passed**(0.22 s). 전체 시험은 반복하지 않았다.
- 설치 없이 기존 pytest/Pydantic/websockets 환경을 읽기 전용으로 사용했다.
  로컬 비추적 socket fence를 PYTHONPATH 앞에 두어 수신·접속 목적지를 loopback
  9580~9589에 제한했다. ROS·Gazebo·시뮬·운영 포트·실기 접촉 0이다.

남은 권고(이번 수정에서 제외): Claude R3 RUN 중 0 cmd의 need_neutral 정체,
R4 SUCCEEDED 후 원수신 deadman과 측정 도착 증명의 순서(실 Nav2 통합에서 확인),
R5 STOP/release 후 PAUSED wait_reason 덮어쓰기. ROS·시뮬·실기 실행 0이다.

## 미검증·통합 전 남은 조건

ROS/Gazebo/새 시뮬/실기/운영 서비스 기동이나 접촉은 하지 않았다. 실제 Nav2/실제 자료 API와
왕복 통합, 물리 정지·도착 자세/속도/유지 시간 허용치, 실폰과 실제 저장 장애/전원 장애는
검증하지 않았다. mock context/arrival 포트는 이 증거를 대신하지 않는다.

계약 빈칸: AgentScenario에는 시뮬 지도 해시/원점/해상도 및 실기 승인·SF-12 증명이 없고,
RUN_STARTED에는 assignment_id/계획 스냅샷 전달 필드가 없다. 조정에 보고했으며 contracts는
수정하지 않았다. 첫 판은 시뮬만, 서버가 DB 고정 판으로 계획을 재구성하는 것으로 합의했다.
실행 중 출입증 갱신은 구현하지 않았다(600 s 만료 → PAUSED → 새 출입증으로 같은 화면 수동 재개).

되돌림은 이 기능 커밋을 git revert한다. Git 되돌림과 실제 에이전트 재시작/배포는 별도 작업이며,
영속 outbox 파일은 삭제하지 않는다. 안전 변경이므로 Claude·Codex 두 모델 검토 후 조정이 dev에 합친다.

## 2026-10-25 통합 2b (기준 dev 687553d)

이 절은 위 초기 구현의 미구현·권고 목록을 대체한다. 기존 기록의 시험 수는 당시 결과다.

- 실제 조회 경로는 `/api/v1/agent/scenarios/{id}?version=n`이다. origin은 경로 없이 유지한다.
- 새 실행은 필수 RunMapProof를 엄격히 검사한다. 실제 로컬 PNG/PGM의 SHA·동일 raster,
  행 반전과 unknown을 포함한 OccupancyGrid·원점·해상도·크기·현재 world/floor/episode와
  고정 판을 대조한다. 누락/불일치 때 출발하지 않는다. HUMAN 지도는 첫 판 실행 불가다.
  RUN_STARTED는 이 검증 뒤 동일 map_proof를 담아 영속 저장하며 commit 전 목표를 제출하지 않는다.
- 기본 ROS 진입점은 명시적인 로컬 지도 자료 구성 시 제품 RunNav/GoalActions를 주입한다.
  기존 RosNode의 단일 ROS 스레드를 확장하며 로봇 명령 publisher를 추가하지 않는다.
  Nav2 lifecycle·신선한 TF/clock/scan 및 정책 위치와의 일치를 검사한다.
- 지점·finish마다 새 목표 UUID를 쓴다. 다음 제출은 이전 목표 terminal result 확인 뒤다.
  취소 요청의 수락만으로 완료라 하지 않으며, acceptance 전 취소도 늦은 handle에 전달한다.
  목표별 intent 구독과 action callback은 불변 목표 세대를 캡처하고 옛 성공은 버린다.
- 도착은 현재 세대 SUCCEEDED + 같은 지도 판의 측정 위치가 0.5 m 이내이고 신선도
  `FH_RUN_ARRIVAL_POSE_MAX_AGE_S` 이하일 때다(기본 1.0 s, 양의 finite).
  yaw 오차·몸체 정지 유지는 10-25 결정으로 제외했다. 기존 도착 시험에서 움직이는 몸의
  거부 기대만 조정 승인으로 제거했으며 stale pose·Core·STOP·deadman 기대는 유지했다.
- 이동 중 0 cmd는 0을 적용하면서 이후 Nav 입력에 새 중립을 불필요하게 요구하지 않는다(R3).
  Nav2 성공 뒤에는 별도의 0 전용 대기(기본 3 s)로 측정 위치를 확인한다(R4).
  Session의 이 제한 상태는 비영 입력을 0으로 강제하며 ROS 원수신 시각을 갱신하지 않는다.
  이동 중 원수신 0.3 s 만료·잠금·독립 sink watchdog·화면 감시는 유지한다.
  도착 뒤 취소 대기도 0 전용·3 s 제한이다. PAUSED 사유와 최초 만료 시각은 보존한다(R5).
- `run.report_rejected`는 실제 outbox 식별자와 대조한다. RETRY는 기존 재연결 backoff 뒤
  같은 원문을 FIFO replay한다. expected_report_seq가 원문보다 커도 삭제하거나 식별자를
  고치지 않는다(B4). 보관하지 않은 선두를 요구하면 기록 장애로 정지한다.
- QUARANTINE은 원문·식별자·거부 이유를 `<outbox>.quarantine`의 별도 0600 SQLite에
  FULL commit한 뒤 live outbox에서 제거한다. 두 파일 간 장애 시 archive를 먼저 보존하며,
  재시작에서 중복 이동을 완료한다. archive는 자동 replay/삭제하지 않는다.
  현재 실행은 즉시 0·취소·잠금·FAILED(RECORDING_REJECTED), 종료 보고는 새 순번이다.
  격리 저장 실패 때 원문은 live outbox에 남고 기록 장애 차단을 유지한다.
- 시뮬 로봇은 프로세스 재시작 때만 격리 차단을 해제한다(B2). 격리 파일과 실패 실행은
  보존하며 새 출입증·새 run_id·STOP 확인·unlock·중립 관문이 계속 필요하다.
  실기는 재시작해도 격리 차단을 유지한다. 원격 해제 경로는 없다.

추가 구성:

- `FOOTHOLD_RUN_MAP_ASSETS_JSON`: 로컬 배열
  `[{"map_version_id":"<uuid>","image_path":"/data/maps/map.png","pgm_path":"/data/maps/map.pgm"}]`.
  신뢰된 launch 등록 `FOOTHOLD_FLOOR_BINDINGS`도 필요하다. PNG는 grayscale8 noninterlaced,
  PGM은 동일 픽셀의 P5/255(0=occupied,205=unknown,254=free) 사본이다.
  지도 원본은 Git에 넣지 않는다. 자료가 없으면 실행은 fail-closed다.
- `FOOTHOLD_RUN_OUTBOX_PATH`와 `.quarantine`은 episode 삭제 디렉터리 밖에 둔다.
  경로의 소유·보존은 launcher 책임이며 2b는 해당 환경변수를 소비한다.
- `FOOTHOLD_SCENARIO_DATA_ORIGIN`과 `FOOTHOLD_RUN_PAUSE_TIMEOUT_S`는 위 구성과 같다.
- 성공 후 측정/취소 대기는 내부 기본 3 s, Nav 이동 제한은 기존 120 s다.

검사 명령(ROS/Gazebo를 기동하지 않는 Python 환경):

```sh
PYTHONDONTWRITEBYTECODE=1 FH_TEST_PORT_RANGE=9590-9599 \
PYTHONPATH=runs/int-agent-test-fence:apps/agent:apps/agent/tools \
python -m pytest -q apps/agent/tests/test_run_integration.py \
  apps/agent/tests/test_scenario_run.py apps/agent/tests/test_executor_nav2.py
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=apps/agent:apps/agent/tools \
python apps/agent/tools/check_run_mutations.py --r1
```

로컬 비추적 fence는 원본 사본에 9590~9599만 허용했고, 기존 도우미를 위해 동일 범위의
환경 표기만 콜론으로 정규화한다. 서버·web·contracts·simmgr 수정은 없다.
실 Nav2 action/다중 구독 전환·목표 사이 늦은 Twist·lifecycle 지연·물리 이동/정지,
실서버 API/DB와 왕복 결합, 실제 전원/디스크 고장과 실폰·실기는 미검증이다.
회전/곡선·임의 저속은 기존 검증 alphabet 밖으로 거부한다. 일반 창고 순찰 완주를 주장하지 않는다.
별도 2a/launcher 통합과 Claude·Codex 안전 검토는 조정 세션이 진행한다.

2b 실행 결과:

- 최초 집중 3파일: **142 passed**. 최종 집중 4파일(`test_run_integration`,
  `test_scenario_run`, `test_executor_nav2`, `test_link_session`): **252 passed**, 2.01 s.
  신규 통합 시험은 최종 54개다.
- 에이전트 전체는 조건문 안에서 **1회** 실행했다. 직전 MemAvailable **5567216 kB**
  (기준 2621440 이상), `pytest -q apps/agent -p no:cacheprovider`:
  **1465 passed, 1 skipped, 2 warnings**, 56.77 s. warning은 기존 nav2_journal 시험의
  pytest 빈 정규식 경고다. 전체 실행 후 대기 만료/취소 완료의 동시 경계 순서와 RETRY의
  run_id 대조·시작 전 로컬 상태 경계를 보완했고 위 최종 집중 252개와 안전 변이를 다시 통과했다.
  전체 시험은 반복하지 않았다.
- 안전 변이 `check_run_mutations.py --r1`: **1/1 DETECTED**. Nav2 원수신 만료의
  공통 출력 관문을 제거하면 기존 로봇 피드백 회귀가 assertion으로 실패한다.
- `git diff --check` 통과. Core 소스·STOP/deadman 시험 기대값 변경 0.
- 소켓은 비추적 fence로 loopback 9590~9599만 사용했다. ROS·Gazebo·시뮬·실기 기동0,
  설치0, 서버·web·contracts·simmgr 변경0이다.

시작 전 실패의 첫 판 범위(조정 합의): RUN_STARTED를 아직 append하지 않은 준비 실패·STOP은
폰의 로컬 FAILED/PAUSED 표시와 0·잠금만 유지하며 서버 outbox에는 넣지 않는다.
따라서 서버 실행 이력은 생성되지 않는다. RUN_STARTED를 일단 append한 뒤의 원문과 이후
STOP 보고는 ACK 전 삭제하지 않고 FIFO로 보존·재전송한다. 서버 ACK를 목표 제출 허가로
사용하지 않으며, 시작 보고가 QUARANTINE되면 이동 중이어도 즉시 0·취소·잠금·FAILED로
축소한다. 이 두 경계는 신규 통합 시험으로 확인했다.

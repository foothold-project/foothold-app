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

## 실제 실행한 검사

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

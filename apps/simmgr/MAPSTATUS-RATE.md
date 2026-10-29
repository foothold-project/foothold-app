# 지도 상태 발행 주기와 실패 진단

안전 입력 경로 — 임계값 불변. 지도 상태의 수신·시뮬 시간 만료는 기존
1.0초, future 허용은 기존 0초이며 odom·lifecycle·STOP 판정도 유지한다.

`connected_runtime.compile_static_runtime`이 격리 child에서만 기존
`node.create_timer(1.0, publish_status)`를 `0.2`초로 바꾼다. connected static과
repository static(warehouse) 경로에 적용하며 외부 runtime 파일은
고치지 않는다. 알려진 타이머가 없거나 중복되거나 모양이 달라지면 시작 전에
거부한다. state·명령 타이머와 발행 본문은 이 변경에서 손대지 않는다.

## 오래된 증거를 새 정보로 위장하지 않는 근거

캐시 메시지 재전송 타이머를 추가하지 않는다. 원래 `publish_status`가 매번
실제 floor/map snapshot, simulation snapshot, TF를 다시 읽는다. 상태의
`sim_t`는 simulation snapshot, pose의 `stamp_sim`은 TF의 원 stamp이며
타이머가 실행된 벽시계나 수신 시각으로 바꾸지 않는다.

시뮬 상태가 진행하면서 TF가 멈추면 기존 pose sim 차 검사가 1.0초 초과에서
거부한다. status 생성이 멈추면 원 수신 나이 또는 state−status sim 차로
floor context가 만료한다. simulation snapshot 자체가 멈추면 state의 원
진행 나이가 만료하므로 반복 수신으로 수명을 연장할 수 없다. future 샘플의
보류·재평가는 기존 수신 시각을 유지하며 양수 선행 허용을 추가하지 않는다.
정적 격자 자산의 불변성은 기존 등록 해시·epoch·run·floor·격자 결속으로
검사한다. 이 수정으로 정적 격자에 새 생성 stamp를 붙이지 않는다.

## 진단

`RunContext`는 기존 조건과 short-circuit 순서로 판정한다. False일 때만
로컬 진단을 준비하며 다음 목표 대기·이동 중 두 실패 경로가 halt 직전 한 번
`LOCALIZATION_LOST context=...`를 기록한다. `current.failure_detail`에도
같은 자료를 보관하며 wire 계약에는 필드를 추가하지 않는다.

- maps/extension 존재, Nav2 ready, map 결속의 실패한 항목 이름
- lifecycle active·수신 나이, odom.reason·수신 나이, clock/scan 수신 나이
- floor/pose/state 원 수신 나이, state 및 pose에 결속된 state 진행 나이,
  state−floor/pose sim 차, 보류된 future 샘플의 원 수신 나이·sim 차
- map 거절 누계·마지막 이유와 마지막으로 수락한 state/pose의 epoch

snapshot이 만료 증거를 지운 후에도 마지막 수락 시각을 진단 전용으로
보존한다. 판정 코드에서는 이 진단 사본을 읽지 않는다. 원 payload·좌표·경로·
인증값은 로그에 넣지 않으며 진단 예외는 기존 실패·0 출력·취소·잠금을 막지 않는다.

## 오프라인 수용 시험

`apps/agent/tests/test_run_context_diagnostics.py`는 가짜 시계와 실제
Telemetry·RunMaps·ScenarioRun을 연결한다. 기존 안전 시험 기대값은 바꾸지
않고 새 회귀를 추가했다. simmgr의 기존 synthetic runtime fixture에는 새로
검사하는 원 타이머 hook만 추가했다.

- 1 Hz + 40 ms 전달 지연: 1.02초에 floor sim 차가 1.0초를 넘어 FAILED
- 5 Hz + 같은 지연: 3초 동안 MOVING 유지
- 5 Hz 중 발행 단절, future, map mismatch, 고정 stamp 재발행, state stamp
  정지: 결함 주입 후 1.0초 이내 FAILED, 0 출력·goal 취소·잠금·lease 폐기
- 두 실패 경로의 진단 예외에도 halt 유지, 실패 로그 1회, 실패 항목 식별
- 타이머 변경 AST 비교, 원 발행 함수 재호출·원 stamp 유지, hook drift 거부

집중 시험: 324 passed. 실제 native source를 실행하지 않고 connected/repository
두 모드 adapter 컴파일 및 타이머 단독 AST 차이를 확인했다.
검사한 원 source SHA-256:
`588c8a5dd9b7cf9ec3861f3173f97d17d44893b4a76ed6cdfec351137e6c313c`.

전체 agent·simmgr 시험 결과는 PR 검증 기록을 참조한다. 실행 환경은 지정된
읽기 전용 Python, 원 test fence 사본, loopback 포트 9580–9589이며 simmgr
의존성은 system dist-packages를 추가하되 venv site-packages를 먼저 둔다.
실제 시뮬·Gazebo·Nav2·ROS/DDS 주기 및 부하는 미검증이다. 합치기 전 안전
입력 경로의 두 모델 검토가 필요하며, 되돌림은 해당 기능 커밋의 revert다.

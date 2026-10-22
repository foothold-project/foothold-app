# PR #46 5차 검토 반영 기록

기준3ed291c, 브랜치 feature/sim-manager다. origin/dev는8e70207110b04483c60563122cc04152e3c73b57이며
이미 일반 merge에 포함되어 있다. rebase/force push0, 실제 ROS/rclpy/Gazebo·systemd-run unit·
native 서비스·실기·설치0, safety/**·안전 상수·셀프테스트·ADR09 변경0이다.

## 결정과 회귀

| 지적 | 반영 |
|---|---|
| H1 재시작 뒤 첫 전달 + 응답 유실 |확실한 생성 전 거부9개 외 POST 성공·불확실 결과 모두 조직 잠금 안에서 DB 세대/STARTING 최종 확인. 맞으면 성공 ACTIVE·불확실 STARTING 유지, 다르면 commit 후 같은 세대 DELETE를 1회 보상하고 START_STALE 감사 1건. DB 현재 owner/hash/출입증은 변경0 |
| STALE409 |생성 없음이므로 DELETE 없이 START_STALE 감사 1건에 NOT_CREATED. 확실한 거부→IDLE 목록에는 넣지 않음 |
| HTTP 예외 |IncompleteRead·BadStatusLine 등 HTTPException도 RelayError로 감싸 불확실 결과 처리. HTTPError 본문 읽기 실패도 확실한 거부로 오인하지 않음 |
| J1 잠금·설정·기록 |보상 DELETE가 대기 중이어도 같은 조직의 다른 로봇 출입증 발급 완료. create_app의 real=True 전달, 있던 N 제거 후 POST N STALE·N+1 성공을 OS 대역으로 회귀·변이 검사 |
| J2 경계·문서 |미송신 첫 전달은 관리자 재시작을 넘을 수 있으며 서버 최종 확인·보상이 맡음. 이중 장애 잔여 runtime/복구·실제 RuntimeMaxSec=240 양쪽/정지 grace45·15초를05·FIRST-LAUNCH·README에 기록. startup의61은 기록만, world 전후 비교는 Simulation 별도. 숫자 앞 띄어쓰기 보정 |
| 유지 |후속 세대 제거0, 원격 호출 중 조직 쓰기 잠금0, 옛 DELETE4경합·D1/D2 복구·두 번째 DELETE403·자동 재전송0. 새 epoch/영속 세대/권한 없음 |

재현은 `test_sim_restart_delivery.py`로 옮겼다. Codex의 False/True 외 timeout·5xx·파싱·
IncompleteRead·BadStatusLine까지 새 수신자 생성 뒤 응답 장애를 주입한다. 최초 POST는 1회,
관리자 로봇0·IDLE·START_STALE 1건을 확인한다. DB가 같은 STARTING이면 보상0·상태 유지다.
후속 세대·보상 실패의 DB 불변과 감사 1건, 응답 유실+보상 실패로 고아가 남는 사례도
별도 단언한다. 고아 token hash는 DB와 다르며 실제 unit 종료 시각/STOP0를 시험했다고
주장하지 않는다. 폰 출입증의 offline600초 계약도 바꾸지 않는다.

검토자 원본은 읽기만 했다. 로컬 사본은 현재 worktree tmp/p1c에만 두며, Codex ASGI client
표기9458을9438로 맞추고 감사 1건 단언을 보강했다(실제 bind/접속 아님). Claude 출력형
탐침도 같은 뜻의 assertion을 추가한다. 옛 r4의 Capture.token 전제는 저장소 지연 시작
회귀의 late agent 생성0·회수·재취득201·후속 DELETE204로 대신 검증한다.

## 검증

기본 셸 ROS_* 그대로(ROS_DOMAIN_ID=57), fixture에서만 환경 격리한다. 기존 승인된 venv/TS
읽기 전용, 새 의존성0. PYTHONDONTWRITEBYTECODE=1,
PYTHONPATH=$PWD/apps/simmgr/tools:$PWD/apps/agent:$PWD,
TMPDIR=$PWD/tmp/p1c, FH_TEST_PORT_RANGE=9430:9449다. 무거운 실행 전 MemAvailable≥2.5GB를 확인했다. 실행 전/중 관측은 약4.3GiB 이상이었다.
전체 서버/agent/simmgr는 각각1회 완료했으며 이후 운영/시험 소스 변경0이다.

```sh
"$FH_PYTHON" -m pytest apps/server -q --tb=short
"$FH_PYTHON" -m pytest apps/agent apps/simmgr/tests -q --tb=short
"$FH_PYTHON" apps/server/tools/check_phone_pass_mutations.py
"$FH_PYTHON" apps/agent/tools/check_phone_mutations.py
"$FH_PYTHON" apps/agent/tools/check_link_mutations.py
"$FH_PYTHON" -m foothold_agent.ros_bridge.check_mutations
"$FH_PYTHON" apps/simmgr/tools/check_mutations.py
"$FH_PYTHON" apps/contracts/generate.py --check
node "$TS_BIN" --strict --noEmit --target ES2020 apps/contracts/ts/index.ts apps/contracts/tests/wire-consumer.ts
# 아래 묶음을 각각 10회, 동시에 실행하지 않고 회별 결과 보존:
"$FH_PYTHON" -m pytest apps/server/tests/test_sim_generation.py apps/server/tests/test_sim_recovery.py apps/server/tests/test_sim_delayed_start.py apps/server/tests/test_sim_restart_delivery.py -q --tb=short
"$FH_PYTHON" -m pytest apps/server/tests/test_phone_pass.py::test_three_robot_ack_pool_contention_keeps_links_and_eventually_confirms -q --tb=short
```

| 검사 | 결과 |
|---|---|
| 최초 server sim+manager 집중 |131 passed,50.06초 |
| 예비 재시작·응답 장애·이중 장애 집중 |14 passed,9.46초. 이후 HTTPError 본문 예외2건도 추가 |
| 서버 전체1회 |750 passed,818.98초. HTTPError 본문 예외2건 추가 포함 |
| agent+simmgr 전체1회(카메라 포함·제외0) |904 passed,1 skipped,41.51초 |
| 두 검토자 재현 사본 |5 passed,6.34초. False/True 모두 runtime0·IDLE·START_STALE 1건 |
| 발급·폰·link·bridge 변이 |35/82/80/49 전부 KILLED, 종료0 |
| 확장 변이 |56/56 KILLED, 모두 assertion·수집/실행 오류0 |
| contracts --check / TS strict |155개 일치 / 종료0 |
| 경합·복구·지연 시작 묶음10회 |10/10 통과, 매회54건·합540건. 프로세스 wall 44.49~46.51초 |
| ACK pool 시험10회(2초 기준 유지) |10/10 통과, 합10건. 프로세스 wall 5.09~5.38초 |

경합 묶음은 test_sim_generation·test_sim_recovery·test_sim_delayed_start·
test_sim_restart_delivery 네 파일이다. 두 묶음은 순차 실행했고 각 회 뒤 조정 follow-up을
확인했다. 아래 시간은 Python/fixture 준비를 포함한 **프로세스 wall**이며 명령 지연이나
ACK의2초 판정 시간이 아니다. ACK 판정과 시험 코드/기한 변경0이다.

| 회 | 시뮬54건 wall(초) | ACK1건 wall(초) |
|---|---|---|
|1|PASS 44.61|PASS 5.17|
|2|PASS 44.49|PASS 5.25|
|3|PASS 44.80|PASS 5.38|
|4|PASS 45.34|PASS 5.12|
|5|PASS 45.08|PASS 5.11|
|6|PASS 45.09|PASS 5.19|
|7|PASS 46.51|PASS 5.09|
|8|PASS 45.39|PASS 5.12|
|9|PASS 45.11|PASS 5.28|
|10|PASS 44.89|PASS 5.27|

기존 경고는 TestClient deprecation1건이며 agent에는 기존 빈 match 경고2건도 있다.
1 skip은 opt-in 실제 DDS 시험이다. 로그/회별 JSON/원본 사본은 tmp/p1c에만 두며 커밋하지 않는다.

실제 startup OS/user bus·unit 수명·고아 종료·메모리/task 최대값·ROS binding·STOP0 ACK·93
DDS 정리·native 명령 지연·실폰/LAN/WSS·UI·실기는 미검증이다. native1대/fake2대 구분과
[FIRST-LAUNCH](FIRST-LAUNCH.md)의 별도 P1-C2 승인 실행, 두 모델 재검토가 남는다.

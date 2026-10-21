# P1-C 오프라인 검증

아래는 최초659f7fa의 검증 기록이다. **현재 PR의4차 검토 수정·최신 검증은
[REVIEW-R4](REVIEW-R4.md)**을 따른다. [3차](REVIEW-R3.md)·[2차](REVIEW-R2.md)·[1차](REVIEW-R1.md)는 당시 실행 이력이다.

기준은 `origin/dev 8702fef`에서 분기한 `feature/sim-manager`다. ROS/Gazebo/rclpy 노드·실기
기동0, 설치0, 외부 원본/다른 worktree 수정0이다. 코드 검토·첫 기동 승인은 별도다.
안전 Core/상수/셀프테스트 및 ADR-002 본문은 변경하지 않았다.

## 재현 환경

Python3.12의 기존 읽기 전용 agent-phone venv를 사용한다(경로는 로컬 승인 값).
TS5.9.3도 같은 worktree의 기존 node_modules를 읽기 전용으로 사용했다. 새 의존성0.
시험 리스너/목적지는9430~9449만, 127/8 클라이언트 **발신 ephemeral은 조정 승인**으로 허용.
모든 임시 자료는 현재 worktree `tmp/p1c`, private PostgreSQL은 그 아래 Unix socket이다.
무거운 실행 전에 MemAvailable≥2.5GB를 확인했고 관측값은 약4.6~5.6GiB였다.

```sh
# FH_PYTHON은 승인된 기존 venv Python의 절대 경로.
export PYTHONDONTWRITEBYTECODE=1
export PYTHONPATH="$PWD/apps/simmgr/tools:$PWD/apps/agent:$PWD"
export TMPDIR="$PWD/tmp/p1c" FH_TEST_PORT_RANGE=9430:9449
"$FH_PYTHON" -m pytest apps/server/tests -q
"$FH_PYTHON" -m pytest apps/agent/tests apps/agent/foothold_agent/camera/tests apps/simmgr/tests -q
"$FH_PYTHON" apps/server/tools/check_phone_pass_mutations.py
"$FH_PYTHON" apps/agent/tools/check_phone_mutations.py
"$FH_PYTHON" apps/agent/tools/check_link_mutations.py
"$FH_PYTHON" -m foothold_agent.ros_bridge.check_mutations
"$FH_PYTHON" apps/simmgr/tools/check_mutations.py
"$FH_PYTHON" apps/contracts/generate.py --check
node "$EXISTING_TYPESCRIPT_BIN" --strict --noEmit --target ES2020 apps/contracts/ts/index.ts apps/contracts/tests/wire-consumer.ts
```

`apps/simmgr/tools/sitecustomize.py`는 위 시험 PYTHONPATH에만 넣는다. 기존 phone fixture의
9450~9469 요청을 허용 범위로 바꾸고, 범위 밖 목적지/리스너를 OS 호출 전에 거부한다.
asyncio 클라이언트의 loopback 발신 `:0`만 OS 할당을 허용한다. runtime에는 넣지 않는다.
`link/testing.py`의 예약 helper와 시험 기대값은 조정 승인으로 FH_TEST_PORT_RANGE를 읽도록
최소 변경했다. 기본9060~9079는 유지, 잘못된 형식/범위는 실패한다. `link/**` 변경은 이
**시험 helper1곳**뿐이며 운영 link 로직은 변경0이다. 다음 검색의 운영 코드 import는0건이다:

```sh
rg -n 'link\.testing|from .*testing import reserved_socket' apps/agent/foothold_agent --glob '*.py'
```

## 실행 결과

| 범위 | 결과 |
|---|---|
| 서버 전체 pytest |674 passed (843.77초), private DB migration 왕복 포함 |
| agent 전체 + camera + simmgr pytest |783 passed, 1 skipped (25.20초). skip은 opt-in 실제 DDS synthetic |
| 최종 서버 중계·관리자 집중 검사 |17 passed (서버3 + 당시 관리자14). 전체 서버674개 실행 뒤 보강한 redirect 시험도 여기 포함 |
| 최종 카메라 + 관리자 + 기존 sim 도구 |75 passed (카메라7 + 관리자16 + 기존 sim 도구52) |
| 출입증 발급·회수 변이 |25/25 KILLED, exit0 |
| 폰 변이 |79/79 KILLED, exit0 |
| 링크 변이 |80/80 KILLED, exit0 |
| bridge 변이 (ROS stub만, synthetic 미실행) |49/49 KILLED, exit0 |
| 새 카메라/관리자 변이 |5/5 KILLED, assertion 실패로 확인 |
| contracts 생성물 `--check` |154개 일치 |
| contracts TS strict typecheck |exit0 |
| 안전 Core·셀프테스트 변경 |0 |
| ADR-002 본문 변경 |0 |

새 변이는 카메라 대기를 control receive에 끼움, domain61 허용, remove의STOP/0 생략,
설정 로봇 상한 제거, 부모 종료 뒤 카메라 유지다. 예외/수집 오류를 KILLED로 세지 않는다.

실제 loopback 소켓 + 무한 대기하는 가짜 카메라 writer에서 STOP30회 p95 **0.390ms**,
독립 watchdog의 가짜 시계 만료 후0까지 벽시계 대기 **41.530ms**를 관측했다.
가짜 시계0.301초를 수동으로 넘긴 뒤 tick을 기다린 결과이며 실제0.4초 끝-끝 검증이 아니다.
실행 명령은 `pytest .../camera/tests/test_camera.py::test_measured_slow_camera_socket_preserves_stop_and_deadman -q -s`다.
영상 소켓이 멈춰도 실제 control TCP 응답이 흐른다는 구조만 입증한다.

첫 전체 agent 실행의5개 실패는 시험 포트 fence에서 legacy fixture를 거부한 결과였다.
telemetry 포트 기대값1개와 클라이언트 발신 ephemeral 정책을 조정자에게 확인하고 보정한
뒤 전체를 다시 실행했다. 최초 실패를 기능PASS로 세지 않는다. 경고는 기존 pytest 빈
match 경고와 FastAPI TestClient의 httpx deprecation이며 의존성을 설치해 없애지 않았다.

## 아직 검증하지 않은 범위

- Gazebo/ROS/DDS 실제 연결, source catalogue/자산/프로필이 실제로 기동 가능한지.
- native agent의 ROS STOP/0 reliable ACK·자원 한도·예외/강제종료·프로세스 잔여 정리.
- ADR-002 §8 명령 지연p95≤100ms·입력 끊김→실제0≤0.4초·STOP 뒤 실제 자동재개0.
- 실제 폰/LAN·실기·WSS/TLS·실폰 Origin 배포·사진 저장/실카메라.
- native 다중 로봇 spawn/despawn/TF 격리: 실제1대 한도로 명시 거부, 4단계 작업.
- 화면이 simulation 필드를 받아 항상 «시뮬»을 표시하는 실제 UI 연동.
- 운영DB/마이그레이션/서비스 교체·배포0.0014는 private fixture 왕복만 시험.

실제 실행은 [FIRST-LAUNCH](FIRST-LAUNCH.md)의 별도 제품 책임자 승인과 정확한 commit·환경
고정 뒤 수행한다. 원본에 새 출력 폴더가 생기는 기존 runtime 계약도 승인 범위에 포함해야 한다.

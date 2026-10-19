# 격리 시뮬 첫 연결 도구

새 `sensor-runtime-r1/live_map.py --isolated-verify` 실행 한 개와 현재 worktree의
실제 ROS 다리·개발 서버를 검증한다. 기존 시뮬 원본은 읽고 실행하기만 한다.
운영 unit, domain 61, 기존 기동/종료 래퍼, 실기, Nav2·SLAM을 사용하지 않는다.
기동 권한은 이 도구 설치와 별개다. 승인된 환경·횟수에서만 실행한다.

## 준비

저장소 루트에서 실행한다. 기존 ROS Jazzy setup 경로와 원본 런타임 경로는
운영자가 환경 변수로 지정한다. ROS는 OS 패키지를 사용하고 가상환경은
`--system-site-packages`로 만든다. 원본이나 다른 worktree에 설치하지 않는다.

| 환경 변수 | 값 |
|---|---|
| `SIM_SOURCE` | 기존 `sensor-spec-20261016/stage/sensor-runtime-r1`의 절대 경로 |
| `SIM_ROS_SETUP` | 설치된 ROS Jazzy `setup.bash`의 절대 경로 |
| `SIM_RUN_DIR` | 아직 없는 이 worktree의 `runs/sim-d1/<tag>` 절대 경로 |
| `FH_SIM_D1_RUN` | 명시적으로 `1`일 때만 기동 |
| `FH_SIM_D1_MOTION` | 기본 비활성; 조종까지 승인된 실행만 `1` |
| `SIM_WORLD_SDF` | 조종할 때 실제 `v5_single/f1` GT 원본 SDF 절대 경로 |

```sh
source "${SIM_ROS_SETUP:?set the existing Jazzy setup path}"
python3 -m venv --system-site-packages .venv-sim-d1
.venv-sim-d1/bin/pip install -r apps/server/requirements-test.txt
.venv-sim-d1/bin/python -m pytest apps/agent/tools/sim -q
.venv-sim-d1/bin/python apps/agent/tools/sim/check_mutations.py --report runs/sim-d1/mutations.json
# SIM_SOURCE / SIM_RUN_DIR도 위 표에 따라 먼저 설정한다.
FH_SIM_D1_RUN=1 .venv-sim-d1/bin/python apps/agent/tools/sim/d1.py
.venv-sim-d1/bin/python apps/agent/tools/sim/analyze.py "$SIM_RUN_DIR"
```

실행 셸에 domain 61 환경을 가져오지 않는다. 부모는 ROS 참가자가 아니며,
자식에만 93·LOCALHOST·LOCALHOST_ONLY=1을 준다. DDS 프로필·외부 발견 설정은
조용히 지우지 않고 거부한다. 추가 `ros2` CLI나 관찰 노드를 띄우지 않는다.
unit은 호출 셸과 다른 user manager 환경을 받을 수 있어, unit 안에서도 ROS setup을
source한 **뒤** 같은 `validate_isolation()`을 실행하고 충돌 DDS 설정을 ROS 초기화 전에 거부한다.

## 관문과 정리

1. `/proc`에서 domain 93 프로세스 0, `ss`에서 후보 UDP 30650–30899 점유 0,
   MemAvailable ≥2500 MiB·load1 ≤9를 확인한다. domain 61의 PID·start_ticks와
   자손 목록, 원본 파일 SHA, free/vmstat/GPU 수치를 로컬에 기록한다.
   권한 때문에 읽지 못한 `/proc` 수는 기록하며, 이를 호스트 전체 부재 증명으로 쓰지 않는다.
2. 새 `fh-rb-sim-<tag>` user unit만 실행한다. MemoryMax=1500M, swap=0,
   CPU=200%, TasksMax=256, RuntimeMaxSec=240이다. 출력은 원본 spec 바로 아래의
   새 `rb-app-<tag>`만 사용한다. ROS 로그와 증거는 `SIM_RUN_DIR`에 쓴다.
3. 1초 간격 OS 감시기가 MemAvailable <1500 MiB, swap-in >2000 KiB/s 연속
   10초, 제한 시간에 새 MainPID만 SIGINT한다. unit·cgroup·PID·start_ticks가
   기록과 같아야 하며, 감시기와 정상 종료를 합쳐 최대 한 번만 보낸다.
   systemd도 main-only 종료를 사용한다. 다른 프로세스를 종료해 자원을 만들지 않는다.
4. STOP true·실제 cmd_applied=0·episode≥1·LOCKSTEP·정책 동작·센서 프레임과
   sim 시각 증가를 확인한다. 실행 중에는 `/proc`의 새 cgroup·domain 93·새
   `fh-srv-<12hex>` partition을 확인한다. 원본 manifest는 종료 시에만 생성되므로
   종료 뒤 같은 partition/domain/GT SHA와 원장 불변을 대조한다. `live-identity.json`은
   이 실행 중 관측 기록이며 원본 manifest를 대신 생성한 파일이 아니다.
5. 기존 private PostgreSQL fixture(Unix socket만)·bootstrap·개발 ORM 등록 경로로
   총괄/운영 계정과 시뮬 로봇 한 대를 만들고, 기존 API에서 토큰을 발급한다.
   로봇 생성 REST API가 없어 ORM 등록은 기존 개발 도구와 같은 방식이다.
   서버는 현재 worktree의 `apps/server`, 사전 bind한 loopback 9020–9039 한 포트,
   worker 1개다. 비밀번호·Bearer 값은 메모리/자식 환경에만 두고 출력하지 않는다.
6. 실제 `python -m foothold_agent.ros_bridge`를 실행한다. 서버의 hello 수락 사건,
   화면 WS ONLINE/STOP_LATCHED/applied=0과 native ROS 상태를 확인한다.
   REST `/robots`도 읽어 기록하되 현재 고정 OFFLINE/null 공백은 별도 S1 범위로 남긴다.
7. 다리 → 서버/임시 DB → 관찰 노드 → 시뮬 MainPID 순으로 정상 종료한다.
   native kids/cleanup.complete, cgroup/domain93/partition/후보 포트 잔여 0,
   개발 포트 반납, domain61 PID/start_ticks·원본 SHA·운영 원장 불변을 확인한다.
   실패하면 자동 재기동하지 않는다. 정리 미확인이면 다른 실행도 시작하지 않는다.

`RuntimeMaxSec` 만료 5초 전 감시기가 SIGINT한다. 영구적으로 반환하지 않는
publisher나 OS 전체 정지는 이 Python 감시기로 보장하지 않는다. SIGINT 뒤 정리
실패 시 자동 KILL하지 않고 실패로 기록하므로 담당자에게 에스컬레이션해야 한다.
MemoryMax·CPUQuota는 시뮬 unit에 적용된다. 개발 서버·PostgreSQL·다리·관찰기는
그 cgroup 제한 밖이며 전역 메모리/swap 감시와 자신의 자식 정상 종료로 관리한다.

## 별도 승인된 제한 조종

`FH_SIM_D1_MOTION=1`을 준 실행만 단계4 뒤 진행한다. GT의 모든 지형 collision을
회전 box/OBJ 경계로 보수적으로 감싸 장애를 검사하고, 평평한 바닥 box의 정확한
직사각형 합집합으로 지지면 연속성을 검사한다. 실제 GT pose/heading에서 전방
3 m에 몸체 전방 0.5 m·좌우 각각 0.6 m 여유를 더한다. 모르는 형상·변환은 거부한다.
world include는 이름 `go2_v2`·URI `model://go2_v2_map`·검증한 pose 문법을 가진
자기 로봇 하나만 제외한다. 다른 include·중첩 model/include/frame·미지원 world 구조나
plugin은 거부한다. static 지형과 floor z=0을 전제로 몸 z도 0.20–0.75 m인지 검사한다.
각 회 직전에 다시 검사하며, 종료 manifest의 world SHA와 GT 증거를 대조한다.

실제 조종권·unlock·RESUME 피드백·새 중립 이후 전진 `[0.6,0,0]`만 최대 2회다.
현재 도구의 입력 burst는 0.30초이며, 첫 회는 화면 WS STOP 버튼 메시지로 끝낸다.
둘째는 입력만 끊어 Core의 0.3초 만료에 따른 실제 ROS 0을 관찰한 뒤 STOP한다.
0.30초 burst에 만료 0.30·tick 0.05·출력 0.05·policy 표본 0.10초를 더한 약
0.80초로 1초 상한 여유를 확보한다. 전달·OS 지연의 실시간 상한 보장은 아니며,
실제 적용 1초 초과 검사도 유지한다. 아래 D1 수치는 변경 전 0.55초 burst 기록이다.
각 회 실제 policy 비영/0과 body_still을 확인하고, 몸 정지 확인 전 다음 회를
시작하지 않는다. 낙상·오래된 상태·정책/LOCKSTEP 이상은 즉시 STOP 후 종료한다.
회전·횡이동·RESET·임의 속도 옵션은 없다. 0.6은 승인된 시뮬 시험값이다.
마지막 STOP도 최대 2초 동안 신선한 ROS STOP/0·화면 WS latched/0을 확인한다.
실패는 `motion-stop-cleanup.json`에 따로 남기고 이미 발생한 오류나 Ctrl-C를 가리지 않는다.
HTTP/WS 시험 클라이언트는 환경 프록시를 사용하지 않는다.

입력 만료, ROS 발행, policy 적용, 몸 정지는 다른 관측이다. `analyze.py`는
observer/driver의 같은 호스트 monotonic 시각으로 각각 계산한다. policy/body 상태는
10 Hz라 표본 해상도가 있으며, 몸 정지는 native body_still 임계값 표식이다.
deadman의 기준은 **에이전트의 마지막 서버 cmd 수신**이다([04 §3.2](../../../../docs/spec/04-ARCHITECTURE.md#32-연결-끊김-처리),
[05 §10.3 규칙2](../../../../docs/spec/05-API-SPEC.md#103-에이전트-쪽-필수-규칙-서버가-무엇을-보내든)).
화면 send 직전부터 ROS 발행까지의 측정만으로 에이전트 수신 기준 만료를 판정하지 않는다.

## D1 실측 (2026-10-20)

첫 격리 기동은 native manifest가 종료 시에만 생기는 점을 발견해 STOP 상태에서
보수적으로 정리했다. 실행 중 `/proc` 관문과 종료 manifest 대조를 승인받아 한 번
재시도했고, 단계0–4·제한 조종 2회·정리를 수행했다. 두 실행 모두 보호 대상 불변과
잔여 0을 확인했다. 실행 전 도구 파서 오류로 끝난 시도에는 시뮬을 기동하지 않았다.
실행한 판은 커밋 전 작업 사본(0.55초 burst, 실행판 해시 미보관)이다.
`d1c027a`는 그 뒤 run-dir·GT catalog 사전 거부를 추가한 판이므로 커밋 전체의 기동 검증은
아니다. 이후 검토 수정의 GT 구조 거부·0.30초 burst·unit DDS 검사·최종 STOP 확인도
ROS 없는 도구/변이 시험으로 확인했으며 시뮬은 재기동하지 않았다.

| 시험 | ROS 0 | ROS STOP | policy 0 | body_still | 트리거 이후 XY 변위 |
|---|---:|---:|---:|---:|---:|
| STOP 버튼부터 | 0.0387 s | 0.0389 s | 0.0515 s | 2.0644 s | 0.1400 m |
| 마지막 입력부터 | 0.3534 s | 0.4831 s | 0.4490 s | 2.1489 s | 0.2490 m |

둘째 ROS STOP은 입력 만료 자체가 아니라 policy 0 확인 뒤 시험기가 누른 STOP이다.
입력 끊김의 시작점은 마지막 화면 `ws.send` 직전이며, 에이전트 cmd 수신 시각은
측정하지 않았다. 마지막 비영 ROS 발행은 +0.3018초, 첫 0은 +0.3534초로 그 사이 약
52 ms다. Client의 50 ms tick이 Core의 `>0.3` 만료를 확인하고 일반 ROS 출력도
50 ms 주기를 쓰므로, 명목상 0.30–0.35초에 출력 0–0.05초와 전달 지연이 더해진다.
수신 기준의 명목 분해는 0.30초 만료 + tick 0–0.05초 + 일반 ROS 출력
0–0.05초 + 전달 지연이다. 0.3534초는 화면 send 직전 기준이며 에이전트 수신 시각이
없으므로 이 기록만으로 수신 기준 0.300초의 준수/위반을 판정하지 않는다.
두 입력 burst는 0.5114/0.5146초, 두 회의 전체 XY 변위는 0.3005/0.3876 m였다.
STOP true 표본 중 비영 policy 적용 0, 낙상 0이었다. 재시도 unit 메모리 최고
684.4 MiB·MemAvailable 최저 3044.1 MiB·load1 최고 2.575·swap-in 최고 52.0 KiB/s였다.
이는 이 호스트의 짧은 실행 관측이며 두 시뮬 동시 실시간성·실기 안전 보장이 아니다.

남은 문제는 REST 요약 OFFLINE/null과 미연결 speed/pose/battery 측정값이다.
끝-끝 출력 상한을 새로 정하거나 만료 0을 urgent 출력으로 바꿀지는 별도 스펙/Core
결정이다. Core/link/서버 동작을 이 도구에서 고치지 않았다.
로컬 증거·원본 manifest·계정·지도·원시 센서 자료는 커밋하지 않는다.

A1b 후속: HTTP `trust_env=False`·WS `proxy=None`은 가짜 전송 시험과 변이로 고정했다.
`test_motion`은 선택 websockets 설치 없이 가짜 모듈로 실행한다. unit의 agent
PYTHONPATH 추가는 validator 한 명령에만 적용하고 live_map 자식에는 상속하지 않는다.
이 unit 변경과 0.30초 burst는 순수 시험만 실행했으며 실제 기동 재확인은 조정 세션 범위다.

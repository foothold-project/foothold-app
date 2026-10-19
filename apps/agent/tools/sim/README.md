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
# SIM_SOURCE / SIM_RUN_DIR도 위 표에 따라 먼저 설정한다.
FH_SIM_D1_RUN=1 .venv-sim-d1/bin/python apps/agent/tools/sim/d1.py
.venv-sim-d1/bin/python apps/agent/tools/sim/analyze.py "$SIM_RUN_DIR"
```

실행 셸에 domain 61 환경을 가져오지 않는다. 부모는 ROS 참가자가 아니며,
자식에만 93·LOCALHOST·LOCALHOST_ONLY=1을 준다. DDS 프로필·외부 발견 설정은
조용히 지우지 않고 거부한다. 추가 `ros2` CLI나 관찰 노드를 띄우지 않는다.

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

## 별도 승인된 제한 조종

`FH_SIM_D1_MOTION=1`을 준 실행만 단계4 뒤 진행한다. GT의 모든 지형 collision을
회전 box/OBJ 경계로 보수적으로 감싸 장애를 검사하고, 평평한 바닥 box의 정확한
직사각형 합집합으로 지지면 연속성을 검사한다. 실제 GT pose/heading에서 전방
3 m에 몸체 전방 0.5 m·좌우 각각 0.6 m 여유를 더한다. 모르는 형상·변환은 거부한다.
각 회 직전에 다시 검사하며, 종료 manifest의 world SHA와 GT 증거를 대조한다.

실제 조종권·unlock·RESUME 피드백·새 중립 이후 전진 `[0.6,0,0]`만 최대 2회다.
입력 burst는 약 0.55초이며, 첫 회는 화면 WS STOP 버튼 메시지로 끝낸다.
둘째는 입력만 끊어 Core의 0.3초 만료에 따른 실제 ROS 0을 관찰한 뒤 STOP한다.
각 회 실제 policy 비영/0과 body_still을 확인하고, 몸 정지 확인 전 다음 회를
시작하지 않는다. 낙상·오래된 상태·정책/LOCKSTEP 이상은 즉시 STOP 후 종료한다.
회전·횡이동·RESET·임의 속도 옵션은 없다. 0.6은 승인된 시뮬 시험값이다.

입력 만료, ROS 발행, policy 적용, 몸 정지는 다른 관측이다. `analyze.py`는
observer/driver의 같은 호스트 monotonic 시각으로 각각 계산한다. policy/body 상태는
10 Hz라 표본 해상도가 있으며, 몸 정지는 native body_still 임계값 표식이다.
0.300초보다 늦은 실측은 엄밀한 0.300초 마감 통과로 표시하지 않는다.

## D1 실측 (2026-10-20)

첫 격리 기동은 native manifest가 종료 시에만 생기는 점을 발견해 STOP 상태에서
보수적으로 정리했다. 실행 중 `/proc` 관문과 종료 manifest 대조를 승인받아 한 번
재시도했고, 단계0–4·제한 조종 2회·정리를 수행했다. 두 실행 모두 보호 대상 불변과
잔여 0을 확인했다. 실행 전 도구 파서 오류로 끝난 시도에는 시뮬을 기동하지 않았다.

| 시험 | ROS 0 | ROS STOP | policy 0 | body_still | 트리거 이후 XY 변위 |
|---|---:|---:|---:|---:|---:|
| STOP 버튼부터 | 0.0387 s | 0.0389 s | 0.0515 s | 2.0644 s | 0.1400 m |
| 마지막 입력부터 | 0.3534 s | 0.4831 s | 0.4490 s | 2.1489 s | 0.2490 m |

둘째 ROS STOP은 입력 만료 자체가 아니라 policy 0 확인 뒤 시험기가 누른 STOP이다.
입력 끊김에서 실제 0은 **0.3534초**였으므로 엄밀한 **0.300초 이내는 미달**이다.
두 입력 burst는 0.5114/0.5146초, 두 회의 전체 XY 변위는 0.3005/0.3876 m였다.
STOP true 표본 중 비영 policy 적용 0, 낙상 0이었다. 재시도 unit 메모리 최고
684.4 MiB·MemAvailable 최저 3044.1 MiB·load1 최고 2.575·swap-in 최고 52.0 KiB/s였다.
이는 이 호스트의 짧은 실행 관측이며 두 시뮬 동시 실시간성·실기 안전 보장이 아니다.

남은 문제는 REST 요약 OFFLINE/null, 미연결 speed/pose/battery 측정값,
입력 만료의 엄밀한 0.300초 마감 검토다. Core/link/서버 동작을 이 도구에서 고치지 않았다.
로컬 증거·원본 manifest·계정·지도·원시 센서 자료는 커밋하지 않는다.

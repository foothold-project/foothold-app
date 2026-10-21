# 첫 기동 승인 요청 계획 — 아직 실행하지 않음

대상은 P1-C Draft PR의 정확한 head commit + 승인된 private 설정이다. 제품 책임자 승인 전에는
아래 실행 절을 실행하지 않는다. 본 작업의 ROS/Gazebo/실기 실행·패키지 설치는0이다.
ADR-002 §8 1단계 성능 판정은 이 계획을 실행한 뒤에만 가능하다.

## 읽기 전용 조사 결과

- 기존 `apps/agent/tools/sim/{README,isolation,d1}.py` 조사. `validate_isolation`은 실제
  `foothold_agent/ros_bridge/config.py`에 있으며 새 관리자도 이것을 그대로 사용한다.
- 외부 `sensor-runtime-r1/SOURCE-SENSOR-RUNTIME-R1.md` 및 `live_map.py`를 읽었다.
  Go2 모델·worlds.json 카탈로그가 있고 `v5_single/f1`의 static GT 쌍을 지원한다.
  `--isolated-verify --sensor-profile l1-d435i-c2-min` 경로만domain93이다.
  기본 legacy 모드는61이므로 **그대로 실행하면 안 된다**.
- 원본에 `/v2_live/camera/compressed` JPEG 발행이 있다. 새 프로필424×240·format=jpeg.
  제어 `/v2_live/cmd_vel`, STOP `/v2_live/stop`, resume `/v2_live/resume`, state/odom/map도
  고정 절대 경로이며 TF도 단일 로봇이다. 새로운 runtime namespace remap을 추정하지 않았다.
- 원본 설치·수정·생성기·import/실행0. 다른 worktree의 기존 launch.json에서 경로만 읽었다.
  Go2 별도 작업공간 후보들은 이번 기동 계획의 실행 대상으로 선택하지 않았다.
- 조정 결정: **1단계 실제1대**만, 기본 상한2는 가짜 계약 시험에만 적용. 다중 로봇 native
  spawn/despawn/TF 격리는4단계 별도 작업이다. JPEG 원본 pass-through 허용, 640×360은 상한.

## 승인 전 준비물 / 중단 조건

1. PR head commit을 고정하고 두 모델 검토·기존 안전 셀프테스트 결과를 확인한다.
2. 운영자 소유0700 private 디렉터리에 catalogue·manager secret·에이전트 key ring·replay
   경로를 준비한다. 서버의 `FH_PHONE_PASS_KEYS`에 같은 robot UUID의 active/keys를 기존
   PR43 방식으로 사전 배포한다. 키 생성/배포는 별도 운영 절차이며 Git/로그에 넣지 않는다.
   사용자/조직/슬롯UUID·현재 로그인·소유 규칙을 대조한다.
3. catalogue의 world_file/map_file은 원본 `worlds.json`의 `v5_single/f1` world/gt_map의
   실제 경로와 정확히 같아야 한다. 원본 생성 센서 자산·provenance의 유효성도 확인한다.
4. manager는 기존 승인된 Python(서버 의존성+websockets), agent도 같은 기존 venv를 지정한다.
   ROS setup 뒤 Python 경로에 기존 ROS binding과 시스템 dist-packages를 연결할 수 있다.
   새 venv/패키지 설치 없이 준비되지 않으면 기동을 멈추고 질문한다. 현재 시험 venv는
   system-site-packages=false이며 기본 `/usr/bin/python3`에는 websockets가 없어 **그대로
   에이전트 Python으로 사용하지 않는다**. `FH_SIM_AGENT_PYTHON`을 명시한다.
5. OS 자료만으로 MemAvailable≥2500MiB·load1≤9·domain93 기존 소유0·후보DDS UDP
   30650~30899 비점유를 기존 D1 preflight로 검사한다. 다른 프로세스를 종료해 자원을 만들지
   않는다. domain61에는 ROS 참가·명령0; OS PID/start_ticks 불변 대조만 한다.
6. 리스너/목적지: manager9430, 별도 시험 control server9431, phone/camera agent9433.
   모두 승인된9430~9449 안. 로컬 폰 HTTP 시험UI가 필요하면 별도 승인된9440만 쓰고,
   기존8453/8792/5190/8870/9450~9479/5320~5329는 접촉하지 않는다.
   LAN 폰에는 승인된 sim PC 주소를 `FH_SIM_AGENT_HOST`로 지정한다. 이 실제 주소는 공개
   문서·PR·카탈로그 예시에 기록하지 않는다. manager bind는 언제나127.0.0.1이다.

## 승인받을 정확한 실행 형태

아래 변수의 실제 값/파일SHA와 PR commit을 승인 요청에 함께 고정한다. 예시는 비밀/주소를
포함하지 않는다. 이 문서에서 명령을 실행하지 않았다. 테스트 socket fence는 runtime
PYTHONPATH에 넣지 않는다. source 뒤 DDS override가 생기면 validator가 시작을 거부한다.

```sh
# 저장소 root, 이미 승인된 기존 Python·ROS setup·private 설정을 운영자가 지정한다.
: "${FH_PYTHON:?existing read-only venv Python}"
: "${SIM_ROS_SETUP:?existing Jazzy setup.bash}"
: "${SIM_SOURCE:?existing sensor-runtime-r1 real path}"
: "${FH_SIM_CATALOG:?private catalogue file}"
: "${FH_SIM_AUTH_FILE:?private 0600 service secret file}"
: "${FH_PHONE_PASS_KEYS:?existing PR43 server key map}"
: "${FH_DATABASE_URL:?isolated test DB only}"
: "${FH_ORG_ID:?test organization UUID}"
: "${FH_SIM_AGENT_HOST:?approved local or LAN interface}"
: "${FOOTHOLD_PHONE_ORIGINS:?approved HTTP test origins JSON}"
source "$SIM_ROS_SETUP"
export ROS_DOMAIN_ID=93 ROS_AUTOMATIC_DISCOVERY_RANGE=LOCALHOST ROS_LOCALHOST_ONLY=1 GZ_IP=127.0.0.1
export PYTHONDONTWRITEBYTECODE=1
export PYTHONPATH="$PWD/apps/agent:$PWD:/usr/lib/python3/dist-packages:${PYTHONPATH:-}"
export TMPDIR="$PWD/tmp/p1c"
export SIM_RUN_DIR="$PWD/runs/simmgr/approved-stage1-001"
export FH_SIM_PORT=9430 FH_SIM_MAX_ROBOTS=1
export FH_SIM_MANAGER_URL=http://127.0.0.1:9430
export FH_SIM_AGENT_WS_URL=ws://127.0.0.1:9431/agent/ws
export FH_SIM_AGENT_PYTHON="$FH_PYTHON"
# 0014는 기존 격리 DB 절차로 먼저 적용한다. 운영 DB에는 향하지 않는다.
"$FH_PYTHON" -m uvicorn apps.server.fh_server.api:create_app --factory --host 127.0.0.1 --port 9431 --workers 1 --no-access-log
# 다른 승인된 셸: 같은 환경. 이 명령 자체는 Gazebo를 시작하지 않는다.
FH_SIM_RUN=1 "$FH_PYTHON" -m apps.simmgr
```

마지막 두 명령은 별도 터미널이다. 서버를 먼저 올린 뒤 관리자를 올린다. 로그인한 시험 폰의
`POST /api/v1/simulation/robots {world_id:"v5_single/f1",robot_id:<사전배포slotUUID>}`
요청이 첫 실제 기동 트리거다. 관리자가 기존 D1 systemd user unit을 만든다:
`MemoryMax=1500M, MemorySwapMax=0, CPUQuota=200%, TasksMax=256, RuntimeMaxSec=240`,
`KillSignal=SIGINT, KillMode=process, SendSIGKILL=no, TimeoutStopSec=45`.
원본 native runtime argv는 기존 D1 supervisor에서 정확히
`/usr/bin/python3 "$SIM_SOURCE/live_map.py" --isolated-verify --sensor-profile l1-d435i-c2-min --purpose session --world-id v5_single --floor-id f1 --map-mode static --map-version gt-20261012 --out <새 rb-app 실행폴더>`다.
이 native 출력 폴더는 원본 isolation 계약상 source 프로젝트의 sensor-spec 아래 새 폴더다.
**원본 소스는 수정하지 않지만, 첫 기동 승인에는 그 새 실행 출력 쓰기 권한을 포함해야 한다.**
에이전트 argv는 `"$FH_SIM_AGENT_PYTHON" -m foothold_agent.ros_bridge`이며 키/토큰은 환경만,
`FOOTHOLD_PHONE_SIMULATION=1,FOOTHOLD_CAMERA_ENABLED=1`, 슬롯9433으로 실행한다.

메모리 예상: 기존 D1 단일 로봇 unit 최고684.4MiB 관측이 있으나 이번 commit 실측이 아니다.
unit 상한1500MiB + agent/manager/시험 서버/DB 수백MiB 추가 예상. 이 부가 프로세스는 unit
cgroup 밖이다. 모든 프로세스 합계 RSS·MemAvailable·swap-in을1초마다 별도 기록한다.
기존 watcher는 MemAvailable<1500MiB, swap-in>2000KiB/s 10초, runtime 만료5초 전
새 unit MainPID만 identity 대조 후SIGINT한다. 원본과 다른 프로세스는 건드리지 않는다.

## 확인·측정 (첫 실행 전 모두 미검증)

| 기준 | 측정 방법 / 통과 |
|---|---|
| 폰 조종 명령 지연p95≤100ms | 같은 PC 계측 드라이버에서 단조 send 직전·bridge 수신·ROS 발행·native cmd_applied 관측 시간을 별도 기록. 명령seq·가변 간격으로 짝짓기, 최소200표본. 폰 RTT와 robot 입력→출력을 분리하고 서로 다른 호스트의 UTC 차로 단방향 지연을 주장하지 않음. LAN 실제 폰은 별도 동일시계 관찰/왕복 측정의 한계 표기 |
| 입력 끊김→실제0≤0.4s | 마지막 폰send와 **에이전트 수신** 시각을 함께 기록, 입력만 끊고 마지막 비영·첫0 ROS/정책 적용 관측. Core 판정/정책 출력/몸 정지는 각각 기록. 최소20회, 최대값도 보고. 새 시뮬이 느려져도 단조 마감 유지 |
| STOP 뒤 재개0 | 조종/보기폰 STOP 각각. 0·래치·목표취소 확인 뒤 옛cmd·재접속·서버 재연결·카메라 재연결로 비영0건. 명시unlock+신선한중립 없이는 재개 없음 |
| 출입증/조종자 | 실제 PR43 발급→agent hello, control/view·서명·다른robot/org·만료·재사용·동시취득·단절·전환회수/ack 규칙. 부모 만료/회수/전환 때 영상도 닫힘 |
| 영상과 제어 분리 | 5fps·원본424×240·JPEG≤64KiB·실제크기표시·소스끊김NO_VIDEO. 영상만 느리게 읽는 폰으로 전체 cmd/STOP지연·deadman을 반복하고 영상 유실/닫힘에도 제어 연결 유지 확인. 이미지 저장0, 크기/수신시각/seq 통계만 |
| 초기/종료 | STOP true·cmd_applied0·episode≥1·LOCKSTEP·카메라 증가·sim시각 증가. agent listener RUNNING만으로 통과 판정하지 않음 |
| 격리 | 자신의unit/cgroup/domain93/partition과 종료 native manifest 대조. 원본sha·domain61 PID/start_ticks·원장불변·잔여DDS/포트0. 두 번째 native robot은409거부, 2대 격리PASS 주장은 하지 않음 |

계측은 승인된 임시 driver/observer를 같은domain93에만 두며 domain61 노드를 띄우지 않는다.
본 PR에는 계측 결과가 없고 관측 instrumentation/driver의 실제 연결 검증도 남아 있다.
실폰·Gazebo·DDS synthetic·종료ACK·네이티브 메모리/지연은 이번 오프라인 시험을 대체하지 않는다.

## 멈추기 / 실패 / 되돌리기

1. 폰 STOP으로0·잠금 확인. 서버 DELETE simulation/robots/{id}를 요청한다. 관리자는 agent에
   SIGINT를 보내고 기존 runner의 Hub.close→bridge ZERO/STOP→reliable ACK→정상exit0을
   기다린 뒤에만 native world를 정리한다. timeout/비정상exit는ERROR·world보존·새기동차단.
2. 관리자 Ctrl-C/SIGTERM도 같은 로봇별 정리를 수행한다. 새 simulator user unit의
   PID/start_ticks/cgroup을 재확인하는 기존 supervisor만 사용한다. 자동KILL/자동재기동0.
3. 정리가 확인되지 않으면 재시도하지 말고 담당자에게 에스컬레이션한다. 원본 프로세스·
   domain61·운영서비스는 종료하지 않는다. 시험 서버는 위 별도 터미널에서 정상Ctrl-C한다.
4. 기능 되돌림은 PR commit revert 후 기존 버전·DB0014 column 보존을 우선한다.
   0014 downgrade는 simulation 출처를 잃으므로 활성 시뮬0·기록보존·별도승인 뒤에만 한다.
   0013 출입증/회수 이력은 그대로 보존한다. Git push/PR은 이 실행 승인과 별개다.

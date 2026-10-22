# 첫 기동 승인 요청 계획 — P1-C2, 아직 실행하지 않음

대상은 PR #46의 정확한 head commit과 승인된 private 설정이다. 제품 책임자 승인 전 실행0.
이번 범위는 **같은 PC만**: 서버·관리자·에이전트 모두127.0.0.1, 트리거/측정은 같은 PC의
시험 driver를 기본으로 한다. 브라우저는 준비된 localhost 흐름만 쓰며 UI 연결은 이번에 미검증이다. 실폰 Wi-Fi 끝-끝 시험은 P1-D에서 한다. LAN bind·TLS를 추가하지 않는다.
브라우저 로그인은 secure 쿠키 때문에 HTTP의 **localhost**만 사용한다(127.0.0.1의 HTTP
쿠키 동작을 가정하지 않는다). localhost UI/driver가 준비되지 않으면 시작하지 않는다.

## 원본 조사와 제약

- `sensor-runtime-r1/live_map.py`에 Go2·worlds.json·`v5_single/f1` static GT 짝과
  `/v2_live/camera/compressed` JPEG가 있다. 새 프로필424×240, 고정 명령/상태/TF다.
  `--isolated-verify --sensor-profile l1-d435i-c2-min`만93이고 legacy 기본61은 실행 금지다.
- native는1대만. fake2대의 namespace/TF/topic/port 분리는 계약 시험이며4단계 native2대
  검증을 대신하지 않는다. 원본/다른 worktree 읽기만, 설치·수정·기동0.
- 관리자는 **ROS_*·RMW/DDS 환경이 있으면 빈 값도 시작 거부**한다. domain은
  `FH_SIM_DOMAIN=93` 설정이며 부모의 ROS_DOMAIN_ID가 아니다. 서버도 ROS 없는 셸을 쓴다.
  기존 preflight/cleanup은 다른93 프로세스·DDS 포트를 그대로 거부한다. 부모 PID를 예외 처리하지 않는다.
  관리자 서비스 startup에서도 fake/native 모두 같은 격리 preflight와 남은 fh-rb-sim/fh-simmgr-agent
  user unit 부재를 확인한 뒤만 API를 준비한다. 자원(MemAvailable/load) 기준만 fake에서는
  경고이며 실제 launcher는 그대로 거부한다. startup 요약은 시각·sim/agent unit 0개·93 프로세스 0·MemAvailable·load를 한 줄로 기록한다. 다른 프로세스/unit을 끄거나 정리하지 않는다.
  user bus 조회 오류는 시작 거부다. 빈 stdout의 unit show는 «이미 없음»이 아니라 bus/상태
  조회 불능이며, 정상 `LoadState=not-found`와 구분한다. 사용자 로그인 bus·XDG_RUNTIME_DIR·
  DBUS_SESSION_BUS_ADDRESS를 확인하고, 관문을 우회하지 않는다.
- simulator와 agent의 환경은 허용 목록으로 만든다. systemd-run 호출도 그 목록만 받고,
  unit payload는 `/usr/bin/env -i ... /bin/bash ...`라 user manager 환경을 다시 제거한다.
  agent만 ROS setup을 source한다. bootstrap은 PYTHONPATH를 비운 venv Python에서 시작한 뒤
  ROS binding·dist-packages를 sys.path 끝에 붙여 venv pydantic·typing_extensions가 먼저 온다.
  읽기 전용 경로 검사에서 기존 dist-packages 선행은 시스템 typing_extensions를 선택했고,
  새 bootstrap은 venv typing_extensions를 선택했다(ROS 앱 실행 없이 검증).

## 승인 전 준비와 중단 조건

1. 두 모델 검토·안전 회귀, 정확한 PR commit/설정 SHA를 고정한다. 개인 주소/키는 공개 기록에 넣지 않는다.
2. 실행 사용자 소유0700 private 폴더에 catalogue·0600 서비스 secret·agent key/replay 경로를
   준비한다. 슬롯 UUID별 키는 기존 PR43의 서버 `FH_PHONE_PASS_KEYS`와 agent ring에 미리
   같은 값으로 배포한다. 원문 토큰·키는 로그/URL/Git에 넣지 않는다.
3. catalogue world_file/map_file은 native `worlds.json`의 world/gt_map 실경로와 정확히 같아야 한다.
   기존 센서 생성 자산·provenance도 확인한다. 준비가 안 되면 설치/생성하지 말고 질문한다.
4. 기존 승인된 read-only Python을 사용한다. `/usr/bin/python3`에는 websockets가 없으므로
   agent에는 승인된 venv Python을 명시한다. ROS binding은 자식이 기존 Jazzy setup에서 얻는다.
5. 기존 OS preflight: MemAvailable≥2500MiB·load1≤9·다른domain93 소유0·DDS UDP30650~30899
   비점유. startup에서 61은 기록만 하며 거부 조건이 아니다. world 실행 전후
   PID/start_ticks 불변 대조는 Simulation이 별도로 한다. ROS 참가/명령0. 다른 프로세스를 종료해 자원을 만들지 않는다.
6. 리스너/목적지는 manager9430·격리 시험 서버9431·agent(phone+camera)9433만 사용한다.
   같은 PC UI가 별도 필요하면9440을 별도 승인한다. 운영8453/8792,5190/8870,9450~9479,
   5320~5329는 접촉하지 않는다. 시험 클라이언트 발신 ephemeral만 허용한다.

## 승인받을 실행 명령

두 터미널 각각 저장소 root에서 아래 환경을 준비한다. **이 문서의 명령은 실행하지 않았다.**
시험 fence는 runtime PYTHONPATH에 넣지 않는다. ROS setup을 제어 평면에서 source하지 않는다.

```sh
: "${FH_PYTHON:?existing approved venv Python}"
: "${SIM_ROS_SETUP:?existing Jazzy setup.bash}"
: "${SIM_SOURCE:?existing sensor-runtime-r1 real path}"
: "${FH_SIM_CATALOG:?private catalogue file}"
: "${FH_SIM_AUTH_FILE:?private 0600 service secret}"
: "${FH_PHONE_PASS_KEYS:?existing PR43 server key map}"
: "${FH_DATABASE_URL:?isolated test DB only}"
: "${FH_ORG_ID:?test organization UUID}"
# 현재 셸에 ROS가 있으면 부모에 넘기지 않는다. 관리자는 누락을 직접 거부한다.
for sim_env_name in ${!ROS_@} RMW_IMPLEMENTATION CYCLONEDDS_URI ROS_STATIC_PEERS ROS_DISCOVERY_SERVER FASTRTPS_DEFAULT_PROFILES_FILE FASTDDS_DEFAULT_PROFILES_FILE RMW_FASTRTPS_USE_QOS_FROM_XML FASTDDS_ENVIRONMENT_FILE; do
  unset "$sim_env_name"
done
export PYTHONDONTWRITEBYTECODE=1
export PYTHONPATH="$PWD:$PWD/apps/agent"
export TMPDIR="$PWD/tmp/p1c"
mkdir -p "$TMPDIR"
export FH_FILES_ROOT="$PWD/runs/simmgr/approved-stage1-001/server-files"
export SIM_RUN_DIR="$PWD/runs/simmgr/approved-stage1-001/native"
export FH_SIM_DOMAIN=93 FH_SIM_PORT=9430 FH_SIM_MAX_ROBOTS=1
export FH_SIM_MANAGER_URL=http://127.0.0.1:9430
export FH_SIM_AGENT_WS_URL=ws://127.0.0.1:9431/api/v1/agent/ws
export FH_SIM_AGENT_HOST=127.0.0.1 FH_SIM_AGENT_PYTHON="$FH_PYTHON"
export FOOTHOLD_PHONE_ORIGINS='["http://localhost:9440"]'
# 기존 절차로 격리 DB에0014까지 적용하고, 이 실행 전용 files 폴더를 준비한다.
# 터미널1 — source/ROS 환경 없이 시험 서버:
"$FH_PYTHON" -m uvicorn apps.server.fh_server.api:create_app --factory --host 127.0.0.1 --port 9431 --workers 1 --no-access-log
# 터미널2 — 위 준비를 동일하게 적용한 뒤 관리자(명시 opt-in):
FH_SIM_RUN=1 "$FH_PYTHON" -m apps.simmgr
```

서버 먼저, 관리자 다음이다. 같은 PC driver가 기존 로그인(Bearer 또는 localhost 브라우저
CSRF 세션)으로 `POST /api/v1/simulation/robots {world_id:"v5_single/f1",robot_id:<slotUUID>}`를
보내면 첫 실제 기동이 발생한다. 아직 이 driver/ROS 계측 연결을 실행하지 않았으며 P1-C2
승인 실행에서 준비·확인한다. LAN 폰으로 이 요청을 보낼 수 있다고 주장하지 않는다.

native unit은 `MemoryMax=1500M,MemorySwapMax=0,CPUQuota=200%,TasksMax=256,RuntimeMaxSec=240,
KillSignal=SIGINT,KillMode=process,SendSIGKILL=no,TimeoutStopSec=45`다. 정리/격리 검사는 기존 D1 그대로다.
unit payload는 허용 목록의 환경과93을 `/usr/bin/env -i` 뒤 지정하고 기존 ROS setup을 source한 뒤:
`/usr/bin/python3 "$SIM_SOURCE/live_map.py" --isolated-verify --sensor-profile l1-d435i-c2-min --purpose session --world-id v5_single --floor-id f1 --map-mode static --map-version gt-20261012 --out <새 rb-app 폴더>`.
**native 출력은 원본 계약상 source 프로젝트 sensor-spec 아래 새 폴더에 쓴다. 이 쓰기도
첫 기동 승인 범위에 반드시 포함한다.** 원본 파일 수정은 없다. 관리자 증거/ROS 로그와
시험 서버 파일은 위 현재 worktree의 새 실행 폴더다.

agent는 허용 목록+그 로봇 설정만 받아 별도 사용자 unit
`fh-simmgr-agent-approved-stage1-001.service`에서 실행한다. RuntimeMaxSec=240,
MemoryMax=512M·MemorySwapMax=0·TasksMax=128, KillSignal=SIGINT·TimeoutStopSec=15·
KillMode=control-group·SendSIGKILL=yes, RemainAfterExit=yes다. 종료 근거를 읽은 뒤
관리자가 자기 exited unit을 stop해 남은 자식을 수거한다. 관리자 SIGKILL/OOM/SIGHUP에도 unit의 수명 제한이 남는다.
상한을 넘으면 에이전트만 종료 → 링크 끊김 → 정지 쪽으로 실패하며 world는 따로 정리한다.
강제 종료는 STOP0 ACK 확인이 아니므로 world 보존/실패 보고 규칙을 유지한다.
첫 기동 때 agent 최대 메모리·task 수를 기록해 다음 실행의 상한을 다시 정한다.
자식 환경은0700 실행 폴더의0600 임시 JSON으로 전달하고 bootstrap이 읽은 즉시 지운다.
토큰은 unit argv/상속 환경에 넣지 않는다. 자식 셸이 ROS setup을 source한 뒤 venv 우선
경로로 `foothold_agent.ros_bridge`를 실행한다. unit 이름은 실행 폴더의 episode 이름으로
고정되며 기존 unit 이름 재사용은 거부한다. `FOOTHOLD_PHONE_SIMULATION=1,FOOTHOLD_CAMERA_ENABLED=1`,
슬롯9433이다. DB URL·서버 출입증 key map·manager secret 경로·FH_SIM_RUN은 전달하지 않는다.

메모리 예상은 기존 D1 unit 최고684.4MiB 관측을 참고한 값이며 이 commit 실측이 아니다.
unit 상한1500MiB 외 agent/manager/시험 서버/DB 수백MiB가 더 든다. 전체 RSS/MemAvailable/
swap-in을1초마다 기록한다. 기존 watcher는 MemAvailable<1500MiB, swap-in>2000KiB/s 10초,
runtime 만료5초 전 자신의 새unit MainPID만 identity 확인 후SIGINT한다.

## 측정 정의 (아직 실제 값 없음)

| 항목 | 표본과 판정 |
|---|---|
| 명령 지연 | **같은 PC driver의 WS send 직전 monotonic → agent velocity publisher 호출 반환 monotonic**. ROS 출력에 가장 최근 승인 cmd seq를 계측으로 연결. 조이스틱 계약과 같은 **50ms(20Hz)** 간격, 준비/중립 후 유효200개, nearest-rank p95≤100ms. 누락/미매칭을 조용히 제외하지 않고 실패로 기록. agent 수신 시각도 별도 보존하며 native cmd_applied/몸 정지는 참고 지표로 구분 |
| 입력 끊김 |50ms 간격 송신을 멈춘 마지막 driver send→첫 agent ROS0≤0.4s,20회·최대값 판정. 마지막 agent 수신부터0도 함께 기록. ROS0/정책0/몸 정지 각각 구분, 시뮬이 느려져도 단조 마감 유지 |
| STOP/재개 |control/view STOP 각각0·잠금·목표취소 확인. 이전cmd·재접속·서버 재연결·영상 재연결로 비영 재개0건. 명시unlock+신선한중립 뒤만 재개 |
| 출입증·조종자 |PR43 실제 발급/회수/ack·전환·만료·중복·다른robot/org·단절·동시취득. 제거 때 살아 있는 출입증 회수, 실패 감사, 슬롯 재사용과 이전 출입증 회수 전달 확인. 부모 종료/만료/회수 때 영상도 닫힘 |
| 영상 격리 |0.2초 sampler가 보장하는≤5fps 상한(실측fps 보고, 원천 격자만으로 보장하지 않음)·JPEG≤64KiB·실제424×240·NO_VIDEO. 읽지 않는 영상 소켓/원천 폭주 중 위200표본 지연/20회 입력 끊김을 반복. 이미지는 저장0, 시각/seq/크기 통계만 |
| TCP 부가 진단 |운영 websockets serve()는 원래 TCP_NODELAY를 켠다.41ms는 proto0인 미리 bind한 시험 소켓 구성에서만 재현됐다. 별도 **20ms 간격 STOP 왕복60회** p95 보고. TCP_NODELAY 실제1 확인. 이 왕복은 위50ms 단방향 명령 지연 판정과 섞지 않음 |
| 관리자 비정상 종료 |승인된 자기 manager PID만 kill한 뒤 agent unit이 **kill 시각부터240s 안 종료**하는지 단조 시계로 기록. RuntimeMaxSec=240 뒤 정지 grace15초는 별도이므로 실제 종료가240s를 넘으면 실패로 기록하고 통과로 간주하지 않음. agent MemoryPeak·task 최대 관측값·kill 당시 unit 나이와 잔여 cgroup 함께 수집 |
| 초기/격리/정리 |STOP true·cmd_applied0·episode≥1·LOCKSTEP·카메라/시뮬시각 증가. 자기unit/cgroup/domain93/partition·native 종료manifest·원본SHA·61 PID/start_ticks·원장불변·잔여DDS/포트0. RUNNING listener만으로 통과 아님 |

driver와 계측 observer도 같은 PC이며 observer만domain93에 참가한다.
**순서 고정:** preflight와 world/agent 기동 완료 → observer 참가 → 계측·STOP0 확인 →
계측 수거 → observer 정상 종료 → observer PID와93 DDS 해제 확인 → 서버 DELETE.
preflight/DELETE cleanup 중 observer가 남아 있으면 실패이며93 검사를 예외 처리하지 않는다. 제어 평면 부모는
ROS 환경이 없다. 측정 hook/driver 실제 연결은 아직 미검증이다. 실폰/LAN 끝-끝 지연은
P1-D 별도 표로 측정하며 이 단계의 같은 PC 수치를 실폰 결과로 표시하지 않는다.

## 멈추기와 실패

1. driver STOP→0·잠금 확인·계측 수거 뒤 observer를 정상 종료하고93 DDS 해제를 확인한 뒤 서버 DELETE로 제거. 서버는 살아 있는 출입증을 기존 회수
   outbox로 먼저 commit하고, 정리 중 발급분도 완료 직전 조직 잠금 아래 회수한다. ACK·offline 600초 한계는05 §13.7 그대로이며 회수 전달을 따로 확인한다.
2. manager는 agent SIGINT→기존 Hub.close·bridge ZERO/STOP·ACK·exit0을 기다린 뒤만 world 정리.
   **Ctrl-C는 한 번만**. 별도 사용자 unit은 터미널 Ctrl-C를 직접 받지 않는다.
3. agent 정지15초 timeout은 failed로 고정하고 자기 unit만 SIGTERM→5초→SIGKILL→5초
   수거한다. 강제 종료는 STOP/zero 확인이 아니므로 **world/슬롯 보존·재기동 차단**이다.
   새 episode 전용 unit만 지정한다. simulator의 기존 no-KILL 정책/identity 검사는 유지한다.
4. 정리 실패 시 manager uvicorn은 오류로 종료될 수 있으며 남은 world는 보존된다(원래 unit의
   240초 제한은 별개). 재시도하지 말고 담당자에게 올린다. 운영/domain61/다른 프로세스는 종료하지 않는다.
5. Git revert와0014/0013 이력 보존이 우선. simulation 출처를 잃는0014 downgrade는 활성0·
   기록보존·별도승인 뒤만. 이번 작업에는 운영 DB migration·배포·기동0이다.

관리자가 비정상 종료했다면 **이 실행의 agent unit만** 아래 literal 이름으로 확인한다.
이 명령 역시 이번 작업에서는 실행하지 않았다. 정상 STOP/zero 확인이 없으면 world는
보존하고 실패를 보고한다. world 또는 다른 unit을 패턴으로 일괄 종료하지 않는다.

```sh
systemctl --user show fh-simmgr-agent-approved-stage1-001.service --property=ActiveState,Result,MainPID,ControlGroup
systemctl --user status fh-simmgr-agent-approved-stage1-001.service --no-pager
# 남은 자기 agent unit만 정리(강제 종료는 STOP/zero 통과가 아님):
systemctl --user stop fh-simmgr-agent-approved-stage1-001.service
systemctl --user show fh-simmgr-agent-approved-stage1-001.service --property=ActiveState,MainPID,ControlGroup
# 상태/최대 메모리·task 증거 수거·자기 cgroup 부재 확인 뒤 남은 failed 메타데이터만:
systemctl --user reset-failed fh-simmgr-agent-approved-stage1-001.service
```

마지막 MainPID=0·자기 cgroup 잔여 0과 unit 종료를 확인한다. unit 이름이 이미 있으면 시작을 거부한다. 정상 종료 후 unit이 회수되어도 기존 실행
폴더의 재사용을 거부하므로 새 실행에는 새 episode 이름/승인 폴더를 쓴다.

## 관리자 비정상 종료 뒤 슬롯 복구

1. driver STOP·observer 정상 종료·93 DDS 해제를 먼저 확인한다. 남은 자기 agent unit은 위
   literal 명령으로 확인/정리하고, world는 기존 D1의 자기 identity/정리 증거로 별도 확인한다.
   다른 unit이나 domain61/다른93을 종료하지 않는다. 남은 unit/프로세스가 있으면 startup은
   거부되어야 하며 빈 manager를 먼저 띄워 «없음»을 만들지 않는다.
2. 새 episode/증거 폴더로 manager를 재시작한다. **기존 isolation preflight와 sim/agent user
   unit 부재 검사 통과**가 전제다. 이후 빈 관리자 DELETE는 세대에 상관없이200이다.
3. 기존 담당자(또는 기존 제거 권한을 가진 총괄)가 같은 PC driver로 서버
   `DELETE /api/v1/simulation/robots/{slotUUID}`를 보낸다. STARTING·STOPPING 모두 허용한다.
   현재 관리자 로봇이 다른 세대라면 409 유지·실패 보고이며 강제로 DB를 고치지 않는다.
   관리자에 로봇이 남아 있으면 1·2단계로 되돌아가 자기 runtime 정리와 부재 관문부터 확인한다.
4. 204 뒤 DB의 IDLE/owner 해제·출입증 회수·hash 교체·REMOVED 감사 1건을 확인한 다음
   올바른 world로 POST한다. 새 취득의 세대는 증가하고201이어야 한다. 이전 담당자는
   IDLE 뒤 owner가 아니므로 반복 DELETE는 기존 권한 판정상403일 수 있다. 첫204 응답이
   유실돼도 목록의 현재 로봇 부재와 재취득201을 함께 확인한다. 빈 목록만으로 DB IDLE을
   단정하지 않으며403 시 슬롯·owner·hash·감사를 바꾸지 않는다.
5. 확실한 시작 전4xx 목록은 [05 §13.9](../../docs/spec/05-API-SPEC.md#139-시뮬-관리자-중계-p1-c-준비)만
   자동 IDLE·START_REJECTED다. timeout/5xx/유실/신원 불일치는 STARTING 유지 후 위 DELETE로
   복구한다. REMOVE_FAILED는 관리자/relay 거부, REMOVE_STALE은 성공 응답 뒤 서버 세대/상태가
   이미 바뀐 경우이며 뒤의 경우 현재 슬롯을 바꾸지 않는다. 둘 다 실패 원인을 확인한다.

관리자는 DELETE의 최대 세대를 슬롯별 제거 확인 세대로 메모리에만 기록하며, 그 이하 POST는
생성 전에 409 SIM_GENERATION_STALE로 거부한다. 재시작 시 기록은 비워진다. 서버의 관리자
POST는 자동 재전송하지 않는다. 다만 서버 commit 뒤 송신 전 지연된 **첫 전달**은 새 관리자에
도착할 수 있다. 이 경계는 성공·불확실 결과 모두의 DB 세대/STARTING 최종 확인과 보상이
맡으며 startup 부재 관문만으로 배제하지 않는다. 불일치면 잠금 밖에서 같은 세대로 DELETE를
1회 보상하고 START_STALE 감사 1건에 결과를 남긴다. STALE 409는 생성 없음이므로 DELETE
없이 NOT_CREATED 감사 1건이다.
503 응답만으로 STARTING 유지인지 보상됐는지 구분할 수 없으므로 목록·감사·재취득을 함께 확인한다. 불확실 결과라도 DB 세대/STARTING이 그대로면 보상하지 않는다.

응답 유실과 보상 실패가 겹치면 고아 runtime이 남을 수 있다. 서버 token hash는 이미 바뀌어
그 에이전트가 서버에 붙지 못한다. 폰 출입증의 offline 600초 한계와 STOP0 확인은 별개다.
world·agent unit은 각각 RuntimeMaxSec=240으로 자동 종료를 요청한다. world의 정지 grace 45초·
agent 15초는 별도이고, 실제 종료/고아 정리/STOP0는 이번에 검증하지 않았다. 다음 POST가
SIM_SLOT_BUSY(불확실)라면 자동 재전송하지 않고 위 복구 1·2단계로 돌아가 자기 runtime과
unit 정리·부재 관문을 확인한 뒤 새 episode/기존 DELETE 복구를 따른다. 현재 DB를 임의로
IDLE로 덮거나 다른 세대 로봇을 지우지 않는다.

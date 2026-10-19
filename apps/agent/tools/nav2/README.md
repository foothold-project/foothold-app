# A3a-1 Nav2 준비 (ROS/시뮬 미실행)

R0′ 단층 GT 실험을 위한 준비 코드다. MS-05 전체나 실제 도달 성공을 뜻하지 않는다.
설계 근거는 조정자가 제공한 A3a-0 조사 §4(시각·지도), §5(제한 보행), §6(안전 경로),
§7(사전등록), §8(A3a-1)이다. 원본 sensor-runtime/control-app, Core, 계약, 서버는 수정하지 않는다.

```
controller_server Twist -> /fh_nav/intent -> NavExecutor (최신 1건/원수신 시각)
 -> Owner -> Session.executor_command -> 기존 Core -> 기존 RosSink
 -> 유일 /v2_live/cmd_vel·stop·resume writer
```

`Owner`가 Session 접근과 sink 적용을 직렬화한다. STOP·lease 변경·PAUSED·낙상·정책 오류는
0 출력 후 비동기 cancel을 접수한다. ACK를 기다리지 않는다. Core 상태를 직접 쓰지 않는다.
RUN 조종권·새 neutral·stop_gen·실제 STOP/RESUME 피드백을 기존 Session으로 통과한다.
대기 중 건강한 생산자는 새 0을 내고, Nav2 실행 중 callback이 끊기면 poll은 None을 낸다.
옛 의도를 다시 발행하지 않아 Session의 엄격한 `>0.3wall초` 실패 판정이 살아 있다.
0.2초 정책 수신/원천 progress 상한은 더 보수적인 실험 관문이다. 기존 Core 1초는 그대로다.
기존 sink 독립 apply watchdog·flush 감시·매 spin 단일 writer 검사도 그대로다.

`policy.json`의 0, .6m/s 직진, .6m/s·±.5rad/s 곡선은 기존 Core의 4값이다.
어댑터는 정확히 같은 SI 값만 normalized axes로 바꾸고 Core 양자화와 대조한다.
저속·후진·횡이동·제자리 회전·NaN·범위 밖은 0+사유다. 허용 오차를 이용한 증폭도 없다.
곡선은 `allow_curves=false`: 실제 곡선 STOP·swept 실험 전 비활성이다.
RPP는 .6을 요청할 수 있으나 충돌·접근 감속 요청을 .6으로 올리지 않는다. 낮은 요청으로
미도달하면 실패다. 이 제한으로 도달이 가능한지는 A3a-2/3 실측과 검토가 필요하다.

`nav2_params.yaml`은 TB3 설정 복사가 아니다. 실제 TF는
`map -> odom -> base_footprint -> base -> lidar_link`이다. `base_link`를 만들어 있다고
가정하지 않는다. Nav2 base frame은 base_footprint이고 map→odom 항등은 기존 live_map만
발행한다. AMCL/SLAM/map_server는 띄우지 않는다. 기존 `/v2_map/map`의 reliable/
transient_local 지도를 쓴다. 모든 Nav 노드·adapter는 use_sim_time=true다.
Go2 보수 외곽은 기존 GT 검사 .5m 전후·.6m 좌우이며 원 반경은 hypot(.5,.6)를 올림한
.782m다. 실측 footstep 크기나 실기 안전 보장값은 아니다. inflation 등 나머지 값은 미실행
초기 설정이며 실측 보정이 필요하다.

`SimOdom`은 같은 sim stamp의 odom→base_footprint TF와 /clock·scan을 검사하고 연속 pose
차분으로 base 원점 twist를 child frame에 낸다. `/v2_live/odom`의 wall header를 덮지 않는다.
동일 stamp·역행·episode 변경·간격>.25초·시간 불일치>.02초는 거부한다. .25/.02초는
원본 10Hz 입력에 대한 보수 초기 검사값으로 `policy.json`에 분리했다. 실제 일치 오차를
A3a-2 STOP 상태에서 확인한다. 실패/지연이면 readiness가 만료되어 이동을 막는다.

## 노드 없는 준비·시험

저장소 루트에서, 이미 준비된 시험 Python으로 실행한다.

```sh
PYTHONPATH=apps/agent python3 apps/agent/tools/nav2/runner.py
python3 -m pytest apps/agent -q
PYTHONPATH=apps/agent python3 apps/agent/tools/nav2/check_mutations.py --report runs/nav2-prep/mutations.json
# 승인된 로컬 원본 경로를 환경에 지정한 뒤 새 사본만 생성:
PYTHONPATH=apps/agent python3 apps/agent/tools/nav2/prepare.py --map-source "$NAV_GT_SOURCE" --output runs/nav2-prep/new-map
```

지도는 v5_single/f1/gt-20261012 원본 pgm/yaml/meta의 고정 SHA·해상도·origin을 검증하고
새 폴더에 그대로 복사한다. 원본 static publisher와 같은 int8 변환(뒤집힌 행,
0→100/254→0/그 밖→unknown)의 SHA도 계산해 실제 OccupancyGrid payload와 대조한다.
지도 metadata는 원본 1Hz publish_status 주기에 맞춰 1.5초 상한(policy.json)을 쓰고,
이 캐시가 정책의 0.2초 신선도나 pose를 대신하지 않는다. 원본을 고치지 않는다. 지도 payload와 runs 산출물은 Git 제외다.
`swept()`는 world SHA를 고정하고 기존 검토된 SDF/OBJ 충돌·평지 지지면 parser를 재사용한다.
직선 전 경로를 지도 1cell(.05m) 이하 간격으로 검사한다. 각 표본은 전방3m+전후.5m/
좌우.6m 보수 사각형을 검사하므로 표본 사이도 겹쳐 덮인다. 회전·후진 경로는 거부한다.
실행 중 실제 GT pose도 매번 별도 작업자에서 재검사한다. 새 경로는 proof 전 0이며,
검사 지연/실패는 이동 보류/실패다. 2D free만으로 계단·낭떠러지를 허용하지 않는다.

새 시험은 Fake Nav2·Fake sink 및 기존 in-process rclpy stub만 쓴다. ROS 초기화·노드·
시뮬·unit·실기·HTTP 서버·포트 사용 0이다. 기존 전체 시험의 loopback 가짜 서버와
명시 DDS opt-in skip은 별도다. 새 변이는 import/fixture 오류가 아니라 assertion만 KILLED로 센다.

## A3a-2/3에 넘기는 실행 경계

`runner.py` 기본은 OFFLINE_PLAN_ONLY다. `--execute`와 `FH_NAV2_EXECUTE=1`은 별도 승인
실행에서만 사용한다. 이번 작업에서는 호출하지 않았다. runner는 서버/시뮬/Nav2/unit을
만들거나 PID에 신호를 보내지 않는다. 이미 격리된 domain93/LOCALHOST와 Nav2가 있어야 한다.
`launch_nav2.py`는 승인 환경에서만 launch description을 반환하며 자동 실행하지 않는다.
controller/behavior의 cmd_vel·cmd_vel_nav·cmd_vel_smoothed를 모두 /fh_nav/intent로 remap한다.
behavior_plugins=[]이며 BT에는 경로 계산/추종만 있다. smoother·collision_monitor·docking·
waypoint follower는 기동 목록에 없다. 타입은 Twist로 고정하고 graph에서도 검사한다.
Nav2가 다리의 세 명령 토픽에 직접 발행하면 기존 단일 writer 관문이 종료시킨다.

runner는 별도 Nav cgroup(memory≤768MiB/swap0/CPU≤150%/tasks≤256)을 요구한다.
조정/기존 시뮬 담당이 native(1500MiB/CPU200%/tasks256/240s)·Nav 소유 cgroup과 새
partition·out·로그를 준비하고 독립 외부 감시/정리를 맡는다. Python 내부 스레드는 프로세스
정지·GIL 독점·OS 지연을 보장하지 않는다. runner는 호스트 메모리/load/GPU/swap/RTF를
읽고 사전등록 상한을 검사하며 자신의 bridge만 닫는다. 실행 후 원본·원장 SHA와
소유 PID/start_ticks/cgroup·domain/partition/포트 잔여 대조는 외부 감독자의 관문이다.
`cleanup_verified=false`를 기본 기록하므로 별도 증거 없이는 다음 회/완료 GO가 안 된다.

`--trial 1..10`, `--points`(고정 사전등록 목록), `--map-source`, `--world`,
`--output`(이 worktree runs/ 아래 **새 폴더**), `--isolated-start-id`, `--history`가 실행 입력이다.
첫 회 외에는 정확한 선행 순서·성공·정리 증거가 필요하다. 각 invocation은 새 격리 시작에서
목표 하나만 보낸다. retry/reset/spawn 이동/수동 대체 완료/자동 재개가 없다. untagged Twist를
다음 goal로 오인하지 않도록 action mailbox도 한 프로세스 한 목표만 허용한다. 늦은
acceptance는 cancel하며 feedback/result는 전체 Binding(run/goal/episode/stop_gen/world/
floor/SHA)이 일치할 때만 받는다. 실제 서버 인증·RUN lease·Q5 통합은 A3b 범위다.

안전4회(manual STOP/입력 끊김, auto STOP/intent 끊김)→G1,G2 각3회 순서가 JSON에 고정된다.
자율 끊김 대조는 adapter의 명시 생산 gate를 닫아 fresh intent 접수를 끊는다(ROS 프로세스는
종료하지 않음). 자동 목표 성공 뒤에는 살아 있는 ROS owner가 새 zero heartbeat를 내어
GT 정지유지를 관측한다. Nav2 SUCCEEDED만으로 도달을 선언하지 않는다.
사전등록의 도착 오차 .30m/15°, 실제 |vxy|≤.05/|wz|≤.10·tilt≤20°·낙상0·명령0을
동일 episode 신선 표본으로 2sim초 유지해야 성공이다. STOP5wall초/.5m 변위,
끊김 마지막 실제 수신→ROS zero .50wall초 상한, 비영 누적4/연속1초, 목표30wall/20sim,
전체240wall 상한을 코드로 판정한다. 시작 전 거부는 BLOCKED_NOT_STARTED로 분모와
분리하지만 R0 완료를 막는다. 시작 뒤 안전 개입·미수렴·unsupported 명령은 FAILED다.
모든 정지 판정에서 sink apply·ROS zero·policy zero·몸 정지는 별도 사건이다.
.50초는 실험 실패 상한이며 기존 Core .30초를 완화하지 않는다.

기록은 `fh-nav2-trial/1` JSONL과 result.json이다. 실제 수신 monotonic, sim/episode,
Core→sink 출력, 원/정제 의도와 사유, GT/자원·오차/몸속도·결과·seed 미설정 여부·
fixture lease/run을 남긴다. 디스크 작업은 bounded 별도 작업자이며 기록 실패는 STOP 경로다.
점군/영상 저장은 없다. `--replay`는 동일 Observation 형식의 입력으로 판정기만 재생한다.
기존 D1/D2 측정과 비교할 때 수신계측 없음·표본10Hz·burst/yaw/RTF 조건 차이를 보존해야 한다.

되돌림은 이 기능 커밋을 revert하고 extension_factory 없는 기존 RosNode 진입점을 사용한다.
기존 다리 진입점은 이 확장을 기본 활성화하지 않는다. push/PR은 기동/배포/실기 승인과 별개다.

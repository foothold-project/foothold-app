# A3a-1 Nav2 준비 — PR #20 검토 수정

실제 ROS/Nav2/시뮬은 실행하지 않은 준비 코드다. MS-05 전체·실제 도달 성공을 뜻하지 않는다.
설계 근거는 A3a-0 §4~8과 PR #20 두 모델 검토다. Core/기존 Core 시험·서버·계약·웹·원본은 변경하지 않는다.

```
Nav2 controller Twist → /fh_nav/intent → NavExecutor → Owner
 → Session.executor_command → 기존 Core → 기존 RosSink → 유일 /v2_live/* 명령 writer
```

원수신 monotonic을 콜백 진입 시 한 번 포착한다. poll 때 새 수신 시각을 만들지 않는다.
Owner의 **모든 출력 입구**가 원수신 `>0.3wall초`를 검사하므로 Session/Core가 poll 시각에
자체 시계를 갱신해도 원수신 마감이 연장되지 않는다. 수신 lock 안에서도 이전 마감을 먼저
검사하고 만료를 래치하므로 Owner보다 먼저 도착한 새 콜백도 이를 지울 수 없다.
정확히 .3초는 허용하며 초과는 만료다. 첫 명령 대기도 .3초다. 만료·STOP·정책/GT/자원 실패에는
0/STOP을 적용한 뒤 비동기 목표 취소를 접수한다. 실제 OS/통신 마감 보장과는 별개다.
Session/Core의 기존 .3초 규칙·잠금·조종권·neutral·stop_gen·sink 독립 watchdog은 그대로다.
로컬 STOP은 공개 `Session.shutdown()`을 사용한다. 가짜 서버 STOP 프레임으로 last_server를
늘리지 않는다. 이 보수적 로컬 중단은 세션도 닫아 새 명시 handshake를 요구한다. 제품에서
연결을 유지하는 로컬 STOP API가 필요하면 소유 밖 link/** 별도 작업으로 추가해야 한다.

`policy.json`의 명령은 Core의 0, .6m/s 직진, .6/±.5rad/s 곡선과 교차 검사한다.
D22에 따라 곡선은 기본 비활성이고 `yaw_zero_threshold_rps=.04` 이하의 작은 omega만
**0으로 줄인다**. .6m/s·1.2m lookahead·지도 1cell(.05m)의 RPP 곡률
`2*v*y/L²=.04167rad/s`보다 작게 설정한 문턱이다. 가까운 carrot에서는 더 작은 횡편차만
허용된다. 이 계산은 추종 정확도 증명이 아니며 GT sweep 검사는 별도다. 속도는 키우지 않는다. 물리 기본에서는 저속·후진·횡·
제자리 회전·비유한/비평면 입력도 거부한다. 첫 미지원 명령은 실행 거부를 래치해 이후 .6↔0
반복을 금지하고 회차를 실패시킨다. RPP 속도/cost 조절은 끄되 collision 검사는 유지한다.
접근 감속 거리도 0으로 꺼서 목표 위치/방향 허용오차로 정지한다. 설치된 Jazzy RPP
`regulation_functions.hpp`의 `remaining_distance < approach_velocity_scaling_dist` 조건에서
거리 0은 감속을 적용하지 않는다. collision 검사는 유지한다. 문턱 밖 곡률이나 다른 감속의
미지원 값은 계속 거부하며 .6으로 올리지 않는다.
`assess_commands.py`는 JSONL `input_si` 표본을 오프라인 재생해 TESTED 비율과 첫 래치 거부를
계산한다. 작은 회전 축소는 `TESTED_YAW_REDUCED`로 구분하여 원입력과 함께 기록한다.
`replay_paths.py`는 실제 params와 사전등록 지점을 읽고 0/1mm/2cm/5cm carrot 횡편차의
가짜 직선 경로를 재생한다. 8개 자율 회차×4 profile의 균등 합성 지원 비율이며 통계적
성공률이 아니다. TESTED 명령 종료와 별개로 연속/총 이동 예산도 표시한다.
`PYTHONPATH=apps/agent python3 apps/agent/tools/nav2/replay_paths.py`로 재생할 수 있다.
실제 추종·Nav2 결과·정지/도달 성공·마감 준수는 미측정이다.

프레임은 실제 `map→odom→base_footprint→base→lidar_link`를 사용한다. 없는 base_link나
두 번째 map→odom을 만들지 않고 GT live_map의 정적 항등을 검증한다. AMCL/SLAM/map_server는
추가하지 않는다. Go2 보수 외곽 .5m 전후/.6m 좌우의 외접원을 올림한 .782m 반경이며 TB3
값을 복사하지 않았다. params·action/lifecycle/remap/QoS의 실제 동작은 미검증이다.

sim odom은 TF의 원래 stamp와 연속 pose 차분을 사용한다. clock↔TF는 .02sim초, 10Hz scan의
비동기 위상은 .15sim초까지 별도 설정으로 검사하며 scan 불일치가 정상 TF 차분 이력을 지우지
않는다. 출발 전 정지 상태에서 **연속 10쌍**과 최대 시간 차를 기록해야 readiness가 열린다.
정책은 원수신·원천 progress .2wall초 상한이다. TF↔state x/y/yaw도 교차 검사한다.
실제 stamp 쌍/odom 오차는 A3a-2 STOP 상태에서 측정해야 하며 설정 변경에는 검토가 필요하다.
graph 조회는 .2초, snapshot 생성은 .05초 간격이고 큰 path는 변경 때만 만들고 읽기 전용으로
공유한다. 다리의 기존 매 spin 실제 명령 writer 검사와 flush/watchdog은 유지한다.

GT 지도 pgm/yaml/meta의 고정 SHA/metadata를 검사해 새 사본만 만든 뒤 **사본도 재해시**한다.
원본 static publisher와 같은 뒤집힌 int8 raster SHA를 실제 OccupancyGrid와 대조한다.
GTWorld는 원본 world SHA와 OBJ/충돌/지지면을 한 번만 읽고 검토된 parser의 구조 검사를
재사용해 불변 경계로 보관한다. 자세·경로·자원은 서로 별도 작업 칸을 사용한다.
경로는 실제 자세→목표 직선 swept 영역 전체를 감싸는 연속 사각형의 지지면·충돌을 검사하고,
NavFn trace의 횡편차
≤.05m(지도 1cell)를 그만큼 확장한 안전 영역 안에 제한한다. 1mm grid 흔들림은 거부하지
않지만 역주행/큰 곡선/낭떠러지/모르는 형상은 거부한다. 실제 자세 proof도 계속 새로 검사하며
검사 지연·안전 영역 밖은 0/실패다. 지형 파일이 바뀌면 외부 소유 감독자가 중단하고 새 승인으로
다시 등록해야 한다. 실행 종료의 원본 SHA 불변 대조도 외부 감독자의 관문이다.

## 노드 없는 시험

```sh
PYTHONPATH=apps/agent python3 apps/agent/tools/nav2/runner.py
python3 -m pytest apps/agent -q
PYTHONPATH=apps/agent python3 apps/agent/tools/nav2/check_mutations.py --report runs/nav2-prep/mutations.json
PYTHONPATH=apps/agent python3 apps/agent/tools/nav2/assess_commands.py runs/nav2-prep/intent-samples.jsonl
```

새 시험은 Fake Nav2/sink, 전체 RosAdapter 생성자→콜백→snapshot→Owner 및 기존 in-process
rclpy stub을 사용하며 ROS 초기화·DDS·시뮬·unit·포트 사용 0이다. 변이는 assertion 실패만
KILLED로 인정한다. 기존 전체 pytest의 loopback 가짜 서버와 명시 DDS opt-in skip은 별도다.

## 등록 원장과 실행 승인 경계

runner 기본은 OFFLINE_PLAN_ONLY다. 실행은 별도 승인 + FH_NAV2_EXECUTE=1 + --execute에서만
가능하며 이번 PR에서는 실행하지 않았다. 서버/시뮬/Nav2/unit 생성·프로세스 신호는 없다.
launch description의 모든 velocity 출력은 /fh_nav/intent로만 remap하며 recovery/smoother/
collision_monitor/docking 노드는 기동 목록에 없다. 기존 다리 확장만 같은 노드에 붙는다.

실험은 `ledger.py register --experiment runs/nav2-experiments/<experiment_id> --receipt <승인 JSON>`으로 한 번
등록한다. ID마다 정해진 원장 경로 하나만 허용하고 승인 ID도 원자적으로 한 번만 소비한다.
같은 승인/실험을 새 출력 폴더에 복제해 다시 시작하는 경로는 없다. 승인에는 experiment_id, approval_id, 현재 preregistration.json의 canonical
SHA256(`ledger.digest`), approved_trials=[1,2,3,4]가 필요하다. runner가 원장을 자동 생성하거나
--history로 성공 표본을 고르는 기능은 없다. 새 회차 시작 전 flock 아래 attempt_started를
append+fsync한다. 같은 회차/실패·BLOCKED 뒤/미정리·중단된 attempt 뒤 재호출은 HOLD다.
각 실행의 --experiment, --trial, --isolated-start-id, **--operator-confirmation**(회차마다
새 명시 조작자 확인 ID), --map-source, --world, --output(이 worktree runs/의 새 폴더)이 필요하다.
확인 ID는 reservation과 unlock 전에 journal에 기록한다. 인증 토큰이나 운영 인증 성공은 아니다.

종료 상태는 전체 원장에 누적한다. 원장은 각 행을 hash-chain으로 검증하며 잘린 행/변조는 거부한다.
cleanup receipt는 experiment_id/attempt_id/isolated_start_id/evidence_sha256 및
owned_processes_gone/cgroups_empty/partition_released/original_sources_unchanged=true가 필요하다.
`ledger.py cleanup`으로 외부 감독자의 실제 증거를 연결해야 다음 회가 열린다. 안전4회 성공·정리
뒤에도 `approve-go`에 별도 승인 artifact(같은 실험/정본 SHA, 새 approval_id,
approved_trials=[5,6,7,8,9,10])가 필요하다. summary/aggregate는 **원장 전체만** 읽어 판정한다.
로컬 원장은 적대적 파일시스템 관리자를 인증하는 체계가 아니다. 새 실험 ID로의 재등록은 새
승인·사전등록 artifact를 요구하며 runner가 실패를 숨겨 자동 새 실험을 만들지 않는다.

목표 성공은 Nav2 SUCCEEDED+GT 위치≤.30m/yaw≤15°+몸 속도/tilt/낙상0+실제 명령0을
2sim초 연속 유지해야 한다. 연속 wall/원수신 간격>.2초 또는 source sim 간격>.2초는 실패이며
무관측 구간을 정지 유지로 세지 않는다. safety 회차는 목표 도착으로 성공할 수 없고 STOP 뒤
ROS zero와 body_still 관측이 5wall초 **이내**일 때만 성공한다. 5초 초과 첫 관측은 실패다.
STOP 전 zero는 폐기한다. 변위 .5m/끊김 ROS zero .50wall초 상한, 비영 누적4/연속1초,
목표30wall/20sim/전체240wall 상한은 그대로다. .50초는 기존 Core .30초를 완화하지 않는다.

기동 전 resource gate, runner cgroup≤768MiB/swap0/CPU150%/tasks256을 확인한다.
**Nav2 프로세스 자체의 cgroup 한도/PID/start_ticks·native 1500MiB/CPU200%/tasks256/240s·
새 partition/out·독립 감시·정리 소유 검증은 A3a-2 외부 감독자 책임**이다. runner cgroup만으로
Nav2까지 제한했다고 주장하지 않는다. GIL/프로세스 정지/OS 지연은 내부 스레드로 보장하지 않는다.
실제 ROS 입력 정합·제한 보행 도달 가능성·STOP 거리·외부 감독/정리·A3b 서버 통합은 미검증이다.

기록은 fh-nav2-trial/1 JSONL/result와 전체 attempt 원장이다. 원수신/clock/scan/odom·정제 전후
명령·이유/오차/자원/GT/회차 확인/결과/정리 증거를 남기고 미디어는 저장하지 않는다.
rollback은 기능 커밋들을 revert하고 기본 extension_factory 없는 기존 다리를 사용한다.
Git push/PR은 실행·배포 승인이 아니다. 안전 변경은 두 모델 재검토 뒤 통합한다.

## 시뮬 전용 전진 곡선·제자리 회전 설정 (Jazzy 1.3.13)

`simmgr/nav2_entry.py`만 `generate_launch_description(simulation=True)`를 호출해
`nav2_params.yaml` 뒤에 `nav2_simulation_params.yaml`을 적용한다. 기존 실기 실험의
기본 호출·기본 YAML·PolicyAdapter 알파벳(0 또는 .6 m/s 직진)은 그대로다.
이 파일 선택은 시뮬 SI 정책의 활성화 권한이 아니다. 기존 실행 증명·결속 검사는 유지된다.
명령을 잘라 맞추는 어댑터와 velocity smoother는 추가하지 않는다.

공식 [RPP 파라미터 설명](https://docs.nav2.org/configuration/packages/configuring-regulated-pp.html),
[1.3.13 제어기](https://github.com/ros-navigation/navigation2/blob/1.3.13/nav2_regulated_pure_pursuit_controller/src/regulated_pure_pursuit_controller.cpp),
[곡률 감속식](https://github.com/ros-navigation/navigation2/blob/1.3.13/nav2_regulated_pure_pursuit_controller/include/nav2_regulated_pure_pursuit_controller/regulation_functions.hpp)을 기준으로 한다.
특히 이 버전은 **같은 regulation_curvature**를 전진 감속과 `wz=vx*k`에 사용한다.
다른 버전에서 이 관계를 확인하지 않고 설정을 이식하지 않는다.

- 고정 곡률 carrot `L=1.2 m`, 목표 뒤 마지막 선분 보간을 함께 켠다.
  유효한 2점 이상 경로에서 선택점 거리는 L 이상이므로 `|k| <= 2/L`이다.
  목표 가까이에서 carrot가 줄어드는 경우도 이 보간으로 제한한다.
- 곡률 감속 반경 `R=1.6 m`, 전진 속도 하한 `.24 m/s`로 설정한다.
  `vx=max(.24,min(.6,.6/(R*|k|)))`이고 `|wz| <= max(.6/R,.24*2/L)=.4 rad/s`다.
  직진은 `.6 m/s`, 비영 이동은 `.24~.6 m/s`다. 하한은 순항의 40%이며,
  90° 회전의 최소 중심 이동 거리는 약 `.6*pi/2=.942 m`다.
  매우 작은 전진 속도로 제자리 회전을 흉내 내는 방식에 기대지 않는다.
- 시뮬의 제자리 회전은 아래 별도 안전 정책으로 허용한다. 후진·접근 감속·cost 감속은 꺼져 있고,
  취소 감속도 명시적으로 끈다. 목표/취소 출력은 전체 0이다.
  위 식은 정적인 이 파라미터 조합과 유효한 기하에 대한 명령 호환 경계다.
  잘못된 경로·충돌·수치 오류에 대한 안전 판정은 기존 fail-closed 경로가 맡는다.

새 오프라인 재생은 다음처럼 실행한다. `--warehouse-map`은 선택 사항이며,
추가하면 기존 Pillow가 필요하다. 저장된 지도만 읽고 ROS를 가져오거나 실행하지 않는다.

```sh
PYTHONPATH=apps/agent python3 apps/agent/tools/nav2/replay_paths.py --heading-sweep \
  --warehouse-map apps/simmgr/worlds/warehouse/maps/f1.png --output runs/heading-fixtures.json
```

현재 CLI는 회전이 켜진 overlay를 읽어 50회를 재생한다. PR #113의 전진 전용
회귀는 `replay(..., rotate=False)` 기본값으로 보존하며 기존 시험 기대값은 유지한다.
이 인자는 오프라인 모델 선택이며 실제 실행 권한이나 새 환경변수가 아니다.

시뮬 SI 정책 `nav2-simulation-si/3`는 폰 수동 시뮬과 같은
`SIMULATION_LIMITS`의 vx −.3~1.0, vy ±.3 m/s, wz ±.5 rad/s를 허용한다.
후진·횡이동·제자리 회전과 조합은 시험용이며, 학습 범위나 보행 검증을 뜻하지 않는다.
welcome의 `experimental` 목록은 유지하고 `requires_forward_motion=false`를 알린다.
실제 허용 범위와 다른 `FOOTHOLD_V2` 학습 범위는 welcome에서 제거했으며,
학습 정책·범위 자체는 그대로다. 비유한·형식 오류·범위 밖은 거부하고 원 SI를 자르지 않는다.
Hub의 `simulation is True`와 simmgr `SimulationBinding` 및 목표별 결속 검사를
그대로 재사용한다(`phone/hub.py`, `executor/nav2/simulation.py`). 결속이 없으면
기존 물리 PolicyAdapter로 돌아가며, 결속을 잃은 SI 투영은 거부한다.
기본 YAML·Core·STOP·수신 만료·실기 투영은 변경하지 않았다.
RPP의 `allow_reversing=false`는 유지한다. 회전 설정과의 상호 배타성 때문에
단순히 켜지 않으며, RPP는 횡이동 명령도 생성하지 않는다. 어댑터의 허용과
자율 경로 생성 능력은 구분하며 실제 Gazebo 보행은 별도 검증이 필요하다.

설치 package.xml의 1.3.13과 설치 `parameter_handler.hpp`, 공식
[파라미터 구현](https://github.com/ros-navigation/navigation2/blob/1.3.13/nav2_regulated_pure_pursuit_controller/src/parameter_handler.cpp),
[회전 구현](https://github.com/ros-navigation/navigation2/blob/1.3.13/nav2_regulated_pure_pursuit_controller/src/regulated_pure_pursuit_controller.cpp)을 확인했다.
`use_rotate_to_heading=true`, `rotate_to_heading_min_angle=pi/6`는
**30° 초과**의 경로 carrot 방위 오차에서 회전한다. 이 문턱은 사용자 결정이며
물리적 안전·추종 성능을 보장하는 각도가 아니다. 고정 곡률 carrot 1.2m를 사용한다.
`rotate_to_heading_angular_vel=.4`로 SI 경계 .5에 .1 여유를 두고,
`max_angular_accel=.8 rad/s²`로 이상적인 20Hz 피드백에서 한 단계 .04rad/s,
정지에서 .4까지 .5초를 준다. 이 값은 실기 보행 특성에서 가져온 값이 아니다.
공식 회전식은 현재 측정 wz 주위 가속도 제한 후 `sqrt(2*a*|angle|)`로 감속한다.
관측 wz가 예상 범위를 벗어나면 명목 .4보다 클 수도 있으며 SI 정책은 여전히
.5 초과를 거부한다. 충돌 검사는 회전 명령에도 그대로 적용된다.

목표 yaw도 같은 `use_rotate_to_heading`으로 켜진다. RPP는 일반 carrot가
xy 허용오차 .30m 안에 들어가면 이를 stateful하게 기억하고 목표 자세로
제자리 회전한다. 최종 목표 판정의 yaw 허용오차는 기존 15°다.
경로 방향용 30° 문턱은 목표 yaw 회전의 문턱이 아니다.

기본 [SimpleProgressChecker](https://github.com/ros-navigation/navigation2/blob/1.3.13/nav2_controller/plugins/simple_progress_checker.cpp)는
위치 이동만 검사한다. 기존 5초에서는 ±135°·180° 출발과 사용자 경로 목표 yaw
회전이 시간 초과했다. 조정 세션의 추가 승인으로 **시뮬 overlay에서만**
`progress.movement_time_allowance=12s`를 적용했다. pi/.4=7.854초에
가감속·위치 .1m 이동 여유를 더한다. 기존 외부 STOP·.3초 원수신 만료·
전체 목표 마감은 유지한다. 앱 EXECUTOR_STALLED는 위치 변화가 아니라 명령 수신
시각을 검사한다. 10초 제자리 회전 중 fresh state/ping/intent를 공급하면 MOVING을
유지하고, 이후 원수신 .300001초 단절은 ZERO/FAILED가 되는 회귀를 추가했다.

목표 `(.8,0)->(1.6,0)`, 출발 `(0,0),(-.4,0),(0,.2),(0,-.2)`에서 각도 10개를
재생하고, 사용자 경로 `(1.34,-3.00)->(-3.00,0.00)`도 같은 각도를 재생한다.
각도는 첫 목표 방위 대비 오차다. 모든 목표 yaw는 0으로 가정했다.
원 사용자 실행의 정확한 yaw·계획은 없으므로 실제 실행 복원은 아니다.
각 목표당 5cm 직선 계획 1회·20Hz 이상적 unicycle·이전 명령과 같은 wz 피드백·
RPP 회전/목표 yaw·위치 기반 progress 감시를 모델링한다.
실제 NavExecutor와 assess_commands를 통과시키며, NavFn·TF·실제 controller·시간 지연·
보행·충돌 예측·출력 정지 보장은 재현하지 않는다.

| 오차 | 래치/4 | 최대 wz 절댓값 rad/s | 기하/벽 포함 완주(각 /4) | 최소 몸체 여유 m | 사용자 래치/1 | 사용자 완주/벽 포함(각 /1) | 사용자 최소 여유 m |
|---|---:|---:|---:|---:|---:|---:|---:|
| 0° | 0 | .179934 | 4/4 | .452 | 0 | 1/1 | .598 |
| +30° | 0 | .400000 | 4/4 | .403 | 0 | 1/1 | .598 |
| −30° | 0 | .400000 | 4/4 | .429 | 0 | 1/1 | .579 |
| +60° | 0 | .400000 | 4/4 | .420 | 0 | 1/1 | .598 |
| −60° | 0 | .400000 | 4/4 | .429 | 0 | 1/1 | .579 |
| +90° | 0 | .400000 | 4/4 | .403 | 0 | 1/1 | .598 |
| −90° | 0 | .400000 | 4/4 | .429 | 0 | 1/1 | .579 |
| +135° | 0 | .400000 | 4/4 | .417 | 0 | 1/1 | .598 |
| −135° | 0 | .400000 | 4/4 | .429 | 0 | 1/1 | .579 |
| 180° | 0 | .400000 | 4/4 | .419 | 0 | 1/1 | .598 |

사용자 경로의 최대 |wz|는 각도 10개 모두 .4rad/s다.
여유는 창고 f1 기존 정적 raster에서 반경 .782m, 반 cell 대각선과 표본 반올림
변위를 뺀 보수적 추정이며 unknown·지도 밖은 막힌 것으로 센다.
회전 중에도 같은 외접원이 몸체를 감싼다. 기하 완주는 최종 xy/yaw를 함께 만족할 때만
센다. stateful 목표 성공 뒤 xy 밖인 경우는 완주에서 제외한다.

50개 모델 회차에서는 미완주가 없었다. 이 결과는 실제 경로의 장애물·Nav2 충돌 검사·
진동·동역학·자원 지연·실제 도달 성공을 검증하지 않는다. 다른 지도/경로에 대한
전방향 출발 보장도 아니다. 실제 시뮬·Gazebo·Nav2 노드·실폰·실기는 미검증이다.
기존 안전 시험 변경은 사용자 결정과 직접 충돌한 시뮬 거부 표본 `.3 -> .51`과
정책판 `/1 -> /2` 두 기대값만 조정 승인으로 변경했다. `.3`은 결속 없는 물리 거부
시험으로 남겼고 다른 기존 기대값은 변경하지 않았다. 통합 전 안전 PR의 두 모델
검토가 필요하다. 되돌림은 이 안전 PR 커밋을 revert하면 PR #113 정책으로 복귀한다.

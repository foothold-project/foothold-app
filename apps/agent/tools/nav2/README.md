# A3a-1 Nav2 준비 — PR #20 검토 수정

실제 ROS/Nav2/시뮬은 실행하지 않은 준비 코드다. MS-05 전체·실제 도달 성공을 뜻하지 않는다.
설계 근거는 A3a-0 §4~8과 PR #20 두 모델 검토다. Core/기존 Core 시험·서버·계약·웹·원본은 변경하지 않는다.

```
Nav2 controller Twist → /fh_nav/intent → NavExecutor → Owner
 → Session.executor_command → 기존 Core → 기존 RosSink → 유일 /v2_live/* 명령 writer
```

원수신 monotonic을 콜백 진입 시 한 번 포착한다. poll 때 새 수신 시각을 만들지 않는다.
Owner의 **모든 출력 입구**가 원수신 `>0.3wall초`를 검사하므로 Session/Core가 poll 시각에
자체 시계를 갱신해도 원수신 마감이 연장되지 않는다. 만료·STOP·정책/GT/자원 실패에는
0/STOP을 적용한 뒤 비동기 목표 취소를 접수한다. 실제 OS/통신 마감 보장과는 별개다.
Session/Core의 기존 .3초 규칙·잠금·조종권·neutral·stop_gen·sink 독립 watchdog은 그대로다.
로컬 STOP은 공개 `Session.shutdown()`을 사용한다. 가짜 서버 STOP 프레임으로 last_server를
늘리지 않는다. 이 보수적 로컬 중단은 세션도 닫아 새 명시 handshake를 요구한다. 제품에서
연결을 유지하는 로컬 STOP API가 필요하면 소유 밖 link/** 별도 작업으로 추가해야 한다.

`policy.json`의 명령은 Core의 0, .6m/s 직진, .6/±.5rad/s 곡선과 교차 검사한다.
곡선은 기본 비활성이며 **미세 omega도 증폭·직진 변환하지 않고 거부**한다. 저속·후진·횡·
제자리 회전·비유한/비평면 입력도 거부한다. 첫 미지원 명령은 실행 거부를 래치해 이후 .6↔0
반복을 금지하고 회차를 실패시킨다. RPP 속도/cost 조절은 끄되 collision 검사는 유지한다.
접근 감속·경로 곡률 때문에 여전히 미지원 값이 나올 수 있으며 조용히 .6으로 올리지 않는다.
`assess_commands.py`는 JSONL `input_si` 표본을 오프라인 재생해 TESTED 비율과 첫 래치 거부를
계산한다. 합성 입력 비율을 실제 Nav2 가능성으로 보고하지 않으며 실제 지원율은 미측정이다.

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

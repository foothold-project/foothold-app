# 시뮬 전용 ROS 다리 (A1)

`python3 -m foothold_agent.ros_bridge` 실행 진입점과 `MotionSink` 구현이다.
Gazebo·정책·RESET·Nav2·실기 SDK를 실행하거나 연결하는 코드는 없다.
안전 판단은 기존 Core와 Session이 담당한다. A1b는 `link/**`에 측정 캐시 진입점을
추가하며, `safety/**`와 기존 Core 시험 기대값은 바꾸지 않는다. 기준은 `docs/spec/05-API-SPEC.md` §10,
`04-ARCHITECTURE.md` §3과 조사 `sim-plan-bridge.md`·ROS/API/격리 보고서다.

## 설정과 실행 경계

모든 값은 실행 환경에서 명시한다. 실제 로봇 ID·주소·토큰을 파일에 저장하지 않는다.

| 환경 변수 | 요구 |
|---|---|
| `ROS_DOMAIN_ID` | 정확히 `93`; 미설정·0·57·61 등은 ROS 초기화 전 거부 |
| `ROS_AUTOMATIC_DISCOVERY_RANGE` | 정확히 `LOCALHOST` |
| `ROS_LOCALHOST_ONLY` | 정확히 `1` |
| `FOOTHOLD_ROBOT_ID` | 명시한 UUID; 노드 식별에 사용 |
| `FOOTHOLD_AGENT_WS_URL` | 기존 Settings 검증을 통과하는 서버 URL |
| `FOOTHOLD_AGENT_TOKEN` | 기존 Settings 검증을 통과하는 Bearer 토큰 |

DDS discovery server·static peers·외부 Cyclone/FastDDS 프로필 및 FASTDDS_ENVIRONMENT_FILE을
거부한다. CWD의 DEFAULT_FASTDDS_PROFILES.xml/DEFAULT_FASTRTPS_PROFILES.xml도 거부한다.
지원 RMW는 FastDDS와 CycloneDDS뿐이다. ROS 인자/전역 remap은 사용하지 않으며
별도 Context를 `domain_id=93`으로 초기화하기 직전에도 격리를 다시 검사한다.
WSS 연결은 서버 통신이며 ROS 발견 범위와 별개다. 토큰이 어느 로봇에 속하는지의
정본은 서버 인증이다. 설정한 UUID와 인증 대상 대조는 이 다리가 추측하지 않는다.

ROS 의존성은 OS의 Jazzy `rclpy`, `geometry_msgs`, `nav_msgs`, `std_msgs`, `sensor_msgs`를 사용한다.
PyPI의 대체 rclpy 패키지를 설치하지 않는다. 기존 `[test,link]` extra가 pytest와
`websockets==15.0.1`을 제공하므로 새 optional dependency는 추가하지 않았다.

```sh
# 의존성 준비 (권장: 가상환경)
python3 -m pip install -e './apps/agent[test,link]'
# 설치된 Jazzy 환경을 읽은 후, 위 환경 변수들을 별도로 설정한 상태에서만 실행
source /opt/ros/jazzy/setup.bash
PYTHONPATH="apps/agent:${PYTHONPATH:-}" python3 -m foothold_agent.ros_bridge
```

진입점 자체는 이번 작업에서 시뮬이나 서버에 연결하여 실행하지 않았다.
새 Session은 항상 STOP 잠금으로 시작한다. 매 연결도 기존 Client가 먼저 정지하며,
재시작·재접속·상태 회복으로 RESUME을 만들지 않는다.

## 격리 시뮬 연결

별도 승인된 첫 실제 연결은 [D1 실행 도구와 안내](../../tools/sim/README.md)를 사용한다.
`SIM_SOURCE`·`SIM_ROS_SETUP`·새 `SIM_RUN_DIR`를 환경으로 지정하고,
`FH_SIM_D1_RUN=1`로 기동한다. 도구가 자식에만 domain 93/LOCALHOST를 주고,
새 unit과 자원 감시기·private PostgreSQL·loopback 9020–9039 서버·실제 다리를
순서대로 실행한다. 비밀번호와 발급된 에이전트 토큰은 메모리/자식 환경에만 둔다.
기본은 STOP 유지 관찰이며, 조종은 별도 `FH_SIM_D1_MOTION=1`과 GT 여유 검사를
통과해야 한다. 기존 실행 래퍼나 domain 61 관찰 노드를 추가하지 않는다.

원본 런타임의 manifest는 종료 시에만 저장된다. 실행 중에는 `/proc`의 소유
cgroup·PID/start_ticks·domain·새 partition과 실제 ROS 상태를 확인하고,
종료 뒤 native manifest·원장 SHA·자식 정리·포트 반납·보호 대상 불변을 대조한다.

2026-10-20 실제 D1에서는 hello 수락과 화면 WS ONLINE/STOP_LATCHED를 확인했다.
STOP 버튼→ROS 0/STOP은 0.0387/0.0389초, policy 0은 0.0515초,
몸의 정지 표식은 2.0644초였다. 마지막 **화면 send 직전**→ROS 0은 0.3534초였다.
에이전트의 cmd **수신 기준** 0.3초 만료와 측정 시작점이 다르고, 50 ms tick·일반
출력 주기·전달 지연이 포함된다. 0.30초 만료 + tick 0–0.05초 + 일반 출력
0–0.05초의 명목 범위에 전달 지연이 더해진다. 이 기록에는 에이전트 수신 시각이
없으므로 수신 기준의 정확한 만료 시간을 계산할 수 없다. 시뮬 GT 제한 직진 시험이며 실기 검증이 아니다.
D1 당시 REST `/robots` 요약과 측정값은 OFFLINE/null이었다. A1b는 측정 송신을
연결했으며 REST 집계는 서버 S1 범위다. A1b의 실제 시뮬 연결은 재검증하지 않았다. 측정 방법·조건·변위·자원·미검증 범위는 실행 도구 안내를 따른다.

## 출력과 수신

- Core 출력의 m/s·rad/s를 Twist `linear.x/y`, `angular.z`에 그대로 넣는다.
  다른 축은 0이다. 출력 슬롯은 최신 속도 1개이며 비영 큐가 없다.
- `apply()`는 짧은 메모리 잠금만 사용한다. ROS 발행 잠금이나 ROS 호출을 기다리지
  않는다. 정상 출력은 ROS 스레드가 20 Hz로 발행한다. STOP/unlock은 다음 spin에서
  처리한다(목표 10 ms 이내, 실시간 마감 보장 아님).
- STOP은 대기 비영·RESUME을 버리고 0/STOP을 요청한다. 새 정지 전환의 첫 STOP은 직전 발행 시각과 무관하게 즉시 내고, 같은 미확인 STOP의
  재전송만 최대 2 Hz로 제한한다. 신선한 STOP 확인 뒤 재전송은 멈춘다.
  이미 발행에 진입한 명령과 STOP이 경합하면 같은 flush가 끝나기 전에 0/STOP을
  다시 시도한다. 전송 중인 명령을 취소할 수 있다고 주장하지 않는다.
- Core가 승인하여 포트에 넘긴 unlock만 RESUME을 한 번 발행한다. 실패한 RESUME도
  재시도하지 않는다. 시뮬 자체 STOP 뒤에도 Core의 새 승인을 로컬 정지 플래그 때문에
  버리지 않는다. unlock 수신 시 이전 속도는 폐기한다. 이후 시뮬 확인·새 중립은 Core가 판단한다.
- 독립 watchdog은 별도 Python 스레드에서 5 ms 간격으로 확인한다. 마지막 **apply**
  뒤 `>=0.3 s`면 대기 명령 폐기·0/STOP이다. stop/unlock은 이 시계를 늘리지 않는다.
  ROS flush가 0.3 s 진행하지 않으면 fresh apply가 있어도 즉시 0/STOP·hold를 건다.
  단발 지연은 agent·폰·카메라를 종료하지 않는다. Session은 기존 Core STOP으로
  입력·재개 의도를 폐기하고 `state.safety_reason=OUTPUT_STALLED`를 알린다.
  새 STOP 피드백과 새 조종권 일치 unlock, 해제 피드백, 새 중립 입력 전에는 움직이지 않는다.
  완료된 flush가 publisher watchdog을 재무장하며 apply만으로 같은 stall을 중복 집계하지 않는다.
  `sink.STALL_LIMIT=(3, 60.0)`에 따라 60초 안 3회 지연은 치명 오류다.
  감지 후 완료된 flush 없이 `sink.STALL_RECOVERY_TIMEOUT=2.0 s`가 지나도 치명이다.
  2초는 짧은 스케줄링 지연의 회복 여유이며 실측으로 확정한 값은 아니다.
  watchdog의 비상 출력은 별도 daemon 한 개에서 시도한다. flush가 출력 잠금을
  쥐고 멎거나 비상 publisher 자체가 멎어도 감시 스레드는 계속 진행하며,
  비상 출력 시도에도 같은 2초 상한을 적용한다. 치명 오류는 watchdog에서
  이벤트 루프의 bridge 실패 대기에 직접 알리므로 다음 apply/flush를 기다리지 않는다.
  비상 0/STOP 중 하나라도 출력 실패하면 즉시 치명 오류이며 둘 다 시도한다.
  PR #78 진단은 매 stall의 감지 시각·구간 이력·스택을 별도 스레드에 남긴다.
  executor/콜백 오류와 shutdown도 0/STOP을 각각 시도하고 오류를 숨기지 않는다.
- 나쁜/오래된 수신은 즉시 출력 hold를 건다. 수신 진입(파싱·검증 전)에 포착한 출력 세대와 일치하는 신선한 실제 STOP 확인 뒤 새 승인
  unlock이 있어야 비영 경로가 열린다. 다리가 Core의 latch/controller/세대를 쓰지 않는다.
- `rclpy` 생성·spin·일반 발행·destroy는 전용 스레드에서 한다. 독립 watchdog의 비상 출력 daemon과
  shutdown의 비상 0/STOP만 thread-safe publisher를 사용할 수 있다.
  종료 비상 0/STOP 뒤 reliable ACK를 전체 최대 1초 기다린 후 node를 파괴한다.
  비상 종료는 전용 daemon에서 시도하며 watchdog join은 최대 0.5초, 각 close 호출의
  완료 대기는 최대 1초다. 시간 초과는 오류로 남기고 publisher를 ACK/destroy하지 않는다.
  멎은 publisher를 강제로 중단하거나 완료했다고 간주하지 않는다.
  스레드 생성 실패 시에는 호출 스레드에서 0/STOP과 정리를 시도한다. 이 자원 고갈
  대안 경로는 동기식이므로 영구히 멎은 publisher의 실행 시간 상한을 보장하지 않는다.
  여러 스레드가 close해도 첫 비상 발행·watchdog 정리의 완료 Event를 기다린 뒤
  ACK 대기로 넘어가며, ACK 시간 초과는 오류로 남긴다. 이벤트 루프나 executor spin 정지는 감시하지만, 프로세스 전체 정지·GIL 독점·OS
  스케줄링 지연·영구히 멎은 publisher API는 같은 프로세스 스레드로 보장할 수 없다.
  하위 ingress TTL은 별도 방어이며 이 감시 시험을 대신하지 않는다.

`/v2_live/cmd_vel`, `/v2_live/stop`, `/v2_live/resume` 발행,
`/v2_live/state`, `/v2_live/odom`, `/v2_map/status`를 구독한다.
센서 존재 확인은 `/v2_map/points`(L1), `/v2_live/camera/compressed`(D435i RGB),
`/v2_live/sensor/d435i/depth/image_mm`(D435i depth)를 best-effort/volatile/depth 1로
구독하고 실제 콜백의 시각만 보관한다. 영상·점군 복사/저장/relay는 하지 않는다.
실제 수신 전에는 hello.devices에 넣지 않으며 수신 뒤 1초가 넘으면 MISSING이다.
원래 수신 monotonic을 Session까지 보존해 입력이 완전히 끊겨도 재연결 hello와
각 state의 `devices_changed`에서 1초 만료를 다시 계산한다. 최신 목록을 state마다
반복하므로 송신 큐의 최신 state 합침에도 변경이 사라지지 않는다. battery 장치를
추측해서 추가하지 않는다.
QoS는 reliable/volatile/KEEP_LAST depth 1이다. 기존 depth 10 계약과 통신 가능한
reliability/durability를 유지하면서 오래된 출력·수신 큐를 제한한다.

기동 후 0.5초 동안, 그리고 실행 중 매 spin마다 세 명령 토픽의 publisher 수가
정확히 1인지 확인한다. 충돌/확인 불가는 ready/서버 연결 전에 실패하거나 실행 중
terminal 0/STOP으로 종료한다. ROS graph 관측이며 전역 배타 예약을 증명하지 않는다.

ROS 콜백은 Core를 호출하지 않는다. state/odom/map 최신 캐시를 크기 1 bundle로
합치고, 예약 callback도 한 개만 두어 `loop.call_soon_threadsafe()`로 전달한다.
거부 사유와 최신 안전 전이 1건은 drain까지 보존하므로 뒤의 정상 표본이
무효화·입력 폐기를 지우지 못한다. 안전 전이를 먼저 Core에 전달한 뒤 최신 측정 캐시를 갱신한다. 새 원천 stamp는 Core에도 전달한다.
소유 루프에서 실제 수신 나이를 다시 검사한 뒤 기존 `Client.on_robot_state()`로
넣는다. schema·관문 타입·유한 숫자·episode 순서·sim 시각·수신 나이를 검사하고
Core의 `clean_state`는 그대로 재사용한다. stamp와 정제 내용까지 같은 중복만
hold/STOP 없이 버린다. 같은 stamp의 새 측정은 캐시에 넣고 달라진 안전 관문·새 낙상 표식만 Core에 전달하며, 특히
policy_running=false·stop_requested=true·reset_in_progress=true는 즉시 0/입력 폐기
경로로 전달한다. 같은 stamp의 후속 회복으로 이 관문을 지우지 않으며 원천 시각
전진 후에도 Core의 잠금·새 중립 절차는 그대로다. 같은 stamp 갱신은 원천 progress
시계를 늘리지 않는다. 반복되어 1초를 넘으면 stale 관문으로 정지한다. 물리 정체로 stamp가 전진하지 않으면 STOP 해제도 허용하지 않는다(N-2 가용성 제한).
내용까지 같은 중복 한 번은 잠금을 만들지 않으며,
같은 episode의 시각 역행은 더 큰 episode가 올 때까지 격리한다.

## 원격측정과 B 단계 필요 변경

`Telemetry.snapshot()`은 **로컬 정제 캐시**이며 새 WS 메시지가 아니다.
소유 루프의 `Client.update_telemetry(snapshot)` → `Session.update_telemetry(snapshot)`으로
전달한다. Session은 매 state 생성 시 simulation clock·수신/원천 progress 나이 ≤1초를
재검사하고 계약의 speed·pose·battery만 복사한다. RESET/거부 입력은 안전 상태 전달보다
먼저 측정 캐시를 비운다. 측정 갱신은 Core 피드백·권한·출력·deadman을 갱신하지 않는다.
속력은 state의 body COM `hypot(vx,vy)`(m/s)로 정의한다. odom은 base 원점
측정임을 구분하며 COM 속도나 map 위치로 바꾸지 않는다. 실제 원천의 header는
wall clock일 수 있어 node는 header_stamp/clock=unverified로 전달하고, 정제 캐시는
odom=null·odom_reason=clock_unverified를 유지한다. sim 시계로 이름을 바꾸거나
추측 변환하지 않는다. 명시적으로 검증한 simulation clock 표본만 캐시에 허용한다.
원천 sim 시각·실제 수신 monotonic·마지막 원천 전진 monotonic·episode·source를
별도 보관한다. 같은 stamp의 새 측정 정보는 Core 수신 시각을 갱신하지 않는다. 안전 관문이
달라진 표본과 새 낙상 표식만 Core에 전달하며 새 원천 시각은 mailbox가 합쳐도 전달한다.
같은 stamp의 새 정보도 실제 수신 시각을 기록하지만 freshness는
마지막 원천 전진 시각보다 늘어나지 않는다.
시각 역행·RESET·stale에는 null로 비운다. odom/map 시각 역행도 해당 episode에서
격리한다. confidence·battery는 null이며 미측정 속도를 0으로 만들지 않는다.

위치는 검증하여 명시한 `MapBinding`(world, ROS floor/map version, 등록된 floor/map
UUID, SHA, episode, run)이 `/v2_map/status.pose_map`과 맞고 시각·source가 유효할
때만 사용한다. odom/world 좌표를 map으로 가장하지 않는다. 진입점은 등록 지도를
추측하지 않으므로 기본 `location=null`이다. SHA는 운영자가 이미 검증한 등록
결속의 값이며, status만으로 지도 파일 SHA를 검증했다고 주장하지 않는다.

PR #13 반영 뒤 별도 B 단계에서 필요한 변경:

1. **A1b 완료**: Session/Client 공개 측정 진입점과 `_state()` 투영을 연결했다.
   pose는 현 계약의 floor_id/x/y/yaw/confidence만 보내며 map_version_id·SHA·episode·
   run/source/시각은 wire에 추가하지 않는다. 등록 결속이 없으면 모든 pose 칸은 null이다.
   시뮬 battery는 실제 원천이 없으므로 soc=null이다. Core 안전 입력과 측정 캐시는 분리한다.
2. map_version_id·floor·SHA·원천 episode/run 결속을 계약(Pydantic→TS)과 서버
   Location 변환에 합의한다. 지금 API pose에는 map_version_id가 없고 서버
   location은 null이다. `MapBinding` 등록/갱신 경로도 그 계약에 맞춰 연결한다.
3. 정제 캐시의 bounded 진단을 실제 event code/서버 문구와 합의하여 전달한다.
   현재 진단은 로컬 30건 링뿐이며 전송/영구 저장을 주장하지 않는다.
4. **A1b devices 완료**: 실제 구독 수신 기준으로 hello를 채운다.
   telemetry GET 집계·영상/바이너리 relay·Nav2 실행기는 별도다.
   이 다리만으로 지도 마커·영상·그래프·임무 실행이 완성되지 않는다.

문서/계약 모호점:

- 현재 기준 link의 4406 처리와 최신 05 §10.3 요구 사이 차이는 PR #13 소유다.
  이 작업에서 link를 수정하지 않았다.
- 시뮬 재기동으로 episode가 초기화되면 다리도 명시적으로 재기동해야 한다.
  오래된 episode 거부를 자동 해제하면 늦은 이전 실행 표본을 새 상태로 오인할 수 있어
  자동 복원은 추가하지 않았다. 새 다리는 다시 잠금·STOP부터 시작한다.
- Odometry에는 episode가 없다. 현재 state와 stamp가 맞는 로컬 관측으로만 보관하고
  안전 관문·map 위치로 사용하지 않는다. 리셋 전후 동일 stamp의 완전한 식별은
  원천의 episode 추가 등 별도 계약 없이는 할 수 없다.
- state String에도 송신 stamp header가 없다. 수신 나이와 sim stamp 순서는 검사하지만
  서로 다른 프로세스의 monotonic 값을 빼서 전송 지연을 만들지 않는다.
- 옛 `control-app/sim/v2_link.py` 경로는 조사 환경에서 없었다. 저장소의 이식 원본
  머리말, 보관된 `e1-0-20261017/sim/v2_link.py` 머리말, 실제 센서 런타임의
  `sensor_isolation.py`·`sensor_profile.py`·`live_map.py`, 원천 ROS 계약을 읽어 대조했다.
- STOP 송신·Core stop_ref·0 출력은 몸의 정지 확인이 아니다. 실제 정지 거리·낙상·
  보행·다중 시뮬 동시 실행은 미검증이다.

## 실행한 검증 (2026-10-19–20)

기존 WS 선택 의존성을 설치한 임시 Python 3.12 가상환경을 사용했다.
기본 시험은 ROS 없이 실행하며 합성 시험만 명시 opt-in이다.

```sh
python -m pytest apps/agent -q
python apps/agent/tools/check_link_mutations.py
PYTHONPATH=apps/agent python -m foothold_agent.ros_bridge.check_mutations
```

최종 결과: 전체 **277 passed, 1 skipped**(합성 ROS는 기본 opt-in 제외),
기존 link 돌연변이 **46/46 KILLED**, 새 ROS 다리 돌연변이 **36/36 KILLED**.
기존 Core 셀프테스트와 WS 실제 loopback 시험을 모두 포함한다.

합성 명령(동일 가상환경의 python):

```sh
source /opt/ros/jazzy/setup.bash
ROS_DOMAIN_ID=93 ROS_AUTOMATIC_DISCOVERY_RANGE=LOCALHOST ROS_LOCALHOST_ONLY=1 \
  FOOTHOLD_ROS_SYNTHETIC=1 python -m pytest \
  apps/agent/tests/test_ros_bridge_synthetic.py -q -s
```

실행 전 시험 자체가 `/proc/*/environ`과 `ss -H -lun`을 다시 읽어 domain 93
프로세스 0, DDS 후보 UDP 30650–30899 바인딩 0을 확인했다. 읽기 제한/경합 프로세스는
별도로 보고했으며 배타 예약이나 다른 호스트 부재의 증명으로 쓰지 않는다.
합성 ingress peer와 실제 Session/Client/Core를 연결해 STOP 확인→승인 RESUME 1회→
false 피드백→새 중립→SI 비영 발행을 확인했다. 실제 비영 수신을 전제로 소유 루프를
차단하고 독립 peer가 마지막 apply 뒤 0.28~0.38초 내 0/STOP을 수신하는지 측정한다.
이 단계에서만 ROS flush의 보조 watchdog 검사를 시험 fixture가 제외하므로, 독립
감시 스레드를 60초 지연한 사본은 같은 합성 시험에서 assertion으로 실패한다.
실측은 Twist 0=0.3039초, STOP=0.3041초였다.
합성 중 두 번째 cmd writer 생성도 terminal 거부됨을 확인한다. **1 passed**. Jazzy는 LOCALHOST_ONLY deprecated 경고를 출력했으며
설정을 적용한다고 명시했다. Gazebo·정책·RESET·운영 서버·domain 61 참가·실기 접촉 0.

돌연변이는 임시 사본만 바꾼다. 구조화된 pytest 관측에서 assertion 실패가 있고
수집/import/runtime 오류가 없어야 KILLED로 센다. 작업 파일/Core는 수정하지 않는다.

| 고의로 깨뜨린 판정 | 결과 |
|---|---|
| domain 61 허용 | KILLED |
| SI Twist 값 2배 | KILLED |
| 최신 출력 소실 | KILLED |
| STOP 시 비영 보존 | KILLED |
| RESUME 재전송 | KILLED |
| watchdog 마감 2배 | KILLED |
| STOP으로 apply 시계 연장 | KILLED |
| unlock으로 apply 시계 연장 | KILLED |
| 독립 감시 지연 | KILLED |
| ROS executor 정지 무시 | KILLED |
| shutdown 비상 출력 삭제 | KILLED |
| thread 오류 비상 출력 삭제 | KILLED |
| B1 새 STOP을 이전 재전송 제한에 묶음 | KILLED |
| B2 외부 STOP 뒤 승인 unlock 소실 | KILLED |
| R-1 동일 stamp를 hold/STOP으로 처리 | KILLED |
| R-3 명령 writer 충돌 허용 | KILLED |
| R-5 이전 STOP 확인으로 새 hold 해제 | KILLED |
| R-7 미확인 odom clock 사유 소실 | KILLED |
| R-8 ACK timeout 무시 / node ACK 대기 삭제 (각 1개) | KILLED |
| R-9 CWD DDS 프로필 자동 읽기 허용 | KILLED |
| B3 같은 stamp 안전 변화 폐기 | KILLED |
| B3 같은 stamp policy/STOP/RESET 회복 허용 (각 1개) | KILLED |
| B3 같은 stamp로 입력 freshness 연장 | KILLED |
| B3 같은 stamp로 측정 freshness 연장 | KILLED |
| B3 mailbox가 앞선 안전 전이 폐기 | KILLED |
| R-5 검증 뒤 세대 포착 | KILLED |
| N-1 두 번째 close가 비상 발행 완료 대기 생략 | KILLED |
| 이전 episode 수락 | KILLED |
| NaN 수락 | KILLED |
| sim 시각 역행 수락 | KILLED |
| 오래된 수신 수락 | KILLED |
| 지도 층 결속 무시 | KILLED |
| 가짜 battery 100 | KILLED |

이 PR은 안전 범위다. `dev` 반영 전 Claude·Codex 두 모델 검토와 조정 세션의
수용 기준 재실행이 필요하다. 초안 PR 제출은 merge나 배포를 뜻하지 않는다.

PR15 두 모델 검토 수정은 위 36개 stub 변이와 별도 **R-4 합성 변이 1/1 KILLED**로
검증했다. 합성 변이 관측 부모는 domain93 참가자가 아니므로 부모의 ROS_DOMAIN_ID를
설정하지 않고, 도구가 자식에게만 93/LOCALHOST/opt-in을 주입한다:

```sh
source /opt/ros/jazzy/setup.bash
# 부모 프로세스는 ROS_DOMAIN_ID 등 3개 격리 변수와 FOOTHOLD_ROS_SYNTHETIC 미설정
PYTHONPATH="apps/agent:${PYTHONPATH:-}" PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 \
  python -m foothold_agent.ros_bridge.check_mutations --synthetic
```

검토 권고 처리: R-5 세대 검사, R-7/Codex R2 clock 미확인 null, R-8 ACK 대기,
R-9 자동 프로필 거부는 구현했다. R-6은 위 재기동 절차를 명시하고 자동 episode
초기화는 안전상 도입하지 않았다. B 단계 서버 원격측정/지도 계약 범위는 그대로다.

B3/R-5 재확인: 외부 재현의 policy 중지·STOP·RESET 3개, 수신/검증 barrier 1개, 종료 순서 1개를
포함해 **282 passed, 1 skipped**(agent 자체 277 + 외부 재현 5)였다. 회복·반복 중복·
최신 mailbox 덮어쓰기·진입 세대 경합은 저장소 회귀로도 추가했다. Core/link 수정 0.

Claude/Codex N-1 재확인: owner 선행과 ROS finally 선행 양쪽에서 첫 close를 비상
발행 직전 barrier에 멈추고 두 번째 close가 완료를 기다리는지, 실제
ZERO/STOP → ACK 2건 → destroy 순서를
검사한다. 완료 대기를 생략한 변이는 이 회귀의 assertion으로 실패한다. N-2의 같은
stamp STOP 관문 변화는 B3 회귀/변이에 포함되며, 위 물리 정체 제한을 명시했다.

## A1b 순수 검증 (2026-10-20)

전체 agent **391 passed, 1 skipped**(ROS opt-in 제외), link 변이 **73/73 KILLED**,
다리 변이 **41/41 KILLED**, sim 도구 **52 passed** 및 변이 **18/18 KILLED**. 새 측정·소유 루프·null 조건·
숫자 정제·devices·R3-1/R3-2 회귀는 `tests/test_agent_telemetry.py`에 있다.
실제 Client와 기존 서버/임시 PostgreSQL 통합에서 speed=.5·pose 수락 후 stale null,
없는 battery=null, D5 미정 location=null을 확인했다. 재현 명령은
[LINK-VALIDATION.md](../../LINK-VALIDATION.md)의 A1b 절을 따른다.
시뮬·ROS·systemd를 기동하지 않았으며 실제 센서 구독/QoS와 D1 기동 후속은 미검증이다.

PR17 검토 후속은 [LINK-VALIDATION.md](../../LINK-VALIDATION.md)의 B1/R1~R7 절에
기록한다. 수신 시각이 hello/state 생성까지 보존되는 무입력 재연결·센서 단독 수신과,
미완료 close의 ACK/destroy 금지·스레드 생성 실패 대안·개별 신선도 검사를 추가했다.
같은 stamp의 새 낙상 표식은 기존 Core 사건에 즉시 전달하며, 같은 stamp의 회복은
원천 전진까지 보존한다. Core 안전 판정·기존 Core 시험은 그대로다.

PR17 후속 최종: 전체 **408 passed, 1 skipped**, link **80/80**, 다리 **49/49**,
sim 도구 **52 passed**·변이 **18/18 KILLED**. 실제 Client/기존 서버 통합도
측정값→stale null과 연결 중 devices OK→MISSING으로 통과했다. 고정 9060 대신
9060–9079의 빈 listener를 먼저 예약한다. 다리 변이는 두 소켓 수용 시험을 제외하고,
전체 pytest에서 그 두 시험을 실행한다. 시뮬/ROS/unit 실제 기동은 추가하지 않았다.

# Point-LIO live · GLIM final 지도 계산

계약은 [PR #476](https://github.com/foothold-project/foothold-app/pull/476)의 `apps/server/SLAM-CONTRACT.md`를 따른다. 한 세션에서 Point-LIO live → GLIM final로만 진행한다. 이 PR은 agent만 변경하며 서비스 설치·실제 실행·로봇 연결은 하지 않는다.

`source=point_lio`를 명시한 새 명령은 이 파이프라인으로, source 없는 옛 4키 `{t,op,session_id,floor_id}`는 기존 PCD 경로로 보낸다. 두 형태의 수신·저장 형식을 각각 모의 검사한다.

## 출처와 설정

`slam_source.py`가 토픽·좌표·pose 출처를 담당한다. 계산기는 명시적인 world frame의 점과 같은 시각 위치만 받는다. `point_lio`, `glim` 이름·기본 토픽·서비스 이름은 서버 registry와 대조한다. 설치 실행 경로의 이전 내장 SLAM media 구독은 비활성화하며 새 지도 경로에는 로봇 SLAM 명령 발행기가 없다.

| 설정 | 기본값 / 의미 |
|---|---|
| `FH_MAPPING_POINT_LIO_CLOUD_TOPIC` | `/cloud_registered` 등록 scan |
| `FH_MAPPING_POINT_LIO_ODOM_TOPIC` | `/aft_mapped_to_init` 대응 위치 |
| `FH_MAPPING_POINT_LIO_FRAME` | 없음: 실제 world frame을 명시해야 수신 |
| `FH_MAPPING_POINT_LIO_CHILD_FRAME` | 선택적 child frame 대조 |
| `FH_MAPPING_POINT_LIO_POSE_TYPE` | `Odometry`; `Odometry` 또는 `PoseStamped`만 허용 |
| `FH_MAPPING_GLIM_CLOUD_TOPIC`, `FH_MAPPING_GLIM_ODOM_TOPIC`, `FH_MAPPING_GLIM_FRAME` | 기본 미설정; GLIM map 좌표와 위치 출처를 명시 |
| `FH_MAPPING_GLIM_POSE_TYPE` | `Odometry`; GLIM map 위치에는 `PoseStamped` 설정 |
| `FH_MAPPING_GLIM_CHILD_FRAME` | 기본 없음; `PoseStamped`에는 설정하면 초기화 거부 |
| `FH_MAPPING_GLIM_DUMP_ROOT` | 기본 없음(완료 미확인); agent와 GLIM 서비스 래퍼가 공유하는 전용 로컬 폴더 |
| `FH_MAPPING_GLIM_DUMP_TIMEOUT_S` | `180`; 종료/dump 대기 시간, 10–600초만 허용 |
| `FH_MAPPING_POINT_LIO_SERVICE`, `FH_MAPPING_GLIM_SERVICE` | `foothold-pointlio`, `foothold-glim` |
| `FH_MAPPING_SERVICE_CONTROL_ENABLED` | 기본 꺼짐; 정확한 `true` 설정일 때만 로컬 서비스 조작 |
| `FH_MAPPING_POINT_LIO_SENSOR_ORIGIN_VERIFIED` | 기본 꺼짐; 대응 pose가 해당 scan의 센서 원점임을 확인한 경우만 `true` |
| `FH_MAPPING_GLIM_FINAL_TOPIC_VERIFIED` | 폐기: 설정해도 최종 저장을 확인하지 않음 |

ROS 토픽은 기존 관측 DDS participant에서 `rt/` 이름으로 받는다. pose 구독은 설정한 DDS 타입을 사용하고 같은 토픽의 서로 다른 타입 등록을 거부한다. 별도 SDK 참여자·SportClient·출력 sink는 만들지 않는다. 실제 ROS 배포판/DDS 타입·도메인·QoS 호환은 실기 확인 대상이다. GLIM map 토픽은 주기적인 누적 자료이므로 최종 저장에는 구독하거나 사용하지 않는다.

## Jetson 적용 값과 종료 어댑터

다음은 rs-slam-r25 작업자가 설치 시 대조할 값이다. 이 코드 작업에서는 Jetson에 접속하거나 설정을 적용하지 않았다. `glim_map` pose와 odom-frame `odom`/`odom_corrected`는 대체 관계가 아니다.

| 환경값 | Jetson 후보 값 / 적용 위치 |
|---|---|
| `FH_MAPPING_GLIM_ODOM_TOPIC` | `/foothold_glim/pose` (map 위치) |
| `FH_MAPPING_GLIM_POSE_TYPE` | `PoseStamped` |
| `FH_MAPPING_GLIM_FRAME` | `glim_map` |
| `FH_MAPPING_GLIM_CLOUD_TOPIC` | `/foothold_glim/map` (출처 설정만 유지; 완료 증거 아님) |
| `FH_MAPPING_GLIM_CHILD_FRAME` | 미설정 |
| `FH_MAPPING_GLIM_DUMP_ROOT` | `~/foothold-slam/final-dumps`; **agent와 GLIM user unit에 동일하게 설정** |
| `FH_MAPPING_GLIM_DUMP_TIMEOUT_S` | `180`; 실제 종료 시간에 맞춰 최대 600까지 |
| `FH_MAPPING_SERVICE_CONTROL_ENABLED` | 검토된 설치에서 `true`; 기존 서비스 이름 유지 |
| `FH_MAPPING_POINT_LIO_POSE_TYPE` | `Odometry`; 기존 Point-LIO 토픽/frame 설정 유지 |

GLIM user unit의 기존 ROS overlay·실행 인자·CPU 설정을 유지하고 **직접 실행하는 `glim_rosnode` 바이너리 앞에** 다음 래퍼를 둔다(예시 경로는 설치 환경에서 치환). `ros2 run`이나 종료 직후 빠져나오는 shell을 중간 프로세스로 두지 않는다.

```text
ExecStart=<agent-python> -m foothold_agent.mapping.glim_dump <glim-prefix>/lib/glim_ros/glim_rosnode <기존 GLIM 인자>
KillSignal=SIGINT
KillMode=mixed
TimeoutStopSec=180
```

래퍼는 agent가 start 때 만든 `request.json`을 읽고 세션별 `<session UUID>-r<final revision>/dump`를 ROS `dump_path` parameter로 추가한다. GLIM의 `dump_on_unload`는 **false**로 두어 destructor의 별도 `/tmp/dump` 저장을 끈다. 실행 전 `started.json`, 종료 신호를 전달한 child가 **exit 0**으로 끝난 뒤에만 `completed.json`을 원자적으로 쓴다. 두 영수증과 request는 세션·최종 revision·frame·무작위 nonce가 같아야 한다. 기존 세션 폴더·이미 실행한 request는 재사용/덮어쓰기하지 않으며 자동 삭제하지 않는다. agent 재시작 후 진행 중 세션의 자동 복원은 지원하지 않는다. 다음 새 세션은 새 UUID 폴더를 쓴다.

save는 이 agent가 두 서비스를 시작해 소유했고 시작 완료한 세션에서만 dump 완료를 수용한다. 기존에 떠 있던 서비스를 임의로 종료하거나 그 dump를 확인된 지도로 쓰지 않는다. 종료 요청은 기존 전용 서비스 스레드로 전달한다. 두 소유 서비스의 stop 성공 확인은 검증된 dump를 읽어 `SLAM_SAVED`로 판정할 때 필수다. 5초 systemctl 호출이 실패하거나 timeout 나면 서비스 스레드가 정리를 재시도한다. stop이 확인되지 않아도 저장 대기 상한(유효한 dump 설정/소유가 없으면 10초, 있으면 `FH_MAPPING_GLIM_DUMP_TIMEOUT_S`) 뒤에는 마지막 Point-LIO 자료를 `slam_save=UNKNOWN`으로 동결하고 업로드한다. stop 실패는 `SLAM_SERVICE event=stop_failed` 로그·서비스 `UNKNOWN` 상태·저장 progress 사유에 남기며, 확인 없는 `SLAM_SAVED`는 만들지 않는다.

dump 폴더는 자동 삭제하지 않는다. `du -sh ~/foothold-slam/final-dumps/*/`로 크기를 확인하고, 해당 세션의 서비스 종료·저장/재처리 필요 여부를 확인한 뒤 보관이 끝난 세션 UUID-revision 폴더만 수동으로 삭제한다(설정한 dump root 사용).

근거는 설치된 wrapper 1.2.2 커밋 [`4d4ec524`](https://github.com/koide3/glim_ros2/blob/4d4ec524ccf1b02aa09b0af2af767ecc54343798/src/glim_rosnode.cpp#L19-L24)의 shutdown → wait → save, GLIM 커밋 [`1a197c99`의 GlobalMapping::save](https://github.com/koide3/glim/blob/1a197c999e4865f5cab7c9cd25474128413ebbca/src/glim/mapping/global_mapping.cpp#L546-L635)와 [SubMap::save](https://github.com/koide3/glim/blob/1a197c999e4865f5cab7c9cd25474128413ebbca/src/glim/mapping/sub_map.cpp#L24-L63)다. `graph.txt`의 submap/frame 수, 연속된 6자리 submap 폴더, 완전한 `data.txt`, graph/values, 설정, trajectory를 검사한다. [`gtsam_points::save_compact`](https://github.com/koide3/gtsam_points/blob/8e94654558dfbe7ddb0341de300daaf17e25ee02/src/gtsam_points/types/point_cloud.cpp#L162-L175)의 `points_compact.bin`은 native float XYZ 12 bytes/점이다. 이 reader는 Jetson/x86의 little-endian float32 형식만 지원하며 일반 `points.bin`이나 PCD를 추측해 읽지 않는다. gtsam_points commit은 로컬 r25 설치 기록의 1.2.2 `8e94654558dfbe7ddb0341de300daaf17e25ee02`와 같은 공식 소스를 읽었다. rs-slam-r25가 실제 바이너리 산출물도 이 형식과 대조해야 한다.

서비스 종료와 영수증을 확인한 뒤 파일 목록·크기·mtime/inode가 1초 이상 안정돼야 읽는다. 완료 영수증 이후 변경, symlink, 누락·부분 쓰기·다른 세션/판·비정상 행렬/좌표는 거부한다. 최종 점은 각 submap의 `T_world_origin`을 적용하고, 최종 위치는 최적화된 `traj_imu.txt` 마지막 pose로 만든다. 주기적으로 받은 map pose의 오래된 위치를 최종 최적화 좌표에 붙이지 않는다. 읽기 끝에도 파일 목록을 다시 대조하며, 실패하면 기존 Point-LIO 판을 보존한다.

## 서비스 생명주기

시작은 서버가 해당 운영자의 로봇 세션에 보낸 명령, 현재 기체 확인·인증 관측 연결·로컬 기본 꺼짐 설정을 거친다. 이동 승인·조종권·잠금 해제는 필요하지 않으며 새 권한을 만들지 않는다. systemctl은 별도 daemon에서 제한된 인자 배열과 5초 호출 timeout으로 실행한다. 조종/STOP 이벤트 루프는 기다리지 않는다.

서비스 이름은 설정된 두 `foothold-*` user unit으로 제한한다. 이 agent가 소유하지 않은 기존 실행 서비스는 소유하거나 끄지 않으며, 하나라도 있으면 새 세션의 시작 완료로 인정하지 않고 기존 서비스가 이미 실행 중이라는 오류를 표시한다. is-active가 0(실행 중)이나 3(꺼짐) 이외의 값을 반환하면 조회 실패로 처리하며 해당 서비스를 시작하거나 소유하지 않는다. 우리가 시작한 것만 저장/취소/종료 때 끈다. 새 세션은 이전에 소유한 그래프를 정리한 뒤 시작한다. 서비스 제어가 설정으로 켜져 있으면 이번 세션이 두 서비스를 직접 시작하고 `STARTED`의 `ready_at`이 기록된 뒤 받은 점·위치만 누적하며, 소유한 서비스가 실행 중일 때만 누적한다. 대체 업로드는 같은 시작 완료 이력을 요구하며 정지 전 자기 자료의 저장은 유지한다. 예외는 설정이 꺼진 경우(`FH_MAPPING_SERVICE_CONTROL_ENABLED`가 대소문자를 무시해 `true`가 아님)에만 적용하며, 런타임 `DISABLED` 상태만으로는 허용하지 않는다. 오프라인·닫힌 상태에서 시작 요청을 거절하면 실패로 처리하고 이전 소유 서비스의 정리 요청을 유지한다. 시작 실패 세션은 이전 그래프의 자료를 모으거나 업로드하지 않는다. 마지막 서비스 시작 호출 중 저장·취소·세션 교체·관측 연결 상실이 생겨도 시작 완료 이력을 남기지 않는다. 시작을 완료했던 세션 자신의 정지 실패에는 위 저장 상한 뒤 UNKNOWN 업로드를 유지한다. stop 재시도는 별도 서비스 스레드에서만 실행해 Point-LIO 자료 처리와 명령 처리를 기다리게 하지 않는다. 같은 서비스의 같은 stop 실패 경고와 관련 cleanup 경고는 30초 간격으로 줄이며, 재시도와 정지 복구 확인은 계속한다. 이전 그래프를 정리하지 못한 새 세션은 시작 실패를 표시하고, 정지 복구 후 새 세션 명령으로 다시 시작한다. 연결/기체 확인 조건이 사라지면 reader를 닫고 10초 뒤 소유한 서비스를 끈다. 이 정리 요청은 DDS 작업자가 지연돼도 별도 관측 감시에서 수행한다. 연결 끊김으로 정지를 요청한 세션은 재접속 뒤 UNKNOWN과 새 세션 시작 안내를 표시하고 점·위치 누적을 재개하지 않는다. 정지 전에 받은 자기 자료는 저장·대체 업로드할 수 있다. 재접속은 시작을 재전송하지 않는다. 서비스 상태 조회/시작 중 취소도 처리한다. systemd unit 설치와 agent 강제 종료에 대한 supervisor 결합은 이 PR에서 실기 검증하지 않았다.

`foothold-robot`·`foothold-policy-cpp`·`foothold-depth`는 두 설정 어디에 넣어도 초기화 오류로 기록하고 거부한다(`.service` 접미사 포함). 서비스 조회·시작·종료는 수행하지 않는다.

## 선택적 라이다·IMU 원본 녹화

`point_lio` 새 세션에만 적용한다. `FH_MAPPING_RAW_RECORD_ENABLED=true`와 기존 서비스 조작 설정이 모두 켜져 있고, 이 agent가 두 지도 서비스를 시작해 소유한 것을 확인한 뒤 녹화를 시작한다. 이미 실행 중이던 서비스가 하나라도 있으면 `services_not_owned`로 건너뛴다. 기본 꺼짐이며 구형 PCD 경로는 적용 대상이 아니다. ROS 2와 `rosbag2` sqlite3 플러그인, `taskset`, `nice`가 agent 실행 환경에서 사용 가능해야 한다. ROS overlay·도메인·RMW 설정도 실행 환경을 그대로 상속한다.

| 설정 | 기본값 / 의미 |
|---|---|
| `FH_MAPPING_RAW_RECORD_ENABLED` | `false`; 명시적 `true`일 때만 시도 |
| `FH_MAPPING_RAW_CLOUD_TOPIC` | `/utlidar/cloud`; 원본 LiDAR ROS 토픽 |
| `FH_MAPPING_RAW_IMU_TOPIC` | `/utlidar/imu`; 원본 IMU ROS 토픽 |
| `FH_MAPPING_RAW_RECORD_DIR` | `~/foothold-slam/sessions`; 세션별 `map-<session UUID>/raw/`에 sqlite3 rosbag, 옆 `recorder.log`에 recorder 출력 |

안전 기준은 고정으로 **한 세션 2 GB(2,000,000,000 bytes)**, 시작 전 **남은 공간 10 GB(10,000,000,000 bytes) 이상**이다. 부족하면 세션 폴더를 만들지 않고 건너뛴다. bag·sidecar·recorder 로그의 파일 크기를 전용 스레드에서 250 ms마다 합산하고 상한에 도달하면 녹화만 멈춘다. 검사 간격 동안의 쓰기와 SIGINT 후 sqlite3 정리 때문에 최종 크기는 2 GB를 조금 넘을 수 있다. 디스크 하드 쿼터가 아니다. 같은 세션 폴더가 이미 있으면 덮어쓰지 않고 `session_path_exists`로 건너뛴다.

`ros2 bag record --storage sqlite3`는 별도 프로세스 그룹에서 CPU 0–3·nice 10으로 실행한다. 저장 요청·취소·관측 인증/기체 확인/연결 조건 상실·세션 교체·agent 정상 종료에서 우리가 시작한 그룹에만 SIGINT를 보낸다. 연결 조건 상실 때 녹화는 즉시 종료 요청하며 지도 서비스의 기존 10초 유예와 별개다. 종료 정리와 `wait`도 전용 스레드에서 수행하며 느린 flush 동안 다음 녹화를 시작하지 않는다. agent 비동기 작업 종료에서는 이벤트 루프를 막지 않고 최대 10초간 녹화 작업자 정리를 기다린다. SIGINT가 지연되면 `sigint_flush_pending`을 로그로 알리고 강제 종료하지 않는다. 10초 넘게 끝나지 않는 recorder, agent 프로세스 강제 종료나 전원 차단은 정상 종료를 보장하지 않는다.

녹화 실패·상한·공간 부족이 지도 상태나 서비스 생명주기를 바꾸지는 않는다. 기존 progress `reason`(최대 200자)에 녹화 상태·사유·현재 bytes를 덧붙이고, `SLAM_RAW` 로그에는 session_id·경로·bytes·상태를 남긴다. 진행 중 크기는 약 10초마다, 종료 때 최종 크기를 기록한다. bundle 계약을 확장하지 않으며 원본을 서버로 업로드하지 않는다. 녹화가 끝나도 지도 세션이 진행 중이면 상태가 계속 보인다.

**자동 삭제는 하지 않는다.** 저장 성공·취소·실패에도 원본 폴더는 보존한다. 로컬 목록·크기는 `du -sh ~/foothold-slam/sessions/map-*/`로 확인할 수 있다(저장 위치를 바꿨으면 해당 경로 사용). 재처리는 로그의 session_id·경로와 bag 안의 metadata를 기준으로 별도 승인된 절차에서 진행하며, 실제 센서 토픽에 임의 재생하지 않는다.

되돌릴 때는 다음 실행의 `FH_MAPPING_RAW_RECORD_ENABLED=false`로 녹화를 끄거나 이 변경 커밋을 revert한 agent를 기존 배포 절차로 적용한다. 실행 중인 세션은 먼저 저장/취소 또는 agent 정상 종료로 SIGINT 정리를 거친다. 기존 녹화 폴더는 그대로 보존한다.

## 5 cm 계산과 전달

`WorldAccumulator`는 기존 세션/저장 core를 확장한다. 칸 = `floor(XYZ/.05)`, 중심 = `(index+.5)*.05`이며 음수 좌표도 같다. live는 판당 최대 8,000점으로 고르게 솎고 30 ms 계산 예산을 작은 묶음마다 확인한다. 운영체제 스케줄링까지 포함한 실시간 보장은 아니다.

2D는 처음 pose 가운데 2,000×2,000칸(100 m 사방), 5 cm다. 범위/계산 한도로 잘리면 부분 자료로 기록한다. 기본은 장애물만 투영하고 나머지는 모름이다. Point-LIO가 등록된 현재 scan을 제공하는 것과 pose가 정확한 센서 원점이라는 것은 별개이므로 보정 확인 설정 전에는 광선으로 빈 곳을 만들지 않는다. 확인된 scan 모드에서는 웹 `occgrid.ts`의 -4/+22 로그오즈, 포화 ±40, -10/15 표시 문턱, 높이·10 m 사거리·한 판 벽 우선 규칙을 그대로 쓴다. NumPy와 격자 배열 초기화도 계산 작업자까지 미룬다.

GLIM dump는 512점씩 별도 공간에서 읽고 모든 점을 5 cm로 묶는다. 50만 voxel/기존 100 m 2D 창 상한을 넘으면 부분 자료로 기록한다. 완성 시 source·revision·frame·voxel·grid·pose를 함께 바꾼다. GLIM→Point-LIO 역전은 없으며 재구축 실패면 마지막 live 판을 보존한다. 누적 전체 지도에 현재 위치의 광선을 쏘지 않는다.

전달은 오래된 voxel 변경부터 최대 2,000개, 오래된 대기 tile부터 최대 4개씩 progress 64 KiB에 맞춰 나눈다. tile은 world 정렬 64×64칸, 원점 `[x*3.2,y*3.2]`, 0 모름/1 빈 곳/2 벽이다. 전송 확인된 항목만 지우고 새 revision에서는 이전 판을 비운다. 브라우저는 계산하지 않고 받은 칸을 배치한다.

tile·grid·bundle의 `floor_z`는 revision의 첫 유효 scan에 대응하는 pose z에서 0.3 m를 뺀 값으로 고정한다. 뒤 pose의 z가 움직여도 바꾸지 않으며, GLIM 재구축을 새 revision으로 교체할 때 그 판의 기준으로 함께 교체한다.

저장은 서비스 종료 → 세션 dump 완료/안정 확인 → 재구축 → 최종 tile·voxel 전송 확인 → bundle 업로드 순서다. dump 설정/소유가 없으면 10초, 설정한 세션은 기본 180초 뒤 확인 실패를 UNKNOWN으로 동결한다(진행 중인 재구축은 마친다). 서버가 UNKNOWN bundle을 받으면 `RECEIVED_ONLY`, 정상 GLIM 판의 `SLAM_SAVED` bundle을 보관하면 `SAVED`와 `SLAM_CONFIRMED`를 만든다. 재시도는 같은 바이트이고 서비스를 다시 시작하지 않는다. GLIM 확인과 파일 저장 성공은 별개이며 Point-LIO 자료로 `SLAM_SAVED`를 주장하지 않는다. 시뮬 지형 생성은 서버의 후속 작업이다.

계산 한도로 잘린 GLIM 판은 bundle의 `slam_save`와 progress phase 모두 UNKNOWN이다. 로컬 `<session>.bundle.json`은 같은 세션의 서버 `SAVED`·`RECEIVED_ONLY` 응답을 확인하거나 그 세션을 취소한 뒤에만 삭제한다. 업로드 실패·수신 미확인은 재시도용으로 남기며 다른 세션 파일은 건드리지 않는다. 저장 파일 작성·업로드 도중 취소되면 해당 작업이 끝날 때에도 취소된 세션 파일을 정리한다.

## 검사와 남은 범위

```sh
PYTHONPATH=apps/agent:. python3 -m pytest apps/agent/tests/test_slam_mapping.py   # node 가 있으면 fixtures/occgrid_reference.cjs(옛 웹 occgrid.ts 사본)와 Int8 격자 대조
PYTHONPATH=apps/agent python3 apps/agent/tools/benchmark_slam.py
PYTHONPATH=apps/agent:. python3 -m pytest apps/agent/tests
PYTHONPATH=apps/agent:. python3 -m pytest apps/agent/tests/test_raw_recording.py
PYTHONPATH=apps/agent:. python3 -m pytest apps/agent/tests/test_glim_dump.py
PYTHONPATH=. python3 -m pytest apps/server/tests/test_slam_*.py
```

계약 통합 전에는 PR #476의 models.py·mapping_sources.py를 같은 임시 폴더에 추출하고 `FH_SLAM_CONTRACT_MODULE`을 지정한다. 모의 시험은 옛 웹 occgrid.ts 사본(fixtures/occgrid_reference.cjs)과 전체 Int8 격자 동등성, 음수 좌표, 최종 판 교체, tile 분할/재시도, 기본 서비스 발행 0, 소유한 서비스만 종료, 느린 서비스/HTTP/계산 중 STOP을 검사한다. 실제 DDS나 systemctl은 실행하지 않는다.

이 PC(Intel i7-10750H, x86_64, Python 3.12.3, NumPy 1.26.4)의 공통 계산기 측정: 합성 10만 점 ×50판, 8,000점 상한·30 ms 예산. 투영 p50/p95/max 30.214/30.469/30.699 ms, 광선 31.377/32.819/41.487 ms(전체 시험과 동시 실행). Jetson 측정이 아니다. 통합 커밋 fe63f145의 agent·카메라 전체는 3,592 통과·기존 실패 12개·10 건너뜀이며, 새 지도·서비스·구형 명령 호환 시험은 27개 통과했다. 기존 실패는 웹 코드 추출의 bumpInputs 누락(phone 7개·speed 5개)으로 변경 전 소스에서도 재현했고 이 PR에서 고치지 않았다. 정확한 검사 명령·커밋은 PR 본문에 기록한다.

GLIM 저장 형식은 위 커밋의 소스와 가짜 dump로 검사했다. 실제 설치·서비스 신호/종료·gtsam_points binary layout·Point-LIO 입력 시각·센서 원점·frame/QoS·loop closure·Jetson 메모리와 STOP 지연·실제 시뮬 지형 실행은 미검증이다. 원격 서버·로봇·Gazebo·운영 설정에 접속하지 않았다. 되돌리기는 agent 변경 커밋을 revert하고 기존 배포 절차로 복구하며 지도/서버 원물은 삭제하지 않는다. 래퍼를 적용한 unit도 기존 실행 방식으로 함께 되돌려야 한다.

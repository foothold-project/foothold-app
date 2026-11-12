# 지도 만들기 계약 (fh-agent/2, REST fh-api/1)

화면 문구는 «지도 만들기», «지도 저장», «취소». API의 slam 이름은 화면에 표시하지 않는다.
타입 정본은 apps/contracts/models.py (MappingStart/Action/Progress/Preview), 생성 TS를 사용한다.

## 화면 REST

모든 경로 앞에 `/api/v1`. 기존 로그인/CSRF 사용. 요청자는 로봇의 **담당 OPERATOR**여야 한다.
총괄·다른 운영자 거부(403 MAPPING_OWNER_ONLY). 실기 로봇, REAL 장소·HUMAN 층만 가능
(422 MAPPING_REAL_ONLY), 휴지통 자원 거부(409 RESOURCE_ARCHIVED).

- `POST /robots/{id}/slam/start` body `{floor_id}` → 202 MappingProgress.
- `POST /robots/{id}/slam/save` body `{session_id}` → 202 MappingProgress.
- `POST /robots/{id}/slam/cancel` body `{session_id}` → 200 MappingProgress.
- `GET /robots/{id}/slam` → MappingProgress 또는 null. **화면은 1초 간격으로 조회**한다.
  담당자만 조회 가능하며 응답은 Cache-Control: private, no-store.

start/save는 연결된 agent 필요(409 ROBOT_OFFLINE). 로봇당 RUNNING/SAVING/FAILED 세션 하나.
중복 start는 409 MAPPING_ACTIVE. save는 RUNNING/FAILED에서 허용하며 SAVING/SAVED 중복은
현재 응답 반환(재업로드 없음). 세션 불일치 409 MAPPING_SESSION_MISMATCH.
담당자가 바뀌면 새 담당자는 이전 작업을 취소한 뒤 새로 시작할 수 있다.
cancel은 SAVED이면 409 MAPPING_STATE_CONFLICT, CANCELLED 재요청은 같은 결과.
SAVING 중 취소는 허용하며 이후 업로드는 거부한다. 점군 수신·변환은 조종권과 무관하다.

## agent 프레임 및 저장

서버 → agent: `{t:'slam',op:'start'|'save'|'cancel',session_id,floor_id}`.
REST에서 권한·연결·세션을 검증한 프레임만 송신한다. 일반 agent 제어 제한을 해제하지 않는다.
agent → 서버: `AgentMappingUpdate` = `{t:'slam.update', ...MappingProgress}`.
전송은 agent Bearer 토큰으로 `POST /agent/robots/{id}/slam/{session_id}/progress` (202).
기존 제어 WS/배포의 4096-byte 제한을 늘리지 않기 위해 별도 bounded HTTP로 보낸다.
WS slam.update도 4096 byte 이하인 경우 수용하지만 기본 agent는 HTTP를 사용한다.
RUNNING/SAVING/FAILED/CANCELLED 보고만 반영하며 SAVED는 서버 저장 트랜잭션만 결정한다.
현재 세션·층과 일치해야 한다. 1초 간격, JSON UTF-8 **64 KiB 이하**.
모든 agent WS 메시지의 4096 byte 상한은 유지한다. 서버 진행 보고는 지도 생성·명령 실행 권한을 주지 않는다.

미리보기: `{resolution,cells:[[ix,iy],...],robot:[x,y,yaw]|null,path:[[x,y],...]}`.
미터·라디안, XY 위에서 보기, cells는 resolution 단위 격자 인덱스.
이번 작업의 odometry 좌표계이며 저장된 층 지도 위에 곧바로 겹치지 않는다.
저장할 때의 좌표 이동은 VoxelMapSummary.source_translation에 기록된다(이후 위치 찾기는 별도 단계).
최대 2000칸/256경로점. 넓어지면 해상도를 낮추며 경로를 균등 추출한다.
벽 높이의 점을 위에서 투영한다. free/unknown 판정 없는 관측점 그림이며 주행 가능 판정이 아니다.
`distance_m`, `point_count`, `elapsed_s`, `error_code`, 쉬운 한국어 `reason` 포함.
`map_version_id`/`terrain_id`는 SAVED에서 새 지도/연결 지형을 가리킨다.
SAVED의 point_count는 저장한 PCD의 실제 점 수다(계약 최대 500만, 현재 agent 누적 한도 200만).

agent는 Bearer **agent 토큰**으로
`POST /agent/robots/{id}/slam/{session_id}/point-cloud` 에 binary XYZ PCD raw body를 전송한다.
50 MiB 제한(기존 voxel-maps 동일), SAVING 세션·robot·floor·시작 당시 담당자와 지도 기준 판에 묶인다.
성공 201 VoxelMapImport, 이미 SAVED이면 저장된 같은 응답(지도 중복 생성 없음).
변환/저장 실패 → FAILED + 이유, 로컬 누적 및 PCD 유지, 다시 지도 저장 가능.
승인 지도 판이 시작 후 바뀌면 409 STALE: 취소 후 다시 시작한다.
새 판은 HUMAN/APPROVED/source=SLAM, 기존 판과 #333의 연결 증명은 보존한다.
원본·raster·voxel·연결 지형 저장은 기존 voxel_maps 파이프라인을 공유한다.

## 연결 끊김과 장비 입력

연결 끊김/서버 liveness 상실 시 누적을 멈추고 FAILED/LINK_LOST.
재연결 시 자동 재개하지 않는다. 같은 프로세스의 누적을 **저장하거나 취소**할 수 있다.
프로세스 재시작 후 자동 복구는 이번 범위 밖이며 로컬 PCD는 저장 실패 시 남는다.
늦은 보고로 SAVING/SAVED/CANCELLED를 되돌리지 않는다. 서버 재시작 뒤 RUNNING은
agent 재접속의 LINK_LOST 보고 또는 다음 저장 요청으로 정리한다.

방식: 로봇 odometry(position + IMU quaternion)로 좌표 변환 후 5 cm voxel 누적.
각 스트림 timestamp는 독립적으로 단조 증가를 확인하고, 서로 다른 시계 원점을 가정해
노트북 수신 시각이 250ms 이내인 최신 위치와 점군을 맞춘다(원천 시각 동일 원점 추정 안 함).
루프 닫기/ICP/scan deskew 없음. 장거리 드리프트·빠른 회전·시각 불일치가 품질을 제한한다.
선택 이유는 기존 go2-readonly와 같은 NumPy 고정판만으로 구성해 별도 정합기 빌드 없이
x86_64 cp310 wheel을 오프라인 설치 파일에 넣을 수 있기 때문이다.
새 optional `slam = [numpy==1.26.4]`: cp310 manylinux x86_64 wheel 다운로드 확인.
**설치 파일 작업자는 slam 묶음을 포함할 것.** 이 작업은 설치 파일을 수정하지 않는다.

SDK 정본 커밋 `unitree_sdk2_python@814556d15970dd2ecf1c9984e845ca02ab07e206`:
- 이 저장소 `apps/agent/foothold_agent/go2_readonly/sdk.py`: 기존 `rt/sportmodestate` 구독을 공유.
  고정 SDK Go2 예제에는 해당 토픽 문자열이 없으므로 SDK에서 확인했다고 주장하지 않는다.
- `unitree_sdk2py/idl/unitree_go/msg/dds_/_SportModeState_.py`: position, imu_state quaternion, stamp.
- `unitree_sdk2py/idl/sensor_msgs/msg/dds_/_PointCloud2_.py` 및 `_PointField_.py`: binary 레이아웃.
**이 고정 SDK에는 라이다 점군 topic 이름 예제가 없다.** 이름을 기억으로 기본 설정하지 않는다.
기준 커밋 `83dafea`의 `apps/agent/foothold_agent/go2_direct/sdk.py:103` 관측 경로의
`rt/utlidar/cloud` / PointCloud2_를 기본으로 재사용한다.
`FH_MAPPING_LIDAR_TOPIC` 하나로 topic을 덮어쓴다(L1/L2 교체).
Unitree 공식 `unitree_ros2@668d1ec5a05d1c38d3306bdca7d59f2ba3581a88/README.md:343-366`
에는 ROS 표시명 `utlidar/cloud`, frame `utlidar_lidar`가 확인된다(참고 소스만, ROS 실행/설치 없음).
같은 고정 ROS 소스 `example/src/src/read_low_state.cpp:47-50`은 IMU quaternion 순서를 qw/qx/qy/qz로 명시한다.
기본 허용 frame은 기존 관측 경로와 같은 utlidar_lidar/lidar_link.
다른 센서 frame은 `FH_MAPPING_LIDAR_FRAME`으로 덮어쓴다.
`FH_MAPPING_LIDAR_TO_BODY`(x,y,z,roll,pitch,yaw; m/rad)는 보정 덮어쓰기이며
기본은 영 변환이다. 센서 장착 오프셋/각도에 따른 벽 겹침은 실기 첫 검증 항목이다.
잘못된 frame은 FAILED/SENSOR_FRAME.
같은 초기화 DDS participant/NIC에서 ChannelSubscriber만 추가하며 publisher/RPC/이동 명령은 없다.


## 실기 첫 확인 (이번 작업에서 실행하지 않음)

1. 같은 전용 NIC에서 점군 topic/PointCloud2 frame, odometry 시각의 각자 단조 증가·노트북 수신 시차 확인.
2. 설치 파일의 slam extra 포함과 cp310 NumPy wheel 오프라인 설치 확인.
3. 담당 운영자 폰 조종 중 지도 만들기·미리보기 1초 갱신·벽 겹침/센서 장착 보정 확인.
4. STOP의 기존 경로/정지 지연이 그대로인지, 지도 작업의 SDK publisher/RPC가 없는지 확인.
5. 연결 단절 후 누적 정지, 재연결 후 저장 재시도·취소, 새 지도 판/연결 지형과 이전 판 보존 확인.
6. 긴 경로/회전 중 odometry 드리프트·deskew 미적용에 따른 실제 품질 확인 (루프 닫기 없음).

## 오류 코드 보충

화면은 서버/진행 보고의 한국어 `message`/`reason`을 표시하고, FAILED에서는 저장 재시도·취소를 제공한다.

| 코드 | 의미/처리 |
|---|---|
| MAPPING_CONFIG_REQUIRED, SENSOR_FRAME | topic/frame/보정 설정 또는 구독 실패. 연결 프로그램 설정 확인 후 취소/재시작 |
| MAPPING_DEPENDENCY | slam optional 묶음 미설치. 설치 파일에 포함 후 다시 연결 |
| SENSOR_UNAVAILABLE | 3초간 시각이 맞는 라이다·위치를 받지 못함. 기존 점은 보존 |
| LINK_LOST | 서버 연결 끊김. 같은 프로세스 재연결 뒤 저장/취소 |
| MAPPING_LIMIT, ODOMETRY_JUMP | 점 수 상한 또는 한 스캔 사이 2m 초과 위치 점프. 새 점 누적 중지, 보존한 지도 저장/취소 |
| MAPPING_EMPTY | 저장할 점 없음. 취소 후 새로 시작 |
| MAPPING_SESSION_LOST | 프로그램 재시작으로 메모리 누적 없음. 취소 후 새로 시작 (디스크 PCD 자동 재수입 없음) |
| STALE | 지도 기준 판 변경. 서버의 한국어 이유를 전달하며 취소 후 새로 시작 |
| MAPPING_FAILED, MAPPING_SAVE_FAILED | 누적/저장 실패. 만든 점은 보존, 저장 재시도/취소 |
| MAPPING_REPORT_TOO_LARGE | 진행 보고 64KiB 초과, agent가 축소해야 함 |
| INVALID_POINT_CLOUD, UPLOAD_TOO_LARGE, UPLOAD_TIMEOUT, UPLOAD_BUSY, FILE_STORAGE_ERROR, FILE_STORAGE_FULL | 기존 점 지도 형식·50MiB 상한·수신·변환·저장 오류, 원본 점은 노트북에 보존 |

실기 품질과 CPython 3.10에서의 실제 구동은 미검증이다. 자동 시험은 CPython 3.12에서
합성 자료·가짜 DDS/가짜 연결만 사용했다. x86_64 cp310 NumPy wheel은 내려받아 존재만 확인했다.

지도 만들기 중에는 층 휴지통 이동/완전 삭제를 거부한다(RESOURCE_IN_USE).
저장/취소 뒤 층을 완전 삭제하면 해당 지도 만들기 세션 기록도 함께 정리한다.

## 자동 검증 기록 (2026-11-12)

검증 환경은 CPython 3.12.3 / NumPy 1.26.4. 모든 DDS·로봇 출력은 fake이며
서버 시험은 private PostgreSQL·합성 파일만 사용했다. 실기/시뮬/데모/운영 배포는 실행하지 않았다.
`<python>`은 시험 가상환경의 Python이다. Orca가 상속한 loader 경로가 실기 입력 검증에
영향을 주지 않도록 agent 시험은 `env -u LD_LIBRARY_PATH -u CYCLONEDDS_URI -u CYCLONEDDS_HOME`으로 실행했다.

- 최종 agent 관련 221 PASS (지도 9 포함):
  `PYTHONPATH=apps/agent:. FH_TEST_PORT_RANGE=23000:23499 <python> -m pytest apps/agent/tests/test_mapping.py apps/agent/tests/test_go2_readonly.py apps/agent/tests/test_go2_drive_media.py apps/agent/tests/test_go2_server_drive.py apps/agent/tests/test_go2_direct.py apps/agent/tests/test_original_core.py apps/agent/tests/test_core_boundaries.py -q`
- 최종 server 지도/계약 20 PASS:
  `FH_TEST_PORT_RANGE=27000:27499 <python> -m pytest apps/server/tests/test_mapping.py apps/server/tests/test_contracts.py -q`
- 최종 server 수명·마이그레이션·연결 63 PASS:
  `FH_TEST_PORT_RANGE=24500:24999 <python> -m pytest apps/server/tests/test_mapping.py apps/server/tests/test_migrations.py apps/server/tests/test_resource_archive.py apps/server/tests/test_trash.py apps/server/tests/test_voxel_annotations.py -q`
- 앞선 voxel/권한/계약/왕복 영향 묶음 114 PASS:
  `FH_TEST_PORT_RANGE=24000:24499 <python> -m pytest apps/server/tests/test_mapping.py apps/server/tests/test_voxel_maps.py apps/server/tests/test_contracts.py apps/server/tests/test_migrations.py apps/server/tests/test_server_drive_blocked.py apps/server/tests/test_admin_no_real_control.py -q`
- `<python> apps/contracts/generate.py --check`: 생성물 289개 일치.
- Agent 전체(최종 수신 시각/오류 보완 전): `PYTHONPATH=apps/agent:. FH_TEST_PORT_RANGE=23500:23999 <python> -m pytest apps/agent/tests -q` → 2300 PASS, 20 FAIL, 1 SKIP.
  20개는 test_phone_policy_compat / test_phone_proportional / test_speed_1p5의 Node TS 추출 실패다.
  기준 83dafea의 세 파일에서도 동일한 20 FAIL, 115 PASS를 확인했으며 화면 소스·안전 기대값은 수정하지 않았다.
- Server ACK 단독 재실행: `test_phone_pass.py::test_real_ws_full_ack_queue_replays_and_switch_opens_only_after_atomic_commit`은 현재 코드/기준 83dafea에서 각각 1 PASS.

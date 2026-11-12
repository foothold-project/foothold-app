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
cancel은 SAVED이면 409 MAPPING_STATE_CONFLICT, CANCELLED 재요청은 같은 결과.
SAVING 중 취소는 허용하며 이후 업로드는 거부한다. 점군 수신·변환은 조종권과 무관하다.

## agent 프레임 및 저장

서버 → agent: `{t:'slam',op:'start'|'save'|'cancel',session_id,floor_id}`.
REST에서 권한·연결·세션을 검증한 프레임만 송신한다. 일반 agent 제어 제한을 해제하지 않는다.
agent → 서버: `AgentMappingUpdate` = `{t:'slam.update', ...MappingProgress}`.
RUNNING/SAVING/FAILED/CANCELLED 보고만 반영하며 SAVED는 서버 저장 트랜잭션만 결정한다.
현재 세션·층과 일치해야 한다. 1초 간격, JSON UTF-8 **64 KiB 이하**.
다른 agent WS 메시지의 4096 byte 상한은 유지한다. 서버 진행 보고는 지도 생성·명령 실행 권한을 주지 않는다.

미리보기: `{resolution,cells:[[ix,iy],...],robot:[x,y,yaw]|null,path:[[x,y],...]}`.
미터·라디안, XY 위에서 보기, cells는 resolution 단위 전역 격자 인덱스.
최대 2000칸/256경로점. 넓어지면 해상도를 낮추며 경로를 균등 추출한다.
벽 높이의 점을 위에서 투영한다. free/unknown 판정 없는 관측점 그림이며 주행 가능 판정이 아니다.
`distance_m`, `point_count`, `elapsed_s`, `error_code`, 쉬운 한국어 `reason` 포함.
`map_version_id`/`terrain_id`는 SAVED에서 새 지도/연결 지형을 가리킨다.

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
루프 닫기/ICP/scan deskew 없음. 장거리 드리프트·빠른 회전·시각 불일치가 품질을 제한한다.
새 optional `slam = [numpy==1.26.4]`: cp310 manylinux x86_64 wheel로 오프라인 설치 가능.
**설치 파일 작업자는 slam 묶음을 포함할 것.** 이 작업은 설치 파일을 수정하지 않는다.

SDK 정본 커밋 `unitree_sdk2_python@814556d15970dd2ecf1c9984e845ca02ab07e206`:
- `example/go2/high_level/go2_sport_client.py`: `rt/sportmodestate`, SportModeState_.
- `unitree_sdk2py/idl/unitree_go/msg/dds_/_SportModeState_.py`: position, imu_state quaternion, stamp.
- `unitree_sdk2py/idl/sensor_msgs/msg/dds_/_PointCloud2_.py` 및 `_PointField_.py`: binary 레이아웃.
**이 고정 SDK에는 라이다 점군 topic 이름 예제가 없다.** 이름을 기억으로 기본 설정하지 않는다.
기존 `apps/agent/foothold_agent/go2_direct/sdk.py:103` 관측 경로의
`rt/utlidar/cloud` / PointCloud2_를 기본으로 재사용한다.
`FH_MAPPING_LIDAR_TOPIC` 하나로 topic을 덮어쓴다(L1/L2 교체).
Unitree 공식 `unitree_ros2@668d1ec5a05d1c38d3306bdca7d59f2ba3581a88/README.md:343-366`
에는 ROS 표시명 `utlidar/cloud`, frame `utlidar_lidar`가 확인된다(참고 소스만, ROS 실행/설치 없음).
기본 허용 frame은 기존 관측 경로와 같은 utlidar_lidar/lidar_link.
`FH_MAPPING_LIDAR_TO_BODY`(x,y,z,roll,pitch,yaw; m/rad)는 보정 덮어쓰기이며
기본은 영 변환이다. 센서 장착 오프셋/각도에 따른 벽 겹침은 실기 첫 검증 항목이다.
잘못된 frame은 FAILED/SENSOR_FRAME.
같은 초기화 DDS participant/NIC에서 ChannelSubscriber만 추가하며 publisher/RPC/이동 명령은 없다.

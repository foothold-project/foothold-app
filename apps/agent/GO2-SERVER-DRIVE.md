# Go2 서버 경유 조종 시험 — 기본 꺼짐

ADR-002의 **명시적으로 선택한 시험 기체**에만 여는 예외다. 웹 담당 운영자 → 개발 서버의 기존 lease/arbiter → 이 PC가 밖으로 연 `fh-agent/2` WS → Go2Sink(`server`) → SDK/DDS 유선 NIC를 사용한다. 이 모드에는 폰 조종 리스너가 없으며, 총괄(ADMIN)은 실기 조종·STOP을 할 수 없다. 다른 운영자도 같은 조직의 STOP은 가능하다. `RobotSummary.server_drive_allowed`는 경로 표시용 bool이며 조종 권한을 대신하지 않는다.

## 준비·현장 순서

1. 두 모델의 안전 검토·통합 후 현장 담당자가 시험 공간과 비상 정지를 확보한다. USB-랜을 기체 전용으로 연결하고 네트워크 설정 화면에서 NIC와 중복 없는 유선 IPv4를 확인한다. Wi-Fi 인터넷은 유지한다. `ip -br link` / `ip -br -4 addr`는 조회만 한다. 기체 표기와 **실측 LowState DDS serial 두 정수의 `첫째-둘째` 형태**를 현장에서 대조한다. 추측한 serial이나 공유 NIC는 금지다. 다른 실기 조종 프로세스를 함께 켜지 않는다.
2. 총괄이 기존 `POST /api/v1/robots`로 실기를 등록하고 담당 운영자를 배정한다(기본 simulation=false). 등록 응답의 agent_token 또는 `POST /api/v1/robots/{robot_id}/agent-token` 재발급 토큰을 비공개로 준비한다. 재발급은 이전 토큰을 폐기한다. 주소·토큰·UUID·serial 실값은 저장소/공유 로그에 쓰지 않는다.
3. 이 PC 소유자의 비공개 파일(절대 경로, 소유자 일치, `chmod 600`, 단일 링크)에 승인 표식을 만든다. JSON 형식은 `{"v":1,"purpose":"go2-field-motion","nic":"<ROBOT_NIC>","robot_serial":"<DDS_SERIAL>","expires_at":<UNIX_SECONDS>}`이며 만료는 현재부터 최대 30분이다. 승인 표식만으로 실기 실행 허가가 생기지는 않는다.
4. **배포 담당자**가 개발 서버의 `FH_SERVER_DRIVE_ROBOTS`에 이 시험 로봇 UUID만 넣고 기존 배포 절차를 따른다(여러 개면 쉼표 구분, 기본 빈 문자열). wildcard/잘못된 UUID는 허용하지 않는다. 목록 밖 실기는 기존 `PHONE_DIRECT_REQUIRED`, ADMIN은 `ADMIN_NO_REAL_CONTROL`로 거부된다. 작업자는 운영 env 변경·서버 재시작을 하지 않는다.
5. 이 PC의 비공개 환경에 아래 이름을 설정한 뒤 에이전트를 시작한다. 값은 현장 담당자가 채우며 shell history·화면 공유에 토큰을 남기지 않는다.

   | 환경 이름 | 값/역할 |
   |---|---|
   | `FH_GO2_DIRECT_ENABLED` | `1`, 기본 꺼짐 |
   | `FH_GO2_DIRECT_NIC` | 기체 전용 유선 NIC |
   | `FH_GO2_DEDICATED_NIC` | 현장 독점 NIC 확인 후 `1` |
   | `FH_GO2_FIELD_APPROVAL` | 승인 JSON의 절대 경로 |
   | `FOOTHOLD_ROBOT_ID` | 서버 등록 UUID |
   | `FOOTHOLD_AGENT_WS_URL` | 해당 개발 서버 `/api/v1/agent/ws` WSS 주소 |
   | `FOOTHOLD_AGENT_TOKEN` | 해당 기체의 agent 토큰 |

   ```sh
   PYTHONPATH=apps/agent runs/go2-x86-venv/bin/python -m foothold_agent.go2_direct.preflight
   # 아래 명령부터 실제 DDS domain 0 참가와 SDK 출력이 시작됨: 현장 실행 승인 후에만
   PYTHONPATH=apps/agent runs/go2-x86-venv/bin/python -m foothold_agent.go2_direct --server
   ```

6. 웹에서 **담당 운영자**로 로그인하고 해당 시험 로봇을 선택한다. **웹 STOP부터** 눌러 잠금과 신선한 실측 정지를 현장 담당자와 먼저 확인한다. 조종권 획득 → 실측 정지 → 명시적 잠금 해제 → 새로운 중립 입력 후에만 전진한다. 승인 만료·NIC/serial 충돌·센서 불건전은 종료/정지한다.

## 유지되는 안전 경계

서버 경유 실기의 `cmd.axes`는 **SI 값 그대로**이며 아래 9개만 정확히 일치시킨다. 반올림·값 맞추기 없이 표 밖은 서버와 에이전트가 STOP·잠금하고 거절한다. 폰의 기존 네 가지 0.6 m/s 표와 시뮬 입력 정책은 바꾸지 않는다.

| 키 | (vx m/s, vy m/s, wz rad/s) |
|---|---|
| 손 뗌 | (0, 0, 0) |
| ↑ / ↓ | (1.5, 0, 0) / (-1.5, 0, 0) |
| ← / → | (0, 1.5, 0) / (0, -1.5, 0) |
| A / D | (0, 0, 0.5) / (0, 0, -0.5) |
| ↑+A / ↑+D | (1.5, 0, 0.5) / (1.5, 0, -0.5) |

 웹은 **새 seq로 10~20Hz 입력**을 보낸다. 서버는 입력을 그대로 전달하며 마지막 명령을 반복하지 않는다(lease만으로 계속 움직이지 않음). 원입력이 0.30초 끊기면 Move(0)·StopMove·잠금이다. 인터넷 지연으로 자주 잠기면 올바른 실패이므로 시간을 늘리지 않고 RTT/간격을 현장 측정한다. 소켓 단절은 즉시 정지·잠금이며 재연결만으로 재개하지 않는다. 주기 tick·상태·ping은 원입력 시각을 갱신하지 않는다. STOP은 lease와 무관하게 우선하고, lease 상실은 정지한다. 정지 확인에는 신선한 일치 serial의 LowState + SportModeState를 사용하며 SDK 성공 코드는 정지 증거가 아니다. RUN·SLAM·지도 명령은 이 예외로 열지 않는다. 서버 상태에는 기존 배터리·실측 속도·latched·stop_gen·실측 후 stop_ref를 사용한다.

## 이 PC 설치·검증 기록

시스템 Python/apt 변경 없이 `runs/go2-python/`의 사용자 공간 CPython 3.10.22와 `runs/go2-x86-venv/`를 준비했다(모두 gitignore). [고정 SDK 커밋](https://github.com/unitreerobotics/unitree_sdk2_python/blob/814556d15970dd2ecf1c9984e845ca02ab07e206/setup.py)은 `814556d15970dd2ecf1c9984e845ca02ab07e206`, cyclonedds는 `0.10.2`, numpy `1.26.4`, opencv-python `4.10.0.84`, websockets `15.0.1`, zeroconf `0.148.0`이다. [공식 PyPI 파일](https://pypi.org/project/cyclonedds/0.10.2/#files)의 `cyclonedds-0.10.2-cp310-cp310-manylinux_2_17_x86_64.manylinux2014_x86_64.whl` SHA256은 `1194b03377e7644c7fb7230dd19b85eb363699d179459bdc5486974ec8d0fc0e`다. wheel과 설치 로그/해시는 `runs/go2-x86-artifacts/`에 로컬 보관한다. preflight는 패키지/커밋/wheel 해시/ELF 메타데이터만 읽고 SDK를 import하거나 DDS에 참가하지 않는다. 소스 갱신 뒤 실행은 위처럼 `PYTHONPATH=apps/agent`를 명시한다.

이동 경로는 가짜 SDK·loopback WS로만 검증했다. 별도 사용자 승인으로 실기 상태 구독→로컬 서버→웹 상태 수신·headless 표시만 읽기 전용으로 확인했으며 실기 이동 검증은 아니다. 실기 NIC/serial·실제 STOP·인터넷 왕복·배터리/속도 실측 표시는 미검증이며, 이 문서의 설치 준비 완료는 실기 안전 검증이 아니다. 시험 종료 시 현장 STOP·정지 확인 후 에이전트를 종료하고 배포 담당자가 서버 목록에서 UUID를 제거한다. 코드 되돌림은 해당 기능 커밋의 revert로 하며 운영 교체는 별도 배포 절차다.


## 관측 전용 경로와 읽기 모드

카메라는 SDK VideoClient.GetImageSample로 읽어 640×360 이하 JPEG·64 KiB 이하·최대 5 Hz로 줄인다. L1은 같은 승인된 DDS 채널의 `rt/utlidar/cloud`를 읽고 센서 frame(`lidar_link` 또는 `utlidar_lidar`)의 float32 XYZ를 4000점·48 KiB 이하·최대 2 Hz로 줄인다. 지도 TF/위치는 만들지 않는다. 각 관측 worker와 최신 자료 1개짜리 보관함은 Core·Go2Sink와 무관하며, 카메라 RPC·코덱·업로드가 멈춰도 입력 감시/STOP을 기다리게 하지 않는다. 카메라 captured_at은 PC 수신 시각이며 기체 촬영 시각의 정확도는 미검증이다.

에이전트는 기존 agent 토큰으로 **HTTP POST** `/api/v1/agent/drive-media/{rgb|lidar}`에 `{header: media/1 JSON, points: null 또는 XYZ bytes의 base64}`를 올린다(본문 100,000 bytes 상한, 채널당 최대 5 Hz). 조종 WS 4096 bytes 제한과 배포 기동 인자는 유지한다. 웹은 같은 서버의 `/api/v1/robots/{robot_id}/drive-media/{rgb|lidar}` WS에 기존 로그인 쿠키+정확한 Origin으로 접속해 받기만 한다(Bearer 앱 인증도 가능). hello·URL 토큰·조종 입력은 없다. `media.video` JSON, `media.points` JSON 직후 binary xyz_f32le, `media.status`는 기존 media/1 그대로다. robot/epoch/episode_id(null)를 확인하고 epoch 변경·1초 넘은 자료·끊김 때 이전 그림을 비운다. 담당자/총괄만 볼 수 있고 재배정·로그아웃·토큰 폐기 시 재확인하여 닫는다. 느린 viewer는 0.20초 쓰기 마감으로 끊으며 관측 오류가 조종 연결을 닫지 않는다.

움직임 SDK 객체 없이 상태만 서버로 올릴 때는 별도 **읽기 전용** 모드를 쓴다. `FH_GO2_DIRECT_ENABLED` 및 `FH_GO2_FIELD_APPROVAL`은 제거하고, robot UUID·agent 토큰·서버 WS 주소만 기존처럼 설정한 후 `--server --readonly --nic <ROBOT_NIC>`를 명시한다. 이 모드는 go2_readonly의 두 DDS 구독자·DiscardSink만 사용하고 SportClient/Go2Sink/Move/StopMove/카메라 RPC를 만들지 않는다. 서버 cmd·lease·unlock·STOP은 모두 폐기하고 stop_ref=0을 유지하여 물리 정지 확인이나 조종권을 만들지 않는다. latched/applied는 논리 잠금·폐기 출력이며 **물리 STOP 확인이 아니다**. 이 명령 역시 실제 DDS 읽기 참가이므로 현장 읽기 승인이 있어야 한다. 읽기 모드에서는 카메라·라이다 송출을 하지 않는다.

## 명시적 0-0 신원 예외 — 서버 시험만

LowState 실측 serial이 **정확히 `0-0`**인 기체에서만 현장 담당자의 선택으로 유선 이웃·MAC 확인을 사용한다. 기존 표식의 소유자·0600·단일 링크·최대 30분 만료는 유지하고, JSON에 `"robot_serial":null,"serial_unavailable":true,"robot_mac":"<현장에서 읽은 소문자 unicast MAC>"`을 모두 명시한다. 누락·다른 serial·MAC 불일치에는 적용하지 않으며 폰 경유는 이 예외를 허용하지 않는다. 생성기는 `deploy/jetson/make_approval.py --output <비공개 절대 경로> --nic <ROBOT_NIC> --serial-unavailable --robot-mac <실측 MAC> --approve-field-motion`이다. 실제 값은 저장소·공유 로그에 넣지 않는다.

시작 및 **매번 명시적 잠금 해제 직전** 지정 NIC의 `ip -j -4 neigh show dev`를 읽어 해당 기체 대역 이웃이 Go2 `.161`과 Orin `.18` 두 항목뿐인지, `.161` MAC이 표식과 일치하는지, 신선한 SDK serial이 여전히 `0-0`인지 확인한다. 제3 이웃·누락·FAILED/INCOMPLETE·다른 NIC·다른 serial은 거부/정지/잠금이다. 스캔·ping·ARP 갱신/삭제·추가 패킷은 만들지 않는다. 잠금 해제의 이웃 조회는 비동기 한 개만 진행하고, 도중 STOP·lease 상실·WS 단절·세대 변화·0.30초 초과가 있으면 폐기한다. 예외를 통과해도 기존 실측 정지·명시 해제·새 중립 및 기본 **error_code==0** readiness 관문은 유지하며 아래의 명시적 운동 상태 목록만 서버 시험에서 추가로 허용할 수 있다.

로컬 관리 비트가 켜진 MAC은 기체 재부팅 뒤 바뀔 수 있다. 바뀌면 거부되는 것이 정상이며 현장에서 다시 읽고 새 표식을 만든다. 옛 MAC을 자동 수용하거나 serial 검사를 생략하지 않는다. 실제 이 예외로 이동하는 시험은 아직 하지 않았다.


## 확인된 V2 운동 상태 허용 — 기본 빈 목록

현장 사용자가 제공한 Unitree V2 문서에 따르면 해당 펌웨어판의 `SportModeState.error_code`는 현재 운동 상태 번호이며 **100=Agile(灵动)**이다. 근거: [Unitree Motion Services Interface V2.0](https://support.unitree.com/home/en/developer/Motion_Services_Interface_V2.0) — 현장 사용자 제공, JS 페이지 본문 대조는 미확인이다. V2에서는 0이 아닌 값이 상태 번호일 수 있으므로 확인된 정수만 목록에 적는다.

서버 경유 시험에만 `FH_GO2_ACCEPT_ERROR_CODES=<확인된 상태 번호의 쉼표 목록>`과 승인 JSON의 `"accept_error_codes":[<같은 정수 목록>]`이 정확히 같은 집합일 때 활성화한다. 기본은 둘 다 빈 목록, 0은 항상 허용, 목록 밖 값은 계속 거부한다. 시작 로그에 `서버 시험 운동 상태 허용: 100(Agile)`처럼 선택한 상태를 한 줄로 남긴다. 폰 경유와 읽기 전용 모드의 조종 권한에는 영향이 없다. 신선한 실측 정지·기존 mode/progress/높이/자세 조건·serial/MAC·명시 해제·새 중립·0.30초는 유지한다. 웹의 기본 보행 장치 오류 표시는 별도 범위다.

현장 담당자가 각각 실측값을 채우는 표식 생성 예: `deploy/jetson/make_approval.py --output <비공개 절대 경로> --nic <ROBOT_NIC> --serial-unavailable --robot-mac <실측 MAC> --accept-error-codes <확인된 상태 번호> --approve-field-motion`. 서버 경유 환경의 `FH_GO2_ACCEPT_ERROR_CODES`에도 동일한 정수 목록을 넣는다. 일반 serial이 확인되는 기체는 `--serial <실측 serial>`을 쓰며 0-0 예외를 적용하지 않는다.

관측 소스는 앞 카메라의 SDK VideoClient **RGB JPEG**와 `rt/utlidar/cloud`의 L1 점군이다. 별도 깊이 센서를 연결하지 않은 이번 구성에는 뎁스 영상 소스가 없으며 RGB를 뎁스로 표시하지 않는다.


서버 경유 이동 표는 현장 사용자 선택으로 전후·좌우 **1.5 m/s**, 회전 **0.5 rad/s**다. 고정 SDK의 SportClient.Move는 vx/vy/vyaw를 JSON으로 직렬화해 _CallNoReply로 보내며 자체 범위 검사/클램프가 없다. 따라서 SDK Python 코드가 vy=1.5를 직접 거부하는 경로는 없지만, 반환0은 펌웨어의 실제 수용·속도·클램프를 보장하지 않는다. 펌웨어 수용 범위와 실기1.5 m/s는 미검증이다. 폰 경로의 기존 표/limits는 유지한다.

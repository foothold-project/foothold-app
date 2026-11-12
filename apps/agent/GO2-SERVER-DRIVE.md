# Go2 서버 경유 조종 시험 — 기본 꺼짐

ADR-002의 **명시적으로 선택한 시험 기체**에만 여는 예외다. 웹 담당 운영자 → 개발 서버의 기존 lease/arbiter → 이 PC가 밖으로 연 `fh-agent/2` WS → Go2Sink(`server`) → SDK/DDS 유선 NIC를 사용한다. 이 모드에는 폰 조종 리스너가 없으며, 총괄(ADMIN)은 실기 조종·STOP을 할 수 없다. 다른 운영자도 같은 조직의 STOP은 가능하다. `RobotSummary.server_drive_allowed`는 경로 표시용 bool이며 조종 권한을 대신하지 않는다.

## 노트북 연결 프로그램으로 시작

실기 연결은 **담당 운영자**가 폰에서 진행한다. 총괄은 실기 목록과 상태를 읽기만 한다. 배포 담당자는 먼저 pairing/현장 승인 서버와 폰 화면을 통합하고, 별도 배포 절차에서 서버 전체 스위치 `FH_SERVER_DRIVE_ENABLED=1`을 설정한다(기본 꺼짐). 이 env가 **없을 때만** 기존 `FH_SERVER_DRIVE_ROBOTS` 목록을 읽으며 wildcard는 계속 거부한다. 어느 설정이든 로봇별 유효한 현장 승인이 함께 필요하다. Git push·PR은 서버 설정 변경·재시작·실기 실행 승인이 아니다.

1. 두 모델의 안전 검토와 통합 후 현장 담당자가 시험 공간과 비상 정지를 확보한다. 기체 전용 유선 NIC를 연결하고 Wi-Fi 인터넷은 유지한다. 다른 실기 조종 프로그램은 종료한다. 설치 담당자가 검토된 CPython 3.10 x86 환경에 `./apps/agent[setup,go2-readonly]`를 설치한다(추가 화면 의존성 `qrcode==8.2`, 연결 `websockets==15.0.1`). SDK·DDS wheel 고정값은 아래 설치 기록을 따른다.
2. 첫 실행에만 서버의 HTTPS 원점 주소를 지정한다. 토큰·UUID·승인 JSON·NIC 이름은 입력하지 않는다. 다음부터는 두 번째 명령만 실행한다.

   ```sh
   PYTHONPATH=apps/agent python -m foothold_agent.setup --server https://control.example.invalid
   # 이후 실행 (저장된 연결 사용)
   PYTHONPATH=apps/agent python -m foothold_agent.setup
   ```

   실제 실행은 DDS domain 0의 **읽기 구독**에 참가하므로 현장 실행 권한을 확인한 뒤 한다. 기본 화면은 `http://127.0.0.1:9611`에만 열린다. `--port`로 변경할 수 있으나 8453/8792/5190/5191/8870/9430은 거부한다. `--no-browser`는 자동 브라우저 열기만 생략한다. `--wheel-dir`는 기존 preflight wheel 보관 위치다.
3. 프로그램은 커널 메타데이터만 조회해 물리 유선 NIC 중 UP·기체 전용 `192.168.123.0/24` 주소·기본 경로 없음인 후보를 고른다. 네트워크 설정 변경·ping·ARP 스캔은 하지 않는다. 후보가 여럿이면 발견된 후보 중 `--nic`로 하나를 고른다. 기체 주소와 같은 호스트 주소, Wi-Fi·가상 NIC·다른 IPv4 대역과 공유하는 NIC는 거부한다.
4. 읽기 전용 DDS 두 구독자로 신선한 serial을 읽고, 노트북 화면의 기체번호·QR 또는 6자리 코드를 폰에서 확인한다. 로그인된 폰의 **+ 로봇 연결하기 → 새 로봇 추가 → 같은 기체번호 확인 → 이름 → 등록**을 진행한다. QR에는 `foothold-pair:<6자리>`만 있고 주소·비밀은 없다. 코드는 10분·1회용이다. 만료·이미 소비됨·신원 충돌은 재실행하여 새로 시작한다.
5. 토큰은 프로그램이 한 번 받아 `~/.config/foothold/agent.json`에 자동 저장한다. 파일은 소유자 일치·0600·정규 파일·단일 링크, 전용 폴더는 0700을 요구하며 symlink는 거부한다. 임시 파일을 fsync한 뒤 원자적으로 교체한다. `~/.config/foothold/go2-agent.env`는 **읽지도 고치지도 않는다**. `--config`는 별도 비공개 절대 경로를 쓰는 시험/복구용이다. 토큰은 화면·로그·명령줄·환경변수에 출력하지 않는다. 기존 연결의 serial과 현재 실측 serial이 다르면 저장된 연결을 덮지 않고 거부한다.
6. 기존 preflight가 자동 실행되고 노트북에 초록/빨강이 표시된다. 서버에는 기존 장치 상태의 **연결 프로그램 자동 점검** 항목(`go2-preflight`)으로 같은 판정을 보낸다. 점검 실패는 조종 SDK 생성을 막는다. 등록만 된 상태에서는 읽기 전용 구독만 있고 SportClient·Move·물리 STOP 객체가 없다. 읽기 전용의 논리 잠금은 물리 정지 확인이 아니다.
7. 폰에서 **현장 안전 확인**의 `space_clear`, `emergency_stop_ready`, `robot_verified`를 모두 확인한다. 서버의 유효한 `field_approval`을 받은 뒤 프로그램이 현재 NIC·실측 serial·최대 30분 만료를 기존 승인 JSON과 같은 검사로 확인하고 내부 승인 표식을 만든다. 그 뒤에만 조종 SDK를 만들며 **잠긴 상태**로 시작한다. 웹 STOP → 조종권 → 신선한 실측 정지 → 명시적 잠금 해제 → 새 중립 입력을 거쳐야 움직인다.
8. 만료·승인 해제·NIC/serial 충돌·WS 단절·서버 ping 끊김은 기존 STOP·잠금 후 읽기 전용으로 돌아간다. 같은 승인 재전송·재연결만으로 조종 모드가 복구되지 않는다. 사용한 승인 만료 시각을 비밀 없이 같은 0600 파일에 기록하므로 **프로그램을 다시 실행한 뒤에도 새 현장 안전 확인이 필요하다**. 새 승인이 와도 조종권·실측 정지·해제·중립 순서는 다시 필요하다.

**자동 연결 제한:** DDS serial이 `0-0`이면 «기체번호를 읽을 수 없는 기체 — 수동 절차»로 안내하고 새 흐름을 거부한다. MAC을 추측하거나 자동 예외를 만들지 않는다. 기존에 승인된 수동 시험 경로는 아래 접기를 참고하며, 새 흐름의 `0-0` 기체 연결은 미지원이다. NIC 또는 실제 serial 충돌 뒤에는 원인을 해결하고 프로그램을 다시 실행한다.

## 연결 해제 뒤 다시 연결

서버가 저장된 토큰을 거부하면(WS 4401/4403, HTTP 401/403) 노트북은 정지·잠금 후 **«이 노트북의 연결이 해제됨 → 다시 연결»**과 `--repair` 안내를 표시한다. 자동으로 QR을 새로 만들거나 재등록하지 않는다.

1. 프로그램을 Ctrl+C로 종료한다. 같은 기체·서버에 다시 연결할 때 아래처럼 **명시적으로** 실행한다. 저장 파일이나 옛 env 파일을 삭제·수정할 필요가 없다.

   ```sh
   PYTHONPATH=apps/agent python -m foothold_agent.setup --repair
   ```

2. 새 QR/6자리 코드를 담당 운영자의 폰에서 확인하고 같은 기체번호로 다시 연결한다. 서버의 확인 단계가 기존 토큰을 폐기한다. 노트북은 새 토큰을 한 번 받은 뒤에만 `agent.json`을 0600·소유자·단일 링크 검사와 원자 교체로 갱신하고 새 연결을 시작한다. 같은 로봇의 사용한 현장 승인 이력은 유지하므로 새 현장 안전 확인이 필요하다.
3. 취소·pairing 실패·저장 실패에는 파일을 미리 지우거나 옛 토큰으로 자동 복귀하지 않는다. 폰 확인으로 서버가 옛 토큰을 이미 폐기한 뒤 저장에 실패했다면 `--repair`를 다시 명시하여 새 코드를 받는다. 서버·실측 serial이 저장된 연결과 다르면 `--repair`에서도 거부한다.

서버 시계와 노트북 시계의 작은 차이를 위해 pairing 10분·서버 현장 승인 30분의 **상한 비교에만 30초 여유**를 둔다. 전달받은 만료 시각은 그대로 사용하며, 노트북 기준 이미 지났거나 정확히 만료된 시각은 계속 거부한다. 수동 승인 JSON의 기존 최대 30분 검사는 그대로다. 이 여유가 지난 승인에 유예 시간을 주거나 조종 입력의 0.30초 기준을 늘리지는 않는다.

## 유지되는 안전 경계

서버 경유 실기의 `cmd.axes`는 **SI 값 그대로**이며 아래 9개만 정확히 일치시킨다. 반올림·값 맞추기 없이 표 밖은 서버와 에이전트가 STOP·잠금하고 거절한다. 실기 폰 직결의 네 가지 명령은 (0, 0, 0)·(1.5, 0, 0)·(1.5, 0, ±0.5)이며 전진 상한만 0.6에서 1.5 m/s로 올렸다. 후진·옆걸음·제자리 회전은 직결에서 계속 닫히고, 원본 Core 기본 0.6 투영·STOP·시간초과·끊김·워치독 관문은 유지한다.

두 경로의 전진 1.5 m/s는 소프트웨어 허용 명령이며, Go2 펌웨어 수용과 실제 몸 속도 1.5 m/s는 실측하지 않았다.

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

에이전트는 기존 agent 토큰으로 **HTTP POST** `/api/v1/agent/drive-media/{rgb|lidar|depth}`에 `{header: media/1 JSON, points: null 또는 XYZ bytes의 base64}`를 올린다(본문 100,000 bytes 상한, 채널당 최대 5 Hz). 조종 WS 4096 bytes 제한과 배포 기동 인자는 유지한다. 웹은 같은 서버의 `/api/v1/robots/{robot_id}/drive-media/{rgb|lidar|depth}` WS에 기존 로그인 쿠키+정확한 Origin으로 접속해 받기만 한다(Bearer 앱 인증도 가능). hello·URL 토큰·조종 입력은 없다. `media.video` JSON, `media.points` JSON 직후 binary xyz_f32le, `media.status`는 기존 media/1 그대로다. robot/epoch/episode_id(null)를 확인하고 epoch 변경·1초 넘은 자료·끊김 때 이전 그림을 비운다. 담당자/총괄만 볼 수 있고 재배정·로그아웃·토큰 폐기 시 재확인하여 닫는다. 느린 viewer는 0.20초 쓰기 마감으로 끊으며 관측 오류가 조종 연결을 닫지 않는다.

움직임 SDK 객체 없이 상태만 서버로 올릴 때는 별도 **읽기 전용** 모드를 쓴다. `FH_GO2_DIRECT_ENABLED` 및 `FH_GO2_FIELD_APPROVAL`은 제거하고, robot UUID·agent 토큰·서버 WS 주소만 기존처럼 설정한 후 `--server --readonly --nic <ROBOT_NIC>`를 명시한다. 이 모드는 go2_readonly의 두 DDS 상태 구독자·DiscardSink를 사용하고 SportClient/Go2Sink/Move/StopMove/카메라 RPC를 만들지 않는다. 서버 cmd·lease·unlock·STOP은 모두 폐기하고 stop_ref=0을 유지하여 물리 정지 확인이나 조종권을 만들지 않는다. latched/applied는 논리 잠금·폐기 출력이며 **물리 STOP 확인이 아니다**. 이 명령 역시 실제 DDS 읽기 참가이므로 현장 읽기 승인이 있어야 한다. 읽기 모드에서는 RGB·라이다 송출을 하지 않으며 뎁스는 아래의 읽기 전용 DDS 경로로만 송출한다.

### 로봇 몸의 뎁스와 보이는 영상 목록

카메라가 로봇 확장 장치에 연결된 경우 노트북은 USB를 열지 않는다. 기존 go2-readonly가
기체 전용 NIC·domain 0으로 연 **동일한 DDS 참가자**를 재사용한다. 깊이 모듈은 새 참가자,
DataWriter·서비스 요청·움직임 명령을 만들지 않는다. 선택한 깊이 토픽 하나만 BestEffort·
Volatile·KeepLast(1)로 읽고, 발견 목록은 `DCPSPublication` 내장 발견 정보만 읽는다.
Unitree 고정 SDK의 비공개 participant 접근이 바뀌거나 depth 의존성이 없으면 영상만
사용 불가로 안내하고 조종 경로는 계속된다. 기존 SDK가 설치된 환경에 선택 묶음
`apps/agent[depth]`가 필요하며 이 변경은 installer에 설치 동작을 추가하지 않는다.

받는 형식은 `sensor_msgs::msg::dds_::Image_`의 `16UC1`(mm), `32FC1`(m),
또는 `CompressedImage_`의 `16UC1; png compressed`,
`16UC1; compressedDepth png`, `32FC1; compressedDepth png`다.
옛 `16UC1; compressedDepth`/`32FC1; compressedDepth` 표기도 실제 PNG 바이트일 때 받는다.
32FC1 compressedDepth는 12바이트 little-endian ConfigHeader의 역깊이 계수를 사용한다.
RGB/JPEG·모호한 mono 형식·RVL은 거부한다. 입력은 최대 1920×1080·8 MiB이며 PNG IHDR을
네이티브 decode 전에 확인한다. ROS wire sequence는 원본과 같은 unbounded 형으로
유지하므로 DDS 역직렬화 이전의 입력 메모리 상한을 보장하는 것은 아니다.

`depth`의 `media.video`, `source=go2_depth`, `episode_id=null`, `points=null`을 보낸다.
640×360·64 KiB·최대 5 Hz, header의 `depth_min_m`/`depth_max_m`에 색상 범위(m)를 적는다.
기본 0.2–5.0 m이며 가까움 빨강·멀리 파랑(TURBO 역방향), 양수 범위 밖은 끝 색,
0·음수·NaN·Inf는 검정이다. 이는 표시 색상 범위이며 카메라의 보장 측정 범위가 아니다.
`FH_GO2_DEPTH_MIN_M`/`FH_GO2_DEPTH_MAX_M`로 finite·0≤min<max≤10000 m를 지정할 수 있다.
captured_at은 노트북 수신 시각이다. 양수 sensor stamp의 중복/역행은 버리고, stamp가 0인
카메라는 노트북 수신 시각으로 신선도를 판단한다. 최신 프레임 하나만
보관하며 수신 후 1초가 지나면 NO_VIDEO다. DDS·변환·HTTP는 독립 daemon/업로드 worker에서
실행하며 종료 때 멈춘 코덱이나 DDS worker를 join하지 않는다.

연결 날 확인 순서(현재 실행 검증은 하지 않음):

1. 현장 읽기 승인 뒤 기존 연결 프로그램을 실행하고 `http://127.0.0.1:9611`의
   **보이는 영상 목록**을 본다. 목록에는 이름·DDS 형식만 있으며 비밀이나 영상 원물은 없다.
2. 목록이 비면 «로봇 쪽에서 뎁스 영상을 내보내지 않고 있습니다 — 확장 장치에서 카메라
   프로그램을 켜야 합니다»를 확인한다. NIC/domain 불일치로 발견하지 못한 경우도 확인한다.
   확장 장치 접속·설치·카메라 프로그램 실행은 현민님 승인 뒤 별도 작업이다.
3. 기본 후보는 ROS 이름 `/camera/depth/image_rect_raw`, `/camera/depth/image_raw`,
   `/camera/camera/depth/image_rect_raw`, `/camera/aligned_depth_to_color/image_raw`,
   `/depth/image_raw` 순이다. 이는 흔한 RealSense namespace/정렬 이름을 참고한 후보이지
   연결된 센서 모델의 증거가 아니다. 실제 발견된 지원 형만 고른다. 후보 외 depth 이름이
   하나면 자동 선택하고, 여러 개면 목록에서 **뎁스로 볼 영상 → 영상 선택**을 누른다.
   선택은 프로그램 메모리에만 남는다. `FH_GO2_DEPTH_TOPIC`은 ROS 절대 이름 또는
   발견 목록의 정확한 DDS 이름(`rt/...`)으로 고정할 수 있으며 미발견 시 다른 것으로 바꾸지 않는다.
4. **뎁스 영상 수신 중 · 0.2–5 m** 표시를 확인하고 담당자 로그인 웹·폰의 뎁스 보기를 고른다.
   수신 대기/형식 오류는 RGB로 대체하지 않는다. 다른 domain·DDS 보안·ROS 1·독점 카메라
   프로토콜만 내보내는 장치와 실제 카메라 모델·네트워크 수신·화면은 아직 미확인이다.

wire 필드 근거: ROS 2 공식 [Image](https://github.com/ros2/common_interfaces/blob/rolling/sensor_msgs/msg/Image.msg),
[CompressedImage](https://github.com/ros2/common_interfaces/blob/rolling/sensor_msgs/msg/CompressedImage.msg),
[Header](https://github.com/ros2/common_interfaces/blob/rolling/std_msgs/msg/Header.msg),
[Time](https://github.com/ros2/rcl_interfaces/blob/rolling/builtin_interfaces/msg/Time.msg)와
[ROS IDL 변환 틀](https://github.com/ros2/rosidl/blob/rolling/rosidl_adapter/rosidl_adapter/resource/msg.idl.em),
[DDS 타입 이름 변환](https://github.com/ros2/rosidl_dds/blob/rolling/rosidl_generator_dds_idl/resource/msg.idl.em).
압축 계수는 공식 [compressed_depth codec](https://github.com/ros-perception/image_transport_plugins/blob/rolling/compressed_depth_image_transport/src/codec.cpp),
후보 이름은 공식 [RealSense ROS README](https://github.com/realsenseai/realsense-ros#published-topics)를 참고했다.

코드 자동 검사 기록(2026-11-12, 기능 코드 `3a33142`; 실기·DDS 참가 실행 없음):

- `PYTHONPATH=apps/agent:. python -m pytest apps/agent/tests apps/contracts/tests -q`:
  2569 통과·3 생략. Node 22.23.2의 `NODE_OPTIONS=--input-type=commonjs-typescript`를 사용하고
  실행 프로세스의 `LD_LIBRARY_PATH`/`CYCLONEDDS_HOME`/`CYCLONEDDS_URI`를 제거했다.
  최종 뎁스·기존 관측 53개, 기존 camera 별도 묶음 22개도 통과했다.
- 공식 ROS 2 Jazzy 직렬화와 새 Image/CompressedImage의 CDR 바이트 비교 2개 통과:
  `FH_TEST_DEPTH_WIRE=1`, `PYTEST_DISABLE_PLUGIN_AUTOLOAD=1`과 설치된 ROS Python/library
  경로로 `test_depth_wire.py`만 실행했다. Cyclone Python 0.10.2/C 0.10.5를 사용한 오프라인
  비교이며 참가자·ROS 노드를 만들지 않았다. 일반 묶음의 생략 3개 중 2개는 이 선택 검사다.
- 서버 미디어 권한·상한·없는 채널·RGB/L1 회귀 33개 통과, 계약 `generate.py --check` 283개 일치.
- 서버 전체는 격리 PostgreSQL·시험 포트 범위에서 `pytest apps/server/tests -q -n 4`로 실행해
  1525 통과·23 실패·9 오류였다. 임의 UUID로 수집 ID가 달라지는 기존 `test_robots`의
  요약 2사례는 병렬 수집에서 제외하고 따로 실행해 모두 통과했다.
  실패/오류의 중복을 뺀 30사례 중 26개는 분리 실행에서 통과했다(가용성 1개는 첫 분리
  실패 뒤 추가 단독 실행 통과). **전체 서버 묶음이 한 번에 통과한 것은 아니다.**
- 남은 `test_sim_orphan_worlds`의 migration/sync 2사례, `test_sim_pairs`의 0027 복구,
  `test_site_purpose`의 migration roundtrip은 작업 전 `83dafea`의 별도 소스 사본에서도
  각각 실패했다. 과거 스키마로 내린 뒤 현재 API/ORM을 사용하는 기존 시험 문제로,
  이 작업에서 마이그레이션·기존 안전 시험 기대값을 바꾸지 않았다.

## 명시적 0-0 신원 예외 — 서버 시험만

LowState 실측 serial이 **정확히 `0-0`**인 기체에서만 현장 담당자의 선택으로 유선 이웃·MAC 확인을 사용한다. 기존 표식의 소유자·0600·단일 링크·최대 30분 만료는 유지하고, JSON에 `"robot_serial":null,"serial_unavailable":true,"robot_mac":"<현장에서 읽은 소문자 unicast MAC>"`을 모두 명시한다. 누락·다른 serial·MAC 불일치에는 적용하지 않으며 폰 경유는 이 예외를 허용하지 않는다. 생성기는 `deploy/jetson/make_approval.py --output <비공개 절대 경로> --nic <ROBOT_NIC> --serial-unavailable --robot-mac <실측 MAC> --approve-field-motion`이다. 실제 값은 저장소·공유 로그에 넣지 않는다.

시작 및 **매번 명시적 잠금 해제 직전** 지정 NIC의 `ip -j -4 neigh show dev`를 읽어 해당 기체 대역 이웃이 Go2 `.161`과 Orin `.18` 두 항목뿐인지, `.161` MAC이 표식과 일치하는지, 신선한 SDK serial이 여전히 `0-0`인지 확인한다. 제3 이웃·누락·FAILED/INCOMPLETE·다른 NIC·다른 serial은 거부/정지/잠금이다. 스캔·ping·ARP 갱신/삭제·추가 패킷은 만들지 않는다. 잠금 해제의 이웃 조회는 비동기 한 개만 진행하고, 도중 STOP·lease 상실·WS 단절·세대 변화·0.30초 초과가 있으면 폐기한다. 예외를 통과해도 기존 실측 정지·명시 해제·새 중립 및 기본 **error_code==0** readiness 관문은 유지하며 아래의 명시적 운동 상태 목록만 서버 시험에서 추가로 허용할 수 있다.

로컬 관리 비트가 켜진 MAC은 기체 재부팅 뒤 바뀔 수 있다. 바뀌면 거부되는 것이 정상이며 현장에서 다시 읽고 새 표식을 만든다. 옛 MAC을 자동 수용하거나 serial 검사를 생략하지 않는다. 실제 이 예외로 이동하는 시험은 아직 하지 않았다.


## 확인된 V2 운동 상태 허용 — 기본 빈 목록

현장 사용자가 제공한 Unitree V2 문서에 따르면 해당 펌웨어판의 `SportModeState.error_code`는 현재 운동 상태 번호이며 **100=Agile(灵动)**이다. 근거: [Unitree Motion Services Interface V2.0](https://support.unitree.com/home/en/developer/Motion_Services_Interface_V2.0) — 현장 사용자 제공, JS 페이지 본문 대조는 미확인이다. V2에서는 0이 아닌 값이 상태 번호일 수 있으므로 확인된 정수만 목록에 적는다.

서버 경유 시험에만 `FH_GO2_ACCEPT_ERROR_CODES=<확인된 상태 번호의 쉼표 목록>`과 승인 JSON의 `"accept_error_codes":[<같은 정수 목록>]`이 정확히 같은 집합일 때 활성화한다. 기본은 둘 다 빈 목록, 0은 항상 허용, 목록 밖 값은 계속 거부한다. 시작 로그에 `서버 시험 운동 상태 허용: 100(Agile)`처럼 선택한 상태를 한 줄로 남긴다. 폰 경유와 읽기 전용 모드의 조종 권한에는 영향이 없다. 신선한 실측 정지·기존 mode/progress/높이/자세 조건·serial/MAC·명시 해제·새 중립·0.30초는 유지한다. 기본 보행 장치는 같은 허용 기준으로 `state=OK`, 선택 `status_code.level=ACCEPTED`를 보고하며 원시 코드와 허용 사유를 보존한다. 허용 목록 밖 nonzero는 기존 ERROR이며, 다른 readiness 관문은 그대로다. 잠금 해제 거절은 선택 `unlock_refused`로 보고하고 정지 판정을 막은 축의 값·기준·단위를 포함한다(계약 README 참조).

현장 담당자가 각각 실측값을 채우는 표식 생성 예: `deploy/jetson/make_approval.py --output <비공개 절대 경로> --nic <ROBOT_NIC> --serial-unavailable --robot-mac <실측 MAC> --accept-error-codes <확인된 상태 번호> --approve-field-motion`. 서버 경유 환경의 `FH_GO2_ACCEPT_ERROR_CODES`에도 동일한 정수 목록을 넣는다. 일반 serial이 확인되는 기체는 `--serial <실측 serial>`을 쓰며 0-0 예외를 적용하지 않는다.

기존 관측 소스는 앞 카메라의 SDK VideoClient **RGB JPEG**와 `rt/utlidar/cloud`의 L1 점군이다. 로봇 몸의 별도 카메라는 위 DDS 경로에서 실제 깊이 자료를 받은 때만 뎁스로 표시하며, 미발견·형식 오류·끊김 때 RGB를 뎁스로 표시하지 않는다.


서버 경유 이동 표는 현장 사용자 선택으로 전후·좌우 **1.5 m/s**, 회전 **0.5 rad/s**다. 고정 SDK의 SportClient.Move는 vx/vy/vyaw를 JSON으로 직렬화해 _CallNoReply로 보내며 자체 범위 검사/클램프가 없다. 따라서 SDK Python 코드가 vy=1.5를 직접 거부하는 경로는 없지만, 반환0은 펌웨어의 실제 수용·속도·클램프를 보장하지 않는다. 펌웨어 수용 범위와 실기1.5 m/s는 미검증이다. 폰 경로의 기존 표/limits는 유지한다.

## 문제 생겼을 때

<details>
<summary>옛 수동 시험 순서와 0-0/MAC 예외 복구 참고</summary>

아래는 이전 시험 절차의 보관본이다. 새 서버에서는 총괄의 실기 등록·토큰 발급 경로가 닫히므로 **옛 2번을 새 등록에 사용하지 않는다**. 자동 프로그램의 0-0 연결은 미지원이며, 기존 등록·유효한 비공개 자격과 별도 현장 승인으로 허용된 옛 수동 시험만 기존 경로를 유지한다. 토큰 폐기·연결 끊기 이후 옛 토큰을 재사용하지 않는다. 운영의 pairing/현장 승인과 서버 전체 스위치를 생략하는 우회 절차가 아니다.

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

</details>

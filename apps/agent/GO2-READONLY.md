# Go2 EDU 상태 전용 실행기

금요일 범위는 상태 읽기다. 이 실행기는 `rt/lowstate`와 `rt/sportmodestate`만 구독한다.
이동·자세·모드 변경, 정지 요청조차 보내지 않는다. 별도 프로세스에서 실행하며 기존
`ros_bridge`, phone hub, safety Core, server link를 생성하지 않는다. 기존 `/phone/ws` 인증과
출입증 경로는 별개다. 이 경로에서 조종·잠금 해제·STOP 검증이 됐다고 표시하면 안 된다.

## 실행 위치와 의존성

기본 권장은 **미리 준비한 Linux x86_64 노트북, CPython 3.10, Ethernet 연결**이다.
Jetson은 Python>=3.10, 실제 NIC, 호환 wheel을 확인한 경우 대안이다. Python 3.8에서 실행할
수 없으며 OS/Python을 현장에서 바꾸지 않는다. Go2 AP의 인터넷 유무는 로컬 상태 수신과 무관하지만
폰에서 실행 호스트로 라우팅되고, 검색하려면 같은 L2망에서 mDNS가 전달돼야 한다.

선택한 경로는 `unitree_sdk2_python`이다. ROS 2 배포판/데몬 없이 공식 lowstate 예제와 같은
DDS domain 0 / 지정 NIC 구독을 사용할 수 있어 준비 단계가 짧다.
[공식 읽기 예제](https://github.com/unitreerobotics/unitree_sdk2_python/blob/814556d15970dd2ecf1c9984e845ca02ab07e206/unitree_sdk2py/test/lowlevel/read_lowstate.py),
[SDK channel 구현](https://github.com/unitreerobotics/unitree_sdk2_python/blob/814556d15970dd2ecf1c9984e845ca02ab07e206/unitree_sdk2py/core/channel.py).
`unitree_ros2`도 상태를 읽을 수 있으나 별도 ROS 배포판·메시지 빌드·DDS 설정이 필요하다.
[공식 ROS 2 연결 안내](https://github.com/unitreerobotics/unitree_ros2#connect-to-unitree-robot)의
노트북 유선 예는 `192.168.123.99/24`다. 주소 충돌 여부와 NIC는 현장에서 확인한다.

`[go2-readonly]` extra는 SDK Git 커밋 `814556d15970dd2ecf1c9984e845ca02ab07e206`
(배포 이름 `unitree_sdk2py`, 버전 1.0.1), `cyclonedds==0.10.2`, SDK의 전이 요구인
`numpy==1.26.4`, `opencv-python==4.10.0.84`를 고정한다.
[공식 setup.py](https://github.com/unitreerobotics/unitree_sdk2_python/blob/814556d15970dd2ecf1c9984e845ca02ab07e206/setup.py).
광고는 별도 `[discovery]` extra (`zeroconf==0.148.0`)다. 기본 설치는 SDK/ROS를 요구하지 않는다.
[CycloneDDS 0.10.2 파일 목록](https://pypi.org/project/cyclonedds/0.10.2/#files)에서
Linux cp310 x86_64 wheel은 있지만 aarch64 wheel은 없다(2026-10-28 확인).
Jetson용은 호환 환경에서 사전에 빌드·검증해야 하며 현장 설치 성공을 보장하지 않는다.

## 현장 실행

준비된 venv에서만 설치한다. 아래 실행 명령은 현장 담당자가 현장에서만 사용한다.

```sh
# 인터넷이 있는 준비 환경에서만; 현장 오프라인 번들 절차는 별도 순서표 참조
.venv-go2/bin/python -m pip install './apps/agent[go2-readonly,discovery]'
# 2단계: NIC 이름 확인. 아래 <...>는 실제 값으로 치환한다.
ip -br link
# 주소 중복을 담당자가 확인한 뒤 임시 주소 추가. sudo 두 명령은 현민님이 현장에서 직접 입력한다.
sudo ip addr add 192.168.123.99/24 dev <ROBOT_NIC>
ip -br -4 addr show dev <ROBOT_NIC>
# 1. 노트북 유선 연결과 NIC 설정 후, 로컬 콘솔에서 실제 상태 먼저 확인
PYTHONPATH=apps/agent .venv-go2/bin/python -m foothold_agent.go2_readonly --nic <ROBOT_NIC>
# 2. Ctrl-C 후 폰이 도달하는 이 호스트의 IPv4로 다시 실행, 광고
ip -br -4 addr # 5단계: 폰과 같은 망의 IPv4 확인 → --listen
PYTHONPATH=apps/agent .venv-go2/bin/python -m foothold_agent.go2_readonly \
  --nic <ROBOT_NIC> --listen <PHONE_LAN_LOCAL_IPV4> --advertise
# 8단계: Ctrl-C로 실행기 종료 후, 직접 추가한 임시 주소만 원복(현민님 직접 입력)
sudo ip addr del 192.168.123.99/24 dev <ROBOT_NIC>
```

NIC가 DOWN이면 현장 담당자가 설정 앱에서 유선 연결을 활성화한다. 기존 주소를 지우거나
`ip addr flush`하지 않는다. 주소가 이미 설정돼 있다면 add/del을 모두 생략한다.

실행은 **실제 domain 0 참가와 DDS discovery 통신**을 시작한다. 명령 데이터 writer가 없어도
DDS discovery/프로토콜 패킷은 송신된다. 명시된 현장 승인 절차 이후에만 실행한다.
`--help`와 모듈 import는 SDK를 import하거나 네트워크를 열지 않는다.
기본 HTTP는 `127.0.0.1:9610`, 기본 mDNS는 꺼짐. 원격 노출은 구체적인 IPv4를 지정해야 한다.
`--nic`는 DDS 망, `--listen`은 폰 망이다. 두 NIC가 달라도 되며 라우팅을 자동 변경하지 않는다.
현장 노트북은 유선으로 DDS를 구독하면서 Wi-Fi로 폰과 같은 서브넷에 동시에 연결한다.
폰 앱의 같은 서브넷 제한에 맞춰 HTTP 바인딩과 mDNS 주소는 **Wi-Fi IPv4**를 사용한다.
유선 로봇 주소나 loopback 주소를 폰에게 광고하지 않는다.
`ip -4 addr show dev <PHONE_WIFI_NIC>`의 주소/접두사와 폰 Wi-Fi 연결 상세의 IP/마스크를
비교한다(/24이면 앞 세 옥텟이 같아야 함). 다른 서브넷이면 같은 현장 허용 Wi-Fi로 맞춘다.
`--rid <확인한 UUID>`는 선택 사항이며 서버에 등록하지 않는다. 주소만으로 기체 식별을 단정하지 않는다.
`--advertise`는 명시적인 광고 요청이며 기존 phone listener의 환경 변수와 별개다.
기본 JSON 출력은 꺼져 있어 현장 코드가 화면에 남는다. 상태는 별도 터미널에서
코드를 입력해 조회한다(아래 명령의 코드는 셸 기록에 남지 않는다).

```sh
read -rs -p 'Field code: ' GO2_CODE; printf '\n'
curl -sS -H "X-Foothold-Code: $GO2_CODE" http://127.0.0.1:9610/go2/status
unset GO2_CODE
```

폰 공개 후 노트북에서 조회할 때는 URL의 `127.0.0.1`을 `--listen`에 준 IPv4로 바꾼다.
진단용 `--json`을 지정하면 1초마다 상태를 출력한다. **tee·출력 리다이렉션·터미널 녹화 금지**:
시작 출력에 현장 코드가 포함된다. 코드가 밀려났으면 스크롤로 확인하거나 재시작해 갱신한다.
SDK channel factory는 singleton이므로 다른 SDK 앱에 import해 합쳐 실행하지 않는다.
Ctrl-C는 구독/HTTP/광고를 정리하고 종료하며 기체에 정지 명령을 보내지 않는다.

## 상태·신선도 계약

응답은 `v=1`, `kind=go2-readonly`, `read_only=true`, `motion_enabled=false`, `gate=READ_ONLY`다.
`ONLINE`은 두 토픽의 수용된 샘플이 모두 2초 이내라는 뜻이다. 하나만 수신하거나 2초를 넘으면
`STALE`, 최초 수신 전 또는 두 토픽 모두 10초를 넘으면 `OFFLINE`이다. 경계값은 각각 `<=2`, `>10`.
신선하지 않은 토픽의 측정값은 즉시 `null`; 마지막 값으로 채우지 않는다.
한 토픽만 계속 수신하면 `STALE`이며 다른 토픽의 값을 숨긴다.

| 필드 | 원천 / 의미 |
|---|---|
| `battery.soc` | lowstate `bms_state.soc`, 0~100 %; 0도 유효 |
| `battery.voltage` | lowstate `power_v`, V; 0/비정상/미제공은 null |
| `attitude.roll/pitch` | lowstate `imu_state.rpy[0:2]`, rad, -π~π |
| `mode` | sportmodestate `mode` 원시 uint8; firmware 의미 미확인, 보행 허가 아님 |
| `error_code` | sportmodestate 원시 uint32, 실제 firmware 의미 미확인 |
| `fallen` | roll 또는 pitch 절댓값 >=π/3인 **기울기 추정**; 판단 불가하면 null |
| `fallen_source` | `imu_tilt_estimate`; 공식 낙상 플래그나 안전 Core 입력 아님 |
| `sources.*` | 각 토픽의 fresh, age_s, received_at(UTC 호스트 수신 시각) |
| `last_received_at` | 마지막으로 수용한 샘플의 호스트 시각; 기체 시각·서버 동기화 보장 아님 |

신선도는 호스트 monotonic으로 계산한다. lowstate tick의 동일/역행 샘플은 갱신하지 않는다
(uint32 wrap만 허용). sport stamp가 미설정·0·고정인 firmware는 별개로 수신한 메시지의
도착 시각을 사용한다. 동일한 객체 재전달(내용 변이 포함)이나 유효 stamp 역행은 갱신하지 않는다.
고정 stamp의 신선도는 수신 지속만 뜻하며 기체 내부 측정 시각의 진행·재전송 부재를 보장하지 않는다.
기체 재부팅 등 시계 초기화 뒤에는 실행기를
재시작하고 기체를 다시 대조한다. 기체 원본 stamp의 wall-clock 비교나 가짜 0 pose는 사용하지 않는다.
실제 기체가 두 토픽을 제공하는지, battery/IMU/모드 의미와 값이 맞는지는 현장 미검증이다.

## 폰의 로컬 HTTP 계약

서버 등록·인터넷·출입증 없이 `GET /go2/status`만 제공한다. 시작 때 콘솔에 나타나는 8자리
현장 코드를 사람이 폰에 입력하고, 매 요청의 `X-Foothold-Code` 헤더에 전달한다.
코드는 프로세스마다 새로 생성되며 30분에 만료된다. 재시작하면 갱신된다. URL·TXT·로그에 넣지 않는다.
코드가 없거나 틀리거나 만료되면 401, 60초 동안 전체 5회 실패하면 429(`Retry-After: 60`).
요청 성공은 제한 카운트를 초기화하지 않는다. `/phone/ws`·임의 경로는 404, 변경 메서드는 405다.
모든 응답은 `Cache-Control: no-store`, CORS 허용 없음. HTTP는 암호화되지 않으므로
현장 담당자가 허용한 로컬 망에서만 사용한다. 같은 망의 도청자에게 코드·상태가 노출될 수 있다.
짝짓기는 계정 인증이나 기체 신원 증명, TLS 대체가 아니다.

공개되는 mDNS TXT는 `v/name/model/agent/mode`, 확인한 UUID를 지정한 경우만 `rid`다.
`mode=go2-readonly`, `agent=http://<IPv4>:9610/go2/status`로 기존 `ws://…/phone/ws`와 구분한다.
코드 없이 공개되는 정보는 이름·모델·상태 서비스의 주소뿐이며 배터리·자세·모드는 인증 후에만 준다.
현재 폰 구현이 이 mode/HTTP를 지원하는지는 별도 작업에서 확인해야 한다.
지원하지 않는 앱은 후보를 상태 전용 미지원으로 표시하고 기존 조종 흐름으로 보내면 안 된다.

폰은 약 1초 간격으로 요청(3초 timeout)하며 유효 응답 뒤 로컬 monotonic으로 다시 감시한다.
앱 수신 후 2초간 유효 응답이 없으면 STALE, 10초를 넘으면 OFFLINE으로 내리고 측정값을 지운다.
서버 `connection`과 폰 수신 감시 중 더 보수적인 상태를 표시한다. 401/429도 ONLINE을 유지할 근거가 아니다.
ONLINE 문구는 «온라인 · 상태 전용», `fallen=true`는 «기울기 큼(낙상 추정)»처럼 표시한다.
조종·자세 변경·모드 변경 버튼, 자동 서버 등록, camera/명령 URL은 이 계약에 없다.

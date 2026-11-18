# Jetson 내부 실행 준비 — 조종 차단, ARM 검증은 후속

기준: `dev`의 `7ed28d5`, 장비 공유 사실 2026-11-18. 이 문서는 **설치 준비 절차**다.
이 PR에서 Jetson 접속·SSH·설치·DDS 참가·실기 명령은 실행하지 않았다.
노트북에서 통과한 pytest를 ARM 설치나 실기 검증으로 간주하지 않는다.

대상은 Go2 X의 확장 컴퓨터 Jetson Orin NX 16GB, Ubuntu 22.04.5,
L4T R36.4.7, aarch64, 현재 전력모드 15W다. 현민님이 별도로 수행한 읽기 전용
확인 결과 Python은 **3.10.12**다. 이 작업자가 Jetson에 접속한 결과는 아니다.
JetPack 판은 **미확인**이다.
유선 `enP8p1s0`는 Go2 내부망, Wi-Fi는 DHCP로 서버에 연결한다.
현민님 확인에서 유선 링크는 1000Mbps이며 Go2 몸체가 응답했다.
`/opt/ros/humble`은 있으나 대상 Python의 cyclonedds·unitree_sdk2py와
dpkg의 cyclonedds·unitree 패키지는 없었다. ROS Humble의 DDS를 재사용할 수 있는지는
**미확인**이며 이 문서는 ROS 환경을 source하거나 설치를 바꾸지 않는다.
팀원 인수 측정 중이므로 firmware·JetPack·librealsense·시스템 패키지·전력모드를 바꾸지 않는다.

## 조사 결과

| 항목 | 코드·배포 메타데이터로 확인한 것 | Jetson에서 남은 확인 |
|---|---|---|
| Python | `pyproject.toml`은 3.10 이상, 현재 Linux 조종 설치 검증은 정확히 CPython 3.10. 현민님 대상 확인은 3.10.12 | SOABI, venv/ensurepip 유무 |
| Unitree SDK | 고정 소스 `814556d15970dd2ecf1c9984e845ca02ab07e206`, 배포판 1.0.1, Python 3.8 이상; Python 소스 wheel 생성 경로가 있음 | 대상 설치·native 의존성·Go2 호환성 **미확인** |
| Cyclone DDS | 0.10.2 고정. PyPI에 Linux aarch64 wheel이 없음. macOS arm64 wheel은 Linux용이 아님 | ARM 소스 빌드·wheel 및 공유 라이브러리 공급 **미확인/차단** |
| 나머지 | NumPy 1.26.4, OpenCV 4.10.0.84, websockets 15.0.1, zeroconf 0.148.0의 CPython 3.10 호환 Linux aarch64 wheel이 게시됨. qrcode 8.2는 범용 Python wheel | 실제 로딩·OpenCV의 외부 GL 등 의존성·CPU 부담 **미확인** |
| NIC | `setup/discovery.py`와 `desktop/network.py`는 `enx*` 접두사를 요구하지 않음. `go2_direct/identity.py`도 전달받은 NIC 이름을 사용 | 실제 주소·기본 경로·물리 유선 여부·기체 이웃 정보 |
| 화면 | `setup --headless`는 기존 `--no-browser`와 같은 옵션. DISPLAY·창·desktop 세션 없이 실행하며 상태·등록·기체 확인은 loopback 화면에 유지 | 별도 승인된 화면 접근 방법, 재시작 때 사람 확인 절차 |
| 설치 파일 | 기존 DEB는 amd64용 Python·wheel·도구를 포함. Jetson에 복사할 수 없음 | 아래 별도 사용자 폴더 묶음 사용; 실제 설치 **미확인** |

출처: [고정 SDK setup.py](https://github.com/unitreerobotics/unitree_sdk2_python/blob/814556d15970dd2ecf1c9984e845ca02ab07e206/setup.py),
[Cyclone DDS 0.10.2 파일 목록](https://pypi.org/project/cyclonedds/0.10.2/#files),
[NumPy](https://pypi.org/project/numpy/1.26.4/#files),
[OpenCV](https://pypi.org/project/opencv-python/4.10.0.84/#files),
[websockets](https://pypi.org/project/websockets/15.0.1/#files),
[zeroconf](https://pypi.org/project/zeroconf/0.148.0/#files),
[qrcode](https://pypi.org/project/qrcode/8.2/#files). wheel 게시와 대상에서의 설치 성공은 별개다.

## 유선 선택과 화면 없는 실행

설치 설정 `connection.json`의 `nic` 기본값은 `enP8p1s0`다. `auto`를 지정하면
기존 자동 탐지에서 **유일한 후보**를 선택한다. 후보가 여러 개거나 없으면 거부한다.
탐지는 로컬 커널 주소·경로와 sysfs만 읽으며 ping·ARP 스캔을 하지 않는다.
Go2 내부 대역만 가진 UP 상태의 물리 유선, Wi-Fi 아님, 기본 경로 아님이라는
기존 조건을 유지한다. 몸체 이웃 정보가 필요한 경우 기존 identity 검사가 이어진다.

**기존 Jetson 주소가 반드시 후보인 것은 아니다.** 노트북용 규칙은 몸체와 확장 컴퓨터의
예약 주소를 로컬 주소로 쓰는 NIC를 거부한다(`setup/discovery.py`의 두 예약 주소).
Jetson이 이 주소를 이미 사용하거나 다른 대역·기본 경로를 함께 쓰면 `--nic`로도
우회할 수 없다. 장비 주소를 임의 변경하지 말고 팀원과 별도 검토한다.
이 PR은 NIC의 이름·주소·라우팅·NetworkManager 프로필을 바꾸지 않는다.

새 설치는 `foothold_agent.desktop` 대신 `foothold_agent.setup --headless`를 실행하므로
브라우저 앱 창·GUI 잠금·로그인 자동 실행·NetworkManager/Polkit 설정 화면이 필요 없다.
상태 화면은 전용 loopback 포트 9468에만 바인딩한다. 보호 포트는 새 installer에서 거부한다.
Wi-Fi에 상태 화면을 공개하거나 인증·Host/Origin 검사를 풀지 않는다.

화면이 없는 장치의 최초 등록에는 담당자가 승인한 **loopback 화면 접근 수단**이 여전히
필요하다. 임시 로컬 화면 또는 별도로 승인된 loopback 전달을 준비하되 이 문서는
SSH·터널·cloudflared 설정을 실행하거나 제공하지 않는다. 등록 코드는 화면에만 있고
서비스 로그에 새로 출력하지 않는다. 기체번호가 없는 로봇은 **매 실행 시** 기존
«이 로봇 맞음» 확인이 필요하다. 저장된 인증 정보로 이 확인을 자동 승인하지 않는다.
따라서 현재는 화면 없는 완전 무인 시작을 보장하지 않는다.

## 설치 준비 묶음 만들기 — 준비 PC에서만

완성 ARM DDS wheel을 확보하기 전에는 **설치 가능한 완성 묶음이 없다**.
아래 다운로드/설치는 향후 담당자의 설치 승인과 ABI·출처 검토 뒤 수행한다.
이번 작업자는 코드·문서·가짜 설치 시험만 실행한다.

기존 `deploy/jetson/build_wheelhouse.py`를 재사용하는
`installer/build_jetson_wheelhouse.py`는 `qrcode==8.2`까지 포함한다.
기본은 계획만 출력하며 다운로드하지 않는다. 준비 PC의 기존 Python 3.12,
pip/setuptools/wheel/readelf가 필요하다. 도구가 없으면 여기서 멈춘다.
검토된 정확한 커밋을 checkout한 저장소에서 실행한다.

```sh
python3 apps/agent/installer/build_jetson_wheelhouse.py \
  --output ./runs/jetson-onboard-new --python-version 3.10

# 아래 두 값은 후속 ARM 빌드·검토 산출물로 채운다. 실제 값을 Git에 넣지 않는다.
python3 apps/agent/installer/build_jetson_wheelhouse.py \
  --output ./runs/jetson-onboard-new --python-version 3.10 \
  --cyclonedds-wheel '<검토한 ARM64 wheel 경로>' \
  --cyclonedds-sha256 '<검토한 SHA256>' --download
```

`INCOMPLETE`가 있거나 명령이 실패하면 설치하지 않는다. 완성 wheelhouse는
모든 전이 의존성·qrcode·agent·SDK·DDS wheel, 해시 고정 requirements,
SHA256SUMS, PROVENANCE를 포함해야 한다. SDK와 agent 버전만 같다고 소스가 같지는
않다. PROVENANCE의 정확한 agent/SDK 소스 커밋과 모든 wheel 해시를 대조한다.
표적 ABI용 wheel을 x86 wheel로 대체하거나 manylinux로 재명명하지 않는다.

검토한 커밋에서 소스 설치 도구 묶음을 별도로 만든다. `HEAD` 대신 검토한 정확한
커밋을 지정할 수도 있다. `git archive`는 추적 소스만 포함하며 venv·키·로컬 자료는 넣지 않는다.

```sh
git archive --format=tar.gz --prefix=foothold-jetson-source/ \
  --output=/tmp/foothold-jetson-source.tar.gz HEAD \
  apps/agent deploy/jetson/install_offline.py deploy/jetson/preflight.py
sha256sum /tmp/foothold-jetson-source.tar.gz
```

이 소스 묶음과 **별도 검토된 완성 wheelhouse**를 담당자가 전달한다. wheelhouse와
소스 묶음의 agent 커밋이 같아야 한다. 압축·wheel·빌드 로그는 커밋하지 않는다.
로컬에서 빌드한 SDK wheel을 설치하면 `direct_url.json`의 VCS 커밋이 자동 기록되지
않을 수 있다. 현재 preflight의 `sdk-source-commit-unverified`를 피하려고 메타데이터를
꾸며 넣지 않는다. 후속 게이트에서 승인된 SDK wheel 해시·소스 출처와 실제 설치 내용의
일치를 검증할 방법까지 함께 검토한다.

## 사용자 폴더 설치 — 아직 실행하지 않은 현장 절차

대상 장치의 일반 사용자로만 수행한다. 시스템 Python·기존 SDK·다른 venv를 덮지 않는다.
사용자 홈의 아직 없는 `~/foothold-robot`와 아직 없는
`~/.config/systemd/user/foothold-jetson.service`를 사용한다.
시스템 패키지·sudo 없이, 로컬 해시 고정 wheel만 설치한다. 기존 경로는 거부한다.

압축을 푼 `foothold-jetson-source` 디렉터리에서, 실제 서버 HTTPS 원점은 명령 실행 때만
입력한다. 예시 주소는 연결 대상이 아니다. 토큰·비밀번호를 인자로 넣지 않는다.

```sh
# 기본은 해시·설정·기존 경로 검사만 수행하며 아무 파일도 만들지 않는다.
python3 apps/agent/installer/jetson_onboard.py \
  --wheelhouse '<완성 wheelhouse의 절대 경로>' \
  --server https://example.invalid --nic enP8p1s0

# ABI·출처 검토와 설치 승인이 끝난 대상에서만 --install 추가
python3 apps/agent/installer/jetson_onboard.py \
  --wheelhouse '<완성 wheelhouse의 절대 경로>' \
  --server https://example.invalid --nic enP8p1s0 --install
```

기존 `install_offline.py`가 `venv`를 만들고 binary-only·no-index·require-hashes로
설치 후 `pip check`한다. Python 3.10/aarch64/Linux가 아니면 실제 설치는 거부한다.
ensurepip/venv, 개발 헤더 또는 외부 공유 라이브러리가 없으면 **시스템 패키지를
설치하지 말고 중단**한다. 실패한 새 부분 설치 폴더는 검사할 수 있도록 보존한다.

결과는 `venv/`, `wheels/`, `launch.py`, `connection.json`, `private/`, `cache/`다.
인증 파일은 생성하지 않으며 디렉터리 0700·설정 0600, 서비스 UMask 0077을 사용한다.
소스의 `setup/storage.py`에서 형식을 확인했다. 이 PC의 `~/.config/foothold/`는
읽지 않았다. 새 launcher도 그 경로를 사용하지 않는다.

unit은 `[Install]` 없이 수동 시작 전용(static), `Restart=no`, GUI 종속성 없음이다.
installer는 daemon-reload/start/enable·linger를 실행하지 않는다.
로그인·부팅 자동 시작은 기본 꺼짐이며 자동 재시작도 없다.
측정 간섭과 자료 생성을 줄이기 위해 새 launcher에서 기존 `FH_RECORD=0` 설정을 쓴다.
영상·뎁스 관측과 DDS 부하는 남으므로 실제 CPU 부담이 0이라는 뜻은 아니다.

## 시작·새 인증 발급·측정과 겹칠 때 끄기

아래 서비스 명령도 **향후 해당 Jetson에서 담당자가 승인한 시간에만** 수행한다.
이 PC의 `foothold-robot.service`에는 적용하지 않는다.

```sh
systemctl --user daemon-reload
systemctl --user is-enabled foothold-jetson.service   # static 예상, 자동 시작 아님

# 다음 명령부터는 DDS 참가가 생기므로 팀원의 실행 시간·동시 사용 승인 뒤에만 실행
systemctl --user start foothold-jetson.service
systemctl --user status foothold-jetson.service
```

서비스 start 성공은 설치·DDS·조종 검증 통과가 아니다. loopback 화면의 자동 점검과
연결 상태를 확인한다. Jetson에서는 기존 preflight가 `installation_ready=False`를
유지하며 «조종 차단 · 이 컴퓨터용 로봇 통신 프로그램은 아직 검증되지 않았습니다»를 표시한다.
ARM SDK 로딩 실패 또는 NIC 거부로 그보다 앞에서 연결이 끝날 수도 있다.

Jetson 전용 등록 코드를 사용해 웹의 새 로봇 추가/승인된 기기 교체 절차를 진행하고
**새 인증 정보**를 발급한다. 노트북 `agent.json`·토큰·승인 기록·UUID를 복사하지 않는다.
같은 기체가 이미 등록되어 있으면 중복 등록/연결 교체 정책을 서버 담당자와 맞추고,
등록 충돌을 피하려고 기체 신원을 바꾸지 않는다. 이 PR은 서버 정책을 바꾸지 않는다.

인증 정보는 `~/foothold-robot/private/agent.json`에 기존 원자 저장 코드로 기록된다.
`robot_id`, `robot_serial`, `agent_token`, `agent_ws_url`, 승인 이력과 선택적 MAC 신원
필드를 코드가 검증한다. 직접 JSON을 만들거나 토큰을 로그·Git·보고서에 복사하지 않는다.
재발급은 서비스를 멈춘 뒤 승인된 등록 절차에서 setup의 기존 `--repair`를 사용하고,
등록 성공 뒤에만 새 토큰이 저장되는 기존 동작을 유지한다.

```sh
# 기존 Jetson 키가 있을 때의 명시적 재등록. 서버 주소는 저장된 Jetson 키에서 복원한다.
systemctl --user stop foothold-jetson.service
FH_RECORD=0 FH_MAPPING_CACHE_DIR="$HOME/foothold-robot/cache/mapping" \
  XDG_CACHE_HOME="$HOME/foothold-robot/cache" \
"$HOME/foothold-robot/venv/bin/python" -I -m foothold_agent.setup --headless --repair \
  --nic enP8p1s0 --port 9468 --config "$HOME/foothold-robot/private/agent.json" \
  --wheel-dir "$HOME/foothold-robot/wheels"
```

위 foreground 재등록은 DDS를 시작하므로 같은 실행 승인이 필요하다.
등록을 마친 뒤 Ctrl+C로 foreground 실행을 끝내고 필요할 때 unit을 수동 시작한다.

팀원 측정과 겹치면 담당자가 아래 **Jetson unit만** 멈추고 inactive를 확인한다.

```sh
systemctl --user stop foothold-jetson.service
systemctl --user is-active foothold-jetson.service  # inactive 예상; 종료 코드가 0이 아닐 수 있음
```

종료는 기존 SIGTERM/STOP 정리 경로를 그대로 사용한다. 프로세스 종료가 물리 정지를
증명하지는 않으므로 현장 담당자가 독립 정지 수단으로 확인한다. DDS 동시 실행과
조이스틱·앱 명령 우선은 실기 승인 전 팀원과 합의한다. `/lowcmd`는 송신하지 않으며
현재 sport 고수준 경로, STOP·끊김·조종권·속도 한도·조종 허용 조건을 변경하지 않았다.

## 완전 되돌리기

아래는 기본 설치 경로 전용이다. `--root`를 바꿨다면 확인한 그 경로만 지운다.
먼저 웹에서 Jetson 기기의 인증을 회수한다. 폴더 삭제만으로 서버 토큰이 폐기되지는 않는다.
측정 자료가 있으면 팀원과 보관 여부를 먼저 확인한다. 사용자 unit·폴더 이외의 서비스,
시스템 라이브러리·기존 키·노트북 설치는 지우지 않는다.

```sh
systemctl --user stop foothold-jetson.service
systemctl --user reset-failed foothold-jetson.service
rm -- "$HOME/.config/systemd/user/foothold-jetson.service"
systemctl --user daemon-reload
rm -r -- "$HOME/foothold-robot"
```

등록 전 실패했다면 토큰 회수는 불필요하다. 설치 도중 실패해 unit이 없으면 unit 삭제와
reset-failed는 생략한다. 별도로 받은 소스/완성 wheelhouse 압축과 아래 사용자 DDS 빌드
폴더도 담당자가 위치를 확인한 뒤 삭제한다. 이 설치는 enable·linger·네트워크 프로필을
만들지 않으므로 그 설정을 되돌리는 시스템 명령은 필요하지 않다.

## 조종 차단 — 후속

### 1. 이미 설치된 SDK·DDS를 읽기만으로 확인

11-18 현민님의 읽기 전용 확인에서는 대상 Python의 두 패키지와 해당 dpkg 패키지가
없었다. `/opt/ros/humble`의 C DDS/RMW 존재는 Python binding 설치나 현재 agent의
고정 0.10.2/SDK 호환성을 증명하지 않는다. Humble의 DDS 재사용은 **미확인**이다.
별도 venv 또는 팀원의 설치 경로가 확인되면 아래 메타데이터 명령으로 추가 확인한다.

대상 담당자가 기존 Python과 알려진 venv의 Python으로 각각 확인한다.
새 SDK import, `pip install`, 예제 실행, ping, DDS participant 생성은 하지 않는다.

```sh
python3 --version
python3 deploy/jetson/preflight.py
python3 - <<'PY'
import importlib.metadata as m
import json, platform, sysconfig
print(platform.machine(), sysconfig.get_config_var('SOABI'))
for name in ('cyclonedds', 'unitree-sdk2py'):
    try:
        dist = m.distribution(name)
    except m.PackageNotFoundError:
        print(name, 'not installed in this Python')
        continue
    direct = json.loads(dist.read_text('direct_url.json') or '{}')
    print(name, dist.version, 'source commit:', direct.get('vcs_info', {}).get('commit_id'))
    for item in dist.files or []:
        if '.so' in item.name:
            print('ELF file:', dist.locate_file(item))
PY
```

배포판이 안 보인다는 결과는 다른 venv·소스 checkout에도 없다는 뜻이 아니다.
팀원이 알려 준 설치 경로만 추가로 확인한다. 기본 이미지나 다른 프로그램의 SDK를
agent venv로 복사하거나 덮지 않는다. 소스 커밋이 없으면 출처 **미확인**으로 남긴다.
위 preflight의 `ready_for_runtime_review`는 메타데이터 점검일 뿐 setup/runtime의
`installation_ready` 또는 실기 조종 허용이 아니다.

### 2. 없으면 사용자 폴더에서 소스 빌드 준비

이 절차 역시 **미실행**이다. 인수 측정 중에는 실행하지 않는다. 팀원이 합의한 시간과
별도 승인된 ARM64 빌드 환경에서만 진행한다. Python 3.10 개발 헤더·venv/ensurepip,
C/C++ compiler·make·cmake·git·setuptools·wheel이 이미 있는지 먼저 확인한다.
없으면 시스템 패키지/sudo가 필요할 수 있으므로 **중단하고 환경 담당자에게 요청**한다.
이 문서에는 apt·sudo·시스템 라이브러리 설치 명령을 두지 않는다.

사용자 전용 새 폴더에서 C runtime과 Python binding을 고정 소스로 빌드한다.
개발 헤더 존재 확인은 `python3-config --includes`가 가리키는 Python.h를 읽어 확인한다.
빌드용 setuptools/wheel도 검토한 로컬 wheel로만 제공하고 `--no-build-isolation`을 쓴다.

```sh
command -v git cmake cc c++ make python3-config
python3-config --includes
python3 -m pip show setuptools wheel

mkdir -m 700 -- "$HOME/foothold-dds-build"
cd -- "$HOME/foothold-dds-build"
python3 -m venv build-venv
# 새 venv의 build 도구가 없으면 검토한 오프라인 wheel로만 설치한다.
./build-venv/bin/python -I -m pip install --no-index --only-binary=:all: \
  --find-links '<검토한 빌드 도구 wheel 폴더>' setuptools==80.9.0 wheel==0.45.1

git clone https://github.com/eclipse-cyclonedds/cyclonedds.git dds-core
git -C dds-core checkout --detach 9995905bce6c4cf9f740d6438bbf7fcfd1c83dfd
cmake -S dds-core -B dds-build -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="$HOME/foothold-dds-build/dds-install" \
  -DBUILD_TESTING=OFF -DBUILD_EXAMPLES=OFF -DBUILD_DDSPERF=OFF -DENABLE_SHM=OFF
cmake --build dds-build --parallel 2
cmake --install dds-build

git clone https://github.com/eclipse-cyclonedds/cyclonedds-python.git dds-python
git -C dds-python checkout --detach 9cec1189a3d5a1407851dfe1f40899dd4a67f52d
CYCLONEDDS_HOME="$HOME/foothold-dds-build/dds-install" \
  ./build-venv/bin/python -I -m pip wheel --no-deps --no-build-isolation \
  --wheel-dir ./dds-wheels ./dds-python

git clone https://github.com/unitreerobotics/unitree_sdk2_python.git sdk-source
git -C sdk-source checkout --detach 814556d15970dd2ecf1c9984e845ca02ab07e206
./build-venv/bin/python -I -m pip wheel --no-deps --no-build-isolation \
  --wheel-dir ./sdk-wheels ./sdk-source
```

`cmake --install`의 설치 위치는 사용자 폴더다. `/usr/local`, ldconfig, 시스템 Python,
시스템 서비스·ROS·카메라 드라이버에는 손대지 않는다. 위의 CYCLONEDDS_HOME은 **빌드
한 명령에만** 주며 runtime에 export하지 않는다. inherited CYCLONEDDS_HOME/
CYCLONEDDS_URI/LD_LIBRARY_PATH 거부도 기존대로 유지한다.
이 소스 빌드만으로는 런타임 loader가 사용자 폴더의 libddsc를 찾는다고 보장할 수 없다.
검토된 ARM build 환경의 auditwheel/patchelf 등으로 필요한 DDS 라이브러리를 wheel 안에
묶고 외부 의존성을 점검해야 한다. 그 도구도 없다면 멈춘다. 시스템 검색 경로 변경이나
runtime loader 환경 변수로 해결하지 않는다. [공식 binding 빌드 설정](https://github.com/eclipse-cyclonedds/cyclonedds-python/blob/9cec1189a3d5a1407851dfe1f40899dd4a67f52d/pyproject.toml)을 참고하되 그 CI 명령을 Jetson에서 그대로 실행하지 않는다.

### 3. 후속 ARM 게이트에 필요한 검토 기록

아래는 **후속 PR**의 입력이다. 현재 x86_64 wheel·ELF 해시 검증과 runtime 조종 허용
조건은 확장하지 않았다. ARM에서 설치가 되더라도 현재 PR만으로 조종을 켤 수 없다.

```sh
git -C dds-core rev-parse HEAD
git -C dds-python rev-parse HEAD
git -C sdk-source rev-parse HEAD
sha256sum ./dds-wheels/*.whl ./sdk-wheels/*.whl
# wheel을 별도 검사 폴더에 풀고, 포함된 각 .so와 dds-install의 각 라이브러리에 반복
readelf -h -d '<검사할 ELF 파일>'
readelf --version-info '<검사할 ELF 파일>'
sha256sum '<검사할 ELF 파일>'
```

기록에는 agent/SDK/C DDS/Python binding 정확한 소스 커밋·소스 압축 해시·변경 여부,
빌드 옵션·도구 버전·L4T/Ubuntu/Python SOABI/libc, wheel 이름·내용의 SHA-256,
ELF64/AArch64·NEEDED·SONAME·RPATH/RUNPATH·GLIBC 심볼 요구, libddsc 동봉과 외부 의존성
해석을 포함한다. ELF 검사는 라이브러리를 로딩하지 않고 수행한다. x86 공식 wheel의
해시를 재사용하거나 버전만으로 승인하지 않는다.

후속 검토에서는 설치된 파일과 승인 wheel 내용의 일치·SDK 출처 증명, loader 덮어쓰기
금지 유지, 잘못된 ABI/해시/누락 라이브러리 거부 시험, 기존 STOP·끊김·조종권·속도·신원
회귀 통과를 확인한다. 안전 범위 변경은 저장소 규칙대로 Claude·Codex 양쪽 검토 후
조정 세션이 판단한다. 별도 승인된 DDS 로딩·Go2 상태 수신·실기 정지 실측·Wi-Fi 단절
시험은 그다음이며, 소스 빌드/pytest/ELF 검사로 대체하지 않는다.

## 이번 검증 범위

새 시험은 가짜 NIC/이웃 정보, GUI 없는 setup 진입, ARM에서 유지되는 검증 거부와
한국어 상태 문구, 해시 고정 오프라인 installer 호출 모의, 기존 폴더/unit 보존,
보호 포트 거부, 자동 시작 없는 unit을 확인한다. 11-18 x86_64/Python 3.12.3,
pytest 7.4.4 시험 venv에서 아래 전체 명령은 **3296 passed, 4 skipped**였다(130.05초).
새 Jetson 시험은 **20 passed**다. 기존 opt-in 뎁스 wire·ROS 합성 및 실제 installer
cache를 요구하는 시험은 켜지 않았다.

```sh
env -u LD_LIBRARY_PATH PYTHONPATH=apps/agent FH_TEST_PORT_RANGE=9530:9549 \
  python -m pytest apps/agent -q
```

최초 실행에서 드러난 기존 매핑 fixture의 `posture_snapshot` 누락과 폰 TS 추출 fixture의
타입 제거 누락은 기준 커밋에서도 재현했다. 두 fixture만 현재 인터페이스에 맞췄으며
시험 기대값·안전 셀프테스트·실제 조종 코드는 바꾸지 않았다. 바꾼 runtime/installer
소스는 Python 3.10 문법으로 AST 파싱했으나 실제 Python 3.10/ARM 실행은 아니다.

Jetson 설치·systemd 실행·ARM 빌드·실기 DDS·서버
등록·GUI 없는 화면 전달·CPU 측정·물리 STOP은 **미확인**이다.

## 팀원과 맞출 것

- 설치 위치: 사용자 홈의 독립 폴더, 기존 Python/SDK/주소와의 충돌 여부.
- 실행 시간대: 인수 측정 시간에는 unit 중지, 수동 시작·종료 담당자.
- DDS 동시 사용: domain 0과 Go2 내부 유선의 기존 프로그램·수신자·명령 송신자 조합.
- 조이스틱과 앱 명령 우선: 기체 모드·소유권·독립 정지 수단, 동시 조종 금지 범위.
- CPU 부담·측정 간섭: 15W 그대로 유지, DDS·영상·뎁스·네트워크·저장 부하 측정과 중지 기준.
- 인증 정보 보관: Jetson 전용 신규 발급, 0700/0600 위치, 회수·교체·삭제 담당자와 화면 접근 수단.

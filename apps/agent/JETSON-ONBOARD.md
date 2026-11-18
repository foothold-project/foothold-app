# Jetson 사용자 폴더 오프라인 설치 묶음

기준: `dev fa6450e` 이후 RB-JETSON-HARDEN (RV-374 권고 ①③), 2026-11-18.
승인 범위는 **설치 묶음 생성과 검증된 ARM DDS의 자동 점검 허용**이다.
이 작업에서 Jetson 접속·SSH·복사·설치·DDS 참가·실기 명령은 실행하지 않는다.
아래 Jetson 명령은 담당자가 실행 시간을 정한 뒤 수행할 현장 절차다.
상태 화면을 보는 수단과 실제 실행·로봇 검증은 별도 승인이 필요하다.

## 대상과 조사 결과

현민님이 전달한 읽기 전용 확인 결과: Jetson aarch64, Ubuntu 22.04,
Python 3.10.12, gcc·cmake·git·python3-config 있음, venv의 ensurepip 없음.
`/opt/ros/humble`에는 FastDDS만 있고 Cyclone DDS와 Python SDK는 없다.
Wi-Fi 인터넷은 되지만 **설치는 인터넷을 사용하지 않는다**.
인수 측정 중인 장치의 시스템 패키지·firmware·JetPack·librealsense·전력모드를
바꾸지 않는다. sudo·apt·시스템 Python 변경·ROS 환경 source는 하지 않는다.

[고정 SDK setup.py](https://github.com/unitreerobotics/unitree_sdk2_python/blob/814556d15970dd2ecf1c9984e845ca02ab07e206/setup.py)는
`cyclonedds==0.10.2`를 요구한다. 11-18 PyPI JSON/파일 목록 조사에서
[0.10.2](https://pypi.org/project/cyclonedds/0.10.2/#files),
[0.10.4](https://pypi.org/project/cyclonedds/0.10.4/#files),
[0.10.5](https://pypi.org/project/cyclonedds/0.10.5/#files) 모두 Linux aarch64 wheel이 없었다.
0.10.3과 0.11.0의 버전별 JSON은 404였다. macOS arm64 파일은 Linux에서 쓸 수 없다.
따라서 SDK 요구 판을 바꾸지 않고, 고정 소스로 대상 Jetson에서 C와 Python binding을 빌드한다.
이 PC에는 ARM 실행·교차 빌드 도구가 없으며 새 시스템 도구를 설치하지 않았다.

| 원본 | 정확한 판·커밋 | 압축 SHA256 |
|---|---|---|
| Cyclone DDS C | 0.10.2 / `9995905bce6c4cf9f740d6438bbf7fcfd1c83dfd` | `bc84e137e0c8a055b8cd97fbeafec94e36de1b0c2e88800896a82384fd867ae5` |
| cyclonedds-python | PyPI sdist 0.10.2 / release tag `9cec1189a3d5a1407851dfe1f40899dd4a67f52d` | `f834962eabbdcdf4e9cd75cf87222f3c5ef22d9cb9e7ed651d9a8710fe984a30` |
| unitree_sdk2py | 1.0.1 / `814556d15970dd2ecf1c9984e845ca02ab07e206` | `5224e774cf7a2ff784b957685225300f9e9627eb0b4fe5a76b8146a4fcbf4743` |

[공식 C 소스](https://github.com/eclipse-cyclonedds/cyclonedds/tree/9995905bce6c4cf9f740d6438bbf7fcfd1c83dfd)와
[Python release 소스](https://github.com/eclipse-cyclonedds/cyclonedds-python/tree/9cec1189a3d5a1407851dfe1f40899dd4a67f52d)를 사용한다.
Python 입력은 Git archive가 아닌 **공식 PyPI sdist 원물**이다.
세 원본 URL과 SHA256은 `go2_direct/arm_provenance.py`에 고정되어 있다.
이는 로컬 빌드 기록이며 서명·재현 가능한 빌드 증명이나 실기 안전 보장은 아니다.

## 준비 PC에서 한 파일 만들기

기존 Python·pip·readelf만 사용한다. 프로그램 소스는 커밋된 `apps/agent`를
`git archive`로 가져오므로 미커밋 자료·인증 파일·다른 앱을 포함하지 않는다.
빌드 전에 변경을 커밋한다. 출력 경로는 아직 없는 이 checkout의 `runs/` 하위여야 한다.
`runs/`는 gitignore 대상이며 묶음·로그·원본 파일을 커밋하지 않는다.

```sh
# 계획: 다운로드·파일 생성 없음
python3 apps/agent/installer/build_jetson_bundle.py --output runs/jetson-bundle/release
# 실제 준비: 공식 공개 배포처에서 다운로드, 설치·ARM 실행 없음
python3 apps/agent/installer/build_jetson_bundle.py --output runs/jetson-bundle/release --build
sha256sum runs/jetson-bundle/release/foothold-jetson-aarch64-cp310.tar.gz
```

완성 파일은 `foothold-jetson-aarch64-cp310.tar.gz` 하나다. 바깥 SHA256은 조정 세션의
검증 결과와 대조한다. `INCOMPLETE`가 있거나 명령이 실패한 출력은 사용하지 않는다.
압축 안에는 다음이 함께 있다.

- `install.sh`, `apps/agent/`: 설치 도구·우리 소스·문서.
- `wheels/`: 공식 Linux aarch64 CPython 3.10/abi3 wheel과 범용 Python wheel 17개.
  NumPy 1.26.4·OpenCV 4.10.0.84·websockets 15.0.1·zeroconf 0.148.0·qrcode 8.2,
  pip 25.3·setuptools 80.9.0·wheel 0.45.1 및 모든 전이 의존성을 포함한다.
- `sources/`: 위의 C DDS·Python binding·SDK 압축 원물 3개.
- `SHA256SUMS`, `PROVENANCE.json`: 전체 파일 해시, 소스 커밋, 원본 해시,
  native wheel의 ELF 헤더·NEEDED·RPATH/RUNPATH·GLIBC 심볼 검사 기록.

모든 공식 wheel의 파일명·판·URL·SHA256은 `installer/jetson-wheels.lock.json`에 고정한다.
준비 도구는 Python 3.10/Linux/aarch64 marker로 의존성 폐쇄와 native ELF의 AArch64를
검사한다. `build_jetson_wheelhouse.py`/`jetson_onboard.py`의 기존 외부 DDS wheel 경로는
호환용으로 보존하지만, 이 설치 묶음은 새 `build_jetson_bundle.py`와
`install_jetson_bundle.py`를 사용한다. 소스와 wheelhouse를 따로 조립할 필요가 없다.

## 담당자가 묶음 옮기기·설치·빌드하기

**이번 작업자는 이 절차를 실행하지 않았다.** 담당자가 승인된 전달 방법으로 한 파일을
Jetson 사용자 홈에 옮긴다. 바깥 SHA256을 먼저 대조하고 홈 아래에 압축을 푼다.
이 문서는 SSH·복사·터널 명령을 실행하거나 네트워크 설정을 바꾸지 않는다.
실제 서버 원점은 현장에서 입력하며 IP·토큰·비밀번호를 Git이나 명령 인자에 넣지 않는다.

```sh
: "${HOME:?HOME must be set}"
# 전달된 원물의 SHA256이 조정 세션 기록과 같은지 먼저 확인
sha256sum foothold-jetson-aarch64-cp310.tar.gz
# 홈 아래의 빈 작업 디렉터리에서 해제
mkdir -- "${HOME:?}/foothold-jetson-unpack"
tar -xzf foothold-jetson-aarch64-cp310.tar.gz -C "${HOME:?}/foothold-jetson-unpack"
cd -- "${HOME:?}/foothold-jetson-unpack/foothold-jetson"
# 읽기 전용 계획: 모든 해시·설정·새 설치 경로 확인
sh ./install.sh --server https://example.invalid --nic enP8p1s0 --port 9539
# 팀원과 시간을 맞춘 대상 Jetson에서만: 실제 서버 원점으로 바꿔 실행
sh ./install.sh --server https://example.invalid --nic enP8p1s0 --port 9539 --install
```

설치 위치는 **정확히 `${HOME:?}/foothold-robot` 하나**다. HOME이 비었거나 상대 경로,
심볼릭 링크, 기존 설치 폴더이면 거부한다. 자동 덮어쓰기·자동 삭제·업그레이드는 없다.
폴더 0700·인증과 설정 및 빌드 기록 0600이며, 설치 실패 시 새 `INCOMPLETE` 폴더와
`build/install.log`를 보존한다. 실패 후에는 실행하지 말고 담당자가 원인을 확인한다.

설치 순서는 다음과 같다.

1. 압축 안 모든 파일과 고정 원본·wheel SHA256을 재검사하고 독립 사용자 폴더에 복사한다.
2. `install.sh`는 PATH의 `python3` 대신 `/usr/bin/python3`를 쓰고, 판이 3.10이 아니면
   설치 전에 멈춘다. `/usr/bin/python3 -I -m venv --without-pip`로 venv를 만든다. 동봉한 공식 pip wheel을
   zip import로 실행해 hash 고정 wheel만 `--no-index --no-deps --require-hashes`로 설치한다.
   ensurepip·get-pip·인터넷·시스템 Python 설치는 사용하지 않는다.
3. `build/` 안에서 Cyclone DDS C를 CMake로 빌드해 `dds/`에 설치한다.
   DDSperf·예제·시험 실행·IDL compiler·SSL·security 플러그인은 빌드하지 않는다.
   네트워크 동작이나 로봇 명령이 없는 라이브러리 빌드다.
4. 고정 Python binding과 SDK, 우리 소스를 새 venv로 wheel 빌드·해시 고정 설치한다.
   binding의 ELF RPATH는 사용자 폴더의 `dds/lib`이며, 생성된 `__library__.py`는
   같은 libddsc를 첫 loader로 지정한다. runtime의 `CYCLONEDDS_HOME`/
   `LD_LIBRARY_PATH` export나 시스템 ldconfig는 필요하지 않다.
5. 실제 설치된 C 라이브러리·binding `.so`의 SHA256/AArch64와 binding·SDK Python 파일
   해시를 수집한다. 원본 SHA256·UTC 빌드 시각·gcc/cmake/readelf/Python/pip/setuptools/wheel
   판·SOABI를 `dds-build-manifest.json`에 0600으로 저장한다.
6. `pip check`와 DDS를 import하지 않는 자동 점검을 실행한다.
   완료된 뒤에만 `launch.py`를 만들고 `INCOMPLETE`를 지운다. 시작하지 않는다.

기존 make·readelf·Python.h가 필요하다. 대상에서 하나라도 없거나 빌드에 실패하면
**시스템 패키지를 설치하지 말고 중단**한다. C 빌드는 병렬 2개로 제한하지만 CPU·메모리·
디스크 부하가 발생하므로 인수 측정 시간과 겹치지 않게 팀원과 맞춘다.
`~/.config/foothold/`, systemd unit, 시스템 경로, 기존 서비스에는 쓰거나 접근하지 않는다.
자동 시작·자동 재시작은 꺼져 있다. 새 unit 등록도 하지 않는다.

## 설치 후 자동 점검과 처음 등록

아래 자동 점검만으로 SDK import·DDS 참가·실기 동작을 하지 않는다.

```sh
"${HOME:?}/foothold-robot/venv/bin/python" -I -m foothold_agent.go2_direct.preflight
stat -c '%a' "${HOME:?}/foothold-robot/dds-build-manifest.json"   # 600
```

ARM에서 `installation_ready`가 되려면 Linux/Python 3.10·기존 패키지 고정 판,
정확한 전용 venv와 빌드 기록, **코드에 고정된 원본 해시** 및 남아 있는 원물,
실제 설치 파일 전체의 해시와 AArch64 ELF가 모두 일치해야 한다.
`cyclonedds`·`unitree_sdk2py`의 실제 import 예정 경로(`find_spec().origin`)도
검증한 각 패키지 폴더 안이어야 하며, 다른 경로가 먼저 잡히거나 찾을 수 없으면 차단한다.
기록 없음·원본/설치 해시 다름·x86 ELF·파일 누락/추가·loader 환경변수면 한국어 이유와
함께 차단한다. 환경변수로 이 점검을 풀 수 없다. 기존 x86_64 검사 본문은 그대로다.
`.pyc` 변조는 로컬 설치 폴더를 바꿀 수 있는 사용자를 신뢰하는 현재 위협 모델 안에 있어 별도 검증하지 않는다.

`installation_ready`는 설치 자동 점검 결과다. NIC·기체 신원·서버 승인·조종권·
STOP·잠금 해제·끊김·0.3초 감시·속도 한도와 runtime 허용 조건은 바꾸지 않는다.
Go2 상태 수신·DDS ABI·정지·통신 단절·실기 조종은 별도 현장 검증이 필요하다.
OpenCV의 GL 등 외부 라이브러리 해석과 실제 미디어 로딩도 대상에서 미확인이다.

실제 실행 승인이 있고 담당자가 상태 화면 접근 수단을 별도로 승인한 뒤에만:

```sh
"${HOME:?}/foothold-robot/venv/bin/python" -I "${HOME:?}/foothold-robot/launch.py"
```

이 명령부터 DDS 참가와 서버 연결이 생긴다. headless는 브라우저를 열지 않으며,
상태 화면은 loopback 전용 포트 9539다. 보호 포트는 installer에서 거부한다.
외부 공개·cloudflared·터널·서비스 자동 시작을 설정하지 않는다.

첫 등록은 한 번: 웹의 «로봇 연결하기 → 새 로봇 추가»에서 승인된 상태 화면의 일회용
코드를 입력한다. 새 Jetson 전용 인증을 `private/agent.json`에 저장하고 다음 실행에
재사용한다. 토큰을 다른 장치에서 복사하지 않는다. 기체번호가 없는 경우 기존 정책대로
**매 실행 시 «이 로봇 맞음» 확인**은 여전히 필요하므로 무인 시작을 보장하지 않는다.
유선 `enP8p1s0`/`auto`의 기존 물리 유선·단일 후보·예약 주소·기본 경로 규칙도 유지한다.
Jetson의 현재 주소가 예약 주소로 거부되면 주소를 임의 변경하지 말고 별도 검토한다.

## 중지·되돌리기

담당자가 위 수동 실행 터미널에서 Ctrl+C로 중지하고 프로세스 종료를 확인한다.
동시 실행 중인 측정 프로그램이나 기존 서비스는 건드리지 않는다. 새 자동 시작 항목은 없다.
필요한 설치 기록을 개인 자료로 보관한 뒤 **이 설치만 제거**한다. 인증 정보도 지워지므로
웹에서 Jetson 전용 등록을 회수할 담당자를 먼저 정한다. 빈 HOME의 잘못된 삭제는 거부한다.

```sh
: "${HOME:?HOME must be set}"
test -d "${HOME:?}/foothold-robot"
test ! -L "${HOME:?}/foothold-robot"
# 종료·보관·인증 회수를 확인한 담당자가 실행
rm -rf -- "${HOME:?}/foothold-robot"
```

다른 `~/.config/` 폴더나 기존 서비스는 삭제하지 않는다. 소스 PR의 되돌리기는
Git revert로 하며, Git 되돌림만으로 장치 설치가 제거되지는 않는다.

## 이번 시험과 남은 현장 확인

새 시험은 ARM 기록 정상/소스 해시 불일치/.so 해시 불일치/x86 ELF/기록 누락/
환경변수 시도와 파일 추가·누락·권한·경로를 확인한다. 기존 x86 시험 기대값은 유지한다.
검증 폴더 밖의 같은 이름 패키지가 먼저 잡힐 때 차단되고, 설치 스크립트가 PATH의 다른 Python을 무시하는지도 확인한다.
가짜 HOME에서 파일 복사·권한·부분 실패 보존을 실제 수행하며 ARM 컴파일 subprocess는
모의한다. 이 PC에서 `venv --without-pip`와 공식 pip wheel bootstrap은 별도 실제 시험한다.
전체 pytest 명령과 결과·생성 묶음 이름·크기·SHA256은 PR과 gitignore된 `runs/` 보고서에 남긴다.

```sh
env -u LD_LIBRARY_PATH PYTHONPATH=apps/agent FH_TEST_PORT_RANGE=9530:9549 \
  python -m pytest apps/agent -q
```

**Jetson 미확인**: 실제 Python 3.10/aarch64 빌드·설치, native 의존성 해석·DDS/binding 로딩,
상태 화면 접근, 최초 등록, 실제 NIC·예약 주소 적합성, DDS 상태 수신·STOP·Wi-Fi 단절,
미디어 로딩·CPU/메모리/열·측정 간섭. 빌드 성공·pytest·ELF 검사는 실기 검증을 대신하지 않는다.

팀원과 설치/빌드 시간·디스크 여유·중지 담당자, 내부 유선의 기존 DDS domain 0 사용,
동시 조종 금지와 독립 정지 수단, 기존 프로그램 우선권, 15W 설정 유지,
새 인증 발급·회수 담당자, 승인된 화면 접근 수단을 맞춘다.

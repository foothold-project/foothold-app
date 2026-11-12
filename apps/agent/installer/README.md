# 노트북 연결 설치 파일

운영자 순서는 [GO2-SERVER-DRIVE.md](../GO2-SERVER-DRIVE.md) 첫 절을 따른다. Ubuntu 22.04·24.04 **Desktop amd64**용 `.deb`와 [Windows 10/11 x64 개발판 ZIP](#windows-1011-x64-개발판)을 만든다. GUI 설치 및 Polkit 비밀번호 창은 별도 현장 확인 항목이며, 시스템 Python·apt 저장소·서버 설정을 수정하지 않는다.

형식을 고른 이유:
1. `.deb`는 Ubuntu의 파일 관리자에서 실행 권한 변경 없이 설치 관리자로 열 수 있다.
2. `/opt/foothold-robot`에 자체 CPython과 모든 wheel을 담아 설치 시 인터넷·pip가 필요 없다.
3. 설치 관리자에서 제거·업그레이드를 관리하며 사용자 연결 키를 건드리지 않는다.

## 빌드

저장소 루트에서 개발용 Python 3.10 이상, `dpkg-deb`가 있는 x86_64 Linux로 실행한다. sudo는 필요 없다. 첫 빌드는 공개 원물 다운로드를 위해 인터넷이 필요하다. 서버 주소는 출력 파일에만 들어가며 저장소에는 넣지 않는다.

```sh
python3 apps/agent/installer/build.py --server https://example.invalid
# output/easy-install/foothold-robot_0.2.0-1_amd64.deb 및 .sha256
```

`--version`은 Debian 버전, `--output`은 이 checkout의 `output/` 또는 `runs/` 하위만 허용한다. 출력 전체가 gitignore 대상이다. 실제 운영 주소가 들어간 파일·빌드 로그는 공개 저장소에 올리지 않는다.

같은 `--output`으로 다시 빌드하면 `cache/`의 받은 원물을 먼저 SHA256으로 재검증해 그대로 쓴다. 서버 주소 변경은 Python·SDK·binutils를 다시 받지 않는다. 특히 GitHub SDK tarball이나 Ubuntu pool의 원물이 나중에 바뀌거나 없어질 수 있으므로 `output/easy-install/cache/`를 보관하고, 개발 서버용 재빌드도 이 위치를 재사용한다. 캐시가 손상되면 새 파일이나 해시를 자동 수용하지 않고 중단한다. 기존 검증 원물을 남기려면 재빌드할 때 `--version 0.2.0-2`처럼 새 버전을 지정한다.

`inputs.lock.json`의 CPython 3.10.21 standalone(20260901)·고정 SDK 커밋 archive·PyPI wheel·Ubuntu native tool을 SHA256으로 검증하고 불일치 시 중단한다. SDK는 검증된 archive에서 로컬 wheel을 만든 뒤 그 커밋의 `direct_url.json`을 기록해 기존 preflight를 유지한다. `pip check`도 수행한다. Python·SDK/DDS·numpy·opencv·websockets·qrcode 핀과 전이 의존 wheel은 모두 고정되어 있다. ELF 확인용 `readelf`와 필요한 libctf만 `/opt`에 묶으므로 binutils apt 설치는 필요 없다. GPL 도구의 정확한 대응 소스·Ubuntu 패치·copyright도 `/opt/foothold-robot/licenses/binutils/`에 함께 넣는다.

빌드는 `pyproject.toml`의 `setup`, `go2-readonly`, **있을 때만 `slam`** 묶음을 읽는다. 묶음 안의 PyPI 항목은 모두 `name==version`이어야 한다. 아직 lock에 없는 고정 항목은 해당 버전의 PyPI SHA256으로 검증한 호환 wheel만 내려받고 설치 파일의 `inputs.lock.json`·`extras.json`에 기록한다. 소스 빌드·임의 버전 해소는 하지 않는다. 새 묶음은 전이 의존성도 핀으로 나열해야 한다(빠지면 `pip check`로 빌드 중단). 기존 lock과 핀이 충돌하면 검토 없이 대체하지 않고 실패한다. `slam`이 없는 현재 checkout에서는 건너뛴다. pyproject 자체는 빌드가 고치지 않는다.

시스템 의존성은 Ubuntu Desktop 기본 구성인 libc6>=2.35, libstdc++6, zlib1g, iproute2, libgl1, libglib2.0이다. [22.04.5 Desktop manifest](https://releases.ubuntu.com/22.04/ubuntu-22.04.5-desktop-amd64.manifest), [24.04.3 Desktop manifest](https://releases.ubuntu.com/24.04/ubuntu-24.04.3-desktop-amd64.manifest)에서 존재를 대조했다. 서버/minimal 이미지나 기본 라이브러리를 제거한 PC는 오프라인 지원 대상이 아니다. NetworkManager가 없거나 권한 창을 제공할 수 없으면 자동 유선 설정 대신 수동 안내를 표시한다.

## 실행·제거 구조

- 앱 목록과 `/etc/xdg/autostart`의 아이콘은 사용자 systemd 서비스로 연결한다. 설치 후 활성 로컬 그래픽 사용자의 기존 user manager에서 시작을 시도하며 root로 프로그램을 실행하지 않는다. 그래픽 세션이 없으면 다음 로그인 때 시작한다. 자동 시작을 끈 사용자의 선택은 재설치에도 보존한다.
- 앱 화면에서 자동 시작 선택·프로그램 종료·명시적 다시 연결을 제공한다. 중복 실행은 사용자별 flock으로 기존 화면을 연다. token·서버 주소를 명령줄/환경에 넘기지 않는다. Python은 `-I`로 실행한다.
- 기본 화면과 관리 POST는 정확한 `127.0.0.1:9611` Host/Origin만 받고, 관리 요청은 JSON·크기 제한·cross-site 거부를 적용한다. 관리 API는 저장된 token을 반환하지 않는다.
- 유선 설정은 명시적 단추로만 새 NetworkManager 프로필을 생성한다. 기존 프로필은 수정하지 않는다. 물리 유선·UP·다른 IPv4 대역 없음·IPv4/IPv6 기본 경로 없음 조건을 재확인한다. 알려진 주소를 피하고 `ipv4.dad-timeout=3000`의 단일 주소 중복 검사가 실패하면 새 UUID의 프로필만 삭제한다. Wi-Fi·다른 NIC·기본 경로·DNS를 수정하지 않는다. DDS 시작 뒤에는 이 단추를 사용할 수 없다.
- 패키지를 제거하면 해당 사용자 서비스를 먼저 종료한다. 사용자 `agent.json`·옛 env·자동 시작 선호·전용 NM 프로필은 삭제하지 않는다. 파일 관리자의 `.deb` 연결 프로그램이 설치 관리자로 지정되어 있어야 한다. 예전 Ubuntu App Center에서 로컬 deb 열기가 지원되지 않으면 설치 관리자의 업데이트/연결 설정은 배포 담당자가 준비해야 한다.

## 로봇 없는 검증

```sh
python3 apps/agent/installer/smoke.py output/easy-install/foothold-robot_0.2.0-1_amd64.deb
python -m pytest apps/agent/tests
```

smoke는 9611이 비었는지 먼저 확인하고, 별도 HOME의 사용자 공간에 패키지를 추출한다. `--nic fh-missing`으로 적합한 NIC가 있어도 DDS에 절대 참가하지 않으며, 화면·자동 시작 끄기/켜기·종료·파일 제거 후 연결 키 보존을 확인한다. 실제 root 설치·GUI 더블클릭·로그인 자동 기동·Polkit 창·실제 NIC 설정·Ubuntu 22.04 별도 OS 실행은 이 검사로 확인되지 않는다. smoke의 `--keep-open`은 Orca 브라우저 화면 QA용으로 종료 API 요청까지 실행을 유지한다.

출처: [Python standalone 배포](https://docs.astral.sh/python-build-standalone/distributions/), [NetworkManager CLI/Polkit](https://networkmanager.pages.freedesktop.org/NetworkManager/NetworkManager/nmcli.html), [never-default·DAD 설정](https://networkmanager.pages.freedesktop.org/NetworkManager/NetworkManager/nm-settings-nmcli.html).

## Windows 10/11 x64 개발판

```sh
python3 apps/agent/installer/build.py --platform windows --server https://example.invalid
# output/easy-install/foothold-robot_0.2.0-1_windows_amd64.zip
# 같은 이름 + .sha256 및 .contents.txt
```

개발 서버의 `GET /api/v1/robot-installer/{platform}` 빌드 호출 계약:

| 항목 | Linux | Windows |
|---|---|---|
| platform | `linux` | `windows` |
| 명령 | `python3 apps/agent/installer/build.py --platform linux --server <HTTPS origin>` | `python3 apps/agent/installer/build.py --platform windows --server <HTTPS origin>` |
| 기본 출력 | `output/easy-install/foothold-robot_0.2.0-1_amd64.deb` | `output/easy-install/foothold-robot_0.2.0-1_windows_amd64.zip` |
| 필요 도구 | x86_64 Linux, Python 3.10+, dpkg-deb | x86_64 Linux, Python 3.10+ 표준 라이브러리만 |

`--version`과 `--output`을 양쪽 모두 지원한다. 출력 마지막 줄은 `artifact`, `bytes`, `sha256`을 담은 JSON이다. 서버는 마지막 JSON 줄의 경로를 사용하거나 위 파일명을 사용하고, 동시 빌드는 출력/캐시가 겹치지 않도록 직렬화해야 한다. 서버 주소는 `server.json`에만 들어가며 빌드 때 고정한다. 사용자에게 주소 입력·Python 설치·pip 실행을 요구하지 않는다. 서버 `BUILDERS` 표에도 이 Windows 명령과 `application/zip`을 연결했다. 인증된 `/api/v1/robot-installer/windows` 요청은 빌드 후 같은 ZIP 파일명을 attachment로 제공하며 실제 서버 배포는 별도다.

Windows 형식은 **공식 embeddable Python + distlib의 amd64 GUI PE 런처를 담은 ZIP**이다. Linux에서 Windows PE를 실행하거나 컴파일하지 않고 검증한 원물을 조합하므로 wine·apt·컴파일러·Windows SDK·추가 시스템 패키지가 필요 없다. 사용자 설치 시에도 인터넷·관리자 권한이 필요 없으며, 바로가기 아이콘을 만들 수 있다. ZIP을 고른 이유는 서명되지 않은 자체 설치 EXE를 새로 컴파일하는 도구 없이 같은 Ubuntu 개발 서버에서 만들기 위해서다. ZIP은 Windows 탐색기의 **모두 압축 풀기** 한 단계가 필요하다.

사용자 순서:

1. ZIP 받기 → 모두 압축 풀기 → **FOOTHOLD 로봇 연결.exe** 더블클릭.
2. `%LOCALAPPDATA%\foothold\robot\<version>-<build-id>`으로 복사되고 바탕 화면·시작 메뉴에 아이콘이 생긴다. 이후에는 그 아이콘을 누른다. SmartScreen 경고가 나오면 **추가 정보 → 실행**을 선택한다. 개발판은 서명되지 않았다.
3. `127.0.0.1:9611` 화면이 열리면 기체 전용 랜선을 연결한다. 필요할 때만 **유선 연결 설정 (관리자 확인)**을 누르고 Windows UAC 확인 창을 승인한다. Windows 방화벽 확인은 실제 Windows 첫 검증 항목이다. 프로그램이 방화벽 규칙을 바꾸지는 않는다.
4. 자동 설정이 실패하거나 UAC를 취소하면 화면 안내에 따라 Windows 설정 → 네트워크 및 인터넷 → 고급 네트워크 설정 → 해당 기체 전용 유선의 IPv4를 수동으로 설정한다. 중복 없는 `192.168.123.200~254`, 마스크 `255.255.255.0`, 게이트웨이·DNS는 비운다. Wi-Fi·인터넷용 유선은 유지한다.

키는 `%APPDATA%\foothold\agent.json`에 저장한다. Windows DACL은 소유 사용자의 FullControl 한 항목만 허용하고 상속을 끈다. 디렉터리와 빈 임시 파일의 ACL을 먼저 보호한 뒤 키를 쓰고 flush/fsync → 원자적 교체한다. 읽을 때도 owner/DACL·단일 링크·reparse point를 검사하며 넓은 ACL의 기존 키를 자동 수용하지 않는다. 기존 `~/.config/foothold/go2-agent.env`나 Windows의 옛 env 파일을 읽지 않는다.

자동 시작은 사용자 Startup 폴더의 해당 `.lnk` 하나만 켜고 끈다. 설치 때 최초 활성화하며 업그레이드는 끈 선택을 유지한다. 실행 중복은 사용자별 Windows byte-range lock으로 막는다. 종료·다시 연결하기는 공통 stop event를 통해 기존 STOP/SDK 정리 경로를 거친다. 같은 버전·서버·프로그램 내용의 폴더는 재사용한다. 버전과 별도로 서버 주소·agent wheel의 build-id를 붙여 다른 주소/코드를 이전 폴더로 잘못 재사용하거나 실행 중 파일을 덮지 않는다. 공개 배포 원물은 새 `--version`으로 구분한다. 제거는 화면에서 자동 시작 끄기 → 프로그램 종료 → `%LOCALAPPDATA%\foothold\robot` 폴더와 바탕 화면·시작 메뉴 아이콘 삭제 순서다. 연결 키는 보존한다.

NIC 최초 선택은 PowerShell `Get-NetAdapter`/`Get-NetIPAddress`/`Get-NetRoute` JSON의 물리·유선(ifType 6)·Up·IPv4/IPv6 기본 경로 없음·전용 `/24` 주소 조건을 적용한다. NIC 식별자는 기존 조종 factory의 `socket.if_nameindex()` 검사와 같은 Windows canonical 이름(`ethernet_...`)이다. 화면 표시와 DDS 초기화에는 같은 index에서 읽은 FriendlyName을 별도로 보존하여 한글·공백을 지원하고 XML 문자는 거부한다. 주소 없는 전용 유선과 Windows 자동 사설 주소(APIPA)는 설정 단추만 제공하고 DDS 후보로 고르지 않는다. UAC가 열린 **뒤에도** GUID·MAC·index·이름·유선 상태·기본 경로·기존 주소를 다시 확인하고 선택한 어댑터에만 netsh 정적 주소와 빈 DNS를 설정한다. DAD Preferred 확인이 실패하면 화면에 수동 안내를 표시한다. DDS가 시작된 뒤에는 주소 설정을 막는다.

실행 중 NIC 재확인은 PowerShell 시작 비용 때문에 공통 안전 감시 시간이 늘어나지 않도록 Windows IP Helper `GetAdaptersAddresses`/`GetIpForwardTable2`로 같은 이름·index·MAC·정확한 주소·Preferred·Up·유선·양쪽 기본 경로 부재를 읽는다. 메타데이터 실패/지연은 기존 runtime의 안전 거부 규칙을 따른다. SDK의 POSIX trace 파일 경로만 사용자 cache의 `cdds.LOG`로 바꾸고, STOP·잠금·serial·field_approval·조종 객체 생성 순서는 공통 구현을 그대로 쓴다. Windows preflight는 SDK/DDS를 import하지 않고 고정 패키지·SDK 커밋·공식 wheel SHA·설치된 DDS DLL/PE 바이트를 검사한다.

`windows-inputs.lock.json`은 python.org **CPython 3.10.11 embeddable amd64**, SDK 고정 archive, cp310 win_amd64 wheel(OpenCV는 호환 cp37 abi3), 순수 Python wheel, Windows 추가 의존 `colorama`, 런처 `distlib`까지 SHA256으로 고정한다. SDK는 같은 고정 커밋에서 Linux 호스트용 빌드 backend로 universal wheel을 만든다. 전이 의존성과 Python 버전 조건은 **Windows/Python 3.10** marker로 검사하며 host Linux marker를 사용하지 않는다. 모든 native `.dll`/`.pyd`의 amd64 PE 헤더를 Linux에서 확인한다. `setup`·`go2-readonly`·있을 때만 `slam`의 새 정확한 핀은 Windows 호환 wheel과 PyPI SHA로만 허용하고, 기존 핀 충돌·wheel 부재·전이 핀 누락은 빌드를 실패시킨다. 원물 캐시는 Linux와 같은 `output/easy-install/cache/`를 공유하며 재다운로드 전 검증하고 손상은 거부한다.

대상은 Windows 10/11 x64 일반 데스크톱이다. Windows N의 OpenCV 미디어 기능은 별도 Media Feature Pack이 필요하다. Python 3.10.11은 python.org가 제공한 마지막 3.10 Windows 바이너리이며 이후 보안 릴리스는 source-only다. 현재 이 Linux PC에서는 Windows 실행을 검증하지 않았으므로 설치 파일 생성 성공과 Windows 실행 성공을 구분한다.

출처: [공식 Python embeddable 배포](https://www.python.org/downloads/release/python-31011/), [Cyclone DDS 0.10.2 wheel](https://pypi.org/project/cyclonedds/0.10.2/#files), [Unitree 고정 setup.py](https://github.com/unitreerobotics/unitree_sdk2_python/blob/814556d15970dd2ecf1c9984e845ca02ab07e206/setup.py), [Get-NetAdapter](https://learn.microsoft.com/en-us/powershell/module/netadapter/get-netadapter), [netsh interface](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/netsh-interface), [IP Helper](https://learn.microsoft.com/en-us/windows/win32/api/iphlpapi/nf-iphlpapi-getadaptersaddresses), [distlib relative launcher](https://github.com/pypa/distlib/blob/0.3.9/PC/launcher.c).

Windows의 실행한 시험·원물 SHA·미검증 범위는 [WINDOWS-VALIDATION.md](WINDOWS-VALIDATION.md)를 본다.

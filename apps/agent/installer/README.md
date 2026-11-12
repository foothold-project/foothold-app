# 노트북 연결 설치 파일

운영자 순서는 [GO2-SERVER-DRIVE.md](../GO2-SERVER-DRIVE.md) 첫 절을 따른다. Ubuntu 22.04·24.04 **Desktop amd64**용 `.deb`다. GUI 설치 및 Polkit 비밀번호 창은 별도 현장 확인 항목이며, 시스템 Python·apt 저장소·서버 설정을 수정하지 않는다.

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

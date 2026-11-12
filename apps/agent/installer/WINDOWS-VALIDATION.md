# RB-AGENT-WIN 검증 — 2026-11-12

기준은 `7810a8b` (`dev`, PR #338 통합)에서 시작한 `less82/rb-agent-win`이다. 초기 구현 수정은 `apps/agent/**`에 한정했다. 아래 검토 후속 작업은 별도 허용된 서버 설치기 파일과 그 시험도 수정했다. Windows PC·Wine·apt·새 시스템 패키지·실기·DDS 참가·로봇 명령·운영/개발 서버·금지 포트의 기존 프로세스에는 접촉하지 않았다. 새 의존성은 `output/`의 시험 전용 venv에만 설치했고 산출물·로그도 gitignore 된 `output/`에만 썼다.

## 가능 여부와 빌드

고정 SDK `814556d15970dd2ecf1c9984e845ca02ab07e206`의 `setup.py`가 요구하는 Cyclone DDS는 **0.10.2**다. 그 버전과 numpy 1.26.4·websockets 15.0.1·zeroconf 0.148.0은 cp310 win_amd64 wheel, OpenCV 4.10.0.84는 CPython 3.10 호환 cp37 abi3 win_amd64 wheel이 있다. SDK는 순수 Python universal wheel로 Linux에서 만들었다. qrcode 8.2와 Windows 추가 의존 colorama 및 전이 의존 wheel도 모두 확보했다. python.org 공식 CPython 3.10.11 embed amd64 ZIP, distlib 런처와 원물 전체를 `windows-inputs.lock.json`의 SHA256으로 고정했다. 가능 여부는 시작 후 30분 이내 조정 세션에 `status: 윈도우 가능 여부`로 보고했다.

선택한 형식은 embeddable Python과 distlib GUI PE 런처를 담은 ZIP이다. Linux의 Python 표준 라이브러리만으로 원물을 조합하며 Windows 바이너리를 실행하지 않는다. 사용자는 ZIP 모두 압축 풀기 → EXE 더블클릭 → 사용자 폴더 설치/아이콘 순서이며, UAC는 선택한 유선 주소 설정에만 쓴다. SmartScreen 안내와 서버 호출 명령·출력명·도구는 [README](README.md)의 Windows 절에 있다.

최종 빌드와 캐시/ZIP 검증 결과는 아래 표에 기록한다. Linux에서 PE 헤더·의존성 marker·해시를 확인한 것이며 Windows에서 DLL 로드나 GUI가 작동한다는 뜻은 아니다.

| 검사 | 결과 |
|---|---|
| `python3 apps/agent/installer/build.py --platform windows --server https://example.invalid --version 0.2.0-4` | PASS: target 의존성·amd64 PE·ZIP 내용 검증 |
| Windows 설치 원물 | `output/easy-install/foothold-robot_0.2.0-4_windows_amd64.zip` |
| 크기·SHA256·내용 수 | **142,170,952 bytes**, `e929d0cfadf6ec8b0d94872f79c7b946f3a25cc650477bca0f5a082263edddda`, 3,274 files |
| 재사용 원물 | 고정 입력 **22개** 전부 빌드 전후 SHA256·mtime 동일, 재다운로드 없음 |

## 실행한 시험

무거운 시험/빌드는 모두 `flock /home/hyeon/.claude/jobs/5cab73e4/tmp/heavy-test.lock nice -n 10`으로 직렬화했다. 아래 pytest는 Orca가 상속한 `LD_LIBRARY_PATH`, `CYCLONEDDS_HOME`, `CYCLONEDDS_URI`를 제거하고 `PYTHONPATH=apps/agent:.` 및 `output/test-venv/bin/python`으로 실행했다. 최초 시스템 Python 실행의 미설치 qrcode/websockets와 inherited loader 환경에 따른 실패는 시험 전용 의존성/환경을 준비한 뒤 재실행했다.

| 검사 | 실제 결과 |
|---|---|
| `pytest apps/agent/tests/test_windows_installer.py apps/agent/tests/test_desktop_installer.py apps/agent/tests/test_setup_pairing.py apps/agent/tests/test_go2_readonly.py -q` | **223 passed** (Windows 신규 39개 + 기존 184개) |
| `pytest apps/agent/tests --ignore=apps/agent/tests/test_phone_policy_compat.py --ignore=apps/agent/tests/test_phone_proportional.py --ignore=apps/agent/tests/test_speed_1p5.py -q` | **2246 passed, 1 skipped** |
| Python compile, `git diff --check` | PASS |

새 시험은 가짜 PowerShell JSON·명령으로 Wi-Fi/가상/Down/공유 주소/IPv4·IPv6 기본 경로/중복·불안정 주소 제외, 한글 표시명과 canonical NIC 식별자 분리, UAC 뒤 재확인과 선택 어댑터 한정 netsh, 키 ACL 보호 후 쓰기/원자 교체/위험 경로 거부, 자동 시작 켜기·끄기/다른 바로가기 보존, 중복 실행 잠금, 종료의 공통 stop 경로, Windows signal 복원, 설치 폴더 build-id·자동 시작 끄기 보존을 확인한다. Native IP Helper는 가짜 ctypes 구조로 주소·route 해석과 on-link/IPv6 default route 제외를 확인한다. preflight와 빌드는 가짜/실제 PE 메타데이터·설치 바이트 변조 거부·Windows/Python 3.10 marker·선택적 추가 핀의 Windows wheel 선택/부재 거부를 검사한다. SDK는 가짜 모듈만 썼다.

전체 회귀에서 제외한 3개 파일은 PR #338의 [기존 검증 기록](VALIDATION.md)에 수정 전 HEAD에서도 재현된 웹 TypeScript 추출 실패 20개가 있는 범위다. 해당 파일·웹 코드·안전 셀프테스트 기대값을 수정하지 않았다. `installer/smoke.py`는 9611을 사용하므로 이번 작업의 금지 포트 조건에 따라 실행하지 않았다. 기존 installer 단위 시험 25개는 그대로 통과했다.

## 진짜 Windows에서 처음 확인할 것

- Windows 10/11 x64 일반 사용자로 ZIP 모두 압축 풀기·SmartScreen·한글/공백 사용자 경로·바탕 화면/시작 메뉴 아이콘과 `127.0.0.1:9611` 화면. 먼저 `--nic fh-missing`으로 로봇 미접속 검증을 한다.
- python.org embed의 SSL/인증서, numpy/OpenCV/DDS의 DLL 로드와 native IP Helper 구조·응답 시간, Windows N은 Media Feature Pack 별도 확인.
- 키 디렉터리와 임시/최종 파일의 실제 NTFS owner-only DACL·재실행 읽기·원자 교체·다른 사용자 접근 거부·reparse/hardlink 거부.
- 자동 시작 끄기/켜기 후 로그아웃/로그인, 같은/새 build-id 재설치와 끈 선택 보존, 중복 아이콘 실행, 종료/다시 연결하기가 강제 종료 없이 공통 STOP 정리를 거치는지.
- 전용 USB 유선에서 Wi-Fi 유지, UAC 승인/취소, netsh 대상 NIC·빈 게이트웨이/DNS·DAD 중복 주소 실패와 수동 안내, 방화벽 창, canonical/FriendlyName의 실제 매핑과 NIC 분리/주소 변경 때 안전 거부.
- 실기 검증은 별도 승인 후 serial·QR/저장 키·field_approval 자동 조건·잠금·조종 SDK 생성 순서·STOP/해제/재연결을 확인한다. Linux 빌드/가짜 시험은 이 확인을 대체하지 않는다.

되돌림: 이 PR의 소스 커밋을 revert하고 검토된 이전 설치 원물을 사용한다. Windows 새 프로그램은 자동 시작을 끄고 종료한 뒤 해당 build-id 폴더와 아이콘만 제거한다. 연결 키는 삭제하지 않는다. Git push/PR은 서버·웹·노트북 배포가 아니다.

## PR #344 검토 수정과 서버 빌드 연결

- PowerShell이 ASCII 작은따옴표 외에 U+2018·U+2019·U+201A·U+201B도 구분자로 읽는 경계를 고쳤다. 사용자 경로를 만드는 `literal()`은 다섯 문자를 각각 두 번 쓰고, NIC FriendlyName에서는 네 smart quote를 거부한다. ACL·바로가기의 악의적인 경로가 한 문자열로 남는지와 해당 NIC가 UAC 호출 전에 제외되는지 새 시험으로 확인했다.
- 수정 전 새 9개 시험은 **8 failed / 1 passed**, 수정 후 Windows 전체는 **48 passed**였다. 실제 PowerShell이나 UAC를 실행하지 않고 가짜 명령과 다섯 작은따옴표 구분자를 해석하는 시험으로 경계를 확인했다.
- `origin/dev`의 #343 통합 `cd746ce`를 merge commit `9d45603`으로 가져왔고, 이어 추가 통합된 `f2628b4`까지 merge commit `4994fdd`로 반영했다. `setup/view.py`의 충돌은 새 영상 선택 UI와 Windows 제거/SmartScreen 안내·FriendlyName 표시를 함께 보존했다. depth·media·웹·계약 파일은 dev의 변경을 그대로 가져왔다.
- 서버 `robot_installer.BUILDERS`에 `--platform windows`, 고정 `foothold-robot_{version}_windows_amd64.zip`, `application/zip`을 연결했다. 기존 API 인증·고정 경로·현재/이전 원물 보존과 **2 GiB·20분** 상한은 유지했다. 시험은 `Content-Disposition`의 `.zip` 파일명·Content-Type·길이·SHA와 플랫폼별 실제 자식 명령/상한 전달을 검사한다.
- 최종 통합 pytest와 서버 경로 실제 빌드 결과는 아래에 기록한다. 초기 Linux/Windows 검증 기록은 해당 시점의 결과이며 이 후속 검증과 구분한다.


| 후속 검사 | 실제 결과 |
|---|---|
| 서버 installer/API/계약 + agent Windows/기존 installer/setup/readonly + merge된 depth/wire 관련 pytest | **309 passed, 2 skipped** (별도 활성화가 필요한 ROS 2/Cyclone wire 비교 2개) |
| 서버 경로 실제 빌드 기준 | `4994fdd0a8febedaec3082243b474a12700f0827` (아래 검증 기록만 추가하기 전 통합 커밋) |
| 실행 경로 | `InstallerManager.schedule → child main → build_once → bounded_run → publish → GET /api/v1/robot-installer/windows` |
| 입력 주소 | `https://control.example.invalid`, 실제 서버/로봇 접속 없음 |
| 최종 파일명 | `foothold-robot_0.2.0+4994fdd0a8fe_windows_amd64.zip` |
| 크기·SHA256·내용 | **142,189,463 bytes**, `1abf446f8f9af3ba42d3254d30ba864407302fd7cc330105b93bc5c009fc9fc2`, **3279 files**, 포함된 Python 소스 **95개**가 현재 제출 소스와 일치 |
| 시간·용량 | **13.46초 / 상태 영역 관측 최대 516,869,430 bytes**, 기존 상한 **1200초 / 2,147,483,648 bytes** 안 |
| 다운로드 응답 | **200**, `Content-Type: application/zip`, 고정 `.zip` attachment 파일명·Content-Length·본문 SHA 일치 |

통합 pytest는 위 네 기존 agent 시험 파일과 `apps/server/tests/test_robot_installer.py`, `test_robot_installer_build.py`, `test_contracts.py`, `apps/agent/tests/test_depth.py`, `test_depth_wire.py`를 같은 명령으로 실행했다. `FH_TEST_PORT_RANGE=19310:19329`의 별도 시험용 범위와 임시 PostgreSQL/인프로세스 API를 사용했다. 초기 신규 서버 시험 한 건은 완료된 자식 목록이 `info()`에서 정리되는 시점을 잘못 가정해 실패했으며 재기동이 없는지를 직접 확인하도록 시험을 고친 뒤 최종 통과했다. 실제 Windows·UAC·DDS/실기는 여전히 미검증이다.

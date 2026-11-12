# RB-AGENT-WIN 검증 — 2026-11-12

기준은 `7810a8b` (`dev`, PR #338 통합)에서 시작한 `less82/rb-agent-win`이다. 수정은 `apps/agent/**`에 한정했다. Windows PC·Wine·apt·새 시스템 패키지·실기·DDS 참가·로봇 명령·운영/개발 서버·금지 포트의 기존 프로세스에는 접촉하지 않았다. 새 의존성은 `output/`의 시험 전용 venv에만 설치했고 산출물·로그도 gitignore 된 `output/`에만 썼다.

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

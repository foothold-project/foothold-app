# RB-AGENT-APPWIN 검증 — 2026-11-12

기준 `origin/dev b46d3d8`, 담당 브랜치 `less82/rb-agent-appwin`. 서버·웹·계약·연결 정책은 수정하지 않았다. 노트북 쪽의 앱 창 실행, 기본 브라우저로 서버 원점 열기, 안내 문구, 전용 링크 등록만 바꿨다.

- 실행 명령: `env -u LD_LIBRARY_PATH -u CYCLONEDDS_HOME -u CYCLONEDDS_URI PYTHONPATH=apps/agent:. /tmp/rb-depth-core-venv/bin/python -m pytest apps/agent/tests/test_desktop_browser.py apps/agent/tests/test_desktop_installer.py apps/agent/tests/test_setup_pairing.py apps/agent/tests/test_windows_installer.py apps/agent/tests/test_installer_build_permissions.py apps/agent/tests/test_wheelhouse_builder.py -q -rs`
- 결과: **202 passed, 1 skipped**. 생략은 `FH_INSTALLER_TEST_CACHE`가 있어야 실행하는 전체 Linux 설치 파일 빌드다. 설치된 브라우저 탐색 순서·기본 브라우저 대체·Windows Edge 인자·전용 프로필·서버 연결 상태와 HTTPS 원점만 허용·정확한 관리 Origin·링크의 추가 옵션 무시·실행 중 단일 연결·Linux MIME 등록과 갱신 실패 허용·Windows HKCU 등록/제거·기존 자동 시작 선택 보존을 검사했다. Windows OS 호출은 가짜 API로 검사했다.
- Chrome 154.0.8037.97 앱 모드를 별도 임시 프로필과 모의 화면 포트 **32831**에서 실행했다. X11 전용 창 식별자로 기존 창을 다시 선택한 뒤 페이지 ID·개수(1개)가 그대로이고 `Popen`을 다시 호출하지 않음을 확인했다. 시험 전용 브라우저는 닫았다. 단순 `--app` 재실행과 Chromium `--focus`는 설치하지 않은 앱 창을 중복 생성하는 것을 관측하여 사용하지 않았다.
- Orca 브라우저에서 모의 화면을 **720×820**, **390×844**로 확인했다. 수평 넘침 없음, 수동 안내 기본 접힘, 연결 시 «서버 웹 열기» 표시와 원점만 모의 기본 브라우저 호출, 연결 대기 시 단추 숨김·코드 표시, Windows 공통 안내 전환을 확인했다. `impeccable detect` 결과는 `[]`였다.

이 PC의 실제 `127.0.0.1:9611`, 사용자 `foothold-robot` 서비스, 실제 연결 설정은 읽거나 바꾸지 않았다. 실기·DDS 참가·Gazebo·SSH·금지 포트 접촉은 없었다. `installer/smoke.py`는 9611을 사용하므로 실행하지 않았다. 실제 Windows 앱 창의 복원·Edge 프로필·레지스트리·링크 확인 대화상자·제거, 새 DEB/ZIP 전체 빌드·실설치, DISPLAY/XWayland가 없는 Wayland 전용 환경은 미검증이다.

새 Python 패키지는 추가하지 않았다. 개인 로그인과 섞이지 않도록 전용 브라우저 프로필은 앱 캐시 아래에 두며, 스냅 Chromium은 자체 상태 폴더 아래에 둔다. Linux의 창 복원은 Ubuntu Desktop의 기존 X11/XWayland 라이브러리를 `ctypes`로 사용하고 Windows는 기존 user32를 사용한다. Git push·Draft PR은 배포가 아니며 되돌림은 이 변경 커밋의 revert와 기존 설치 파일 사용이다.

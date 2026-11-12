# RB-EASY-INSTALL 검증 — 2026-11-12

기준: `83dafea`에서 시작한 `less82/rb-easy-install`, Ubuntu 24.04.5 x86_64. sudo·시스템 설치·DDS 참가·실기·운영 서버·서버 재시작·금지 포트 접촉은 하지 않았다. Docker/Podman이 없어 별도 HOME에 사용자 공간 추출로 검사했다.

| 검사 | 실제 결과 |
|---|---|
| `python3 apps/agent/installer/build.py --server https://example.invalid` | PASS, 자체 CPython 3.10.21 및 고정 wheel·SDK·도구 해시 확인, `pip check` 통과 |
| 설치 원물 | `output/easy-install/foothold-robot_0.2.0-1_amd64.deb`, **222,277,844 bytes (211.98 MiB)** |
| SHA256 | `51edad6d8f2bca38698c843f5dfe4dcd9d8107b34892e7cde4afc12e783b50b3` |
| `python3 apps/agent/installer/smoke.py output/easy-install/foothold-robot_0.2.0-1_amd64.deb --keep-open` | PASS, 9611 사전 비점유 확인, 추출 → 앱 아이콘·자동 시작·사용자 서비스 파일 → bundled preflight·cv2 → 없는 `fh-missing` NIC 안내 → 자동 시작 끄기/켜기·중복 실행 → 화면 종료 → 추출 파일 제거 → 키·옛 env 보존 |
| Orca 브라우저 | 1338×881 및 390×844 렌더 확인, «로봇을 찾지 못함»·«자동 점검 통과», 좁은 화면 가로 넘침 없음, 실제 checkbox 끄기와 종료 단추 동작 확인 |
| `pytest apps/agent/tests/test_desktop_installer.py -q` | **25 passed**, 가짜 NIC/NetworkManager·DAD 실패/변경 경합·다른 연결 제외·CSRF·자동 시작 선호·명시 NIC 부재의 DDS 미진입·가짜 로컬 세션 maintainer hooks |
| 관련 회귀 (setup pairing + readonly + installer) | 초기 21개 installer 포함 **176 passed**; 이후 추가한 installer 4개도 25개 묶음에서 PASS |
| 전체 agent 시험 | 최초 시스템 Python은 미설치 의존성으로 수집 실패; 별도 시험 venv 및 editable agent·Pydantic·Pillow·opencv 준비, Orca의 inherited loader env를 제거한 실행은 **2309 passed / 25 failed / 1 skipped** |
| 실패 원인 분리 | 그중 웹 TypeScript 추출 실패 **20개는 수정 전 HEAD archive에서도 그대로 재현**, 해당 3개 파일은 **115 passed / 20 failed**; 나머지 5개 시간 민감 실패는 낮은 부하의 관련 재실행에서 통과(런타임·미디어 45 passed, 서버 끊김 1 passed) |
| 최종 영향 회귀 | `pytest apps/agent/tests --ignore=apps/agent/tests/test_phone_policy_compat.py --ignore=apps/agent/tests/test_phone_proportional.py --ignore=apps/agent/tests/test_speed_1p5.py -q`: **2203 passed / 1 skipped**, 새 25개 포함 |
| 선택적 `slam` | 실제 pyproject는 수정하지 않음; 별도 TOML fixture에 `slam=["packaging==25.0"]`를 넣어 묶음 읽기·호환 wheel 다운로드·PyPI SHA256 대조 PASS, 현재 원본의 slam 부재는 건너뜀 |
| 정적 검사 | Python compile·`sh -n`·`git diff --check` PASS, UI mechanical detector 빈 지적 |

전체 시험 통과 조건은 **기존 실패 20개 때문에 충족하지 못했다**. 해당 시험이나 안전 기대값·웹 코드·pyproject는 수정하지 않았다. `output/easy-install/`의 시험 로그와 캡처는 로컬 원물이며 Git에 넣지 않는다.

미확인: Ubuntu 22.04 별도 OS 실행, 실제 GUI 더블클릭 설치/제거, 실제 root dpkg 설치, 설치 직후·로그인 systemd 자동 기동, Polkit 창, 실제 전용 유선 설정·중복 주소 충돌, 실기 serial·QR/저장 연결·실폰·실로봇 이동. `.deb`가 파일 관리자의 설치 관리자로 연결되는지는 대상 Desktop에서 확인해야 한다. 설치 파일은 가짜 서버 주소 전용이며 운영에 배포하지 않았다.

되돌림: 이 PR의 소스 커밋을 revert하고 검토된 이전 설치 원물을 패키지 관리자로 설치한다. 사용자 키를 지우지 않는다. Git revert만으로 노트북·서버·웹을 교체하지 않는다.

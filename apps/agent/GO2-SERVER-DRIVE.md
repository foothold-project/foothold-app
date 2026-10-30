# Go2 서버 경유 조종 시험 — 기본 꺼짐

ADR-002의 **명시적으로 선택한 시험 기체**에만 여는 예외다. 웹 담당 운영자 → 개발 서버의 기존 lease/arbiter → 이 PC가 밖으로 연 `fh-agent/2` WS → Go2Sink(`server`) → SDK/DDS 유선 NIC를 사용한다. 이 모드에는 폰 조종 리스너가 없으며, 총괄(ADMIN)은 실기 조종·STOP을 할 수 없다. 다른 운영자도 같은 조직의 STOP은 가능하다. `RobotSummary.server_drive_allowed`는 경로 표시용 bool이며 조종 권한을 대신하지 않는다.

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

## 유지되는 안전 경계

입력은 기존 normalized axes이며 출력은 `(0,0,0)`, `(0.6,0,0)`, `(0.6,0,±0.5)`만 가능하다. 웹은 **새 seq로 10~20Hz 입력**을 보낸다. 서버는 입력을 그대로 전달하며 마지막 명령을 반복하지 않는다(lease만으로 계속 움직이지 않음). 원입력이 0.30초 끊기면 Move(0)·StopMove·잠금이다. 인터넷 지연으로 자주 잠기면 올바른 실패이므로 시간을 늘리지 않고 RTT/간격을 현장 측정한다. 소켓 단절은 즉시 정지·잠금이며 재연결만으로 재개하지 않는다. 주기 tick·상태·ping은 원입력 시각을 갱신하지 않는다. STOP은 lease와 무관하게 우선하고, lease 상실은 정지한다. 정지 확인에는 신선한 일치 serial의 LowState + SportModeState를 사용하며 SDK 성공 코드는 정지 증거가 아니다. RUN·SLAM·지도 명령은 이 예외로 열지 않는다. 서버 상태에는 기존 배터리·실측 속도·latched·stop_gen·실측 후 stop_ref를 사용한다.

## 이 PC 설치·검증 기록

시스템 Python/apt 변경 없이 `runs/go2-python/`의 사용자 공간 CPython 3.10.22와 `runs/go2-x86-venv/`를 준비했다(모두 gitignore). [고정 SDK 커밋](https://github.com/unitreerobotics/unitree_sdk2_python/blob/814556d15970dd2ecf1c9984e845ca02ab07e206/setup.py)은 `814556d15970dd2ecf1c9984e845ca02ab07e206`, cyclonedds는 `0.10.2`, numpy `1.26.4`, opencv-python `4.10.0.84`, websockets `15.0.1`, zeroconf `0.148.0`이다. [공식 PyPI 파일](https://pypi.org/project/cyclonedds/0.10.2/#files)의 `cyclonedds-0.10.2-cp310-cp310-manylinux_2_17_x86_64.manylinux2014_x86_64.whl` SHA256은 `1194b03377e7644c7fb7230dd19b85eb363699d179459bdc5486974ec8d0fc0e`다. wheel과 설치 로그/해시는 `runs/go2-x86-artifacts/`에 로컬 보관한다. preflight는 패키지/커밋/wheel 해시/ELF 메타데이터만 읽고 SDK를 import하거나 DDS에 참가하지 않는다. 소스 갱신 뒤 실행은 위처럼 `PYTHONPATH=apps/agent`를 명시한다.

가짜 SDK·loopback WS 검증만 수행했다. 실기 NIC/serial·실제 STOP·인터넷 왕복·배터리/속도 실측 표시는 미검증이며, 이 문서의 설치 준비 완료는 실기 안전 검증이 아니다. 시험 종료 시 현장 STOP·정지 확인 후 에이전트를 종료하고 배포 담당자가 서버 목록에서 UUID를 제거한다. 코드 되돌림은 해당 기능 커밋의 revert로 하며 운영 교체는 별도 배포 절차다.

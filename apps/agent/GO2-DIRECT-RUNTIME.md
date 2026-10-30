# Go2 현장 실행 진입점

`python -m foothold_agent.go2_direct`는 명시적인 **실기 DDS domain 0 시작 명령**이다.
이번 검증은 가짜 DDS·SDK와 루프백 WS만 사용했다. 기체·Orin·실폰 검증은 하지 않았다.
자동 시작 서비스, 기립, 모드 전환, 학습 정책 실행은 제공하지 않는다.

## 현장 준비 설정

실기 담당자가 기체 한 대만 있는 전용 유선 NIC, 펌웨어, 독립 비상 정지 수단을
확인한 뒤 사용하는 설정이다. 공유 로봇망에는 사용하지 않는다.
현장 설정·키·표식·출입증은 Git 밖의 실행 사용자 전용 파일로 보관한다.

| 설정 | 값/조건 |
|---|---|
| `FH_GO2_DIRECT_ENABLED` | 기본 미설정. 승인 뒤에만 `1` |
| `FH_GO2_DIRECT_NIC` | 확인한 전용 로봇 NIC 이름 |
| `FH_GO2_DEDICATED_NIC` | 전용 망을 현장에서 확인한 뒤 `1` |
| `FH_GO2_FIELD_APPROVAL` | 기존 0600 승인 JSON의 절대 경로 |
| `FOOTHOLD_ROBOT_ID` | 등록한 기체 UUID (DDS 일련번호와 별도) |
| `FOOTHOLD_PHONE_HOST`, `FOOTHOLD_PHONE_PORT` | Orin의 폰 LAN 사설 IPv4와 승인한 전용 포트 |
| `FOOTHOLD_PHONE_KEY_PATH` | 기존 출입증 검증 키링 JSON 절대 경로, 사용자 소유 0600 |
| `FOOTHOLD_PHONE_ORG_ID` | 기존 출입증 발급 조직 UUID |
| `FOOTHOLD_PHONE_POLICY_NAME`, `FOOTHOLD_PHONE_POLICY_VERSION` | 확인한 기본 보행 정책 이름/판 |
| `FOOTHOLD_PHONE_REPLAY_DB` | 사용자 전용 디렉터리의 영구 재사용 방지 SQLite 경로 |
| `FOOTHOLD_PHONE_CLOCK_TRUSTED` | 현장 시각 확인 뒤 `1` |
| `FOOTHOLD_PHONE_SIMULATION` | 반드시 `0` |
| `FOOTHOLD_PHONE_ORIGINS` | 필요할 때 기존 폰 Origin 허용 목록 JSON. 기본 `[]` |

승인 표식은 기존 `v:1`, `purpose:"go2-field-motion"`, `nic`, `robot_serial`,
`expires_at` 형식을 유지한다. 실행 사용자 소유, 0600, 일반 파일, 단일 링크,
현재부터 30분 이내 만료여야 한다. 이 실행부의 `robot_serial`은 SDK LowState의
`sn[0]`과 `sn[1]`을 **앞자리 0 없는 십진수 두 개 `decimal-decimal`**로 이어 붙인 값이다.
각 숫자는 uint32 범위다. 제품 라벨의 문자열을 추측해 변환하지 않는다.
현장 담당자가 확인한 DDS 값과 표식이 맞지 않으면 SportClient를 만들지 않는다.

SDK/loader 환경(`CYCLONEDDS_URI`, `CYCLONEDDS_HOME`, `LD_LIBRARY_PATH`) 덮어쓰기는
기존 경계대로 거부한다. ROS 셸·다른 SDK 프로세스 안에 끼워 넣지 않는다.
설정·키 검증과 폰 포트 bind가 성공한 다음 DDS를 한 번 초기화한다.
5초 이내에 신선한 두 토픽과 일련번호가 확인되지 않으면 시작을 거부한다.

## 연결과 정지

설치와 현장 설정 준비가 끝난 뒤 전용 셸에서 설정을 불러오고 시작한다.
아래 `field.env`는 현장 담당자가 준비한 **검토된 사용자 전용 셸 설정 파일**이다.

```sh
set -a
. ./field.env
set +a
./go2-venv/bin/python -m foothold_agent.go2_direct
```

폰은 기존 `fh-phone/1` 출입증으로 `/phone/ws`에 접속한다. 상태 전용 8자리 현장 코드는
조종 인증이 아니다. 기존 폰 인증·한 lease·STOP·세대 검사·새 중립 입력을 그대로 거친다.
폰 화면에서 실기 UUID/출입증/직접 WS/STOP 화면까지 진입하는 연결은 Claude 담당 후속
작업이다. 기존 «Go2 상태 보기» 화면만으로 이 WS에 접속하거나 조종할 수는 없다.

시작은 잠금 상태다. 새 센서 정지 확인 → 명시적 STOP 해제 → 새 중립 입력 뒤에만 이동한다.
명령은 기존 네 개 `(0,0,0)`, `(0.6,0,0)`, `(0.6,0,-0.5)`, `(0.6,0,0.5)` 그대로다.
폰 입력 시각과 출력 시각을 따로 감시하므로 Core의 주기 출력·센서 콜백은 폰 입력의
0.30초 마감 시각을 연장하지 못한다. 만료하면 0/StopMove/잠금이며 자동 재개하지 않는다.
센서가 0.20초를 넘기거나 비정상 상태가 되면 소유 루프에서 잠근다. 소유 루프가 멈추면
출력 부품의 독립 0.30초 감시가 정지를 시도한다. 표식 만료·출력 작업 실패·기체 ID 충돌은
프로세스를 종료하며, 정지 출력은 네트워크 정리 전에 요청한다.

## 실제 관측 → Core 연결 규칙

- LowState `sn` 일치, 증가하는 uint32 `tick`(wrap 허용), 원래 단조 수신 시각을 사용한다.
- SportModeState에는 기체 ID가 없다. 같은 전용 NIC에서 일치한 LowState가 0.20초
  이내일 때만 받아들이며, 양수이고 엄격하게 증가하는 `stamp`만 받는다. 재전송·역행·
  상수/미설정 stamp는 정지 확인을 갱신하지 못한다. 두 토픽 모두 0.20초 이내여야 한다.
- 다른 LowState ID를 한 번이라도 관측하면 재시작과 현장 검토 전까지 거부한다.
  이 결합은 **암호학적 DDS 신원 인증이 아니다**. 공유 NIC·여러 발행자는 허용하지 않는다.
- 정상 준비 관측은 문서화된 일반 모드 0/1/3, error_code=0, progress=0,
  body_height 0.20~0.50m, 유효한 roll/pitch와 기울기 60도 미만으로 좁힌다.
  SDK의 Move 수용/펌웨어 준비 완료를 보장하는 신호로 주장하지 않는다.
- 정지 관측은 sport 몸 속도 세 축 각각 절댓값 ≤0.02m/s, yaw speed ≤0.03rad/s,
  LowState gyro 세 축 ≤0.05rad/s, 다리 12개 관절 속도 ≤0.10rad/s를 모두 요구한다.
  이 보수적인 기준과 센서 값의 실제 의미는 펌웨어별 현장 대조가 필요하다.
- 콜백 당시의 출력 정지 세대·로컬 순번·수신 시각으로 `confirm_stopped`를 호출한다.
  STOP 이전 관측, 다른 세대, 같은 순번, 낡은 관측으로 새 STOP을 확인하지 않는다.
  실제 정지 관측과 로컬 출력 잠금을 함께 Core의 `stop_requested`로 전달한다.
  해제 요청 뒤 새 관측에서 출력 잠금이 풀린 것이 확인되어야 Core의 재개가 완료된다.
  SDK 반환 코드·마지막 명령을 센서 피드백으로 만들지 않는다.

SDK 소스 형식: [고정 LowState](https://github.com/unitreerobotics/unitree_sdk2_python/blob/814556d15970dd2ecf1c9984e845ca02ab07e206/unitree_sdk2py/idl/unitree_go/msg/dds_/_LowState_.py),
[고정 SportModeState](https://github.com/unitreerobotics/unitree_sdk2_python/blob/814556d15970dd2ecf1c9984e845ca02ab07e206/unitree_sdk2py/idl/unitree_go/msg/dds_/_SportModeState_.py).
모드 설명: [Unitree ROS2 상태 문서](https://github.com/unitreerobotics/unitree_ros2#1-sportmode-state).

## 검증 범위

가짜 DDS·별도 가짜 SportClient 두 개·실제 루프백 WebSocket으로 기존 인증/lease를 거쳐
Move/StopMove, STOP 중 이동 관측의 재개 거부, 새 중립, 폰 단절·입력 단절·센서 단절을
시험한다. 기존 안전 셀프테스트의 기대값은 바꾸지 않는다.

```sh
FH_TEST_PORT_RANGE=9530:9549 PYTHONPATH=apps/agent python -m pytest -q \
  apps/agent/tests/test_go2_runtime.py apps/agent/tests/test_go2_feedback.py \
  apps/agent/tests/test_go2_runtime_config.py apps/agent/tests/test_go2_direct.py
```

실기 승인·APK 연결·실제 제동 시간·펌웨어 필드/모드 의미·DDS 외부 라이브러리·
NIC 독점·멀티캐스트·기체 측 failsafe는 현장 확인 항목이다. 소프트웨어 0.30초는 물리적
정지 시간 보장이 아니다. 진행 중 SDK 호출과 프로세스/네트워크 장애 한계는 기존
[설치 문서](../../deploy/jetson/README.md)와 같다.

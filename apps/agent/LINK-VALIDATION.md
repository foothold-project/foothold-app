# W3-A 서버 연결부 검증 기록

2026-10-19, `feature/agent-link`, 기준 `origin/dev`의 W1-A 안전 Core 합침 이후.
소유·변경은 `apps/agent/**`뿐이다. `safety/core.py`·기존 두 시험 파일·상수·기대값 변경 0.

## 결과와 범위

- sans-I/O `link/session.py`: 주입 단조 시계, 초기 잠금, lease·seq·새 중립·CAS unlock,
  사람 deadman, RUN 로컬 실행기 감시, 마지막 서버 프레임부터 3 s 검출·0~30 s 유예,
  지점 대기, 재연결 그 자리 정지 후 hello와 실행/lease 사본, 즉시 state 넘김 확인.
- `link/client.py`: 선택 의존성 `websockets==15.0.1`, 환경 변수 주소·에이전트 토큰,
  지수 재연결, 독립 20 Hz 감시, 쓰기 시간 제한, 명령 자동 재시도 없음,
  로컬 출력부터 적용한 뒤 hello/state 전송, 취소·로컬 포트 오류 시 정지 시도.
- `link/interfaces.py`: 비블로킹 MotionSink/Executor 프로토콜. 시험용 가짜만 구현.
  신선한 로컬 bridge 상태 없이 Core를 해제하거나 움직이게 하지 않는다.

Python 3.12.3 / pytest 9.1.1 / websockets 15.0.1, 별도 임시 가상환경에서 실행했다.
명령의 `python`은 해당 환경의 Python이다(시스템에는 `python3`만 있다).

| 명령·검사 | 결과 |
|---|---|
| `python -m pytest apps/agent -q` | 최초 제출 79 passed → 검토 수정 후 116 passed, 기존 32 포함, skip 0 |
| `python apps/agent/tools/check_link_mutations.py` | 최초 10/10 → 검토 수정 후 17/17 변이를 pytest assertion 실패로 검출 |
| `git diff --check` | 통과 |
| Core·기존 시험의 기준 대비 diff | 0 |

수동 deadman은 정확히 0.3 s에서 이전 Core대로 유지, 초과 시 0·입력 폐기·새 중립이며
잠금 추가 0이다. 새 명령을 받기 **전에** 만료를 판정해서 늦은 비영 입력으로 deadman을
피할 수 없다. 연결 검출은 정확히 3 s, 유예 만료는 마지막 프레임으로부터 설정값에 도달한
때다. 30 s 설정에서 29.95 s 진행·30 s 정지, 0/3 s 설정에서 검출 즉시 정지를 확인했다.

가짜 서버는 같은 프로세스 asyncio, `127.0.0.1`에 OS가 정한 임의 포트만 사용했다.
인증 헤더·hello.proto·정지/hello 순서·넘김 state 확인 2 s 이내·실제 재접속,
서버 ping 중 수동 입력 단절, handshake 지연 중 감시, 쓰기 지연 중 감시,
503 응답에 대한 지수 대기, 프로토콜 불일치 응답/닫기 후 정지·재접속을 검증했다.
잘못된 JSON·모르는 메시지와 결정적 무작위 잘못된 필드 200개도 무동작·무예외로 확인했다.

ROS·Nav2·Gazebo·운영 포트·운영 서버·실폰·실로봇 접촉 0. 실제 TLS 서버 인증·실행 계획
해석·충돌 감시·실측 속도·정지 거리·20 Hz 실시간 스케줄링·패키지 배포는 미검증이다.
가짜 bridge의 STOP/해제 확인은 실제 장치의 확인을 대신하지 않는다.

## 변이 시험

`tools/check_link_mutations.py`는 임시 패키지 사본만 바꾸며 본 작업 트리 Core를 바꾸지 않는다.
Session 변이는 `test_link_session.py`, Client 종료 변이는 취소 회귀 시험을 실행해
assertion 실패가 나야 검출로 센다(수집 오류 제외).

| 일부러 깨뜨린 판정 | 결과 | 주 검출 시험 |
|---|---|---|
| 무수신 검출 `>=3` → `>3` | 검출 | 유예 0/3/30 경계 |
| 유예 기점을 검출 시각으로 3 s 늦춤 | 검출 | 유예 3/30·마지막 프레임 기점 |
| lease 폐기 시 controller만 지우고 잠금·입력 폐기 생략 | 검출 | null 즉시 폐기·직접 lease 변경 |
| 중복 seq 허용 | 검출 | 동일 seq 거부 |
| 재연결 때 STOP 잠금 생략 | 검출 | 그 자리 정지 후 hello·반개방 연결 복구 |
| unlock stop_gen 확인 생략 | 검출 | 세대·lease·로컬 확인 관문 |
| 자율 실행기 watchdog 제거 | 검출 | 서버 ping/cmd로 로컬 감시 대체 불가 |
| deadman 0.3 → 0.6 s | 검출 | 0.3 s 초과 및 늦은 비영 cmd 거부 |
| 새 중립 관문 제거 | 검출 | 넘김·unlock·deadman 후 새 중립 |
| 전진 속도 0.6 → 1.2 | 검출 | 에이전트 속도 한계 |

최초 새 시험에서 DEAD 상수를 구현과 같이 읽어 deadman 연장 변이를 놓쳤다.
새 연결부 시험의 시간 기준을 명세의 0.3 s 리터럴로 고친 뒤 검출됨을 확인했다.
기존 시험을 바꾼 것은 아니다. 이 표는 선정한 변이의 결과이며 전체 결함 검출 주장이 아니다.

## 문서 모호점·후속 계약 결정 (명세 파일 수정 0)

1. **프로토콜 협상**: 05 §10 제목의 `fh-agent/1`은 `/` 때문에 HTTP WebSocket
   subprotocol token으로 사용할 수 없다. 조정 답변에 따라 협상 헤더를 생략하고
   `hello.proto="fh-agent/1"`을 보낸다. 다른 proto 응답/명시적 닫기 이유는 정지·잠금 후
   재접속한다. 이 필드·거부/닫기 형식은 정본 문서 후속 반영 대상이다.
2. **봉투·크기·순번**: §9의 flat `{t,...body}`와 4 KiB 제한을 에이전트에도 적용했다.
   §10에는 별도 봉투·id/robot 필요 여부·크기·seq 초기값/상한·재연결 때 seq 범위가 없다.
   이 구현은 seq를 0 이상 정수로 받고 lease 변경 때만 초기화하며 동일 lease 재연결에서는
   마지막 seq를 보존한다. 클라이언트는 인증된 한 로봇 연결로 취급한다.
3. **RUN lease 연결/잠금 해제**: 04 §4.2는 주인을 `RUN:<run_id>`로 쓰고 05는 holder_type을
   `RUN`으로 쓴다. 두 표기를 모두 받아 후자는 미지정, 전자는 실행 ID를 보존해 대조하며
   holder/실행 ID만 달라져도 즉시 0·입력 폐기한다. lease의 독립 run_id 필드와 run.start의
   lease_id는 여전히 없다. 현재 RUN lease와 맞는 run.start 하나만 수락하며 실제 계획
   실행은 하지 않는다.
   자동 unlock은 하지 않는다. Core에 필요한 로컬 STOP/해제 피드백은 이후 ROS 다리가
   제공해야 하며 서버 메시지로 합성하지 않는다. 실제 자율 실행 시작·재개와 사람 unlock
   연계는 후속 서버/실행기 통합 계약 대상이다.
4. **원격측정·시각·사건**: §10.1은 로봇 상태 미수신 때의 필드 null 허용 여부와 mode 값,
   run progress 형식, 사건 시각/코드 목록을 명시하지 않는다. 이 범위에서는 없는 측정치를
   null로 두며 mode는 USER/RUN/FREE, event.robot_at은 null·data에 단조 시각을 둔다.
   연결 사건은 메모리 순서 보존만 하며 전송 도중 끊긴 사건의 ACK/중복 제거·내구성은
   계약이 없다. Core 관찰 사건은 내부 메모리 링이며 서버용 사건 코드 매핑은 후속이다.
5. **지원 밖 메시지**: streams/map.sync/floor.set/slam/run.confirm/run.control.return은
   이 작업에서 안전하게 무시한다. 실제 미디어·지도·임무 실행·사람 확인을 구현했다고
   주장하지 않는다. 단계 진행/완료 보고와 실행 계획 유효성 검사는 후속 실행기 범위다.
6. **연결 복구/경계**: 3 s 무수신 뒤 같은 소켓에서 프레임이 다시 와도 재연결로 보아
   정지·잠금·hello하며 그 프레임의 조종 명령은 실행하지 않는다. 유예 만료와 지점 도착이
   같은 시각이면 만료를 먼저 적용한다. 재연결 hello의 lease는 상태 사본이며 서버가 lease를
   다시 확인해 주기 전에는 cmd/unlock/실행 재개를 허용하지 않는다.

넘김의 2 s 마감·새 lease 발급·실행 상태를 PAUSED로 맞추는 일은 서버 책임이다.
여기서는 로컬 정지 출력을 적용한 뒤 `state(latched=true, applied=0, 증가한 stop_gen)`를
즉시 보내는 것까지 검증했다. 몸의 속도 0 확인이나 서버 전체 넘김을 검증한 것이 아니다.
`dev` 통합은 안전 범위의 Claude·Codex 두 모델 검토와 조정 세션의 합침 관문이 남아 있다.


## Claude 검토 후 수정 (PR #8, 기준 head 42266b1)

조정 요청 범위 B1·B2·R1·R2·R4·R5·R6·R7·R10·R11을 반영했다.
수정 전 추가 시험 실행에서 **31 failed, 53 passed**를 관측했다(추가 시험 작성 시점,
두 연결부 시험 모듈). USER/RUN 전진 중 잘못된 lease가 옛 권한을 유지하는 B1,
RUN:<id> 무시, 서버 cmd가 실행기 의도를 지우는 R1, 기본 시계 API, 큐 포화 예외를
실제로 재현했다. 취소 시험은 기본 시계 오류와 분리하기 위해 명시 단조 시계로 고쳤으며,
원래 코드에서 맞던 안전 방어는 별도 변이로 제거해 새 시험이 실패하는 것을 확인했다.

| 항목 | 변경·검증 |
|---|---|
| B1 | 13종 잘못된 lease × USER/RUN, 즉시 0·잠금·입력 폐기·옛 cmd 거부·LEASE_INVALID; RUN:<id> 정규화·실행 대조·소유자 변경 폐기 |
| B2 | RUN 중 executor 0 다음 서버 N/F로 비영 출력 생성 불가; 같은 lease USER↔RUN 즉시 0·잠금·폐기; 두 변이 검출 |
| R1 | RUN 서버 cmd는 실행기 intent/intent_t/중립 관문을 그대로 두고 폐기; lease별 RUN_SERVER_CMD_IGNORED 1회 |
| R2 | 전진 중 Client.run 취소, 마지막 sink stop·0·잠금; Session.shutdown도 전진에서 검증; 두 종료 변이 검출 |
| R4 | 잘못된 실행기 축을 20 Hz로 보내도 health 갱신 안 됨, 정확히 .3 s 유지·초과 FAILED; 해당 변이 검출 |
| R5 | 재연결 lease 미확인 상태에서 독립 Core 잠금 관문을 열어도 cmd가 Core.cmd에 닿지 않음; 확인 관문 제거 변이 검출 |
| R6 | 실제 가짜 WS 연결 송신 큐 128 포화 → 즉시 정지·연결 교체·새 hello, Client.run 계속 생존; 포화 중 로컬 감시 유지 |
| R7 | MotionSink 독립 감시 계약 명시: 0.3 s 안 새 apply 없으면 0/StopMove, stop/unlock은 갱신 금지 |
| R10 | README에 /api/v1/agent/ws 예시와 05 제목 차이를 기록; 하드코딩 없음 |
| R11 | Session 기본 시계를 time.monotonic으로 지정, 시험 시계 주입 유지 |

추가 변이 7개는 RUN 서버 cmd 수락, 동일 lease holder 변경 누락, 잘못된 lease 무시,
잘못된 실행기 축도 health 갱신, lease 재확인 생략, Session 종료 잠금 제거,
Client 취소 shutdown 생략이다. 기존 10개와 함께 **17/17**을 assertion 실패로 검출했다.

R3·R8·R9·R12 구현은 조정 지시로 이번 범위에서 제외했다. R3의 출력 순서는 현재 코드
구조에 의한 보장이며 큐 삽입 순서 변이를 독립적으로 구분하는 시험은 추가하지 않았다.
R8 송신 메시지 크기 검사·R12 지원 밖 명령 거부 사건은 후속이며, R9 현장 사설 CA
설정은 미구현·미검증임을 README에 명시했다. ROS 다리·실제 sink 자체 감시·실기는
이번에도 검증하지 않았고 Core·기존 32개 시험의 판정/기대값 변경은 0이다.

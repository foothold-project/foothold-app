# W3-A 서버 연결부 검증 기록

2026-10-19, `feature/agent-link`, 기준 `origin/dev`의 W1-A 안전 Core 합침 이후.
소유·변경은 `apps/agent/**`뿐이다. `safety/core.py`·기존 두 시험 파일·상수·기대값 변경 0.

## 결과와 범위

- sans-I/O `link/session.py`: 주입 단조 시계, 초기 잠금, lease·seq·새 중립·CAS unlock,
  사람 deadman, RUN 로컬 실행기 감시, 마지막 유효 서버 봉투부터 3 s 검출·0~30 s 유예,
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
| `python -m pytest apps/agent -q` | 최초 79 → Claude 수정 116 → Codex 수정 148 → 맞물림 168 → r3 수정 174 passed, 기존 32 포함, skip 0 |
| `python apps/agent/tools/check_link_mutations.py` | 최초 10/10 → 검토 17/17 → 맞물림 32/32 → r3 39/39 assertion 검출, ERROR 0 |
| `git diff --check` | 통과 |
| Core·기존 시험의 기준 대비 diff | 0 |

수동 deadman은 정확히 0.3 s에서 이전 Core대로 유지, 초과 시 0·입력 폐기·새 중립이며
잠금 추가 0이다. 새 명령을 받기 **전에** 만료를 판정해서 늦은 비영 입력으로 deadman을
피할 수 없다. 연결 검출은 정확히 3 s, 유예 만료는 마지막 유효 봉투의 수신 시각으로부터 설정값에 도달한
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
pytest hook이 기록한 AssertionError/명시적 pytest.fail만 검출로 센다.
RuntimeError·TypeError·setup/teardown·수집/내부 오류·보고서 누락·시간 초과는 ERROR이며
검출로 세지 않는다. assertion과 실행 오류가 섞인 경우도 ERROR다.

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
   이 구현은 seq를 0~2**53-1 정수로 받고 상한 밖에서는 마지막 값을 갱신하지 않는다.
   lease 변경 때만 초기화하며 동일 lease 재연결에서는
   마지막 seq를 보존한다. 클라이언트는 인증된 한 로봇 연결로 취급한다.
3. **RUN lease 연결/잠금 해제**: 04 §4.2는 주인을 `RUN:<run_id>`로 쓰고 05는 holder_type을
   `RUN`으로 쓴다. 최종 조정 결정으로 RUN:<id>만 유효하게 받고, 접두어 없는 RUN/빈 ID는
   조종권 없음으로 처리한다. run.start·resume·실행기 명령/health는 holder_run_id와 정확히
   대조하며 holder/실행 ID만 달라져도 즉시 0·입력 폐기한다. lease의 독립 run_id 필드와 run.start의
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
6. **연결 복구/경계**: 조정 결정(아래 Codex 수정 R4)에 따라 해석 가능한 봉투만 연결
   생존으로 센다. 3 s 무수신 뒤 같은 소켓에서 유효 봉투가 다시 와도 재연결로 보아
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


## Codex 독립 검토 후 수정 (PR #8, 기준 head 7e79795)

막는 지적 0건 이후 조정 요청 R1~R5를 반영했다. 수정 전 연결부/도구 시험 모듈에서
**23 failed, 87 passed**를 확인했다. 큰 정수의 서버 축·유예 정책·로컬 실행기 축에서
OverflowError, stop 실패 뒤 apply(0) 생략과 최초 오류 덮어쓰기, 느린 handshake 뒤
백오프 초기화, 파싱 불가 프레임의 연결 유예 연장, RuntimeError/TypeError를 변이 검출로
잘못 세는 문제를 각각 재현했다. 이후 가짜 WS의 큰 정수 수신 뒤 정상 입력 복구와
실제 pytest 하위 프로세스의 AssertionError/pytest.fail/RuntimeError 유형 관찰도 추가했다.
assertion과 수집 오류를 함께 실행하는 경우의 구분 시험도 수정 전 실패를 확인한 뒤 보강했다.

| 항목 | 변경·검증 |
|---|---|
| R1 | 연결부에서 숫자 타입과 축 -1~1/유예 0~30을 float 변환 전에 검사; ±10**400도 입력 오류로 처리; 서버·실행기·정책 6개 경계와 가짜 WS 생존/정상 입력 복구 |
| R2 | stop 실패 뒤에도 apply(0)를 별도 시도; 출력 실패 뒤 unlock/비영 시도 금지; 첫 출력 오류 보존; shutdown 실패도 원래 오류를 덮지 않음; 재연결 가능한 통신 오류로 로컬 출력 오류를 숨기지 않음 |
| R3 | WS context 진입 직후부터 연결 유지 시간을 측정, disconnect 시각까지 3 s 이상일 때만 간격 초기화; 2 s handshake+1.2 s 연결에서 0.25/0.5/1.0 s 검증 |
| R4 | 조정 결정: 파싱 가능한 JSON 객체 + 비어 있지 않은 문자열 t만 생존 봉투; 미지 t 포함, 본문 오류가 명령/권한을 허용하지는 않음; 수신 최초 단조 시각 보존; 8종 잘못된 프레임 20 Hz에도 유예 0에서 3 s 검출·잠금 |
| R5 | pytest 전용 hook의 구조화 예외 유형으로 판정; AssertionError/명시적 pytest.fail만 KILLED; 실행 오류·혼합 오류·누락·시간 초과는 ERROR; 가짜 결과 6종·실제 하위 pytest 예외 3종·assertion과 수집 오류 혼합으로 구분 검증 |

R4는 정본의 «아무 프레임»을 해석 가능한 앱 봉투로 좁힌 조정 결정이다. 04/05 정본
문서는 수정하지 않았으며 후속 반영 대상이다. 잘못된 lease는 유효한 t=lease 봉투에서
즉시 권한 없음으로 처리한다. JSON 파싱 불가 프레임은 연결 시각뿐 아니라 수동 입력
시각·조종권·잠금 세대도 갱신하지 않는다. proto 불일치의 즉시 정지·재연결은 별도 유지한다.

최종 `python -m pytest apps/agent -q`: **148 passed, skip 0**(기존 32 포함).
구조화 판정으로 다시 실행한 변이는 **17/17 KILLED, ERROR 0, SURVIVED 0**이다.
Core·기존 두 시험 파일의 diff 0, 변경은 apps/agent/**뿐이며 실제 서버·ROS·Gazebo·실기
접촉은 없다. 고장 sink의 물리적 정지를 보증하는 검증은 아니며 독립 감시 구현은 후속이다.


## 합치기 전 Claude r2 권고·PR #10 맞물림 수정 (기준 head 44bf39f)

수정 전 새 Session/Client 시험에서 **13 failed, 110 passed**를 확인했다. 큰 seq의 lease
고착, 취소 중 sink 오류 흔적 소실, FREE 잘못된 lease의 세대 증가, bare RUN 권한 수락,
누락된 실행 ID 바인딩, 인증 닫기 재접속, 1012 사건 누락과 기본 재시도 간격 차이를 재현했다.
기존부터 맞던 apply(0) 단독 경로는 별도 시험과 제거 변이로 고정했다.

| 항목 | 수정·검증 |
|---|---|
| A/N1 seq | 0~2**53-1만 수락; 2**53·10**400은 마지막 seq를 오염시키지 않고 0·입력 폐기, 새 정상 중립/명령 복구; 상한 경계 수락 |
| A/N2 취소 sink 진단 | CancelledError/기존 오류는 보존하면서 output_errors에 LocalPortError(원래 cause 포함)를 붙임; Python 3.11+는 add_note도 추가; 정지·0 시도 유지 |
| A/N3 FREE invalid | 이미 조종권 없음·잠금이면 _void만 수행, 반복 잘못된 lease 3건에도 stop_gen 일정; LEASE_INVALID 사건은 유지; 실제 STOP 세대 규칙은 Core 그대로 |
| A/N5 apply(0) 단독 | 비영 apply 하나만 실패하는 _emit 단독 호출에서도 다음 apply(Z)를 시도; Client.shutdown 이중 방어에 기대지 않는 시험·변이 |
| B/I1 RUN 소유자 | USER 또는 RUN:<id>만 유효; bare RUN·빈 ID는 즉시 조종권 없음; run.start/resume/실행기 cmd·health의 실행 ID 정확 일치; 미지정 ID를 허용하는 대체 경로 제거 |
| B/I2 닫기 정책 | 4401/4403은 정지·잠금·lease 미확인 뒤 ReconnectForbidden으로 종료, 자동 재접속 0; handshake HTTP 401/403도 같은 의미로 거부; 사유 코드는 호출자에 보존 |
| B/I2 반복·사건 | 기본 1/2/4/8/10 s 백오프, 3 s 연결 유지 시만 초기화; 닫기/재시도 코드·간격 사건; 1013 반복 3회와 재접속 4회 모의 검증 |
| B/I4 두 번째 hello | 3 s 무수신 뒤 유효 ping → 같은 소켓 두 번째 hello → 서버 1012 → 새 소켓에 정지 후 hello; 1012는 재시도 대상이고 닫기/백오프 사건이 순서대로 전달됨 |

정본 05 §9.4의 4401/4403 «재연결 안 함»과 기본 1 s·최대 10 s를 적용했다. 반복되는
1013도 첫 재시도 1 s 뒤에는 같은 지수 백오프를 적용한다는 조정 요청에 맞췄다.
빠른 모의 시험에서는 Settings로 더 짧은 간격을 명시하며 기본 운영값은 그대로 검사한다.
사건은 메모리 큐 범위다. 인증 종료 시에는 연결이 없으므로 사건을 서버에 보냈다고
주장하지 않으며, 호출자가 ReconnectForbidden.close_code와 Session을 보관/진단해야 한다.

최종 시험: **168 passed, skip 0**, 기존 Core 32개 포함. 변이는 기존 17개+추가 15개,
총 **32/32 KILLED, ERROR 0, SURVIVED 0**이다. 추가 대상은 seq 상한·취소 진단·FREE 세대·
단독 0 재시도·bare RUN·시작/재개/실행기 바인딩·인증 닫기·1012·닫기/재시도 사건·백오프·
기본 간격/상한이다. Client 변이는 해당 정책 시험을 선택하며 Session 변이도 필요한 경우
WS 시험을 선택한다. assertion과 실행 오류를 구분하는 이전 판정은 유지했다.

엄격한 RUN:<id>로 인해 기존 «holder 비교 하나만 제거» 변이는 run_id 비교가 같은 변경을
항상 잡아 SURVIVED였다. 그 결과를 숨기지 않고, 검출하려던 실제 결함인 «동일 lease의
소유자(holder+run_id) 변경 검사 제거»로 변이 범위를 맞춰 두 방향 변경 시험의 실패를 확인했다.
Core·기존 두 시험 파일은 변경 0이며, 기존 연결부 모의 RUN 프레임만 새 조정 계약의
RUN:<id>로 갱신했다. 실제 PR #10 서버 통합은 조정 세션 범위이며 여기서는 가짜 서버만 사용했다.

**후속만 기록(A/N4)**: bridge 상태의 `x:10**400` 같은 큰 정수는 원본 Core.clean_state의
finite()/float 변환에서 OverflowError가 날 수 있다. Core와 on_robot_state 경로는 이번에
고치지 않았다. bridge 통합 때 범위 검사 또는 잘못된 상태 무시 방식을 별도 결정해야 한다.
ROS·Gazebo·운영 서버·실기 접촉은 이번에도 0이며 실제 sink 감시/물리 정지는 미검증이다.


## Claude r3 수정 (기준 head 4392fc7)

수정 전 연결부 시험에서 **6 failed, 126 passed**로 재시도 사건 누적, PAUSED 이유
덮어쓰기, 1013 간격 차이를 확인했다. 반복 재시도는 큐를 늘리는 대신 첫 발생 위치의
SERVER_RETRY 하나로 합쳐 attempts/first_at_s/last_at_s와 마지막 delay_s/close_code를
보존한다. 연결에서 사건을 넘기면 집계 참조를 비워 다음 단절은 새 집계로 시작한다.
독립 사건/실행 변경의 FIFO 위치는 바꾸지 않는다.

| 항목 | 수정·검증 |
|---|---|
| T1 | 가짜 시계의 단절 200회 재시도(약 2,000 s) 뒤 기본 송신 큐 128에서 첫 소켓 1회로 복구, TRANSPORT_BACKPRESSURE 없음; SERVER_LINK_LOST → PAUSED run.update → LINK_LOSS_TIMEOUT → 재시도 집계 → state 순서 보존 |
| T1 집계 | Session 단위에서도 사건 수 <128·재시도 1건·attempts=200·처음/마지막 시각 검증, 다음 단절은 새 attempts=1, 이미 반환한 사본 불변 |
| R1 | 1013은 명세대로 항상 기본 1 s 간격(가속 모의 프로필에서는 지정 초기 간격); HTTP 503 등 그 밖 오류는 기존 지수 백오프·최대 10 s 유지 |
| R2 | shutdown은 이미 PAUSED이고 이유가 있으면 보존; Client가 4401/4403 뒤 끝나도 SERVER_AUTH_REJECTED 유지 |
| R3(a) | 실제 가짜 WS Client에서 SERVER_CLOSED.retry=false와 인증 거부 대기 이유를 함께 확인, retry=True 변이 검출 |
| R3(b) | RUN:a→RUN:b 뒤 이전 실행 a가 PAUSED인 채 0.31 s 경과해도 FAILED로 바뀌지 않는 도달 가능한 전환 시험; 실행기 감시 소유자 조건 제거 변이 검출 |
| R4 | connect도 기존 PAUSED 이유를 보존; OPERATOR·LINK_LOSS_TIMEOUT을 hello/종료 후 유지, 움직이던 실행만 새 RECONNECTED 대기 이유 생성 |

R3(b)는 검토에서 등가로 분류됐으나, 감시가 PAUSED 실행도 포함하므로 소유자가 바뀐
이전 실행 스냅샷에는 차이가 있다. 이 경로를 정상 lease 전환과 시간 경과만으로 검증했고,
해당 guard는 유지하며 이유를 코드 주석에 적었다. 인위적으로 RUNNING 상태를 만들지 않았다.
R1은 이전 기록의 «1013 반복도 지수 증가» 선택을 폐기하고 05 §9.4의 고정 1 s로 맞춘다.
정본 파일은 바꾸지 않았다.

최종 `python -m pytest apps/agent -q`: **174 passed, skip 0**, 기존 32 포함.
`python apps/agent/tools/check_link_mutations.py`: **39/39 KILLED, ERROR 0, SURVIVED 0**.
추가 7개는 재시도 집계 제거·집계 카운터 동결·종료/재연결 이유 덮기·인증 닫기 사건을
재시도 가능으로 표시·이전 PAUSED 실행의 소유자 guard 제거·1013 지수 백오프 복귀다.
기존 지수 백오프 변이는 1013 고정 시험 대신 실제 모의 HTTP 503 반복 시험으로 검증한다.
Core·기존 두 시험 파일 diff 0, apps/agent/** 밖 변경 0, 실서버·ROS·Gazebo·실기 접촉 0이다.
이 집계는 메모리 범위이며 전송 중 단절의 ACK/중복 제거·디스크 내구성을 추가한 것은 아니다.

## PR #10 독립 검토 B1 조정 계약: stop_ref (4552c06 이후)

이 절은 서버 작업자가 조정 세션의 명시적 확장 소유 범위에서 작성했다. dev에 합쳐진
PR #8 e0cd274를 서버 브랜치에 일반 merge한 뒤 `link/session.py`와 새 시험·변이 도구만
고쳤다. `safety/core.py`, 기존 Core 시험2개와 안전 상수/기대값은 변경하지 않았다.

서버의 STOP 확인을 stop_gen 증가 추정에서 **이번 STOP의 인과 식별자** 대조로 바꿨다.

- server→agent stop에는 `stop_ref: int`(1~2**53-1)가 있다. 에이전트는 lease/user 확인을
  기다리지 않고 기존 Core.stop을 호출한다. 그 뒤 Core가 latched이고 applied=0일 때만
  유효한 ref를 보관한다. Client의 로컬 motion 적용 후 state 송신 순서는 그대로다.
- agent→server state에는 `stop_ref`(0~2**53-1)를 넣는다. 0은 해당 서버 연결에서 적용한
  STOP이 없다는 뜻이다. lease-null·로컬 STOP 자체로 새 서버 ref를 만들거나 추정하지 않는다.
  새 connect마다 ref를0으로 비워 이전 연결/서버 epoch의 응답을 재사용하지 않는다.
- 잘못된 ref(null·0·음수·bool·실수·2**53)는 STOP 자체를 막지 않지만 새 ref를 확인하지 않는다.
  정지 적용 전 상태(미잠금 또는 비영 applied)도 새 ref를 확인하지 않는다.
- seq·unlock stop_gen·stop_ref는 같은 2**53-1 상한을 쓴다. 원본 Core의 내부 stop_gen이
  그 범위를 소진하는 극단 경계에서는 링크가 STOP_GEN_EXHAUSTED를 기록하고 조종권
  확인을 무효화한다. wire 세대는 상한에서 포화 표시하고 ref는0으로 두므로 새 grant를
  확인할 수 없다. Core 내부 정수/잠금/CAS를 수정하거나 wrap하지 않는다.
- 서버는 같은 ref + latched + applied0을2 s 안에 받아야 take/넘김을 완료한다. 늦은 이전
  반납/취소 state와 로컬 STOP이 섞여도 새 grant를 만들 수 없다. 마감과 새 grant는 서버 책임이다.

새 `tests/test_stop_reference.py`는 ref 회신·잘못된 입력6종·재연결 초기화·미적용2종·
unlock 경계·세대 소진2종을 검사한다. 서버의 새 회귀는 실제 Session으로 검토 재현을
옮겨 이전 반납 state를 새 STOP을 전달하기 전에 주입한다. 이는 단순 +1 가짜 모델을
보완하는 시험이며 실제 기체의 물리적 정지 확인은 아니다.

서버·agent의 계약 변경은 함께 갱신해야 한다. stop_ref가 없는 구버전은 새 서버에서
정지 확인을 완료하지 못한다. 이 작업에서 Client의 사건 큐/오프라인 내구성·ROS 다리·
실제 sink·안전 Core 정책은 바꾸지 않았다. 실제 uvicorn 통합은 loopback 포트0의 OS 배정
fd와 기존 임시 PostgreSQL, 메모리 fake bridge/sink로만 실행한다. 운영8453/8792·ROS·
Gazebo·실기 접촉0, 배포 없음이다.

### 이번 실행 결과

- `PYTHONPATH=apps/agent python -m pytest apps/agent/tests -q`: **187 passed** (4.56 s), 기존 Core32개 포함.
- `PYTHONPATH=apps/agent python -m pytest apps/server apps/agent/tests -q`: **419 passed**
  (서버232+에이전트187, 106.24 s), Starlette 안내1건, skip0.
- `python apps/agent/tools/check_link_mutations.py`: **46/46 KILLED**, ERROR0·SURVIVED0.
  기존39개+ref회신/범위/잠금/적용0/재연결·unlock상한·wire세대포화7개다.
- 실제 uvicorn+현재 Client: take→unlock→중립→비영 cmd→요청/수락 넘김→STOP 통과.
  별도 소유 잠금 소실→1013재시도3회 이상→해제 후 인증된ping복귀도 **1 passed** (7.43 s).
- 생성물61개 일치·wire객체 소비 tsc·Alembic 왕복 통과. 서버 검증 수정표는
  `apps/server/REALTIME-VALIDATION.md`의 Codex 독립 검토+Claude r3 절을 참조한다.

### 이번 최종 변이 표

| Mutation | Result | Assertion-failing tests |
|---|---|---|
| loss boundary >3s | KILLED | test_loss_detection_3s_and_grace_from_last_frame_boundary[0], test_loss_detection_3s_and_grace_from_last_frame_boundary[3], test_loss_detection_3s_and_grace_from_last_frame_boundary[30] |
| grace starts at detection | KILLED | test_loss_detection_3s_and_grace_from_last_frame_boundary[3], test_loss_detection_3s_and_grace_from_last_frame_boundary[30], test_last_any_frame_not_remote_timestamp_drives_loss_and_grace |
| lease drop keeps old intent | KILLED | test_lease_null_is_immediate_even_if_stop_never_arrives, test_changed_lease_without_null_stops_and_locks, test_invalid_lease_revokes_authority_immediately[USER-frame0] |
| RUN accepts server cmd | KILLED | test_run_server_cmd_cannot_create_movement_between_executor_ticks, test_run_server_cmd_leaves_executor_intent_and_neutral_gate_untouched |
| same lease owner change missed | KILLED | test_qualified_run_holder_is_normalized_bound_and_switch_discards_input, test_same_lease_holder_change_immediately_zero_latches_discards[USER-RUN], test_same_lease_holder_change_immediately_zero_latches_discards[RUN-USER] |
| invalid lease ignored | KILLED | test_invalid_lease_revokes_authority_immediately[USER-frame0], test_invalid_lease_revokes_authority_immediately[USER-frame1], test_invalid_lease_revokes_authority_immediately[USER-frame2] |
| invalid executor axes refresh health | KILLED | test_invalid_executor_axes_at_20hz_do_not_refresh_watchdog |
| unconfirmed lease cmd accepted | KILLED | test_unconfirmed_lease_cmd_never_reaches_core_even_with_other_gates_open |
| session shutdown has no latch | KILLED | test_shutdown_from_moving_state_outputs_stop_zero_and_latch |
| client cancellation has no shutdown | KILLED | test_cancel_while_moving_requests_stop_zero_and_latch |
| seq upper bound removed | KILLED | test_seq_upper_bound_cannot_poison_lease[past-json-safe], test_seq_upper_bound_cannot_poison_lease[huge] |
| cancel output failure trace removed | KILLED | test_cancelled_error_retains_shutdown_sink_failure_trace |
| invalid FREE lease advances generation | KILLED | test_invalid_free_lease_does_not_increment_an_already_locked_generation |
| standalone zero fallback removed | KILLED | test_nonzero_apply_failure_alone_attempts_zero_without_shutdown |
| bare RUN owner accepted | KILLED | test_run_owner_without_nonempty_qualified_id_revokes_authority[RUN] |
| run start binding removed | KILLED | test_qualified_run_holder_is_normalized_bound_and_switch_discards_input, test_run_start_requires_matching_bound_owner_even_with_other_gates_open |
| run resume binding removed | KILLED | test_qualified_run_holder_is_normalized_bound_and_switch_discards_input, test_run_resume_requires_matching_bound_owner_even_with_other_gates_open |
| executor command health binding removed | KILLED | test_executor_requires_exact_owner_for_commands_and_health[None], test_executor_requires_exact_owner_for_commands_and_health[other-run] |
| authorization close retried | KILLED | test_authorization_close_is_terminal_and_stops_without_reconnect[4401], test_authorization_close_is_terminal_and_stops_without_reconnect[4403] |
| 1012 incorrectly terminal | KILLED | test_second_hello_1012_reconnects_and_records_close_and_backoff |
| close event removed | KILLED | test_second_hello_1012_reconnects_and_records_close_and_backoff |
| retry event removed | KILLED | test_repeated_1013_close_uses_fixed_interval_and_records_each_attempt |
| retry backoff fixed | KILLED | test_exponential_backoff_against_same_process_rejecting_server |
| default retry interval shortened | KILLED | test_default_close_backoff_matches_api_spec |
| default retry cap lowered | KILLED | test_default_close_backoff_matches_api_spec |
| offline retry aggregation removed | KILLED | test_offline_retry_summary_is_bounded_and_retains_count_and_time_range |
| offline retry counter frozen | KILLED | test_offline_retry_summary_is_bounded_and_retains_count_and_time_range |
| shutdown pause reason overwritten | KILLED | test_client_auth_close_preserves_paused_reason_and_nonretry_event[4401], test_client_auth_close_preserves_paused_reason_and_nonretry_event[4403] |
| reconnect pause reason overwritten | KILLED | test_reconnect_and_shutdown_preserve_existing_pause_reason |
| fatal close event marked retryable | KILLED | test_client_auth_close_preserves_paused_reason_and_nonretry_event[4401], test_client_auth_close_preserves_paused_reason_and_nonretry_event[4403] |
| old paused run health watched under new owner | KILLED | test_paused_old_executor_is_not_failed_after_owner_changes_to_another_run |
| 1013 incorrectly uses exponential backoff | KILLED | test_repeated_1013_close_uses_fixed_interval_and_records_each_attempt |
| duplicate seq accepted | KILLED | test_non_increasing_and_malformed_seq_discard_input[2] |
| reconnect has no STOP latch | KILLED | test_next_waypoint_wait_wins_before_grace_and_cannot_auto_resume, test_reconnect_stops_before_hello_with_lease_run_copy_and_events_in_order, test_half_open_link_resuming_also_stops_and_hello |
| unlock ignores generation | KILLED | test_unlock_requires_current_lease_integer_generation_and_local_confirmation, test_unlock_safe_integer_upper_bound |
| executor watchdog disabled | KILLED | test_executor_watchdog_uses_local_commands_even_when_server_pings_and_cmds, test_invalid_active_run_control_fields_do_not_crash_or_change_status, test_invalid_executor_axes_at_20hz_do_not_refresh_watchdog |
| deadman lengthened | KILLED | test_deadman_exact_boundary_no_new_lock_and_cannot_bypass_with_late_cmd, test_executor_watchdog_uses_local_commands_even_when_server_pings_and_cmds, test_invalid_active_run_control_fields_do_not_crash_or_change_status |
| fresh neutral bypassed | KILLED | test_handoff_state_ack_then_new_lease_locked_and_new_neutral, test_changed_lease_without_null_stops_and_locks, test_deadman_exact_boundary_no_new_lock_and_cannot_bypass_with_late_cmd |
| server axes exceed speed cap | KILLED | test_lease_null_is_immediate_even_if_stop_never_arrives, test_handoff_state_ack_then_new_lease_locked_and_new_neutral, test_changed_lease_without_null_stops_and_locks |
| STOP reference echo removed | KILLED | test_stop_reference_echo_only_after_latched_zero, test_invalid_reference_still_stops_without_acknowledging[None], test_invalid_reference_still_stops_without_acknowledging[0] |
| STOP reference upper bound removed | KILLED | test_invalid_reference_still_stops_without_acknowledging[9007199254740992] |
| STOP reference latch guard removed | KILLED | test_unapplied_stop_never_echoes_new_reference[unlatched] |
| reconnect retains old STOP reference | KILLED | test_reference_boundary_and_reconnect_epoch |
| unlock generation upper bound removed | KILLED | test_unlock_safe_integer_upper_bound |
| STOP reference zero-output guard removed | KILLED | test_unapplied_stop_never_echoes_new_reference[nonzero] |
| wire generation exceeds safe integer | KILLED | test_core_generation_exhaustion_is_bounded_and_never_confirms[connect], test_core_generation_exhaustion_is_bounded_and_never_confirms[stop] |

## W4-B 후속 보완 (2026-10-19, 기준 dev 17b73e7)

안전 Core와 `test_original_core.py`·`test_core_boundaries.py`는 변경 0이다. 링크와 시험·도구·문서만
고쳤으며 화면 계약 fh-rt/1은 그대로다. 서버 쪽 결과는 REALTIME-VALIDATION의 W4-B 절을 본다.

| 항목 | 동작·회귀 |
|---|---|
| 오프라인 Session 버퍼 | 사건·run.update 최대 255건 + 누락 요약 1건. 일반 사건을 먼저 버리고 안전 사건만 남으면 가장 오래된 것을 버린다. `test_offline_buffer_is_bounded_and_loss_is_counted`는 1000건에서 상한·안전 사건·누락 합계를 검사한다. 버퍼 상한 제거 변이가 실패한다. |
| 송신 큐·첫 재연결 | 128건 개별 메시지 + state/ACK 최신 각 1건. hello, state, 안전 사건을 앞서 전송한다. 초기 이력은 비동기 배압으로 전달해 writer가 시작하기 전에 큐가 포화되는 것을 막는다. 255건 이력을 첫 연결 한 번으로 보내고 순서를 검사한다. 동기 주입·state 우선 제거 변이가 실패한다. |
| 느린 송신/실패 | 쓰기는 200 ms 상한이며 로컬 20 Hz 감시는 계속된다. 포화는 즉시 0·잠금·입력 폐기 및 해당 연결 재접속이다. 미송신 사건과 실패 중인 마지막 쓰기는 상한 안에서 재보관하며 이전 state/ACK는 재전송하지 않는다. 서버 ACK가 없어 마지막 쓰기는 중복 가능하다. 실패 쓰기의 이력 순서와 옛 telemetry 폐기를 검사한다. |
| P1 대기 이유 | transport_overflow·protocol_mismatch도 기존 PAUSED 이유를 보존한다. LINK_LOSS_TIMEOUT을 주입한 매개 시험과 두 변이가 이를 검사한다. 새 STOP/OPERATOR 원인은 계속 새 이유다. |
| P2 retry 요약 위치 | 첫 재시도 위치 1건이 attempts·first_at_s~last_at_s 범위를 요약한다. 뒤 사건보다 last_at_s가 늦을 수 있고, 안전 우선 송신도 전체 사건의 시각순 정렬을 뜻하지 않는다. README에 명시했다. |
| proto | fh-agent/2로 올렸다. 추가 조정 결정: 4406 + PROTOCOL_MISMATCH이면 즉시 0·잠금·조종권 확인 폐기 후 최소 30초 재연결 대기다. 4401/4403 영구 중단 및 1013 고정 1초는 유지한다. 긴 프로토콜 대기는 시험에서 요청 간격을 관측한 뒤 가상화/취소했다. 실제 uvicorn에 fh-agent/1을 선언하는 Client로도 확인했다. 미갱신 옛 바이너리의 재시도 간격을 서버만으로 바꿀 수는 없으므로 동시 갱신을 문서화했다. |
| bridge 큰 정수 | float 범위 밖 정수를 Core 호출 전 거부하고 BRIDGE_STATE_INVALID를 남긴다. 표시 x/sim_t, cmd_applied, episode의 양/음 10**400은 예외 없이 0·잠금 유지, Core state_seq·생존 시각 미갱신이다. 범위 검사 제거 변이는 명시적 시험 실패로 검출한다. |

각 큐는 메모리 유한 버퍼다. 포화 때 누락을 요약하지만 디스크 내구성·수신 ACK·정확히 한 번 전달·
프로세스 재시작 뒤 복구를 구현한 것은 아니다. 사건 종류에 따라 우선순위가 달라지므로 일반 사건끼리의
FIFO와 안전 사건 우선 보장을 구분한다. 실제 sink의 독립 watchdog·물리적 정지는 여전히 후속 범위다.

실제 uvicorn + 현재 Client의 정상/300 ms DB 지연 + 400 사건 backlog 조건에서
`take → unlock → 새 중립 → 비영 명령 → 요청/수락 넘김 → STOP`을 통과했다.
모든 네트워크 시험은 loopback 임시 fd/포트 0 및 가짜 bridge/sink였다. ROS·Gazebo·실기·운영 포트·배포 접촉 0이다.

### W4-B 실행 결과

| 명령 (Python은 전용 venv) | 실제 결과 |
|---|---|
| `PYTHONPATH=apps/agent python -m pytest apps/agent/tests -q` | **202 passed**, 5.62 s, skip 0 |
| `python apps/agent/tools/check_link_mutations.py` | **53/53 KILLED**, ERROR·SURVIVED 0. 기존 46 + 버퍼 상한·두 대기 이유·큰 정수·state 우선·첫 replay 배압·30초 protocol 대기 7개. |
| `PYTHONPATH=apps/agent python -m pytest apps/server/tests -q` | **245 passed**, 실제 서버/Client 정상·DB 지연/backlog·옛 proto 경로 포함 |
| 생성물·wire 소비 tsc·Python/JSON Schema wire 대조 | **61개 일치 / exit 0 / 1 passed** |
| 실제 지연·Client 통합 단독 재실행 | **6 passed**, 최종 25 ms 갱신에서 함수 앞/연결 점유 × 0.3/0.45초 모두 40/40, take→넘김→STOP (이전 부하 표본 32~40/40도 서버 표에 보존) |

별도 실패 쓰기 시험은 FIRST→SECOND→연결 종료 사건의 미송신 복구 순서를 확인하고 옛 state/ACK를 폐기한다.
변이의 수집·실행 오류는 KILLED에 포함하지 않는다. 프로토콜 불일치 30초는 실제 시간 30초를 기다렸다는
뜻이 아니라 Client가 선택한 대기 간격과 그동안의 안전 상태를 관측한 결과다.

최종 제출 사본의 서버 변이도 **91/91 assertion 검출**, exit 0, 실행/수집 오류·생존 0이다.
서버 전체 최종 실행은 **245 passed (165.96 s)**였다. agent Core 및 기존 Core 시험 변경은 0이다.

## PR #13 두 모델 검토 보완

앞 W4-B 절은 `d371f0d` 당시 기록이다. 아래가 현재 버퍼·FIFO·포화 동작이며,
안전 사건 축출·안전 우선 재정렬·프로세스 전체가 RAM뿐이라는 설명을 대체한다.

| 지적 | 현재 동작과 회귀 |
|---|---|
| 안전 사건 축출 | 255건 RAM, 일반 사건 우선 생략과 LINK_BUFFER_DROPPED count. 안전 전용 포화는 SQLite 초과분 파일로 보존한다. 일반 사건은 안전 사건을 축출하지 못한다. 1000건 안전 사건 + 일반 사건 + 앞에 복원한 실패 쓰기를 작은 묶음으로 비워 원래 순서와 count를 검사한다. 저장소별 파일 독립성과 서버 포화 보존도 서버 표에 있다. |
| 사건 재정렬 | hello·최신 state/ACK만 사건을 앞선다. 사건/run.update는 연결 중 새 사건까지 같은 FIFO 펌프를 거치며 128건 송신 큐의 공간을 기다린다. 255건 이력은 첫 연결에 전송하고 새 이력이 무제한 RAM 튜플로 커지지 않는다. 사건 FIFO 역전·동기 송신 포화 변이가 실패한다. |
| 재시도 이력 | 실패 쓰기를 복원해도 SERVER_RETRY 첫 위치·횟수·시간 범위를 이어 간다. 전부 안전 사건으로 찼으면 일반 재시도 기록은 생략 수에 포함하며 안전 사건을 바꾸지 않는다. SERVER_CLOSED 개별 내역은 유지한다. |
| 프로토콜·로컬 오류 | 4406+PROTOCOL_MISMATCH 및 옛 서버 4403+PROTOCOL_MISMATCH*는 0·잠금·기존 대기 이유 보존과 30초 이상 대기다. 다른 4401/4403은 영구 중단이다. 파일 I/O가 shutdown 기록까지 막아도 물리 STOP·apply(0)를 별도로 시도한다. |

초과분 파일은 프로세스 수명 동안의 배압 장치이며 재시작 저널이 아니다. 서버 ACK가 없어
hello 직후 거절 또는 마지막 쓰기의 원격 도달/DB 저장 여부는 알 수 없다. 이 한계는
README·PR에 명시하며 정확히 한 번 전달을 주장하지 않는다. Core와 기존 Core 시험 변경은 0이다.

### PR #13 최종 실행 결과

- agent pytest: **220 passed** (기존 Core 포함).
- agent 변이: **62/62 KILLED, exit 0**, ERROR·SURVIVED 0. 프로토콜 정지는 writer 취소 gate보다 앞서는지 RUN 비영 출력에서 검사한다. 이전 실행의 비고유 anchor와
  FIFO 위반의 KeyError는 검출로 세지 않았고, assertion으로 판정하도록 시험을 고친 뒤 전체 재실행했다.
- 서버 전체 **267 passed, 1 warning in 165.38s (0:02:45)**(변이 도구 정상 기준 실행, 실제 Client 정상/300 ms DB 지연 + 400건 backlog 통합 포함), 계약 생성물 **61개 일치**, wire 소비 tsc **exit 0**, Python/JSON Schema wire 대조 **1 passed**다. 서버 변이는 **108/108 assertion 검출, exit 0**, ERROR·MISSED 0이다. 상세 부하 표본과 재-take·거부 수는 서버 검증표에 적었다.

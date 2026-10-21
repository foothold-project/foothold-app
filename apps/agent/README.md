# FOOTHOLD 로봇 에이전트 — 안전 Core + 서버 연결부

Python 3.10 이상. `sim/v2_link.py`에서 이식한 안전 Core와 ROS 없는 서버 연결 상태
기계다. Core 판정·상수·기존 시험은 변경하지 않았다([PORTING.md](PORTING.md)).
표준 라이브러리만으로 import하며, 네트워크는 `Client.run()`을 명시적으로 실행할 때만
사용한다. 로봇 실행 진입점·ROS·Nav2·실제 MotionSink 구현은 포함하지 않는다.

```sh
# pytest + 선택 연결 의존성 (실행 라이브러리는 websockets 하나, 정확한 버전 고정)
python3 -m pip install -e './apps/agent[test,link]'
python3 -m pytest apps/agent -q
python3 apps/agent/tools/check_link_mutations.py
```

환경 변수 `FOOTHOLD_AGENT_WS_URL`, `FOOTHOLD_AGENT_TOKEN`을 실행 환경에서 설정하고
`Settings.from_env()`로 읽는다. 주소 예시는 `wss://example.invalid/api/v1/agent/ws`다.
조정 결정 경로 `/api/v1/agent/ws`와 05 §10 제목의 `/agent/ws` 차이는 문서 후속 항목이며,
실제 경로는 환경 변수 값이 정한다. 값은 저장소에 넣지 않는다. WSS를 사용하며 가짜 서버
시험용으로만 loopback WS를 허용한다. 기본 인증은 `Authorization: Bearer`다.
프록시·쿠키·토큰 쿼리는 사용하지 않는다. 기본 재시도는 1 → 2 → 4 → 8 → 10 s이며,
handshake 시간을 제외하고 연결 성립 후 3 s 이상 유지되면 초기 간격으로 되돌린다.
닫기 4401·4403은 정지·잠금 뒤 `ReconnectForbidden(close_code)`로 끝내며 자동 재접속하지
않는다. handshake HTTP 401·403도 각각 같은 뜻으로 처리한다. 설정/토큰을 고친 뒤 호출자가
명시적으로 새 Client 실행을 시작해야 한다. 1012(두 번째 hello 뒤 소켓 교체)·1013(바쁨) 등
1013은 05 §9.4대로 매번 기본 1 s 뒤 재시도한다. 그 밖의 닫기는 기본 1 s부터
백오프하며, 닫기 코드·재시도 간격을 SERVER_CLOSED /
SERVER_RETRY 사건으로 남긴다. 사건의 저장·전송 보장 범위는 아래와 같다.

`fh-agent/2`는 앱 프로토콜 이름이다. 조정 결정(2026-10-19)에 따라 HTTP의
`Sec-WebSocket-Protocol` 협상은 하지 않고 `hello.proto`에 이름을 넣는다.
서버 프레임의 다른 `proto`, 또는 다른 버전을 명시한 닫기 사유(`fh-agent/…` 문자열이나
`{"proto":"…"}`)는 정지·잠금 뒤 최소 30 s 간격으로 재연결 대기한다. 서버는 전용 닫기 코드 4406과
`PROTOCOL_MISMATCH` 이유를 쓴다. 4401/4403 인증·권한 거부는 계속
영구 중단이며, 화면 `fh-rt/1`은 그대로다. stop_ref 필수 계약 때문에 agent 판을 올렸다.

## 호출 방법과 출력 순서

- `Session()`은 기본 `time.monotonic`을 쓰며 시험에서는 단조 시계를 주입할 수 있다.
  상태 기계는 입출력이 없다. 메서드 반환값 `Effects`는 로컬
  `motion`과 서버로 보낼 `messages`다. **motion을 순서대로 적용한 뒤 messages를 보낸다.**
  초기·매 재연결 때 `stop`과 `apply(0)`을 먼저 적용한 뒤 `hello`를 전송한다.
- `MotionSink.apply(MotionCommand)`는 블로킹하지 않는 로컬 출력 포트다.
  `apply`는 속도 적용, `stop`은 안전 정지 요청, `unlock`은 Core가 허용한 단발 해제 요청이다.
  `Client`가 이 순서를 보장하며 20 Hz 로컬 감시를 송수신과 별도 task에서 수행한다.
  sink 자체에도 **0.3 s 안에 새 apply가 없으면 0/StopMove**를 내는 독립 감시가 필수다.
  stop/unlock은 이 감시의 apply 시각을 갱신하지 않는다. 실제 sink 구현은 후속 범위이며,
  Python 이벤트 루프의 실시간 마감이나 실제 정지 거리를 보장하는 것은 아니다.
- 모든 Session 접근은 직렬화한다. Client 사용 중에는 같은 이벤트 루프에서
  `client.on_robot_state(raw)`로 신선한 로컬 bridge 상태를 넣는다. 서버 프레임은 이 상태를
  대신할 수 없다. 현재 로컬 입력 형식은 원본 Core의 `SCHEMA`·`clean_state()` 그대로다.
  잠금 해제는 신선한 로컬 STOP 확인 → 현재 lease·stop_gen으로 unlock → 이후 새 로컬
  해제 확인 → 새 중립 순서다. 신선한 로컬 상태가 없으면 항상 0이다.
- `Executor.poll(run_사본)`는 20 Hz로 정규화 축(대기 중에는 0)을 내는 빈 인터페이스다.
  `None`은 명령이 없는 것으로 보며 0.3 s 초과면 실행 `FAILED`다.
  지점 도착은 같은 루프의 `client.waypoint_reached(run_id)`로 알린다.
  RUN lease에는 서버 cmd가 아닌 이 로컬 입력만 사용한다.
- 송신 큐는 사건·전환 128건과 최신 state/ACK 각 1건이다. hello가 먼저이고 최신 state/ACK만
  사건 이력을 앞선다. 사건·전환끼리는 FIFO다. 재접속 이력은 비동기 배압으로 나눠 보내므로 128건 초과 이력도
  첫 연결에서 전송할 수 있다. 직접 송신 큐가 포화되면 즉시 정지·잠금·입력 폐기 후
  해당 연결만 끊고 재연결한다. 미송신 사건은 아래 상한 안에서 보관한다.
  로컬 감시와 `Client.run()`은 계속되며 새 연결에서도 정지 후 hello를 보낸다.
  로컬 출력 실패·실행기 예외는 숨기지 않고 `Client.run()`을 종료하면서 안전 정지를
  시도한다. stop이 실패해도 apply(0)를 별도로 시도하고 최초 출력 오류를 보존한다.
  출력 실패 뒤에는 unlock·비영 출력을 시도하지 않는다. 취소/기존 오류를 보존할 때도
  `exception.output_errors`에 정지 출력 오류를 남기고 Python 3.11 이상에서는 note도 붙인다.
  호출자는 예외를 처리해야 한다. 외부 드라이버가 명령을 실제로
  적용했는지는 여기서 추측하지 않는다.

## 연결과 안전 경계

`lease=null` 또는 lease/holder 변경은 즉시 0·입력 폐기이며 원본 `Core.drop()`의 잠금을
유지한다. 형식이 틀린 lease(키 누락·빈/비문자 ID·모르는 holder)는 조종권 없음으로
처리하고 `LEASE_INVALID` 사건을 남긴다. 이미 FREE·잠금이면 입력만 폐기해 같은 오류로
stop_gen을 반복 증가시키지 않는다. 유효한 holder는 `USER` 또는 `RUN:<run_id>`뿐이며
접두어 없는 `RUN`·빈 실행 ID는 조종권 없음이다. RUN은 내부 모드만 RUN으로 정규화하고,
run.start·재개·실행기 명령/감시는 바인딩된 실행 ID와 정확히 대조한다. 같은 lease에서도 holder/실행 ID
변경이면 입력을 폐기한다. 새 lease와 unlock 이후 새 중립 전에는 움직이지 않는다. seq는 lease마다
0~`2**53-1` 정수 안에서 증가해야 하며, 같은 lease의 재연결에서는 마지막 값을 보존한다.
상한 밖 seq는 마지막 seq를 바꾸지 않고 입력을 폐기하므로 정상 중립/명령으로 복구할 수 있다. 틀린 lease·seq·입력은
폐기한다. RUN 중 서버 cmd는 실행기 의도를 건드리지 않고 버리며 lease별 사건을 한 번
남긴다. 서버/실행기 축과 유예 정책은 float 변환 전에 범위를 검사하므로 큰 정수도
입력 오류로 버리고 계속한다. 속도는 Core의 단계화만 사용한다. 수동 deadman은 엄격한 `> 0.3 s`에서
0·입력 폐기·새 중립이며 **잠금은 추가하지 않는다**(SF-03, PRD Q7 별도 정책).

서버는 1 s마다 앱 `ping`을 보내야 한다. 조정 결정에 따라 JSON 객체에 비어 있지 않은
문자열 `t`가 있는 봉투만 연결 생존으로 센다(모르는 `t`도 포함). JSON으로 파싱할 수 없는 텍스트·이진·
봉투 없는 값과 WS 제어 ping은 시계를 갱신하지 않는다. 유효 봉투 3 s 무수신이면 끊김이며,
자율 실행 유예는 마지막 유효 봉투의 최초 수신 시각부터 0~30 s(기본 30)이며, 0/3 s 설정은 검출 즉시
만료한다. 지점 대기가 먼저면 대기를 유지하고, 시간이 먼저면 그 자리 정지·잠금한다.
재연결은 그 자리 정지·실행 PAUSED 보고·hello 순서이며 자동 재개하지 않는다.
이미 PAUSED이고 대기 이유가 있으면 재연결·클라이언트 종료·송신 포화·proto 불일치도
그 이유를 보존한다. 새로운 STOP·운영자 일시정지는 새 원인으로 기록한다.
넘김 확인은 즉시 전송하는 `state`의 `latched`, `applied`, `stop_gen`이며 몸의 정지 확인은
아니다. 서버가 2 s 제한·새 lease 발급을 담당한다.

`hello`, 10 Hz `state`/마지막 `cmd.ack`, 연결 사건 `event`, `run.update`를 반환한다.
끊김 중 사건·run.update는 FIFO로 보관한다. RAM은 255건이며 한도에서는 가장 오래된
일반 사건부터 버리고 `LINK_BUFFER_DROPPED.data.count`로 누락 수를 알린다. 안전 사건만
남았으면 새 일반 사건을 버리고, 새 안전 사건은 프로세스 전용 임시 SQLite 파일에 넘긴다.
안전 코드는 SERVER_LINK_LOST, LINK_LOSS_TIMEOUT, EXECUTOR_STALLED, PROTOCOL_MISMATCH,
TRANSPORT_BACKPRESSURE, STOP_GEN_EXHAUSTED, LEASE_INVALID, BRIDGE_STATE_INVALID,
HISTORY_STORAGE_BLOCKED이며,
run.update와 인증/프로토콜 거부 SERVER_CLOSED도 보존한다. Client는 파일 제출·run.update
보관 **전에 sink STOP·apply(0)**를 출력한다. SQLite 생성/INSERT/SELECT/DELETE/정리는
이력별 지연 생성 daemon 작업자 1개가 맡고 재접속마다 새 작업자를 만들지 않는다.
파일은 물리 8 MiB·캐시 128 KiB, 파일 작업은 실행 중 포함 최대 256개이며 64개부터
접수를 닫아 watchdog/수신 루프가 파일 대기를 하지 않게 한다. RAM 255건 + 파일 작업
최대 256건 + 파일 head 1건이며 송신 큐 128건·in-flight 1건의 실패 복원을 위해 여유를
예약한다. 이력 파일 오류/고수위는 즉시 STOP·0·잠금, 옛 lease/intent 폐기와
HISTORY_STORAGE_BLOCKED 기록으로 드러낸다. 막힌 동안 외부 실행기 입력은 접수하지
않고 bridge 유효 피드백·감시 시계는 계속 처리한다. 이미 접수한 안전 사건은 축출하지
않으며 파일 작업/미송신 기록이 각 소유자에 남는다. 파일이 정상이고 작업이 모두 끝난
뒤 새 연결은 가능하지만 자동 unlock/재개하지 않는다. 새 lease→신선한 정지 피드백→
unlock→새 중립 절차가 필요하다. 공간 부족은 저장소를 먼저 복구한다. 이 정책은 Q7
링크 단절 유예와 별개다. 저장 고장이 지속되면 writable 대기 동안 오프라인이며
저장소를 복구하기 전에는 재접속도 시도하지 않는다. 파일은 재시작 복구 저널이 아니다. sans-I/O Session을
단독 사용하면 호출자가 기록 I/O·출력 순서를 책임지며 실제 비동기 경계는 Client다.

hello와 교체 가능한 최신 state/ACK만 사건 이력을 앞설 수 있다. 사건·run.update끼리는
재정렬하지 않으며, 재연결 중 새로 생긴 사건도 같은 FIFO 펌프를 거친다. 송신 큐는
128건이고 이력은 공간을 기다리며 한 건씩 옮긴다. 무제한 크기의 이력을 한 번에 RAM에
읽지 않는다. 실패한 쓰기/아직 보내지 않은 이력은 FIFO 앞에 복원한다.
반복 SERVER_RETRY는 첫 발생 위치의 1건으로 합쳐 attempts·first_at_s·last_at_s와 마지막
간격/코드를 보존하며 실패한 송신 뒤 복원해도 집계를 이어 간다. 요약의 위치는 첫 재시도
위치이고 범위는 first_at_s~last_at_s라 뒤 사건보다 last_at_s가 늦을 수 있다.
한도에서 일반 기록인 재시도/종료 내역이 생략될 때도 누락 수에 포함한다.

네트워크 실패 시 마지막 쓰기가 도착했는지 알 수 없어 중복될 수 있다. 서버 수신 ACK·
재시작 뒤 복구는 없다. hello 직후 서버가 닫으면 송신 성공한 사건도 DB에 남았는지는
알 수 없다. 프로토콜 거부를 확인하면 소켓 작업 취소 완료를 기다리기 전에 STOP·0을 출력한다.
새 Client는 옛 서버의 `4403 + PROTOCOL_MISMATCH*` 이유도 정지·잠금과
최소 30 s 재접속 대기로 처리한다. 다른 4401/4403 인증 거부는 영구 중단한다.
서버의 로봇별 기록 한도 `1013 + ROBOT_ARCHIVE_LIMIT`도 teardown 대기 전에 로컬
STOP·0·잠금과 lease 폐기를 적용한다. 다른 1013의 기존 고정 재시도/Q7 정책은 유지한다.
로컬 정제 측정은 같은 소유 루프의 `client.update_telemetry(snapshot)`으로 입력한다.
Core 안전 피드백인 `on_robot_state`와 별도이며 매 송신마다 원천/수신 나이를 재검사한다.
현 계약의 speed·pose·battery만 전송하고 미측정·무효·stale 필드는 `null`이다.
시뮬 배터리 원천과 등록 지도 결속은 추측하지 않는다.
로컬 sensor 관측은 원래 `received_monotonic_s`와 함께 `client.update_devices(devices)`로
넣는다. Session이 hello와 각 state의 `devices_changed`에서 만료를 다시 계산한다.
다리와 Session은 같은 단조 시계(시험의 주입 시계도 포함)를 사용해야 한다.
`event.robot_at`은 `null`이다(주입 단조 시각은 `data.monotonic_s`). 미디어·이진·업로드,
지도 다운로드·SLAM·층 변경·사람 확인·return 경로 실행은 후속 작업이며 해당 프레임은
무시한다. 실제 임무 계획을 실행하는 기능은 없다.

검증 결과·변이 표·계약 모호점은 [LINK-VALIDATION.md](LINK-VALIDATION.md)에 기록한다.
운영 서버·Gazebo·ROS·실로봇에 연결하는 절차는 포함하지 않는다.
현장 사설 CA 설정·연결은 미구현·미검증이며 현재 WSS는 시스템 기본 CA를 사용한다.

로컬 bridge의 float 표현 범위를 넘는 큰 정수 피드백은 링크가 Core 호출 전에 거부하고
`BRIDGE_STATE_INVALID`를 기록한다. 거부한 입력은 Core 상태·생존 시각을 갱신하지 않는다.
Core 및 기존 Core 시험은 수정하지 않았다.

## 폰 연결 서버 (P1-A, ROS 없는 모의 검증)

계약 정본은 [05 §13](../../docs/spec/05-API-SPEC.md#13-폰--에이전트-fh-phone1)이다.
`foothold_agent.phone`은 stdlib + `websockets==15.0.1`만 사용한다. 가짜 폰/sink 시험:

```sh
python3 -m pytest apps/agent -q
python3 apps/agent/tools/check_phone_mutations.py
python3 apps/contracts/generate.py --check
npm --prefix apps/contracts run typecheck
```

기존 `python3 -m foothold_agent.ros_bridge` 진입점은 다음 표의 **필수 환경 변수가 모두** 있을 때만
`/phone/ws`를 연다. 값은 배포 환경에서 제공하고 Git에 넣지 않는다. 이번 작업에서는
이 진입점을 실행하지 않았고 ROS/시뮬을 기동하지 않았다.

| 변수 | 뜻 |
|---|---|
| `FOOTHOLD_PHONE_HOST`, `FOOTHOLD_PHONE_PORT` | 명시적 바인딩 인터페이스·포트. 기본 리스너 없음 |
| `FOOTHOLD_PHONE_KEY_PATH` | 로봇 전용 `{kid:base64url_secret}` 파일(키 32바이트 이상) |
| `FOOTHOLD_PHONE_ORG_ID` | 이 로봇의 조직 UUID. 기존 `FOOTHOLD_ROBOT_ID`와 함께 대조 |
| `FOOTHOLD_PHONE_REPLAY_DB` | 영속적인 로컬 spent-jti SQLite 파일. 보호된 쓰기 가능한 디렉터리 |
| `FOOTHOLD_PHONE_POLICY_NAME`, `FOOTHOLD_PHONE_POLICY_VERSION` | 실제 배포 정책 식별자, hello에 그대로 표시 |
| `FOOTHOLD_PHONE_CLOCK_TRUSTED` | 운영 감독자가 동기화를 확인한 뒤 `1`. 없거나 다른 값은 시작 거부 |
| `FOOTHOLD_PHONE_SIMULATION` | 시뮬 `1`/실기 `0` 명시. 없거나 다른 값이면 시작 거부 |
| `FOOTHOLD_PHONE_ORIGINS` | PWA/브라우저 배포에는 필수. JSON 배열의 정확한 HTTP(S) Origin 허용 목록. 기본 빈 목록은 Origin 있는 연결 모두 거부; 헤더 없는 앱은 허용 |

설정·키·재사용 저널은 ROS 시작 전에 확인한다. 출입증은 관제 서버가 발급하지만 그
엔드포인트는 후속이다. 시험에서는 실행할 때 만든 난수 키로 직접 서명한다. HS256은
로봇별 대칭키이며 키 배포·회전·유출 한계·저널 복구·시계 신뢰는 05 §13.2를 따른다.
시계 동기화 상실 때 현재 감독자의 전달 수단은 **프로세스 정지뿐**이다. 외부에서
`Verifier.trusted`를 바꾸는 IPC는 없으며 자동 OS NTP 상태 연동은 실기 전 관문이다.
시계 역행/5초 초과 오차는 자체 검출한다. 키/저널은 실행 사용자 소유의 일반 파일·
group/other 권한0만 허용한다. 배포 시 **실행 사용자 소유·0600·실파일**로 제공하며
심볼릭 링크/FIFO/그룹 읽기 등 넓은 권한은 시작 거부다. 실제 클라이언트의 Origin과
secret 파일 제공 방식은 실기 전 배포 시험에서 확인한다. 빈 Origin 목록의
브라우저/PWA 폰은 HTTP 403이다. 운영 설정의
메모리 저널은 거부하고 상위 디렉터리도 보호해야 한다. FULL commit의 루프 차단 시간은
1단계 시뮬 관문에서 fsync 지연으로 측정한다.
출입증 상한은 600초다. 인터넷이 끊겨 새 출입증을 못 받으면 **남은 수명(최대10분)
뒤 정지·잠금 후 조종권을 비우며**, 연결이 살아 있어도 연장하지 않는다.

폰 모드에서 Hub의 Session/Core 하나가 실제 sink를 소유한다. 기존 Client는 Session이나
Core를 따로 만들지 않는 Observer 파사드·DiscardSink로 상태·기록만 전송한다. 서버의
lease/cmd/unlock/run/slam/floor.set은 버리고 옛 stop만 Hub.stop에 넣는다. 클라우드의
일반 단절·재접속은 폰 lease를 바꾸지 않는다. 출입증/조종권은 프로세스 재시작 시 복원하지
않으며 spent-jti 저널만 유지한다. 수신·넘김·출력은 같은 이벤트 루프에서 직렬 처리한다.
20Hz 감시 외에 실제 sink의 독립 0.3초 watchdog도 여전히 필수다.
폰 Session의 서버 링크 타이머는 끄고 Hub만 연결을 감시한다. hello 승인 전 오류·STOP은
그 소켓만 닫는다. hello 대기는3초/최대16개, 원격 host당2개다. 주소 상한을 먼저 적용해
초과 주소의 가장 오래된 대기만 교체한다. 전체 상한에서는 대기가 가장 많은 주소부터
교체하며 동률은 가장 오래된 소켓이 먼저다. hello 검증 중인 연결은 교체하지 않는다.
현재 검증은 동기이며 비동기로 바꾸면 제외 규칙/점유 한도를 다시 검토한다. 같은 주소(NAT 공유 포함)의 비인증 폭주는 그 주소의 재접속을 막을 수
있다. 공격 주소 수가 전체 상한/2(8개)를 넘는 다중 주소 폭주도 재접속을 막을 수 있으며
정지·잠금을 유지한다. 실기 전 관문은 **로봇 망 분리·접속 속도 제한(주소별 동시 TCP 수·ulimit 포함)**이다.
대기16개 상한은 닫는 중인 소켓·TCP handshake 수까지 제한하지 않는다.
**역방향 프록시 앞단은 금지**한다(모든 폰이 한 주소로 집계됨). 폰 앱의1013 수신 후
짧은 재시도 동작도 실기 전에 확인한다. 인증된 연결은 별도16개다.
승인된 보기 폰의 수신 계층 형식 오류도 STOP·잠금을 적용한다. 요청 알림은 종류별 최신1개,
거절/자동 거절/요청자 자기 철회(cancel·release·view·요청자 끊김) 뒤 사용자+기기 기준
30초 제한을 남기며 새 출입증 재접속으로 우회할 수 없다. REQUEST_FLOOD·형식/크기 오류·
수신 계층 오류·보내기 시간 초과등 요청자 귀책 거부도 철회다. 조종자 반납·끊김/만료·
STOP_CONFIRM_FAILED·요청자와 무관한 시계 불신/서비스 종료/로봇 정리/내부 오류만 예외다.
요청자 출입증 만료로 대기가 사라져도 그 시점부터30초 제한이다. 짧은 새 출입증 반복으로 우회하지 못한다.
take·request는 사용자+기기별 독립 이동1초8개/60초30개 예산을 쓰며 grant·재접속으로
초기화하지 않는다. 초과는 LEASE_ACQUIRE_LIMIT 오류 응답만·연결 유지, 거부 기록은
Hub 전체에서 초당1건 이하로 집계한다. cancel은 별도1초8개 초과 연결만 닫는다. 비조종자의 view·release만 별도1초 창에 합계8개,
초과분은 REQUEST_FLOOD(status429) 오류 응답만 하고 무시한다. 연결·ping·STOP은 유지한다.
현재 조종자의 release·view는 집계·제한 없이 즉시0·잠금·반납한다. 취득·넘김 수락 시
이전 비조종자 창을 초기화한다. **정지·조종권을 줄이는 명령은 속도 제한으로 막지 않는다.**

폰 ping은 1초마다, 3초 무수신에 정지·잠금·옛 lease 폐기, 마지막 ping으로부터 15초까지
기존 사용자+기기 예약이다. 같은 사용자+기기는 새 출입증/연결로 새 lease를 취득할 수 있다.
RUN·카메라·발급 서버·회수 목록·실폰·실로봇·TLS 배포는 후속이다.
실기 전 관문 정본은 [05 §13.6](../../docs/spec/05-API-SPEC.md#136-오류닫기후속-경계)이다. 새 폰 네트워크 시험은
loopback 9450~9469만 사용한다. 기존 회귀 시험 helper의 9060~9079는 조정 승인으로 유지한다.

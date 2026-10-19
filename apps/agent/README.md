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
`PROTOCOL_MISMATCH: expected fh-agent/2` 이유를 쓴다. 4401/4403 인증·권한 거부는 계속
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
- 송신 큐는 사건·전환 128건과 최신 state/ACK 각 1건이다. hello가 먼저이고 state·안전 사건은
  일반 사건 이력을 앞선다. 재접속 이력은 비동기 배압으로 나눠 보내므로 128건 초과 이력도
  첫 연결에서 전송할 수 있다. 이력 중 새 사건까지 포화되면 즉시 정지·잠금·입력 폐기 후
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
끊김 중 사건·run.update는 최대 255건을 보관하고, 넘친 수는 별도 1건
`LINK_BUFFER_DROPPED.data.count`로 알린다(최대 256건). 포화 때 오래된 일반 사건을 먼저
버리고, 안전 사건뿐이면 가장 오래된 것을 버린다. 무손실·디스크 내구성은 없다.
hello와 최신 state, 안전 사건을 앞서 보내고 일반 사건끼리는 순서를 보존한다. 반복 SERVER_RETRY는
첫 발생 위치의 1건으로 합쳐 attempts·first_at_s·last_at_s와 마지막 간격/코드를 보존한다.
요약의 위치는 첫 재시도 위치이고 범위는 first_at_s~last_at_s다. 따라서 뒤의 다른 사건보다
last_at_s가 늦을 수 있으며, 안전 우선 전송도 전체 시각순 정렬을 뜻하지 않는다.
긴 단절 동안 재시도 횟수만큼 큐가 늘지 않으며, 독립 안전 사건은 원래 순서를 유지한다. 송신 성공 전 실패한 사건은 상한 안에서 재보관한다. 네트워크 실패 시 마지막 쓰기가
도착했는지는 알 수 없어 중복될 수 있다. 서버 수신 ACK·디스크 저장·재시작 뒤 복구는 없다. 원격측정이 연결되지 않은 필드는 `null`이고
`event.robot_at`도 `null`이다(주입 단조 시각은 `data.monotonic_s`). 미디어·이진·업로드,
지도 다운로드·SLAM·층 변경·사람 확인·return 경로 실행은 후속 작업이며 해당 프레임은
무시한다. 실제 임무 계획을 실행하는 기능은 없다.

검증 결과·변이 표·계약 모호점은 [LINK-VALIDATION.md](LINK-VALIDATION.md)에 기록한다.
운영 서버·Gazebo·ROS·실로봇에 연결하는 절차는 포함하지 않는다.
현장 사설 CA 설정·연결은 미구현·미검증이며 현재 WSS는 시스템 기본 CA를 사용한다.

로컬 bridge의 float 표현 범위를 넘는 큰 정수 피드백은 링크가 Core 호출 전에 거부하고
`BRIDGE_STATE_INVALID`를 기록한다. 거부한 입력은 Core 상태·생존 시각을 갱신하지 않는다.
Core 및 기존 Core 시험은 수정하지 않았다.

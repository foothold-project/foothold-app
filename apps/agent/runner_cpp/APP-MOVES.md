> 분류: 규약 안 · 연결 프로그램 → START C++ 실행기 앱 동작 넘김 (실행기 쪽은 아직 코드 없음)
> 작성: Claude 세션 (오흥재 지시, app-lx) · 2026-11-26
> 근거: 팀장 11/26 08:01 「저수준 열」 · 동작표 action-table-1126 · `foothold_agent/go2_direct/actions.py` `LOWLEVEL` · `runner_send` · `apps/contracts` `LowlevelAction` · 실행기 `src/runner.cpp` 리모컨 키 판정 (feat/runner-dog-sit-1126-app-lx)
> 요지: 앱 동작 하나 = 리모컨 키 한 번. 연결 프로그램이 127.0.0.1 UDP 로 `{seq, key, action, request_id}` 를 보내고, 실행기는 그 키를 리모컨 키와 같은 판정으로 한 번 누른 것처럼 다룬다
> 상태: 연결 프로그램 쪽만 있음 (가짜 수신 소켓 시험만). 실행기 수신 · 응답은 미구현 · 실기 0 회. `FH_START_MOVE_PORT` 를 정하기 전에는 앱 단추가 `RUNNER_NOT_CONNECTED` 로 거부됨

# 앱 동작 → START 실행기

## 지금 있는 것 (연결 프로그램)

- START 표시 파일 `/tmp/foothold-start-active` 가 있으면 상태에 `control: LOWLEVEL`, 없으면 `FACTORY` 를 싣는다. 화면은 이 칸으로 단추를 끈다.
- START 중 앱 동작 요청:
  - `LowlevelAction` 밖 (조회 포함) → `REJECTED` · `LOWLEVEL_UNSUPPORTED`
  - 안 → 조종권 · 중복 · 위험 확인 (Damp) 만 본 뒤 `runner_send`. 순정 SDK 자세 · 정지 판정은 START 중 순정 상태 보고가 없어 보지 않는다 (실행기가 판정)
  - `FH_START_MOVE_PORT` 없음 → `REJECTED` · `RUNNER_NOT_CONNECTED`
  - 보냄 → `SUCCEEDED` · `RUNNER_SENT`. 실행기 접수도 동작 완료도 아니다
  - 소켓 오류 → `FAILED` · `RUNNER_SEND_FAILED`
- 자세 단추: 엎드리기 (`stand_down`) 는 `StandDown` 과 같이 `L2+A` 로, 일어서기 (`stand_up`) 는 `LOWLEVEL_UNSUPPORTED`.
- 순정 SDK 호출은 START 중 하나도 나가지 않는다 (#498 그대로, 조회도 막음).

## 묶음

한 UDP 데이터그램 = JSON 한 줄, 512 바이트 이하.

```json
{"seq": 123456789012345, "key": "R1+B", "action": "Sit", "request_id": "..."}
```

| 칸 | 뜻 |
|---|---|
| `seq` | 연결 프로그램의 CLOCK_MONOTONIC ns. 늘어나는 번호이자 보낸 시각 |
| `key` | 리모컨 키 이름. 아래 표의 일곱 값만 |
| `action` | 앱 동작 이름 (기록용) |
| `request_id` | 앱 요청 번호 (기록 · 이후 응답용) |

| action | key | 실행기 쪽 뜻 (지금 리모컨과 같음) |
|---|---|---|
| Sit | R1+B | 정책 중이면 개 앉기 시작 |
| RiseSit | R1+B | 개 앉기를 다 버틴 뒤면 다시 서기 |
| StandDown | L2+A | 정책 중이면 엎드림 · 감쇠 중이면 다시 섬 |
| Stretch | R2+A | 정책 중이면 기지개 |
| Hello | R2+B | 정책 중이면 악수 |
| Heart | R2+Y | 정책 중이면 하트 |
| Damp | L2+B | 바로 감쇠 (비상) |

Sit 과 RiseSit 은 같은 키다. 실행기는 지금 상태로 어느 쪽인지 정한다 (리모컨과 같음). 앱이 Sit 을 보냈는데 실행기가 앉아 버티는 중이면 다시 서기가 된다. 받아들일 수 없으면 RiseSit 에 대해서만 다시 서기를 허용하는 검사를 실행기에 둘지 팀장 확인이 필요하다.

## 실행기 쪽에 만들 것 (안 · 이 브랜치에서는 고치지 않음)

1. `--app-port <포트>` (0 = 끔). 127.0.0.1 에만 묶고, 보낸 쪽 주소가 127.0.0.1 이 아니면 버린다. 제어 스레드를 막지 않게 non-blocking 으로 한 주기에 묶음을 모두 읽는다.
2. 버림: 512 바이트 넘음 · JSON 아님 · `seq` 가 정수 아님 또는 마지막 받은 값 이하 · 지금 steady_clock 과 0.5 초 넘게 차이 · `key` 가 표 밖. 버린 수만 센다.
3. 받은 키는 그 주기 한 번만 `keys` 에 OR 로 더한 것처럼 판정한다. 다음 주기에는 떼어진 것으로 본다 (`move_latched_` · `lie_latched_` 가 리모컨과 똑같이 한 번만 시작하게).
4. 리모컨이 늘 우선: 그 주기에 리모컨 버튼이 하나라도 눌려 있으면 앱 키는 버린다. 단 `L2+B` 는 언제나 받는다.
5. 기록: 받은 키마다 `APP_KEY {key, action, request_id, phase}` 이벤트 한 줄. 버린 묶음은 `APP_KEY_DROPPED {reason}`.
6. 응답 (다음 단계): 실행기가 `{seq, request_id, result: STARTED | IGNORED, phase}` 를 연결 프로그램 포트로 돌려주면 연결 프로그램이 `RUNNER_SENT` 대신 `RUNNER_STARTED` · `RUNNER_IGNORED` 로 보고한다. 그 전까지 화면은 「보냄 · 현장 확인」 으로만 쓴다.

## 시험 (실기 전)

- 가짜 LowState 로 표의 일곱 키가 리모컨 키와 같은 상태 변화를 내는지, 같은 seq 두 번 · 오래된 seq · 표 밖 키 · 리모컨 동시 입력이 버려지는지
- `L2+B` 가 동작 중에도 바로 감쇠하는지
- 연결 프로그램 쪽: `apps/agent/tests/test_go2_actions.py` 의 START 시험 (가짜 수신 소켓)

## 정할 것

- `FH_START_MOVE_PORT` 값과 자동 시작 (systemd) 에 넣을지
- 인사 (Greet · L1+A): 앱 동작 이름이 없다 (`Go2ActionName` 은 SDK 이름이고 인사의 SDK 번호가 확인 전). 이름을 정하면 `LowlevelAction` · `LOWLEVEL` · 위 표에 같이 더한다
- AME-2 실행기도 같은 표시 파일 · 같은 묶음을 쓸지 (지금은 START 표시 파일만 봄)

> 분류: 규약 · 연결 프로그램 ↔ START C++ 실행기 앱 입력 (키 · 속도 · 응답)
> 작성: Claude 세션 (오흥재 지시, app-lx) · 2026-11-26
> 근거: 팀장 11/26 08:01 「저수준 열」 · 10:17 Greet · 10:49 「리모컨 · 앱 · 키보드 · 음성이 순정이든 START 든 같게」 · 넘김은 멈춘 뒤 (조정 세션 11/26) · 실행기 `src/app_input.cpp` `src/app_socket.cpp` `src/runner.cpp` · 연결 프로그램 `foothold_agent/go2_direct/runner_link.py` `sink.py` `feedback.py` `actions.py`
> 요지: 같은 기기 127.0.0.1 UDP. 앱 동작 하나 = 리모컨 키 한 번, 화면 조종 = 막대 대신 속도 (0.3 초 끊기면 0). 리모컨이 늘 우선. 실행기가 묶음마다 응답해 연결 프로그램이 STARTED · IGNORED 를 정직하게 보고
> 상태: 양쪽 코드 · 가짜 로봇 · 가짜 소켓 시험 통과 (feat/start-input-1126-app-lx). 실기 0 회 · Jetson 설정 안 바꿈. 포트 값과 자동 시작 넣기는 팀장 결정

# 앱 동작 → START 실행기

## 길

```
웹 · 앱 · 음성 → 서버 action · drive API → 연결 프로그램 (fh-agent/2)
   START 표시 파일 /tmp/foothold-start-active 없음 → 순정 SportClient (전과 같음)
   있음 + FH_START_MOVE_PORT → 127.0.0.1:<포트> UDP → foothold_start --app-port <포트>
```

- 음성 · 키보드 · 앱 단추는 모두 같은 서버 API (`t: action` · `t: posture` · `t: cmd`) 로 들어오고 연결 프로그램은 보낸 쪽을 가리지 않는다. 음성 담당이 같은 API 를 쓰면 같은 결과가 난다.
- 서버는 START 중 동작 이름만 거른다 (`realtime.py` `send_action`: `LowlevelAction` · `LowlevelQuery` 밖은 `LOWLEVEL_UNSUPPORTED`). 이동 명령은 START 로 막지 않는다. 고친 것 없음.

## 연결 프로그램

- START 중 앱 동작 (`LowlevelAction`) → 조종권 · 중복 · 위험 확인 (Damp) 뒤 키 묶음. 결과는 바로 `SUCCEEDED · RUNNER_SENT`, 실행기 응답이 오면 바꾼다:
  - `STARTED` → `SUCCEEDED · RUNNER_STARTED` (실행기가 그 키로 상태를 바꿈. 동작 완료 아님)
  - `IGNORED` → `REJECTED · RUNNER_IGNORED_PHASE` (정책 밖 등) · `_REMOTE` (리모컨 쓰는 중) · `_BUSY` (같은 주기 다른 키) · `_NOT_STOPPED` (넘김인데 안 멈춤)
  - 응답 없음 → `RUNNER_SENT` 그대로 (화면은 「보냄 · 현장 확인」)
- 엎드리기 단추 (`stand_down`) 는 `L2+A`. 일어서기는 `LOWLEVEL_UNSUPPORTED`. 읽기 전용 조회는 순정 SDK (#498).
- 화면 조종 (START + 포트): 출력 주기 (약 50 Hz) 마다 속도 묶음을 보낸다. 잠김 · STOP · 자세 · 동작 중 · 리모컨 쓰는 중이면 0. 순정 `Move` · `StopMove` 는 보내지 않는다. 비상 정지도 속도 0 (실행기가 감속해 선다 · 엎드리지 않음).
- 실행기 응답 (속도 묶음의 응답 포함) 이 0.2 초 넘게 없으면 「START 실행기 응답이 없어」 로 화면 조종을 막는다.
- 잠금 풀기 · 걷기 가능 판단: START 중에는 순정 SportModeState 대신 실행기 응답의 `phase` 와 LowState (자이로 0.05 rad/s · 관절 0.10 rad/s 이하 = 정지) 로. `policy` 이고 기울기 60° 안이면 서서 걷기 가능, `damping` 이면 엎드림, 그 밖은 바뀌는 중.
- 포트 없음 (`FH_START_MOVE_PORT` 미설정) → 전처럼 동작은 `RUNNER_NOT_CONNECTED`, 화면 조종은 막힘.

## 묶음

한 UDP 데이터그램 = 평평한 JSON 객체 하나, 512 바이트 이하. 문자열은 출력 가능한 ASCII, 역슬래시 · 따옴표 없음. 칸은 아래 것만 (다른 칸 · 중복 칸이면 버림).

```json
{"seq": 123456789012345, "key": "R1+B", "action": "Sit", "request_id": "..."}
{"seq": 123456789012346, "vx": 0.6, "vy": 0.0, "wz": 0.0}
```

| 칸 | 뜻 |
|---|---|
| `seq` | 보낸 쪽 CLOCK_MONOTONIC ns (부호 없는 정수). 늘어나는 번호이자 보낸 시각 |
| `key` · `action` · `request_id` | 키 묶음. 키와 동작은 아래 표의 짝만 |
| `stop` | 정지 묶음 (`1` 잠금 · `0` 해제, 다른 칸 없음). 응답 `ACCEPTED` |
| `vx` · `vy` · `wz` | 속도 묶음 (m/s · m/s · rad/s). 절댓값 2 · 2 · 3 넘으면 버림, 막대가 낼 수 있는 범위 (-1.3~전진 상한 · ±0.8 · ±1.5) 로 자름 |

| action | key | 실행기 쪽 뜻 (리모컨과 같음) |
|---|---|---|
| Sit · RiseSit | R1+B | 정책 중이면 개 앉기 · 앉아 버티는 중이면 다시 서기 |
| StandDown | L2+A | 정책 중이면 엎드림 · 감쇠 중이면 다시 섬 |
| Stretch | R2+A | 정책 중이면 기지개 |
| Hello | R2+B | 정책 중이면 악수 |
| Greet | L1+A | 정책 중이면 인사 |
| Heart | R2+Y | 정책 중이면 하트 |
| Damp | L2+B | 바로 감쇠 (비상) |
| FreeWalk · ClassicWalk | START+LEFT · START+RIGHT | 멈춘 뒤 1 초 지났을 때만 엎드려 순정 free walk · Classic 으로 넘김. 실행기만 받음 (아래 「정할 것」) |

Sit 과 RiseSit 은 같은 키라 실행기가 지금 상태로 어느 쪽인지 정한다 (리모컨과 같음).

## 실행기 (`--app-port <포트>`, 0 또는 생략 = 끔)

1. 127.0.0.1 에만 묶는다. 보낸 쪽이 127.0.0.1 이 아니면 버린다. 제어 주기 (5 ms) 마다 non-blocking 으로 쌓인 묶음을 최대 64 개 읽는다. 1024 미만 포트는 거부.
2. 버림 (응답 없음): 512 바이트 넘음 · 형식 틀림 · 키와 동작 짝 틀림 · 속도 범위 밖 · `seq` 가 마지막 받은 값 이하 · 0.5 초보다 오래됨 · 20 ms 넘게 앞섬. 버린 수를 세고 `APP_DROP {reason, dropped}` 를 1 초에 한 번까지 기록.
3. 키: 그 주기에만 리모컨 키에 OR 로 더한다. 다음 주기에는 뗀 것으로 본다. 그래서 실행기의 모든 관문 (정책 중에만 동작 · 동작 중 누름 무시 · 넘어짐 · 신선도) 이 리모컨과 똑같이 걸린다. 한 주기에 키 하나 (나머지 `busy`), 같은 묶음 안에 Damp 가 있으면 Damp.
4. 속도: 막대가 중립일 때만 `remote_want` 대신 쓴다. 그 뒤는 막대와 같은 `shape_command` · `slew_command`. 보낸 시각에서 0.3 초 안에 새 묶음이 없으면 버려 목표 0 (명령은 막대를 놓을 때와 같은 감속으로 0 까지).
5. 리모컨 우선: 그 주기에 리모컨 막대 (0.05 이상) 나 버튼이 하나라도 있으면 앱 키 · 속도를 버리고 (`remote`) 앱 속도는 지운다 (새 묶음이 와야 다시 씀). 단 앱 L2+B 는 늘 받는다. 리모컨 L2+B 는 원래대로 언제나 감쇠. 팀장이 바꿀 수 있는 규칙이다.
   **앱 STOP 은 예외 (팀장 11/28 「키보드 전진이든 조이스틱 전진이든 앱 STOP 이 먹어야 한다」).** 정지 묶음 `{seq, stop: 1}` 을 받으면 리모컨 막대가 기울어 있어도 걷기 목표를 0 으로 잠근다. 정책은 감쇠 없이 감속해 선다. 잠김은 해제 묶음 `{seq, stop: 0}` 으로만 풀린다. 막대를 놓거나 앱 속도 묶음이 와도 풀리지 않는다 (잠긴 동안 앱 속도는 `IGNORED stopped`). 리모컨 L2+B 와 다른 키는 그대로 먹는다. 연결 프로그램은 operator stop (화면 · 앱 STOP, cause user_stop 또는 cause 없음) 동안 출력 주기마다 `stop: 1` 을 보내고, 잠금 풀기 (unlock) 가 받아들여진 뒤 `stop: 0` 을 다섯 번 보낸다. 일반 정지 (화면 숨김 · lease 전환) 는 전처럼 속도 0 이라 리모컨에 양보한다. 실행기가 다시 켜지면 잠김은 사라진다 (메모리에만 있음).
6. 응답: 묶음마다 보낸 쪽 포트로 `{seq, result, reason?, request_id?, phase, remote}`. 키는 주기 전후 phase 나 동작이 바뀌면 `STARTED`, 아니면 `IGNORED` (`phase` · `remote` · `busy` · `not_stopped`). 속도는 `ACCEPTED` · `IGNORED remote`. 같은 주기에 다른 까닭 (넘어짐 등) 으로 phase 가 바뀌어도 `STARTED` 로 보일 수 있다.
7. 기록: 키마다 `APP_KEY {key, started}`.

## 순정 넘김은 멈춘 뒤에만 (리모컨 · 앱 같음)

정책 중 start+왼쪽 · 오른쪽 (앱 START+LEFT · START+RIGHT) 은 아래가 모두 1 초 (`handover_still_hold`) 이어졌을 때만 엎드려 넘긴다. 값은 `src/runner.cpp` 상수, 실기에서 조정한다.

| 조건 | 상수 | 값 |
|---|---|---|
| 정책 명령 (감속 뒤) 축마다 | `handover_command_max` | 0.02 |
| 추정 몸 속도 x · y (`--debug-est` 가 있을 때만 봄) | `handover_speed_max` | 0.10 m/s |
| 자이로 축마다 | `handover_gyro_max` | 0.30 rad/s |

아니면 무시하고 `HANDOVER_REFUSED {not_stopped}` 를 남기며 정책은 계속 돈다. 누른 채 기다려도 넘기지 않는다 (떼고 다시 눌러야). 감쇠 중 넘김 · L2+B · 넘어짐 처리는 그대로.

## 시험 (실기 전, 실행한 것)

- `ctest` (호스트) 5 묶음: `runner_transitions` 에 앱 키 · 앱 속도와 만료 · 리모컨 우선 · L2+B · 나쁜 묶음 · 넘김 거부 (리모컨 · 앱), `app_input` 에 해석 · loopback 왕복 · 만료
- aarch64 교차 빌드 시험 바이너리 5 개를 qemu 로 실행
- 연결 프로그램: `tests/test_go2_start_input.py` (가짜 실행기 소켓) · `test_go2_actions.py` START 시험

## 정할 것

- `FH_START_MOVE_PORT` 값 (안: 47210) 과 자동 시작에 넣을지. 넣는 방법은 `systemd/README.md`
- 앱에서 순정 넘김 (FreeWalk · ClassicWalk) 을 켤지: 실행기는 받지만 계약 `LowlevelAction` (동작표 「저수준」 열) 에 없어 지금 서버가 `LOWLEVEL_UNSUPPORTED` 로 막는다. 켜려면 동작표 · 계약 · 연결 프로그램 `LOWLEVEL` · 화면을 함께 바꾼다
- START 중 화면의 비상 정지를 속도 0 (지금) 으로 둘지, 엎드리기 (L2+A) 로 할지
- 리모컨 우선 규칙 (지금: 리모컨이 중립이 아니면 앱 버림, 앱 Damp 만 예외)
- AME-2 실행기도 같은 표시 파일 · 같은 묶음을 쓸지
- 걷기 모드 (계약 #525 `gait`, 연결 프로그램 `go2_direct/gait.py`): START 중 `classic` 은 위 `ClassicWalk` 키 (START+RIGHT) 로 보낸다. 실행기에 아직 없는 것: 순정 기본 걸음 (`sport`) 으로 넘기는 키 (앉기 · 순정 모드 선택 · 다시 서기 · 걸음 선택 없음), 순정 중 START 정책 시작 키 (START+UP 은 키표에 없음), AME-2 (START+DOWN 은 지금 `ame2_unavailable`). 그때까지 연결 프로그램은 `GAIT_UNSUPPORTED` · `GAIT_NOT_READY` 로 답한다

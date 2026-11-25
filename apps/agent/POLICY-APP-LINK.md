> 분류: 설계 안 · 연결 프로그램 (Go2Sink) → 정책 실행기 명령 넘김 (검토 전 · 코드 없음)
> 작성: Claude 세션 (오흥재 지시, app-lx) · 2026-11-22
> 근거: `foothold_agent/go2_direct/sink.py` `Go2Sink.drain` · `GO2-SERVER-DRIVE.md` · `foothold_agent/policy/applink.py` (3bcfee8a)
> 요지: 서버 조종의 속도 · STOP 을 START 상태일 때만 loopback 으로 실행기에 보내고, 순정 상태일 때는 지금처럼 SportClient Move. 안전 관문은 그대로 두고 출력 자리만 나눈다
> 상태: 안 · 팀장 확인과 두 모델 검토 전에는 sink.py 를 고치지 않음 · 실기 0 회

# 연결 프로그램 → 정책 실행기 명령 넘김 (안)

## 지금

| 자리 | 하는 일 |
|---|---|
| 웹 → 서버 → `fh-agent/2` → `Go2Sink` | 조종권 · 잠금 · watchdog · 실측 정지 · 램프를 거친 속도를 `drain` 이 `SportClient.Move` 로 보냄. `_walkable()` (SportModeState mode 0 · 1 · 3) 일 때만 |
| 정책 실행기 (`policy/run.py --app-port`) | 127.0.0.1 UDP 로 `{seq, vx, vy, wz, mode}` 를 받음. 리모컨 우선 · 0.3 초 끊기면 0 · 학습 상한 · 시뮬 가감속 (3bcfee8a, 가짜 SDK 시험만) |

START 상태에서는 순정 sport 서비스를 내려놓으므로 `_walkable()` 이 거짓이 되어 Move 를 보내지 않는다. 그래서 지금은 웹 명령이 실행기에 닿지 않는다.

## 바꿀 것 (안)

1. **실행기 → 연결 프로그램 상태 알림.** 실행기가 1 초에 10 번 `{phase, seq_seen, remote_active}` 를 연결 프로그램의 loopback 포트로 보낸다. 0.3 초 끊기면 연결 프로그램은 「실행기 없음」 으로 본다.
2. **출력 자리 나누기 (`drain` 끝의 한 갈래).** 계산한 `velocity` 를 받는 쪽만 바꾼다.
   - 실행기 phase = `policy` 이고 신선함 → `applink` 묶음 `{seq, vx, vy, wz}` 를 보냄. Move 는 보내지 않음
   - 그 밖 → 지금처럼 `_walkable()` 이면 Move
   - 잠금 · 승인 회수 · 연결 끊김 · watchdog 같은 안전 관문은 갈래 앞에서 그대로 돈다. 갈래는 「무엇으로 내보내나」 만 정한다
3. **STOP 뜻.** 실행기 쪽은 순정 `StopMove` 가 없다.
   - 서버 STOP · 잠금 → 속도 0 을 보낸다. 실행기는 감속해 제자리에 선다. 엎드리지 않음
   - 비상 정지 → `mode: sit` (천천히 엎드림). 서 있는 채 감쇠 (L2 + B) 는 털썩 주저앉으므로 앱에서는 쓰지 않는다
   - 실측 정지 확인은 실행기의 명령 0 과 몸통 속도 (LowState) 로 한다
4. **모드 단추.** 웹 Shift + 1 → `mode: start`, Shift + 2 → AME-2 알림만 (팀장 11/22 13:05 · 13:12). classic · free walk 키는 아직 정하지 않음
5. **상태 보고.** `AgentState` 에 실행기 phase 를 선택 필드로 더한다 (화면이 실기 상태 다섯 가지를 보이게 · app-design-lx 명세와 맞춤)

## 정할 것

| 물음 | 안 |
|---|---|
| 서버 STOP 을 받으면 실행기에서 제자리 서기 (속도 0) 인가, 엎드리기인가 | 제자리 서기. 비상만 엎드리기 |
| START 로 넘기는 것을 웹에서 허용하나 | 리모컨 위 + start 와 같게 허용. 실기는 팀장 「보내」 뒤 |
| 실행기가 없을 때 START 단추 | 누를 수 없게 보이고 이유를 적음 |
| 감속 값 | 7 절 결정 (planner 권고 vx 1.2 /s) 을 실행기 · 시뮬에 함께 |

## 시험 계획 (실기 전)

- 가짜 SDK · 가짜 실행기로 갈래 시험: phase 별로 Move 와 UDP 중 하나만 나가는지, STOP · 잠금 · watchdog 이 두 경로 모두 0 을 내는지, 실행기 상태가 끊기면 Move 로 돌아가지 않고 0 을 유지하는지
- 기존 `GO2-SERVER-DRIVE.md` 시험 전체 회귀
- 실기는 A 단계 (등록 · 상태) → 순정 Move → START 순서, 각 단계 팀장 동의

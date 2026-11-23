> 분류: 실행 안내 · Jetson 부팅 자동 시작 + 첫 실기 확인 절차 (한 장)
> 작성: Claude 세션 (오흥재 지시, app-lx) · 2026-11-23
> 근거: 팀장 11/23 10:11 (lead-lx 전달) · `installer/policy-runner/` · `foothold_agent/policy/lowlevel.py` · 11/22 실기 기록 (live-5a · live-6a)
> 요지: Jetson 이 켜지면 실행기가 순정 상태로 기다리고, 리모컨 위 + start 로 START 가 붙는다. 첫 실기는 11/22 에 통과한 서 있는 상태 확인 순서 그대로
> 상태: 단위 파일만 둠 (켜지 않음) · 가짜 SDK 시험 59 통과 · 자동 시작 실기 0 회

# Jetson 자동 시작과 첫 실기 확인

## 어떻게 켜지나

1. Jetson 전원 → 화면 자동 로그인 (`/etc/gdm3/custom.conf` AutomaticLogin = nvidia) → 사용자 단위 `foothold-policy.service` 시작.
2. 실행기는 순정 (HIGH) 으로 기다린다. 이때 저수준 송신은 0 이다. Go2 가 꺼져 있어도 그대로 기다리고, Go2 를 켜면 LowState 를 받기 시작한다.
3. 리모컨 위 + start 를 사람이 눌러야 START 로 넘겨받는다. 30 분 승인 표식 대신 이 누름이 사람 확인이다 (`--armed-by-remote`).
4. 설정은 `~/foothold-policy-1122/runner.env` 한 파일에 있다. 전원을 껐다 켜도 같다. 상한 표와 감속 1.2 /s 는 코드에 들어 있다.
5. 기록: 실행 줄은 `~/foothold-policy-1122/live-auto.log`, 50 Hz 기록은 `~/foothold-policy-1122/trace/`.

| 할 일 | 명령 (Jetson) |
|---|---|
| 켜기 (한 번 · 팀장 확인 뒤) | `systemctl --user enable --now foothold-policy.service` |
| 지금 상태 | `systemctl --user status foothold-policy.service` |
| 끄기 (엎드린 뒤 순정) | `systemctl --user stop foothold-policy.service` |
| 자동 시작 그만 | `systemctl --user disable foothold-policy.service` |

## START 와 순정을 오가는 길 (11/22 밖에서 쓴 길 · 새 판도 같음)

| 조작 | 코드 길 (lowlevel.py, 3631d6e5 이후 줄) | 몸이 하는 것 |
|---|---|---|
| 순정 (선 채) → 위 + start | `tick` → `start_policy` (326) → `to_low` (201): CheckMode 로 이름을 읽고 ReleaseMode 를 반복 → 지금 관절 각에서 기본 자세로 2.5 초 | 선 채로 넘겨받음 · 앉지 않음 |
| START → ← / → + start | `tick` (294) → `back_to_factory` (519) → `lower` (401) → stop-mode sit → `sit_down` (501) 2 초 → 감쇠 → `to_high` (SelectMode mcf · CheckMode 확인) → RecoveryStand → 3 초 뒤 free walk · classic | 2 초 엎드렸다가 순정이 일으켜 세움 (11/22 밖에서 세 번 · 긁힘 없음) |
| 서 있는 채 넘김 (실기 미확인) | `stand_handover` (444): 선 채 목표를 잡은 채 SelectMode → 붙으면 놓음 → BalanceStand | `--stop-mode stand` 일 때만 · 기본 아님 |

11/22 14:27~14:46 의 소리 (팀장 「앉았다 일어날 때 · 앉을 때 모터 갈리는 소리」) 는 잡은 채 넘긴 판 (holding True · live-4e · 4f) 에서 났다. 그 판은 순정이 붙은 뒤 선 몸에 RecoveryStand 를 보내, 순정이 스스로 앉았다 일어났다. 소리가 우리와 순정이 겹쳐서인지, 순정의 그 동작에서인지는 가리지 못했다 (미확인). 새 stand 길은 RecoveryStand 대신 BalanceStand 를 쓴다 (실기 0 회).

## 1 초 끊김 (LIVENESS_S)

Jetson 과 Go2 를 잇는 유선 랜 (`enP8p1s0`) 의 LowState 를 기준으로 한다. Wi-Fi 와 인터넷은 상관없다. 선이 빠지면 순정 넘김 (SelectMode) 도 같은 선으로 가므로 닿지 않는다. 그러면 MODE_HIGH_FAILED 로 끝난다. LowCmd 가 끊겼을 때 펌웨어가 무엇을 하는지는 미확인이다.

## 첫 실기 확인 (11/22 15:10~15:18 에 통과한 순서 · 매달지 않음)

준비: Go2 순정 classic 으로 선 채. 주변 2 m 비움. app-lx 가 실행 줄 (`live-auto.log`) 을 본다.

1. 순정 classic 선 채 → 위 + start → 선 채로 넘겨받고 기본 자세 (2.5 초)
2. 왼 막대 앞 조금 → 천천히 걷기 · 놓으면 멈춤 (감속 1.2 /s 라 0.5 초쯤 미끄러지듯 섬)
3. 오른 막대로 제자리 회전 · 왼 막대 옆으로 옆 걸음
4. → + start → 2 초 엎드림 → 순정이 일으켜 세움 → classic (긁힘 소리 없음)
5. 위 + start (free walk 에서) → 다시 START
6. ← + start → free walk
7. 위 + start → L2 + A → 천천히 엎드림 → 감쇠
8. 엎드린 채 위 + start → 일어나 START
9. L2 + B → 즉시 감쇠 (선 채면 털썩)
10. 아래 + start → AME-2 알림만
11. `systemctl --user stop` → (START 였으면) 엎드린 뒤 순정 · `live-auto.log` 에 EXIT_SIT_DOWN · MODE_HIGH
12. Jetson 재부팅 → 자동으로 RUNNER_READY (armed remote) → 위 + start 로 붙음

한 줄마다 app-lx 가 사건 (MODE_LOW · POLICY_START · SIT_DOWN · MODE_HIGH · FACTORY_GAIT) 과 trace 파일을 확인해 기록한다.

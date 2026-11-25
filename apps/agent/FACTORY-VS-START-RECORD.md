> 분류: 실기 순서표 · 순정 (Sport · Classic) 과 START 의 같은 명령 판 50 Hz 기록 (팀장이 조작 · 한 장)
> 작성: Claude 세션 (오흥재 지시, app-lx) · 2026-11-23
> 근거: 팀장 11/23 09:36 결정 (lead-lx 09:39 전달 4 번) · `foothold_agent/policy/factory_record.py` · `run.py --trace-dir`
> 요지: 직진 0.5 · 1.0 · 1.5 m/s 와 제자리 회전 ±0.5 · ±1.0 rad/s 를 순정 두 모드와 START 에서 똑같이 하고, 관절 · 발 힘 · 기울기를 같은 꼴로 남긴다
> 상태: 순서표 · 가짜 SDK 시험만 (기록 프로그램 실기 0 회) · 로봇 조작은 팀장, 시작 · 끝 명령은 app-lx

# 순정 대 START 같은 명령 판 기록

## 준비 (app-lx)

- 순정 기록: `python3 -m foothold_agent.policy.factory_record --nic enP8p1s0 --out ~/foothold-policy-1122/trace --label sport` (classic 이면 `--label classic`). 구독만 하고 명령은 보내지 않는다. 실행기와 함께 켜 둬도 된다.
- START 기록: 실행기를 `--trace-dir ~/foothold-policy-1122/trace` 로 띄운다. START 가 켜진 동안 내내 남는다.
- 바닥: 평평하고 앞으로 10 m 이상 비어 있는 곳. 같은 자리에서 세 모드를 모두 한다.

## 순서 (팀장 · 줄마다 앞에서 2 초 서 있다가 시작 · 끝나면 2 초 서 있기)

| 줄 | 모드 | 할 것 | 막대 |
|---|---|---|---|
| 1 | Sport (free walk) | 직진 약 0.5 m/s · 5 초 | 왼 막대 앞 약 1/3 |
| 2 | Sport | 직진 약 1.0 m/s · 5 초 | 앞 약 2/3 |
| 3 | Sport | 직진 끝까지 · 5 초 | 앞 끝 |
| 4 | Sport | 제자리 왼 회전 약 0.5 · 5 초 | 오른 막대 왼 약 1/3 |
| 5 | Sport | 제자리 오른 회전 약 0.5 · 5 초 | 오른 막대 오른 약 1/3 |
| 6 | Sport | 제자리 왼 회전 약 1.0 · 5 초 | 왼 약 2/3 |
| 7 | Sport | 제자리 오른 회전 약 1.0 · 5 초 | 오른 약 2/3 |
| 8~14 | Classic (→ + start 또는 순정 앱) | 1~7 과 같게 | 같게 |
| 15~21 | START (위 + start) | 1~7 과 같게. START 막대: 앞 1/3 = 0.5 · 2/3 = 1.0 · 끝 = 1.5 m/s, 회전 1/3 = 0.5 · 2/3 = 1.0 rad/s | 같게 |

- 순정 막대가 몇 m/s 인지는 펌웨어 값이라 모른다 (미확인). 그래서 순정 기록에는 펌웨어 속도 추정 (`sport.vel`) 을 함께 남겨 실제 속도로 줄을 맞춘다.
- 줄 사이에 무슨 줄인지 말로 알려 주면 기록 시각에 표시한다 (막대 원값도 기록에 있음).
- 넘어질 것 같으면 순정은 순정 방식대로, START 는 L2 + A (천천히 엎드림) 또는 L2 + B (즉시 감쇠).

## 남는 것 (한 줄 = 20 ms)

`t · phase · stick (lx ly rx) · keys · want (자르기 전) · shape (none · clip · gap) · goal (자른 뒤) · cmd (가감속 뒤 = 정책 입력) · target (관절 목표 12) · q · dq · tau (12, 정책 순서) · foot 4 · gyro · grav · est_vx (기록용 ONNX 일 때) · sport (순정: mode · gait · height · vel · yaw_speed)`

## 끝나면

app-lx 가 Jetson `~/foothold-policy-1122/trace/` 를 ai-lx01 `/home/jay/data/overnight-1122/jetson-logs/trace/` 로 가져와 lead 에 경로를 알린다.

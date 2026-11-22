> 분류: 실행 안내 · Jetson 저수준 정책 실행부 (로봇 명령은 --live · 승인 표식 뒤)
> 작성: Claude 세션 (오흥재 지시, app-lx) · 2026-11-22
> 근거: 브라우저 시뮬 `mobile/sim/start-demo-adapter.js` 계약 · lab 정본 3 `start-m15500-app` 시험 벡터 · lab `05-depth-input.md` (초안)
> 요지: START m15500 관측 조립 · ONNX · 원본 깊이 60×60 · 저수준 실행기 (모드 전환 · 일어서기 · 정책 · 감쇠 · 넘어짐 RecoveryStand) · 리모컨 조작
> 상태: 초안 · ai-lx01 에서 시험 벡터 세 모드 통과 · Jetson 미설치 (11/22 밤 Jetson 꺼짐)

# Jetson 정책 실행부

## 무엇이 있나

| 파일 | 하는 일 |
|---|---|
| `foothold_agent/policy/start.py` | 관측 45 · 이력 10 · 깊이 두 장 (5 스텝마다 · 한 장 늦게) · 플래그 · GRU 되먹임 · ONNX 실행 · 관절 순서 (정책 ↔ SDK) · 목표 관절각 |
| `foothold_agent/policy/depth.py` | D435i 원본 깊이 → 시뮬 카메라 60×60 (광선 다시 뽑기 · 정규화 · 미검출 1.0) |
| `foothold_agent/policy/bench.py` | 정책 묶음 SHA 확인 · 시험 벡터 세 모드 · 추론 지연 (p50 · p95 · 최대) JSON |
| `foothold_agent/policy/lowlevel.py` | 저수준 실행기: StandDown → ReleaseMode → CheckMode 빈 이름 → 일어서기 (PD 60/5 → 25/0.5) → 정책 50 Hz (LowCmd 200 Hz) · L2+B 비상 감쇠 · 상태 50 ms 끊김 감쇠 · 넘어짐 0.5 초 → 감쇠 → SelectMode → RecoveryStand |
| `foothold_agent/policy/unitree.py` | 실기 경계 (unitree_sdk2py: LowState · LowCmd + CRC · SportClient · MotionSwitcherClient) |
| `foothold_agent/policy/run.py` | 실행 명령. 기본 dry-run (읽고 계산만, 송신 0). `--live` 는 go2_direct 승인 표식 (사람 · 0600 · 30 분) 이 있어야 시작 |

리모컨 (팀장 11/22 12:34): 위 + start = START 정책, 아래 + start = AME-2 (student 대기 · 알림만), ← + start = 순정 free walk, → + start = 순정 classic, L2 + B = 비상 감쇠.
리모컨 바이트 배치 · 고수준 모드 이름 ('normal' 또는 'mcf') 은 SDK 예제 기준이며 이 Go2 X 에서 아직 재지 않았다.
지금은 끔 (off) 모드만 연다. 복원 (reconstruction) 은 D435i 깊이 원천을 붙인 뒤.

## 지도 모드

| 모드 | ONNX | 깊이 | 실기 |
|---|---|---|---|
| reconstruction (복원) | map_on | D435i 원본 깊이 → 60×60 | 가능 (실기와 같은 조건) |
| off (끔) | map_off | 안 씀 (0) | 가능 · 고유수용감각만 |
| gt (정답 지도) | map_on | 안 씀 (0) | 불가 · 시뮬 전용 |

## Jetson 에서 (sudo 없음 · 로봇 명령 없음)

```sh
# ai-lx01 에서 묶음 복사 (Jetson 이 켜져 있을 때)
scp -r /home/jay/data/jetson-bundle-1122 <Jetson>:~/foothold-policy-1122
# Jetson 에서
bash ~/foothold-policy-1122/install.sh      # 사용자 영역 pip 설치 · 시험 벡터 · 지연 측정 → result-*.json
```

## ai-lx01 시험 (11/22 04:3x)

| 항목 | 값 |
|---|---|
| 시험 벡터 행동 오차 | 복원 4.1e-6 · 정답 2.3e-6 · 끔 3.5e-6 (허용 1e-4) |
| 입력 조립 오차 (이력 · 깊이 두 장) | 0 |
| 추론 1 회 (x86_64 · onnxruntime 1.32 CPU) | p50 1.94 ms · p95 1.99 ms |

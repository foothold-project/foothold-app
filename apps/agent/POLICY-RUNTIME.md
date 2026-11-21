> 분류: 실행 안내 · Jetson 저수준 정책 실행부 (로봇 명령 없음 단계)
> 작성: Claude 세션 (오흥재 지시, app-lx) · 2026-11-22
> 근거: 브라우저 시뮬 `mobile/sim/start-demo-adapter.js` 계약 · lab 정본 3 `start-m15500-app` 시험 벡터 · lab `05-depth-input.md` (초안)
> 요지: START m15500 관측 조립 · ONNX 실행 · 원본 깊이 60×60 다시 뽑기를 파이썬으로 옮기고, Jetson 에서 로봇 없이 확인 · 지연을 잰다
> 상태: 초안 · ai-lx01 에서 시험 벡터 세 모드 통과 · Jetson 미설치 (11/22 밤 Jetson 꺼짐)

# Jetson 정책 실행부

## 무엇이 있나

| 파일 | 하는 일 |
|---|---|
| `foothold_agent/policy/start.py` | 관측 45 · 이력 10 · 깊이 두 장 (5 스텝마다 · 한 장 늦게) · 플래그 · GRU 되먹임 · ONNX 실행 · 관절 순서 (정책 ↔ SDK) · 목표 관절각 |
| `foothold_agent/policy/depth.py` | D435i 원본 깊이 → 시뮬 카메라 60×60 (광선 다시 뽑기 · 정규화 · 미검출 1.0) |
| `foothold_agent/policy/bench.py` | 정책 묶음 SHA 확인 · 시험 벡터 세 모드 · 추론 지연 (p50 · p95 · 최대) JSON |

저수준 명령 (LowCmd) 송신 · SDK 모드 전환 (MotionSwitcher) · 넘어짐 일어서기 (SportClient.RecoveryStand) 는 아직 없다.
그 경계는 팀장 동의 뒤 `go2_direct` 의 승인 표식 경계 위에 따로 만든다.

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

# 조종 단계 조사·검증 — 2026-10-22

기준 `origin/dev 6edfac8`, 작업 `feature/drive-modes`.
제품 결정은 후진·제자리 회전·속도 3단 추가다. 후진 상한은 0.2 m/s,
뒤쪽 센서 없는 실기는 금지하며 이번 대상은 시뮬뿐이다.
조정 세션은 미리보기 복구를 우선하고 **이번 측정을 보류**하도록 지시했다.
따라서 새 명령은 열지 않았다. 기본 보통 0.6만 사용 가능하며 나머지 단계와
후진·제자리 회전에는 «시뮬에서 아직 확인 안 됨»을 표시한다.

## 코드·설정 근거

외부 원본은 읽기만 했다. 아래 경로는 각 원본 프로젝트 기준 상대 경로다.

| 경로 | 확인한 내용 |
|---|---|
| `apps/simmgr/launcher.py:NativeLauncher.start_world` | 기존 `Simulation` supervisor 사용, `v5_single/f1`만 허용 |
| `apps/agent/tools/sim/isolation.py:Simulation` | 기존 sensor runtime의 `live_map.py`, domain 93·새 partition 사용 |
| control-app exp33 `sensor-spec-20261016/stage/sensor-runtime-r1/sensor_isolation.py:TARGET` | 격리 대상은 `v5_single/f1`, domain 93. 속도 지원 근거가 아님 |
| 같은 runtime `live_map.py:49,65,1464,1606` | TESTED는 4개 명령. Ingress는 유한값을 전달하고 actor 관측에 사용. 전달 성공은 보행 성공이 아님 |
| control-app exp33 `gz/frozen.json`, `src/v2_obs.py:build_obs,load_policy` | 동결 npz actor, 관측235 중 속도명령3개를 배율 없이 사용 |
| foothold-lab `models/foothold-v2.json:training` | 학습 시 기록한 env.yaml을 정본으로 지칭 |
| foothold-lab `models/foothold-v2.env.yaml:990–1014` | vx 0.4~1.5, vy 0, wz -1~1, heading 100%, standing 10% |
| IsaacLab-ref `velocity_command.py:150–163` | heading 오차로 wz를 계산하고 standing 환경은 **세 축 모두 0**. standing 비율이 제자리 회전 학습을 뜻하지 않음 |
| `apps/agent/foothold_agent/phone/protocol.py:project_velocity,LIMITS` 및 `safety/core.py:quantize` | 현재 허용 집합으로 하향 투영. 후진·제자리·저속 거부 |

| 명령 (vx, vy, wz) | 학습 설정 | 실제 시뮬 보행 | 이번 활성화 |
|---|---|---|---|
| (0,0,0) | standing에서 세 축 0 | 기존 정지 경로 | 유지 |
| (0.6,0,0), (0.6,0,±0.5) | 전진·heading 설정 범위 안 | 기존 TESTED 집합, 기존 검증 기록 | 유지 |
| (-0.2,0,0) | vx 학습 범위 밖 | **미확인** | 차단 |
| (0,0,±0.5) | standing은 wz도 0, 이 조합 학습 근거 없음 | **미확인** | 차단 |
| (0.2,0,0) | vx 학습 범위 밖 | **미확인** | 차단 |
| (0.4,0,0) | vx 학습 범위 안 | **미확인** | 차단 |
| 그 밖의 빠름/전진·회전 조합 | 범위만으로 개별 조합 지원을 확정할 수 없음 | **미확인** | 차단 |

읽은 원물 SHA256:

- env.yaml: `a951ed5322428acc228fbd0b919dba5031af6bb567278edc763103a6a0f32292`
- live_map.py: `588c8a5dd9b7cf9ec3861f3173f97d17d44893b4a76ed6cdfec351137e6c313c`
- v2_obs.py: `5adf638a00a8c73b7e7e760430a7bd0cc9fbd5b25d57de76a31b404df746d320`
- actor npz: `a162d3bff81611de0ac60cd5aeb08dea3a3d06445992137d02b75c5bf3e604b8` (frozen.json과 일치)

## 변경한 안전 규칙과 유지한 경계

새 허용 명령·안전 규칙 변경은 **0**이다. `LIMITS.commands`, projection, Core,
STOP/zero·deadman·잠금·출입증·세대·재연결·watchdog DEAD 및 기존 셀프테스트는
그대로다. 범위표 최대값 안에 있다는 이유로 미확인 명령을 추가하지 않는다.
웹 회전 단독 입력도 기존처럼 에이전트가 최종 0으로 투영하며, 안내를 즉시 표시한다.
웹의 후진 입력은 기존처럼 허용 최소값 0으로 잘린다. STOP은 머리줄에 계속 표시한다.

## 후속 측정 방법 — 이번 실행 아님

조정 세션의 별도 작업 지시와 미리보기 비어 있음 확인 후에만 진행한다.
현재 phone/Core 경로는 후보를 거부하므로 **LIMITS에 먼저 추가해 측정하지 않는다**.
현재 worktree의 `runs/`에만 별도 측정 harness를 두고, 승인된 격리 시뮬의
raw ROS ingress에 후보 한 개씩 20 Hz로 최대10초 발행하는 방법을 제안한다.
이는 phone/Core 필터를 우회하는 **시뮬 전용 시험**이므로 조정 승인 범위에
명시해야 한다. 기존 미리보기 worktree와 control-app·ws_go2gz 추적 파일 수정은 0이다.

domain 93·partition·소유 unit·포트9430~9449를 먼저 확인하고 다른 사용자가 있는
시뮬에는 붙지 않는다. 기본 STOP 확인 → 명시 resume → 새 0 → 후보 → 0·STOP 확인의
순서로 수행하고 중단·예외·자원 부족·낙상 시 즉시0·STOP, 확인 실패 시 다음 후보 금지다.
독립 벽시계 watchdog과 기존 runtime TTL을 유지하고, 사용자 조종과 동시 발행하지 않는다.
후진은 최대0.2, 회전은 양 방향을 따로, 0.2/0.4 전진도 각각 측정한다.
명령별로 벽시계10초와 sim 경과시간, 실제 `cmd_applied`, 시작/끝 xyz·yaw·tilt,
몸통 기준 변위·최대 기울기·fallen·STOP 뒤 body_still을 기록한다.
정책 호출/명령 수신만으로 통과시키지 않고 방향에 맞는 몸 이동과 낙상0을 확인한다.
확인된 개별 조합만 후속 안전 PR에서 허용 목록과 투영에 반영하고 두 모델이 검토한다.

## 오프라인 시험

시험 결과와 재현 명령은 PR 본문에 기록한다. Python은 기존 읽기 전용 venv,
`PYTHONDONTWRITEBYTECODE=1`, worktree 내부 TMPDIR,
`PYTHONPATH=runs/drive-modes/fence:apps/agent:.`, 포트9410~9429 fence를 사용한다.
웹은 승인된 node_modules 읽기 전용 링크와 worktree 내부 Vite cacheDir를 사용한다.
각 무거운 실행은 MemAvailable ≥2.5 GiB인 `if` 안에서만 수행한다.
실제 ROS·Gazebo·실폰·실로봇·배포 검증은 이번에 수행하지 않았다.

| 실행 | 결과 |
|---|---|
| `python -m pytest apps/agent -q -p no:cacheprovider` | **899 passed, 1 skipped**, 기존 경고2개. opt-in 실제 DDS만 제외. 폰·기존 안전 셀프테스트·새 투영 경계58개 포함 |
| `npm --prefix apps/web test -- --config vite.drive-modes.config.ts` | **557 passed**, 11파일. 미확인 단계 선택 차단·후진/제자리 안내·STOP 회귀 포함 |
| `npm --prefix apps/web run typecheck` | 통과 |
| `npm --prefix apps/web run build -- --config vite.drive-modes.config.ts` | 통과. 배포하지 않음 |
| 투영 경계 변이2개 (로컬 메모리에서만 적용) | **2/2 검출**. vx 0.4를 0.6으로 승격: assertion14개, 회전 임계값0.5→0.49: assertion4개. 원본 파일 수정0 |

임시 Vite 설정은 기존 설정에 현재 worktree cacheDir만 덮어쓴 파일이며 제출에서
제외한다. 승인된 node_modules 링크도 시험 후 제거한다. 로컬 로그는
`runs/drive-modes/`에만 보존한다.

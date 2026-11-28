# simagent · 헤드리스 MuJoCo 시뮬 (Node 물리 자식)

`mobile/sim/` 의 MuJoCo wasm · Go2 · nvidia-demo f32 정책을 Node 에서 화면 없이 돌린다. 안전 계약 (조종권 · 잠금 · 재개 · cmd.ack) 은 파이썬 에이전트 하나가 갖는다. `apps/agent/foothold_agent/mujoco_bridge` 는 ros_bridge 의 Session · Core · RosSink · Inputs · Telemetry 를 그대로 쓰고, DDS 토픽 대신 이 자식의 stdin/stdout 을 쓴다.

```
서버 ── fh-agent/2 ──> 파이썬 mujoco_bridge (link/session.py · safety/core.py · ros_bridge.sink.RosSink)
                        └─ stdin/stdout 한 줄 JSON ──> node apps/simagent/child.mjs (MuJoCo wasm)
```

자산은 저장소 밖 `FH_SIM_SRC` 에 둔다 (mobile 과 같은 묶음: `node_modules/@mujoco/mujoco/` · `policy_v2.f32` · `assets/unitree_go2/`).

## 자식 계약 (child.mjs)

한 줄에 JSON 객체 하나 (UTF-8, `\n`). 뜻은 Gazebo `/v2_live/cmd_vel` · `/v2_live/stop` · `/v2_live/resume` · `/v2_live/state` 와 같다.

### stdin (부모 → 자식)

| 줄 | 뜻 |
|---|---|
| `{"t":"cmd","v":[vx,vy,wz]}` | 몸통 좌표 속도 (m/s · rad/s). `|vx|≤1.5 · |vy|≤1.0 · |wz|≤2.0` 유한값. STOP 상태 · 리셋 중이면 버린다 |
| `{"t":"stop"}` | `stop_requested=true`, 명령 0. 이미 STOP 이어도 같다 |
| `{"t":"resume"}` | `stop_requested=false`. 명령은 0 에서 다시 시작 (재개 허가 판단은 부모 Core 가 이미 했다) |
| `{"t":"reset"}` | STOP · `reset_in_progress=true` 한 번 내보낸 뒤 출발 자리로 되돌리고 `episode+1`. 리셋 뒤에도 STOP |
| 그 밖 (JSON 아님 · 모르는 `t` · 범위 밖 · 칸 수 틀림) | **STOP** 으로 잠그고 stderr 에 `{"error":"bad_line",...}` |

- 마지막 유효 `cmd` 뒤 0.5 s (`ttl_s`) 가 지나면 명령 0 (`ttl_expired=true`). 부모가 늦거나 멈춰도 로봇이 계속 걷지 않는다
- stdin 이 닫히면 (부모 종료) STOP 뒤 곧바로 끝난다 (종료 코드 0)

### stdout (자식 → 부모) · 20 Hz

`safety/core.py clean_state` · `ros_bridge/telemetry.py StateGate` 가 받는 `v2_live/state/1`:

| 칸 | 뜻 |
|---|---|
| `schema` | `"v2_live/state/1"` |
| `episode` · `sim_t` | 정수 · 시뮬 초 (리셋해도 줄지 않음) |
| `stop_requested` · `reset_in_progress` · `policy_running` | 관문 값 (bool) |
| `x` `y` `z` `yaw` | 몸통 위치 (월드 m) · 방향 (rad) |
| `vx` `vy` `wz` | 몸통 좌표 속도 |
| `upright` · `tilt_deg` · `fallen` | 곧추섬 (몸통 위 · 월드 위 내적) · 기울기 · `upright<0.5` |
| `base_height` | 몸통 z − 네 발 중심 z (m) |
| `body_still` | 수평 속도 < 0.05 m/s 이고 회전 < 0.05 rad/s |
| `cmd_applied` | 이번에 물리에 넣은 명령 (STOP · 리셋 · TTL 이면 `[0,0,0]`) |
| `cmd_age_s` · `ttl_s` · `ttl_expired` | 마지막 cmd 뒤 시간 · 0.5 · 끊김 |
| `battery_soc` | 시뮬 배터리 % (0~100). 물리 한 걸음마다 `대기 전력 + 1.04 × Σ|관절 토크 × 속도|` 를 적분한 남은 에너지 ÷ 236.8 Wh (`vitals.mjs`, 상수 근거는 그 파일 머리) |
| `joint_temp_c` | 관절 모터 온도 °C 12 개, 실기 SDK 순서 (FR · FL · RR · RL × 엉덩이 · 허벅지 · 종아리). MuJoCo 관절 토크로 1 차 열 모형 (`vitals.mjs`) 을 적분 |
| `source` · `plugin_mode` | `"mujoco"` · `"REALTIME"` |

부모 쪽에서 읽을 수 없는 줄 · 1 s 넘는 침묵 · 자식 종료는 모두 RosSink hold (0 · STOP, 새 STOP 확인과 새 unlock 전까지 움직임 없음) 이다. 자식 종료는 에이전트 종료로 이어진다.

## 실행

```
FH_SIM_SRC=<자산> node apps/simagent/run.mjs --seconds 5                # 자식 없이 N 초 헤드리스
FH_SIM_SRC=<자산> FOOTHOLD_AGENT_WS_URL=ws://127.0.0.1:8812/api/v1/agent/ws FOOTHOLD_AGENT_TOKEN=<시뮬 로봇 토큰> \
  PYTHONPATH=apps/agent python -m foothold_agent.mujoco_bridge           # 서버에 시뮬 로봇으로 붙음
```

선택: `FH_SIM_MAP` (collapsed-house-v2) · `FH_SIM_SEED` · `FH_SIM_NODE` · `FH_SIM_BATTERY_START` (시작 SoC, 100) · `FH_SIM_AMBIENT_C` (관절 주변 온도, 25). 예전 `FH_SIM_BATTERY_DRAIN` (고정 감소율) 은 없앴다 (읽지 않음). 에이전트 토큰은 자식 환경에 넘기지 않는다.

## 시험

```
cd apps/simagent && FH_SIM_SRC=<자산> FH_CONTRACT_PY=<pydantic 파이썬> npm test   # vitals.test.mjs 는 자산 없이도 돈다
cd apps/agent && python -m pytest tests/test_mujoco_bridge.py
```

아직 없는 것: simmgr 백엔드 (시뮬 로봇 공급) · 지도 연결 (pose 는 floor/map 이 없어 서버에 null 로 감) · 임무 실행.

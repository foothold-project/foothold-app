> 분류: 실행 안내 · 로컬 compose 한 벌 (웹 · 서버 · MuJoCo · 가짜 로봇 자리)
> 작성: Claude 세션 (오흥재 지시, app-lx) · 2026-11-19
> 근거: 팀장 11/19 「로컬 먼저 · 서버는 마지막」 · `apps/server/README.md` · `deploy/README.md` · `deploy/Caddyfile` · `deploy/prepare-release.sh` · `deploy/prepare_sim.py` · dev `2b19f592` 실사
> 요지: `docker compose -f deploy/local/compose.yaml up --build` 한 번으로 PostgreSQL 16 + 관제 서버 + 웹 (MuJoCo 브라우저 시뮬 포함) + HTTPS 앞단이 이 컴퓨터에만 뜬다. 가짜 로봇 · 기록 재생은 자리만 있고 미구현
> 상태: 초안 · 같은 명령을 docker 없이 하나씩 띄워 확인함 · `docker compose up` 자체는 아직 미실행 (작성 기기에 docker 없음)

# 로컬 compose 한 벌

## 1. 지금 foothold-app 이 도는 방식 (dev `2b19f592` 기준 · 실사)

| 부분 | 시작 명령 | 도는 곳 · 포트 | 설정 (이름만) | 서로 잇는 길 |
|---|---|---|---|---|
| 웹 `apps/web` | 개발 `npm run dev` (vite 127.0.0.1:5180) · 운영은 `npm run build` 뒤 Caddy 가 `dist` 를 정적으로 | 개발 PC 브라우저 · 운영 NaverCloud dev VM 의 Caddy 443 (`deploy/Caddyfile`) | `FH_API` (vite 프록시 대상, 기본 `http://127.0.0.1:8810`) · `FH_TUNNEL*` · `FH_PHONE_PORT_RANGE` | `/api/v1/*` REST · 화면 WS `/api/v1/ws` |
| 서버 `apps/server` | `uvicorn apps.server.fh_server.main:app --port 8810 --workers 1` | dev VM systemd `foothold-server.service` · 127.0.0.1:8810 · EnvironmentFile `/etc/foothold/server.env` | `FH_DATABASE_URL` · `FH_ORG_ID` · `FH_WS_ORIGIN` · `FH_FILES_ROOT` · `FH_ROBOT_INSTALLER_ENABLED` · `FH_SIM_MANAGER_URL` · `FH_SIM_AUTH_FILE` · `FH_PHONE_PASS_KEYS` | **PostgreSQL 16 전용** (SQLite 없음). 쿠키는 늘 Secure 라 브라우저는 HTTPS 로만 로그인 |
| 첫 준비 | `bootstrap roles` → `alembic upgrade head` → `bootstrap organization` | 사람이 한 번 | `FH_BOOTSTRAP_DATABASE_DSN` · `FH_MIGRATE_*` · `FH_*_PASSWORD` · `FH_ORG_*` · `FH_BOOTSTRAP_*` | 두 번째 실행은 역할 · 조직이 있다며 멈춤 |
| agent 노트북 앱 | `python3 -I -m foothold_agent.desktop --managed` (.deb, 사용자 unit `foothold-robot.service`) | 노트북 Ubuntu amd64 · 설정 화면 127.0.0.1:9611 · 로그인 자동 시작 (`/etc/xdg/autostart`) | 설치 루트 `server.json` · 키 `~/.config/foothold/agent.json` | agent WS `/api/v1/agent/ws` (wss, ws 는 loopback 만) |
| agent Jetson | `~/foothold-robot/venv/bin/python -I ~/foothold-robot/launch.py` (`foothold_agent.setup --headless --onboard`) | Jetson aarch64 · 상태 화면 loopback 9539 | `connection.json` · `private/agent.json` | 같은 agent WS · 시작하면 실 DDS 참가 |
| agent go2_direct · go2_readonly · ros_bridge | `python -m foothold_agent.go2_direct` · `… go2_readonly --nic X` (9610) · `… ros_bridge` (simmgr 가 띄움) | 현장 PC · 로봇 LAN · dev VM | `FH_GO2_*` · `FOOTHOLD_ROBOT_ID` · `FOOTHOLD_AGENT_WS_URL` · `FOOTHOLD_AGENT_TOKEN` · `FOOTHOLD_PHONE_*` | 모두 실 DDS (unitree SDK) 또는 ROS (rclpy) 필요. **서버에 붙는 가짜 로봇 실행 명령은 없음** |
| 토큰 연결 패널 | agent 가 `POST /api/v1/pairing/start` 로 일회용 코드 (10 분) → 로컬 화면 9611 · 9539 에 코드 · QR → 웹 「+ 로봇 연결하기 → 새 로봇 추가」 (`apps/web/src/pairing.tsx`) 가 `claim` · `confirm` → agent 가 `poll` 로 agent 토큰 · WS 주소를 받음 | 서버 `fh_server/pairing.py` | agent 의 서버 주소는 https (http 는 127.0.0.1 만) | 다른 길: 총괄이 `POST /robots` 하면 `agent_token` 을 한 번 보여 줌 |
| MuJoCo 시뮬 | 브라우저 정적 페이지 `/sim/index.html?from=web` (`mobile/sim`, `@mujoco/mujoco` 3.17.0 wasm) | **사용자 브라우저 · 폰에서 계산** (GPU 서버 안 씀). 서버는 파일만 | 빌드 때 비공개 자산 `FH_SIM_ASSETS` (PC) · `/var/lib/foothold/sim-policy` (서버) | 정책 · MuJoCo 런타임 · three · Go2 메시는 저장소에 없음. 자산이 없으면 `prepare_sim.py` 가 `/sim/` 을 빼고 웹만 |
| Gazebo 시뮬 (참고) | `python -m apps.simmgr` (127.0.0.1:9430) + transient unit | dev VM `foothold-simmgr.service` | `FH_SIM_*` | 이 compose 에 넣지 않음 (ROS · rootfs 필요). `FH_SIM_RUN≠1` 이면 FakeLauncher |

옛 `web/` · `ui/` · `server/` · `sim/v2_link.py` 는 배포 묶음에 들어가지 않는다 (`deploy/prepare-release.sh`).

## 2. 띄우기

```sh
cp deploy/local/.env.example deploy/local/.env     # 비밀번호 · UUID 를 새로 채운다
docker compose -f deploy/local/compose.yaml up --build
# https://localhost:8443 → .env 의 FH_BOOTSTRAP_USERNAME / FH_BOOTSTRAP_PASSWORD 로 로그인
```

| 서비스 | 하는 일 | 끝나는가 |
|---|---|---|
| `db` | postgres:16 · 볼륨 `db` | 계속 |
| `init` | 역할 → alembic → 첫 조직 · 총괄 (`init_db.py`). 이미 있으면 건너뜀 | 한 번 |
| `server` | uvicorn 단일 프로세스 · `fh_app` 역할 · 로봇 설치 파일 빌드 끔 | 계속 |
| `web` | `apps/web` 빌드 + `prepare_sim.py` 로 MuJoCo 묶기 → 볼륨 `webdist` | 한 번 |
| `caddy` | `https://localhost:8443` · `tls internal` · `/api/v1` → server (WS 포함) · 정적 | 계속 |
| `robot` | 가짜 로봇 · 기록 재생 **자리 (주석 · 미구현)** | |

- 열리는 포트는 `127.0.0.1:8443` 하나다. 운영 서버 · 로봇 · Gazebo · 클라우드에 닿는 서비스는 없다.
- 브라우저가 Caddy 내부 인증서에 한 번 경고한다. 쿠키가 Secure 라 http 로는 로그인되지 않는다.
- MuJoCo: `.env` 의 `FH_SIM_ASSETS` 에 비공개 자산 폴더를 주면 `/sim/` 이 들어간다. 비우면 웹만 뜬다 (경고 한 줄).
- 다시 처음부터: `docker compose -f deploy/local/compose.yaml down -v` (로컬 볼륨만 지운다).
- 바꾼 코드를 다시 보려면 `up --build` (웹은 `web` 이 매번 새로 빌드한다).

## 3. 가짜 로봇 · 기록 재생 (미구현)

- 저장소에는 서버 agent WS 에 붙어 상태를 보내는 가짜 로봇 실행 명령이 없다. agent 의 진입점은 모두 실 DDS 나 ROS 가 필요하다.
- `mobile/sim/go2-replay.js` 는 이름과 달리 파일 재생이 아니라, 서버에서 실기 상태를 받아 보여 주기만 한다.
- 만들려면 `foothold_agent.link.client.Client` 와 가짜 출처를 이어야 한다. 참고할 시험 코드는 `apps/server/tools/agent_reconnect_case.py` 다.
- 실기 기록 (예: `20261119-2229-lodging-full`) 을 읽어 같은 WS 로 흘리는 재생기도 마찬가지로 만들어야 한다.
- `.env.example` 의 `FOOTHOLD_ROBOT_ID` · `FOOTHOLD_AGENT_TOKEN` · `FH_LOCAL_REPLAY_DIR` 는 그 자리를 위한 칸이다.
- agent 는 ws 를 loopback 에만 허용한다. 그래서 컨테이너 안 가짜 로봇은 Caddy 의 wss 를 거쳐야 하고, 그러려면 내부 인증서를 믿게 하는 설정이 필요하다.

## 4. 확인한 것과 못 한 것

docker 없이 같은 명령을 하나씩 띄워 확인했다 (작성 기기, 11/19).
- **PostgreSQL 16:** `pgserver` 로 띄웠다.
- **init:** 이미지와 같은 최소 사본 (`apps/server` · `apps/contracts` · `apps/simmgr/worlds`) 에서 두 번 돌렸다. 첫 번째는 역할 · 마이그레이션 · 조직을 만들었고, 두 번째는 모두 건너뛰었다.
- **server:** `fh_app` 역할로 시작했고 권한 검사를 통과했다.
- **web:** 빌드를 통과했다. 자산 없이 돌리면 `/sim/` 이 빠진다는 경고가 나온다. 작성 기기의 Node 는 24 이고, 이미지는 node:22 다.
- **Caddy 2.8.4:** `validate` 와 `fmt` 를 통과했다. 이 설정으로 띄운 뒤 HTTPS 로 다음을 확인했다.
  - `/` 와 깊은 주소가 200 이고, `X-Frame-Options: DENY` 가 붙는다.
  - `/api/x` 는 404 다.
  - 로그인이 200 이고, `/me` 는 `ORG_ADMIN` 이다.
  - 화면 WS `wss://…/api/v1/ws` 가 열리고 첫 프레임 ping 을 받는다.

못 한 것:
- `docker compose up` 자체 (이미지 빌드, 서비스 사이 이름 `db` · `server`, 볼륨 권한) 는 아직 돌려 보지 않았다.
- `/sim/` 이 실제 자산으로 들어가는지는 보지 않았다. 이 기기에서는 자산 폴더를 찾지 못했다.
- 가짜 로봇은 만들지 않았다.
- 폰에서 이 판을 여는 것은 보지 않았다. 지금은 127.0.0.1 에만 열린다.

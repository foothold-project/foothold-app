# 리허설 프로젝트 API — `/api/rehearsal` (R1 · 개정 2: 구현 확정 — head 파일 없음·판 무결성·보관함 용량·층당 계단 16)

2026-10-18 · RL mentor · root·UI 공유용. 서버 모듈 `server/rehearsal.py`(저장·검증·분석·내보내기) + `server/rehearsal_http.py`(본문 상한·JSON 해석, 프레임워크 없음). 관문/v2_link 연결은 root 단독.
**이 API 는 계획 작성·2D 기하 검토·파일 생성만 한다.** Gazebo·ROS 실행, 로봇 명령, 물리·넘어짐·실도달 판정은 하지 않는다. 응답 문구도 «실행/측정»으로 읽히지 않게 쓴다.

## 1. 숫자 합의 (root 최종 용량 기준 반영)

| 항목 | 값 | 넘으면 |
|---|---|---|
| 요청 본문(전체 JSON) | **≤ 262144 B (256 KiB)** | 413 `요청이 256 KiB 를 넘습니다` |
| 응답 JSON | **≤ 1048576 B (1 MiB)** | 서버가 만들지 않음(아래 상한으로 보장, 넘으면 500 `응답 상한`) |
| export ZIP 원본 | **≤ 655360 B (640 KiB)**, base64 로 JSON 안 | 413 `내보내기 파일이 640 KiB 를 넘습니다` |
| scene 정규 JSON(배경 포함) | ≤ 245760 B (240 KiB) | 413 |
| 배경 도면(디코드 후) | ≤ 131072 B (128 KiB), PNG/JPEG, 가로·세로 ≤ 4096 px (base64 ≈ 171 KiB → 기하 몫 ≈ 69 KiB 남김) | 400 — UI 가 축소·압축, 서버는 자르거나 지우지 않음 |
| 프로젝트 수 | ≤ 64 | 409 `프로젝트 수 상한` |
| 프로젝트당 판(rev) | ≤ 200 | 409 `판 수 상한` (옛 판 자동 삭제 없음) |
| 저장소 전체 | ≤ 134217728 B (128 MiB) | 507 `저장 공간 상한` |
| 층 | 1–8 | 400 |
| 요소(벽·상자·계단) | ≤ 1500, 계단 펼친 뒤 상자 합 ≤ 2000 | 400 |
| 층당 출발 계단 | ≤ 16 (위층 바닥판 구멍 분해 격자 상한) | 400 `count` |
| 로봇 / 로봇당 센서 / 장비 | ≤ 12 / ≤ 6 / ≤ 200 | 400 |
| 경로 / 경로당 점 / 배치안 | ≤ 48 / 2–200 / ≤ 12 | 400 |
| 세계 크기 | 가로·세로 각 2–100 m, 해상도 0.05 m 고정(층 지도 ≤ 2000×2000) | 400 |
| 층 지도 칸 합(가로칸×세로칸×층 수) | **≤ 8,000,000** — 100×100 m 는 2층까지, 70×70 m 는 4층, 50×50 m 는 8층 | 400 `too_large` |
| 계산 작업량(래스터 행·BFS 칸·선분 표본·교차 비교, 안쪽 루프에서 셈) | ≤ 20,000,000 단위/요청 | 413 — 부분 결과 없음 |
| 계산 시간(안쪽 루프에서 monotonic 확인) | put 5 s · analyze 5 s · export 10 s | 503 — 부분 결과 없음 |
| 분석 경고 | 최대 200 건(넘으면 `truncated: true`) | — |

gzip 본문 미지원. 배경 도면은 ZIP 에 넣지 않는다(scene.json 에 `data_sha256` 만). 동시 처리는 root 연결의 Semaphore(1).
자원 상한은 «최소 2층 + 계단» 을 100×100 m 까지 지원하도록 잡았다. 이 PC 순수 CPU 시험의 실측 시간은 구현 보고에 적는다(다른 기기 속도 미측정).

## 2. 경로와 동작

- `GET /api/rehearsal` (쿼리 없음) → `list` 와 같은 응답(메타만, 큰 본문 없음).
- `POST /api/rehearsal` 본문 `{op, ...}`:

| op | 요청 | 200 응답 |
|---|---|---|
| `list` | `{op:'list'}` | `Listing` |
| `get` | `{op:'get', id, rev?}` (rev 생략 = 최신) | `{project: ProjectMeta, scene: Scene}` |
| `put` | `{op:'put', id: null, scene}` 새로 / `{op:'put', id, rev, scene}` 고치기(rev = 내가 본 최신 판) | `{project: ProjectMeta, new: boolean, warnings: Issue[]}` |
| `delete` | `{op:'delete', id, rev}` | `{id, deleted: true}` — 지우지 않고 보관함(`.trash/`)으로 옮김 |
| `analyze` | `{op:'analyze', scene}` 저장 전 초안 / `{op:'analyze', id, rev?}` 저장본 | `Analysis` |
| `export` | `{op:'export', id, rev?}` 저장본만 | `{filename, mime:'application/zip', base64, sha256, bytes, project: ProjectMeta}` |

오류 응답: `{error: string, issues?: Issue[], cur?: {rev, sha256}}`.
- 400 형식·검증 실패(issues 에 위치), 404 없는 프로젝트/판, 409 판 충돌(cur = 서버 최신) 또는 개수 상한, 413 크기·계산 작업량, 507 저장 공간, 503 계산 시간 상한·저장소 이상(심볼릭 링크 등 — 따라가거나 고치지 않음), 500 그 밖.
- `list`/GET 응답에는 `damaged: string[]`(읽을 수 없는 프로젝트 id), 저장소 경로 자체가 링크면 `broken: string` 이 붙는다(쓰기 op 는 503).
- 판 충돌(409)은 자동 덮어쓰기 하지 않는다. UI 가 다시 불러와 비교.

## 3. TS 타입

```ts
export type Vec2 = [number, number];
export type Pose2 = [number, number, number];          // x, y (m), yaw (rad)

export interface Floor { id: string; name: string; z: number; height: number }   // z 오름차순, 첫 층 z = 0
export interface Wall   { id: string; type: 'wall';   floor: string; a: Vec2; b: Vec2; thickness: number; height: number }
export interface Box    { id: string; type: 'box';    floor: string; center: Vec2; size: [number, number, number]; yaw: number }
export interface Stairs { id: string; type: 'stairs'; floor: string; to_floor: string; start: Vec2; yaw: number;
                          steps: number; riser: number; tread: number; width: number }
export type Element = Wall | Box | Stairs;

export type SensorKind = 'lidar_l1' | 'lidar_l2' | 'lidar_unknown' | 'camera' | 'depth';
export interface Sensor { id: string; kind: SensorKind; mount: [number, number, number, number] }  // 로봇 기준 x,y,z,yaw
export interface Robot  { id: string; name: string; model: 'go2_proxy'; floor: string; pose: Pose2; sensors: Sensor[] }
export type EquipKind = 'camera_fixed' | 'relay' | 'marker' | 'other';
export interface Equip  { id: string; kind: EquipKind; floor: string; pose: Pose2; label: string }
export interface Route  { id: string; robot: string; floor: string; points: Vec2[] }
export interface Scenario { id: string; name: string; robots: string[]; routes: string[] }

export interface Background {
  mime: 'image/png' | 'image/jpeg'; data_b64: string; floor: string;
  ref_px: [Vec2, Vec2];   // 이미지 픽셀(u 오른쪽, v 아래)
  ref_m:  [Vec2, Vec2];   // 같은 두 점의 세계 좌표(m) — 축척·회전·이동은 UI 가 이 두 쌍으로 계산
}
export interface Scene {
  schema: 'fh_rehearsal_scene/1'; name: string;
  world: { origin: Vec2; size: Vec2; resolution: 0.05; background: Background | null };
  floors: Floor[]; elements: Element[]; robots: Robot[]; equipment: Equip[];
  routes: Route[]; scenarios: Scenario[];
}

export interface ProjectMeta { id: string; name: string; rev: number; sha256: string; at: string; by: string;
                               bytes: number; counts: { floors: number; elements: number; robots: number; routes: number; scenarios: number } }
export interface Issue { level: 'error' | 'warn'; code: string; path: string; msg: string; at?: Vec2; floor?: string }
export interface Analysis {
  ok: boolean;                      // error 0 개
  issues: Issue[]; truncated: boolean;
  floors: { id: string; free: number; blocked: number; no_floor: number }[];       // 0.05 m 칸 수
  routes: { id: string; robot: string; length_m: number; blocked_segments: number[]; unreachable_points: number[] }[];
  crossings: { scenario: string; a: string; b: string; at: Vec2 }[];             // 같은 배치안·같은 층 경로 선분 교차
  note: string;                     // '2D 기하 검토 — 물리·넘어짐·실제 도달 판정 아님'
}
export interface Limits { [k: string]: number }
export interface Listing { projects: ProjectMeta[]; damaged: string[]; limits: Limits; broken?: string }
```

## 4. 검증 규칙(서버, 400)

- 정확한 키만(모르는 키·빠진 키 거부). 숫자 자리에 bool·문자열·NaN·Infinity 거부(JSON `NaN`/`Infinity` 토큰, `1e999` 도 거부). 중복 키 거부.
- ID `^[a-z][a-z0-9_]{0,31}$`(로봇은 24자 이하 — ROS 이름공간 `/<robot_id>` 로 쓰기 때문), **문서 전체에서 중복 금지**. `scene.name` 1–60자, 그 밖의 이름·라벨 0–60자, 제어문자 금지.
- 세계: `origin` 각 ±10000 m, `size` 각 2–100 m, `resolution` 은 0.05 만. 층 지도 칸 합(ceil(가로/0.05)×ceil(세로/0.05)×층 수) ≤ 8,000,000 → `too_large`.
- 층: 1–8개, `z` 0–200 m, `height` 1–10 m. 첫 층 `z` = 0, 이후 층은 바로 아래층보다 **1 m 이상 위·오름차순**.
- 숫자 범위 위반 코드 `range`, 형식 위반 `number`(bool·NaN·inf·문자열; 계단 `steps` 는 정수만). 목록 개수 위반 `count`, 열거값 밖 `enum`(로봇 `model` 은 `go2_proxy` 만, 센서 `kind` 5종, 장비 `kind` 4종 — §3).
- 센서 `mount` = [x, y, z, yaw] 각 ±2π 안이면서 로봇 기준 |x|·|y| ≤ 1 m, 0 ≤ z ≤ 1.5 m. 로봇당 센서 ≤ 6.
- 경로: 경로당 점 2–200, **모든 경로 점 합 ≤ 2000**, 경로 ≤ 48. 배치안 안에서 같은 로봇·경로 중복 금지(`dup`), 배치안 로봇 ≤ 12·경로 ≤ 48.
- 배경: `mime` PNG/JPEG, `data_b64` 문자열 길이 ≤ ceil(131072/3)·4, 엄격 base64, PNG IHDR/JPEG SOF 머리로 가로·세로 1–4096 px, `ref_px`·`ref_m` 각 점 2개(같은 점 금지, `ref_px` 는 이미지 안, `ref_m` 각 ±10000), `floor` 는 있는 층.
- 상자 합(계단 단·위층 바닥판 분해 포함) ≤ 2000, 층당 도착 계단 ≤ 16.
- 층 참조(`floor`·`to_floor`·`robot`·배치안의 robots/routes)는 존재해야 한다. 경로의 robot 이 배치안 robots 에 없으면 오류.
- 좌표: 모든 점·상자 모서리·로봇/장비 위치가 세계 사각형 안. 벽 길이 ≥ 0.05, 두께 0.05–1.0, 높이 0.05–10. 상자 각 변 0.05–50. yaw 는 |yaw| ≤ 2π.
- 계단: `to_floor` = 바로 위층, `steps × riser` 와 두 층 높이 차가 0.005 m 안, 단 수 2–40, 단 높이 0.05–0.25, 디딤 0.15–0.60, 폭 0.5–4.0(형식 상한일 뿐). **모든 계단에 경고 `stairs_range_unverified`(Gazebo 오르기 검증 치수 범위 미확인).**
- 로봇 출발 자세가 막힌 칸·바닥 없는 칸이면 오류(`robot_blocked`). 경로 점이 바닥 없는 칸이면 오류.
- 경고(저장은 됨): 경로 선분이 장애물(몸 반경 0.35 m 팽창, 0.2 m 보수 격자)을 지남 `route_blocked`, 출발점에서 경로 점으로 2D 연결 없음 `route_unreachable`, 같은 배치안 로봇 간 경로 교차 `route_crossing`, 벽·상자 높이가 층 높이를 넘음 `element_above_floor`, 회전된 계단의 위층 구멍은 축정렬 사각으로 근사 `stair_hole_aabb`, 로봇 모델 `generic_proxy_not_gait`(보행 검증 아님), 라이다 `lidar_spec_unconfirmed`.
- 2D 지도에서 계단은 아래층에서 막힘, 위층 구멍은 «바닥 없음» — 층 사이 연결은 지도로 판정하지 않는다(`route_unreachable` 은 같은 층 안에서만).

## 5. 생성 규칙(analyze·export 공통, 같은 기하)

- 원점·해상도·크기는 모든 층 공통(`world.origin`, 0.05 m, ceil(size/0.05)).
- 벽 → yaw 회전 상자(길이 + 두께, 양 끝은 두께/2 연장 없음), 상자 그대로, 계단 → 단마다 층 바닥부터 쌓은 상자, 2층 이상 → 두께 0.10 m 바닥판(계단 도착 구멍 제외).
- 층 지도 판정(현 `build_v5_world.py` 와 같은 수치): 막힘 = 고체 [lo,hi] 가 `hi > z+0.05` 이고 `lo < z+0.60`; 지지 = `z-0.06 ≤ hi ≤ z+0.05` 인 윗면(1층은 지면 전체 지지). 값: 막힘 0 / 빈칸 254 / 바닥 없음 205. PGM 첫 줄 = y 최대.
- `map.yaml`: `image: map.pgm`, `mode: trinary`, `resolution: 0.05`, `origin: [ox, oy, 0]`, `negate: 0`, `occupied_thresh: 0.65`, `free_thresh: 0.25`.

## 6. export ZIP 내용(고정 이름만)

| 경로 | 내용 |
|---|---|
| `world.sdf` | 고정 머리(physics·scene·light·ground, 플러그인 3개 고정: Physics·UserCommands·SceneBroadcaster) + 정적 모델 `fh_scene`(상자 collision/visual). 사용자 문자열은 XML escape, 경로·URI·플러그인 입력 없음. 로봇은 넣지 않는다 |
| `floors/<floor_id>/map.pgm`, `map.yaml` | 층별 GT 래스터(같은 기하) |
| `scene.json` | 저장 판 scene 의 **기록 사본**(배경 `data_b64` → `data_sha256` 으로 대체). **다시 불러올 수 있는 설계 파일이 아니다** — 원설계 JSON 은 UI 가 별도로 내보낸다. manifest `provenance` 에 출처 명시 |
| `plan.json` | 배치안별 로봇: 이름공간 `/<robot_id>`, 출발 자세, 모델 `generic_proxy`, 예정 토픽 이름 — **계획값, 기동·연결 아님** |
| `manifest.json` | 프로젝트 id·rev·scene sha256·파일별 sha256·생성기 판·주의(계단 치수 미확인, generic proxy 보행 검증 아님, Gazebo 실행 0) |

ZIP 은 결정적(같은 판 → 같은 sha256: 파일 순서·시각 고정).

## 7. 저장(서버)

- 위치: `<media>/rehearsal/`(기존 `docs.json`·SQLite·사진과 분리). `projects/<id>/r000001.json…`(불변, 같은 이름 있으면 실패) — **head 파일 없음**, 목록 메타는 마지막 판에서 매번 유도. 판 파일 봉투 `fh_rehearsal_rev/1` = {schema, id, rev, at, by, sha256, scene}(`at` = 저장 시각 `%Y-%m-%dT%H:%M:%S%z`, `by` = 연결이 넘긴 actor 문자열); 읽을 때 schema·id·rev·scene 정규 JSON sha256 을 대조하고, 어긋나면 그 프로젝트는 503 + 목록 `damaged`(고치거나 지우지 않음). **put·delete 도 잠금 안에서 최신 판을 먼저 확인** — 손상이면 503, 새 판·보관 이동 0(정상 수정으로 손상을 가리지 않음, 715 R1 보완). 이전 정상 판 get 은 계속 가능. 잠금 = 프로세스 lock + `fcntl.flock(.lock)`, 쓰기 = `O_CREAT|O_EXCL|O_NOFOLLOW` 임시 파일 → fsync → `os.link`(같은 이름 있으면 실패) → 폴더 fsync.
- 링크 차단: root·projects·.trash·.lock·프로젝트 폴더·판 파일이 symlink 이거나 정규 파일/폴더가 아니면 따라가지 않고 503(목록은 `damaged` 또는 저장소 전체 `broken`). 판 파일은 `O_NOFOLLOW` + fstat 정규 파일 + 크기 상한으로 읽는다.
- 용량 128 MiB 는 `.trash` 보관분을 **포함**해 센다(삭제 반복으로 우회 불가).
- 삭제 = `.trash/<id>-<시각>/` 로 이동(파일 삭제 없음).
- 모듈 메서드(root 연결용): `Store(root).listing() -> dict`, `Store(root).apply(body: dict, actor: str) -> (code, dict)`. HTTP 쪽: `rehearsal_http.handle_post(store, raw: bytes, actor) -> (code, dict)`, `handle_get(store) -> (code, dict)` — 본문 상한·엄격 JSON·응답 상한 검사 포함.

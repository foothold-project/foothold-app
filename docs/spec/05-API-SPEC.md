# FOOTHOLD 로봇 운영 플랫폼 — API 명세서

| 항목 | 내용 |
|---|---|
| 문서 번호 | FH-SPEC-05 |
| 판 | 0.1 (초안, 검토 대기) |
| 작성일 | 2026-10-19 |
| API 판 | `/api/v1` · 실시간 `fh-rt/1` · 에이전트 `fh-agent/1` |
| 상위 문서 | [04 아키텍처](04-ARCHITECTURE.md) · [02 기능 명세서](02-FUNCTIONAL-SPEC.md) |
| 관련 문서 | [06 DB](06-DB-DESIGN.md) |

정본 규칙: 이 문서는 사람이 읽는 명세다. 구현할 때 타입의 정본은 서버의 Pydantic 모델이고, 거기서 OpenAPI 와 TypeScript 타입을 만든다(지금 `contracts/v1` 의 Pydantic → TS 생성 방식 유지). 둘이 다르면 이 문서를 고친다.

---

## 1. 공통 규칙

### 1.1 주소·형식
- 기본 주소: `https://<현장 서버>/api/v1`
- 본문: JSON (UTF-8). 시각: ISO 8601 UTC (`2026-10-19T05:02:11.123Z`). ID: UUID 문자열.
- 길이 단위 m, 각도 rad, 속도 m/s·rad/s. 좌표는 지도 판의 좌표계(`map` 프레임).

### 1.2 인증
| 클라이언트 | 방법 |
|---|---|
| 웹 | `POST /auth/login` → 쿠키 `fh_s` (HttpOnly, Secure, SameSite=Strict). 상태를 바꾸는 요청은 `X-FH-CSRF` 헤더 필요 |
| 설치형 앱 | `POST /auth/login` (`client: "app"`) → `access_token`(15분) + `refresh_token`(30일). `Authorization: Bearer` |
| WS | 쿠키(웹) 또는 `POST /auth/ws-ticket` 로 받은 1회용 티켓(20 s) `?ticket=` |
| 로봇 에이전트 | `Authorization: Bearer <agent_token>` (등록 때 1회 발급) |

### 1.3 판(버전)과 충돌
- 편집 가능한 자원은 `version`(정수)을 가진다. 응답 헤더 `ETag: "<version>"`.
- 수정 요청은 `If-Match: "<version>"` 필수. 다르면 **409** + 현재 값.

### 1.4 오류 형식
```json
{ "error": { "code": "LEASE_HELD", "message": "다른 사람이 조종 중입니다.", "detail": { "holder": "이OO" } } }
```
- `message` 는 화면에 그대로 보여도 되는 한국어 문장. `code` 는 화면 분기용.

| HTTP | 언제 | 대표 code |
|---|---|---|
| 400 | 입력 형식 오류 | `VALIDATION` |
| 401 | 로그인 필요·만료 | `AUTH_REQUIRED` |
| 403 | 권한 없음 | `FORBIDDEN`, `NOT_ROBOT_OWNER`, `APPROVAL_REQUIRED` |
| 404 | 없음 | `NOT_FOUND` |
| 409 | 판 충돌·상태 충돌 | `VERSION_CONFLICT`, `LEASE_HELD`, `RUN_ACTIVE`, `APPROVAL_STALE`, `ALREADY_DECIDED` |
| 422 | 실행 전 점검 실패 | `PRECHECK_FAILED` (detail 에 실패 항목 목록) |
| 429 | 횟수 제한 | `RATE_LIMITED` |
| 503 | 로봇 끊김 등 | `ROBOT_OFFLINE` |

### 1.5 목록
- `?limit=50&cursor=<불투명 문자열>` → `{ "items": [...], "next_cursor": "..." | null }`

### 1.6 권한 표기
아래 표의 "권한" 열: **A** = 총괄 운영 관리자, **O** = 운영 관리자, **O(내)** = 그 로봇의 담당 운영 관리자, **로그인** = 로그인한 누구나(조직 안).

---

## 2. 인증·계정

| 메서드 | 경로 | 설명 | 권한 |
|---|---|---|---|
| POST | `/auth/login` | `{username, password, client:"web"|"app", device_label}` → 사용자 정보(+토큰) | 누구나 (실패 5회/5분 제한) |
| POST | `/auth/logout` | 이 기기 세션 끝. 열린 WS 는 4401 로 닫힘 | 로그인 |
| POST | `/auth/refresh` | 앱 토큰 갱신 | 앱 |
| POST | `/auth/ws-ticket` | WS 1회용 티켓 | 로그인 |
| GET | `/me` | 내 정보·역할·담당 로봇 ID 목록 | 로그인 |
| PATCH | `/me` | 표시 이름·알림 설정 | 로그인 |
| POST | `/me/password` | 비밀번호 변경 | 로그인 |
| GET | `/users` | 사용자 목록 | A |
| POST | `/users` | 운영 관리자 만들기 `{username, display_name, role, temp_password}` | A |
| PATCH | `/users/{id}` | 이름·역할·잠금 | A |
| DELETE | `/users/{id}` | 지우기(담당 로봇이 있으면 409) | A |
| GET | `/users/{id}/sessions` | 로그인 기기 목록 | A |
| DELETE | `/users/{id}/sessions/{sid}` | 강제 로그아웃 | A |

**사용자 객체**
```json
{ "id": "…", "username": "kim", "display_name": "김OO", "role": "ORG_ADMIN"|"OPERATOR",
  "locked": false, "robot_ids": ["…"], "created_at": "…" }
```

---

## 3. 로봇

| 메서드 | 경로 | 설명 | 권한 |
|---|---|---|---|
| GET | `/robots` | 목록 + 최신 상태 요약 `?scope=mine|all` | 로그인 |
| POST | `/robots` | 등록 → `{robot, agent_token}` (토큰은 이때 한 번만 보임) | A |
| GET | `/robots/{id}` | 상세(장치 목록·담당자·현재 실행·현재 층) | 로그인 |
| PATCH | `/robots/{id}` | 이름·담당 운영 관리자 `{name, owner_user_id}` | A |
| DELETE | `/robots/{id}` | 해제(실행 중이면 409) | A |
| POST | `/robots/{id}/agent-token` | 에이전트 토큰 재발급(기존 무효) | A |
| GET | `/robots/{id}/telemetry` | 그래프용 요약 `?from&to&fields=battery,speed,latency&step=10s` | 로그인 |
| POST | `/robots/{id}/floor` | 현재 층 사람 입력 `{floor_id}` | A, O(내) |
| POST | `/robots/{id}/stop` | STOP (WS 를 못 쓸 때 대체 경로) | 로그인 (볼 수 있으면) |

**로봇 요약 객체**
```json
{
  "id": "…", "name": "Go2-3", "model": "unitree_go2",
  "owner": { "id": "…", "display_name": "이OO" },
  "connection": "ONLINE"|"OFFLINE",
  "status": "IDLE"|"TELEOP"|"RUNNING"|"PAUSED"|"STOP_LATCHED"|"ERROR",
  "battery": { "soc": 82, "updated_at": "…" } | null,
  "location": { "floor_id": "…", "map_version_id": "…", "x": 3.2, "y": -1.1, "yaw": 1.57,
                "confidence": 0.91, "updated_at": "…" } | null,
  "lease": { "holder_type": "USER"|"RUN", "user": {"id":"…","display_name":"…"}|null, "since": "…" } | null,
  "current_run": { "id": "…", "scenario_name": "2층 순찰", "progress": {"done": 3, "total": 5} } | null,
  "devices": [ { "key": "rgb", "kind": "CAMERA_RGB", "label": "전면 카메라", "state": "OK"|"MISSING"|"ERROR" } ],
  "attention": ["BATTERY_LOW"] 
}
```
- 값을 받을 수 없으면 `null`. 화면은 `null` 줄을 숨긴다.

---

## 4. 관제 요약

| 메서드 | 경로 | 설명 | 권한 |
|---|---|---|---|
| GET | `/dashboard` | 요약 수치 | 로그인 |

```json
{ "robots_total": 12, "robots_running": 4, "robots_attention": 2, "approvals_pending": 3,
  "operators": [ { "user_id": "…", "display_name": "이OO", "robot_count": 3 } ]  // A 에게만
}
```

---

## 5. 지도

| 메서드 | 경로 | 설명 | 권한 |
|---|---|---|---|
| GET | `/sites` | 장소 → 건물 → 층 나무 (층마다 승인 판, 대기 요청 수) | 로그인 |
| POST | `/sites` · `/sites/{id}/buildings` · `/buildings/{id}/floors` | 만들기 `{name}` / 층은 `{name, level}` | A |
| PATCH/DELETE | `/sites/{id}` · `/buildings/{id}` · `/floors/{id}` | 이름 바꾸기·지우기(쓰는 시나리오가 있으면 409) | A |
| GET | `/floors/{id}/map-versions` | 판 목록 | 로그인 |
| GET | `/map-versions/{id}` | 판 정보 + 지도 요소(구역·지점·연결점) | 로그인 |
| GET | `/map-versions/{id}/image` | 지도 이미지(png) | 로그인 |
| GET | `/map-versions/{id}/diff?base={id}` | 두 판 차이(요소 목록 + 바뀐 칸 이미지) | 로그인 |
| POST | `/floors/{id}/map-versions` | 새 판 저장 `{base_version_id, image(업로드 ID), features, reason}`. A → 바로 `APPROVED`. O → `PENDING` + 결재 생성 | A, O |
| POST | `/floors/{id}/map-versions/{vid}/rollback` | 이 판으로 되돌리기. O → 결재 생성 | A, O |
| POST | `/uploads` | 큰 파일 올리기(지도 이미지·사진) → `{upload_id, sha256}` | 로그인 |
| POST | `/robots/{id}/slam/start` | SLAM 새 지도 시작 `{floor_id}` | A, O(내) |
| POST | `/robots/{id}/slam/save` | 지금 SLAM 결과를 새 판으로 저장 요청 | A, O(내) |
| GET | `/floor-connectors?building_id=` | 층 연결점 목록 | 로그인 |

**지도 요소(features)**
```json
{
  "zones": [ { "id": "…", "type": "NO_GO"|"SLOW", "name": "공사 구역", "polygon": [[x,y], …] } ],
  "waypoints": [ { "id": "…", "name": "계기판 A", "x": 1.0, "y": 2.0, "yaw": 0.0 } ],
  "connectors": [ { "id": "…", "kind": "STAIRS", "pair_floor_id": "…", "x": 9.1, "y": 0.4, "yaw": 3.14 } ],
  "edits": [ { "op": "ERASE"|"WALL", "polyline": [[x,y], …], "width": 0.1 } ]
}
```

---

## 6. 임무·시나리오·배정·실행

### 6.1 작업 카탈로그
| 메서드 | 경로 | 설명 | 권한 |
|---|---|---|---|
| GET | `/actions` | 작업 종류와 필요한 장치 `?robot_id=` 를 주면 그 로봇이 할 수 있는지 함께 | 로그인 |

```json
[ { "key": "PHOTO", "label": "사진 찍기", "params": {"camera": "rgb"}, "requires": ["CAMERA_RGB"],
    "available": true, "why_unavailable": null },
  { "key": "WAIT", "label": "대기", "params": {"seconds": 30}, "requires": [] },
  { "key": "OPERATOR_CONFIRM", "label": "운영자 확인", "params": {"prompt": "계기판 이상 없음?"}, "requires": [] },
  { "key": "SENSOR_LOG", "label": "센서 값 기록", "params": {"device": "…", "seconds": 10}, "requires": ["…"] } ]
```

### 6.2 임무
| 메서드 | 경로 | 설명 | 권한 |
|---|---|---|---|
| GET | `/missions` | 목록 | 로그인 |
| POST | `/missions` | 만들기 `{name, steps:[{action, params}]}` → 판 1 | A, O |
| GET | `/missions/{id}` | 최신 판 (`?version=n`) | 로그인 |
| PUT | `/missions/{id}` | 새 판 저장 (`If-Match`) | A, 만든 사람 |
| DELETE | `/missions/{id}` | 보관 처리(배정에 쓰이면 숨김만) | A, 만든 사람 |

### 6.3 시나리오
| 메서드 | 경로 | 설명 | 권한 |
|---|---|---|---|
| GET | `/scenarios` | 목록 `?mine=1&floor_id=` | 로그인 |
| POST | `/scenarios` | 만들기 → 판 1 | A, O |
| GET | `/scenarios/{id}` | 최신 판 (`?version=n`) | 로그인 |
| PUT | `/scenarios/{id}` | 새 판 저장 (`If-Match`) | A, 만든 사람 |
| DELETE | `/scenarios/{id}` | 보관 | A, 만든 사람 |
| POST | `/scenarios/preview` | 저장 전 경로 미리보기(층 경유·거리·갈 수 없는 지점) | 로그인 |

**시나리오 판 본문**
```json
{
  "name": "2층 순찰",
  "waypoints": [
    { "floor_id": "…", "map_version_id": "…", "x": 1.0, "y": 2.0, "yaw": 0.0,
      "waypoint_ref": "…" | null, "mission_id": "…", "mission_version": 2 }
  ],
  "finish": { "mode": "STAY"|"RETURN_TO_START"|"GO_TO", "target": {…} | null },
  "notes": ""
}
```

### 6.4 배정
| 메서드 | 경로 | 설명 | 권한 |
|---|---|---|---|
| GET | `/assignments` | `?robot_id=&status=` | 로그인 |
| POST | `/assignments` | `{scenario_id, scenario_version, robot_id, memo}`. A → `ACTIVE`. O(내) → `PENDING` + 결재 생성 | A, O(내) |
| DELETE | `/assignments/{id}` | 해제 | A, O(내) |

### 6.5 실행
| 메서드 | 경로 | 설명 | 권한 |
|---|---|---|---|
| POST | `/runs/precheck` | `{assignment_id}` → 점검 항목별 결과 | A, O(내) |
| POST | `/runs` | 시작 `{assignment_id, emergency_reason?: string}` → 점검 실패 시 422. `emergency_reason` 은 "배정 미승인" 하나만 실패했을 때만 허용 | A, O(내) |
| GET | `/runs` | 목록 `?robot_id=&status=&from&to` | 로그인(운영자는 범위 제한) |
| GET | `/runs/{id}` | 상세(지점별 결과·경로·사진) | 로그인 |
| POST | `/runs/{id}/pause` · `/resume` · `/abort` · `/return` | 실행 제어 | A, O(내) |
| POST | `/runs/{id}/floor-confirm` | 층 전환 구간 "n층 도착" 확인 `{floor_id}` | A, O(내) |
| POST | `/runs/{id}/operator-confirm` | 작업 `OPERATOR_CONFIRM` 응답 `{step, answer: "OK"|"NG", memo}` | A, O(내) |
| GET | `/runs/{id}/report` | 인쇄용 보고서(PDF) | 로그인 |

**점검 결과**
```json
{ "ok": false, "items": [
  { "key": "ASSIGNMENT", "ok": false, "message": "배정 결재가 아직 승인되지 않았습니다.", "emergency_allowed": true },
  { "key": "BATTERY", "ok": true, "message": "배터리 82%" },
  { "key": "LOCALIZATION", "ok": false, "message": "현재 층을 알 수 없습니다. 층을 입력하세요.", "action": "SET_FLOOR" } ] }
```

---

## 7. 결재

| 메서드 | 경로 | 설명 | 권한 |
|---|---|---|---|
| GET | `/approvals` | A: 전체 `?status=PENDING` / O: 내 요청만 | A, O |
| GET | `/approvals/{id}` | 상세(종류별 미리보기 자료 포함) | A, 요청자 |
| POST | `/approvals/{id}/approve` | 승인 `{comment?}`. 대상이 바뀌었으면 409 `APPROVAL_STALE` | A |
| POST | `/approvals/{id}/reject` | 반려 `{reason}` (필수) | A |
| POST | `/approvals/{id}/cancel` | 요청 취소 | 요청자 |
| POST | `/approvals/{id}/acknowledge` | 사후 확인 `{verdict: "OK"|"FLAGGED", comment}` | A |

**결재 객체**
```json
{ "id": "…", "kind": "MAP_REVISION"|"MAP_ROLLBACK"|"SCENARIO_ASSIGNMENT"|"POST_REVIEW",
  "status": "PENDING"|"APPROVED"|"REJECTED"|"CANCELED"|"STALE"|"OPEN"|"ACKNOWLEDGED"|"FLAGGED",
  "requester": {…}, "decider": {…}|null, "reason": "공사 구역 생김", "decision_comment": null,
  "target": { "type": "map_version"|"assignment"|"run", "id": "…" },
  "base_ref": { "type": "map_version", "id": "…" } | null,
  "emergency": false, "created_at": "…", "decided_at": null }
```

---

## 8. 기록·알림

| 메서드 | 경로 | 설명 | 권한 |
|---|---|---|---|
| GET | `/events` | 사건 `?category=&severity=&robot_id=&user_id=&run_id=&from&to` | 로그인(운영자는 범위 제한) |
| GET | `/events/export.csv` | 같은 필터로 CSV | 로그인 |
| GET | `/notifications` | 내 알림 `?unread=1` | 로그인 |
| POST | `/notifications/read` | `{ids}` 또는 `{all:true}` | 로그인 |
| POST | `/push/subscribe` | Web Push 구독 등록 | 로그인 |
| GET | `/media/{id}` | 사진 파일 | 로그인(범위 제한) |

**사건 객체**
```json
{ "id": "…", "at": "…", "robot_at": "…"|null, "category": "RUN"|"ROUTE"|"LINK"|"LEASE"|"APPROVAL"|"SAFETY"|"ACCOUNT",
  "code": "ROUTE_DEVIATION", "severity": "INFO"|"WARN"|"ERROR",
  "message": "14:02 Go2-3이 계획 경로에서 1.8 m 벗어났습니다.",
  "robot_id": "…"|null, "user_id": "…"|null, "run_id": "…"|null, "data": { "distance_m": 1.8 } }
```

---

## 9. 실시간 — 화면 ↔ 서버 (`wss://<서버>/ws`, `fh-rt/1`)

### 9.1 봉투
```json
{ "t": "<종류>", "id": "<요청 ID, 응답 짝>", "robot": "<robot_id>", ...본문 }
```
- 서버 → 화면 응답: `{ "t": "reply", "id": "…", "ok": true|false, "error": {…} }`
- 한 메시지 최대 4 KiB(영상 이진 프레임 제외).

### 9.2 화면 → 서버
| t | 본문 | 설명 | 권한 |
|---|---|---|---|
| `sub` | `{robots:[id], streams:["state","rgb","depth","lidar","map"]}` | 구독 설정(덮어쓰기). 영상은 구독이 있을 때만 로봇이 보냄 | 볼 수 있는 로봇 |
| `lease.take` | `{robot}` | 조종권 잡기. 비어 있으면 받음, 아니면 `LEASE_HELD` | A, O(내) |
| `lease.request` | `{robot}` | 조종권 요청(조종권자에게 창) | A, O(내) |
| `lease.respond` | `{robot, request_id, accept: bool}` | 조종권자의 응답 | 조종권자 |
| `lease.release` | `{robot}` | 조종 끝내기(0 명령 + 잠금 + 반납) | 조종권자 |
| `cmd` | `{robot, lease_id, seq, axes:[fx, fy, fw]}` | 조종 입력, 50 ms 마다(0 포함). 각 축 -1..1 | 조종권자 |
| `unlock` | `{robot, lease_id, stop_gen}` | 잠금 해제(지금 `resume` 의 CAS 규칙 유지) | 조종권자 |
| `stop` | `{robot}` | STOP | 볼 수 있으면 |
| `hidden` | `{robot}` | 화면 숨김·떠남 → 정지·잠금·반납 | 조종권자 |
| `photo` | `{robot}` | 사진 찍기 | 조종권자, 실행 중 담당자 |
| `ping` | `{}` | 연결 확인(조종 중이 아닐 때 5 s 마다) | 로그인 |

### 9.3 서버 → 화면
| t | 본문 | 빈도 |
|---|---|---|
| `state` | 로봇 요약 객체(§3)의 바뀐 부분 + `speed`, `latency_ms`, `stop_gen`, `latched` | 구독 로봇마다 10 Hz |
| `lease` | `{robot, holder, lease_id(조종권자에게만), since}` | 바뀔 때 |
| `lease.requested` | `{robot, request_id, requester:{display_name, role}, expires_at}` | 조종권자에게 |
| `lease.result` | `{robot, request_id, result: "ACCEPTED"|"DECLINED"|"TIMEOUT"|"CANCELED"}` | 요청자·조종권자에게 |
| `run` | `{run_id, robot, status, progress, current_step, wait: null|"FLOOR_CONFIRM"|"OPERATOR_CONFIRM"}` | 바뀔 때 |
| `event` | 사건 객체(§8) | 생길 때(권한 범위만) |
| `notify` | 알림 | 생길 때 |
| 이진 | `[1바이트 종류(1=rgb,2=depth,3=lidar)][16바이트 robot UUID][8바이트 시각 ms][내용]` | 구독 때 |

### 9.4 닫기 코드
| 코드 | 뜻 | 화면 |
|---|---|---|
| 4401 | 로그인 만료 | 로그인 화면 (재연결 안 함) |
| 4403 | 권한 없음 | 재연결 안 함 |
| 1013 | 서버 바쁨 | 1 s 뒤 재연결 |
| 그 밖 | — | 1 s 뒤 재연결(최대 10 s 간격까지 늘림) |

---

## 10. 실시간 — 서버 ↔ 로봇 에이전트 (`wss://<서버>/agent/ws`, `fh-agent/1`)

### 10.1 에이전트 → 서버
| t | 본문 | 빈도 |
|---|---|---|
| `hello` | `{agent_version, robot_model, firmware, devices:[…], map_versions:[sha256…], last_floor_id, latched, stop_gen}` | 연결 직후 1회 |
| `state` | `{pose:{floor_id,x,y,yaw,confidence}, speed, battery:{soc,voltage?}, latched, stop_gen, applied:[vx,vy,wz], mode, devices_changed?}` | 10 Hz |
| `event` | `{code, severity, robot_at, data}` (서버가 문장을 만든다) | 생길 때. 끊김 중 쌓은 것은 재연결 때 순서대로 |
| `run.update` | `{run_id, status, step, progress, path_deviation_m?, fail_code?}` | 바뀔 때 |
| `cmd.ack` | `{seq, applied:[…], reason?}` | 10 Hz 로 묶어서(마지막 seq) |
| `media` | `{kind:"photo", run_id?, step?, upload_id}` (사진은 먼저 `/uploads` 로 올림) | 찍을 때 |
| 이진 | 영상 프레임(§9.3 형식, robot 칸은 비움) | 서버가 켰을 때만 |

### 10.2 서버 → 에이전트
| t | 본문 | 설명 |
|---|---|---|
| `lease` | `{lease_id|null, holder_type}` | 현재 조종권. `null` 이면 어떤 cmd 도 거부 |
| `cmd` | `{lease_id, seq, axes, t_server}` | 화면 입력 전달 |
| `stop` | `{by_user_id}` | 즉시 0 명령 + 잠금 |
| `unlock` | `{lease_id, stop_gen}` | 잠금 해제 요청 |
| `streams` | `{rgb:bool, depth:bool, lidar:bool, map:bool}` | 영상 켜기/끄기 |
| `run.start` | `{run_id, plan:{segments:[{floor_id, map_version_id, goals:[…], connector?}]}, missions:{…}, policy:{link_loss_wait_s:30}}` | 실행 내려보내기 |
| `run.control` | `{run_id, op:"pause"|"resume"|"abort"|"return"}` | 실행 제어 |
| `run.confirm` | `{run_id, kind:"FLOOR"|"OPERATOR", data}` | 사람 확인 결과 전달 |
| `map.sync` | `{versions:[{id, floor_id, sha256, url}]}` | 승인 판 미리 내려받기 |
| `floor.set` | `{floor_id}` | 사람 입력 층 |
| `slam` | `{op:"start"|"save"|"cancel", floor_id}` | 새 지도 |

### 10.3 에이전트 쪽 필수 규칙 (서버가 무엇을 보내든)
1. `lease_id` 가 지금 값과 다르거나 `null` 이면 cmd 거부.
2. cmd 가 0.3 s 안 오면 0 명령 + 잠금.
3. 잠금 상태에서는 `unlock` 뒤 중립 입력 한 번이 와야 움직임.
4. 속도 한계·명령 단계화는 에이전트 설정이 정본(서버 값으로 늘릴 수 없음).
5. 서버 연결이 끊기면 조종 중 → 즉시 정지·잠금, 실행 중 → `link_loss_wait_s` 뒤 정지·잠금.
6. 재시작하면 잠금 상태로 시작.

---

## 11. 지금 API 와의 대응 (이식 참고)
| 지금 (v2_gate / v2_link) | 새 API |
|---|---|
| `/api/login`, `/api/whoami`, `/api/logout` | `/auth/login`, `/me`, `/auth/logout` |
| `/api/robots?scope=mine|all`, `/api/robots/claim` | `/robots?scope=`, `POST /robots` (등록은 총괄) |
| `/api/r/{rid}/ws`, `/api/r/{rid}/watch/ws` | `/ws` 하나 + `sub` (로봇별 권한은 서버가 판단) |
| WS op `take/release/cmd/stop/resume/hidden/photo` | `lease.take/lease.release/cmd/stop/unlock/hidden/photo` |
| WS op `map_list/map_get/map_start/map_save` | REST `/floors/…/map-versions`, `/robots/{id}/slam/*` |
| `/api/docs` (zone/tmpl/mission/run/note 문서) | `/map-versions`(구역), `/missions`, `/scenarios`, `/runs` |
| 상태 `status` 10 Hz | `state` 10 Hz |
| 닫기 코드 4401/4403/1013 | 같음 |

---

## 12. 변경 이력
| 판 | 날짜 | 내용 |
|---|---|---|
| 0.1 | 2026-10-19 | 최초 작성 |

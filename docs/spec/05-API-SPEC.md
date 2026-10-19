# FOOTHOLD 로봇 운영 플랫폼 — API 명세서

| 항목 | 내용 |
|---|---|
| 문서 번호 | FH-SPEC-05 |
| 판 | 0.3 (초안, 검토 대기) |
| 작성일 | 2026-10-19 |
| API 판 | `/api/v1` · 실시간 `fh-rt/1`(`/api/v1/ws`) · 에이전트 `fh-agent/1`(`/api/v1/agent/ws`) |
| 상위 문서 | [04 아키텍처](04-ARCHITECTURE.md) · [02 기능 명세서](02-FUNCTIONAL-SPEC.md) |
| 관련 문서 | [06 DB](06-DB-DESIGN.md) |

정본 규칙: 이 문서는 사람이 읽는 명세다. 구현할 때 타입의 정본은 서버의 Pydantic 모델이고, 거기서 OpenAPI 와 TypeScript 타입을 만든다(지금 `contracts/v1` 의 Pydantic → TS 생성 방식 유지). 둘이 다르면 이 문서를 고친다.

---

## 1. 공통 규칙

### 1.1 주소·형식
- 기본 주소: `https://<현장 서버>/api/v1`
- 본문: JSON (UTF-8). 시각: ISO 8601 UTC (`2026-10-19T05:02:11.123Z`). 서버가 보내는 시각은 UTC 로 바꿔 `Z` 로 끝나고, 받는 시각은 시간대가 있어야 한다. ID: UUID 문자열. 예외: 사건(`events`)·알림(`notifications`)·조종권 기록(`lease_log`)은 DB 의 bigint 를 **십진 문자열**로 보낸다(`"184467"`). JS number 로 바꾸지 않는다.
- 길이 단위 m, 각도 rad, 속도 m/s·rad/s. 좌표는 지도 판의 좌표계(`map` 프레임).
- 실시간 메시지의 정수 필드(`seq`·`stop_gen`·`stop_ref`·`step` 등)는 0 이상 2^53-1(JS 안전 정수) 이하만 받는다. bool·실수·범위 밖 값은 형식 오류다.

### 1.2 인증
| 클라이언트 | 방법 |
|---|---|
| 웹 | `POST /auth/login` → 쿠키 `fh_s` (HttpOnly, Secure, SameSite=Strict, `Path=/api/v1`, 기본 24시간) + 응답 본문 `csrf_token`. 상태를 바꾸는 요청은 `X-FH-CSRF` 헤더 필요(틀리면 403 `FORBIDDEN`). 새로고침 뒤에는 `GET /auth/session` 으로 CSRF 값을 다시 받는다 |
| 설치형 앱 | `POST /auth/login` (`client: "app"`) → `access_token`(15분) + `refresh_token`(30일). `Authorization: Bearer`. 갱신할 때마다 두 토큰을 새로 주고, 이미 쓴 `refresh_token` 을 다시 쓰면 그 기기 세션을 끝낸다 |
| 화면 WS | 웹: `fh_s` 쿠키 + `Origin` 검사(설정한 출처, 없으면 같은 출처와 정확히 일치. 와일드카드·전달 헤더 안 믿음). 앱: `Authorization: Bearer`(Origin 검사 안 함). 1회용 티켓은 쓰지 않는다 |
| 로봇 에이전트 | `Authorization: Bearer <agent_token>`. 서버는 sha256 만 `robots.agent_token_hash` 에 저장한다. 발급·재발급은 총괄의 `POST /robots/{id}/agent-token`(§3): 옛 토큰은 즉시 무효(새 연결 거부, 이미 열린 연결은 주기 인증 확인에서 4403), 원문은 그 응답에서 한 번만 보인다 |

- 비밀번호 길이: 지금 구현은 1~1024자만 검사한다. 최소 길이·복잡도 정책은 **미정(결정 필요)**.

### 1.3 판(버전)과 충돌
- `version`·`If-Match` 는 **임무(`missions`)·시나리오(`scenarios`) 본체**에만 쓴다. 응답 헤더 `ETag: "<version>"`, 수정 요청은 `If-Match: "<version>"` 필수, 다르면 **409** + 현재 값.
- 지도는 `version` 대신 새 판 저장 때의 `base_version_id` 로 같은 검사를 한다(다르면 409). `map_versions.number` 는 화면에 보이는 판 번호일 뿐 충돌 검사에 쓰지 않는다.
- 그 밖의 수정 가능 자원(계정·로봇·장소/건물/층·조직 설정은 총괄만, `/me` 의 내 정보는 본인만 고침)은 동시 수정이 드물어 마지막 저장이 이기고, 바뀐 내용은 사건으로 남긴다.

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
| 409 | 판 충돌·상태 충돌 | `VERSION_CONFLICT`(같은 값이 이미 있음 포함), `LEASE_HELD`, `RUN_ACTIVE`, `APPROVAL_STALE`, `ALREADY_DECIDED`, `LAST_ORG_ADMIN` |
| 422 | 실행 전 점검 실패 | `PRECHECK_FAILED` (detail 에 실패 항목 목록) |
| 429 | 횟수 제한 | `RATE_LIMITED`, `LEASE_REQUEST_COOLDOWN` |
| 500 | 서버 내부 오류 | `INTERNAL_ERROR` (입력·토큰을 되돌려 보이지 않음) |
| 503 | 로봇 끊김·서버 일시 불가 | `ROBOT_OFFLINE`, `SERVER_BUSY` |

### 1.5 목록
- `?limit=50&cursor=<불투명 문자열>` → `{ "items": [...], "next_cursor": "..." | null }`

### 1.6 권한 표기
아래 표의 "권한" 열: **A** = 총괄 운영 관리자, **O** = 운영 관리자, **O(내)** = 그 로봇의 담당 운영 관리자, **로그인** = 로그인한 누구나(조직 안).

---

## 2. 인증·계정

| 메서드 | 경로 | 설명 | 권한 |
|---|---|---|---|
| POST | `/auth/login` | `{username, password, client:"web"|"app", device_label}` → 로그인 응답(아래) | 누구나 (IP·계정마다 실패 5회/5분 넘으면 429 `RATE_LIMITED`) |
| POST | `/auth/logout` | 이 기기 세션 끝 + 웹 쿠키 지움. 열린 WS 는 4401 로 닫힘 | 로그인 |
| POST | `/auth/refresh` | 앱 토큰 갱신 `{refresh_token}` → `{access_token, refresh_token}` | 앱 |
| GET | `/auth/session` | 지금 세션 확인 → `{client:"web"|"app", csrf_token}`. 웹은 새 `csrf_token`, 앱은 `null`. 새로고침 뒤 CSRF 재획득용 | 로그인 |
| GET | `/me` | 내 정보·역할·담당 로봇 ID 목록 | 로그인 |
| PATCH | `/me` | 표시 이름·알림 설정 `{display_name?, notify_prefs?}` | 로그인 |
| POST | `/me/password` | 비밀번호 변경 `{current_password, new_password}`. 성공하면 이 사용자의 모든 세션(지금 기기 포함)을 끝낸다. 현재 비밀번호가 틀리면 403, 5회/5분 넘으면 429 | 로그인 |
| GET | `/users` | 사용자 목록 | A |
| POST | `/users` | 계정 만들기 `{username, display_name, role, temp_password}` | A |
| PATCH | `/users/{id}` | 이름·역할·잠금. 잠그면 그 사용자의 세션을 모두 끝낸다 | A |
| DELETE | `/users/{id}` | 지우기(보관 처리, 세션 모두 끝). 담당 로봇이 있으면 409 `VERSION_CONFLICT` | A |
| GET | `/users/{id}/sessions` | 로그인 기기 목록 | A |
| DELETE | `/users/{id}/sessions/{sid}` | 강제 로그아웃 | A |

**사용자 객체**
```json
{ "id": "…", "username": "kim", "display_name": "김OO", "role": "ORG_ADMIN"|"OPERATOR",
  "locked": false, "robot_ids": ["…"], "created_at": "…" }
```

**로그인 응답** = 사용자 객체 + 아래 필드. 응답에는 `Cache-Control: no-store`.
```json
{ …사용자 객체, "csrf_token": "…"|null, "access_token": "…"|null, "refresh_token": "…"|null }
```
- 웹(`client:"web"`): `csrf_token` 만 값이 있고 세션 토큰은 `fh_s` 쿠키로만 간다. 앱(`client:"app"`): `access_token`·`refresh_token` 만 값이 있다.
- 실패는 계정이 없거나 비밀번호가 틀리거나 잠긴 계정 모두 같은 401 `AUTH_REQUIRED`.

**마지막 총괄 보호**: 잠기지 않고 보관되지 않은 `ORG_ADMIN` 이 한 명뿐이면 그 계정의 강등·잠금·삭제는 409 `LAST_ORG_ADMIN` ("마지막 총괄 계정은 강등·잠금·삭제할 수 없습니다.").

---

## 3. 로봇

| 메서드 | 경로 | 설명 | 권한 |
|---|---|---|---|
| GET | `/robots` | 목록 + 최신 상태 요약 `?scope=mine|all` (기본 `mine`). `all` = 조직의 전체 로봇 | 로그인 |
| POST | `/robots` | 등록 → `{robot, agent_token}` (토큰은 이때 한 번만 보임) | A |
| GET | `/robots/{id}` | 상세(장치 목록·담당자·현재 실행·현재 층). 담당 밖 운영 관리자에게는 로봇 요약 객체만 200 | 로그인 |
| PATCH | `/robots/{id}` | 이름·담당 운영 관리자 `{name, owner_user_id}` | A |
| DELETE | `/robots/{id}` | 해제(실행 중이면 409) | A |
| POST | `/robots/{id}/agent-token` | 에이전트 토큰 발급·재발급 → `{agent_token}`. 옛 토큰 즉시 무효, 원문은 이 응답에서 한 번만(`Cache-Control: no-store`) | A |
| GET | `/robots/{id}/telemetry` | 그래프용 요약 `?from&to&fields=battery,speed,latency&step=10s` | A, O(내). 담당 밖 운영 관리자는 404 |
| POST | `/robots/{id}/floor` | 현재 층 사람 입력 `{floor_id}` | A, O(내) |
| POST | `/robots/{id}/stop` | STOP (WS 를 못 쓸 때 대체 경로) → 202 `{requested:true}`. 웹은 `X-FH-CSRF` 필요. 실시간 중재기가 없는 서버면 503 `SERVER_BUSY` | 로그인 (볼 수 있으면) |

**관제·조종 고르기의 로봇 범위**
- PC 관제·조종 고르기: 총괄·운영 관리자 모두 `scope=all` 로 전체 로봇을 받는다. 운영 관리자 화면은 자기 담당을 먼저 놓는다(서버 목록은 만든 순서이고, 순서는 화면이 정함).
- 운영 관리자에게 남의 로봇은 보기만: 조종 단추는 비활성 + 이유, STOP 은 누를 수 있다([02 §10](02-FUNCTIONAL-SPEC.md#10-권한-표)).
- 폰: 운영 관리자는 자기 담당 로봇만 고른다.
- 담당 밖 운영 관리자가 그 로봇의 원격측정·실행·사건·사진을 요청하면 404(§8 범위 판정).

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
  "current_run": { "id": "…", "status": "MOVING", "scenario_name": "2층 순찰", "progress": {"done": 3, "total": 5} } | null,
  "devices": [ { "key": "rgb", "kind": "CAMERA_RGB", "label": "전면 카메라", "state": "OK"|"MISSING"|"ERROR" } ],
  "attention": ["BATTERY_LOW"]
}
```
- 값을 받을 수 없으면 `null`. 화면은 `null` 줄을 숨긴다. `owner`·`status` 도 모르면 `null`.
- `location`: 에이전트 `state.pose`(§10.1)에 `map_version_id` 가 없어서 지금 서버는 지도 판을 추측하지 않고 `null` 로 둔다. pose 에 지도 판을 실을지는 **미정(결정 필요)**.

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
| GET | `/runs/{id}` | 상세(지점별 결과·경로·사진) | 로그인(목록과 같은 범위 판정) |
| POST | `/runs/{id}/pause` · `/resume` · `/abort` · `/return` | 실행 제어 | A, O(내) |
| POST | `/runs/{id}/floor-confirm` | 층 전환 구간 "n층 도착" 확인 `{floor_id}` | A, O(내) |
| POST | `/runs/{id}/operator-confirm` | 작업 `OPERATOR_CONFIRM` 응답 `{step, answer: "OK"|"NG", memo}` | A, O(내) |
| GET | `/runs/{id}/report` | 인쇄용 보고서(PDF) | 로그인(목록과 같은 범위 판정) |

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
| GET | `/events/export.csv` | 같은 필터로 CSV | 로그인(`/events` 와 같은 범위 판정) |
| GET | `/notifications` | 내 알림 `?unread=1` | 로그인 |
| POST | `/notifications/read` | `{ids}` 또는 `{all:true}` | 로그인 |
| POST | `/push/subscribe` | Web Push 구독 등록 | 로그인 |
| GET | `/org/settings` | 조직 기준값 ([06 organizations.settings](06-DB-DESIGN.md#31-조직사람)) | 로그인 |
| PATCH | `/org/settings` | 기준값 고치기. 범위: `battery_low_pct` 5~50, `run_min_battery_pct` 10~90, `deviation_m` 0.5~5, `lease_request_timeout_s` 5~30, `link_loss_wait_s` 0~30. 바꾼 값은 다음 실행부터 적용하고, 실행 중인 것은 `run.start` 때 받은 값을 쓴다 | A |
| GET | `/media/{id}` | 사진 파일 | 로그인(그 사진이 붙은 실행·사건과 같은 범위 판정) |

- 범위 판정은 서버가 요청마다 한다. 목록에서 안 보이는 실행·사건·사진을 ID 로 직접 요청하면 **404**(있다는 사실도 숨김). 운영 관리자가 남의 로봇에 대해 볼 수 있는 것은 관제의 로봇 요약 객체뿐이다.

**사건 객체**
```json
{ "id": "…", "at": "…", "robot_at": "…"|null, "category": "RUN"|"ROUTE"|"LINK"|"LEASE"|"APPROVAL"|"SAFETY"|"ACCOUNT",
  "code": "ROUTE_DEVIATION", "severity": "INFO"|"WARN"|"ERROR",
  "message": "14:02 Go2-3이 계획 경로에서 1.8 m 벗어났습니다.",
  "robot_id": "…"|null, "user_id": "…"|null, "run_id": "…"|null, "data": { "distance_m": 1.8 } }
```

---

## 9. 실시간 — 화면 ↔ 서버 (`wss://<서버>/api/v1/ws`, `fh-rt/1`)

**연결 공통 (§9·§10)**
- 경로: 화면 `/api/v1/ws`, 에이전트 `/api/v1/agent/ws`. 웹 쿠키의 `Path=/api/v1` 안에 두려고 `/api/v1` 아래에 둔다.
- `fh-rt/1`·`fh-agent/1` 은 앱 프로토콜 이름이다. `Sec-WebSocket-Protocol` 협상 헤더는 쓰지 않는다(`/` 는 HTTP token 에 쓸 수 없음). 대신 첫 메시지(에이전트는 `hello`)에 `proto` 필드를 넣는다. 화면은 첫 메시지에 필수, 그 뒤로는 생략 가능하고, `null`·다른 값이면 4403 으로 닫는다. 에이전트 쪽 불일치 처리는 §10.3 규칙 12.
- 인증: §1.2. 수락 전에 인증이 거부되면 HTTP 401/403 으로 끝나고, 이는 4401/4403 과 같은 영구 거부다(재연결 안 함). 일시 거부(실시간 중재기 없음·DB 일시 오류)는 연결을 수락한 뒤 1013 으로 닫는다.
- 한 조직의 실시간 중재기는 서버 하나다(PostgreSQL 세션 잠금을 얻은 서버). 잠금이 없는 서버는 REST 인증·계정 처리는 하되 WS 는 1013, HTTP STOP 은 503 `SERVER_BUSY`.

### 9.1 봉투
```json
{ "t": "<종류>", "id": "<요청 ID, 응답 짝>", "robot": "<robot_id>", "proto": "fh-rt/1"(첫 메시지), ...본문 }
```
- 서버 → 화면 응답: `{ "t": "reply", "id": "…", "ok": true|false, "error": {…} }`. 성공이면 `error` 를 생략한다. HTTP 에 해당하는 상태는 `error.detail.status` 에 담는다(예: 429 `LEASE_REQUEST_COOLDOWN`, 503 `ROBOT_OFFLINE`). 형식 오류는 `VALIDATION`.
- 한 메시지 최대 4 KiB(영상 이진 프레임 제외). 에이전트 연결에도 같은 봉투·크기를 쓴다. 화면 연결에서 4 KiB 초과는 1009, 이진 프레임은 1003, JSON 이 아니면 1007 로 닫는다.

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
| `ping` | `{}` | 연결 확인(조종 중이 아닐 때 5 s 마다). 조종권 heartbeat 는 늘리지 않음(heartbeat 는 `cmd` 만) | 로그인 |

### 9.3 서버 → 화면
| t | 본문 | 빈도 |
|---|---|---|
| `state` | 로봇 요약 객체(§3)의 바뀐 부분 + `speed`, `latency_ms`(지금 미측정 `null`), `stop_gen`, `latched`, `applied` | 구독 로봇마다 10 Hz |
| `lease` | `{robot, holder, lease_id(조종권자 연결에만), since}` | 바뀔 때 |
| `lease.requested` | `{robot, request_id, requester:{display_name, role}, expires_at}` | 조종권자에게 |
| `lease.result` | `{robot, request_id, result: "ACCEPTED"|"DECLINED"|"TIMEOUT"|"CANCELED", error?}`. 정지 확인 실패([02 F-TO-04](02-FUNCTIONAL-SPEC.md#f-to-04-조종권-요청-sf-05sf-08--확정--제안-보완) 넘김 순서 4)는 `CANCELED` + `error:"STOP_CONFIRM_FAILED"` | 요청자·조종권자에게 |
| `run` | `{run_id, robot, status, progress, current_step, wait: null|"FLOOR_CONFIRM"|"OPERATOR_CONFIRM"}` | 바뀔 때 |
| `event` | 사건 객체(§8) | 생길 때(권한 범위만) |
| `notify` | 알림 | 생길 때 |
| 이진 | `[1바이트 종류(1=rgb,2=depth,3=lidar)][16바이트 robot UUID][8바이트 시각 ms][내용]` | 구독 때 |

### 9.4 닫기 코드
화면·에이전트 연결에 같이 쓴다.

| 코드 | 뜻 | 받은 쪽 |
|---|---|---|
| 4401 | 로그인 만료·세션 폐기 (수락 전이면 HTTP 401) | 재연결 안 함. 화면은 로그인 화면 |
| 4403 | 권한 없음·토큰 불일치·프로토콜 불일치 (수락 전이면 HTTP 403) | 재연결 안 함 |
| 1012 | 재접속 필요: 같은 로봇의 새 연결이 옛 연결을 대체함, 에이전트가 같은 소켓에서 두 번째 `hello` 를 보냄 | 새 연결로 재연결 |
| 1013 | 일시 거부: 서버 바쁨·실시간 중재기 없음·DB 확인 지연·입력 한도 초과·`hello` 3 s 안 옴·에이전트 3 s 무수신 | 1 s 뒤 재연결(반복돼도 1 s) |
| 그 밖 | — | 1 s 뒤 재연결, 이어서 2·4·8·10 s (최대 10 s). 3 s 이상 연결이 유지된 뒤 끊기면 다시 1 s 부터 |

---

## 10. 실시간 — 서버 ↔ 로봇 에이전트 (`wss://<서버>/api/v1/agent/ws`, `fh-agent/1`)

연결·인증·닫기 코드는 §9 머리의 «연결 공통»과 §9.4 를 따른다.

### 10.1 에이전트 → 서버
| t | 본문 | 빈도 |
|---|---|---|
| `hello` | `{proto:"fh-agent/1", agent_version, robot_model, firmware, devices:[…], map_versions:[sha256…], last_floor_id, latched, stop_gen, lease_id, run:{run_id, status, step, wait_reason?}|null}` | 연결 직후 1회(3 s 안). 서버는 이것으로 실행·조종권을 맞춘다([04 §3.2](04-ARCHITECTURE.md#32-연결-끊김-처리) 재연결) |
| `state` | `{pose:{floor_id,x,y,yaw,confidence}, speed, battery:{soc,voltage?}, latched, stop_gen, stop_ref, applied:[vx,vy,wz], mode:"USER"|"RUN"|"FREE", devices_changed?}`. 측정 전 값(pose 각 칸·speed·soc)은 `null`. `stop_ref` 는 §10.5 | 10 Hz, 그리고 `lease`·`stop`·`unlock` 을 적용한 직후 |
| `ping` | `{}` | 서버 `ping` 에는 `state` 또는 `ping` 으로 응답한다(10 Hz `state` 가 응답을 겸함) |
| `event` | `{code, severity, robot_at|null, data}` (서버가 문장을 만든다) | 생길 때. 끊김 중 쌓은 것은 재연결 때 순서대로. 끊긴 동안의 재시도 사건은 하나로 묶는다(§10.3 규칙 11) |
| `run.update` | `{run_id, status, step, progress, path_deviation_m?, fail_code?}` | 바뀔 때 |
| `cmd.ack` | `{seq, applied:[…], reason?}`. 아직 받은 cmd 가 없으면 `seq:-1` | 10 Hz 로 묶어서(마지막 seq) |
| `media` | `{kind:"photo", run_id?, step?, upload_id}` (사진은 먼저 §10.4 `/agent/uploads` 로 올림) | 찍을 때 |
| 이진 | 영상 프레임(§9.3 형식, robot 칸은 비움) | 서버가 켰을 때만 |

### 10.2 서버 → 에이전트
| t | 본문 | 설명 |
|---|---|---|
| `lease` | `{lease_id|null, holder_type:"USER"|"RUN:<run_id>"|null}` | 현재 조종권. `null` 이거나 값(lease_id·holder·run_id)이 바뀌면 받는 즉시 0 명령 + 입력 폐기, 그 뒤 옛 lease 의 cmd 거부. 형식은 §10.3 규칙 1 |
| `ping` | `{t_server}` | 1 s 마다. 에이전트의 끊김 판정·유예 시계 기준([04 §3.2](04-ARCHITECTURE.md#32-연결-끊김-처리)) |
| `cmd` | `{lease_id, seq, axes, t_server}` | 화면 입력 전달 |
| `stop` | `{by_user_id|null, stop_ref}` | 즉시 0 명령 + 잠금. `stop_ref` 는 로봇마다 1 씩 늘리는 정수(1~2^53-1), §10.5 |
| `unlock` | `{lease_id, stop_gen}` | 잠금 해제 요청 |
| `streams` | `{rgb:bool, depth:bool, lidar:bool, map:bool}` | 영상 켜기/끄기 |
| `run.start` | `{run_id, plan:{segments:[{floor_id, map_version_id, goals:[…], connector?}]}, missions:{…}, policy:{link_loss_wait_s:30}}` | 실행 내려보내기 |
| `run.control` | `{run_id, op:"pause"|"resume"|"abort"|"return"}` | 실행 제어 |
| `run.confirm` | `{run_id, kind:"FLOOR"|"OPERATOR", data}` | 사람 확인 결과 전달 |
| `map.sync` | `{versions:[{id, floor_id, sha256, url, resolution, origin:[x,y,yaw], features}]}` | 승인 판 미리 내려받기. `url` 은 §10.4 의 에이전트 지도 경로. 좌표계·구역(`features`)도 같은 판에 묶여 함께 온다 |
| `floor.set` | `{floor_id}` | 사람 입력 층 |
| `slam` | `{op:"start"|"save"|"cancel", floor_id}` | 새 지도 |

### 10.3 에이전트 쪽 필수 규칙 (서버가 무엇을 보내든)
감시 장치의 모드별 구분은 [04 §3.2](04-ARCHITECTURE.md#32-연결-끊김-처리)가 정본이다.
1. `lease` 가 `null` 이 되거나 바뀌면 즉시 0 명령 + 입력 폐기, 새 lease + 새 중립 전까지 0 이 아닌 명령 금지. `lease_id` 가 지금 값과 다른 cmd 는 거부. `holder_type` 은 `"USER"` 또는 `"RUN:<run_id>"` 만 유효하다. 접두어 없는 `RUN`·빈 run_id·`lease_id` 빠짐·빈 문자열 등 **형식이 틀린 lease 는 조종권 없음**으로 보고 즉시 0 명령 + 입력 폐기(사건 `LEASE_INVALID`).
2. 사람이 조종권을 가진 동안: 서버 cmd 가 0.3 s 안 오면 0 명령 + 입력 폐기, 다시 움직이려면 새 중립 입력(deadman, 현재 Core 동작). 잠금(latch)은 걸지 않는다. 만료 때 잠금까지 걸지는 PRD Q7 **결정 필요**.
3. 실행이 조종권을 가진 동안: 서버 cmd 감시는 쓰지 않고(서버 cmd 는 무시), 에이전트 안 임무 실행기의 명령에 같은 0.3 s 감시를 건다. 실행기 명령·`run.start`·`run.control resume` 은 조종권 holder 의 run_id 와 **정확히 같을 때만** 받는다.
4. STOP 은 lease·사용자 확인 없이 바로 적용한다. STOP 잠금 상태에서는 `unlock` 뒤 중립 입력 한 번이 와야 움직임.
5. 속도 한계·명령 단계화는 에이전트 설정이 정본(서버 값으로 늘릴 수 없음).
6. 실행 중 서버 연결이 끊기면(3 s 동안 해석 가능한 서버 봉투가 없음, 규칙 8) 마지막 해석 가능한 봉투의 수신 시각부터 `link_loss_wait_s` 유예: 그 안에 다음 지점에 닿으면 그 앞에서 대기, 시간이 먼저 끝나면 그 자리에서 정지·잠금(같은 시각이면 만료가 먼저). 재연결돼도 대기는 사람이 재개할 때까지 유지.
7. 재시작하면 잠금 상태로 시작.
8. 형식 오류·모르는 메시지: JSON 이 아니거나 `t` 가 없는 프레임은 버리고 연결 생존에도 세지 않는다. `t` 가 있는 해석 가능한 봉투(모르는 `t`·본문 형식 오류 포함)는 연결 생존(마지막 서버 수신 시각)만 갱신한다. 어느 경우에도 새 움직임·권한을 만들지 않고, deadman 0.3 s·lease·`stop_gen`·잠금을 갱신하지 않는다. 형식이 틀린 cmd 는 0 + 입력 폐기.
9. 같은 소켓 회복: 3 s 무수신 뒤 같은 소켓에 유효 봉투가 다시 와도 재연결로 본다 — 정지·잠금 후 `hello`, 그 프레임의 조종 명령은 실행하지 않는다(서버는 두 번째 `hello` 를 1012 로 닫아 새 연결을 요구). `hello` 의 lease 는 상태 사본이며, 서버가 `lease` 를 다시 보내 확인하기 전에는 cmd·unlock·실행 재개를 하지 않는다.
10. `seq` 는 0~2^53-1. lease 가 바뀔 때만 처음부터 세고, 같은 lease 로 재연결하면 마지막 seq 를 이어 간다. 범위 밖 값은 마지막 seq 를 바꾸지 않고 0 + 입력 폐기.
11. 끊긴 동안의 재시도 사건(`SERVER_RETRY`)은 큐에 쌓지 않고 하나로 묶는다(시도 수·처음/마지막 시각·마지막 간격·닫기 코드). 연결돼 그 사건을 보내면 다음 끊김은 새로 센다.
12. 프로토콜 불일치(`proto` 가 `fh-agent/1` 이 아님): 결정은 «에이전트는 정지·잠금 상태로 재연결 대기». **현재 구현과 다름(결정 필요)**: 서버는 4403(`PROTOCOL_MISMATCH`)으로 닫고, 에이전트는 4401/4403 을 영구 거부로 보아 정지·잠금 뒤 재연결을 멈춘다. 4403 이 아닌 닫기에 다른 proto 가 실려 오면 정지·잠금 뒤 재연결한다.

### 10.4 에이전트 REST (에이전트 토큰 전용)
에이전트 토큰은 아래 경로만 쓸 수 있고, 사람 계정 API 는 403. 사람 계정 쿠키·토큰으로 아래 경로를 부르면 403. 사람 계정 토큰을 로봇에 넣어 쓰지 않는다.
| 메서드 | 경로 | 설명 | 허용 범위 |
|---|---|---|---|
| POST | `/agent/uploads` | 사진 올리기 → `{upload_id, sha256}` | 토큰의 로봇만. `run_id` 를 붙이면 그 로봇의 실행만 — 진행 중이거나 끝난 지 10분 안(촬영 시각 `taken_at` 이 실행 시간 안이어야 함). 끊김 때문에 더 늦으면 사진은 `run_id` 없이 로봇 사진으로 받고 사건에 원래 실행 ID 를 적는다. 받은 `upload_id` 는 같은 로봇의 `media` 메시지에서 한 번만 쓸 수 있다 |
| GET | `/agent/map-versions/{id}/image` | 지도 이미지(png) | 서버가 그 로봇에 `map.sync`·`run.start` 로 내려보낸 판만 |

### 10.5 정지 확인 (`stop_ref`)
조종권을 처음 줄 때와 넘길 때([02 F-TO-04](02-FUNCTIONAL-SPEC.md#f-to-04-조종권-요청-sf-05sf-08--확정--제안-보완) 넘김 순서), 실행에서 사람으로 넘길 때([04 §4.2](04-ARCHITECTURE.md#42-자율-실행과-수동-조종)) 서버는 이 확인을 지나야 새 lease 를 준다. 따로 ACK 메시지는 없다.
1. 서버는 `stop` 마다 로봇별로 1 씩 늘린 `stop_ref`(1~2^53-1)를 싣는다. 다시 쓰거나 되돌리지 않는다.
2. 에이전트는 그 STOP 을 적용해 `latched=true`·`applied=[0,0,0]` 이 된 뒤에만 그 값을 보관하고, 다음 `state` 의 `stop_ref` 에 마지막으로 적용한 값을 되돌린다. `0` 은 이 연결에서 적용한 서버 STOP 이 없다는 뜻이고, 새 연결마다 0 으로 시작한다. 잘못된 `stop_ref` 도 STOP 자체는 적용하지만 확인 값으로는 쓰지 않는다.
3. 확인 = `stop` 을 보낸 뒤 **2 s 안에** 같은 `stop_ref` + `latched=true` + `applied=[0,0,0]` 인 `state` 를 받음. `stop_gen` 증가량으로 추정하지 않는다. 늦거나 다르면 실패 → 조종권 비움(`FREE`), 화면에는 `STOP_CONFIRM_FAILED`(§9.3).
4. `stop_ref` 가 2^53-1 에 닿으면 STOP 은 계속 보내되 새 조종권은 주지 않는다.
5. 서버와 에이전트는 이 계약을 함께 갱신한다. `stop_ref` 를 돌려주지 않는 옛 에이전트는 새 서버에서 정지 확인을 통과하지 못한다.
- 여기서 확인하는 것은 메시지 사이의 인과(그 STOP 을 적용했다는 보고)다. 몸이 실제로 섰는지(속도 0·정지 거리)는 아니다.

---

## 11. 지금 API 와의 대응 (이식 참고)
| 지금 (v2_gate / v2_link) | 새 API |
|---|---|
| `/api/login`, `/api/whoami`, `/api/logout` | `/auth/login`, `/me`, `/auth/logout` |
| `/api/robots?scope=mine|all`, `/api/robots/claim` (미커밋 작업 사본 관측, [04 §1](04-ARCHITECTURE.md)) | `/robots?scope=`, `POST /robots` (등록은 총괄) |
| `/api/r/{rid}/ws`, `/api/r/{rid}/watch/ws` (미커밋 작업 사본 관측) | `/api/v1/ws` 하나 + `sub` (로봇별 권한은 서버가 판단) |
| WS op `take/release/cmd/stop/resume/hidden/photo` | `lease.take/lease.release/cmd/stop/unlock/hidden/photo` |
| WS op `map_list/map_get/map_start/map_save` | REST `/floors/…/map-versions`, `/robots/{id}/slam/*` |
| `/api/docs` (zone/tmpl/mission/run/note 문서) | `/map-versions`(구역), `/missions`, `/scenarios`, `/runs` |
| 상태 `status` 10 Hz | `state` 10 Hz |
| 닫기 코드 4401/4403/1013 | 같음 + 1012 (§9.4) |

---

## 12. 변경 이력
| 판 | 날짜 | 내용 |
|---|---|---|
| 0.1 | 2026-10-19 | 최초 작성 |
| 0.2 | 2026-10-19 | PR #3 검토 1·2차 반영 (deadman 현재 동작·감시 모드 분리·연결 끊김 기준·기록 범위·에이전트 REST·ID·판 충돌 범위 등) |
| 0.3 | 2026-10-19 | dev 구현(PR #8·#10)과 조정 결정 반영: WS 경로 `/api/v1/ws`·`/api/v1/agent/ws`, proto 필드(협상 헤더 없음), 화면 WS 쿠키+Origin·앱 Bearer(티켓 없음), 에이전트 토큰 재발급, 닫기 코드 1012·1013·수락 전 HTTP 거부, `stop_ref` 정지 확인(§10.5), 형식 오류 메시지·lease holder 형식·정수 상한, `scope=all` 범위, 로그인 응답·`/auth/session`·`LAST_ORG_ADMIN`, 비밀번호 정책 미정. proto 불일치 처리는 구현과 달라 결정 필요 |

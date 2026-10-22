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
- 실시간 메시지의 정수 필드는 정수만 받고(bool·실수는 형식 오류) 상한은 2^53-1(JS 안전 정수)이다. 하한은 칸마다 다르다: `seq`·`stop_gen`·`step` 은 0 이상. `stop_ref` 는 서버 `stop` 에서 1 이상, 에이전트 `state` 에서 0 이상(0 = 이 연결에서 적용한 서버 STOP 없음, §10.5). `cmd.ack.seq` 만 -1 을 허용한다(아직 받은 cmd 없음, §10.1). 범위 밖 값은 형식 오류다.

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
- 담당 밖 운영 관리자가 그 로봇의 원격측정·실행·사건·사진을 요청하면 404(§8 범위 판정). 남의 로봇에 내가 한 행동(예: 내가 누른 STOP)의 사건은 §8 의 **결정 필요** 항목.

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
- 남의 로봇에 내가 한 행동(예: 내가 누른 STOP)의 사건을 기록에서 볼 수 있는지는 **결정 필요**. [02 §10](02-FUNCTIONAL-SPEC.md#10-권한-표)의 «내 행동»과 위 범위 판정이 겹친다. 사건 REST 는 아직 구현 전이라 확인된 동작이 없다.

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
- 한 메시지 최대 4 KiB(영상 이진 프레임 제외). 에이전트 연결도 같은 평평한 JSON 형식·4 KiB 한도를 쓰지만 필수 칸은 방향마다 다르다: 화면 → 서버는 `t`·`id`(로봇 대상이면 `robot`, 첫 메시지는 `proto:"fh-rt/1"`), 서버 → 화면 `reply` 는 `t`·`id`. 에이전트 ↔ 서버는 `t` 와 본문뿐이다(`id`·`robot` 없음, 로봇은 연결의 토큰으로 정함). `proto:"fh-agent/1"` 은 에이전트 `hello` 에만 필수. 화면 연결에서 4 KiB 초과는 1009, 이진 프레임은 1003, JSON 이 아니면 1007 로 닫는다.

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
| 4403 | 권한 없음·토큰 불일치·화면 프로토콜 불일치 (수락 전이면 HTTP 403) | 재연결 안 함 |
| 4406 | 에이전트 프로토콜 불일치(`PROTOCOL_MISMATCH`, §10.3 규칙 12). W4-B 에서 구현 중이며 지금 dev 는 4403 으로 닫는다 | 에이전트: 정지·잠금을 유지하고 30 s 이상 간격으로 재연결 |
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
| `phone.revoke.ack` | `{seq}`. 회수 저장·열린 연결 적용 뒤 확인(§13.7), 재전송에 같은 seq 응답 | 회수 적용마다 |
| `cmd.ack` | `{seq, applied:[…], reason?}`. 아직 받은 cmd 가 없으면 `seq:-1` | 10 Hz 로 묶어서(마지막 seq) |
| `media` | `{kind:"photo", run_id?, step?, upload_id}` (사진은 먼저 §10.4 `/agent/uploads` 로 올림) | 찍을 때 |
| 이진 | 영상 프레임(§9.3 형식, robot 칸은 비움) | 서버가 켰을 때만 |

### 10.2 서버 → 에이전트

P1-B의 `phone.revoke`/`phone.revoke.ack`는 현재 구현 프로토콜 `fh-agent/2`의 확장이다.
폰 모드는 기존 lease·cmd·unlock을 무시하며 인증된 회수·STOP만 Hub에 적용한다(§13.7).
| t | 본문 | 설명 |
|---|---|---|
| `phone.revoke` | `{seq:1..2^53-1,items:[{jtis:[UUID…],until:UTC초} 또는 {sub:UUID,device?:UUID,until:UTC초}]}`. seq는 영속·로봇별 멱등 식별자, items1~16·jtis1~64, 프레임4KiB 이하 | 출입증 무효화만(§13.7). 인증된 링크, 재접속 시 유효 목록 전부 재전송 |
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
8. 형식 오류·모르는 메시지:
   - 연결 생존(마지막 서버 수신 시각)은 **JSON 객체이고 `t` 가 비어 있지 않은 문자열**인 봉투만 갱신한다. 모르는 `t`·본문 형식 오류도 이 조건을 채우면 생존으로 센다. JSON 이 아니거나, 객체가 아니거나, `t` 가 없거나 문자열이 아니거나(`null`·숫자) 빈 문자열이면 버리고 생존에도 세지 않는다.
   - 모르는 `t`·본문 형식 오류는 새 움직임·권한을 만들지 않고 deadman 0.3 s 시계를 갱신하지 않는다. 형식이 틀린 cmd 는 0 + 입력 폐기.
   - 예외(형식이 틀려도 안전 쪽으로 바로 적용): 형식이 틀린 `lease` 는 조종권 없음으로 즉시 폐기(규칙 1). `stop` 은 `stop_ref` 가 틀려도 정지·잠금을 적용한다(규칙 4, §10.5 의 2). 어느 메시지든 `proto` 칸이 `fh-agent/1` 이 아니면 정지·잠금(규칙 12).
9. 같은 소켓 회복: 3 s 무수신 뒤 같은 소켓에 유효 봉투가 다시 와도 재연결로 본다 — 정지·잠금 후 `hello`, 그 프레임의 조종 명령은 실행하지 않는다(서버는 두 번째 `hello` 를 1012 로 닫아 새 연결을 요구). `hello` 의 lease 는 상태 사본이며, 서버가 `lease` 를 다시 보내 확인하기 전에는 cmd·unlock·실행 재개를 하지 않는다.
10. `seq` 는 0~2^53-1. lease 가 바뀔 때만 처음부터 세고, 같은 lease 로 재연결하면 마지막 seq 를 이어 간다. 범위 밖 값은 마지막 seq 를 바꾸지 않고 0 + 입력 폐기.
11. 끊긴 동안의 재시도 사건(`SERVER_RETRY`)은 큐에 쌓지 않고 하나로 묶는다(시도 수·처음/마지막 시각·마지막 간격·닫기 코드). 연결돼 그 사건을 보내면 다음 끊김은 새로 센다.
12. 프로토콜 불일치(`proto` 가 `fh-agent/1` 이 아님): 서버는 인증·권한 거부(4401/4403)와 구별되는 닫기 코드 4406(이유 `PROTOCOL_MISMATCH`, §9.4)으로 닫는다. 에이전트는 정지(0·잠금) 상태로 30 s 이상의 느린 간격으로 재연결을 기다리고, 영구 중단하지 않는다(서버·에이전트 중 한쪽만 먼저 갱신돼도 다른 쪽 갱신 뒤 자동 복구). **현재 dev 구현은 다름**: 서버는 4403(`PROTOCOL_MISMATCH`)으로 닫고, 에이전트는 4403 을 영구 거부로 보아 정지·잠금 뒤 재연결을 멈춘다. W4-B(`fh-agent/2` 판 올림)에서 4406 으로 맞춘다.

### 10.4 에이전트 REST (에이전트 토큰 전용)
에이전트 토큰은 아래 경로만 쓸 수 있고, 사람 계정 API 는 403. 사람 계정 쿠키·토큰으로 아래 경로를 부르면 403. 사람 계정 토큰을 로봇에 넣어 쓰지 않는다.
| 메서드 | 경로 | 설명 | 허용 범위 |
|---|---|---|---|
| POST | `/agent/uploads` | 사진 올리기 → `{upload_id, sha256}` | 토큰의 로봇만. `run_id` 를 붙이면 그 로봇의 실행만 — 진행 중이거나 끝난 지 10분 안(촬영 시각 `taken_at` 이 실행 시간 안이어야 함). 끊김 때문에 더 늦으면 사진은 `run_id` 없이 로봇 사진으로 받고 사건에 원래 실행 ID 를 적는다. 받은 `upload_id` 는 같은 로봇의 `media` 메시지에서 한 번만 쓸 수 있다 |
| GET | `/agent/map-versions/{id}/image` | 지도 이미지(png) | 서버가 그 로봇에 `map.sync`·`run.start` 로 내려보낸 판만 |

### 10.5 정지 확인 (`stop_ref`)
조종권을 처음 줄 때와 넘길 때([02 F-TO-04](02-FUNCTIONAL-SPEC.md#f-to-04-조종권-요청-sf-05sf-08--확정--제안-보완) 넘김 순서), 실행에서 사람으로 넘길 때([04 §4.2](04-ARCHITECTURE.md#42-자율-실행과-수동-조종)) 서버는 이 확인을 지나야 새 lease 를 준다. 따로 ACK 메시지는 없다.
1. 서버는 `stop` 마다 로봇별로 1 씩 늘린 `stop_ref`(1~2^53-1)를 싣는다. 값은 그 조직 실시간 중재기의 메모리에 있다: 한 중재기 안에서는 줄지 않고, 중재기가 새로 뜨면 0 부터 다시 센다(지금 구현은 DB 에 남기지 않는다).
2. 에이전트는 그 STOP 을 적용해 `latched=true`·`applied=[0,0,0]` 이 된 뒤에만 그 값을 보관하고, 다음 `state` 의 `stop_ref` 에 마지막으로 적용한 값을 되돌린다. `0` 은 이 연결에서 적용한 서버 STOP 이 없다는 뜻이고, 새 연결마다 0 으로 시작한다. 잘못된 `stop_ref` 도 STOP 자체는 적용하지만 확인 값으로는 쓰지 않는다.
3. 확인 = `stop` 을 보낸 뒤 **2 s 안에** 같은 `stop_ref` + `latched=true` + `applied=[0,0,0]` 인 `state` 를 받음. `stop_gen` 증가량으로 추정하지 않는다. 늦거나 다르면 실패 → 조종권 비움(`FREE`), 화면에는 `STOP_CONFIRM_FAILED`(§9.3).
4. `stop_ref` 가 상한 2^53-1 에 닿으면 그 값으로 확인된 조종권은 한 번 줄 수 있다. 그 뒤의 STOP 은 같은 상한값을 다시 실어 계속 보내되, 그 값으로 새 조종권은 주지 않는다(`lease.result` `CANCELED` + `error:"STOP_REF_EXHAUSTED"`). 다시 주려면 중재기를 새로 띄워야 한다.
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
| 0.3 | 2026-10-19 | dev 구현(PR #8·#10)과 조정 결정 반영: WS 경로 `/api/v1/ws`·`/api/v1/agent/ws`, proto 필드(협상 헤더 없음), 화면 WS 쿠키+Origin·앱 Bearer(티켓 없음), 에이전트 토큰 재발급, 닫기 코드 1012·1013·수락 전 HTTP 거부, `stop_ref` 정지 확인(§10.5), 형식 오류 메시지·lease holder 형식·정수 상한, `scope=all` 범위, 로그인 응답·`/auth/session`·`LAST_ORG_ADMIN`, 비밀번호 정책 미정. proto 불일치는 조정 결정(별도 닫기 4406·30 s 이상 느린 재연결)을 정본으로 적고 dev 구현은 W4-B 에서 맞춤. PR #11 검토 반영: 형식 오류 규칙의 안전 예외, 생존 봉투 조건, 정수 칸별 하한, `stop_ref` 수명(중재기 메모리), 방향별 필수 칸, 남의 로봇 내 행동 사건 결정 필요 |
| 0.4 | 2026-10-21 | P1-A: ADR-002 0.3의 폰 직결 `fh-phone/1` 봉투·600초 출입증·단일 조종권·단조 감시·상태·오류 계약 추가(§13) |
| 0.5 | 2026-10-21 | PR #41 r1: hello 승인 전 영향 없음·Origin/대기 한도, 인증된 수신 오류 STOP, 중재기 단일 감시, 취소 제한·알림 대체, 중간 입력/stop_ref 뜻, 영속 저널·파일 권한·명시적 simulation 보강 |
| 0.6 | 2026-10-21 | PR #41 r2: 주소별 hello 대기2개·검증 중 교체 금지, CANCELED 중 자기 취소만30초 제한, Origin·파일 배포 조건 명시 |
| 0.7 | 2026-10-21 | PR #41 r3: D8 요청자 철회 모든 경로30초 제한·release/view 속도 창 포함, D9 hello 전체16개·대기가 가장 많은 주소부터 교체, 다중 주소 한계·배포 관문 명시 |
| 0.8 | 2026-10-21 | PR #41 r4: D8 보충 요청자 귀책 거부도30초 제한, D10 view/release 초과는 오류 응답만·연결 유지, identity/내부 오류 경계와 TCP 자원 한계 명시 |
| 0.9 | 2026-10-21 | PR #41 r5: D10 조종자 release/view는 제한·집계 없이 즉시 정지/반납, 역할 취득 시 창 초기화, D11 요청자 출입증 만료도30초 철회 제한 |
| 0.18 | 2026-10-22 | PR #47 검토: 미회수8개도 만료+60초 창·active/retained 오류 상세, 정확한 발급 권한/용량 계산·서버 STOP 경로, 로봇 삭제/퇴역 peer 경고 정리 |
| 0.17 | 2026-10-22 | PR #45 후속: 사용자·로봇별 회수 포함32개/만료+60초 상한, ACK 풀 경쟁 경고 집계, 1024페이지 초과 저널 재시작 회귀 |
| 0.16 | 2026-10-22 | PR #43 후속: 8개 상한에서 회수 jti 제외·D13/예약 유지, ACK 풀 대기는 연결 유지/재전송, 큰 저널 재시작·대기/TCP 변이 보강 |
| 0.15 | 2026-10-22 | PR #43 r3: 서버 wire1MiB/4096행·에이전트 물리8MiB, 사용자·로봇 미만료8개, retry/감사 초기화 회귀·ACK DB timeout |
| 0.14 | 2026-10-21 | PR #43 r2: ack 포화 retry floor·5초 timeout/로봇별 저장1개·늦은 commit 멱등, D16 ack 무관4096묶음/1MiB 예약·만료+60초·거부 사용자 상위8명 |
| 0.13 | 2026-10-21 | PR #43 검토 반영: 단조 유효 연결 회수·ack 큐/로봇 범위·영속 묶음/4096 예약·거부 감사 집계·운영 되돌림/백오프/시계 한계 |
| 0.12 | 2026-10-21 | P1-B: fh-control 출입증 발급·D13 한도·명시 switch/회수 ack, 서버→에이전트 영속 회수 목록 |
| 0.11 | 2026-10-21 | PR #41 r7 후속: 거부 집계 종료 flush·조용한 구간/정리 시험, 발급자·클라이언트·DDS 관문 보강 |
| 0.10 | 2026-10-21 | PR #41 r6: D12 늘리는 명령의 identity 독립 예산1초8개/60초30개·거부 집계, 줄이는 명령 미집계, 실기 전 관문을13.6에 통합 |

## 13. 폰 ↔ 에이전트 (`fh-phone/1`)

ADR-002 0.3 §5~7이 정본이다. 이 절은 P1-A 직결 조종 계약이며, §9의 화면 중계
조종과 §10의 서버 `lease`·`cmd`·`unlock`을 폰 서버 사용 시 대체한다. 서버 연결은
상태·사건 전송용이고, 재접속으로 조종권을 바꾸지 않는다. 옛 서버 `stop`은 방어적으로
정지 쪽으로만 받는다. **RUN·카메라·시뮬 관리자·서버 출입증 발급 구현은 포함하지 않는다.**

### 13.1 연결·봉투
- 로봇당 현장 리스너 하나, 경로 `/phone/ws`(쿼리 없음). 포트·바인딩 주소·키·조직·정책은
  실행 환경에서 정한다. `Sec-WebSocket-Protocol` 협상은 없고 첫 `hello.proto`가 필수다.
  시뮬·현장 시험만 `ws://`를 쓰며 실기용 WSS/앱 방식은 ADR-002 §10 후속 관문이다.
- 폰 → 에이전트: 평평한 `{t,id,robot,proto?,...}` JSON. `id`는 1~128자, `robot`은
  해당 로봇의 표준 소문자 UUID. 후속 proto는 생략 가능하나 있으면 `fh-phone/1`만 허용한다.
  소문자 하이픈 표준형 제한은 Pydantic·JSON Schema·생성 TS의 robot 설명에도 같다.
  `null`·여분 필드·중복 키·NUL·유한수가 아닌 수·틀린 형식은 거부한다. 한 프레임 4 KiB,
  이진 불가. 정수 `seq`·`stop_gen`·밀리초는 §9·§10과 같은 0~2^53-1, bool은 정수가 아니다.
- 연결마다 3 s 안에 hello, 이후 앱 `ping` 1 s마다. WS 제어 ping/pong과 cmd는 이
  연결 확인을 대신하지 않는다. 인증된 연결 최대 16개와 별도로 hello 대기는 최대 16개다.
  원격 주소(host, 포트 제외)당 대기는 최대 2개다. 주소 상한을 먼저 적용해 초과 주소의
  가장 오래된 대기만 1013으로 교체한다. 그 뒤 전체 16개 상한에서는 **대기가 가장 많은
  주소**의 소켓을 교체한다. 교체 가능한 주소의 대기 수가 같으면 가장 오래된 소켓이 먼저다.
  hello 프레임을 수신해 검증에 들어간 연결은 검증이 끝날 때까지 교체 대상에서 뺀다.
  **현재 hello 검증은 동기**이며 표시부터 승인/거부까지 await가 없다. 비동기 검증으로
  바꾸면 이 교체 제외 규칙과 대기 점유 한도를 다시 검토해야 한다.
  교체 후보가 모두 검증 중이면 새 연결만 1013으로 거부한다. 한 주소의 지속 접속 흐름이
  다른 주소의 재접속을 밀어내는 것을 막는다. **같은 주소**(NAT 공유 포함)의 비인증 호스트 폭주는
  그 주소의 재접속을 막을 수 있다. 공격 주소 수가 전체 상한/2(8개)를 넘는 다중 주소
  폭주도 재접속을 막을 수 있다. 이 경우 재개되지 않고 정지·잠금을 유지한다.
  **실기 전 관문은 로봇 망 분리·접속 속도 제한(주소별 동시 TCP 수·ulimit 포함)**이다.
  대기16개가 닫는 중인 소켓·TCP handshake까지16개로 제한하는 것은 아니다. r4 검토의
  보기 폰 신규 hello→STOP은16×4 다중 주소 흐름에서7/10, NAT 공유 흐름에서8/10이었다.
  이 수치는 접속 실패가 남는 한계의 관측이며 보장값이 아니다. 승인된 폰의 STOP과 구분한다.
  대기는 승인 없이 3 s가 지나면 닫으며 로봇에는 영향이 없다. 수신 큐는 4개,
  `lease.requested`·`lease.result` 알림은 연결별 **종류마다 최신 1개**(합계 최대 2개)로 대체한다.
  감사 사건은 별도 FIFO 기록이다. 송신 대기 0.2 s, 로컬 안전 감시는 별도 20 Hz다.
- **hello 승인 전 소켓은 로봇에 아무 영향도 없다.** 틀린 프레임·STOP·인증 실패·종료는
  그 소켓만 닫는다. ADR §7의 «붙은 폰»은 hello가 승인된 폰(보기만 포함)이다.
  Origin 헤더가 없는 앱 연결은 허용한다. 헤더가 있는 브라우저 연결은 설정된 허용 목록과
  정확히 일치할 때만 허용하고, 목록 기본값은 비어 있어 모두 HTTP 403으로 거부한다.
  이 거부도 로봇에는 영향이 없다. 허용 목록은 `FOOTHOLD_PHONE_ORIGINS`의 JSON 문자열 배열이다.
  **브라우저/PWA 폰 배포는 실제 Origin 설정이 필수**이며 빈 목록이면 HTTP 403이다.
  실제 클라이언트의 출처 형식·WSS 배포 방식으로 확인하는 시험은 실기 전 관문이다.
  **역방향 프록시 앞단은 금지**한다. 모든 폰이 프록시 한 주소로 집계되기 때문이다.
  폰 앱이 1013 수신 후 짧게 재시도하는지도 실기 전에 확인한다.
- 로봇당 판정기·Session·실제 MotionSink는 하나다. 폰별 Session을 만들지 않는다.
  서버용 Observer는 Core/Session/로봇 출력이 없는 전송 파사드다.
  폰 모드 Session의 서버용 링크 타이머는 끄고 Hub만 폰 연결을 감시한다. 가짜
  SERVER_LINK_LOST/재연결로 Hub owner와 Session lease가 갈라지지 않는다.

### 13.2 출입증 (발급자는 관제 서버, 검증자는 에이전트)
표준 compact JWS(`base64url(header).base64url(payload).base64url(signature)`, padding 없음)를
쓴다. header는 정확히 `{alg:"HS256",typ:"JWT",kid:"키 식별자"}`이며 다른 알고리즘·누락·
중복 키를 거부한다. 서명은 ASCII `header.payload`의 **HMAC-SHA-256**, `hmac.compare_digest`
비교다. Python 표준 라이브러리만 쓴다. 토큰은 최대 2048자이고 URL/쿠키/로그에 싣지 않는다.

| payload 칸 | 뜻 |
|---|---|
| `iss`, `aud` | 고정 `fh-control`, `fh-phone/1` |
| `org`, `robot` | 조직 UUID·대상 로봇 UUID 하나. 로봇의 로컬 설정과 모두 대조 |
| `sub`, `device` | 사용자 UUID·앱 설치 단위 기기 UUID. hello.device와도 대조 |
| `purpose` | `control`(조종 요청·보기·STOP) 또는 `view`(보기·STOP만) |
| `iat`, `exp` | UTC Unix 초 정수. `iat <= 현재 UTC < exp`, **0 < exp-iat <= 600 s** |
| `jti` | 발급마다 새 UUID. 연결·갱신·재접속마다 새 출입증 필요 |

- 수명 상한은 ADR 제안과 같은 **600초(10분)**로 확정한다. 관제 서버가 끊겨 새 출입증을
  못 받으면 남은 수명만큼(최대 10분)만 조종할 수 있고, 그 뒤 정지·잠금·조종권 비움이다. 받을 때 UTC로 남은 수명을
  구하고 `monotonic 수신 시각 + 남은 수명`을 고정한다. 열린 연결은 이 단조 마감으로
  만료하며 시뮬 정지·시계 조정·재접속으로 연장하지 않는다. 갱신은 같은 WS의 두 번째
  hello가 아니라 새 출입증/새 연결/새 lease/명시 unlock/새 중립이다.
- 키는 **로봇마다 별도 256 bit 이상 난수**다. 발급 서버와 그 로봇에만 별도 보안 절차로
  배포하며 Git·웹 번들·폰에는 넣지 않는다. 에이전트 키 파일은 `{kid:base64url_secret}`
  JSON, 최대 16키. 키 회전은 새 kid를 양쪽에 배포하고 옛 출입증 600초가 지난 뒤 옛 키를
  제거한다. 현재 키 파일은 시작 때 읽으므로 재시작은 빈 조종권·잠금으로 시작한다.
  HS256은 대칭키라 **로봇 키가 유출되면 그 로봇 출입증을 위조할 수 있다**. 로봇별 키와
  조직·로봇 대조로 피해를 제한하며, 비대칭키 검증 라이브러리 도입은 후속 보안 결정이다.
- 사용한 jti는 로컬 SQLite 저널에 **hello 승인 전에 FULL commit**한다. 같은 jti의
  두 번째 연결은 종료 후·프로세스 재시작 후에도 거부한다. 만료 ID만 삭제하며 최대
  4096건/DB 물리8 MiB(4096 B 페이지2048개), 저장 실패·잠금·용량 초과는 새 연결 거부다. DB를 삭제/분실하면
  재사용 방지 이력이 사라지므로 키를 바꾼 뒤 복구한다. 활성 연결/조종권은 복구하지 않는다.
  운영 Settings/Config는 `:memory:`·메모리 URI를 거부한다(직접 Verifier 시험만 메모리 허용).
  키 파일과 기존/새 저널은 프로세스 사용자 소유의 일반 파일이고 group/other 권한이
  없는 경우만 허용한다(배포 파일은 **0600**으로 제공). 심볼릭 링크·FIFO·디렉터리·
  그룹 읽기 등 넓은 권한은 시작 거부다. 배포 도구가 만든 secret 링크/그룹 공유 파일을
  그대로 쓰지 않으며 실행 사용자 소유의 실파일로 제공한다. 실제 배포 방식의 시작 시험은 실기 전 관문이다.
  운영자는 상위 디렉터리도 다른 사용자가 교체할 수 없도록 보호한다.
  admission의 작은 동기 저널 쓰기도 OS I/O 지연이 있을 수 있어 sink의 독립 watchdog이 필수다.
  이 FULL commit이 루프를 막는 시간은 **1단계 시뮬 관문의 fsync 지연 측정 항목**이다.
- 시작 시 운영자가 시계 동기화 상태를 확인하고 `FOOTHOLD_PHONE_CLOCK_TRUSTED=1`을
  명시해야 한다(자동 NTP 신뢰 판정 구현은 아님). 로컬 신뢰 값의 거짓 전환(시험 주입),
  UTC 역행(저널의 마지막 승인 UTC 포함), 단조 경과와 UTC 경과의 5 s 초과 차이는
  신뢰 상실이다. 열린 연결을 정지·잠금 후 비우고 모두 닫는다. 자동으로 신뢰를 복구하지 않는다.
  운영 감독자가 프로세스 밖에서 신뢰 값을 바꾸는 IPC는 없다. 동기화 상실 시 현재
  전달 방법은 **프로세스 정지뿐**이며, 실제 NTP 상태 감독 연동은 실기 전 관문이다.
- 계정 잠금·담당 해제 등 서버 권한 회수는 오프라인에서 즉시 알 수 없다. 최대 600초
  남을 수 있다. 발급과 인증된 회수 목록·영속 캐시는 [§13.7](#137-출입증-발급회수-fh-control)을 따른다.
  토큰 재사용 방지는 권한 회수와 다르다.
- **1폰 1대 발급자 의무:** 같은 기기의 서로 다른 로봇 `control` 출입증 유효 구간을
  겹치게 발급하지 않는다. 로봇을 바꿀 때 앱은 앞 로봇의 정지·잠금·반납 reply를 확인하며,
  발급자는 앞 로봇에 발급한 모든 출입증의 마지막 만료까지(최대 10분) 새 대상 발급을
  기다린다. 예외는 §13.7의 **앞 로봇 해당 기기 control 전부 회수 ack**뿐이다.
  같은 대상 갱신/재접속은 새 jti로 허용한다. 에이전트는 다른 오프라인 로봇의
  조종권을 조회·강제 회수할 수 없으므로 이 전역 제한은 §13.7 발급자와 후속 앱이 함께 지킨다.
  기기 UUID는 설치 단위로 고정하고 탭별로 만들지 않는다. 같은 로봇에서 동일 기기의
  두 번째 활성 WS는 보기 연결까지 `DEVICE_CONNECTED`로 거부하며 탭끼리 조종을 공유하지 않는다.

### 13.3 폰 → 에이전트
아래 본문에도 13.1의 `t,id,robot`이 필수다. hello 이외에는 먼저 출입증 검증이 끝나야 한다.

| t | 본문 | 의미 |
|---|---|---|
| `hello` | `{proto:"fh-phone/1",device,ticket}` | 인증·보기 시작. 자동 조종권 취득/해제 없음 |
| `lease.take` | `{}` | 비어 있으면 취득, 다른 조종자가 있으면 `LEASE_HELD` |
| `lease.request` | `{}` | 비어 있으면 취득, 조종 중이면 넘김 요청. 강제 취득 아님 |
| `lease.respond` | `{request_id,accept:bool}` | 현재 조종자만 넘기기/계속 조종 |
| `lease.cancel` | `{}` | 자기 대기 요청 취소 |
| `lease.release`, `view` | `{}` | 자기 조종권을 0+잠금 후 즉시 반납, 보기 유지 |
| `cmd` | `{lease_id,seq,vx,vy,wz}` | SI 단위 m/s·m/s·rad/s, 50 ms마다 중립 포함 송신 |
| `stop` | `{}` | 보기만 출입증도 가능. 즉시 0+잠금, lease·세대 확인 없이 안전 쪽 |
| `unlock` | `{lease_id,stop_gen}` | 현재 조종자의 명시적 CAS 해제 요청, 성공 자체가 해제 확인은 아님 |
| `ping` | `{client_time_ms}` | 1 s마다. state.echo로 짝을 맞춰 폰이 RTT 계산 |

조종권은 사용자+기기+이 WS 연결에 묶인 새 UUID다. 다른 연결이 lease 값을 알아도
cmd/unlock은 `NOT_CONTROLLER`로 버리며 deadman·seq를 갱신하지 않는다. 조종자의
seq는 lease 안에서 엄격히 증가한다. 중복·역행·상한 밖 seq는 형식 오류로 안전 정지한다.

허용 범위표는 앞 `0..0.6`, 옆 `0`, 회전 `-0.5..0.5`이지만 그 사이 모든 속도를
지원한다는 뜻은 아니다. `commands`의 현재 Core 명령은 `[0,0,0]`, `[0.6,0,0]`,
`[0.6,0,-0.5]`, `[0.6,0,0.5]`뿐이다. SI 입력은 성분 크기를 늘리지 않는 방향으로
이 집합에 내린다: vx<0.6이면 0, 회전 절댓값<0.5이면 0, 전진 없는 회전은 0, 옆은 0.
초과 입력은 최대값으로 자르고 `cmd.ack.clipped=true`로 알린다. 실제 최종 판정은
기존 Session/Core다. 잘려서 0이 된 **비중립 입력은 새 중립을 대신하지 않으며 이미
확인한 중립도 지우지 않는다**. 예: 중립 뒤 vx 0.2→0.4는 각각 0과 Core의 미검증 이유를
응답하고, 이어 0.6에서 전진한다. 중립 없이 같은 입력을 보내면 계속 0이다. 내부 어댑터는
중간 입력을 Core가 비중립·0으로 판정하는 유효 축으로 넘기며 실제 출력 크기를 키우지 않는다.

### 13.4 취득·넘김·끊김
- 취득·넘김·반납·끊김은 한 이벤트 루프에서 직렬 처리한다. 먼저 옛 입력을 차단하고
  Session에 lease=null → stop을 적용한 뒤 같은 `stop_ref`·`latched=true`·`applied=[0,0,0]`을
  확인하고 새 lease를 준다. 이 로컬 호출은 동기라 네트워크 왕복을 기다리지 않는다.
  확인 실패는 즉시 `STOP_CONFIRM_FAILED`로 실패(§10.5의 2 s 상한 안), 비움·잠금 유지.
  sink 오류는 STOP과 0을 각각 시도하고 서비스를 종료한다. 몸이 멈췄다는 확인은 아니다.
- 새 조종자는 잠금 상태다. 신선한 로컬 STOP 피드백 → 현재 stop_gen으로 명시 unlock →
  그 뒤 새 해제 피드백 → 새 중립 → 새 비영 입력 순서다. STOP·넘김·재접속 후 자동 재개 없음.
- **정지·조종권을 줄이는 쪽 명령(stop·조종자 release·view)은 속도 제한으로 막지 않는다.**

| 방향/명령 | 적용 예산·처리 |
|---|---|
| 늘리기: `lease.take`·`lease.request` | FREE 즉시 취득 포함, 정확한 `(user, device)` 단위의 독립된 **이동1초8개 + 이동60초30개**. grant·역할 전환·새 출입증 재접속으로 초기화하지 않음 |
| 줄이기: `stop`·현재 조종자 `lease.release`·`view` | 어떤 예산에도 세지 않고 항상 즉시 정지·잠금·해당 조종권 비움(보기 폰의 STOP은 현재 조종권을 빼앗지 않음) |
| 대기 철회: `lease.cancel` | 별도 연결별1초8개. 초과 연결은1013 REQUEST_FLOOD로 닫고 D8 철회 제한 유지 |
| 비조종자 `lease.release`·`view` | 별도 연결별1초8개, 초과는 오류 응답만·연결 유지·실제 취소 무시 |

늘리기 예산은 의미 판정 전에 허용된 **시도**를 센다(성공/LEASE_HELD/COOLDOWN 등 모두 포함).
예산 자체의 거부는 추가 차감하지 않는다. 초과는 `LEASE_ACQUIRE_LIMIT`(detail.status=429)
응답만 하며 연결·STOP을 유지한다. 권한이 비어도 예산을 우회하지 못한다.
거부 감사 사건 `PHONE_LEASE_ACQUIRE_LIMIT`은 합계 횟수를 묶어 **Hub 전체에서 초당1건 이하**다.
출입증·조종권의 수명과 독립적인 프로세스 내 단조시계 예산이며,1초/60초 경계에서 오래된
시도만 비운다. 기존 취소/비조종자 UI 창을 초기화해도 이 예산은 보존한다.

- 먼저 잡은 사람이 우선이다. 대기 요청은 로봇당 1건, 응답 10 s 뒤 `TIMEOUT` 자동 거절,
  기존 조종 유지. 거절(`DECLINED`)/자동 거절(`TIMEOUT`)/**요청자 자기 철회** 뒤 같은
  사용자+기기는 30 s간 `LEASE_REQUEST_COOLDOWN`(detail의 HTTP 상태 의미는 429).
  자기 철회는 `lease.cancel`·`lease.release`·`view`·요청자 끊김(ping 무수신 포함) 모두다.
  **요청자 귀책으로 그 연결을 닫는 거부**(REQUEST_FLOOD·형식 오류·크기 초과·수신 계층
  오류·알림 넘침·보내기 시간 초과 등)도 철회다. 새 출입증으로 같은 사용자+기기가
  재접속해도 제한은 사라지지 않는다. 키는 정확히 `(user, device)`이며 같은 사용자의
  다른 기기·다른 사용자의 같은 device 값에는 제한을 확장하지 않는다.
  **요청자 출입증 만료로 대기 요청이 사라지는 것도 철회**이며 그 만료 시점부터30초 제한이다.
  짧은 새 출입증을 반복해도 우회할 수 없다. 조종자 출입증 만료는 정지·잠금 후 비우며 요청자에게 제한을 추가하지 않는다.
  제한을 추가하지 않는 예외는 **조종자 반납·끊김/만료, 넘김의 `STOP_CONFIRM_FAILED`,
  요청자와 무관한 정리(시계 불신·서비스 종료·로봇 쪽 정리·내부 오류)**뿐이다.
  형식 오류 거부를 서버 정리 예외로 세지 않는다.
  조종권이 비어 있을 때도 D12 늘리기 예산 안에서 즉시 취득한다.
  요청·승낙·거절·자동 거절·취득·해제를 식별자와 함께 사건으로 남긴다.
  `lease.cancel`은 별도 연결당 단조 1 s 구간에8개까지이며 초과 연결만
  1013 `REQUEST_FLOOD`로 닫는다. **비조종자 view·lease.release만 별도 단조1초 창에 합계8개**다.
  그 초과분은 `reply.ok=false`, `REQUEST_FLOOD`(detail.status=429)로 응답하고 무시하며
  **연결을 닫지 않는다**. 현재 조종자의 view·lease.release는 어떤 창에서도 세지 않고
  항상 즉시0·잠금·조종권 비움을 처리한다. take·넘김 수락으로 조종자가 될 때 이전
  취소·view/release 창을 초기화한다(D12 identity 예산은 유지). 비조종자의 창은 취소 창과 독립이고 ping·STOP을 막지 않는다. 비조종자의 폭주 때문에 현재 조종자를 잠그거나
  프로세스를 종료하지 않는다. 제한 거부는 새 전환 사건을 만들지 않으며 D12 거부 횟수만 위 방식으로 집계한다.
  비조종자의 초과 view/release가 무시되면 대기 요청은 남을 수 있고10초 자동 거절 또는 lease.cancel로 끝난다.
- cmd가 **엄격히 >0.3 s** 없으면 기존 Core가 0+입력 폐기·새 중립을 요구한다. deadman에
  잠금을 추가하지 않는다. 앱 ping 3 s 무수신에는 즉시 STOP·잠금·옛 lease 무효화,
  마지막 ping으로부터 15 s까지 사용자+기기 예약만 남긴다. 확인된 소켓 종료는 즉시 같은
  정지를 적용한다. 예약 중 다른 사람의 취득은 거부한다. **같은 사용자+기기**는 새 연결과
  새 출입증으로 재취득할 수 있지만 새 lease/잠금/명시 해제/중립 절차를 다시 지난다.
  15 s 또는 출입증 단조 마감 중 먼저 온 때 예약을 비운다. 정상 반납·출입증 만료는 즉시 비움.
- **인증된 연결**의 형식 오류·두 번째 hello는 STOP+잠금 후 그 연결을 닫고 그 연결이 가진
  조종권을 비운다. 보기 폰도 같으며 Hub 이전 수신 계층의 1002/1003/1007/1009 오류 종료도
  포함한다. 정상 보기 폰 종료는 현재 조종자에게 영향이 없다. 종료 정리 중 출력 실패도
  서비스 소유자에게 전파하고 모든 연결/태스크 정리를 시도하며 최초 오류·취소를 보존한다.
  모든 receive 앞에서 전체 만료를 처리하므로 다른 폰의 프레임이 만료된 옛 out을 다시 내지 않는다.
  재시작은 빈 조종권·잠금이다. 모든 마감은 단조 벽시계다.
- RUN은 이번 경로로 켜지지 않는다. 후속 RUN도 조종자 폰 감시 **3 s 이하 연결 확인**을
  쓰고, 끊김 시 목표 취소·일시정지·잠금 및 사람의 명시 재개를 요구한다(ADR §7 승인 관문).

### 13.5 에이전트 → 폰

| t | 본문·빈도 |
|---|---|
| `hello` | `{id,robot,proto,limits:{vx_min,vx_max,vy_min,vy_max,wz_min,wz_max,commands},policy:{name,version},simulation,ping_interval_ms:1000,link_timeout_ms:3000,lease_timeout_ms:15000}`. 1회. 정책 식별자는 배포 설정이며 에이전트가 실제 정책을 추측하지 않음 |
| `reply` | `{id,ok,error:null|{code,message,detail},lease_id:null|UUID,request_id:null|UUID}`. 요청마다. 새 lease는 해당 연결에만 반환 |
| `cmd.ack` | `{id,seq,applied:[vx,vy,wz],clipped,reason:null|string}`. 명령마다, Core 판정 뒤. applied는 측정 속도가 아니라 실제로 내보낸 요청 값 |
| `lease.requested` | `{robot,request_id,requester:{user_id,device_id},expires_at}`. 현재 조종자에게. expires_at은 표시용 UTC, 실제 만료는 단조 10 s |
| `lease.result` | `{robot,request_id,result:"ACCEPTED"|"DECLINED"|"TIMEOUT"|"CANCELED",error:null|string}`. 요청자·전 조종자에게. 새 조종자의 lease는 다음 자기 state에만 표시 |
| `state` | 아래 전체 스냅샷, 10 Hz. 첫 hello 인증 전에는 보내지 않음 |

state는 §10과 같은 이름·뜻의 `battery:{soc,voltage?}`, `pose:{floor_id,x,y,yaw,confidence}`,
`speed`, `latched`, `stop_gen`, `applied`, `mode:"USER"|"FREE"`, `devices_changed`에
다음 칸을 더한다. 없는 측정은 null이며 만들어서 0/정상으로 보내지 않는다.

| 칸 | 뜻 |
|---|---|
| `robot`, `controller`, `controller_device` | 로봇·현재 조종자 사용자·기기 UUID. 예약 중에도 사용자/기기를 보이며 없으면 null |
| `controller_connected`, `lease_id` | 살아 있는 조종자 연결 여부. lease_id는 그 연결에만 보이고 나머지는 null. 예약은 연결/lease가 아님 |
| `stop_ref` | **폰 state에 한해** Hub가 생성한 로컬 STOP 확인 카운터다. 폰의 요청 ID나 서버의 ref가 아니다. Observer가 서버에 보내는 §10.5 stop_ref는 서버의 마지막 유효 ref만 돌려주며 없거나 서버가 재접속하면 0이다 |
| `stop_requested`, `posture:{z,tilt_deg,fallen,body_still}`, `velocity:[vx,vy,wz]` | 신선한 로컬 bridge 피드백. 오래되면 각 값 null |
| `echo:{id,client_time_ms,agent_time_ms}|null` | 마지막 앱 ping의 ID·폰 시각·에이전트 수신 UTC ms. 폰이 수신 시 RTT를 계산하며 서로 다른 시계의 단방향 지연으로 추정하지 않음 |
| `simulation`, `wall_time_ms`, `sim_time_s`, `sim_wall_delta_s` | 명시적 배포 설정(`FOOTHOLD_PHONE_SIMULATION=1/0`, 없으면 시작 거부), UTC ms, 측정 시뮬 초, 같은 episode의 첫 관측부터 `(시뮬 경과)-(단조 벽시계 경과)` 초. 멈춤·느려짐은 음수, 신선한 근거가 없으면 null. 실기는 시뮬 두 칸 null |

### 13.6 오류·닫기·후속 경계
- 요청 실패는 `reply.ok=false`와 §1.4 형태의 error다. `LEASE_HELD`, `NOT_CONTROLLER`,
  `FORBIDDEN`, `UNLOCK_REJECTED`, `LEASE_REQUEST_PENDING`, `LEASE_REQUEST_EXPIRED`,
  `LEASE_REQUEST_COOLDOWN`, `LEASE_ACQUIRE_LIMIT`(취득/요청 예산 초과의 연결 유지 응답),
  `REQUEST_FLOOD`(view/release 초과의 연결 유지 응답),
  `STOP_CONFIRM_FAILED`를 쓴다. 이전 lease/세대로 자동 재시도하지 않는다.
- 닫기: `4401` 만료·hello 없음·시계 불신, `4403` 출입증/조직/로봇/기기/용도 불일치·재사용,
  `4406` proto 불일치, `1012` 두 번째 hello, `1013` 3 s 끊김·수용 한도,
  `1003` 이진, `1007` 형식/seq 오류, `1009` 4 KiB 초과. 이유에는 코드만 싣고 출입증은 싣지 않는다.
  4401/4403은 새 인증/시계 복구 전 자동 재연결하지 않는다. 4406은 30 s 이상 간격,
  1013은 시작1초에서 지수 백오프로6초 이상까지 간격을 늘려 새 출입증으로 재접속한다.
  429의 retry_after는 반드시 지키며 조종권 복원을 뜻하지 않는다.
- 카메라·streams·slam(start/save/cancel)·floor.set·정책 전환·시나리오/목표는 후속 계약이다.
  제어 동작은 조종자만이며 서버의 옛 slam/floor.set/run.*는 현재 직결 모드에서 실행하지 않는다.
  이번 모델에는 실행 가능한 빈 명령을 추가하지 않는다.


#### 실기 전 관문 (아직 미검증)

이 절이 폰 직결 배포·현장 승인 전 확인 목록의 정본이다. 이번 ROS 없는 단위/WS/변이
검증은 아래 관문을 통과한 뜻이 아니다. [ADR-002 §8](09-ADR-002-PHONE-DIRECT.md#8-단계--시뮬-먼저-실기-없이-끝까지)의 단계 선행 조건과 시뮬→실기 순서를 따른다.

- **로봇 망·접속 자원:** 망 분리, 주소별 접속 속도·동시 TCP 수·ulimit. 논리 hello 대기16개가
  handshake/닫는 중인 소켓까지16개로 묶지 않는다. 같은 주소/NAT 또는8개를 넘는 다중
  공격 주소는 재접속을 막을 수 있다. r3 조종자16×4는3/10, r4 신규 보기 폰STOP은16×4에서
  7/10·NAT 공유8/10이었다. 실패는 정지 쪽이며 보장값이 아니다. 승인된 폰의 STOP과 신규
  폰의 hello→STOP 접속을 구분한다. **역방향 프록시 앞단 금지**(주소가 하나로 합쳐짐).
- **클라이언트·배포:** PWA 실제 Origin 허용 목록 필수(빈 목록은403), 실제 앱/브라우저
  출처·WSS/TLS 제공 방식, 실행 사용자 소유0600 실파일 키·저널(심볼릭 링크·그룹 읽기 거부),
  보호된 상위 디렉터리·키 배포/회전·저널 복구. 폰 앱의1013 후 시작1초·지수 백오프(6초 이상까지)·429 retry_after 준수와
  비조종자 view/release 연타 묶기·오류 처리. COOLDOWN·LEASE_HELD·PENDING 중 take/request
  재시도·연타 금지(거절도 예산을 쓰므로 잠김이60초로 늘어남), 조종자 상태에서 take 재전송 금지.
  STOP/조종자 반납은 지연시키지 않는다.
- **시계·발급:** NTP 상태 감독·시계 신뢰 확인/상실 전달(현재 IPC 없이 프로세스 정지),
  UTC/단조시계 경계 실환경 시험. **발급 iat의 미래 여유는0초**(`iat ≤ 로봇 UTC`),
  서버가 앞서면 전송 지연으로 상쇄되지 않는 차이만으로도4403일 수 있다. 에이전트 자신의
  UTC/단조 경과 차5초 검사는 서버↔로봇 시계 차5초 허용을 뜻하지 않는다. **fh-control 출입증 발급 속도 제한**도 D8·D11·D12의 새 출입증
  반복 방어 전제다. [§13.2](#132-출입증-발급자는-관제-서버-검증자는-에이전트)의 **1폰1대 발급자 의무**도 확인한다.
  발급 속도·사용자당 기기 수 제한은 D12의 전제이기도 하다. 검토의16 identity 합계는
  5초 취득480·기록966·disk spill711, 지속 분당 취득480이었다. history spill 상한은8MiB다.
  §13.7의 서버 발급과 에이전트 검증 왕복은 시험 키로 검사하며 실제 배포는 이 관문에서 확인한다.
  사용자·로봇별 회수 포함32개 제한도 적용한다. 발급마다 회수하는1-jti 묶음의4096행을
  채우려면 적어도128계정(4096÷32)이 필요하다. 이는 **그 로봇 발급 권한을 가진 계정**
  (**같은 조직 ORG_ADMIN 전원 + 그 로봇 owner 1명**, 중복 제외)이 충분히 있다는 전제다.
  미회수8개도 예약과 같은 `exp+60 > UTC` 창으로 세므로 미회수8개×4KiB 예약 경로는
  32계정(1MiB÷32KiB), 회수24개+미회수8개 혼합은 작은 묶음 overhead까지 합쳐 약35KiB/계정으로
  약30계정에서 바이트 상한에 먼저 닿을 수 있다. 이전의8개 판정은 exp만 보아16계정에서 유예8개+새8개가 겹쳤으나,
  현재는8개 상한의 창을 예약과 맞춰 이 중첩을 막는다. 발급 제한은 다수 권한 계정의 공모를 완전히 막는 보장이 아니다.
- **루프·출력 부하:** hello SQLite FULL commit/fsync 차단 시간, hello 대기 흐름 중20Hz
  조종/감시 흔들림, sink 독립 watchdog. **회수 pending 조회0.1초 × 로봇 수**의 DB/읽기 풀
  부하와 회수 묶음 재전송 중 정지 지연도 측정한다. **STOP 연타의 bridge·로봇 명령 부하**(검토의
  5초2.3~2.6만 sink 출력)를 큐 크기·지연과 함께 측정한다. STOP은 원칙상 제한하지 않는다.
- **단계1 시뮬·실폰·실로봇:** 격리 Gazebo1대·카메라/시뮬 관리자 선행 승인 뒤 같은PC/현장 망
  명령 지연95분위≤100ms, 입력 끊김→0≤0.4초, STOP 뒤 자동 재개 없음·출입증/조종자 규칙.
  그 다음 실제 폰·기체/펌웨어/연결 방식의 정지 거리·지연, WSS 배포, 다중 로봇 명령/TF/
  이름 공간 격리를 확인한다. 실기 정지 거리 기준은 실기 단계에서 별도로 정한다.
  ROS 실행0 제약으로 제외한 실제 DDS synthetic 시험(`test_ros_bridge_synthetic.py`,
  domain93 opt-in)도 단계1에서 별도로 실행한다.

카메라·RUN·시뮬 관리자·웹 연결은 후속이다. 발급/회수는 §13.7이다. Nav2 기존 변이 분류의
cancel_goal_removed assertion11개+StopIteration3개(64/65)는 별도 검사 도구 후속이며
실기 관문을 대신하지 않는다. 무해한 중복 방어 변이 생존은 결함으로 세지 않는다.

### 13.7 출입증 발급·회수 (`fh-control`)

`POST /api/v1/robots/{robot_id}/phone-pass`는 §2의 현재 로그인 세션을 매번 검사한다.
웹 세션은 `X-FH-CSRF` 필수, 앱은 기존 Bearer 세션 규칙이다. 요청은
`{device:UUID,purpose:"control"|"view",switch?:false}`이고 응답은
`{token,exp:UTC초,kid}`다. `Cache-Control: no-store`이며 토큰은 **응답 본문에만** 담는다.
URL·쿠키·로그·감사 사건·DB에 토큰/서명을 넣지 않는다. 화면/앱은 이 응답을 저장·공유하지 않는다.

- control은 기존 `authorize(O_OWN)`, view는 기존 상세 보기 `authorize(ROBOT_READ)`를
  재사용한다. 로봇 요약 목록의 공개 범위와 상세 원격측정 보기 범위를 혼동하지 않는다.
  다른 조직·없는/해제된 로봇·보기/조종 불가는 동일404 `NOT_FOUND`, 잠긴/삭제 계정·폐기
  세션은401이다. 서버의 현재 배정·권한을 읽으며 출입증 요청으로 권한을 늘리지 않는다.
- §13.2의 모든 claim을 그대로 서명한다. `iss=fh-control`, `aud=fh-phone/1`,
  `org,robot,sub,device,purpose`, 서버 UTC 정수초 `iat`, `exp=iat+600`, 새 UUID `jti`다.
  클라이언트가 수명·사용자·조직·로봇 claim을 지정할 수 없다. 발급 기록은
  jti·user·device·robot·purpose·iat·exp만 저장하고 만료된 기록을 다음 발급에서 정리한다.
  발급은 `PHONE_PASS_ISSUED` 감사 사건(토큰 없이)이다. 거부는 조직별 영속 카운터에
  이유별 횟수를 모아 **초당1건 이하** `PHONE_PASS_DENIED {count,reasons}`로 기록한다.
  조용한 구간에도 별도 작업이 집계하며 재시작/종료 때 미기록 횟수는 DB에 남아 이어진다.
- **1폰1대:** 같은 `(user,device)`의 다른 로봇에 만료 안 된 control이 하나라도 있고 그
  출입증 모두의 회수 ack가 없으면409 `PASS_OTHER_ROBOT`, detail.retry_after는 마지막
  exp까지 남은 초다. 같은 로봇 재발급은 허용, view는 이 제한 밖이다. 앱은 앞 로봇의
  정지·잠금·반납 reply를 확인한 뒤 **명시 `switch:true`**로 새 대상 발급을 요청한다.
  이때만 앞 로봇들의 그 identity control 전부를 회수 outbox에 넣고409 `PASS_SWITCH_PENDING`을
  돌려준다. 첫 요청은 발급하지 않으며 **모든 이전 출입증의 ack 뒤 재요청**부터 허용한다.
  단순히 다른 로봇 발급을 잘못 누르는 것은 회수를 만들지 않는다. 오프라인 앞 로봇은
  ack를 못하므로 마지막 만료까지 기다린다. 서버는 폰 반납을 자동으로 추정하지 않는다. 보장은 **사용자가 선언한 기기 UUID 단위**다.
  서버가 물리 폰을 증명하지 않으므로 UUID를 바꾸면 사용자당4대까지 별도 기기로 우회할 수 있다.
- **D13 발급 한도:** 조직 쓰기 잠금 아래 `(user,device)`당 이동60초에 성공한 발급10건,
  사용자당 만료 안 된 출입증이 있는 서로 다른 device 최대4대다(control/view 합산).
  초과는429 `PASS_RATE_LIMIT`/`PASS_DEVICE_LIMIT`, detail.retry_after는 최초 예산/기기 슬롯이
  돌아올 때까지 남은 초다. 새 세션·재접속으로 초기화되지 않는다. 1013 뒤 재접속은 시작1초의 지수 백오프를 적용해6초 이상까지 늘리고 매번 새 출입증이
  필요하다. 429에서는 retry_after보다 일찍 발급을 재시도하지 않는다. 이 한도는 D8·D11·D12의 발급자 방어 전제다.
- **사용자별 로봇 점유 한도:** `(user,robot)`별 **회수 안 된 보존 출입증**은 `exp+60 > 서버 UTC` 창에서
  control/view·모든 기기를 합쳐 최대8개다. 초과는429 `PASS_ACTIVE_LIMIT`,
  `detail:{limit:"active",retry_after:…}`이며 retry_after는 그8개 중 가장 이른 exp+60까지다.
  8개를 모두 썼으면 만료 후60초까지 새 발급을 기다린다. 기기당1개씩4기기의 정상 만료 갱신은
  유예4개+새4개여서 허용된다.
  회수된 jti는 ack와 무관하게8개 상한에서만 제외한다. 다른 로봇 전환의1폰1대 ack 조건은 위 규칙을 유지한다. 로그아웃·권한 회수 뒤 재로그인해
  새 출입증을 받을 수 있다. 회수된 jti의 공간은 로봇별4096행/1MiB 예약이 계속 센다.
  **두 번째 상한은 같은 `(user,robot)`의 회수 여부와 무관한 보존 출입증32개**다.
  `exp+60 > 서버 UTC`인 control/view·모든 기기를 합산하며 ack도 공간을 돌려주지 않는다.
  초과는429 `PASS_ACTIVE_LIMIT`, `detail:{limit:"retained",retry_after:…}`이며
  retry_after는 보존 출입증 중 가장 이른 `exp+60`까지다.
  경계 `exp+60 == 서버 UTC`부터 제외한다. 다른 로봇/사용자의 상한은 별도이며 새 세션·device 변경으로
  초기화되지 않는다.8개 발급→로그아웃→재로그인 발급200을3회 반복해도 허용된다.
  **D13의 발급 예산·기기 슬롯은 회수/ack로 돌려주지 않는다.** 기기당60초10건·4기기의
  속도 예산과32개 보존 상한은 함께 적용한다.12명이 발급마다 회수하는 회귀에서 각32개 뒤429,
  합계384회수 묶음/약41KiB로 로봇 예약에 닿지 않고 다른 사용자 발급은200이다.
  1-jti 회수 행 경로는 최소128계정이 필요하지만 기존 미회수/혼합 바이트 경로는 약30~32계정으로도
  먼저 포화할 수 있다(계산·권한 전제는 §13.6). 이 제한들은 STOP·조종자 반납을 막지 않는다.
  **출입증 발급을 거부당해도 서버 STOP 경로(`POST /api/v1/robots/{id}/stop`)는 계속 쓸 수 있다**
  (기존 로그인·CSRF·로봇 보기 권한·서버/로봇 링크 조건은 그대로).
- 키가 배포되지 않은 로봇은503 `PASS_KEY_MISSING`이다. 환경 변수 `FH_PHONE_PASS_KEYS`의
  경로에서 로봇별 최소256bit 키를 읽는다. 파일 형식은
  `{robot_UUID:{"active":kid,"keys":{kid:unpadded_base64url_secret}}}`다. active는 반드시
  명시하고 keys에 있어야 하며 빈 키 묶음은 시작 거부한다. 실행 사용자 소유0600 실파일만
  사용하고 심볼릭 링크·group/other 접근 가능 파일·다른 uid·디렉터리를 거부한다.
  경로/키는 DB·Git·웹 번들·로그에 넣지 않고 보호된 상위 디렉터리에 배포한다.

#### 키 생성·회전

개발 도구 `apps/server/tools/generate_phone_keys.py`의 `--robot`, `--kid`,
`--server-output`, `--agent-output` 인자로 한 로봇의 두 파일을 만든다. 두 출력 경로는
**저장소 밖의 서로 다른 새 경로**여야 하며 기존 파일을 덮지 않는다. 키는 실행 중 난수로
만들고 화면에 출력하지 않는다. 서버 출력은 위 active/keys 형식, 에이전트 출력은 기존
`{kid:secret}` 형식이다. 여러 로봇은 비밀 배포 절차에서 서버 묶음으로 합치며 키를 공유하지 않는다.

회전은 새 키를 먼저 해당 로봇 에이전트의 키 묶음에 더하고 재시작·잠금·시계/저널을 확인한
뒤 서버 파일 keys에 새 키를 더해 active를 바꾸고 서버를 재시작한다. 예전 키는 이전 발급의
마지막 exp와 오프라인600초 창이 끝날 때까지 두고 제거한다. 즉시 회수는 아래 목록과 ack를
사용하며, 새 active 지정만으로 이미 발급한 출입증이 무효가 되었다고 판단하지 않는다.
키/저널 백업·반환·키 유출 대응과 실제 배포 검증은 §13.6의 실기 전 관문이다.

#### 회수와 한계

계정 잠금·삭제·역할 변경, 담당 해제, 강제/사용자 로그아웃(해당 사용자의 모든 기기),
비밀번호 변경, 명시 로봇 전환은 같은 조직 쓰기 트랜잭션에서 아직 유효한 출입증별 회수
outbox를 저장한다. 전송 묶음도 같은 트랜잭션에 불변 저장해 재접속 때 같은 seq/본문을
보낸다(최대16항목·항목당64jti·전체4KiB). 묶음 ack는 포함 jti 모두에 원자 적용한다. 담당 해제는 이전 담당자의 해당 로봇만 대상으로 한다. 발급 기록과
회수 기록은 만료 이후 정리하며 감사 기록은 기존 보존 규칙을 따른다.

인증된 §10 서버 링크가 `phone.revoke`를 전송한다. 현재 구현은 jti 선택자를 보내고,
계약은 `{sub[,device],until}` 선택자도 허용한다. 에이전트는 자신의 로봇 서버 링크에서만
받고 폰 프레임으로는 받지 않는다. 같은 SQLite 저널(물리8MiB 상한, FULL commit)에
회수 seq·선택자·until을 보존한다(회수 행 최대4096, 실제 바이트 한도가 먼저 찰 수 있음).
같은 seq·같은 본문은 멱등, 같은 seq의 다른 본문은 저장 오류로 닫는 쪽이다. until은
**새 hello 거부 캐시의 UTC 보존 기한**이다. 이미 승인된 연결은 고정된 **단조 마감**으로
유효성을 판정하며, 허용된 UTC 전진 보정으로 until을 넘었어도 일치 jti는 회수한다.
사용자/기기 선택자는 `iat < until`인 기존 연결만 대상으로 하므로 until 이후 승인된
정상 새 출입증을 끊지 않는다. 조종 연결은 기존 반납 경로로 즉시0·잠금·비움, 해당 보기 연결도4403,
새 hello도4403이다. 저장/용량 실패는 즉시 정지·잠금·열린 연결 종료·새 hello 거부이며
ack하지 않는다. 원인 복구와 명시 재시작 전에는 정상으로 돌아가지 않는다.

적용·FULL commit 뒤 `phone.revoke.ack(seq)`를 보낸다. 서버는 그 로봇의 인증된 링크에서
보낸 seq 이하이며 해당 로봇에 속한 묶음의 ack만 전용 큐/작업으로 순서대로 저장하고
1폰1대 예외에 쓴다. 느린 ack DB 쓰기는 에이전트 수신 루프를 막지 않으며, 저장 전에는
예외가 열리지 않는다. 연결당 대기 큐128개가 차면 처리하지 못한 가장 낮은 seq 직전으로
전송 커서를 되돌려 다음 조회부터 같은 연결에 재전송한다(확인으로 세지 않음).
저장은 **5초** 제한이며 초과하면1013 `REVOCATION_ACK_STORAGE_TIMEOUT`, 저장 오류는
1013 `REVOCATION_ACK_STORAGE_UNAVAILABLE`로 닫아 재접속 재전송한다. timeout으로 이미
실행 중인 DB commit을 억제하지 않는다. 실제 commit 전에는 전환을 허용하지 않으며,
늦은 commit은 닫힌 연결의 커서·대기 집합을 바꾸지 않는다. 재접속의 같은 seq 저장은 멱등이다.
ACK 저장은 API 일반 엔진과 분리한 풀(2개·overflow0·대기0.5초)을 쓴다.
풀 획득 대기 실패는 DB 오류로 보지 않는다. ACK는 미확인으로 남기고 연결을 유지하며
해당 seq 직전의 retry floor로 다음 주기에 재전송한다. 로봇별 연속 풀 대기 실패 수를 세고
첫 실패 및 이전 경고 뒤30초 이상 지났을 때만 경고1줄을 남긴다(고정 원인 `POOL_TIMEOUT`,
연속 횟수, 대기 seq 최소/최대; 토큰·jti 원문 없음). 실제 ACK 저장 성공 시 연속 횟수는0으로
돌리되 경고 간격은 유지한다. 로봇 행 삭제 시 경고 상태를 지우고 늦은 실패도 다시 만들지 않는다.
닫힌·교체된 peer는 경고/계수에서 제외한다. 실제 DB 오류의1013
`REVOCATION_ACK_STORAGE_UNAVAILABLE`와5초 저장 timeout의1013
`REVOCATION_ACK_STORAGE_TIMEOUT`는 유지한다.
연결1초·statement2초·lock1초·TCP 무응답2초 제한을 두어 DB가 멈춘 뒤 슬롯을
무기한 붙잡지 않게 한다. 외부5초 제한과 늦은 commit/재접속 멱등 규칙은 그대로다.
로봇별 진행 중 저장은 **1개**로 제한한다. 이전 저장이 남으면 새 연결도 그 완료를 기다리며
동일5초 제한으로 닫힐 수 있다(멈춘 DB 작업을 재접속마다 새 스레드로 늘리지 않음). 에이전트가 다시 연결되면 ack 여부와
무관하게 아직 유효한 회수 전부를 seq 순서로 재전송한다. 연결 중에도 outbox를 계속
전송하고, DB/전송 실패 시 재접속으로 다시 보낸다. 서버와 끊긴 로봇은 새 회수를 알 수
없어 **최대600초** 남는다([ADR §5.2](09-ADR-002-PHONE-DIRECT.md#52-출입증--서버-없이-확인하되-오래-남지-않게)). 회수는
**출입증 무효화**이며 서버가 lease·cmd를 내려 조종권을 발급·덮어쓰는 것이 아니다.


로봇별 예약은 아래 두 한도를 동시에 만족해야 한다(D16 정정).

| 항목 | 예약 계산 | 상한 |
|---|---|---|
| 행 | 만료 안 된 회수 **묶음 수(ack 여부 무관)** + 아직 회수 안 된 살아 있는 출입증 수(향후 각1묶음 최악값) |4096행 |
| 바이트 | 같은 묶음의 실제 직렬화 `phone.revoke` 본문 바이트 합 + 같은 출입증당4KiB |1MiB |

서버 예약의 **wire1MiB·4096행**과 에이전트 저널의 **물리8MiB**는 다른 한도다.
에이전트는4096 B 페이지2048개를 사용한다. 본문이2KiB를 막 넘는 행의 페이지 낭비,
B-tree/색인·metadata·같은 DB의 used-jti4096행 몫을 포함할 여유로 wire의8배를 둔다.
서버 wire 한도를 절반으로 줄이는 안은 이 페이지 경계를 충분히 설명하지 못해 채택하지 않았다.
실제 pack/Verifier로 최대 프레임·2KiB 직상 프레임·1jti+used4096행 극단을 함께 검사한다.
에이전트 저널은 ack한 묶음도 until까지 보존하므로 **ack는 예약을 비우지 않는다**.
서버의 정리·예약·회수/재전송 만료 판정은 로봇 시계 지연 여유 **+60초**를 더한다.
즉 `exp/until +60 > 서버 UTC`이면 유지하고, 같거나 작을 때만 비운다.
이 여유는 출입증600초 수명·서명 검증·iat 미래 여유0초·1폰1대 권한 만료를 늘리지 않는다.
한도를 넘길 **새 발급만503 PASS_REVOCATION_CAPACITY**로 거부한다. 계정 잠금·로그아웃·
회수 자체·폰 STOP/현재 조종자 반납은 이 한도로 막지 않는다. **만료(+60초)로만** 여유가
생긴다(회수 시 묶음 압축으로 예약 최악값이 줄 수 있음). 기존 초과 이력이 있다면 발급을
멈추고 회수/정리하며 이력을 버리지 않는다. 조직 잠금 트랜잭션으로 마지막 슬롯도 직렬화한다.
발급 거부 요약은 전체 횟수·이유와 함께 거부가 많은 사용자 상위8명의 `user_id`별 횟수,
나머지 합계 `other_count`를 남긴다(토큰·서명 없음, 조직당 초당1건 이하).

#### 0013 운영 되돌림

우선 **코드 revert +0013 테이블 보존**으로 대응한다. 발급·회수·불변 묶음·ack·거부 집계
이력을 지운 빈 DB로 재승격하면1폰1대와 회수 예외의 근거를 잃는다. 실제 스키마 되돌림이
꼭 필요하면 다음 순서를 운영 절차로 확인한 뒤 수행한다(이번 PR에서는 미실행).

1. 새 출입증 발급을 중지하고 마지막 발급 시각·exp와 미완료 회수/ack를 확인한다.
2. 마지막 출입증 만료까지 **최대600초** 기다리고 회수 적용·조종 정지/잠금 상태를 확인한다.
   끊긴 로봇은 ack로 간주하지 않으며 만료 확인 없이 초기화/재발급하지 않는다.
3. phone_passes·phone_revocations·phone_revocation_batches·phone_pass_denials 이력을 백업하고
   복구·검증 방법 및 키/active 판을 기록한 뒤 승인된 스키마 작업을 한다.
4. 재승격 전 이력·seq·ack를 복구/대조한다. 이력을 복구할 수 없거나 키 신뢰가 깨졌으면
   새 로봇별 키 배포/회전과 잠금·저널·시계 확인을 거쳐 재발급한다. 예전 키로 만료 출입증을
   새로 유효하게 만들지 않는다. 다운그레이드 왕복 단위 시험은 이 운영 승인을 대신하지 않는다.

### 13.8 1단계 카메라 (`fh-phone/1`, P1-C)

이 절은 §13.6의 «카메라 후속» 중 낮은 빈도 JPEG 경로를 구체화한다. 실시간 제어 WS
`/phone/ws`와 **같은 에이전트 포트의 별도** `/phone/camera/ws`를 사용한다. 영상 전송이
막혀도 제어의 응답·STOP·deadman 작업을 기다리게 하지 않는다. 서버를 경유하지 않는다.

1. 배포에서 `FOOTHOLD_CAMERA_ENABLED=1`인 경우에만, 기존 출입증 hello 성공 응답의
   `camera_token`에 43자 난수 토큰을 준다(그 외 null). control/view 모두 같다.
   토큰은 부모 연결 하나·로봇 하나에 묶이고, **발급 후 10초 미만·1회용**이다.
2. 폰은 카메라 WS의 첫 텍스트 프레임으로
   `{t:"camera.hello",robot:UUID,token:camera_token}`을 보낸다. URL·저장·로그에 넣지 않는다.
   hello는 4 KiB·1초 이내, 전체 카메라 접속은 인증 대기를 포함해 최대16개다.
   인증 대기는 주소별2개이며 초과는1013 CAMERA_ADDRESS_CAPACITY다.
   부모 폰 연결 하나당 카메라 연결은 하나만 허용한다.
3. 에이전트 → 폰 프레임은 다음 두 가지다. `CameraHello/Frame/Status` 생성 계약이 정본이다.

| t | 필드 | 뜻 |
|---|---|---|
| `camera.frame` | robot, seq, mime=`image/jpeg`, width, height, jpeg | 실제 크기와 표준 base64 JPEG. seq는 카메라 프로세스 수명 안에서 증가하며 조종 seq와 관계없음 |
| `camera.status` | robot, state=`NO_VIDEO` | 영상 없음. 연결 직후, 유효 원천 수신 후 단조 벽시계1초 초과, 카메라 미수신 때 |

JPEG 원본은 최대65,536 B(64 KiB), width≤640·height≤360이다. base64는 최대87,384자이므로
영상 **수신** 프레임 한도를96 KiB 이상으로 둔다. 제어 **송신**의4 KiB 한도는 그대로다.
≤5fps 송신 상한은 `run()`의 단조 벽시계0.2초 sampler가 보장하며 실측fps를 보고한다.
원천 격자만으로 송신 최소 간격/창 상한을 주장하지 않는다. 원천 submit은0.2초
격자(next += 0.2, 긴 공백 뒤 재설정)로 제한한다. 미소 흔들림으로 격자가 누적 지연되지
않으며 유효하지 않은 프레임은 자리를 쓰지 않는다. 아직 샘플하지 않은1장은 덮어쓰지 않는다.
ROS 입력 최신1장·폰별 대기 최신1장만 둔다.
현재 원본의424×240 JPEG를 재인코딩·확대하지 않는다. 640×360은 상한이며 기본 출력
크기640×360 대신 원본 크기를 쓰는 조정 결정이다. 손상된 외피·크기 불명·상한 초과
프레임은 버린다. JPEG 바이트를 저장하거나 안전 판단에 쓰지 않는다.

인증 후 카메라 WS는 받기 전용이다. 폰이 추가 application 프레임(조종·STOP 포함)을
보내면4403 `CAMERA_RECEIVE_ONLY`로 **영상 소켓만** 닫는다. 잘못된·재사용·만료 토큰은
4403 `CAMERA_UNAUTHORIZED`다. 부모 종료·출입증 만료·회수·전환으로 부모가 없어지면
최대50 ms 감시 주기 뒤4403 `CAMERA_PARENT_CLOSED`로 닫는다(네트워크 닫힘 완료 지연 별도).
느린 영상 쓰기는0.2초 제한 뒤1013 CAMERA_SEND_TIMEOUT으로 영상 연결만 닫고,
hello 대기 만료는1013 CAMERA_HELLO_TIMEOUT이다. 폰 조종 연결은 유지한다. 프레임 유실·
NO_VIDEO·카메라 소켓 닫힘은 조종권·STOP·입력 만료를 바꾸지 않는다. 재연결은 새 부모
hello/새 출입증으로 새 토큰을 받는 흐름이며, 조종권 자동 복원은 없다.

### 13.9 시뮬 관리자 중계 (P1-C 준비)

폰은 관제 서버의 다음 API를 호출하고, 서버만 loopback 시뮬 관리자와 서비스 인증으로
통신한다. 로그인·웹 CSRF는 기존 규칙, 권한은 목록/생성 `authorize(O)`, 기존 로봇
제거/재요청 `authorize(O_OWN)`다. 새 권한·조종 명령 중계 경로를 만들지 않는다.

| API | 입력 / 응답 |
|---|---|
| `GET /api/v1/simulation/worlds` | `SimCatalog`: 공개 world id·name·description·사전 배포 slot UUID·상한·launcher. 원본 경로/키 없음 |
| `GET /api/v1/simulation/robots` | `SimRobotList`, 현재 조직·본인 소유만(총괄은 조직 전체) |
| `POST /api/v1/simulation/robots` | `SimStartRequest {world_id,robot_id}` →201 `SimRobot` |
| `DELETE /api/v1/simulation/robots/{robot_id}` | 담당 권한 확인·STOP/0·정리 확인 뒤204 |

`SimRobot`은 generation, robot_id, owner_id, world_id, `simulation:true`, state, agent_address,
namespace, tf_prefix, command_topic, launcher를 싣는다. `state=PREPARED,launcher=fake`는
가짜 launcher의 계약 시험 결과이고 접속 가능한 로봇이 아니다. `RUNNING,native-single`은
네이티브 에이전트 listener가 열린 결과이며 §13.6·ADR-002 §8 성능 통과를 뜻하지 않는다.

시뮬 오류는 기존 `error.code`·HTTP 상태를 유지하고 선택 `error.detail`(단수)에
`SimFailureDetail`을 싣는다. `reason`은 `resources_low`(메모리·부하 관문 거부),
`manager_unreachable`(관리자 미설정 또는 연결 거절), `slot_busy`(슬롯 사용 중),
`unknown`이다. 이유 없는 옛 응답·알 수 없는 이유는 기존 일반 문구를 쓴다.
timeout·본문/프로토콜 오류만으로 «관리자 꺼짐»이라고 단정하지 않는다.
선택 숫자는 `mem_available_mib`, `load1`, `min_mem_available_mib`, `max_load1`이며
주소·경로·원격 오류 문장·인증 정보는 중계하지 않는다.
`start_not_created:true`는 기존 자원 preflight가 unit·프로세스·원본 출력 생성 전에
거부한 두 경로(episode 검사 또는 Simulation.start 첫 검사)에서만 전달한다.
정확히 `503 SIM_UNAVAILABLE + reason=resources_low + start_not_created=true`이면
관리자 failed를 고정하지 않고, 서버는 같은 STARTING 세대만 출입증 회수·hash 교체·owner
해제와 START_REJECTED 감사 후 IDLE로 돌린다. 앱은 «PC 자원이 부족해 시뮬을 띄우지
않았습니다(메모리·부하). 잠시 뒤 다시 띄우세요.»를 표시하고 고르기로 돌아간다.
빈 episode 폴더와 preflight 증거는 남을 수 있다. 다음 시도도 모든 시작 관문을 다시 통과해야 한다.
증명 없는 자원 오류·생성 뒤 실패·불확실은 failed 고정과 STARTING 예약을 유지한다.
관리자 연결 거절은 «시뮬 관리자가 꺼져 있습니다. 관리자를 다시 켠 뒤 정리하세요.»,
`SIM_DISABLED` 설정 누락은 «시뮬 관리자 연결 설정이 없습니다. 관리자에게 설정을 요청하세요.»로 구별한다.
슬롯 사용 중 안내는 남은 다른 슬롯이 있을 때만 «다른 슬롯»을 제안하며,
STOP·기존 정리 동작·불확실한 슬롯의 소유 확인을 유지한다.

서버는0014의 `robots.simulation`(기본false)을 중계 등록에서만true로 저장한다. 일반 로봇
등록/수정 입력은 이 필드를 받지 않는다. offline·메타데이터 갱신·제거 뒤에도 로봇 요약에
`simulation:true`가 남는다. 화면의 «시뮬» 표시는 **DB RobotSummary.simulation만** 사용한다(화면 구현 별도).
에이전트 welcome/state.simulation은 참고용이며 출처 판정에 쓰지 않는다. 시뮬 행의 일반
`/robots/{id}/agent-token` 회전은409 SIM_TOKEN_MANAGED, 일반 DELETE와 담당자 PATCH는
409 SIM_ROBOT_MANAGED로 거부한다. 이름 수정은 기존 권한으로 허용한다.
SIM_ROBOT_REQUESTED/REGISTERED/REMOVED·REMOVE_FAILED·REMOVE_STALE·START_REJECTED·START_STALE 감사는
id·world·generation·launcher·실패코드·관리자 인스턴스·부재 복구 여부만 담고 주소·토큰·키는
담지 않는다. 에이전트 시작 전 id·토큰 hash와 REQUESTED를 먼저 commit하므로 시작 응답이
유실·timeout·5xx·신원/응답 검증 실패는 STARTING을 유지하고 자동 재취득하지 않는다.
STARTING에서도 같은 권한의 DELETE로 같은 세대의 관리자 로봇을 정리한 뒤 IDLE로 복구한다. 제거 전 살아 있는 출입증을 기존 회수 outbox로
commit하고, 정리 중 새로 발급된 것도 완료 직전 조직 잠금 아래 다시 회수한다. 제거 성공 뒤 owner를 비워 다른 사람이 슬롯을 쓸 수 있게 한다. 실패면
owner를 유지하고 실패 감사를 별도 commit한다. 로봇·출입증 이력은 삭제하지 않는다.

출입증은 **그대로 §13.7**로 받는다. 슬롯 UUID의 서버/에이전트 키를 미리 배포하며, 키가
없는 슬롯은503 PASS_KEY_MISSING이다. 일반 로그인 권한을 넘는 키/claim을 생성하지 않는다.
관리자 인증은 저장소 밖 실행 사용자 소유0600 파일의 최소32자 서비스 키이며, 서버의
`FH_SIM_MANAGER_URL`은127.0.0.1·기본 9430~9449만 허용한다. 환경 proxy는 사용하지 않는다.
관리자도127.0.0.1에만 bind하며 포트를 공유하지 않는다.
카탈로그 `name`은 필수 1~40자, `description`은 선택(기본 빈 문자열)·최대 200자다. 이름 없는 옛 항목은 id로 대체하고 경고 1줄을 남기며 선택·POST는 id를 쓴다.
`FH_SIM_EXTRA_PORTS="8870"`은 관리자·서버의 추가 허용 포트 목록(쉼표 구분)이며 기본 9430~9449는 유지하고 8453·8792는 설정해도 거부한다. 127.0.0.1·사용자/비밀번호 없는 URL·기존 경로 검사는 그대로다.

관리자 내부 API는 `/v1/worlds` GET/POST, `/v1/robots` GET/POST/DELETE다. 서버만 POST에
`SimProvision {world_id,robot_id,owner_id,org_id,agent_token,generation}`을 보낸다. 비밀은 본문/자식
환경에만 있고 응답·URL·감사·공개 카탈로그에 없다. 월드 파일+지도 파일은 저장소 밖
설정의 짝이며 원본 자산을 복사하지 않는다. ROS 도메인93·LOCALHOST만 허용하고61·DDS
override를 거부한다. 제어 평면은 ROS_*·RMW/DDS 환경을 거부하고
FH_SIM_DOMAIN=93 설정에서만 자식 허용 목록 환경을 만든다(자식에 DB/서버키/관리자키/실행flag 미전달).
중계 쓰기 timeout은180초로 native110+30초보다 길고, GET은5초다.
모든 관리자 호출은 조직 쓰기 잠금을 푼 뒤 수행한다. 에이전트 WS 경로는 `/api/v1/agent/ws`만 허용한다.
첫 기동은 같은 PC·127.0.0.1만이며 LAN 폰 측정은 P1-D다. 기본은fake, 시뮬·에이전트 프로세스 생성은 명시 `FH_SIM_RUN=1`일 때만이다.
서비스 startup의 읽기 전용 OS 도구 조회는 fake에서도 수행한다.

기본 상한2·1인1대·월드1개를 가짜 launcher로 검증한다. 원본 native runtime은 고정된
Go2 한 대·절대 토픽/TF라 실제 경로는 **1대만 허용**하고 namespace/tf_prefix가 빈 값이다.
두 번째 실제 로봇은409 SIM_NATIVE_SINGLE_ONLY로 거부하며, 다중 로봇 격리 통과를 주장하지
않는다(4단계). 첫 기동은 [기동 계획](../../apps/simmgr/FIRST-LAUNCH.md)의 별도 승인 대상이다.

슬롯 세대의 정본은 서버 DB 하나다. 취득은0014의 `sim_generation`(0부터 단조 증가)을
조직 잠금 안에서 올리고 `sim_state=STARTING→ACTIVE→STOPPING→IDLE`로 관리한다.
STARTING/STOPPING 재POST는 같은 담당자도 거부한다. **DELETE는 STARTING·STOPPING에서도**
기존 `O_OWN` 권한으로 허용한다. IDLE 해제 뒤 owner가 없는 슬롯에 대한 이전 담당자의
반복 DELETE는 기존 권한 판정 그대로이며, 새 POST 취득은 기존 `O`를 사용한다.
첫204 응답이 유실되면 재시도는403일 수 있다. 목록의 현재 로봇 부재와 재취득201을
함께 확인하며, 빈 목록만으로 DB IDLE이라고 단정하지 않는다.

관리자는 받은 세대를 로봇과 함께 보관한다. 슬롯별 DELETE 최대 세대는 제거 확인 세대로
메모리에만 보관하며(로봇이 없어도 기록), 그 이하 POST는 잠금 안에서 생성 전에 409
SIM_GENERATION_STALE로 거부한다. 이 코드는 확실한 시작 전 거부 목록에 넣지 않는다.
별도 영속 세대는 없으며 재시작하면 제거 확인 세대도 비워진다. 관리자 POST는 자동 재전송하지
않는다. 서버 commit 뒤 아직 송신하지 않은 첫 전달은 관리자 재시작을 넘을 수 있으므로,
성공·불확실 결과 모두 서버 최종 확인과 보상을 거친다. 새 관리자의 부재 관문만으로 이
첫 전달을 배제하지 않는다.
관리자 DELETE 본문은 `SimRemove {generation}`이며 자기 잠금 안에서 다음처럼 처리한다.

- 로봇이 있으면 같은 세대일 때만 STOP·정리하고, 다른 세대면409 SIM_GENERATION_MISMATCH다.
- 로봇이 없으면 기대 세대와 무관하게200이며, 세대 취소 영수증을 남겨 늦은 POST를 막는다.
  응답 `SimRemoval`은 `manager_instance_id` UUID·`absent`·`startup_clean`을 싣는다.
- 서비스 시작 전 fake/native 모두 기존 isolation preflight(93/DDS 부재)와 남은
  `fh-rb-sim-*.service`/`fh-simmgr-agent-*.service` user unit 부재 검사를 통과한다.
  fake의 자원 경고는 서비스 시작만 허용하며 `startup_clean=false`로 복구 증명이 되지 않는다.
  user bus 조회 실패도 시작 거부다. 검사는 읽기만 하고 프로세스/unit을 정리하지 않는다.
  61은 startup에서 기록만 하며 거부 조건이 아니다. world 전후 61 불변 비교는 기존대로다.

0016의 `robots.sim_manager_instance_id`에 예약 전 카탈로그에서 받은 관리자 UUID를
저장한다. POST의 첫 전달·재시작·최종 확인·보상·SIM_GENERATION_STALE 규칙은 그대로다.
같은 관리자의 DELETE 취소 영수증은 기존처럼 늦은 POST를 막는다. 다른 관리자가 모르는
슬롯은 **기록된 UUID와 다른 새 UUID + 시작 시 unit 0·domain93/DDS 0·자원 통과 +
해당 슬롯 부재 + 이후 관리자 실패/종료 없음**을 모두 확인해야 IDLE로 해제한다.
응답 손상·증명 누락·기록 없는 레거시 슬롯은 `503 SIM_RECOVERY_UNPROVEN`으로 보존한다.

목록 `SimRobotList.cleanup`은 DB에는 소유가 있으나 관리자 목록에서 같은 owner·generation을
확인할 수 없는 슬롯(`robot_id,owner_id,generation,can_recover`)이다. 관리자 꺼짐·응답 오류에도
현재 권한 범위의 DB 정리 대상을 반환하며 목록 조회 자체는 슬롯을 해제하지 않는다.
앱은 내 슬롯에 «이전 시뮬이 정리되지 않았습니다 — 정리»와 항상 누를 수 있는 정리 버튼을
보인다. 연결 주소를 만들거나 출입증을 발급받지 않는다. 기존 관리자 UUID 기록이 없으면
«이 시뮬 자리는 자동 정리할 수 없습니다 — 관리자에게 문의하세요.»도 표시한다.
성공한 복구 감사는 기존 SIM_ROBOT_REMOVED 한 건에 세대·새 관리자 UUID·recovered_absent를 담는다.

서버는 원격 DELETE 뒤 조직 잠금 아래 **세대와 STOPPING을 모두** 다시 확인한 뒤만
재회수·담당자 해제·hash 교체·REMOVED 감사를 수행한다. 같은 세대의 이중 DELETE도
완료된 IDLE을 다시 바꾸지 않는다. 다른 세대면 아무것도 변경하지 않고409를 보낸다.
같은 담당자의 재취득도 다른 세대이며 이전 DELETE가 새 로봇·출입증·owner·키를 바꾸지 않는다.
원격 호출 동안 조직 쓰기 잠금은 유지하지 않는다.

시작 전 확실한 거부는 다음 **(HTTP status, code) 고정 목록만** 인정한다. 같은 요청의
완료 처리에서 세대와 STARTING을 다시 확인하고, 중간 발급 출입증 회수·hash 교체·owner
해제·IDLE·START_REJECTED를 commit한다. 목록 밖 코드·status 조합·본문 파싱 실패는 불확실로
남겨 STARTING DELETE로 복구한다. 기존 로봇이 있을 수 있는 SIM_SLOT_BUSY는 목록에 없다.

| HTTP | 시작 전 거부 코드 |
|---|---|
|400|SIM_VALIDATION, SIM_IDENTITY_INVALID, SIM_CREDENTIAL_INVALID|
|404|SIM_WORLD_NOT_FOUND, SIM_SLOT_NOT_FOUND|
|409|SIM_WORLD_BUSY, SIM_OWNER_LIMIT, SIM_NATIVE_SINGLE_ONLY, SIM_ROBOT_LIMIT|

- `SIM_ROBOT_START_REJECTED`: 위 목록의 확실한 시작 전 거부로 같은 세대 예약을 즉시 해제했다.
- `SIM_ROBOT_REMOVE_FAILED`: 관리자/relay가 정리 요청을 실패/거부했다(관리자가 먼저 세대 불일치를 거부한 경우 포함). owner/예약을 보존한다.
- `SIM_ROBOT_REMOVE_STALE`: 관리자는 성공했지만 서버 완료 검사에서 세대 또는 STOPPING이 바뀌었다. 현재 로봇/예약/hash/출입증은 바꾸지 않는다.

관리자 POST의 확실한 거부 목록 밖 결과는 **성공·불확실 모두** 조직 잠금 안에서 DB 세대와
STARTING을 최종 확인한다. 둘이 맞으면 성공은 ACTIVE, 불확실은 STARTING 유지다.
맞지 않으면 commit으로 잠금을 푼 뒤 원래 세대의 관리자 DELETE를 **1회** 보상 시도한다.
현재 DB 슬롯/출입증/owner/hash는 바꾸지 않는다. 응답은 원래 불확실 오류(예 503), 성공
응답의 뒤늦은 불일치는409다. `SIM_ROBOT_START_STALE` 감사 1건에 세대와 보상 결과
(제거/이미 없음 또는 실패코드)를 기록한다. 관리자 STALE 409는 생성되지 않았으므로 보상
DELETE 없이 같은 감사 1건에 `compensation=NOT_CREATED`를 남긴다. HTTP 프로토콜 예외
(IncompleteRead·BadStatusLine 등)도 RelayError로 감싼 불확실 결과이며 자동 재전송하지 않는다.

첫 전달·응답 유실에 보상 실패까지 겹치면 runtime이 남을 수 있다. 서버 token hash는 이미
교체되어 옛 에이전트는 서버에 붙지 못하지만, 이 사실을 STOP0 확인이나 폰 출입증의 즉시
offline 무효화로 보지 않는다(§13.7 한계 유지). world와 agent unit은 각각
**RuntimeMaxSec=240**의 자동 종료 대상이다(정지 grace는 world 45초·agent 15초 별도이며 실제
종료/고아·STOP0는 아직 미검증). 다음 취득이 SIM_SLOT_BUSY(불확실)로 막히면 자동 반복하지
않고 FIRST-LAUNCH 복구 1·2단계에서 자기 runtime 정리·부재 관문·새 episode를 확인한 뒤
기존 DELETE 복구를 따른다. 보상 실패로 현재 DB를 덮거나 새 인스턴스 epoch를 도입하지 않는다.

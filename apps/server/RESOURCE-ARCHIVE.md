# 지도·시나리오 삭제와 기록 보존

삭제는 기본 목록과 새 선택에서 숨기는 동작이다. 장소·건물·층은 빈 자료까지
모두 `archived_at`을 설정하며, 지도 판·시나리오 판·실행·사진은 삭제하지 않는다.
인증과 기존 `O` 정책(ORG_ADMIN·OPERATOR)을 유지한다.

| API | 기본 동작 | 보관 자료 조회 |
|---|---|---|
| DELETE sites / buildings / floors | 204, 행 보존·`archived_at` 설정, 반복 요청 204 | `…_DELETED` 사건 1회 |
| GET sites | 보관 장소·건물·층 제외 | `archived=true` 포함, 각 항목 `archived_at` |
| GET floors/{id}/map-versions | 보관 층이면 빈 목록 | `archived=true` 판 목록 유지 |
| DELETE scenarios/{id} | 204, 기존 보관 처리와 사건 유지 | 고정 판·직접 조회 유지 |
| GET scenarios | 보관 시나리오 또는 보관 층을 쓰는 최신 판 제외 | 기존 `archived=true`로 모두 포함 |
| GET assignments | 보관 시나리오·층을 쓰는 고정 판 배정 제외 | `archived=true`로 해제·거절 이력도 조회 |
| POST scenarios / preview | 보관 층 선택 404 | 직접 시나리오 GET은 재검증하지 않음 |
| POST assignments · GET agent/scenarios | 보관 층·시나리오 신규 사용 거부 | 과거 사건·사진·지도 이미지 조회 유지 |
| POST map-versions / rollback, PATCH hierarchy, POST children | 보관 대상 409 RESOURCE_ARCHIVED | 기존 ID로 지도 판·이미지 GET 200 |
| GET simulation/worlds, POST simulation/robots | 보관 층을 포함한 등록 월드 제외·신규 시작 409 | 기존 정리 API 유지 |

층 삭제의 409 RESOURCE_IN_USE 조건은 보관되지 않은 로봇의 `last_floor_id`,
ACTIVE/PENDING 배정, 종료되지 않은 실행(QUEUED/PREPARING/MOVING/RUNNING/
AT_WAYPOINT/PERFORMING/WAIT_CONFIRM/PAUSED), 해당 월드의 IDLE 이외 시뮬 슬롯이다.
실행은 현재 층뿐 아니라 고정 시나리오 판의 모든 층을 확인한다.
시나리오 삭제도 모든 과거 판을 대상으로 ACTIVE/PENDING 배정과 종료되지 않은 실행을 확인한다.
건물·장소는 살아 있는 하위가 하나라도 있으면 409이며, 모두 숨긴 후에는 삭제할 수 있다.
지도 판이 없는 빈 층도 같은 보관 처리를 택해 외래 키와 삭제 의미를 일관되게 유지했다.

마이그레이션 `0021`은 sites/buildings/floors에 nullable `archived_at`, robots에
nullable `sim_world_id`를 추가한다. 기존 자료는 보관하지 않으며 신규 시뮬 시작 때 월드 키를
보관한다. 기존 비-IDLE 시뮬 슬롯의 월드가 NULL이면 모든 시뮬 등록 층 삭제를 보수적으로
막으며, 기존 세션 정리 흐름에서 IDLE이 되면 해제한다. 삭제 요청은 관리자나 원격 DB에 접속하지 않는다.

되돌림은 기능 커밋을 revert하고 스키마는 유지한다. 예전 코드는 보관 표시를 모르므로
보관 자료가 다시 나타날 수 있다. 숨김을 유지해야 하면 먼저 전진 수정한다.
0021 downgrade는 보관 행이 있으면 실패한다. 보관 항목을 별도 승인된 절차로 대조·복구한
뒤에만 downgrade하며 지도 판·실행·사진 삭제로 제약을 우회하지 않는다.

OpenAPI에는 새 `archived` 쿼리와 보관 시각 응답이 반영된다. JSON Schema·TS 생성물의
정본은 `apps/contracts/models.py`이며 `generate.py`로 갱신한다.

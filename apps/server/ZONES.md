# 구역 API · 화면/브라우저 시뮬 인계

정본은 `apps/contracts/models.py`와 생성 `apps/contracts/ts/index.ts`다.
이 문서는 서버·계약 구현 브랜치의 인계이며 실제 브라우저/실기 주행 검증이 아니다.

## 속도

`MapZone`의 기존 필드에 `max_speed_mps?: number | null`을 추가한다.
SLOW에만 0.3~1.5 m/s의 유한한 숫자를 허용한다. 옛 자료의 미지정/null은 값 없음이다.
서버는 기본값을 채우지 않는다. 화면의 새 구역 기본 제안은 0.3이다.
NO_GO에는 키 자체를 보내지 않는다(null도 거절). 이 범위의 근거는 기존
`apps/agent/foothold_agent/safety/core.py`의 phone 0.3~1.5 m/s 범위다.
이 PR은 해당 장치·조종 속도나 제한 코드를 변경하지 않는다.

## 자기 격자의 구역 칸

`GET /api/v1/map-versions/{id}/zone-grid?cursor=0&limit=20000`

같은 조직의 로그인 사용자(총괄·운영자)가 읽는다. 다른 조직/없는 판은 404.
응답: `{format_version:1,map_version_id,origin:[x,y,yaw],resolution,width,height,
row_order:"TOP_TO_BOTTOM",cursor,cells:[{index,no_go,slow,max_speed_mps}],next_cursor}`.
구역이 닿은 칸만 보내며 index 오름차순이다. 생략된 칸은 금지 아님·감속 아님·상한 없음이다.
`cursor`는 희소 목록 안의 위치다(index 아님). `next_cursor=null`이면 끝이다.
기본/최대 limit=20000, 음수 cursor·범위 밖 limit는 400이다.
`row=floor(index/width)`, `col=index%width`; 0행은 이미지 위쪽이다.
칸 중심의 지도 좌표는 원점 yaw로 회전하기 전
`((col+.5)*resolution,(height-row-.5)*resolution)`이며 XY 원점에 더한다.
HUMAN 10cm·SIMULATION 5cm 각 판의 해상도/원점/치수를 그대로 쓴다.

닫힌 다각형과 닫힌 칸이 변·모서리 한 점에서라도 닿으면 적용한다.
원점 회전 후 정수 경계의 부동소수 오차는 1e-9칸 이내에서 경계로 맞춘다.
NO_GO가 우선이며 금지 칸의 max_speed_mps는 null이다. 겹친 SLOW는 지정된 값의 최솟값이다.
`slow=true,max_speed_mps=null`은 속도 미지정 감속 구역이다(임의 기본 속도 생성 금지).
몸체 반경/여유는 포함하지 않는다. 경로 찾기·몸체 여유·손 조종 집행은 소비자가 적용한다.
서버 계산은 `fh_server/zones.py` 한 곳이다. 화면 selftest도 합성 정답
`tests/fixtures/zone-grid-v1.json`을 그대로 읽는다(경계·모서리·겹침·행순서·회전·가는 구역).

## 정확한 쌍둥이 찾기

`GET /api/v1/map-versions/{HUMAN id}/simulation-twin`

응답 `{map_version_id,simulation_map_version_id,simulation_floor_id,terrain_id}`.
해당 HUMAN 판에 고정된 첫 번째 지형 raster(terrain_version=1)를 반환한다.
옛 HUMAN UUID를 최신 UUID로 바꾸지 않는다. 연결 없음은 404, 손상된 증명은 422다.
브라우저는 이 simulation_map_version_id로 zone-grid를 읽는다.
브라우저에 넣을 지형 spec도 `GET /api/v1/map-versions/{simulation_map_version_id}`의
고정 `terrain_spec`을 쓴다. 같은 terrain_id의 최신 Terrain.spec로 몰래 바꾸면
선택한 raster와 물체가 달라질 수 있다. 다른 지형 수정 판은 그 판 UUID를 명시한다.
이 API는 조직 사용자 인증만 사용하며 로봇 연결·실행·로그인은 새로 하지 않는다.
선택한 다른 불변 지형 판은 기존 agent API의 simulation_map_version_id로 지정하며
해당 판의 zone-grid를 읽는다. 기존 실행 증명과 SIMULATION 출처 검사는 유지한다.

## 저장 전 시나리오 겹침 검사

`POST /api/v1/floors/{id}/zone-overlaps`, 본문 `{features:MapFeatures}`.
응답 `{scenarios:[{scenario_id,scenario_name,hits:[{kind:"POINT"|"SEGMENT",element,zone_id}]}]}`.
살아 있는 시나리오의 최신 저장 판만 검사하며 저장하지 않는다.
POINT는 지점·GO_TO 종료 지점·경로의 연결점이 NO_GO 내부/경계인 경우다.
SEGMENT는 같은 층의 연속 지점 또는 연결점 접근/이탈 직선이 NO_GO와 닿는 경우다.
RETURN_TO_START의 마지막→처음도 포함한다. 층간 공중 직선은 만들지 않는다.
`element`는 `waypoints.0`, `finish.target`, `waypoints.0->waypoints.1`,
또는 `waypoints.0->waypoints.1.via.0:<연결점 id>` 형태다.
이 검사는 지도 저장을 차단하지 않는다. 화면이 겹침을 보여 주고
«아니요»면 편집 유지, «예»면 저장 후 해당 시나리오 수정 화면으로 이동한다.

## 최신 지도 적용

Scenario 목록/상세의 계산 필드:
`map_update:{status:"CURRENT"|"AUTO_APPLICABLE"|"NEEDS_EDIT",reasons:[{element,reason}],map_version_ids:[UUID]}`.
CURRENT=이미 최신, AUTO_APPLICABLE=같은 그림에서 구역·지점만 변경되어 적용 가능,
NEEDS_EDIT=그림/격자 변경 또는 NO_GO 안의 지점·연결점 등 확인 필요.
직선만 금지 구역을 지나는 경우는 자동 적용 가능(브라우저 길 찾기가 돌아간다).

`POST /api/v1/scenarios/{id}/apply-latest-map` (본문 없음, 기존 O 쓰기 권한).
응답 Scenario+ETag. Scenario→정렬된 Floor 잠금 후 한 건씩 새 불변 판을 만든다.
이미 최신이면 같은 판을 반환한다. 수정 필요면 409 `MAP_UPDATE_REQUIRED`,
error.detail.map_update에 원인을 담는다. 단순 GET/preview/agent GET에서는 새 판을 만들지 않는다.
성공한 응답 number를 다음 새 시뮬 시작에 명시한다.
옛 지도 판으로 새 시작을 요청하면 거절하며 서버가 조용히 바꾸지 않는다.
진행 중·일시정지/재개·실행 기록은 원래 고정 판을 보존한다.


## 배정·승인 이력 보존

migration 0029는 불변 ScenarioVersion에 nullable `auto_map_from_number` 한 칸을 추가한다.
같은 시나리오의 더 작은 판 번호만 참조할 수 있다. 기존 판은 null이고 수정하지 않는다.
자동 지도 적용의 새 판에서만 출처 판 번호를 적으며, 사람이 저장한 판은 null이다.
배정의 scenario_version_id, 승인 target/base와 원래 판 번호를 바꾸지 않는다.
최신 판까지 끊기지 않는 자동 갱신 계보가 있으면 배정 응답/승인 preview에
선택 계산 필드 `effective_scenario_version`을 추가한다(원래 `scenario_version`은 보존).
새 실행은 이 판을 명시적으로 사용하며 원래 옛 지도 판으로 시작할 수 없다.
승인 결정은 원래 판을 기록하면서 effective_scenario_version을 별도 사건 필드로 남기고,
그 적용 판에 대해 기존 조직·담당·보관·최신 지도·SIM 출처 검사를 그대로 한다.
이미 같은 자동 적용 판으로 이어진 ACTIVE/PENDING 배정의 중복 생성은 409다.
수동 시나리오 수정은 계보를 끊으며 기존 규칙을 따른다. 이미 달리는 Run 참조는 바꾸지 않는다.
자동 갱신 사건 SCENARIO_VERSION_CREATED.data에는 reason=«지도 구역 변경으로 자동 갱신»,
auto_map_from_number와 assignment_policy=preserve_original_reference_follow_auto_lineage를 남긴다.
이 방식은 역순 Assignment/Approval 잠금을 새로 잡거나 이력 값을 덮지 않는다.

자동 적용 가능한 지도 저장 뒤 아직 명시 갱신을 확정하기 전에 대기 승인을 누르면
409 MAP_UPDATE_REQUIRED로 적용 경로를 안내하고 승인·배정은 PENDING으로 보존한다.
별도 apply-latest-map 성공 뒤 기존 요청을 다시 승인한다. 승인 API 자체는 시나리오 판을 만들지 않는다.
그림/격자가 다르거나 지점이 금지 구역 안이거나 담당·보관·대상이 바뀐 요청은 기존 STALE 규칙이다.
수동 시나리오 수정으로 끊어진 계보에도 이 보존 예외를 적용하지 않는다.
0029 downgrade는 자동 갱신 계보가 하나라도 있으면 이력 백업 없이 컬럼을 지우지 못하도록 거절한다.

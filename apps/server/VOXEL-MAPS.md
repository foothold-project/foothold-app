# 점 지도 파일 → 실기 지도와 시뮬 지형

이 경로는 완료된 SLAM 결과를 받는다. 로봇 연결·실시간 누적·SLAM 수행·시뮬 실행은 하지 않는다.
`apps/contracts/models.py`와 생성된 `ts/index.ts`가 응답의 정본이다. DB migration은 없다.

## 올리기

`POST /api/v1/floors/{floor_id}/voxel-maps?name=…&format=pcd|ply&base_version_id=…`

- 기존 로그인/CSRF 적용, 총괄 권한. REAL 장소의 HUMAN 층만 허용한다.
- 본문은 파일 바이트 하나(`application/octet-stream`). 파일 이름이나 로컬 경로를 보내지 않는다.
- 새 층의 `base_version_id`는 생략한다. 기존 지도 교체는 읽은 승인 판 UUID를 보낸다. 바뀌었으면 409.
- 상한: 50 MiB, 500만 점, 10 cm 칸 50만 개, 좌표 ±10,000 m. 수신 시간 60초.
- PCD ASCII/little-endian binary와 PLY ASCII/little-/big-endian binary XYZ를 읽는다.
  추가 scalar 속성은 건너뛴다. PCD compressed·PLY 면/list는 지원하지 않는다.
- 잘못된 파일은 422 `INVALID_POINT_CLOUD`, 바이트 상한은 413, 처리 중에는 503.
  URL/query의 형식 오류는 기존 서버 공통 규칙대로 400이다.
- 한 프로세스에 한 파일만 수신/변환한다. 변환은 이벤트 루프·DB 트랜잭션 밖에서 한다.
  저장 직전 로그인/조직/권한을 다시 확인하고 지도·지형을 한 트랜잭션으로 저장한다.

응답 `VoxelMapImport`는 `{map, terrain, voxels}`다. `map`은 HUMAN 승인 지도 판이고
`terrain`은 기존 지형 저장소의 수정 가능한 Terrain이다. 원본 파일은 서버에 보관만 하며
화면용 자료는 `voxels`와 아래 읽기 경로로 준다. 일반 지도 판·목록에도 선택 필드
`voxel_map: VoxelMapSummary`가 있어 3D 보기와 연결 지형 입구를 표시할 수 있다.

## 좌표와 근사 규칙

- 좌표를 축 회전 없이 평행 이동한다. 원본 XYZ + `source_translation` = 지도/지형 XYZ.
  원본 점의 10 cm 격자 경계와 지형 중심을 맞추며 Z=0은 자동 추정한 바닥이다.
- 바닥은 가장 많은 점을 가진 수평 띠의 20% 이상 점이 있는 띠 중 가장 낮은 10 cm 띠다.
  이는 휴리스틱이며 `estimated_floor_z`는 원본 좌표의 바닥 높이다.
- 2D는 10 cm 해상도, 바닥+0.1~0.6 m에 점 칸이 있으면 막힘(0),
  바닥 칸만 있으면 빈 곳(254), 나머지는 모름(205)이다. PNG+ROS YAML로 저장한다.
- 지도/지형 바닥은 축마다 4~30 m다. 넘으면 가운데 30 m를 **두 결과에 같이** 적용하며
  잘린 이유를 `warnings`에 담는다. 원본 파일은 자르지 않는다.
- 지형 상자는 2D에서 막힌 XY 칸에만 만든다. 추정 바닥 면을 기준으로 +0.1 m 칸부터
  위로 빈 칸 없이 이어진 칸의 윗면까지 만들고 높이는 1 m로 자른다. 첫 틈 뒤의
  천장·선반·탁자 윗면은 지형 높이에 포함하지 않는다. 바닥 바로 위 칸이 없으면 상자를 만들지 않는다.
- 같은 높이의 이웃 막힘 칸을 직사각형으로 합친다. 빈 곳·모름 칸으로 넓히지 않으며,
  그래도 60개를 넘으면 지도 아래쪽부터 같은 행의 왼쪽 순서로 앞 60개만 만든다.
  빠진 물체와 연결 높이 자르기는 `warnings`에 담고 지형 수정하기에서 보완한다.
  따라서 2D 빈 곳에는 지형 상자가 생기지 않고, 지형 상자 칸은 2D 막힘 칸의 부분집합이다.
- 관측된 바닥에서 물체·가장자리와 0.45 m 떨어진 시작 위치를 찾는다.
  못 찾으면 422로 전체 저장을 취소한다. 자동 근사는 지형 수정 화면에서 다듬는다.
- 지형 지도는 기존 5 cm raster를 사용하지만 원점·축·바닥 크기는 HUMAN 지도와 같다.
  연결된 지형의 바닥 크기 변경은 422다. 물체·시작 위치·이름은 기존 지형 저장으로 수정한다.

## 3D 읽기 / 화면 인계

`GET /api/v1/map-versions/{id}/voxels?limit=10000&cursor=0`

같은 조직 로그인 사용자는 읽을 수 있다. 한 묶음은 최대 20,000칸, cursor는 0부터의 정수 위치다.
응답 `{summary, cells, next_cursor, max_page_size}`에서 `next_cursor=null`이면 끝이다.
칸이 없는 지도는 404, 잘못된 limit/cursor는 400이다. 원본 전체 점 배열을 반환하지 않는다.

`cells`는 `[ix, iy, iz]` 정수 배열이다. 칸 중심은
`summary.origin + (index + .5) * summary.voxel_size`이고 한 변은 0.1 m다.
XY는 지도와 같으며 origin의 Z는 0이다. 높이 색은 이 Z를 사용하면 된다.
음수 Z 칸도 보관한다. `summary.cells_sha256`은 전체 칸을 순서대로 little-endian signed
int32 XYZ로 이은 바이트의 SHA256이고 `source_sha256`은 보관 원본의 SHA256이다.
`voxel_count`, `point_count`, `terrain_id`, `source_translation`, `warnings`도 summary에 있다.
파일 주소나 raw 원본 읽기 API는 제공하지 않는다.

## 같은 시나리오와 실행 증명

시나리오 원본의 HUMAN floor/map UUID는 바꾸지 않는다. 시뮬 에이전트용 고정 계획을 만들 때만
서버의 불변 Upload 메타데이터 `voxel_twin`(원본 판 ID·그림 SHA256·원점·치수·해상도·지형 ID)을
원본 판과 대조해 쌍둥이 SIMULATION floor/map UUID로 치환한다. x/y/yaw와 고정 임무는 그대로다.
같은 HUMAN 층에서 같은 Upload·그림·원점·치수·해상도·`features.edits`를 유지하고
구역·지점·연결점만 저장하면, `maps.py` save/rollback은 새 HUMAN 판과 그 판 전용의
불변 SIMULATION 판·Upload 메타데이터를 같은 트랜잭션에 추가한다. SIMULATION 판은
기존 PNG/PGM 파일을 공유하고 `features`를 HUMAN 판에서 좌표 변환 없이 복사한다.
`voxel_twin.map_version_id`는 새 HUMAN 판을 정확히 가리킨다. 기존 판·Upload·파일은 수정하지 않는다.
지형 spec·지형 저장 번호는 바뀌지 않는다. 이후 지형 저장도 연결된 HUMAN 판의 features를 복사한다.

공개 `MapVersion.voxel_map.map_version_id`와 voxel 읽기의 `summary.map_version_id`는
연결된 새 HUMAN 판 UUID를 반환한다. `terrain_id`·원본/칸 SHA256·칸 배열은 그대로다.
새 파일(같은 PNG 바이트라도 다른 Upload), 다른 층, WALL/ERASE 편집에는 연결을 넘기지 않는다.
3D 원본 칸이 있는 비연결 판은 원래 summary UUID를 유지하므로 `voxel_map.map_version_id !== id`다.
기존에 연결 없이 저장됐던 과거 판을 자동 수정하거나 소급 연결하지 않는다. 그 판을 새로
저장하거나 되돌리면 위 조건을 확인해 새 판의 연결을 만든다.

기본 선택은 **해당 HUMAN 판과 쌍을 이루는 첫 번째 지형 raster의 불변 판**이다.
구역 저장 시 이미 존재하는 각 지형 저장 번호마다 같은 raster·새 구역의 쌍둥이를 만든다.
지형을 수정한 경우에도 기본 raster를 최신으로 바꾸지 않는다. 수정한 지형 판을 명시하려면 기존 agent scenario GET에
`simulation_map_version_id=<고정 지형 지도 판 UUID>`를 추가한다. RUN_STARTED에서도 보고한
고정 판을 재검증한다. 승인된 최신 판으로 조용히 바꾸지 않는다.
이전 HUMAN 판에 묶인 시뮬 UUID를 새 HUMAN 판 실행에 명시하면 422다.
구역 저장 이후의 UUID를 다시 읽어 명시해야 한다. 쌍둥이의 features가 원본과 달라도 422다.

쌍둥이는 canonical PGM을 저장하고 `connected_gt`에 정확한 PGM/PNG SHA256과
`world_id=custom/<terrain_id>`, `ros_floor_id=f1`을 고정한다. 로봇의 신뢰된 서버
`sim_world_id`도 이 world와 일치해야 한다. 기존 `runs.map_proof`는 변경하지 않았고
SIMULATION 출처·원본 PGM·조직·좌표·치수·world/floor 검사를 그대로 통과해야 한다.
에이전트의 로컬 실제 파일·live world/episode 검사는 여전히 필요하다.

사람이 만든 시뮬 전용 시나리오는 기존 실기 fail-closed 경로(422 PRECHECK_FAILED, 한국어 이유)로
차단한다. 실기의 기존 배정·실행 전 증명 미구현 제한도 유지한다.

이번 검증은 합성 파일·격리 DB의 서버 계약/기록 시험이다. 실제 custom world 시작,
브라우저 실행기/에이전트가 이 world identity와 파일을 받는 연결, L1/L2 SLAM,
실기 실행은 확인하지 않았다. 기존 launcher가 허용하는 world 목록을 확장하지 않는다.

## 구역 집행의 현재 범위와 화면 인계

- 실기·시뮬 지도 모두 `POST /api/v1/scenarios/preview`와 시나리오 저장의 같은
  `missions.preview`를 쓴다. `NO_GO` 다각형 내부와 경계에 있는 목표점·연결점은 거절한다.
  오목 다각형은 ray crossing으로 판정한다. 선분이 구역을 통과하는지는 검사하지 않는다.
- `MapZone`은 `{id,type,name,polygon}`이며 `SLOW`에 속도 필드는 없다. 현재 서버·에이전트에는
  이 구역에 따른 주행 중 감속/회피 집행이 없다. 이를 추가하거나 속도를 추정하지 않았다.
  실기 실행은 기존 실행 전 증명 미구현으로 계속 fail-closed다.
- 서버 에이전트 계획은 각 지점과 `map_proofs`에 **동일 features를 보관한 불변 쌍둥이 UUID**를
  고정한다. features 자체를 계획 응답에 중복 삽입하거나 `RunMapProof` 계약을 바꾸지는 않는다.
- 로그인한 브라우저는 기존 `GET /api/v1/map-versions/{HUMAN UUID}`의
  `features.zones`, `features.waypoints`, `features.connectors`를 읽으면 된다.
  같은 조직 읽기 권한이 필요하며 새 계약 필드는 없다. x/y/yaw와 polygon 좌표는 시뮬과 같다.
  최신 지형 기준 읽기는 `GET /api/v1/terrains/{terrain_id}` → `map_version_id` →
  `GET /api/v1/map-versions/{SIMULATION UUID}`이며 여기에도 같은 features가 있다.
  고정 시나리오에는 그 시나리오의 판 UUID를 사용하고 최신 판으로 조용히 바꾸지 않는다.
- 현재 `mobile/sim/main.js`의 custom terrain은 localStorage의 지형을 읽고, `?bt=`는
  `fh.btMission.<id>`의 지점/나무를 읽는다. 위 서버 features를 가져오거나 구역을 집행하지 않는다.
  브라우저에서 읽기·표시·주행 정책을 적용하는 것은 화면 작업 범위다.

## 기존 시나리오·배정의 고정과 남은 결정

시나리오 판은 지도 판 UUID와 임무 판 번호를 저장하고, 배정은 ScenarioVersion UUID에 묶인다.
지도 저장/되돌리기만으로 기존 시나리오·배정·고정 임무·실행 기록을 최신으로 바꾸지 않는다.
따라서 기존 시나리오 실행은 이전 구역을 유지한다. 새 구역을 적용하려면 최신 지도에서
시나리오 새 판을 저장해 동일 preview를 거치고 기존 배정·승인 절차를 다시 밟는 것이 작은 제안이다.
자동 재바인딩·자동 재승인은 구현하지 않았다. 이 사용자 흐름과 감속 값·경로 통과/주행 중 구역
집행 정책은 제품 결정이 필요하다. 이번 변경만으로 실기·브라우저 주행 집행을 보장하지 않는다.

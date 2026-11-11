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
- 지형은 같은 XY 칸의 최고 높이를 상자로 만든다. 높이는 1 m로 자른다.
  같은 높이 이웃 칸을 직사각형으로 합치고, 60개를 넘으면 .2/.4/.8/… m로
  보수적으로 묶어 최고 높이 상자를 만든다. 해상도 저하와 높이 자르기는 `warnings`에 담는다.
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
다른 판에서 원본 Upload를 재사용해도 새 판 UUID에는 이 연결을 인정하지 않는다.

기본 선택은 첫 번째 생성 지형 판이다. 수정한 지형 판을 명시하려면 기존 agent scenario GET에
`simulation_map_version_id=<고정 지형 지도 판 UUID>`를 추가한다. RUN_STARTED에서도 보고한
고정 판을 재검증한다. 승인된 최신 판으로 조용히 바꾸지 않는다.

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

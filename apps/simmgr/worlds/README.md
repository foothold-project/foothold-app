# 정적 시뮬 월드 카탈로그

`worlds.json`은 저장소에 포함된 공개 정적 자산의 준비용 카탈로그다. 경로는 이
JSON이 있는 폴더 기준이다. `warehouse/f1`의 SDF·PNG/YAML·층 높이·스폰 좌표를 묶는다.
기존 private `FH_SIM_CATALOG`와 native source의 `worlds.json`을 수정하거나 자동 병합하지
않는다. `launcher.py`의 `v5_single/f1` 허용과 world/gt_map 실경로 대조는 그대로다.

후속 통합에서 private catalog 항목을 만들 때 `world` → `world_file`, `gt_map` →
`map_file`의 실경로와 이름·설명을 사용한다. 지금 fake launcher에 명시 등록할 수 있으나,
native는 `warehouse/f1`을 계속 거부한다. native 스폰·지도 화면 연결은 별도 작업이다. 지도·시나리오는 서버의 명시 관리 명령으로
등록하며, JSON을 추가한 것만으로 실행 가능 또는 자동 등록됐다고 보지 않는다.
기존 v5 자산을 이 폴더로 복사하지 않는다.

## Warehouse

- 출처·권리·변경 내역: [NOTICE](warehouse/NOTICE), [MIT-0 LICENSE](warehouse/LICENSE),
  원본 입력 해시: [sources.json](warehouse/sources.json).
- 원본 branch `ros2`, 고정 commit `ee0af733315e78432408c3cd98d378ecee5f767c`,
  tree `54aaabdafb46087847e20f4929651948e81e7286`.
- 실제 바닥 collision 외곽 약 13.98047 × 20.906665m, 윗면 z≈0.034226m.
  원본 좌표를 그대로 쓴다. 지도는 외곽 여유 포함 **15 × 22m**, 300 × 440px, 0.05m/cell.
- 스폰 `(x,y,yaw)=(0,0,0)`, robot base z=0.434226m. free 셀과 반경 0.4m의 지도 여유를
  오프라인 확인했다. 실제 로봇 높이·접촉·스폰 성공은 확인하지 않았다.
- SDF 1.9, 모든 모델 static. OBJ는 월드 SDF 기준 상대 경로이며 별도 환경 변수나 다운로드가
  없다. Harmonic Physics/UserCommands/SceneBroadcaster/Sensors(ogre2)/Imu 플러그인을 명시한다.
  로봇·센서는 월드에 포함하지 않는다. 텍스처 없이 단색 재질을 사용한다.

## 재생성 (오프라인)

패키지를 설치하지 않는다. 시스템 Python에 이미 있는 numpy/Pillow/trimesh를 사용한다.
원본 다운로드는 이 도구에 포함하지 않는다. 고정 SHA의 필요한 파일을 별도 로컬 폴더에
준비하고 `sources.json`의 Git blob/SHA-256과 대조한 뒤 가져온다. 아래 `SOURCE`는 그 폴더다.

```sh
PYTHONDONTWRITEBYTECODE=1 python3 apps/simmgr/tools/import_warehouse.py \
  SOURCE apps/simmgr/worlds/warehouse
PYTHONDONTWRITEBYTECODE=1 python3 apps/simmgr/tools/collision_map.py \
  apps/simmgr/worlds/warehouse/warehouse.sdf apps/simmgr/worlds/warehouse/maps \
  --floor f1:0.034226 --resolution 0.05 --bounds -7.5 -11 7.5 11
```

`--floor f1:0 --floor f2:3`처럼 층을 반복 지정한다. 모든 층은 같은 bounds/resolution/origin을
쓰며, origin의 셋째 값은 **yaw=0**이다. `floor_z`는 `metadata.json`에 별도로 기록한다.
world SHA-256, collision 의존 파일 SHA-256과 묶음 해시, upstream SHA, 생성기 판·소스 해시,
픽셀 크기·미터 크기·장애물 높이 구간·좌표 변환·층별 PNG 해시를 기록한다.

정적 모델의 중첩 pose/link/collision pose와 양수 mesh scale을 적용한다. geometry는 box와
로컬 OBJ mesh만 지원한다. include·이름 참조 frame·외부 URI·그 밖의 geometry는 오류로
중단한다. COLLADA 입력은 AWS의 Z_UP/triangle/matrix 형식만 변환한다.

## 지도 판정과 한계

- 장애물 구간은 `floor_z + [0.05, 0.60]m`. 삼각형을 높이 구간에서 잘라 격자 사각형과의
  교차를 보수적으로 칠하고, 닫힌 일관된 메쉬 내부도 winding으로 채운다.
- free=254는 명시한 층 높이 ±0.005m의 거의 수평인 상향 지지면이 셀의 네 꼭짓점과 중심에
  모두 있어야 한다. 지지면 없음·구멍·외곽·경사로는 unknown=205로 남긴다. 장애물은 0이다.
  unknown을 free로 바꾸거나 무한 ground plane을 추가하지 않는다.
- 열리거나 winding이 일관되지 않은 메쉬는 높이 구간에 걸친 AABB 전체를 장애물로 잡고
  지지면으로 쓰지 않는다. AWS PalletJack collision이 여기에 해당한다.
- PNG는 월드 +Y를 위로 뒤집어 저장한다. YAML은 trinary, negate=0,
  occupied_thresh=0.65, free_thresh=0.196으로 205를 unknown으로 유지한다.
  셀의 중앙 좌표 변환은 메타에 있다.
- 유한 격자와 다섯 지지점 표본이므로 셀보다 작은 구멍이나 임의 복잡한 메쉬의 완전한
  지지면 합집합을 증명하지 않는다. 바닥의 자동 발견·계단/경사 보행 가능성·로봇 footprint
  팽창·안전 정책·층간 이동·실행 시 좌표 정합은 후속 검증 범위다.

## 시험

합성 월드 한 개의 독립 기대 격자로 두 층·지지면 외곽·높은 메쉬 내부·pose·PNG Y 반전·
YAML yaw·메타 해시·미지원 geometry 오류를 검사한다. API fixture와 분리되어 ROS·서버를
불러오지 않는다.

```sh
# TMPDIR은 현재 worktree 안의 미리 만든 폴더. MemAvailable >= 2.5 GiB일 때만 실행.
PYTHONDONTWRITEBYTECODE=1 TMPDIR="$PWD/tmp/warehouse" \
  python3 -m pytest apps/simmgr/tools/tests -q -p no:cacheprovider
# 기존 읽기 전용 venv의 Python을 FH_PYTHON에 지정한다.
PYTHONDONTWRITEBYTECODE=1 TMPDIR="$PWD/tmp/warehouse" \
  PYTHONPATH="$PWD/apps/simmgr/tools:$PWD/apps/agent:$PWD" FH_TEST_PORT_RANGE=9430:9449 \
  "$FH_PYTHON" -m pytest apps/simmgr/tests -q -p no:cacheprovider
```

Gazebo/ROS/미리보기 서버/실제 슬롯 실행은 이 작업에서 0회다. 생성한 미리보기 그림과
시험 기록은 worktree `runs/`에만 남기며 커밋하지 않는다.

## 지도·시나리오 등록 (ADR-003 ②)

서버의 `python -m apps.server.fh_server.sim_maps --worlds-dir apps/simmgr/worlds
--org-id … --actor-id … --files-root …` 관리 명령을 명시 실행한다(환경 변수
`FH_DATABASE_URL`, 활성 총괄 사용자 ID 필요). 자세한 명령은 서버 README를 따른다.
시작 시 자동 실행은 없으며, private manager catalog·launcher 허용 목록은 바꾸지 않는다.
월드 하나는 지도 트리의 건물 하나, 층은 `floor_id`마다 하나다. PNG/YAML·생성 메타 해시와
좌표를 검증하고 결재 행 없이 승인 판을 만든다. 이미지 SHA가 같으면 중복을 만들지 않고,
바뀌면 새 판을 승인한다. 이미 본 옛 이미지를 다시 입력해도 최신 승인을 되돌리지 않는다.

`warehouse/scenarios.json`의 세 시나리오는 world 좌표(m)이며 모두 f1의 현재 승인 판을
참조한다. 각 지점은 free=254이고 occupied=0/unknown=205 셀의 사각형까지 0.5m 이상
떨어져 있다(지도 외곽도 검사). 지점 하나를 벽에 옮기는 음성 시험을 서버 시험에 포함한다.
이는 지점 여유 검사이며 지점 사이 이동·Nav2 경로·실제 Gazebo 주행 검증은 아니다.
지점 임무는 이름만 있는 표시·기록용 판(`steps=[]`)이다(ADR-003 결정 5).

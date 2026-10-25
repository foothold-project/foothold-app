# 잔해 험지 (`rubble/f1`)

외부 모델·사진·텍스처·다운로드 없이 이 저장소에서 직접 작성한 생성기의 출력이다.
원통·둔덕은 각각 26정점·48삼각형인 작은 닫힌 OBJ이며 충돌·표시에 같은 형상을 쓴다.
상자·판은 SDF 기본 도형이다. OBJ에는 유한한 단위 정점 법선과 면 참조를 넣었고,
native 실행은 기존 #86의 표시 법선 경로도 그대로 거친다.

바닥은 20×20m, 윗면 z=0인 유한 상자다. 시작 `(0,-6,yaw=0)`, base z=0.4m이며
시작점 반경 **2m 안은 비웠다**. 바닥 외 잔해 96개와 바닥 모두 static이다.
넘어지는 잔해·관절·동적 더미 계산은 없다.

| 띠 | 중심 배치 영역 Y(m) | 바닥 위 전체 높이 상한 | 구성 |
|---|---|---|---|
| 쉬움 | -9…-3 | 0.05m | 낮은 상자·판·원통 토막·둔덕 흩뿌림 |
| 보통 | -2…3 | 0.10m | 같은 도형, 일부 판 기울기 5…14°(요구 상한 15°) |
| 어려움 | 4…9 | 0.15m | 두 조각을 쌓은 정적 더미, 전체 높이에 상한 적용 |

난수 씨앗은 `20261025`다. 모든 충돌은 각 띠 안에 들어가며, 띠 사이 가로 길과
중앙 세로 길을 비웠다(시험은 폭 1.6m 이상을 확인). 높이는 기울어진 판의
회전 뒤 전체 외곽을 기준으로 제한한다. 미리 만든 시나리오는 쉬움 띠의 중앙 길
`(0,-8) → (0,-6) → (0,-4)` 순찰 하나이며, 각 지점은 0.5m 지도 여유를 확인한다.
지점 임무는 표시·기록용이다. 경로 계획·주행 성공을 뜻하지 않는다.

**v2 보행 정책은 잔해에서 시험한 적이 없어 넘어질 수 있다.** 실제 Go2 스폰·발 접촉·
보행·Nav2·웹/폰 미리보기 실주행은 미검증이다. 지도 판정은 보행 가능성 인증이 아니다.

## 재생성과 지도·높이

시스템에 이미 있는 numpy/Pillow/trimesh만 사용하며 설치하지 않는다.

```sh
mkdir -p tmp/rubble
if [ "$(awk '/MemAvailable/{print $2}' /proc/meminfo)" -ge 2621440 ]; then
  PYTHONDONTWRITEBYTECODE=1 TMPDIR="$PWD/tmp/rubble" \
    python3 -m apps.simmgr.tools.generate_rubble apps/simmgr/worlds/rubble \
    --catalogue apps/simmgr/worlds/worlds.json
fi
```

기존 `collision_map.py`가 **충돌 형상**에서 400×400px, 0.05m/cell,
origin `[-10,-10,0]`인 PNG/YAML과 SHA metadata를 생성한다. 기본 장애물 높이 구간
`[0.05,0.60]m`를 유지하므로 **5cm 미만의 쉬움 잔해는 2D 지도에서 free일 수 있다**.
이는 Nav2/보행 통과 보장이 아니다. native 준비 때 충돌에서 다시 만든 PNG가 등록
바이트와 같은지 확인하고, 상향 면을 표본화한 실제 높이 `ground.npz`를 episode 안에만
만든다. 평면의 픽셀로 높이를 추측하지 않는다. 생성기·SHA·시작점·띠 높이·통로·
지도 결정성과 native 높이 표본을 오프라인 시험한다.

카탈로그는 `readiness=offline_prepared`다. 사용하려면 관리자가 private 실행 목록에
같은 SDF/YAML 실경로를 명시하고 기존 `sim_maps` 명령으로 서버 지도·시나리오를
등록해야 한다. 이 작업은 운영 목록·DB·미리보기 서비스를 자동 수정하지 않는다.
계약·서버 승인 묶음·manager·native status·agent는 `rubble`의 고정 `f1`을 함께 확인한다.
창고 `f1`과 잔해 `f1`은 월드 ID·승인 PNG/PGM SHA로 구별한다. 웹의 기존 `f1=1층`을 쓴다.

## 격리 Gazebo 확인 (2026-10-25)

ROS domain **94**, 실행마다 다른 `fh-rubble-check-*` GZ_PARTITION을 사용했다.
각 실행은 110초 상한이며 한 번에 하나만 실행했다. 원본 SDF에 임시 시험 구와
고정 카메라만 더하고, 자기 process group만 종료·확인했다. ROS 노드·실기·
domain 61/93·미리보기 서버·운영 포트는 실행 대상에 포함하지 않았다.

| 확인 | 결과 |
|---|---|
| 월드 로드·물리 스텝 | 3회 모두 gz rc=0, 원본 SDF SHA `7646fdd2da1909f6bdc9fb566d88bdc93cb37a647d6f25cbcb80d93032fc0bf7` |
| 마지막 실행 | 6.07초, 전용 partition `fh-rubble-check-20261025-0015` |
| 충돌 접촉 | `contact_probe::body::probe` ↔ `easy_0_0_box_0::body::solid` 관측 |
| 첫 카메라 프레임 | RGB 424×240, 각 채널 ≥245인 흰 픽셀 비율 **0.0%** |
| 종료 | 각 실행의 자기 process group 잔여 0 |

처음 두 실행(6.00초/35.96초)은 접촉 토픽 구독이 달라 접촉 메시지를 얻지 못했다.
첫 실행의 임시 PosePublisher 부착 위치 오류도 수정했다. 마지막 실행은 Gazebo가
발행한 기본 contact 토픽을 구독해 접촉을 확인했다. EGL의 dri2 경고는 있었으나
카메라 프레임을 얻었고 OBJ 법선 오류·흰 화면·비정상 종료는 관측하지 않았다.
이는 로봇 없는 정적 월드·시험 구 접촉·고정 카메라 확인이며 보행 검증은 아니다.
로컬 원시 로그·프레임은 Git 제외 `runs/rubble/`에만 보관한다.

남은 권고: 합친 뒤 배정된 미리보기에서 쉬움 띠부터 낮은 속도로 로봇 보행·넘어짐·
센서·Nav2 경로를 확인한 다음 보통/어려움으로 넓힌다. 임의 경로의 통과 가능성은
별도로 확인한다.

## 오프라인 검증

기준 `origin/dev cc37e33`, Python 3.12의 승인된 기존 venv를 읽기 전용으로 사용했다.
venv에 없는 numpy는 시스템 패키지 경로를 뒤에 추가했다. 설치·venv 변경은 없다.
`PYTHONDONTWRITEBYTECODE=1`, worktree 안 TMPDIR, MemAvailable ≥2.5GiB의 `if` 관문을
사용한다. 시험용 PostgreSQL은 그 TMPDIR의 private Unix socket만 쓴다.

기존 시험 fence는 9430…9449만 허용하므로, **Git 제외 `runs/rubble/sitecustomize.py`
사본만** 9450…9469를 허용하도록 바꾸어 PYTHONPATH 맨 앞에 둔다. 저장소 fence와
다른 worktree·venv는 고치지 않는다. 허용 범위 안의 명시 포트는 다른 포트로
바꾸지 않고, legacy 범위 밖 요청과 :0 예약만 변환한다. 사본의 OS 호출 전 거부 시험에서
8870·9430·9433·8453·8792·5190·5191의 bind/connect 시도를 차단했다.
`FH_PYTHON`과 `FH_VENV_SITE`는 조정이 승인한 기존 Python·site-packages 경로다.

```sh
export PYTHONDONTWRITEBYTECODE=1 TMPDIR="$PWD/tmp/rubble" FH_TEST_PORT_RANGE=9450:9469
export PYTHONPATH="$PWD/runs/rubble:$PWD/apps/simmgr/tools:$PWD/apps/agent:$PWD:$FH_VENV_SITE:/usr/lib/python3/dist-packages"
if [ "$(awk '/MemAvailable/{print $2}' /proc/meminfo)" -ge 2621440 ]; then
  python3 -m pytest apps/simmgr/tools/tests -q -p no:cacheprovider
  "$FH_PYTHON" -m pytest apps/simmgr/tests apps/agent/tests \
    apps/agent/foothold_agent/camera/tests apps/contracts/tests -q -p no:cacheprovider
  "$FH_PYTHON" -m pytest apps/server/tests -q -p no:cacheprovider
  "$FH_PYTHON" apps/contracts/generate.py --check
fi
```

처음 지정된 venv는 없어 조정이 다른 기존 venv를 지정했다. numpy 수집 오류,
새 시험의 DB autoflush 오류, 9430 전용 fence의 시작 경고를 고친 뒤 아래 범위를
검증했다. 중단된 전체 실행을 통과로 세지 않는다. 웹 코드는 바꾸지 않았으며
실폰·실기·미리보기 통합·배포·운영 DB 반영은 실행하지 않았다.

| 범위 | 결과 |
|---|---|
| 도구 전체 (결정성·시작점·띠 높이·지도 포함) | 22 passed |
| simmgr·agent·camera·contracts 전체 | 1490 passed, 1 skipped (64.81초); skip은 opt-in 실제 DDS 시험 |
| 잔해·창고 층 묶음 + 명시 포트 점유 + 로컬 fence 최종 집중 | 16 passed (9.41초) |
| 명시 포트 점유 회귀 + 로컬 fence 재확인 | 2 passed (0.46초) |
| 서버 전체 | 893 passed, 1 failed (1048.31초); 아래 로컬 fence 영향 |
| 계약 생성물 | 168개 일치 |

서버 전체의 유일한 실패는 기존
`test_telemetry_tool_reserves_only_configured_port`였다. 로컬 fence가 점유된 명시
9450 포트를 다른 빈 포트로 바꿔 기대한 예약 실패가 나오지 않았다. 허용 범위 안의
명시 포트를 그대로 두도록 **로컬 사본만** 고친 뒤 해당 시험과 fence 시험은
2 passed로 확인했다. 서버 전체를 수정된 fence로 다시 실행한 결과는 아니며,
전체 결과를 모두 통과로 표시하지 않는다. 기능 코드·시험 기대값은 바꾸지 않았다.

원시 로그는 worktree `runs/rubble/`에 보관하며 커밋하지 않는다. 외부 모델 입력과
운영/미리보기 서비스 재시작은 없다. 다른 모델 검토와 dev 합치기는 조정의 후속 관문이다.

# 붕괴 주택 · 초안

고정 잔해를 Gazebo SDF와 폰·웹 MuJoCo/three.js에 함께 내보낸다. 실로봇·보행 성공·배포 판정은 포함하지 않는다.

10월 29일 v2가 최신 로컬 원본이다(README·검증 기록·previews·수정 시각 확인). 이 판의 시계 방향 길, 원래 조각 1,085개와 타일 150개의 XY, 9단×12.5cm 계단(디딤판30cm·폭1.4m), 약0.8m 더미 높이를 유지한다. 최신판 자체도 높이장과 얕게 변형한 돌을 사용했으므로, 더 오래된 10월 23일 판(10월 28일 수정)의 독립된 돌·판자·콘크리트 표현과 재질 계열을 복원했다.

- 높이장에서 더미를 제거했다. 높이장에는 바닥 위4~8mm 먼지와 현관 연결면만 남는다. 집 바닥·기초의 절대 높이는 흙 요철과 구분한다.
- 큰 조각114개는 회전·기울기가 다른 독립된 볼록 메시이며, 두 층이 겹치고 기대도록 배치했다. 10월29일 더미의 높이 영역을 따른다. 모든 조각은 고정체다.
- 작은 조각1,235개의 원래 XY를 유지하고 밑면을 바닥 위에 올렸다. 시각 메시를 재질별로 묶고, 접촉은95개 보수적 상자로 묶었다. 상자가 작은 돌 사이 빈틈을 메우므로 실제 보이는 돌마다 정확한 접촉면을 제공하지 않는다.
- 집은 원본 CC0 UV와512px 파생 albedo를 사용한다. 돌·콘크리트·목재 색은10월23일 원본 재질의 평균 선형 albedo×SDF tint다. Gazebo와three.js가 같은 색·자산을 사용한다. 광원은 각 엔진의 기존 중성 주광을 사용하므로 그림자와 밝기는 완전히 같지 않다.
- 벽 접촉은 기존127개 열 상자다. 창·가구·지붕의 모든 충돌면을 재현하지 않는다. 접촉348개, 라이다 전용0개로 상한507개 이내다.

## 수치와 지도

5cm 격자의 실제 시각 삼각형 수직 교점으로 다시 측정했다. 벽·지붕은 바닥 높이 통계에서 제외한다.

| 지표 | PR #174 /10월29일 원본 | 이번 판 |
|---|---:|---:|
| 길 위 높이 p5/중앙값/p95 | 2.29/3.00/7.61cm | 0.45/0.75/5.91cm |
| 길 위 최소~최대 | 1.96~7.90cm | 0.40~7.00cm |
| 실내 최대 더미 | 78.6cm | 78.5cm |
| 길 밖15~40cm 면적 비율 | 48.48% | 23.78% |

길과 길 밖 높이가 낮아진 이유는 연속 둔덕을 없애고 개별 조각 사이에 바닥이 드러나게 했기 때문이다. 더미 최고 높이와 동선은 유지했다. 작은 조각의 보수적 상자 때문에 길 위 시각/접촉 높이 차이는 p95 7.10cm·최대7.59cm다. 이 근사는 작은 조각의 비용을 제한하기 위한 것이며 보행 정확도를 보장하지 않는다.

장애물 지도는 집 몸통 높이대와 바닥보다15cm 높은 실제 큰 조각·작은 조각 접촉 상자를5cm 격자로 굽는다. 길 최소90cm 폭 및 기존35cm 사각 여유 폭 시험을 통과했다. `top.png`·`top.json`은 앱과 같은three.js 장면에서 다시 굽는다. 발밑187칸은 실제 MuJoCo 접촉체를 raycast하며, 큰 조각을 제거하면 해당 높이가 내려가는 시험을 포함한다. 집 벽 열 상자 및 작은 돌 접촉 상자 근사는 스캔에도 그대로 반영된다.

## 재생성·검사

원본은 읽기만 한다. GUI·앱 서버·로봇을 실행하지 않는 생성 명령이다.

```bash
python3 -m apps.simmgr.tools.import_house /path/to/debris-sandbox-20261029-v2
FH_SIM_SRC=/path/to/local-sim node mobile/scripts/make-top.mjs collapsed-house-v2
node mobile/scripts/scenario-selftest.mjs
node mobile/scripts/top-fit-selftest.mjs
FH_SIM_SRC=/path/to/local-sim node mobile/scripts/height-scan-selftest.mjs
FH_SIM_SRC=/path/to/local-sim node mobile/scripts/house-look-selftest.mjs
PYTHONPATH=apps/agent:. python3 -m pytest apps/server/tests/test_house_assets.py apps/server/tests/test_sim_maps.py apps/server/tests/test_warehouse_floor.py -q
```

생성 뒤 `worlds.json`의 해당 항목 SHA와 `mapframe.tsx`의 해당 지도 PNG SHA를 갱신한다. 서버 시험은 사설 임시 PostgreSQL·파일 저장소만 사용한다. 시뮬레이션 서버 Gazebo adapter는 기존처럼 `native_supported:false`다.

같은 카메라 세 각도의10월23일 Gazebo·10월29일 Gazebo·새 Gazebo·새three.js 비교, 실행 명령과 검증 로그는 저장소 밖 `runs/house-look/` 보고서에 보관한다. Gazebo는 domain93·고유 partition·headless로만 실행했다. 창고 평지2.8초 회귀는3/3, 이동1.541m·낙상0이었다. 붕괴 주택의 보행 성공을 판단하지 않았다. 실폰 성능·발열·실로봇·운영 서버·APK는 미검증이다.

CC0 출처와 변형은[NOTICE.md](NOTICE.md)에 있다.

자산: Collapsed House by Nate Koenig / OpenRobotics, https://fuel.gazebosim.org/1.0/OpenRobotics/models/Collapsed%20house — CC0-1.0, https://creativecommons.org/publicdomain/zero/1.0/

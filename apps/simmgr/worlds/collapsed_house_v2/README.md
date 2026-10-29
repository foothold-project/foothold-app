# 붕괴 주택 · 초안

`collapsed_house_v2/f1`은 고정 지형이다. 남쪽 입구의 9단 계단(단높이12.5cm·디딤판30cm·폭1.4m)을 지나 남서쪽→북서쪽→동쪽 방으로 시계 방향으로 이동한다.

바닥을 단일 상자로 바꾸지 않는다. Gazebo는 높이장과 원래 집 메시를, 앱 MuJoCo는 높이장 PNG와 127개 벽 열 상자를 사용한다. three.js에는 원래 집2219삼각형과 실제 잔해 메시가 포함된다. 원래 15~30cm 돌1085개를 재배치하고 작은 삼각 타일150개를 추가했다.

앱 목록에서 «붕괴 주택 · 초안»을 고르거나 `/sim/index.html?map=collapsed-house-v2`로 연다. 기존 모바일 번들 생성 절차(`FH_SIM_SRC`와 `mobile/scripts/sync-web.mjs`)가 높이장 파일도 포함한다. 외부 정책·MuJoCo·three.js·로봇 자산은 기존 절차로 공급하며 이 PR에 넣지 않는다.

서버 지도·시나리오는 `worlds.json`에 등록되어 기존 `apps.server.fh_server.sim_maps` 명시적 가져오기로 등록할 수 있다. 작업 중 운영 서버에는 연결하지 않았다. `native_supported:false`이므로 서버 Gazebo 실행 adapter 연결은 별도 작업이다.

## 재생성·검사

로컬 판의 `tools/build_worlds.py`와 `tools/validate.py`를 먼저 실행하고 다음 명령으로 앱 형식으로 내보낸다. 원본 지형은 저장소 밖에 둔다.

```bash
python3 -m apps.simmgr.tools.import_house /path/to/generated-terrain-v2
FH_SIM_SRC=/path/to/local-sim node mobile/scripts/make-top.mjs collapsed-house-v2
node mobile/scripts/scenario-selftest.mjs
python3 -m pytest apps/server/tests/test_house_assets.py -q
```

`mapframe.tsx`의 새 PNG SHA 연결도 맞춰야 한다. 서버 시험은 격리된 시험 DB/파일 저장소에서만 등록한다. 지도는5cm 해상도로 실제 집 몸통 높이대와 15cm를 넘는 더미를 표시하며, 낮은 잔해와 계단은 이동 가능 후보로 남긴다.

## 모델과 표현의 한계

- 바탕과 더미 경계 비탈은 15° 이하로 설계했다. 작은 조각의 옆면은 별도의 국소 턱이다. 미세 격자 경사와 바탕 경사를 분리해 보고한다.
- 높이장 수평 표본은1.66cm이다. 조각의 수직 옆면에서는 보이는 면과 접촉 높이의 차이가 커질 수 있다. PNG의8bit 양자화도 약8mm이다.
- 앱 벽 충돌은 몸통 높이의 실제 삼각형을10cm 격자로 보수적으로 덮은 열 상자다. 창·지붕·가구의 모든 충돌면을 그대로 재현하지 않는다.
- 현재 foothold-v2는 발밑을 평면으로 관측한다. 거친 면·계단의 성공은 보장하지 않는다. 실제 시험 결과와 미검증 범위는 작업 보고서에 남긴다.
- 실폰 성능·발열·실로봇·원격 서버는 미검증이다. APK나 운영 배포를 수행하지 않는다.

CC0 집 출처·변형 범위는 [NOTICE.md](NOTICE.md)에 있다.

최신 검증: 지형58,019삼각형, 접촉 geom139개+라이다 전용30개(접촉 없음), 앱 자산 합계10MB 미만. 수평 라이다는 높이장 전체 대신30cm를 넘는 더미를50cm 격자 보수적 상자로 본다.

Chrome 공유 앱 물리의 양방향 각10회: 완주0/20·넘어짐0/20·진행 정체20/20. 입구 출발은 몸통 접촉10/10, 역방향은0/10이었다. 정체는 전진 명령 중5초에5cm 미만 이동한 경우이며 실제 발 끼임 원인은 미판정이다. 같은 초기값으로 반복한 결정론적 시험이다.

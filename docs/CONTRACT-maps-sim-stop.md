# 지도·지형 선택·Gazebo 끄기 계약 (초안, 2026-10-14)

상태: **초안 — RL 쪽 구동기·world 는 실행 미검증, UI 쪽 지도 화면은 미구현.** frozen 커밋이 정해지면 이 문서 머리에 적는다.
새 기능은 전부 기존 WS(`/api/app/ws` → v2_link) op 로 오간다. 네이티브(앱 셸) 변경 0, 전화기 파일 저장 0.

## 1. 세계와 층

| world_id | building_id | floor_id | 지도 출처 | 비고 |
|---|---|---|---|---|
| `v5_single` | `v5` | `floor1` | GT 기하 래스터 | v5 1층만 추출한 단층 |
| `v5_building` | `v5` | `floor1`, `floor2` | GT 기하 래스터 | 같은 건물, 층마다 지도 따로 |
| `rooms_a` | `rooms_a` | `floor1` | SLAM(직접 조종하며 생성) | 새 미매핑 단층 |

- GT 기하 래스터는 «SLAM 결과 아님»으로만 표시한다. 기존 v5-l1/l2: 800×640, 0.05 m, origin [-20,-14,0], trinary.
- 층 전환 = Gazebo 끄기 → 다른 floor_id 로 새 기동(지도 체험 원장 1회). 계단 자동 이동·층간 자동 주행 없음.

## 2. 지도 보기와 실제 기동은 다르다

- **지도 보기 선택**: 저장된 지도만 바꿔 본다. 실제 world·조종 상태는 바뀌지 않는다.
- **시뮬 시작**: 지형·층·모드(`slam|static`)를 명시해 고르고 확인창을 거친 요청만. 자동 기동·자동 재시작 없음.
- 원장 두 개는 섞지 않는다: 기존 체험(`ledger_used/max`) ↔ 지도 체험(`map_ledger_used/max`, 4회·각 1800 s). 화면에 이름을 달리 표시하고 서로 대신하지 않는다.

## 3. 저장 지도 자산 (서버 관리)

```
<MAPS_ROOT>/<building_id>/<floor_id>/<map_version>/
    map.pgm  map.yaml  meta.json
```
- `map_version` = `YYYYmmdd-HHMMSS-e<epoch>` (정규식 `^\d{8}-\d{6}-e\d+$`). building_id·floor_id 는 위 표의 고정 허용목록.
- 쓰기: RL 구동기 `/v2_map/save`(Trigger) 만. 임시 폴더에 다 쓴 뒤 rename(원자). 기존 버전 덮어쓰기 없음 — 같은 층 재저장 = 새 버전.
- 읽기: v2_link 는 `<MAPS_ROOT>` 아래를 **읽기만**. 경로·파일 이름은 서버가 만든다. 클라이언트가 보낸 래스터를 정본으로 올리지 않는다.
- `meta.json`: `schema:"v2_map_meta/1"`, world_id, building_id, floor_id, epoch, map_version, `map_source: "slam"|"gt_raster"`, resolution, origin, width, height, saved_sim_t, sha256(map.pgm).

## 4. WS op (v2_link)

| op | 보냄 | 답 | 비고 |
|---|---|---|---|
| `map_list` | `{op, rid}` | 건물·층별 버전 목록 + meta 요약 | 읽기만 |
| `map_get` | `{op, rid, building_id, floor_id, map_version}` | meta + PNG(base64) | pgm→PNG 변환은 IOLoop 밖, 결과 캐시 |
| `sim_stop` | `{op, rid}` | 접수 답 → 결과는 이벤트 | 아래 6절 |

상한(서버가 검사, 넘으면 지도 상태 오류 — 조종·STOP 계약은 그대로):
- 격자 width·height ≤ 2000, PNG 응답 ≤ 1 MB, 실시간 지도(`/v2_map/map`) 반영 ≤ 1 Hz, 대기열 = 최신 1장(덮어쓰기).
- 지도 처리(변환·파일 읽기·저장 서비스 대기)는 조종 명령·영상·STOP 을 막지 않는다.

## 5. 지도 위 로봇 표시 결속

로봇 마커는 아래가 **모두** 맞을 때만 그린다. 하나라도 아니면 «위치 미표시(지도와 결속 안 됨)».
- `/v2_map/status` 의 world_id·building_id·floor_id·epoch 가 보고 있는 지도 meta 와 같다.
- `pose_map`(구동기가 map→base_footprint 를 조회해 넣은 값)이 있고 신선하다.
- 늦게 온 이전 epoch 의 지도·자세는 버린다.
- 출처 표기: `slam_tf`(SLAM 보정) / `gt_identity`(GT 정렬 지도에만 정확). live GT 를 지도 origin 에 그냥 붙이지 않는다.

`/v2_map/status`(JSON) 필드: `schema:"v2_map_status/1"`, world_id, building_id, floor_id, mode, epoch, map_version, map_source, sim_t, `pose_map{x,y,yaw,stamp_sim,source}|null`, `last_save{map_version,ok,reason}|null`, map_ledger_used, map_ledger_max.

## 6. Gazebo 끄기 (`sim_stop`, 구현됨 — 개발판)

- 로봇 STOP 이 아니다. 같은 systemd 사용자 unit 을 RL 의 `stop_live.sh` 로 한 번 끄고, 상태 스크립트로 확인한다.
- 거부: 관문 로그인 신원 없음 · 다른 기기 조종 중 · 시작 요청 처리 중 · 켜진 Gazebo 없음 · 처리 중 · 30 s 쿨다운.
- 요청 시: 본인 조종 입력 폐기 → 명령 0 → STOP 잠금 → 조종권 반납.
- 성공(«ROS 세션 종료 확인»)은 상태 조회 종료 코드 0 + `active_state ∈ {inactive, failed}` + 상태 수신 3 s 넘게 끊김일 때만. 그 밖은 «확인 못 함». Gazebo 잔여 프로세스는 확인 범위 밖.
- 전체 60 s 안: wrapper 기다림 ≤45 s, 상태 조회마다 ≤min(10, 남은 시간). 실패·연결 끊김에도 결과 기록·busy 해제.
- 자동 재시작 없음. 다시 하려면 «시뮬 시작»을 직접 누르고 해당 원장 상한을 쓴다.

## 7. 아직 안 된 것

- RL 구동기·3세계 world·`/v2_map/*` 발행: 실행 미검증. 매핑 연결 전에는 «매핑 완료»·저장 버튼 동작을 표시하지 않는다.
- v2_link 의 map_list/map_get, 지도 보기 화면: 미구현.
- 서빙판 반영·새 APK: 검수 뒤, 조종 중이 아닐 때.

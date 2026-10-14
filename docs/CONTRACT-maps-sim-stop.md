# 지도·지형 선택·Gazebo 끄기 계약 (초안, 2026-10-14)

상태: **초안 — RL 쪽 구동기·world 는 실행 미검증. UI 쪽 저장 지도 보기·실시간 지도·지도 체험 시작·지도 저장은 개발판 구현(합성 발행기·스텁 래퍼로만 시험, 실 Gazebo·RL 래퍼 미실행).** frozen 커밋이 정해지면 이 문서 머리에 적는다.
새 기능은 전부 기존 WS(`/api/app/ws` → v2_link) op 로 오간다. 네이티브(앱 셸) 변경 0, 전화기 파일 저장 0.

## 1. 세계와 층

| world_id | building_id | floor_id | 지도 출처 | 비고 |
|---|---|---|---|---|
| `v5_single` | `v5_single` | `f1` | GT 기하 래스터 `gt-20261012` | v5 1층만 남긴 단층. 건물 키를 `v5` 와 나눠 같은 층·버전 키에 합쳐지지 않게 |
| `v5_building` | `v5` | `l1`, `l2` | GT 기하 래스터 `gt-20261012` | 같은 건물, 층마다 지도 따로 |
| `rooms_a` | `rooms_a` | `f1` | SLAM(직접 조종하며 생성) | 새 미매핑 단층 |

정본: RL `map-20261014/MAP-CONTRACT.md`(worlds.json·`live_map.meta_check`). 이 문서와 갈리면 RL 정본을 따르고 여기를 고친다.

- 같은 GT 원본을 두 world 가 써도 자산 폴더는 world 의 건물 키 아래 따로 둔다(덮어쓰기 0). 원본은 meta 의 `source_note`(선택, 서버는 읽지 않음)에 적는다.
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
- `map_version` 정규식 `^(\d{8}-\d{6}-e\d+|gt-\d{8})$` — 저장본 `YYYYmmdd-HHMMSS-e<epoch>`, 사전 GT `gt-YYYYMMDD`. building_id·floor_id 는 위 표의 고정 허용목록.
- 쓰기: RL 구동기 `/v2_map/save`(Trigger) 만. 임시 폴더에 다 쓴 뒤 rename(원자). 기존 버전 덮어쓰기 없음 — 같은 층 재저장 = 새 버전.
- 읽기: v2_link 는 `<MAPS_ROOT>` 아래를 **읽기만**. 경로·파일 이름은 서버가 만든다. 클라이언트가 보낸 래스터를 정본으로 올리지 않는다.
- `meta.json`(RL `meta_check` 와 같은 규칙, 추가 키 허용): 필수 키 schema `v2_map_meta/1`·world_id·building_id·floor_id·epoch·map_version·map_source·map_frame(`map`)·resolution·origin[x,y,yaw]·width·height(≤2000)·saved_sim_t·saved_wall·reason(`user_save|pre_reset_autosave|gt_raster_copy`)·sha256_pgm. 값 null 은 epoch·saved_sim_t·saved_wall 만(키는 항상 있음). epoch: slam 정수 ≥1 / gt_raster null. gt_raster 는 source_pgm·source_sha256 필수. 화면은 origin yaw 0 만 그린다. map.yaml 대조는 RL 쪽(화면은 yaml 을 안 씀).
- maps root: RL 단계 폴더의 `maps/`(절대경로는 status.maps_root 로도 실림). v2_link 는 `--maps-root` 로 받는다.
- meta 하나가 틀리면 그 지도만 목록에서 빠진다(다른 지도는 유지). 화면은 받은 답의 world·건물·층·버전·epoch·출처가 고른 것과 모두 같을 때만 그린다.

## 4. WS op (v2_link)

| op | 보냄 | 답 | 비고 |
|---|---|---|---|
| `map_list` | `{op, rid}` | 건물·층별 버전 목록 + meta 요약 | 읽기만 |
| `map_get` | `{op, rid, building_id, floor_id, map_version}` | meta + PNG(base64) | pgm→PNG 변환은 IOLoop 밖, 결과 캐시 |
| `sim_stop` | `{op, rid}` | 접수 답 → 결과는 이벤트 | 아래 6절 |
| `map_live_get` | `{op, rid}` | `live{seq, epoch, world_id, floor_id, png}` | 지금 표시 중인 실시간 격자만(7절) |
| `map_start` | `{op, rid, world_id, floor_id, mode, map_version?}` | 접수 답 → 결과는 이벤트·`map_start.last` | 8절 |
| `map_save` | `{op, rid}` | 결과 답(≤10 s) 또는 «결과 미확인» | 9절 |

상한(서버가 검사, 넘으면 지도 상태 오류 — 조종·STOP 계약은 그대로):
- 격자 width·height ≤ 2000, PNG 응답 ≤ 512 KiB, 실시간 지도(`/v2_map/map`) 반영 ≤ 1 Hz, 대기열 = 최신 1장(덮어쓰기).
- 지도 처리(변환·파일 읽기·저장 서비스 대기)는 조종 명령·영상·STOP 을 막지 않는다.

## 5. 지도 위 로봇 표시 결속

로봇 마커는 아래가 **모두** 맞을 때만 그린다. 하나라도 아니면 «위치 미표시(지도와 결속 안 됨)».
- `/v2_map/status` 의 world_id·building_id·floor_id·epoch 가 보고 있는 지도 meta 와 같다.
- `pose_map`(구동기가 map→base_footprint 를 조회해 넣은 값)이 있고 신선하다.
- 늦게 온 이전 epoch 의 지도·자세는 버린다. **GT 사전 지도(meta epoch null)는 epoch 로 비교하지 않는다** — 지도 쪽은 world·building·floor·map_version·sha256_pgm 이 status 와 같은지, 자세 쪽은 status 의 현재 epoch·stamp 신선도를 따로 본다(null ≠ live epoch 로 영구 미표시가 되지 않게). 실시간 결속 규칙은 7절.
- 출처 표기: `slam_tf`(SLAM 보정) / `gt_identity`(RL 이 worlds.json 지정 GT 폴더·기하 바이트 대조를 통과한 지도에만 냄). live GT 를 지도 origin 에 그냥 붙이지 않는다.
- 저장 SLAM 지도를 static 으로 띄우면 RL 은 map→odom 을 내지 않고 `pose_map=null`·`pose_map_null_reason=saved_slam_map_not_localized` — 화면은 마커를 그리지 않는다(위치 추정 기능 없음).

`/v2_map/status`(JSON) 필드: `schema:"v2_map_status/1"`, world_id, building_id, floor_id, mode, epoch, map_version, map_source, sim_t, `pose_map{x,y,yaw,stamp_sim,source}|null`, `last_save{map_version,ok,reason}|null`, map_ledger_used, map_ledger_max, pose_map_null_reason(`saved_slam_map_not_localized|tf_stale|tf_lookup_failed|null`). 정본은 RL MAP-CONTRACT §4.

## 6. Gazebo 끄기 (`sim_stop`, 구현됨 — 개발판)

- 로봇 STOP 이 아니다. 같은 systemd 사용자 unit 을 RL 의 `stop_live.sh` 로 한 번 끄고, 상태 스크립트로 확인한다.
- 거부: 관문 로그인 신원 없음 · 다른 기기 조종 중 · 시작 요청 처리 중 · 켜진 Gazebo 없음 · 처리 중 · 30 s 쿨다운.
- 요청 시: 본인 조종 입력 폐기 → 명령 0 → STOP 잠금 → 조종권 반납.
- 성공(«ROS 세션 종료 확인»)은 상태 조회 종료 코드 0 + `active_state ∈ {inactive, failed}` + 상태 수신 3 s 넘게 끊김일 때만. 그 밖은 «확인 못 함». Gazebo 잔여 프로세스는 확인 범위 밖.
- 전체 60 s 안: wrapper 기다림 ≤45 s, 상태 조회마다 ≤min(10, 남은 시간). 실패·연결 끊김에도 결과 기록·busy 해제.
- 자동 재시작 없음. 다시 하려면 «시뮬 시작»을 직접 누르고 해당 원장 상한을 쓴다.

## 7. 실시간 지도 결속 (`/v2_map/status` + `/v2_map/map`, 서버가 정본)

- 구독: status String(reliable, depth 10) · map OccupancyGrid(transient_local·reliable·depth 1). ROS 콜백은 최신 1장만 두고, 검사·PNG 변환은 별도 일꾼 ≤1 Hz.
- 결속 키 K = (world_id, building_id, floor_id, mode, map_source, map_version, epoch). status 형식이 틀리면(스키마·허용표·모드/출처·버전 정규식·map_frame·epoch≥1) 격자 0.
- 격자 표시 조건(전부): status 3 s 안 · `map_accepting=true`·`map_error=null`·앱 RESET/Gazebo 끄기 직후 아님 · `status.map.epoch == epoch` · 격자 수신 ≥ K 를 처음 본 시각(옛 K 격자 거부) · w/h/resolution 이 `status.map` 과 같음 · frame `map`, w/h 1~2000, 칸 {-1, 0~100}, 원점 유한·쿼터니언 정규·yaw 0, PNG ≤512 KiB.
- stamp: **slam 만** 격자 stamp == `status.map.stamp_sim`(±1 ms). static 은 RL 이 파일 지도를 stamp 0 으로 내므로 stamp 를 비교하지 않고, 같은 K·수신 순서·격자 형상 + 저장 meta(world·출처·크기·해상도·원점 x,y) 대조로 결속한다. static 의 `stamp_sim` 이 null 이든 0.0 이든 표시 시각으로 쓰지 않는다.
- K 가 바뀌거나(새 epoch·새 세션) 같은 K 에서 `sim_t` 가 1 s 넘게 되감기면(새 기동 episode 재사용) 표시 격자·대기 격자·처음 본 시각을 같이 초기화. status 3 s 끊김도 세션 경계로 본다.
- ROS 행 0 = 아래쪽 → PNG 는 행을 뒤집어 위쪽이 y 큰 쪽(저장 지도 PGM 과 같은 방향).
- frame·형식이 틀린 새 격자는 채택하지 않고, 같은 K 의 마지막 정상 격자를 유지한다.
- 위치 마커(실시간 보기만): 격자 표시 중 + 같은 status 의 `pose_map` 유한 + 출처가 모드와 맞음(slam→`slam_tf`, static+gt_raster→`gt_identity`) + |sim_t − pose.stamp_sim| ≤ 1 s + status 2 s 안. 아니면 마커 0 + 이유(`pose_map_null_reason` 한국어). 실시간 보기 중에는 Gazebo GT 마커·길·구역을 그리지 않는다(좌표계가 다름).
- 저장 지도 보기(`map_get`)는 이 결속을 쓰지 않고 마커를 그리지 않는다.
- 화면: 지도 고르기의 «실시간 지도(/v2_map)». 서버 `live_map.st != ok` 가 되면 그림을 즉시 버리고 이유를 표시, 새 `grid.seq` 마다 `map_live_get` 으로 다시 받고 seq·epoch·world·floor 가 받는 사이 바뀌었으면 버린다.
- `live_map` 요약에는 경로(maps_root·저장 path)·kids 를 싣지 않는다.

## 8. 지도 체험 시작 (`map_start`, 개발판)

- v2_link 인자 `--map-start <start_map.sh 절대경로>`(상태는 같은 폴더 `map_status.sh`, 읽기만). 없으면 버튼 거부(«경로 미설정»).
- 인자: 허용표의 world·floor · mode `slam|static` · static 은 maps 목록에 있는 버전 필수, slam 은 버전 없음.
- 거부: 관문 로그인 아님 · 시작 처리 중(기존 «시뮬 시작»과 같은 busy·120 s 쿨다운, 단일 unit) · Gazebo 종료 처리 중 · Gazebo 켜짐/세션 running·starting · 다른 기기 조종 중 · 지도 체험 원장 미확인·소진·그 world/floor 사용됨.
- 접수 시 같은 조종 lock 에서: 조종권 해제·명령 0·STOP 잠금·입력 폐기, 처리 중 take/resume/reset/비영 명령 차단(STOP·화면 숨김·반납은 그대로). 끝나도(성공·실패·시간 초과 240 s) 자동 복원·재시도·연장·take/resume 0, STOP 잠금 유지. 실시간 지도도 새 K 까지 «리셋 중».
- 원장: 지도 체험(`map_ledger_used/max`·사용 키) 을 기존 체험 원장과 다른 줄·다른 이름으로 표시.
- 화면: PC 지도 왼쪽 패널·폰 지도 서랍의 «지도 체험 시작» — 지형·층·모드·버전 선택 + 확인창. «지도 보기» 선택은 세계를 바꾸지 않는다.

## 9. 지도 저장 (`map_save`, 개발판)

- 조건: 관문 로그인 · slam 모드 · 실시간 격자 표시 중 · 처리 중 아님 · `/v2_map/save` 준비. 화면은 실시간 slam 일 때만 버튼을 보인다.
- `/v2_map/save`(Trigger) 1회, 10 s 제한. 답 message JSON 의 `map_version`(정규식)·`reason`(경로 지움)만 쓰고 `path` 는 버린다.
- 10 s 넘으면 «결과 미확인(늦게 저장될 수 있음) — 저장 지도 목록 다시 확인». «저장 실패»로 단정하지 않고 자동 재호출 0. 늦게 온 답은 사건으로만 남기고 현재 지도·저장 결과로 쓰지 않는다. 요청 때와 응답 때 epoch 가 다르면 그 사실을 붙인다. 연결이 끊긴 뒤의 답은 그 기기에 보내지 않는다.

## 10. 아직 안 된 것

- 실 RL 구동기·3세계 world·`/v2_map/*` 발행·`start_map.sh`/`map_status.sh` 실행: 미검증(합성 발행기 domain 88·스텁 래퍼로만 시험).
- RL static status 의 `map.stamp_sim` 실제 값(0.0 또는 null) 미확인 — 어느 쪽이든 static 은 stamp 비교 안 함.
- 저장 지도 static 을 띄운 뒤 위치 추정(localization): 없음 — `saved_slam_map_not_localized` 면 마커 0.
- 실시간 보기에서 격자가 아직 없을 때 화면은 시뮬 바닥(GT) 보기로 돌아가 «시뮬 바닥 도면 · GT» 로 표시한다(실시간 지도 미표시 이유는 고르기 아래에).
- 서빙판 반영·새 APK: 검수 뒤, 조종 중이 아닐 때.
- 소스 경로 정리: 커밋 0c09f8d·660ded9 의 v2_link selftest 에는 로컬 호스트 경로 문자열이 있었다(키·토큰 아님). 6fad1df 부터 HEAD 에서는 환경변수(`V2_LINK_MAPS_ROOT`·`V2_LINK_V5_PGM`)로 바꿨고, 과거 이력은 다시 쓰지 않았다(검사 범위 = HEAD).

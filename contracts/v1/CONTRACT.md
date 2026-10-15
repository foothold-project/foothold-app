# FOOTHOLD 앱 계약 v1 (`fh-app/1`)

정본은 `models.py` 이고, `schema/*.json`·`ts/index.ts` 는 `tools/generate_contracts.py` 로 만든 생성물이다(수정 금지).
현행 `sim/v2_link.py`(기준 2dfc0e9)의 메시지를 **이름·단위를 바꾸지 않고** 그대로 적었다. 조종 op 는 재설계하지 않았다.
`tests/backend/test_contracts.py` 가 v2_link 의 검사 함수(`doc_check`·`valid_axes`·`clean_state`)와 실제 dict 키(`snapshot`·`take_photo`)를 대조해서, 어긋나면 실패한다.

## 통로

| 통로 | 방향 | 계약 타입 |
|---|---|---|
| WS `/ws` 텍스트 | 화면 → 서버 | `ClientOp` (op 9개, 관문 `v2_gate.OPS` 와 같음, 1024 B 이하) |
| WS `/ws` 텍스트 | 서버 → 화면 | `ServerMsg` = `Status`(10 Hz) · `Reply`(rid 응답) |
| WS `/ws` 바이너리 | 서버 → 화면 | JPEG 원본 한 장(새 프레임일 때만). 메타 없음 |
| `GET /api/docs` | 조회 | `DocsList` |
| `POST /api/docs` | 쓰기 | 요청 `DocWrite`, 응답 `DocPutOk`·`DocDelOk`·`ApiError` |
| `GET /api/media` | 조회 | `MediaList` (사진·사건을 한 번에 — `/api/photos` 같은 경로는 없음) |
| `GET /media/photos/<YYYYMMDD>/<이름>.jpg` | 조회 | 사진 파일 |

- 쓰기 헤더: `Origin` 이 서버 자신의 주소여야 한다(아니면 403). `X-FH-Actor` = 관문이 붙이는 «계정 · 기기»(퍼센트 인코딩 UTF-8). 화면은 이 헤더를 만들지 않는다.
- 시뮬 → 서버 ROS `/v2_live/state`(schema `v2_live/state/1`)의 원본 계약은 RL 쪽 소유라 여기 없다. 화면이 받는 것은 서버가 정리한 `SimState` 다.

## 추가 필드·unknown·null

- **화면 → 서버(WS op)**: 모르는 필드는 무시한다. `cmd` 의 형식이 틀려도 서버는 연결을 끊거나 거부하지 않고 **명령 0 + 입력 무효화**로 처리한다(안전 정본은 서버 Core).
- **서버 → 화면**: 모르는 필드는 무시한다. 받는 쪽은 새 필드 때문에 메시지를 버리면 안 된다. 다만 정해진 필드의 **타입이 틀리면** 그 메시지는 형식 오류로 본다.
- **문서 본문 `doc`**: 정해진 키만 허용(추가·누락 = 400). 저장 형식이라 엄격하다.
- **enum 값**(`role`, `Event.st`, 문서 enum)은 닫힌 집합이다. 새 값이 생기면 계약 버전을 올린다. 그 전에 화면이 모르는 값을 받으면 가장 제한적인 것으로 다룬다(role → 보기 전용, st → warn).
- **null = 미확인**: 값이 없거나 원천이 형식에 맞지 않게 보냈다는 뜻이다. 0·false 로 바꿔 표시하지 않는다. `SimState` 의 키는 항상 모두 있고, 관문값 4개(`episode`·`stop_requested`·`reset_in_progress`·`policy_running`)는 null 이 될 수 없다.
- **선택 필드**(`?`): `Reply.photo`(사진 성공 때만), `ApiError.cur`(409 때만), `DocPut.kind/id/rev`(새 문서 = `id:null`+`kind`, 고침 = `id`+`rev`).

## 숫자·bool

- bool 은 숫자가 아니다(`True` 를 1 로 받지 않음). NaN·Inf 는 거부한다. 정수 자리에 `2.0` 은 거부한다(strict).
- 문서 좌표: 유한 숫자 ±10000. `cmd` 축: −1..1.
- **생성 TS 는 타입만 준다.** 런타임 검증이 아니므로, 화면이 받은 JSON 을 믿으려면 따로 검사해야 한다. 생성 타입이 맞다고 서버가 끝까지 같은 검사를 한다는 뜻도 아니다.
- **서버 검사 주체(2026-10-13 현재):** 운영 경로 v2_link 는 Pydantic 을 쓰지 않는다 — 문서는 손으로 쓴 `doc_check`, WS 는 `valid_axes`·`gate_msg` 로 검사한다(`--store sqlite:` 여도 문서 검사는 `doc_check`). Pydantic `check_doc` 은 독립 `server/api.py`·`Store` 기본값·시험에서만 쓴다. 두 검사의 수락·거부가 같은지는 `test_contracts.py` 의 표본(53건)으로만 확인했고, 모든 입력에서 같다는 증명은 아니다.
- 이 계약은 현행 조종 op(0·(0.6,0,0)·(0.6,0,±0.5) 명령, STOP=명령 0)를 다시 설계하지 않는다. STOP 명령 0 은 물리 정지가 아니다.

## 단위·좌표

| 필드 | 단위 |
|---|---|
| `x` `y` `z`, 문서 `pts`·`wps.x/y` | m |
| `yaw` | rad, 반시계 + |
| `vx` `vy` | m/s |
| `wz` | rad/s |
| `tilt_deg` | 도 |
| `sim_t` `cmd_age_s` `ttl_s` `gt_age_s` `frame_stamp_sim_s` | s |
| `rtf` | 비율 |
| `applied` / `cmd_applied` | `[vx m/s, vy m/s, wz rad/s]` |

- 좌표계는 **시뮬이 보낸 Gazebo GT 좌표 그대로**다(`source` 필드로 출처 표시). 지도·구역·경유점도 같은 좌표에 그린다(live.js `world_live.sdf` 바닥 −10~10 m). 실로봇의 map/odom 프레임과의 관계는 **미정**이다 — 실기 연결 때 다시 정한다.
- 서버가 보내는 명령은 시험한 네 가지뿐이다: `[0,0,0]`, `[0.6,0,0]`, `[0.6,0,±0.5]`.
- **STOP 명령 0 ≠ 물리 정지.** 실험에서 3.6 s·0.32 m 를 더 움직였고 원인은 미확정이다. `applied` 가 0 이라고 «멈췄다»고 표시하지 않는다.

## 시각·나이·episode

- `at`·`saved_at`·`frame_at`·`started`/`ended`: 서버 지역 시각 ISO 문자열, 오프셋은 `%z` 형식(`+0900`, 콜론 없음). `frame_at` 은 ms 3자리. **Safari 의 `Date` 파싱은 콜론 없는 오프셋을 받지 않으므로** 화면에서 직접 고쳐 파싱해야 한다(형식 변경은 v2 에서 합의).
- `Event.t`: `HH:MM:SS`, 날짜 없음.
- `*_age`·`*_age_s`: 서버 단조 시계 기준으로 마지막 수신 뒤 지난 초. null 은 한 번도 받지 못했다는 뜻이다. 0.3 s(입력)·1 s(상태) 기준의 판정은 서버가 한다.
- `episode`: 시뮬이 정한 정수로, 리셋마다 바뀐다. 첫 상태를 받기 전에는 null. 바뀌면 서버가 STOP 잠금을 건다. 사진의 `episode` 는 프레임과 상태가 같은 episode 일 때만 저장된다.

## 조종 시작·잠금 세대 stop_gen (10-15 N1)

- `status.stop_gen`: 서버 Core 의 잠금 세대(0 이상 정수). 잠그는 모든 일마다 +1 — STOP(**이미 잠겼어도**)·조종권 해제(반납·숨김·끊김·로그아웃)·리셋 요청·리셋 응답·episode 변경·시뮬이 스스로 STOP·Gazebo 종료/지도 체험 시작(시뮬 바쁨). 정상 해제·take·cmd 는 바꾸지 않는다.
- `resume.stop_gen`(선택): 화면이 «조종 시작» 확인창을 연 순간 본 값. 서버의 지금 값과 다르면 거부(이벤트 «잠금 세대 다름»), 재시도 없음 — 사람이 다시 확인해야 한다. 확인창 동안 다른 기기가 누른 STOP(옛 latch boolean 으로는 흔적 없음)을 풀지 않기 위한 CAS.
- 칸이 있는데 0 이상 정수가 아니면(null·bool·실수·문자) 형식 오류로 거부. 칸이 없으면 옛 클라이언트(따로 누르는 «STOP 해제» — 그 순간의 사람 행동)로 그대로 처리한다(배포된 APK·옛 웹 호환).
- 옛 서버(status 에 `stop_gen` 없음): 새 화면은 «조종 시작»을 막고 이유를 보인다. 세대 없이 take→resume 을 자동으로 잇는 대체 경로·형식 완화는 없다.
- 화면 결속(확인창~성공): 연결 세대·대상·판·episode·리셋 대기·stop_gen·형식·신선도(status 간격 1 s)·시뮬 막힘·다른 기기 점유·(take 뒤) 조종권. 하나라도 바뀌면 그 순간 취소하고, 되돌아와도 취소를 유지한다. 이 기기 STOP·숨김·반납·리셋 요청도 취소. 정지 단계는 늘지 않는다(STOP 은 여전히 한 번에 즉시).

## 문서 판(rev)

- 문서마다 `rev` 는 1부터 시작해 고칠 때마다 +1. `id`·`rev`·`by`·`at` 은 서버가 붙인다.
- 전체 판 `DocsList.rev` = `status.docs_rev`. 값이 바뀌면 화면이 다시 읽는다(값 자체에 의미는 없고 «바뀜»만 본다).
- 고칠 때는 화면이 읽은 `rev` 를 보낸다. 다르면 **409 + `cur`**(지금 저장된 판)가 오고, 화면은 초안을 지우지 않는다.
- 하나만 허용: `status:'진행'` 인 `run` 은 전체에서 하나, `note` 는 `photo` 당 하나. 겹치면 409 + 기존 문서.

## 오류(HTTP)

| 코드 | 뜻 |
|---|---|
| 400 | 형식(`error` = `doc.경로: 이유` 등) · 문서 수 한도 2000 · 본문 12000 B 초과 · (server/api 만) 요청 64 KiB 초과 |
| 403 | 다른 출처 |
| 404 | 없는 문서(다른 기기가 지웠을 수 있음) |
| 409 | 판 충돌 또는 «하나만» 위반, `cur` 포함 |
| 500 | 저장 실패 — 이전 상태 그대로 |
| 503 | 저장소 사용 불가(파일 손상 등, 원본 보존) — `DocsList.broken` 에 이유 |

## 실행 대상(provider) · 보조 관제 뷰 (10-14)
- 이름 하나: `ProviderKind` = `simulation_gate`(관문 경유 시뮬) | `go2_direct`(Go2 직접 — 네이티브 담당, 준비 중). UI·네이티브·RL 은 이 값만 쓴다.
- `Capabilities` {command, map, rgb, depth, points, follow_cam}: 지금 실제로 주는 것만 true. 실기 미도착·펌웨어 미확인 = 전부 false(빈 칸 + 이유). go2_direct 의 command 는 false(자동 조종 0).
- 대상 전환(화면): 누름 폐기 → 시뮬을 떠나면 hidden(조종권 해제) → 보기 전용 → 연결 세대 +1. 세대가 다른 응답·카메라·지도·점군은 버린다. 돌아와도 조종권·STOP 해제 자동 복원 0. 실기 모드에서는 시뮬 WS 로 cmd·stop·take·ask 를 보내지 않는다.
- 보조 뷰는 서버가 밀어넣지 않는다: `status.views.{follow,points}` 의 seq 가 바뀌면 화면이 보고 있을 때만 `view_get` 으로 최신 1개를 받는다(≤2 Hz).
- points: map 프레임 xyz(float32 LE, base64, n×12 바이트, n ≤ 4000). 결속 키(world·building·floor·mode·map_source·map_version·epoch)가 `live_map` 과 다르거나 `live_map.bound` 가 true 가 아니면(상태 수준 결속 — 리셋·끊김·층 이동·epoch 어긋남·형식 틀림) 화면은 누적하지 않는다. 격자 그림만의 대기(새 격자 변환·도착, `grid.upd`)는 점군·3인칭을 끄지 않는다(10-15 MAP-STABILITY). 누적은 시각화이며 SLAM 3D 지도가 아니다.
- follow: Gazebo 렌더 3인칭 — RL `/v2_map/follow_cam`(std_msgs/String JSON, schema `v2_map/follow_cam/1`, JPEG base64 ≤64 000 B). 지도 체험 시작 때 `follow_cam: true`(strict bool, 실기 대상에선 보내지 않음)일 때만 켜진다. 평지 체험엔 없다. 웹이 그리는 «가상 3D 뷰»와 따로 표기한다.
- 실시간 지도 갱신(10-15): 서버는 앞선 격자(status 보다 stamp 가 앞섬, 크기·원점 바뀜 포함)를 보관 당시 K 와 함께 대기시켰다가 다음 status 에서 메타가 맞으면 원자 교체한다. status 가 표시 그림보다 앞서면(같은 K·slam·형식 정상 메타·앞선 stamp) 그 그림을 검증 시각 + 12 s 까지만 `grid.upd=true` 로 보유하고 그동안 `pose=null`. map 없음·해상도 바뀜·stamp 역행·형식 이상·K/epoch/층 세대 변경·리셋·끊김은 즉시 버린다. 화면도 새 seq 해독 중엔 같은 K·연결 세대의 검증된 그림(이미지+메타 한 덩어리)을 같은 시한까지 보이고 마커 0 + «갱신 중».
- 시각 판정(서버 `Views`, 기준시계 = `live_map` status 의 `sim_t`, 1 Hz): 추정 상한 hi = 마지막 sim_t + 그 status 뒤 흐른 벽시계(RTF ≤ 1 가정).
  - 받을 때 stamp_sim > hi + 0.5 s → «미래 시각»으로 **들이지 않음**(캐시 오염으로 다음 정상 프레임이 «역행» 거부되는 것 방지).
  - 보일 때: sim_t 모름 → `stale`(현재 시뮬 시각 모름) · stamp_sim > hi + 0.5 s → `bad`(미래) · sim_t − stamp_sim > 3 s → `stale`(시뮬 시각 기준 오래됨) · 벽시계 수신 나이 > 3 s → `stale`. ok 가 아니면 `view_get` 은 주지 않는다.
  - 화면(`checkStatus`): `views.{points,follow}` 형식(st 4종·why 문자열·seq null|양의 정수·age_s null|유한 ≥0)이 틀리면 그 뷰만 버린다(조종·STOP 관문과 무관). `viewKey` 는 age_s 0~3 s·seq 양의 정수·마지막 메시지 ≤1 s 일 때만.
  - 미검증: RTF > 1 · 실 카메라/점군 stamp 와 sim_t 의 실제 차 · 처리 부하·지연(실기동 없음).

## 버전

- 메시지에는 버전 필드가 없다. **없으면 v1** 이다. 필드 추가는 v1 안에서 한다(받는 쪽이 무시하므로).
- 이름·단위·enum·필수 여부를 바꾸면 `fh-app/2` 다. 바꾸기 전에 화면 담당과 먼저 합의한다.

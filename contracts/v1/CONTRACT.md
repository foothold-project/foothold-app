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
- **생성 TS 는 타입만 준다.** 런타임 검증이 아니므로, 화면이 받은 JSON 을 믿으려면 따로 검사해야 한다. 서버는 Pydantic 으로 검사한다.

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

## 문서 판(rev)

- 문서마다 `rev` 는 1부터 시작해 고칠 때마다 +1. `id`·`rev`·`by`·`at` 은 서버가 붙인다.
- 전체 판 `DocsList.rev` = `status.docs_rev`. 값이 바뀌면 화면이 다시 읽는다(값 자체에 의미는 없고 «바뀜»만 본다).
- 고칠 때는 화면이 읽은 `rev` 를 보낸다. 다르면 **409 + `cur`**(지금 저장된 판)가 오고, 화면은 초안을 지우지 않는다.
- 하나만 허용: `status:'진행'` 인 `run` 은 전체에서 하나, `note` 는 `photo` 당 하나. 겹치면 409 + 기존 문서.

## 오류(HTTP)

| 코드 | 뜻 |
|---|---|
| 400 | 형식(`error` = `doc.경로: 이유` 등) · 문서 수 한도 2000 · 본문 12000 B 초과 |
| 403 | 다른 출처 |
| 404 | 없는 문서(다른 기기가 지웠을 수 있음) |
| 409 | 판 충돌 또는 «하나만» 위반, `cur` 포함 |
| 500 | 저장 실패 — 이전 상태 그대로 |
| 503 | 저장소 사용 불가(파일 손상 등, 원본 보존) — `DocsList.broken` 에 이유 |

## 버전

- 메시지에는 버전 필드가 없다. **없으면 v1** 이다. 필드 추가는 v1 안에서 한다(받는 쪽이 무시하므로).
- 이름·단위·enum·필수 여부를 바꾸면 `fh-app/2` 다. 바꾸기 전에 화면 담당과 먼저 합의한다.

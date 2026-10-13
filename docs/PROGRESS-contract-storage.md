# 계약·저장소 진행 (백엔드 mentor, 2026-10-13)

브랜치 `less82/app-contract-storage`, 기준 `2dfc0e958230e823d302e9f433aaeda5d25f2971`. 로컬 커밋만(push·merge 는 고정 mentor 통합 검수 뒤).

## 구현

| 경로 | 무엇 |
|---|---|
| `contracts/v1/models.py` | 정본. 현행 v2_link 메시지(WS op 9·status·reply·SimState)·`/api/docs`·`/api/media`·문서 5종을 이름·단위 그대로. `check_doc()` = 서버 문서 검사 |
| `contracts/v1/CONTRACT.md` | 단위·좌표·시각·나이·episode·rev·오류·버전·unknown/null·추가 필드 정책 |
| `contracts/v1/schema/*.json`, `contracts/v1/ts/index.ts` | 생성물(수정 금지). `tools/generate_contracts.py`(`--check` = 재현 검사) |
| `server/store.py` | SQLite 문서 저장소. `apply()` 는 v2_link `Docs.apply` 와 같은 코드·응답. 사진·사건 메타 표 |
| `server/migrate.py` | `import`(복사본 → 임시 DB → 검증 → 덮어쓰기 없는 확정, manifest) · `verify` · `export`(rollback = docs.json 형식) |
| `server/api.py` | FastAPI 독립 어댑터 `create_app(store, allowed_origins, on_event, version)`: GET/POST `/api/docs`, GET `/api/media`. **v2_link 에 연결하지 않음 — 구현 완료 경로 아님** |
| `sim/v2_link.py` | (b) 연결 최소 diff: `--store json|sqlite:<경로>`(기본 json), `open_docs()`, GET 도 executor + DB 오류 500. 이 브랜치에만 — 통합은 고정 mentor 호환 검토 뒤 |
| `tests/backend/` | `test_contracts.py`(74) · `test_store.py`(25) · `test_v2_link_store.py`(8) · `test_review_fixes.py`(21) |
| `requirements-backend.txt` | 버전 고정(pydantic 2.14.1 · fastapi 0.143.0 · httpx 0.28.1 · pytest 9.1.1 + 의존성) |

### SQLite 설계
- `docs(id PK, kind CHECK, rev CHECK≥1, by, at, doc CHECK json_valid, seq)` STRICT. 목록 순서는 `seq`(만든 순서 = docs.json 삽입 순서).
- «하나만» 규칙: 생성 열 `note_photo`·`run_active` 에 **부분 UNIQUE 인덱스**를 걸고, 쓰기 앞에서 앱이 먼저 검사한다. 다른 프로세스와 경합해 앱 검사를 빠져나가도 `IntegrityError` → 409 + `cur`.
- 쓰기 하나 = `BEGIN IMMEDIATE` 트랜잭션 하나. 예외가 나면 ROLLBACK 하고, 어댑터는 500 으로 답한다. 고칠 때는 `UPDATE … WHERE id AND rev`.
- 전체 판 `meta.rev` 는 저장된 단조 증가 값이다. import 때는 v2_link 가 보이던 값(rev 합)으로 시작한다. **docs.json 은 재시작하면 rev 합으로 다시 세서, 삭제 뒤에는 값이 작아질 수 있었다**(시험이 이 차이를 고정).
- 연결은 호출마다 새로 연다(WAL, busy_timeout 5 s). 스레드·프로세스 사이에 공유하지 않는다.
- 열 때 검사(`_validate`): `quick_check` · 표·인덱스 정의가 DDL 과 글자 그대로 같음 · meta `schema_version`/`rev`/`seq` 가 정수 ≥0 · 문서 행마다 id 형식·종류·rev·by/at·본문 검사(`check`)·크기 · 문서 수 ≤2000 · `meta.rev ≥ rev 합`·`meta.seq ≥ 최대 seq`. 하나라도 틀리면 `broken` — 쓰기·`/api/media`·`db_rev()` 는 503(Bad), `GET /api/docs` 는 v2_link 와 같게 200 + 빈 목록 + broken 글. 파일 바이트는 그대로.
- 실행 중 DB 오류(디스크 등)는 GET·POST 모두 JSON 500 + `no-store`.
- 새 문서 id 가 이미 있으면(같은 초 + 무작위 꼬리 겹침) 다시 뽑는다 — 덮지 않고 500 도 아님. id 형식(문자열)은 그대로.
- 새 DB 는 임시 파일에 만든 뒤 `os.link` 로 만든다. 이미 있으면 덮어쓰지 않는다.
- 사진 JPEG·지도·영상 파일은 옮기거나 지우지 않는다. DB 에는 url·saved_at·episode·메타 JSON 만 둔다.

## 모의 검증(이 PC, ROS·공개 포트 없음, 임시 폴더만)

```
# 저장소 루트에서
python3 -m venv .venv-backend && .venv-backend/bin/pip install -r requirements-backend.txt
.venv-backend/bin/python tools/generate_contracts.py --check
.venv-backend/bin/python -m pytest -q -p no:cacheprovider tests/backend
# 생성 TS 타입 검사까지: FH_TSC=<typescript 5.9.3 의 tsc 경로> 를 붙이면 test_generated_ts_typechecks 가 돈다(없으면 skip)
```
- 결과: **127 passed · 1 skipped**(FH_TSC 없음) — 원문 `runs/backend-review-20261013/pytest-full.txt`(gitignore, 명령·버전·sqlite 판 포함). tsc 5.9.3(임시 폴더 설치, 저장소 밖)으로 따로 돌린 실행에서는 74/74 통과(계약 코드는 이후 바뀌지 않음).
- **v2_link 와 대조한 항목:**
  - 문서 형식 53건: 같은 입력에 v2_link `doc_check` 와 `check_doc` 의 수락·거부가 같은지
  - cmd 형식: `valid_axes` 와 같은지
  - 관문 op 집합: `v2_gate.OPS` 와 같은지
  - `snapshot()`·`take_photo` meta·`SimStart.state` 의 dict 키(ast 로 추출)가 계약 필드와 같은지
  - `clean_state` 출력이 `SimState` 검사를 통과하는지
  - 같은 요청 23개 순서에서 `Docs.apply` 와 `Store.apply` 의 HTTP 코드가 모두 같은지(200·409 는 응답 내용까지 비교)
  - `actor_from_header` 결과가 같은지
- **동시성:** 8 프로세스(spawn)가 Barrier 로 같은 순간에 note(같은 사진)·진행 run 생성 → 결과 `[200, 409×7]`. 8 스레드가 같은 rev 로 고침 → 1 건만 200. 앱 검사를 끈 상태에서 DB 제약만으로 409.
- **실패 주입:** 문서 행을 쓴 «뒤»에 OperationalError 를 일으킴(put·고침·del) → 목록·rev 그대로, HTTP 500.
- **손상:** sqlite 가 아닌 파일·빈 파일·schema_version 2 → broken, 503, 파일 바이트 그대로.
- **마이그레이션:** 실제 v2_link `Docs`·`Media` 로 만든 자료(깨진 사건 줄 포함) → import → verify → 새 DB 로 계속 씀 → export → v2_link `Docs` 가 깨짐 없이 읽음. 원본 폴더(JPEG 포함)의 바이트는 처음과 같음. out 이 이미 있으면 거부. 형식 오류·사진 하나에 note 둘·진행 run 둘·bool rev 가 있으면 DB 를 만들지 않음(manifest `failed`).
- **시험이 결함을 잡는지 변이로 확인:**
  - 계약 쪽(Zone 이름 41자, `docs_rev` 이름 바꿈): 4 개 실패
  - UNIQUE 인덱스 제거: 1 개 실패
  - 트랜잭션 제거: 2 개 실패
  - 전체 rev 증가 제거: 6 개 실패
  - 모두 원복한 뒤 cmp 로 원본과 같음을 확인

## 앱 Codex 1회 묶음 검수(85d08f7/47006b6) 반영

| 항 | 구현 | 모의 검증(`test_review_fixes.py`) | 미확인 |
|---|---|---|---|
| 1 열 때 의미 손상 | `Store._validate`(위 설계 절). `db_rev`·`media` 도 broken 이면 Bad. api GET 두 개·v2_link GET 에 DB 오류 → JSON 500 | 정상 SQLite 안의 손상 9종(meta rev 없음·글자·seq 음수·rev<합·표 없음·인덱스 없음·doc `{}`·doc `[1]`·id 형식) → broken·503·바이트 그대로. `_db` 가 읽기 중 OperationalError → GET 2·POST 1 모두 JSON 500 no-store | v2_link Tornado GET 의 500 경로는 코드만(Tornado 시험 없음, `--selftest` 통과만). 실제 디스크 오류 미실험 |
| 2 원본 폴더 | `check_src`: 있는 폴더 + `docs.json` 파일 필수, 작업 폴더도 만들기 전 거부. 빈 시작은 `import --allow-empty` 명시만. v2_link `open_docs` 는 media 폴더에 docs.json 이 아직 없을 때만 allow_empty(json 경로가 빈 Docs 로 시작하는 것과 같게). 문서 봉투 키는 정확히 6개(닫힘) | 없음·파일·빈 폴더·docs.json 이 폴더·봉투 키 추가 → 종료 2, out·작업 폴더 없음, 원본 그대로, 거부 이유 글 확인. `--allow-empty` 만 빈 DB | — |
| 3 확정 뒤 증거 | `settle()`: `wal_checkpoint(TRUNCATE)` 후 -wal/-shm 남으면 거부 → `snapshot.sqlite` 별도 복사(sha 를 manifest 에) → `os.link(tmp,out)` → tmp 삭제. export 는 `mkstemp` 배타 생성 + finally 삭제 | out 링크 수 1, `new.sqlite` 없음, snapshot sha = manifest = 확정 DB sha, out 에 계속 써도 snapshot sha 그대로. 기존 `.docs.json.tmp` 그대로 + export 성공 | — |
| 4 사진 메타 | 같은 url·다른 메타 → 거부. 완전히 같은 줄 → `photos_dup_identical` 개수만. JPEG 없음 → `photos_missing_jpeg` 개수(미확인, 지우거나 고치지 않음, 원본 폴더에서 존재만 확인) | 같은 줄 1·없는 JPEG 1 → 둘 다 개수, 원본 그대로. 다른 메타 → 종료 2, DB 없음 | 실제 `runs/app-media` 의 중복·누락 개수 미확인(운영 자료 미실행) |
| 5 본문 상한 | Content-Length 가 숫자 아님·64 KiB 초과 → 바로 400. 그 뒤 `request.stream()` 으로 받은 바이트를 세서 넘으면 더 읽지 않고 400(파싱 안 함) | chunked(길이 없음) 64 KiB+ · 거짓 길이 `10` · 길이 `abc` → 400 «너무 큼». chunked 정상 본문 → 200 | v2_link POST 상한은 그대로(Tornado 기본 `max_body_size`) — sim 통합 때 판단 |
| 6 문서 | CONTRACT.md: «서버는 Pydantic 으로 검사» 삭제 → 운영 v2_link 는 `doc_check`·`valid_axes`·`gate_msg`, Pydantic 은 독립 api·Store 기본값·시험만. 표본 53건 대조 ≠ 모든 입력 동등 증명. 조종 op 재설계 없음, 버전 필드 없음 | 원물 `runs/backend-review-20261013/` | — |

- 변이 확인(새 시험 21개 대상, 각각 원복 후 실행): 스키마 대조 제거 1 실패 · media broken 무시 9 · tmp 삭제 제거 1 · 스트림 상한 제거 1 · Content-Length 사전검사 제거 1 · id 1회 뽑기 1 · 빈 폴더 허용 1 · 다른 메타 수용 1 · 봉투 키 개방 1 · export 고정 tmp 1. 처음에 살아남은 3개(스트림 상한·봉투 키·본문 dict 검사)는 다른 이유의 400/거부가 가려서였고, 시험이 이유 글까지 보게 고쳤다. 본문 dict 검사는 `check` 와 중복이라 지웠다.
- 참조 강제는 보류(방향 판정): FK·CASCADE 없음, 없는 참조는 화면이 «미확인»으로 표시. 새 참조 검사·스냅샷은 다음 제품 계약.

## 알려진 차이(의도)

- **전체 판 `docs_rev`:** SQLite 는 저장된 단조 증가 값이라 재시작해도 줄지 않는다. 옛 docs.json 경로는 재시작 때 rev 합으로 다시 세서 삭제 뒤 값이 작아질 수 있다. 화면은 값이 «달라지면» 다시 읽으므로 문제없음(고정 mentor 확인).
- **새 문서 id 충돌:** 옛 v2_link `Docs` 는 id = 종류+초+pid+n(n 은 열 때마다 0) 이라, 같은 초·같은 pid 로 다시 열면 기존 id 를 다시 만들어 그 문서를 덮는다. Store 경로는 충돌 시 다시 뽑는다. 옛 json 경로 수정은 고정 mentor 가 통합 때.
- 400 이유 글: 독립 Store/api(기본 `check_doc`)는 pydantic 오류에서 만든 한국어. v2_link 를 거치면 `doc_check` 라 문구까지 같다(바이트 대조 시험).

## 미확인·남은 것

- 운영 자료로는 실행하지 않았다(지시대로 운영 자료 직접 변환 금지). 실제 `runs/app-media` 의 크기·이상 데이터는 미확인이다.
- 연결은 (b) 로 정했다(앱 Codex·고정 mentor): v2_link `--store sqlite:<경로>` 최소 diff 를 이 브랜치에 커밋했고, `sim/` 통합은 고정 mentor 가 호환 검토 뒤 한다. 운영 8792·실제 v2_link 프로세스로는 실행하지 않았다(시험은 v2_link 를 import 해 `Docs`·`open_docs` 를 직접 부름).
- (a) 별도 FastAPI 프로세스는 구현 완료로 보지 않는다 — `server/api.py` 는 TestClient 로만 검증, uvicorn 미설치.
- 이벤트(`events.jsonl`)를 DB 로 옮기는 것은 import 까지만 했다. 실행 중인 v2_link 는 여전히 jsonl 에 쓴다.
- 문서 사이 참조(mission.tmpl → tmpl id, run.wps.photos·note.photo → 사진 파일)는 v2_link 와 같이 **강제하지 않는다**. 지워진 양식·사진을 가리킬 수 있다. 막을지는 제품 결정이다.
- starlette 가 `httpx` 대신 `httpx2` 를 권하는 DeprecationWarning 을 낸다. 시험 클라이언트 쪽 경고일 뿐 동작과는 무관하다.
- 생성 TS 는 타입일 뿐 런타임 검증이 아니다. 화면 쪽 런타임 검사(예: JSON Schema 검사기)는 화면 담당이 정한다.

## 제안(코드 미변경): watchdog·ROS 와 웹/DB/영상 분리

**현재(v2_link 실측):**
- `rclpy.spin` 은 별도 스레드에서 돈다.
- 20 Hz `tick`(Core.applied → `/v2_live/cmd_vel` 발행 + STOP 재전송), 10 Hz WS `push`, 사진 저장 `media.photo`(JPEG 파일 쓰기)가 **모두 같은 Tornado IOLoop** 에서 돈다. 문서 쓰기만 executor 로 나가 있다.
- 그래서 IOLoop 이 막히면 cmd_vel 발행 간격도 같이 벌어진다. 원인이 될 수 있는 것: 큰 WS 쓰기, 디스크 지연, 느린 JSON 직렬화.

**경계 제안:**
1. `ControlLoop` 스레드 하나만 `core.applied()`·`want_stop_pub()` 를 부르고 `pub_cmd`·`pub_stop` 으로 발행한다. 주기는 `time.monotonic()` 기준 50 ms, 밀리면 따라잡지 않고 다음 칸으로 간다. 웹 쪽은 `snapshot` 읽기와 `core.cmd/stop/...` 호출만 한다(지금과 같은 `lock`, 짧게).
2. `lock` 안에서는 IO 를 하지 않는다. 사진 JPEG 쓰기는 executor 로 보낸다(지금 문서 쓰기처럼). DB·영상 인코딩도 조종 lock 을 잡은 채로 하지 않는다.
3. 웹 이벤트 루프·DB·영상 프로세스는 watchdog 을 소유하지 않는다. 이들이 죽거나 멈추면 입력 끊김 0.3 s 규칙에 따라 Core 가 0 을 낸다. 그 0 을 발행하는 쪽이 ControlLoop 하나라서, 웹이 멈춰도 0 발행은 계속된다.
4. 발행 간격 자체를 기록한다(최대 지연 히스토그램을 사건이나 status 에). 개선됐다는 주장은 이 숫자로만 한다.

**작동 원리와 한계:**
- 이 분리로 줄어드는 것은 «웹 작업이 발행을 막는» 경로 하나다.
- Python GIL·OS 스케줄링·DDS 전달 지연은 남는다. 그래서 **실시간 보장은 아니다.**
- 최종 안전망은 받는 쪽(시뮬·로봇)의 명령 TTL 이다(`ttl_s`·`ttl_expired`).
- STOP 명령 0 은 물리 정지가 아니다(실험에서 3.6 s·0.32 m 를 더 이동, 원인 미확정).
- 구현은 `sim/` 수정이라 고정 mentor 와 합의한 뒤에 한다.

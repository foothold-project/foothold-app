# W3-B 실시간 서버 검증 기록

2026-10-19, `feature/server-realtime`, 기준 `origin/dev` = `6b024c98c2f78c0f7506fefaa92814dd8ba00339`.
소유 경로 `apps/server/**`, `apps/contracts/**`만 변경했다. 기존 안전 Core·셀프테스트·명세 파일 변경 0.
이 기록은 기능 브랜치의 모의·DB 검증이며 통합 dev 후보나 배포 검증이 아니다.

## 구현

- `fh_server/leases.py`: I/O 없는 중재기와 주입 단조 시계/ID 생성기. 사용자·기기·연결별 lease,
  take/request/respond/release/hidden/heartbeat, 요청 기본 10 s·거절/TIMEOUT부터 30 s 제한,
  유효 cmd부터 15 s 만료, seq 증가·50 ms 제한, stop_gen CAS.
- 넘김·최초 take: 서버 holder 폐기 → 에이전트 lease null → STOP → 2 s 안의
  `latched=true`, `applied=[0,0,0]`, 증가한 stop_gen → 새 lease. 미확인·늦은 확인은 FREE.
- `fh_server/realtime.py`: 두 WS·HTTP STOP, Origin/쿠키 또는 앱 Bearer 인증,
  기존 `authorize` 함수의 ROBOT_READ/O_OWN/ROBOT_SUMMARY 정책 재사용.
  수신·전송·주기 감시에서 세션 폐기·담당 변경을 확인한다. lease_id는 해당 연결에만 전송한다.
- STOP/cmd는 읽기 전용 독립 DB 풀을 쓴다. 조직/세션/로봇 쓰기 잠금과 `last_seen_at` 갱신을 타지 않는다.
  송신 큐에 먼저 넣고, lease_log/events는 별도 풀의 작업자가 기록한다.
  감사 큐 포화는 조종권을 비우고 새 조종을 거부한다. 감사 DB 잠금은 제한 시간 뒤 같은 건을 재시도한다.
- 에이전트 hello, 1 s ping, 마지막 수신부터 3 s 끊김, 중복 연결 교체,
  재연결 사람 lease 폐기·진행 중 run 사본 PAUSED, 정지 확인 뒤 RUN 예약.
  실행·지도·media는 검증된 빈 확장 지점이며 실제 실행/파일 처리는 구현하지 않았다.
- 조직당 PostgreSQL 세션 소유 잠금을 얻은 중재기 하나만 WS를 연다.
  다른 서버의 REST 인증·계정 처리는 허용하되 WS는 1013, HTTP STOP은 503이다.
  소유 잠금 소실은 FREE·연결 닫기로 처리한다. 이 소유 잠금은 STOP/cmd 경로와 무관하다.
- 총괄 전용 agent-token 재발급 API는 토큰을 한 번 반환하고 sha256만 저장한다.
  기존 0001의 `robots.agent_token_hash`를 사용한다(조정 승인). 새 `0004_lease_log`는
  조직 FK·op CHECK·INSERT/SELECT 전용 역할 권한과 시퀀스 권한을 추가한다.
- Pydantic 메시지 모델 → JSON Schema/TS 생성물. 원시 토큰·DB URL·운영 자료를 추가하지 않았다.

## 실행 결과

Python 3.12.3, 전용 venv, pgserver wheel PostgreSQL 16을 사용했다.
PostgreSQL은 기존 시험 도구 그대로 전용 임시 Unix socket·임시 포트에서만 실행하고 종료했다.
WS는 Starlette의 프로세스 내 ASGI 시험 연결이며 네트워크 포트를 열지 않았다.
운영 8453/8792·ROS·Gazebo·운영 서버·실기 접촉 0.

| 명령 | 결과 |
|---|---|
| `apps/server/.venv/bin/python -m pytest apps/server -q` | 133 passed (기존 100 + 신규 33) |
| `apps/server/.venv/bin/python -m pytest apps/server/tests/test_migrations.py -q -s` | 1 passed; upgrade head → downgrade base → upgrade head, ORM 차이 0 |
| `apps/server/.venv/bin/python apps/contracts/generate.py --check` | 생성물 60개 일치 |
| `npm ci --prefix apps/contracts --ignore-scripts` | 성공 |
| `npm run --prefix apps/contracts typecheck` | tsc 성공 |
| `apps/server/.venv/bin/python apps/server/tools/check_realtime_mutations.py` | 12/12 assertion 실패로 검출 |
| `python3 sim/v2_link.py --selftest` | 원본 변경 없이 selftest OK |
| `git diff --check` | 성공 |

pytest의 Starlette/httpx 사용 중단 안내 1건은 기존 안내다. 기존 100개 시험은 유지했으며,
기존 `test_migrations.py`의 예상 테이블 목록에만 새 `lease_log`를 추가했다.
새 순수 시험 12개와 WS/DB 시험 21개가 시간 경계·권한·송신·정리 경로를 검사한다.

| 수용 항목 | 근거 |
|---|---|
| 10 s TIMEOUT·30 s 제한·15 s heartbeat | `test_leases.py`, WS 요청/결과/429 시험. 단조 시각을 유지하고 별도 UTC를 역/정 보정 |
| 넘김 순서·latched/applied/세대 확인·실패 FREE | 순수 시험 + 실제 ASGI WS에서 lease null/stop/새 lease 순서·낡은 state 거부 |
| hidden/release 즉시 폐기 | 순수 시험과 WS 송신 관측 |
| 다른 조직·담당 밖 sub/cmd | WS 닫기 4403, STOP은 조직 안 다른 담당자의 로봇에도 허용 |
| cmd lease_id/seq/50 ms, unlock CAS | 순수 경계 시험과 WS 오류/에이전트 수신 관측 |
| DB 쓰기 잠금 중 STOP/cmd | 조직·세션·로봇 행 FOR UPDATE + events SHARE 잠금 유지 중 각각 0.75 s 안 에이전트 수신; 잠금 해제 뒤 사건 기록 |
| 3 s 무수신·1 s ping·재연결 PAUSED | 주입 시계의 정확한 3 s 경계, hello 사본 폐기, RUN 예약 확인 |
| 서버 재시작 FREE·중재기 중복 방지 | 기존 런타임 종료 후 새 앱 hello의 옛 lease 무시, 다른 서버 WS 거부·소유 잠금 소실 FREE |
| 토큰/세션/담당 변경 | 토큰 hash/no-store/구 토큰 무효, 로그아웃 4401·권한 변경 4403·lease 폐기 |
| 감사 권한 | 실제 fh_app에서 lease_log UPDATE/DELETE/TRUNCATE 거부·조직 혼합 FK 거부 |

최종 전체 회귀 전에 추가한 소유 잠금의 최초 버전이 REST 다중 클라이언트의 시작까지 막아
17 failed/115 passed를 냈다. WS 권한만 단일 소유로 제한하고 중첩 lifespan을 참조 계수로 관리해
기존 인증·계정 동시성 시험을 다시 실행했다. 실패를 통과로 간주하거나 기존 기대값을 낮추지 않았다.

## 일부러 깨뜨린 안전 판정

`tools/check_realtime_mutations.py`는 임시 패키지 사본만 바꾼다.
기준 사본의 시험 통과 뒤 각 변이에서 pytest assertion 실패가 나야 검출로 센다(수집 오류 제외).

| 깨뜨린 판정 | 결과 |
|---|---|
| 요청 기본 10 → 20 s | 검출 |
| TIMEOUT 뒤 30 s 제한 제거 | 검출 |
| heartbeat 15 → 30 s | 검출 |
| 중복 seq 허용 | 검출 |
| 50 ms 간격 검사 제거 | 검출 |
| unlock stop_gen CAS 제거 | 검출 |
| 낡은 stop_gen으로 넘김 허용 | 검출 |
| 적용 속도 0 확인 제거 | 검출 |
| latched 확인 제거 | 검출 |
| 2 s 이후 늦은 정지 확인 허용 | 검출 |
| lease null 대신 옛 lease 유지 | 검출 |
| 연결 단위 소유 확인을 사용자 단위로 약화 | 검출 |

이 결과는 선정한 12개 판정의 검출이며 모든 결함 검출을 뜻하지 않는다.

## 문서 모호점·조정 결정 (명세 파일 수정 0)

1. 05 §9/§10 경로와 §1 인증 표는 조정 결정으로 `/api/v1/ws`, `/api/v1/agent/ws`,
   웹 쿠키+Origin·앱 Bearer를 쓴다. 티켓은 만들지 않았다. 프로토콜 이름은 협상 헤더 대신
   첫 메시지/hello의 proto 필드이며 불일치는 4403으로 닫는다.
2. `robots.agent_token_hash`는 이미 0001에 있다. 중복 마이그레이션 없이 재사용하는 조정 승인을 받았다.
   등록 CRUD는 별도 범위이며 기존 등록 로봇의 토큰 발급/교체는 총괄 API 하나로 제공한다.
3. 요청 제한은 기본 10 s와 조직 설정 5~30 s를 함께 지원한다. cmd만 15 s heartbeat를 갱신한다.
   WS의 HTTP 상당 오류 상태는 reply.error.detail.status에 담는다(429 LEASE_REQUEST_COOLDOWN 포함).
4. 정지 확인 실패에 해당하는 §9.3 result 값이 없다. `CANCELED`와 `error=STOP_CONFIRM_FAILED`를 보낸다.
   최초 take에도 같은 정지 확인 관문을 적용해 잠금 상태로 시작한다.
5. §10 state.pose에는 §3 Location의 map_version_id가 없다. 지도 판을 추측하지 않고 화면 location은
   null로 둔다. 배터리 SOC 미수신은 null, 수신 시각은 서버 UTC로 표기하며 latency_ms는 미측정 null이다.
6. hello의 진행 중 실행을 PAUSED로 맞추는 것은 이번 범위에서 메모리 사본뿐이다.
   runs 표·실행 계획·시나리오·지도·업로드·영상 바이너리·photo 요청 처리는 후속 담당 범위다.
   서버 재시작 후 RUN 사본도 정지 확인 전에는 lease를 주지 않는다.
7. STOP 즉시 송신과 감사 DB 대기는 분리된다. 감사 큐의 프로세스 종료 내구성·사건 ACK/중복 제거 계약은 없다.
   정상 시험은 큐 drain 후 DB 기록을 확인했으며 강제 종료 중 미기록 사건 보존을 주장하지 않는다.
8. seq의 wire 상한·JS 안전 정수 범위, 원격측정 스키마의 상세 판정·실측 RTT,
   실행 lease와 run_id 연결·자동 재개/잠금 해제는 후속 계약 사항이다.

## 에이전트와 어긋남·후속 통합

`origin/feature/agent-link`의 `42266b1`에서 `link/session.py`, `LINK-VALIDATION.md`를 읽기만 했다.
`apps/agent/**` 수정·가져오기·통합 실행은 하지 않았다.

- W3-A는 측정 전 pose/battery/speed를 null로 보낸다. 서버가 이를 수용하고 화면용 값을 정규화했다.
  W3-A의 소문자 사건 severity도 받아 DB에는 대문자로 저장한다. proto·lease·stop·state 확인 형식은 맞는다.
- W3-A는 같은 소켓에서 무수신 뒤 회복해도 새 hello를 보낼 수 있다. 이 서버는 두 번째 hello에서
  1012로 닫아 실제 재접속과 토큰 재확인을 요구한다. 재접속 때까지 사람 lease를 복원하지 않는다.
- W3-A의 RUN 진행 표기는 RUNNING이고 DB 설계 실행 상태는 MOVING 등이다. 서버는 재연결 사본을
  PAUSED로만 정규화한다. 실제 실행 상태 변환·영속화는 후속 실행기 통합에서 확정해야 한다.
- streams/map/media 실행은 양쪽 모두 실제 처리를 하지 않는다. 지도 좌표·영상 전송을 지원한다고 쓰지 않는다.
- 이 서버의 ASGI 가짜 에이전트 검증은 W3-A 클라이언트와의 실제 WSS 통합 검증을 대신하지 않는다.
  두 PR 통합 뒤 조정 세션에서 별도 통합 시험이 필요하다.

## 남은 관문·되돌림

실제 HTTPS 프록시·브라우저·설치 앱·실폰·ROS·실로봇·정지 거리·네트워크 지연·20 Hz 부하·
DB 장애 중 큐 포화·강제 종료 감사 내구성·실제 W3-A 상호운용은 미검증이다.
기능은 Draft PR이며 안전 범위의 Claude·Codex 두 모델 검토와 조정 세션의 dev 합침이 남는다.
배포·서버 재시작·운영 설정·main 변경을 수행하지 않았다.
코드는 PR 변경 커밋을 revert한다. 자료가 있는 DB의 0004 downgrade는 lease_log 삭제를 동반하므로
감사 기록 백업과 승인된 별도 이관 계획 없이 실행하지 않는다.

## PR #10 Claude 검토 수정 (2026-10-19)

아래가 현재 구현·검증의 기준이다. 위의 133개/60개/12개 결과와 맞물림 차이는 최초 제출
`717c664`의 기록이며, 아래 수정에서 달라진 동작은 이 절과 README를 따른다.
소유 경로는 계속 `apps/server/**`, `apps/contracts/**`이고 `apps/agent`·정본 명세·기존 안전 Core는 수정하지 않았다.

| 지적 | 수정 | 고침을 빼면 실패하는 회귀 시험 |
|---|---|---|
| B1 감사 폭주·영구 failed | 반복 거부·STOP·에이전트 사건은 첫 건+1 s 집계, 전역 첫 사건 20/s·256 키 한도; 연결 수신 100/s·순간 100개. 큐 포화는 FREE 통지·조종 차단만 하고 STOP/접속은 유지하며 큐 1/4 미만에서 자동 복귀·누락 수 요약 | `test_b1_repeated_denied_stop_agent_events_bounded_and_new_take_survives`, `test_b1_full_queue_revokes_notifies_keeps_stop_and_recovers`, `test_b1_real_ws_cmd_and_stop_floods_allow_fresh_take`, `test_b1_connection_ingress_bound_closes_flooder_only` |
| B2 cmd 뒤 DB 읽기에 STOP 대기 | WS 수신·송신에 DB 대기 없음. 연결 시 인증과 100 ms 감시가 갱신한 권한 스냅숏을 사용; STOP/lease는 대기 cmd 폐기, cmd도 최신 하나만 남김. 500 ms 낡은 캐시는 새 조종 금지·기존 STOP 범위 유지 | `test_b2_stop_bypasses_slow_db_and_twenty_queued_commands`, `test_safety_enqueue_discards_pre_stop_commands`, `test_stale_authorization_blocks_motion_but_cached_stop_remains_immediate` |
| B3 WS 라이브러리 누락 | requirements에 `websockets==15.0.1`, 실제 uvicorn의 화면/에이전트 101 업그레이드와 STOP 중계 시험 | `test_readme_uvicorn_really_upgrades_screen_and_agent`, `test_deployment_pins_websocket_backend_and_wire_size` |
| R1 처리 지터로 정상 명령 거부 | 25/s·순간 3개 토큰 버킷, 증가하는 seq의 0 입력은 예산 초과에도 전달 | `test_twenty_hz_with_processing_jitter_has_no_false_rejections`, `test_cmd_lease_sequence_and_fifty_ms_boundaries` |
| R2 앞선 미보고 STOP 세대 | 아직 state로 확인하지 못한 STOP도 세대 하한에 누적하고 넘김의 추가 STOP까지 확인 | `test_pending_stop_generation_cannot_confirm_later_transfer` |
| R3 인증 거부 시 즉시 lease 폐기 | 4401/4403을 보내기 전에 actor의 holder·transfer·request 정리, finally에서도 방어 | `test_r3_deny_screen_revokes_before_socket_close_io`, `test_r3_auth_close_revokes_before_watch_can_be_cancelled` |
| R4 FREE 통지·소유 잠금 회복 | 공통 revoke를 통해 화면에 FREE 통지. 소유 잠금 소실 후 500 ms 주기 재획득, 성공 후에도 옛 lease는 복원하지 않음 | `test_r4_emergency_notifies_and_authority_recovers` |
| R5 최초 take 취소 결과 | 요청 ID 없는 take도 STOP 취소 시 `lease.result(CANCELED, request_id=null)` | `test_stop_cancels_initial_take_with_result` |
| R6 자율 실행 인수 감사 | `RUN_PAUSE_TAKEOVER` lease_log/events 기록 | `test_r6_run_takeover_and_i1_bound_run_lease` |
| R7 전송·로봇별 DB 읽기 증폭 | 세션별 갱신 공유, 스냅숏 SELECT 2회(로봇 수 무관). 수신/송신은 최신 캐시만 검사 | `test_r7_delivery_checks_cached_policy_without_db`, `test_r7_policy_load_batches_robot_checks_into_two_reads` |
| R8 WS 수신 메모리 상한 | README uvicorn 실행에 `--ws-max-size 4096` | `test_deployment_pins_websocket_backend_and_wire_size` |
| R9 조작 거부로 전체 연결 닫힘 | sub·인증 거부만 닫고, 권한 없는 hidden/cmd 등은 reply.error 후 연결 유지 | `test_r9_invalid_hidden_replies_without_closing`, 기존 조직/담당 경계 시험 |
| R10 조종권 감사 색인 | 새 0005에 `(org_id, robot_id, at DESC)` 색인, 기존 감사 자료 변경 없음 | `test_r10_lease_history_index_exists`, Alembic 왕복/ORM 비교 |
| I1 실행 지정 없음 | 에이전트 wire lease는 `RUN:<run_id>`, AgentLease 계약은 USER 또는 RUN:UUID만 허용 | `test_r6_run_takeover_and_i1_bound_run_lease` |
| I2 에이전트 형식 오류 재접속 루프 | 추가 필드는 무시, 잘못된 본문/JSON은 사건으로 묶고 버림. 문자열 t 봉투만 수신 생존 갱신; 잘못된 본문은 lease·세대를 바꾸지 않음. 최초 hello 제한 3 s·명시적 proto 불일치 거부는 유지 | `test_i2_invalid_agent_body_unknown_fields_and_binary_do_not_close`, `test_i2_liveness_only_parseable_envelopes` |
| I3 영상 미구현과 구독 충돌 | 모든 streams false, 이진 프레임은 버리기만 함 | `test_i3_streams_remain_disabled`, I2 형식 시험 |
| I5 severity 대소문자 | 에이전트 소문자/대문자 입력 수용·저장은 대문자 | I2 형식 시험에서 warn → WARN 사건 저장 |

### 추가 변이 11개 누락 보완

| 기존 누락 판정 | 새 시험 |
|---|---|
| respond 조종권자 확인 | `test_only_current_holder_may_respond` |
| 넘김 중 take 차단 | `test_take_cannot_steal_transfer` |
| 넘김 중 request 차단 | `test_request_blocked_during_transfer_even_with_stale_holder_copy` |
| 대기 요청 2건 차단 | `test_only_one_pending_request` |
| transferee hidden 정리 | `test_transferee_hidden_cancels_unfinished_transfer` |
| disconnect의 transfer 정리 | `test_disconnect_pending_transfer_is_revoked` |
| disconnect의 request 정리 | `test_disconnect_pending_request_is_canceled` |
| STOP/lease의 cmd 폐기 | `test_safety_enqueue_discards_pre_stop_commands` |
| 요청자 연결 소실 시 수락 차단 | `test_disconnected_requester_cannot_be_granted_even_before_cleanup` |
| failed 상태 조작 차단 | `test_failed_runtime_refuses_existing_connection_control_but_allows_stop` |
| 감사 큐 포화 시 FREE | `test_b1_full_queue_revokes_notifies_keeps_stop_and_recovers` |

추가로 전달 단계 권한 검사와 교체된 에이전트 state 처리 함수를 각각 단독 시험했다.
전송·캐시·수신·큐·복구·계약/의존성까지 변이 도구가 바꾸며, 수집 오류는 검출로 세지 않는다.
중복 방어가 있던 인증 닫기 경로의 최초 변이는 finally 정리 때문에 통과했다. 닫기 I/O 전에
폐기돼야 한다는 독립 시험을 추가해 즉시 폐기와 finally 방어를 따로 검증했다.

### 수정 후 실행 결과

- `apps/server/.venv/bin/python -m pytest apps/server -q`: **166 passed**, 안내 1건.
- `apps/server/.venv/bin/python apps/server/tools/check_realtime_mutations.py`: **50/50 검출**, 수집 오류 0.
  최초 12개 중재기 변이에서 50개로 확장했으며 `realtime.py`·계약·의존성·마이그레이션도 포함한다.
- `test_realtime_review.py`: 23 passed; 이전 133개 기대 중 R1/R9/I1/I3의 의도 변경만 맞췄다.
  기존 인증·동시성·안전 Core 시험의 기대값은 낮추지 않았다.
- DB 갱신에 100 ms 지연을 주입하고 같은 연결에 cmd 20개 뒤 STOP을 넣은 시험에서
  에이전트 도착 100 ms 상한을 통과했다. 대기 cmd 폐기는 별도 송신 큐 시험으로 확인했다.
- 감사 입력 60,000건(거부·STOP·에이전트 각 20,000건)은 쓰기 작업자를 멈춘 상태에서
  큐 3건 이하로 남았다. 실제 WS의 cmd/STOP 폭주는 해당 연결만 제한한 뒤 새 연결 take까지 확인했다.
- 실제 PostgreSQL Alembic `upgrade head → downgrade base → upgrade head`: 1 passed, ORM 차이 0.
- 생성물 61개 일치, `tsc --strict --noEmit`: 성공.
- 기존 `python3 sim/v2_link.py --selftest`: 원본 수정 없이 selftest OK.
- 깨끗한 임시 venv에 `requirements-test.txt`만 설치한 뒤 `test_ws_deployment.py`: 2 passed.
  실제 uvicorn을 사전 bind한 127.0.0.1 임시 fd/포트로 시작해 두 WS의 101, lease와 STOP 전달을 확인했다.
  시험 뒤 uvicorn·임시 PostgreSQL·venv를 종료/제거했다. 운영 포트·ROS·Gazebo·실기 접촉 0.

HTTP STOP의 최초 인증·CSRF 확인은 DB 조회를 유지한다. B2의 수신 순서·100 ms 상한 검증은
이미 인증된 WS 연결을 대상으로 하며, 무인증 HTTP 요청에 정지를 먼저 허용하지 않는다.
WS 캐시는 감시 주기와 DB 응답 시간만큼 권한 변경 반영이 늦을 수 있다. 500 ms가 지나면
조종 입력은 멈추고, 이미 검증한 세션/로봇의 STOP은 느린 갱신에 묶지 않는다.
감사 큐와 집계 창은 메모리이며 프로세스 종료 내구성을 새로 보장하지 않는다.
추가 필드 수용·영상 비활성화·RUN ID 표기는 서버에서만 수정했고 실제 W3-A 재통합은 별도 관문이다.

### 수정 후 변이 실행 표

| Broken decision | Detection |
|---|---|
| request timeout 10 -> 20 | detected |
| TIMEOUT cooldown omitted | detected |
| lease heartbeat 15 -> 30 | detected |
| duplicate seq accepted | detected |
| command budget removed | detected |
| unlock CAS removed | detected |
| stale stop generation accepted | detected |
| nonzero applied accepted | detected |
| latch check removed | detected |
| late transfer ack accepted | detected |
| lease null replaced by stale lease | detected |
| connection binding weakened | detected |
| respond holder check omitted | detected |
| take allowed during transfer | detected |
| request during transfer | detected |
| second pending request allowed | detected |
| hidden transferee not revoked | detected |
| unreported earlier STOP ignored | detected |
| initial take cancel not notified | detected |
| strict 50 ms gate reintroduced | detected |
| zero input rate rejected | detected |
| disconnect leaves request | detected |
| disconnect leaves transfer | detected |
| safety enqueue keeps stale cmd | detected |
| requester gone accepted | detected |
| failed input gate ignored | detected |
| audit overflow does not revoke | detected |
| delivery policy omitted | detected |
| replaced state handler gate omitted | detected |
| repeat audit aggregation omitted | detected |
| audit overload never recovers | detected |
| STOP waits for DB again | detected |
| auth close retains lease | detected |
| emergency FREE not notified | detected |
| ownership never recovers | detected |
| RUN identity not bound | detected |
| RUN takeover audit omitted | detected |
| invalid agent body disconnects | detected |
| invalid JSON renews liveness | detected |
| streams falsely enabled | detected |
| origin prefix accepted | detected |
| ingress budget omitted | detected |
| WebSocket backend pin omitted | detected |
| transport frame cap undocumented | detected |
| agent severity normalization omitted | detected |
| agent future fields forbidden | detected |
| binary agent frame closes link | detected |
| operation denial closes connection | detected |
| lease audit index omitted | detected |
| stale cache permits motion | detected |

## Claude r2 재검토 N1~N9 수정

검토 대상 `9c6b893` 이후 같은 `feature/server-realtime`에서 수정했다.
검토 보고서의 N1~N9를 모두 읽었으며 명세 문서와 `apps/agent/**`는 수정하지 않았다.
원래 B1~B3·R1~R10·I1/I2/I3/I5 회귀와 50개 변이도 유지한다.

| 지적 | 수정·판단 | 고침을 빼면 실패하는 회귀 시험 |
|---|---|---|
| N1 일시 거부가 실제 HTTP 403 | 소유 잠금 없음·failed·최초 인증 DB 일시 오류는 WS accept 후 1013. 실제 인증 불일치는 기존 403/4403 유지 | `test_n1_busy_is_retryable_1013_over_real_uvicorn`(화면/에이전트), `test_true_agent_auth_denial_stays_forbidden`, 별도 도구의 `test_real_pr8_client_keeps_retrying_after_owner_loss_and_reconnects` |
| N2 낡은 스냅숏에서 FREE 유실 | 송신자가 같은 알림을 보관하고 권한을 다시 읽은 뒤 재검사·전송. 갱신 실패는 재시도하고, 권한 상실은 닫기. 수신/STOP은 이 대기를 공유하지 않음 | `test_n2_stale_free_is_retried_after_snapshot_refresh`: 700 ms DB 지연·낡은 캐시에서 에이전트 끊김 후 FREE 수신 |
| N3 hello 지연으로 영구 중단 | hello 시한 초과만 1013, 명시적 proto 불일치는 기존 거부 | `test_n3_hello_deadline_is_retryable` |
| N4 거부 입력 예산 우회 | JSON 해석 후 모델/권한/busy 검사 전에 예산 소비. 잘못된 에이전트 JSON·binary도 소비 | `test_n4_screen_denials_spend_ingress_before_validation` 4종, `test_n4_agent_invalid_frames_are_budgeted` 4종 |
| N5 포화 시 FREE 뒤 ACCEPTED | effect 목록 적용 중 감사 포화는 표시만 하고 가장 바깥 목록 완료 후 emergency FREE | `test_n5_overflow_free_follows_entire_accepted_effect_batch`: 실제 TAKE 감사 포화에서 양쪽 화면 ACCEPTED < 마지막 FREE |
| N6 시작 때 standby 영구 대기 | 처음 소유 잠금을 못 얻어도 감시/재선출 실행. README에 두 WS 경로를 실시간 소유자에게 보내는 라우팅 조건 명시 | `test_n6_startup_standby_acquires_after_owner_stops` |
| N7 DB 오류 한 번에 전체 끊김 | 신선한 권한 캐시는 단발 DB 오류 동안 유지·재시도. 500 ms 낡으면 lease 폐기·새 조종 차단·STOP 유지. 마지막 정상 판정부터 5 s가 지난 오류에서는 1013. 소유 확인 오류는 즉시 FREE지만 연결/STOP 유지·재확인 | `test_n7_single_policy_db_error_retries_without_dropping_lease`, `test_n7_single_agent_auth_db_error_keeps_connection`, `test_n7_unknown_ownership_frees_but_keeps_stop_and_rechecks`, `test_n7_stale_policy_revokes_motion_but_preserves_stop_during_retry`, `test_n7_stale_agent_auth_blocks_authority_but_stop_is_still_forwarded`, `test_n7_retry_grace_is_bounded_and_closes_temporarily`, `test_n7_stale_successful_read_is_not_a_permanent_authorization_denial` |
| N8 RUN 인수 중복 RELEASE | 사용자 없는 RELEASE를 생략하고 RUN_PAUSE_TAKEOVER와 확인 후 TAKE를 유지. 실행 예약 RUN_TAKE와 별개의 의도가 있는 기록만 남김 | `test_n8_run_takeover_has_no_duplicate_release`: RUN_TAKE → RUN_PAUSE_TAKEOVER → TAKE 정확한 3행 |
| N9 사건 backlog로 재접속 반복 | 유효 사건만 별도 100/s·순간100 예산. 초과는 연결을 유지하며 AGENT_BACKLOG_SAMPLED로 수를 집계하고 버림. 매 사건 후 event loop 양보, state·정지 확인의 예산을 소모하지 않음 | `test_n9_backlog_events_do_not_disconnect_or_starve_state`: 사건 500개 뒤 state 반영·lease/연결 유지·감사 큐 상한·초과 집계 확인 |

### N7 완화의 안전 기준

- DB 단발 오류를 실제 인증 거부와 구별한다. 화면/로봇 권한의 마지막 성공 시각은
  단조 시계로 검사하며, 새 cmd/unlock/non-null lease·넘김 확인은 500 ms 낡은
  로봇 인증이나 확인 중인 소유권을 사용할 수 없다. 화면 권한도 같은 상한이다.
- 낡은 권한을 감시가 발견하면 holder/transfer를 폐기한다. 기존에 인증·허용된 범위의
  STOP과 lease null은 캐시의 신선도·DB 재시도를 기다리지 않고 계속 중계한다.
  화면 송신자가 알림 재확인을 기다리는 동안에도 별도 수신 경로로 STOP이 즉시 나감을 시험했다.
- 소유 잠금 판정이 불명확하면 조직 전체를 즉시 FREE로 두며 새 조종을 막는다.
  확인된 소유 잠금 소실은 원래처럼 FREE+1013이고, 재획득 뒤 옛 lease는 복원하지 않는다.
  단순 확인 쿼리 오류에서는 기존 연결을 남겨 STOP을 전달하고 재확인을 시도한다.
- 마지막 정상 권한 판정부터 5 s 이상 확인되지 않으면 1013으로 닫는다. 소유권 확인은
  첫 오류부터 5 s를 기준으로 한다. 이 기준은 DB 호출 반환 때 검사하며 각 읽기의
  statement_timeout 2 s가 별도로 적용된다. 5 s를 정확한 wall-clock 닫기 상한으로 주장하지 않는다.
  송신 알림 재확인은 자체 5 s timeout도 적용한다. 단발 오류로 전체 현장을 재접속시키는
  비용을 줄이되, 오래된 권한으로 움직이는 유예를 늘리지 않으려는 선택이다.
- 실제 토큰 불일치·세션 폐기·권한 상실은 유예 없이 원래의 4401/4403이다.
  성공했지만 낡은 스냅숏도 POLICY_STALE로 재시도하며 4403으로 잘못 분류하지 않는다.

### 실제 PR #8 Client 맞물림

`apps/server/tools/check_agent_reconnect.py`는 지정 Git commit의 agent package만
`git archive`로 임시 폴더에 읽는다. 에이전트 소스·worktree에는 쓰지 않는다.
실제 uvicorn을 127.0.0.1 임시 fd/포트로 시작하고 기존 임시 PostgreSQL fixture를 사용한다.
시험용 속도 싱크는 모든 출력이 0인지 단언한다.

- 검토 보고서 기준 `4392fc708ad471047bf710dc978c20b903168255`: **1 passed** (6.87 s).
- 현재 PR #8 `e0cd2741ef9aecfc5cdd4c4962044213640a2428`: **1 passed** (최종 재실행 6.67 s).
- 임시 DB의 실시간 소유 세션을 종료 → 다른 연결이 잠금을 점유 → Client에서
  1013 재시도 3회 이상 → 잠금 해제 → 인증된 server ping 복귀를 확인했다.
  기존 오류를 되살린 변이는 실제 Client의 ReconnectForbidden으로 검출한다.
- 실제 uvicorn의 별도 시험 3개는 바쁜 화면/에이전트가 각각 HTTP 101 뒤 1013을
  받는 것과 진짜 잘못된 에이전트 토큰이 HTTP 403인 것을 구분한다.

### 실행 결과·남은 범위

- 전체 pytest: **190 passed**, Starlette 안내 1건 (113.23 s).
- N2~N9 전용 시험: **21 passed**, 실제 uvicorn 거부 코드 시험: **3 passed**.
- 변이 도구: **67/67 검출**, 수집 오류 0. 기존 50개와 r2 17개를 포함한다.
- 원본 수정 없는 기존 `sim/v2_link.py --selftest`: **selftest OK**.
- Alembic `upgrade head → downgrade base → upgrade head`: **1 passed**, ORM diff 0.
- `generate.py --check`: 생성물 **61개 일치**; `tsc --strict --noEmit`: 성공.
- 기존 감사 집계·STOP DB 지연·프로토콜/권한·기존 100개 시험을 포함하며 기대를 낮추지 않았다.

N9는 사건 원본을 모두 저장하는 기능이 아니다. 제한 이내의 사건은 수신 순서로 처리하고
초과 원본은 버린 개수로 집계한다. 집계 키/전역 한도가 겹치면 AUDIT_DROPPED 요약에 포함된다.
PR #8의 Session 미송신 사건 큐 상한과 송신 배압은 `apps/agent/**` 소유 범위라 수정하지
않았으며 조정 세션에 후속 판단 항목으로 전달했다. 에이전트 내부 메모리 상한까지
해결했다고 주장하지 않는다. 실제 DB 재시작·네트워크 장애·TLS/프록시·실폰·로봇·영상은
시험하지 않았다. 운영 8453/8792·Gazebo·ROS·실기 접촉 0이며 배포하지 않았다.
이번 수정에 새 DB migration·메시지 계약 변경은 없다.

### r2 최종 변이 실행 표

| Broken decision | Detection |
|---|---|
| request timeout 10 -> 20 | detected |
| TIMEOUT cooldown omitted | detected |
| lease heartbeat 15 -> 30 | detected |
| duplicate seq accepted | detected |
| command budget removed | detected |
| unlock CAS removed | detected |
| stale stop generation accepted | detected |
| nonzero applied accepted | detected |
| latch check removed | detected |
| late transfer ack accepted | detected |
| lease null replaced by stale lease | detected |
| connection binding weakened | detected |
| respond holder check omitted | detected |
| take allowed during transfer | detected |
| request during transfer | detected |
| second pending request allowed | detected |
| hidden transferee not revoked | detected |
| unreported earlier STOP ignored | detected |
| initial take cancel not notified | detected |
| strict 50 ms gate reintroduced | detected |
| zero input rate rejected | detected |
| disconnect leaves request | detected |
| disconnect leaves transfer | detected |
| safety enqueue keeps stale cmd | detected |
| requester gone accepted | detected |
| failed input gate ignored | detected |
| audit overflow does not revoke | detected |
| delivery policy omitted | detected |
| replaced state handler gate omitted | detected |
| repeat audit aggregation omitted | detected |
| audit overload never recovers | detected |
| STOP waits for DB again | detected |
| auth close retains lease | detected |
| emergency FREE not notified | detected |
| ownership never recovers | detected |
| RUN identity not bound | detected |
| RUN takeover audit omitted | detected |
| invalid agent body disconnects | detected |
| invalid JSON renews liveness | detected |
| streams falsely enabled | detected |
| origin prefix accepted | detected |
| ingress budget omitted | detected |
| WebSocket backend pin omitted | detected |
| transport frame cap undocumented | detected |
| agent severity normalization omitted | detected |
| agent future fields forbidden | detected |
| binary agent frame closes link | detected |
| operation denial closes connection | detected |
| lease audit index omitted | detected |
| stale cache permits motion | detected |
| N1 transient rejection before accept | detected |
| N1 real PR8 reconnect forbidden | detected |
| N2 stale notification discarded | detected |
| N3 hello timeout fatal | detected |
| N4 screen denial bypasses ingress | detected |
| N4 malformed agent bypasses ingress | detected |
| N5 emergency interleaves accepted batch | detected |
| N6 startup standby never elects | detected |
| N7 policy transient disconnects | detected |
| N7 agent auth transient disconnects | detected |
| N7 uncertain ownership disconnects | detected |
| N7 stale policy fails to revoke | detected |
| N7 retry grace unbounded | detected |
| N8 duplicate RUN release restored | detected |
| N9 event backlog disconnects | detected |
| N9 events exhaust control budget | detected |
| N7 stale read mislabeled forbidden | detected |

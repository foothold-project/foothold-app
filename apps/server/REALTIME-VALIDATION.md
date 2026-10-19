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

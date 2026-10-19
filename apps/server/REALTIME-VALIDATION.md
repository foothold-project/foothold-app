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

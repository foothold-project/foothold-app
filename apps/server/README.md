# 관제 서버 — 계정·로봇·실시간·기록

정본: `docs/spec/04-ARCHITECTURE.md`, `05-API-SPEC.md`, `06-DB-DESIGN.md`.
저장소 루트에서 실행한다. Python 3.12, PostgreSQL 16을 사용한다.

## 설치·실행

```sh
python3 -m venv apps/server/.venv
. apps/server/.venv/bin/activate
pip install -r apps/server/requirements-test.txt
```

실제 서비스 DB는 관리자가 별도로 준비한다. 서버 실행 계정은 `fh_app`,
마이그레이션 계정은 `fh_migrate`, 보고용은 `fh_readonly`다.
새 DB의 관리자 DSN과 세 역할의 비밀번호를 환경 변수로 넣은 뒤 최초 한 번 실행한다.
비밀번호·DSN을 셸 이력이나 저장소에 기록하지 않는다.

```sh
python -m apps.server.fh_server.bootstrap roles
alembic -c apps/server/alembic.ini upgrade head
python -m apps.server.fh_server.bootstrap organization
uvicorn apps.server.fh_server.main:app --host 127.0.0.1 --port 8810 --ws-max-size 4096 --workers 1
```

웹 쿠키는 항상 Secure다. 브라우저 사용에는 HTTPS 역방향 프록시가 필요하다.
위 uvicorn은 그 프록시 뒤의 로컬 연결이며, 시험 클라이언트도 HTTPS origin을 쓴다.
API 기준 경로는 `/api/v1`. 마이그레이션은 서버 시작 때 자동 실행하지 않는다.
개발 서버는 사용 뒤 종료한다. 운영 포트·로봇·ROS·Gazebo에는 접속하지 않는다.

| 환경 변수 | 용도 |
|---|---|
| `FH_DATABASE_URL` | API 전용 `postgresql+psycopg://` SQLAlchemy URL (`fh_app`) |
| `FH_MIGRATE_DATABASE_URL` | Alembic·초기 조직 생성용 URL (`fh_migrate`) |
| `FH_ORG_ID` | 첫 판에서 서비스할 조직 UUID; 다른 조직 ID는 조회할 수 없음 |
| `FH_BOOTSTRAP_DATABASE_DSN` | 최초 역할 생성에만 쓰는 psycopg 관리자 DSN (`postgresql://`) |
| `FH_MIGRATE_PASSWORD`, `FH_APP_PASSWORD`, `FH_READONLY_PASSWORD` | 최초 역할 생성 때 주입하는 비밀번호 |
| `FH_ORG_NAME` | 최초 조직 이름 |
| `FH_BOOTSTRAP_USERNAME`, `FH_BOOTSTRAP_DISPLAY_NAME`, `FH_BOOTSTRAP_PASSWORD` | 최초 총괄 계정; 기존 조직은 덮어쓰지 않음 |

서버 환경에는 관리자·마이그레이션 자격 증명을 넘기지 않는다.
API 시작 시 DB 계정의 스키마 생성·사건 변경·삭제 권한과 관리자 권한을 검사하여
과도한 권한이면 시작을 거부한다. `events` 소유자는 `fh_migrate`이고 `fh_app`에는
SELECT/INSERT 및 시퀀스 사용 권한만 부여한다. `fh_app`은 도메인 표에 DELETE 권한이 없다.
예외로 `auth_rate_windows`의 요약 완료 카운터 정리에만 DELETE를 허용한다.
기존 역할이 있으면 bootstrap은 중단하므로 관리자가 역할 상속·기존 권한을 검토해야 한다.

## 구현 범위·계약

- 웹 로그인·로그아웃, `/me` 조회/수정·비밀번호 변경, 계정 관리·기기 세션 폐기.
- 앱 access 15분, refresh 30일. 갱신 때 두 토큰을 회전하며 최초 refresh 만료 시각을 늘리지 않는다.
  사용한 refresh 해시를 세션의 `retired_refresh_hashes`에 보관하고 재사용을 발견하면
  해당 기기 세션을 폐기하고 `SESSION_REVOKED`(`reason=REFRESH_REUSED`) 사건을 남긴다.
  정상 갱신은 `TOKEN_REFRESHED` 사건으로 기록한다. 원문 토큰은 저장하거나 기록하지 않는다.
- 웹 세션 기본 24시간. 로그인 응답의 `csrf_token`을 `X-FH-CSRF`에 넣어 변경 요청을 보낸다.
  새로고침·새 탭에서는 쿠키로 `GET /api/v1/auth/session`을 불러
  `{client: "web", csrf_token}`을 다시 얻는다. 응답은 `Cache-Control: no-store`다.
  CSRF는 HttpOnly 세션 토큰을 키로 한 HMAC-SHA256(고정 메시지 `fh-csrf/1`) 값으로,
  같은 세션의 탭끼리는 같고 재로그인하면 달라진다. DB에는 그 값의 sha256만 저장한다.
  조회 때 다른 탭의 값을 무효화하지 않으며, 이전 골격의 세션은 처음 조회 때 해시를 갱신한다.
  앱 bearer로 조회하면 `{client: "app", csrf_token: null}`이며 인증 토큰은 반환하지 않는다.
  이 경로는 05 §1.2의 웹 쿠키·변경 요청 헤더 규칙을 구체화한 계약이다.
  조정 세션에서 명세의 CSRF 획득 경로를 후속 반영해야 한다. 로그아웃 후 쿠키와 세션을 폐기한다.
  로그인은 JSON 자격 증명, 앱 갱신은 refresh 토큰으로 인증하므로 기존 세션 CSRF를 요구하지 않는다.
- 비밀번호 scrypt n=16384/r=8/p=1. DB에는 세션·refresh·CSRF 원문 대신 sha256만 저장한다.
  `/me/password`의 현재 비밀번호 확인도 계정별 실패 5회/5분으로 제한하며 실패는
  `PASSWORD_CHANGE_FAILED`, 제한 거절은 `PASSWORD_CHANGE_RATE_LIMITED`로 기록한다.
  비밀번호 최소 길이 정책은 미정이며 이번 수정에서는 기존 최소 1글자를 유지한다.
- 잠기지 않고 보관되지 않은 마지막 `ORG_ADMIN`의 강등·잠금·삭제는
  `409 LAST_ORG_ADMIN`으로 거부한다. 조직 행을 잠가 두 총괄의 동시 변경도 직렬화한다.
  인증된 변경 요청은 세션의 `last_seen_at`을 고치기 전에 조직 행을 `FOR NO KEY UPDATE`로 잠근다.
  잠금 순서는 조직 → 필요한 계정 advisory lock → 세션·사용자 수정이다.
  세션을 공유한 탭의 설정·계정·비밀번호 변경도 이 순서를 따른다.
  조직의 키를 바꾸지 않는 잠금이므로 로그인·refresh·감사 기록의 FK `KEY SHARE` 검사는 함께 허용한다.
- 실패 5회/5분을 IP와 계정 각각에 적용한다. PostgreSQL 사건 조회와 트랜잭션 advisory lock을
  사용하여 여러 프로세스·재시작 사이에서도 제한을 공유한다. 실패 5건 뒤 6번째 요청부터 429다.
  제한 거절은 IP 또는 계정 키·UTC 5분 고정 창별로 `auth_rate_windows`의 가변 카운터에 합산한다.
  두 제한이 모두 걸렸으면 IP 키로 합산해, 같은 IP가 username을 바꿔도 사건이 늘지 않는다.
  창이 닫힌 뒤 다음 로그인 또는 현재 비밀번호 확인 요청에서 `count`를 담은
  `LOGIN_RATE_LIMITED`/`PASSWORD_CHANGE_RATE_LIMITED` 사건 **한 행**으로 남긴다.
  매 요청마다 닫힌 창을 최대 100개 처리하며, 창 종료 타이머는 없다. 다음 인증 요청이 없으면
  사건은 아직 생성되지 않고 카운터가 DB에 남는다. 재시작·다중 인스턴스 사이에도 합계가 보존된다.
  사건 INSERT와 카운터 DELETE는 한 트랜잭션이며, 동시 요약은 행 잠금으로 중복을 막는다.
  최초 실패 5건은 그대로 사건으로 남기고, 제한 요약은 실패 횟수 집계에서 제외한다.
  입력 username 원문은 사건에 보관하지 않고 DB와 같은 소문자 정규화 후 sha256 `account_key`로 집계한다.
  IP는 ASGI의 `request.client.host`다. uvicorn은 기본으로 proxy headers를 켜고
  127.0.0.1 프록시를 신뢰하므로 위 실행 예의 로컬 프록시 뒤에서는 X-Forwarded-For가 반영될 수 있다.
  운영자는 `--forwarded-allow-ips`에 신뢰할 프록시만 지정해야 하며, 그 프록시는 외부에서 온
  X-Forwarded-For를 그대로 넘기지 않고 실제 접속 주소로 덮어써야 한다.
  프록시가 주소를 전달하지 않으면 모든 사용자가 프록시 IP 하나의 실패 한도를 공유한다.
- 로그인·실패·로그아웃·계정 변경·조직 설정 변경은 같은 DB에 한국어 사건으로 남긴다.
- 로봇 목록 `scope=mine|all`, 사용자·세션·로봇 목록은 `(created_at, id)` 순서의 불투명 cursor를 쓴다.
  서버가 매 요청 DB의 역할·조직·담당을 확인한다. 요약 보기는 `ROBOT_SUMMARY`,
  담당 로봇의 상세·기록 보기는 `ROBOT_READ`(범위 밖 404), 조종·배정은 `O_OWN`(담당 밖 403)으로 구분한다.
- 조직 설정 GET/PATCH와 명세의 각 범위 검사. 변경은 마지막 저장이 이기며 사건을 남긴다.
- 응답 계약의 모든 시각은 DB 시간대와 무관하게 UTC `Z`로 정규화한다.
  NUL 문자열과 DB 입력 오류는 400 VALIDATION, 그 밖의 DB·서버 오류는 500 INTERNAL_ERROR
  ApiError 형식으로 돌려주며 SQL·입력 원문·예외 상세를 응답하지 않는다.

조정 세션이 확인한 명세 해석: `scope=all`과 `/robots/{id}`는 조직 안 다른 담당자의
로봇도 **관제 요약 객체만** 허용한다. 다른 조직·없는 ID는 404다. 담당 밖의 운영자에게는 식별 정보·담당자만 제공하고 실시간 요약값은 숨긴다
(`connection=UNKNOWN`, 상태·배터리·위치·조종권·실행은 null, 장치·주의는 빈 목록).
담당자·총괄의 목록과 상세에는 현재 에이전트 연결, 마지막 유효 state의 상태·배터리·pose,
중재기의 현재 lease를 반영한다. 연결이 끊기면 OFFLINE이고 status·battery·location은 null,
attention은 OFFLINE만 반환한다. 연결이 살아 있어도 state가 3초 넘게 없으면 측정값은 null이다.
x·y·yaw가 모두 null이면 location도 null이며, 나머지 pose의 null은 보존한다. `map_version_id`가 없으면 null이다. 서버가 지도 판을 추측하지 않는다.
실행 기능이 없어 `current_run=null`이다. `robot_devices`는 hello 및 `devices_changed`로 저장하고,
목록에서 빠진 기존 장치는 MISSING으로 보관한다.

티켓·지도·임무·결재·원격측정 REST API는 구현하지 않았다.
WS·에이전트 연결·조종권·STOP의 구현 범위는 아래 실시간 절을 따른다.
이들을 위한 가짜 응답 경로나 빈 서비스는 만들지 않았다. 계약의 로봇 요약 필드는
미수신 값은 null이며 실행·지도 지원을 뜻하지 않는다.
층·실행·결재 표가 아직 없어 `last_floor_id`, 사건의 `run_id`/`approval_id`는 UUID 열만 두고
해당 FK는 후속 소유 작업에서 추가해야 한다. 조직 내부 사용자의 로봇 담당 FK는 DB에서도 강제한다.

## 시험

```sh
. apps/server/.venv/bin/activate
python -m pytest apps/server -q
python apps/contracts/generate.py --check
npm ci --prefix apps/contracts --ignore-scripts
npm run --prefix apps/contracts typecheck
```

pytest는 venv의 `pgserver` wheel에 들어 있는 PostgreSQL 16 바이너리를 사용한다
([원본 프로젝트](https://github.com/orm011/pgserver)). sudo·Docker·시스템 PostgreSQL은 필요 없다.
매 실행 임시 데이터 폴더·임시 포트 번호·전용 Unix socket을 만들고 DB는 TCP에는 listen하지 않는다.
`FH_TEST_PORT_RANGE=9040:9059`를 지정하면 DB 번호와 실제 uvicorn 시험의 loopback 포트 할당을
그 범위로 제한한다. 지정하지 않으면 OS가 빈 포트를 고른다.
관리자와 별개인 `fh_migrate`로 마이그레이션하고, HTTP 시험은 실제 `fh_app`으로 접속한다.
`finally`에서 PostgreSQL 종료를 기다린 뒤 임시 폴더를 제거한다. SQLite 대체는 없다.

전체 시험에는 실제 DB 권한에 의한 사건 UPDATE/DELETE/TRUNCATE·DDL 차단,
읽기 전용 계정, 앱의 과도한 DB 권한 거부, 인증·권한·CSRF·속도 제한·범위 검사가 포함된다.
같은 쿠키의 설정·계정 변경 40회, 설정·비밀번호 확인 동시 요청, 제한 요청 40회에서
키·창별 카운터 한 행과 정확한 합계의 요약 한 행, 요약 트랜잭션 rollback·재시작도 검사한다.
마이그레이션 왕복만 별도로 보려면:

```sh
python -m pytest apps/server/tests/test_migrations.py -q -s
```

이 명령은 새 PostgreSQL에서 실제 `upgrade head → downgrade base → upgrade head`를 실행한다.
새 빈 DB용 `downgrade base`는 자료를 삭제한다. 운영에서는 백업 후 승인된 이관 절차를 따른다.

## 되돌림·한계

배포를 수행하지 않는 기능 브랜치다. 코드는 해당 변경 커밋을 `git revert`한다.
시험 DB는 폐기 가능하며, 자료가 있는 DB는 덤프와 복원 계획 없이 downgrade하지 않는다.
`0003_auth_rate_windows`를 내리면 아직 요약하지 않은 카운터도 사라지므로 별도 보존 계획이 필요하다.
기존 안전 검사는 `python3 sim/v2_link.py --selftest`로 ROS 없이 실행할 수 있다.
실제 HTTPS 프록시·브라우저·앱·실폰·로봇 연결은 이 시험 범위 밖이다.
로그인 보호는 DB 사건 보존 기간(최소 5분 유지)에 의존하고, 여러 조직 운영·RLS는 후속 범위다.


## 실시간 연결 (W3-B)

로봇 등록은 총괄만 `POST /robots {name, owner_user_id?}`로 한다. 응답은 201
`{robot, agent_token}`과 `Cache-Control: no-store`이며 원문 토큰은 이때 한 번만 반환한다.
DB와 사건에는 sha256만 저장하며 조회·수정 응답에는 토큰이 없다. 기본 model은
`unitree_go2`, hello가 실제 model을 보내면 갱신한다. 담당자는 같은 조직의 잠기지 않은
운영 관리자 한 명 또는 null이다. 총괄의 `PATCH /robots/{id}`로 이름·담당을 바꾼다.
`DELETE /robots/{id}`는 보관 처리로 기록을 유지하며 조종권·넘김·진행 중 실행이 있으면
409 VERSION_CONFLICT다. 삭제 시 토큰을 무효화하고 열린 에이전트 연결을 4403으로 닫는다.
담당 변경·삭제는 실시간 소유 프로세스로 보내야 한다(소유 중재기 없음·변경 중이면 503 SERVER_BUSY).

담당 변경·해제는 기존 `lease=null → stop`을 먼저 enqueue하여 옛 조종권과 대기 요청을
폐기한다. 그 뒤 `{t:"subscription.revoked",robot,reason:"ACCESS_REVOKED"|"ROBOT_DELETED"}`를
보내고 해당 로봇만 구독에서 뺀다. 같은 화면의 다른 로봇 구독과 연결은 유지한다.
화면 proto는 fh-rt/1 그대로이며 기존 웹은 모르는 t를 무시한다(알림 표시는 후속 W2).
세션 폐기는 기존 4401, 명시적인 범위 밖 `sub` 재시도 거부는 기존 4403이다.
새 담당자가 조종권을 자동으로 받거나 총괄이 강제로 인수하는 기능은 추가하지 않았다.
회수됐던 화면이 다시 담당을 받으면 먼저 해당 로봇을 `sub`로 다시 구독해야 한다.
재구독 전 `lease.take`·`lease.request`는 409 SUBSCRIPTION_REQUIRED이며 STOP·ping은 유지한다.

`GET /dashboard`는 총괄에게 조직 전체, 운영자에게 담당 로봇의 total·online·attention을
반환한다. attention은 OFFLINE·배터리 기준 미만·ERROR·STOP_LATCHED·장치 ERROR 중
하나라도 있는 로봇 수다(중복 합산 없음). `robots_running=0`, `approvals_pending=0`은
실행·결재 구현 전의 값이다. `operators`는 총괄에게 운영자별 담당 로봇 수를, 운영자에게
빈 배열을 반환한다. 장치 저장은 migration 0006으로 추가한다.
장치 오류는 목록·상세·dashboard 모두 연결된 에이전트의 최신 장치 목록을 기준으로 한다.
DB의 옛 ERROR가 현재 목록에서 빠졌으면 MISSING이며 주의로 세지 않는다.
장치 저장은 수신 루프와 별개의 연결·작업자(각 2개)에서 처리한다. 로봇별 실행 중 1개·최신 대기
1개만 유지하고 동일 목록을 다시 쓰지 않는다. 저장 실패는 AGENT_INVENTORY_FAILED 사건이며
state·STOP 확인·ping 수신이나 조종권을 끊지 않는다. hello·state의 중복 장치 key는 거부하고
잘못된 hello는 AGENT_INVALID_HELLO로 기록한다.
마지막 snapshot 저장 실패는 1초 간격으로 최초 시도 포함 최대 3회 시도한다. 소진된 동일
snapshot의 반복 state는 재시도를 재개하지 않으며, 변경된 snapshot 또는 재연결 hello는 새
한도로 저장한다. 실패 시마다 사건을 남기고 더 최신 snapshot이 있으면 그것을 우선한다.
hello의 non-null 모델은 같은 연결 세대의 후속 state에 보존한다. 단절·삭제·토큰 변경 때
이전 세대의 대기/재시도/모델을 폐기하며, 이미 실행 중인 쓰기는 토큰·보관 상태를 검사한다.

회수 시 해당 로봇의 대기 비공개 프레임을 지우며, 송신 lock을 얻은 뒤에도 로봇별 세대·권한을
검사한다. 안전 출력 뒤 기존 fh-rt/1 lease-null을 먼저 보내고 subscription.revoked를 보낸다.
다른 로봇 큐는 유지한다. 보관 삭제 tombstone과 담당 변경 판정 시각은 권한 감시 유예보다 긴
6초 뒤 정리하고, 단절된 로봇의 metadata 작업은 실행 중 작업을 마친 뒤 제거한다.

하나의 조직은 서버 프로세스 **1개**로 실행한다(`uvicorn --workers 1`).
시작 때 전용 PostgreSQL 세션 advisory lock을 얻은 프로세스만 실시간 중재기를 연다.
다른 프로세스는 REST 조회·인증을 제공할 수 있지만 WS는 **수락한 뒤 1013**, HTTP STOP은
503으로 거부한다. 수락 전 WS 닫기는 uvicorn에서 HTTP 403이 되어 인증 거부와 혼동되므로
일시적인 거부에는 쓰지 않는다. 앞단은 두 WS 경로를 같은 실시간 소유 프로세스로 보낸다.
임의의 REST 복제본으로 계속 분산하면 잠금을 기다리는 클라이언트의 재시도만 늘어난다.
이 잠금은 STOP·cmd 경로와 분리돼 있다. 잠금 소실을 확인하면 FREE를 알리고 연결을 닫으며,
시작 때 잠금을 못 얻은 프로세스도 포함해 500 ms 주기로 재획득을 시도한다.
성공해도 옛 lease를 복원하지 않는다. 잠금 확인의 일시 DB 오류는 즉시 FREE로 전환하되
기존 연결과 STOP을 유지하며 최대 5 s 동안 재확인한다.
서버를 새로 시작하면 사람 조종권·요청·재요청 제한은 모두 메모리에서 새로 시작한다.

- 화면: `/api/v1/ws`. 웹은 `fh_s` 쿠키와 정확한 Origin 일치, 앱은 Bearer.
  프록시 뒤에서는 `FH_WS_ORIGIN=https://<화면 출처>`를 명시한다(와일드카드·경로 없음).
  첫 메시지는 `proto: "fh-rt/1"`을 포함한다. 예: `{t:"ping",id:"…",proto:"fh-rt/1"}`.
- 에이전트: `/api/v1/agent/ws`, 로봇 전용 Bearer, 최초 `hello.proto="fh-agent/2"`.
  두 프로토콜 이름은 WS subprotocol 협상 헤더에 넣지 않는다.
  한 연결의 텍스트 JSON은 4 KiB까지다. 영상 바이너리 중계는 이번 범위 밖이다.
  최초 hello의 3 s 시한 초과는 재시도 가능한 1013이다. proto 불일치는 전용 4406 +
  `PROTOCOL_MISMATCH`로 닫고 AGENT_PROTOCOL_MISMATCH 사건을 남긴다.
  Client는 정지·잠금 후 최소 30 s 간격으로 재연결 대기한다. 인증·권한 거부 4401/4403과
  구별한다. stop_ref가 없는 옛 agent 계약을 조용히 수용하지 않는다. 화면 fh-rt/1은 그대로다.
- `sub`는 상세 권한(`ROBOT_READ`)을 확인한다. 운영자는 담당 로봇만 실시간 상세를 받는다.
  STOP은 요약 보기(`ROBOT_SUMMARY`) 권한이므로 조직 안 다른 담당자의 로봇도 가능하다.
  조종은 기존 `authorize(..., 'O_OWN', robot)` 한 함수로 판정한다.
  연결 때와 독립 읽기 감시에서 현재 세션·역할·담당을 읽는다. 조직의 화면 세션을
  묶은 SELECT 2회로 판정하고, 같은 사용자의 ACL 계산은 묶음 안에서 공유한다.
  조회용 8개/조종용 32개 풀·executor를 분리한다. 담당자는 조종용 묶음으로 미리 준비하고,
  조회 전용 세션은 100 ms 간격의 별도 몫을 쓴다. 첫 판정 전에는 두 묶음에서 준비한다. 두 판정은
  10 ms 간격을 두고 시작하며, 완료된 판정 중 가장 최근 시작한 것을 사용한다.
  연결된 로봇의 토큰도 묶은 SELECT 1회와 전용 24개 풀·executor로 확인하며,
  ACL용 로봇 행을 이미 읽었다면 그 행의 토큰도 같은 시작 시각으로 확인한다.
  토큰 비교는 현재 소켓에 묶인 로봇·헤더에만 적용한다. 최초 인증의 조직 조회를
  연결 후 로봇마다 반복하지 않는다. 일반 인증 읽기 풀은 4개, HTTP STOP의 인증·권한
  풀과 executor는 각 12개이며, 기록 쓰기는 별도 1개 풀·작업자를 사용한다.
  빠른 DB는 100 ms 간격이며, 조종용은 지연이 늘면 15 ms, 로봇 인증은 20 ms까지 줄인다. 흐름당 미완료
  읽기는 각 실행 슬롯(조회 8/조종 32/로봇 24) 이하이고 executor의 남은 실행 슬롯을 먼저 얻어 실행 대기열을 만들지
  않는다. 2 ms 간격으로 완료를 확인하고, 풀 대기·스레드 대기도 판정 나이에 포함한다.
  읽기가 끝날 때까지 슬롯을 점유하며 수락 전 거부·취소도 producer를 정리한다.
  죽은 producer는 다음 감시에서 교체한다. 실제 읽기·스케줄링 합계가 500 ms에
  근접하면 입력 거부와 lease 폐기가 생길 수 있다. 이 경우 새 take가 필요하다.
  **500 ms는 조회 완료 뒤 TTL이 아니라 조회 시작부터 새 조종을 허용할 수 있는 상한**이다.
  STOP 범위는 느린 갱신 중에도 유지한다. 화면 상태 알림은 10 Hz 이하로 보낸다.
  낡은 권한을 만난 알림은 보관하고 갱신 뒤 다시 검사한다. reply는 별도 유한 큐여서
  STOP 응답이 갱신 대기 뒤에 줄 서지 않는다. lease.release/hidden은 기존 권한과 연결별
  소유 관계로 처리하며 낡은 로봇 인증·busy가 반납을 막지 않는다. 마지막 성공 판정이
  500 ms를 넘으면 새 조종을 막고 감시가 lease를 폐기하며, 5 s 이상 확인되지 않으면
  1013으로 닫는다. 소비자 읽기 시한은 2 s, DB statement/connect timeout도 2 s다.
  실제 세션 폐기·토큰 불일치에는 유예 없이 4401/4403을 적용한다.
- 조종권은 사용자·세션·연결에 묶인다. 유효 cmd(0 포함)만 heartbeat를 갱신한다.
  화면의 50 ms 입력 주기를 수용하되 서버는 25개/s·순간 3개 토큰 버킷으로 지터를 허용한다.
  중복/역순 seq·다른 lease_id는 거부하고, 새 seq의 0 입력은 명령 예산이 없어도 보낸다.
  에이전트 송신 큐에는 최신 cmd 하나만 남긴다. `ping`은 heartbeat가 아니다.
  `lease.request`는 조직 설정의 기본 10 s, 거절·TIMEOUT 확정부터 30 s 재요청 제한이다.
- 최초 take와 넘김 모두 `lease=null → stop(stop_ref) → 같은 stop_ref/latched/applied=0`을
  확인하고 새 lease를 발급한다. stop_ref는 로봇별 서버 증가 정수(1~2**53-1)이며,
  이전 반납·취소·로컬 STOP의 늦은 state는 이번 확인을 대신할 수 없다.
  stop_gen은 unlock CAS에만 쓰고 정지 인과 관계를 추정하는 데 쓰지 않는다.
  stop_ref를 소진하면 STOP은 계속 보내지만 새 take/넘김은 FREE로 끝내며 값을 재사용하지 않는다.
  2 s 확인 실패는 FREE다. RUN 인수 감사는 `RUN_PAUSE_TAKEOVER`와 확인 후 `TAKE`로
  기록하며 같은 전환에 `RELEASE(user=null)`를 중복 기록하지 않는다. unlock은 최신 stop_gen CAS를 검사하며,
  에이전트의 로컬 STOP·중립 관문을 대신하지 않는다.
- 서버는 에이전트에 1 s마다 ping을 보낸다. 마지막 수신부터 3 s면 연결을 닫고 사람 lease를 정리한다.
  hello의 사람 lease 사본은 복원하지 않는다. 진행 중 run 사본은 메모리에서 PAUSED로 맞추고,
  정지 확인 뒤 `RUN:<run_id>`로 실행을 지정해 lease를 예약한다. 지연된 RUN 종료 보고는
  같은 실행의 현재 RUN lease에만 적용하고 사람 lease나 넘김을 폐기하지 않는다.
  실행·지도·업로드 처리는 후속 확장 지점이다.
- STOP과 cmd 인증은 읽기 전용 풀을 쓰며 REST identity의 조직 잠금·last_seen_at 쓰기를 하지 않는다.
  WS STOP/cmd는 수신 즉시 검증된 캐시로 판정한다. STOP·lease 변경은 대기 cmd를 버린 뒤
  송신 큐에 넣는다. HTTP STOP의 최초 인증 예외·응답 순서는 아래 절을 따른다.
  사건 DB 기록은 별도 1개 풀/작업자로 처리하고 감사 DB 잠금은 1 s 제한으로 재시도한다.
  반복 거부·형식 오류는 로봇/사용자/코드별 첫 건과 1 s 집계로 묶는다. 첫 사건 전역
  20개/s·최대 256개 집계 키를 사용하되 로봇별 기록 한도는 별도로 유지한다.
  화면 입력 100개/s·순간 100개를 넘으면 닫되 STOP은 먼저 전달한다. 예산은 모델 검증·
  권한·busy 검사 전에 쓰므로 거부 입력도 제한한다. 에이전트 형식 오류·이진 프레임도
  예산을 쓴다. 유효 event는 로봇별 100개/s·순간 512개 예산을 한 번만 소비한다.
  로봇별 한도를 넘으면 해당 로봇만 STOP·FREE 후 1013으로 닫는다. 다른 로봇의
  lease·STOP·기록은 유지한다. 사건 저장 때문에 state/정지 확인을 기다리지 않는다.
  저장 불가 Unicode·NUL·비JSON·비유한 숫자·과도한 중첩 data는 수신에서 버리고 사건으로 묶는다.
  감사 작업자는 영구 데이터 오류(Unicode·SQLSTATE22/23 등)를 격리하고 안전한
  AUDIT_QUARANTINED 사건을 기록한 뒤 다음 건을 처리한다. 원본 data·SQL·토큰은 격리 사건에 넣지 않는다.
  일시 DB 오류는 같은 건을 재시도한다. 전송 중 단절의 ACK/재전송·디스크 내구성·
  에이전트의 유한 미송신/송신 큐와 누락 요약은 apps/agent/README.md를 본다.
  메모리/임시 파일의 미기록 건은 프로세스 손실 뒤 내구성을 보장하지 않는다.
- `POST /api/v1/robots/{id}/stop`은 HTTP 대체 경로(쿠키에는 CSRF 헤더 필요)다.
  응답 202는 요청 접수이며 실제 정지·몸의 속도 0 확인을 뜻하지 않는다.
- `POST /api/v1/robots/{id}/agent-token`은 총괄만 호출하는 재발급 API다.
  응답의 `agent_token`을 한 번만 보여 주며 `Cache-Control: no-store`다.
  기존 `robots.agent_token_hash` 열에는 SHA-256만 저장하고 원문은 사건에 넣지 않는다.
  최초 인증은 조직 내 활성 로봇의 고정 길이 해시를 compare_digest로 비교한다.
  연결 뒤 독립 감시는 서버가 묶은 로봇 ID 한 행만 읽고 digest를 고정 시간 비교한다.
  토큰 회전·보관·조직 범위 검사도 매번 유지하며 원문 토큰 SQL equality를 쓰지 않는다.
  데이터 수신은 인증 DB 왕복을 기다리지 않는다. 잘못된 에이전트 본문은 집계 사건으로
  남기고 버리며, 추가 필드는 무시한다. 해석 가능한 문자열 t 봉투만 생존을 갱신한다.
  영상 중계 전까지 모든 streams는 false이며 이진 프레임은 버린다.

`0004_lease_log`는 조종권 감사 표와 INSERT/SELECT 전용 권한을 추가한다.
기존 0001의 agent_token_hash를 재사용하며 중복 열을 추가하지 않는다.
0004 downgrade는 조종권 감사 기록을 삭제하므로 자료가 있는 DB에서 되돌림은 별도 보존 계획이 필요하다.
시험·변이 검출·문서 차이와 미검증 범위는 [REALTIME-VALIDATION.md](REALTIME-VALIDATION.md)를 본다.

`0005_lease_log_index`는 `(org_id, robot_id, at DESC)` 감사 조회 색인만 추가한다.
0005 downgrade는 그 색인만 제거한다.

실제 uvicorn과 현재 통합된 agent Client의 재접속 맞물림은 아래 별도 도구로 검사한다.
기본값은 같은 작업 트리의 agent이며 새 stop_ref 계약을 함께 검사한다. 역사 버전을 지정할 때만
`git archive`로 임시 폴더에 읽으며 에이전트 소스·worktree를 수정하지 않는다. 임시 PostgreSQL의 소유 세션을 종료하고 잠금을 점유해
1013 재시도 3회 이상과 잠금 해제 후 인증된 ping 복귀를 확인한다. uvicorn은 loopback의
사전 bind한 임시 fd/포트만 쓴다. 실제 DB 재시작·현장 네트워크 장애 시험은 아니다.

```sh
python apps/server/tools/check_agent_reconnect.py
python apps/server/tools/check_realtime_mutations.py
```

다른 저장소에서 agent 객체를 읽으려면 `--agent-repo /absolute/path`를 지정한다.
특정 역사 버전을 진단하려면 `--agent-ref <commit>`도 지정한다. 새 stop_ref 계약이 없는
구버전은 이번 통합 시험을 통과하지 못한다. 서버·에이전트는 계약을 함께 갱신해야 한다.
변이 도구도 실제 Client 회귀와 구조화한 예외 유형 판정을 포함한다. 타입 소비 시험은
`apps/contracts/tests/wire-consumer.ts`이며 `npm run --prefix apps/contracts typecheck`에 포함된다.

## PR #13 재검토 보완: 로봇별 기록과 STOP

연결별 archive 큐·퇴역 작업자는 만들지 않는다. 이력은 `robot_id`가 소유하고,
로봇 사이에는 하나의 DB auditor가 한 건씩 공정하게 순환한다. **같은 로봇 안에서는
수신 FIFO**를 유지하고 안전 사건을 앞으로 재정렬하지 않는다. 서로 다른 로봇 사이의
저장 순서는 달라질 수 있다. 모든 사건 data의 `server_received_at`(서버 수신 UTC)·
`robot_sequence`(로봇별 순번)를 서버가 부여하며 CSV/시간순 표시는 이 값과 Event.at을
사용해야 한다. 화면 `fh-rt/1`·Screen* 필드에는 변경이 없다.

로봇별 RAM FIFO는 64건이다. 일반 사건부터 생략하고 `AUDIT_DROPPED.data.count`에
묶음의 `_count`까지 포함한 누락 수를 남긴다. 모두 안전이면 새 일반 사건을 생략한다.
STOP·lease 전환/폐기·연결/권한 거부·안전 코드·ERROR 이상 등 **이미 접수한 안전 사건은
축출하지 않는다**. 수신 응답 대기 예약, 파일 작업 대기, DB in-flight까지 합쳐 로봇당
512건·직렬화 페이로드 2 MiB를 넘기 전에 새 접수를 거부한다. 정상 접수는 480건 및
2 MiB−32 KiB까지이고 마지막 32건·32 KiB는 EXPIRE/AGENT_DISCONNECTED/
HISTORY_STORAGE_BLOCKED/AUDIT_DROPPED 진단용이다. 안전 사건만으로 차도 더 접수하지
않고 해당 로봇을 STOP·FREE 후 `1013 + ROBOT_ARCHIVE_LIMIT`로 닫는다. 거절한 입력은
접수된 기록으로 간주하지 않으며, 승인된 기록과 누락 수는 계속 보유한다.

초과분은 로봇별 임시 SQLite 파일(물리 8 MiB 상한·캐시 128 KiB)에 보존한다. 파일 생성·
INSERT/SELECT/DELETE/정리는 해당 이력의 지연 생성 daemon 작업자 1개가 처리한다.
재접속은 같은 이력/작업자를 재사용한다. 파일 작업은 실행 중 포함 최대 256개이고 64개에서
새 접수를 닫는다. 이미 접수한 예약은 제한된 로봇 stage에서 기다린다. 파일 stall/오류는
그 로봇의 lease를 폐기하고 STOP을 전달한 후 연결을 닫으며 다른 로봇 수신·ticker·기록을
막지 않는다. 새 Client도 이 닫기 이유를 받자마자 teardown 전에 로컬 STOP·0을 출력한다.

복구는 대기 64건·256 KiB 이하, 파일 작업 0·오류 없음, 최소 1 s 이후의 새 연결부터
허용한다. 옛 lease/unlock/명령은 복원하지 않는다. 파일 오류는 같은 작업/원본을 유지해
재시도하며, 소비자에서 꺼낸 마지막 건도 DB 성공까지 소유한다. 예기치 않은 auditor
종료는 감시가 교체하고 조직 입력을 안전 차단한다. 이 조직 단위 `audit_storage_failed`
차단은 원인·미기록 건을 확인한 운영자 재시작이 필요하다. 로봇별 파일 오류는 이 전역
차단을 켜지 않는다. 공간 부족은 파일/디스크를 복구한 뒤 새 연결·lease·unlock·중립
절차를 거친다. 자동 주행 재개는 없다. 저장 오류 정책은 Q7 링크 단절 유예와 별개다.

HTTP STOP은 검증된 token/client/robot/CSRF 키 최대 256개를 조회 시작 기준 **250 ms**만
캐시한다. 같은 프로세스의 ORM commit으로 logout·session 폐기·사용자 잠금/보관·역할/
조직·세션 토큰은 해당 사용자만, 로봇 조직/보관 상태는 해당 로봇만 즉시 무효화한다.
진행 중 cold 조회도 같은 범위의 commit을 검사한다. 관계없는 사용자의 토큰 갱신은
STOP을 거절하지 않는다. 변경 이력은 최대 1024개이며 이력을 벗어난 조회와 범위를
판정할 수 없는 매개변수 bulk 변경은 보수적으로 거절/전체 무효화한다.
다른 프로세스나 raw SQL 변경은 이 알림을 우회하므로 TTL 상한을 적용한다. 캐시 적중은
DB 대기 없이 STOP을 적용한다. 최초 opaque-token 요청은 인증·CSRF·범위를 알 수 없어
**단일 SELECT 후 STOP**이라는 조정 승인 예외를 둔다. 전용 12개 연결/실행 슬롯을 쓰고
슬롯 포화 때 즉시 버리지 않고 기다리며, 슬롯 대기+조회 합계 2 s 시한 초과/DB 오류에는
503을 반환한다. 취소된 읽기는 작업이 실제 끝나야 슬롯을 돌려줘 executor 대기를
만들지 않는다. 서로 다른 20명 동시·0/450 ms 조회에서 모두 202를 검사한다.
미인증 STOP을 보내지 않는다. 접수 기록은
RAM에 먼저 예약하고 STOP을 적용한 뒤 202 응답을 보낸다. 파일/DB 기록은 응답 시도
뒤에 넘기며 응답 취소도 예약된 기록을 잃지 않는다. 450 ms 조회 6명 동시를 검사한다.

DB 연결 예산은 ASGI 프로세스당 실시간 4(일반 인증/owner 1 포함)+8(조회)+32(조종)+
24(로봇)+12(HTTP STOP)+1(감사)=81개, 별도 REST 기본 5+overflow 10을 합쳐 최대
96개에 장치 저장 전용 2개를 더한 **98개**다. 운영 `max_connections`에는 관리·마이그레이션·다른 프로세스/복제본 여유도
계산해야 한다. 이 PR은 운영 설정을 바꾸지 않는다. 최초 인증 가용 3개에 30개 연결이
동시에 몰리는 재시작 부하는 1013 대기가 남는다. admission 증설은 DB 전체 예산과
함께 별도 측정한다. 450 ms는 권한 시작 기준 500 ms까지 여유가 작아 거부/lease 폐기
가능성이 계속 있다. 늦은 읽기를 새로 찍거나 조종 명령을 자동 재생하지 않는다.

파일은 프로세스 수명 동안의 배압 장치이며 재시작 저널이 아니다. 서버 수신 ACK·
정확히 한 번 전달·프로세스 손실 뒤 복구·물리 정지를 보장하지 않는다. 넘김 확인은
`state`의 latched/applied/stop_gen/stop_ref이며 몸의 정지 확인은 아니다.
API §9·§10의 판/닫기 코드, 로봇별 FIFO/한도/수신시각·순번, HTTP 최초 인증 예외와
저장 오류의 Q7 분리 반영은 소유 범위 밖 정본을 맡은 조정 세션의 동기화 항목이다.

HTTP 503의 정지 적용 여부: 유효 캐시 요청은 슬롯을 기다리지 않고 STOP을 적용한다.
최초 인증의 슬롯 대기/조회 시한 초과는 인증을 확인하지 못했으므로 STOP을 보내지 않는다.
조회 뒤 해당 사용자·로봇의 캐시 세대가 바뀌면 권한/세션이 폐기됐을 수 있어 기존 actor를 재사용하지 않는다.
인증 뒤 로봇 기록 접수가 실패한 경로는 STOP을 먼저 적용하고 503을 알리는 기존 동작이다.
일반 backlog 배출을 기다리는 시험용 `join()`은 진입 때 한 번만 요약을 넣고 이후
소비자/ticker의 정상 요약을 기다린다. 반복 대기 wake-up이 기록 전체를 요약으로
바꾸지 않는지 별도 최신 61건 보존 회귀로 검사한다.


## S0 서버 후속

- 서버는 구독 없는 화면에도 `{t:"ping",t_server:"…Z"}`를 1 s마다 보낸다.
  권한 갱신을 기다리는 비공개 알림과 분리된 reply 큐를 사용한다. 화면은 응답할 의무가
  없으며 양방향 ping 모두 조종권 heartbeat를 늘리지 않는다(`cmd`만 연장).
- 화면의 `{t:"lease.cancel",id,robot}`은 **그 연결**의 대기 요청을 취소한다.
  요청 ID를 받기 전에도 쓸 수 있다. 양쪽에 같은 request_id의 `lease.result(CANCELED)`를
  보내므로 상대 창도 닫을 수 있다. 수락 직후 정지 확인 중인 넘김도 lease-null→STOP으로
  취소하며, 이미 확정된 조종권이나 다른 탭의 요청은 `LEASE_REQUEST_STALE`로 거절한다.
  확정된 조종권을 반납할 때는 기존 `lease.release`/`hidden`을 쓴다.
- 수락 전 인증 실패는 HTTP 401, 권한·Origin·에이전트 토큰 거부는 HTTP 403이다.
  ASGI `websocket.http.response` 확장이 없는 서버에서는 accept→4401/4403으로 구분한다.
  수락 후 4401/4403과 일시 거부 accept→1013은 유지한다. 브라우저 JS는 HTTP 거부의
  상태를 직접 읽지 못하므로 화면의 기존 REST 세션 확인은 계속 필요하다.
- 새 조종권의 화면 lease 통지 직전에 최신 state를 같은 순서 큐에 넣는다. 화면이 이전
  stop_gen으로 즉시 unlock해 한 번 거절되던 경합을 막으며, stop_gen CAS·정지 확인은 유지한다.
- 보관한 로봇의 이름은 새 등록/이름 변경에 재사용할 수 있다. 활성 로봇끼리의 조직 내
  이름 중복은 계속 409다. migration 0007은 UNIQUE(org_id,name)를 활성 행의 부분 고유
  인덱스로 바꾸며 과거 robot ID·사건·토큰은 합치거나 복원하지 않는다.
- OFFLINE 로봇의 REST 목록·상세는 저장된 장치의 상태를 `MISSING`으로 표시한다.
  연결이 끊겨 현재 장치를 확인할 수 없다는 뜻이며 물리 제거를 확인했다는 뜻은 아니다.
  DB의 마지막 보고는 보존하고 재연결 hello/state의 최신 장치 상태를 표시한다.
  비담당자의 devices=[]·connection=UNKNOWN과 OFFLINE 측정값 null은 유지한다.

warm HTTP STOP의 슬롯 우회는 **조회 시작부터 250 ms 안**에서만 가능하다.
그 뒤에는 cold 인증을 다시 거치므로 DB가 멈추면 2 s 시한 뒤 503이 될 수 있다.
TTL·정책 신선도 500 ms를 늘리지 않으며, 501 ms 정책에서는 회수·STOP을 유지한다.

S0 회귀·실제 Client 통합은 `tests/test_server_followup*.py`, 검증 결과는
`REALTIME-VALIDATION.md`의 S0 절을 본다. 시험 포트를 제한하려면
`FH_TEST_PORT_RANGE=9150:9169`를 지정한다.

0007을 내리기 전에 조직별 보관 행을 포함한 이름 중복을 확인하고 별도 이관으로
해소해야 한다. 중복이 남으면 PostgreSQL이 옛 UNIQUE 복원을 거절하며, downgrade는
트랜잭션으로 되돌아간다. 운영 자료를 자동으로 이름 변경/삭제하지 않는다.


등록201·담당 변경·삭제 직후 `sub`가 모르는 ID나 읽기 권한 변경을 만나면, 해당 요청 뒤에
시작한 정책 스냅숏을 한 번 확인한다. 기존 공유 read-ahead만 사용하며 화면 연결당 대기
구독 작업은1개다. 추가 `sub`는503 SERVER_BUSY로 거절하고 STOP 수신은 계속 처리한다.
최신 정책에도 ID가 없으면404 NOT_FOUND reply로 그 구독만 거절하고 이전 구독을 유지한다.
다른 조직·없는 ID는 같은404이며, 같은 조직의 알려진 로봇에 실제 ROBOT_READ가 없으면
기존4403·인증 만료4401을 유지한다. 조회 실패/정책500ms 초과는503이며 접근을 부여하지 않는다.
화면 종료 때 대기 구독을 취소한 뒤 공유 정책 생산자를 정리한다.

PR #21 검토 후속: 요청자가 `lease.cancel`로 닫은 요청도 같은 사용자의 30초 재요청
제한에 센다. 취소가 확정된 시각부터 계산하며 재접속·다른 기기로 우회할 수 없다.
수락 뒤 STOP 확인 전 취소도 같고, 이미 수락이 확정됐거나 만료된 요청의 취소는
`LEASE_REQUEST_STALE`이다. 기록 admission이 닫혀도 권한을 확인한 취소는 처리하며
새 요청·take·명령의 기록 admission 검사는 유지한다.
정책 갱신은 화면별 2ms 확인 대신 두 공유 lane의 새 결과를 기다린다. 빈 lane은
다른 lane의 watermark를 밀지 않으며 500ms 신선도와 2초 조회 시한은 그대로다.
검토 후속 변이만 실행할 때는 `check_realtime_mutations.py --match S0`를 쓴다.
선택 실행도 정상 서버 전체 시험을 먼저 1회 수행한다.

## 사건 기록·알림 (S2)

`GET /api/v1/events`는 `category`(RUN/ROUTE/LINK/LEASE/APPROVAL/SAFETY/ACCOUNT),
`severity`(INFO/WARN/ERROR), `robot_id`, `user_id`(행동한 사람), `run_id`, `from`, `to`로
거른다. 기간은 시간대가 있는 ISO 8601 시각이며 양 끝을 포함한다. `limit=1..100`(기본 50),
`cursor`로 `(at DESC, id DESC)` 순서의 `items`, `next_cursor`를 받는다.
사건·알림 ID는 bigint의 십진 **문자열**이다. `at`·`robot_at` 등 시각 필드는 UTC `Z`이며,
저장 문장의 시각은 Asia/Seoul로 그린다(조직별 시간대 설정은 후속 범위).

총괄은 같은 조직 전체, 운영자는 **지금 담당인 활성 로봇의 사건 또는 내가 한 행동**만
읽는다. 담당 변경은 다음 요청부터 반영한다. `GET /events/{id}`도 같은 범위이며,
범위 밖·다른 조직·없는 사건은 같은 404를 반환한다. 다른 로봇의 내 행동 허용은 조정
지시의 임시 D3 해석이다. 로봇 필터도 내 행동이 있는 다른 로봇은 그 행동만 반환하고,
읽을 수 있는 행도 현재 담당도 없는 로봇은 없는 ID와 같은 404다.
`runs` 표는 아직 없어 `run_id`는 이미 보이는 사건에 있는 ID만 조회하며 나머지는 404다.

`GET /events/export.csv`는 위 필터·범위를 그대로 적용한다(cursor는 사용하지 않음).
BOM을 포함한 UTF-8, CSV 따옴표/줄바꿈 이스케이프, 저장된 문장과 data JSON을 내보낸다.
유니코드 공백 뒤를 포함해 `=`, `+`, `-`, `@`로 시작하거나 탭/개행으로 시작하는 칸에는 앞에
작은따옴표를 붙인다. 최대 **10,000행**이며 초과하면 부분 자료를 내보내지 않고
400 `EXPORT_LIMIT`로 기간/필터를 좁히도록 안내한다. 상한은 ID만 조회해 판정하고,
확정한 ID의 행을 100개씩 읽어 임시 파일에 쓴 뒤 65,536자 청크로 스트리밍한다.
프로세스 전체 조회·파일 생성 슬롯은 1개이며 쓰기가 끝나면 전송 전에 반환한다.
생성 중인 두 번째 요청은 기존 오류 형식의 429 `RATE_LIMITED`다. 전송 중인 임시 파일은
조직·사용자별 1개로 제한하며 같은 사용자의 추가 요청도 429다. 느린 다운로드가 다른
사용자의 생성을 막지 않는다. 조회/쓰기 실패·응답 호출 전 예외·전송 단절에도 요청
수명에 묶인 정리로 슬롯·파일을 회수한다.
사건/CSV/알림 조회는 `no-store`다.

`fh_server/event_messages.py`가 모든 서버 사건 문장 틀의 한 곳이다. 새 행을 저장할 때
이름·시각·값·조사로 만들며 옛 문장은 다시 만들거나 고치지 않는다. `robot_at`이 서버
`at`보다 미래가 아니고 24시간 이내일 때만 그 시각을 쓰며, 나머지는 서버 `at`을
Asia/Seoul로 그린다. 원래 `robot_at`은 보존한다. 문장 값은 제어문자를 제거하고
128자로 제한하며 숫자 자리에 객체·문자열·bool·비유한 값은 «확인되지 않음»으로 쓴다. 새 서버 코드의
틀 누락은 예외와 소스 목록 회귀 시험으로 검출한다. 에이전트 코드는 열린 확장점이므로
별도 `AGENT_CODES` 허용 목록의 관측·진단 코드만 전용 틀·분류를 쓴다. 목록 밖의
코드(서버 전용 사람 행동·계정·결재 포함)는 `AGENT_EVENT` 틀·LINK 분류에 원래 코드를
표시하고 알림을 만들지 않는다.
`HISTORY_STORAGE_BLOCKED`는 실제 에이전트의 자체 기록 저장 실패에도 쓰이므로 허용하되,
서버 저장 실패와 서로 다른 문장으로 표시한다.
코드·data·robot_at은 보존한다. STOP·명령 수신은 기존처럼 감사 저장을 기다리지 않는다.
사건 수정/삭제 API는 없으며 `fh_app`의 기존 SELECT/INSERT 전용 권한과 시작 검사를 유지한다.

0008은 조직 FK가 있는 `notifications`와 목록 색인을 추가한다. 사건·알림 INSERT는 같은
트랜잭션이다. 현재 연결한 대상은 조종권 요청(현재 holder), 연결 끊김·실행 실패/완료·
경로 이탈·배터리 부족(현재 담당과 조직 총괄)이다. 잠긴/보관 계정은 제외하고
`notify_prefs`의 알림 kind가 false이면 생성하지 않는다. STOP·로그인·연결 성공·일반
오류는 알림으로 만들지 않는다. 배터리 임계값 감지 자체와 실행 기능을 새로 만들지는 않는다.

- `GET /notifications?unread=1`: 로그인한 사람의 `items`, `next_cursor`, `unread_count`.
  `limit`, `cursor` 지원, 최신순. 안 읽음 수는 페이지와 무관한 본인 전체 수다.
- `POST /notifications/read {"ids":["123"]}` 또는 `{"all":true}`: 204. 웹은 기존 CSRF 헤더,
  앱은 bearer를 쓴다. ids는 1~100개이고 둘 중 하나만 지정한다. 남의/없는 ID가 섞이면
  같은 404이며 내 알림도 부분 처리하지 않는다. 다시 읽어도 최초 `read_at`은 유지한다.
- 알림의 `link`는 `#/history?event_id=<십진 ID>`다. 화면 배지·이동 처리는 W3/W5 소유다.
  Web Push·WS notify 배송·결재 알림(S4)은 이번 구현 범위 밖이다.

0008은 서버를 멈춘 상태에서 적용한다(events 제약/색인 생성 중 INSERT가 막힐 수 있음).
notifications의 앱 권한은 SELECT/INSERT와 `UPDATE(read_at)`뿐이다. 초안의 예전 0008을
이미 적용한 시험 DB는 재생성하거나, 관리자가 전체 UPDATE 권한을 회수하고 read_at 열
권한만 부여해야 한다. 운영 DB의 권한을 이 작업에서 변경하지 않는다.
자료가 있는 DB는 백업 후 승인된 이관 절차로 0008을 적용한다. 0008 downgrade는
알림함만 삭제하며 사건 행은 고치지 않는다. 알림 보존이 필요하면 먼저 내보내야 한다.
코드는 변경 커밋을 revert한다. 실제 브라우저·실폰·실로봇 확인은 별도다.

## 장소·층·지도 판 (S3a)

`FH_FILES_ROOT`(기본 `/var/lib/foothold/files`) 한 곳에 지도 파일을 저장한다.
서버 실행 계정이 읽고 쓸 수 있는 전용 디렉터리를 준비하고 DB와 함께 백업한다.
시험은 `tmp_path` 아래 합성 이미지만 사용하며 실제 지도 원본은 Git에 넣지 않는다.

- `GET /sites`: 조직의 `items` 나무(장소 → 건물 → 층), 층의
  `approved_version_id`와 `pending_count=0`. 나무는 한 번에 반환하며 `next_cursor=null`이다.
- 총괄만 장소·건물·층을 만들고 이름/층 높이를 고치거나 지운다. 하위 자료,
  지도 판, 로봇의 마지막 층, 연결점 참조가 있으면 `409 RESOURCE_IN_USE`다.
  시나리오 참조 검사는 S5가 추가해야 한다. 조직 밖·없는 UUID는 같은 404다.
- 지도 저장은 총괄만 `POST /floors/{id}/map-versions`로 한다.
  `{base_version_id, image, features, reason}`에서 첫 판의 기준은 `null`이다.
  지금 승인 판과 다르면 `409 STALE` 및 `detail.approved_version_id`를 반환한다.
  판 INSERT, 층 승인 포인터, 연결점 투영, 승인 사건을 같은 DB 트랜잭션에 저장한다.
  운영자는 `403 APPROVAL_REQUIRED`이며 S4의 PENDING·결재 연결 전에는 저장할 수 없다.
- 판 목록은 `items`, `next_cursor`이며 `limit=1..100`이다. 상세에는 지도 요소,
  해상도·원점·치수·PNG sha256·만든 사람이 들어간다. `/image`는 인증 후 PNG를 반환한다.
  과거 판의 `SUPERSEDED`는 현재 층 포인터로 계산하며 저장된 판 행은 고치지 않는다.
  판 PATCH/PUT/DELETE API가 없고 `fh_app`은 `map_versions` INSERT/SELECT만 가능하다.
  서버 시작 때 UPDATE/DELETE/TRUNCATE 권한을 가진 DB 계정을 거절한다.

### 원시 업로드 두 단계

추가 Python 의존성 없이 `POST /uploads`의 원시 본문을 사용한다.
웹은 기존 CSRF 헤더, 설치형 앱은 bearer 인증을 그대로 쓴다.

1. `Content-Type: image/png` 또는 `image/x-portable-graymap`으로 이미지 바이트를 올린다.
   응답 `201 {upload_id, sha256}`의 sha256은 **올린 이미지 원본** 기준이다.
2. `POST /uploads?image=<1단계 upload_id>`에 `Content-Type: text/yaml`
   또는 `application/x-yaml`로 ROS map YAML을 올린다. 응답의 **새 upload_id**가
   이미지+메타데이터 묶음이며 판 저장의 `image` 필드에 넣는다.
   sha256은 연결한 원본 이미지 기준이다. YAML 없는 이미지 ID로 판을 저장하면 422다.

이미지는 **8 MiB 이하**, YAML은 **16 KiB 이하**, 가로·세로는 각각 **4096 픽셀 이하**다.
Content-Length가 상한을 넘거나 스트리밍 수신 중 상한을 넘으면 `413 UPLOAD_TOO_LARGE`다.
PNG는 매직·청크·CRC·zlib 데이터 길이·필터·치수를 검사하며 Adam7와 색/비트 형식을 지원한다.
PGM P2/P5(8/16비트)는 픽셀 수·범위를 검사하고 표준 zlib로 8비트 회색 PNG로 변환한다.
YAML은 `resolution`, `origin: [x,y,yaw]`, `negate`, `occupied_thresh`, `free_thresh`가 필수이고,
`image`(경로 없는 PNG/PGM 파일 이름), `mode`(trinary/scale/raw)만 선택으로 받는다.
알 수 없는/중복 키, 중첩·앵커·별칭·태그·여러 문서, 비유한 숫자·잘못된 임계값을 422로 거절한다.

서버가 파일 이름을 정하며 업로드의 이름/경로를 쓰지 않는다. 임시 PNG는
`uploads/tmp/<uuid>/image.png`, 승인 판은 `maps/<floor_id>/<number>-<PNG sha256 앞12>.png`
및 같은 이름의 `.yaml`로 저장한다. YAML의 image는 변환한 PNG를 가리킨다.
판의 `image_sha256`은 내려받는 **PNG 바이트** 기준이므로 PGM 원본 해시와 다를 수 있다.
파일 독점 생성으로 덮어쓰기를 막고 요청 중 DB/파일 실패 때 새 파일을 지운다.
프로세스 종료·디스크 장애의 원자성은 보장하지 않으며 고아 파일 정리는 후속 운영 작업이다.

지도 요소 검사 오류는 `422 INVALID_FEATURES`와 `detail.element` 또는 `detail.elements`의
필드 경로로 알린다. 구역·선의 점은 회전 원점을 반영한 이미지 범위 안이어야 한다.
다각형은 3~256개의 서로 다른 점, 넓이>0, 인접하지 않은 변의 교차 없음이 필요하다.
지점은 이름·유한한 x/y/yaw, 연결점은 같은 건물의 다른 층·좌표,
편집은 ERASE/WALL·서로 다른 점 2개 이상·양의 width를 검사한다.
구역 256개·지점 1000개·연결점 256개·편집선 256개, 선당 점 256개가 상한이다.

`GET /floor-connectors?building_id=`는 현재 승인 판들의 연결점을 반환한다.
서로 다른 두 층의 features.connectors에 **같은 id·kind와 서로의 pair_floor_id**가 있으면
양쪽 pose/판을 묶어 `active=true`다. 한쪽만 있으면 `b_pose`, `map_version_b_id`는 null이고
`active=false`다. 새 판 승인 때 현재 투영을 다시 만들며 과거 판 features는 보존한다.
장소·건물·층 CRUD는 ACCOUNT 사건, 판 승인은 APPROVAL 사건으로 저장한다.
총괄의 바로 저장에는 별도 결재 요청/결과가 없으므로 알림을 만들지 않는다(S4 소유).

### 이관·검증·후속

0009는 기존 서버를 멈춘 승인된 이관 절차로 적용한다. 새 지도 표 및
`robots.last_floor_id`의 조직 포함 FK를 추가하므로 기존의 잘못된 층 ID를 먼저 정리해야 한다.
운영 DB나 운영 파일은 이 작업에서 변경하지 않는다. downgrade는 지도/업로드 **DB 행을 삭제**하며
파일은 삭제하지 않는다. 사용 중에는 먼저 DB+파일을 백업하고 참조 소비자를 멈춰야 한다.
코드 되돌림은 해당 커밋 revert이며 파일/DB 복구와 서비스 교체는 별도 절차다.

미사용 업로드는 정본의 24시간 규칙을 따르는 정리 작업이 필요하지만 이번에는 스케줄러를
구현하지 않는다. 두 단계 업로드가 같은 PNG 경로를 공유하므로 정리 시 최종 묶음과
판 참조를 함께 확인해야 하며 UUID만 보고 원본 이미지를 지우면 안 된다.
/diff·/rollback, 운영자 PENDING/결재, SLAM, 로봇 위치의 지도 판 결합은 후속 범위다.

```sh
FH_TEST_PORT_RANGE=9290:9309 python -m pytest -q apps/server/tests/test_maps.py apps/server/tests/test_map_files.py apps/server/tests/test_maps_wire.py
FH_TEST_PORT_RANGE=9290:9309 python apps/server/tools/check_realtime_mutations.py --match S3a
python -m apps.contracts.generate --check
npm run --prefix apps/contracts typecheck
```

변이 도구는 선택 실행에서도 먼저 서버 pytest 전체를 한 번 수행하고 변이는 하나씩 실행한다.
실제 uvicorn 시험도 합성 PGM/YAML·임시 파일·임시 PostgreSQL·loopback 포트만 사용한다.
실제 지도·화면·실폰·실로봇·ROS·Gazebo 검증을 뜻하지 않는다.

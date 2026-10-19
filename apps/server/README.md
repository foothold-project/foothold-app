# 관제 서버 — 계정·로봇·실시간

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
(`connection=OFFLINE`, 상태·배터리·위치·조종권·실행은 null, 장치·주의는 빈 목록).
담당자·총괄의 목록과 상세에는 현재 에이전트 연결, 마지막 유효 state의 상태·배터리·pose,
중재기의 현재 lease를 반영한다. 연결이 끊기면 OFFLINE으로 바뀌고 마지막 state의 측정값은
그 갱신 시각과 함께 메모리에 남는다(프로세스 재시작 뒤에는 미수신 null).
pose의 각 null은 그대로 보존하며 `map_version_id`가 없으면 null이다. 서버가 지도 판을 추측하지 않는다.
실행 기능이 없어 `current_run=null`이다. `robot_devices`는 hello 및 `devices_changed`로 저장하고,
목록에서 빠진 기존 장치는 MISSING으로 보관한다.

티켓·지도·임무·결재·기록 조회·CSV·원격측정 REST API는 구현하지 않았다.
WS·에이전트 연결·조종권·STOP의 구현 범위는 아래 실시간 절을 따른다.
이들을 위한 가짜 응답 경로나 빈 서비스는 만들지 않았다. 계약의 로봇 요약 필드는
명세대로 전체 구조를 정의하지만 상태 수신 기능을 구현했다는 뜻은 아니다.
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
수정·삭제는 실시간 소유 프로세스로 보내야 한다(소유 중재기 없음·변경 중이면 503 SERVER_BUSY).

담당 변경·해제는 기존 `lease=null → stop`을 먼저 enqueue하여 옛 조종권과 대기 요청을
폐기한다. 그 뒤 `{t:"subscription.revoked",robot,reason:"ACCESS_REVOKED"|"ROBOT_DELETED"}`를
보내고 해당 로봇만 구독에서 뺀다. 같은 화면의 다른 로봇 구독과 연결은 유지한다.
화면 proto는 fh-rt/1 그대로이며 기존 웹은 모르는 t를 무시한다(알림 표시는 후속 W2).
세션 폐기는 기존 4401, 명시적인 범위 밖 `sub` 재시도 거부는 기존 4403이다.
새 담당자가 조종권을 자동으로 받거나 총괄이 강제로 인수하는 기능은 추가하지 않았다.

`GET /dashboard`는 총괄에게 조직 전체, 운영자에게 담당 로봇의 total·online·attention을
반환한다. attention은 OFFLINE·배터리 기준 미만·ERROR·STOP_LATCHED·장치 ERROR 중
하나라도 있는 로봇 수다(중복 합산 없음). `robots_running=0`, `approvals_pending=0`은
실행·결재 구현 전의 값이다. `operators`는 총괄에게 운영자별 담당 로봇 수를, 운영자에게
빈 배열을 반환한다. 장치 저장은 migration 0006으로 추가한다.

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
조직·세션 토큰·로봇 조직/보관 상태가 바뀌면 즉시 전부 무효화한다. 갱신 중 폐기도 세대 검사로 차단한다.
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
96개다. 운영 `max_connections`에는 관리·마이그레이션·다른 프로세스/복제본 여유도
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
조회 뒤 캐시 세대가 바뀌면 권한/세션이 폐기됐을 수 있어 기존 actor를 재사용하지 않는다.
인증 뒤 로봇 기록 접수가 실패한 경로는 STOP을 먼저 적용하고 503을 알리는 기존 동작이다.
일반 backlog 배출을 기다리는 시험용 `join()`은 진입 때 한 번만 요약을 넣고 이후
소비자/ticker의 정상 요약을 기다린다. 반복 대기 wake-up이 기록 전체를 요약으로
바꾸지 않는지 별도 최신 61건 보존 회귀로 검사한다.

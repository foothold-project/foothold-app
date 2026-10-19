# 관제 서버 — 골격과 실시간 (W2-A · W3-B)

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
로봇도 **관제 요약 객체만** 허용한다. 다른 조직·없는 ID는 404다. 이번 골격에서는 모든
로봇 응답이 동일한 요약 필드만 제공한다. 상세·기록 기능을 추가할 때 담당 밖의
원격측정·실행·사건·사진 ID는 404로 숨겨야 한다. 현재 수신 상태가 없으므로
`connection=OFFLINE`, 그 밖의 미수신 값은 null, 장치·주의 목록은 빈 목록이다.

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
매 실행 임시 데이터 폴더·임시 포트 번호·전용 Unix socket을 만들고 TCP에는 listen하지 않는다.
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

하나의 조직은 서버 프로세스 **1개**로 실행한다(`uvicorn --workers 1`).
시작 때 전용 PostgreSQL 세션 advisory lock을 얻은 프로세스만 실시간 중재기를 연다.
다른 프로세스는 REST 조회·인증을 제공할 수 있지만 WS는 1013, HTTP STOP은 503으로 거부한다.
이 잠금은 STOP·cmd 경로와 분리돼 있다. 소유 잠금이 사라지면 FREE를 알리고 연결을 닫으며,
기존 중재기는 500 ms 주기로 재획득을 시도한다. 성공해도 옛 lease를 복원하지 않는다.
서버를 새로 시작하면 사람 조종권·요청·재요청 제한은 모두 메모리에서 새로 시작한다.

- 화면: `/api/v1/ws`. 웹은 `fh_s` 쿠키와 정확한 Origin 일치, 앱은 Bearer.
  프록시 뒤에서는 `FH_WS_ORIGIN=https://<화면 출처>`를 명시한다(와일드카드·경로 없음).
  첫 메시지는 `proto: "fh-rt/1"`을 포함한다. 예: `{t:"ping",id:"…",proto:"fh-rt/1"}`.
- 에이전트: `/api/v1/agent/ws`, 로봇 전용 Bearer, 최초 `hello.proto="fh-agent/1"`.
  두 프로토콜 이름은 WS subprotocol 협상 헤더에 넣지 않는다.
  한 연결의 텍스트 JSON은 4 KiB까지다. 영상 바이너리 중계는 이번 범위 밖이다.
- `sub`는 상세 권한(`ROBOT_READ`)을 확인한다. 운영자는 담당 로봇만 실시간 상세를 받는다.
  STOP은 요약 보기(`ROBOT_SUMMARY`) 권한이므로 조직 안 다른 담당자의 로봇도 가능하다.
  조종은 기존 `authorize(..., 'O_OWN', robot)` 한 함수로 판정한다.
  연결 때와 100 ms 주기 감시에서 현재 세션·역할·담당을 읽어 캐시한다. 같은 세션의
  연결은 갱신을 합치며 로봇 수에 관계없이 스냅숏은 SELECT 2회다. 수신·송신은 캐시만
  검사한다. 500 ms보다 오래된 판정으로 새 조종 입력을 보내지 않으며, 이전에 허용된
  STOP 범위는 느린 갱신 중에도 쓸 수 있다. 세션 만료·폐기는 입력 폐기와 lease 반납으로 처리한다.
- 조종권은 사용자·세션·연결에 묶인다. 유효 cmd(0 포함)만 heartbeat를 갱신한다.
  화면의 50 ms 입력 주기를 수용하되 서버는 25개/s·순간 3개 토큰 버킷으로 지터를 허용한다.
  중복/역순 seq·다른 lease_id는 거부하고, 새 seq의 0 입력은 명령 예산이 없어도 보낸다.
  에이전트 송신 큐에는 최신 cmd 하나만 남긴다. `ping`은 heartbeat가 아니다.
  `lease.request`는 조직 설정의 기본 10 s, 거절·TIMEOUT 확정부터 30 s 재요청 제한이다.
- 최초 take와 넘김 모두 `lease=null → stop → latched/applied=0/새 stop_gen`을 확인하고
  새 lease를 발급한다. 아직 보고되지 않은 앞선 STOP 수까지 세대 하한에 포함한다.
  2 s 확인 실패는 FREE다. unlock은 최신 stop_gen CAS를 검사하며,
  에이전트의 로컬 STOP·중립 관문을 대신하지 않는다.
- 서버는 에이전트에 1 s마다 ping을 보낸다. 마지막 수신부터 3 s면 연결을 닫고 사람 lease를 정리한다.
  hello의 사람 lease 사본은 복원하지 않는다. 진행 중 run 사본은 메모리에서 PAUSED로 맞추고,
  정지 확인 뒤 `RUN:<run_id>`로 실행을 지정해 lease를 예약한다. 실행·지도·업로드 처리는 후속 확장 지점이다.
- STOP과 cmd 인증은 읽기 전용 풀을 쓰며 REST identity의 조직 잠금·last_seen_at 쓰기를 하지 않는다.
  WS STOP/cmd는 수신 즉시 캐시로 판정한다. STOP·lease 변경은 대기 cmd를 버린 뒤
  송신 큐에 넣는다. HTTP 대체 경로의 최초 인증은 기존 DB 조회를 쓴다. 사건은 별도
  풀/큐에서 기록하고 감사 DB 잠금은 1 s 제한으로 재시도한다. 반복 거부·STOP·에이전트
  사건은 로봇/사용자/코드별 첫 건과 1 s 집계로 묶으며, 첫 사건 전역 20개/s·최대 256개
  집계 키로 제한한다. 큐 포화 시 FREE 알림을 보내고 새 조종만 막으며 STOP과 접속은
  계속 허용한다. 큐가 1/4 미만으로 줄면 자동 회복하고 누락 수를 요약한다. 화면 연결은
  전체 입력 100개/s·순간 100개를 넘으면 닫되 그 프레임이 STOP이면 먼저 전달한다.
  감사 큐는 메모리이므로 프로세스 종료 전 미기록 건의 내구성은 보장하지 않는다.
- `POST /api/v1/robots/{id}/stop`은 HTTP 대체 경로(쿠키에는 CSRF 헤더 필요)다.
  응답 202는 요청 접수이며 실제 정지·몸의 속도 0 확인을 뜻하지 않는다.
- `POST /api/v1/robots/{id}/agent-token`은 총괄만 호출하는 재발급 API다.
  응답의 `agent_token`을 한 번만 보여 주며 `Cache-Control: no-store`다.
  기존 `robots.agent_token_hash` 열에는 SHA-256만 저장하고 원문은 사건에 넣지 않는다.
  기존 에이전트 연결은 독립적인 100 ms 주기 인증 감시에서 예전 토큰을 거부한다.
  데이터 수신은 인증 DB 왕복을 기다리지 않는다. 잘못된 에이전트 본문은 집계 사건으로
  남기고 버리며, 추가 필드는 무시한다. 해석 가능한 문자열 t 봉투만 생존을 갱신한다.
  영상 중계 전까지 모든 streams는 false이며 이진 프레임은 버린다.

`0004_lease_log`는 조종권 감사 표와 INSERT/SELECT 전용 권한을 추가한다.
기존 0001의 agent_token_hash를 재사용하며 중복 열을 추가하지 않는다.
0004 downgrade는 조종권 감사 기록을 삭제하므로 자료가 있는 DB에서 되돌림은 별도 보존 계획이 필요하다.
시험·변이 검출·문서 차이와 미검증 범위는 [REALTIME-VALIDATION.md](REALTIME-VALIDATION.md)를 본다.

`0005_lease_log_index`는 `(org_id, robot_id, at DESC)` 감사 조회 색인만 추가한다.
0005 downgrade는 그 색인만 제거한다.

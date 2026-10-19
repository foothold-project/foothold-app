# 관제 서버 골격 (W2-A)

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
uvicorn apps.server.fh_server.main:app --host 127.0.0.1 --port 8810
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
SELECT/INSERT 및 시퀀스 사용 권한만 부여한다. `fh_app`은 다른 표도 DELETE 권한이 없다.
기존 역할이 있으면 bootstrap은 중단하므로 관리자가 역할 상속·기존 권한을 검토해야 한다.

## 구현 범위·계약

- 웹 로그인·로그아웃, `/me` 조회/수정·비밀번호 변경, 계정 관리·기기 세션 폐기.
- 앱 access 15분, refresh 30일. 갱신 때 두 토큰을 회전하며 최초 refresh 만료 시각을 늘리지 않는다.
- 웹 세션 기본 24시간. 로그인 응답의 `csrf_token`을 `X-FH-CSRF`에 넣어 변경 요청을 보낸다.
  세션마다 CSRF 값이 다르므로 재로그인 응답 값을 사용한다. 로그아웃 후 쿠키와 세션을 폐기한다.
  로그인은 JSON 자격 증명, 앱 갱신은 refresh 토큰으로 인증하므로 기존 세션 CSRF를 요구하지 않는다.
- 비밀번호 scrypt n=16384/r=8/p=1. DB에는 세션·refresh·CSRF 원문 대신 sha256만 저장한다.
- 실패 5회/5분을 IP와 계정 각각에 적용한다. PostgreSQL 사건 조회와 트랜잭션 advisory lock을
  사용하여 여러 프로세스·재시작 사이에서도 제한을 공유한다. 실패 5건 뒤 6번째 요청부터 429다.
  IP는 직접 연결 주소다. 프록시 헤더 신뢰는 운영자가 신뢰할 프록시만 uvicorn에 설정해야 한다.
- 로그인·실패·로그아웃·계정 변경·조직 설정 변경은 같은 DB에 한국어 사건으로 남긴다.
- 로봇 목록 `scope=mine|all`, UUID 순서 cursor 목록. 서버가 매 요청 DB의 역할·조직·담당을 확인한다.
- 조직 설정 GET/PATCH와 명세의 각 범위 검사. 변경은 마지막 저장이 이기며 사건을 남긴다.

조정 세션이 확인한 명세 해석: `scope=all`과 `/robots/{id}`는 조직 안 다른 담당자의
로봇도 **관제 요약 객체만** 허용한다. 다른 조직·없는 ID는 404다. 이번 골격에서는 모든
로봇 응답이 동일한 요약 필드만 제공한다. 상세·기록 기능을 추가할 때 담당 밖의
원격측정·실행·사건·사진 ID는 404로 숨겨야 한다. 현재 수신 상태가 없으므로
`connection=OFFLINE`, 그 밖의 미수신 값은 null, 장치·주의 목록은 빈 목록이다.

WS·티켓·에이전트·조종권·STOP·지도·임무·결재·기록 조회·CSV·원격측정 API는 구현하지 않았다.
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
마이그레이션 왕복만 별도로 보려면:

```sh
python -m pytest apps/server/tests/test_migrations.py -q -s
```

이 명령은 새 PostgreSQL에서 실제 `upgrade head → downgrade base → upgrade head`를 실행한다.
새 빈 DB용 `downgrade base`는 자료를 삭제한다. 운영에서는 백업 후 승인된 이관 절차를 따른다.

## 되돌림·한계

배포를 수행하지 않는 기능 브랜치다. 코드는 해당 변경 커밋을 `git revert`한다.
시험 DB는 폐기 가능하며, 자료가 있는 DB는 덤프와 복원 계획 없이 downgrade하지 않는다.
기존 안전 검사는 `python3 sim/v2_link.py --selftest`로 ROS 없이 실행할 수 있다.
실제 HTTPS 프록시·브라우저·앱·실폰·로봇 연결은 이 시험 범위 밖이다.
로그인 보호는 DB 사건 보존 기간(최소 5분 유지)에 의존하고, 여러 조직 운영·RLS는 후속 범위다.

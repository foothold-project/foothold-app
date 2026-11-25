# Docker로 로컬 웹 개발하기

Docker Engine 또는 Docker Desktop과 Docker Compose v2(`docker compose version`)가 필요하다.
저장소 루트에서 실행한다. 호스트에 Python·Node·PostgreSQL을 설치할 필요는 없다.
이미지·패키지를 처음 받을 때는 인터넷 연결이 필요하다.

## 시작

```sh
cp .env.example .env
${EDITOR:-vi} .env  # FH_DB_PASSWORD와 FH_BOOTSTRAP_PASSWORD를 각자 채우고 저장
docker compose up
```

브라우저에서 **http://localhost:5180**을 열고 `.env`의 `FH_BOOTSTRAP_USERNAME`과
`FH_BOOTSTRAP_PASSWORD`로 로그인한다. 웹 포트를 바꿨으면 그 포트로 접속한다.
웹 세션 쿠키는 기존처럼 `Secure`다. HTTP localhost의 Secure 쿠키 예외를 지원하는
Chrome·Edge·Firefox를 사용한다. Safari에서는 이 예외를 지원하지 않으므로 이 HTTP 구성으로
로그인할 수 없다([MDN 설명](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Cookies)).
`127.0.0.1`이나 LAN 주소 대신 **localhost**를 사용한다.

`db`는 운영과 같은 PostgreSQL 16이며 호스트에 DB 포트를 공개하지 않는다.
`server`가 DB 준비를 기다려 역할 생성 → Alembic `upgrade head` → 최초 조직·총괄 생성 →
API 실행을 차례로 수행하고, API 준비 뒤 Vite가 시작한다. API·웹의 호스트 공개 범위는
`127.0.0.1`이다. 컨테이너 안에서만 바인드 주소가 `0.0.0.0`이다.

`apps/web`을 고치면 Vite가 반영한다. `apps/contracts`와 `mobile/sim`은 현재 웹의
JS·JSON·정적 자료 import에 필요해서 읽기 전용으로 연결한다. 시뮬 프로세스는 실행하지 않는다.
`node_modules`는 컨테이너 전용 volume에 저장하며 시작할 때 `npm ci --ignore-scripts`로
lockfile에 맞춘다. 서버 소스를 고치면 `docker compose up --build server`로 다시 빌드한다.

서버 이미지에는 `apps/server`·`apps/contracts`·`apps/simmgr/worlds`와 Docker 진입점이 들어간다.
정적 월드 카탈로그는 migration 0028과 기존 warehouse 지도 등록 복구가 읽으므로,
시뮬 프로세스를 실행하지 않아도 필요하다. `worlds.json`이 참조하는 YAML·PNG·메타데이터·시나리오를
빠뜨리지 않도록 `worlds` 디렉터리를 복사하고 `.dockerignore`에서도 허용한다.

## 환경 변수와 포트

`.env`는 Git에서 제외된다. 실제 계정·비밀번호·서버 주소를 예제에 옮기지 않는다.
각 항목의 설명은 [.env.example](../.env.example)에 있다.

| 항목 | 로컬에서 하는 일 |
|---|---|
| `FH_WEB_PORT`, `FH_API_PORT` | 호스트 포트(기본 5180, 8810); 컨테이너 포트는 5180, 8810으로 고정 |
| `FH_DB_USER`, `FH_DB_NAME` | 전용 DB 초기 관리자·DB 이름; 관리자 이름으로 `fh_app`·`fh_migrate`·`fh_readonly`는 사용 불가 |
| `FH_DB_PASSWORD` | 로컬 DB 관리자와 전용 역할의 비밀번호; 빈 값은 시작 거절 |
| `FH_DATABASE_URL` | `db:5432`의 `fh_app` SQLAlchemy 주소; 비밀번호는 `FH_DB_PASSWORD`에서 URL 인코딩해 주입 |
| `FH_ORG_ID`, `FH_ORG_NAME` | 최초 로컬 조직 UUID·이름 |
| `FH_WS_ORIGIN` | 브라우저의 정확한 `http://localhost:<웹 포트>` 출처 |
| `FH_FILES_ROOT` | 컨테이너 안 파일 volume 연결 위치(기본 `/var/lib/foothold/files`) |
| `FH_ROBOT_INSTALLER_ENABLED` | 예제 값 0; Compose에서도 0으로 고정 |
| `FH_BOOTSTRAP_USERNAME`, `FH_BOOTSTRAP_DISPLAY_NAME`, `FH_BOOTSTRAP_PASSWORD` | 최초 로컬 총괄 계정; 비밀번호가 비면 시작 거절 |

비밀번호에 `$` 등 특수문자가 있으면 `.env`에서 작은따옴표로 감싼다.
예제 URL에는 비밀번호를 따로 쓰지 않는다. DB·마이그레이션 자격 증명과 최초 계정 비밀번호는
초기화 프로세스에만 쓰고 API 실행 환경에서 제거한다(API용 URL은 유지).
한 비밀번호를 DB 역할에 같이 쓰는 것은 이 전용 로컬 구성만의 편의이며 운영 설정이 아니다.

이미 쓰는 포트가 있으면 시작 전에 `.env`의 세 값을 함께 바꾼다. 예:

```dotenv
FH_WEB_PORT=15480
FH_API_PORT=18810
FH_WS_ORIGIN=http://localhost:15480
```

웹은 컨테이너 안에서 `FH_API=http://server:8810`을 사용하므로 호스트 API 포트를 바꿔도
프록시 주소를 바꿀 필요가 없다. Docker 밖 Vite의 기본 바인드는 계속 `127.0.0.1`이다.

## 중지·다시 시작·초기화

`Ctrl+C` 또는 `docker compose down`으로 중지한다. DB·업로드는 이름 있는 volume에 남는다.
다시 `docker compose up`하면 마이그레이션만 적용하고 기존 조직·계정·비밀번호를 덮어쓰지 않는다.
`.env`의 최초 계정 비밀번호를 바꿔도 이미 생성된 로그인 비밀번호는 바뀌지 않는다.
DB 이름·사용자·비밀번호도 기존 volume을 자동 변경하지 않는다. 값이 맞지 않으면 초기화가 실패한다.

**로컬 DB·업로드를 모두 지워 새로 시작할 때만** 다음을 실행한다.

```sh
docker compose down --volumes
docker compose up --build
```

이 명령은 이 Compose 프로젝트의 DB·파일·node_modules volume을 삭제한다.
보존할 자료가 있으면 먼저 내보낸다. `FH_FILES_ROOT`를 바꾸기 전에도 기존 파일 보존 여부를 확인한다.

## 확인과 범위

`docker compose ps`에서 세 서비스 상태를 보고 `docker compose logs server web`으로 확인한다.
필수 비밀번호 누락은 Compose가 시작 전에 안내한다. DB 역할이 일부만 있거나 기존 비밀번호가
맞지 않으면 초기화를 중단하며, 비밀번호·SQL 상세를 로그에 출력하지 않는다.

로봇 조종·실기 연결·Gazebo·시뮬 매니저·폰 터널은 이 로컬 Docker 작업 범위 밖이다.
`FH_SIM_MANAGER_URL`·`FH_SIM_AUTH_FILE`·`FH_PHONE_PASS_KEYS`를 전달하지 않고
로봇 설치 프로그램·서버 경유 조종을 끈다. 로그인 후 로봇이 없는 초기 조직이 정상이다.
운영 배포 설정과 서버에는 이 구성을 적용하지 않는다.

Docker 없이 서버 이미지의 저장소 경로 누락을 검사하려면 Python 3.12 가상환경에서
`apps/server/requirements-test.txt`를 설치한 뒤 다음을 실행한다.

```sh
FH_TEST_PORT_RANGE=15432:15439 python -m pytest -q docker/test_local.py
```

`pgserver` wheel의 임시 PostgreSQL을 사용하며 시스템 DB에 연결하지 않는다.
회귀 시험은 `docker/server.Dockerfile`의 COPY 항목만 임시 폴더에 옮긴 뒤
격리된 Python 프로세스에서 Alembic `upgrade head`를 실행하고 DB 버전을 확인한다.
같은 폴더에서 warehouse 지도 등록 복구도 확인한다. 호스트 저장소의 import 경로와
`PYTHONPATH`는 자식 프로세스에서 사용하지 않는다. Docker의 `.dockerignore` 필터링이나
RUN·컨테이너 환경을 재현하는 시험은 아니므로 실제 이미지 확인은 별도로 필요하다.

이 구성의 첫 제출에서는 Docker 미설치 PC에서 YAML·경로·명령·기존 시험만 확인했다.
**이미지 빌드, `docker compose up`, 컨테이너 간 프록시·WS, 브라우저 로그인·HMR은 아직 확인하지 않았다.**
Docker가 준비된 환경에서 위의 사용 중이지 않은 포트를 지정하여 이어서 확인해야 한다.

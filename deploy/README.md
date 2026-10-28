# 팀 개발 서버 배포 묶음

Ubuntu 24.04 전용 **dev 배포**다. 이 PR은 서버 접속·설치·실행을 하지 않는다.
공인 IP, 실제 주소, 계정, 암호, DSN을 저장소·PR·명령 인수·셸 이력에 적지 않는다.
아래 서버 명령은 SSH 키 등록 후 별도 첫 배포 작업에서 root가 실행한다.
배포는 검토된 `dev`의 **정확한 40자리 커밋**을 지정한다. 브랜치 이름을 실시간 추적하지 않는다.

```mermaid
flowchart LR
    Client[웹 / 폰 앱] -->|HTTPS 443 · FH_SITE| Caddy
    Caddy -->|/ 정적 파일| Web[releases/sha/apps/web/dist]
    Caddy -->|/api/v1/* · WS 포함| API[uvicorn 127.0.0.1:8810 · workers 1]
    API -->|fh_app · loopback| DB[PostgreSQL 16]
    API --> Files[/var/lib/foothold/files]
```

`current`는 `/opt/foothold/releases/<sha>`를 가리킨다. simmgr·에이전트·GPU·ROS·Gazebo·시뮬 자산은 설치하거나 실행하지 않는다.
루트 웹 파일은 Caddy가 읽고 API/WS는 경로를 보존하여 프록시한다. `/api/*`의 다른 경로는 404다.

## 현민님이 먼저 준비할 것

1. 공인 IP를 확보하고 서버의 SSH 공개키를 등록한다. root 로그인과 복구용 콘솔을 확인한다.
2. 네이버 클라우드 ACG는 TCP 80/443 전체, TCP 22 본인 IP만 허용한다. 5432/8810은 외부에 열지 않는다.
3. 사이트는 `<공인IP 점을 대시로>.sslip.io`로 정한다. DNS가 서버를 가리키고 80/443에 도달해야 자동 인증서를 받을 수 있다. sslip.io·CA의 정책/발급 제한으로 실패하면 주소를 재확인한다.
4. 검토한 소스·배포 묶음만 root 소유의 서버 작업 폴더로 전달한다. 이 저장소의 파일을 서버 비밀값으로 편집하지 않는다.

## 웹 빌드는 PC에서

서버 Node 설치를 생략한다. 임시 `git archive`에서 `npm ci --ignore-scripts`와 `npm run build`로 빌드한 정적 파일만 전송한다. 서버 빌드보다 서버의 `node_modules` 디스크와 TypeScript/Vite 빌드 메모리를 절약한다(정량 수치는 미측정). Python venv는 대상 서버의 ABI에 맞게 서버에서 만든다.
PC의 Node/npm은 해당 커밋의 웹 빌드를 지원하는 사전 설치본을 사용한다. 빌드 입력에는 웹이 가져오는 `apps/contracts`, `mobile/sim/maps.json`, `mobile/sim/assets/*/top.png`도 포함한다. 서버에는 웹 `dist`만 보내며 시뮬 실행 코드·원본 자산은 보내지 않는다.

```bash
# PC: 출력 폴더는 저장소 밖. COMMIT은 검토한 dev 커밋을 환경 변수로 지정.
bash deploy/prepare-release.sh "$COMMIT" "$ARTIFACT_DIR"
# SSH 등록 이후 별도 작업에서만 실행. 변수 값은 비공개 운영 메모에서 관리.
rsync -av "$ARTIFACT_DIR/$COMMIT.tar.gz" "$ARTIFACT_DIR/$COMMIT.tar.gz.sha256" \
  "$DEPLOY_TARGET:/var/lib/foothold/incoming/"
```

체크섬은 전송 손상 확인용이며 서명이 아니다. 신뢰하는 PC·검토한 커밋·SSH 경로를 사용해야 한다. tar와 그 안의 Python은 root로 실행할 신뢰 코드다. 임의 업로드나 웹 요청으로 배포를 호출하면 안 된다.
준비 스크립트도 해당 후보 커밋의 것을 사용한다. 웹 주소는 빌드에 넣지 않고 상대 경로 `/api/v1`을 그대로 쓴다.
서버 Python 직접 의존성은 `apps/server/requirements.txt`의 `==` 버전을 사용한다. 전이 의존성 전체 해시 lock은 아직 없으며 향후 재현성 보강 대상이다.

## 첫 bootstrap 및 배포

아래 순서는 **새 서버 전용**이다. 기존 DB/서비스가 있는 서버에는 검토 없이 실행하지 않는다. root로 진행하고 `set -x`·세션 녹화·환경 덤프를 켜지 않는다.

1. 서버 작업 폴더에 검토한 `deploy/`를 놓는다. 공식 저장소의 패키지 목록에서 Caddy 버전을 선택한다. [공식 Caddy 설치 절차](https://caddyserver.com/docs/install#debian-ubuntu-raspbian)의 stable 저장소를 사용한다. `CADDY_VERSION`에는 배포 시 확인한 정확한 apt 버전을 넣는다. bootstrap은 `caddy=$CADDY_VERSION` 설치 후 `apt-mark hold caddy`를 한다. 갱신은 별도 점검에서 `apt-mark unhold caddy` → 새 정확 버전 설치 → 검증 → 다시 hold 순서로 한다.
2. 서버 root 셸에서 `read -r`로 `FH_SITE`, `FH_ORG_NAME`, `FH_BOOTSTRAP_USERNAME`, `FH_BOOTSTRAP_DISPLAY_NAME`, `CADDY_VERSION`을 입력하고 export한다. 비밀번호를 입력하지 않는다. 기존 server.env가 있으면 초기 설정을 유지한다.
3. `bash deploy/bootstrap-server.sh`를 실행한다. Ubuntu apt로 Python 3.12 venv, PostgreSQL 16, Caddy, ufw, rsync 등을 설치하며 Node는 설치하지 않는다. ufw는 22/80/443 TCP만 추가한다. **22의 본인 IP 제한은 ACG가 담당**한다. PostgreSQL은 명시적으로 127.0.0.1에만 바인드한다. 이 단계의 패키지 설치/DB 설정 적용은 서비스 시작을 수반한다.
4. 초기 관리자 비밀번호는 `/root/foothold-initial-admin.txt`(root 소유, 600)에서 서버 관리자가 직접 확인한다. 스크립트는 화면·로그로 출력하지 않는다. DB 암호 3개는 서버에서 생성해 `/etc/foothold/database.env`(600)에 보관한다. server.env는 600, root:foothold이고 **systemd가 root로 읽어** 프로세스에 전달한다. 서비스 계정은 nologin이며 `/etc/foothold` 자체는 700이다. 관리자 DB 접속은 [로컬 peer 인증](https://www.postgresql.org/docs/16/auth-peer.html)만 사용하고 관리자 DSN을 저장하지 않는다.
5. 위 PC 명령으로 만든 묶음과 체크섬을 서버 incoming 폴더에 전달한다. `bash deploy/deploy.sh "$COMMIT"`을 실행한다. 새 릴리스 → venv → fh_migrate로 Alembic → 조직/첫 관리자 최초 생성 → current 원자적 교체 → API 재시작 → Caddy 시작/다시 읽기 → 확인 순서다. 첫 관리자 비밀번호 파일은 bootstrap에서 만들고 **DB 계정 등록은 첫 배포 때** 한다.
6. 확인은 TLS 검증을 켠 `/` HTML 200, 비로그인 `/api/v1/auth/session` 401, 로그인 후 `/api/v1/ws` **101 핸드셰이크**다. 로봇 명령/WS 프레임은 보내지 않는다. 자동으로 만든 확인용 웹 세션은 로그아웃한다. 확인 실패 시 자동 복구 결과를 확인한다.

bootstrap 재실행은 저장한 암호·조직·관리자 파일을 교체하지 않는다. 기존 역할은 저장된 배포 상태가 있을 때만 재사용하며 과도한 역할 속성을 거부한다. 패키지 설정·서비스 정의·방화벽 규칙은 다시 적용한다. 외부에서 역할 권한을 수동 변경한 경우엔 별도 감사가 필요하다. 비밀 파일 생성 도중 중단되어 상태가 불완전하면 자동 덮어쓰기 대신 수동 복구한다.
`bootstrap-state.py`는 내부 도구이며 직접 실행하지 않는다. PostgreSQL의 기본 scram host 인증을 유지하며, 외부 DB 연결 설정은 추가하지 않는다.

## 환경 변수와 권한

`server.env.example`은 변수 이름과 빈 값만 제공한다. 실제 값은 bootstrap이 서버에서 만든다.

| 변수 | 저장/주입 위치 · 용도 |
|---|---|
| `FH_SITE` | `/etc/foothold/site.env` · 유일한 사이트 주소 설정(스킴·경로 없음) |
| `FH_DATABASE_URL` | server.env · API `fh_app` SQLAlchemy URL |
| `FH_ORG_ID` | server.env · bootstrap에서 생성한 서비스 조직 UUID |
| `FH_ORG_NAME` | server.env · 입력한 최초 조직 이름 |
| `FH_WS_ORIGIN` | server.env · 배포 시 `https://` + `FH_SITE`로 생성 |
| `FH_FILES_ROOT` | server.env · `/var/lib/foothold/files` |
| `FH_MIGRATE_PASSWORD`, `FH_APP_PASSWORD`, `FH_READONLY_PASSWORD` | database.env(600) · 세 DB 역할의 무작위 암호 |
| `FH_MIGRATE_DATABASE_URL` | 배포 중 Python 프로세스/자식 환경에만 · Alembic/초기 조직용 |
| `FH_BOOTSTRAP_USERNAME`, `FH_BOOTSTRAP_DISPLAY_NAME`, `FH_BOOTSTRAP_PASSWORD` | 최초 관리자 파일(600) · 최초 조직 생성 때만 사용 |
| `FH_BOOTSTRAP_DATABASE_DSN` | 이 묶음은 저장/사용하지 않음 · 기존 서버 README의 관리자 DSN 대신 local peer 사용 |
| `FH_SMOKE_COOKIE` | 선택 `/root/foothold-smoke.env`(600) · 유효한 웹 `fh_s` 값, 확인용만 |

server.env에는 관리자·마이그레이션 자격 증명을 넣지 않는다. API는 fh_app, 마이그레이션은 fh_migrate, 보고용은 fh_readonly다. API 시작의 기존 DB 권한 검사를 유지한다.
`FH_SIM_MANAGER_URL`, `FH_SIM_AUTH_FILE`, `FH_PHONE_PASS_KEYS`, `FH_TUNNEL*`은 설정하지 않는다. 이 서버는 시뮬 관리자나 폰 출입증 키를 배포하지 않는다.
Caddy는 site.env만 전달받는다. [reverse_proxy의 WS 지원](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)을 사용하며 외부 X-Forwarded-For를 실제 접속 IP로 덮어쓴다. uvicorn은 loopback 프록시만 신뢰한다. TLS는 Caddy 자동 HTTPS, 보안 헤더와 짧은 HSTS를 적용한다. 접근 로그는 켜지 않으며 API 접근 로그도 끈다.
API systemd는 코드/venv를 root 소유 읽기 전용으로 두고 파일 저장소만 쓰게 한다. 단일 worker는 기존 실시간 중재기 소유권 요구다.

## 평소 dev 배포와 되돌리기

검토한 dev 커밋마다 PC 준비·전송·`deploy.sh "$COMMIT"`을 반복한다. `flock`으로 배포/수동 복구 동시 실행을 막는다. 전환 전 실패는 기존 current를 유지하고, 전환 후 재시작/검사 실패는 이전 current로 되돌리고 재시작한다. 첫 배포에 이전 release가 없으면 current를 지우고 API를 정지한다. 복구 실패는 로그에 `FAILED`로 남긴다. 재시작은 기존 연결을 끊으며 사람 조종권을 복원하지 않는다.
수동 복구는 DB와 이전 코드의 호환을 먼저 판단한 뒤 `bash deploy/rollback.sh "$PREVIOUS_COMMIT"`이다. 검사에 실패하면 직전 릴리스로 복구를 시도한다.
**DB는 자동 downgrade하지 않는다.** 새 스키마와 옛 코드가 호환되지 않으면 코드 복구로 해결되지 않으므로 서비스를 정지하고 승인된 DB 복구 절차를 따른다. 새 릴리스 활성화 전 백업을 확보한다. 시뮬 이력 등 기존 마이그레이션의 downgrade 제한은 서버 README를 따른다.
이미 있는 SHA 디렉터리를 덮어쓰지 않는다. 실패한 준비를 재시도하려면 해당 폴더가 current/복구 대상이 아닌지 확인하고 관리자 판단으로 제거하거나 새 커밋을 쓴다. 이전 릴리스·백업을 자동 삭제하지 않으므로 디스크를 관리한다. `/var/lib/foothold/deploys.log`에 시각·SHA·이전 SHA·종료 코드·복구 결과 한 줄을 기록한다.
첫 관리자 비밀번호를 바꾸거나 계정을 잠근 뒤에는 유효한 확인용 웹 쿠키를 `/root/foothold-smoke.env`에 `FH_SMOKE_COOKIE`로 보관한다(600). 없으면 최초 관리자 파일로 로그인 확인을 한 번 시도하며 실패하면 배포를 실패로 처리한다. 이 파일은 백업/보고에 원문을 노출하지 않는다. 유효 기간이 끝나면 갱신하며 임의의 운영 사용자 세션을 재사용하지 않는다.

## 도메인 구매 후

새 도메인의 DNS를 서버에 연결하고 `/etc/foothold/site.env`의 **FH_SITE 한 줄만** 바꾼다. 배포 스크립트의 사이트 반영 단계(`python -m deploy.site`, release 루트에서 해당 venv 사용)를 실행한 뒤 `systemctl restart foothold-server`, `systemctl reload caddy`, `python -m deploy.smoke`로 확인한다. 일반 배포에서도 이 단계가 자동 실행된다. server.env의 `FH_WS_ORIGIN`은 자동으로 파생되므로 직접 편집하지 않는다. 기존 출처의 쿠키는 새 출처로 옮겨지지 않아 다시 로그인한다. DNS/인증서 전환 실패 시 FH_SITE를 이전 값으로 복구해 같은 단계를 수행한다. 도메인 전환은 DB 변경이 없다.
폰 앱은 `mobile/start/index.html`의 **서버 주소 → 열기**에서 새 HTTPS 주소를 입력한다. 검사는 `mobile/start/origin.js`, 선택한 origin의 WebView 이동 허용은 `mobile/android/app/src/main/java/org/footholdproject/app/RemoteClient.java`다. 고정 서버 주소/재빌드 설정을 바꿀 필요가 없다. 이 PR은 앱 코드를 바꾸지 않으며 실폰 연결은 미검증이다.

## simmgr 없는 응답(소스 확인)

`apps/server/fh_server/simulation.py`는 URL이 없으면 `app.state.simmgr=None`으로 설치된다. 시작 실패를 유발하지 않는다. 인증/권한을 통과한 요청 기준:

| API | 결과 |
|---|---|
| GET `/api/v1/simulation/worlds` | 503 `SIM_DISABLED`, reason `manager_unreachable` |
| GET `/api/v1/simulation/robots` | 200, `manager_error=SIM_DISABLED`, 실제 항목 없음; DB에 남은 정리 대상은 별도 cleanup 목록 |
| POST `/api/v1/simulation/robots` | 이 구성은 출입증 키가 없어 먼저 503 `PASS_KEY_MISSING`; 키가 있더라도 관리자 호출은 `SIM_DISABLED` |
| 외부 카메라 관리자 호출 | 503 `SIM_DISABLED`(인증·로봇·권한 등의 선행 검사에 따라 앞서 거부 가능) |

일반 계정/웹/API 개발은 가능하다. 시뮬 API 정상 실행·생성은 지원 범위가 아니다. 코드/기존 시험을 읽어 확인했으며 이 배포 구성의 실제 DB·서버 기동은 하지 않았다.

## 백업(선택, 자동 설치 안 함)

root 전용 700 폴더를 만들고 cron을 관리자가 선택 설치한다. PostgreSQL local peer를 쓰므로 관리자 DSN을 파일/로그에 두지 않는다. 아래 예시는 하루 한 번이며 `%`는 crontab 규칙에 맞게 이스케이프했다.

```cron
15 3 * * * root umask 077; /usr/sbin/runuser -u postgres -- /usr/bin/pg_dump -Fc foothold > /var/backups/foothold/db-$(date +\%F).dump
```

`install -d -m 700 /var/backups/foothold`를 먼저 한다. 실패 알림·보존 기간·암호화된 외부 사본·복원 연습은 첫 배포에서 지정한다. 파일 저장소도 같은 시점의 DB와 함께 별도 백업한다. env/초기 관리자 파일은 비밀 관리 경로로만 보관한다. DB 덤프/파일/비밀 파일은 저장소에 넣지 않는다.

## 이번 검증과 미검증

`bash -n`(모든 sh), 모의 복구 조건 시험 `bash deploy/tests/test_decisions.sh`, Python 구문 검사를 수행한다. shellcheck는 사전 설치본이 있을 때만 실행한다. 서버 앱 코드는 변경하지 않으므로 서버 pytest/전체 앱 빌드는 반복하지 않는다.
깨끗한 `git archive` 폴더에 기존 웹 의존성을 읽기 전용으로 연결해 `npm run build`(`tsc --noEmit` + `vite build`) 1회 통과를 확인했다. 패키지 설치는 0회이며 `prepare-release.sh`의 `npm ci` 및 최종 전송 묶음 생성은 실행하지 않았다.
실제 서버 SSH·root/sudo·apt·systemctl·Caddy 검증 실행·PostgreSQL 설정/권한·Alembic 실적용·TLS 발급·HTTP/WS·실폰은 **미검증**이다. 서버 재현성을 보장하는 배포 완료 기록이 아니며 첫 배포 작업의 관문이다.

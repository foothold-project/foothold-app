# 노트북 로봇 연결 프로그램 내려받기

웹 **+ 로봇 연결하기 → 새 로봇 추가 → 설치 파일 받기**에서 Ubuntu Desktop
amd64용 `.deb`를 받는다. 로그인한 서버 조직의 ORG_ADMIN·OPERATOR에게만 제공한다.

## 웹 계약 (fh-api/1)

- `GET /api/v1/robot-installer/info`: 생성 타입 `RobotInstallerInfo`.
  `{items:[...]}` 안에 linux·windows 항목을 각각 제공한다.
  준비된 항목은 `{platform, available:true, version, size, sha256, built_at, commit, filename}`.
  `size`는 바이트, `built_at`은 UTC ISO 8601, `commit`은 원본 dev 전체 SHA다.
- 준비되지 않은 항목은 `{platform, available:false, reason}`. reason은 `not_built`, `building`,
  `build_failed`, `disabled`, `build_tools_missing`, `limit_exceeded`, `invalid_artifact`,
  `not_supported_yet` (준비 중; Windows 빌드 명령 연결 전). `building`의 화면 문구는 만드는 중이다.
  화면은 준비되지 않은 이유를 안내하고 내려받기 버튼을 비활성화한다.
- `GET /api/v1/robot-installer/{platform}`: 해당 플랫폼 설치 파일 본문, `Content-Disposition: attachment;
  filename="<filename>"`, `Cache-Control: private, no-store`.
  준비되지 않으면 404 `INSTALLER_UNAVAILABLE` (detail.reason 포함).
- 두 GET 모두 기존 로그인 쿠키 또는 앱 Bearer 인증을 쓴다. 미로그인·다른 조직
  세션은 401, 허용되지 않은 역할은 403이다. 조직·경로·파일명 입력은 받지 않는다.
- 기존 성공본이 있으면 새 빌드 중이거나 실패해도 그 성공본을 계속 제공한다.

계약 정본은 `apps/contracts/models.py`, 생성 TS는 `apps/contracts/ts/index.ts`다.

Linux 파일명은 `foothold-robot_<version>_amd64.deb`다. 플랫폼은 `linux`·`windows`만 받는다.

## 서버에서 만들고 보관하는 방법

서버가 켜진 뒤 허용된 사용자의 첫 info/다운로드 요청에서 백그라운드 subprocess를
시작한다. HTTP는 빌드 완료를 기다리지 않는다. 배포된 릴리스의 `COMMIT`과 `apps/agent`
전체(installer와 pyproject 포함)의 내용을 사용한다. 입력이 같으면 새 dev 커밋에서도
기존 성공본을 제공하고, 입력이 바뀌거나 성공본이 없을 때만 다시 만든다. 주소는 비공개
서버 설정 `FH_WS_ORIGIN`(기존 deploy.site가 `FH_SITE`에서 유도)을 읽고 소스에 넣지 않는다.
기존 릴리스 archive는 이미 `apps/agent` 전체를 포함한다.

실행자는 API와 같은 root 아닌 서비스 계정이다. API 환경변수·DB 설정을 자식에게 넘기지
않고 nice +10, 20분, 상태 폴더 전체 1 GiB 상한으로 자식 프로세스 그룹을 중단한다.
0.25초마다 검사하므로 검사 사이에 잠시 초과할 수 있으며 단일 파일에도 상한을 적용한다.
python3·dpkg-deb 없음, root 실행, 빌드 실패, 상한 도달은 reason으로 알린다.
apt·sudo·SSH는 사용하지 않는다.

고정 저장소는 `${FH_FILES_ROOT:-/var/lib/foothold/files}/robot-installer/<platform>/`다.
기존 systemd 서비스의 ReadWritePaths 안에 있으므로 deploy-tools 갱신은 필요 없다.
`cache/` 입력은 기존 build.py가 사용 전에 SHA256을 재검증한다. 빌드 사본은
`work/source/output/easy-install/`, 완성본은 `releases/<commit>/installer`와 `info.json`이다.
`current`를 원자 교체하고 `previous`에 옛 성공본 하나를 보관한다. `work/`는 성공·실패 후
지운다. `attempts/<commit>.json`은 보존하여 실패·중단한 같은 SHA는 자동 재시도하지 않는다.
플랫폼별 flock으로 API 재시작 뒤에도 동시에 빌드하지 않는다. 배포 잠금·결과·실패 SHA를
조작하지 않는다.

끄려면 비공개 server.env에 `FH_ROBOT_INSTALLER_ENABLED=0`을 설정하고 다음 승인된 보통
배포 절차를 따른다(기존 파일도 내려받을 수 없게 된다). 복구는 새 dev 커밋으로 하며,
실패 기록 자동 삭제나 같은 SHA 재시도는 하지 않는다. Windows는 `BUILDERS` 표에
`--server/--output/--version`을 받는 빌더를 한 줄 추가하여 켤 수 있다.

첫 Linux 빌드에는 x86_64 Linux, python3, dpkg-deb와 외부 HTTPS(고정 CPython·PyPI wheel·
SDK/binutils 입력 받기), 상태 영역 최대 1 GiB 여유, 최대 20분이 필요하다. OS 패키지를
추가하지 않고 도구가 부족하면 이용 불가로 끝난다. 설치 파일 생성은 실기·DDS·노트북
설치 성공 검증을 대신하지 않는다.

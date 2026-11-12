# 노트북 로봇 연결 프로그램 내려받기

웹 **+ 로봇 연결하기 → 새 로봇 추가 → 설치 파일 받기**에서 Ubuntu Desktop
amd64용 `.deb`를 받는다. 로그인한 서버 조직의 ORG_ADMIN·OPERATOR에게만 제공한다.

## 웹 계약 (fh-api/1)

- `GET /api/v1/robot-installer/info`: 생성 타입 `RobotInstallerInfo`.
  준비되면 `{available:true, version, size, sha256, built_at, commit}`.
  `size`는 바이트, `built_at`은 UTC ISO 8601, `commit`은 원본 dev 전체 SHA다.
- 준비되지 않으면 `{available:false, reason}`. reason은 `not_built`, `building`,
  `build_failed`, `disabled`, `build_tools_missing`, `limit_exceeded`, `invalid_artifact`.
  화면은 준비되지 않은 이유를 안내하고 내려받기 버튼을 비활성화한다.
- `GET /api/v1/robot-installer`: `.deb` 본문, `Content-Disposition: attachment;
  filename="foothold-robot_<version>_amd64.deb"`, `Cache-Control: private, no-store`.
  준비되지 않으면 404 `INSTALLER_UNAVAILABLE` (detail.reason 포함).
- 두 GET 모두 기존 로그인 쿠키 또는 앱 Bearer 인증을 쓴다. 미로그인·다른 조직
  세션은 401, 허용되지 않은 역할은 403이다. 조직·경로·파일명 입력은 받지 않는다.
- 기존 성공본이 있으면 새 빌드 중이거나 실패해도 그 성공본을 계속 제공한다.

계약 정본은 `apps/contracts/models.py`, 생성 TS는 `apps/contracts/ts/index.ts`다.

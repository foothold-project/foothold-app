# 폰에서 PC 시뮬 미리보기 열기 — Quick Tunnel

이 문서는 **다음 실행 작업**을 위한 안내다. 코드 준비·단위 시험만으로 터널이나 실폰
검증을 마쳤다고 보지 않는다. 운영·실기에는 적용하지 않는다. 실행 중인 시뮬·미리보기의
설정이나 프로세스를 바꾸는 일은 담당자가 안전하게 종료한 뒤 별도로 진행한다.

## 준비

폰의 `127.0.0.1`은 폰 자신이다. 외부 주소에서 연 화면의 조종·카메라 WS는
`wss://<random>.trycloudflare.com/__fh_phone/<port>/phone/ws`와
`…/phone/camera/ws`를 통해 PC의 **정적 Vite preview**로 들어온다. preview는 빌드된
`dist`만 제공하고 HTTP API·`/api/v1/ws`·두 폰 WS 경로를 프록시한다.
출입증·명령 내용과 판정 위치는 그대로다. localhost·127.0.0.1·IPv6 loopback에서
연 화면은 기존 직접 WS를 쓴다.

`cloudflared`는 [공식 다운로드](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)의
OS·아키텍처에 맞는 실행 파일을 사용자 경로에 받는다. 다음은 Linux x86-64 예시다.
sudo·시스템 패키지 설치·서비스 등록은 필요 없다. 아래 명령은 이 PR 검증에서 실행하지 않았다.

```sh
mkdir -p "$HOME/.local/bin"
curl -fL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
  -o "$HOME/.local/bin/cloudflared"
chmod u+x "$HOME/.local/bin/cloudflared"
```

## 실행 담당자의 순서

1. 승인된 시뮬 시험 환경과 계정·출입증 키를 기존 절차로 준비한다. 비밀 값은 저장소에
   적지 않는다. **운영 env에는 `FH_TUNNEL`을 넣지 않는다.**
2. `apps/web`에서 에이전트 범위를 정하고 먼저 빌드한다. 이 값은 브라우저 번들에도
   들어가므로 범위를 바꾸면 다시 빌드한다. 새 의존성은 필요 없다.

   ```sh
   export FH_PHONE_PORT_RANGE='9433:9434'
   npm run build
   ```

3. 터널 전용 preview 터미널에서 빌드 결과물만 정적으로 제공한다. API가 기본 개발
   서버와 다르면 기존 `FH_API` 값을 사용한다.

   ```sh
   export FH_TUNNEL=1
   npm run preview -- --port 5190
   ```

   아직 `FH_TUNNEL_ORIGIN`이 없으면 경고와 함께 외부 Host를 거부한다.
   **`npm run dev`로 터널을 열지 않는다.** dev는 `FH_TUNNEL=1`이어도 경고하고 외부
   Host와 폰 프록시를 거부한다. 개발 모듈·PC 파일을 인터넷에 제공하지 않는다.
4. 별도 터널 터미널에서 임시 주소를 받는다. 순서는 **build → preview + FH_TUNNEL →
   cloudflared**다. `localhost`가 IPv6로 해석되어 연결에 실패하면 URL의 호스트만
   `127.0.0.1`로 바꾼다.

   ```sh
   "$HOME/.local/bin/cloudflared" tunnel --url http://localhost:5190
   ```

5. 출력된 **정확한 HTTPS Origin**을 터널 전용 preview 환경과 서버·simmgr를 시작하는
   각 환경에 넣는다. 예시의 `<random>`을 실제 받은 이름으로 바꾸되 슬래시·포트·경로·
   와일드카드는 넣지 않는다. 주소는 커밋하지 않는다.

   ```sh
   export FH_TUNNEL=1
   export FH_TUNNEL_ORIGIN='https://<random>.trycloudflare.com'
   ```

   이 작업에서 새로 띄운 터널 전용 preview를 종료하고 같은 `npm run preview -- --port 5190`으로
   다시 시작해야 새 Origin을 읽는다. 기존 미리보기·운영 프로세스는 건드리지 않는다.
   서버·simmgr는 승인된 기존 실행 절차와 비밀 설정을 유지한다. systemd 등으로 시작한다면
   셸 export만으로 서비스 환경이 바뀌지 않는다. simmgr는 새 에이전트에 Origin을 전달하므로
   이미 실행 중인 에이전트는 바뀌지 않는다. 기존 `FOOTHOLD_PHONE_ORIGINS` 목록은 보존한다.
   독립 simulation agent도 두 환경 값을 읽지만 실기 agent에는 자동 추가하지 않는다.
   프록시는 Host와 Origin을 바꾸지 않으며 `FH_WS_ORIGIN`의 기존 값도 보존한다.
6. 폰에서 받은 HTTPS 주소를 열고 로그인한다. 로봇 연결·카메라·출입증 만료·STOP·폰 연결
   끊김 정지를 별도로 검증한다. 터널 지연은 현장 직결 검증을 대신하지 않는다.

## 에이전트 포트 경계

`FH_PHONE_PORT_RANGE`는 **웹 프록시·가드·브라우저 주소 검사**에 공통으로 적용한다.
기본은 **9433:9434**이며 `9433:9433`·`9434:9434`처럼 그 부분집합만 허용한다.
잘못되거나 넓힌 범위는 경고 후 폰 프록시를 끈다. 관리자9430·서버/DB9431·웹9440과
8870·8453·8792 등 나머지 포트는 env와 상관없이 거부한다.

근거: `apps/simmgr/config.py`의 `Slot.port`를 `apps/simmgr/launcher.py`가
`FOOTHOLD_PHONE_PORT`로 그대로 전달한다. `tools/first_launch.py`의 catalogue는
9433을, `tests/test_manager.py`의 두 슬롯은 9433·9434를 사용한다. simmgr의 일반
9430~9449 서비스 허용 목록 전체가 에이전트 포트라는 뜻은 아니다. catalogue는 포트를
별도로 설정할 수 있지만 이 터널은 확인된 두 슬롯만 허용한다. 임의 extra port나 관리자
포트 재배치는 지원하지 않는다. 터널 사용 전에 catalogue의 슬롯/서비스 구성을 확인한다.

프록시는 `/phone/ws`·`/phone/camera/ws` WS만 받고 일반 HTTP·쿼리·다른 호스트·경로를
거부한다. `/api/v1`과 서버 실시간 WS는 API 프록시를 쓴다.

## 제한과 종료

- **주소를 아는 사람은 로그인 화면과 빌드된 웹 자료까지 접근할 수 있다.** Quick Tunnel은
  접근 인증 서비스가 아니다. 공유 범위를 제한하고 시험 후 바로 종료한다. 로그인·CSRF·
  출입증 검증은 계속 필요하다. 이 방식은 배포용 웹 서버 구성이 아니다.
- 터널 경유 요청은 서버·에이전트에서 `127.0.0.1`로 보인다. 외부인이 로그인 시도 제한
  **5회/5분**을 채우면 로컬 로그인도 막힐 수 있다.
- 터널 허용은 기본 꺼짐이다. preview에서 `FH_TUNNEL=1`과 유효한 `FH_TUNNEL_ORIGIN`이
  함께 있을 때만 정확한 `.trycloudflare.com` Host와 HTTPS Origin 하나를 추가한다.
  잘못된 주소는 경고 후 무시한다. 전달된 Host 헤더나 임의 Origin을 신뢰하지 않는다.
- Vite 5.4.10의 `allowedHosts`는 구현되지 않았다. HTTP·WS upgrade 가드가 실제 경계를
  검사한다. 터널 Host의 `/@fs/`·`/@id/`·`/@vite`·`/__vite`·`/node_modules/`·`/src/`는
  query 유무와 관계없이 403(빈 본문)이다. dev 서버는 터널 Host 전체를 거부한다.
  Vite 업그레이드는 별도 권고로 남기며 이번에는 공유 의존성을 바꾸지 않는다.
- 세션 쿠키는 기존 `Secure; HttpOnly; SameSite=Strict; Path=/api/v1` 그대로다.
  HTTPS API와 WSS `/api/v1/ws`는 같은 사이트·경로이므로 쿠키를 보낼 수 있다.
  `/__fh_phone`은 첫 WS 프레임의 출입증을 쓴다. HTTP LAN 주소에서는 Secure 쿠키 로그인을
  기대하지 않는다. CSRF 헤더 검사도 그대로다.
- 끝날 때 먼저 기존 화면의 끝내기로 조종권을 반납하고 시뮬 종료를 확인한다. 터널 터미널에서
  Ctrl-C로 `cloudflared`를 끝낸다. 웹·서버·simmgr의 실행 환경에서
  `unset FH_TUNNEL FH_TUNNEL_ORIGIN FH_PHONE_PORT_RANGE`하고 승인된 기존 절차로 해당
  개발 프로세스·에이전트를 종료해 허용을 회수한다. unset만으로 이미 실행 중인 프로세스의
  허용 목록은 바뀌지 않는다. 기존 프로세스를 임의로 재시작하지 않는다.
- Quick Tunnel을 다시 만들면 주소도 달라질 수 있다. 새 주소로 세 환경을 맞추고 새로
  로그인한다. 실폰·외부 네트워크·Cloudflare 연결·실로봇 검증은 별도 작업이다.

[Cloudflare Quick Tunnel 안내](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)를
참고한다. 기존 `.cloudflared/config.yaml`이 있으면 Quick Tunnel과 충돌할 수 있으므로
기존 파일을 임의로 삭제하지 말고 실행 담당자가 별도 환경을 준비한다.

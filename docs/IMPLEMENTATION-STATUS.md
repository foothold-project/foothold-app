# 구현 상태 — 판별 정본 (2026-10-13 18:06 실측 기준)

이 문서 하나가 «어느 판이 무엇을 하고, 어디서 검증됐고, 실제로 쓰이는가»의 정본이다. 화면 이식 개수는 PRD 완료가 아니다.

## 판별 표

| 판 | 코드 판 | 기능 | 검증 환경 | 실폰 · 운영 반영 | 사용 경로 |
|---|---|---|---|---|---|
| 기존 canonical | 83b25ca (운영 체크아웃, 이 브랜치와 별개) | 원본 19화면 `web/*.dc.html` + `web/live.js` + `sim/v2_link.py`(조종권·STOP·명령 제한·공유 문서) | 이 문서 범위에서 다시 검증하지 않음 | 운영 판. 16:52 실측 8792·8453 LISTEN 없음 = 지금 서빙 꺼짐 | 관문 https 8453(켜져 있을 때) |
| 새 React | 이 브랜치 `less82/app-ui-react-recovered`(Draft PR #1 → `feature/two-device`). 화면 19 = ff4e407, B1 UI 어댑터 = 28392b0, B2 저장 = a98c7fa | 19화면 모두 원본 틀로 연결(모의): 기존 16 + MLogin·PcLogin(a63a465, 웹 쿠키 로그인) · System(d2833e2, 디자인 체계 참고 화면 — 센서 기능 아님). 조종 경계 `ui/src/data/link.ts`(29c758c → 27a50bb). 전송층 `ui/src/data/transport.ts` 하나가 웹 쿠키 / 네이티브 B 를 고름(아래 B 행). **화면 연결 19/19 ≠ PRD 완료** | 모의만: 가짜 시뮬 + `sim/v2_link.py` 8791 · Vite 5181 · 개발 관문 `--spa` 127.0.0.1:18453(자체서명·시험 계정) · 헤드리스 Chromium 합성 입력 · vitest 36건(a98c7fa, 가짜 FhGate 포함) | 실폰 0 · 운영 반영 0 | 개발 서버만 |
| 기본 bundled APK | React e618139(브랜드 적용 전) | 앱 안 React 번들, 서버 연결 없음 | 에뮬레이터 API 34 설치·실행 | 실폰 0 · 최종 배포판 아님(debug 서명) | 표: 아래 «APK 판 표» |
| 원격 A APK | 외피 3885275(`GateSslClient`) | 관문이 내주는 **옛 웹(`web/`, live.js)** 을 원격으로 띄움. 앱 안 www(React)는 쓰이지 않음 | 5회차 PASS — 로그인 전: 관문 인증서 확인·다른 CA 거부 안내 / 로그인 후: 읽기 왕복만. **로그인 후 조종·숨김(lifecycle)은 미검증** | 실폰 0 | 표: 아래 «APK 판 표» |
| 최종 bundled B | 없음 — 설계 2판(733044e) 방향검수 통과 · **구현 준비 단계**. 네이티브 어댑터 B1(모바일 담당) 404da91 · 계약 `mobile/docs/FHGATE-CONTRACT.md` v0.1(gen·err.data.gen·sessionEnded.gen·logout ok·stored/locked) — 앱 Codex 좁은 읽기 검수 통과. UI 쪽 B1 어댑터 `ui/src/data/transport.ts` = 28392b0(앱 Codex 좁은 재검수 통과, **최종 B 통합 시험의 UI 기준**): 앱 출처 + FhGate 일 때만 native, 원격 A 는 web · gen + 로컬 epoch · 콜드 스타트 no_gate/잠김 → 로그인 화면 · 서버 로그아웃 확인 안내. B2 저장 = a98c7fa(계약 d4e5002·af602ba, 읽기 검수 통과, B1 통합과 별도): bundled B 만 saveFile, 원격 A·플러그인 없는 앱은 저장 미지원 | 앱 안 React + 관문 주소·앱 전용 토큰·1회용 WS 표. 서버 앱 전용 경로 S1~S4: 개발 사본 **구현 de29404**(분리 `sim/app_auth.py` + `sim/v2_gate.py` 최소 연결, 계약 v0.1 d83761e · 기존 Core·웹 쿠키·브라우저 WS 불변, 앱 Codex 읽기 검수 통과) | S1~S4: 개발 관문→모의 8791 시험 49/49(`runs/b-server/`). B1 네이티브 어댑터: 모의 시험 27건·정적 빌드뿐(404da91). UI 어댑터: vitest 31건(28392b0)·B2 포함 36건(a98c7fa), 가짜 플러그인뿐. 모바일 fixture·통합 러너 실행 0 · SAF 실제 창 0. **플러그인 실호출 0 · 네이티브 실호출 0 · 실서버 0 · 실APK/실기기 0 · 운영 관문 반영 0**(로그인 전·후 모두). 서버 49/49 는 모의 시험 숫자이지 운영 근거가 아님 | 실폰 0 · IPA 0 | 설계: `less82/app-contract-storage` 의 `mobile/docs/B-BUNDLED-DESIGN.md`·`FHGATE-CONTRACT.md` |
| iOS | 프로젝트만 | — | 없음. 이 PC 에 Mac·Xcode·서명 없음 → IPA 0 | iPhone Safari 웹 접속은 네이티브 근거가 아님 | — |

APK 판 표(sha256·빌드·회차별 결과): 브랜치 `less82/app-contract-storage` 의 `mobile/README.md` 「APK 별 판」(3fc9dc3). APK 파일은 git 무시.

## 지금 확인된 것 / 아닌 것

- 조종(MDrive, d342c80): 보기 전용으로 시작 → 막대 첫 누름은 «조종권 받기»만(명령 없음) → STOP 해제 뒤 막대 = 20 Hz `cmd` → STOP 뒤 `cmd` 0건(0 도 섞이지 않음) → pagehide 에 `hidden` 1회 + 보기 전용. **모의 서버 + 합성 입력 근거뿐.** 실제 APK 에서의 pause/숨김·실기기 다지점 터치는 미검증.
- STOP 은 명령 0 요청 + 잠금이다. «STOP 뒤 약 3.6 s 동안 0.32 m 더 이동»은 시뮬 실험 관측이지 정지 거리·시간 보장이 아니다(원인 미확인).
- Main(PC 조종, 14453ae): 보기 전용 시작 → 누름 버튼 첫 누름은 take 만 → STOP 해제 뒤 누름 = 20 Hz `cmd`(아크 fx 1·fw ±1) · ↑ 키 누르는 동안만 · 크게 보기(확대 STOP 포함, 열고 닫을 때 폐기) · 누른 채 화면 떠남 → hashchange 뒤 0 아닌 `cmd` 0 + `hidden` · 1440/1280/1024 폭 STOP 보임·넘침 0·시안 예시값 0. **모의 + 헤드리스 합성 입력 근거뿐.**
- 경계 보완(27a50bb, 앱 Codex 중간검수 3건): 누른 손가락만 손잡이·값 변경, 같은 pid 만 up 정리, 서랍(메뉴)·전체화면·confirm 전 폐기, 낡은 손가락 move·hover·다른 pid up 으로 되살아나지 않음(md_check ⑥~⑧).
- Main 키(9dfae30): ↑ 앞, ↑+←/→ 아크. ←/→ 단독·↓ 는 서버가 0 으로 막음을 그대로 표시(지원 속도·서버 제한 변경 없음). 입력 두 곳 초과 → 전부 멈춤 + 이유.
- 로그인(a63a465·48a3318): 원본 틀에 실제 로그인(예시 계정 없음) · WS 4401 → 로그인 화면(next 는 앱 해시 경로만) · 로그아웃 = hidden → 세션 끝 → whoami 401 · 옛 로그인 응답은 의도 번호로 버림. 근거 `runs/bundle4/login/`(PC·Android UA 헤드리스, 모의). 실폰·실APK 미검증.
- System(d2833e2): 디자인 체계 참고 화면 안내(숫자는 시안 예시·센서 미연결), 표본 STOP 은 실제 stop 전송.

## 우선순위 (앱 Codex 10-13)

1. 조종 경계 + 핵심 STOP/숨김/끊김 통합(Main 포함) → 실기기 접속·터치 시험.
2. 최종 B 로그인·인증서·Origin·API·WS·lifecycle 설계 병행(모바일 담당, 구현·보안 완화 없음).
3. 깊이·3D 등.

## 역사

- 묶음별 결과·시험 명령: `docs/PLAN-parallel-platform-20261013.md`(묶음 1 결과·브랜드·복구 절은 당시 기록).

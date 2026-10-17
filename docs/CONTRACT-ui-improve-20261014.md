# Unitree 비교 개선 구현 — 최소 계약·수락 기준 (2026-10-14, UI mentor)

근거: `docs/REVIEW-unitree-rea.md` r2.1(756f442d) §2 추천 ①~⑥. 기존 19화면·공식 브랜드·사용자 승인 막대 배치 안에서만. 새 센서·실 Go2·OTA·자율 0.
순서: P1(① 접속, ② 조종 단계, ③ 경고 목록) → P2(④ 영상|지도, ⑤ 마지막 사진, ⑥ 상태 칩). Git: 검수 전 push 0, 로컬 커밋만.

## ① 접속 프로필 · 주소 공유 · 연결 단계

### 관문 S5 — 로그인 불요 검사 (sim/v2_gate.py)
| 경로 | 조건 | 200 본문 | 그 밖 |
|---|---|---|---|
| `GET /api/health` (웹) | Host ∈ 이 관문 주소 · Origin 없음 또는 같은 출처 | `{"app":"foothold-gate","api":1}` | 403 Host/Origin · 429 상한 |
| `GET /api/app/health` (앱) | 기존 AppBase(앱 Origin 2값 정확 일치 + Host) | 같음 | 403 · 429 |
- 본문은 위 두 키뿐(모바일 mentor 안 A 와 같음). 계정·세션·기기·PID·호스트 경로·버전·IP 0. 쿠키·Authorization 읽지 않음. 로그인 실패 제한(RateLimit)과 별개.
- 상한: IP 당 60 s 에 60회(넘으면 429, 시각 = `time.monotonic`). GET 만. 표가 4096 IP 를 넘으면 통째로 비운다 — 메모리 보호일 뿐 **보장된 IP 제한이 아니다**(많은 IP 로 돌리면 개별 카운트가 초기화됨).
- 기존 `/api/login`·`/api/app/*`·`/ws`·`same_origin` 경로 불변.

### 네이티브 (모바일 mentor 안 A·C 합의 — 정본은 FHGATE-CONTRACT)
- `probe()` → `{status, compat, api, gen}`. 대상 = 지금 setGate 된 origin 만(인자 없음). `GET <origin>/api/app/health`, Authorization 0, ≤4 KB, redirect 거부, 동시 1. 시한은 **정확한 8 s 상한이 아니다**(FHGATE-CONTRACT 그대로): 연결 ≤ 4 s · 소켓 읽기 한 번 ≤ 4 s, 8 s 검사 시한은 본문 읽는 동안 각 읽기 뒤에만 봄 → 마지막 블로킹 읽기(≤ 4 s)만큼 넘을 수 있음(대략 12 s 넘게도 가능), 전체 강제 중단 없음. 화면은 그동안 «확인 중». compat = 200 + 본문 정확히 `{"app":"foothold-gate","api":정수≥1}`. reject `no_gate`·`net`·`tls`·`redirect`·`too_big`·`busy`·`stale`.
- 카메라: 네이티브는 CAMERA 권한 + uses-feature required=false 만. 스캔은 화면 getUserMedia + BarcodeDetector(없으면 스캔 버튼 숨김 → 붙여넣기). 새 의존 0. 닫기·hidden·pagehide·unmount 때 track.stop(). 스캔 수명(`data/qrscan.ts`): 닫힌 뒤 늦은 detect·getUserMedia·play 결과는 onOrigin·onClose·안내 0, 늦게 온 카메라는 즉시 끔, detect 동시 1·수락 1회. 수락 = 입력칸에 넣기까지 — 저장·주소 변경은 기존 «주소 저장»(웹은 확인창) 뒤에만.
- 화면 쪽 대조: 시작 epoch → `await sync` 뒤 epoch 재대조(바뀌었으면 probe 0회·STALE) → 응답 epoch·`gen` 대조 → reject 도 `e.data.gen === 호출 gen` 일 때만 net/tls 단계에 붙임(아니면 STALE).
- 화면은 `typeof P.probe === 'function'` 일 때만 부른다. 없으면 «도달·인증서 확인 = 로그인 때»(몰래 로그인 요청으로 시험 0).
- 프로필 저장 = 화면 localStorage `{v:1, profiles:[{id,name≤40,kind,origin}]≤8}`, 네이티브 0.
- QR 내용 = 평문 origin `https://호스트:포트` 만 생성·수락(`fhgate:1?…` 형식은 이번에 안 씀 — 계정·토큰 칸 원천 0).

### 화면 (로그인 화면 기존 서버 카드 안)
- 프로필: 이 기기에 저장한 주소 목록(이름·origin만, 비밀 0). 이름은 주소로 정함: 100.64.0.0/10 → Tailscale, 사설 대역 → LAN, 그 밖 → 직접 입력. 포트 하드코딩 0(실제 origin 그대로).
- 웹: 다른 주소 고르기 = 그 주소로 이동(교차 출처 fetch 0). 네이티브: `setGate`.
- 붙여넣기: 글 하나 → gateOrigin 통과한 origin 만. 공유: `navigator.share`(없으면 복사) — 주소만.
- QR: 지금 관문 주소(`/api/hosts` + 지금 origin)를 QR 로 보여 줌(qrcode-generator 1.4.4, start.html 과 같은 라이브러리). QR 내용 = `https://호스트:포트/` 뿐.
- 연결 단계 줄: 주소 형식 → 도달 → 인증서 → FOOTHOLD 관문 → 로그인 → 링크(WS). 각 칸 = 확인됨 / 실패(이유) / 미확인. «주소 저장됨» ≠ «연결 확인됨».
  - 웹: 도달·관문 = `/api/health`(전체 8 s AbortController · `redirect:'error'` · 본문 4 KB 상한 · 쿠키 0). **인증서 칸은 «브라우저 처리 · 신뢰 미확인»(별도 상태 `brw`)** — https 로 열렸어도 사용자가 경고를 넘겼는지 JS 로 모르므로 «확인됨»으로 쓰지 않는다. 브라우저는 네트워크 실패와 redirect 거부를 같은 TypeError 로 줘서 둘을 가르지 않는다.
  - 네이티브: `probe` 결과 코드로 도달(net)·인증서(tls)·관문(bad_type/origin) 구분. 인증서 «확인됨»은 네이티브 probe 성공(시스템 + dev CA 검증)일 때만.
- 수락: 옛 관문(경로 없음 → HTML 200) = «관문 확인 못 함»(성공 아님) · 잘못된 주소 = 형식 단계에서 멈춤 · 로그인 실패는 로그인 단계에만.

## ② 조종 단계 (공용 `data/drive_stage.ts`)
- 입력: 서버 `role`·`latch`·`resume_pending`·`reset_pending`·`sim_block`·링크 신선도·`viewOnly` + 실제 발행 판정 `driveBlock(L)` 결과(`block`).
- 단계: 보기 → 조종권 → STOP 해제 → 조종 가능. 막힘(링크 끊김·시뮬 막힘·리셋 중·해제 대기·다른 기기)은 단계 대신 이유. «조종 가능»은 `driveBlock(L) === null` 일 때만 — 새 판·형식 이상(옛 st 남음)·STOP 직후 ACK 전(stopHeld)이면 그 이유를 표시(명령·Core 변경 0).
- «다음 행동» 한 줄. 자동 take/resume 0 — 버튼은 기존 것(사람이 누름).

## ③ 경고 목록 (같은 파일)
- 항목: `{lvl: 'block'|'warn'|'info', text, fix}`. block = 지금 명령 0(driveBlock 이 실제로 막는 사실만 — 새 판 포함), warn = 주의(명령은 막지 않음), info = 안내. 넘어짐 단독은 warn(Core·driveBlock 이 낙상만으로 막지 않는 기존 계약, 새 안전 차단 0) + 필요 시 수동 STOP→시뮬 리셋 안내.
- 폰: 가운데 알림 = 가장 높은 항목 1줄(`■/▲/●` 문구 — 해결) + 2개 이상이면 «목록 N» + 기존 큰 버튼(새로고침·시뮬 시작·조종권 받기·STOP 해제·시뮬 리셋). «목록 N» → dropAll → 가운데 알림 자리(top 150, 폭 420, 최대 200 px, 스크롤)에 목록(항목별 «해결: …») + 같은 큰 버튼 + «목록 닫기». 목록이 열린 동안 가운데 알림은 숨김(버튼 가림 0). 경고 0 이면 자동 닫힘. STOP 과 겹치지 않음(헤드리스 실측: 목록 212–632 × 150–350, STOP 668–800 × 14–78, STOP 중심 elementFromPoint = STOP).
- 단계 표시: 첫 HUD 칩이 «보기 › 조종권 › STOP 해제 › 조종 가능»(지금 칸 진하게, 막힘이면 주황) · aria-label/title 에 막힘 이유·다음 행동.
- PC: 기존 mode·motion 줄 유지, 칩에 «단계 …» 하나만 추가(작은 변경).

## ④ 영상|지도 (폰 MDrive)
- 작은 칸 탭 = 배치 순환: 영상 크게 → 반반(왼쪽 영상·오른쪽 지도, 작은 칸은 «반반 보기 · 눌러 바꾸기») → 지도 크게(작은 칸에 영상). 큰 지도 화면은 메뉴 «큰 지도 열기». 키보드 Enter 는 원래 링크(큰 지도) 그대로.
- 영상 img[data-live-cam] 은 늘 1장(옮겨 그릴 뿐 — link.ts 가 같은 선택자로 프레임을 넣음), 큰 쪽 지도는 MapCanvas small(포인터 0, 손가락은 막대로만).
- 전환 전 dropAll. 손가락 2개 규칙 그대로. 작은 지도는 GT 그대로(실시간 지도 결속 규칙 미접촉).
- 배치는 이 기기에 저장(`fh.live.split`, 낡은 «조종 중» 상태 복원 0 — 화면 배치만).

## ⑤ 마지막 사진
- 폰: 서버 사진 목록(useMedia)의 saved_at 가장 최근 1장 썸네일(오른쪽 버튼 줄 아래 72×48) → `#/MFinding?url=`. 새 팝업 0. 사진 없으면 칸 없음.
- PC: 이번 묶음에서 바꾸지 않음(기존 «사건 기록 · 조종·사진 기록» 링크·WP 사진 칸 그대로).

## ⑥ 상태 칩
- 배터리·온도: 상태 필드 없음 → «배터리·온도 미연결»(폰 HUD·PC 칩). 응답 시간 = «앱↔관문» HTTP(웹 `/api/health`, 앱 `probe()`, 5 s 마다, 조종 화면 보일 때만) — 로봇 링크 속도 아님. 네이티브 probe 없으면 «미측정».

## 시험
- 관문 selftest + 합성(가짜 관문 상태 · mock) · 순수 함수 selftest(단계·경고·주소 분류·QR 내용) · PC·폰 헤드리스 스크린샷.
- 실 Gazebo·원장·사용자 탭·운영 serve 접촉 0. 새 APK 0(최종 1개는 native+UI 고정 뒤).
- 미확인으로 남길 것: 실폰 QR 스캔·iPhone Safari 경로·네이티브 probe 실호출.

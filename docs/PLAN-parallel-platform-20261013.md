# 병렬 플랫폼 개발: 역할·파일·상태 (2026-10-13)

현민님 명시 승인(앱 Codex 전달): «그대로 작업 claude 한테 나눠서 병렬로 진행해줘. 필요하다면 claude 세션을 새로 열어도 좋아.»
이번 범위에서 «계획 문서만»·«새 담당 금지» 규칙을 대체한다. 구현·저장소 범위 무료 의존성 설치·모의 검증까지 진행한다. 과거 규칙 때문에 대기하지 않는다.
유지: 운영 판(83b25ca)·서빙(8792/8453) 무변경, 라이브 무단 교체 금지, 실기·Pod·새 Gazebo·실체험 원장 무접촉, main/force 금지, 위키는 위키 Codex 단독.

## 역할 (앱 Claude 작업자 2명, 하위 위임·추가 세션 없음)

| 담당 | 브랜치 · 위치 | 소유 파일 |
|---|---|---|
| 고정 앱 mentor (UI·모바일·전체 통합) | `feature/react-platform-oh`, worktree `foothold-app-wt-live-ui` | `ui/**`, `mobile/**`, 루트 JS 패키지·lock, 프론트 시험, 이 문서, 기존 `sim/`·`web/` 의 최종 연결 |
| 백엔드 mentor | `less82/app-contract-storage`, checkout `app-contract-storage` | `contracts/**`, `server/**`, `tests/backend/**`, `tools/generate_contracts.py`, 백엔드 패키지 설정·진행 문서 |
| 앱 Codex | 검수만 | 제품 방향·코드 검수 |

- 같은 파일을 동시에 고치지 않는다. 스키마 변경은 백엔드 담당과 합의(orca 로 직접 교환).
- UI 는 `contracts/v1/` 생성물을 읽기만 한다. 백엔드 첫 계약 커밋은 필요한 만큼 cherry-pick, 기존 live 연결에 병합하지 않는다.
- 조종 명령·WebSocket·renderer 소유자는 하나. 통합 조종 와치독은 지금 v2_link 단일 소유 유지.
- 무거운 브라우저·빌드 동시 부하는 두 담당이 조정(헤드리스 Chromium 한 번에 하나).

## 단계와 상태

| 묶음 | 내용 | 상태 |
|---|---|---|
| 1 | React+TS+Vite 토대. 원본 19화면 시안(`web/*.dc.html`)의 마크업·CSS·글꼴을 그대로 그리는 React 템플릿 렌더러, 라우팅, 전송 경계(현재 JSON API·WS), 읽기 전용 기록·보고서 화면 | 완료 dbf7a28(아래 «묶음 1 결과») |
| 브랜드 | foothold-brand 7afd241 로고·토큰·Pretendard 적용(배치·조작 그대로) | 완료(아래 «브랜드 적용») |
| 2 | 계획·양식·공용 지도(Canvas)·사진 분류 이전. Zustand = 표시·일시 입력, TanStack Query = 문서 조회·저장(409·초안·세대) | 대기 |
| 3 | 조종 Main·MDrive (마지막). 두 pointerId·폐기 규칙·STOP 우선·비영 복원 금지 보존. link.ts 에 live.js 126–127 의 hidden/pagehide → hidden 이식 + 앱 생명주기 계약: native pause·visibility·pagehide·blur·끊김 → 모든 pointer 폐기 + (가능하면) hidden, resume → 재연결은 보기 전용, WS 명령 발행 소유자 1개(App plugin 활성은 모바일 담당과 협의) | 대기 |
| 4 | PWA·Capacitor(Android/iOS) 같은 번들 | 외피 병렬 완료(모바일 담당, app-contract-storage `mobile/**` 86ef8d4 Capacitor 8.5.2·96b600f 아이콘·appId 임시) · 개발 연결 A(server.url→기존 관문 HTTPS, fixture) 진행 중 · 번들 내장 B 는 신뢰·Origin·API 설계 별도 · 실폰 미검증 |
| 5 | PC 3D 슬롯(three.js/R3F, 공급원 없음 표시), FastAPI/SQLite 백엔드 호환 연결 | 대기 |

## 묶음 1 결과 (dbf7a28)
- 실연결: Report·PcHistory·MHistory(나머지 16화면은 «아직 옮기지 않음» 안내, 시안 parity 는 유지).
- 시험(모의 링크 8791 = `tools/fake_v2_live.py` + `sim/v2_link.py --media runs/dev-allscreens/media`, ROS_DOMAIN_ID=88):
  - `python3 ui/tests/live_cmp.py runs/react-oh/live-3 Report 'Report?run=r10131246269513' 'Report?run=nope' PcHistory MHistory` → 5/5 PASS(기존 `?live=v2` 와 보이는 글 줄 일치, 시안 예시 글 잔존 0). 캡처 `runs/react-oh/live-3/*_{legacy,react}.png`
  - `python3 ui/tests/parity.py` → 19화면 20/20 PASS(`runs/react-oh/parity-5`)
  - `npx vitest run` 1 통과(tms +0900/-0130/빈값/null/쓰레기), `npm run build` 통과
  - STOP: 버튼 pointerdown·Space 키 → 상태 줄 «STOP 잠금» 확인(해제는 조종권 보유자만 — 보기 전용 연결로는 해제 안 되는 것이 정상)
- 기존 동작과 일부러 다르게 한 곳: Report 결과 색을 상태별(브랜드 뒤: 완료 dim-ink·진행 note-ink·실패/중단 stop, 기존은 늘 파랑) · PcHistory 쪽 버튼(비활성 흐림·현재 쪽 강조, 기존 복제 스타일 버그) · MHistory 목록 스크롤(기존 넘침 숨김) · 사진 읽기 전 건수 «—» · 시뮬 세션 결과 null → «미확인».
- 남은 것: 4401 은 authEnd 표시만(로그인 화면 = 묶음 4) · 카메라 프레임 무시 · MapCanvas 지도 위 버튼·로봇 궤적(묶음 2) · PcSettings 쪽 안 앵커(#display 등)가 해시 경로와 충돌(묶음 2) · live_cmp 는 줄 순서 미비교.

## 백엔드 연결 (fixture 만, 운영·자료 이전 아님)
- 통합 완료(개발 사본): 백엔드 47006b6·099d7b3·d10edb6·37ab187(check 를 write_db·compare Store 까지 전달) 체리픽 + 46bb846(json Docs id 충돌 다시 뽑기). `python3 tests/sim/store_mock_check.py <media 있는 폴더> <포트>` 11/11.
- 호환 확인됨: GET DB 오류 = 500 `{error}` → 기존 live.js·React 모두 «문서 읽기 실패 · …».
- 수정 해시 받은 뒤 통합 범위(mock 한정): GET 정상 / DB 읽기 오류 500 JSON / no-store / POST 409·503 / WS docs_rev 통지. 사진·사건 정본은 계속 파일(DB import 스냅샷으로 바꾸지 않음).
- 알려진 차이: 재시작 뒤 docs_rev(Store 는 저장값 유지, 옛 Docs 는 합으로 다시 셈).

## 브랜드 적용 (foothold-brand `7afd2416d266f9a2d6d6166c66e576eacef524b9`)
- 자산: `ui/public/brand/` 12파일 원본 바이트 그대로(blob SHA 12/12 = 원본 트리), 출처·라이선스 범위·해시 `ui/public/brand/SOURCE.md`. 토큰 MIT, 로고 Reserved(TRADEMARKS·BRAND_USAGE_POLICY). 글꼴 Pretendard 1.3.9 OFL 로컬 번들(`ui/public/licenses/`), 외부 CDN 없음(Google Fonts 링크 제거).
- 로고: `src/app/BrandLogo.tsx` — 원본 SVG `<img>`, 변형·필터·재색칠 없음, 높이만 지정. 헤더 8화면 compact h24(134×24, 옛 131×28 자리), 로그인 소개면(항상 어두운 바탕) primary-dark PcLogin h40·MLogin h36, Report «FOOTHOLD · 임무 기록» → compact-light h16 + «임무 기록». System(옛 디자인 시스템 설명)은 그대로.
- 색 다리 `src/brand.css`: 공식 토큰 → 화면 변수(bg=paper, panel=card, panel2=paper-2, line=rule, line2=rule+ink 16%, text=ink, muted=ink-2, accent=brand, ok=dim-ink, warn=note-ink, bad=공식 stop, *-bg=*-soft). `.fh`/`.fh.light` → `<html data-theme>`(`src/app/theme.ts`), `.fh` 없는 Report 는 밝음. `--stop` 충돌: 공식 stop 은 `--b-stop` 으로 잡고 STOP 채움은 두 테마 `#a3342a`(공식 밝음 stop). `--nav`·`--measure` 안 씀. 지도 그림색(`--map`·`--wall`·`--gridc`)은 그대로.
- 화면 안 고정색(테마 무관 자리)만 같은 공식값으로: MDrive 경로 `#38C6D9→#3ec7b4`·STOP `#D7261E→#a3342a`, 로그인 소개면 `#071014→#12161d`·`#38C6D9→#3ec7b4`, MAlert 경보띠·Report 빨강 `→#a3342a`, Report 청록·잉크 `→#0e7a6e`·`#161c26`. SVG 글꼴 속성은 Pretendard.
- 검증 (`python3 ui/tests/brand_shots.py <폴더>`, parity.html 예시값·모의만):
  - BEFORE `runs/brand/before-e618139/`, AFTER `runs/brand/after-1/` (PC Main·PcLogin·Report, 폰 MDrive·MHome·MLogin × 어두운/밝은, `measure.json`).
  - 후속 좁은 patch(앱 Codex 검수 지적): Report 결과색(실연결·시안 예시값 모두) 완료=dim-ink·진행=note-ink·실패/중단=stop, Report 표·지도 글 ink-2·note-ink·금지구역 stop-soft, 사진 위 표시·MDrive HUD 점·경고칩·Main 카메라 bbox·녹화점은 공식 어두움 값, Main 경고띠·warn 채움 글자 = var(--warn) 위 var(--paper)(5.64/7.52), 빨간 띠 흰 버튼 글자 #a3342a. System 설명칸에 «원본 시안 참고용·현재 공식 규격 링크». 캡처 `runs/brand/after-2/`.
  - STOP: Main 162×52→159×52(글자폭, 위치 1265,23 화면 안·적중), MDrive 132×64·MHome 358×64 위치·크기 그대로, 전부 inView·elementFromPoint 적중. 글자 대비 5.02/5.71 → 6.81.
  - 대비: 본문 14.66(어두움)·15.67(밝음)은 화면 실측. 아래는 토큰 값 계산 — accent 위 글자 8.66/5.21, note-ink/note-soft 5.45·6.05, dim-ink/dim-soft 5.99·6.77. 상태는 색 + 글자·기호(색만으로 구분 안 함).
  - 로고: 보이는 img 의 개발 서버 응답 sha256 = `ui/public` 원본, 테마별 dark/light 파일 바뀜 확인. 가로 넘침 0.
  - parity 19화면(`runs/brand/parity-after-1`): 픽셀 차이는 글꼴·색·로고로 전부 발생(승인된 브랜드 차이). DOM 차이 분류: 14개 뷰 diff 에서 브랜드 치환(로고·고정색·글꼴 속성)을 되돌리면 e618139 와 바이트 일치, CSS 머리 무변경 → 구조·배치 변경 없음.
  - Pretendard 기본 줄 높이가 낮아 `line-height` 미지정 블록이 몇~십여 px 위로 붙음(Report 표·MHome 카드). 줄바꿈·넘침·STOP 이동 없음 → 박스 조정 안 함.
  - `npx tsc --noEmit`·`npx vitest run`·`npx vite build` 통과(woff2 92개 로컬, dist 에 외부 글꼴 요청 없음).

## 복구 (2026-10-13)
- 옛 UI worktree 삭제(원인 미확인) 뒤 `app-ui-react-recovered`(e618139)에서 재개. 커밋은 보존, 미커밋 브랜드 작업·`runs/`(BEFORE 캡처·live-1..3·parity-5·dev-allscreens fixture 사진/사건) 소실. 위 «묶음 1 결과»의 `runs/react-oh/…`·`runs/dev-allscreens/…` 경로는 더 없다.
- 남은 원물 보존 `runs/recovery-20261013/`(README). 새 개발 fixture `runs/dev-recovered/`(문서 44건 = 삭제 직후 GET 사본 시드, 사진·사건 비어 있음) — 새 시험이며 복원 원물 아님.

## 사용자만 할 수 있는 것
- 실제 iPhone·Android 기기 터치 확인, iOS 서명(Apple 계정) — 묶음 4 이후.

## 미확인 · 블로커
- 실제 iPhone·Android 다지점 터치: 미확인(에뮬레이션·CDP 합성만 가능).
- iOS 빌드: 이 PC 에 macOS/Xcode/서명 없음 → 프로젝트·절차까지만.
- Node: React(ui, Vite 5)는 시스템 Node 18.19.1 로 빌드. 모바일 외피(Capacitor 8.5.2)는 Node 22 이상(사용자 폴더 node 22, 전역 업데이트 없음) — `mobile/README.md`.

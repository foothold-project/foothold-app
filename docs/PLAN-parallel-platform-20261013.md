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
| 2 | 계획·양식·공용 지도(Canvas)·사진 분류 이전. Zustand = 표시·일시 입력, TanStack Query = 문서 조회·저장(409·초안·세대) | 대기 |
| 3 | 조종 Main·MDrive (마지막). 두 pointerId·폐기 규칙·STOP 우선·비영 복원 금지 보존 | 대기 |
| 4 | PWA·Capacitor(Android/iOS) 같은 번들 | 대기 |
| 5 | PC 3D 슬롯(three.js/R3F, 공급원 없음 표시), FastAPI/SQLite 백엔드 호환 연결 | 대기 |

## 묶음 1 결과 (dbf7a28)
- 실연결: Report·PcHistory·MHistory(나머지 16화면은 «아직 옮기지 않음» 안내, 시안 parity 는 유지).
- 시험(모의 링크 8791 = `tools/fake_v2_live.py` + `sim/v2_link.py --media runs/dev-allscreens/media`, ROS_DOMAIN_ID=88):
  - `python3 ui/tests/live_cmp.py runs/react-oh/live-3 Report 'Report?run=r10131246269513' 'Report?run=nope' PcHistory MHistory` → 5/5 PASS(기존 `?live=v2` 와 보이는 글 줄 일치, 시안 예시 글 잔존 0). 캡처 `runs/react-oh/live-3/*_{legacy,react}.png`
  - `python3 ui/tests/parity.py` → 19화면 20/20 PASS(`runs/react-oh/parity-5`)
  - `npx vitest run` 1 통과(tms +0900/-0130/빈값/null/쓰레기), `npm run build` 통과
  - STOP: 버튼 pointerdown·Space 키 → 상태 줄 «STOP 잠금» 확인(해제는 조종권 보유자만 — 보기 전용 연결로는 해제 안 되는 것이 정상)
- 기존 동작과 일부러 다르게 한 곳: Report 결과 색을 상태별(완료 파랑·진행 주황·실패/중단 빨강, 기존은 늘 파랑) · PcHistory 쪽 버튼(비활성 흐림·현재 쪽 강조, 기존 복제 스타일 버그) · MHistory 목록 스크롤(기존 넘침 숨김) · 사진 읽기 전 건수 «—» · 시뮬 세션 결과 null → «미확인».
- 남은 것: 4401 은 authEnd 표시만(로그인 화면 = 묶음 4) · 카메라 프레임 무시 · MapCanvas 지도 위 버튼·로봇 궤적(묶음 2) · PcSettings 쪽 안 앵커(#display 등)가 해시 경로와 충돌(묶음 2) · live_cmp 는 줄 순서 미비교.

## 백엔드 연결 (fixture 만, 운영·자료 이전 아님)
- 통합 대기: d10edb6 의 `server/migrate.py` 108·131행 `Store(db…)` 가 주입된 check 를 안 받아 시스템 python(pydantic 없음)에서 `--store sqlite:` 가 docs.json 폴백. 재현: `ROS_DOMAIN_ID=88 python3 sim/v2_link.py --port 8793 --media <fixture 사본> --store sqlite:<새 db>` → «SQLite 이전 실패(… ModuleNotFoundError: pydantic)». 백엔드에 좁은 수정 + pydantic import 차단 반례 요청(10-13).
- 호환 확인됨: GET DB 오류 = 500 `{error}` → 기존 live.js·React 모두 «문서 읽기 실패 · …».
- 수정 해시 받은 뒤 통합 범위(mock 한정): GET 정상 / DB 읽기 오류 500 JSON / no-store / POST 409·503 / WS docs_rev 통지. 사진·사건 정본은 계속 파일(DB import 스냅샷으로 바꾸지 않음).
- 알려진 차이: 재시작 뒤 docs_rev(Store 는 저장값 유지, 옛 Docs 는 합으로 다시 셈) · 옛 json Docs id 충돌(같은 초·pid 재시작) — 통합 때 sim/ 쪽 수정.

## 사용자만 할 수 있는 것
- 실제 iPhone·Android 기기 터치 확인, iOS 서명(Apple 계정) — 묶음 4 이후.

## 미확인 · 블로커
- 실제 iPhone·Android 다지점 터치: 미확인(에뮬레이션·CDP 합성만 가능).
- iOS 빌드: 이 PC 에 macOS/Xcode/서명 없음 → 프로젝트·절차까지만.
- Node 18.19.1 → Vite 5·Capacitor 6 계열 사용(Vite 7·Capacitor 7 은 Node 20 이상 요구).

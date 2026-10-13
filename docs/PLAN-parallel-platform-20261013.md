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
| 1 | React+TS+Vite 토대. 원본 19화면 시안(`web/*.dc.html`)의 마크업·CSS·글꼴을 그대로 그리는 React 템플릿 렌더러, 라우팅, 전송 경계(현재 JSON API·WS), 읽기 전용 기록·보고서 화면 | 진행 |
| 2 | 계획·양식·공용 지도(Canvas)·사진 분류 이전. Zustand = 표시·일시 입력, TanStack Query = 문서 조회·저장(409·초안·세대) | 대기 |
| 3 | 조종 Main·MDrive (마지막). 두 pointerId·폐기 규칙·STOP 우선·비영 복원 금지 보존 | 대기 |
| 4 | PWA·Capacitor(Android/iOS) 같은 번들 | 대기 |
| 5 | PC 3D 슬롯(three.js/R3F, 공급원 없음 표시), FastAPI/SQLite 백엔드 호환 연결 | 대기 |

## 미확인 · 블로커
- 실제 iPhone·Android 다지점 터치: 미확인(에뮬레이션·CDP 합성만 가능).
- iOS 빌드: 이 PC 에 macOS/Xcode/서명 없음 → 프로젝트·절차까지만.
- Node 18.19.1 → Vite 5·Capacitor 6 계열 사용(Vite 7·Capacitor 7 은 Node 20 이상 요구).

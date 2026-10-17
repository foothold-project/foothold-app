# 앱 구조 단계별 전환 계획 (2026-10-13)

목적: 지금 앱(정적 HTML/JS + Tornado)을 목표 구성으로 **한 번에 갈아엎지 않고**, 단계마다 되돌릴 수 있게 옮기는 순서를 정한다.
아래 «전환 계획»은 2dfc0e9 를 읽고 쓴 계획이다. 그 뒤 10-13 병렬 구현 승인으로 일부 단계가 착수됐고, 진행 사실은 «현재 작업 상태»에 따로 적는다. 이 문서 자체는 운영 전환·시뮬 기동 승인이 아니다.

- 기준 코드: Git `feature/two-device` 2dfc0e9 (이 문서의 «현재»는 이 커밋을 읽은 것).
- 운영 서빙 판: 83b25ca. **코드 Git 최신 판과 운영 판은 다르다.** 어느 단계도 운영 판 교체를 포함하지 않는다(교체는 사용자 조종이 끝난 뒤 따로).
- 프레임워크를 바꾼다고 새 기능·몸 정지 성능이 생기지 않는다. 각 단계의 효과는 «유지보수·검사 가능성»이지 안전 보장이 아니다.

## 현재 작업 상태 (2026-10-13)

| 항목 | 사실 |
|---|---|
| 승인 | 10-13 병렬 구현 승인(구현·무료 의존성·모의 검증까지, 라이브 무단 교체 금지). 역할·소유 파일: [PLAN-parallel-platform-20261013.md](PLAN-parallel-platform-20261013.md) |
| 브랜치 | UI `feature/react-platform-oh`(고정 앱 mentor) · 백엔드 `less82/app-contract-storage`(백엔드 mentor) |
| 계약 | 독립 contracts(Pydantic 정본 → JSON Schema → TS) 85d08f7. UI 브랜치에 cherry-pick 92203a7, 화면은 읽기 소비만. legacy 서버(v2_link)에는 아직 미연결. 타입 검사는 조종 Core 검증을 대신하지 않는다 |
| 저장 | SQLite store·migrate·FastAPI 독립 어댑터 47006b6, Tornado Docs→Store adapter 099d7b3(`--store json|sqlite:<경로>`, 기본 json). 검수 중이라 통합 보류. 첫 통합은 (b) 기존 Tornado Docs → SQLite store 최소 adapter, fixture DB 로만. 20 Hz 명령 루프에서 DB 조회·사진 IO 금지, Core·와치독 소유 유지. 사진·사건 저장소 정본과 docs_rev 신호 동기는 미정(구현 완료 아님) |
| UI | 19화면 시안 → React 틀 변환·대조 PASS(95fad34). 보고서 실데이터 연결 진행 중 |
| 운영·실기기 | 운영 판 83b25ca·서빙 무변경(이 작업 미반영). 실제 iPhone·Android 미검증 |

## 현재 구조 (2dfc0e9, 코드 확인)

| 층 | 지금 | 비고 |
|---|---|---|
| 화면 | HTML/CSS/JS 19개 시안 원본 + `web/dc.js`(시안 런타임) + `web/live.js`(실데이터 연결) | 빌드 도구 없음. React·TS·Zustand·TanStack Query 미도입 |
| 서버 | `sim/v2_link.py` Tornado: HTTP·WebSocket, Core 상태, rclpy | Core 20 Hz `tick`(명령 발행·STOP 재전송, 730행)과 10 Hz `push`(864행)는 Tornado IOLoop 의 PeriodicCallback(920~921행). `rclpy.spin` 은 별도 스레드(726행), 문서 쓰기는 `run_in_executor`(910행) |
| 저장 | `docs.json`(임무·기록·구역·사진 메모, rev·409) + `photos/events.jsonl` + JPEG 파일 | SQLite **아님**(6단계 후보) |
| 보호 | `v2_gate.py` HTTPS 로그인 관문, v2_link 는 127.0.0.1 | Pydantic·FastAPI 미도입 |
| 배포물 | 없음 | APK·IPA·EXE 없음. PWA 매니페스트만(홈 화면 웹 앱, 실제 iPhone 미확인) |

STOP·와치독이 «IOLoop 와 완전히 독립»이라고 말할 수 없다. tick 이 IOLoop 위에 있어서, IOLoop 를 오래 막는 코드가 들어오면 명령 0 재전송도 늦어진다. 이것이 1·6단계에서 지킬 핵심 제약이다.

## 목표 구성 (제안)

| 영역 | 후보 | 언제 |
|---|---|---|
| 화면 | React + TypeScript + Vite, 실시간 표시·입력은 Zustand, 기록 읽기·저장은 TanStack Query | 2단계부터 화면 하나씩 |
| 계약 | Pydantic 모델 → JSON Schema → TS 타입 | 독립 contracts 에 구현됨, legacy 서버에는 아직 미연결 |
| 조종 입력 | Canvas + Pointer Events | 3단계 |
| PC 점군 | three.js / React Three Fiber, 읽기 전용 Foxglove 병행 | 4단계 |
| 배포 | PWA, 필요하면 Capacitor | 5단계 |
| 서버 | FastAPI + WebSocket + rclpy (요청 층부터) | 6단계 |
| 검사 | Playwright + pytest, 사용자 iPhone 16 Pro 실기기 | 모든 단계 |

## 단계

모든 단계 공통: 한 번에 렌더러 둘·WebSocket 명령 발행자 둘을 동시에 두지 않는다. 비밀(토큰·키·계정 해시)은 저장소에 넣지 않는다. 실기 STOP 통합 검증은 어느 단계로도 대신할 수 없다.

### 0단계: 지금 상태 고정

| 항목 | 내용 |
|---|---|
| 목표 | «현재 구현 / 현재 운영 / 실기기 미검증»을 한 표로 고정해, 이후 단계가 무엇을 바꿨는지 대조할 기준을 만든다 |
| 재사용 | README 의 구현·미연결·검증 표, 19개 시안 원본(화면 디자인 원본은 보존 대상) |
| 바꿀 것 | 표 하나 추가. 코드 변경 없음. 새 기능·몸 정지를 프레임워크 전환의 효과로 약속하지 않는다 |
| 수락 기준 | 표의 각 행에 근거(커밋·시험 기록)가 있고, 운영 판(83b25ca)과 코드 판(2dfc0e9)이 따로 적혀 있음 |
| 되돌리기 | 문서만이라 해당 없음 |
| 상태 | 제안 · 착수 없음(현재 작업 상태 표가 일부 대신함) |

### 1단계: 메시지·데이터 계약

| 항목 | 내용 |
|---|---|
| 목표 | WebSocket 메시지와 문서 저장 형식을 버전 붙은 계약으로 적는다: 필수 필드, 단위, 좌표계, 시각·나이(age), 에피소드·세대(generation), unknown/error 표현, rev, 401·403·409 의미 |
| 재사용 | v2_link 의 현재 형식 검사(doc_check, 유한 숫자·길이 검사)와 rev·409 규칙 |
| 바꿀 것 | JSON Schema 문서와 거기서 만든 TS 타입. **생성된 타입은 실행 중 검사가 아니다.** legacy 서버 검사는 그대로 둔다(Pydantic 모델은 독립 contracts 에 있고 legacy 에 아직 미연결) |
| 수락 기준 | 지금 서버가 보내는 메시지 전부가 스키마로 설명되고, 깨진 입력 예시가 서버에서 여전히 거절됨 |
| 되돌리기 | 스키마 파일 삭제. 실행 코드는 바뀌지 않음 |
| 상태 | 착수 · 독립 contracts 85d08f7, legacy 서버 미연결 |

### 2단계: JS 경계 정리 → 읽기 전용 화면부터 React

| 항목 | 내용 |
|---|---|
| 목표 | live.js 의 연결·상태·그리기 경계를 나눈 뒤, 읽기 전용 화면(보고서·기록 등)을 하나씩 React 로 옮긴다. **조종 화면은 맨 마지막** |
| 재사용 | 시안 HTML/CSS(디자인), live.js 의 연결 규칙, 1단계 계약 |
| 바꿀 것 | Zustand = 화면 표시 상태와 잠깐의 입력 의도. TanStack Query = 서버 문서(409 처리·초안 보존·실패 시 내용 유지). Query 를 명령 재시도 큐로 쓰지 않는다 |
| 수락 기준 | 옮긴 화면마다 이전 판과 같은 검사(live_ui_check 등)가 통과하고, 같은 화면에 옛 렌더러와 새 렌더러가 동시에 붙지 않음 |
| 되돌리기 | 화면 단위로 옛 HTML 로 돌린다(화면별 전환 스위치) |
| 상태 | 착수 · React 토대·변환 대조 완료, 보고서 실데이터 연결 진행 |

### 3단계: 두 엄지 조종 계약

| 항목 | 내용 |
|---|---|
| 목표 | 왼쪽 = 회전, 오른쪽 = 앞뒤. 두 pointerId 를 따로 추적. 손 뗌·pointercancel·포커스 잃음·화면 숨김·링크 끊김·모드 변경·STOP 은 누름을 폐기하고, 0 이 아닌 입력을 자동 복원하지 않는다 |
| 재사용 | 지금 v2 화면의 막대별 포인터 규칙(같은 막대 둘째·셋째 손가락 → 전부 폐기, 한 막대 손 뗌 → 그 막대만 0. 코드 확인, 에뮬레이션만). 옛 «두 손가락 → 전부 해제» 규칙은 이 두 영역 계약으로 대체된다 |
| 바꿀 것 | Canvas + Pointer Events 로 다시 쓰되 서버 한계는 v2 그대로: 후진·제자리 회전·저속은 서버가 0 으로 막음. 명령 0 + 잠금은 몸 정지가 아니다(시뮬 관측: STOP 뒤 약 3.6 s·0.32 m 더 움직임, 원인 미확인) |
| 수락 기준 | 다지점 시험은 별도 도구로(Playwright `touchscreen` 은 `tap` 만 있음 — 아래 링크). 에뮬레이션 통과와 실제 iPhone·Android 통과를 따로 적는다 |
| 되돌리기 | 조종 화면을 옛 판으로 |
| 상태 | 대기 |

### 4단계: PC 점군

| 항목 | 내용 |
|---|---|
| 목표 | 점군 출처·TF·시각·SLAM 소유자(누가 지도를 만드나) 계약을 먼저 정하고, 그 다음 그린다 |
| 재사용 | 1단계 계약의 시각·나이 표현 |
| 바꿀 것 | 점 수·Hz·큐·바이트 상한, 최신 프레임만 유지하고 밀린 것은 버림, 그리기를 명령 채널과 분리(점군이 STOP 을 늦추지 않게). Foxglove 는 읽기 전용으로만 — publish·service 는 **서버에서 막는다**(화면이 읽기 전용이라는 것만으로는 부족) |
| 수락 기준 | 상한을 넘는 점군을 넣어도 STOP 지연이 기준 안. 시각이 오래된 점군은 «오래됨» 표시 |
| 되돌리기 | 점군 패널 끄기(명령 경로와 분리돼 있어야 가능) |
| 상태 | 대기 |

### 5단계: 배포·PWA (그다음 Capacitor)

| 항목 | 내용 |
|---|---|
| 목표 | 판 번호, 원자적 묶음 교체, 되돌리기. 서비스 워커의 옛 캐시 방지(API·명령은 캐시 금지) |
| 재사용 | 지금 PWA 매니페스트, 운영 판 교체 규칙(조종 중 교체 금지) |
| 바꿀 것 | 실기기 측정: 로그인·TLS·가로 고정·전체 화면·화면 꺼짐 방지·진동·저장소. Capacitor 는 별도 단계로, Android 와 iOS 조건을 따로 본다(화면 방향 API 등 — 아래 링크). iPhone 계획 유지 |
| 수락 기준 | 새 판 배포 뒤 옛 캐시 화면이 남지 않음, 사용자 iPhone 16 Pro 에서 항목별 통과·실패 기록 |
| 되돌리기 | 이전 묶음으로 원자 교체 |
| 상태 | 대기 |

### 6단계: SQLite, 그다음 FastAPI 요청 층

| 항목 | 내용 |
|---|---|
| 목표 | (a) docs.json·events.jsonl → SQLite. (b) HTTP 요청 층을 FastAPI 로. 둘은 따로 진행 |
| 재사용 | 지금 파일은 보존(옮긴 뒤에도 지우지 않음), rev·409 규칙, 로그인·소유자·TTL·STOP·영상·위치 관문 |
| 바꿀 것 | (a) ID·rev·관찰 분류·사진 참조, 트랜잭션, 복구, 스키마 버전. DB 에는 사진 경로·시각·임무 ID 를 넣고 사진 파일은 파일로. (b) ROS executor 와 명령 게이트웨이·와치독은 한 소유자. async 를 쓴다고 안전·실시간이 생기지 않는다(아래 FastAPI 링크) |
| 수락 기준 | (a) 옮기기 전후 문서 수·rev 일치, 중간 실패 시 원본 그대로. (b) 기존 관문 시험 전부 통과, 요청 처리 중에도 20 Hz 명령 0 재전송이 늦지 않음 |
| 되돌리기 | (a) 원본 파일로 복귀. (b) Tornado 판으로 |
| 상태 | (a) 착수 · 저장 47006b6 + Tornado adapter 099d7b3 검수 중, 통합 보류 · (b) FastAPI 어댑터는 독립 구현만, legacy 미연결 |

## 원래 계획에서 유지하는 것
- 모니터링(서버·링크 상태 기록), 비밀은 커밋하지 않음, DB 에는 경로·시각·임무 ID, 실기 STOP 통합 검증은 별도 승인 뒤.

## 공식 자료
- FastAPI async: https://fastapi.tiangolo.com/async/
- Playwright Touchscreen(`tap` 만 제공): https://playwright.dev/docs/api/class-touchscreen
- Capacitor Screen Orientation: https://capacitorjs.com/docs/apis/screen-orientation

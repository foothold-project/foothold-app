# PR #43 1차 검토 반영

- 브랜치 `feature/phone-pass`, 검토 대상 `43c72f4` 이후 변경이다. 두 검토 보고서와 재현을 읽고 저장소 회귀 시험으로 옮겼다.
- 소유 범위 안에서만 변경했고 `safety/**` 판정·상수·셀프테스트 기대값 변경0이다. 실제 ROS·시뮬·실폰·실로봇·운영 실행0이다.
- 기존 venv와 서버 사설 PostgreSQL fixture를 사용했다. 새 시험9450~9469, 기존 에이전트 helper 범위 유지, 임시 `tmp/phone-pass-r1`/`tmp/ppg`, 무거운 실행 전 MemAvailable2.5GB 이상을 확인했다.

## 수정과 결정

| 항목 | 반영 |
|---|---|
| K1 | 열린 연결은 고정된 단조 마감으로 먼저 만료 처리한다. UTC until을 넘었어도 일치하는 열린 jti를 회수하고0·잠금·비움·4403 적용 후에만 ack한다. UTC until은 새 hello 캐시 보존에만 사용한다. 사용자/기기 선택자는 iat < until인 기존 연결만 대상으로 해 정상 신규 출입증을 끊지 않는다 |
| K2 | 실제 서버 WS로 다른 로봇의 낮은 seq·미전송 높은 seq를 ack해도 저장0임을 확인하고 공식 변이2개를 추가했다 |
| K3 | ack를 연결당 FIFO/중복 제거 큐(128개)와 별도 DB 작업으로 저장한다. 저장 전에는 전환 예외가 없고, r2에서는 큐 포화 ack의 retry floor를 유지해 같은 연결에서 재전송한다. 3초간 DB 저장을 막아도 state 수신·연결이 살아 있고 전환은409다. hello 이후 timeout과 회수 전송/ack 저장 오류의 닫힘 이유를 구분한다 |
| K4 | jti별 이력은 유지하고 별도 불변 묶음을 같은 트랜잭션에 저장한다. ≤16항목·항목64jti·전체4KiB, 재접속에도 같은 seq/본문, 묶음의 모든 jti에 ack를 원자 적용한다 |
| K4 조정 확인 | r2 D16 정정: 로봇당 미만료 회수 묶음(ack 무관)+미회수 출입증4096행, 묶음 실제 바이트+출입증당4KiB 합1MiB를 넘길 새 발급만503 PASS_REVOCATION_CAPACITY다. 만료(+60초)로만 공간이 돌아온다. 잠금·로그아웃·회수·STOP·조종자 반납은 막지 않는다. 에이전트 저널의 행=묶음·바이트 한도를 근거로 각 미회수 출입증의 최악1묶음을 예약한다. 미적용 PR이므로 새0014 대신0013을 보강하도록 확인받았다 |
| K5 | 조직별 영속 count/reasons를 초당1건 이하의 PHONE_PASS_DENIED 사건으로 집계한다. 별도 작업이 조용한 구간도 기록하며, 종료·재시작 때 pending count는 DB에 남아 이어진다 |
| K6 | revoke/pending과 실제 API/실시간 경로가 같은 주입 UTC 시계를 사용한다. 발급 변이 도구의 포트 범위는 FH_TEST_PORT_RANGE로 덮어쓸 수 있다 |
| K7~K9 | API §13.6/13.7와 서버 README에0013 되돌림(코드 revert·테이블 보존 우선/중지→최종600초→회수·이력 백업·복구·키 대응),1013 지수 백오프(1초 시작·6초 이상)/429 retry_after, 선언 기기 UUID 보장·사용자당4기기 우회, 미래 iat 여유0초와 자체 경과 차5초의 구분을 명시했다 |
| 기록 R4 | 회수 pending 조회0.1초×로봇 수의 DB/읽기 풀 부하와 재전송 중 정지 지연을 API §13.6 실기 전 관문에 추가했다 |

## 실행

아래 python은 `.venv/bin/python`이다. 서버/발급 변이에 `FH_TEST_PORT_RANGE=9450:9469`, 시험에 worktree TMPDIR를 적용했다.

| 명령 | 결과 |
|---|---|
| `python -m pytest apps/server -q` | 649 passed, 기존 경고1 |
| `python -m pytest apps/agent -q` | 812 passed,1 skipped, 기존 경고2 |
| `python apps/server/tools/check_phone_pass_mutations.py` | 10/10 KILLED |
| `python apps/agent/tools/check_phone_mutations.py` | 79/79 KILLED |
| `python apps/agent/tools/check_link_mutations.py` | 80/80 KILLED |
| `python apps/agent/foothold_agent/ros_bridge/check_mutations.py` | 49/49 KILLED, ROS 없는 모의 경로 |
| `python apps/contracts/generate.py --check` | 144개 일치 |
| `npm --prefix apps/contracts run typecheck` | 통과 |
| Codex 원본 clock 재현(ROOT만 이 worktree로 변경) + Claude 원본3개 | 4 passed,1 deselected |
| `git diff --check` / safety diff | 통과 / 변경0 |

K1 저장소 시험은 +2초로 until을 넘김·until==wall·단조 deadline 직전/같음/직후 × jti/사용자/기기 선택자15개와 정상 신규 출입증3개다. 회수 뒤 이전 cmd는 거부된다. 기존 실제 WS 종료/저장 실패 시험도 전체에 포함된다.

Claude의 원본 slow-ack 재현은 state를 보내지 않고6초 기다리므로 정상3초 무수신 종료와 섞인다. 그대로 실행해 «연결이 끝까지 살아야 함»으로 바꾸지 않고, 저장소 회귀에서 계속 state를 보내며 DB를3초 막아 reader 생존·미확인 전환 거부·저장 뒤 허용을 확인했다. 원본의 타 로봇/미전송 ack·기기 UUID 변경·동시 발급/한도3개는 그대로 현재 코드에서 통과했다. Codex clock 재현은 즉시0·잠금·비움 assertion이 이제 통과한다.

### 공식 변이 매핑

- 폰 추가1개: `open revocation wrongly uses UTC expiry` → K1 단조/UTC 경계에서 검출.
- 발급 기존3개 유지: `one phone one robot removed`, `issuance rate limit removed`, `switch allowed without ack`.
- 발급 추가7개: `unsent ACK accepted`, `ACK robot binding removed`, `revocation capacity reservation removed`, `batch sends one JTI per frame`, `denial audit batching removed`, `pending uses real UTC instead of injected clock`, `revoke uses real UTC instead of injected clock`.
- 모두 unique anchor·수집>0·종료1·실제 assertion 실패·비-assertion 오류0을 요구한다. runtime/import 오류를 성공으로 세지 않는다.

## 남은 범위

- 현재 API §13.6의 실환경 관문 전체, 운영0013 적용/되돌림, 실제 키 배포/회전, NTP·다중 로봇 조회/저널/출력 부하, 실제 DDS synthetic(domain93 opt-in)·시뮬·실폰·실로봇·배포는 미검증이다.
- 1폰1대는 선언 UUID 단위이며 사용자당4기기 우회가 가능하다. 같은 연결 안10분 출입증 갱신·웹/폰 연결·카메라·시뮬 관리자는 후속이다.
- Nav2 도구의 기존 cancel_goal_removed 분류 오류(64/65)는 이전 조정 승인된 후속이며 이 라운드 지시대로 재실행하지 않았다. 전체 변이 통과로 바꾸어 쓰지 않는다.
- 검증 로그/재현은 Git 제외 tmp에 남기고 시험 자동 임시 폴더만 정리한다. 실제 키·토큰·운영 주소·실명·개인 경로를 추적 파일에 추가하지 않았다. 두 모델 재검토·dev 통합은 조정 세션이 수행한다.

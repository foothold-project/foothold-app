# PR #45 권고 후속 검증

- 브랜치 `feature/phone-pass-followup2`, 기준 `origin/dev`의 PR #45 합친 커밋 `95a9f5b`다. 이전 feature 브랜치를 계속하지 않고 새 브랜치에서 작업했다.
- Claude 검토 권고 R1~R3·재현을 회귀 시험으로 옮겼다. 안전 Core·상수·기존 셀프테스트 기대값 변경0, 에이전트 런타임 변경0, ROS·시뮬·운영 실행0, 새 의존성0이다.
- 기존 venv·사설 PostgreSQL fixture·가짜 sink를 사용했다. 무거운 실행 전 MemAvailable2.5GB 이상, 서버/발급 시험9450~9469와 기존 링크/bridge helper 포트 예외를 유지했다.

## 이 작업에서 정한 결정

| 항목 | 결정·구현 |
|---|---|
| G1 보존 상한 | `(user,robot)`별 회수 여부·ACK 여부와 무관하게 `exp+60 > 서버 UTC`인 출입증을32개까지 허용한다(control/view·기기 합산). 초과429 `PASS_ACTIVE_LIMIT`, retry_after는 가장 이른 exp+60까지다. 새 세션/기기 변경으로 초기화하지 않는다. 조직 쓰기 잠금 안에서 판정한다 |
| G1 기존 규칙 | 회수 안 된 미만료8개 상한·D13 기기당 이동60초10건/사용자4기기·1폰1대 전환 ACK 조건은 유지한다.8개→로그아웃→재로그인 발급200을3회 반복한다. 회수·STOP·조종자 반납 경로는 제한하지 않는다 |
| G1 용량 계산 | 발급마다 회수하는1-jti 묶음4096행 경로는 최소128계정(4096÷32)이 필요하다. 기존 미회수8개×4KiB 경로는32계정, 회수24개+미회수8개는 작은 묶음 overhead와 합쳐 약35KiB/계정이어서 약30계정에서1MiB 바이트에 먼저 닿을 수 있다. 해당 로봇 발급 권한(관리자/배정 조종자)이 있는 계정 수가 전제다. 조정 확인에 따라 두 경로를 구분했고 기존 PR #43 M2부터 있던 바이트 경로를 새 제한의 보장으로 표현하지 않는다. 서버4096행/1MiB/+60초·에이전트 물리8MiB는 유지한다 |
| G2 경고 | PoolTimeout 때 링크 유지/미확인 retry floor 동작은 그대로다. 로봇별 연속 횟수를 세고 첫 실패 및 이전 경고30초 뒤에만 원인 `POOL_TIMEOUT`·횟수·대기 seq 범위를 경고한다. 토큰/jti/DB 예외 원문은 기록하지 않는다. 실제 ACK 저장 성공은 횟수만0으로 돌리고 경고 시각은 유지한다. 실제 DB 오류/외부5초 timeout의1013은 유지한다 |
| G3 큰 저널 | 실제 파일 Verifier로2KiB 직상 프레임1200개를 저장해1024페이지를 넘긴 뒤 재시작한다. 내용 유지·옛 출입증 거부·동일 seq 멱등·새 출입증 승인·새 회수 저장을 검사한다. 이는8MiB 물리 재시작 검사이며1200개 전부가 서버1MiB wire 예산에 들어간다는 뜻은 아니다. 서버 마지막 허용 상태의 실제 pack/Verifier3극단 시험은 별도로 유지한다 |

## 회귀와 변이

- 12명의 실제 발급자에 대해 주입 시계·조직 잠금·실제 발급/회수 경로로 각80번 시도한다. 각32개 발급/48개429, 전체384개1-jti 묶음(41,748 wire B), 다른 사용자 HTTP 발급200이다. 검토 재현의 로봇 전체503 대신 사용자별429가 먼저 발생한다.
- 단일 계정의400회 발급/로그아웃 시도는32개 수락·368개429·4묶음으로 제한된다. 기존 속도 예산 검사는 별도 시험으로 유지한다.32개 뒤 exp+60 직전 거부/경계 허용, 다른 로봇 예산도 검사한다.
- 실제 큐/writer/to_thread 경로에 풀 실패와 시계를 주입하여29.999초 경고 억제·30초 재경고·성공 뒤 횟수 초기화·경고 간격 유지·다른 로봇 독립·링크 유지·비밀 원문 미포함을 검사한다. 기존 실제3로봇 풀 경쟁→모두 확인 시험도 유지한다.
- 발급 변이3개 추가:32개 상한 제거,32개에서 회수 제외, 풀 경쟁 경고 생략. 폰 변이2개 추가: 시작 page_count 검사2048→512/1024. 기존256 회귀 변이도 유지한다. import/runtime 오류가 아닌 실제 assertion 실패로만 KILLED를 판정한다.

## 실행

아래 python은 `.venv/bin/python`이다. 로그는 `tmp/phone-pass-f2`, 서버/pytest TMPDIR는 짧은 worktree 경로 `tmp/pf2`, 발급 변이 DB는 `tmp/ppg`다. 서버/발급에는 `FH_TEST_PORT_RANGE=9450:9469`를 적용했다.

| 명령 | 결과 |
|---|---|
| `python -m pytest apps/server -q` |680 passed, 기존 경고1 ·800.04초 |
| `python -m pytest apps/agent -q` |813 passed,1 skipped, 기존 경고2 |
| `python apps/server/tools/check_phone_pass_mutations.py` |32/32 KILLED |
| `python apps/agent/tools/check_phone_mutations.py` |82/82 KILLED |
| `python apps/agent/tools/check_link_mutations.py` |80/80 KILLED |
| `python apps/agent/foothold_agent/ros_bridge/check_mutations.py` |49/49 KILLED, ROS 없는 모의 경로 |
| `python apps/contracts/generate.py --check` |144개 일치 |
| `npm --prefix apps/contracts run typecheck` |통과 |
| 서버 발급/용량 집중 회귀 |67 passed, 기존 경고1 |
| 큰 저널 재시작 집중 회귀 |1 passed |
| `git diff --check` / safety diff |통과 / 변경0 |

## 파일·미검증·되돌림

- `fh_server/phone_pass.py`·`fh_server/realtime.py`: 보존32개 상한·풀 경쟁 경고/계수.
- 서버 `tests/test_phone_pass.py`·`tools/check_phone_pass_mutations.py`: 새4사례·기존400회 회귀의 새 판정·공식 변이3개.
- 에이전트 `tests/test_phone_pass.py`·`tools/check_phone_mutations.py`: 큰 파일 재시작 회귀 크기·공식 변이2개. 에이전트 실행 코드 변경은 없다.
- 서버 README·이 기록·`docs/spec/05-API-SPEC.md`: 결정·용량 계산·검증·변경 이력0.17.

실기 전 관문 정본은 [API §13.6](../../docs/spec/05-API-SPEC.md#136-오류닫기후속-경계)이다. ROS/DDS(domain93)·시뮬·실폰·실로봇·운영 migration/저널 복구·키 배포·실제 TCP 단절·배포는 실행하지 않았다. 다수 권한 계정의 바이트 포화 경로는 계산을 명시했으며 이번 작업의 새 실험 범위는1-jti 회수 반복이다. 기존 Nav2 변이 분류64/65 후속은 이번4종과 별개다. 두 모델 검토와 dev 통합은 조정 세션의 관문이다. 되돌림은 이 기능 커밋의 코드 revert이며 DB 스키마/키/운영 배포 변경은 없다.

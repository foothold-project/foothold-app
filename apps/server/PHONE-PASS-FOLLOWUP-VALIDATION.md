# PR #43 권고 후속 검증

- 브랜치 `feature/phone-pass-followup`, 기준 `origin/dev`의 PR #43 합친 커밋 `8702fef`다. 이전 feature 브랜치를 계속하지 않고 새 브랜치에서 작업했다.
- Claude r4 권고 R1~R3·재현과 이번 조정 결정을 반영했다. `safety/**`의 판정·상수·기존 셀프테스트 기대값 변경0, ROS·시뮬·운영 실행0, 새 의존성0이다.
- 기존 venv·사설 PostgreSQL fixture·가짜 sink만 사용했다. 무거운 실행 전 MemAvailable2.5GB 이상, 새 서버/발급 시험9450~9469와 기존 helper 예외를 유지했다.

## 결정과 변경

| 항목 | 결정·구현 |
|---|---|
| F1 | 사용자·로봇당8개 상한은 **회수 안 된 미만료** 출입증만 센다. 회수 jti는 ack 여부와 무관하게 이8개 상한에서만 제외한다. 다른 로봇 전환의1폰1대 ack 조건은 유지한다. 회수 이력은 기존4096행/1MiB/+60초 예약이 계속 센다. **D13 성공 발급 예산·기기 슬롯은 회수/로그아웃으로 반환하지 않는다**.8개 뒤 실제 로그아웃→재로그인 발급200이며 ACK가 없어도 가능하다 |
| F1 용량 근거 | 고정4기기×기기당60초10건으로600초400건을 모두 사용하며8개마다 로그아웃/재로그인을 반복한다. 각60초 창에서 같은 기기의11번째 발급은429이고 재로그인으로 예산이 초기화되지 않는다.400개 전부 회수(ACK0), 예약50행/19,041 wire B로 남고 다른 사용자 발급은200이다. 큰 저널 용량을 대신하는 시험이 아니라 한 사용자의 이 반복 경로가 예약을 채우지 않는 집중 회귀다 |
| F2 | ACK 풀 획득 대기 실패(PoolTimeout)만 일시 경쟁으로 처리한다. 연결/reader를 유지하고 해당 ACK를 미확인으로 둔 채 seq 직전 retry floor를 남겨 다음 pending 주기에 같은 불변 프레임을 재전송한다. overflow 재시도와 공통 helper를 쓴다. 실제 DB 오류·5초 저장 timeout의1013·로봇별 진행1개·늦은 commit 멱등은 유지한다 |
| F2 상한 | 풀2개/overflow0/대기0.5초는 유지한다. 실제 풀 연결2개를 잡고 세 번째 획득이0.5초 근처에 실패하는지 검사한다. 실제 libpq 연결의 TCP 무응답 설정2000ms도 검사한다. 이 시험은 Unix fixture에서 드라이버 설정/풀 지연을 검증하며 물리 TCP 단절을 측정한 뜻은 아니다 |
| F3 | 실제 파일 저널을2KiB 직상 프레임400개로256페이지 넘게 만든 뒤 Verifier를 닫고 다시 연다. 회수400행·used1행 유지, 옛 token 거부, 동일 seq 재전송 멱등, 새 token 승인·새 회수 저장까지 확인한다 |

## 회귀와 변이

- 실제 서버 WS3개·로봇3대가 함께 ACK 저장을 시작하고 실제 PostgreSQL 쓰기 경로를0.8초씩 지연한다.2개 풀로 인해 한 로봇은PoolTimeout을 거치지만 같은 연결의 재전송 뒤3개 모두 영속 확인되고 링크가 유지된다. 기존 실제 SQL statement/lock 오류와5초/늦은 commit 회귀도 유지한다.
- 발급 변이4개 추가: 회수 출입증을8개에 다시 포함, 풀 대기 실패를1013으로 처리, pool 대기30초, TCP 제한 제거. 기존 포화 변이 anchor만 공통 helper에 맞춰 바꿨다.
- 폰 변이1개 추가: 시작 시 page_count 검사를2048 대신256으로 되돌림. reopen 실패를 실제 assertion으로 판정하며 import/runtime 오류는 KILLED가 아니다.

## 실행

아래 python은 `.venv/bin/python`이다. 로그는 `tmp/phone-pass-followup`, 시험 DB/pytest TMPDIR는 짧은 worktree 경로 `tmp/pf`, 발급 변이 DB는 `tmp/ppg`다. 서버/발급에는 `FH_TEST_PORT_RANGE=9450:9469`를 적용했다.

| 명령 | 결과 |
|---|---|
| `python -m pytest apps/server -q` |676 passed, 기존 경고1,758.88초 |
| `python -m pytest apps/agent -q` |813 passed,1 skipped, 기존 경고2 |
| `python apps/server/tools/check_phone_pass_mutations.py` |29/29 KILLED |
| `python apps/agent/tools/check_phone_mutations.py` |80/80 KILLED |
| `python apps/agent/tools/check_link_mutations.py` |80/80 KILLED |
| `python apps/agent/foothold_agent/ros_bridge/check_mutations.py` |49/49 KILLED, ROS 없는 모의 경로 |
| `python apps/contracts/generate.py --check` |144개 일치 |
| `npm --prefix apps/contracts run typecheck` |통과 |
| 새 서버 집중 회귀 / 큰 저널 재시작 |4 passed /1 passed |
| `git diff --check` / safety diff |통과 / 변경0 |

처음 긴 TMPDIR에서 사설 PostgreSQL이 Unix 소켓 경로 길이 한도로 시작하지 못했다(시험 본문 실행0). `tmp/pf`로 바꾼 집중 회귀가 모두 통과했으며 이후 전체 시험/변이에 같은 짧은 경로를 사용했다.

## 바꾼 파일·미검증

- `fh_server/phone_pass.py`, `fh_server/realtime.py`: 회수 jti 제외와 풀 경쟁 재전송.
- 서버 `tests/test_phone_pass.py`, `tools/check_phone_pass_mutations.py`: 새4사례·공식 변이4개.
- 에이전트 `tests/test_phone_pass.py`, `tools/check_phone_mutations.py`: 큰 파일 재시작1사례·변이1개. 에이전트 런타임/안전 Core 변경은 없다.
- 서버 README·이 기록·`docs/spec/05-API-SPEC.md`: 새 결정·검증·변경 이력0.16.

실기 전 관문 정본은 [API §13.6](../../docs/spec/05-API-SPEC.md#136-오류닫기후속-경계)이다. ROS/DDS(domain93)·시뮬·실폰·실로봇·운영 migration/저널 복구·키 배포·실제 TCP 단절·다중 로봇 DB 부하·배포는 실행하지 않았다. 원래 Nav2 변이 분류64/65 후속은 이번4종과 별개다. 회수/발급 규칙은 조정의 새 결정이며 두 모델 검토·dev 통합은 조정 세션의 관문이다.

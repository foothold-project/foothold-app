# PR #6 검토 수정 기록

같은 `feature/server-skeleton` 브랜치에서 Claude 검토의 B1~B3 및 요청된 권고를 수정했다.
소유 경로는 `apps/server/**`, `apps/contracts/**`이며 `docs/`와 기존 앱·안전 코드에는 변경이 없다.

| 항목 | 수정 | 실패를 검출하는 회귀 시험 (`apps/server/tests/`) |
|---|---|---|
| B1 | 쿠키 인증 `GET /api/v1/auth/session`에서 세션별 CSRF 재획득, no-store, 탭 사이 값 유지 | `test_review.py`: 쿠키만 가진 새 클라이언트의 변경·로그아웃, 원래 탭 유지, 앱·미인증 구분 |
| B2 | 마지막 활성 총괄의 강등·잠금·삭제를 `409 LAST_ORG_ADMIN`으로 거부, 조직 행 잠금 | `test_review.py`: 3가지 제거, 잠긴·다른 조직 총괄 제외, 총괄 2명의 동시 자기 변경·서로 잠금 |
| B3 | 계약의 모든 datetime을 UTC로 정규화하고 Z로 직렬화 | `test_review.py`: DB TimeZone을 Asia/Seoul·Pacific/Honolulu로 바꾼 로그인·me·세션 시각; `test_contracts.py`: 중첩 배터리·lease·사건 시각 |
| R1 | 사용한 모든 refresh 해시를 저장, 재사용 시 해당 세션 폐기·사건, 정상 갱신 사건 | `test_review.py`: 2세대 전 토큰 재사용 및 동시 갱신, 최신 access/refresh 무효 확인 |
| R2 일부 | 현재 비밀번호 실패를 계정 단위 5회/5분 제한·기록, 잠금 뒤 자격·세션 재확인 | `test_review.py`: 다른 기기·사용자·시간 만료·동시 실패·동시 성공 변경; 길이 정책은 기존 1글자 유지 |
| R3 | 중첩 문자열 NUL 거부, DataError 400, DB·일반 예외 500 ApiError | `test_review.py`: 로그인 필드·중첩 키의 NUL, 실제 PostgreSQL 입력/쿼리 오류 및 일반 예외의 형태·원문 비노출 |
| R4 | 응답 serialization 스키마, 출력 기본값 필수, PATCH 생략 가능·null 금지, ErrorBody 이름 | `test_contracts.py`: 응답 필수 필드, 모든 PATCH 필드 null 실패·빈 PATCH 성공, TS 이름 검증 |
| R5 | schema뿐 아니라 중첩 ts의 여분 파일도 --check 실패, 재생성 시 오래된 생성물 제거 | `test_contracts.py`: 여분 JSON·TS·중첩 TS 각각 검출·정리 |
| R7 | 모든 사용자 세션 일괄 폐기에 org_id·revoked_at IS NULL 조건, 명시 폐기 반복 시 시각 보존 | `test_review.py`: 잠금·삭제·비밀번호 변경의 과거 시각 및 다른 조직·사용자 보존, 반복 폐기 |
| R8 | ROBOT_SUMMARY, ROBOT_READ(범위 밖 404), O_OWN(담당 밖 403) 구분, ID 요약도 authorize 경유 | `test_review.py`: 보기/명령 오류 구분과 HTTP 요약 경로의 권한 함수 호출 |
| R10 | LOGIN_RATE_LIMITED 별도 사건·집계 제외, username 원문 대신 account_key 해시, XFF 신뢰 조건 명시 | `test_review.py`: 제한 사건 수·집계 만료·없는 username 원문 비보관; 기존 계정/IP 제한 시험 유지 |
| R11 | 사용자·세션·로봇 cursor를 (created_at, id) 순서로 변경 | `test_review.py`: UUID 역순·같은 생성 시각을 섞어 페이지 유실·중복 및 순서 확인 |
| R2-1 (2차) | 인증된 변경은 dirty flush 전에 조직 NO KEY UPDATE → 계정 advisory → 세션·사용자 순서로 통일 | `test_review_r2.py`: 같은 쿠키의 설정/PATCH·DELETE 계정 잠금 역전, 각 40회 동시 요청 500 0, 설정·비밀번호 확인 40회 |
| R2-2 (2차) | 키·UTC 5분 창별 가변 카운터에 거절 수만 누적하고 닫힌 창마다 count 요약 한 행 | `test_review_r2.py`: 로그인·비밀번호 40회(실패 5·거절 35), 사용자명 변경·다른 IP·동시 요청, rollback·재시작·동시 요약·조직 분리·두 창·DB DST 경계 |

R6·R9·R12·R13은 조정 지시대로 수정하지 않았다. 쿠키와 향후 WS 경로, API/DB 정본 후속,
bootstrap SQL 비밀번호 전달, 시작 권한 검사 확대는 조정 세션의 후속 범위다.
최소 비밀번호 길이 정책도 미정이며 README에 명시했다.
2차의 나머지 권고(refresh 이력 크기, account_key 소금, 정본 /auth/session)도 지시대로 이번에 수정하지 않았다.

## 2차 수정의 재현·동작

수정 전 `eb061e8`에서 새 `test_review_r2.py`의 최초 8개 시험을 실행해 **8 failed**를 확인했다.
동일 세션의 설정·계정 요청은 500을 재현했고, 로그인/비밀번호 40회 중 거절 35건이
영구 사건 35행을 생성했다. 수정 후에는 같은 시험과 추가한 원자성·재시작 시험을 모두 통과했다.

429 합계는 `0003`의 `auth_rate_windows`에 저장하며 현재 키·창에는 한 행만 UPDATE한다.
IP와 계정 제한이 동시에 적용되면 IP를 선택해 username 변경으로 카운터 행이 늘지 않는다.
창이 끝난 뒤 다음 로그인/현재 비밀번호 확인 요청이 최대 100개 창을 요약한다.
40회 시험에서 거절 35회는 카운터 한 행(count=35), 이후 사건 한 행(count=35)이 된다.
요약 전에는 카운터가 DB에 남으므로 재시작해도 합계가 사라지지 않는다.
영구 사건은 계속 INSERT/SELECT 전용이고, 가변 카운터 DELETE와 사건 INSERT는 같은 트랜잭션이다.

## 실행 결과

서버 전용 venv와 pgserver wheel의 PostgreSQL 16을 사용했다. 임시 데이터 폴더·임시 포트·
전용 Unix socket에서만 시험하고 종료했으며 sudo·Docker·SQLite·운영 서비스·ROS·Gazebo·실기에 접촉하지 않았다.

- `apps/server/.venv/bin/python -m pytest apps/server -q`: **100 passed**, Starlette/httpx 사용 중단 안내 1건
- `apps/server/.venv/bin/python -m pytest apps/server/tests/test_migrations.py -q -s`: **1 passed**,
  `upgrade head → downgrade base → upgrade head: PASS`, ORM/DB 차이 0
- 마이그레이션 시험은 기존 0001의 실제 사용자·세션을 넣고 0002·0003 업그레이드/다운그레이드의 자료 보존도 확인
- `apps/server/.venv/bin/python apps/contracts/generate.py --check`: **28개 일치**
- `npm run --prefix apps/contracts typecheck`: **PASS**
- `python3 sim/v2_link.py --selftest`: 원본 수정 없이 **selftest OK** (ROS 없는 오프라인 자체검사)

새 카운터 표는 `0003_auth_rate_windows.py`로 추가하며 기존 `0001`·`0002`는 변경하지 않았다.
0003을 내리면 미요약 카운터는 사라지므로 먼저 별도 보존 계획을 검토해야 한다.
자료가 있는 DB에서는 전체 `downgrade base`를 되돌림 수단으로 쓰지 않는다.
코드 수정은 새 변경 커밋을 revert하고, DB 되돌림은 백업 뒤 별도 검토한다.
실제 브라우저·HTTPS 프록시·앱·실폰·로봇 및 통합 dev 후보는 미검증이다.

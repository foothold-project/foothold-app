# PR #46 6차 검토 반영 기록

기준 `6ec2139441525c4e28566fd193029bb2b516e53f`, 같은 `feature/sim-manager`다.
실제 ROS/rclpy/Gazebo·systemd-run unit·FH_SIM_RUN=1·실기 실행 0,
safety/**·안전 상수·셀프테스트·ADR09 변경 0이다.

수정 커밋은 `0eb92da6235e20312f054c3c0031803483ca1b38`이며 전체 pytest는 이 운영/시험
소스에서 실행했다. 이후 전진한 origin/dev `50dd4abf443a8532f6c71f660cf401e4cbb88226`을
`3dc697d5e75146325dbe6dd5df2bc0d0521f5516`으로 일반 merge했다(충돌 0·웹만 10파일).
merge 전후 apps/server·apps/agent·apps/simmgr·apps/contracts 트리는 같다.
따라서 전체 pytest/계약은 반복하지 않고 바뀐 웹의 typecheck·vitest를 최종 재검사했다.
rebase·force push 0이다.

## 결정과 회귀

| 지적 | 반영 |
|---|---|
| L1 / B1 / K1 예외 경계 | Relay.request의 요청 생성·직렬화·송신·응답 읽기/닫기·JSON 디코딩과 HTTPError 본문 읽기를 바깥 `except Exception`으로 정규화한다. RelayError의 코드/상태는 유지하고 다른 예외는 SIM_UNAVAILABLE/503이다. KeyboardInterrupt·SystemExit·CancelledError 등 BaseException은 그대로 전파하며 원문 예외 메시지를 응답/감사에 넣지 않는다 |
| 시작·제거 완료 관문 | POST는 확실한 생성 전 거부 9개 외 성공·불확실 모두 기존 조직 잠금/refresh 관문으로 간다. DELETE도 성공·RelayError 모두 잠금/refresh 뒤 판단한다. DELETE 불확실 결과는 REMOVE_FAILED 1건을 commit하고 STOPPING을 보존한다. 이전 세대/owner/hash/출입증을 바꾸지 않는다 |
| M1 최종 확인 잠금 | POST의 최종 Robot refresh 직후를 붙잡아 DELETE의 실제 PostgreSQL 잠금 대기(pg_blocking_pids)를 관측한다. release 뒤 POST 201→DELETE 204→IDLE·관리자 로봇 0이다. 최종 lock_organization 삭제 변이는 assertion KILLED |
| M2 STALE 409 | delete_first 경합에서 DELETE는 사용자 요청 1회뿐이며 보상 DELETE 0회임을 단언한다. NOT_CREATED 감사 1건을 유지한다 |
| M3 문구 | START_STALE은 NOT_CREATED / REMOVED_OR_ABSENT / 정리 실패로 구분한다. FIRST-LAUNCH에 503만으로 STARTING 유지/보상 여부를 구분할 수 없으므로 목록·감사·재취득으로 확인한다고 적었다. API §13.9·README·FIRST-LAUNCH·REVIEW-R5 숫자 앞 띄어쓰기도 정리했다 |
| M4 웹 계약 고정값 | approvals/connect/events/maps/robots 시험의 RobotSummary 고정값 5곳에 simulation: false만 추가했다. dev merge로 들어온 missions 시험 고정값 1곳도 조정의 별도 승인 뒤 같은 한 줄을 추가했다. 웹 동작 변경 0 |

Codex의 한도 안 깊은 JSON(HTTP 200·503)과 Claude의 HTTPError 본문
ConnectionResetError·TimeoutError를 `test_sim_restart_delivery.py`의 broken_response와
회귀 매개변수로 옮겼다. 재시작 뒤 첫 POST 응답 장애에서 관리자 로봇 0·IDLE·
START_STALE 1건·POST 1회·같은 세대 DELETE 1회 보상을 단언한다.
DELETE 본문 OSError는 503·REMOVE_FAILED 1건·STOPPING·owner 보존을 단언한다.
요청 직렬화·송신·본문·닫기의 예상 밖 RuntimeError/TypeError와 BaseException도 검사한다.
DB가 그대로 STARTING·같은 세대인 정상 불확실 결과는 보상 0이며 후속 세대는 불변이다.
원격 POST/GET/보상 DELETE 동안 조직 잠금 없음과 이전 경합/복구 시험을 유지한다.

## 실행 환경과 검증

기본 셸의 ROS_* 5개(ROS_DOMAIN_ID=57)를 유지하고 fixture에서만 격리했다.
기존 승인된 venv/웹 의존성을 사용했으며 새 의존성 설치 0이다.
웹 시험의 임시 node_modules 연결로 공유 의존성 경로의 `.vite/vitest/results.json`
결과 캐시가 갱신되어 읽기 전용 제약에서 벗어났다. 연결은 제거했고 공유 캐시는 더
수정하지 않았다. 공유 패키지 소스·다른 worktree의 추적 소스 수정은 0이다.
merge 뒤 재검사는 의존성을 현재 worktree tmp/p1c/r6 안에 복사해 캐시도 로컬에 기록했다.
PYTHONDONTWRITEBYTECODE=1, PYTHONPATH=$PWD/apps/simmgr/tools:$PWD/apps/agent:$PWD,
TMPDIR=$PWD/tmp/p1c, FH_TEST_PORT_RANGE=9430:9449다. socket fence가
리스너/목적지를 loopback 9430~9449로 제한하고 client source ephemeral만 허용한다.
무거운 실행 직전 MemAvailable≥2.5GB를 확인했다(관측 약 3.7GiB 이상).

```sh
"$FH_PYTHON" -m pytest apps/server -q --tb=short
"$FH_PYTHON" -m pytest apps/agent -q --tb=short
"$FH_PYTHON" -m pytest apps/simmgr -q --tb=short
"$FH_PYTHON" apps/contracts/generate.py --check
npm --prefix apps/web run typecheck
npm --prefix apps/web test
"$FH_PYTHON" apps/simmgr/tools/check_mutations.py \
  --only 'relay normalization narrowed' \
  --only 'HTTPError body outside normalization' \
  --only 'final STARTING organization lock omitted'
```

| 검사 | 이번 실행 결과 |
|---|---|
| 서버 전체 1회 | 771 passed, 1080.64초 |
| 에이전트 전체 1회 | 835 passed, 1 skipped, 43.23초 |
| simmgr 전체 1회 | 69 passed, 1.65초 |
| 집중 경합/복구 1회 | 68 passed, 115.97초. 이후 문구 3건·전체 요청 경계 4건은 서버 전체에 포함 |
| 검토자 원문 사본 | 6 passed, 7.92초. 깊은 JSON 200·503 모두 503·IDLE·로봇 0·START_STALE 1건, 본문 ConnectionResetError도 동일 |
| 새 예외 변이 2개 | 2/2 assertion KILLED, 수집/실행 오류 0 |
| M1 최종 잠금 삭제 변이 | 1/1 assertion KILLED, 수집/실행 오류 0 |
| merge 전 웹 typecheck / vitest | 종료 0 / 8 files·455 passed, 15.40초 |
| merge 후 최종 웹 typecheck / vitest | 종료 0 / 9 files·490 passed, 13.46초 |
| contracts --check | 생성물 155개 일치 |

검토자 원본은 읽기만 했다. 사본에 결과 assertion을 보강했고 원본은
수정하지 않았다. Claude 이중 장애 탐침의 출력 결과도 문서의 복구 순서와 같았다.
전체 pytest는 앱별 1회이며 반복 5회·기존 변이 전수는 이번에 재실행하지 않았다.
기존 검증 기록을 이번 독립 실행 결과로 표시하지 않는다.
merge 후 첫 로컬 의존성 사본은 폴더명이 node_modules가 아니어서 타입 경로 해석에
실패했다(TS7006). 사본 디렉터리명만 바로잡은 최종 typecheck는 통과했으며 실패 로그도
별도로 보존한다. 이 과정의 운영/시험 소스 추가 수정은 0이다.
skip 1건은 opt-in 실제 DDS 시험이며 경고는 기존 TestClient deprecation/빈 match다.
로그·재현 사본·변이 JSON은 worktree의 tmp/p1c/r6에 보존하고 커밋하지 않는다.

실제 startup OS/user bus·unit 종료/고아/자원 상한·ROS binding·STOP0 ACK·93 DDS 정리·
native 명령 지연·실폰/LAN/WSS/UI·실기·운영 migration/배포는 미검증이다.
응답 유실+보상 실패의 잔여 runtime, offline 600초, world/agent 각각 RuntimeMaxSec=240과
정지 grace 45/15초의 실제 종료 검증은 [FIRST-LAUNCH](FIRST-LAUNCH.md)의 별도 승인 범위다.
Claude의 변경분 짧은 확인과 조정의 dev 합치기, 실제 기동 승인은 별도다.

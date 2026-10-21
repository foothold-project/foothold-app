# P1-A 폰 직결 검증 기록 — PR #41 r1

2026-10-21. `feature/agent-phone-link`, `dev` 대상 Draft PR. 정본은 ADR-002 0.3
(`origin/dev`의 `828f572`) 및 [05 §13](../../docs/spec/05-API-SPEC.md#13-폰--에이전트-fh-phone1).
PR #41의 코드 커밋은 PR 본문/완료 보고의 정확한 head를 따른다. 아래 수치는 r1 최종 검증이다.

## 변경

- `foothold_agent/phone/`: 4 KiB WS 서버, 오프라인 HS256 출입증 확인·영속 jti 저널,
  단일 조종권 중재기, 상태/ACK/요청 알림, 관제 전송 Observer.
- `ros_bridge/config.py`, `__main__.py`: 환경 설정에 따른 명시적 리스너 활성화와 모의 검증.
  **실제 Session/Core와 sink는 하나**, Observer는 Session/Core/실제 출력이 없다.
- `tests/test_phone.py`, `tools/check_phone_mutations.py`: 가짜 sink·시계·폰·관제 서버 회귀와 변이.
- `apps/contracts/models.py`, `schema/Phone*.json`, `ts/index.ts`: 폰 모델과 생성물 20개.
- `README.md`, `docs/spec/05-API-SPEC.md`: 실행 환경·계약·결정/후속 범위.
- `safety/**`, 원본 셀프테스트, 기존 `sim/server/contracts/ui/mobile` 변경 0.

## 실행

Python 3.12.3, 작업 폴더의 `.venv`(pytest 9.1.1, websockets 15.0.1, Pydantic 2.14.1).
임시 파일은 `TMPDIR="$PWD/tmp/phone"`로 작업 폴더 안에 두었다. 무거운 실행 직전
MemAvailable은 2.5 GB 이상(관측 6~7 GB)이었다. 새 폰 시험은 loopback 9450~9469만
사용했다. 기존 helper 9060~9079는 조정 세션의 명시적 승인으로 유지했다.

| 실제 명령 (`TMPDIR` 설정 후) | 결과 |
|---|---|
| `.venv/bin/python -m pytest apps/agent -q` | **695 passed, 1 skipped**. 기존 582개 + 폰 113개(이전63개 포함). 기존 경고 2개 |
| `.venv/bin/python -m pytest apps/agent/tests/test_phone.py apps/agent/tests/test_phone_review.py -q` | **113 passed** (test_phone.py + test_phone_review.py) |
| `.venv/bin/python apps/agent/tools/check_phone_mutations.py` | **35/35 KILLED**, assertion 실패로만 판정 |
| `.venv/bin/python apps/agent/tools/check_link_mutations.py` | **80/80 KILLED** |
| `.venv/bin/python apps/agent/foothold_agent/ros_bridge/check_mutations.py` | **49/49 KILLED**, synthetic 옵션 없음 |
| `.venv/bin/python apps/contracts/generate.py --check` | 생성물 **139개 일치** |
| `npm --prefix apps/contracts ci --ignore-scripts` | 완료, 취약점 0(실행 당시 출력) |
| `npm --prefix apps/contracts run typecheck` | 통과 |
| `git diff --check` | 통과 |
| `git diff --quiet origin/dev -- apps/agent/foothold_agent/safety apps/agent/tests/test_original_core.py` | 차이 0 |

전체 시험에서 제외된 1개는 실제 DDS 참여를 요구하는 synthetic ROS 시험이다.
`FOOTHOLD_ROS_SYNTHETIC=1`을 설정하지 않았다. 처음 시스템 Python 실행은 websockets
미설치로 6 failed/544 passed/3 skipped였고, 격리 환경 설치 뒤 위 최종 결과를 얻었다.

검증한 경계: 두 폰 동시 취득 하나만 성공, 연결 간 lease 재사용 거부, 보기 전용 STOP,
위조/다른 로봇·조직·기기·용도·만료/재사용 거부(재시작 포함), 열린 연결 만료 시 STOP,
3초 ping 감시·15초 예약과 동일 사용자+기기의 새 취득, 반납, 요청 10초·재요청 제한30초,
STOP/해제 피드백/새 중립, deadman 정확한 0.3초 경계, 허용 명령 집합·잘림 표시,
잘려서0인 비중립의 중립 대체 금지, 형식 오류·두 번째hello, 측정 null·echo·시계차,
시계 불신/역행, 저널 지연의 수명 연장 금지, 출력 오류, 서버 cmd·재접속 격리,
환경 설정·ROS 없는 진입점 모의 검증·stdlib import, bridge 만료 후 소켓4401 유지.

## 기존 Nav2 변이 도구의 분류 한계 (이번 변경과 무관)

추가 실행한 명령:

```
.venv/bin/python apps/agent/tools/nav2/check_mutations.py --report tmp/phone/nav2-mutations.json
.venv/bin/python apps/agent/tools/nav2/check_mutations.py --only cancel_goal_removed --report tmp/phone/nav2-cancel-rerun.json
```

전체 **64/65 KILLED**, `cancel_goal_removed`는 **SURVIVED/ERROR**로 종료1이다.
이번 r1 전체 실행에서도 같은 결과를 재확인했다.
이 변이는 assertion 실패 **11개로 실제 검출**됐지만 아래 기존 시험3개가
`StopIteration`도 내므로 도구가 ERROR로 분류한다. 이를 통과/KILLED라고 세지 않았다.

- `test_deadline_boundary_cannot_be_revived_in_either_callback_order[0.300001-False]`
- 같은 시험 `[0.300001-True]`
- `test_delayed_consumption_then_callback_before_owner_cannot_reset_deadline`

`git archive origin/dev apps/agent`로 **828f572의 원본**을 작업 폴더 안
`tmp/phone/dev-baseline`에 추출해 같은 단일 변이를 재실행했다. 기본172개 통과 후
동일한 assertion11개 + StopIteration3개 + ERROR/종료1을 재현했다. 변이 대상
`executor/nav2/intent.py`와 기존 Nav2 시험은 변경하지 않았다. 조정 세션은 근거를
PR에 적고 이 도구/시험 분류 개선을 별도 후속 작업으로 남기는 것을 승인했다.

## 결정·한계

- 출입증 상한600초(10분). 서버 없이 갱신하지 못하면 **남은 수명(최대10분) 뒤
  정지·잠금·조종권 비움**. 실제 발급 서버·권한 회수 목록 수신은 후속.
- HS256 로봇별 전용키(최소256bit). 로봇 키 유출 시 해당 로봇의 위조 가능성을 명시.
  jti 저널을 잃으면 키 교체 후 복구. 시계 동기화 신뢰는 운영자가 확인해 제공한다. 외부 신뢰 변경 IPC는 없으므로
  현재 동기화 상실은 프로세스 정지로만 전달한다. NTP 감독 연동은 실기 전 관문이다
  (단위 시험의 신뢰 값 주입·역행·5초 차이는 검증).
- 같은기기 두번째 활성WS 거부. 다른로봇 control 출입증 중첩 금지는 발급자 의무이며
  이전 대상 출입증 만료까지 기다린다. 여러 오프라인 에이전트 사이 전역 회수 구현은 아님.
- 감시는 전부 단조 벽시계. Core의 deadman은 기존대로 >0.3초에서0·새 중립이며 잠금 추가0.
- 실제 ROS/시뮬·운영 포트·domain61·실폰·실로봇 접촉0. 실제 지연·정지 거리·TLS 배포·
  멀티 로봇 이름 공간 격리는 미검증. 카메라·RUN·시뮬 관리자·웹 연결은 후속이다.
- `dev` 합침은 조정 세션의 Claude/Codex 양쪽 안전 검토 관문을 거친다. 배포·merge 없음.


## PR #41 두 모델 검토 반영 r1

두 검토 보고서와 재현 코드의 시나리오를 읽어 저장소 회귀 시험으로 옮겼다. 원본 검토
worktree 파일은 고치지 않았다. `tests/test_phone_review.py` 49개와 기존 진입점 시험의
simulation 두 값 분기로 50개를 추가했다. 원본의 메모리 저널/느슨한 키 권한 관측은
이제 설정 단계에서 거부하는 음성 시험으로 바뀌었다.

| 지적 | 수정/재현 결과(대표 시험 이름) |
|---|---|
| X1 Codex B1 | 실제 WS의 인증된 보기 폰4097바이트→1009→STOP/잠금. 정상 보기 폰 종료는 영향없음 (`test_transport_viewer_invalid_close_stops_but_normal_close_does_not`) |
| X2 Codex B2 | 실제 WS disconnect의 sink 예외→서비스 실패·connections/reader/states 정리. 최초 오류/취소+추가 출력 오류 보존 (`test_disconnect_sink_error_is_service_failure_and_always_cleans_tasks`, `test_handler_cleanup_preserves_first_error_or_cancellation`) |
| X3 Codex B3/Claude R7 | 운영 메모리 DB 거부, 파일 소유자/권한/FD 일반 파일 검사. key/journal의 group읽기·other쓰기·symlink·directory·FIFO 10개 음성 시험 |
| X4 Claude B1 | 자기 취소 포함30초 제한, 요청/취소8개/초 초과 연결만 닫기, 알림 종류별 최신1개. 실제 WS 폭주 중 조종자·서비스 유지, 감사 전환2건으로 제한 (`test_request_cancel_flood_closes_only_requester_and_bounds_events`) |
| X5 Claude B2/R11/Codex R2 | view 취득 거부,5초 차이,중복/역행seq,4096가득참,재시작UTC역행,보기폰틀린프레임,만료넘김,예약마감,JOSE alg/header/padding 모두 회귀+변이 추가 |
| D1 | hello 전 틀린 프레임/STOP/수신 계층 오류는 소켓만 닫고 로봇 영향0. Origin 기본 브라우저 거부/앱 허용·허용목록 실제 WS 시험 |
| D2 | 미승인 대기4개·3초, 가장 오래된 대기 교체. 네 대기 소켓 뒤 동일 사용자/기기 재접속 취득 성공·hello 만료 영향0 |
| D3 | 폰 Session에 `server_link=False`(기존 서버 경로는 True 기본값 유지). reviewer P18b 시간축에서 owner⇔유효lease 유지·가짜 SERVER_LINK_LOST0 |
| D4 | reviewer probe4의 중립→vx0.2→0.4→0.6은0/0/0.6이며 Core 이유 응답. 중립 없는 중간 입력은 중립을 만들지 않음 |
| D5 | Observer stop_ref는 마지막 서버 ref만, 재접속0. 폰 state의 로컬 카운터 의미는05에 분리 |
| D6 | receive 앞 전체 만료. 다른 폰 요청이 만료된 조종자의 옛 비영 out을 내지 않음 |
| D7/R8/R12/R13 | 실행 설정의 simulation0/1·누락거부, NTP 문서 실제 동작 교정, 전체 recv 제한시간, robot소문자표준형 모델·생성물·05 일치 |

35개 폰 변이는 assertion 실패만 KILLED로 세며 import/runtime 오류를 통과로 세지 않는다.
기존 변이의 방향은 «예약 보호 제거(and False)»와 «같은 기기의 정상 재취득 거부(and True)»로
나누었다. 새 회귀는 검토자의 Codex B1/B2/B3와 Claude P1/P18b/P20/P21·요청/취소 폭주·
아날로그 램프·인증/시계/seq 재현에 대응한다.

이번에 바꾼 결정은 D1(승인 전 영향0), D3(Hub 단일 타이머), D4(이전 중립 보존)이며
05 §13과 PR 본문에도 반영했다. `safety/**`·상수·원본 셀프테스트 변경0을 유지한다.
후속 R6: hello의 동기 FULL commit이 루프를 막는 시간은 **1단계 시뮬 관문에서 fsync
지연으로 측정**한다. 이번에는 ROS/시뮬을 실행하거나 저장 비동기 구조를 바꾸지 않았다.

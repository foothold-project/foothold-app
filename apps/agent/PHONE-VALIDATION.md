# P1-A 폰 직결 검증 기록 — PR #41 r5

2026-10-21. `feature/agent-phone-link`, `dev` 대상 Draft PR. 정본은 ADR-002 0.3
(`origin/dev`의 `828f572`) 및 [05 §13](../../docs/spec/05-API-SPEC.md#13-폰--에이전트-fh-phone1).
PR #41의 코드 커밋은 PR 본문/완료 보고의 정확한 head를 따른다. 아래 수치는 r5 최종 검증이다. r1~r4는 당시 이력이며 최신 결정은 D10 정정·D11이다.

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
MemAvailable은 2.5 GB 이상(r5 실행 직전 관측 5.5~5.7 GB)이었다. 새 폰 시험은 loopback 9450~9469만
사용했다. 기존 helper 9060~9079는 조정 세션의 명시적 승인으로 유지했다.

| 실제 명령 (`TMPDIR` 설정 후) | 결과 |
|---|---|
| `.venv/bin/python -m pytest apps/agent -q` | **769 passed, 1 skipped**. 기존582개 + 폰187개(이전174개 포함). 전체1회, 기존 경고2개 |
| `.venv/bin/python -m pytest apps/agent/tests/test_phone.py apps/agent/tests/test_phone_review.py -q` (r5 부분 확인) | **187 passed**, 위 전체 실행에도 포함 |
| `.venv/bin/python apps/agent/tools/check_phone_mutations.py` | **64/64 KILLED**, assertion 실패로만 판정 |
| `.venv/bin/python apps/agent/tools/check_link_mutations.py` | **80/80 KILLED** |
| `.venv/bin/python apps/agent/foothold_agent/ros_bridge/check_mutations.py` | **49/49 KILLED**, synthetic 옵션 없음 |
| `.venv/bin/python apps/agent/tools/nav2/check_mutations.py --report tmp/phone/r5-nav2-mutations.json` | **64/65 KILLED, 종료1**. 아래 기존 분류 한계 동일 |
| `.venv/bin/python apps/contracts/generate.py --check` | 생성물 **139개 일치** |
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
r1·r2·r3 전체 실행에서 같은 결과를 재확인했다. r3 JSON도 동일한 assertion11개·StopIteration3개다.
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
| D2 → Z1 | 미승인 대기4개·3초에 주소당2개·검증 중 보호를 추가. 아래 r2 지속 흐름 시험으로 보강 |
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


## PR #41 재확인 r2

Claude r2 보고서와 보조 보고서(-2~-5), probe6~8을 읽었고 Codex r2의 막는 것0을
확인했다. 원본 검토 worktree는 읽기만 했다. r1보다 폰 시험22개, 변이12개를 추가했다.

| 지적 | 수정/시험/변이 |
|---|---|
| Z1 | hello 대기 주소당2개를 전체4개 상한보다 먼저 적용. 해당 주소의 미승인 대기만 교체하며 hello 검증 중은 제외. 교체 후보가 모두 검증 중이면 새 연결만 거부. 실제 WS에 논리 주소를 시험용으로 주입하여 한 주소의 지속16개 흐름 중 다른 주소의 동일 사용자+기기 새 출입증 취득 **10/10**. 전체/주소 상한·검증 중 보호 각각 회귀와 변이 |
| Z2 | 두 중립 시험 모두 후진·작은 앞 입력·옆·회전 네 분기로 매개변수화. 각 입력 뒤0.6이0 유지. 옆/회전을 중립으로 만드는 두 변이 검출. 중립 확인 뒤0.2→0.4→0.6의 기존 동작 유지 |
| Z3 (당시) → D8 | 명시적 cancel만30초 제한으로 구현했던 우회가 r3에서 드러나 모든 요청자 철회로 교정. 아래 최신 D8 기록 참조 |
| Z4 | 인증16개 상한/17번째 거부, 실제 WS1002(잘못된 연속 프레임)·1007(틀린 UTF-8)·1003 종료→STOP, key/journal 실행uid, journal open 후 SQLite connect 전 inode 교체 거부, 1초 창마다8개씩24개 요청 생존. 해당 변이7개 검출 |
| Z5 | README·05 §13에 PWA Origin 설정 필수/빈 목록403, 실행 사용자 소유·0600·실파일 배포 조건, 링크/그룹 읽기 거부와 실기 전 배포 시험 명시 |

검토자 재현을 작업 폴더 안 `tmp/phone/r2-probe*.py`로 옮겨 새 코드에서 실행했다.
probe6은 **187272 cases, bad0**, probe8의 회전±/옆±/후진5개 모두 뒤의0.6까지0이다.
probe7은 loopback WS에 **공격 주소와 조종자 주소를 분리 주입**한 경우 동시4/16/64개
흐름 모두 **10/10 취득, 서비스 실패0**이었다. 연결 시작 도중 공격 태스크를 취소하면서
일부 미완성 HTTP handshake 종료 로그가 남았으며 조종 결과/서비스 생존과 구분했다.
헤더를 통한 주소 주입은 시험 전용 Server 서브클래스에만 있고 운영은 소켓의 원격 host만 쓴다.
원본 probe7의 같은 주소 흐름을 해결했다고 주장하지 않는다. 같은 host/NAT의 비인증
폭주는 그 주소의 재접속을 막을 수 있으며 정지·잠금을 유지하는 한계를05에 명시했다.

r2 최종 폰 변이 **47/47**은 모두 assertion 실패로만 검출했다. 첫 inode 변이 실행에서
검사 제거가 SQLite 오류로 끝난 것은 KILLED로 세지 않았고, private open과 SQLite connect
사이의 실제 경로 교체로 재현 시점을 고쳐 assertion 검출을 확인했다.

이번 결정 Z1(주소별 수용·검증 보호)과 Z3(자기 취소만 CANCELED 제한)은05·PR에 반영했다.
후속 Q1/Q2: 실제 PWA/앱의 Origin·WSS와 실행 사용자 소유0600 실파일 제공 방식으로 실기 전
시작 시험. 후속 Q5: 닿지 않는 중복 방어(_check_peer·추가 stop·closing 검사) 변이의 생존은
결함으로 세지 않는다. 후속 Q7/R6: 1단계 시뮬 관문에서 hello FULL commit/fsync 차단 시간과
**hello 대기 흐름 중 조종20Hz 흔들림**을 함께 측정한다. 이번에는 ROS/시뮬 기동0이다.


## PR #41 재확인 r3 — 당시 결정 D8/D9 (D8은 r4에서 보충)

Codex r3 보고서와 자기 취소 재현, Claude r3 보고서(-2~-4 포함)와 probe9/10을 읽고
저장소 시험으로 옮겼다. 원본 검토 worktree는 읽기만 했다. 폰 시험22개와 변이6개 추가다.

| 지적/결정 | 수정·회귀·변이 |
|---|---|
| V1/D8 | 자기 철회는 cancel·release·view·요청자 끊김(ping 무수신 포함) 모두. identity(user+device) 기준30초 제한을 남겨 새 출입증 재접속도 차단. 29.99초 거부/30초 허용5분기, 실제WS 요청자 종료·재접속, probe9 5초 동안8프레임/초·16프레임/초 두 경우 ×3별칭 회귀. 요청 수락1·사건2, 초과는 해당 연결만 닫음 |
| D8 예외 (당시) | 형식 오류를 비귀책으로 분류한 부분은 r4에서 수정. 조종자 원인·출입증 만료/시계 불신·서비스 종료/내부 오류만 제한0. 아래 최신 D8 보충 참조 |
| D8 속도 창/변이 | request·cancel·release·view 합계8개/초. release/view 반복 음성 시험. 요청자 release 무벌·요청자 끊김 무벌·release/view 속도 창 제외·서버 정리 오분류 변이4개 검출 |
| V2/D9 | hello 대기 전체16개/주소당2개, 주소 상한 먼저. 전체 교체는 교체 가능한 소켓 중 대기가 가장 많은 주소부터, 동률은 가장 오래된 것. 최대치16·모든 검증 중 보호·주소 부하/동률 회귀, 부하 무시·전체4개 회귀 변이2개 검출 |
| D9 실제WS | 헤더 주소 주입 없이 Linux loopback connect(local_addr=...)로 서로 다른 출발 주소. 공격2×8·4×4·8×4 흐름 중 다른 주소의 동일 사용자+기기 새 출입증 재취득 **각10/10**, 서비스 생존. 정상 연결은127.0.0.1·공격은별도loopback host |
| W1~W3 | README/05에 역방향 프록시 앞단 금지, 동기 hello 검증 전제/비동기 변경 시 제외 규칙 재검토, 실기 전 폰 앱1013 짧은 재시도 확인 명시 |

검토자의 probe9/10은 작업 폴더 안 `tmp/phone/r3-probe9.py`·`r3-probe10.py`로 옮겨
새 코드로 다시 실행했다. probe9의 release/view/cancel은 모두 요청 수락1·사건2·
LEASE_REQUEST_COOLDOWN이며 조종자 유지/잠금 추가0이다. 저장소의 5초 전체 시간축
시험에서는8프레임/초 정상 제한·16프레임/초 해당 연결 종료도 별도로 확인했다.
Codex의 원본 자기 취소3경로 재현도 **3 passed**다.

probe10 실제 출발 주소 시험은1×16·1×64·2×8·4×4·8×4 모두 **10/10**이었다.
상한/2를 넘는 **16×4는3/10(실패7, 1013 HELLO_CAPACITY), 서비스 생존**으로 남은 한계를
재현했다. 이를 통과나 해결로 세지 않는다. 같은 주소/NAT 폭주 또는8개를 넘는 다중 공격
주소의 폭주가 재접속을 막을 수 있으며 정지·잠금을 유지한다. **실기 전 로봇 망 분리·
접속 속도 제한** 관문을 README·05·PR에 적었다. 역방향 프록시는 실제 출발 주소를
합치므로 앞단 금지다. 폰 앱1013 짧은 재시도는 실기 전 확인 범위이며 이번 구현은 아니다.

최종 폰 변이53개는 모두 assertion 실패·비-assertion 오류0으로 검출했다.
새 회귀/변이 외에 safety·원본 셀프테스트 변경0, ROS/시뮬/운영 포트 접촉0을 유지했다.


r3 최종 실행은 전체 pytest739 passed/1 skipped, phone53/53·link80/80·ROS49/49 변이
종료0, contracts139개 일치·typecheck 종료0이다. Nav2는64/65·종료1이며
cancel_goal_removed의 assertion11개와 StopIteration3개가 이전과 같음을 JSON으로 확인했다.
새 코드/시험의 오류를 통과로 바꾸지 않았으며 기존 Nav2 분류 개선은 앞서 승인된 후속이다.
명령/로그는 작업 폴더 안 `tmp/phone/r3-*.log`·`r3-nav2-mutations.json`에 남겼다.


## PR #41 재확인 r4 — 당시 결정 D8 보충·D10 (r5 정정 전)

Codex r4 보고서/실제WS 재현, Claude r4 보고서(-2/-3 포함)와 test_r4_probe·probe11·
probe12를 읽어 저장소 회귀로 옮겼다. 원본 검토 worktree는 읽기만 했다.
폰 시험17개·변이7개 추가, 기존 시험/변이는 새 D8/D10 의미로 교정했다.

| 지적 | 현재 수정·회귀·변이 |
|---|---|
| T1/D8 보충 | Hub.fail은 요청자 귀책 거부를 철회로 분류. REQUEST_FLOOD·형식·크기·수신 계층 오류 등에 같은 identity30초 유지. 비귀책 출입증 만료/시계 불신은 예외. 실제WS 세 원인×새 출입증 재접속3회→수락1·요청/취소 사건2,29.99초 거부/30초 허용. 분류 단위 시험5개(알림 넘침 코드 포함) |
| 내부 오류/종료 | handler의 primary/stopping 판정을 유지. 내부 오류·서비스 종료는 제한0, send timeout·정상 폰 종료는 제한30초. 정리 후 pending·connections·workers 회수. 내부 오류 벌점 변이 검출 |
| T2/D10 | request/cancel 합계8개/1초 초과는 해당 연결 종료. view/release는 독립된1초 창에 합계8개, 초과는 오류 응답(REQUEST_FLOOD/status429)만 하고 무시·연결 유지. 실제WS 보기 폰20연타 뒤STOP 성공, 초과 release가 pending을 취소하지 않음, 요청/release 반복은 여전히 수락1·사건2 |
| T3 | 정확히(user,device)만 제한. 같은 사용자의 다른 기기·다른 사용자의 같은 device 값은 요청 즉시 성공. 원래 identity는 계속 제한. 같은 사용자 다른 기기까지 제한하는 변이 검출 |
| T4 | Hub의 pending16 상한은 직접 사용 전용이라는 주석, 직접16개/17번째 SERVER_BUSY 단위 시험·변이. Server는 _admit에서 먼저 등록하므로 이 경계를 쓰지 않음 |

신규7개 변이는 REQUEST_FLOOD 무벌·형식 오류 무벌·내부 오류 벌·사용자 전체로 제한 확장·
view/release 초과 연결 종료·초과분이 실제 취소를 적용·직접Hub 상한 제거다. 기존
release/view 속도 변이는 soft limit 제거로, 서버 정리 벌점 변이는 비귀책 시계 정리로 바꿨다.
최종 **60/60**은 실제 assertion 실패·비-assertion 오류0이다.

두 검토자의 원본 r4 재현 파일을 작업 폴더 안으로 옮긴 실행은 **5 passed**다.
probe12의 실제5초 루프는 flood1365회·정상 종료1166회·형식 오류2370회 새 연결 모두
**요청 수락1·lease 관련 사건3(초기 조종 취득1+요청/취소2)**이었다. 원래 조종자·서비스는
유지됐고 형식 오류는 기존대로 STOP/잠금, flood/정상 종료는 추가 잠금0이다.
별도 저장소 WS 회귀가 크기 초과1009와29.99/30초 경계도 확인한다.

probe11 재실행: 대기peak16, handler 소켓peak은8×4→32·16×4→64·64×2→128,
관측 maxrss51~57MB였다. 신규 보기 폰STOP은 흐름 없음10/10,8×4 다른 주소10/10,
NAT 공유8/10,16×4 다른 주소7/10으로 접속 한계가 남았다. 보장값이나 해결로 세지 않는다.
05 §13 한계에7/10·8/10 수치를 적었다. 실기 전 망 분리·접속 속도 제한에 **주소별 동시
TCP 수·ulimit**을 추가했다. 승인된 폰의 STOP과 신규 폰의 hello 접속을 구분한다.
ROS/시뮬/운영 포트 접촉0·safety 및 원본 셀프테스트 변경0을 유지했다.


r4 최종 실행: 전체756 passed/1 skipped, phone60/60·link80/80·ROS49/49 변이 종료0,
contracts139개 일치·typecheck 종료0이다. Nav2는64/65·종료1이며 기존과 동일한
cancel_goal_removed assertion11개·StopIteration3개를 r4 JSON으로 확인했다. 이 기존 분류
한계를 통과로 세지 않는다. 로그/재현 복사본은 작업 폴더 안 `tmp/phone/r4-*`에 남겼다.


## PR #41 재확인 r5 — D10 정정·D11

두 검토자의 r5 보고서와 재현을 읽고 저장소 시험으로 옮겼다. 원본 검토 worktree는
읽기만 했다. 폰 시험13개·변이4개를 추가하고 기존 만료/직접Hub 상한 시험을 보강했다.

| 지적 | 현재 수정·검증 |
|---|---|
| S1/D10 정정 | 현재 조종자 release/view는 속도 창 검사·집계 없이 늘 즉시0·잠금·조종권 비움. soft 오류/무시는 비조종자만. take/넘김 수락 성공 때 이전 request/cancel·release/view 창 초기화 |
| S1 역할 회귀 | 비조종자 view8회→취득 또는 넘김 수락→unlock·새 중립·0.6→release/view4분기, 실제WS도4분기. 모두 즉시owner/lease없음·잠금·Core/sink0·옛lease cmd거부. 취득/반납12회×2분기와 이미 가득 찬 owner 창 주입×2분기도 안전 반납. 조종자 명령은 집계0 |
| S1 변이 | 조종자 release도 창 적용→안전 반납 assertion으로 검출. 취득 시 역할 창 초기화 제거→4분기 검출 |
| S2/D11 | 요청자 출입증 만료로 대기 요청이 사라져도 그 만료 시점부터30초 철회 제한. 조종자 출입증 만료는 기존대로STOP·잠금·비움/요청자 제한0. 시계 불신·내부 오류·서비스 종료 예외 유지 |
| S2 회귀/변이 | 시계 주입으로 잔여수명1초 새 출입증29회 반복→30초 내수락1·요청/취소사건2. t=1만료 뒤t=30.99거부/t=31허용. 요청자 만료 무벌 변이 검출 |
| S3 | direct Hub에서15개 대기 중16번째hello 성공·16개 대기 중17번째SERVER_BUSY. 상한4회귀·상한제거 두 변이 모두 검출 |

원본 Codex owner-release 단위2개/실제WS1개는 모두 통과했다. Claude 재현5개도 통과했다.
작업 폴더 안 복사본의 «고쳐지기 전에는 error가 있다»는 출력문 한 곳만 null-safe로
고쳤으며 기대 assertion은 바꾸지 않았다. 원본 보고서/재현 파일은 보존했다.
전체8개에서 owner반납 직후out/sink0·잠금·owner비움, take/release9회모두성공,
30초 짧은출입증 반복수락1을 관측했다. 3000개 원시 입력 재현의 비PhoneError 예외0도
유지됐으나 완전한 입력 공간 증명으로 세지 않는다.

05 §13과 README에 **정지·조종권을 줄이는 명령(stop·조종자release·view)은 속도 제한으로
막지 않는다**는 원칙, 비조종자만 soft 창 적용, 역할 전환 초기화, D11 만료 정의를 적었다.
W3의 handler primary/stopping 중복 검사는 무해한 기존 방어로 기록만 하며 고치지 않았다.
ROS/시뮬/운영 포트 접촉0, safety·원본 셀프테스트 변경0을 유지했다.


r5 최종 실행: 전체769 passed/1 skipped, phone64/64·link80/80·ROS49/49 변이 종료0,
contracts139개 일치·typecheck 종료0이다. Nav2는64/65·종료1이며 기존과 같은
cancel_goal_removed의 assertion11개·StopIteration3개를 r5 JSON으로 확인했다. 기존 분류
한계를 통과로 세지 않는다. 작업 폴더 안 `tmp/phone/r5-*`에 로그/재현 복사본을 남겼다.

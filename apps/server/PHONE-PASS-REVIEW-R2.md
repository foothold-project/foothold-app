# PR #43 2차 검토 반영

- 브랜치 `feature/phone-pass`, 기준 `f30a68e`. 두 검토자의 r2 보고서·재현과 조정 답을 반영했다.
- `safety/**` 판정·상수·셀프테스트 기대값 변경0, 의존성 추가0, 시뮬·ROS·운영 실행0이다.
- 기존 venv·서버 사설 PostgreSQL fixture·가짜 sink만 사용했다. 서버/발급/재현 포트9450~9469, 기존 링크/bridge 시험 helper 범위 유지. 무거운 실행 전 MemAvailable2.5GB 이상을 확인했다.

## 수정과 결정

| 항목 | 반영 |
|---|---|
| L1 | 연결당 ACK FIFO128개가 차면 가장 낮은 미처리 seq 직전의 retry floor를 남기고 커서를 되돌린다. 진행 중 조회가 커서를 덮어써도 다음 조회 주기에 다시 적용한다. 같은 연결에서 불변 묶음을 자동 재전송하며 저장 전 전환은409다 |
| L2·D16 정정 | ACK한 묶음도 에이전트 저널에 남으므로 서버 예약에서 빼지 않는다. 행=미만료 회수 묶음(ack 무관)+미회수 출입증(각 최악1묶음), 상한4096. 바이트=해당 묶음 실제 wire 본문 합+미회수 출입증당4KiB, 상한1MiB다. 정리·예약·회수/재전송은 만료+60초를 유지한다. 새 발급만503이며 회수·잠금·로그아웃·STOP·반납은 막지 않는다 |
| L3 | API §13.7·서버 README·r1 기록의 D16을 실제 행/바이트 계산과 맞췄다. ack는 여유를 비우지 않으며 만료(+60초)로만 비운다. 이 여유는 서명·600초 수명·iat 미래 여유0초·권한 만료를 늘리지 않는다 |
| L4 | 영속 거부 집계에 사용자별 횟수를 더했다. 사건에는 user_id 상위8명과 나머지 합계 other_count를 기록하며 조직당 초당1건 이하·조용한 구간 배출을 유지한다 |
| L5·조정 답 | 저장 제한5초, 초과1013 REVOCATION_ACK_STORAGE_TIMEOUT, 오류1013 REVOCATION_ACK_STORAGE_UNAVAILABLE. 늦은 실제 commit은 억제하지 않는다. 저장 task/callback은 닫힌 peer의 cursor/pending을 건드리지 않는다. 로봇별 진행 중 저장1개를 재접속에도 유지해 멈춘 스레드가 누적되지 않게 한다. 새 연결의 대기도 같은5초 제한이며 동일 seq 재저장은 멱등이다 |
| L6 | 기존10개를 유지하고 포화 복구·sent seq 재전송·view 회수·ACK 중복·저장 실패 닫기·보존 묶음 예약·배경 감사·바이트·60초 경계·timeout 이유의 공식 변이10개를 추가했다. 필수2종을 포함해 실제 assertion 실패로 검출한다 |

## 회귀와 검토자 재현

- 실제 서버 WS에서130개 불변 묶음을 보내고 DB 저장을 막았다.128개 대기 큐가 차면 같은 연결에 마지막 묶음이 재전송된다. 회복 뒤 마지막 묶음2개 jti는 원자 확인되고 전환409→200, 중복 ack에도 최초 acked_at이 유지된다.
- 별도 큐/저장 시험으로 저장 중 중복 제거·오래된 peer 거부, timeout1013, 늦은 commit 전409/후200, 닫힌 peer 상태 불변, 재접속 중 로봇당 실행1개·같은 seq 멱등을 검사한다. 실제 WS 저장 오류1013과 재접속 재전송도 검사한다.
- ACK된1-jti 묶음4097개→다음 발급503, 행4095에서 동시 마지막 슬롯200/503,255개 미회수 출입증의4KiB 예약→256개에서 바이트 포화,until==now/now+59/now+60/now+61 경계를 검사한다.10명의 거부55건은 상위8명52건·나머지3건의 사건1개로 배경 배출된다.
- Codex `test_ack_queue_recovery.py`는 이 worktree를 대상으로 그대로 통과했다.128개만 저장된 순간에도 retry floor128이 남아 조용한 유실이 아니다. 저장소 시험은 실제 같은 연결 재전송까지 확인한다.
- Claude `test_r2_probe.py`6개도 이 worktree에서 통과했다. 느린2.5초 저장/reader 생존·다른 로봇/미전송 ACK 거부·선언 device 변경·저장 오류1013을 유지했다. 기존4095개 **미회수 출입증** 경계는 새1MiB 기준을 이미 넘으므로 동시 응답을503/503으로 바꿨다(행 슬롯200/503은 저장소의 ACK된 묶음4095개 시험으로 별도 확인).4097개 직접 삽입 초과 이력은 실제 에이전트4096행 뒤 저장 실패하지만 서버의 다음 발급은503임을 새 assertion으로 확인했다.

## 실행

아래 python은 `.venv/bin/python`이다. 임시 파일/출력은 worktree의 `tmp/phone-pass-r2`, 발급 변이용 사설 DB는 `tmp/ppg`를 사용했다. 서버/발급/재현에는 `FH_TEST_PORT_RANGE=9450:9469`를 적용했다.

| 명령 | 결과 |
|---|---|
| `python -m pytest apps/server -q` |664 passed, 기존 경고1,658.95초 |
| `python -m pytest apps/agent -q` |812 passed,1 skipped, 기존 경고2 |
| `python apps/server/tools/check_phone_pass_mutations.py` |20/20 KILLED |
| `python apps/agent/tools/check_phone_mutations.py` |79/79 KILLED |
| `python apps/agent/tools/check_link_mutations.py` |80/80 KILLED |
| `python apps/agent/foothold_agent/ros_bridge/check_mutations.py` |49/49 KILLED, ROS 없는 모의 경로 |
| `python apps/contracts/generate.py --check` |144개 일치 |
| `npm --prefix apps/contracts run typecheck` |통과 |
| 두 검토자 r2 재현(위 기대 조정 포함) |7 passed, 기존 경고1 |
| `git diff --check` / safety diff |통과 / 변경0 |


## 바꾼 파일

- `fh_server/phone_pass.py`: 행/바이트 예약·60초 유지·사용자별 거부 집계.
- `fh_server/realtime.py`: retry floor·ACK timeout·진행 중 저장1개·오래된 peer 차단.
- `fh_server/models.py`, `migrations/versions/0013_phone_pass.py`: 영속 거부 사용자별 카운터.
- `tests/test_phone_pass.py`, `tools/check_phone_pass_mutations.py`: 회귀15개 추가·기존 만료 기대 갱신·변이10개 추가.
- `README.md`, `PHONE-PASS-REVIEW-R1.md`, 이 기록: 운영 조건·D16 정정·실제 검증 범위.
- `docs/spec/05-API-SPEC.md`: §13.7 계약·용량 계산/닫힘 이유·변경 이력0.14.

## 미검증·후속

실기 전 관문 정본은 [API §13.6](../../docs/spec/05-API-SPEC.md#136-오류닫기후속-경계)이다. 실제 ROS/DDS(domain93)·시뮬·실폰·실로봇·운영0013·키 배포/회전·NTP·DB 지연/로봇 수×0.1초 조회 부하·망/접속 자원·배포는 실행하지 않았다. 늦은 DB commit을 강제로 취소하는 기능은 없으며, 멈춘 저장이 남은 로봇은 새 연결도5초 뒤 재접속을 요구할 수 있다.

운영 되돌림은 코드 revert·0013 테이블 보존 우선이다. 실제 스키마 되돌림은 발급 중지→최종600초/회수·정지 확인→이력 백업/복구·키 대응 절차를 따른다. 기존 Nav2 변이 분류 오류64/65는 승인된 별도 후속이며 이번4종 결과에 포함하지 않았다. 같은 연결의10분 출입증 갱신·폰/웹·주소 안내·카메라·시뮬 관리자는 후속이다. 두 모델 재검토·dev 통합은 조정 세션의 관문이다.

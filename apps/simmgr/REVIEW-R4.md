# PR #46 4차 검토 반영 기록

기준5f05e3f, 브랜치 feature/sim-manager다. origin/dev는8e70207110b04483c60563122cc04152e3c73b57이며
이미 일반 merge된 커밋이라 추가 merge는 없었다. rebase/force push0이다.
실제 ROS/rclpy/Gazebo·systemd-run unit·native 서비스·실기·설치0, safety/**·ADR09 변경0이다.

## 결정과 회귀

| 지적 | 반영 |
|---|---|
| F1 늦은 POST |관리자 잠금 안에서 슬롯별 DELETE 최대 세대를 메모리에 기록한다. 로봇 부재/중복/낮은 세대 DELETE도 최댓값을 낮추지 않는다. 그 이하 POST는 world/unit/agent 생성 전에409 SIM_GENERATION_STALE. 다음 세대는 수락 |
| 재시작 경계 |세대 정본은 서버 DB다. 제거 확인 세대는 재시작 때 비워진다. POST 자동 재전송 없음(단일 opener 호출, timeout/5xx 각각 호출1회·redirect 거부 회귀). 새 관리자는 잔여 unit·93/DDS 부재 관문을 통과해야 한다. 영속 저장/새 권한 없음 |
| 보상·감사 |POST 성공 뒤 세대/STARTING 불일치면 조직 잠금을 풀고 같은 세대 DELETE1회, START_STALE 감사1건에 결과를 commit. 성공/실패 어느 쪽도 현재 DB owner/hash/출입증을 변경하지 않는다. STALE 코드는 확실한 거부 목록에서 제외 |
| 경합 유지 |DELETE 먼저/POST 먼저, 후속 세대 취득 뒤 보상 성공/실패, STOPPING 위 ACTIVE 덮어쓰기 차단, 확실한 거부 콜백 도중 재취득/STOPPING 경합, 기존 옛 DELETE4경합과 복구·반복403 불변 |
| G1/G2 |ready 전503, 거부 hash 교체, callback 세대/STARTING, listing health·poll 실패/비정상 종료 래치·agent unit 생성 오류 래치를 OS 대역으로 회귀·변이 검사 |
| G3/G4 |startup 요약 한 줄(UTC·sim/agent unit0·93 process0·MemAvailable·load), 비밀/경로 없음. 기존 격리 checker 수정0. 정확한 resource gate만 fake에서 경고하고 실제 launcher에서는 거부. 다른93/DDS/잔여unit/bus 오류 관문은 유지 |
| G5 |05·FIRST-LAUNCH에 휘발성 제거 확인 세대/재시작·POST 재전송 없음·보상 설명, 복구3단계에서 남은 로봇이면1·2단계로 복귀, 목록 숫자 띄어쓰기 보정 |
| G6 |ACK pool3대 시험의2초 기한 그대로. 실패 메시지에 로봇별 revoke 수신·ACK 송신/수신·pool timeout·저장 시작/완료 monotonic 시각만 추가. 운영 ACK 로직 변경0 |

내부 관리자 POST의 기존200은 조정 확인으로 유지했다. 과제의 N+1→201은 서버 중계 기준이며
관리자 단위는 성공200을 단언한다. 새 API 상태 코드를 만들지 않았다.

검토자 두 재현은 저장소의 `test_sim_delayed_start.py`로 옮겼다. Codex 원본은 늦게 생성된
agent token과 가상의 offline Hub를 만드는 전제였으므로, 수정 뒤에는 **late agent 생성0건**과
실제 DB 출입증 회수, 관리자 로봇0·IDLE·재취득201·후속 DELETE204를 단언한다. 임의로 새
Verifier를 만들어 기존 offline600초 계약이 바뀌었다고 주장하지 않는다. Claude 출력형 재현은
동일 결과를 assertion으로 강화했다. 원본/다른 worktree 수정0, 로컬 사본은 tmp/p1c뿐이다.

## 검증

```sh
# 공통 환경은 아래 본문. FH_PYTHON/TS_BIN은 기존 승인된 읽기 전용 실행 파일.
"$FH_PYTHON" -m pytest apps/server -q --tb=short
"$FH_PYTHON" -m pytest apps/agent apps/simmgr/tests -q --tb=short
"$FH_PYTHON" -m pytest apps/server/tests/test_sim_delayed_start.py apps/server/tests/test_sim_recovery.py apps/server/tests/test_sim_generation.py apps/server/tests/test_phone_pass.py::test_three_robot_ack_pool_contention_keeps_links_and_eventually_confirms -q
"$FH_PYTHON" apps/server/tools/check_phone_pass_mutations.py
"$FH_PYTHON" apps/agent/tools/check_phone_mutations.py
"$FH_PYTHON" apps/agent/tools/check_link_mutations.py
"$FH_PYTHON" -m foothold_agent.ros_bridge.check_mutations
"$FH_PYTHON" apps/simmgr/tools/check_mutations.py
"$FH_PYTHON" apps/contracts/generate.py --check
node "$TS_BIN" --strict --noEmit --target ES2020 apps/contracts/ts/index.ts apps/contracts/tests/wire-consumer.ts
```

기본 셸의 ROS_*를 유지했다(ROS_DOMAIN_ID=57). fixture에서만 ROS/RMW/DDS 환경을 제거하며
환경 거부 시험은 값을 명시적으로 넣는다. 기존 읽기 전용 venv/TypeScript, 새 의존성0이다. 실행 전/중 MemAvailable 관측은 약5.6~6.7GiB로2.5GB 기준 이상이었다.
공통 환경은 PYTHONDONTWRITEBYTECODE=1,
PYTHONPATH=$PWD/apps/simmgr/tools:$PWD/apps/agent:$PWD,
TMPDIR=$PWD/tmp/p1c, FH_TEST_PORT_RANGE=9430:9449다.

| 검사 | 결과 |
|---|---|
| manager·server 경합/복구 집중 |105 passed,27.37초 |
| 서버 전체(1회) |734 passed,741.50초 |
| agent+simmgr 전체(1회, 카메라 포함·제외0) |902 passed,1 skipped,38.27초 |
| 두 검토자 재현 사본 |3 passed,3.99초. late 생성0·IDLE·재취득201·후속 DELETE204 |
| 최종 서버 경합·복구·옛 DELETE4경합·ACK 진단 |39 passed,29.16초 |
| 발급·폰·link·bridge 변이 |35/82/80/49 전부 KILLED, 종료0 |
| 최종 새 카메라/관리자/중계 변이 |50/50 KILLED, 모두 assertion·수집/실행 오류0 |
| contracts --check / TS strict |155개 일치 / 종료0 |

집중 검사 최초 실행은101 passed/4 failed였고, 새 START_STALE 감사의 메시지 템플릿 누락
KeyError를 발견해 고친 뒤105건이 통과했다. 최초 실패를 PASS로 세지 않는다.
서버 전체 실행 중/뒤에 추가한 시험 단언(POST 재전송 횟수)·ACK 수신/저장 worker 진단은
마지막 집중39건에서도 확인했다. 이 보강은 시험 코드뿐이며 운영 코드 추가 수정은 없었다.
새 변이는 기존38개에 제거 확인 guard·부재 DELETE 기록·보상 생략·STALE 오분류·ready·
거부 callback 경합/hash·listing health·조회 오류/비정상 종료 래치·unit 시작 래치·POST 최종
STARTING 검사 누락12개를 더했다. 예비49건도 전부 검출됐고 마지막50건 전체로 다시 확인했다.
전체 실행 경고는 기존 TestClient deprecation1건, agent에는 기존 빈 match 경고2건도 있다.
1 skip은 opt-in 실제 DDS 시험이다. 실행 로그/임시 자료/OS 대역 증거는 tmp/p1c이며 공개 커밋에서 제외한다.

실제 startup OS 관문/user bus·unit 수명/고아·메모리/task 최대값·ROS binding·STOP0 ACK·
93 DDS 정리·native 명령 지연·실폰/LAN/WSS·UI는 미검증이다. native1대/fake2대 구분과
[FIRST-LAUNCH](FIRST-LAUNCH.md)의 별도 P1-C2 승인 실행, 두 모델 재검토가 남는다.

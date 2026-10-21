# P1-B 출입증 발급·회수 검증

- 브랜치: `feature/phone-pass`, 지정 기준 `015f89d`(PR #41 병합 뒤 dev).
- PR #41 후속 첫 커밋: `861ada8`. 발급·영속 회수 구현: `cd82168`.
- 범위: 서버 REST/기존 권한·세션·감사, 에이전트 폰/인증 서버 링크, 계약 모델·생성물, API §10/§13.
  `safety/**` 판정·상수·셀프테스트 기대값 변경0. 서버 lease/cmd로 폰 조종권을 덮는 경로 추가0.
- 실행: 기존 venv, 서버의 기존 사설 PostgreSQL 시험 fixture(상주 DB 추가0), 가짜 sink·loopback WS.
  서버 시험에 `FH_TEST_PORT_RANGE=9450:9469`, 임시는 worktree의 `tmp/phone-pass`·`tmp/ppg`.
  기존 에이전트 helper의 승인된 포트 범위는 유지하고 새 WS는9450~9469다. 무거운 실행 전
  MemAvailable2.5GB 이상을 확인했다.

## 결정

1. 기존 `authorize(O_OWN)`/`authorize(ROBOT_READ)` 재사용. 상세 보기 권한과 로봇 요약 열람을
   구분하며 폰 권한을 새로 만들지 않았다. 계정·조직·세션·CSRF는 기존 요청 판정을 따른다.
2. HS256·600초·새 jti와 §13.2 claim을 서버가 생성한다. 서버 DB/감사는 메타데이터만 저장한다.
3. 조정 확인: 로봇 변경은 **명시 switch:true**일 때만 이전 identity의 control을 회수한다.
   첫 요청409 `PASS_SWITCH_PENDING`, 앞 로봇에 발급한 모든 미만료 control의 ack 뒤 재요청부터
   허용한다. switch 없는 다른 로봇 요청은409 `PASS_OTHER_ROBOT`이고 회수하지 않는다.
4. D13은 성공 발급 기준 identity당 이동60초10건·사용자당 미만료 기기4개다. 세션을 바꿔도 유지한다.
5. 조정 확인: 서버 파일은 `{robot:{active:kid,keys:{kid:secret}}}`, active 생략 불가.
   에이전트 `{kid:secret}` 형식 유지. 로봇 간 동일 키 재사용은 거부한다.
6. 계정/담당/로그아웃/명시 전환과 같은 트랜잭션의 outbox를 인증된 로봇 링크로 보내고,
   에이전트는 FULL commit·열린 연결 정리 뒤 ack한다. 재접속 때 ack된 유효 항목도 다시 보낸다.
7. 회수는 출입증 무효화이며 조종권 발급이 아니다. SQLite 회수 행4096/저널 전체1MiB 한도,
   저장/형식 오류는 정지·새 hello 거부, 서버 단절 중 최대600초 한계다.
8. PR #41 거부 집계는 종료 시 한 번 flush하며 **STOP/zero 뒤** 실행한다. 감사 실패에도
   연결 정리를 하고 최초 오류를 보존한다. 발급·앱·DDS 후속 관문을 API §13.6에 보강했다.

## 검증

명령 앞의 `python`은 `.venv/bin/python`, 서버 명령에는 위 TMPDIR/포트 환경 변수를 적용했다.
최종 결과와 PR 번호는 조정 보고 및 PR 본문에 함께 기록한다. 서버/에이전트 최종 전체와
발급·폰·링크·bridge 변이, 계약 생성·typecheck는 종료0이다. Nav2 도구만 아래 기존 오류로 종료1이다.

| 명령 | 결과 |
|---|---|
| `python -m pytest apps/agent -q` | 794 passed,1 skipped, 기존 경고2개 |
| `python -m pytest apps/server -q` | 642 passed, 기존 경고1개 |
| `python -m pytest apps/server/tests/test_phone_pass.py -q` | 29 passed |
| `python -m pytest apps/agent/tests/test_phone_pass.py -q` | 8 passed(최종 전체에 포함) |
| `python apps/server/tools/check_phone_pass_mutations.py` | 3/3 KILLED |
| `python apps/agent/tools/check_phone_mutations.py` | 78/78 KILLED |
| `python apps/agent/tools/check_link_mutations.py` | 80/80 KILLED |
| `python apps/agent/foothold_agent/ros_bridge/check_mutations.py` | 49/49 KILLED, ROS 없는 모의 경로 |
| `python apps/agent/tools/nav2/check_mutations.py --report tmp/phone-pass/nav2-mutations.json` | 64/65 KILLED·종료1, 아래 기존 결함 |
| `python apps/contracts/generate.py --check` | 144개 일치 |
| `npm --prefix apps/contracts run typecheck` | 통과 |
| `git diff --check` | 통과 |

새 시험은 발급 거부(권한·잠금·조직·키 없음), CSRF,600초 claim/메타데이터·비노출,
실제 서버 발급→에이전트 WS hello/control·view 왕복, 명시 전환·모든 ack·기기/속도 한도와
만료 정리, 계정·담당·삭제·로그아웃 회수, 인증된 서버 WS 재전송·ack 저장을 검사한다.
에이전트는 실제 WS 열린 조종 연결의0·잠금·4403/새 hello 거부, jti·사용자·기기 선택자,
재시작 영속·멱등·기한·충돌·용량·저장 실패와 연결 전 cloud facade 거부를 검사한다.

수정 중 첫 서버 전체 실행은636 passed/1 failed였다. 새 왕복 시험의 고정 bind가 기존
OS 할당 FD 정적 검사에 걸렸으며, 기존 `bind(('127.0.0.1',0))`와 포트 제한 환경 변수로
고쳤다. 해당 검사+왕복3개와 최종 전체642개가 모두 통과했다. 첫 발급 변이 실행의
PostgreSQL Unix 소켓 경로 길이 오류는 TMPDIR를 worktree 안의 짧은 `tmp/ppg`로 고쳐
재실행했다. 수집/import/runtime 오류를 변이 KILLED로 세지 않았다. ack 변이는 조건 반전 대신
ack 필터 자체 제거로 작성해, 확인 없는 조기 전환을 시험이 직접 검출하도록 했다.

### 요구된 새 변이6종의 매핑

| 요구 | 도구 / 변이 이름 |
|---|---|
| 1폰1대 검사 제거 | 서버 `check_phone_pass_mutations.py` / `one phone one robot removed` |
| 발급 속도 제한 제거 | 같은 도구 / `issuance rate limit removed` |
| 열린 연결 회수 미적용 | 폰 `check_phone_mutations.py` / `revocation ignores open connections` |
| 회수 재시작 뒤 잊음 | 같은 도구 / `revocation forgotten after restart` |
| ack 없이 바꾸기 허용 | 서버 도구 / `switch allowed without ack` |
| view에 control 허용 | 폰 도구 / `view ticket can acquire authority` |

PR #41 r7의3개 생존 변이는 `denial count is never reset`,
`empty acquisition identity is never pruned`, `denial batch interval is half a second`로
모두 검출한다. `close omits final denial flush`도 추가했다.

## 미검증·기존 결함·후속

- Nav2 `cancel_goal_removed`는 assertion11개와 StopIteration3개가 함께 생겨 엄격 분류상
  ERROR다. baseline172개는 통과했다. PR #41과 같은 기존 결함이며 이 영역 변경0,
  조정이 이번 PR에서도 미해결 후속으로 분리하도록 확인했다. 전체 도구 통과로 세지 않는다.
- ROS/DDS synthetic(domain93 opt-in)·Gazebo/시뮬·실폰·실로봇·운영/미리보기/QA 포트·배포는
  실행하지 않았다. 실제 환경 승인은 [API §13.6](../../docs/spec/05-API-SPEC.md#136-오류닫기후속-경계)의
  실기 전 관문 전체가 남는다. 두 모델 안전 검토와 dev 통합은 조정 세션이 수행한다.
- 같은 연결 안 출입증 갱신은 미구현이다. 조종 중10분 만료 시 정지·잠금·끊김이 발생하며,
  이를 끊지 않고 갱신할 계약은 별도 결정이다. 폰/웹 연결·주소 안내·카메라·시뮬 관리자는 후속이다.
- 키 파일/환경 변수/권한 배포와0013 운영 마이그레이션은 미실행이다. 생성 도구는 시험용
  난수만 생성했고, 추적 파일에는 실제 키·토큰·운영 주소·실명·개인 경로를 추가하지 않았다.

# ADR-003 ④ 웹 시뮬 출입증 두 겹 관문

기준 `origin/dev f894b77` (PR #95 포함), 브랜치 `feature/web-sim-gate`.
서버·에이전트·공유 출입증 계약만 변경했다. `apps/web` 변경은 없다.

## 동작과 호환

- 요청 `surface`는 `phone | pc`, 기본값 `phone`이며 서버는 항상 서명한다.
- 기존 접근 권한 검사 뒤 발급기에서 PC+서버 simulation 미설정을 403
  `WEB_SIM_ONLY`로 막는다(control·view 모두). 총괄 실기의 PR #95
  `ADMIN_NO_REAL_CONTROL` 403은 유지한다.
- 에이전트는 서명 검증 후 PC+로컬 simulation 미설정을 hello 4403
  `WEB_SIM_ONLY`로 막는다. 승인된 연결에서도 조종권·조종 요청마다 다시 확인한다.
  서버가 시뮬이라고 등록한 실제 서명 토큰을 로컬 실기 모드에 넣는 시험도 포함한다.
- STOP·0 명령·조종권 반납·취소는 추가 관문에서 제외한다. PC도 기존 Session과 Core의
  deadman 0.3 s를 사용하며 새 시간 상수·안전 셀프테스트 기대값 변경은 없다.
- 에이전트는 surface 없는 기존 서명 토큰을 phone으로 받아들인다.
  새 claim을 모르는 구 에이전트는 새 토큰을 거부하므로 에이전트를 먼저 갱신한다.
- 직결 `run.*`는 아직 지원하지 않아 실행하지 않는다. ADR-003 ⑤의 직결 실행기
  추가 때에도 공통 PC 요청 관문을 통과해야 한다. 이번 변경은 실행기를 켜지 않는다.

## 재현 환경

기존 시험용 Python venv와 TypeScript 실행 파일을 읽기 전용으로 사용했다.
설치·운영 서버·실기·ROS·Gazebo 접촉은 없다. 시험은 직렬로 실행한다.
임시 PostgreSQL은 전용 임시 폴더와 Unix socket을 사용한다.

```sh
mkdir -p tmp/web-sim-gate/fence tmp/web-sim-gate/temp
python3 - <<'PY'
from pathlib import Path
source = Path('apps/simmgr/tools/sitecustomize.py').read_text()
source = source.replace('(9430, 9449)', '(9580, 9599)').replace('9430:9449', '9580:9599')
Path('tmp/web-sim-gate/fence/sitecustomize.py').write_text(source)
PY
export PYTHONDONTWRITEBYTECODE=1
export PYTHONPATH="$PWD/tmp/web-sim-gate/fence:$PWD/apps/agent:$PWD"
export TMPDIR="$PWD/tmp/web-sim-gate/temp" FH_TEST_PORT_RANGE=9580:9599
# PYTHON은 기존 시험용 venv 실행 파일, TSC는 기존 TypeScript 실행 파일.
"$PYTHON" -m pytest -q -p no:cacheprovider \
  apps/server/tests/test_web_sim_gate.py apps/server/tests/test_phone_pass.py \
  apps/server/tests/test_admin_no_real_control.py apps/agent/tests/test_web_sim_gate.py \
  apps/agent/tests/test_phone.py apps/agent/tests/test_phone_pass.py \
  apps/agent/tests/test_original_core.py
# 전체 시험은 각각 시작 직전 MemAvailable >= 2621440 KiB일 때만 실행.
"$PYTHON" -m pytest -q -p no:cacheprovider apps/server
"$PYTHON" -m pytest -q -p no:cacheprovider apps/agent
"$PYTHON" apps/server/tools/check_web_sim_gate_mutations.py
"$PYTHON" apps/contracts/generate.py --check
node "$TSC" --strict --noEmit --target ES2020 \
  apps/contracts/ts/index.ts apps/contracts/tests/wire-consumer.ts
git diff --check
```

## 결과

- 변경 전 신규 시험: **22 failed, 16 passed**. surface 계약 누락·PC admission 거부
  코드 부재를 실제 실패로 확인했다(수집·환경 오류 없음).
- 최초 구현 후 같은 신규 시험: **38 passed**.
- 실제 토큰·WebSocket 왕복, PR #95, 기존 폰·안전 Core를 포함한 집중 시험:
  **224 passed**, 135.66초, 기존 FastAPI/Starlette 경고1개.
- 계약 생성물 **168개 일치**, TypeScript 검사 종료0.
- 검증한 실행 코드 커밋은 `f679fec704f8f2eca1ff2dd21ed2f5aeb8f227c2`다.
  이후 결과 기록만 추가했으며 실행 코드는 동일하다.
- 서버 전체 **1회: 932 passed**, 1141.52초, 기존 FastAPI/Starlette 경고1개.
  시작 전 MemAvailable **3083804 KiB**로 2.5 GiB 관문을 통과했다.
- 에이전트 전체는 **미실행**이다. 서버 종료 뒤 **2367660 KiB**, 변이 완료 뒤
  **2204708 KiB**로 모두 2621440 KiB 조건에 못 미쳤다. 에이전트 집중 **118개**는
  위 224개 안에서 통과했다. 가용 메모리 회복 뒤 에이전트 전체1회는 남아 있다.
- 관련 변이 **2/2 KILLED**, 정상 기준 **14 passed**. 서버 발급 관문 제거와
  에이전트 hello 관문 제거 각각 단언 실패2개, 수집·준비·종료·실행 오류0이다.
- `git diff --check` 통과. 웹·기존 Core/Session·안전 셀프테스트 파일 diff0이다.

## 검토·미검증·되돌림

Claude·Codex 두 모델 검토와 조정의 수용 확인은 draft PR 이후 관문이다.
실폰·실로봇·브라우저 키보드·실제 네트워크/물리 정지 시간은 미검증이다.
0.3 s 뒤0 및 0.4 s 이내 기준은 단조 가짜 시계와 모의 출력으로 확인한다.
앱/에이전트 배포·서버 재시작은 실행하지 않았다. DB 마이그레이션은 없다.
되돌림은 이 기능 커밋을 revert하고 에이전트·서버 호환을 함께 확인한다.

## PR #97 검토 반영

Codex P1의 연결 뒤 PC 관문 거부 시 잔류 출력을 수정했다. 로컬 simulation이
꺼진 PC 연결은 기존 반납 경로를 통해 Session lease·Core controller·Hub owner와
예약·진행 중 요청을 정리하며, STOP·0 출력·잠금을 즉시 적용한다. 유효한 0 명령은
기존 lease·sequence 검사를 통과해 적용한 뒤 반납하고 `cmd.ack`을 반환한다.
STOP·반납·취소·view·ping도 관문 거부 없이 정리한다. 새 시간 상수와 기존
Core/Session·안전 셀프테스트 기대값 변경은 없다.

- 강화한 에이전트 시험: 수정 전 **8 failed / 18 passed**, 수정 후 **26 passed**.
  PC hello → take → unlock → 중립 → vx=.6 → simulation=False → 0 cmd 순서에서
  별도 STOP·tick·시간 경과 없이 sink 마지막 출력0·owner/lease/controller 해제를 단언한다.
  기존 재판정 시험4개에서도 별도 STOP을 제거하고 움직이던 owner의 즉시 정리를 확인한다.
- 집중 시험: 기존 224개 묶음 + 안전 요청6개 + 총괄 우선순위1개 = **231 passed**,
  116.64초, 기존 FastAPI/Starlette 경고1개. 총괄+pc+실기 요청은
  `WEB_SIM_ONLY`보다 `ADMIN_NO_REAL_CONTROL`이 먼저임을 확인했다.
- 관련 변이 **2/2 KILLED**. 메모리 안에서 거부 직전 반납 또는 0 명령 뒤 반납만
  각각 제거하고 강화한 시험10개를 실행했다. 정상 기준10개 통과, 각 변이에서
  단언 실패7개/1개, 수집·준비·종료·실행 오류0이다. 저장소 코드는 변이하지 않았다.
- 에이전트 전체: **미실행(메모리)**. 20분간 1분 간격으로 21회 확인했으며 MemAvailable 2279272–2567888 KiB, 마지막 2319852 KiB로 모두 2621440 KiB 미만입니다.
- 이번 수정에서 서버 전체는 재실행하지 않았다. 앞 절의 932개 통과는 최초 구현 당시
  기록이며 이번 결과로 대신하지 않는다. 집중 시험은 짧은 임시 TMPDIR의 격리 DB와
  **9580:9599** socket fence로 실행했고 기존 시험용 venv는 읽기만 했다.

남은 한계: `surface`는 클라이언트의 자기 신고다. HMAC 서명은 발급 뒤 claims
바꿔치기를 막지만 최초 신고가 실제 단말 종류인지 입증하지 못한다. PC도
`surface=phone` 또는 생략으로 운영자 실기 출입증을 받을 수 있으며, 실기는 기존
운영자 권한·담당 판정이 막는 범위다. 이를 단말 종류의 독립 인증으로 해석하지 않는다.

배포 순서: 에이전트를 먼저 갱신하고 서버를 갱신한다. 구 에이전트는 새 surface
claim이 들어간 폰 출입증도 거부한다. #98의 웹 타입 중복 표기는 #98 담당 범위로 남긴다.
Claude·Codex의 최초 검토 뒤 막는 지적 수정 단계이며 재검토 없이 작성자 시험과
조정 수용 확인을 거친다. merge·운영 배포·실폰·실기·ROS·Gazebo 검증은 수행하지 않았다.

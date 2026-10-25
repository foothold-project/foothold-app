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
- STOP·조종권 반납·취소는 추가 관문에서 제외한다. PC도 기존 Session과 Core의
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
- 전체 시험과 관련 변이는 진행 중이며 완료 뒤 이 기록을 갱신한다.

## 검토·미검증·되돌림

Claude·Codex 두 모델 검토와 조정의 수용 확인은 draft PR 이후 관문이다.
실폰·실로봇·브라우저 키보드·실제 네트워크/물리 정지 시간은 미검증이다.
0.3 s 뒤0 및 0.4 s 이내 기준은 단조 가짜 시계와 모의 출력으로 확인한다.
앱/에이전트 배포·서버 재시작은 실행하지 않았다. DB 마이그레이션은 없다.
되돌림은 이 기능 커밋을 revert하고 에이전트·서버 호환을 함께 확인한다.

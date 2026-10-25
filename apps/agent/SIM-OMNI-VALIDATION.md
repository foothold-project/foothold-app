# 시뮬 시험용 후진·옆걸음·제자리 회전

기준 `origin/dev cc37e33d120c599ba204b7064929b1aa07d60774`,
브랜치 `feature/sim-omni-agent`. 2026-10-25 제품 결정의 **시뮬 폰 명령만** 구현했다.
이 기록은 코드·모의 출력 검증이며 보행·물리 정지 검증이 아니다.

## 바꾼 규칙

- vx: 후진 [−0.3, −0.05], 전진 [0.2, 1.0] m/s와 별도0.
- vy: [−0.3, −0.05] 또는 [0.05, 0.3] m/s와 별도0.
- wz: 제자리를 포함해 입력 |wz|≥0.5일 때 부호에 따른 고정±0.5 rad/s, 그 미만0.
- 축별 데드존은0, 상·하한 밖은 끝값으로 자르고 `clipped=true`다.
  앞/뒤·옆·회전 조합을 허용하며 놓으면 즉시0이다.
- `SIMULATION_LIMITS`는 vx_min=−0.3, vx_max=1.0, vy_min=−0.3, vy_max=0.3,
  wz_min=−0.5, wz_max=0.5와
  `experimental=['reverse','lateral','turn_in_place']`를 알린다.
  Pydantic·JSON Schema·TS에서 experimental은 선택 필드이며 생략하면 빈 목록이다.
- 잘려서0인 비중립 입력은 이유가 있는 데드존 축으로 전달해 새 중립을 만들지 않는다.

실기는 후진·옆·제자리 회전 금지, 기존 전진0.6의4개 명령이다.
`protocol.py`의 실기 `project_velocity` 분기부터 `LIMITS`까지 기준 원문과 바이트 단위
동일함을 확인했다. Core·Session·Hub·ROS bridge·기존 안전 셀프테스트는 diff0이다.
시뮬에만 이미 존재하던 projection 주입을 사용하므로 하위 안전 경로 수정은 필요 없었다.
STOP/zero·deadman·잠금·출입증·세대·재연결·watchdog·stall 규칙은 그대로다.

## 실행과 결과

Python은 지정된 기존 preview 작업 폴더의 server venv를 **읽기 전용**으로 사용했다.
패키지 설치0, `PYTHONDONTWRITEBYTECODE=1`, pytest cache 비활성화,
TMPDIR은 현재 worktree `tmp/sim-omni/temp`다.
`apps/simmgr/VALIDATION.md`의 PYTHONPATH 구성과 socket fence를 따르되
fence 사본의 고정 허용 범위를 **9470:9489**로 바꿔 현재 worktree 안에 뒀다.
발신 loopback 클라이언트의 OS 할당 ephemeral 규칙은 기존 fence와 같다.
각 무거운 명령은 `if MemAvailable >= 2621440 KiB` 안에서만 실행했다.

공통 환경(아래 PYTHON은 지정된 읽기 전용 venv 실행 파일):

```sh
mkdir -p tmp/sim-omni/fence tmp/sim-omni/temp
python3 - <<'PY'
from pathlib import Path
source = Path('apps/simmgr/tools/sitecustomize.py').read_text()
source = source.replace('(9430, 9449)', '(9470, 9489)').replace('9430:9449', '9470:9489')
Path('tmp/sim-omni/fence/sitecustomize.py').write_text(source)
PY
export PYTHONDONTWRITEBYTECODE=1
export PYTHONPATH="$PWD/tmp/sim-omni/fence:$PWD/apps/agent:$PWD"
export TMPDIR="$PWD/tmp/sim-omni/temp" FH_TEST_PORT_RANGE=9470:9489
# 아래 각 명령을 같은 메모리 관문으로 감싼다.
if [ "$(awk '/MemAvailable/ {print $2}' /proc/meminfo)" -ge 2621440 ]; then
  "$PYTHON" -m pytest apps/agent -q -p no:cacheprovider
fi
```

| 실제 검사 | 결과 |
|---|---|
| 집중 pytest: `test_phone_omni.py`, `test_phone_continuous.py`, `test_phone_drive_modes.py`, `test_original_core.py` | **424 passed**, 1.20초 |
| `python -m pytest apps/agent -q -p no:cacheprovider` 전체1회 | **1333 passed, 1 skipped**, 54.98초, 기존 경고2개 |
| `python apps/agent/tools/check_sim_omni_mutations.py` | 정상 기준31개 통과, **2/2 KILLED**, 실행 오류0 |
| `python apps/contracts/generate.py --check` | 생성물 **168개 일치** |
| 기존 TypeScript 실행 파일로 `--strict --noEmit --target ES2020 apps/contracts/ts/index.ts apps/contracts/tests/wire-consumer.ts` | 종료0 |
| `git diff --check` 및 실기 분기/원본 안전 코드 원문 비교 | 통과, 변경0 |

새 시험은 0.05·0.2·0.3·0.5·1.0의 정확한 경계와 인접 부동소수점 값, 양방향 옆걸음,
제자리 양회전, 후진+옆+회전, STOP/해제·새 중립·deadman을 확인한다.
실제 Hub→Session/Core→RosSink→Twist의 음수 vx/vy·제자리 wz 전달과 STOP 뒤0을
가짜 시계·가짜 publisher에서 확인했다. ROS/DDS는 만들지 않았다.

변이는 원본 파일을 고치지 않고 자식 프로세스 메모리에서만 주입한다.
시뮬 투영의 flag 검사를 제거하면 assertion10개, 실기 Hub에 시뮬 Core를 선택하면
assertion7개가 실패한다. 구조화된 pytest 보고서로 assertion만 검출로 세며
수집·실행·setup/teardown 오류는0이다.

최초 집중 시험은 동작424개 통과 후 새 ROS-free 시험7개의 teardown에서 닫힌 sink를
다시 사용해 오류가 났다. 시험의 원래 가짜 sink를 복원하도록 정리 순서만 고쳤으며,
수정 뒤 집중424개와 전체 시험이 위와 같이 통과했다. 제품 오류로 숨기거나 PASS로 세지 않았다.

## 남은 검증

skip1개는 실제 DDS opt-in synthetic 시험이다. ROS·Gazebo 기동, 실주행·실폰·실기 Go2,
미리보기 재시작·운영 포트·domain61/93 접촉, 배포·merge는 이번 작업0이다.
시뮬 제자리 회전 낙상과 약한 후진 응답의 기존 측정 때문에 **시험용이며 넘어질 수 있음**을
명세에 유지했다. 옆걸음과 모든 조합의 안정성은 미검증이며 명령 전달 성공으로 대신하지 않는다.
화면은 별도 작업자가 담당하고 `apps/web` 변경0이다.
Claude·Codex 두 모델의 안전 검토와 합친 뒤 별도 시뮬 주행 배정은 조정 세션에 남는다.
되돌림은 이 기능 커밋을 revert하고 기존 배포 절차로 반영하며 Git 이력을 강제로 바꾸지 않는다.

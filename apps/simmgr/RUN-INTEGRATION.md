# Nav2 자식과 시나리오 실행 자료 연결

기준 `origin/dev d011450`, 구현 범위 `apps/simmgr/**`. 실제 ROS·Gazebo·Nav2 기동과
domain 61/93 참가, 미리보기 교체, 원본 sim 변경은 수행하지 않았다.

## 수명과 격리

world 시작 전 기존 domain93/DDS/user-unit 부재 검사를 유지하고 Nav2 unit 잔여도 거부한다.
그 뒤 MemAvailable ≥ 3000 MiB·load1 ≤ 7을 60초 동안 1초 간격으로 확인한다.
한 표본이라도 벗어나면 이번 시도를 거부한다. 원래 native supervisor의 기동 직전 관문도 유지한다.
이 관문은 실제 기동 시 적용되며 이번 시험에서는 합성 시계·표본으로 검사했다.

world의 live identity 준비 뒤 `add`에서 Nav2 → agent 순서로 기동한다. 두 자식은
검증된 같은 `fh-srv-<nonce>` GZ partition과 domain93·LOCALHOST·GZ_IP loopback 환경을 받는다.
Nav2는 episode별 `fh-simmgr-nav2-<episode>.service`를 소유하며 MemoryMax=768M,
CPUQuota=150%, MemorySwapMax=0, KillMode=control-group과 유한 RuntimeMaxSec을 사용한다.
실사용 RAM·CPU는 미측정이며 `nav2-unit.json`에도 null로 기록한다.

기존 agent의 Nav2 launch description·params·straight BT를 재사용한다. 추가 AMCL/map_server/TF는
없고 지도는 기존 `/v2_map/map`, 속도 출력은 기존 `/fh_nav/intent`를 사용한다.
어느 Nav2 노드라도 종료하면 launch 전체에 Shutdown을 요청한다. 관리자 watcher는 HTTP 요청과
독립적으로 agent/Nav2/world 종료를 관찰하고, 기존 agent STOP/zero 정리 → Nav2 cgroup 정리 →
native 정리 증명 순서로 나머지를 정리한다. 실패 agent는 Nav2를 먼저 정리한 뒤 기존의
실패 invocation·native 증명 경로를 따른다. 기동 중 실패에도 같은 정리를 시도한다.

Nav2 정리는 저장한 InvocationID와 현재 unit이 일치할 때만 exact unit을 stop하고, 원래
cgroup의 비점유와 unit 종료를 확인한다. 패턴 kill은 사용하지 않는다. 정리 실패는
`SIM_CLEANUP_NAV2_UNPROVEN`과 실패 latch로 남기고 world/소유를 해제하지 않는다.
watcher의 실패도 로그에 남긴다. 자동 정리가 증명된 장애도 owner의 명시적 DELETE 전에는
실패 상태를 유지한다. episode별 watcher는 다음 episode를 감시하지 않는다.

## agent 환경

| 환경변수 | 구성 |
|---|---|
| `FOOTHOLD_RUN_OUTBOX_PATH` | `SIM_RUN_DIR/outbox/<robot UUID>.sqlite3`, 디렉터리 0700·파일 0600. timestamp episode 밖의 고정 경로이며 세대·관리자 재시작·episode 삭제로 바꾸거나 지우지 않는다. symlink/공개 권한 파일은 거부한다. |
| `FOOTHOLD_SCENARIO_DATA_ORIGIN` | 명시한 설정 또는 agent WS URL에서 유도한 HTTP(S) origin. path·query·fragment·userinfo를 허용하지 않는다. |
| `FH_RUN_ARRIVAL_POSE_MAX_AGE_S` | 명시한 양의 유한값만 전달한다. 생략하면 agent 기본값 1.0을 따른다. |
| `FOOTHOLD_RUN_MAP_ASSETS_JSON` | `[{map_version_id,image_path,pgm_path}]`. 등록된 선택 world 자료에서 episode 로컬 PNG/PGM/YAML 사본을 만든다. |
| `FOOTHOLD_FLOOR_BINDINGS` | 기존 실제 native run nonce·generation·층 binding 전달을 유지한다. |

창고 f1 PNG를 grayscale 그대로 P5로 구성한다. 300×440·해상도 0.05·원점
[-7.5,-11,0]과 top-down raster, unknown=205/free=254/occupied=0을 보존한다.
이미지 SHA·source PGM SHA·치수·원점·해상도를 등록 binding과 대조하며, 실험 v5의 고정
SHA/800×640 조건을 적용하지 않는다. 기존 서버 bounded map codec을 재사용하므로
관리자 venv에 Pillow/YAML 같은 새 패키지를 설치하지 않는다. 실제 지도 사본은 커밋하지 않는다.

## 오프라인 검증

초기 작성본(r1 이전):

- 집중 `test_nav2_lifecycle.py`: **29 passed**. unit 상한·격리·invocation 교체 거부·남은 cgroup
  거부·bootstrap, 60초 관문과 마지막 표본 하락, origin 거부, 환경 전달, SQLite 재시작/삭제 보존,
  창고 raster/좌표/SHA, 세 자식 종료와 기동 실패 정리, 정리 실패 latch를 확인했다.
- simmgr 전체 `apps/simmgr/tests`: **283 passed** (18.66초), 기존 경고 1개.
- 지도 도구 전체 `apps/simmgr/tools/tests`: **22 passed** (1.54초).
- 전체 실행 전 MemAvailable ≥ 2621440 kB를 `if`로 검사했다. 검사 준비 중 읽은
  표본은 5384716 kB였으며 기동 자원 측정으로 간주하지 않는다.
- 초기 전체 수집은 승인된 venv의 numpy 누락으로 중단됐다. 설치 없이 기존 시스템
  dist-packages를 sys.path 끝에 추가한 뒤 전체 시험을 1회 실행했다.
- 시험 DB의 임시 포트 할당은 `FH_TEST_PORT_RANGE=9600:9609`; 실제 ROS 참가·서비스 unit 생성 0.

PR #108 r1:

- R1: `systemd-run`의 `CalledProcessError`와 `LoadState=not-found`/빈 InvocationID가
  함께 확인된 경우만 Nav2 미생성으로 처리한다. `_stop_nav2`가 핸들을 비우고 world 정리를
  진행한다. timeout처럼 생성 여부가 모호하면 정리 거부와 소유·실패 latch를 유지한다.
- R4: agent/Nav2 readiness 상태 조회의 `RuntimeError`도 `_cleanup_failed_start`를
  호출한다. 상태 확인 실패의 기존 latch는 해제하지 않는다.
- R2: HTTP scenario origin은 agent와 동일하게 `127.0.0.1`/`::1`만 허용하며
  명시 origin과 WS에서 유도한 origin 모두 Settings 검증 시 거부한다. HTTPS는 유지한다.
- 회귀 11개 추가: 미생성 거부/timeout 2개, agent/Nav2 조회 실패 2개,
  HTTP host 거부 및 loopback/HTTPS 허용 7개. 집중 **40 passed** (3.53초),
  simmgr 전체 **294 passed** (19.59초, 전체 1회), 기존 경고 1개.
- 전체 실행 직전 MemAvailable **5596772 kB**, `if` 관문 ≥2621440 kB 확인.
  기존 읽기 전용 venv와 시스템 dist-packages를 사용했고 설치·sudo는 하지 않았다.
  포트는 `FH_TEST_PORT_RANGE=9600:9609`, 실제 ROS/Gazebo/Nav2 기동·ROS 참가 0.
- 초기 집중 시험에서 새 mock이 preflight의 unit 목록 조회까지 가로채 2개가 실패했다.
  목록 조회를 기존 mock에 위임하도록 고친 뒤 위 결과를 확인했다. 지도 도구는 변경하지
  않아 r1에서 재실행하지 않았다.

재현 명령(`FH_PYTHON`은 승인된 기존 read-only venv Python):

```sh
if [ "$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)" -ge 2621440 ]; then
  PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=apps/agent:. FH_TEST_PORT_RANGE=9600:9609 \
    "$FH_PYTHON" -c 'import sys; sys.path.append("/usr/lib/python3/dist-packages"); import pytest; raise SystemExit(pytest.main(["apps/simmgr/tests", "-q", "-p", "no:cacheprovider"]))'
fi
if [ "$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)" -ge 2621440 ]; then
  PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=. FH_TEST_PORT_RANGE=9600:9609 \
    /usr/bin/python3 -m pytest apps/simmgr/tools/tests -q -p no:cacheprovider
fi
```

## 미검증과 남은 권고

실제 systemd/ROS/Gazebo/Nav2 기동·플러그인 로딩·lifecycle/action readiness·주행·취소·도착·
실사용 RAM/CPU·swap-in/RTF/원수신 지연은 미검증이다. 이는 예산 상한이나 mock 통과로
대체하지 않는다. 기존 straight BT/제한된 intent alphabet을 재사용하므로 창고의 회전·왕복
순찰 완주를 주장하지 않는다. agent 쪽 다중 목표/도착 포트 변경과 통합해 별도 승인된 후보에서
검증해야 한다. 미리보기 runs 스크립트의 설정/경로 연결은 이번 소유 범위 밖이며 별도 통합 대상이다.

남은 권고: 실제 측정 후 자원 여유와 종료 grace(기존 설정+90초)에 Nav2 정리까지 포함한
최악 시간을 확인하고, 별도 runner가 필요하면 추가 예산을 검토한다. agent CPU 상한은
기존처럼 설정되지 않았다. 다른 모델 검토·dev 통합과 실기동 승인은 조정 세션에서 수행한다.
되돌림은 이 기능 커밋을 revert하며, 보존된 outbox DB는 삭제하지 않는다.

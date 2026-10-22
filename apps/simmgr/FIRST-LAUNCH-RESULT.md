# 첫 Gazebo 기동 결과 — P1-C2 (2026-10-22)

**판정: 기동·정리 통과, 측정 절차 실패, 성능·폰 조종 수용 기준 미확인.**
기준은 `origin/dev`의 `80b1bd8636b37d658fa7a2bc7b78f45a4feee01e`(PR #46 통합)이다.
제품 책임자의 첫 domain93 기동 승인 아래 같은 PC 시험 driver만 사용했다.
실폰·UI·실기 검증이나 배포 완료를 뜻하지 않는다.

| 항목 | c2-001 | c2-002 (조정 승인 재실행 1회) |
|---|---|---|
| 새 격리 DB·마이그레이션 | 통과, `0014` | 통과, `0014` |
| 생성 센서 자산·provenance | 통과, manifest·입력 모델·기준 원본 SHA 일치 | 동일 |
| 시작 전 domain93·DDS·대상 TCP 포트 | 모두 0 | 모두 0 |
| 서버 → 관리자 → POST | 201 RUNNING, 7.215초 | 201 RUNNING, 6.028초 |
| observer → 측정 순서 | **실패**: observer 생성 실패 뒤 driver가 실행됨 | **실패**: observer setup 종료, 준비 관문이 driver 차단 |
| 유효 성능 표본 | 없음: 순서 위반 표본 폐기 | 없음: 조종 명령 0 |
| 정상 DELETE | 204 | 204 |
| native 종료 manifest·원본 SHA·보호 도메인 PID/start_ticks·원장 | 통과 | 통과 |
| 자기 sim/agent unit·cgroup·domain93·DDS 잔여 | 모두 0 | 모두 0 |
| 시험 서버·관리자·격리 PostgreSQL 종료 | 통과 | 통과 |

`runs/simmgr/c2-001/`, `runs/simmgr/c2-002/`는 Git 제외된 private 증거 폴더다.
폴더 권한은 0700, catalogue·서비스 secret·서버/agent key ring·환경/세션 파일은 0600이다.
슬롯 키는 서버와 agent에 같은 값으로 사전 배포했다. DB는 새 클러스터의 전용 Unix socket만
사용했고 운영·미리보기 DB에는 연결하지 않았다. 새 native 출력 폴더만 source 프로젝트의
sensor-spec 아래 만들었으며 원본 파일 수정·설치·센서 자산 생성은 없었다.

`c2-002/db-final.json`은 `simulation=true`, `sim_generation=1`, `sim_state=IDLE`,
owner 해제와 REQUESTED/REGISTERED/REMOVED 감사 각 1건을 확인했다.
두 episode의 unit은 마지막 조회에서 `LoadState=not-found`, `MainPID=0`, 빈 cgroup이었다.
마지막 `ss` 조회에서 시험 대상 9430·9431·9433·9440의 TCP listener도 0이었다.

| 자원 실측 | c2-001 | c2-002 |
|---|---:|---:|
| 서버 시작 전 MemAvailable (MiB) | 3512.44 | 3446.40 |
| POST 직전 별도 검사 (MiB) | 미확인 | 3298.22 |
| native preflight MemAvailable (MiB) | 3398.15 | 3290.16 |
| 실행 중 MemAvailable 최저 (1초 표본, MiB) | 1902.57 | 2192.67 |
| 실행 중 load1 최고 (1초 표본) | 9.45 | 5.38 |
| sim unit MemoryPeak (MiB) | 855.68 | 705.70 |
| agent unit MemoryPeak (MiB) | 62.21 | 46.98 |
| agent task 최대 관측값 | 17 | 17 |
| sim task 최대 관측값 | 102 | 102 |
| RuntimeMaxSec (sim / agent) | 240 / 240 | 240 / 240 |

조정 여유값 3500MiB는 첫 POST 직전 미재확인, 정식 관문 통과: 조정자는 해당 실행의
native preflight 3398MiB를 FIRST-LAUNCH의 2500MiB 기준으로 수용하고 측정 계속을 지시했다.
재실행은 조정 지시대로 POST 직전 2500MiB·load1≤9를 재확인했다. 실행 후의 load 최고값은
기동 전 부하 관문과 별개다. 기존 watcher의 MemAvailable<1500MiB·swap-in 중단 기준과
sim/agent의 RuntimeMaxSec=240·종료 grace는 바꾸지 않았다.
메모리는 systemd MemoryPeak이고 task는 각 unit의 단회 스냅샷이다. 따라서 task의 전체
시간 최대값은 **미확인**이며, 관측값을 실제 전체 최대값으로 간주하지 않는다.

폰 조종 세션 길이 권고: 현재는 **준비·정리를 포함해 4분 이내의 시험 세션**을 유지하며, agent 최대 메모리 62.21MiB·task 관측 최대 17개만으로 세션 연장이나 상한 축소를 권고하지 않는다.

| 측정 수용 기준 | 판정 | 근거·남은 범위 |
|---|---|---|
| 명령 200개·50ms 간격·publisher 반환 p95≤100ms | 미확인 | c2-001의 observer 없는 표본은 폐기, c2-002 driver 차단 |
| 입력 끊김→첫 agent ROS0≤0.4초, 20회 | 미확인 | 완결된 유효 측정 없음 |
| control/view STOP·목표취소·잠금·명시 재개 | 미확인 | DELETE의 정상 agent 종료 확인을 이 항목의 통과로 대신하지 않음 |
| 출입증 실제 발급·회수 ACK·전환·만료·중복·다른 robot/org·단절·동시취득 | 미확인 | c2-001 실제 control 출입증 발급 후 일부 조종은 있었으나 행렬 검증 미완료 |
| 영상 fps·JPEG 크기·424×240·NO_VIDEO·부모 종료 | 미확인 | native manifest 카메라 frame 수 351/313은 폰 수신 fps·규격·연결 종료 증명이 아님 |
| 안 읽는 영상·원천 폭주 중 지연/입력 끊김 반복 | 미확인 | 실행 완료되지 않음, 원천 폭주 driver는 미구현 |
| 20ms STOP 왕복 60회·TCP_NODELAY=1 | 미확인 | 실행되지 않음 |
| 초기 STOP true·cmd_applied0·episode·LOCKSTEP·시각 증가 | 미확인 | observer 기반 초기 관문 미완료; manifest `online_ready=false`, `safe_fallback_verified=false` |
| 관리자 비정상 종료·240초 내 agent 종료 | 미확인 | 지시대로 생략 |
| native 격리·정상 정리 | **통과** | 두 cleanup의 source/도메인 PID/원장 불변, native manifest 일치·cleanup complete, 잔여 0 |

오류와 다음 작업:

- c2-001: `ValueError: control plane must not inherit ROS/DDS environment`.
  observer용 환경을 만드는 제어 코드가 부모 ROS 환경을 검사하며 종료했다. 복합 셸이 실패 뒤
  driver를 실행한 순서 오류가 있어 자기 driver를 SIGINT하고 정상 DELETE했다. 그 뒤 도구를
  단일 의존 실행 흐름으로 바꿨고, observer용 환경은 허용 목록에서만 만들도록 했다.
- c2-002: `setup.bash: line 8: AMENT_TRACE_SETUP_FILES: unbound variable`.
  `set -euo pipefail`의 nounset 상태에서 기존 ROS setup이 선택 환경 변수를 읽은 것이 원인이다.
  observer 준비 관문이 제대로 driver를 차단했다. **추가 재시도하지 않았다.**
  다음 수정 제안은 ROS setup을 source하는 구간에만 nounset을 잠시 해제하고, source 성공 뒤
  다시 켜는 것이다. 수정 후 observer만의 준비·정상 종료·DDS 해제 확인을 먼저 검증해야 한다.

`tools/first_launch.py`는 준비·기동·observer/driver 순서·정상 DELETE용 시험 driver이며,
`tools/first_launch_instrument.py`는 시험 프로세스에서만 agent bootstrap을 바꿔 publisher
반환 시각과 가장 최근 승인 cmd seq를 기록한다. runtime 파일·명령/STOP 판정·unit 상한은
수정하지 않았다. `tools/first_launch_measure.py`의 전체 경로는 **미검증**이며,
현재 observer bootstrap의 위 오류를 고치기 전에는 재실행하면 안 된다.
`tools/first_launch_observer.py`는 기존 읽기 전용 domain93 observer를 재사용한다.
시험 도구 폴더는 서비스 runtime PYTHONPATH에 넣지 않았다.

검사: 기존 승인된 Python으로 `python -m pytest apps/simmgr/tests -q --tb=short` **69 passed**,
신규 네 도구의 AST 구문 검사 통과, `git diff --check` 통과.
실기·실폰·브라우저·전체 서버/agent 회귀 시험은 이번 변경에서 실행하지 않았다.

| world 후보 | 이름·설명 | native world/GT 지도 실파일 짝 | 이번 catalogue/기동 |
|---|---|---|---|
| `v5_single/f1` | 단층 시험장 · 상부 기하를 줄인 첫 격리 대상 | 있음 | 포함, 기동·정리 통과 |
| `v5_building/l1` | 건물 1층 · 층간 이동은 별도 검증 | 있음 | 미포함·미확인 |
| `v5_building/l2` | 건물 2층 · 높은 층 시작점 | 있음 | 미포함·미확인 |
| `rooms_a/f1` | 방·복도 단층 · 사전 GT 지도 없음 | **없음** (`gt_map=null`) | 후보 제외 |

추가 world는 조정 지시로 후속 작업으로 분리했다. 선택해도 기동할 수 없는 world를 공개
catalogue에 넣지 않았다. 차단 지점은 `apps/simmgr/launcher.py:97`의 첫 world 허용 검사,
`apps/agent/tools/sim/constants.py:4`의 고정 WORLD_ID/FLOOR_ID,
읽기 전용 source의 `sensor-runtime-r1/sensor_isolation.py:12` TARGET 및 같은 파일 31줄의 `arg_errors()` 비교다.
지도·점군·사진·영상 원본은 커밋하지 않았다.

되돌림은 이 시험 도구·결과 문서 커밋의 Git revert로 충분하다. 두 실행은 이미 정상 종료했고,
격리 DB/증거는 private 폴더에 보존했다. 운영 DB migration·서버 교체·웹/APK 배포는 없었다.

# Agent에서 만드는 5 cm 내장 SLAM 지도

서버 계약은 [PR #476](https://github.com/foothold-project/foothold-app/pull/476)의 `apps/server/USLAM-CONTRACT.md`를 따른다. 이 변경은 `apps/agent`만 소유하며 서버·웹·계약·정책 실행기 소스를 바꾸지 않는다. 실제 로봇이나 DDS에 연결한 기록은 없다.

## 입력과 계산

- 지도 점은 `rt/uslam/frontend/cloud_world_ds`, 위치는 `rt/uslam/frontend/odom`만 받는다. world 점을 pose로 다시 회전하거나 이동시키지 않는다. `FH_USLAM_FRAME` 기본값은 `map`, `FH_USLAM_CHILD_FRAME` 기본값은 `base_link`이며 실제 표본과 일치하는 값을 명시해야 한다. 잘못된 frame, stamp, 좌표·방향, 250 ms를 넘는 점/pose 차이, 500 ms를 넘는 수신 자료는 거절한다. sport/robot_odom 대체는 없다.
- `WorldAccumulator`는 기존 `Accumulator`의 세션·PCD 저장 구조를 재사용한다. 칸은 `floor(XYZ / .05)`, 중심은 `(index + .5) * .05`다. 음수 칸도 같은 규칙이다. 실시간 입력은 최대 8,000점으로 고르게 솎고, 해석 예산 15 ms와 계산 예산 30 ms를 둔다. 예산은 작은 묶음마다 확인하므로 운영체제 스케줄링을 포함한 실시간 보장은 아니다.
- 2D는 처음 위치를 가운데로 하는 2,000×2,000칸(100 m 사방), 5 cm, 행 우선·아래에서 위로 쌓는다. `FH_USLAM_INPUT` 기본값 `projection`은 장애물만 투영하고 나머지는 모름이다. `scan`은 현 scan과 센서 원점이 확인된 입력에서만 선택한다. 이때 웹 `occgrid.ts`와 같은 바닥 -0.3 m, 장애물 +0.15 m, 천장 +1 m, 10 m 광선, 로그오즈 -4/+22, 포화 ±40, 표시 문턱 -10/15를 쓴다. 한 판에서는 벽이 빈 곳보다 우선한다.
- `rt/uslam/cloud_map`은 별도 작업 공간에서 2,048점씩 재구축한다. 전체 50만 점까지 한 번씩 처리한 뒤 3D·2D를 함께 새 revision으로 교체한다. 더 큰 자료는 50만 점으로 고르게 솎고 부분 자료로 기록한다. 전체 지도에 현재 pose의 광선을 쏘지 않는다. 처리 중에는 현재 지도와 다음 전체 지도 한 개만 유지한다.

## 명령과 관측 범위

`FH_USLAM_COMMANDS`는 기본 꺼짐이며 정확히 `1`인 별도 설정, 현재 기체 확인, 연결, 유효한 현장 승인이 모두 있어야 발행할 수 있다. 이 PR은 그 설정을 켜지 않는다. `std_msgs.msg.dds_.String_` 형식은 고정한 [SDK 소스](https://github.com/unitreerobotics/unitree_sdk2_python/blob/814556d15970dd2ecf1c9984e845ca02ab07e206/unitree_sdk2py/idl/std_msgs/msg/dds_/_String_.py)에서 확인했다.

응답 reader를 먼저 열고, 발행은 `rt/uslam/client_command`의 `mapping/start`, `mapping/stop` 두 값으로 제한한다. 동시에 한 명령만 진행하며 명령·세션 중복이나 재접속으로 다시 발행하지 않는다. 10초 무응답·연결 상실은 `UNKNOWN`이다. `FH_USLAM_START_ACK`, `FH_USLAM_STOP_ACK`는 실제 펌웨어에서 확인한 **정확한 응답 문자열**만 설정할 자리이며 기본값은 없다. 임의 로그 부분 일치를 성공으로 추측하지 않는다. String 응답에 명령 ID가 없으므로 외부 앱 조작이나 지연된 동일 로그와의 완전한 상관관계는 실기에서도 별도 확인해야 한다. 취소는 로컬 작업 취소이며 로봇 종료 성공을 뜻하지 않는다.

설치 실행 경로의 내장 SLAM·SLAM media 수신은 이동 승인·잠금과 분리한다. 전용 NIC·현재 기체·자동 점검·인증 연결이 유효해야 하며, 식별/연결 조건이 사라지면 reader를 닫는다. 이 경로는 SportClient나 출력 sink를 만들지 않는다. RGB·원시 lidar 기록과 명시적 `legacy` PCD 경로는 기존 이동 승인 생명주기를 유지한다. 기체 확인 callback이 없는 독립 legacy 읽기 전용 실행 경로는 새 내장 SLAM 수신 권한을 자동으로 얻지 않는다.

## 전달과 저장

3D 칸 변경은 오래된 변경부터, 2D는 64×64칸 tile을 오래된 대기 tile부터 보낸다. tile 원점은 world `[x * 3.2, y * 3.2]`이며 음수 좌표도 같은 규칙이다. progress는 64 KiB 이하, 최대 2,000개 voxel 변경·4개 tile로 나누고 전송이 확인된 항목만 대기열에서 지운다. 새 revision은 이전 지도를 비운다. 브라우저는 이 계산 결과를 배치하기만 하면 된다.

저장은 stop 요청 후 수신을 유지하고, 저장 응답·전체 지도 또는 10초 대기 범위의 결과를 동결한다. 전체 지도를 재구축 중이면 그 처리를 마친다. 최종 revision의 모든 tile·voxel 변경 전송을 확인한 뒤 같은 판의 voxel과 2D grid를 하나의 JSON bundle로 올린다. 따라서 서버가 SAVED로 바뀌기 전에 재접속용 tile도 모두 도착한다. 정확한 저장 응답·저장 후 전체 판이 있고 처리 한도로 잘리지 않은 경우에만 bundle의 `robot_save=ROBOT_SAVED`를 사용한다. 나머지는 `UNKNOWN`으로 받은 범위만 저장한다. 로봇 응답 시각은 별도로 남는다.

bundle은 임시 파일·fsync·원자적 교체로 로컬 보관한 뒤 HTTP 작업자가 보낸다. 실패 재시도는 동일 바이트를 사용하며 stop을 재발행하지 않는다. HTTP·DDS 초기화/해제·해석·계산은 조종 이벤트 루프 밖에서 수행한다. 큰 JSON은 작은 조각으로 인코딩하고 주기적으로 실행권을 넘긴다. 접수·발행·응답·최초/최종 자료·저장 완료의 UTC/monotonic 시각과 점 수·바이트·drop 이유만 기록한다. DDS 원본 stamp는 보존하고 장치 사이 시계 차이를 지연이라고 계산하지 않는다.

## 재현 검사

가상환경에 agent 시험과 서버 계약 시험 의존성을 설치한다. DDS SDK는 모의 객체로 대체하며 설치·접속하지 않는다. 루트에서 `PYTHONPATH=apps/agent:. python3 -m pytest apps/agent/tests`를 실행한다. ROS/실기 로더 설정을 상속한 시험 환경에서는 그 설정을 제거한 별도 시험 프로세스를 쓴다.

웹 동등성은 다음 순서로 같은 JSON 자료를 실제 TypeScript와 Python에 넣는다.

```sh
npm exec --yes --package=typescript@5.7.3 -- tsc apps/web/src/occgrid.ts --target ES2020 --module commonjs --outDir /tmp/uslam-reference
FH_OCCGRID_JS=/tmp/uslam-reference/occgrid.js PYTHONPATH=apps/agent:. python3 -m pytest apps/agent/tests/test_uslam_mapping.py
PYTHONPATH=apps/agent python3 apps/agent/tools/benchmark_uslam.py
```

서버 계약 통합 전에는 PR #476의 `apps/contracts/models.py`를 임시 파일로 추출하고 `FH_USLAM_CONTRACT_MODULE`에 그 파일을 지정하여 실제 진행/tile/원본 stamp/bundle 검증을 실행할 수 있다. 기본 golden도 실제 웹 코드와 같은 공통 자료에서 생성한 값이다.

2026-11-25 이 PC(Intel i7-10750H, x86_64, Python 3.12.3, NumPy 1.26.4)에서 합성 10만 점을 50판 계산한 결과: 투영 p50 27.422 / p95 29.254 / 최대 29.724 ms, 광선 p50 28.528 / p95 31.356 / 최대 40.031 ms. 실시간 점 상한 8,000·계산 예산 30 ms, 전체 시험과 동시 실행한 측정이며 Jetson 수치가 아니다.

전체 시험 최종 회차는 3,497 통과·12 실패·10 건너뜀이다. 실패는 기준 `origin/dev`에도 있는 `bumpInputs` 추출 누락(phone 7개·speed 5개)이며 변경 전 소스 사본에서도 재현했다. 앞선 회차의 정책 인계 간격 -0.1 ms 실패(`test_stand_handover_reports_gap`)도 변경 전 사본에서 재현했으나 최종 전체 회차에서는 통과했다. 기대값이나 정책 코드는 고치지 않았다. 이후 최종 tile 전송 대기 보완은 새 지도 시험 16개로 다시 검사하며 결과는 PR 본문에 기록한다.

실기에서 남은 확인은 펌웨어 명령·성공 로그, frame/child frame, scan과 누적 지도 구분, 센서 원점·바닥 높이, 전체 지도·응답 순서, loop closure, Jetson 계산/STOP 지연·메모리이다. 배포·실폰·실로봇·Gazebo·원격 서버 접속 검사는 하지 않았다. 되돌리기는 이 agent 변경 커밋을 revert하고 이전 agent를 기존 배포 절차로 복구한다. 서버/지도 원물은 삭제하지 않는다.

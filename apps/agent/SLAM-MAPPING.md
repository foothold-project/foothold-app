# Point-LIO live · GLIM final 지도 계산

계약은 [PR #476](https://github.com/foothold-project/foothold-app/pull/476)의 `apps/server/SLAM-CONTRACT.md`를 따른다. 한 세션에서 Point-LIO live → GLIM final로만 진행한다. 이 PR은 agent만 변경하며 서비스 설치·실제 실행·로봇 연결은 하지 않는다.

`source=point_lio`를 명시한 새 명령은 이 파이프라인으로, source 없는 옛 4키 `{t,op,session_id,floor_id}`는 기존 PCD 경로로 보낸다. 두 형태의 수신·저장 형식을 각각 모의 검사한다.

## 출처와 설정

`slam_source.py`가 토픽·좌표·pose 출처를 담당한다. 계산기는 명시적인 world frame의 점과 같은 시각 위치만 받는다. `point_lio`, `glim` 이름·기본 토픽·서비스 이름은 서버 registry와 대조한다. 설치 실행 경로의 이전 내장 SLAM media 구독은 비활성화하며 새 지도 경로에는 로봇 SLAM 명령 발행기가 없다.

| 설정 | 기본값 / 의미 |
|---|---|
| `FH_MAPPING_POINT_LIO_CLOUD_TOPIC` | `/cloud_registered` 등록 scan |
| `FH_MAPPING_POINT_LIO_ODOM_TOPIC` | `/aft_mapped_to_init` 대응 위치 |
| `FH_MAPPING_POINT_LIO_FRAME` | 없음: 실제 world frame을 명시해야 수신 |
| `FH_MAPPING_POINT_LIO_CHILD_FRAME` | 선택적 child frame 대조 |
| `FH_MAPPING_GLIM_CLOUD_TOPIC`, `FH_MAPPING_GLIM_ODOM_TOPIC`, `FH_MAPPING_GLIM_FRAME` | 모두 미설정: 조사·설치에서 최종 자료 규격을 확정할 자리 |
| `FH_MAPPING_POINT_LIO_SERVICE`, `FH_MAPPING_GLIM_SERVICE` | `foothold-pointlio`, `foothold-glim` |
| `FH_MAPPING_SERVICE_CONTROL_ENABLED` | 기본 꺼짐; 정확한 `true` 설정일 때만 로컬 서비스 조작 |
| `FH_MAPPING_POINT_LIO_SENSOR_ORIGIN_VERIFIED` | 기본 꺼짐; 대응 pose가 해당 scan의 센서 원점임을 확인한 경우만 `true` |
| `FH_MAPPING_GLIM_FINAL_TOPIC_VERIFIED` | 기본 꺼짐; 전용 최종 판 의미를 확인한 설치에서만 `true` |

ROS 토픽은 기존 관측 DDS participant에서 `rt/` 이름으로 받는다. 별도 SDK 참여자·SportClient·출력 sink는 만들지 않는다. 실제 ROS 배포판/DDS 타입·도메인·QoS 호환은 실기 확인 대상이다. GLIM 최종 지도 요청 서비스·파일/토픽 규격은 추측하지 않았으며, 현재는 명시 설정 자리와 UNKNOWN 수용 경로다.

## 서비스 생명주기

시작은 서버가 해당 운영자의 로봇 세션에 보낸 명령, 현재 기체 확인·인증 관측 연결·로컬 기본 꺼짐 설정을 거친다. 이동 승인·조종권·잠금 해제는 필요하지 않으며 새 권한을 만들지 않는다. systemctl은 별도 daemon에서 제한된 인자 배열과 5초 호출 timeout으로 실행한다. 조종/STOP 이벤트 루프는 기다리지 않는다.

서비스 이름은 설정된 두 `foothold-*` user unit으로 제한한다. 이 agent가 소유하지 않은 기존 실행 서비스는 소유하거나 끄지 않는다. 우리가 시작한 것만 저장/취소/종료 때 끈다. 새 세션은 이전에 소유한 그래프를 정리한 뒤 시작하며 시작 완료 전에 받은 자료는 누적하지 않는다. 연결/기체 확인 조건이 사라지면 reader를 닫고 10초 뒤 소유한 서비스를 끈다. 이 정리 요청은 DDS 작업자가 지연돼도 별도 관측 감시에서 수행한다. 재접속은 시작을 재전송하지 않는다. 서비스 상태 조회/시작 중 취소도 처리한다. systemd unit 설치와 agent 강제 종료에 대한 supervisor 결합은 이 PR에서 실기 검증하지 않았다.

`foothold-robot`·`foothold-policy-cpp`·`foothold-depth`는 두 설정 어디에 넣어도 초기화 오류로 기록하고 거부한다(`.service` 접미사 포함). 서비스 조회·시작·종료는 수행하지 않는다.

## 5 cm 계산과 전달

`WorldAccumulator`는 기존 세션/저장 core를 확장한다. 칸 = `floor(XYZ/.05)`, 중심 = `(index+.5)*.05`이며 음수 좌표도 같다. live는 판당 최대 8,000점으로 고르게 솎고 30 ms 계산 예산을 작은 묶음마다 확인한다. 운영체제 스케줄링까지 포함한 실시간 보장은 아니다.

2D는 처음 pose 가운데 2,000×2,000칸(100 m 사방), 5 cm다. 범위/계산 한도로 잘리면 부분 자료로 기록한다. 기본은 장애물만 투영하고 나머지는 모름이다. Point-LIO가 등록된 현재 scan을 제공하는 것과 pose가 정확한 센서 원점이라는 것은 별개이므로 보정 확인 설정 전에는 광선으로 빈 곳을 만들지 않는다. 확인된 scan 모드에서는 웹 `occgrid.ts`의 -4/+22 로그오즈, 포화 ±40, -10/15 표시 문턱, 높이·10 m 사거리·한 판 벽 우선 규칙을 그대로 쓴다. NumPy와 격자 배열 초기화도 계산 작업자까지 미룬다.

GLIM 전체 지도는 512점씩 별도 공간에서 처리한다. 50만 점까지 한 번씩 처리하고 더 크면 고르게 솎아 부분 자료로 기록한다. 완성 시 source·revision·frame·voxel·grid·pose를 함께 바꾼다. GLIM→Point-LIO 역전은 없으며 재구축 실패면 마지막 live 판을 보존한다. 누적 전체 지도에 현재 위치의 광선을 쏘지 않는다.

전달은 오래된 voxel 변경부터 최대 2,000개, 오래된 대기 tile부터 최대 4개씩 progress 64 KiB에 맞춰 나눈다. tile은 world 정렬 64×64칸, 원점 `[x*3.2,y*3.2]`, 0 모름/1 빈 곳/2 벽이다. 전송 확인된 항목만 지우고 새 revision에서는 이전 판을 비운다. 브라우저는 계산하지 않고 받은 칸을 배치한다.

tile·grid·bundle의 `floor_z`는 revision의 첫 유효 scan에 대응하는 pose z에서 0.3 m를 뺀 값으로 고정한다. 뒤 pose의 z가 움직여도 바꾸지 않으며, GLIM 재구축을 새 revision으로 교체할 때 그 판의 기준으로 함께 교체한다.

저장은 GLIM 최종 판을 기다리며, 확인할 수 없으면 10초 뒤 받은 범위만 UNKNOWN으로 동결한다. 진행 중인 전체 재구축은 마친다. 최종 tile·voxel 전송 확인 후 같은 판의 3D·2D·최종 pose를 한 bundle로 원자적으로 보관·업로드한다. 재시도는 같은 바이트이고 서비스를 다시 시작하지 않는다. GLIM 확인과 파일 저장 성공은 별개이며 Point-LIO 자료로 `SLAM_SAVED`를 주장하지 않는다. 시뮬 지형 생성은 서버의 후속 작업이다.

계산 한도로 잘린 GLIM 판은 bundle의 `slam_save`와 progress phase 모두 UNKNOWN이다. 로컬 `<session>.bundle.json`은 같은 세션의 서버 `SAVED`·`RECEIVED_ONLY` 응답을 확인하거나 그 세션을 취소한 뒤에만 삭제한다. 업로드 실패·수신 미확인은 재시도용으로 남기며 다른 세션 파일은 건드리지 않는다. 저장 파일 작성·업로드 도중 취소되면 해당 작업이 끝날 때에도 취소된 세션 파일을 정리한다.

## 검사와 남은 범위

```sh
npm exec --yes --package=typescript@5.7.3 -- tsc apps/web/src/occgrid.ts --target ES2020 --module commonjs --outDir /tmp/slam-reference
FH_OCCGRID_JS=/tmp/slam-reference/occgrid.js PYTHONPATH=apps/agent:. python3 -m pytest apps/agent/tests/test_slam_mapping.py
PYTHONPATH=apps/agent python3 apps/agent/tools/benchmark_slam.py
PYTHONPATH=apps/agent:. python3 -m pytest apps/agent/tests
```

계약 통합 전에는 PR #476의 models.py·mapping_sources.py를 같은 임시 폴더에 추출하고 `FH_SLAM_CONTRACT_MODULE`을 지정한다. 모의 시험은 실제 웹 코드와 전체 Int8 격자 동등성, 음수 좌표, 최종 판 교체, tile 분할/재시도, 기본 서비스 발행 0, 소유한 서비스만 종료, 느린 서비스/HTTP/계산 중 STOP을 검사한다. 실제 DDS나 systemctl은 실행하지 않는다.

이 PC(Intel i7-10750H, x86_64, Python 3.12.3, NumPy 1.26.4)의 공통 계산기 측정: 합성 10만 점 ×50판, 8,000점 상한·30 ms 예산. 투영 p50/p95/max 30.214/30.469/30.699 ms, 광선 31.377/32.819/41.487 ms(전체 시험과 동시 실행). Jetson 측정이 아니다. 통합 커밋 fe63f145의 agent·카메라 전체는 3,592 통과·기존 실패 12개·10 건너뜀이며, 새 지도·서비스·구형 명령 호환 시험은 27개 통과했다. 기존 실패는 웹 코드 추출의 bumpInputs 누락(phone 7개·speed 5개)으로 변경 전 소스에서도 재현했고 이 PR에서 고치지 않았다. 정확한 검사 명령·커밋은 PR 본문에 기록한다.

설치·서비스 실행·GLIM 저장 요청/형식·Point-LIO 입력 시각·센서 원점·frame/QoS·loop closure·Jetson 메모리와 STOP 지연·실제 시뮬 지형 실행은 미검증이다. 원격 서버·로봇·Gazebo·운영 설정에 접속하지 않았다. 되돌리기는 agent 변경 커밋을 revert하고 기존 배포 절차로 복구하며 지도/서버 원물은 삭제하지 않는다.

> 분류: 앱 · 에이전트 · 실행기
> 작성: Codex 세션 (오흥재 지시, app-code) · 2026-11-23
> 근거: foothold-app #473 · Python PR #472의 `c24155bb9fe29aa19cdb37336ea86bb295a4db2a` · 재기립 보완 `16f2dd6f` · start-m15500 정책 계약
> 요지: C++ 실행기 빌드, 행위 대조, 송신 없는 검증 절차
> 상태: 검증용 · 실기 송신 및 운영 전환은 별도 승인

# START C++ 실행기

제어 스레드는 LowState를 읽고 리모컨·생존 신호·모드 우선순위를 판정하며 5 ms 간격으로 LowCmd를 처리한다. ONNX 추론은 별도 스레드에서 20 ms마다 요청한다. 추론이 늦으면 마지막 목표를 유지하며 밀린 요청을 몰아 실행하지 않는다. 앉기나 감쇠로 전환하기 전에 걸린 추론의 결과는 폐기한다. 기록 스레드는 고정 크기 링을 비우고 이벤트와 50 Hz 정책 표본을 JSONL로 기록한다. 파일당 50 MB, 폴더당 2 GB에서 제한하고 이전 기록은 보존한다.

순정에서 진입할 때는 신선한 LowState와 리모컨 위 + Start가 필요하다. 감쇠 상태에서 다시 설 때는 1초 동안 접은 자세로 다리를 모은 뒤 일어선다. 몸 기울기가 25°를 넘으면 재기립을 거부한다. 제어를 되돌릴 때 마지막 감쇠 이후 LowCmd를 중단하고, MotionSwitcher가 요청한 모드를 확인한 후에 순정 복귀를 기록한다. dry-run은 LowState만 구독하며 LowCmd 발행자와 MotionSwitcher·SportClient를 생성하지 않는다. 운영 START 표시 파일은 live 모드에서만 바뀐다.

## 빌드와 시험

CMake 3.20 이상, C++17 컴파일러. 실행 바이너리는 ONNX Runtime C++ 헤더와 같은 버전 라이브러리, OpenSSL Crypto 개발 파일이 필요하다. DDS를 포함한 빌드에는 Unitree SDK2 CMake 패키지를 추가한다.

```sh
cmake -S apps/agent/runner_cpp -B "$build_dir" -DCMAKE_BUILD_TYPE=Release \
  -DFOOTHOLD_WITH_ORT=ON \
  -DONNXRUNTIME_INCLUDE_DIR="$ort_dir/include" \
  -DONNXRUNTIME_LIBRARY="$ort_dir/lib/libonnxruntime.so" \
  -DFOOTHOLD_VECTOR_BUNDLE="$policy_bundle"
cmake --build "$build_dir" --parallel 2
ctest --test-dir "$build_dir" --output-on-failure
```

SDK가 있는 Linux 호스트에서는 configure에 `-DFOOTHOLD_WITH_UNITREE=ON -DCMAKE_PREFIX_PATH="$unitree_dir"`를 더한다. `FOOTHOLD_WITH_ORT`를 끄면 SDK가 없는 호스트에서도 코어와 가짜 SDK 전환 시험을 빌드할 수 있다. 정책 묶음의 ONNX와 JSON 벡터는 외부 산출물이다.

기준 Python 패키지를 `PYTHONPATH`에 두고, NumPy와 같은 버전의 ONNX Runtime Python이 설치된 환경에서 직접 비교한다.

```sh
python apps/agent/runner_cpp/tests/command_replay.py "$build_dir/command_replay"
python apps/agent/runner_cpp/tests/vector_replay.py \
  "$build_dir/vector_replay" "$policy_bundle" --python-reference
```

## 송신 없는 주기 측정

```sh
"$build_dir/foothold_start" --folder "$policy_bundle" \
  --benchmark --mode off --seconds 30 --cpu-range 0-3 --trace-dir "$trace_dir"
```

위 모드는 합성 LowState로 가동한다. SDK 포함 빌드에 `--nic "$state_interface"`를 더하면 실제 LowState를 수신하고 같은 로컬 진입 조건을 재현한다. 필요한 코어와 기존 프로세스 부하는 장비 담당자가 확인한 값을 쓴다. `--rt-priority`와 `--mlock`은 실제 적용 결과를 상태 줄에 남긴다. 권한이 없으면 해당 결과가 `false`로 표시된다.

`dt_p99`와 `dt_max`는 Python과 같은 최근 250개 정책 간격, `dt_n`과 `dt_over30`은 누적이다. 종료 줄의 `policy_period_p99_ms`는 0.1 ms 폭으로 올림한 누적 p99, `policy_period_max_ms`는 누적 최대다. `lowcmd_writes`가 모든 상태 줄에서 0이어야 한다. 벤치마크가 측정 시간 전에 정책에서 이탈하거나 기록이 떨어지면 프로세스가 실패로 끝난다.

지도 복원 입력은 `--mode reconstruction --depth-socket "$private_dir/depth.sock"`로 받는다. 소켓 디렉터리는 실행 사용자가 소유하고 접근 모드는 0700이어야 한다. 기존 카메라와 기준 Python 패키지가 있는 환경에서 `depth_bridge.py --socket "$private_dir/depth.sock"`를 실행하면 ROS 2 로컬 구독으로 정규화한 프레임을 보낸다. 재표본화는 기준 `DepthResampler`를 쓴다. 수신기는 250 ms 안의 유효한 프레임만 받아들이고 정책의 한 장 지연을 적용한다. 지도 복원 진입 후 유효 프레임을 잃으면 앉기와 순정 복귀 경로를 사용한다. `--benchmark --mode reconstruction`에 소켓을 생략하면 정규화된 합성 깊이를 쓴다. GT는 벡터 시험에서만 지원한다.

## 적용 범위와 되돌림

기본 앉기 경로, 리모컨 진입 및 리모컨 기반 명령을 이식했다. Python의 앱 UDP 제어, 선택형 `settle`·`stand` 종료 경로, 디버그 추정 ONNX는 이번 실행기에서 지원하지 않는다. 정본 ONNX에는 추정 전진 속도 출력이 없어 기록의 `est_vx` 값은 `[null,null]`이다. ORT 및 DDS 라이브러리 내부 할당은 별도 측정 대상이다.

운영 서비스와 배포 파일은 이 변경의 범위 밖이다. 시험 종료 시 실행기 프로세스가 스스로 종료된다. 코드가 반영된 뒤 되돌려야 하면 기능 커밋을 revert하고 기존 Python 실행기로 확인한다.

## 제어·감각·기록 통신 코어 배치

세 역할을 나누려면 `--control-cpus`, `--sensing-cpus`, `--io-cpus`를 함께 지정한다. 각각 한 코어 또는 연속 범위이며 시작 프로세스가 허용받은 코어 안에 있어야 한다. 세 범위는 겹칠 수 없다. 지정하지 않으면 기존 `--cpu-range`를 사용한다.

| 역할 | 배치 | 스케줄러 |
|---|---|---|
| 제어 | 200 Hz 상태 머신과 명령 호출 | `--rt-priority`의 FIFO 우선순위 |
| 감각 | 정책 추론 작업 스레드, ORT 내부 스레드, 사용 시 깊이 소켓 수신 | 정책 작업 스레드는 `--sensing-rt-priority`, 기본값은 제어보다 한 단계 아래. 내부 작업 및 깊이 수신은 일반 스케줄링 |
| 기록 통신 | JSONL 기록 스레드와 DDS 초기화로 생기는 SDK 스레드 | 일반 스케줄링 |

예를 들어 전 코어 0–7을 쓸 수 있는 별도 시험에서 제어 4, 감각 5–7, 기록 통신 0–3을 지정하려면 아래처럼 실행한다.

```sh
"$build_dir/foothold_start" --folder "$policy_bundle" --benchmark --seconds 30 \
  --control-cpus 4 --sensing-cpus 5-7 --io-cpus 0-3 \
  --rt-priority 40 --sensing-rt-priority 30
```

시작 로그의 각 `role` 행은 커널에서 읽은 CPU 목록·스케줄링 정책·우선순위, 그리고 요청값을 출력한다. 실행 중에는 스레드 TID를 찾아 `chrt -p TID`와 `taskset -pc TID`로 대조할 수 있다. FIFO 권한 부족 시 dry-run은 실제 적용된 정책을 기록한다. live 실행은 정책 또는 제어 실시간 설정이 실패하면 시작을 중단한다.

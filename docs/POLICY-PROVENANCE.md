# MVP foothold-v2 → policy_v2.f32 출처 기록

2026-10-29, 기준 `origin/dev` = `468715b2f78d39d38fc9124bd8cbc05fa12d36bf`.
MVP `foothold-v2`의 LFS oid·모델 카드와 10월 12일 내보내기의 원본 SHA-256이 같다.
이번에는 **npz → f32를 재현했고, 발견한 f32 사본 7개 모두 재생성물과 바이트가 같다**.
원본 체크포인트 실물은 지정된 Downloads 위치에 없고 현재 Python에 torch도 없다.
따라서 **원본 .pt → TorchScript/npz 단계는 이 PC에서 재현 안 함(torch 없음)**이며,
그 구간의 출처 연결은 아래 당시 스크립트·검증 기록을 근거로 한다.

## 사슬과 파일 식별

`foothold-lab/models/foothold-v2.pt`(LFS oid) → 원본 `foothold-v2.pt`
→ `control-app 실험 33 export-20261012/policy_v2_actor.pt`(TorchScript)
→ 같은 내보내기의 `policy_v2_actor.npz` → `policy_v2.f32`.
여기서 실험 33은 `control-app/experiments/33-foothold-v2-gazebo-20261012`,
내보내기는 그 아래 `cpu-check/export-20261012`를 뜻한다.

| 대상 | 크기(bytes) | SHA-256 | 근거 |
|---|---:|---|---|
| LFS가 선언한 원본 .pt 실물 | 6,882,293 | `e5c213219b4529464b7d3f3cce8f7a61c78fa4f2f7df7c64cfe12944c5ab2fee` | 포인터 oid·모델 카드·export.json의 src_sha256 일치, 이번 실물 재해시 아님 |
| models/foothold-v2.pt 포인터 파일 | 132 | `ad00e96a0ec6ea4196ff45f68a3e281710797b9acd351d05044fb1e2e085f295` | 실물과 구별해 실제 해시 측정 |
| export-20261012/policy_v2_actor.pt | 1,158,533 | `1ff96c8c0a6494c7a403d1eb6da227246e9ee3c0ff343c4656484eada1d9e47b` | 이번 해시 = export.json의 ts_sha256; 실행·역직렬화 안 함 |
| export-20261012/policy_v2_actor.npz | 1,148,406 | `a162d3bff81611de0ac60cd5aeb08dea3a3d06445992137d02b75c5bf3e604b8` | 이번 해시·숫자 배열 읽기 |
| 이번 재생성 f32 | 1,146,416 | `da199be22d3bea64601d5237a0438ff447c85a49ce64d35bb6f486b5f0adc68c` | 아래 사본 모두와 SHA·전체 바이트 일치 |

다음은 foothold 자료 트리와 Orca foothold-app 작업 폴더 트리에서 찾은 사본이다.
아래 경로는 각 작업 폴더 이름부터의 상대 이름이며, 파일은 모두 읽기만 했다.
발견 범위 밖의 PC 전체나 원격 사본까지 같은 것으로 단정하지 않는다.

| 사본 | 크기(bytes) | SHA-256 |
|---|---:|---|
| rb-phone-robot-connect/mobile/www/sim/policy_v2.f32 | 1,146,416 | `da199be22d3bea64601d5237a0438ff447c85a49ce64d35bb6f486b5f0adc68c` |
| rb-phone-robot-connect/mobile/android/app/src/main/assets/public/sim/policy_v2.f32 | 1,146,416 | `da199be22d3bea64601d5237a0438ff447c85a49ce64d35bb6f486b5f0adc68c` |
| rb-phone-robot-connect/mobile/android/app/build/intermediates/assets/dev/mergeDevAssets/public/sim/policy_v2.f32 | 1,146,416 | `da199be22d3bea64601d5237a0438ff447c85a49ce64d35bb6f486b5f0adc68c` |
| rb-preview-dev2/mobile/www/sim/policy_v2.f32 | 1,146,416 | `da199be22d3bea64601d5237a0438ff447c85a49ce64d35bb6f486b5f0adc68c` |
| rb-preview-dev2/mobile/android/app/src/main/assets/public/sim/policy_v2.f32 | 1,146,416 | `da199be22d3bea64601d5237a0438ff447c85a49ce64d35bb6f486b5f0adc68c` |
| rb-preview-dev2/mobile/android/app/build/intermediates/assets/dev/mergeDevAssets/public/sim/policy_v2.f32 | 1,146,416 | `da199be22d3bea64601d5237a0438ff447c85a49ce64d35bb6f486b5f0adc68c` |
| rb-terrain-v2/runs/terrain-v2/simsrc/policy_v2.f32 | 1,146,416 | `da199be22d3bea64601d5237a0438ff447c85a49ce64d35bb6f486b5f0adc68c` |

## .pt → TorchScript → npz: 당시 자료로 확인한 구간

원래 스크립트는 읽기만 했으며 실행하거나 가져오기(import)하지 않았다.

| control-app 실험 33의 근거 파일 | SHA-256 | 확인 내용 |
|---|---|---|
| cpu-check/export_and_check.py | `9eba53e5c9d971f93dd74e17863faa6b8732ecda6a124210cdafe1ce9315b7a8` | 원본 model_state_dict에서 actor 추출, strict 로드, 235→512→256→128→12, ELU, 정규화 없음, TorchScript 저장·재로드 |
| cpu-check/export-20261012/export.json | `24a02b1e6dd54fa81ea47225302990ed7b0d45a04fa0617fdde76475120ee94a` | 원본 SHA·iter 3000·torch 2.14.0+cpu·아래 당시 차이 기록 |
| cpu-check/test_v2_obs.py | `2c4d28e983e2f1507a359a36b8438244d88970a73f7529d28c70fb7145ef985d` | 92–95행: TorchScript state_dict의 숫자 배열을 np.savez로 저장(기존 파일은 보존) |
| cpu-check/test_v2_obs.out | `52c820c87dfacaadaae3b38404b252ba752af4cfa1cd4bd9156cbe3ccbdddb66` | NumPy vs TorchScript 최대 차 `1.1444091796875e-05`, ALL PASS |
| cpu-check/test_v2_obs.r2.out | `15bd796489beee269508a17783e11a6212e5d32a2c69e730155527c6b2c17d9e` | 같은 최대 차·ALL PASS 재기록 |

`export.json`의 기준 rsl_rl actor vs TorchScript 및 기준 actor vs torch MLP의
최대 절대 차는 모두 **0**이다. 입력은 zeros 1개, stand_approx 1개,
정규분포 σ=1 4,096개, σ=5 4,096개이며 torch seed는 `20261012`다.
이 0은 **당시 torch 계산 사이의 값**이고 이번 NumPy vs JS 차이를 뜻하지 않는다.
`test_v2_obs.py`의 별도 NumPy vs TorchScript 시험은 torch seed 1의 4,096개이며
당시 최대 차는 위 표와 같이 0이 아니다.

당시 export.json에는 npz 자체 해시가 없다. 따라서 이번 npz를 당시 TorchScript에서
다시 추출하여 대조한 것은 아니며, 해당 연결은 저장 코드·동일 폴더 자료·과거 로그로 뒷받침된다.
원본 실물 확보와 torch가 허용되는 별도 환경에서 이 구간을 다시 검증할 수 있다.

## npz → f32: 이번 재현

[변환 스크립트](../mobile/scripts/npz_to_f32.py)는 표준 ZIP/NPY를
NumPy `read_array(..., allow_pickle=False)`로 읽는다. 키·shape·float32·유한값을 검사하고
`0.weight, 0.bias, 2.weight, 2.bias, 4.weight, 4.bias, 6.weight, 6.bias` 순서로
행 우선 float32 little-endian 바이트를 잇는다. 총 286,604개 float, 1,146,416 bytes다.
기존 파일은 덮어쓰지 않는다. torch·추가 패키지는 필요 없다.

[`mobile/sim/sim.js`](../mobile/sim/sim.js)의 실제 `loadPolicy`와 같은 shape이며,
은닉층 세 개는 ELU(α=1), 마지막은 선형이다. JS는 곱셈·누산을 binary64 Number로 수행하고
각 층 출력을 Float32Array에 저장한다. NumPy의 float32 행렬곱과 반올림 경로가 다르므로
숫자 출력까지 항상 비트 일치한다고 요구하지 않는다.

현재 실행 환경: Python 3.12.3, NumPy 1.26.4, Node v18.19.1, little-endian CPU.
Node는 순전파 모듈만 직접 import했고 `createSim`·MuJoCo를 호출하지 않았다.
앱 package.json의 권장 Node는 ≥22이며, 이번 검사는 설치된 v18에서 수행했다.

입력은 float32 zeros, 원래 export_and_check.py의 stand_approx
(`x[8]=-1`, `x[48:]=0.32-0.5`, 나머지 0), NumPy default_rng/PCG64 seed `20261029`로
차례로 생성한 σ=1 64개와 σ=5 64개다. 이번 난수는 과거 torch 난수와 별개다.

| 같은 입력 | N | npz NumPy vs f32 NumPy 최대 차 | npz NumPy vs f32 JS 방식 최대 차 | npz NumPy vs 실제 sim.js 최대 차 | JS 방식 모사 vs 실제 sim.js 최대 차 |
|---|---:|---:|---:|---:|---:|
| zeros | 1 | 0 | 4.470348358154297e-07 | 4.470348358154297e-07 | 0 |
| stand_approx | 1 | 0 | 5.960464477539062e-07 | 5.960464477539062e-07 | 0 |
| randn_s1 | 64 | 0 | 1.33514404296875e-05 | 1.33514404296875e-05 | 0 |
| randn_s5 | 64 | 0 | 5.340576171875e-05 | 5.340576171875e-05 | 0 |

`--check`는 재생성 바이트 일치, 가중치 배열 일치, 출력 유한값, NumPy 두 경로의 정확한 일치,
실제 sim.js와 NumPy의 절대 허용차 `2e-4`(rtol=0), JS 방식 모사와 실제 sim.js의
절대 허용차 `1e-6`(rtol=0)을 assert한다. 실측 최대 차는 위 표와 같다.
이 검사는 정책 파일 출처와 순전파 대조이며 물리·행동·실로봇 검증은 아니다.

## 재현 명령과 로컬 원시 기록

저장소 루트에서 `POLICY_EXPORT_DIR`은 보유한 실험 33의 `cpu-check/export-20261012`,
`POLICY_F32_COPY`는 검증할 기존 f32 파일로 지정한다. 개인 절대 경로를 문서나 커밋에 쓰지 않는다.

```sh
mkdir -p runs/policy-provenance
# 변환만: 출력 파일은 새 이름이어야 한다.
python3 mobile/scripts/npz_to_f32.py "$POLICY_EXPORT_DIR/policy_v2_actor.npz" \
  --output runs/policy-provenance/rebuilt.f32
# 같은 시험을 assert로 재실행하고 입력·네 경로 출력·최대 차를 JSON에 저장한다.
OPENBLAS_NUM_THREADS=1 python3 mobile/scripts/npz_to_f32.py \
  "$POLICY_EXPORT_DIR/policy_v2_actor.npz" --check "$POLICY_F32_COPY" \
  --report runs/policy-provenance/inference.json
sha256sum "$POLICY_EXPORT_DIR/policy_v2_actor.npz" \
  "$POLICY_EXPORT_DIR/policy_v2_actor.pt" "$POLICY_F32_COPY" \
  runs/policy-provenance/rebuilt.f32
npm --prefix mobile run selftest
```

로컬 기록은 `runs/policy-provenance/`에 저장하고 기존 Git 제외 규칙을 유지한다.

- `inventory.json`: 각 파일의 상대 이름·bytes·SHA, 탐색 범위, 원본 부재, 모든 사본의 바이트 일치.
- `historical-export.json`: 개인 경로를 뺀 당시 export 수치와 재현하지 않은 단계.
- `inference.json`: 130개 입력, 각 경로의 전체 출력, 최대 차, seed, 도구 버전, 실행 코드 SHA.
- `REPORT.md`: 15줄 이내 작업 결과.

앱의 기존 `npm --prefix mobile run selftest`는 통과 사례 4개·거부 사례 18개로 PASS.
이번에는 앱 동작 코드를 바꾸지 않았으며 빌드·에뮬레이터·실기·Gazebo·배포는 하지 않았다.
가중치와 로컬 기록은 커밋하지 않고 기존 `FH_SIM_SRC` 복사 방식을 유지한다.

## FP32 ONNX 시뮬 추론 (2026-11-02)

기준 `origin/dev` = `c510ca0` (#226 포함). `policy_v2_onnx.py`는 위 NPZ의
SHA를 먼저 검사하고, 기존 `npz_to_f32.py`의 숫자 ZIP/NPY 판독기
(`allow_pickle=False`)·NumPy 순전파를 재사용한다. 체크포인트·pickle·받은 코드는
읽거나 실행하지 않는다. 기존 `runs/ame2-export/venv`의 Python 3.12를 `-I`로
실행했고 NumPy 2.5.4·onnx 1.20.1을 재사용했다. Python 패키지 추가 설치는 없다.

| 산출물 | 값 |
|---|---|
| `policy_v2.onnx` | 1,146,973 bytes, opset 17 / IR 8, 고정 B=1, 모든 가중치 FP32 |
| ONNX SHA-256 | `c9f3c5c00c6b3b3a41daf96b5de46f18673af23718ffbf8ecd84c77969bf27e2` |
| NPZ SHA-256 | `a162d3bff81611de0ac60cd5aeb08dea3a3d06445992137d02b75c5bf3e604b8` |
| 재생성 f32 SHA-256 | `da199be22d3bea64601d5237a0438ff447c85a49ce64d35bb6f486b5f0adc68c` (기존과 바이트 동일) |
| 입출력 | `observation[1,235]` → `action[1,12]`, 모두 float32 |
| 그래프 | Gemm×4, ELU(alpha=1)×3, 최종 선형 결정적 평균. 샘플링·정규화 없음 |

ONNX full checker를 통과했다. 관측 235·MLP 512/256/128·행동 12·scale 0.25·
관절 순서·명령 범위·높이 스캔·주기 계약은 바꾸지 않았다. 직렬화는 deterministic이며
출력은 `runs/policy-onnx/out/`의 새 파일로만 쓰고 기존 파일은 덮어쓰지 않는다.
모델·원시 관측·런타임·APK는 Git에 넣지 않는다.

`policy-adapters.js`의 `onnx` 필드에 파일·SHA·입력/출력 이름·shape·type·행동 출력 이름을
선언하고, 기존 AME-2 실행기를 일반화한 `policy-onnx.js`를 두 모델이 공유한다.
`ame2-onnx.js`는 이전 시험 도구용 호환 export만 남긴다. WASM 1 thread가 기본이며
`policyBackend=f32`로 같은 모델의 기존 JS 계산을 명시적으로 선택할 수 있다.
`ame2Backend=f32|wasm|webgpu`도 AME-2에서 계속 지원한다.

ONNX 파일 없음·SHA 불일치·런타임/세션/첫 추론/실행 실패는 같은 어댑터의 f32로
전환하고 화면 아래와 메뉴에 이유를 계속 표시한다. 예:
**«foothold-v2 · 기본 계산 사용: ONNX 파일 없음 (404) (f32 JS) · 시뮬 전용»**.
다른 정책으로 조용히 바꾸지 않는다. AME-2 f32 자체가 없을 때의 기존 선택 비활성화는 유지한다.
STOP·blur·hidden·pagehide·reset과 손 조종은 generation을 바꿔 대기 중 결과를 버린다.
동시 추론은 하나이며 대기 중 프레임 시간 빚은 버린다. foothold-v2는 잠금 뒤에도
기존과 같이 0 속도 명령으로 서기 계산을 계속한다. AME-2는 기존처럼 잠금 중 물리도 쉰다.

### 동일 입력 대조와 지연

고정 130건 = zero·중립·seed 20261029의 PCG64 정규 난수 sigma 1/5 각64건.
기록 60건 = 다섯 지도 f32 궤적에서 25틱마다 수집. 전부 유한값,
**최대 절대오차 ≤1e-4**를 기준으로 검사했다. 상대오차의 분모 하한은 1e-6이며 별도 합격 기준이 아니다.
Node 22.23.3 / onnxruntime-node 1.31.1 CPU 1 thread, Chrome 154.0.8037.97 /
onnxruntime-web 1.31.1 WASM 1 thread. 전체 node_modules 설치 없이 Node ORT 패키지만
로컬 시험 폴더에 설치했고 Web 런타임은 이전 검증 APK에 보존된 동일 버전을 재사용했다.

| 환경·입력 | NumPy↔JS max abs | NumPy↔ONNX max abs | JS↔ONNX max abs |
|---|---:|---:|---:|
| Node 고정130 | 4.95911e-5 | 4.19617e-5 | 4.19617e-5 |
| Node 기록60 | 1.66893e-6 | 7.15256e-7 | 1.66893e-6 |
| Chrome WASM 고정130 | 4.95911e-5 | 4.19617e-5 | 5.34058e-5 |
| Chrome WASM 동일 기록60 | 1.66893e-6 | 7.15256e-7 | 1.43051e-6 |

같은 회차 zero 입력 warm 100회(10회 준비 후)의 추론 지연이다. 최초 load는 각 파일 fetch/read,
로더·session 생성·첫 추론을 포함하며, ONNX는 런타임 import도 포함한다. 네트워크 원격 로드나
실폰 cold start 측정이 아니다. 정책 로드 부분만 측정하며 MuJoCo·지도 로드는 제외한다.
파일 캐시와 호스트 부하의 영향이 있다.

| 환경 | f32 첫 load ms | ONNX 첫 load / 첫 추론 ms | f32 p50/p95 ms | ONNX p50/p95 ms |
|---|---:|---:|---:|---:|
| Node CPU | 6.30 | 51.64 / 1.65 | .556 / 1.015 | .130 / .467 |
| Chrome WASM | 22.20 | 391.60 / 10.90 | 1.0 / 1.3 | .2 / .4 |

### 다섯 지도 궤적 수치 (보행 판정 없음)

지도 기본 spawn·기본자세 hold .5초 뒤 각 엔진 300틱(6초). 같은 명령을 2초씩
`[.6,0,0]` → `[.6,0,.5]` → `[0,0,0]`으로 주었다. quaternion은 부호 동치 보정 후
성분 최대 차, gravity는 몸 기준 아래 방향 성분 최대 차다. 기본 spawn 부근의 짧은 궤적이며
전체 지도·험지·장시간·다른 명령의 보행 동등성이나 «성공»을 뜻하지 않는다.

| 지도 | Node 위치 최대 m / 관절 최대 rad | Chrome WASM 위치 최대 m / 관절 최대 rad | Chrome quaternion / gravity 최대 |
|---|---:|---:|---:|
| factory-inspection | 5.50724e-8 / 7.99266e-7 | 2.30096e-7 / 3.38615e-6 | 3.91690e-7 / 3.30659e-7 |
| factory-inspection-alt1 | 5.50724e-8 / 7.99266e-7 | 2.30096e-7 / 3.38615e-6 | 3.91690e-7 / 3.30659e-7 |
| factory-zone | 4.45480e-8 / 7.73330e-7 | 1.20804e-7 / 2.47251e-6 | 2.59832e-7 / 3.52332e-7 |
| warehouse | 1.32469e-7 / 1.88950e-6 | 1.42748e-7 / 1.22185e-6 | 1.92168e-7 / 4.12214e-7 |
| element-course | 4.88974e-8 / 9.15941e-7 | 1.62361e-7 / 3.11078e-6 | 3.25145e-7 / 2.97844e-7 |

### 재현과 배포 경계

```sh
# POLICY_NPZ=보유 NPZ; POLICY_PY=기존 ame2-export venv의 python;
# POLICY_ORT_NODE=로컬 onnxruntime-node 1.31.1 entry;
# FH_SIM_SRC=기존 외부 자산; FH_AME2_SRC=기존 AME-2 export;
# FH_POLICY_ONNX_SRC=runs/policy-onnx/out; FH_PLAYWRIGHT=기존 playwright-core entry.
if OPENBLAS_NUM_THREADS=1 "$POLICY_PY" -I mobile/scripts/policy_v2_onnx.py "$POLICY_NPZ"; then :; else exit 1; fi
if node mobile/scripts/policy-onnx-sim-selftest.mjs; then :; else exit 1; fi
if OPENBLAS_NUM_THREADS=1 "$POLICY_PY" -I mobile/scripts/policy_v2_onnx.py "$POLICY_NPZ" --observations runs/policy-onnx/out/observations.json; then :; else exit 1; fi
if node mobile/scripts/policy-onnx-parity.mjs; then :; else exit 1; fi
if node mobile/scripts/sync-web.mjs; then :; else exit 1; fi
if node mobile/scripts/policy-onnx-headless.mjs; then :; else exit 1; fi
```

`sync-web.mjs`는 어댑터 목록을 순회하여 `FH_POLICY_ONNX_SRC`(기본 `FH_SIM_SRC`)에서
선택적 ONNX를 SHA 확인 후 복사하고 런타임은 한 번만 복사한다. AME-2는 기존 `FH_AME2_SRC`를
유지한다. 생성 파일·원 관측·전체 지표는 로컬 `runs/policy-onnx/`에 있다.
**dev merge는 서버 자동배포를 실행한다.** 서버 ONNX 자산은 이번 범위 밖이므로 서버 웹 기본
foothold-v2도 위 기본 계산 배지와 함께 기존 f32로 실행된다. ONNX 없는 상태의 수동 명령·물리
진행을 headless에서 확인한다. 서버 ONNX 제공은 후속 작업으로 `deploy/prepare_sim.py`에
두 모델의 선택 자산·고정 SHA·ORT mjs/wasm 복사와 MIME·누락 처리 검증이 필요하다.
이번 작업은 deploy·apps·server·운영 포트·원격 서버·Gazebo·실로봇·설치/배포에 접촉하지 않는다.
코드 복구는 PR merge의 `git revert`, 즉시 비교는 `policyBackend=f32`다.

Chrome ONNX 궤적에서 별도로 모은 관측 60건도 NumPy로 다시 계산했다.
NumPy↔JS 최대 1.66893e-6, NumPy↔WASM 최대 7.15256e-7로 기준 이내였다.
`--observations runs/policy-onnx/out/browser-observations.json --reference-name browser-recorded.json`으로
원 입력과 두 엔진 출력을 보존한 상태에서 재현한다.

검증은 무거운 실행을 하나씩만 진행했다. 기존 `*-selftest.mjs` 19개 전부 통과
(start/scenario/astar/height-scan/height-walk/factory-one/factory-outside/house-look/top-fit/
sim-goal/sim-keys/sim-no-fall/ame2-network/ame2-sim/ame2-ui/ame2-overhead/
ame2-train-match/ame2-train-terrain/ame2-onnx-sim).
특히 `ame2-train-match`는 기존 foothold-v2 f32의 관측·qpos·qvel·ctrl 30틱 비트 동일을,
`height-walk`는 5지도 6초의 기존 f32 궤적 비트 동일을 확인했다.
추가로 v2 ONNX Node/Chrome 궤적·두 어댑터의 비동기 취소·기존 AME-2 ONNX
고정274/기록72 parity·headless WASM UI를 통과했다. Chrome에서는 양 정책의
STOP/blur/hidden/pagehide/reset/손 입력 때 늦은 결과 폐기와 동시 추론 하나,
모델/런타임/wasm 없음·SHA·첫 추론·실행 실패 시 같은 모델 f32 전환 및 배지 노출을 확인했다.
원 로그는 로컬 `runs/policy-onnx/selftests/`와 `headless*.log`에 있다.
실폰·에뮬레이터 실행·실제 GPU·장시간/전체 지도·실로봇은 미검증이며 보행 성공 판단은 하지 않는다.

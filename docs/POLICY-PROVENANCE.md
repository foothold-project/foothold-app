# MVP foothold-v2 → policy_v2.f32 출처 기록

## start-demo (m13000)

`start-m13000-app/CONTRACT.md` 및 `contract.json`의 m13000 ONNX 두 파일을 그대로 사용한다. 원본 checkpoint SHA-256은 `20365a2c6d70f94f65f1114471f7df198e56d86db6d02d89cea43c666b95e768`이며, checkpoint 재내보내기는 수행하지 않았다.

| 파일 | bytes | SHA-256 |
|---|---:|---|
| `start-m13000_map_on.onnx` | 5813202 | `4799677acdc9fbc22da28fd56fefa3181f24b38b198e3bea02270c1c1cd11d93` |
| `start-m13000_map_off.onnx` | 5823033 | `8317548f51a046afb537c212eec47a12b2888b6ea049fa84361d83aa8c30849f` |

정답/복원은 map_on + use_gt true/false, 끔은 map_off이다. ONNX 전용이며 f32 되돌림이 없다. `FH_START_SRC`(또는 `FH_POLICY_ONNX_SRC`)에서 복사하고 SHA를 확인한다. 모델·가중치·시험 벡터는 커밋하지 않는다. 배포 준비의 private-assets 루트에 두 파일을 놓으면 `/sim/`으로 복사하며, 없거나 SHA가 다르면 start 메뉴만 비활성화한다. 실제 서버 복사·배포는 별도 승인 작업이다.

2026-11-09 m13000 벡터 20스텝을 Node 22.23.2 / ORT 1.31.1 CPU 및 Chrome 154.0.8037.97 / ORT Web 1.31.1 WASM main·Worker에서 대조했다. 입력 9개·출력 4개의 이름·순서·모양·bool 플래그는 전달 계약과 같으며 실행기·상태 되먹임은 유지했다.

| m13000 벡터 | Node 행동 최대 차 | Chrome main | Chrome Worker |
|---|---:|---:|---:|
| reconstruction | 2.05636024e-6 | 2.62260437e-6 | 2.62260437e-6 |
| gt | 2.14576721e-6 | 1.90734863e-6 | 1.90734863e-6 |
| off | 1.90734863e-6 | 2.02655792e-6 | 2.02655792e-6 |

모든 출력의 최대 차는 2.62260437e-6으로 허용 오차 1e-4 이하다. 후진 모드 상한은 학습 범위에 맞춰 1.3 m/s다.

시험 벡터 실측 및 조정 결정(2026-11-04)에 따라 이력은 **현재 포함 최신 관측부터 10개**, 리셋 뒤 첫 관측을 10칸에 채운다. 인계 v0.3의 «오래된 것이 앞» 설명과 다르다. 깊이 두 장도 최신부터이며, tick 15 입력은 `[f10, f5]`다. 관측 이력·깊이 버퍼·GRU 출력은 실제 행동 적용 때만 확정한다. `policy-vector-selftest.mjs`는 원시 프레임 f0/f5/f10을 기록에서 꺼내 등록된 모드의 obs45/hist/depth2/gt_map을 만들고 대조한 뒤 그대로 Node/브라우저/Worker ONNX에 넣는다. 비정답 모드의 기록에는 사용하지 않는 진단 gt_map이 남아 있어, 앱의 0 지도와의 차이는 별도 수치로 보고하고 유효 입력은 0인지 확인한다.

깊이의 새 프레임은 첫 호출에서 초기화한 뒤, 이후 tick에서는 ONNX 결과를 수용한 `applyAction` 안에서 물리 진행 전에 캡처한다(소비는 다음 tick). 같은 물리 상태 재시도는 원시 센서 표본을 재사용하며 이력/상태를 확정하지 않는다. 카메라 거리·시야 밖 지형은 보수적인 경계 상자로 제외하고, 남은 3600 광선은 그대로 `mj_multiRay`로 계산한다. start 높이 지도만 `fastVertical`을 켜 수직 광선과 삼각형·수평면·수직 박스의 교차를 직접 계산한다(삼각형 경계·그 외 도형은 native 계산). nvidia/ame2는 기존 native 경로를 유지한다. `start-demo-sensor-parity-selftest.mjs`는 3지도·몸 전체 자세 450개에서 native 대비 깊이 1620000개 광선·높이 230400칸의 최대 차 0을 확인했다.

start는 추론 중이고 `stats.slow`로 시뮬 지연이 확인될 때만 그리기를 미루되 마지막 그리기 이후 최대 100ms가 지나면 pending이어도 그리기·라이다·시나리오/목표/층 UI를 진행한다. 매 RAF의 벽시계 시간과 Worker 기한 20ms는 유지하며, 기본 계산을 화면 ONNX로 바꾸거나 새 자동 전환을 추가하지 않는다. `start-demo-realtime-selftest.mjs`는 창고에서 nvidia와 같은 6초 전진 키 조건을 CPU 1배·3배 감속으로 실행해 실제 WebGL 그리기 횟수·배속·확정/버림·동기 구간·longtask를 기록한다. 별도 고정 카메라의 `gl.finish` 포함 그리기 비용도 측정하며 이 시험용 계측은 앱 번들에 넣지 않는다. 센서 값은 실제 MuJoCo 평지/벽/천장 시험으로 확인하며, 보행 성공 판정은 포함하지 않는다.

## nvidia-demo

앱 시뮬 모드 id·메뉴 이름은 `nvidia-demo`이며, 옛 URL 값 `foothold-v2`는 별칭으로 받는다. 원본 모델·파일 이름과 해시는 유지한다.

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
**«foothold-v2 · 기본 계산 사용: ONNX 파일 없음 (f32 JS) · 시뮬 전용»**.
서버는 없는 ONNX 파일에도 SPA fallback으로 HTTP 200 `text/html`을 줄 수 있으므로,
이 응답은 SHA 검사 전에 모델 부재로 처리한다. HTTP 404 호스트는 이유에 `(404)`도 표시한다.
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

### APK: 빌드만 실행 (설치·배포 없음)

최종 실행 코드/자산 복사 기준은 `126bdfd6b2e670c312a464f49cd74c96e16cfed8`이며
아래 두 APK의 `SOURCE.json.mobile_rev`가 이 커밋, `dirty=false`임을 확인했다.
같은 소스·dev variant에서 기존 AME-2 ONNX+공통 WASM 포함 번들을 기준으로,
foothold-v2 ONNX를 추가했을 때의 차이다. 공통 ORT를 모델마다 중복해서 담지 않는다.

| APK 내용 | bytes |
|---|---:|
| 기존 f32 둘 + AME-2 ONNX + 공통 WASM | 33,809,882 |
| 위 내용 + foothold-v2 ONNX | 34,879,427 |
| 증가 | **1,069,545 (+1.020 MiB)** |

추가 ONNX 원본 1,146,973 bytes, APK 압축 1,069,356 bytes다. 나머지 차이는 SOURCE 메타데이터와
ZIP 구조다. 두 APK의 f32/ONNX 파일 SHA를 `SOURCE.json` 및 선언과 대조했다.
`testDevUnitTest assembleDev`는 둘 다 통과(각95 tasks, 마지막 빌드18초/16초),
앱 단위시험 **16개·실패/오류/건너뜀 0**이다. Gradle `--no-daemon --max-workers=1`
`-Dorg.gradle.jvmargs=-Xmx512m`으로 브라우저 종료 뒤 순차 실행했다.
Capacitor 의존성은 기존 설치를 재사용/로컬 복사했고 전체 mobile node_modules를 설치하지 않았다.
마지막 자산 복사 일반화는 어댑터의 f32/선택 manifest/ONNX를 실제 복사해 SHA와 SOURCE를 확인했고,
이후 위 APK 두 개를 다시 빌드했다. 전체 selftest 이후 실행 코드 변경은 없고 패키징만 일반화했다.
실폰·에뮬레이터에서 APK를 실행하지 않았으며 versionCode/설치본/배포물을 바꾸지 않았다.
최종 PR head에는 이 기록의 문서 변경만 추가된다. APK/자산 상세는 로컬 `runs/policy-onnx/apk-size.json`이다.

```sh
if (cd mobile && node node_modules/@capacitor/cli/bin/capacitor sync android); then :; else exit 1; fi
if (cd mobile/android && ./gradlew --no-daemon --max-workers=1 -Dorg.gradle.jvmargs=-Xmx512m testDevUnitTest assembleDev); then :; else exit 1; fi
```

### PR #227 검토 r1: SPA의 HTTP 200 HTML 응답

없는 모델에 `text/html; charset=utf-8`·HTTP 200을 주는 응답은 SHA 검사 전에
«ONNX 파일 없음»으로 처리한다. headless fixture로 두 정책의 이 응답·배지·동일 어댑터
f32 전환을 확인하고, foothold-v2의 명령 반응/이동도 확인했다. `policy-onnx-headless.mjs --ui-only`
전체(기존 수명주기·7종 실패 전환·명시적 f32 포함), `start-selftest.mjs`, 변경 JS 구문 검사를
재실행해 통과했다. ONNX/가중치/수치 계산은 바꾸지 않았고 parity·APK 빌드는 이 수정에서
반복하지 않았다. 실제 Caddy/원격 서버·운영 포트·실폰은 접촉하지 않았다.

### 서버 웹 ONNX 패키징 (2026-11-02)

`deploy/prepare_sim.py`는 위 두 정책의 ONNX를 출처 SHA로 확인하여 선택적으로
`dist/sim/`에 복사한다. 공유 런타임은 `mobile/package-lock.json`에 고정된
`onnxruntime-web@1.31.1`이며 기존 WASM APK에서 추출한 동일 파일을 사용한다.
`mobile/scripts/sync-web.mjs`의 기본 WASM 파일 목록과 같다. 버전 갱신·다운로드·
WebGPU/asyncify 추가는 하지 않는다.

| `ort/` 안 파일 | bytes | SHA-256 |
|---|---:|---|
| `ort.wasm.min.mjs` | 53,725 | `c21d9c326d453a4a61398270c804d5979e118540597cb0c07f7b3d64e6098234` |
| `ort-wasm-simd-threaded.mjs` | 24,738 | `30ed0b5cd1182ede931fea448afb567d4dc705ec957af09f108a2be5f770dac3` |
| `ort-wasm-simd-threaded.wasm` | 14,848,852 | `4b884c203b0fa48d057be3332c65513ff85aa3c5bddd6946acc0fab7ecda001d` |

모델 누락·SHA 불일치는 해당 ONNX만 생략한다. 런타임 누락·SHA 불일치는
`ort/` 전체를 생략한다. 두 경우 모두 경고하며 기존 f32 시뮬은 유지하고,
브라우저의 같은 정책 f32 전환과 이유 배지를 사용한다. 링크·특수파일·경로/소유권
위반은 기존처럼 준비를 중단한다. 자산 원물은 Git에 넣지 않는다.
이 패키징 변경의 원격 배포·서비스 전환 및 배포 후 브라우저 확인은 별도 관문이다.

## 팀 인계 v0.3: 다중 출력·상태·bool 실행기 (2026-11-03)

`loadOnnxPolicy`는 계약의 모든 출력을 `{출력 이름: 소유한 TypedArray}`로 반환한다.
Worker도 같은 묶음과 모든 고유 출력 버퍼를 전송한다. 입력과 예열은 계약 자료형을 따르며
bool `[1]`은 Uint8Array/ORT bool tensor다. `withPolicyState`가 계약 `state` 쌍의
리셋 0과 되먹임을 담당하고, `sim.js`의 `applyAction`에서만 `policy.commit(outputs)`를 호출한다.
추론 재호출은 확정 상태를 바꾸지 않는다. 취소·리셋·세대 변경·중복 확정 결과는 버린다.
모드 관측은 복제한 memory 후보를 받고 `inputs(s, candidate, obs)`로 입력 묶음을 만들 수 있다.
행동 적용 전까지 history/depth 후보를 확정하지 않으며 `reset(memory)`/`commit(memory,s,outputs)`
고리를 제공한다. start 모드 등록·관측/깊이 구현은 후속 범위다.

Node 22.23.2 / onnxruntime-node 1.31.1 CPU 1 thread,
Chrome 154.0.8037.97 / onnxruntime-web 1.31.1 WASM 1 thread에서
받은 벡터 각각 20스텝을 앱 실행기 그대로 실행했다. start는 기록된 hidden state를 쓰지 않고
앱의 확정 출력만 되먹였고, 모든 출력 크기·유한값과 bool·리셋·동일 스텝 재호출을 확인했다.

| 벡터 | Node 행동 최대 차 | Chrome main | Chrome Worker |
|---|---:|---:|---:|
| start reconstruction | 1.90734863e-6 | 4.05311584e-6 | 4.05311584e-6 |
| start gt | 1.66893005e-6 | 2.26497650e-6 | 2.26497650e-6 |
| start off | 1.90734863e-6 | 1.43051147e-6 | 1.43051147e-6 |
| ame2 gt | 1.59442425e-6 | 1.51991844e-6 | 1.51991844e-6 |

모든 행동 최대 차가 `1e-4` 이하다. ame2 f32 최대 차는 양 환경 `1.19209290e-6`(판정 없음).
시험은 벡터의 모델 SHA와 실제 파일 SHA를 먼저 대조하며 필수 경로가 없으면 오류로 멈춘다.

```sh
# Node >=22로 실행한다(브라우저 시험의 Playwright는 Node >=20 필요).
# 각 변수는 보유한 외부 묶음/의존성을 가리킨다. FH_ORT_WEB는 ORT Web dist 폴더.
# FH_START_SRC, FH_AME2_SRC, FH_AME2_F32_SRC, POLICY_ORT_NODE, FH_ORT_WEB,
# FH_PLAYWRIGHT 필수; POLICY_VECTOR_REPORT는 선택적 로컬 JSON 출력 경로.
node mobile/scripts/policy-vector-selftest.mjs
```

기존 foothold-v2 f32의 5지도·각 300틱(6초) 관절/위치/속도/토크 궤적은
`height-walk-selftest.mjs`의 기준 소스와 비트 동일했다. 이는 수치 회귀 기록이며 보행 판정은 아니다.
엔진 기본은 `main.js`의 `DEFAULT_POLICY_BACKEND` 상수 하나로 관리하며 ONNX 전환은 별도 커밋이다.
되돌림 시 항상 **«<모드> · JS f32 되돌림 중 · 사유»**를 표시한다.
서버의 새 자산 배치는 승인 후 별도 작업이며, 새 ONNX가 없어도 `prepare_sim`은 실패하지 않는다.

새 실행기의 foothold-v2 Node ONNX↔f32 물리 비교는 기존 5지도 각 300틱(6초)에서
위치 최대 차 `1.32469082e-7 m`, 관절 최대 차 `1.88950233e-6 rad`였다.
`policy-state-selftest.mjs`는 실제 MuJoCo `applyAction`을 통해 feedback/history 확정,
시간 초과·취소·STOP·리셋 뒤 후보 폐기와 hidden state 0을 확인했다.
AME-2 train-match/sim, height-scan, frame-clock, scenario, sim-no-fall 회귀와
양 어댑터 비동기 취소·리셋·dispose 시험도 통과했다. AME-2의 연속 궤적 차이는
[AME-2 출처 기록](AME2-PROVENANCE.md)의 별도 수치를 따른다.

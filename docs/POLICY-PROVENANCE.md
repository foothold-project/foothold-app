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

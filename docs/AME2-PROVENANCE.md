# AME-2 teacher → 앱용 f32 출처 기록

2026-10-29. 기준 `origin/dev` = `f15a701`(원격 fetch 후 확인).
[변환 스크립트](../mobile/scripts/ame2_export.py)가 받은 학습 코드를 **텍스트로만 읽고**
다시 작성한 CPU torch actor와 NumPy actor를 대조했다.
학습 코드 import·실행 없이 `torch.load(..., map_location="cpu", weights_only=True)`가 성공했다.
이는 두 재구현과 바이트 내보내기의 검증이며, 원래 학습 actor를 실행한 대조나 보행 성공 평가는 아니다.

## 출처 사슬과 도구

`model_14999.pt` → `actor_state_dict`(strict load) → C 순서 float32 LE 연결
→ `ame2_actor.f32` + `ame2_actor.json`(배치표·계약) + `check.json`(입력·출력·대조).
모든 산출물은 로컬 `runs/ame2-export/out/`에만 보관하고 커밋하지 않는다.

| 대상 | bytes | SHA-256 |
|---|---:|---|
| 원본 model_14999.pt | 100,274,078 | `8c3be365eeddd136edda31988df7fed96ad6f9f92713490b2d993037bf978d4d` |
| ame2_actor.f32 | 5,007,976 | `28edbc05169b817044c600d90cc081bb797ae56c5b8400b8ffebf648410d26a0` |
| ame2_actor.json | 로컬 배치표 | `92ddf3db0b36582b72d9e136e2749a2edf21dbc4156875ecf603c36dc3711fe7` |
| check.json | 로컬 원시 대조 | `20df46ed6dc53b23e763c5da5fed560fa926517192b02ba812e141f8d27eaf26` |

Python **3.12.3**, torch **2.15.0+cpu**(`torch.version.cuda=null`), NumPy **2.5.4**,
CPU 단일 torch 스레드, `OPENBLAS_NUM_THREADS=1`, `python -I`, 최적화 `-O` 금지.
최초 변환에서는 CPU wheel 인덱스로 venv에 torch를 설치하고 NumPy만 추가했다. 11-02 ONNX 후속 작업은 아래 별도 기록을 따른다.
설치 전 `/` 여유 **6.9GB**, 설치 후/대조 후 **5.9GB**로 중단선 1.5GB 이상이었다.

원본 checkpoint의 키는 `actor_state_dict`, `critic_state_dict`, `optimizer_state_dict`,
`iter`, `infos`, `go2_env_state`이며 `iter=14999`다. 받은 README의 누적 학습 횟수는
제공자 설명이며 이번 실행으로 입증한 값은 아니다.
checkpoint 전체 **369개 텐서와 숫자 scalar의 유한값 검사를 통과**했고,
actor **41개 텐서 전부 float32**, strict missing/unexpected **0/0**이다.
숫자 가중치는 1,251,994개이며 이 중 `log_std` 12개는 결정적 순전파에 쓰지 않는다.

텍스트 근거 해시(받은 파일의 상대 경로, 실행하지 않음):

| 파일 | SHA-256 |
|---|---|
| rsl_rl/rsl_rl/models/AME2_models.py | `d88276b1a9cac8c676828af7991f50c7515726245210f5f6c09ae34c4466d14d` |
| rsl_rl/rsl_rl/modules/ame2_modules.py | `b3fc6b38073b085299c9e622e1c1a6e86126d94ae488d5485e7853e7841a8a2c` |
| rsl_rl/rsl_rl/algorithms/ppo.py | `f1c4b73cb132078e5e594ed04690533b3c296178604f1b12657100f75bb622f9` |
| go2/ame2_go2/tasks/mdp/observations.py | `02aca54ea3e5716fd0faacec5b6d54e592b89fd0841c73de1732e98fc140fee6` |
| go2/ame2_go2/tasks/mdp/actions.py | `792b74d38c4cb1abe2350d63c18a20d96fb3414d8c8f1a525c63bb1b488bf756` |
| go2/ame2_go2/tasks/go2_env_cfg.py | `58342b6abedc758e42ec0878a2ffedde2f74440c8277139a1ab93bb75e9f7ded` |
| params/agent.yaml | `ec7e4bd09c96c3a097d91218847b8c19c4c08b6c660d4a8e4d10296916d5cc90` |
| params/env.yaml | `08b815230d30f6d86e45913f39f8a818ab40cacbf40303cbc597623054ad4e65` |

배치표에는 변환 스크립트 SHA-256도 기록되어 같은 실행 소스를 식별한다.
텍스트 해시는 출처 기록이며 임의의 다른 코드판과의 의미적 호환성을 자동 보증하지 않는다.

## 구조 대조

근거 M=`AME2_models.py`, U=`ame2_modules.py`, O=`observations.py`, E=`params/env.yaml`, A=`params/agent.yaml`.
M:411–503의 생성 순서·크기와 실제 41개 키가 맞는다. M:589–618,1285–1338의 결정적 계산을 재구성했다.

1. 전체 `[B,29,13,3]` 지도의 xyz를 Conv2d 3→8, k3/d1/p0 → ELU →
   Conv2d 8→32, k3/d2/p0 → ELU로 읽고 공간축 max → Linear 32→64 → ELU로 만든다.
2. 상태 49→512→512→128 MLP의 두 은닉층만 ELU. global64와 prop128 순으로 연결한
   192→64→2 gaze head(은닉 ELU) 뒤 sigmoid를 취한다.
3. `cx=5.5+17*r_x`, `cy=4.5+3*r_y`.
   `ox=clip(round(cx-5.5),0,17)`, `oy=clip(round(cy-4.5),0,3)`이며 round는 **ties-to-even**.
   `(ox+i)*13+oy+j`로 원래 지도에서 12×10을 gather한다. 보간·높이 평균 없음.
   학습 STE의 `hard+(soft-soft.detach())`는 유한값 추론에서 hard와 같으므로 soft 경로를 실행하지 않는다.
4. crop xyz는 Linear 3→16 → ELU, z만 Conv2d 1→8→48(각 k5/p2/d1, zero padding, 각 ELU).
   두 결과를 `[FC16,CNN48]`로 연결 → Linear 64→96 → ELU → 120개 토큰.
5. `[prop128,global64]` → MLP 192→512→512→96이 query 1개를 만든다.
   MHA는 96차원/32 heads/**head당3**, Q/K/V 순서로 in_proj를 자른다.
   `softmax(QKᵀ/sqrt(3))V` → head 연결 → out_proj 96→96.
   torch는 독립 재작성한 모듈에서 `nn.MultiheadAttention` math backend,
   NumPy는 QKV·head 분할·최댓값을 뺀 softmax를 직접 계산한다(U:7–17).
6. `[attn96,prop128,global64]` → 288→512→512→12 MLP. 두 은닉층만 ELU,
   마지막 선형 출력이 raw action mean이다(M:102–139). 모든 ELU α=1.
   정규화·LayerNorm·BatchNorm·추론 dropout·RNN·상태 이력은 없다(A:6, M:229–230, E:1320).

## 입력·출력 계약

배치표 JSON의 `contract`가 앱 후속 작업용 계약이다. 두 입력은 별도 텐서이며 합쳐 넣지 않는다.

| 입력 | 0부터의 칸 | 단위·의미 |
|---|---|---|
| teacher_prop | 0–2 / 3–5 / 6–8 | 몸 선속도 m/s / 몸 각속도 rad/s / 몸에서 본 아래 방향 단위벡터 |
| teacher_prop | 9–20 / 21–32 / 33–44 | 기본각 대비 관절각 rad / 관절속도 rad/s / 직전 raw action(±50 clip) |
| teacher_prop | 45–48 | yaw 좌표 목표 x,y(m), sin(yaw 오차), cos(yaw 오차); 중립 `[0,0,0,1]` |
| teacher_mapping | `[B,29,13,3]` | C 순서; x 바깥/y 안쪽; 마지막 xyz(m) |

추가 배율·정규화 없음. 목표 거리는 길이2m로 제한하고 더 멀면 목표 yaw가 정책 스텝마다 무작위다(O:296–340).
지도 격자는 `x=-0.42+0.06*i`, `y=-0.36+0.06*j`, yaw만 따라 회전한다.
z는 `hit_world_z-body_sensor_z+0.27m`를 ±1.5m로 자르고 학습 잡음을 더한다(O:160–222).
변환기는 이미 만든 관측을 받으며 센서·잡음·무반사·목표 생성기는 포함하지 않는다.

E:1583–1600의 원문 `scale: 0.25`, `use_default_offset: true`에 따라
**관절 목표각 = 기본 관절각 + 0.25 × raw action**이다. 스크립트는 raw action까지만 출력한다.
11-02 팀원 학습 코드(nogapst5_vmax12_to15000)와 `model_14999`를 대조했다.
`go2_env_state.critic_contract.joint_names`는 FL/FR/RL/RR hip → thigh → calf로,
기존 `AME2_JOINT_ORDER`와 같다(`go2/ame2_go2/algorithms/go2_runner.py:431,554`).
새 export는 이 이름 목록을 기록하며, 목록이 없는 체크포인트만 미확인으로 남긴다. 기존 f32와 외부 배치표는 덮어쓰지 않았다.
actor의 TeacherPropCfg는 49칸이고 시간 입력이 없다. `time_left`는 CriticCfg 전용이다
(`go2/ame2_go2/tasks/go2_env_cfg.py:170–180,218–235`). 항목별 대조는
[학습 계약 점검](../mobile/scripts/ame2-training-contract.md)을 본다.

## 실제 actor 키·shape·dtype·배치

아래 offset은 bytes다. JSON에는 각 텐서의 bytes와 SHA-256도 있다.
Linear는 `[out,in]`, Conv는 `[out,in,kx,ky]`이며 모두 C 순서 little-endian float32다.
`log_std`를 포함하므로 기존 foothold-v2 로더가 그대로 읽을 수 있는 형식은 아니다.

| 키 | shape | dtype | offset |
|---|---|---|---:|
| `log_std` | `[12]` | float32 | 0 |
| `fc_part.0.weight` | `[16,3]` | float32 | 48 |
| `fc_part.0.bias` | `[16]` | float32 | 240 |
| `cnn_part.0.weight` | `[8,1,5,5]` | float32 | 304 |
| `cnn_part.0.bias` | `[8]` | float32 | 1104 |
| `cnn_part.2.weight` | `[48,8,5,5]` | float32 | 1136 |
| `cnn_part.2.bias` | `[48]` | float32 | 39536 |
| `local_proj.0.weight` | `[96,64]` | float32 | 39728 |
| `local_proj.0.bias` | `[96]` | float32 | 64304 |
| `prop_encoder.net.0.weight` | `[512,49]` | float32 | 64688 |
| `prop_encoder.net.0.bias` | `[512]` | float32 | 165040 |
| `prop_encoder.net.2.weight` | `[512,512]` | float32 | 167088 |
| `prop_encoder.net.2.bias` | `[512]` | float32 | 1215664 |
| `prop_encoder.net.4.weight` | `[128,512]` | float32 | 1217712 |
| `prop_encoder.net.4.bias` | `[128]` | float32 | 1479856 |
| `global_cnn.0.weight` | `[8,3,3,3]` | float32 | 1480368 |
| `global_cnn.0.bias` | `[8]` | float32 | 1481232 |
| `global_cnn.2.weight` | `[32,8,3,3]` | float32 | 1481264 |
| `global_cnn.2.bias` | `[32]` | float32 | 1490480 |
| `global_proj.0.weight` | `[64,32]` | float32 | 1490608 |
| `global_proj.0.bias` | `[64]` | float32 | 1498800 |
| `gaze_head.0.weight` | `[64,192]` | float32 | 1499056 |
| `gaze_head.0.bias` | `[64]` | float32 | 1548208 |
| `gaze_head.2.weight` | `[2,64]` | float32 | 1548464 |
| `gaze_head.2.bias` | `[2]` | float32 | 1548976 |
| `query_mlp.net.0.weight` | `[512,192]` | float32 | 1548984 |
| `query_mlp.net.0.bias` | `[512]` | float32 | 1942200 |
| `query_mlp.net.2.weight` | `[512,512]` | float32 | 1944248 |
| `query_mlp.net.2.bias` | `[512]` | float32 | 2992824 |
| `query_mlp.net.4.weight` | `[96,512]` | float32 | 2994872 |
| `query_mlp.net.4.bias` | `[96]` | float32 | 3191480 |
| `mha.in_proj_weight` | `[288,96]` | float32 | 3191864 |
| `mha.in_proj_bias` | `[288]` | float32 | 3302456 |
| `mha.out_proj.weight` | `[96,96]` | float32 | 3303608 |
| `mha.out_proj.bias` | `[96]` | float32 | 3340472 |
| `output_mlp.net.0.weight` | `[512,288]` | float32 | 3340856 |
| `output_mlp.net.0.bias` | `[512]` | float32 | 3930680 |
| `output_mlp.net.2.weight` | `[512,512]` | float32 | 3932728 |
| `output_mlp.net.2.bias` | `[512]` | float32 | 4981304 |
| `output_mlp.net.4.weight` | `[12,512]` | float32 | 4983352 |
| `output_mlp.net.4.bias` | `[12]` | float32 | 5007928 |

## assert 대조 결과

NumPy는 내보낸 f32 바이트를 다시 해석한 배열로 계산하고 torch는 strict-load한 actor로 계산했다.
저장 후 파일을 다시 읽어 모든 텐서·전체 바이트가 정확히 같은지도 확인했다.
seed **20261029**, NumPy default_rng/PCG64, 무작위 상태 N=64 및 높이 U(-1.5,1.5).
난수 사례는 수치 일치용이며 물리적으로 가능한 상태나 성공한 보행 사례가 아니다.

| 입력군 | N | torch ↔ NumPy 최대 절대 행동 차 |
|---|---:|---:|
| 모두0(지도 xyz도0) | 1 | 2.8312206268310547e-7 |
| 중립 목표·중력 z=-1·평면 격자 | 1 | 2.384185791015625e-7 |
| 고정 난수 상태·기복 지도 | 64 | **5.781650543212891e-6** |
| crop 끝·반정수·인접 float32 | 208 | 1.430511474609375e-6 |

총274건, 모든 출력 유한, crop offset 전부 동일, `atol=1e-4, rtol=0` assert 통과.
경계208건은 학습 gaze로 정확한 반정수를 만들었다는 뜻이 아니라 **중간 center를 주입**해
두 순전파의 crop/후속 CNN/attention/행동을 비교한 것이다. 끝점 밖 clamp도 포함한다.
별도로 .5→0, 1.5→2, 2.5→2, 16.5→16의 기대 offset을 고정해 양쪽 round 함수를 검사했다.
주입 없는66건은 학습 gaze를 그대로 사용한다. 원시 입력·center·offset·양쪽 출력은 `check.json`에 있다.
앱 전체 기존 검사 `npm --prefix mobile run selftest`: **4 통과·18 거부 PASS**.

## 재현

저장소 루트에서 실행한다. `AME2_CHECKPOINT`, `AME2_SOURCE`, `AME2_PARAMS`, `AME2_RUN`
환경변수는 로컬 보유 자료와 지정된 `runs/ame2-export`를 가리키며 개인 경로는 커밋하지 않는다.
기존 출력 파일은 덮어쓰지 않는다. 재실행은 새 상위 경로 아래 `runs/ame2-export/out`을 택하거나
이전 산출물을 해당 out 안에서 별도 이름으로 보존한 뒤 실행한다.

```sh
df -h /
python3 -m venv "$AME2_RUN/venv"
"$AME2_RUN/venv/bin/python" -I -m pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu
"$AME2_RUN/venv/bin/python" -I -m pip install --no-cache-dir numpy
df -h /
OPENBLAS_NUM_THREADS=1 "$AME2_RUN/venv/bin/python" -I mobile/scripts/ame2_export.py \
  "$AME2_CHECKPOINT" --source-root "$AME2_SOURCE" --params "$AME2_PARAMS" \
  --out "$AME2_RUN/out" --check
npm --prefix mobile run selftest
```

`weights_only=True`가 실패하면 원문 오류를 보고하고 중단한다. `weights_only=False` 재시도,
safe globals 추가, 받은 코드 import, 데이터 폴더를 작업 디렉터리로 삼는 실행은 하지 않는다.

## 남은 범위

**실기 불가: 교사가 참 높이지도를 읽음**. 실행 당시 학습 도구판·
원래 actor 실행과의 일치·라이선스/재배포 범위·실기 센서 지도·폰 속도/발열·목표 도착/정지는 미확인이다.
JS 순전파·앱 어댑터·ONNX·앱 빌드·실폰·실기·Gazebo·서버·배포·보행 성공 평가는 하지 않았다.
이 PR은 변환 스크립트와 출처 문서만 제공한다. 통합 후 되돌림은 해당 커밋의 `git revert`이며
앱 가중치나 운영 배포물을 교체하는 작업은 포함하지 않는다.

## ONNX 추론 (2026-11-02)

기준은 `origin/dev` 91c20b3이며 시뮬 전용이다. 같은 체크포인트의 actor만 우리
`ame2_export.py`에서 재구성해 FP32 deterministic mean으로 내보냈다.
기존 CPU venv의 Python 3.12·PyTorch 2.15.0+cpu·NumPy 2.5.4에 공식 PyPI의
`onnx==1.20.1`(protobuf 7.36.2, ml_dtypes 0.6.0)을 추가했다.
실행은 `runs/ame2-export/venv/bin/python -I`였고, 체크포인트는
`torch.load(weights_only=True, map_location='cpu')`로만 읽었다.
받은 학습 코드는 텍스트 hash/검토만 했으며 import·실행·복사하지 않았다.

| 항목 | 값 |
|---|---|
| actor ONNX | 5,028,942 bytes, opset 17, 고정 B=1, FP32 |
| SHA-256 | `398acb0c73369e84946a34c0109bca1edd0560cc14ee286fd36b9caf7e2da69b` |
| 체크포인트 SHA-256 | `8c3be365eeddd136edda31988df7fed96ad6f9f92713490b2d993037bf978d4d` |
| 입력 | `prop[1,49]`, `mapping[1,29,13,3]`, 각각 float32 |
| 출력 | `action[1,12]` 평균, `offsets[1,2]` int64, `gaze_logits[1,2]` float32 |
| 검사 | ONNX full checker 통과, 외부 tensor 파일 없음, 학습 파라미터 FP32 |
| 계약 | 관측 49·관절 순서·행동 지연·높이 ray·목표 clip 변경 없음 |

`log_std`·critic·샘플링은 그래프에 없다. 208개 crop 경계/ties-to-even fixture는
별도 `ame2_actor_crop_test.onnx`로 검사하고 앱에 복사하지 않는다.
`--onnx --check`는 기존 f32 export와 ONNX를 함께 만들고,
`--onnx-only`는 f32를 덮어쓰지 않고 ONNX만 만든다. 모든 export는
`runs/ame2-export/out/`에만 새 파일로 쓰며 기존 파일은 교체하지 않는다.
기록 관측의 PyTorch 출력은 `--references-only --observations <기록 JSON>`으로 생성한다.

동일 입력 대조 기준은 **모든 출력 유한값, crop offset 일치, 최대 절대오차 ≤1e-4**다.
최대 상대오차는 `abs(a-ref)/max(abs(ref),1e-6)`로 별도 보고하며 독립 합격 기준으로 쓰지 않는다.
고정 274건은 zero/neutral/random64/crop 경계 208건이고, 실제 관측 72건은
아래 여섯 지도 f32 궤적에서 25틱마다 얻었다. Node는 `onnxruntime-node@1.31.1` CPU 1 thread,
브라우저는 `onnxruntime-web@1.31.1` WASM 1 thread다.

| 환경·입력 | PyTorch↔JS 최대 abs / rel | PyTorch↔ONNX 최대 abs / rel | JS↔ONNX 최대 abs / rel |
|---|---|---|---|
| Node 고정 274 | 6.199e-6 / 1.323e-4 | 5.722e-6 / 3.297e-4 | 4.768e-6 / 4.621e-4 |
| Node 실제 72 | 2.384e-6 / 2.862e-4 | 5.245e-6 / 3.339e-4 | 4.768e-6 / 6.198e-4 |
| Chrome WASM 고정 274 | 6.199e-6 / 1.323e-4 | 7.153e-6 / 8.789e-4 | 5.960e-6 / 8.972e-4 |
| Chrome WASM 실제 72 | 2.384e-6 / 2.862e-4 | 6.199e-6 / 3.339e-4 | 4.053e-6 / 6.198e-4 |

브라우저 궤적 대조는 PC headless Chrome 154.0.8037.97·MuJoCo에서
지도 기본 spawn·기본자세 hold .5초 후, 두 엔진에 같은 가까운 목표를 2초마다
`[1,0,0,1]` → `[.5,.3,sin(.2),cos(.2)]` → 중립으로 주었다.
각 엔진·지도·지연마다 300틱(6초), 지연 0과 4를 고정해 reset 난수 차이를 제거했다.
학습 지형은 기본 spawn인 가장 쉬운 stair 타일 하나이며 다른 타일·seed·장시간은 미검증이다.
아래는 WASM 대비 f32의 시간별 최대 차이다. quaternion은 부호 동치를 보정한 성분 차,
gravity는 몸 기준 아래 방향 성분 차다. 보행 «성공» 기준이나 합격 판정은 두지 않았다.

| 지도 | delay | 위치 최대 m | 관절 최대 rad | quaternion 최대 | gravity 최대 |
|---|---:|---:|---:|---:|---:|
| factory-inspection | 0 / 4 | 1.59185 / .53056 | 2.77152 / 2.65538 | 1.19510 / .97336 | 1.10485 / 1.99986 |
| factory-inspection-alt1 | 0 / 4 | .09814 / .08171 | 1.21077 / 1.88005 | .24520 / .09899 | .42438 / .19900 |
| factory-zone | 0 / 4 | 1.617e-7 / 2.501e-6 | 2.170e-6 / 5.899e-6 | 1.469e-7 / 1.087e-6 | 3.423e-7 / 1.211e-6 |
| warehouse | 0 / 4 | 1.166e-6 / 6.216e-7 | 2.128e-6 / 2.541e-6 | 4.398e-7 / 2.683e-7 | 2.981e-7 / 5.195e-7 |
| element-course | 0 / 4 | 8.954e-8 / 7.154e-7 | 7.346e-7 / 1.881e-6 | 1.060e-7 / 2.191e-7 | 1.216e-7 / 3.960e-7 |
| ame2-train-terrain | 0 / 4 | .00693 / .01698 | .05728 / 1.96146 | .00879 / .21042 | .01450 / .53664 |

같은 입력의 작은 추론 차이가 여러 틱 뒤 일부 공장 궤적에서 크게 누적됐다.
원인별 분해나 보행 동등성은 미검증이다. Node CPU 비교에서도 공장 위치 차가 최대 1.25133m였고,
원 궤적·자세·72건 관측과 전체 비교값은 로컬 `runs/ame2-onnx/walk-node.json`과
`browser-wasm-walk.json`에 보존한다. 모델·가중치·원 궤적·WASM·APK는 커밋하지 않는다.


실측 추론·메모리와 기본 엔진 선택:

| PC headless Chrome | WASM 1 thread | WebGPU (SwiftShader) |
|---|---:|---:|
| 첫 import·모델 fetch·session·첫 추론 합계 ms | 822.2 | 25,344.3 |
| 첫 추론 ms | 25.5 | 22,175.1 |
| warm 100회 p50 / p95 ms | 2.4 / 4.1 | 314.5 / 447.6 |
| 같은 회차 f32 JS p50 / p95 ms | 8.9 / 15.3 | 15.6 / 30.0 |
| 빈 페이지 → 대조 종료 JS heap MiB | .97 → 14.38 | .97 → 5.14 |
| 빈 페이지 → 대조 종료 backing storage MiB | .00 → 28.38 | .00 → 19.88 |
| 빈 페이지 → 대조 종료 Chrome 전체 RSS 합 MiB | 691.79 → 848.59 | 618.80 → 803.25 |

WASM warm benchmark 직후 JS heap 3.65 MiB·backing storage 15.05 MiB·Chrome RSS 합
896.53 MiB도 표본으로 남겼다. 메모리는 CDP `Runtime.getHeapUsage`와 브라우저가 보고한
프로세스들의 `/proc` RSS 합으로 측정했다. 종료 값에는 fixture·JS 비교·추가 session 메모리가
포함되며, RSS는 공유 페이지 중복 가능성이 있고 GPU 할당만을 분리하거나 peak를 측정한 값은 아니다.
WASM·WebGPU 표본은 같은 시점이 아니고 호스트는 다른 작업과 메모리 압박을 공유했다.
CPU는 i7-10750H, Chrome은 154.0.8037.97, ANGLE SwiftShader와 비교용 unsafe WebGPU 옵션이다.
실제 GPU·실폰 속도/메모리를 뜻하지 않는다. WebGPU 결과는 보존된 첫 실행 기록이며,
이후 잘못된 자산 복사 목록으로 발생한 asyncify 모듈 누락도 기록하고 목록을 고쳤다.

그래프는 Conv·MatMul·Gemm·Softmax·GatherElements·Round·Mod·Slice 등 ONNX 표준 연산
31종이다. 두 EP 설정 모두 전체 그래프 생성과 고정/실제 관측의 action 대조를 실행했다.
WebGPU 고정 입력 PyTorch↔ONNX 최대 abs/rel은 9.537e-6 / 3.906e-4,
실제 관측은 4.292e-6 / 9.300e-4였고, JS↔ONNX는 각각 6.676e-6 / 4.089e-4,
3.815e-6 / 1.216e-3였다. EP 내부의 CPU fallback별 연산 배치는 측정하지 않아
전 연산 GPU 실행으로 주장하지 않는다. 이 환경의 지연과 load 시간으로 **WASM을 기본**으로 골랐다.
WebGPU는 실제 GPU에서 재측정하기 위한 opt-in이며, `FH_AME2_WEBGPU=1`일 때
ORT 1.31.1이 요청하는 `ort.webgpu.min.mjs`와 `ort-wasm-simd-threaded.asyncify.{mjs,wasm}`만 추가한다.


검증 실행 범위와 명령:

- **PC 실행**: 기존 selftest 18개(start, scenario, astar, height-scan, height-walk,
  factory-one, factory-outside, house-look, top-fit, sim-goal, sim-keys, sim-no-fall,
  ame2-network, ame2-sim, ame2-ui, ame2-overhead, ame2-train-match, ame2-train-terrain) 통과.
  로컬 로그는 `runs/ame2-onnx/selftests/`에 보존했다.
- **PC 실행**: Node 고정/기록 입력 대조, 여섯 지도×delay 0/4×300틱 궤적,
  비동기 겹침 차단·clear/reset/dispose 늦은 결과 폐기 통과.
- **PC headless Chrome 실행**: WASM 시뮬·동시 추론 1개, STOP/blur/hidden/pagehide/reset
  즉시 잠금·늦은 결과 폐기, ONNX 파일/ORT 모듈/**wasm** 누락·hash 불일치·run 실패 시
  화면 밖으로 접히지 않는 f32 되돌림 표시와 물리 진행, 명시적 f32 선택 통과.
- WebGPU opt-in 복사 후 세 런타임 파일과 설치 패키지의 byte 일치도 확인했다.
- **APK 빌드만**: `testDevUnitTest assembleDev` 성공(95 tasks, 24초).
  f32만 포함한 APK 24,603,120 bytes → 기본 WASM APK 33,805,116 bytes,
  **+9,201,996 bytes (+8.78 MiB)**. 같은 로컬 dev variant이며 설치/배포하지 않았다.
  추가 ONNX 원본 5,028,942 bytes(APK 압축 4,660,674), ORT wasm 원본
  14,848,852 bytes(압축 4,504,736), 나머지는 mjs·메타데이터·ZIP 구조다.
  WebGPU/asyncify 자산은 기본 APK에 없다. 파일별 크기·SHA는 로컬 `apk-size.json`에 보존했다.
- **미검증**: 실폰 APK·에뮬레이터 실행, 실제 GPU, 장시간/전체 학습 타일/다른 seed,
  실로봇·Gazebo·실기 정책·운영 배포. 보행 성공 판단은 사용자에게 남긴다.

내보내기와 최초 검증은 `91c20b3`의 모바일 소스에 본 변경을 얹어 실행했다.
이후 `origin/dev`의 `3cd1f66`까지 fast-forward했다(그 사이 차이는 deploy 경로뿐).
검증은 미커밋 소스에서 실행했으며 최종 소스 commit은 PR head로 추적한다.

```sh
# 환경: Node >=22; AME2_EXPORT=runs/ame2-export/out;
# AME2_ORT_NODE=로컬 onnxruntime-node@1.31.1 entry;
# FH_SIM_SRC=기존 외부 시뮬 자산; FH_PLAYWRIGHT=playwright-core entry.
# 모델·외부 자산이 있는 작업 폴더에서만 실행. 전체 시험 결과를 if로 검사한다.
if node mobile/scripts/ame2-onnx-parity.mjs; then :; else exit 1; fi
if node mobile/scripts/ame2-onnx-sim-selftest.mjs; then :; else exit 1; fi
if FH_AME2_SRC="$AME2_EXPORT" node mobile/scripts/sync-web.mjs; then :; else exit 1; fi
# --walk: 궤적 포함. --ui-only: 무거운 대조를 재실행하지 않고 실패/수명주기 시험만.
# WebGPU 전체 대조는 AME2_TEST_RUNTIME=1로 설치된 모든 런타임 파일을 시험 서버에 제공.
if AME2_TEST_RUNTIME=1 node mobile/scripts/ame2-onnx-headless.mjs --walk; then :; else exit 1; fi
if node mobile/scripts/ame2-onnx-headless.mjs --ui-only; then :; else exit 1; fi
# 위 Chrome 프로세스가 종료된 뒤 Gradle만 단독 실행한다.
if (cd mobile && npx cap sync android); then :; else exit 1; fi
if (cd mobile/android && ./gradlew --no-daemon --max-workers=1 -Dorg.gradle.jvmargs=-Xmx512m testDevUnitTest assembleDev); then :; else exit 1; fi
```

`dev`에 합치면 서버 자동배포가 실행된다. 서버에 ONNX/ORT 자산이 없고 f32가 있으면
AME-2 선택 시 **f32 되돌림 + 실패 이유**를 지속 표시하고 기존 f32로 실행한다.
f32도 없으면 기존처럼 AME-2 선택을 비활성화한다. 모델/WASM은 커밋하지 않으므로
Git merge만으로 ONNX 자산이 서버에 생기지 않는다. 되돌림 선택은 `ame2Backend=f32`,
코드 되돌림은 본 PR merge의 `git revert`이며 APK/서버 교체는 별도 승인·절차다.


### 공통 실행기 전환 (2026-11-02)

foothold-v2 ONNX 추가와 함께 기존 실행기를 `policy-onnx.js`로 일반화했다.
AME-2 모델 SHA·입력 `prop[1,49]`/`mapping[1,29,13,3]`·출력 이름/차원은
`policy-adapters.js`에서 선언하며 위 그래프와 f32·관측·action/지연 계약은 그대로다.
`ame2-onnx.js`는 기존 내보내기/대조 스크립트의 호환 export를 제공한다.
기본 WASM과 `ame2Backend` 옵션은 유지하고 모든 모델 공통 `policyBackend` 옵션을 추가했다.
되돌림 배지는 **«AME-2 · 기본 계산 사용: 이유 (f32 JS) · 시뮬 전용»**으로 표시한다.
이전 표의 «f32 되돌림»은 당시 문구이며 현재 문구는 위와 같다.
새 모델 절차와 취소/패키징은 [정책 어댑터 §10](spec/11-POLICY-ADAPTER.md#10-새-모델-추가-절차-시뮬-전용),
foothold-v2 수치는 [정책 출처](POLICY-PROVENANCE.md#fp32-onnx-시뮬-추론-2026-11-02)에 있다.

공통 실행기 전환 뒤 기존 모바일 selftest 19개와 AME-2 ONNX Node 고정274/기록72를
재실행했다. 최대 절대오차는 이전 표와 같고 기준 1e-4 이내다. 6지도×delay 0/4×300틱
Node 궤적도 다시 기록했으며 보행 판정은 하지 않았다. 기존 headless WASM UI와 공통
실행기의 두 정책 수명주기·파일/런타임/wasm/SHA/첫 추론/실행 실패 시험도 통과했다.
이번 공통화에서 WebGPU는 재실행하지 않았으며 위 WebGPU 수치는 최초 측정 기록이다.

공통화 최종 코드 `126bdfd`의 dev APK는 기존 AME-2 ONNX+WASM을 유지한 기준
33,809,882 bytes → foothold-v2 ONNX 추가 34,879,427 bytes(+1.020 MiB)였다.
단위시험16개와 빌드만 통과했고 실폰/설치/배포는 하지 않았다. 상세 기준은 정책 출처의 APK 절을 따른다.

## 팀 인계 v0.3: AME-2 새 ONNX (2026-11-03)

정본은 lab main `c34759b6`의 `inbox/jay/20261103-policy-handoff/HANDOFF-APP-DEVELOPER.md`
v0.3이다. `ame2-demo-app/ame2-demo.onnx`는 5,038,171 bytes,
SHA-256 `830595df1e78072c0606b5193d1ba787720ff6777edc7cabe496b8c1a9d25de6`이다.
이 절은 앞의 `ame2_actor.onnx` 계약을 대체한다. 입력은 `prop [1,49]`,
`mapping [1,29,13,3]`, 출력은 `action [1,12]`, `gaze_r [1,2]`, 모두 float32다.
상태 되먹임은 없다. 진단 crop은 `gaze_r`에서
`ox = clamp(round(r0 * 17), 0, 17)`, `oy = clamp(round(r1 * 3), 0, 3)`으로 계산한다.
기본 행동 지연은 리셋마다 0이며 난수로 뽑지 않는다. 명시적 지연 인자는 기존 측정 도구용이다.

f32 가중치 SHA `28edbc05…`와 배치표 SHA `92ddf3db…`는 그대로이며 되돌림 준비 여부만 나타낸다.
선택 메뉴는 실제 backend에 맞춰 판정한다. f32 선택은 f32 파일과 유효한 배치표가 있어야 하며,
ONNX 선택은 새 ONNX 또는 되돌림 f32/배치표 중 하나가 있으면 가능하다.
URL의 `policyBackend`/`ame2Backend`도 실제 계산과 같은 우선순위로 반영한다.
선택된 AME-2의 ONNX가 없으면 같은 정책 f32를 쓰며
화면 아래에 **«AME-2 · JS f32 되돌림 중 · ONNX 파일 없음 …»**을 계속 표시한다.
f32도 없으면 정책을 잠그고 사유를 표시한다. 다른 정책으로 자동 전환하지 않는다.
`FH_AME2_SRC`는 새 묶음, 선택적인 `FH_AME2_F32_SRC`는 기존 f32/배치표 폴더를 가리킨다.
ONNX와 시험 벡터는 Git에 넣지 않는다.

`policy-vector-selftest.mjs`의 20스텝 행동 최대 차는 Node CPU `1.59442425e-6`,
Chrome WASM main/Worker 각각 `1.51991844e-6`이다(허용차 `1e-4`).
같은 벡터와 기존 f32의 최대 차는 Node/Chrome 각각 `1.19209290e-6`이며 측정값만 기록한다.
서버 복사·배포·실폰·실로봇 시험은 하지 않았다. 서버 승인 후 배포 자산 입력 루트에
`ame2-demo.onnx`와 기존 `ort/` 검증 파일 셋을 준비해야 한다. 서버 기본 입력 루트는
`/var/lib/foothold/sim-policy/`이며 원격 복사는 이번 작업에서 하지 않는다.
`deploy/prepare_sim.py`는 새 ONNX 부재·SHA 불일치 시 경고하고 기존 시뮬 패키징을 계속한다.

추가 Node 물리 비교는 6지도 각 300틱(6초), 명시적 지연 0/4의 12쌍을 기록했다.
기본 지연 0인 factory-inspection에서 f32↔새 ONNX 위치 최대 차 `1.25133012 m`,
관절 최대 차 `2.51822137 rad`였으며 전체 12쌍의 최대도 이 값이다.
같은 지연 0의 warehouse는 `5.14280933e-7 m`/`1.02974686e-6 rad`,
ame2-train-terrain은 `0.00744128 m`/`0.05754055 rad`였다.
모든 상태는 유한했지만 연속 궤적의 수치 동일성은 확인되지 않았다.
벡터 허용차 통과와 이 궤적 측정은 별개이며 f32 보행 동등성이나 보행 성공을 판정하지 않는다.

REVIEW-267 B1은 선택 판정과 실행이 같은 backend 해석을 쓰도록 고쳤다.
`policy-availability-selftest.mjs`는 `ab997e0`의 상수 한 줄만 역적용한 f32 기본값 fixture와
ONNX 기본값을 각각 headless로 실행했다. ONNX만/f32만/둘 다/둘 다 없음의 8조합과
명시적 backend override 2건이 통과했다. f32 기본은 f32/배치표가 있어야 선택 가능하며,
ONNX 기본은 ONNX 또는 되돌림 f32/배치표가 있으면 선택 후 물리가 진행됐다.
ONNX 부재로 f32 되돌림을 쓰는 경우 화면의 지속적인 사유 표시도 확인했다.
기본값 전환 커밋은 여전히 상수 한 줄이며 역적용 검사도 통과했다.

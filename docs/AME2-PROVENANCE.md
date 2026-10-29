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
CPU wheel 인덱스로 venv에 torch를 설치했고 NumPy만 추가했다. ONNX는 선택 범위로 생략했다.
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
이름으로 정한 관절 순서는 받은 USD 자산이 없어 **미확인**이고 JSON의 `joint_names=null`이다.
시간 입력은 **미확인으로 유지**한다. 위 49칸 설정에 독립 시간 항목이 없다는 정적 관찰을
소유자가 의도한 시간 입력 계약 확정으로 대체하지 않는다.

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

**실기 불가: 교사가 참 높이지도를 읽음**. 관절 이름 순서·시간 입력 계약·실행 당시 학습 도구판·
원래 actor 실행과의 일치·라이선스/재배포 범위·실기 센서 지도·폰 속도/발열·목표 도착/정지는 미확인이다.
JS 순전파·앱 어댑터·ONNX·앱 빌드·실폰·실기·Gazebo·서버·배포·보행 성공 평가는 하지 않았다.
이 PR은 변환 스크립트와 출처 문서만 제공한다. 통합 후 되돌림은 해당 커밋의 `git revert`이며
앱 가중치나 운영 배포물을 교체하는 작업은 포함하지 않는다.

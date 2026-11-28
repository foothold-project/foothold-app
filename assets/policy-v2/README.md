분류: 자산 · 보관용 정책 (nvidia-demo)
작성: 2026-11-28
근거: 운영 결정 2026-11-28 (policy_v2 는 저장소에 올리기만 하고 앱에서 쓰지 않음) · docs/POLICY-PROVENANCE.md
요지: policy_v2.onnx · policy_v2.f32 를 보관만 한다. prepare_sim · compose · 웹 시뮬 · 모델 고르기 · 서버 어디서도 이 폴더를 읽지 않는다
상태: 보관. 쓰려면 따로 결정한다

출처: foothold-app 의 docs/POLICY-PROVENANCE.md 에 적힌 SHA-256 과 같은 파일이다 (f32 는 npz_to_f32.py, ONNX 는 mobile/scripts/policy_v2_onnx.py 로 만든 것). 확인은 `sha256sum -c SHA256SUMS`.

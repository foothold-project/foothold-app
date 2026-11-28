분류: 자산 · 시뮬 정책 ONNX
작성: 2026-11-28
근거: 운영 결정 2026-11-28 (정책 ONNX 를 앱 저장소에 둠) · docs/POLICY-PROVENANCE.md · docs/AME2-PROVENANCE.md
요지: 자산 묶음에 같은 이름의 파일이 없을 때 deploy/prepare_sim.py 가 SHA256SUMS 와 고정 SHA 를 확인해 쓰는 정책 세 개
상태: ame2-demo · start-m15500 map_on · map_off. MuJoCo · onnxruntime · Go2 모형은 여기 없고 자산 묶음에서 받는다. policy_v2 는 assets/policy-v2 에 보관만 하고 쓰지 않는다

출처: 공개 저장소 foothold-project/foothold-lab 의 `inbox/jay/20261103-policy-handoff` (ame2-demo-app · start-m13000-app) 와 SHA-256 이 같은 파일이다. 확인은 `sha256sum -c SHA256SUMS`.

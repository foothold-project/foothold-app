# API v1 계약

`models.py`의 Pydantic v2 모델이 정본이다. 범위는 API 명세 §1.4 오류,
§2 인증·계정, §3 로봇 요약, §8 사건·조직 설정이다. 기존 `contracts/v1`은 수정하지 않는다.

저장소 루트에서 서버 venv를 사용한다.

```sh
apps/server/.venv/bin/python apps/contracts/generate.py
apps/server/.venv/bin/python apps/contracts/generate.py --check
npm ci --prefix apps/contracts --ignore-scripts
npm run --prefix apps/contracts typecheck
```

생성기는 Pydantic → JSON Schema → TS로 변환하며 JSON Schema와 TS 모두 커밋한다.
`--check`는 새 파일·달라진 파일·불필요한 옛 스키마를 발견하면 실패한다.
TS는 타입 선언이며 런타임 검증기가 아니다. bigint 사건 ID는 십진 문자열이다.
모든 수신 시간은 시간대가 있는 ISO 8601이고 UUID는 TS에서 string이다.

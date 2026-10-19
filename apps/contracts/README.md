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
`ts/` 안의 여분 `.ts`도 검사하며 재생성 때 오래된 생성 파일을 제거한다.
응답 모델은 serialization 모드로 생성하므로 항상 출력되는 기본값 필드도 필수다.
입력 모델은 validation 모드이며 PATCH 필드는 생략 가능하지만 null은 거부한다.
오류 본문 타입은 TS 전역 Error와 충돌하지 않는 `ErrorBody`다.
TS는 타입 선언이며 런타임 검증기가 아니다. bigint 사건 ID는 십진 문자열이다.
모든 시각은 시간대가 있어야 하며 응답은 UTC `Z`로 정규화한다. UUID는 TS에서 string이다.
웹 새로고침 뒤 CSRF 획득 응답은 `SessionInfo`이며 서버 README의 `/auth/session`을 따른다.

# API v1 계약

`models.py`의 Pydantic v2 모델이 정본이다. 범위는 API 명세 §1.4 오류,
§2 인증·계정, §3 로봇 요약, §5 지도, §7 지도 결재, §8 사건·조직 설정이다. 기존 `contracts/v1`은 수정하지 않는다.

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

## 에이전트 실시간 판 (W4-B 조정 결정)

화면 `fh-rt/1`은 유지한다. agent hello는 `fh-agent/2`이며 state.stop_ref가 필수다.
서버는 옛/다른 proto를 전용 4406 + `PROTOCOL_MISMATCH`로 닫고
AGENT_PROTOCOL_MISMATCH 사건을 남긴다. Client는 0·잠금 및 기존 대기 이유를 보존하고
최소 30초 간격으로 재접속 대기한다. 인증·권한 거부 4401/4403은 영구 중단 그대로다.
이 동작은 이번 Client 갱신이 필요하며, 미갱신 옛 바이너리를 실행할 때 그 백오프를 서버만으로 바꿀 수는 없다.

사건/event와 run.update는 발생 FIFO를 유지한다. hello·최신 state/ACK는 이력을 앞설 수
있다. 포화는 일반 사건 우선 생략과 누락 수 사건으로 알리며 안전 사건 초과분은
프로세스 수명 동안 파일로 보존한다. 4406의 이유 문자열은 정확히 `PROTOCOL_MISMATCH`다.
옛 서버의 4403이라도 이유가 `PROTOCOL_MISMATCH`로 시작하면 새 Client는 같은 느린
재연결 정책을 적용한다. 이유 없는 인증/권한 4403과 구별한다.

서버 저장 순서는 로봇별 수신 FIFO이며 서로 다른 로봇은 공정하게 섞일 수 있다.
기존 Event.data에 서버가 `server_received_at`(UTC ISO)·`robot_sequence`(로봇별 순번)를
부여한다. 화면 타입은 바꾸지 않는다. 로봇별 접수 한도 512건·2 MiB(진단용 32건·32 KiB
포함), 초과분 파일 8 MiB를 넘기 전에 STOP·FREE 후 `1013 + ROBOT_ARCHIVE_LIMIT`로
그 로봇 연결만 닫는다. 이미 접수한 안전 사건은 버리지 않는다. Client는 이 이유를 받으면
즉시 로컬 STOP·0·잠금과 lease 폐기를 적용하며 재연결이 자동 주행 재개를 뜻하지 않는다.
상세 접수/복구·HTTP STOP 최초 인증 예외는 서버 README를 따른다.


## 지도 (S3a)

`SiteTree`, `MapVersionCreate`/`MapVersion`/`MapVersionList`, `MapFeatures`,
`MapUpload`, `FloorConnectorList`를 제공한다. 좌표 쌍과 origin은 TS 튜플이다.
지도 요소 오류는 422이며 detail의 element/elements는 문제 필드 경로다.
원시 이미지 업로드 뒤 YAML을 연결해 새 upload_id를 받는 두 단계 형식과
용량 제한은 [서버 README](../server/README.md#원시-업로드-두-단계)를 따른다.
지도 판의 SUPERSEDED는 층의 approved_version_id로 계산하며 DB 행은 불변이다.


S4a 지도 결재 목록/처리 응답은 `Approval`/`ApprovalList`, 상세는 `ApprovalDetail`,
입력은 `ApprovalApprove`/`ApprovalReject`다. `ApprovalDetail.preview`는 층 ID/이름과
대상·기준 판 번호를 담고 목록은 미리보기 자료를 싣지 않는다.
이번 지원 종류는 MAP_REVISION/MAP_ROLLBACK이며 status는 PENDING/APPROVED/REJECTED/
CANCELED/STALE이다. target/base_ref의 판 ID로 기존 MapDiff API를 조회한다.
MapVersion.status에 CANCELED를 추가했다. 기존 생성물 필수 필드의 추가는 없어
기존 웹 지도 fixture의 필드 보충은 필요하지 않다. 웹의 결재 화면·이동·실제
요청/결과 알림 연결 및 기존 운영자 저장/되돌리기 403 가짜 응답 갱신은 화면 소유 작업이다.

PR32 검토 반영: 사유/의견·지도 저장/되돌리기 reason은 Cc/Cf 문자를 서버에서 거부한다.
알림 종류·notify_prefs 키는 06의 APPROVAL_DECIDED이며 0011이 이전 APPROVAL_RESULT를
이관한다. 요청자는 승격 뒤에도 자기 결재의 승인/반려를 할 수 없고 취소만 가능하다.
행위자 본인은 결정 알림 수신자에서 제외한다.

# API v1 계약

`models.py`의 Pydantic v2 모델이 정본이다. 범위는 API 명세 §1.4 오류,
§2 인증·계정, §3 로봇 요약, §5 지도, §6 작업·임무·시나리오, §7 지도 결재, §8 사건·조직 설정이다. 기존 `contracts/v1`은 수정하지 않는다.

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

## 작업·임무·시나리오 (S5a)

`Action`/`ActionOption`, `MissionWrite`/`Mission`/`MissionList`,
`ScenarioWrite`/`Scenario`/`ScenarioList`, `ScenarioPreview`를 추가했다.
배정·실행 계약은 후속이다. `PhotoParams`/`WaitParams`/`ConfirmParams`/
`SensorLogParams`가 인자 범위의 정본이며 MissionStep의 action에 따라 서버가 검사하고
기본값을 채운다. MissionStep.params의 TS 표현은 JSON 객체이므로 클라이언트의
타입 검사만으로 잘못된 작업별 인자를 검출하지는 않는다.

입력/출력에서 공유하는 MissionStep·ScenarioPoint(하위 ScenarioWaypoint 포함)·
ScenarioFinish는 입력의 기본값 생략을 표현하도록 스키마에서 해당 필드가 선택이다.
실제 응답은 params/yaw/waypoint_ref/target 기본값도 포함한다.
시나리오 판의 number는 선택한 판이며 version/latest_version/archived_at은 본체의
현재 값이다. 최신 조회의 ETag/If-Match는 현재 version을 사용하고 ?version=n 응답은
ETag를 생략한다. Action.options는 camera/device 선택지별 장치 요구·가능 여부·이유이며,
작업 available은 하나라도 가능한 선택지가 있는지를 뜻한다. 작업 requires는 선택지의
공통 필수 장치만 담으며 params 기본값 자체의 지원 여부는 options로 확인한다.
waypoint_ref는 지점 ID이고 좌표 차이 상한은 0.05 m다. 본문 검사422의 detail.elements는
문제 경로 배열이고 preview 자료는 detail.preview다. query/path 오류는 공통400이다.
범위·인자 상한·preview의
직선/직접 연결점 거리 한계·428/409/422는 서버 README S5a 절을 따른다.


## 시뮬 월드 지도 연결 (ADR-003 ②)

`SimWorld.map_id`는 지도 트리의 건물 ID이며, 선택 필드 `floors`는 등록된 층의
`floor_id`·`name`·`floor_z`(월드 m)·현재 승인 `map_version_id`를 담는다.
미등록 월드는 `map_id=null`, `floors=[]`다. 서버가 로그인 조직의 등록 자료를 연결하며
simmgr는 지도 DB를 소유하지 않는다. 기존 `id`와 월드 실행 가능 여부는 바꾸지 않는다.
`MapBuilding.sim_world_id`, `MapFloor.provenance`/`floor_z`, `MapVersion.provenance`도
선택 추가 필드다. 출처는 `HUMAN`/`SIMULATION`이며 기존 `MapVersion.source`의
IMPORT/EDIT/ROLLBACK/SLAM(만든 방식)과 구분한다. 사람이 시뮬 층을 편집·되돌려도
SIMULATION 출처를 유지한다. 서버 업로드 ID 재사용·YAML 연결 복사도 지도 판의 출처를 보존한다.

시뮬 지도 판이 하나라도 든 시나리오를 실기 로봇에 배정하면
`422 SIM_MAP_REQUIRES_SIM_ROBOT` (`ScenarioTargetErrorCode`)이다. 일반 로봇 API로
simulation 값을 설정할 수 없으며 기존 서버 등록 값으로 판정한다. 결재 승인 때도
같은 적합성을 다시 확인한다. 후속 실행 시작 API는 공통 `require_target`을 호출해야 한다.

미리 만든 임무 판은 표시·기록용 이름이며 `Mission.steps=[]`로 읽힌다.
일반 `MissionWrite`는 기존대로 작업 1개 이상을 요구한다. 시뮬 지도 자동 승인은
지도에만 해당하며 운영자 시나리오 배정의 결재는 기존대로다.

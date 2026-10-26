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

AgentState와 이를 상속하는 PhoneState의 선택 필드 `safety_reason`은
`OUTPUT_STALLED | null`이다. publisher 지연으로 잠긴 동안 `OUTPUT_STALLED`를
보내며 신선한 STOP 피드백·새 unlock·해제 피드백 뒤 null이 된다.
물리 정지 확인은 기존 `stop_requested` 피드백이며 이 사유 필드로 대신하지 않는다.
서버는 검증된 값을 로봇별 `ScreenState.safety_reason`으로 전달한다. 필드를 생략하는
옛 에이전트, 아직 상태가 없거나 오래된 상태, 오프라인 로봇은 null이다.

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
배정과 실행 동작 구현은 후속이다. 직결 실행 계약은 아래 scenario/1 절을 따른다. `PhotoParams`/`WaitParams`/`ConfirmParams`/
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

## 시나리오 실행 공통 계약 (scenario/1, 05 §13.10)

`PhoneMessage`의 `PhoneRunStart`는 고정 시나리오 판·단일 층/지도 판 참조만 받는다.
계획·좌표를 start 본문에 싣지 않는다. `RunPlan`은 에이전트가 자료 API에서 검증한
1구간·1~200개 순서 지점 스냅샷이다. `RunGoal.mission_version`은 고정 임무 판이며
임무 이름도 함께 보관한다. 종료 방식은 기존 `ScenarioFinish`를 사용한다. 현재 층·종료
목표·월드 바인딩/해시 대조, 자료 API 인증과 출발 관문은 후속 에이전트/서버 구현 책임이다.

`PhoneRunControl`은 pause/resume의 lease·screen 증명과 resume 비밀값을 검사한다.
abort에는 이 증명을 강제하지 않는다. 실제 PAUSED·원 주체 또는 서명된 run_cancel 권한은
에이전트가 검사해야 한다. return과 `PhoneRunConfirm`은 예약 형식을 표현할 뿐 첫 판에서
항상 UNSUPPORTED_OPERATION으로 응답해야 한다. `PhoneWelcome.capabilities.run_contract`
선택 확장이 scenario/1일 때만 실행 화면을 연다. 없는 구 에이전트에 실행을 보내지 않는다.

직접 상태는 `PhoneRunUpdate`(t=run.update), 재접속 첫 `PhoneState.run`은 비밀값 없는
`RunSnapshot`이다. 별도 run.status 프레임은 §13.10에 없으므로 정의하지 않는다.
`RunStatus`는 새 CANCELED와 예약 WAIT_CONFIRM을 포함한다. `RunRecordStatus`/
`CurrentRun`은 ABORTED 기록 호환을 제공한다. 기존 `RunCopy.status`는 내부 Session의
RUNNING을 보존하기 위해 문자열로 유지한다. PAUSED 이유는 RunWaitReason이며 실패 코드로
쓰지 않는다. 알려진 실패/거부 표는 RunFailCode/RunRejectCode로 내보내되 fail_code 문자열은
미래의 알 수 없는 실패를 일반 실패로 표시할 수 있도록 유지한다.

`PhoneReply.detail`은 시작/재바인딩 연결에만 돌려줄 `RunResumeDetail`이다. 토큰의 실제
256 bit 난수 생성·해시 보관·회전·연결 제한과 출력 필터링은 후속 에이전트 책임이다.
`PhoneTicketClaims.run_cancel`은 엄격한 boolean, 선택 필드이며 생략=false다.
기존 purpose/surface 의미와 수명 상한을 바꾸지 않으며 PhonePassRequest에 자가 권한
주장 필드를 추가하지 않는다. `run_pause_timeout_s`(양의 초, 기본 600)는 에이전트 설정이므로
start·출입증·조직 설정 계약에 넣지 않는다.

전환 기간 `AgentRunUpdate` 서버 입력은 상세 상태 외에 기존 RUNNING/ABORTED를 읽는다.
agent_instance_id/report_seq/monotonic_s는 생략 가능하되 제공하면 셋 모두 필요하며 null은
거부한다. 새 직접 `PhoneRunUpdate`/`RunSnapshot`은 RunStatus만 쓴다.
새 영속 전이는 필수 식별자·상세 상태의 `DurableAgentRunUpdate`, 연결된 모든 원인/종료/
지점 사건은 `DurableAgentEvent`를 사용한다. 무식별 구 보고는 비실행 사건/원격측정·옛
메모리 Session 표시만 허용하며 새 영속 실행을 생성/변경/종료하거나 ACK할 수 없다.
읽기 파서와 별도로 DB 경계 강제(2a)·생산자 전환(2b)이 필요하다.
`AgentEvent`의 일반 사건에는 이 식별자가 선택이며, 세 필드는 함께 있어야 한다.
RUN_STARTED/RUN_WAYPOINT_ARRIVED/RUN_WAYPOINT_RECORDED에는 식별자가 필수다.
지점 사건의 data는 RunWaypointArrived/RunWaypointRecorded로 검사하고 봉투 식별자와
대조한다. 기록 결과는 DISPLAY_ONLY다. `RunRecorded`는 DB commit 뒤 수신 확인이며
실행 명령이나 재개 권한이 아니다. 영속 outbox·순서/중복 제거·트랜잭션·ACK 시점은
후속 에이전트/서버 구현에서 검증한다. 기존 소비자는 이 단계에서 수정하지 않았다.

`AgentScenario`는 `GET /agent/scenarios/{id}?version=n`의 데이터 응답이다. 기존 시나리오
응답처럼 `id`/`number`가 고정 시나리오 참조이며, 저장된 순서의 `waypoints`는 층·지도 판과
임무 ID·고정 판·표시 이름을 모두 담고 `finish`는 저장된 종료 방식/목표를 담는다.
응답 자체를 단일 층으로 자르지 않는다. 에이전트가 이 자료의 모든 참조·종료 목표를 대조한
뒤에만 RunPlan을 만들며 여러 층/지도 판은 출발 전에 거부한다(§13.10.2).
새 실행 경계는 `ProvenAgentScenario.map_proofs`가 필수다. `RunMapProof`는 floor/map UUID,
PNG의 image_sha256, 원본 PGM의 source_pgm_sha256(각 실제 바이트 SHA-256), origin(m/rad),
resolution(m/cell), width/height(픽셀), HUMAN/SIMULATION source와 world_id/ros_floor_id를
담는다. SIMULATION은 월드/ROS 층 바인딩 필수, HUMAN은 두 값 null이다. 모든 지점/GO_TO
참조를 중복·누락 없이 덮어야 한다. 서로 다른 PNG/PGM 해시는 별도로 검사하고 raster
좌표/축/행 방향·unknown도 대조한다. UUID는 해시가 아니다. 신뢰된 현재 월드/episode/epoch·
층·로컬 실제 바이트/좌표 정보 대조는 에이전트 validator가 수행하며 누락도 fail-closed다.
기존 AgentScenario의 증명 생략/null 읽기는 실행 허가가 아니다.

`RUN_STARTED.data`는 `RunStarted`로 검사한다. run/scenario 고정 판·층/지도 판·시작 주체
user_id/device_id/surface/screen_id·simulation을 담으며 resume_token 등 추가 키는 거부한다.
보고 식별자·단조 시각·robot_at은 event 봉투, robot/org와 수신 시각은 인증 링크/서버에서
얻는다. simulation과 주체는 서버가 인증 자료로 재검사하며 자기 주장만 신뢰하지 않는다.
새 영속 RUN_STARTED는 `ProvenRunStarted`로 같은 `map_proof`를 필수 보관한다. 봉투는
`DurableAgentEvent`로 검증하고 서버가 DB 고정 지도 증명과 대조해야 한다. 기존 RunStarted의
증명 생략은 옛 보고 읽기 전용이며 새 출발 관문에 사용하지 않는다. 계획 스냅샷은 서버가
고정 시나리오/임무 판으로 재구성한다. 이 계약만으로 validator/DB 강제가 구현되지는 않는다.

`ServerAgentMessage`는 계약에 정의된 서버→에이전트 lease/cmd/stop/unlock/ping/streams와
phone.revoke, run.recorded, run.report_rejected를 묶는다. `AgentMessage`는 반대 방향 입력이며 수신 확인을
포함하지 않는다. 옛 서버 run.start/run.control 명령은 이 묶음으로 새로 계약화하지 않는다.

`RunReportRejected`는 instance/seq/run_id(null 가능)에 묶인 거부이며 commit ACK가 아니다.
SEQUENCE/STORAGE만 RETRY(일시)이고 SEQUENCE만 expected_report_seq가 필요하다. 원문·
식별자를 그대로 보존해 백오프 후 FIFO replay한다. OWNER/MAP/PLAN/STATE/STEP/PROVENANCE/
CONFLICT/INSTANCE/ROBOT/NOT_FOUND/INVALID는 QUARANTINE(영구)이다(실제 코드는 RUN_REPORT_
접두사). 서버는 별도 거부 이력 commit 뒤 영구 처분을 보내고 그 순번을 소비한다. 같은
원문 replay는 같은 처분, 다른 원문은 CONFLICT이며 실행/지점에 성공 반영하지 않는다.
격리 이력 commit 실패는 STORAGE/RETRY 또는 ACK 없는 1013이다.

에이전트는 자신의 미확인 보고와 대조한 영구 처분을 원문/이유와 함께 영속 격리하여 replay
대상에서 제외하고, 0+목표 취소+입력 폐기+잠금+FAILED(RECORDING_REJECTED)로 축소한다.
격리 저장 실패면 원문 outbox 유지+PAUSED(RECORDING_UNAVAILABLE)다. 이미 종료된 실행은
다시 열지 않으며 다른 대기 보고는 순서대로 개별 처분을 받아 후속 기록을 막지 않는다.
새 start/resume는 운영자 대조 전 금지한다. 단순 재접속·삭제·가짜 ACK·수정 replay는 복구가
아니다. 운영자는 잠금/취소 확인→양쪽 식별자/지문/지도/계획/권한/마지막 기록 대조→원인
수정→감사 가능한 서버 데이터 종료/정정→격리·FIFO 대조/사람의 차단 해제 순서로 복구한다.
원문과 처분은 보존하고 실패 run은 resume하지 않는다. 새 출입증·새 run_id·STOP 확인·명시
unlock·새 중립을 거쳐 새 실행한다. 구체 원칙은 [05 §13.10.5](../../docs/spec/05-API-SPEC.md#13105-에이전트--서버-기록),
2a/2b에서 구현/검증하며 현 1013 독성 replay가 해결됐다고 주장하지 않는다.

`GET /api/v1/agent/map-versions/{id}/image`는 agent Bearer 토큰·현재 robot/org를 재검사하고
이 로봇 map.sync 배포 판 또는 인증된 고정 시나리오 조회에서 허용한 정확한 판만 반환한다.
200=image/png·no-store·증명 PNG SHA 일치, 401=인증 실패, 404=미허용/다른 조직/없는 판,
422 MAP_VERSION_MISMATCH=보관 이미지와 증명 불일치다. 최신 판/일반 사용자 URL로 우회하지
않는다. 이미지 API는 2a 미구현이며 검증된 로컬 사본으로 대체해도 증명은 필수다.

계약 집중 시험은 다음과 같다. 기존 안전 셀프테스트의 기대값은 변경하지 않는다.

```sh
apps/server/.venv/bin/python -m pytest -q apps/contracts/tests
apps/server/.venv/bin/python apps/contracts/generate.py --check
npm run --prefix apps/contracts typecheck
```

## 연결 건물 정적 지도 관측 (floor-auto 1·2단계)

- 실행 `world_id=v5_building`, 시작 선택 `spawn_floor_id=l1|l2`(기본 l1).
  `v5_building/l1|l2` 요청은 시작 별칭이며 응답 identity는 `v5_building`이다.
  `SimWorld.spawn_floor_ids`와 `floors[].ros_floor_id`가 선택 키를 제공한다.
  실행 중 시작층 재선택은 거부하며 층 확정은 슬롯·세대·리스·Gazebo를 바꾸지 않는다.
- 에이전트/폰 `state.pose.floor_context`, 서버 `state.location.floor_context`가
  `robot_id, generation, run_id, epoch, floor_rev, world_id, building_id`와
  `spawn_floor_id, current_floor_id, floor_id, map_version_id, sha256,
  source_pgm_sha256, source, floor_state, reason, confirmed_sim_t`를 전달한다.
  `current_floor_id`는 ROS l1/l2 키, `floor_id`·`building_id`·`map_version_id`는 서버 UUID다.
  `pose.map_version_id`와 `Location.map_version_id`도 같은 승인 판 UUID를 보존한다.
- `source=gt_geometry`, 원본 정적 PGM은 `source_pgm_sha256`, 서버 이미지 PNG는 `sha256`다.
  서로 다른 바이트이므로 두 SHA를 같다고 비교하지 않는다. 시작 시 서버가 조직·SIMULATION
  출처·층 소속·승인 판·원본 PGM→PNG·좌표 정보를 검증한 양 층 `SimMapBinding`을 전달한다.
  승인 격자와 다르면 위치를 비우고 `binding_mismatch` 또는 `approval_unverified`를 표시한다.
- `floor_state=on_floor|transit|unknown`; on_floor일 때만 `current_floor_id`가 있다.
  transit/unknown의 위치·판 필드는 null이다. `reason`은 원본 `confirming`, `connector_*`,
  `support_off_floor`, `invalid_input`, `support_nan`, `fallen_or_tilt`, `floor_jump_*` 등을 보존한다.
  상태는 정상 수신을 계속하며 지도 전환 때문에 sim_busy·STOP·입력 0을 만들지 않는다.
- 화면은 이미지 요청 직전의 전체 문맥과 응답 시 현재 문맥을 비교하고, 일치할 때만 이미지와
  pose를 함께 표시한다. 이탈·확정·RESET에서 증가하는 `floor_rev`와 epoch를 모두 비교한다.
  양 층 승인 판은 미리 캐시할 수 있지만 transit/unknown/이미지 오류에서는 위치·목표를 숨긴다.
  지도 로딩은 수동 명령 전송의 조건이 아니다. SLAM 복원·층간 자율 목표는 이 계약의 지원 범위 밖이다.

## 다중 관측 media/1 · 외부 시점 observer/1 (VQ-A)

기존 `CameraHello`/`CameraFrame`/`CameraStatus`와 phone 카메라 토큰·영상은 그대로다.
새 `MediaHello`/`MediaMessage`는 **별도 관측 소켓**의 계약이며 안전/조종 WS union에
추가하지 않는다. 영상과 점군은 채널별 연결로 분리한다. `MediaHello`는
`robot/epoch/episode_id/channel`과 43자 토큰을 묶는다. 실기 episode_id는 null,
시뮬은 현재 episode UUID다. B는 인증된 부모 보기 연결에 결속된 10초·1회 토큰을
발급/소비하고 부모 종료·권한 취소·episode 종료 때 관측 연결을 닫아야 한다.
기존 camera_token을 media 토큰으로 재해석하거나 임의 다른 채널에 재사용하지 않는다.

- `MediaVideoFrame(t=media.video)`은 channel=`rgb|external`, source는
  `rgb → d435i_rgb|go2_front`, `external → gazebo_external`이다. 장치 이름을
  혼용하지 않는다. UTC `captured_at`, robot/epoch/episode/seq/frame을 매 프레임 보낸다.
  JPEG는 decoded ≤65,536B, ≤640×360, wall-clock ≤5Hz다. 새 모델은 canonical base64와
  크기·JPEG 양끝 마커를 검사한다. **완전한 JPEG decode/실제 치수 확인은 B/D 책임**이다.
- `MediaPointCloudHeader(t=media.points)`는 channel=`lidar`, source=`l1`,
  encoding=`xyz_f32le`다. JSON header 직후 같은 소켓의 **바이너리 메시지 하나**에
  순서대로 x/y/z LE float32를 보낸다. `byte_length=count*12`, count=0..4,000,
  ≤48,000B, wall-clock ≤2Hz다. `validate_payload(bytes)`는 정확한 길이와 finite,
  각 좌표 ±10,000m를 검사한다. header 없이 binary, 중간 header/다른 프레임,
  길이 불일치·잘못된 순서는 소켓 오류로 거부한다. base64/JSON 점 배열을 쓰지 않는다.
- `frame=map`은 map_version_id와 변환 시점 로봇 `pose(x/y/z/yaw)` 필수다.
  raw `lidar_link`는 둘 다 null이다. 유효 TF·현재 승인 지도 판을 확인하지 못하면
  map 점군을 보내거나 표시하지 않는다. `truncated`는 해당 스캔 절삭 표시이며 누적이 아니다.
- B/F는 채널별 seq 증가, 현재 robot/epoch/episode 결속, UTC 파싱 후 미래/오래된 시각을
  검사한다. 수신 시 1초 넘은 자료/미래 1초 초과 자료는 버리며 최신 자료 하나만 보관한다.
  전환·해지 즉시 pending binary와 이전 자료를 비운다. wall-clock 송신 간격은 영상 200ms,
  점군 500ms 이상으로 강제한다. 모델 단독 검사는 인증·시각 신선도·속도를 강제하지 않는다.
  느린 시청자 때문에 control/STOP 큐·lock·DB/journal에 대기하지 않는다.
- `MediaStatus`는 채널과 결속된 `NO_VIDEO|NO_POINTS|UNAVAILABLE` 및 이유다.
  화면이 숨거나 타일 비활성이면 구독을 해제한다.

`ExternalCameraViewRequest(t=external.view, version=observer/1)`는 별도 인증 observer
API의 요청이다. robot/episode/epoch/seq와 yaw ±π rad, pitch ±1.2 rad,
radius 0.5..10m만 허용한다. C는 현재 보기 권한·바인딩·seq를 검사하고 wall-clock ≤10Hz,
latest-only·timeout을 강제한다. entity/service/world/로봇 pose 입력은 계약에 없으며
추가 키는 거부한다. **서비스와 독립 카메라 entity는 C의 신뢰된 서버 설정에서 고정**한다.
임의 Gazebo service 프록시와 로봇 pose 변경은 금지다. 초기 시점은 로봇당 공유하며
드래그 해제/연결 종료 시 대기 요청을 버린다. 이 계약 추가는 Gazebo 실행 검증이 아니다.

## 사진·대기 실행 scenario/2 및 사진 REST 메타 (VQ-A)

`scenario/1`의 `run.start`·`DISPLAY_ONLY` 의미를 유지한다. 미지정 새 선택 필드는
기본 직렬화에서도 생략하며, 구 응답의 명시적 null을 새 실행 허가로 해석하지 않는다.
새 실행은 `PhoneCapabilities.execution` 및 `AgentHello.execution_capabilities`의
`ExecutionCapabilities(contract=scenario/2, revision, actions)`가 광고된 뒤에만
`PhoneRunStartV2(t=run.start.v2)`로 요청한다. 기존 run_contract=scenario/1 표시는 보존한다.
새 opcode를 지원하지 않는 소비자는 실행을 거부해야 하며 run.start로 자동 재시도하지 않는다.

`ExecutionCapability`는 `SUPPORTED|UNAVAILABLE|UNSUPPORTED`와 이유를 표현한다.
미광고·미확인·미지원은 실행 가능이 아니다. depth 사진은 `photo.depth/UNSUPPORTED`로
표현하며 현재 JPEG 업로드/성공 참조는 RGB만 허용한다. executor 지원 ∧ source 장치 정상
∧ fresh frame ∧ 저장 준비가 모두 충족될 때만 SUPPORTED다. 준비 상태가 바뀌면 revision을
증가시킨다. D/E는 start/resume/단계 직전에 현재 revision과 필요 capability를 재검사하고
`ExecutionCapabilities.require(required, revision)`의 실패를 거부로 처리한다.

`AgentScenarioWaypoint`/`RunGoal`의 선택 `mission_steps`+`required_capabilities`는 항상
함께 있어야 하고 정규화된 고정 단계에서 유도한 capability 집합과 정확히 일치해야 한다.
선택 필드 존재만으로 실행하지 않는다. `ExecutableAgentScenario`/`ExecutableRunPlan`의
scenario/2·revision, 필수 고정 단계와 기존 map proof 관문을 모두 사용한다. 빈 단계는
기존 가져온 표시 이름의 실제 no-op이며 새로운 작업을 추론하지 않는다. `ExecutableRunStarted`
는 같은 판/revision과 map proof를 RUN_STARTED 기록에 넣는다. D는 최신 임무가 아닌 고정
mission_id/version에서 단계를 가져오며 E는 이를 검증한 실행 스냅샷에 복사한다.

`RunWaypointRecorded.results`는 기존 DISPLAY_ONLY 또는 `RunExecutedResults(mode=EXECUTED,
run_contract=scenario/2, execution_capability_revision, steps)`다. `RunStepResult`는
step_idx/action/source, SUCCEEDED|FAILED, 실패 코드·이유와 선택 photo 참조다.
성공 PHOTO는 server commit ACK의 photo_id/source/captured_at/sha256이 필수이고 실패는
성공 참조를 담지 않는다. 실패 이후 다음 단계 결과는 금지다. D/E는
`results.validate_plan(fixed_goal, revision)`로 단계 수/순서/action/source/판을 대조하고,
인증된 run/waypoint 소유와 photo_id 소유·SHA를 DB에서 재확인한다. 모델만으로 DB 소유나
실제 실행을 증명하지 않는다. scenario/1 run에 EXECUTED 결과를 반영하지 않는다.

`PhotoUploadMetadata`는 agent 인증 REST 요청의 메타다. org_id(tenant)/robot_id/run_id/
waypoint_idx/step_idx, source=rgb, captured_at, MIME=image/jpeg, byte_length≤65,536,
sha256와 idempotency_key가 필수다. 이미지 바이트는 별도 REST binary body/part로 전송하고
안전 WS·사건·journal에는 참조만 넣는다. `validate_payload(bytes)`는 크기·마커·SHA를
검사하며 실제 JPEG decode/치수 검사는 D가 수행한다. D는 org/robot을 인증 링크에서 확인하고
run의 고정 PHOTO 단계·source·현재 실행 소유를 재검사한다. 키는 인증 org/robot/run/
waypoint/step 범위로 묶고 동일 키+동일 메타/바이트는 같은 photo_id를 재응답하며 다른 내용은
충돌로 거부한다. URL·경로·이미지 바이트 추가 필드는 거부한다.

`PhotoUploadReceipt`는 같은 메타+photo_id+stored_at이며 바이트 원자 저장과 DB 메타 commit
후에만 반환한다. E는 업로드 timeout/디스크 실패/끊김을 성공 처리하지 않고 run/waypoint/step
및 자기 generation과 일치하는 ACK만 수용한다. WAIT는 기존 WaitParams(1..3600초, 기본30)를
사용한다. 이동 취소·출력0 후 단조 시간 비차단 대기, pause 잔여시간 보존·명시 resume,
PHOTO 요청 뒤 새 프레임 및 STOP/cancel/세대 변경 이후 늦은 완료 무시는 E의 구현 책임이다.
이 계약 PR은 B/C/D/E transport·저장·실행기나 실기 지원을 구현/검증하지 않는다.

### B 연결 발급 (agent media 구현)

`PhoneWelcome.media`는 선택 필드다(구 agent는 생략, 기존 `camera_token` 불변).
존재하면 `version=media/1`, `path=/phone/media/ws`, `robot/epoch/episode_id`와
`rgb/external/lidar` capability 각각의 `available/reason/token`을 제공한다.
사용 가능 채널에만 43자·10초·1회 토큰이 있으며, 다른 채널·부모·로봇으로
재사용할 수 없다. 소비자는 각 채널별 새 WS의 `MediaHello`에 이 바인딩과
토큰을 그대로 전달하고 부모 보기 연결을 유지한다. 새 agent에 구 소비자가
연결될 때 optional response 확장을 무시하는 기존 호환 규칙을 따른다.

현 B의 시뮬 `episode_id`는 trusted launch의 native run nonce UUID이고 `epoch`는
accepted state episode다(서버 sim DB ID와 혼용 금지). launch 바인딩을 확인하지
못하면 필드를 생략한다. 실기 adapter는 episode null이다. external은 소스가
없어 unavailable이며, C와 합의한 후속 compressed 토픽은
`/v2_live/external_cam/compressed`다. 실제 연결·한계는
[agent media README](../agent/foothold_agent/media/README.md)를 본다.

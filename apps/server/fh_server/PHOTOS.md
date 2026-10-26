# 사진 REST와 scenario/2 소비자 인터페이스

사진 바이트는 아래 REST 경로만 사용한다. 안전 WebSocket·실행 journal·events에는 사진 참조만 넣는다.

## 에이전트(E)

1. 인증된 agent hello에 `ExecutionCapabilities(contract="scenario/2", revision=R, actions=...)`를 광고한다. RGB 촬영은 `photo.rgb: SUPPORTED`와 hello 장치 `CAMERA_RGB: OK`가 모두 필요하다. WAIT는 `wait: SUPPORTED`가 필요하다. 깊이 사진 저장은 지원하지 않는다.
2. `GET /api/v1/agent/scenarios/{scenario_id}?version=N&run_contract=scenario/2&execution_capability_revision=R`를 agent Bearer 토큰으로 요청한다. 서버는 live hello의 판·장치를 검사하고 고정 임무 판의 `mission_steps`와 `required_capabilities`를 포함한 `ExecutableAgentScenario`를 돌려준다. 누락·판 불일치·기능 미지원은 `422 EXECUTION_UNAVAILABLE`과 이유로 거절한다. 협상 쿼리가 없는 기존 조회는 scenario/1 표시 전용이다.
3. `RUN_STARTED.data`는 `ExecutableRunStarted`를 사용한다. `map_proof`와 동일한 capability 판이 필수이며, 기록된 run.plan은 `ExecutableRunPlan`을 기준으로 finish/map_proofs를 더해 고정된다.
4. RUN_STARTED와 RUN_WAYPOINT_ARRIVED의 영속 기록 ACK 뒤, 현재 실행 지점에서 촬영한다. `POST /api/v1/agent/photos`에 agent Bearer 토큰, `Content-Type: image/jpeg`, `X-Photo-Metadata: <PhotoUploadMetadata JSON>`, raw JPEG 본문을 보낸다. 메타데이터는 계약의 org/robot/run/waypoint_idx/step_idx/source/captured_at/mime/byte_length/sha256/idempotency_key를 모두 포함한다. source는 rgb만 허용한다.
5. `200 PhotoUploadReceipt`는 파일 rename·fsync와 DB commit 뒤 반환한다. 동일 키·동일 메타데이터·동일 바이트는 같은 영수증이다. 타 실행/단계 또는 다른 내용으로 키를 재사용하면 거절한다. 재시도는 최초 키·촬영시각·바이트를 그대로 보낸다. 저장 실패는 `503 PHOTO_STORAGE_ERROR`, 한도는 `507 PHOTO_CAPACITY`다. 성공 ACK 없이 PHOTO 성공 결과를 보내면 안 된다.
6. RUN_WAYPOINT_RECORDED에는 `RunExecutedResults`를 보낸다. PHOTO 성공 참조의 photo_id/source/captured_at/sha256는 저장 영수증에서 복사한다. 서버는 조직·로봇·실행·지점·단계 소유를 DB와 대조한다. scenario/1의 EXECUTED와 scenario/2의 DISPLAY_ONLY는 `RUN_REPORT_PLAN`으로 격리한다. 실패 단계는 FAILED로 기록하며 모든 지점이 DONE이기 전 COMPLETED를 거절한다.

서버는 실행 시작 명령을 보내지 않는다. 실제 WAIT/촬영 실행·새 프레임·중단 처리는 에이전트가 맡는다. capability가 바뀌면 새 revision을 담아 재접속해야 한다(현 계약에 hello 이후 capability 갱신 메시지는 없음).

## 화면(F)

- 기록 API의 `PHOTO_STORED` 사건: `photo_id`, `run_id`, `waypoint_idx`, `step_idx`, `source`, `captured_at`, `sha256`, `url`, `thumbnail_url` 참조를 제공한다. 이미지 바이트는 없다.
- `PHOTO_STORE_FAILED` 사건: 같은 실행/단계 참조와 `reason`을 제공한다. 실패를 촬영·저장 성공으로 표시하지 않는다. DB 자체가 전혀 쓰이지 않는 장애에서는 사건 저장도 보장할 수 없다.
- 사용자 세션 또는 사용자 Bearer 토큰으로 `GET /api/v1/photos/{photo_id}`를 요청한다. 조직·현재 담당자 또는 총괄의 ROBOT_READ 권한을 매번 검사한다. `/thumbnail`은 원본을 반환한다. 둘 다 `image/jpeg`, `private, no-store`다. 인증되지 않은 공개 URL은 없다.
- `/api/v1/actions?robot_id=...`의 PHOTO/WAIT available과 why_unavailable을 따른다. 미선택·오프라인·실행기 미광고를 실행 가능으로 표시하지 않는다.

## 저장·검증 한계

`photos.py:PhotoLimits` 한 곳에서 JPEG 65,536B·640×360·조직별 최대 10,000장/256MiB를 설정한다. 보관 한도에 도달하면 기존 증거를 지우지 않고 새 업로드를 거절한다. 파일은 기존 files_root 아래 `photos/<org>/<photo_id>.jpg`에 보관한다. 실패·과정 중단 후 고아 파일은 다음 해당 조직 업로드 때 조직 잠금 아래 정리한다. 사용 중인 `.tmp`를 다른 업로드가 지울 수 없다.

조정 지시에 따른 ponytail: JPEG는 SOI·세그먼트 길이·SOF0/1/2의 8bit/채널/해상도·SOS·EOI와 크기·SHA256 구조 검사만 수행하며, 픽셀 손상은 잡지 못한다. 새 이미지 디코더 의존성은 추가하지 않는다. thumbnail은 별도 축소본이 아니다. 파일·DB를 명시적으로 보존/정리하기 전에는 사진이 있는 0020 마이그레이션 downgrade를 거절한다.

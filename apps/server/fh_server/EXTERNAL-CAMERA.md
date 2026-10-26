# 외부 카메라 REST — 화면(F)

`POST /api/v1/robots/{robot_id}/external-camera/{view,reset,cancel}`.
사용자 세션 쿠키 + `X-FH-CSRF` 또는 **사용자** Bearer로 호출한다.
폰 media/출입증·agent 토큰으로는 호출할 수 없다. 조직·현재 담당자 또는
총괄의 `ROBOT_READ`를 매번 검사한다. 실기는 `409 UNAVAILABLE`다.

본문은 세 경로 모두 계약 `ExternalCameraViewRequest` 그대로다(최대 4096B).
`robot`, `episode_id`, `epoch`는 현재 media welcome의 값을 사용한다.
`seq`는 형식상 필수지만 서버가 공유 순번으로 덮어쓴다. 예:

```json
{"t":"external.view","version":"observer/1","robot":"00000000-0000-0000-0000-000000000001","episode_id":"00000000-0000-0000-0000-000000000002","epoch":1,"seq":0,"yaw":3.14,"pitch":0.45,"radius":3.0}
```

`yaw`는 -π…π rad, `pitch`는 -1.2…1.2 rad, `radius`는 0.5…10 m.
reset/cancel에서도 이 값들은 검증되지만 사용되지 않는다. 추가 필드는 거절한다.
view는 공유 대기 시점을 교체하고 reset은 공유 기본 시점을 예약한다.
cancel은 대기 작업만 버리고 이미 적용된 공유 시점은 유지한다.

성공 `200`은 `{"accepted":true,"shared":true,"seq":1790000000000000,"operation":"view"}`
형태이며 `Cache-Control: no-store`다. 정본의 의미는 **queued acceptance,
not proof of a rendered frame or successful Gazebo service execution.**
화면에서 프레임 반영·Gazebo 실행 성공으로 표시하면 안 된다. 모든 시청자가 시점을 공유한다.

오류 형태는 기존 `{"error":{"code":"…","message":"…","detail":{}}}`다.

| HTTP / code | 화면 처리 |
| --- | --- |
| 400 VALIDATION | ID·필수 필드·범위·추가 필드 확인 |
| 401 AUTH_REQUIRED / 403 FORBIDDEN | 로그인·CSRF·계정 권한 확인 |
| 404 NOT_FOUND | 타 조직·담당 해제·보관 로봇 포함, 보기 중단 |
| 409 UNAVAILABLE | 실기에는 Gazebo 외부 카메라 없음 |
| 409 SIM_OBSERVER_RATE_LIMIT | 사용자·로봇당 세 작업 합계 100ms 이상 간격 유지 |
| 409 SIM_OBSERVER_BINDING | 경로 robot 불일치 또는 중계 중 담당자·세대 변경 |
| 409 SIM_OBSERVER_UNAVAILABLE | 실행 슬롯 불일치·미지원 월드·observer 부재·오래된 episode/epoch·busy 등 |
| 413 BODY_TOO_LARGE | 본문 4096B 초과 |
| 503 SIM_DISABLED / SIM_UNAVAILABLE | 관리자 미연결·통신 timeout·잘못된 접수 응답 |

simmgr가 반환한 허용된 `SIM_*` 오류 code/status와 계약상 안전한 detail은 유지한다.
서버는 등록된 ACTIVE 슬롯의 담당자·세대와 simmgr의 RUNNING 슬롯을 대조하며,
episode/epoch는 바꾸지 않고 simmgr가 최종 검사한다. 기존 loopback 서비스 Bearer만
사용하고 GET/POST 각각 timeout은 0.5초이며 자동 재시도·대기열은 없다.

드래그 해제·뷰 종료 때 화면이 cancel을 보내고, 빠른 연속 요청으로 제한되면
100ms 간격에 맞춰 마지막 cancel을 보낸다. 권한 회수 뒤에는 새 요청을 중단한다.
별도 서버 연결 감시는 추가하지 않는다: HTTP는 지속 연결 소유권을 표현하지 않고,
observer의 대기 작업은 최대 0.3초만 유효하므로 화면 cancel과 이 만료로 충분하다.
권한을 잃은 사용자의 cancel도 권한 검사에서 거절된다.

순번은 Unix 시각 마이크로초 시작값과 `max(현재 시각, 직전 순번+1)`로 서버가 배정한다:
기존 `--workers 1` 운영 규칙 아래 여러 시청자가 공유하며 정상 시계에서 재시작 후에도
증가하므로 DB 마이그레이션이 필요 없다. 실행 중 시계 역행도 흡수하지만 서버 재시작을
걸친 시스템 시계 역행은 보장하지 않으며 simmgr의 기존 seq 검사가 오래된 요청을 거절한다.
cancel/reset 및 중계 실패도 순번·속도 한도를 소비한다. STOP·lease·조종권·실행 경로는 쓰지 않는다.


## 중계 실패 진단

외부 카메라 오류는 `fh_server.external_camera`의 warning에 고정 stage,
HTTP status, 프로토콜 code를 기록한다. `slots_response`는 검증 실패의
필드 경로·오류 종류도 최대 16개 기록한다(예: `items.0.generation:int_parsing`).
스키마에 없는 필드명은 값·토큰을 포함할 수 있어 `<extra>`로 가리고,
TypeError는 원문 없이 `$:type_error`로 기록하며 `type_site=request|parse`로
요청 호출(경로 구성 포함)과 계약 해석을 구분한다. `type_kind=unexpected_timeout`은
`timeout` 키워드 인자를 받지 않는 호출을, `other`는 그 밖의 TypeError를 뜻한다.
분류는 고정 문자열만 남기며 함수명·예외 원문·값을 기록하지 않는다. 계정·로봇 ID, 요청/응답 본문,
URL·인증값·원문 예외·Pydantic 입력은 기록하지 않는다.

| stage | 의미와 HTTP 본문 |
| --- | --- |
| `manager_disabled` | 중계 미설정: 503 `SIM_DISABLED`, 관리자 연결 안내 |
| `slots_transport` | 실행 슬롯 GET 통신/중계 오류: 받은 SIM code/status, 외부 카메라 처리 실패 안내 |
| `slots_response` | 실행 슬롯 JSON 계약 불일치 또는 요청 호출 TypeError: 503 `SIM_UNAVAILABLE`, 연결 정보 확인 실패 안내 |
| `command_transport` | view/reset/cancel POST 통신 또는 simmgr 거절: 받은 SIM code/status, 외부 카메라 처리 실패 안내 |
| `command_response` | accepted/shared/seq/operation ACK 불일치: 503 `SIM_UNAVAILABLE`, 접수 응답 확인 실패 안내 |

실행 슬롯은 목록 API와 같은 `simulation.parse_robot_list` 계약 해석을 사용한다.
목록 API는 검증 실패를 `manager_error=SIM_UNAVAILABLE`와 정리 목록으로 바꿔
HTTP 200을 반환하므로, 200만으로 관리자 슬롯 응답이 유효했다고 판단하지 않는다.
현재 소스의 simmgr `listing`·`describe`와 API 직렬화를 거친 native/fake 응답은
view/reset/cancel 시험을 통과했다. 실제 직렬화 응답을 이용한 동시 GET도 통과했다.
HTTP 오류의 list/string 본문·중첩 error list/string, 잘못되거나 끊긴 JSON,
느린 헤더/본문은 기존 `Relay.request` 경계에서 `RelayError`로 바뀌어
`slots_transport`가 된다. 내부 직렬화/open/read/오류본문 read의 TypeError도
이미 같은 경계에 갇히므로 현재 소스에서 `slots_response` TypeError의 원인으로
확인되지 않았다. 느린 헤더는 기본 5초 목록 GET에 성공해도 0.5초 카메라 GET은
실패할 수 있지만 이 경우도 `slots_transport`다.

미리보기의 `slots_response` TypeError는 관찰용 launcher가 `Relay.request`를
`observed(self, method, path, body=None)`로 교체하면서 발생했다. 이 wrapper는
`timeout`을 받지 않아 외부 카메라의 `timeout=.5` 호출이 원래 Relay 본문 진입 전에
실패하지만, 기본 인자만 쓰는 목록 GET은 통과한다. 실행 프로세스의 launcher 경로와
그 wrapper 정의·교체 코드를 읽기 전용으로 대조했으며 같은 signature의 adapter로
실제 simmgr 직렬화 응답을 사용하는 시험에서 재현했다.

수정 위치는 관찰 launcher다: wrapper가 `**kwargs`를 받고 원래 `Relay.request`에
그대로 전달해야 한다. 앱의 timeout을 제거하거나 늘려 우회하지 않는다. launcher는
이 저장소 변경 범위 밖이므로 이 PR은 재현 시험과 위치 진단만 추가하며 launcher
수정·재시작·실시뮬 끌기 확인은 포함하지 않는다. 새 진단은 이 경우
`type_site=request type_kind=unexpected_timeout`을 기록한다.

등록된 RUNNING 슬롯·현재 담당자·세대 불일치와 observer 부재·binding/freshness
거절은 409 `SIM_OBSERVER_UNAVAILABLE`다. observer ACK 대기와 matching discard는
합계 최대 350ms로 서버의 500ms timeout보다 먼저 끝나도록 한다. 실제 관리자
통신 실패는 계속 503이며 자동 재시도는 하지 않는다.

화면은 503/observer 준비 실패를 «지금 시점 요청을 받지 못합니다 — 다시 끌면
다시 보냅니다»로 안내하고 다음 끌기를 허용한다. 영상은 별도 media 채널의
1초 신선도 판정으로 NO_VIDEO를 받고, 새로운 유효 프레임이 오면 복구한다.
REST 오류를 영상 성공으로 표시하거나 마지막 프레임의 시각을 갱신하지 않는다.

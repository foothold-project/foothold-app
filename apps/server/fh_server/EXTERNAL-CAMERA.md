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

# Go2 상태를 폰 LTE로 올리는 계약

기본 경로는 **Orin → 현장 Wi-Fi의 `/phone/ws` → 폰 → LTE의 기존 HTTPS 서버**다.
Go2 AP/Orin에 인터넷이 있다고 가정하지 않는다. 폰 송신 코드는 Claude 담당 후속 작업이다.
이번 변경은 Orin의 측정 state, 서버의 표시 전용 수신 경계, 아래 계약만 제공한다.
Orin에 상태 이력/재송신 큐를 만들지 않는다.

## 하위 호환 추가

| 위치 | 추가 | 이전 클라이언트 |
|---|---|---|
| 기존 PhoneState | 선택 `robot_serial`, `sensor_age_ms` | 기존 필드 그대로. 값이 없으면 새 필드 생략 |
| 새 PhoneStateUpload | POST 표시 메시지 `t:"phone.state"` 1개. 중첩 `state`는 기존 AgentState | 기존 AgentState/폰 명령 메시지 변경 없음 |
| RobotSummary, ScreenState | 선택 `telemetry_source:"PHONE"` | 직접 agent 상태는 기존 모양. 새 필드는 폰 경유 상태일 때만 존재 |

기존 계약의 배터리·속도·장치 OK/MISSING/ERROR를 쓴다. 자세 수치·오류 코드·토픽별
신선도는 **다음 작업: 선택 필드 추가 확장**이다. label에 숫자를 넣지 않는다.
지도 위치·시뮬·임무 상태는 이 relay로 받지 않는다.

## Orin → 폰

기존 출입증으로 인증된 `/phone/ws`의 기존 `t:"state"`에 다음이 실린다.

- `battery.soc`, `battery.voltage`, `speed`, `devices_changed`는 실제 관측에서만 만든다.
  원래 수신 시각의 기존 1초 stale 규칙을 쓰며 낡거나 없는 값은 null/MISSING이다.
- `robot_serial`은 확인된 LowState.sn의 canonical `decimal-decimal`이다.
  `sensor_age_ms`는 두 토픽 중 더 오래된 원래 수신 시각부터의 나이다.
  ID 충돌/미수신에는 metadata가 없으며, 1000ms 초과 상태는 서버로 올리지 않는다.
- 기존 `simulation:false`, `robot` UUID, 인증·lease·STOP·정지 피드백 의미는 그대로다.
  8자리 상태 전용 코드를 이동 출입증으로 쓰지 않는다.

## 폰 → 서버 (Claude 구현 대상)

`POST /api/v1/robots/{robot_uuid}/phone-state`

기본 인터넷 망(LTE)의 기존 로그인 **앱 Bearer 세션**을 사용한다. 현장 Wi-Fi로 bind한
Go2 소켓과 구분한다. 토큰은 URL·로그·분석 도구·에러 메시지에 넣지 않는다.

```json
{
  "t": "phone.state",
  "robot": "00000000-0000-4000-8000-000000000001",
  "pass_token": "<이 폰이 해당 로봇 접속에 쓴 유효한 출입증>",
  "sequence": 1,
  "observed_at": "2026-01-01T00:00:00Z",
  "robot_serial": "1234-5678",
  "sensor_age_ms": 20,
  "state": {
    "t": "state",
    "pose": {"floor_id": null, "map_version_id": null, "x": null, "y": null, "yaw": null, "confidence": null},
    "speed": null,
    "battery": {"soc": null},
    "latched": true,
    "stop_gen": 0,
    "stop_ref": 0,
    "applied": [0, 0, 0],
    "mode": "FREE",
    "devices_changed": []
  }
}
```

예제 UUID·시각·일련번호는 형식 설명용 가짜 값이다. 실제로는 폰이 **방금 받은** state를
전달한다. 아래 AgentState 필드만 골라 담고 PhoneState 전체를 그대로 넣지 않는다.

`t, pose, speed, battery, latched, safety_reason, stop_gen, stop_ref, applied, mode,
devices_changed, controller, controller_device, controller_connected, controller_since`

선택 필드는 없으면 생략한다. `reported_run`은 생략/null만 허용하고, mode는 FREE/USER,
pose는 전부 null이어야 한다. 장치는 최대 16개, key 64자·label 128자 이내다.
`robot_serial`은 state에서 그대로 복사한다. `sensor_age_ms`도 state 값을 복사하며
폰에서 0으로 바꾸거나 수신 시각을 새로 만들어 낡은 자료를 살리지 않는다.

- 주기 **1Hz**, 진행 중 HTTP 요청은 최대 하나, 요청 제한 시간 1초. 중간 state는 최신
  하나로 교체한다. 출입증 JTI 하나에서 sequence는 엄격하게 증가하며, 새 JTI에서 새로
  시작한다. 같은 JTI의 sequence를 앱 재시작으로 0부터 재사용하지 않는다.
- `observed_at`은 그 state가 폰에 도착한 UTC 시각이다. 서버는 지연 2초 초과·미래 1초
  초과를 거부한다. 폰에서도 원래 수신 후 1초가 넘으면 전송하지 않는다.
- 폰 WS 단절·앱 숨김/종료·로봇 전환·pass 만료·metadata 없음·센서 나이 1000ms 초과에는
  전송을 중단하고 대기 중 스냅샷을 버린다. 상태 이력/오프라인 재전송은 하지 않는다.
- 성공은 **204, 빈 본문**이다. 401/403은 인증/출입증 회복 전까지 중단, 409는 현재
  스냅샷 폐기(ID 불일치는 연결 확인), 429/5xx/시간 초과는 현재 스냅샷을 버리고 다음
  주기의 새 관측만 검토한다. 실패한 POST를 재시도하지 않는다.
- 로봇 접속 때 출입증의 hello 1회 사용 규칙은 그대로다. 서버 표시 업로드는 그 유효한
  발급 기록의 서명 소유를 확인할 뿐 새 폰 lease를 만들거나 hello를 재사용하지 않는다.

## 서버가 확인하는 경계

앱 로그인 사용자·조직·기체·device·purpose가 서명된 발급 기록과 맞고, 출입증이
미만료·미폐기이며 surface=phone이어야 한다. 다른 로봇/사용자/조직·시뮬·위조 서명·
미발급 출입증·재전송 순번·0.5초 미만 반복은 거부한다. 계정/권한은 기존 HTTP 인증으로
매 요청 재확인한다. 서버는 pass_token을 저장하지 않는다.

서버는 최신 표시 값 하나만 메모리에 보관하고 원래 관측 나이까지 포함해 최대 3초 뒤
버린다(출입증 만료가 먼저면 그때 버림). 등록 agent가 신선하면 그 상태를 우선한다.
폰 경유 캐시는 `realtime.agents`, arbiter, 조종권, STOP ref 확인, 임무 실행에 연결하지
않는다. 서버 → 폰 → 로봇 명령 경로는 없다. 기존 웹 목록/상태 경로에서만 읽는다.
`telemetry_source:"PHONE"`은 **폰이 전한 상태**라는 출처이며 암호학적 센서 증명이나
로봇의 정지 보장을 뜻하지 않는다. 초기 기체 식별은 전용 NIC/현장 승인 규칙을 따른다.

## 선택 경로: 인터넷이 있는 현장의 Orin 직접 보고

기본 `FH_GO2_CLOUD_REPORTING`은 미설정/0이다. Orin에 인터넷이 있는 현장에서만
`FH_GO2_CLOUD_REPORTING=1`과 기존 `FOOTHOLD_AGENT_WS_URL`, `FOOTHOLD_AGENT_TOKEN`을
함께 준비하면 기존 등록 agent Bearer/hello/state 경로를 쓴다. 토큰만 상속돼도 이 경로를
켜지 않는다. 서버 STOP/cmd/lease/unlock/run은 버리며, 기존 인증 폐기와 ping만 받는다.

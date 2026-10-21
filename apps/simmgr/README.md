# 시뮬 관리자 — P1-C 준비

폰 → 기존 관제 서버 → loopback 관리자 → 로봇별 에이전트 수명만 관리한다.
조종·STOP·영상은 폰 ↔ 에이전트다. 기본 launcher는 가짜이며 프로세스를 생성하지 않는다.
실제 기동은 **미실행**, [FIRST-LAUNCH](FIRST-LAUNCH.md)의 제품 책임자 승인 뒤 별도 작업이다.

- 설정/격리: `config.py`에서 기존 `validate_isolation` 재사용. domain93·LOCALHOST만 허용,
  DDS override·61 거부. 같은 PC loopback manager9430, 서버9431, agent9433/9434(시험9430~9449).
- 수명: `service.py`의 잠금 하나로 직렬화. 월드1개, 1인1대, 기본2대 상한(1..2 설정).
  STOP→0→에이전트 정상 종료 확인→로봇 제거→월드 종료. 정지 실패는ERROR·슬롯 보존·
  새 시작 차단이며 world 자동KILL/재기동 없다. agent timeout은 자기 수명 제한 user unit만 TERM/KILL로 수거하되 world 보존. 종료 중에도 다른 로봇의 정리는 시도한다.
- 슬롯 취득마다 세대를 올린다. manager STOP/제거와 서버 완료 처리가 같은 세대일 때만
  적용되어 이전 DELETE가 재취득한 담당자·키·출입증을 지우지 않는다. STOPPING 재취득은 거부한다.
- `FakeLauncher`: 실제 프로세스/소켓/ROS0. `PREPARED` 응답을 살아 있는 로봇으로 표시하지 않는다.
  UUID별 namespace·TF prefix·명령 토픽·에이전트 포트 분리의 **계획/계약**만 시험한다.
- `NativeLauncher`: 명시 `FH_SIM_RUN=1` 때만 기존 D1 `Simulation` supervisor를 불러 쓴다.
  자원/전용 user unit/identity/source hash/정리 검사를 재사용. 원본은 고정Go2+고정토픽이라
  실제1대만·v5_single/f1만 허용한다. native world 시작은 이미 로봇1대를 포함한다.
  로봇 제거는 그 월드 정리까지 포함하고 새 episode는 관리자 재시작/새 증거 폴더가 필요하다.
- 서버의0014는 durable `simulation` 출처·슬롯 세대·전환 상태를 추가한다. 기존0013 발급·회수/키 경로 그대로.
  두 파일에 같은 슬롯 키를 사전 배포하고 서버를 기동한다. 동적 키 생성/파일 갱신 없다.

저장소 밖 private JSON 카탈로그의 모양(실제 UUID/경로/키를 이 파일에 넣지 않는다):

```json
{
  "worlds": [{"id": "v5_single/f1", "world_file": "/private/world.sdf", "map_file": "/private/map.pgm"}],
  "slots": [{"robot_id": "00000000-0000-4000-8000-000000000001", "org_id": "00000000-0000-4000-8000-000000000002", "key_path": "/private/agent-keys.json", "replay_path": "/private/replay.sqlite", "port": 9433}]
}
```

`world_file/map_file`은 native `worlds.json`의 world/gt_map 실경로와 일치해야 한다.
원본의 generated 센서 자산·provenance도 기존 runtime이 검사한다. 가짜 모드는 경로의 파일을
열지 않는다. 카탈로그 id/슬롯/포트는 중복을 거부한다. 키 파일은 기존 private-file 검사다.
운영자 설정 경로는 환경 `FH_SIM_CATALOG`, `FH_SIM_AUTH_FILE`, `FH_SIM_AGENT_WS_URL`로 준다.
`FH_SIM_DOMAIN=93`이 필수이며 관리자 부모의 ROS_*·RMW/DDS 환경은 시작 거부한다.
자식만 허용 목록에서93·LOCALHOST 환경을 받는다. WS URL은 `/api/v1/agent/ws`만 허용한다.
`python -m apps.simmgr`는 workers1·access log off·loopback bind다.

카메라는 `FOOTHOLD_CAMERA_ENABLED=1`일 때만 기존 ROS JPEG를 최대5fps·64KiB·640×360
상한으로 솎는다. 현재424×240 원본 pass-through(조정 승인), 재인코딩/새 의존성0.
별도 영상WS·부모 연결 종속1회용 토큰과 계약은 [API §13.8](../../docs/spec/05-API-SPEC.md#138-1단계-카메라-fh-phone1-p1-c).

오프라인 검증 절차·결과는 [VALIDATION](VALIDATION.md). 공개 원본 지도/월드/영상·주소·키를
추가하지 않는다. 원본 및 다른 worktree는 읽기만 했으며 설치/수정/ROS/Gazebo 기동0이다.

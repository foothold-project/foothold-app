# 시뮬 관리자 — P1-C 준비

폰 → 기존 관제 서버 → loopback 관리자 → 로봇별 에이전트 수명만 관리한다.
조종·STOP·영상은 폰 ↔ 에이전트다. 기본 launcher는 가짜이며 시뮬·에이전트 프로세스를 생성하지 않는다.
서비스 startup은 읽기 전용 OS 도구로 부재를 확인한다.
실제 기동은 **미실행**, [FIRST-LAUNCH](FIRST-LAUNCH.md)의 제품 책임자 승인 뒤 별도 작업이다.

- 설정/격리: `config.py`에서 기존 `validate_isolation` 재사용. domain93·LOCALHOST만 허용,
  DDS override·61 거부. 같은 PC loopback manager9430, 서버9431, agent9433/9434(시험9430~9449).
- 수명: `service.py`의 잠금 하나로 직렬화. 월드1개, 1인1대, 기본2대 상한(1..2 설정).
  STOP→0→에이전트 정상 종료 확인→로봇 제거→월드 종료. 정지 실패는ERROR·슬롯 보존·
  새 시작 차단이며 world 자동KILL/재기동 없다. agent timeout은 자기 수명 제한 user unit만 TERM/KILL로 수거하되 world 보존. 종료 중에도 다른 로봇의 정리는 시도한다.
- 세대의 정본은 서버 DB 하나이며 슬롯 취득마다 세대를 올린다. manager STOP/제거와 서버 완료 처리가 같은 세대일 때만
  적용되어 이전 DELETE가 재취득한 담당자·키·출입증을 지우지 않는다. STARTING/STOPPING
  재POST는 거부하되 DELETE로 복구한다. 빈 관리자는 세대와 무관하게 취소 영수증을 남긴다.
  서버는 예약 때 기록한 관리자 UUID와 DELETE의 인스턴스·부재·startup 증명을 대조한다.
  재시작한 관리자의 부재는 자원·unit·93/DDS 시작 관문 통과 및 이후 실패 없음까지 확인해야
  슬롯을 해제한다. 증명 없는 응답·기록 없는 레거시 슬롯은 소유와 세대를 보존한다.
  관리자 목록에 없는 DB 소유 슬롯도 앱 목록의 정리 대상으로 남는다(연결 주소 없음).
  서비스 startup에서 fake/native 모두 기존 isolation preflight와 남은 sim/agent user unit
  부재를 읽기만 확인하며 user bus 오류도 거부한다. 61은 startup 기록만 하며 거부 조건이
  아니고, world 실행 전후 비교는 Simulation이 별도로 한다. 자원 기준만 fake에서는 경고이며 native는 거부한다.
  DELETE 최대 세대는 제거 확인 세대로 메모리에만 기록하고 그 이하의 늦은 POST를 생성 전에
  거부한다. 재시작 때 비워지며 영속 tombstone은 없다. 서버 POST 자동 재전송은 없고, 늦은
  성공·불확실 응답 모두 DB 세대/STARTING 최종 확인 뒤 불일치면 잠금 밖 같은 세대 DELETE를
  1회 보상하고 START_STALE 감사 1건을 남긴다. STALE 409는 NOT_CREATED 감사만 남긴다.
  송신 전 지연된 첫 전달은 재시작을 넘을 수 있으며 startup 관문만으로 배제하지 않는다.
  응답 유실+보상 실패의 잔여 runtime은 교체된 hash로 서버에 붙지 못하며 world/agent unit
  각각 RuntimeMaxSec=FH_SIM_RUNTIME_SECONDS+90(기본1890초)의 자동 종료 대상(정지 grace 45/15초·실제 종료 미검증)이다. 다음
  SIM_SLOT_BUSY는 [FIRST-LAUNCH](FIRST-LAUNCH.md)의 복구 1·2단계로 돌아간다.
- `FakeLauncher`: 시뮬·에이전트 프로세스/리스너/ROS0. `PREPARED` 응답을 살아 있는 로봇으로 표시하지 않는다.
  UUID별 namespace·TF prefix·명령 토픽·에이전트 포트 분리의 **계획/계약**만 시험한다.
- `NativeLauncher`: 명시 `FH_SIM_RUN=1` 때만 기존 D1 `Simulation` supervisor를 불러 쓴다.
  자원/전용 user unit/identity/source hash/정리 검사를 재사용. 원본은 고정Go2+고정토픽이라
  실제1대만·v5_single/f1만 허용한다. native world 시작은 이미 로봇1대를 포함한다.
  로봇 제거는 그 월드 정리까지 포함한다. 정상 agent 종료와 world identity/정리 증거 확인 뒤에는
  같은 관리자에서 다음 POST가 가능하다. 매 기동은 `SIM_RUN_DIR` 아래 시각+순번의 새0700
  episode 폴더와 그 이름의 agent unit을 쓰며 기존 폴더/unit 이름은 재사용하지 않는다.
  다음 기동도 자원·93·DDS·sim/agent unit 부재 관문을 다시 통과한다. 정리 실패·식별 불일치·
  강제 agent 종료·감시 오류는 실패를 고정해 재기동을 차단하며 담당자 확인이 필요하다.
  예외는 unit·프로세스·native 출력 생성 전 증명된 두 자원 거부뿐이다. 빈 episode 폴더와
  preflight 증거는 남길 수 있으나 launch/source hash 기록·native 출력이 생겼으면 고정한다.
  증명된 경우 서버도 같은 STARTING 세대를 IDLE로 돌려 앱에서 잠시 뒤 다시 띄울 수 있다.
- 서버의0014는 durable `simulation` 출처·슬롯 세대·전환 상태를 추가한다. 기존0013 발급·회수/키 경로 그대로.
  0016은 예약한 관리자 인스턴스 UUID를 추가하며 기존 행에는 추정 UUID를 채우지 않는다.
  두 파일에 같은 슬롯 키를 사전 배포하고 서버를 기동한다. 동적 키 생성/파일 갱신 없다.

저장소 밖 private JSON 카탈로그의 모양(실제 UUID/경로/키를 이 파일에 넣지 않는다):

```json
{
  "worlds": [{"id": "v5_single/f1", "name": "기본 연습장", "description": "시뮬 조종 연습 공간", "world_file": "/private/world.sdf", "map_file": "/private/map.pgm"}],
  "slots": [{"robot_id": "00000000-0000-4000-8000-000000000001", "org_id": "00000000-0000-4000-8000-000000000002", "key_path": "/private/agent-keys.json", "replay_path": "/private/replay.sqlite", "port": 9433}]
}
```

`world_file/map_file`은 native `worlds.json`의 world/gt_map 실경로와 일치해야 한다.
카탈로그 `name`은 1~40자, `description`은 선택(기본 빈 문자열)·최대 200자이며, 옛 항목의 이름 생략은 id로 대체하고 경고 1줄을 남긴다.
`FH_SIM_EXTRA_PORTS="8870"`처럼 관리자·서버에 쉼표로 추가 포트를 명시한다(기본 9430~9449 유지, 8453·8792는 설정해도 거부, loopback·URL 검사는 유지).
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

장애 후 복구·확실한 시작 전 거부 목록·감사 코드 차이는 [API §13.9](../../docs/spec/05-API-SPEC.md#139-시뮬-관리자-중계-p1-c-준비),
실제 고아 정리와 startup 부재 증명 순서는 [FIRST-LAUNCH](FIRST-LAUNCH.md)를 따른다.


## 시간 제한

`FH_SIM_RUNTIME_SECONDS`는 기본1800초(30분), 허용5..3600초다. 월드 준비 요청부터 계산한
UTC `expires_at`를 로봇 응답에 주고 관리자는 단조 시계로 같은 기한을 감시한다. 정상 만료는
기존 STOP/zero → agent exit0 → native world 정리 증명 경로를 사용한다. agent/native·Gazebo
unit은 같은 설정+90초(기본1890초) 상한, native watcher는 그5초 전의 마지막 안전망이다.
기한을 없애거나 실패한 cleanup을 정상으로 바꾸지 않는다. D1 단독 실행의 기본240초는 유지한다.

깨끗하게 끝난 세대만 `expired`로 제공한다. 서버는 폰 없이도2초마다 확인하고 기존 nonce·
robot_id·generation 결속 DELETE 증명과 최종 출입증 회수 뒤 DB IDLE로 돌린다. 다음 POST만
세대를 증가시킨다. 실패는 ERROR/STOPPING과 소유를 유지한다. 완료 메모리가 관리자 재시작으로
사라진 경우 기존 #55 복구를 따른다. 폰은 남은 시간과5분·1분 안내를 표시하고 증명된 완료 뒤
다시 띄우기를 제공한다. 검증 범위는 [TIMELIMIT](TIMELIMIT.md)을 본다.

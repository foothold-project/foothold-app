# PR #46 2차 검토 반영 기록

기준43c53e3, 같은 feature/sim-manager에서 수정했다. 실제 ROS/rclpy/Gazebo 노드·
native 서비스·unit 기동·실기·설치·외부 원본/다른 worktree 수정은0이다.

## 결정과 회귀

| 지적 | 반영·확인 |
|---|---|
| C1 이전 DELETE가 재취득 슬롯 제거 |0014에 단조 증가 sim_generation·sim_state 추가. 취득마다 세대 증가, STARTING/STOPPING 재취득 거부. manager 잠금 안에서 기대 세대가 맞을 때만 STOP·제거, tombstone 세대 보존. 서버도 원격 호출 뒤 조직 잠금 아래 같은 세대·STOPPING 재확인 뒤만 재회수·owner 해제·hash 교체·REMOVED. 오래된 요청은409와 감사1줄만. 원본 두 지연 지점 재현 통과, 저장소 회귀는 다른/같은 소유자 총4경합에서 로봇·owner·hash·출입증 유지 |
| C2 셸 ROS 환경에 의존하는 시험 |simmgr·server simulation·agent fixture에서 ROS_/RMW_/CYCLONEDDS_/FASTRTPS_/FASTDDS_를 제거. 환경 거부 시험만 직접 주입. 최종 전체 검사는 ROS_DOMAIN_ID=57 등 기본 셸을 그대로 유지해 실행(명령에 env -u 없음) |
| S1 고아 agent |전용 transient user unit, RuntimeMaxSec=240·MemoryMax512M·swap0·Tasks128·control-group·INT/15초 후KILL. manager의 PID/스레드 수명에 의존하지 않는 상한.512M/128은 조정 확인, 한도 초과 시 agent 종료·링크 끊김·정지 쪽 실패/world 별도 정리, 첫 기동 최대 메모리/task 재측정 조건을 문서화. RemainAfterExit로 정상 exit 근거를 읽은 뒤 자기 unit stop. private0600 JSON을 bootstrap이 읽고 즉시 삭제, 토큰 argv/상속 환경0. 시험은 명령/가짜 상태만, 실제 unit 기동0 |
| S2 일반 관리 API |시뮬 행의 일반 DELETE와 담당자 PATCH는409 SIM_ROBOT_MANAGED. 기존 agent-token409도 유지 |
| S3 조직 잠금 중 원격 GET |catalogue·retry 목록·생성·제거 전부 commit 뒤 relay. 완료 시 조직 잠금 재취득·세대 재검사. GET5초, 쓰기180초. 두 GET 정지 중 같은 조직 쓰기 완료 회귀 |
| S4 흔들리는 원천 fps |0.2초 격자(next +=0.2), 긴 공백 재설정, invalid는 자리 미사용. 샘플 전 대기1장은 유지해 샘플 사이 덮어쓰기 손실 방지. 폰 큐는 최신1장 교체 유지. 문서는≤5fps 상한·실측 보고 |
| S5 빠진 영상 경계 |64KiB 초과는 parser 앞에서 거부. parser 대체 시험으로 조기 바이트 제한 자체를 검증. 만료 토큰·영상 입력 수락 변이도 assertion으로 검출 |
| S6 observer |기동/preflight 뒤 참가→STOP0/계측 수거→observer 종료·93 DDS 해제 확인→DELETE 순서 고정. 기존93 검사를 약화하지 않음 |
| S7 실행 계획·TCP |mkdir TMPDIR 추가. ROS/dist-packages는 venv sys.path 뒤에 추가. 읽기 전용 bootstrap 경로 시험으로 venv typing_extensions 우선 확인. 운영 serve()는 원래 NODELAY=1,41ms는 proto0 미리 bind한 시험 소켓에서만이라고 정정 |

원격 호출 동안 조직 쓰기 잠금을 잡지 않는다. 같은 담당자도 새로운 세대로 구분한다.
시작 응답 유실/실패는 STARTING 예약을 보존해 자동 재취득하지 않으며, 실행 증거와
목록을 확인한다. 실패한 정지는 world/슬롯 보존·새 기동 차단이다.

## 최종 검사

최종 결과는 실행 완료 후 아래 표에 고정한다. 명령의 공통 환경은 기존 읽기 전용
venv Python과 `PYTHONDONTWRITEBYTECODE=1`, `PYTHONPATH=$PWD/apps/simmgr/tools:$PWD/apps/agent:$PWD`,
`TMPDIR=$PWD/tmp/p1c`, `FH_TEST_PORT_RANGE=9430:9449`다. ROS 환경은 셸에서 제거하지 않았다.

| 검사 | 결과 |
|---|---|
| 서버 전체 pytest |690 passed,738.08초 |
| agent+simmgr 전체 pytest |878 passed,1 skipped,35.47초 |
| 최종 집중 검사 |83 passed (manager+camera+server simulation·4경합 포함); 추가 migration/세대11 passed·unit 상한 인자1 passed |
| 원본 Codex 경합 재현 |2 passed, 이전 DELETE409·새 owner/로봇/출입증 유지 |
| 원본 Claude fps probe(300초 가짜 시계·4ms 흔들림) |5Hz→4.87fps,10/15/30Hz→각4.98fps |
| 기존 발급·폰·link·bridge 변이 |25/79/80/49 전부 KILLED, 종료0 |
| 새 변이 |29/29 KILLED, 모두 assertion·수집/예외 오류0 |
| contracts --check / TS strict |155개 일치 / 종료0 |
| safety/**·안전 상수·셀프테스트·09 ADR 본문 변경 |0 |

최초 집중 검사에서는 시험 로그인 재발급으로 기존 CSRF를 무효화한4건, 새 감사 템플릿
누락2건을 수정했다. 최초 전체 서버는687 passed/2 failed(792.85초)였고 migration2건은 ORM Text와 migration VARCHAR
불일치였다. migration을 맞춘 뒤 해당11건과 최종 전체를 재검사했다. agent 전체 첫 실행
877 passed/1 skipped 뒤 unit의 정상 종료 근거 보존을 보강하고 최종 전체를 재검사했다.
최초 새 변이에서 owner 검사 제거가 다른 guard에 가려 살아남아, 외부 owner는 원격
로봇 조회 전에 거부해야 한다는 회귀 단언을 보강했다. 최종29개는 모두 assertion kill이다.

최종 집중 측정(ROS 없는 loopback)은 최악 JPEG 폭주 tick 기준50.181ms/부하50.126ms,
20ms STOP RTT p95 NODELAY=0 41.394ms/1 0.753ms, 느린 영상 STOP p95 0.468ms다.
가짜 시계 deadman watchdog 관측41.332ms이며 실제 ROS/실폰 정지 시간으로 세지 않는다.
60초 흔들림 회귀는10/15/30Hz 원천4.950/4.967/4.967fps였다.

임시 원본 재현·전체/집중/mutation 실행 로그는 이 worktree tmp/p1c에 두고 커밋하지 않는다.
리스너/목적지9430~9449만, loopback 클라이언트 발신 ephemeral만 허용했다. 무거운 실행 전
MemAvailable≥2.5GB(관측 약4.1~6.7GiB), 새 의존성0. 공개 주소·키·지도·영상 추가0.

실제 native unit의 종료/고아/자원 상한·ROS binding·STOP0 ACK·93 DDS 정리·명령 지연·
실폰/LAN/WSS·UI는 미검증이다. [FIRST-LAUNCH](FIRST-LAUNCH.md)의 별도 P1-C2 승인 실행과
두 모델 재검토가 남는다. native는1대만이며 fake2대 계약은 실제2대 검증을 대신하지 않는다.

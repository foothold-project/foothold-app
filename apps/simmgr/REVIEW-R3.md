# PR #46 3차 검토 반영 기록

기준7b470cb에서 origin/dev `8e70207110b04483c60563122cc04152e3c73b57`을 먼저 일반 merge했다.
merge commit은 `cd91199ccbee3a37782bcb9eaa7b987671c7f5cc`, 충돌0이며05는 자동 병합됐다.
rebase/force push0, 실제 ROS/rclpy/Gazebo·systemd-run unit·native 서비스·실기·설치0이다.

## 결정과 회귀

| 지적 | 반영과 근거 |
|---|---|
| D1 STARTING 영구 예약 |확실한 생성 전 거부는(status,code) 고정9개만 같은 세대/STARTING 검사 아래 출입증 회수·owner 해제·hash 교체·IDLE·START_REJECTED commit. 유실·timeout·5xx·unknown4xx·잘못된 status/code·신원/본문 검증 실패는 STARTING 유지. STARTING에서도 기존 권한의 DELETE로 정리/IDLE/재취득201 |
| D2 재시작 세대 고착 |세대의 정본은 서버 DB 하나. manager tombstone 제거. 로봇이 있으면 같은 세대만 STOP/제거, 없으면 기대 세대와 무관하게200. ACTIVE/STOPPING 재시작과 시작 전/후 유실·신원 불일치 복구 회귀 |
| 부재 전제 |서비스 startup에서 **fake/native 모두** 기존 isolation preflight와 남은 fh-rb-sim/fh-simmgr-agent user unit 부재를 읽기만 검사. 실패/bus 조회 불능이면 API 준비 전 거부. 다른93·61·unit 정리0. 기존93/DDS/resource 검사 변경0. 대역으로 남은93/failed unit·bus 오류·startup 생략 변이 확인 |
| 옛 DELETE·이중 DELETE |기존4경합(관리자 앞/뒤, 같은/다른 소유자) 유지. 서버 완료 시 조직 잠금 아래 세대와 STOPPING을 모두 확인. 같은 세대 이중 DELETE도REMOVED1회·hash 교체1회이며 이전 완료가 IDLE을 다시 바꾸지 않음 |
| E1 unit 시험 |KillSignal=SIGINT 인자, loaded 이름 재사용 거부, agent_entry가 exec 전에 private 파일 삭제를 독립 회귀·변이로 고정 |
| E2 느린/실패한 systemctl |failure는 순수 cached 상태. health·startup poll·STOP signal/wait는 to_thread. show timeout은 실패 상태→503/ERROR로 바꾸고 signal/stop CalledProcessError도 failed+child/world 보존. 느린 status 중 event loop 진행과 각 호출의 다른 thread 실행을 확인 |
| E3 실제 기동 계획 |literal agent reset-failed, 빈 show stdout/bus 원인 구분, 관리자 kill 뒤240s 내 agent 종료 목표·MemoryPeak/task 최대 기록·grace15 별도 판정, startup 부재 증명 뒤 STARTING/STOPPING DELETE 복구 순서 |
| E4 설명/감사 |≤5fps 상한의 근거는0.2초 sampler(원천 격자만 아님). START_REJECTED/REMOVE_FAILED/REMOVE_STALE 차이와 불확실한 시작의 해제 API를05에 명시 |

확실한 거부 목록/서비스 startup 관문은 조정 확인을 받았다. SIM_SLOT_BUSY는 기존 로봇이
있을 수 있어 목록에서 제외한다. 목록 밖 또는 오류 본문 파싱 실패는 자동 해제하지 않는다.
STARTING 중 출입증이 발급됐다면 확실한 거부 해제에도 기존 회수 경로를 사용한다.

권한을 넓히지 않는다. 첫 DELETE204 뒤 owner=None이므로 이전 담당자의 두 번째 DELETE는
기존 O_OWN 규칙상403이다. 이때 slot/owner/hash/감사 불변을 같은 복구 시험에서 단언했다.
원본 Codex restart 재현의 «마지막 DELETE204» 기대는 조정 승인에 따라 첫204·두 번째403·
IDLE·재취득201로 보정했다. 원본 파일은 읽기만, 수정된 재현 사본은 현재 worktree tmp다.
목록에는 DB IDLE 필드가 없으므로 빈 목록만으로 IDLE을 단정하지 않고 로봇 부재와
재취득201을 함께 확인한다는 문구도 조정 확인을 받았다. 새 조회 계약/권한은 만들지 않았다.

## 실행 결과

기존 읽기 전용 venv/TypeScript, 기본 셸 ROS_* 그대로(ROS_DOMAIN_ID=57 포함) 실행했다.
공통 환경은 `PYTHONDONTWRITEBYTECODE=1`,
`PYTHONPATH=$PWD/apps/simmgr/tools:$PWD/apps/agent:$PWD`,
`TMPDIR=$PWD/tmp/p1c`, `FH_TEST_PORT_RANGE=9430:9449`다. env -u 없음.

| 검사 | 결과 |
|---|---|
| dev merge 뒤 최종 서버 전체 |724 passed,843.10초 |
| dev merge 뒤 agent+simmgr 전체(카메라·기존 sim tools 포함) |895 passed,1 skipped,41.07초. 제외0 |
| 최초 manager+server sim 집중 |97 passed,27.78초 |
| 두 검토자 원본 재현7 + 최종 복구 회귀21 |28 passed,31.51초. 시작 실패/유실·재시작 모두 DELETE204→IDLE→재취득201, 반복403 불변 포함 |
| 예비 실행의 ACK pool 경계 단독 재검사 |1 passed,3.63초(범위 밖 코드 변경0) |
| 기존 발급·폰·link·bridge 변이 |35/82/80/49 전부 KILLED, 종료0 |
| 최종 새 변이 |38/38 KILLED, 모두 assertion·수집/실행 오류0 |
| contracts --check / TS strict |155개 일치 / 종료0 |
| safety/**·안전 상수·셀프테스트·09 ADR 본문 변경 |0 |

최초 서버 전체 진행 중, 확실한 거부 해제에도 STARTING 도중 발급분 회수가 필요함을
확인해 자기 pytest에 SIGINT 중단을 요청했다. 해당 실행은 계속 진행되어 비최종
예비 기록으로 분리했다. 회수·회귀 추가 뒤 최종 서버 전체를 별도로 새로 실행했으며
최종 결과를 예비 실행과 혼동하지 않는다. agent/simmgr 전체는1회 완료했다.
그 뒤 조정자가 요청한 반복403의 상태/감사 불변 단언을 집중 검사28건에서 추가 확인했다.

예비 전체는722 passed/1 failed(858.02초)였다. dev에서 합쳐진
`test_three_robot_ack_pool_contention_keeps_links_and_eventually_confirms`의2초 내
모든 acked_at 확인이 실패했고, CSV 시험 중 WeakKeyDictionary 콜백의 KeyboardInterrupt
unraisable 경고도 남았다. SIGINT/병렬 부하와 ACK 실패의 인과는 단정하지 않는다.
최종 전체에서 같은 ACK 시험이 통과했고, 전체 종료 후 그 시험만 단독 재검사해1 passed를
확인했다. 예비 실패를 지우거나 그 실행을 전체 PASS로 바꾸지 않으며 해당 범위 코드는 수정0이다.

새 변이는 기존29개에 부재 세대 거부·확실한 거부 예약 보존·STARTING DELETE 금지·
같은 세대 이중 DELETE 상태 검사 생략·startup 부재 증명 생략·잘못된 종료 신호·unit 재사용·
private 파일 삭제 생략·시작 거부 시 발급분 회수 생략을 더했다. timeout을 kill로 세지 않는다.
임시 검사/원본 사본/로그는 tmp/p1c에만 있으며 커밋하지 않는다.

무거운 실행 전 MemAvailable≥2.5GB(관측 약5.2~6.6GiB), 리스너/목적지9430~9449만,
loopback 발신 ephemeral만 허용했다. 다른 worktree/원본 수정0·새 의존성0·공개 주소/키/
지도/사진/영상 추가0이다. startup OS 검사는 시험에서 전부 대역으로, 실제 unit 조회·정리도0이다.

실제 startup preflight/user bus·unit 수명/고아·메모리/task 상한·ROS binding·STOP0 ACK·
93 DDS 정리·native 명령 지연·실폰/LAN/WSS·UI는 미검증이다. [FIRST-LAUNCH](FIRST-LAUNCH.md)의
별도 P1-C2 승인 실행과 두 모델 재검토가 남는다. native1대/fake2대 구분은 그대로다.

# PR #46 1차 검토 반영 기록

기준659f7fa, 같은 feature/sim-manager에서 수정했다. Gazebo/rclpy/ROS 노드·native 서비스·
실기·설치·원본 수정 실행0. 테스트의 가짜 launch/child와 환경 사전만 사용했다.

## 지적별 결과

| 지적 | 반영과 회귀 |
|---|---|
| B1 제어 평면을93 선점/잔여로 오인 | manager CLI/factory 모두 ROS_*·RMW/DDS 환경 존재를 거부. FH_SIM_DOMAIN=93은 설정만. 자식 허용 목록+unit `env -i`. 실제 자기 /proc 행을 넣은 preflight/close 두 재현 통과, 다른93/61/DDS 검사 유지 |
| B2 서버 WS 주소 | 기본·문서·시험을 `/api/v1/agent/ws`로 일치, 다른 경로는 설정 거부. 그 설정 경로와 생성된 agent token으로 실제 서버 TestClient WS hello→lease/stop 수신 |
| B3 같은 PC | 서버/manager/agent127.0.0.1만. 첫 트리거/측정은 같은 PC driver, localhost 브라우저 secure 쿠키 제약 명시. LAN/실폰은 P1-D |
| R1 토큰·빠진 방어 | 첫 영상만 닫은 뒤 토큰 재사용 거부와 active 상태에서 새 토큰도 거부. pop/active·pending·loopback·owner·키 없음·실제 행 거부·REMOVED 감사 변이 추가 |
| R2 원천 폭주 | 바이트별 FF 탐색을 C 정규식 검색으로, 파싱 전5Hz 제한. 초과 입력은 잠금 밖 sleep(0)로 GIL 양보. 지속 생산자가 제어 loop를 굶기지 않음 |
| R3 영상 대기 고갈/닫기 이유 | 주소별 미인증2개·hello1초, 전체16개. hello/send timeout을1013 CAMERA_HELLO_TIMEOUT/CAMERA_SEND_TIMEOUT으로 구분, 부모 유지 |
| R4 출처/회전 | 일반 agent-token API의 sim 행409 SIM_TOKEN_MANAGED. 화면은 DB RobotSummary.simulation만, welcome/state는 참고용이라고05에 고정 |
| R5 종료 | start_new_session=True.15초 정지 timeout은 failed, 자기 group identity 확인 뒤 TERM→5초→KILL→5초 수거. 강제 종료를 STOP/zero 확인으로 세지 않고 world/슬롯 보존 |
| R6 제거/재사용 | 제거 전 기존 outbox로 회수 commit, 정리 중 발급분도 끝에 조직 잠금 아래 재회수. 성공 시owner 해제·agent hash 교체, 실패면owner 보존·실패 감사 commit. 중계180초 |
| R7 기동 계획 | ROS 없는 제어 평면·agent만 dist-packages, 전용 FH_FILES_ROOT, Ctrl-C1회·실패world 보존·native 출력 승인 범위·50ms/200표본/driver send→agent publish 측정을 명시 |
| R8 20ms RTT | server accepted socket TCP_NODELAY=1. 기본 accept socket이 proto0인 시험 구성에서 Nagle 켜짐/꺼짐 A/B 및20ms 간격60회 회귀 |

**이번 보강의 소유 밖1곳은 조정 승인한 `apps/agent/tools/sim/isolation.py`의 선택 launch_env
연결부뿐**이다. 기본None은 기존 command 경로 그대로, preflight/cleanup/93/61/DDS 검사
변경0. systemd-run 프로세스의 env와 실제 unit payload `env -i`를 명령 인자 수준으로 확인했다.
기존 link/testing.py 변경은 이번 보강에서 추가 수정0, 운영 import0건 그대로다.

## 실행 결과와 순서

서버·에이전트 전체는 각각1회 실행했다. 그 뒤 원본 폭주 재현의 잔여 GIL 경쟁과 제거 중
발급 창을 추가로 보강하고, 바뀐 경계 전체를 최종 집중 검사로 다시 확인했다. 전체 결과를
최종 소스에서 다시 실행한 것처럼 바꾸지 않는다.

| 검사 | 결과 |
|---|---|
| 서버 전체 |682 passed,797.00초 (후반 재회수 보강 전) |
| agent/tests + camera/tests + simmgr/tests 전체 |814 passed,1 skipped,31.90초 (후반 GIL yield/factory guard 보강 전) |
| 최종 manager+camera+server simulation+기존 sim 도구 |118 passed,15.30초. 기존 sim 도구52개 포함 |
| 마지막 서버 중계 집중 |11 passed. 정리 중 발급→끝에서 회수·owner 해제 포함 |
| 원본 Claude camera/RTT + Codex 영상 종료 후 재사용 재현 |3 passed. 이후 최종 camera+원본 폭주 재현16 passed |
| 발급/폰/link/bridge 변이 |25/79/80/49 전부 KILLED, 종료0 |
| 새 변이 |22/22 KILLED, 수집/예외 오류 아닌 assertion kill |
| contracts --check / TS strict |154개 일치 / 종료0 |
| safety/**·안전 상수·셀프테스트·09 ADR 본문 변경 |0 |

기존 venv/TypeScript를 읽기 전용으로 사용했다. TMPDIR은 현재 worktree tmp/p1c,
리스너/목적지9430~9449, 클라이언트 loopback 발신 ephemeral만 허용했다.
무거운 실행 전 MemAvailable2.5GB 이상(관측 약4.8~6.6GiB). 새 의존성0.

## 측정과 실패를 구분한 기록

- Nagle A/B:20ms STOP RTT p95 **41.876ms(off)→1.103ms(on)**. 원본 RTT 진단도 gap20ms
  **0.63ms**, gap0/60ms0.32/0.59ms. 실제 ROS 출력 지연이 아닌 TCP 왕복이다.
- 원본 tight-loop probe에서 파싱/빈도 제한만으로는 tick 최대77.1ms가 남았다.
  드롭 때 GIL을 양보하도록 보강한 동일 원본 재현은 **tick51.8ms, STOP p95 0.98ms**였다.
  별도 cadence 회귀는 기준50.434ms/부하50.193ms. 이 값은 OS 실시간 상한 보장이 아니다.
- 원본의 미인증16개 동일주소 재현은 이제2개만 대기,1초 뒤 해제. 같은 NAT/주소의 정상
  영상도 이2개 대기 예산을 공유한다. 다른 주소는 별도 예산이며 제어 소켓에는 영향 없다.
- 최초 집중 검사의 실패3개는 테스트 셸 ROS57 환경과 기존 가짜 시계 프레임시험을 새
  정책에 맞추기 전 결과였다. 다음 실패2개는 새 최악 JPEG fixture에서 SOF 바이트를
  잘못 잘라낸 시험 문제였다. 수정 후 집중116/최종118 통과; 실패를 PASS로 덮지 않는다.

ROS 실제 실행·native STOP/zero ACK/그룹 종료·unit 메모리/정리·실폰/LAN/WSS·화면 표시·
성능/정지 관문은 미검증이다. 제품 책임자의 별도 P1-C2 승인과 두 모델 재검토가 남는다.
[FIRST-LAUNCH](FIRST-LAUNCH.md)의 native 외부 source 아래 새 출력 쓰기도 승인 범위다.

# 첫 Gazebo 기동·측정 결과 — P1-C2 r2 (2026-10-22)

**판정: 기동·격리·정리 통과, ROS 발행 seq 기준 지연 및 입력 끊김 통과, 전체 수용은 미완료.**
같은 PC driver 시험이며 실폰·UI·실기·배포 검증이 아니다.
기준은 PR #46 통합 `80b1bd8636b37d658fa7a2bc7b78f45a4feee01e`,
r2 시작 head는 `45ed6a9`다. PR #49는 `feature/sim-first-launch` → `dev` Draft다.

제품 책임자의 domain93 첫 기동 승인과 조정자의 r2 지시 아래 `c2-003`을 실행했다.
그 뒤 조정자는 로그 분류를 확인하고 **신선한 중립만 보완한 c2-004에서 deadman 및
unread-video만 재측정**하도록 명시했다. 출입증 확장 행렬·원천 폭주는 구현하지 않고
미확인으로 남기라는 지시를 따랐다. 추가 실행은 하지 않았다.

## r2 수정과 실행 순서

- 시험 observer의 ROS setup source 구간만 `set +u; source …; set -u`로 감쌌다.
  `errexit`와 `pipefail`은 유지한다. 다른 ROS source 경로는 nounset을 켜지 않는 기존
  bootstrap이며 이번에 제품 코드·안전 Core·명령 판정·ROS topic·unit 상한은 바꾸지 않았다.
- 실제 observer와 같은 셸 명령의 `observer_dry`로 setup, 격리 검증, rclpy/메시지 import까지
  확인했다. `rclpy.init`을 호출하지 않아 ROS 참가·DDS socket 생성 없이 종료했다.
- 두 episode 모두 새 격리 DB에 `0014` 적용, 센서 자산/provenance·입력 모델 SHA 검증,
  domain93·DDS UDP·대상 TCP listener 부재 뒤 서버 → 관리자 → POST 순서로 시작했다.
  POST 직전 **MemAvailable≥2500MiB·load1≤9 코드 관문**을 통과했다.
- RUNNING 뒤 observer state 준비 → driver → observer SIGINT/exit0·PID/UDP 해제 →
  DELETE 순서를 지켰다. 그 뒤 자기 관리자·서버·격리 PostgreSQL을 정상 종료했다.
- 입력 끊김 표본은 직전 5개 명령의 비영 ACK가 모두 있어야 유효하다. 정지한 채 반복된
  0을 성공 표본으로 세지 않는다. 각 시행 전 신선한 중립을 보내는 보완은 시험 driver에만 있다.

## 측정표

| 항목 | 결과 | 증거·한계 |
|---|---|---|
| 기본 명령 200개, 50ms 간격 | **ROS 발행 seq 기준 통과** | c2-003: 수신·비영 ACK 200개, publisher 일치 181개, p95 **46.77ms**; 합침 19개, 최대 연속 1개 |
| 기본 입력 끊김→첫 agent ROS0, 20회 | **통과** | c2-004: **20/20**, 마지막 driver send 기준 최대 **397.52ms**, 마지막 agent 수신 기준 최대 397.33ms |
| 읽지 않는 영상 소켓 중 명령 200개 | **ROS 발행 seq 기준 통과** | c2-004: publisher 일치 184개, p95 **46.16ms**, 합침 16개, 최대 연속 1개, 계측상 진짜 유실 0개 |
| 읽지 않는 영상 소켓 중 입력 끊김 | **통과** | c2-004: **20/20**, send 기준 최대 **370.78ms**, agent 수신 기준 최대 370.64ms |
| control/view STOP·잠금·비영 차단 | **관측 범위 통과** | c2-003: 두 STOP 뒤 latched=true·applied0, STOP 뒤 비영 명령 5개 모두0, view의 lease.take 거부 |
| 명시 unlock+신선한 중립 뒤 재개 | **통과** | c2-003: 명시 재개 뒤 비영 명령 5개 모두 비영 ACK; c2-004 마지막 STOP도 잠금·0 확인 |
| 목표 취소·과거 cmd·재접속·서버/영상 재연결 자동 재개 금지 | **미확인** | 활성 목표와 각 재연결 행렬을 만들지 않음; STOP 일부 확인으로 대체하지 않음 |
| 실제 출입증 발급 | **통과** | c2-003 control/view 각1개, c2-004 control1개, 모두 서버 실제 발급·agent hello 성공 |
| 제거 시 출입증 회수·ACK | **ACK 확인 실패** | DB 회수 outbox는 c2-003 2건/c2-004 1건, 최종 acked_at은 각각 **0건**; 회수 기록을 ACK 통과로 간주하지 않음 |
| 출입증 전환·만료·중복·다른 robot/org·단절·동시취득·슬롯 재사용 | **미확인** | 확장 driver 미구현, 조정 지시로 이번에 구현·실행하지 않음 |
| 영상 JPEG 크기·실제 해상도·NO_VIDEO | **관측 범위 통과** | c2-003 109 frame, 최대 **3985 bytes**, 전부 **424×240**, NO_VIDEO 수신; 이미지 저장0 |
| 영상 fps≤5 | **평균 관측 통과 / 엄격한 상한 미확인** | 수신 평균 **4.52fps**, 최소 수신 간격 188.23ms; 평균만으로 모든 시간창의 상한을 증명하지 않음 |
| 영상 부모 종료·만료·회수 시 연결 종료 | **미확인** | driver가 영상 연결을 먼저 닫았으므로 부모 종료 경계의 증거가 아님 |
| 원천 폭주 중 지연/입력 끊김 반복 | **미확인** | driver 미구현, 조정 지시로 생략; unread-video와 구분 |
| STOP 왕복 60회·TCP_NODELAY | **관측 범위 통과** | c2-003 p95 **1.29ms**, TCP_NODELAY=1; 매 응답 뒤 20ms 대기이며 정확한 20ms 절대 송신 격자는 미확인 |
| 초기 STOP true·cmd_applied0·episode≥1·LOCKSTEP | **통과** | c2-003 초기 ROS state와 폰 latched/applied0 확인, episode1·policy_running=true |
| 카메라/시뮬 시각 증가 | **통과** | 초기→최종 sim_t와 camera_frames 증가 확인 |
| native 격리·정상 정리 | **통과** | 두 episode 모두 아래 정리표 통과 |
| 관리자 비정상 종료→240초 내 agent 종료 | **미확인** | 원 지시대로 생략 |

### ROS 발행 seq 판정과 c2-003 실패 보존

원래 정의인 **200개 모두 publisher 일치**로는 c2-003이 **실패**다(181/200).
조정자는 먼저 누락을 분류하고, 최신값 우선 합침이면 **publish된 seq의 p95 + 덮어쓴 seq 수·
최대 연속 누락**을 공개하는 기준으로 판정하라고 지시했다. 이는 원래 정의와 다른 판정이며,
181개만 조용히 남긴 200표본 성공으로 표현하지 않는다. c2-004도 원래 정의는 184/200으로 실패다.

c2-003의 19개는 모두 비영 ACK 뒤 **다음 seq 수신이 다음 publisher 호출보다 먼저**였고,
그 다음 publication은 모두 seq+1의 비영 출력이었다. 각 다음 수신은 48.60~51.21ms,
다음 publish는 49.87~57.55ms 뒤였다. 따라서 latest-only flush 전 합침으로 분류했다.
`latency-classification.json`에 19건을 보존했다. c2-004의 16개도 같은 규칙으로 분류했고
진짜 유실로 분류된 seq는 0개다. 이 분류는 시험 hook의 agent 수신/publisher 기록에 근거한다.
두 episode 모두 recorder overflow는 없었다. publisher 반환 시각은 ROS 전달·몸 정지 시각이 아니다.

c2-003 입력 끊김은 첫 1회만 비영 ACK를 갖춘 유효 표본(369.57ms)이고, 뒤 19회는
`손을 한 번 뗀 뒤 다시 누르세요`로 0이어서 **20회 측정 실패**다. 이어진 unread-video
명령은 비영 ACK가 없어 0/200, 입력 끊김도 0/20 유효로 **실패**했다. 이 결과를 삭제하지
않았으며 c2-004의 신선한 중립 준비 뒤 결과와 구분한다. 제품 정책·기대값은 바꾸지 않았다.

## 기동·정리와 자원

| 항목 | c2-003 | c2-004 (승인된 남은 항목만) |
|---|---:|---:|
| POST 직전 MemAvailable (MiB) | 3591.07 | 4442.74 |
| native preflight MemAvailable (MiB) | 3587.41 | 4442.04 |
| POST 201 RUNNING 소요 (초) | 6.880 | 5.739 |
| 실행 중 MemAvailable 최저 (MiB, 1초 표본) | 2744.02 | 3413.10 |
| 실행 중 load1 최고 | 6.16 | 4.94 |
| swap-in 최대 (KiB/s, 1초 표본) | 3180.58 | 35.64 |
| sim unit MemoryPeak (MiB, 관측 최대) | 839.53 | 502.36 |
| agent unit MemoryPeak (MiB, 관측 최대) | 48.63 | 47.58 |
| sim / agent task 관측 최대 | 102 / 17 | 102 / 17 |
| unit 표본 수 (1초 주기) | 64 | 47 |
| sim / agent RuntimeMaxSec | 240 / 240 | 240 / 240 |
| observer 종료·UDP 해제 | exit0·통과 | exit0·통과 |
| 정상 DELETE | 204 | 204 |
| native 종료 manifest·cleanup complete·원본 SHA·원장 불변 | 통과 | 통과 |
| 보호 도메인 PID/start_ticks 불변 (ROS 참가0) | 통과 | 통과 |
| 자기 sim/agent unit·cgroup·domain93·DDS 잔여 | 모두0 | 모두0 |
| 대상 TCP listener·자기 서버/관리자/격리 DB 잔여 | 모두0 | 모두0 |
| 최종 DB | IDLE·generation1·owner 해제 | IDLE·generation1·owner 해제 |
| REQUESTED/REGISTERED/REMOVED 감사 | 각1건 | 각1건 |

시작 전 여유가 부족했을 때(2462MiB)는 기동하지 않고 기다렸다. 다른 작업자 프로세스를
종료하지 않았다. watcher의 MemAvailable<1500MiB·swap-in>2000KiB/s 10초 지속·만료 5초 전
중단 기준을 유지했다. c2-003 swap-in 순간 최고는 기준을 넘었지만 10초 지속 조건은 충족하지
않아 중단하지 않았다. 1초 task 표본은 전체 시간의 정확한 최대를 증명하지 않는다.
폰 조종 세션 길이 권고: **준비·정리를 포함해 4분 이내 시험 세션**을 유지한다.
새 두 episode의 agent 최대 관측 메모리 48.63MiB·task17만으로 상한 축소나 세션 연장은 권고하지 않는다.

`runs/simmgr/c2-003/`, `runs/simmgr/c2-004/`는 Git 제외 private 증거 폴더(0700)다.
설정·key ring·secret·환경/세션 파일은0600이다. DB는 각각 새 클러스터의 Unix socket만 썼다.
슬롯 키는 서버와 agent에 같은 값으로 사전 배포했다. native 출력은 승인된 source 프로젝트
sensor-spec 아래 새 폴더에만 기록했다. 원본 수정·센서 생성·패키지 설치는 없었다.

## 직전 실행 이력

| 항목 | c2-001 | c2-002 |
|---|---|---|
| 새 격리 DB·마이그레이션 | 0014 통과 | 0014 통과 |
| POST RUNNING / DELETE | 201 / 204 | 201 / 204 |
| 기동 시간 | 7.215초 | 6.028초 |
| 측정 | observer 생성 실패 뒤 driver 실행, 순서 위반 표본 폐기 | setup의 AMENT_TRACE_SETUP_FILES unbound, 준비 관문이 driver 차단 |
| 성능 수용 | 미확인 | 미확인 |
| MemAvailable 최저 | 1902.57MiB | 2192.67MiB |
| sim / agent MemoryPeak | 855.68 / 62.21MiB | 705.70 / 46.98MiB |
| agent / sim task 단회 관측 | 17 / 102 | 17 / 102 |
| 격리·정상 정리·잔여0 | 통과 | 통과 |

c2-001 오류는 observer 환경 구성 중 `control plane must not inherit ROS/DDS environment`였다.
그 뒤 제어 흐름을 단일 의존 순서와 허용 목록 환경으로 바꿨다. c2-002는 nounset 아래 기존
ROS setup을 source하다 종료했다. r2의 제한된 nounset 해제와 dry 단계로 해당 오류를 해결했다.

## 검사·남은 범위·되돌림

최종 simmgr 전체 시험 `python -m pytest apps/simmgr/tests -q --tb=short`: **73 passed**
(기존69 + ROS-free bootstrap/표본 유효성/합침 분류 회귀4).
시험 Python은 기존 승인 venv, 네트워크 fixture는 기존 9430~9449 fence를 사용했다.
도구 AST 구문 검사와 `git diff --check`를 확인했다. ROS dry는 실제 setup으로 두 차례 통과했다.
최종 통합 full driver 경로는 중립 보완 뒤 전체를 다시 실행하지 않았고,
실제 재실행은 `--remaining` 경로뿐이다. 전체 서버/agent 회귀·브라우저·실폰·실기는 실행하지 않았다.

`v5_single/f1`만 catalogue에 포함·기동했다. `v5_building/l1`, `v5_building/l2`는
world/GT 실파일 짝이 있으나 추가 world는 조정 지시로 후속 분리했다.
`rooms_a/f1`은 gt_map이 없어 제외했다. 확장 차단 위치는 `apps/simmgr/launcher.py:97`,
`apps/agent/tools/sim/constants.py:4`, 읽기 전용 source의 `sensor_isolation.py` TARGET/arg_errors다.
지도·점군·사진·영상 원본과 private 자격 증거는 커밋하지 않는다.

되돌림은 시험 도구·결과 문서 커밋의 Git revert다. 모든 자기 시험 프로세스는 종료했고
private DB/증거는 보존했다. 운영 DB migration·서버 교체·웹/APK 배포는 없었다.

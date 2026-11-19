# 조종 정지·잠금·조종권 해제 원인 지도

기준: `origin/dev` 3591441(#391 포함) 이후 RB-LOCK-CAUSES 계측 추가본. **코드 87개(서버 27, 에이전트 60)**, 아래 별도 관문 8개. 모의 표본과 소스에서 확인했으며 과거 r4~r10의 실제 원인을 확정하는 자료는 아니다. 실기·DDS·Jetson·원격 서버·운영 DB는 접촉하지 않았다.

`a` = 명령 0/STOP, `b` = 잠금(명시적인 잠금 해제 필요), `c` = 조종권 해제(조종 시작부터 필요). `(c)`는 당시 실제 controller가 있었을 때만 해제 사건이 남는다는 뜻이다. STOP 요청/명령 0은 실측 정지의 증거가 아니다.

경로: 웹 50 ms 입력 → 서버 조종권/CAS/권한 관문 → 선택 필드 `AgentLease.cause`·`AgentStop.cause` → Session/Core → Go2Sink 정상·독립 비상 레인 → Go2; LowState/SportModeState 실측이 정지 확인으로 되돌아온다. 웹의 숨김·blur·pointer 해제는 새 정책이 아니며 기존 동작 그대로다.

- **입력 0.3 s 만료는 서버가 STOP을 새로 보내는 경로가 아니다.** Core는 `>0.3 s`에서 입력을 0으로 폐기하고, Go2Sink는 별도로 `≥.30 s` 공백을 감시해 잠글 수 있다.
- 서버 **2 s 정지 확인 실패도 추가 STOP을 보내지 않는다.** 조종권을 받기 전 보냈던 STOP이 유지되며 transfer가 취소된다. 이미 있는 `STOP_CONFIRM_FAILED` 결과와 아래 관문 표로 구별한다.
- 서버가 보낸 `lease=null`의 원인을 먼저 기록하므로 뒤의 STOP 전에 연결이 끊겨도 `release` 원인이 남는다. 순서·참조·CAS는 그대로다.
- 화면은 기존 `정지 잠금`, `조종 시작`, `잠금 해제`, 거부 사유만 표시한다. 이 변경은 원인 코드를 웹의 새 문구로 노출하지 않는다.

## 서버에서 전달하는 코드

| 원인 코드 | 발동 조건·기준 값·소스 | 결과 | 사용자가 되돌리는 절차 | 기존 화면 문구 |
|---|---|---|---|---|
| `user_stop` | 사용자 STOP(WS·HTTP), 즉시. 기존 조종권은 유지. [apps/server/fh_server/leases.py:234](../apps/server/fh_server/leases.py#L234) | a/b | 현장 확인 → 잠금 해제 → 손 뗌 | 정지 요청 접수 / 정지 잠금 |
| `lease_release` | 조종 끝내기·명시적 반납. [apps/server/fh_server/leases.py:199](../apps/server/fh_server/leases.py#L199) | a/b/c | 연결·권한 확인 후 조종 시작 → 잠금 해제 → 손 뗌 | 정지 잠금 / 조종권이 비었습니다. |
| `lease_expired` | 마지막 유효 cmd heartbeat 이후 ≥15 s. 화면 ping은 연장하지 않음. [apps/server/fh_server/leases.py:280](../apps/server/fh_server/leases.py#L280) | a/b/c | 연결·권한 확인 후 조종 시작 → 잠금 해제 → 손 뗌 | 정지 잠금 / 조종권이 비었습니다. |
| `lease_take` | 조종권 받기 직전 lease-null → STOP; 확인 전에는 새 권한 없음. [apps/server/fh_server/leases.py:146](../apps/server/fh_server/leases.py#L146) | a/b/(c) | 2 s 안의 실제 정지 확인 후 잠금 해제 | 로봇 정지를 확인한 뒤 조종권을 받습니다. |
| `lease_transfer` | 넘김 수락 직전 기존 권한 반납 → STOP. [apps/server/fh_server/leases.py:197](../apps/server/fh_server/leases.py#L197) | a/b/c | 새 조종자가 정지 확인 후 잠금 해제 | 정지 잠금 / 조종권이 비었습니다. |
| `run_takeover` | RUN 조종권에서 사용자 조종으로 전환하기 전 STOP. [apps/server/fh_server/leases.py:165](../apps/server/fh_server/leases.py#L165) | a/b/c | 연결·권한 확인 후 조종 시작 → 잠금 해제 → 손 뗌 | 일시정지하고 조종 / 정지 잠금 |
| `transfer_canceled` | 수락과 경합한 넘겨받기 취소; 30 s 재요청 제한은 그대로. [apps/server/fh_server/leases.py:125](../apps/server/fh_server/leases.py#L125) | a/b/c | 현재 조종권 확인; 제한이 끝난 뒤 조종 시작 | 정지 잠금 / 조종권이 비었습니다. |
| `screen_hidden` | 조종 화면 떠남·숨김·pagehide가 hidden 전송. [apps/server/fh_server/leases.py:203](../apps/server/fh_server/leases.py#L203) | a/b/c | 연결·권한 확인 후 조종 시작 → 잠금 해제 → 손 뗌 | 정지 잠금; 숨긴 화면에는 새 안내 없음 |
| `access_revoked` | 로봇 읽기/조종 권한 소실. [apps/server/fh_server/realtime.py:900](../apps/server/fh_server/realtime.py#L900) | a/b/c | 담당자에게 접근 권한 확인 후 화면 다시 열기 | 로봇 접근 권한이 없습니다. |
| `robot_changed` | 담당 변경·로봇 삭제. 연결이 끊긴 이전 조종자의 권한도 철회. [apps/server/fh_server/realtime.py:935](../apps/server/fh_server/realtime.py#L935) | a/b/c | 담당/목록 확인; 삭제 로봇은 재개 불가 | 로봇 접근 권한이 없습니다. / 목록에서 제거 |
| `screen_auth_revoked` | 화면 로그인 세션 거부·폐기; deny_screen 또는 revoke_on_close. [apps/server/fh_server/realtime.py:996](../apps/server/fh_server/realtime.py#L996) | a/b/c | 로그인·권한 확인 후 조종 시작 | 로그인이 필요합니다. / 서버 연결이 끊겼습니다. |
| `screen_policy_stale` | 화면 권한 스냅샷 >0.5 s 또는 POLICY_STALE. 5 s 유예 후 닫는 기존 동작 유지. [apps/server/fh_server/realtime.py:1683](../apps/server/fh_server/realtime.py#L1683) | a/b/c | 연결·권한 확인 후 조종 시작 → 잠금 해제 → 손 뗌 | 서버가 권한을 확인하는 중입니다. 잠시 뒤 다시 누르세요. |
| `screen_disconnected` | 화면 연결 소실 중 아직 확정 안 된 transfer 철회. 이미 가진 권한은 15 s 유지. [apps/server/fh_server/realtime.py:1003](../apps/server/fh_server/realtime.py#L1003) | a/b/(c) | 연결·권한 확인 후 조종 시작 → 잠금 해제 → 손 뗌 | 서버 연결이 끊겼습니다. |
| `agent_auth_revoked` | 에이전트 인증 거부·처리 실패·프레임 검증/작업 시한 실패로 retire. [apps/server/fh_server/realtime.py:1018](../apps/server/fh_server/realtime.py#L1018) | a/b/c | 연결·권한 확인 후 조종 시작 → 잠금 해제 → 손 뗌 | 로봇 연결이 끊겨 조종할 수 없습니다. |
| `agent_policy_stale` | 에이전트 인증 갱신 실패 후 스냅샷 >0.5 s. [apps/server/fh_server/realtime.py:1813](../apps/server/fh_server/realtime.py#L1813) | a/b/c | 연결·권한 확인 후 조종 시작 → 잠금 해제 → 손 뗌 | 서버가 로봇 연결을 확인하는 중입니다. |
| `agent_connected` | 새 hello·재연결에서 이전 조종권 정리 및 새 STOP 참조 시작. [apps/server/fh_server/realtime.py:2059](../apps/server/fh_server/realtime.py#L2059) | a/b/c | 연결·권한 확인 후 조종 시작 → 잠금 해제 → 손 뗌 | 정지 잠금 / 로봇 연결과 담당 정보를 확인하고 있습니다. |
| `agent_disconnected` | 현재 에이전트 소켓의 finally 정리. [apps/server/fh_server/realtime.py:2200](../apps/server/fh_server/realtime.py#L2200) | a/b/c | 연결·권한 확인 후 조종 시작 → 잠금 해제 → 손 뗌 | 로봇 연결이 끊겨 조종할 수 없습니다. |
| `agent_silent` | 에이전트 수신 없음 ≥3 s(archive 대기 제외), 소켓 닫기 전 철회. [apps/server/fh_server/realtime.py:2318](../apps/server/fh_server/realtime.py#L2318) | a/b/c | 연결·권한 확인 후 조종 시작 → 잠금 해제 → 손 뗌 | 로봇 연결이 끊겨 조종할 수 없습니다. |
| `field_approval_revoked` | 서버 연결·담당 승인 정본 소실/담당 변경. [apps/server/fh_server/realtime.py:895](../apps/server/fh_server/realtime.py#L895) | a/b/c | 연결·권한 확인 후 조종 시작 → 잠금 해제 → 손 뗌 | 로봇 연결과 담당 정보를 확인하고 있습니다. |
| `audit_unavailable` | 서버 감사 기록 저장 실패/포화의 emergency_free; 모든 안전 출력 먼저. [apps/server/fh_server/realtime.py:1271](../apps/server/fh_server/realtime.py#L1271) | a/b/c | 연결·권한 확인 후 조종 시작 → 잠금 해제 → 손 뗌 | 서버 기록을 확인하고 있습니다. |
| `run_finished` | 현재 RUN의 종료 상태가 저장됐고 해당 RUN lease와 일치. [apps/server/fh_server/realtime.py:1970](../apps/server/fh_server/realtime.py#L1970) | a/b/c | 필요하면 조종 시작 → 잠금 해제 | 시나리오 종료 상태 / 정지 잠금 |
| `transfer_access_lost` | 정지 확인 직전에 요청자 연결·권한 재확인 실패. [apps/server/fh_server/realtime.py:2282](../apps/server/fh_server/realtime.py#L2282) | a/b/c | 요청자 연결·담당 확인 후 다시 조종 시작 | 요청자 연결이 끊겼습니다. / 권한 오류 |
| `archive_blocked` | 해당 로봇의 기록 저장 채널 차단. 종료 직전 직접 보낸 lease/STOP에도 같은 코드. [apps/server/fh_server/realtime.py:2367](../apps/server/fh_server/realtime.py#L2367) | a/b/c | 연결·권한 확인 후 조종 시작 → 잠금 해제 → 손 뗌 | 로봇 기록 저장을 확인하세요. |
| `drive_command_rejected` | 실기 시험 명령표·조직 속도 상한 밖의 입력; 기존 권한은 유지. [apps/server/fh_server/realtime.py:1548](../apps/server/fh_server/realtime.py#L1548) | a/b | 허용 입력·설정 확인 → 잠금 해제 | 허용된 시험 명령표 또는 조직 속도 상한 밖 입력입니다. |
| `drive_frame_invalid` | 현재 조종권자의 실기 cmd 검증 실패에서 기존 STOP 경로. [apps/server/fh_server/realtime.py:1570](../apps/server/fh_server/realtime.py#L1570) | a/b | 입력 형식 확인 → 잠금 해제 | 입력 형식을 확인하세요. |
| `drive_settings_changed` | 조직 상한/실기 빠른 이동 설정 변경 뒤 현재 출력이 새 제한 밖. [apps/server/fh_server/realtime.py:1199](../apps/server/fh_server/realtime.py#L1199) | a/b | 새 속도 설정 확인 → 잠금 해제 | 정지 잠금; 별도 새 문구 없음 |
| `unknown` | 옛 lease/STOP의 cause 누락·null·허용 목록 밖. 원인을 추측하지 않음. [apps/server/fh_server/leases.py:128](../apps/server/fh_server/leases.py#L128) | a/b/(c) | 기존 화면과 현장 상태로 확인 후 기존 절차 | 기존 정지 잠금·조종권 안내 그대로 |

## 에이전트 로컬 코드

서버 코드가 있으면 그대로 `source=server`로 기록한다. 아래는 `source=agent`다. 여러 관문이 동시에 실패하면 기존 단락 평가 순서에서 **처음 실패한 조건**을 기록하며 다른 조건을 다시 조회하지 않는다.

| 원인 코드 | 발동 조건·기준 값·소스 | 결과 | 사용자가 되돌리는 절차 | 기존 화면 문구 |
|---|---|---|---|---|
| `startup` | Session 생성 시 즉시 잠금. [apps/agent/foothold_agent/link/session.py:80](../apps/agent/foothold_agent/link/session.py#L80) | a/b | 현장 상태 확인 → 잠금 해제 → 새 손 뗌 | 정지 잠금 |
| `connection_changed` | Session connect/reconnect 즉시 STOP. Setup 승인 epoch는 연결 변경 시 철회. [apps/agent/foothold_agent/link/session.py:309](../apps/agent/foothold_agent/link/session.py#L309) | a/b/(c) | 다시 연결 → 조종 시작 → 잠금 해제 | 서버 연결이 끊겼습니다. / 정지 잠금 |
| `link_grace_expired` | RUN 링크 수신 ≥3 s 뒤, 정한 link_loss_wait_s(0..30 s)까지 경과하면 STOP. [apps/agent/foothold_agent/link/session.py:202](../apps/agent/foothold_agent/link/session.py#L202) | a/b | 연결 회복 후 RUN 상태·잠금 확인 | 시나리오 일시정지 / 정지 잠금 |
| `output_stalled` | 출력 감시 stall_sequence가 바뀐 것을 Session이 관측. 아래 output_*의 전달 요약 코드. [apps/agent/foothold_agent/link/session.py:232](../apps/agent/foothold_agent/link/session.py#L232) | a/b | 현장 상태 확인 → 잠금 해제 → 새 손 뗌 | 출력이 늦어져 로봇을 멈췄습니다 — 다시 잠금 해제하면 이어집니다. |
| `generation_exhausted` | Core stop_gen >2**53-1; 참조/CAS 재사용 금지. [apps/agent/foothold_agent/link/session.py:284](../apps/agent/foothold_agent/link/session.py#L284) | a/b | 연결 프로그램 재연결·상태 조정 필요; 자동 해제 없음 | 정지 잠금 |
| `protocol_mismatch` | fh-agent/2와 다른 프로토콜. [apps/agent/foothold_agent/link/session.py:329](../apps/agent/foothold_agent/link/session.py#L329) | a/b | 서버·연결 프로그램 버전 확인 후 재연결 | 정지 잠금 |
| `history_blocked` | 영구 기록 저장 차단. lease 폐기. [apps/agent/foothold_agent/link/session.py:338](../apps/agent/foothold_agent/link/session.py#L338) | a/b/c | 기록 저장 복구 → 재연결 → 조종 시작 | 정지 잠금 / 연결 프로그램 기록 오류 |
| `history_unavailable` | retain 중 로컬 영구 기록 사용 불가; STOP. [apps/agent/foothold_agent/link/session.py:132](../apps/agent/foothold_agent/link/session.py#L132) | a/b | 기록 저장 복구 후 명시적으로 다시 조종 | 정지 잠금 |
| `transport_backpressure` | 송신 큐 포화; transport를 닫고 STOP snapshot 유지. [apps/agent/foothold_agent/link/session.py:352](../apps/agent/foothold_agent/link/session.py#L352) | a/b | 연결 회복 뒤 조종 시작·잠금 해제 | 정지 잠금 |
| `server_auth_rejected` | 서버 transport close가 재시도 불가 인증 거부. [apps/agent/foothold_agent/link/session.py:372](../apps/agent/foothold_agent/link/session.py#L372) | a/b | 연결 인증 복구 후 재연결 | 정지 잠금 |
| `shutdown` | 클라이언트 종료. Setup은 승인도 철회. [apps/agent/foothold_agent/link/session.py:395](../apps/agent/foothold_agent/link/session.py#L395) | a/b/(c) | 프로그램 다시 연결 → 조종 시작 → 잠금 해제 | 로봇 연결이 끊겼습니다. |
| `invalid_lease` | 무효 lease와 기존 무잠금 상태; 유효한 새 권한 생성 안 함. [apps/agent/foothold_agent/link/session.py:455](../apps/agent/foothold_agent/link/session.py#L455) | a/b | 서버 조종권 상태 확인 → 조종 시작 | 정지 잠금 |
| `feedback_lost` | 실기 DDS sample 없음 또는 consume가 정상 보행 조건을 잃음; 기존 lease는 유지. [apps/agent/foothold_agent/go2_direct/server.py:56](../apps/agent/foothold_agent/go2_direct/server.py#L56) | a/b | 센서·운동 상태 회복 → 실측 정지 확인 → 잠금 해제 | 정지 잠금 |
| `transport_closed` | 실기 서버 소켓 닫힘 즉시 STOP(일반 Session grace와 별개). Setup은 승인 철회. [apps/agent/foothold_agent/go2_direct/server.py:63](../apps/agent/foothold_agent/go2_direct/server.py#L63) | a/b/(c) | 다시 연결 → 조종 시작 → 잠금 해제 | 로봇 연결이 끊겼습니다. |
| `action_requested` | 허가된 Go2 action을 접수하면 동작 전 Core 잠금. [apps/agent/foothold_agent/go2_direct/server.py:83](../apps/agent/foothold_agent/go2_direct/server.py#L83) | a/b | 동작 완료·실측 정지 확인 → 잠금 해제 | 동작 상태 / 정지 잠금 |
| `posture_requested` | 일어서기/엎드리기 접수 시 동작 전 Core 잠금. [apps/agent/foothold_agent/go2_direct/server.py:95](../apps/agent/foothold_agent/go2_direct/server.py#L95) | a/b | 자세 동작 완료·실측 정지 확인 → 잠금 해제 | 일어서는 중… / 엎드리는 중… / 정지 잠금 |
| `command_outside_table` | 실기 서버 입력이 허용 속도표 바깥; 현재 feedback 무효화 후 STOP. [apps/agent/foothold_agent/go2_direct/server.py:104](../apps/agent/foothold_agent/go2_direct/server.py#L104) | a/b | 허용 입력·연결 프로그램 확인 → 잠금 해제 | 정지 잠금 |
| `other_stop` | 고정 목록에 없는 로컬 STOP 호출; 사용자 값은 기록하지 않음. 폰 Hub의 내부 stop도 agent 출처. [apps/agent/foothold_agent/safety/core.py:242](../apps/agent/foothold_agent/safety/core.py#L242) | a/b | 현장 상태 확인 → 잠금 해제 → 새 손 뗌 | 정지 잠금 |
| `lease_changed` | 로컬 Hub 등 내부 lease 변경으로 Core controller 반납. [apps/agent/foothold_agent/safety/core.py:217](../apps/agent/foothold_agent/safety/core.py#L217) | a/b/c | 새 조종자가 조종 시작 → 잠금 해제 | 정지 잠금 |
| `lock_transition` | 명시 원인을 지정하지 않은 Core._lock의 고정 fallback. [apps/agent/foothold_agent/safety/core.py:160](../apps/agent/foothold_agent/safety/core.py#L160) | a/b | 현장 상태 확인 → 잠금 해제 → 새 손 뗌 | 정지 잠금 |
| `episode_changed` | 받은 episode가 직전과 다름. STOP 세대 증가. [apps/agent/foothold_agent/safety/core.py:196](../apps/agent/foothold_agent/safety/core.py#L196) | a/b | 새 상태 확인 → 잠금 해제 | 정지 잠금 |
| `robot_stop` | Core가 풀린 중에 실제/시뮬 stop_requested=true 수신. [apps/agent/foothold_agent/safety/core.py:204](../apps/agent/foothold_agent/safety/core.py#L204) | a/b | 실측 정지 확인 → 잠금 해제 | 정지 잠금 |
| `reset_requested` | 허가된 reset 접수 시 잠금. [apps/agent/foothold_agent/safety/core.py:283](../apps/agent/foothold_agent/safety/core.py#L283) | a/b | 리셋 완료 후 상태 확인 → 잠금 해제 | 정지 잠금 |
| `reset_finished` | 진행 중인 reset의 성공/실패 응답 수신 시 잠금 유지. [apps/agent/foothold_agent/safety/core.py:291](../apps/agent/foothold_agent/safety/core.py#L291) | a/b | 리셋 결과 확인 → 잠금 해제 | 정지 잠금 |
| `sim_busy` | 지도 체험/시뮬 전환 busy; 기존 controller 반납 후 잠금. [apps/agent/foothold_agent/safety/core.py:297](../apps/agent/foothold_agent/safety/core.py#L297) | a/b/(c) | 처리 완료 후 조종 시작 → 잠금 해제 | 시뮬 처리 안내 / 정지 잠금 |
| `input_invalid` | 권한 있는 Core cmd의 axes 형식 무효; 입력 폐기. [apps/agent/foothold_agent/safety/core.py:232](../apps/agent/foothold_agent/safety/core.py#L232) | a | 올바른 새 중립 입력 뒤 다시 누르기 | 형식 오류 입력 → 명령 0(로컬 사건); 웹 전용 새 문구 없음 |
| `input_deadman` | 마지막 입력 이후 >0.3 s이고 이전 intent가 비영. Core 자체는 latch/lease를 바꾸지 않음. [apps/agent/foothold_agent/safety/core.py:334](../apps/agent/foothold_agent/safety/core.py#L334) | a | 손을 뗀 뒤 다시 누르기; 출력 감시도 잠갔다면 잠금 해제 | 웹 전용 새 문구 없음(로컬: 입력 끊김 0.3 s → 명령 0) |
| `sim_unseen` | 정상 상태를 보던 중 Core 상태 없음. [apps/agent/foothold_agent/safety/core.py:174](../apps/agent/foothold_agent/safety/core.py#L174) | a | 정상 상태 회복 → 새 손 뗌; 자체로는 조종권 해제 안 함 | 시뮬 상태 미수신(로컬 사건); 웹 전용 새 문구 없음 |
| `sim_stale` | 상태 수신 나이 >1.0 s. [apps/agent/foothold_agent/safety/core.py:176](../apps/agent/foothold_agent/safety/core.py#L176) | a | 정상 상태 회복 → 새 손 뗌; 자체로는 조종권 해제 안 함 | 시뮬 상태 끊김(로컬 사건); 웹 전용 새 문구 없음 |
| `sim_resetting` | state.reset_in_progress=true. [apps/agent/foothold_agent/safety/core.py:178](../apps/agent/foothold_agent/safety/core.py#L178) | a | 정상 상태 회복 → 새 손 뗌; 자체로는 조종권 해제 안 함 | 시뮬 리셋 중(로컬 사건); 웹 전용 새 문구 없음 |
| `policy_not_running` | state.policy_running=false. 실기는 보행 상태 검증 실패도 이 관문으로 투영됨. [apps/agent/foothold_agent/safety/core.py:180](../apps/agent/foothold_agent/safety/core.py#L180) | a | 정상 상태 회복 → 새 손 뗌; 자체로는 조종권 해제 안 함 | 정책 미실행(로컬 사건); 웹 전용 새 문구 없음 |
| `executor_stalled` | 현재 RUN executor 입력 나이 >0.3 s; 입력 폐기와 FAILED. [apps/agent/foothold_agent/link/session.py:212](../apps/agent/foothold_agent/link/session.py#L212) | a | executor·RUN 결과 확인 후 새 조종 절차 | 실행 실패 / EXECUTOR_STALLED 기록 |
| `link_lost` | Setup 승인 유효성 검사에서 session.link_lost; Session의 3 s 판정 뒤 승인 철회. [apps/agent/foothold_agent/setup/runtime.py:231](../apps/agent/foothold_agent/setup/runtime.py#L231) | a/b/(c) | 연결 회복 → 새 승인 epoch → 조종 시작 | 로봇 연결이 끊겼습니다. |
| `approval_revoked` | expires_at=null 또는 명시적 현장 승인 철회. [apps/agent/foothold_agent/setup/runtime.py:183](../apps/agent/foothold_agent/setup/runtime.py#L183) | a/b/(c) | 랜선·연결·담당 확인 → 자동 승인 갱신 대기 → 조종 시작·잠금 해제 | 읽기 전용 · 현장 안전 확인 필요 / 정지 잠금(원인별 새 웹 문구 없음) |
| `approval_invalid` | 승인 마커 값/유효 구간 검증 실패. [apps/agent/foothold_agent/setup/runtime.py:140](../apps/agent/foothold_agent/setup/runtime.py#L140) | a/b/(c) | 랜선·연결·담당 확인 → 자동 승인 갱신 대기 → 조종 시작·잠금 해제 | 읽기 전용 · 현장 안전 확인 필요 / 정지 잠금(원인별 새 웹 문구 없음) |
| `approval_connection` | 옛 승인 재사용·연결 안 된 상태에 새 승인. [apps/agent/foothold_agent/setup/runtime.py:147](../apps/agent/foothold_agent/setup/runtime.py#L147) | a/b/(c) | 랜선·연결·담당 확인 → 자동 승인 갱신 대기 → 조종 시작·잠금 해제 | 읽기 전용 · 현장 안전 확인 필요 / 정지 잠금(원인별 새 웹 문구 없음) |
| `approval_expired` | monotonic deadline 도달 또는 wall 만료. 서버 마커는 30분 유효/60 s 갱신. [apps/agent/foothold_agent/setup/runtime.py:223](../apps/agent/foothold_agent/setup/runtime.py#L223) | a/b/(c) | 랜선·연결·담당 확인 → 자동 승인 갱신 대기 → 조종 시작·잠금 해제 | 읽기 전용 · 현장 안전 확인 필요 / 정지 잠금(원인별 새 웹 문구 없음) |
| `approval_replaced` | 새 활성화 전에 기존 epoch 정리. 정상 승인 시작에서도 한 번 발생 가능. [apps/agent/foothold_agent/setup/runtime.py:173](../apps/agent/foothold_agent/setup/runtime.py#L173) | a/b/(c) | 랜선·연결·담당 확인 → 자동 승인 갱신 대기 → 조종 시작·잠금 해제 | 읽기 전용 · 현장 안전 확인 필요 / 정지 잠금(원인별 새 웹 문구 없음) |
| `preflight_unavailable` | 기존 ready=false. [apps/agent/foothold_agent/setup/runtime.py:221](../apps/agent/foothold_agent/setup/runtime.py#L221) | a/b/(c) | 랜선·연결·담당 확인 → 자동 승인 갱신 대기 → 조종 시작·잠금 해제 | 읽기 전용 · 현장 안전 확인 필요 / 정지 잠금(원인별 새 웹 문구 없음) |
| `nic_mismatch` | check_nic 결과가 True가 아님. [apps/agent/foothold_agent/setup/runtime.py:323](../apps/agent/foothold_agent/setup/runtime.py#L323) | a/b/(c) | 랜선·연결·담당 확인 → 자동 승인 갱신 대기 → 조종 시작·잠금 해제 | 읽기 전용 · 현장 안전 확인 필요 / 정지 잠금(원인별 새 웹 문구 없음) |
| `nic_check_failed` | 비동기 NIC 확인에서 예외. [apps/agent/foothold_agent/setup/runtime.py:370](../apps/agent/foothold_agent/setup/runtime.py#L370) | a/b/(c) | 랜선·연결·담당 확인 → 자동 승인 갱신 대기 → 조종 시작·잠금 해제 | 읽기 전용 · 현장 안전 확인 필요 / 정지 잠금(원인별 새 웹 문구 없음) |
| `nic_check_delayed` | NIC 작업 미완료이고 stamp-next_nic >.20 s. next_nic=시작+.1이므로 작업 시작부터는 약 .30 s 이후(기존 식 그대로). [apps/agent/foothold_agent/setup/runtime.py:372](../apps/agent/foothold_agent/setup/runtime.py#L372) | a/b/(c) | 랜선·연결·담당 확인 → 자동 승인 갱신 대기 → 조종 시작·잠금 해제 | 읽기 전용 · 현장 안전 확인 필요 / 정지 잠금(원인별 새 웹 문구 없음) |
| `identity_changed` | 승인 serial 불일치 또는 MacIdentity가 다른 몸/serial을 확인한 failure_epoch. [apps/agent/foothold_agent/setup/runtime.py:228](../apps/agent/foothold_agent/setup/runtime.py#L228) | a/b/(c) | 랜선·연결·담당 확인 → 자동 승인 갱신 대기 → 조종 시작·잠금 해제 | 읽기 전용 · 현장 안전 확인 필요 / 정지 잠금(원인별 새 웹 문구 없음) |
| `identity_unavailable` | 관측 identity 조회 ValueError/PermissionError; DDS identity 나이 허용 ≤.20 s. [apps/agent/foothold_agent/setup/runtime.py:234](../apps/agent/foothold_agent/setup/runtime.py#L234) | a/b/(c) | 랜선·연결·담당 확인 → 자동 승인 갱신 대기 → 조종 시작·잠금 해제 | 읽기 전용 · 현장 안전 확인 필요 / 정지 잠금(원인별 새 웹 문구 없음) |
| `identity_check_failed` | MacIdentity 실패 epoch 변화(커널 조회 실패·일시 미확인); 성공이 사이에 와도 옛 승인 철회. [apps/agent/foothold_agent/setup/runtime.py:226](../apps/agent/foothold_agent/setup/runtime.py#L226) | a/b/(c) | 랜선·연결·담당 확인 → 자동 승인 갱신 대기 → 조종 시작·잠금 해제 | 읽기 전용 · 현장 안전 확인 필요 / 정지 잠금(원인별 새 웹 문구 없음) |
| `feedback_identity_conflict` | Feedback의 영구 serial 충돌 fault. [apps/agent/foothold_agent/setup/runtime.py:229](../apps/agent/foothold_agent/setup/runtime.py#L229) | a/b/(c) | 랜선·연결·담당 확인 → 자동 승인 갱신 대기 → 조종 시작·잠금 해제 | 읽기 전용 · 현장 안전 확인 필요 / 정지 잠금(원인별 새 웹 문구 없음) |
| `activation_feedback_lost` | SDK 구성 뒤 활성화 직전 feedback.sample 없음. [apps/agent/foothold_agent/setup/runtime.py:267](../apps/agent/foothold_agent/setup/runtime.py#L267) | a/b/(c) | 랜선·연결·담당 확인 → 자동 승인 갱신 대기 → 조종 시작·잠금 해제 | 읽기 전용 · 현장 안전 확인 필요 / 정지 잠금(원인별 새 웹 문구 없음) |
| `runtime_exit` | setup.run finally에서 독립 SDK 레인 STOP 후 worker 닫음. [apps/agent/foothold_agent/setup/runtime.py:473](../apps/agent/foothold_agent/setup/runtime.py#L473) | a/b/(c) | 랜선·연결·담당 확인 → 자동 승인 갱신 대기 → 조종 시작·잠금 해제 | 읽기 전용 · 현장 안전 확인 필요 / 정지 잠금(원인별 새 웹 문구 없음) |
| `identity_check_delayed` | MacIdentity 검사가 executor 대기 포함 0≤경과<.20 s를 넘김. 긍정적 충돌과 구별. [apps/agent/foothold_agent/setup/identity.py:73](../apps/agent/foothold_agent/setup/identity.py#L73) | a/b/(c) | 새 신선한 기체 확인 → 새 승인·조종권·잠금 해제 | 로봇 확인 잠시 안 됨 · 이동 잠김 |
| `output_apply_stalled` | 잠금이 풀린 상태에서 SDK sink apply 공백 ≥.30 s. 이미 잠긴 idle의 반복 watchdog은 새 사건으로 세지 않음. [apps/agent/foothold_agent/go2_direct/sink.py:293](../apps/agent/foothold_agent/go2_direct/sink.py#L293) | a/b | 출력/연결 원인 복구 → 실측 정지 확인 → 잠금 해제 | 출력이 늦어져 로봇을 멈췄습니다 — 다시 잠금 해제하면 이어집니다.(stall 계열); 나머지는 정지 잠금 |
| `output_drain_stalled` | apply는 신선하지만 정상 출력 worker drain 공백 ≥.30 s. [apps/agent/foothold_agent/go2_direct/sink.py:294](../apps/agent/foothold_agent/go2_direct/sink.py#L294) | a/b | 출력/연결 원인 복구 → 실측 정지 확인 → 잠금 해제 | 출력이 늦어져 로봇을 멈췄습니다 — 다시 잠금 해제하면 이어집니다.(stall 계열); 나머지는 정지 잠금 |
| `output_input_stale` | 위 두 조건이 아니고 원래 사용자 입력 나이가 ≥.30 s 또는 비영 입력의 원래 시각이 무효. [apps/agent/foothold_agent/go2_direct/sink.py:294](../apps/agent/foothold_agent/go2_direct/sink.py#L294) | a/b | 출력/연결 원인 복구 → 실측 정지 확인 → 잠금 해제 | 출력이 늦어져 로봇을 멈췄습니다 — 다시 잠금 해제하면 이어집니다.(stall 계열); 나머지는 정지 잠금 |
| `output_fault` | SDK/worker 출력에서 최초 예외; 원래 예외는 유지. [apps/agent/foothold_agent/go2_direct/sink.py:552](../apps/agent/foothold_agent/go2_direct/sink.py#L552) | a/b | 출력/연결 원인 복구 → 실측 정지 확인 → 잠금 해제 | 출력이 늦어져 로봇을 멈췄습니다 — 다시 잠금 해제하면 이어집니다.(stall 계열); 나머지는 정지 잠금 |
| `output_workers_unready` | 실제 모드에서 독립 worker 2개가 모두 살아 있지 않음. [apps/agent/foothold_agent/go2_direct/sink.py:331](../apps/agent/foothold_agent/go2_direct/sink.py#L331) | a/b | 출력/연결 원인 복구 → 실측 정지 확인 → 잠금 해제 | 출력이 늦어져 로봇을 멈췄습니다 — 다시 잠금 해제하면 이어집니다.(stall 계열); 나머지는 정지 잠금 |
| `output_source_changed` | 선택된 출력 source가 바뀌어 기존 pending을 폐기. [apps/agent/foothold_agent/go2_direct/sink.py:300](../apps/agent/foothold_agent/go2_direct/sink.py#L300) | a/b | 출력/연결 원인 복구 → 실측 정지 확인 → 잠금 해제 | 출력이 늦어져 로봇을 멈췄습니다 — 다시 잠금 해제하면 이어집니다.(stall 계열); 나머지는 정지 잠금 |
| `output_source_invalid` | 선택한 출력 source와 다른 apply/unlock. [apps/agent/foothold_agent/go2_direct/sink.py:368](../apps/agent/foothold_agent/go2_direct/sink.py#L368) | a/b | 출력/연결 원인 복구 → 실측 정지 확인 → 잠금 해제 | 출력이 늦어져 로봇을 멈췄습니다 — 다시 잠금 해제하면 이어집니다.(stall 계열); 나머지는 정지 잠금 |
| `output_command_invalid` | stop/unlock/apply 이외의 MotionCommand kind. [apps/agent/foothold_agent/go2_direct/sink.py:382](../apps/agent/foothold_agent/go2_direct/sink.py#L382) | a/b | 출력/연결 원인 복구 → 실측 정지 확인 → 잠금 해제 | 출력이 늦어져 로봇을 멈췄습니다 — 다시 잠금 해제하면 이어집니다.(stall 계열); 나머지는 정지 잠금 |
| `output_velocity_invalid` | 기존 속도표/limits 투영 거부. [apps/agent/foothold_agent/go2_direct/sink.py:391](../apps/agent/foothold_agent/go2_direct/sink.py#L391) | a/b | 출력/연결 원인 복구 → 실측 정지 확인 → 잠금 해제 | 출력이 늦어져 로봇을 멈췄습니다 — 다시 잠금 해제하면 이어집니다.(stall 계열); 나머지는 정지 잠금 |
| `output_closed` | sink close로 독립 레인 STOP, worker 종료. [apps/agent/foothold_agent/go2_direct/sink.py:690](../apps/agent/foothold_agent/go2_direct/sink.py#L690) | a/b | 출력/연결 원인 복구 → 실측 정지 확인 → 잠금 해제 | 출력이 늦어져 로봇을 멈췄습니다 — 다시 잠금 해제하면 이어집니다.(stall 계열); 나머지는 정지 잠금 |
| `output_posture_hold` | 측정 자세가 walkable 아님/동작 중, 비영 요청을 0으로 투영. latch 자체를 새로 만들지는 않음. [apps/agent/foothold_agent/go2_direct/sink.py:412](../apps/agent/foothold_agent/go2_direct/sink.py#L412) | a | 자세 동작 완료 또는 일어서기 → 실측 상태 확인 | 로봇이 엎드려 있습니다. «일어서기»를 누르면 걸을 수 있습니다. / 자세 상태 안내 |

## 이미 멈추거나 잠긴 상태에서 재개를 막는 관문 8개

아래 이름은 기존 오류·관측 분류다. 새로운 `GO2_LOCK cause` 코드를 만들거나 2 s 실패 때 STOP 프레임을 추가하지 않았다. 원인 코드 표의 개수에 포함하지 않는다.

| 기존 코드·관문 | 발동 조건·기준 값·소스 | 결과 | 사용자가 되돌리는 절차 | 기존 화면 문구 |
|---|---|---|---|---|
| `STOP_CONFIRM_FAILED` | transfer 시작 후 ≥2 s, 또는 인과 stop_ref·잠금·applied=[0,0,0] 확인 불성립. [apps/server/fh_server/leases.py:268](../apps/server/fh_server/leases.py#L268) | 기존 a/b 유지; 미발급 권한은 주지 않음 | 현장 확인 후 조종 시작 다시 | 로봇 정지 확인 실패. 조종권은 비어 있고 로봇은 정지 요청 상태입니다. 현장을 확인한 뒤 다시 조종 시작하세요. |
| `STOP_REF_EXHAUSTED` | 서버 stop_ref ≥2**53-1; 이미 보낸 STOP은 유지. [apps/server/fh_server/leases.py:148](../apps/server/fh_server/leases.py#L148) | a/b 유지·grant 금지 | 로봇 연결 프로그램 재연결·상태 조정 | 로봇을 다시 연결해야 조종권을 줄 수 있습니다. |
| `STILL_MOVING / STOP_UNCONFIRMED` | Go2 실측 vx/vy≤.02 m/s, vz≤.06 m/s, yaw≤.03 rad/s, gyro≤.05 rad/s, 관절 dq≤.10 rad/s 모두 필요. sink 세대와 신선도도 일치해야 함. [apps/agent/foothold_agent/go2_direct/feedback.py:247](../apps/agent/foothold_agent/go2_direct/feedback.py#L247) | b 유지; 신규 잠금 아님 | 현장에서 정지 확인 뒤 잠금 해제 다시 | 거절 사유: STILL_MOVING — 축별 값/기준 |
| `FEEDBACK_FRESHNESS` | Low/Sport 둘 다 0≤수신 나이≤FEEDBACK_MAX_AGE_S=.20 s; mode 0/1/3·progress=0·높이 0.20~0.50 m·tilt<π/3. 시험 허용 운동 상태만 통과. [apps/agent/foothold_agent/go2_direct/feedback.py:232](../apps/agent/foothold_agent/go2_direct/feedback.py#L232) | 확인 불가면 b 유지; 정상→비정상은 feedback_lost | 센서·자세 회복 후 잠금 해제 | 거절 사유: STATE_UNSEEN / STOP_UNCONFIRMED 등 |
| `RESUME_IDENTITY` | unlock마다 비동기 기체 확인, STOP·lease·sink 세대 동일 및 경과 <.30 s. [apps/agent/foothold_agent/go2_direct/identity.py:107](../apps/agent/foothold_agent/go2_direct/identity.py#L107) | 실패하면 기존 feedback_lost로 a/b | 랜선·기체 확인 후 잠금 해제 다시 | 로봇 확인 잠시 안 됨 · 이동 잠김 / 정지 잠금 |
| `STOP_GEN_MISMATCH / OUTPUT_HELD` | lease/CAS 불일치 또는 출력 정지 확인 미완료. [apps/agent/foothold_agent/link/session.py:529](../apps/agent/foothold_agent/link/session.py#L529) | b 유지; 신규 잠금 아님 | 최신 상태 확인 후 잠금 해제 다시 | 정지 상태가 바뀌었습니다. [잠금 해제]를 다시 누르세요. / 거절 사유 |
| `RESUME/RESET_WAIT` | 잠금 해제 확인 >3 s, reset 응답 >35 s; 대기 해제만, 기존 STOP 유지. [apps/agent/foothold_agent/safety/core.py:312](../apps/agent/foothold_agent/safety/core.py#L312) | a/b 유지 | 결과·상태 확인 후 다시 요청 | 잠금 해제 확인 대기 / 로컬: 다시 누르세요 |
| `WEB_INPUT_ZERO` | 50 ms 반복. 손 뗌·blur·hidden·STOP이면 즉시 새 0; hidden/pagehide는 별도 조종권 반납. 서버→에이전트 입력 공백은 위 deadman이 담당. [apps/web/src/serverdrive.tsx:3](../apps/web/src/serverdrive.tsx#L3) | a; hidden이면 a/b/c | 창이 보이고 연결됨을 확인 후 새로 누르기; 반납됐으면 조종 시작 | 서버 연결이 끊겨 조종할 수 없습니다. 다시 연결되면 누르세요. |

추가 화면 정본: [웹 연결·lease·STOP 문구](../apps/web/src/rt.ts#L15), [실기 잠금 해제 거부 표시](../apps/web/src/serverdrive.tsx#L88), [출력 지연 안내](../apps/web/src/simdrive.tsx#L96). #386 기체 확인은 일시 미확인에서 신선한 재확인이 가능하지만, 다른 몸/serial의 긍정적 증거인 영구 fault는 프로그램 재실행이 필요하다. 위 표의 기체 변경 복구 절차도 이 조건을 따른다.

## 기록 형식과 집계

```text
GO2_LOCK kind=release cause=screen_hidden source=server held_ms=50
GO2_LOCK kind=lock cause=nic_check_delayed source=agent held_ms=301
```

`held_ms`는 Core에서 마지막으로 유효하게 받은 정상 입력(0 포함), sink에서는 마지막 유효 apply부터 사건까지의 monotonic 경과 ms다. 이전 관측이 없으면 -1이다. 정상 움직임의 지속 시간·서버 RTT·임계값을 뜻하지 않으며 서로 다른 프로세스 시계를 빼지 않는다. 값·주소·MAC·serial·lease/user ID·토큰·예외 원문은 이 줄에 넣지 않는다.

동일 `(kind,cause,source)`는 직전 출력부터 1 s 안에 다시 출력하지 않는다. 세대 증가·STOP·명령 폐기·권한 반납은 매번 그대로 수행한다. 따라서 집계는 **최대 초당 1건으로 묶인 관측 횟수**이며 초당 발생한 원래 호출 수가 아니다. `stop`, `lock`, `release`는 한 사건의 세 결과일 수 있으므로 더해서 사건 수로 해석하지 않는다. 출력 감시 세부 `output_apply_stalled`/`output_drain_stalled`/`output_input_stale`와 Session의 `output_stalled` 전달 요약도 같은 사건을 가리킬 수 있다.

시험 후 조정 세션이 이미 확보한 로그 파일에서 실행(새 실기 접속 불필요):

```sh
grep 'GO2_LOCK ' agent.log
# 잠금 원인별 관측 횟수
grep 'GO2_LOCK kind=lock ' agent.log | sed -E 's/.* cause=([^ ]+) source=([^ ]+).*/\2 \1/' | sort | uniq -c | sort -nr
# 조종권 해제만 별도 집계
grep 'GO2_LOCK kind=release ' agent.log | sed -E 's/.* cause=([^ ]+) source=([^ ]+).*/\2 \1/' | sort | uniq -c | sort -nr
```

`unknown`은 원인 없는 옛 프레임, 잘못된 cause, 새 버전의 아직 모르는 코드다. 프레임은 기존처럼 즉시 STOP하고 잠금·권한 조건을 바꾸지 않는다. 서버 프레임을 중계하는 phone Hub 내부 호출은 `source=agent`로 구별한다. 기존 SAFETY·GO2_STOP_RESULT 기록도 유지한다.

서버 변경은 `Effect.cause` 진단 metadata를 기존 순서 그대로 enqueue할 때 선택 필드에 싣는다. 기존 effect body와 안전 셀프테스트는 고치지 않았다. 에이전트는 이 선택 필드를 권한·검증·시한 판단에 사용하지 않는다. 계약은 기존 필드·검증을 그대로 유지하고 cause가 없거나 null이면 직렬화에서 생략한다. 옛 웹에는 새 필드가 전달되지 않는다. **서버 이유까지 얻으려면 서버와 에이전트 둘 다 배포 필요**, 웹/APK 변경은 없다. 이 작업은 배포하지 않았다.

## 모의 검증

- 서버 Arbiter → 실제 Realtime enqueue → 에이전트 Session에서 STOP 코드가 그대로 로그에 남음.
- 서버 cause 27개·옛 필드/없는 cause·비정상 cause, 계약 JSON Schema/TS 선택 필드, 기존 검증 유지.
- 승인 만료·NIC 불일치/예외/지연·기체 변경/일시 미확인/검사 지연·피드백 충돌·연결 변경을 구분.
- 출력 apply/drain/원래 입력 만료 구분, rolling 1 s 반복 제한, 로깅 실패에도 STOP/권한 반납 유지.
- 기존 안전 시험은 기대값을 고치지 않고 실행. 실측 정지·실기 복귀는 미확인.

# PR #43 3차 검토 반영

- 브랜치 `feature/phone-pass`, 기준 `7eb24bc`. 두 검토자의 r3 보고서·추가 보고서·원본 재현과 이번 조정 결정을 반영했다.
- `safety/**`의 Core 판정·상수·기존 셀프테스트 기대값 변경0, 의존성 추가0, ROS·시뮬·운영 실행0이다.
- 기존 venv·사설 PostgreSQL pytest fixture·가짜 sink만 사용했다. 서버/발급/재현 포트9450~9469, 기존 링크/bridge helper 예외 유지. 무거운 실행 전 MemAvailable2.5GB 이상을 확인했다.

## 결정과 수정

| 항목 | 반영 |
|---|---|
| M1·D16 물리 한도 | 서버 wire1MiB·4096행·만료+60초 예약은 유지한다. 에이전트 SQLite만4096 B 페이지2048개=물리8MiB로 늘린다. 페이지 낭비·B-tree/색인·metadata·같은 DB의 used-jti4096행을 포함할 여유다. 서버512KiB 안은2KiB 직상 행에서 페이지 소비를 충분히 설명하지 못해 이번 조정 결정으로 대체했다 |
| M2 | `(user,robot)`별 미만료 출입증8개(control/view·기기 합산) 초과429 PASS_ACTIVE_LIMIT, retry_after=가장 이른 exp까지다. D13과 같은 성공 발급 이력이므로 회수/ack도 exp까지 센다. 다른 사용자/로봇의 한도는 별도이며 세션/device 변경으로 초기화하지 않는다. 감소 명령·회수 경로는 바꾸지 않았다 |
| M3 | 진행 중 pending 조회가 overflow 뒤 sent cursor를200으로 덮어써도 다음 조회는 retry floor128부터 시작하는 순서 제어 시험과 공식 변이를 추가했다 |
| M4 | 첫 사용자5건을 flush한 뒤 다른 사용자1건을 flush하면 두 번째 요약은1건·other_count0만 남아야 한다. users 누적/초기화 생략 변이를 검출한다 |
| M5 | ACK 저장을 일반 API 엔진과 분리한다. 풀2개·overflow0·pool 대기0.5초, 연결1초·statement2초·lock1초·TCP 무응답2초다. 실제 pg_sleep/행 잠금으로1013 REVOCATION_ACK_STORAGE_UNAVAILABLE·진행 슬롯 해제·같은 seq 재접속 회복을 확인한다. 외부5초 timeout·로봇별 진행1개·늦은 commit/닫힌 peer 불변·멱등은 유지한다 |

## 실제 SQLite 용량 경계

`test_phone_pass_capacity.py`는 실제 `pack()`으로 만든 불변 프레임을 사설 PostgreSQL에 보존한 마지막 허용 상태와 실제 발급 API의 다음503을 대조한다. 같은 파일 SQLite Verifier에 난수 키로 서명한 실제 토큰4096개를 먼저 verify하여 used 표를 채운 뒤 **모든** 프레임을 revoke/FULL commit한다. raw SQLite INSERT나 메모리 DB로 저장 성공을 대신하지 않는다.

아래 수치는 집중 회귀의 관측값이다.

| 극단 | 회수 행 | wire 합(B) | used 행 | 실제 페이지 | 다음 발급 |
|---|---:|---:|---:|---:|---|
| 최대 크기 프레임(각4,000~4,096 B) |257 |1,047,938 |4096 |394 |503 |
| 본문2KiB 직상(2,048~2,100 B) |508 |1,045,864 |4096 |611 |503 |
|1jti 프레임 |4096 |449,453 |4096 |233 |503 |

이는 합성 보존 이력을 직접 구성하는 용량 상한 시험이다. 수만 개 출입증을 API로 순차 발급한 시험이나 모든 SQLite 구현/저장 장치의 수학적 용량 증명으로 주장하지 않는다. 기존256페이지로 돌리는 변이는 최대 프레임 극단에서 실제 저장 실패를 assertion으로 검출한다. used/회수의 논리4096 상한·서명/만료·저장 실패의 새 hello 거부 규칙은 유지한다.

## 기존 경계와 검토자 재현

- D13 60초10건 시험은 새 사용자·로봇8개 한도와 충돌하지 않게 같은 user/device의 view를 두 로봇에5개씩 발급한다. 정확한 rate/device 상한·이력 정리 검증을 유지했고 기존 시험 수를 줄이지 않았다.
- Codex SQLite 관측은 이전 실패222개 대신 wire 예산 안256개 전부 저장(294페이지)으로 바뀐다. 그256개 상태의 다음 발급200은 이제 실제로 저장 가능하며, 이어지는 발급은503이다.
- Claude99jti×263개 재현은 wire1,041,635 B·실제269페이지로 모두 저장된다(기존250개 뒤 실패 해소). 남은4KiB 예약의 발급1개는200, 다음은503이다. 단일 사용자 재현300회는8개만 발급되고 첫 거부429 PASS_ACTIVE_LIMIT, 다른 사용자는200이다.
- `probe_pages.py`는 서버 wire 또는4096행 중 먼저 닿는 경계에서 멈추도록 기대를 바꿨다. jti1/16/50/64개 극단은 각각4096/1504/517/407개를 저장했고 페이지134/307/265/413이었다(이 탐침은 used 표 없이, 위 정식3극단은 used4096개 포함).
- 두 검토자의 원본 파일은 보존하고 이 worktree 임시 복사본에 기대값만 조정했다. 저장소 회귀는 실제 마지막 상태503·공유 used 몫·사용자 제한·조회 덮어쓰기·감사 두 배치·실제 DB 오류를 추가로 고정한다.

## 실행

아래 python은 `.venv/bin/python`이다. 임시/로그는 `tmp/phone-pass-r3`, 발급 변이 DB는 `tmp/ppg`이며 서버/발급/재현에 `FH_TEST_PORT_RANGE=9450:9469`를 적용했다.

| 명령 | 결과 |
|---|---|
| `python -m pytest apps/server -q` |672 passed, 기존 경고1,758.62초 |
| `python -m pytest apps/agent -q` |812 passed,1 skipped, 기존 경고2 |
| `python apps/server/tools/check_phone_pass_mutations.py` |25/25 KILLED |
| `python apps/agent/tools/check_phone_mutations.py` |79/79 KILLED |
| `python apps/agent/tools/check_link_mutations.py` |80/80 KILLED |
| `python apps/agent/foothold_agent/ros_bridge/check_mutations.py` |49/49 KILLED, ROS 없는 모의 경로 |
| `python apps/contracts/generate.py --check` |144개 일치 |
| `npm --prefix apps/contracts run typecheck` |통과 |
| 두 검토자 r3 재현, 기대 조정 포함 |4 passed, 기존 경고1 |
| Claude 페이지 탐침, 서버 행/wire 경계로 한정 |4극단 모두 저장, 종료0 |
| 집중 회귀 |59 passed, 기존 경고1 |
| `git diff --check` / safety diff |통과 / 변경0 |

발급 변이는 기존20개에 물리256페이지 회귀·사용자별8개 상한 제거·조회 뒤 floor 재적용 제거·users 초기화 누락·ACK statement timeout 제거5개를 추가했다. 물리 한도 변이는 서버 pack/에이전트 SQLite 왕복을 검사하므로 발급 변이 도구가 에이전트 파일도 지정해 복사·변이한다. 모든 판정은 수집>0·실제 assertion 실패·비-assertion 오류0을 요구한다.

## 바꾼 파일·남은 범위

- `apps/agent/foothold_agent/phone/tickets.py`, 에이전트 README: 물리 저널8MiB와 근거.
- `fh_server/phone_pass.py`, `fh_server/realtime.py`: 사용자/로봇8개·별도 ACK timeout 엔진과 정리.
- `tests/test_phone_pass.py`, `tests/test_phone_pass_capacity.py`, `tools/check_phone_pass_mutations.py`: 새8사례·기존 D13 분리·공식 변이5개.
- 서버 README·`PHONE-PASS-REVIEW-R2.md`·이 기록·`docs/spec/05-API-SPEC.md`: D16 물리/논리 구분·발급/DB 제한·검증·변경 이력0.15.

실기 전 관문은 [API §13.6](../../docs/spec/05-API-SPEC.md#136-오류닫기후속-경계)이다. ROS/DDS(domain93)·시뮬·실폰·실로봇·운영0013/키 배포·NTP·망 분리/자원·DB 다중 로봇 부하·실제 네트워크 단절/저장 장치 성능은 실행하지 않았다. DB의 pool/connect/statement/lock/TCP 제한은 OS/DNS 등 모든 외부 고장의 강제 중단 보장이 아니며 외부5초/로봇별 저장1개 방어를 유지한다.

운영 되돌림은 코드 revert·0013 테이블 보존 우선이며 미만료 이력을 버리지 않는다. 커진 에이전트 저널은 이전256페이지 코드에서 시작 거부될 수 있으므로 저널을 삭제해 우회하지 않고 보존·승인된 복구/키 대응을 거친다(운영 되돌림 미검증). 기존 Nav264/65 분류 후속은 이번4종에 포함하지 않았다. 같은 연결 출입증 갱신·폰/웹 연결·주소 안내·카메라·시뮬 관리자는 후속이며, 두 모델 재검토·dev 통합은 조정 세션 관문이다.

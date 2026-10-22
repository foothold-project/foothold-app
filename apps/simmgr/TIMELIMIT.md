# 시뮬 시간 제한 변경 검증

최초 기준 `origin/dev 6edfac8`, 브랜치 `feature/sim-timelimit`.
후속 기준 `origin/dev deccb75`, 브랜치 `fix/sim-followup`의 변경·검증은 아래 후속 기록을 따른다.
기본 사용 기한을240초에서1800초로 바꾸고 관리자에서 먼저 정상 정리한다.
실제 ROS/Gazebo·실폰·실로봇·운영/미리보기 서비스·배포는 실행하지 않았다.

## 바뀐 규칙

- `Settings.runtime_seconds` / `FH_SIM_RUNTIME_SECONDS`: 기본1800초, native 정수300..3600초,
  fake 정수5..3600초(짧은 값은 모의 시험용).
  월드 준비 요청부터 계산한 UTC `expires_at`를 전달하며 실제 예약은 단조 시계다.
- agent/native·Gazebo unit은 같은 설정+90초(기본1890초)로 제한한다. native watcher는
  그5초 전이며 정상 정리에85초 여유를 준다. systemd stop grace45/15초는 별도다.
  기존 standalone D1 도구의 기본240초·자원 관문·식별 검사는 유지한다.
- 기한이면 직렬화 잠금 안에서 기존 STOP/zero·agent exit0 → world close 증명을 거친다.
  성공만 완료 목록에 남기고 실패는 ERROR·failed·소유를 유지한다. 목록의 native 건강
  검사는 전환 중 생략하고 STARTING/STOPPING 스냅샷을 즉시 반환한다. 전환 밖 건강 검사는
  같은 잠금을 써 정상 정리 도중 agent exit를 비정상으로 오판하지 않게 한다.
- 서버 lifespan 작업은 폰과 무관하게2초마다 ACTIVE 조직의 완료를 확인한다. 현재
  owner·세대를 먼저 대조하고 기존 DELETE와 동일한 nonce·robot_id·generation 결속,
  관리자 UUID·부재 증명을 검사한다. 초기/최종 출입증 회수 후 owner 해제·hash 교체·IDLE,
  종료 세대는 유지하며 다음 POST만 증가한다. 증명 실패는 STOPPING·소유를 유지한다.
- 앱은 남은 시간 mm:ss·5분/1분 안내를 텍스트로 표시한다. 기한0·빈 목록·WS 단절만으로
  정상 종료를 주장하지 않으며, 서버가 DB IDLE까지 확인한 본인·동일 세대 완료 뒤에만
  «시간이 다 되어 시뮬을 끝냈습니다 — 다시 띄우기»로 돌아간다. 내 ERROR 카드의 정리도
  기존 증명 경로를 사용한다. STOP·끝내기/정리는 계속 표시된다.

## 유지한 규칙

STOP/zero ACK·deadman·잠금·명령 경로·출입증·소유 권한·세대 최종 확인·늦은 POST 차단,
#51 정상 재사용·실패 고정, #55 요청 결속/재시작 부재 증명·시작 전 거부(B)를 유지했다.
기존 안전 Core와 셀프테스트 기대값은 수정하지 않았다. unit runtime 기대값만 요청된
1890초로 바꾸었고 supervisor 대역에 새 seconds 인자를 연결했다.

## 실행 환경과 결과

기존 승인 venv와 웹 node_modules는 읽기 전용으로 사용했다. `PYTHONDONTWRITEBYTECODE=1`,
worktree 내부 TMPDIR·Vite cache/build 출력, `FH_TEST_PORT_RANGE=9480:9489`를 적용했다.
포트 fence는 worktree `runs/` 사본이며 범위 밖 loopback 접속/리스너를 OS 호출 전에 거부했다.
각 무거운 실행은 `if`로 MemAvailable≥2.5GiB일 때만 실행했다. 검증 뒤 node_modules
링크와 임시 Vite 설정은 이 worktree의 literal 경로로 제거했다. 새 패키지 설치0이다.

```sh
# PYTHON은 승인된 기존 venv, 모든 경로는 이 worktree 기준.
export PYTHONDONTWRITEBYTECODE=1 FH_TEST_PORT_RANGE=9480:9489
export PYTHONPATH="$PWD/runs/timelimit/fence:$PWD/apps/agent:$PWD"
export TMPDIR="$PWD/runs/timelimit/tmp"
"$PYTHON" -m pytest apps/simmgr/tests apps/server/tests/test_sim*.py \
  apps/agent/tools/sim/test_isolation.py apps/agent/tools/sim/test_runner_boundaries.py \
  apps/agent/tests/test_original_core.py apps/agent/tests/test_core_boundaries.py -q --tb=short
# 313 passed (116.19s)

# apps/web에서 worktree 내부 cacheDir/outDir를 지정한 임시 설정으로 실행
npm test -- --config vite.timelimit.config.mts
# 11 files / 558 passed (15.73s), phone 35 passed
# 최종 ERROR→확인 중 보강 뒤 phone 집중 36 passed (6.91s)·typecheck/build 재통과
npm run typecheck
# PASS
npm exec -- vite build --config vite.timelimit.config.mts
# PASS
"$PYTHON" apps/contracts/generate.py --check
# 164개 일치
```

실제5초를 기다리는 native/OS 대역 시험에서 agent unit/native에95초를 함께 전달하고
STOP/zero → agent exit0 → world close → 관리자 failed=false·남은 대역 unit0 → 세대2
재기동을 확인했다. 서버 시험은 폰/목록 요청 없이 lifespan 작업의 IDLE·hash 교체·발급된
출입증 전량 회수·감사1회와 세대2 재취득을 확인한다. agent/world 정리 실패 시 소유/실패
보존, nonce·robot_id·generation·startup_clean 손상 시 STOPPING 보존, 다른 소유자/이전 세대
완료 무시를 검증했다. 웹은30:00·05:00·01:00, 안내 경계, 완료 전 정리 확인 중과 STOP,
증명된 완료 뒤 연결 닫기·다시 띄우기, 잘못된 세대/빈 목록에서 연결 보존을 검증했다. 마지막 보강으로 기한 뒤 동일 세대
ERROR면 연결을 닫고 «확인 중»·STOP·다시 끝내기를 유지하며 자동 DELETE를 보내지 않는
시험을 추가해 최종 phone36개와 typecheck/build를 재실행했다(다른 웹 시험은 변경0).

안전 변이2개(기한 정리의 agent STOP/zero 생략, 완료 회수의 nonce 검사 생략)는 각각
assertion1·errors0으로 KILLED다. 변이 실행은 disposable worktree 내부 사본뿐이며
정본/안전 셀프테스트 수정0이다. 기존 mutation 도구의 변수명 anchor2곳은 공통 제거
helper 추출의 org_id 이름에 맞췄다.

최초 계약 생성은 UTC 타입 이름 오류로 실패했고 수정 후 재생성/--check를 통과했다.
최초 typecheck는 새 필드가 없는 시험 fixture로 실패했고 null을 추가해 통과했다.
최초 웹 임시 설정은 ESM 로드 오류였고, .mts 설정으로 전체 시험이 통과했다.
첫 build 명령은 실행 경로 오류였고 apps/web에서 재실행해 통과했다.
기존 Starlette/httpx deprecation·브랜드 CSS 빌드 경고는 남는다.

## 남은 확인·되돌림

실제 transient unit의 failed0·Gazebo manifest·30분 경과·실폰 배치는 미검증이다.
완료 목록은 관리자 메모리이므로 정리 직후 서버 확인 전 관리자 재시작이면 #55 수동
복구가 필요하다. 서버의 완료 증명 실패로 STOPPING이 되면 서버가 자동 반복하지 않고 기존 정리 단추로
확인한다. 이와 별개로 **명시 DELETE가 관리자에서 실패하면 기존 expiry 작업은 취소되지
않는다**. 기한에 잠금 안에서 같은 STOP/zero → agent exit0 → world 정리를 한 번 더 시도한다.
native launcher의 failed 고정은 유지되므로 재시도가 정리를 일부 진행해도 깨끗한 완료로
승격되지 않으며 ERROR·소유 보존, 완료 기록 없음이다. expiry 자체가 실패한 뒤의 주기적
재시도는 없다. 이 후속에서는 재시도 동작·정리 순서를 바꾸지 않았다.
서버·관리자·웹은 새 계약을 함께 적용해야 하며 옛 서버/관리자는 새 기한 완료
기능을 제공하지 않는다. 두 모델 검토와 dev 합치기는 조정 세션의 관문이다.

되돌림은 이 기능 커밋의 `git revert`다. Git push/PR은 운영 서비스·DB·APK 배포가 아니다.


## 후속 기록 — PR #58·#57 권고

- 전환 중 listing은 잠금을 기다리지 않고 조직별 STARTING/STOPPING 사본을 반환한다.
  월드 준비 중 아직 robots에 넣지 않은 요청도 읽기용 STARTING으로 표시한다.
  정상 정리 중 watcher의 unit_exited 관측은 STOPPING을 ERROR로 바꾸지 않는다.
  전환 담당 코드가 실제 실패를 처리하며 기존 failed 고정과 STOP/zero 순서는 유지한다.
- remaining_s는 관리자 단조 시계 기한에서 올림한 남은 초다. 서버가 같은 계약으로
  전달하며 폰은 수신 시점의 performance.now()에 결합해 센다. 같은 로봇·owner·세대의
  새 응답만 갱신하고, 값이 없는 옛 관리자에서는 UTC 비교 없이 시간 표시를 생략한다.
- native 설정은300..3600초, fake는5..3600초다. native 대역 시험도300초 설정을 사용하고
  기한 호출만 앞당겨 검사하며, 실제300초/1800초 경과 시험으로 보고하지 않는다.
- 미확인 후진·제자리 회전 안내가 있는 동안 clipped의 «끝까지 밀어야 움직입니다» 안내를
  숨긴다. 명령 값·허용 명령·STOP·정리 단추는 유지한다.

검증은 기존 읽기 전용 venv/웹 의존성, PYTHONDONTWRITEBYTECODE=1, worktree 내부 TMPDIR·
cacheDir/outDir, runs 안 fence 사본과9480~9489 범위에서 실행했다. 무거운 명령은 각각
`if MemAvailable >= 2621440 KiB` 관문 뒤에만 실행했다. 임시 웹 의존성 링크와 설정은
이 worktree의 literal 경로로 제거했다. 새 패키지 설치·ROS/Gazebo·운영/미리보기 접촉0이다.

```sh
export PYTHONDONTWRITEBYTECODE=1 FH_TEST_PORT_RANGE=9480:9489
export PYTHONPATH="$PWD/runs/sim-followup/fence:$PWD/apps/agent:$PWD"
export TMPDIR="$PWD/runs/sim-followup/tmp"
# PYTHON은 승인된 기존 venv, fence는 sitecustomize.py의 허용 범위만 바꾼 runs 사본.
"$PYTHON" -m pytest apps/simmgr/tests apps/server/tests/test_sim*.py -q --tb=short
# 265 passed (117.86s)
# 정상 정리 중 cached unit_exited 보강 뒤 영향 범위 재검증:
"$PYTHON" -m pytest apps/simmgr/tests -q --tb=short
# 128 passed (1.74s), 집중 timelimit 16개 포함

# apps/web에서 기존 Vite 설정에 worktree 내부 cacheDir/outDir만 덧댄 임시 설정:
npm test -- --config vite.followup.config.mts
# 11 files / 562 passed (19.84s), phone 39개 포함
npm run typecheck
# PASS
npm exec -- vite build --config vite.followup.config.mts
# PASS
"$PYTHON" apps/contracts/generate.py --check
# 164개 일치
```

전환4곳(world 시작·agent 시작·STOP/zero 대기·world 정리 대기)에서 목록을100ms 제한으로
읽고 다른 조직에는 빈 목록을 반환하는지 검사했다. 서버 경유 정리 중 목록은2초 미만,
manager_error 없음·cleanup 카드 없음·STOPPING·remaining_s 전달을 확인했다. 폰 시계를
하루 앞/뒤로 틀려도30:00·05:00·01:00과 안내·증명 전후 구분이 유지되며, 미확인 안내
중 clipped 숨김과 안내 종료 뒤 복원을 검증했다. native5/299초 거부·300초 수용,
fake 짧은 값 수용도 확인했다.

최초 typecheck는 current의 null 가능성3곳으로 실패했고 명시 guard 뒤 통과했다.
기존 Starlette/httpx deprecation·브랜드 CSS 빌드 경고는 남는다. 실제 systemd/ROS/Gazebo,
실폰·가로 화면 배치·실로봇·실제300초/30분 경과·관리자 재시작 재현·배포는 미검증이다.
STOP/zero·deadman·명령 경로·출입증·세대·#51·#55 증명 결속·기한 정리 순서 변경0이다.

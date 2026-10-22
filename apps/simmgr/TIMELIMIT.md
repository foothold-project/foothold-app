# 시뮬 시간 제한 변경 검증

기준 `origin/dev 6edfac8`, 브랜치 `feature/sim-timelimit`.
기본 사용 기한을240초에서1800초로 바꾸고 관리자에서 먼저 정상 정리한다.
실제 ROS/Gazebo·실폰·실로봇·운영/미리보기 서비스·배포는 실행하지 않았다.

## 바뀐 규칙

- `Settings.runtime_seconds` / `FH_SIM_RUNTIME_SECONDS`: 기본1800초, 정수5..3600초.
  월드 준비 요청부터 계산한 UTC `expires_at`를 전달하며 실제 예약은 단조 시계다.
- agent/native·Gazebo unit은 같은 설정+90초(기본1890초)로 제한한다. native watcher는
  그5초 전이며 정상 정리에85초 여유를 준다. systemd stop grace45/15초는 별도다.
  기존 standalone D1 도구의 기본240초·자원 관문·식별 검사는 유지한다.
- 기한이면 직렬화 잠금 안에서 기존 STOP/zero·agent exit0 → world close 증명을 거친다.
  성공만 완료 목록에 남기고 실패는 ERROR·failed·소유를 유지한다. 목록의 native 건강
  검사도 같은 잠금을 써 정상 정리 도중 agent exit를 비정상으로 오판하지 않게 한다.
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
복구가 필요하다. 증명 실패로 STOPPING이 되면 자동 반복하지 않고 기존 정리 단추로
확인한다. 서버·관리자·웹은 새 계약을 함께 적용해야 하며 옛 서버/관리자는 새 기한 완료
기능을 제공하지 않는다. 두 모델 검토와 dev 합치기는 조정 세션의 관문이다.

되돌림은 이 기능 커밋의 `git revert`다. Git push/PR은 운영 서비스·DB·APK 배포가 아니다.

# 로봇 입력 녹화와 PC 재생

### Jetson에서 켜기와 끄기

에이전트를 평소처럼 실행하고 별도 터미널에서 설치 묶음의 Python을 사용한다. `ROBOT_NIC`에 에이전트가 쓰는 유선 인터페이스, `SETUP_PORT`에 로컬 설정 화면의 포트, `AGENT_ROOT`에 설치 폴더를 지정한다.

```sh
umask 077
CAPTURE="$HOME/robot-captures/$(date +%Y%m%d-%H%M%S)"
"$AGENT_ROOT/venv/bin/python" -I -m foothold_agent.record \
  --nic "$ROBOT_NIC" --status-port "$SETUP_PORT" --out "$CAPTURE" --max-gb 20
```

- Ctrl-C 또는 녹화기 PID에 SIGTERM을 보내면 대기 자료를 쓰고 종료한다. 에이전트와 별도 프로세스이며 DDS domain 0에서 best-effort로 구독한다. 에이전트가 여러 개면 `--agent-pid PID`로 계측 대상을 고른다.
- 상태·점군·오도메트리 9개 토픽과 설정 화면의 `depth_selected` 하나를 추적한다. 설정 화면을 사용할 수 없으면 `--status-port` 대신 `--depth-selected 현재토픽` 또는 `--depth-selected none`을 쓴다. 앞카메라는 이미 전송되는 응답의 시각·영상 바이트 수를 남긴다. JPEG 내용이 필요할 때만 `--video`를 추가한다.
- 빈 폴더 하나가 한 녹화다. 기본 조각은 128 MB 또는 60초다. `--chunk-mb`, `--chunk-seconds`로 바꾼다. 합계가 20 GB(십진)를 넘기 전에 가장 오래된 조각부터 지운다. 한 메시지가 조각 목표보다 크면 단독으로 저장하고, 전체 상한보다 크면 오류로 종료한다. 강제 종료 때 미완성인 마지막 프레임은 읽을 때 경고하고 건너뛴다.
- **녹화 폴더는 비공개 자료다.** LowState의 원본 숫자 배열 `sn`에 기체번호가 들어갈 수 있다. 점군·깊이·선택한 영상에는 현장이 보인다. 임의 ROS 프레임·필드 이름은 가명 처리하고 맞춤 깊이 토픽은 `depth_selected`로 표시한다. 카메라 응답의 RPC 헤더·텍스트와 JPEG의 APP/주석은 제외한다. 저장소와 공개 이슈에 올리지 않는다.

### 옮기기와 지우기

녹화를 끝내고 해당 폴더 **전체**를 비공개 이동식 저장소로 복사한다. `du -sh "$CAPTURE"`로 용량을 확인한다. 예를 들어 `cp -a -- "$CAPTURE" "$PRIVATE_DRIVE/"`로 복사한 뒤 `diff -qr -- "$CAPTURE" "$PRIVATE_DRIVE/$(basename "$CAPTURE")"`로 대조한다. 원본을 지울 때는 파일 관리자에서 확인한 그 세션 폴더를 삭제한다. 새 폴더로 시작한 녹화의 상한은 이전 세션에는 적용되지 않는다.

### PC에서 다시 틀기

재생에는 동일 버전의 에이전트와 기존 Go2 관측용 Python 환경(고정된 Unitree·CycloneDDS IDL, 미디어용 NumPy·OpenCV)이 필요하다. 소스 체크아웃에서는 `cd apps/agent` 후 실행한다.

```sh
python -m foothold_agent.record replay "$CAPTURE" --speed 1
python -m foothold_agent.record analyze "$CAPTURE"
```

재생은 단조시계 간격에 맞춰 원본 IDL을 복원한다. `--speed 2`는 간격을 절반으로 줄인다. 로봇 구독과 두 운동 출력은 모두 메모리 안에 있다. 기본 모드는 로컬 모의 서버 응답과 업로드 수신기를 사용한다. 마지막 줄에서 토픽별 전달 수와 가짜 출력 호출 수를 확인한다.

웹과 실제 업로드 지연을 확인하려면 **격리된 로컬 개발 서버**에서 시험 로봇을 소유자에게 등록하고 해당 UUID의 서버 조종을 활성화한다. 시험용 기체번호는 `1000-1`이다. 그 서버의 웹을 열고, 시험 등록으로 발급한 UUID와 토큰을 각각 `FH_REPLAY_ROBOT_ID`, `FH_REPLAY_TOKEN` 환경 변수로 전달한다. `python -m foothold_agent.record replay "$CAPTURE" --server-port "$DEV_PORT"`는 loopback의 기존 에이전트 WS·미디어 API를 사용한다. 잠금·조종권·업로드는 기존 에이전트와 서버가 처리한다. 첫 수신 기체번호와 다른 번호는 재생에서도 충돌로 처리한다. 현장 MAC 조회, 회선 손실, Jetson의 CPU 경합은 재생 PC에서 별도로 측정해야 한다.

### 분석 표 읽기

- p50·p95는 수신 단조시계 간격을 1 ms 단위로 반올림한 최근접 순위다. 최대와 200 ms 초과 건수는 원래 ns로 계산한다. B/s 분모는 보존된 녹화 전체 시간이다. 크기는 DDS CDR 바이트, 앞카메라는 영상 바이트다.
- CPU 시간표와 녹화기 RSS, 큐 초과와 DDS가 보고한 손실을 함께 본다. `analyze "$CAPTURE" --system-jsonl`은 전체·코어별 CPU, 에이전트 PID·스레드 TID별 CPU, 메모리·부하·인터페이스별 누적 RX/TX, 녹화기 CPU·RSS를 초 단위로 출력한다. CPU는 프로세스/스레드에서 한 코어가 100%다. `elapsed_s >= 30`인 줄이 예열 이후 값이다. `robot_nic`은 지정 유선 인터페이스, `ifN`은 Linux 인터페이스 인덱스다.
- Linux journal에서 해당 PID의 `GO2_LOCK kind=lock` 시각·원인만 추려 녹화에 포함한다. 잠금 표는 직전 lowstate·sport 상태의 경과 시간과 시스템 CPU를 보여준다. journal 상태가 `unavailable` 또는 `no_agent`이면 같은 부팅에서 별도로 보관한 `journalctl -o json` 또는 `short-monotonic` 사본을 `analyze "$CAPTURE" --journal "$LOCAL_JOURNAL"`로 지정한다. 외부 사본은 행 번호로 대조할 수 있다.

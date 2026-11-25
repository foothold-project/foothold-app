# C++ 실행기 서비스 (Jetson 사용자 서비스)

- `foothold-policy-cpp.service` → `~/.config/systemd/user/`. `<설치 폴더>` 를 실제 빌드 폴더 이름으로 바꾼다.
- `wait-link-restart.conf` → `~/.config/systemd/user/foothold-policy-cpp.service.d/`
  - Go2 본체 선 (enP8p1s0) 에 IPv4 가 잡힐 때까지 최대 60 초 기다린 뒤 시작한다. 실패하면 3 초 뒤 다시 시작한다.
  - 11/25 실기: 이 설정이 없으면 부팅 때 선보다 3 초 먼저 떠서 DDS 생성에 실패하고 멈췄다. 넣은 뒤 껐다 켜기 시험에서 다시 시작 0 번, 18.7 초에 준비됨.
- `runner.env` 는 `apps/agent/installer/policy-runner/runner.env.example` 을 복사해 쓴다 (0600).
- 기록 상한: trace 폴더 바로 아래 *.jsonl 합계 4 GB. 2 GB 가 넘으면 ai-lx01 의 `apps/agent/tools/trace_backup.py` (10 분 타이머) 가 닫힌 파일을 백업하고 sha256 이 맞는 것만 Jetson `trace/archive-<날짜>/` 로 옮긴다. 지우지 않는다.

```
systemctl --user daemon-reload
systemctl --user enable --now foothold-policy-cpp
```

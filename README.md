# foothold-app

현장에서 로봇을 조종하고, 임무를 맡기고, 결과를 기록하는 앱의 **화면 시안 구현**입니다.

> **예시 데이터입니다. 실제 로봇 상태가 아닙니다.**
> - 화면 속 로봇 이름·운영자 이름(«운영자 A»)·배터리·위치·가스 값은 모두 시안용 표본입니다.
> - 판정 기준과 기준값은 «예시 기준 · 검증 전»입니다. 실제 적용 기준이나 법규 충족을 뜻하지 않습니다.
> - ROS, 실제 로봇, 실제 임무와 연결되어 있지 않습니다.
> - STOP 버튼은 모양만 있는 시안입니다. 아무것도 멈추지 않습니다.
> - 사진 판독·AI·가스 측정·자동 후퇴·경보·법규 기준은 화면 예시입니다. 구현되거나 검증된 기능이 아닙니다.
> - 로그인·지도·로봇 장비·설정·알림 화면도 모양만 있습니다. 로그인은 인증하지 않습니다. 정지 시험 «정상»·마지막 시험 시각·장비 상태·인증서 확인 표시는 실제 시험이나 확인 결과가 아닙니다.
> - 목표 보내기·위치 맞추기·출입 금지 구역·온도 초과 시 자동 앉기 같은 동작은 실행되지 않습니다. 이후 기능을 만들 때 따로 검증할 대상입니다.

> - 예외: 아래 «v2 시뮬 실연결»(`?live=v2`)로 연 관제(Main)·조종(MDrive) 두 화면만 Gazebo 시뮬(foothold-v2 시험)에 연결됩니다. 실제 로봇이 아닙니다.

## 열기

```bash
python3 -m http.server 8000 --bind 127.0.0.1
# 브라우저에서 http://127.0.0.1:8000/web/
```

- 글꼴(IBM Plex Sans KR · JetBrains Mono)은 Google Fonts에서 받습니다. 그래서 네트워크가 필요합니다.
- 화면 상태는 주소 뒤에 붙여 바꿉니다(미리보기 전용). 예:
  - `Main.dc.html?scenario=통신 끊김`
  - `?theme=밝은`
  - `MDrive.dc.html?stickLayout=왼쪽 회전 · 오른쪽 앞뒤`

## v2 시뮬 실연결 (`?live=v2`)

관제(`Main.dc.html?live=v2`)와 조종(`MDrive.dc.html?live=v2`) 두 화면만 연결합니다. Gazebo·정책·RESET 은 RL 쪽 세션이 띄우고, 이 앱은 Gazebo 를 띄우지 않습니다. `?live` 가 없으면 시안 그대로입니다.

```bash
# 로컬 ROS PC, foothold-app 폴더에서 (RL 세션이 떠 있을 때)
source /opt/ros/jazzy/setup.bash
export ROS_DOMAIN_ID=61 ROS_AUTOMATIC_DISCOVERY_RANGE=LOCALHOST
python3 sim/v2_link.py --port 8790          # 끝낼 때 Ctrl+C (끝나며 명령 0 한 번)
# 브라우저: http://127.0.0.1:8790/MDrive.dc.html?live=v2  · http://127.0.0.1:8790/Main.dc.html?live=v2
```

- 계약 정본: `control-app/experiments/33-foothold-v2-gazebo-20261012/online-20261012/CONTRACT-v2_live.md`. 127.0.0.1 전용, 같은 출처(8790)의 페이지만 WebSocket 을 열 수 있습니다.
- 안전 판단은 서버(`sim/v2_link.py`)가 합니다. 조종권은 한 기기만, 막대를 처음 누르면 조종권만 얻고 다시 눌러야 움직입니다.
- 보내는 명령은 시험한 값뿐입니다: 0 · 앞 0.6 m/s · 앞 0.6 + 회전 ±0.5 rad/s. 후진·옆걸음·제자리 회전·저속은 «미검증»으로 표시하고 보내지 않습니다.
- 손을 떼거나, 입력이 0.3 s 끊기거나, 화면을 숨기거나, 연결·시뮬 상태가 끊기면 명령은 0 입니다. 다시 이어져도 예전 입력을 되살리지 않습니다.
- STOP 은 누구나 누를 수 있고 명령 0 을 잠급니다. 시뮬은 기동·리셋 뒤에도 STOP 상태입니다. «STOP 해제»(조종권만) → 시뮬 확인 → 새로 누름 순서로만 다시 움직입니다. RESET 도 STOP 을 유지합니다.
- 표시: 위치·속도·기울기·넘어짐은 Gazebo 정답값(GT)이고 지도가 아닙니다. 카메라는 Gazebo 렌더입니다. 배터리·지도·임무·AI·가스는 «미연결»입니다. 시험 문구 «Gazebo · foothold-v2 시험 · 낙상·정지 지연 미검증»과, 정지 뒤 1~2 s 안에 한 번 다시 움직일 수 있다는 주의를 함께 보입니다(시뮬 기록 최대 약 .33 m/s·28°).
- 시험: `python3 sim/v2_link.py --selftest`(ROS 없이) · `tools/live_check.py`(가짜 발행기 domain 88 + 포트 8791 모의, 실제 근거 아님) · `tools/live_e2e.py`·`tools/live_probe.py`(이미 떠 있는 실연결 서버 대상).

## 구조

| 경로 | 내용 |
|---|---|
| `web/*.dc.html` | 디자인 시안 원본 마크업을 그대로 둔 화면입니다(19개). 원본과 다른 곳은 실행기 교체(스크립트 줄), 승인된 STOP 배치·예시 문구, 화면 사이 링크 연결입니다. 하나하나는 `docs/PROGRESS-ui-reference.md`에 있습니다. |
| `web/live.js` | `?live=v2` 일 때만 Main·MDrive 를 v2 시뮬에 잇는 화면 층입니다. 없으면 아무것도 하지 않습니다. |
| `sim/v2_link.py` | v2 시뮬 연결 서버(ROS 2 ↔ WebSocket, 127.0.0.1:8790). 조종권·STOP·명령 제한을 판단합니다. |
| `tools/fake_v2_live.py` | 시험 전용 가짜 v2 발행기(domain 61 거부). |
| `web/dc.js` | 시안 마크업을 그리는 작은 실행기입니다. React나 외부 런타임 없이 동작합니다. |
| `web/index.html` | 화면 목록입니다. |
| `tools/compare.py` | 원본 시안과 구현을 같은 크기로 캡처해 RGB 차이가 16을 넘는 픽셀 수를 셉니다. |
| `tools/nav_check.py` | 화면 열림, 화면 사이 링크, 임무 양식 조작이 원본과 같은지 확인합니다. 화면 이름을 붙이면 그 화면만 봅니다. |

검사 도구는 원본 시안(`reference/`, 저장소에는 없음)과 headless Chrome, Pillow, python3-tornado가 있어야 돌아갑니다.

## 라이선스 메모

- 글꼴: SIL Open Font License, Google Fonts에서 받습니다.
- 시안 도구의 원본 실행기(`support.js`)는 라이선스를 확인하지 못했습니다. 그래서 저장소에 넣지 않고 쓰지도 않습니다.
- 저장소 라이선스: 미정.

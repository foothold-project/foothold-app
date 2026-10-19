# FOOTHOLD 로봇 에이전트 — W1-A 골격

`sim/v2_link.py`의 안전 Core와 관련 셀프테스트를 옮긴 Python 패키지다.
Python 3.10 이상을 사용하며 실행 의존성은 표준 라이브러리뿐이다.
ROS·웹 서버 없이 import할 수 있고, 실행 진입점·소켓·로봇 명령 송신은 없다.

```sh
# 저장소 루트, pytest가 있는 Python 환경
python3 -m pytest apps/agent -q
python3 sim/v2_link.py --selftest

# 이 패키지만 설치할 때 (테스트 도구 포함)
python3 -m pip install -e './apps/agent[test]'
```

설치 후 `from foothold_agent.safety.core import Core`로 가져온다.
호출자는 접근을 직렬화하고, 명령 적용 주기마다 `applied()` 결과를 사용해야 한다.
`applied()`는 판정 결과를 반환할 뿐 로봇에 발행하지 않는다.
`cmd()`에는 `valid_axes()`로 검사한 값만 넣는다.
원본의 상태 스키마·시뮬 용어·이벤트 출력·`sink` 실패 처리도 그대로 유지한다.

## 다음 단계 (미구현 자리)

| 자리 | 후속 작업 |
|---|---|
| 서버 접속 모듈 | outbound WSS, 로봇 인증, 서버 조종권과 `lease_id`·증가 `seq` 대조, 재접속 시 잠금, 불확실한 명령 자동 재시도 금지 |
| ROS 2 다리 모듈 | 별도 승인된 도메인·포트에서 상태 수신 및 20 Hz 명령 발행, STOP·resume·reset 확인, 실기 어댑터 |
| 임무 실행기·원격측정 | 별도 작업에서 계약과 안전 경계를 정한 뒤 구현 |

SF-01의 화면 STOP·보기 권한, SF-04의 서버 조종권 정합성,
SF-09의 전송 재시도 정책은 이 골격만으로 구현되지 않는다.
원본 Core는 최초 `latch=False`이고 deadman 만료 시 입력 폐기·중립 재확인을
요구하지만 잠금을 설정하지 않는다. 따라서 SF-02·SF-03의 초기 잠금·deadman 잠금
요구사항까지 충족했다고 보고하지 않는다. 원본 판정 보존 제약에 따라 이번에 바꾸지 않았다.
원본 assert 대응과 검증 범위는 [PORTING.md](PORTING.md)에 기록한다.

운영 앱·서버, Gazebo·ROS 도메인·실로봇에 연결하는 절차는 포함하지 않는다.

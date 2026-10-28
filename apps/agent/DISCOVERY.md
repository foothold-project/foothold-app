# 같은 망에서 에이전트 찾기

폰 listener가 바인딩된 뒤 `_foothold._tcp.local.`을 광고한다. 광고는 검색 후보이며,
인증·등록·온라인 상태의 증거가 아니다. 기존 `/phone/ws` 인증은 그대로 필요하다.
BLE 광고/프로비저닝과 Unitree 자체 Wi-Fi 검색은 이 모듈의 역할이 아니다.

| 환경 변수 | 값 |
|---|---|
| `FOOTHOLD_MDNS_ENABLED` | 기본 `1`; `0`이면 import·스레드·소켓 생성 없이 끔 |
| `FOOTHOLD_MDNS_ADDRESS` | 폰이 도달할 **로컬 인터페이스 IPv4**. wildcard listener에서는 필수. IP 변경 뒤 재실행 |
| `FOOTHOLD_MDNS_NAME` | 기본 `Go2 EDU`; UTF-8 100바이트 이하 공개 표시명 |
| `FOOTHOLD_MDNS_MODEL` | 기본 `Go2 EDU`; UTF-8 100바이트 이하 모델명 |

TXT: `v=1`, `name`, `model`, `agent=ws://<IPv4>:<port>/phone/ws`,
`rid=<robot UUID>`(listener에서 제공할 때). 비밀·토큰·서버 주소는 넣지 않는다.
SRV 포트는 phone listener 포트, A 레코드와 송수신 인터페이스는 지정 IPv4다.
무작위 instance/host 이름을 사용하고 이름 충돌 처리는 zeroconf가 맡는다.
IPv4 한 인터페이스를 지원한다. loopback listener는 항상 광고하지 않는다.
수동 지정 주소의 실제 소유·폰 도달 여부는 현장에서 확인한다.

선택 의존성은 `zeroconf==0.148.0`([배포](https://pypi.org/project/zeroconf/0.148.0/),
[공식 API](https://python-zeroconf.readthedocs.io/en/latest/api.html), LGPL-2.1-or-later)다.
표준 라이브러리에는 mDNS/DNS-SD responder가 없고 기존 의존성에도 없다.
충돌 검사·질의 응답·TTL/철회를 직접 구현하지 않기 위해 추가했다.
설치 예: 저장소 루트에서 `python3 -m pip install -e './apps/agent[link,discovery]'`.
이 PR 작업 중 패키지 설치나 실망 광고 실행은 하지 않았다.

광고는 독립 daemon thread에서 등록·응답·철회하며 phone/safety 루프는 네트워크 완료를
기다리지 않는다. 설정 오류, extra 부재, multicast 실패는 광고만 끄고 고정 경고를 남긴다.
종료 시 철회를 요청하지만 daemon이 끝나기 전 프로세스가 종료되면 캐시가 TTL까지 남을 수 있다.
광고 실패가 기존 조종·STOP·인증 판정을 바꾸지 않는다.

## ROS 없는 현장 검색 시험

Python 3.10 이상과 `[discovery]` extra만 있으면 검색 후보 광고를 실행할 수 있다.
아래의 주소는 **실제로 실행하는 컴퓨터의 폰 연결 망 IPv4**로 바꾼다.

```sh
# 저장소 루트에서. 예시 주소를 그대로 실행하지 않는다.
FOOTHOLD_MDNS_NAME='Go2 EDU (검색 시험)' \
PYTHONPATH=apps/agent python3 -m foothold_agent.discovery \
  --discovery-only --address <LOCAL_IPV4> --port 8790
```

이 명령은 TXT `mode=discovery-only`를 추가하고 TCP listener·ROS·SDK·상태·서버 등록을
전혀 만들지 않는다. `rid`도 넣지 않는다. 검색 목록에 나타나는 단계만 시험하며,
표시 주소로 실제 연결하려 하면 실패하는 것이 예상 결과다. Ctrl-C로 종료한다.
실기 어댑터가 준비되기 전 `ros_bridge`를 실행하거나 domain 제한을 풀지 않는다.
현장 준비와 오프라인 파일은 로컬 `runs/go2-friday/FIELD-CHECKLIST.md`를 따른다.

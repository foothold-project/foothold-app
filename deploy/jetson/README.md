# Orin NX 실기 직결: 오프라인 준비용 초안

목표는 `Android APK ↔ 로봇 안 Orin NX 에이전트 ↔ Unitree SDK ↔ Go2 기본 보행`이다.
이 변경은 **SDK 출력 부품과 설치 사전 준비**까지만 제공한다. 실행 진입점, APK 연결,
실기 상태→Core 피드백 연결, 자동 실행 서비스는 제공하지 않는다. 기존
`go2_readonly`·mDNS·8자리 읽기 전용 현장 코드는 변경하지 않는다.

## 현재 제공하는 범위

- `foothold_agent.go2_direct`: 생성·import·`apply()`는 SDK 통신을 하지 않는다.
  명시적 `sdk.connect()`만 승인 검사를 통과한 뒤 SDK를 import/초기화한다.
- 몸 기준 SI 입력 `vx`, `vy`, `wz`와 단일 명령원 선택. 정지는 명령원과 관계없이 우선한다.
  명령원 선택은 인증이 아니다. upstream Core/lease/인증을 통과한 입력만 연결해야 한다.
- 기존 실기 명령 집합 `(0,0,0)`, `(0.6,0,0)`, `(0.6,0,-0.5)`, `(0.6,0,0.5)`만 허용한다.
  범위는 더 좁힐 수 있으나 새 속도·후진·횡이동·제자리 회전을 추가하지 않는다.
  작은 입력을 큰 속도로 올려 맞추지 않고, 집합에 없는 결과는 거절하고 잠근다.
- 입력 또는 출력 갱신이 0.30초 끊기면 `Move(0,0,0)`와 `StopMove()`를 시도하고 잠근다.
  늦게 도착한 입력과 먼저 재개된 출력 모두 기존 입력·출력 만료 시각을 덮기 전에 잠근다.
  SDK 호출이 늦게 반환된 경우에도 완료 시각으로 덮기 전에 검사하고 0/정지를 다시 보낸다.
  단순한 속도 0은 잠금 정지와 다르다. STOP/잠금 해제는 입력 생존 시간을 연장하지 않는다.
- 정상 출력과 별도의 SDK 객체를 쓰는 감시 경로, SDK timeout 설정 0.10초.
  명시적 STOP은 감시 작업을 즉시 깨워 정상 출력 복귀나 0.30초 만료를 기다리지 않는다.
  기본 live 모드에서는 두 작업 스레드가 살아 있기 전 STOP 외 입력·잠금 해제·수동
  `drain()`을 `OutputError`로 거부한다. 먼저 `start_threads()`를 실행해야 한다.
  STOP 중 이미 진행 중인 호출이 돌아오면 정상 경로에서도 즉시 0/정지를 다시 보낸다.
- 새 정지 세대에 대한 신선한 실제 정지 피드백(0.20초 이내), 권한 있는 명시적 해제,
  그 뒤 새 중립 입력을 모두 거쳐야 이동한다. SDK 성공 코드를 정지 피드백으로 만들지 않는다.

`Go2Sink.apply(command, source=...)`는 소유 명령원 확인이 필요한 새 부품이다.
기존 `MotionSink`에 그대로 꽂는 교체품이 아니다. `confirm_stopped()` 호출자는 센서 출처,
기체 ID, 순번, 시각, 실제 정지 판단을 검증해야 한다. 이 연결은 아직 작성하지 않았다.
가짜 SDK로 수동 순서를 검증하는 시험만 생성 시 `offline_test_mode=True`를 명시한다.
이 모드는 live 작업 스레드를 시작할 수 없으며 실기에 사용하면 안 된다.

## 1. 로봇을 받기 전에 확인할 것

Orin NX라는 제품명만으로 JetPack·Ubuntu·Python·NIC·펌웨어가 확정되지 않는다.
전용 Python 환경을 사용하고 JetPack의 시스템 Python을 교체하지 않는다.

읽기 전용 로컬 점검:

```sh
python3 deploy/jetson/preflight.py
```

아키텍처, Python, 설치된 배포판 버전, L4T 표시, 로컬 NIC 주소 대역/UP 상태와 DDS/loader
환경 덮어쓰기를 읽는다. SDK import·소켓·ping·ARP·로봇 탐색은 하지 않는다.
`192.168.123.0/24`는 현재 점검용 예시 대역이며 기체에서 확인해야 한다.
SDK는 domain 0을 계획한다. 이 스크립트는 실행 중 DDS 도메인·라우팅·로봇 연결을
검증하지 않는다. 종료 0도 **메타데이터 검토 통과**일 뿐 실기 사용 승인이 아니다.

## 2. 인터넷 없이 설치하기 위한 파일 목록

신뢰하는 준비 PC/동일 ARM64·Python ABI 환경에서 아래를 마련한다.
이 저장소에는 wheel·venv·실제 승인 표식·운영 설정을 커밋하지 않는다.

| 파일 | 조건 |
|---|---|
| `foothold_agent-0.2.0-*.whl` | 이 PR의 검토된 정확한 소스 커밋에서 빌드. 버전만으로 소스 동일성을 판단하지 않는다. |
| `unitree_sdk2py-1.0.1-*.whl` | SDK 소스 `814556d15970dd2ecf1c9984e845ca02ab07e206`에서 빌드·출처 기록 |
| CycloneDDS 0.10.2 wheel | Jetson ARM64와 대상 Python·libc에 맞는 바이너리. x86_64 wheel을 복사하면 안 된다. |
| 나머지 wheel 전체 | numpy 1.26.4, opencv-python 4.10.0.84, zeroconf 0.148.0, websockets 15.0.1와 **모든 전이 의존성** |
| `requirements.txt` | 모든 배포판을 한 줄 `패키지==정확한버전 --hash=sha256:wheel해시`로 고정. URL·소스 압축·editable 금지 |
| `SHA256SUMS` | requirements.txt와 각 wheel의 SHA-256, 같은 폴더의 파일 이름만 |
| 출처·ABI 검토 기록 | agent/SDK 커밋, 빌드 환경, ABI, 네이티브 라이브러리 의존성, 해시 목록을 별도 보관 |

**현재 ARM64 바이너리 묶음을 생성하거나 Jetson 설치를 검증한 상태가 아니다.**
CycloneDDS wheel의 외부 공유 라이브러리까지 확인해야 한다. Linux x86 가상환경에서
테스트가 통과해도 Jetson의 DDS 로딩·멀티캐스트·펌웨어 호환성을 증명하지 않는다.
점검 스크립트의 패키지 버전 확인도 SDK 소스 커밋 확인을 대신하지 못한다.

## 3. 설치 계획 확인과 설치만 수행하기

검토한 wheelhouse를 로컬로 복사한 뒤, 아직 없는 전용 venv 경로를 지정한다.

```sh
python3 deploy/jetson/install_offline.py --wheelhouse ./wheelhouse --dest ./go2-venv
```

기본은 파일·해시·고정 목록 검사만 한다. venv를 만들거나 패키지를 설치하지 않는다.
ABI와 출처 검토가 끝난 현장 담당자만 같은 명령에 `--install`을 붙여 설치한다.
설치 시 로컬 wheel만 허용하고 해시를 검사하며 마지막에 `pip check`를 수행한다.
모든 자식 프로세스에서 상속된 `PIP_*`를 제거하고 `PIP_CONFIG_FILE=os.devnull`로
pip 설정 파일을 차단한다. `--no-user`와 절대 경로 `--prefix`로 설치 대상을 지정한
전용 venv에 고정한다. Python의 `-I`만으로 pip 설정이 격리된다고 가정하지 않는다.
기존 경로를 덮지 않는다. 실패 시 새로 생긴 부분 설치 venv는 보존하므로 담당자가
내용을 확인한 뒤 정리한다. 로봇 연결·SDK 실행·systemd 등록·자동 시작은 하지 않는다.

## 4. 후속 통합 및 현장에서 활성화하기 위한 관문

이 초안을 설치해도 APK 조종은 켜지지 않는다. 다음을 순서대로 마쳐야 한다.

1. 두 모델의 안전 검토와 담당 조정 세션 통합. 기존 읽기 전용 경로를 대체하지 않는다.
2. APK↔Orin 로컬 인증·전송, 한 명령원 소유, 실제 센서→Core의 정지/잠금 피드백 연결.
   8자리 읽기 전용 현장 코드는 이동 권한으로 사용할 수 없다.
3. 실기 담당자 승인, 독립 비상 정지 수단·안전 공간 확보, 실제 기체 ID·NIC·SDK 호환 확인.
4. 현장에서만 `FH_GO2_DIRECT_ENABLED=1`, `FH_GO2_DIRECT_NIC`와 절대 경로
   `FH_GO2_FIELD_APPROVAL`을 설정한다. 기본은 모두 미설정이다.
   승인 표식은 실행 사용자 소유의 단일 링크 일반 JSON 파일, 권한 0600이어야 한다.
   형식은 `v:1`, `purpose:"go2-field-motion"`, 확인된 `nic`, `robot_serial`,
   `expires_at`(현재보다 미래이고 30분 이내인 Unix 초)다. 실제 값은 Git에 넣지 않는다.
5. 승인된 전용 프로세스에서만 `sdk.connect()`를 호출한다. 별도로 읽은 실제 serial이
   표식과 같아야 하며, inherited DDS/loader 설정이 있으면 거절한다. SDK singleton을
   쓰는 다른 프로그램에 끼워 넣지 않는다. 초기화 자체도 실제 DDS 통신이므로 이 초안
   검증에서는 호출하지 않았다. 기립·모드 전환·이동은 초기화 과정에서 하지 않는다.
6. 정지부터 단계별 확인. 입력 끊김·앱 종료·출력 지연·재연결·명령원 전환을 실측한다.

표식은 현장 운영 관문이며 폰 인증·이동 lease·실제 로봇 검증을 대체하지 않는다.
만료 뒤 nonzero SDK 출력은 거절하고 0/정지는 허용한다.

0.30초는 소프트웨어 감시 기준이다. Python 스레드, SDK timeout, 두 RPC 객체만으로
물리적 정지 시간이나 DDS 전송 순서를 보장하지 못한다. 진행 중인 호출은 취소할 수 없고,
프로세스/네트워크 정지 시 이 코드도 정지 명령을 전송하지 못한다. SDK 호출이 영구히
멈춘 경우 전용 프로세스 감시와 기체 측 failsafe가 필요하며 현재 제공하지 않는다.
`Move()` 반환 0은 명령 전송 성공이고 `StopMove()` 응답도 실제 정지 증거가 아니다.

## 오프라인 검증

```sh
FH_TEST_PORT_RANGE=9510:9529 PYTHONPATH=apps/agent python3 -m pytest -q \
  apps/agent/tests/test_go2_direct.py apps/agent/tests/test_jetson_preparation.py
```

가짜 SDK·가짜 시계·임시 파일만 사용한다. 실제 SDK 초기화·패키지 설치·Jetson·APK·실로봇
검증을 포함하지 않는다. 새 모듈을 사용하지 않으면 기존 실행 경로에는 영향이 없다.

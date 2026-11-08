# 현장 순서표 — Go2 한 대·전용 Orin·승인한 실기 시험 전용

이 순서는 별도 실기 승인을 받은 담당자가 실행한다. 이번 개발 작업에서는 실행하지 않았다.
검토한 APK/코드 커밋, 실제 JetPack·Python ABI, 펌웨어, 전용 NIC, 일련번호,
독립 비상 정지 수단과 안전 공간을 먼저 확인한다. 자동 기립·모드 전환·서비스 시작은 없다.
**현재 CycloneDDS ARM64 바이너리 공급이 차단 항목이다.** [두 준비 경로](DDS-BUILD-PATHS.md)와
기본 이미지의 기존 패키지/ABI를 먼저 확인한다. INCOMPLETE 묶음으로 다음 설치를 진행하지 않는다.

1. **묶음 복사.** 준비 PC의 `runs/`에 만든 완성 묶음을 Orin으로 복사한다.
   `INCOMPLETE`가 있으면 사용하지 않는다. 대상 Python은 묶음의 `PROVENANCE.json`과
   같아야 하며 시스템 Python을 교체하지 않는다. `wheelhouse/SHA256SUMS`를 대조한다.
2. **preflight.** 설치 전 `python3 deploy/jetson/preflight.py`로 누락 목록을 확인한다.
   처음에는 패키지 미설치로 종료 2가 정상이다. 전용 대상 Python ≥3.10, ARM64,
   L4T/NIC/환경을 확인하고 CycloneDDS의 ELF NEEDED와 외부 `.so` 해석을 검토한다.
3. **설치.** `python3 deploy/jetson/install_offline.py --wheelhouse ./wheelhouse --dest ./go2-venv`
   로 계획을 확인한 뒤, 담당자가 같은 명령에 `--install`을 붙인다. 새 전용 venv만 만들며
   설치 실패 환경은 덮지 않는다. `./go2-venv/bin/python deploy/jetson/preflight.py`가
   메타데이터 점검을 통과해야 다음으로 간다. 이는 실제 DDS 로딩/신원 검증을 대신하지 않는다.
4. **현장 설정·승인 표식.** 사용자 전용 0700 디렉터리에 검토한 0600 `field.env`와 기존
   폰 키링/재사용 방지 DB 경로를 준비한다. 전체 설정 이름은
   [실행 문서](../../apps/agent/GO2-DIRECT-RUNTIME.md)를 따른다.
   **`FOOTHOLD_PHONE_ORIGINS`에는 «앱이 연 서버 주소의 origin»으로 만든 JSON 배열이
   반드시 있어야 한다.** 예시 `['…']`는 JSON이 아니므로 쓰지 말고
   `FOOTHOLD_PHONE_ORIGINS='["https://app-server.invalid"]'`의 익명 예시 호스트를
   실제 앱의 scheme/host/필요한 port로 교체한다(경로·끝 `/` 제외).
   Android Go2Link는 WebView의 https Origin을 유지한 채 Wi-Fi에 묶은 소켓으로 중계한다.
   빠졌을 때 agent는 주소를 로그에 쓰지 않고 `PHONE_ORIGIN_NOT_ALLOWED`로 거부한다.

   ```sh
   ./go2-venv/bin/python deploy/jetson/make_approval.py --output "<새 표식 절대 경로>" --nic "<확인한 전용 NIC>" --serial "<확인한 LowState 숫자-숫자>" --approve-field-motion
   ```

   표식은 기본 15분, 최대 30분이며 기존 파일을 덮지 않는다. 현장 확인 없이 숫자를 추측해
   넣지 않는다. `FH_GO2_DIRECT_ENABLED=1`, `FH_GO2_DEDICATED_NIC=1`, 같은 NIC와 표식
   경로를 field.env에 지정한다. 상속된 DDS/loader 덮어쓰기는 제거하고 검토한 셸을 쓴다.
5. **시작.** 검토한 현장 설정을 불러온 전용 셸에서 한 명령으로 시작한다.

   ```sh
   ./go2-venv/bin/python -m foothold_agent.go2_direct
   ```

   기본은 로컬 폰 연결이다. Orin에 인터넷이 있는 경우에만 별도
   `FH_GO2_CLOUD_REPORTING=1`과 등록 토큰/주소로 직접 보고한다. 보통은 폰 LTE 경유다.
6. **폰 연결.** 검토한 새 APK에서 실제 기체 UUID와 유효한 폰 출입증으로 «연결»한다.
   Go2 상태 전용 8자리 코드는 조종 출입증이 아니다. 처음은 잠금이다. 실제 센서 정지
   확인 → 명시적 해제 → 새 중립 입력 순서다. 폰 LTE 송신 구현·APK 판은 별도 확인한다.
7. **STOP부터 확인.** 독립 비상 정지 담당자가 있는 승인된 시험에서 폰 STOP → 0/StopMove
   시도·잠금과 센서 정지 피드백을 확인한다. 정지 확인 전 재개 거부, 입력 0.30초 끊김,
   폰 단절·센서 0.20초 신선도·재접속/새 출입증·새 중립·표식 만료를 단계별로 실측한다.
   소프트웨어 시각은 실제 제동 시간 보장이 아니다. 이상하면 독립 정지 수단과 현장 절차를 따른다.

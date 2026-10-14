# Go2Direct 계약 — PC 관문 없이 Go2 에 직접 (2026-10-14, 기초 단계)

**지금 상태: 실로봇 연결 불가.** 로봇이 아직 없고(배송 전, 펌웨어 모름), Android 플러그인과 실제 네트워크 Port 는 **파일 0** 이다.
있는 것은 순수 Java 코어(`Go2Direct.java`)와 JVM 시험(`Go2DirectTest.java`)뿐이다. «연결됨·작동 완료»라고 표시하지 않는다.

| 부분 | 상태 |
|---|---|
| 탐색 응답 판정·질의 바이트 | 순수 코드 + 시험 |
| 로봇 등록부(원본 보존·설정 세대) | 순수 코드 + 시험. Android 보관소(Keystore, 못 풀면 보존) 연결부는 JVM 시험 불가 → 미검증 |
| 탐색 수명(busy·stale·hidden·cancel·늦은 응답) | 관문 탐색과 같은 `FhNearby.Ctl<T>` + 모의 Port 시험 |
| signaling 바이트 처리(9991 con_notify → con_ing) · HTTP 응답 파서 | 순수 코드 + 가짜 로봇 시험. 실펌웨어 대조 0 |
| Android 플러그인 `Go2Direct` | **미구현(파일 0)** |
| 실제 UDP 탐색 Port · 실제 HTTP 소켓 Port | **미구현(파일 0)** |
| WebRTC(영상·data channel) | **미구현** — WebView 쪽(UI 소유) |
| 이동 명령 | **없음** — 계획에도 이 단계엔 없다 |
| iOS | 계약만. Swift·Mac 빌드 0 |

화면은 `Capacitor.isPluginAvailable('Go2Direct')` 가 false 면 «실기 직접 연결: 준비 중(이 앱 판엔 없음)»으로만 보인다. 영상·데이터·명령 지원을 표시하지 않는다.
UI 합의(10-14): 실기 화면 칸(지도·RGB·depth·점군)은 contracts `Capabilities{command,map,rgb,depth,points,follow_cam}` 로 접어 실기 판에선 전부 false, 이번 판은 Go2Direct 메서드 호출 0·JS 키 입력 0, 모드 전환 때 시뮬 입력 폐기·명령 송신 0·세대 +1.

## 1. 경로 구별

| 경로 | 무엇 | PC 필요 | 이 계약 |
|---|---|---|---|
| ① 앱 직접 WebRTC | 로봇 Wi-Fi(AP, 고정 주소) 또는 같은 LAN(STA). UDP 탐색 → HTTP signaling → WebView RTCPeerConnection | 아니오 | **대상** |
| ② 공식 SDK2 / DDS | `unitree_sdk2`(BSD-3). 유선 이더넷 망, PC·온보드 컴퓨터에서 DDS | 예(또는 온보드) | 아님 — 앱 직접 연결과 다른 것 |
| ③ 로봇 탑재 relay | EDU 확장 컴퓨터에서 relay 를 돌려 앱이 거기 붙음 | 아니오(로봇 안) | 아님 — 대안으로만 기록 |

PC 관문(FhGate)은 그대로 있고 이 계약과 별개다. PC 를 필수로 두지 않는다.

## 2. 형식 출처와 한계

- Unitree Go 앱 정적 분석(REA, 실앱 실행 아님): 로봇 Wi-Fi 면 고정 주소, 아니면 UDP 방송 + 현재 SN 응답 대기, Wi-Fi 꺼짐이면 원격.
- 바이트 형식: 커뮤니티 MIT 코드 `legion1581/unitree_webrtc_connect` @e0abc57 기준. **Unitree 공식 보증 아님.** 실로봇 실측 0.
- 탐색: 질의 `{"name":"unitree_dapengche"}`(선택 `sn`) → 231.1.1.1:10131, 응답 JSON `{sn, ip}` 을 10134 에서 받음.
- signaling: HTTP 9991 `/con_notify` → `data2` 1(평문)·2(앱 내장 정적 키)·3(기기별 AES-128 GCM, Go2 ≥1.1.15) → `/con_ing_<5자리>` 로 암호화한 offer → answer.

## 3. 타입 계약(제안 — 플러그인 구현 시 이대로)

```ts
interface Go2Capabilities {
  kind: 'go2_direct'; api: 1;   // contracts/v1 ProviderKind 와 같은 이름(플러그인 이름은 Go2Direct)
  discover: boolean; register: boolean; deviceKey: boolean; signal: boolean;
  legacyKey: false;      // data2=2 — 앱 내장 정적 키는 추출 비밀이라 미포함
  legacyPort: false;     // 8081 /offer 옛 평문
  cloudKey: false;       // 기기 키 클라우드 취득(실계정 로그인) 0
  remote: false;         // 원격·TURN
  pointcloud: false;     // 점군 디코드
  command: false;        // 이동 명령
  verifiedOnRobot: false;
}
interface Go2Robot { sn: string; name: string; hasKey: boolean }        // 키 글자는 절대 안 옴
interface Go2Found { sn: string; ip: string; known: boolean }           // 미검증 후보
type Go2Why = 'wifi' | 'nsd' | 'hidden' | 'cancelled';                   // nsd = 탐색 시작 실패(UDP 포함 같은 이름 유지)
type Go2Stop = 'none' | 'requested' | 'failed';

capabilities(): Promise<Go2Capabilities>
robots(): Promise<{ gen: number; state: 'ok' | 'unreadable' | 'invalid'; robots: Go2Robot[] }>
discover(o?: { ms?: number }): Promise<{ gen: number; items: Go2Found[]; why?: Go2Why; stop: Go2Stop }>   // 1000~8000, 기본 5000
discoverStop(): Promise<void>
register(o: { sn: string; name?: string }): Promise<{ gen: number }>
forget(o: { sn: string }): Promise<{ gen: number }>
setKey(o: { sn: string }): Promise<{ gen: number; hasKey: boolean; why?: 'cancelled' }>   // native 입력창 — JS 는 키를 주지도 받지도 않음
clearKey(o: { sn: string }): Promise<{ gen: number }>
reset(): Promise<{ gen: number }>     // 사용자가 명시한 등록부 초기화만(기기 키 포함 삭제)
signal(o: { gen: number; sn: string; ip: string; mode: 'sta' | 'ap'; sdp: string }):
  Promise<{ gen: number; sdp: string; auth: 'device_key' | 'none' }>
signalCancel(): Promise<void>
```

## 4. 세대(gen)와 수명

- `gen` = 등록부 설정 세대. 저장이 확인된 등록·이름 변경·키 설정/삭제·forget·reset 마다 +1. 실패·거부는 그대로.
- `signal` 은 받는 순간의 `gen` 을 고정한다. 시작 때 현재와 다르거나, 끝났을 때 달라졌으면 `stale` — answer·상태를 채택하지 않는다.
- 탐색: 진행 중 두 번째 `busy`, 화면 숨김 `hidden`, 화면 재생성 `stale`, 끝난 탐색의 늦은 응답은 표시 0. 관문 탐색과 같은 제어기.
- 앱 복귀·재연결: 저장된 로봇을 발견하면 **읽기만** 자동 연결 가능. 조종 잡기(take)·재개(resume)·운동 0. 0이 아닌 속도 복원 0.

## 5. 신원과 인증

- 후보 신원 = 응답 `sn` + 출발지 주소. 출발지는 사설 IPv4 만(공인·CGNAT·IPv6·루프백 제외), 응답의 `ip` 가 출발지와 다르면 버림, `sn` 은 `^[A-Za-z0-9]{6,32}$`, 같은 `sn` 은 처음 것만, 16 개 상한.
- 처음 본 로봇은 목록에 보이기만 한다. 사람이 고르고 등록해야 연결 대상이 된다.
- `auth: 'device_key'` = 기기 키로 GCM 복호가 맞음 → 그 로봇의 공개키로 확인됨.
- `auth: 'none'`(data2=1) = 공개키 **미인증**. 같은 망의 가로채기를 막지 못한다. 화면은 «미인증 — 읽기만»으로 표시하고 명령은 열지 않는다.
- 암호화(signaling 내용 보호)와 신원 확인(sn·기기 키)은 별개다. 하나가 된다고 다른 것을 주장하지 않는다.

## 6. 평문 HTTP 는 Go2 signaling 만의 예외

- 앱의 NSC 는 그대로 cleartext 금지다. WebView·관문 통신은 계속 TLS 만 쓰고, **관문 TLS 설정 변경은 0**.
- 예외는 Go2 프로토콜이 정한 «사설 IPv4 숫자 주소 · 포트 9991 고정» signaling 하나다(구현될 때 native 소켓, 지금은 파일 0).
- 응답 검사(순수 파서, 시험 있음): 머리 ≤8 KiB · 본문 ≤64 KiB · 200 만 성공 · redirect(3xx)·multipart·chunked 외 전송 인코딩·길이 표기 충돌 거부 · 이름 해석 0(숫자 주소만).
- signaling 값 검사: data1 ≤16 KiB · 끝 10 자 `^(?:[!-~][A-J]){5}$` · 공개키 base64 100~1400 자, RSA 1024~4096 비트 · GCM 은 nonce 12 + tag 16 · offer·answer SDP ≤32 KiB 이고 `v=0` 시작 · answer `type` 은 `answer`. 전체 시한 10 s 하나.

## 7. 오류 code

| code | 뜻 |
|---|---|
| `bad_input` | 형식(일련번호·주소·mode·SDP·이름·키) |
| `busy` | 탐색·signal 이 이미 진행 중 |
| `stale` | 취소됨, 설정 세대가 바뀜, 화면 재생성 — 결과 버림 |
| `not_registered` | 등록 안 된 로봇 |
| `full` | 등록 16 대 초과 |
| `storage` | 등록부 저장 실패, 또는 원본을 못 읽어 변경 막힘(`reset` 전) |
| `key_required` | data2=3 인데 기기 키 없음 |
| `key_rejected` | 기기 키가 이 로봇 것이 아님(GCM 태그 불일치) |
| `unsupported_legacy_key` | data2=2 펌웨어 — 미지원 |
| `robot_busy` | 로봇이 다른 연결을 쓰는 중(answer `reject`) |
| `bad_robot` | 로봇 응답 형식 위반(위 6절) |
| `unreachable` · `timeout` | 실소켓 Port 가 생길 때 쓸 값(지금은 Port 0) |
| `internal` | 예기치 않은 오류 |

## 8. 화면 안내 문구 기준

- 빈 목록: «찾은 로봇 없음 — 로봇이 꺼져 있거나, 다른 망이거나, 응답하지 않는 것일 수 있습니다(앱은 셋을 구분하지 못함).»
- 실기 단계: «실기 직접 연결 기초만: 탐색 응답·등록·시그널링의 순수 처리까지. 네트워크·RTC·조종 연결은 추가 개발 필요.»
- 미지원 항목은 capabilities 그대로 «지원 안 함»으로 보이고, 버튼을 «곧 지원»처럼 활성화하지 않는다.

## 9. 등록부 보관

- Keystore AES-GCM 으로 암호화한 JSON 하나(`v:1`, robots ≤16). 기기 키는 이 안에만.
- 읽기 결과 `ok` · `unreadable`(보관본은 있으나 못 풂) · `invalid`(형식 위반 — 버전·필드 타입·sn 중복·키 형식·뒤에 붙은 글자 등). ok 가 아니면 하나도 채택하지 않고 원본을 보존하며, 변경은 `storage` 로 거부한다. 덮는 길은 사용자가 명시한 `reset` 뿐.
- 세션 보관소(FhGate)는 기존대로 못 풀면 지운다. 등록부는 지우지 않는다(기기 키 소실 방지).

## 10. 확인 안 한 것

실로봇·실펌웨어 형식 · 실제 UDP 멀티캐스트 수신(기기·Wi-Fi 칩별 MulticastLock 필요 여부) · targetSdk 37 로컬망 권한 · Android Keystore 보관 동작 · WebView WebRTC 연결 · data channel 검증 단계 · 영상·점군 · iOS 전부.

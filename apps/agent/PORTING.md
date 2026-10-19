# 안전 Core 이식 기록 (W1-A)

## 출처와 변경 경계

- 기준: `origin/feature/spec-docs` (`fe856609663919d82c41954bbe878a34044d6aa1`, 기획 PR #3).
- 원본: `sim/v2_link.py`, Git blob `6fa2708254372f282460baf9a4daa289e7516132`.
- 원본 SHA-256: `4ba64183aa39a411ac3a6f9f7b66e8791cc5202b3d9265ef28eb753352f771ee`.
- `SCHEMA`부터 `Core` 끝까지 복사했다. 원본 구간과 이식 구간의 문자열 대조가
  일치한다. 모듈 설명과 표준 라이브러리
  `math`, `time`, `deque` import만 분리했다. ROS·웹·서버 import는 없다.
- `sim/`, `server/`, `ui/`, `contracts/`, `mobile/` 수정 0. 변경은 `apps/agent/**`뿐이다.

## 보존한 판정

| 항목 | 원본 그대로인 값·동작 |
|---|---|
| DEAD / STATE_STALE | 0.3 s / 1.0 s, 엄격한 `>` 만료 비교 |
| RESUME_TIMEOUT / RESET_TIMEOUT | 3.0 s / 35.0 s, 응답 없으면 대기 종료 |
| 허용 명령 | `(0, 0, 0)`, `(0.6, 0, 0)`, `(0.6, 0, ±0.5)` |
| 중립 | 모든 축 절댓값 `< 0.2` |
| 후진 거부 | `fx <= -0.2` |
| 옆걸음 거부 | `abs(fy) >= 0.5` |
| 전진·회전 | 전진 `fx >= 0.5`, 회전 `fw >= 0.5` / `fw <= -0.5` |
| STOP·세대 | 누구나 STOP, 이미 잠겼어도 세대 증가, 오래된 세대 resume 거부 |
| 재개·리셋 | 새 상태 확인 전 0, 대기·끊김·episode 변경 시 기존 입력 폐기 |
| 재조종 | 새 중립 입력 뒤 새 비영 입력 필요, 조종권은 한 연결만 |

**SF-02·SF-03 차이: 막는 것 아님·후속 안전 작업 W-SAFE-1.**
원본은 최초 `latch=False`다. deadman 또는 상태 만료는 `_void()`로 입력 폐기와
중립 재확인을 요구하지만 `latch=True`로 잠그지 않는다. 초기 잠금·deadman 잠금
요구사항 충족을 주장하지 않는다. 이번에는 원본 판정·셀프테스트 기대값 변경 0을
우선하며, 조정 세션이 이 차이를 별도 W-SAFE-1 범위로 확인했다.

서버 연결·`lease_id`/`seq`·재접속 처리·충돌 감시·명령 전송 재시도 정책은 미구현이다.
SF-01~04·SF-09 전체가 완성된 것은 아니다. Core의 timeout 뒤 자동 재시도는 없고,
`want_stop_pub()`의 STOP 확인 재발행 의사결정도 그대로이며 실제 발행은 없다.

## 원본 assert 대응표

기본 `selftest()`의 Core·입력·상태 검사와 `selftest_stopgen()` 전체,
`selftest_stop()`의 Core 입력 경계, `selftest_live()`의 Core 처리 중 경계를 옮겼다.
함수 이름과 import를 바꾸고 독립 추출한 두 시험에 가짜 시계 `t = [0.0]`를 추가했다.
기본 selftest 끝의 다른 셀프테스트 호출과 완료 출력은 pytest 수집으로 대체했다.
아래 원본 assert의 조건·메시지 AST를 행 순서대로 비교해 모두 일치함을 확인했다.
반복문 안의 assert는 표에서 한 문장으로 센다. 위치는 `파일:행:열`(1부터)이다.

카메라(`selftest_camwhy`), 지도·미디어·문서·뷰·외부 래퍼 시험은 Core 소유 범위가
아니어서 이식하지 않았다. 원본 전체 `--selftest` 실행에는 이 범위도 포함된다.
실제 지도 원물 선택용 `V2_LINK_MAPS_ROOT`는 지정하지 않았다.

| 원본 함수 | pytest 함수 | assert 수 |
|---|---|---|
| `selftest` | `test_original_core` | 49 |
| `selftest_stopgen` | `test_original_stopgen` | 20 |
| `selftest_stop` | `test_original_stop_busy_core` | 10 |
| `selftest_live` | `test_original_map_busy_core` | 8 |

총 **87개 assert 문**의 기대값·메시지가 동일하다.

| 원본 assert 위치 | 이식 위치 (`apps/agent/` 기준) | pytest 함수 |
|---|---|---|
| `sim/v2_link.py:2688:5` | `tests/test_original_core.py:18:5` | `test_original_core` |
| `sim/v2_link.py:2690:9` | `tests/test_original_core.py:20:9` | `test_original_core` |
| `sim/v2_link.py:2694:9` | `tests/test_original_core.py:24:9` | `test_original_core` |
| `sim/v2_link.py:2695:5` | `tests/test_original_core.py:25:5` | `test_original_core` |
| `sim/v2_link.py:2699:9` | `tests/test_original_core.py:29:9` | `test_original_core` |
| `sim/v2_link.py:2700:5` | `tests/test_original_core.py:30:5` | `test_original_core` |
| `sim/v2_link.py:2704:5` | `tests/test_original_core.py:34:5` | `test_original_core` |
| `sim/v2_link.py:2705:5` | `tests/test_original_core.py:35:5` | `test_original_core` |
| `sim/v2_link.py:2706:11` | `tests/test_original_core.py:36:11` | `test_original_core` |
| `sim/v2_link.py:2707:5` | `tests/test_original_core.py:37:5` | `test_original_core` |
| `sim/v2_link.py:2708:20` | `tests/test_original_core.py:38:20` | `test_original_core` |
| `sim/v2_link.py:2709:28` | `tests/test_original_core.py:39:28` | `test_original_core` |
| `sim/v2_link.py:2710:25` | `tests/test_original_core.py:40:25` | `test_original_core` |
| `sim/v2_link.py:2711:5` | `tests/test_original_core.py:41:5` | `test_original_core` |
| `sim/v2_link.py:2713:19` | `tests/test_original_core.py:43:19` | `test_original_core` |
| `sim/v2_link.py:2714:11` | `tests/test_original_core.py:44:11` | `test_original_core` |
| `sim/v2_link.py:2715:20` | `tests/test_original_core.py:45:20` | `test_original_core` |
| `sim/v2_link.py:2716:11` | `tests/test_original_core.py:46:11` | `test_original_core` |
| `sim/v2_link.py:2718:23` | `tests/test_original_core.py:48:23` | `test_original_core` |
| `sim/v2_link.py:2720:33` | `tests/test_original_core.py:50:33` | `test_original_core` |
| `sim/v2_link.py:2722:21` | `tests/test_original_core.py:52:21` | `test_original_core` |
| `sim/v2_link.py:2723:20` | `tests/test_original_core.py:53:20` | `test_original_core` |
| `sim/v2_link.py:2724:5` | `tests/test_original_core.py:54:5` | `test_original_core` |
| `sim/v2_link.py:2725:20` | `tests/test_original_core.py:55:20` | `test_original_core` |
| `sim/v2_link.py:2726:21` | `tests/test_original_core.py:56:21` | `test_original_core` |
| `sim/v2_link.py:2728:33` | `tests/test_original_core.py:58:33` | `test_original_core` |
| `sim/v2_link.py:2728:84` | `tests/test_original_core.py:58:84` | `test_original_core` |
| `sim/v2_link.py:2729:20` | `tests/test_original_core.py:59:20` | `test_original_core` |
| `sim/v2_link.py:2729:56` | `tests/test_original_core.py:59:56` | `test_original_core` |
| `sim/v2_link.py:2730:20` | `tests/test_original_core.py:60:20` | `test_original_core` |
| `sim/v2_link.py:2730:64` | `tests/test_original_core.py:60:64` | `test_original_core` |
| `sim/v2_link.py:2731:26` | `tests/test_original_core.py:61:26` | `test_original_core` |
| `sim/v2_link.py:2731:96` | `tests/test_original_core.py:61:96` | `test_original_core` |
| `sim/v2_link.py:2733:26` | `tests/test_original_core.py:63:26` | `test_original_core` |
| `sim/v2_link.py:2733:70` | `tests/test_original_core.py:63:70` | `test_original_core` |
| `sim/v2_link.py:2734:5` | `tests/test_original_core.py:64:5` | `test_original_core` |
| `sim/v2_link.py:2735:5` | `tests/test_original_core.py:65:5` | `test_original_core` |
| `sim/v2_link.py:2736:36` | `tests/test_original_core.py:66:36` | `test_original_core` |
| `sim/v2_link.py:2737:52` | `tests/test_original_core.py:67:52` | `test_original_core` |
| `sim/v2_link.py:2738:5` | `tests/test_original_core.py:68:5` | `test_original_core` |
| `sim/v2_link.py:2738:49` | `tests/test_original_core.py:68:49` | `test_original_core` |
| `sim/v2_link.py:2739:5` | `tests/test_original_core.py:69:5` | `test_original_core` |
| `sim/v2_link.py:2739:86` | `tests/test_original_core.py:69:86` | `test_original_core` |
| `sim/v2_link.py:2740:33` | `tests/test_original_core.py:70:33` | `test_original_core` |
| `sim/v2_link.py:2742:35` | `tests/test_original_core.py:72:35` | `test_original_core` |
| `sim/v2_link.py:2743:26` | `tests/test_original_core.py:73:26` | `test_original_core` |
| `sim/v2_link.py:2743:93` | `tests/test_original_core.py:73:93` | `test_original_core` |
| `sim/v2_link.py:2744:5` | `tests/test_original_core.py:74:5` | `test_original_core` |
| `sim/v2_link.py:2744:40` | `tests/test_original_core.py:74:40` | `test_original_core` |
| `sim/v2_link.py:847:18` | `tests/test_original_core.py:82:18` | `test_original_stopgen` |
| `sim/v2_link.py:848:5` | `tests/test_original_core.py:83:5` | `test_original_stopgen` |
| `sim/v2_link.py:848:25` | `tests/test_original_core.py:83:25` | `test_original_stopgen` |
| `sim/v2_link.py:849:5` | `tests/test_original_core.py:84:5` | `test_original_stopgen` |
| `sim/v2_link.py:850:5` | `tests/test_original_core.py:85:5` | `test_original_stopgen` |
| `sim/v2_link.py:851:34` | `tests/test_original_core.py:86:34` | `test_original_stopgen` |
| `sim/v2_link.py:852:5` | `tests/test_original_core.py:87:5` | `test_original_stopgen` |
| `sim/v2_link.py:853:39` | `tests/test_original_core.py:88:39` | `test_original_stopgen` |
| `sim/v2_link.py:854:40` | `tests/test_original_core.py:89:40` | `test_original_stopgen` |
| `sim/v2_link.py:855:5` | `tests/test_original_core.py:90:5` | `test_original_stopgen` |
| `sim/v2_link.py:855:41` | `tests/test_original_core.py:90:41` | `test_original_stopgen` |
| `sim/v2_link.py:856:47` | `tests/test_original_core.py:91:47` | `test_original_stopgen` |
| `sim/v2_link.py:857:49` | `tests/test_original_core.py:92:49` | `test_original_stopgen` |
| `sim/v2_link.py:858:21` | `tests/test_original_core.py:93:21` | `test_original_stopgen` |
| `sim/v2_link.py:858:75` | `tests/test_original_core.py:93:75` | `test_original_stopgen` |
| `sim/v2_link.py:859:49` | `tests/test_original_core.py:94:49` | `test_original_stopgen` |
| `sim/v2_link.py:860:57` | `tests/test_original_core.py:95:57` | `test_original_stopgen` |
| `sim/v2_link.py:861:5` | `tests/test_original_core.py:96:5` | `test_original_stopgen` |
| `sim/v2_link.py:862:5` | `tests/test_original_core.py:97:5` | `test_original_stopgen` |
| `sim/v2_link.py:863:18` | `tests/test_original_core.py:98:18` | `test_original_stopgen` |
| `sim/v2_link.py:794:15` | `tests/test_original_core.py:105:15` | `test_original_stop_busy_core` |
| `sim/v2_link.py:794:79` | `tests/test_original_core.py:105:79` | `test_original_stop_busy_core` |
| `sim/v2_link.py:796:14` | `tests/test_original_core.py:107:14` | `test_original_stop_busy_core` |
| `sim/v2_link.py:798:9` | `tests/test_original_core.py:109:9` | `test_original_stop_busy_core` |
| `sim/v2_link.py:799:53` | `tests/test_original_core.py:110:53` | `test_original_stop_busy_core` |
| `sim/v2_link.py:800:9` | `tests/test_original_core.py:111:9` | `test_original_stop_busy_core` |
| `sim/v2_link.py:801:9` | `tests/test_original_core.py:112:9` | `test_original_stop_busy_core` |
| `sim/v2_link.py:803:5` | `tests/test_original_core.py:114:5` | `test_original_stop_busy_core` |
| `sim/v2_link.py:804:5` | `tests/test_original_core.py:115:5` | `test_original_stop_busy_core` |
| `sim/v2_link.py:804:69` | `tests/test_original_core.py:115:69` | `test_original_stop_busy_core` |
| `sim/v2_link.py:2362:5` | `tests/test_original_core.py:121:5` | `test_original_map_busy_core` |
| `sim/v2_link.py:2362:69` | `tests/test_original_core.py:121:69` | `test_original_map_busy_core` |
| `sim/v2_link.py:2363:52` | `tests/test_original_core.py:122:52` | `test_original_map_busy_core` |
| `sim/v2_link.py:2365:9` | `tests/test_original_core.py:124:9` | `test_original_map_busy_core` |
| `sim/v2_link.py:2366:53` | `tests/test_original_core.py:125:53` | `test_original_map_busy_core` |
| `sim/v2_link.py:2367:18` | `tests/test_original_core.py:126:18` | `test_original_map_busy_core` |
| `sim/v2_link.py:2368:22` | `tests/test_original_core.py:127:22` | `test_original_map_busy_core` |
| `sim/v2_link.py:2368:86` | `tests/test_original_core.py:127:86` | `test_original_map_busy_core` |

## 추가 단위 시험·실행 기록

`tests/test_core_boundaries.py`는 원본 기대값과 분리해 명령 단계화 경계,
deadman·상태·재개·리셋의 정확한 시간 경계, timeout 뒤 자동 재시도 없음,
사건 sink 실패에도 STOP 적용, 표시값 정리, `python -I -S`에서 표준 라이브러리만으로
import와 0 출력을 판정한다. 새 pytest는 원본 서버를 import하거나 실행하지 않는다.

2026-10-19, Python 3.12.3 / pytest 7.4.4, 저장소 루트에서 실행:

| 명령·검사 | 결과 |
|---|---|
| `python3 -m pytest apps/agent -q` | 19 passed |
| `python3 sim/v2_link.py --selftest` | 종료 코드 0, `selftest OK` |
| 원본 구간 문자열 대조 / 원본 assert AST 대조 | Core·상수 동일 / 위 대응표 전체 동일 |
| `git diff --check` | 통과 |

오프라인 단위·모의 검증 결과다. ROS·Gazebo·운영 서버 접촉, 네트워크 연결,
실폰·실로봇·실제 명령 송신·정지 거리·20 Hz 실행 주기와 패키지 배포는 미검증이다.
원본 셀프테스트의 subprocess는 임시 폴더의 모의 스크립트만 실행한다.
PR #3 이후 합침이며 `dev` 통합과 Claude·Codex 양쪽 안전 검토는 조정 세션 관문이다.

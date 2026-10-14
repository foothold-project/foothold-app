# 통합 브랜치 출처 — less82/app-platform-integration

이 브랜치는 **UI final 위에 `mobile/**` 스냅샷만 얹은 것**이다(옛 모바일 브랜치와의 merge 아님 — 최초는 UI final 에서 생성, 이후 새 UI final 은 로컬 일반 merge 로 전진). 옛 모바일 브랜치의 `sim/`·`server/`·`contracts/` 판과 그 이력은 가져오지 않는다.

| 부분 | 출처 커밋 | 트리 해시 | 비고 |
|---|---|---|---|
| 현재 UI final — `ui/`·`server/`·`contracts/`·`sim/`·`web/`·`tests/`·`tools/` 등 | `c954bbd4a2b21a2e3e6650b9a78875f7c4107159` (`less82/app-ui-react-recovered`) | `ui` = `86642d9d29a38372e516585ba97e75775dee71fd` | 그대로 |
| `mobile/**` | `cfbb683acdb785c9b713f47d32013aa9e8b8e91e` (`less82/app-contract-storage`) | `mobile` = `f7681116d5f25729a95b83de667cfd02e3e1ca09` | 파일 단위 변경 0 |
| `docs/PROVENANCE-app-platform-integration.md`(이 문서) · `docs/GITHUB-WORKFLOW.md` · 루트 `.gitignore` 경로 보강 | 이 브랜치에서 추가 | — | 작업 방식은 GITHUB-WORKFLOW.md |

검사(통합 커밋마다): `git rev-parse HEAD:mobile` = 위 mobile 트리, `git rev-parse HEAD:ui` = 위 ui 트리, `git diff --name-only c954bbd4a2b21a2e3e6650b9a78875f7c4107159 HEAD` 는 `mobile/`·위 두 문서·`.gitignore` 뿐.

한계(이 판): Go2Direct 는 순수 코어·JVM 시험만 — Android 플러그인과 실제 UDP/HTTP Port 는 미구현(실로봇 연결 불가). 실폰·iOS·실기 확인 0.

# 세션 이동 체크포인트 (2026-10-13, 고정 앱 mentor 대화 90f1cd5b)

Orca 상위 foothold → foothold-app 아래 터미널로 같은 대화를 resume 하기 위한 저장점이다. 새 담당·새 대화가 아니다.

## 커밋 상태 (feature/react-platform-oh)
- `dbf7a28`: 묶음 1 UI.
- `0e210e5`: 묶음 1 결과 문서.
- `0757124`·`4f42cc7`·`b6b9fd7`·`9877bf9`: 백엔드 47006b6·099d7b3·d10edb6·37ab187 의 cherry-pick.
- `46bb846`: 옛 json Docs id 충돌 재추첨 + `tests/sim/store_mock_check.py`.
  - 시험 결과: fixture 사본·도메인 88 에서 11/11.
  - 사진·사건의 정본은 계속 파일이고 DB 로 옮기지 않았다.
  - 운영 자료 이전은 하지 않았다.

## 커밋 안 된 diff
- `ui/package.json`, `ui/package-lock.json`: `pretendard@1.3.9` 를 추가했다.
  - 공식 npm 배포이고 저장소는 orioncactus/pretendard 다. 라이선스는 OFL-1.1(`node_modules/pretendard/dist/LICENSE.txt`)이다.
  - 글꼴 패밀리 이름은 `'Pretendard Variable'` 이다. 동적 부분집합 CSS 는 `pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css` 다.

## 브랜드 지시 (앱 Codex, 10-13) — 아직 적용 전
**기준과 원본 자료**
- 기준은 `foothold-project/foothold-brand` main `7afd2416d266f9a2d6d6166c66e576eacef524b9` 다.
- 받은 원본 16개는 `runs/react-oh/brand-src-7afd241/` 에 있다(git 무시).
  - 토큰 css·json, LICENSE·LICENSE_SCOPE·TRADEMARKS·BRAND_USAGE_POLICY·BRAND_BIBLE, MIT.txt, 로고 README·ASSET_INDEX, compact·primary light/dark SVG, favicon SVG.
  - 각 파일의 git blob SHA 를 트리와 대조해 모두 OK 였다.
- 원본 reference 와 브랜드 저장소는 수정하지 않는다.

**할 일**
1. `ui/public/brand/` 에 원본 바이트 그대로 둔다. `SOURCE.md` 에 다음을 기록한다.
   - commit/SHA
   - 토큰은 MIT
   - 로고는 Reserved brand assets(TRADEMARKS·BRAND_USAGE_POLICY)
2. 로고를 넣는다.
   - 헤더 로고칸: 10개 view(Main·PcHistory·PcLogin·MLogin·PcMap·PcMissions·PcPlan·PcReview·PcRobot·PcSettings)에서 `svg 28px + "FOOTHOLD" 글자` 를 compact SVG `<img>` 로 바꾼다(높이 약 24px, 비율 537.108:96).
   - 로그인 넓은 칸(PcLogin·MLogin)에는 primary 를 쓴다.
   - light/dark 는 CSS 로 고른다. `.fh .logo-l{display:none}` / `.fh.light .logo-d{display:none}`.
   - Report 의 `"FOOTHOLD · 임무 기록"` 글자 워드마크는 compact-light 와 `임무 기록` 으로 바꾼다.
   - favicon 은 공식 파일로 바꾼다.
   - transform·filter·재칠은 추가하지 않는다. SVG 에 이미 들어 있는 skewX(-3) 만 둔다.
3. 글꼴을 바꾼다.
   - `.fh` 와 `.mono` 는 `'Pretendard Variable', Pretendard, 'Malgun Gothic', 'Segoe UI', system-ui` 로 하고 `tabular-nums` 를 유지한다.
   - index.html 의 Google Fonts 링크는 제거한다(외부 CDN 없이도 표시되게).
4. 색 bridge 를 만든다. 공식 tokens.css 는 값 변경 없이 import 한다.
   - 충돌하는 이름은 `--stop` 뿐이다. `:root{--b-stop:var(--stop)}` 로 먼저 잡아 두고 `.fh` 에서 alias 한다.
   - 셀렉터는 per-screen `.fh.light`(0,2,0)보다 우선해야 한다.
   - 매핑은 아래와 같다.

     | 앱 변수 | 공식 토큰 |
     |---|---|
     | `--bg` | `--paper` |
     | `--panel` | `--card` |
     | `--panel2` | `--paper-2` |
     | `--line` | `--rule` |
     | `--line2` | `color-mix(rule, ink 15%)` |
     | `--text` | `--ink` |
     | `--muted` | `--ink-2` |
     | `--accent` | `--brand` |
     | `--ok` | `--dim-ink` |
     | `--warn` | `--note-ink` |
     | `--bad` | `--b-stop` |
     | `--acc-bg`·`--warn-bg`·`--bad-bg` | `--dim-soft`·`--note-soft`·`--stop-soft` |
     | `--on-accent` | 어두움 `--paper`(대비 8.66) · 밝음 `--card`(5.21) |

   - STOP 채움은 어두움에서도 공식 light `--stop` 값 `#a3342a` 를 쓴다. 흰 글자 대비 6.81 이고, 공식 dark `--stop` 은 3.14 라 미달이다.
   - `--nav`·`--measure` 는 레이아웃에 적용하지 않는다.
   - 미결: 공식 토큰은 `:root[data-theme]` 또는 OS 설정을 따르고, 앱 테마는 `.fh.light` 클래스다. 렌더 경로(main.tsx·parity.tsx)에서 `<html data-theme>` 를 `.fh` 테마에 맞추는 동기화가 필요하다. parity 쪽도 같은 처리가 필요하다.
5. 검증(mock 만)
   - BEFORE/AFTER 캡처: PC Main·로그인·Report, 폰 MDrive·MHome, light/dark 각각.
   - 로고 sha256, 대비 표.
   - STOP 이 화면 안에 있는지와 hit 확인.
   - glyph 폭 때문에 줄바꿈이 생기거나 STOP 이 밀리는지 확인한다.
   - parity 차이는 «브랜드 승인 차이»로 구분해 기록한다.
   - 레이아웃을 다시 설계해야 하면 앱 Codex 에 묻는다.
   - 브랜드는 별도 커밋으로 하고, 앱 Codex 보고는 3줄.

## 그다음 (묶음 2, 범위 그대로)
- 진행한 범위: MAlerts·MAlert 의 기존 로직(live.js 1597–1662)만 읽었고 코드는 아직 없다.
- 계획
  - 공통 문구(UNSUP/WHY/STOP_FACT/LATCH_TXT)를 `ui/src/data/facts.ts` 로 옮긴다.
  - 화면 순서: MAlerts·MAlert → PcRobot → 계획·양식(PcMissions·PcPlan, Query mutation 409·초안) → 사진 분류(PcReview·MFinding) → 지도(PcMap·MMap, MapCanvas 버튼·궤적) → PcSettings(쪽 안 앵커 충돌).

## 떠 있는 내 개발 프로세스 (서버 조작 안 함, 그대로 둠)
- fake `tools/fake_v2_live.py` 153879 와 link 8791(153881, 도메인 88). 모의 링크는 STOP 시험 뒤 잠금 상태다. 해제는 조종권 보유자만 할 수 있다.
- vite 5181(218330), CDP Chrome 9258(162848).
- 시험 자식(8793·8794 link, 시험 스크립트)은 없다(확인함).

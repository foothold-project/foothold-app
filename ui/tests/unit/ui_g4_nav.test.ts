import { expect, test } from 'vitest';
// G4(ROOT 4 · UX-SPEC 3-1 · 10-19): PC 주 메뉴 7칸 = 관제·조종·임무·기록·지도·로봇·(아래)설정 — 공통 틀(PcFrame)과 정적 화면 8곳이 같은 목록.
// 본다: 순서(UX-SPEC 3-1 표 그대로) · 현재 칸은 화면당 1개 · Main 에서는 «조종»만 현재(옛 «관제» cur 0) · 조종 그림 = 기존 규격(24 viewBox · stroke 1.8)
// 정적 view 는 하드코딩 마크업이라 파일 글에서 순서를 읽는다(그리는 결과와 같은 글). 한계: 실제 픽셀·폰 하단 메뉴(개편 0)는 670 몫.
const ORDER = ['Fleet', 'Main', 'PcPlan', 'PcHistory', 'PcMap', 'PcRobot', 'PcSettings'];
const LAB = ['관제', '조종', '임무', '기록', '지도', '로봇', '설정'];
const CUR: Record<string, string> = { Main: 'Main', PcHistory: 'PcHistory', PcMap: 'PcMap', PcRobot: 'PcRobot', PcPlan: 'PcPlan', PcMissions: 'PcPlan', PcSettings: 'PcSettings', PcReview: 'PcHistory' };
const fsm = 'node:fs', src = async (p: string) => (await import(/* @vite-ignore */ fsm)).readFileSync(new URL(`../../src/${p}`, import.meta.url), 'utf8') as string;   // 다른 시험과 같은 방식(@types/node 없음)

test('정적 화면 8곳: 메뉴 7칸 같은 순서·글 · 현재 칸 하나(Main = 조종만)', async () => {
  for (const [f, cur] of Object.entries(CUR)) {
    const s = await src(`screens/${f}.view.tsx`);
    const a = [...s.matchAll(/<a className="nav( cur)?" href="#\/(\w+)"[^>]*>[\s\S]*?\{"([^"]+)"\}\s*<\/a>/g)];
    expect(a.map((m) => m[2]), f).toEqual(ORDER); expect(a.map((m) => m[3]), f).toEqual(LAB);
    expect(a.filter((m) => m[1]).map((m) => m[2]), f).toEqual([cur]);
    expect(a.filter((m) => m[1] && !/aria-current="page"/.test(m[0])), f).toEqual([]);
  }
});

test('공통 틀 PcFrame: NAV 6칸 + 아래 설정 = 같은 7칸 · 조종 그림 규격', async () => {
  const s = await src('app/fleetui.tsx');
  const nav = s.slice(s.indexOf('const NAV'), s.indexOf('const SET_ICON'));
  expect([...nav.matchAll(/\['(\w+)', '([^']+)'/g)].map((m) => [m[1], m[2]])).toEqual(ORDER.slice(0, 6).map((h, i) => [h, LAB[i]]));
  expect(s).toContain('href="#/PcSettings"');
  expect(nav).toMatch(/\['Main', '조종', I\(<><circle cx="12" cy="12" r="8" \/><path d="[^"]+" \/><\/>\)\]/);
});

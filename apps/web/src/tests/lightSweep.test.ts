// 밝은 판 · 어두운 판(u11): 로봇 · 지도 · 기록 · 설정 · 휴지통 · 결재 탭 화면 파일에 직접 색(#hex · rgb() · hsl())을 쓰지 않는다 — 색은 토큰(var(--…)).
// 주석은 보지 않는다(이슈 번호 #252 등). 남겨 두는 직접 색은 아래 표에 까닭과 함께만.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DelX } from '../screens/mapedit';

const FILES = import.meta.glob(['../screens/{fleet,maps,mapedit,mapmake,mapdiff,slammap,mapscen,terrain,terrain3d,voxel3d,voxelmap,history,settings,trash,approvals}.{tsx,css}'],
  { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

/** [파일, 그 줄에 있어야 하는 글, 까닭] */
const ALLOW: [string, string, string][] = [
  ['terrain3d.tsx', "c('--", '토큰을 읽지 못할 때(토큰이 color-mix 등)만 쓰는 기본색'],
  ['terrain3d.tsx', "hole: new THREE.Color('#0b0d10')", '구멍 = 바닥 없음. 두 테마 모두 검은 빈칸(2D 판 terrain.tsx 구멍과 같은 뜻)'],
  ['terrain.tsx', 'fill="#14171C"', '구멍 = 바닥 없음. 두 테마 모두 검은 빈칸 + 빗금'],
  ['slammap.tsx', "g.fillStyle = `rgb(${RGB[0].join(',')})`", '점유 지도 바탕 = 지도 자료 색(occmap.tsx 표, 테마와 무관한 그림)'],
  ['slammap.tsx', "|| '#36c'", '토큰을 읽지 못할 때만 쓰는 기본색'],
  ['slammap.tsx', "g.strokeStyle = '#fff'", '지도 그림(테마와 무관한 점유 색) 위 로봇 화살 테두리'],
  ['mapscen.css', '.fh.light .mp,.fh.light .mp-fl,.proto.light.u7 .view{', '밝은 판 토큰 = 정본 DESIGN.md 밝음 1 값(tests/maplight.test.js 가 표와 맞춰 봄)'],
  ['mapscen.css', '.mp{--mp-rowhi:', '시안 u7 어두운 판 값을 토큰으로 정의하는 줄(밝은 판은 .fh.light 줄에서 테마 토큰으로 덮음)'],
  ['mapscen.css', '.mp-fl,.u7 .view{--mp-rowhi:', '층 화면(시안 u7_3 · u7_4 보기 칸 포함)의 같은 토큰 정의(밝은 판은 .fh.light 줄에서 덮음)'],
  ['mapscen.css', '  --mp-on:rgba(0,195,137', '같은 토큰 정의 둘째 줄'],
  ['mapscen.css', '  --mp-view:radial-gradient(', '같은 토큰 정의 셋째 줄'],
  ['mapedit.tsx', "stroke: '#FFFFFF'", '지우기 손잡이 = --bad-strong 위 흰 X(두 테마 같은 대비 6.5:1, STOP 단추와 같은 고정 쌍)'],
];

const COLOR = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(/;
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

describe('밝은 판 · 직접 색 없음', () => {
  it('대상 파일을 찾음(경로가 바뀌어 0 개가 되면 시험이 헛돈다)', () => {
    expect(Object.keys(FILES).length).toBeGreaterThanOrEqual(20);
  });
  it('대상 파일에 직접 색이 없다(허용 표 밖)', () => {
    const bad: string[] = [];
    for (const [path, src] of Object.entries(FILES)) {
      const name = path.split('/').pop()!;
      strip(src).split('\n').forEach((line, i) => {
        if (!COLOR.test(line)) return;
        if (ALLOW.some(([f, has]) => f === name && line.includes(has))) return;
        bad.push(`${name}:${i + 1}: ${line.trim().slice(0, 120)}`);
      });
    }
    expect(bad).toEqual([]);
  });
  it('L4: 지도 편집 지우기 손잡이 바탕 = --bad-strong(흰 X 와 두 테마 대비 6.5:1) · --bad 로 되돌리면 실패', () => {
    const html = renderToStaticMarkup(createElement('svg', null, createElement(DelX, { at: [10, 20], r: 8, k: 'z1', label: '지우기' })));
    const fill = html.match(/<circle[^>]*style="([^"]*)"/)![1];
    expect(fill).toContain('fill:var(--bad-strong)');
    expect(fill).not.toMatch(/fill:var\(--bad\)/);
  });
  it('지도 경유점 번호 글자 = --on-accent(어두움 --accent 위 흰 글자는 대비가 낮다)', () => {
    const src = FILES['../screens/maps.tsx'];
    expect(src).toMatch(/fill: 'var\(--accent\)', stroke: 'var\(--on-accent\)'/);
    expect(src).toMatch(/style=\{\{ fill: 'var\(--on-accent\)' \}\}>\{i \+ 1\}/);
  });
});

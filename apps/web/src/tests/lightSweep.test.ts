// 밝은 판 · 어두운 판(u11): 로봇 · 지도 · 기록 · 설정 · 휴지통 · 결재 탭 화면 파일에 직접 색(#hex · rgb() · hsl())을 쓰지 않는다 — 색은 토큰(var(--…)).
// 주석은 보지 않는다(이슈 번호 #252 등). 남겨 두는 직접 색은 아래 표에 까닭과 함께만.
import { describe, expect, it } from 'vitest';

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
  it('지도 경유점 번호 글자 = --on-accent(어두움 --accent 위 흰 글자는 대비가 낮다)', () => {
    const src = FILES['../screens/maps.tsx'];
    expect(src).toMatch(/fill: 'var\(--accent\)', stroke: 'var\(--on-accent\)'/);
    expect(src).toMatch(/style=\{\{ fill: 'var\(--on-accent\)' \}\}>\{i \+ 1\}/);
  });
});

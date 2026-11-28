// @vitest-environment node
// 팀장 02:21 «시뮬 파랑이 관제 타일 · 작은 지도에서 덜 보인다»: 실측(어둠) 타일 현장 바탕 밝기 110 에 파랑 차이 7 · 작은 지도 시뮬 점은 회색 점선.
// 고친 뒤: 현장 위 시뮬 로봇은 보통 섞기 + 진하기 바닥값 · 작은 지도 시뮬 점은 SIM 토큰(어둠 #4c9bff · 밝음 #2F6FE0)으로 채움 · 테두리
import { describe, expect, it } from 'vitest';
import { SITE_SIM, simLook } from '../proto/tileview';
import tileSrc from '../proto/tileview.ts?raw';
import css from '../proto/u5.css?raw';

describe('시뮬 파랑이 관제 타일 · 작은 지도에서도 보임', () => {
  it('현장 위 시뮬 로봇 = 보통 섞기 · 진하기 바닥 0.6 이상(점 바닥은 로봇 탭과 같은 값) · 색은 토큰 그대로', () => {
    expect(SITE_SIM.a[0]).toBeGreaterThanOrEqual(0.6); expect(SITE_SIM.k[0]).toBeGreaterThan(0.18);
    expect(tileSrc).toContain('this.cyber.uniforms.site.value = ly.world ? 1 : 0; this.cyber.blending = ly.world ? THREE.NormalBlending : simLook(light).blend;');
    expect(simLook(false).col).toBe(0x4c9bff); expect(simLook(true).col).toBe(0x2f6fe0);
  });
  it('작은 지도 시뮬 점: 회색 점선이 아니라 SIM 파랑 점선 + 옅은 채움 · 14 px · 어둠 · 밝음 모두', () => {
    const dark = css.match(/\.u5 \.dotm\.sim\{[^}]*\}/)![0], light = css.match(/\.proto\.light \.u5 \.dotm\.sim\{[^}]*\}/)![0];
    expect(dark).not.toContain('#5e6662'); expect(dark).toContain('dashed #4c9bff'); expect(dark).toContain('rgba(76,155,255,.35)'); expect(dark).toContain('width:14px');
    expect(light).toContain('#2F6FE0'); expect(light).toContain('rgba(47,111,224,.28)');
  });
});

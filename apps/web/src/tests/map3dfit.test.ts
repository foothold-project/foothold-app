// 팀장 02:55 지도 탭 「3D 보기 · 미리 보기」 가 칸 위쪽 반에만 그려지던 것: 미리 보기 칸(data-u7-preview)이 flex 가 아니라
// Map3D(.vx flex:1 · .vx-3d flex:1) 가 높이를 받지 못하고, canvas 가 제 비율(2:1)로 너비의 반 높이(902 × 451)만 차지했다.
import { describe, expect, it } from 'vitest';
import pickSrc from '../screens/u7/pick.tsx?raw';
import vxCss from '../screens/voxel3d.css?raw';

describe('지도 탭 3D 미리 보기 칸을 가득 채움', () => {
  it('미리 보기 칸 = 세로 flex · Map3D 는 flex:1 로 칸 높이를 받음', () => {
    expect(pickSrc).toContain("<div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' }} data-u7-preview>");
    expect(vxCss).toMatch(/\.vx\{flex:1;min-height:0/); expect(vxCss).toMatch(/\.vx-3d\{flex:1;min-height:0/);
    expect(vxCss).toMatch(/\.vx-3d>canvas\{display:block;width:100%;height:100%/);
  });
});

// RB-UNITREE-LOOK-FIX 3: 저장 지도 3D 를 못 그리면 쉬운 말 안내(«WebGL» 같은 개발자 말 없음). jsdom 엔 WebGL 이 없어 실제 three 가 그대로 실패한다.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import '../serverdrive';   // 앱처럼 조종 화면 쪽을 먼저 — voxelmap ↔ slamview 순환 import 에서 voxel3d 를 맨 먼저 부르면 hueAt 이 아직 없다(앱은 voxel3d 를 동적 import)
import Voxel3D, { type Props } from '../screens/voxel3d';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('3D 를 못 그리면 «지도 보기»로 안내 — WebGL 말 없음', () => {
  const box = document.createElement('div'), root = createRoot(box);
  const v = { width: 10, height: 10, resolution: 0.1, origin: [0, 0, 0] } as unknown as Props['v'];
  act(() => root.render(<Voxel3D v={v} pages={[]} n={0} />));
  const p = box.querySelector('[data-voxel-3d-failed]')!;
  expect(p.textContent).toBe('이 브라우저에서는 3D 화면을 볼 수 없습니다. «지도 보기»로 보세요.');
  expect(p.textContent).not.toMatch(/WebGL/i);
  act(() => root.unmount());
});

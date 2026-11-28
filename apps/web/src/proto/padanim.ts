// 멈춘 로봇 바닥 표시(충전 고리 · 점검 네모)와 그 위로 층층이 오르는 같은 꼴(팀장 11-29 01:37).
// 바닥(100 %)은 그대로 두고, 같은 꼴이 원 중심 기준으로 조금씩 작아지며(98 · 96 · 94 %) 한 박에 한 층씩 오르고 흐려져 사라진 뒤 다시 바닥부터.
// 박은 끊어서(「당당당당」 · 부드러운 이음 없음). 관제 타일(tileview)과 로봇 탭 큰 무대(go2view)가 이 두 함수를 같이 쓴다.
import * as THREE from 'three';

/** 시안 u5_1 pad() 그대로: 충전 = #00c389 고리 r 0.34(진하기 0.85) · 0.40(0.3), 앞뒤 1.25 배 · 점검 = #a9b8c6 네모 W 0.38 · D 0.5(0.75), 바깥 +0.06(0.22) */
export const PAD = { charge: { col: 0x00c389, rings: [[0.34, 0.85], [0.40, 0.3]] as [number, number][], sz: 1.25 }, check: { col: 0xa9b8c6, W: 0.38, D: 0.5, out: 0.06, op: [0.75, 0.22] } };

/** 오르는 층 값 한 곳: 크기(바닥 = 1) · 층 간격(m) · 한 박(s) · 층 진하기(바닥 진하기에 곱함) · 채도 낮춤(회색 쪽으로 섞는 몫) */
export const PAD_RISE = { scale: [1, 0.98, 0.96, 0.94], dy: 0.05, beat: 0.42, op: [1, 0.5, 0.3, 0.14], grey: 0x8d9590, desat: 0.35 } as const;
/** 한 바퀴 박 수 = 바닥 한 박 + 오르는 층마다 한 박 */
export const PAD_BEATS = PAD_RISE.scale.length;

/** t 초에 보이는 오른 층 수(0 = 바닥만 · 1 ~ 3). 박 안에서는 바뀌지 않고 박 경계에서 한 번에 바뀐다 */
export const padStep = (t: number) => Math.floor(Math.max(0, t) / PAD_RISE.beat) % PAD_BEATS;

export const calmMotion = () => typeof matchMedia === 'function' && !!matchMedia('(prefers-reduced-motion: reduce)')?.matches;

/** 바닥 꼴(LineLoop 둘) + 오르는 층 무리(name 'rise' · 층마다 같은 꼴을 작게 · 낮은 채도) */
export function padGroup(kind: 'charge' | 'check') {
  const col = kind === 'charge' ? PAD.charge.col : PAD.check.col, g = new THREE.Group(); g.name = `pad-${kind}`;
  const shapes: [THREE.Vector3[], number][] = [];
  if (kind === 'charge') for (const [r, op] of PAD.charge.rings) shapes.push([Array.from({ length: 96 }, (_, i) => new THREE.Vector3(Math.cos((i / 96) * 6.2832) * r, 0.002, Math.sin((i / 96) * 6.2832) * r * PAD.charge.sz)), op]);
  else {
    const { W, D, out, op } = PAD.check, sq = (w: number, d: number) => [[-w, -d], [w, -d], [w, d], [-w, d]].map(([x, z]) => new THREE.Vector3(x, 0.002, z));
    shapes.push([sq(W, D), op[0]], [sq(W + out, D + out), op[1]]);
  }
  const loop = (pts: THREE.Vector3[], c: THREE.Color | number, op: number) => new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: c, transparent: true, opacity: op, depthWrite: false }));
  for (const [pts, op] of shapes) g.add(loop(pts, col, op));
  const rise = new THREE.Group(); rise.name = 'rise'; g.add(rise);
  const soft = new THREE.Color(col).lerp(new THREE.Color(PAD_RISE.grey), PAD_RISE.desat);
  for (let k = 1; k < PAD_BEATS; k++) {
    const layer = new THREE.Group(); layer.name = `rise-${k}`;
    layer.scale.set(PAD_RISE.scale[k], 1, PAD_RISE.scale[k]); layer.position.y = PAD_RISE.dy * k; layer.visible = false;
    for (const [pts, op] of shapes) layer.add(loop(pts, soft, op * PAD_RISE.op[k]));
    rise.add(layer);
  }
  return g;
}

/** 시각 t(초 · 그리는 쪽 시계)에 맞춰 오른 층을 켜고 끔. 움직임 줄이기면 바닥만 */
export function padTick(g: THREE.Object3D, t: number, calm = calmMotion()) {
  const rise = g.getObjectByName('rise'); if (!rise) return;
  const n = calm ? 0 : padStep(t);
  rise.children.forEach((l, i) => { l.visible = i < n; });
}

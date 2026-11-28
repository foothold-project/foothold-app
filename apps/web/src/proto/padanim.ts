// 멈춘 로봇 바닥 표시(충전 고리 · 점검 네모)와 그 위로 층층이 오르는 같은 꼴(팀장 11-29 01:37).
// 바닥(100 %)은 그대로 두고, 같은 꼴이 원 중심 기준으로 조금씩 작아지며(98 · 96 · 94 · 92 · 90 %) 한 박에 한 층씩 오르고 흐려져 사라진 뒤 다시 바닥부터(팀장 02:14 「5 층까지」).
// 박은 끊어서(「당당당당」 · 부드러운 이음 없음). 관제 타일(tileview)과 로봇 탭 큰 무대(go2view)가 이 두 함수를 같이 쓴다.
import * as THREE from 'three';

/** 시안 u5_1 pad() 그대로: 충전 = #00c389 고리 r 0.34(진하기 0.85) · 0.40(0.3), 앞뒤 1.25 배 · 점검 = #a9b8c6 네모 W 0.38 · D 0.5(0.75), 바깥 +0.06(0.22) */
/** 밝은 판 색(밝음 1 · 로봇 탭 padMesh 와 같은 값): 충전 #18A07E · 점검 #5E6662 */
export const PAD_LIGHT = { charge: 0x18a07e, check: 0x5e6662 } as const;
export const PAD = { charge: { col: 0x00c389, rings: [[0.34, 0.85], [0.40, 0.3]] as [number, number][], sz: 1.25 }, check: { col: 0xa9b8c6, W: 0.38, D: 0.5, out: 0.06, op: [0.75, 0.22] } };

/** 오르는 층 n 개: 꼭대기 높이 top.dy · 꼭대기 크기 top.scale(0.90) 사이를 고르게 나눈다.
 *  진하기는 첫 층 top.op[0] 에서 꼭대기 top.op[1] 까지 같은 비로 흐려진다. 안 A · B 는 꼭대기 0.25 m · 0.065(옛 값) */
export const PAD_TOP = { dy: 0.25, scale: 0.9, op: [0.5, 0.065] } as const;
/** 확정 안 C(팀장 03:14 «촘촘한 줄(B) · 위로 갈수록 연해져 덜 보임 → 층을 더 올려 로봇 몸까지 덮게»):
 *  꼭대기 0.40 m(Go2 서 있는 몸 위) · 11 층(층 간격 0.036 m = B 와 같은 촘촘함) · 꼭대기 진하기 0.18(전 0.065 · 위에서도 보이게) */
export const PAD_TOP_C = { dy: 0.4, scale: 0.9, op: [0.5, 0.18] } as const;
type PadTop = { dy: number; scale: number; op: readonly [number, number] };
export function padRise(n: number, top: PadTop = PAD_TOP) {
  const k = Array.from({ length: n + 1 }, (_, i) => i), f = (i: number) => (n > 1 ? (i - 1) / (n - 1) : 0);
  return { scale: k.map((i) => 1 - (1 - top.scale) * (i / n)), dy: top.dy / n, op: k.map((i) => (i === 0 ? 1 : top.op[0] * (top.op[1] / top.op[0]) ** f(i))) };
}
/** 안 A = 5 층 · 안 B = 7 층(꼭대기 0.25 m) · 안 C = 11 층(꼭대기 0.40 m · 확정). 이 한 줄로 고른다 */
export const PAD_PLANS = { A: 5, B: 7, C: 11 } as const;
export const PAD_TOPS: Record<keyof typeof PAD_PLANS, PadTop> = { A: PAD_TOP, B: PAD_TOP, C: PAD_TOP_C };
export const PAD_PLAN: keyof typeof PAD_PLANS = 'C';
/** 주소 ?pad=A|B|C(또는 #… ?pad=B)로 PAD_PLAN 을 덮어씀(안 견주기). 다른 값 · 없음 = PAD_PLAN */
export const padPlan = (): keyof typeof PAD_PLANS => {
  try { const v = new URLSearchParams(location.search || location.hash.split('?')[1] || '').get('pad'); return v === 'A' || v === 'B' || v === 'C' ? v : PAD_PLAN; } catch { return PAD_PLAN; }
};

/** 오르는 층 값 한 곳: 크기(바닥 = 1) · 층 간격(m) · 한 박(s) · 층 진하기(바닥 진하기에 곱함) · 채도 낮춤(회색 쪽으로 섞는 몫) */
/** 오르는 층 값 한 곳. 박: 안 A · B 0.42 s · 안 C 0.24 s(층이 11 개라 한 바퀴 2.9 s · 전 5 층 2.5 s 와 비슷하게).
 *  층 색: 안 C 는 회색(#8d9590 · 팀장 «회색 · 라이팅 뺀 꼴»: 바닥 색을 빼고 회색 줄만) · A · B 는 바닥 색을 35 % 회색 쪽으로 */
const PLAN_NOW = padPlan();
export const PAD_RISE = { ...padRise(PAD_PLANS[PLAN_NOW], PAD_TOPS[PLAN_NOW]), beat: PLAN_NOW === 'C' ? 0.24 : 0.42, grey: 0x8d9590, desat: PLAN_NOW === 'C' ? 1 : 0.35 } as const;
/** 한 바퀴 박 수 = 바닥 한 박 + 오르는 층마다 한 박 */
export const PAD_BEATS = PAD_RISE.scale.length;

/** t 초에 보이는 오른 층 수(0 = 바닥만 · 1 ~ beats - 1). 박 안에서는 바뀌지 않고 박 경계에서 한 번에 바뀐다 */
export const padStep = (t: number, beats: number = PAD_BEATS) => Math.floor(Math.max(0, t) / PAD_RISE.beat) % beats;

export const calmMotion = () => typeof matchMedia === 'function' && !!matchMedia('(prefers-reduced-motion: reduce)')?.matches;

/** 바닥 꼴(LineLoop 둘) + 오르는 층 무리(name 'rise' · 층마다 같은 꼴을 작게 · 낮은 채도) */
export function padGroup(kind: 'charge' | 'check', light = false, rise = PAD_RISE) {
  const col = light ? PAD_LIGHT[kind] : kind === 'charge' ? PAD.charge.col : PAD.check.col, g = new THREE.Group(); g.name = `pad-${kind}`;
  const shapes: [THREE.Vector3[], number][] = [];
  if (kind === 'charge') for (const [r, op] of PAD.charge.rings) shapes.push([Array.from({ length: 96 }, (_, i) => new THREE.Vector3(Math.cos((i / 96) * 6.2832) * r, 0.002, Math.sin((i / 96) * 6.2832) * r * PAD.charge.sz)), op]);
  else {
    const { W, D, out, op } = PAD.check, sq = (w: number, d: number) => [[-w, -d], [w, -d], [w, d], [-w, d]].map(([x, z]) => new THREE.Vector3(x, 0.002, z));
    shapes.push([sq(W, D), op[0]], [sq(W + out, D + out), op[1]]);
  }
  const loop = (pts: THREE.Vector3[], c: THREE.Color | number, op: number) => new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: c, transparent: true, opacity: op, depthWrite: false }));
  for (const [pts, op] of shapes) g.add(loop(pts, col, op));
  const up = new THREE.Group(); up.name = 'rise'; g.add(up);
  const soft = new THREE.Color(col).lerp(new THREE.Color(PAD_RISE.grey), PAD_RISE.desat);
  for (let k = 1; k < rise.scale.length; k++) {
    const layer = new THREE.Group(); layer.name = `rise-${k}`;
    layer.scale.set(rise.scale[k], 1, rise.scale[k]); layer.position.y = rise.dy * k; layer.visible = false;
    for (const [pts, op] of shapes) layer.add(loop(pts, soft, op * rise.op[k]));
    up.add(layer);
  }
  return g;
}

/** 시각 t(초 · 그리는 쪽 시계)에 맞춰 오른 층을 켜고 끔. 움직임 줄이기면 바닥만 */
export function padTick(g: THREE.Object3D, t: number, calm = calmMotion()) {
  const rise = g.getObjectByName('rise'); if (!rise) return;
  const n = calm ? 0 : padStep(t, rise.children.length + 1);
  rise.children.forEach((l, i) => { l.visible = i < n; });
}

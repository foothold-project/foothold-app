import { describe, expect, it } from 'vitest';
import { fleetKind, fleetOrder, type FleetKind, type Urgent } from '../fleetorder';

type R = { id: string; u: Urgent; k: FleetKind };
const ids = (l: R[]) => fleetOrder(l, (r) => r.u, (r) => r.k).map((r) => r.id);

describe('fleetOrder (팀장 11-28 17:34): 긴급 → 실기 → 데모 → 사용자 시뮬', () => {
  it('긴급이 없으면 실기(Go2 X) 맨 위 · 데모 · 시뮬, 같은 종류는 받은 순서', () => {
    expect(ids([
      { id: 'd1', u: null, k: 'demo' }, { id: 's1', u: null, k: 'sim' }, { id: 'x', u: null, k: 'real' }, { id: 'd2', u: null, k: 'demo' },
    ])).toEqual(['x', 'd1', 'd2', 's1']);
  });
  it('긴급은 종류보다 위(위험 → 경고 → 주의 → 끊김), 같은 단계 안은 실기 → 데모 → 시뮬', () => {
    expect(ids([
      { id: 'x', u: null, k: 'real' }, { id: 'dw', u: 'warn', k: 'demo' }, { id: 'xl', u: 'lost', k: 'real' },
      { id: 'sb', u: 'bad', k: 'sim' }, { id: 'xw', u: 'warn', k: 'real' }, { id: 'dc', u: 'crit', k: 'demo' },
    ])).toEqual(['dc', 'sb', 'xw', 'dw', 'xl', 'x']);
  });
  it('fleetKind: 데모가 시뮬로 돌아도 데모 · 시뮬만이면 시뮬 · 둘 다 아니면 실기', () => {
    expect([fleetKind(true, true), fleetKind(true, false), fleetKind(false, false), fleetKind(undefined, undefined)]).toEqual(['demo', 'sim', 'real', 'real']);
  });
});

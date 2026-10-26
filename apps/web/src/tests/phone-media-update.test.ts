import { afterEach, expect, it, vi } from 'vitest';
import type { PhoneMediaWelcome, SimRobot } from '../../../contracts/ts';
import { media } from '../media';
import { sim } from '../phone';
import { FakeWS } from './fakeWs';

const R = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const offer = (epoch = 1): PhoneMediaWelcome => ({ version: 'media/1', path: '/phone/media/ws', robot: R,
  epoch, episode_id: B, rgb: { available: true, reason: 'Ready', token: 'r'.repeat(43) },
  external: { available: true, reason: 'Ready', token: 'e'.repeat(43) },
  lidar: { available: true, reason: 'Ready', token: 'l'.repeat(43) } });

async function connect() {
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ token: 'test-pass', exp: 2000000000, kid: 'k' }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }));
  await sim.attach({ robot_id: R, agent_address: 'ws://127.0.0.1:9433/phone/ws', state: 'RUNNING',
    simulation: true, generation: 1, owner_id: 'u', world_id: 'warehouse', expires_at: null, remaining_s: null } as SimRobot);
  const parent = FakeWS.last;
  parent.auto = null; parent.open();
  parent.recv({ t: 'hello', id: '1', robot: R, proto: 'fh-phone/1', simulation: true, camera_token: 'c'.repeat(43) });
  return parent;
}

afterEach(() => { sim.clear(); vi.unstubAllGlobals(); });

it('hello 없이 media 가 늦게 준비돼도 같은 부모에서 영상 연결·세대 갱신·해지, 전후 STOP 즉시', async () => {
  const parent = await connect();
  expect(media.binding()).toBeNull();
  sim.stop();
  expect(parent.of('stop')).toHaveLength(1);
  const legacy = FakeWS.last;
  expect(legacy.url).toContain('/phone/camera/ws');
  media.want('external', 1); media.want('lidar', 1);
  parent.recv({ t: 'media.update', robot: R, media: offer() });
  expect(sim.get().link?.at).toBe('open');
  expect(media.binding()).toMatchObject({ robot: R, epoch: 1 });
  expect(legacy.readyState).toBe(3);
  const channels = FakeWS.all.filter(w => w.url.endsWith('/phone/media/ws'));
  expect(channels).toHaveLength(2);
  for (const w of channels) { w.auto = null; w.open(); }
  expect(channels.map(w => w.sent[0].channel).sort()).toEqual(['external', 'lidar']);
  parent.recv({ t: 'media.update', robot: R, media: offer(2) });
  expect(media.binding()?.epoch).toBe(2);
  expect(channels.every(w => w.readyState === 3)).toBe(true);
  parent.recv({ t: 'media.update', robot: R, media: null });
  expect(media.binding()).toBeNull();
  sim.stop();
  expect(parent.of('stop')).toHaveLength(2);
  expect(FakeWS.all.filter(w => w.url.endsWith('/phone/ws'))).toHaveLength(1);
  media.want('external', -1); media.want('lidar', -1);
});

it('다른 로봇의 media 갱신은 받지 않고 부모 종료 뒤 옛 갱신은 되살리지 않음', async () => {
  const parent = await connect();
  parent.recv({ t: 'media.update', robot: B, media: { ...offer(), robot: B } });
  parent.recv({ t: 'media.update', robot: R, media: { ...offer(), robot: B } });
  expect(media.binding()).toBeNull();
  parent.recv({ t: 'media.update', robot: R, media: offer() });
  expect(media.binding()).not.toBeNull();
  sim.close();
  parent.recv({ t: 'media.update', robot: R, media: offer(2) });
  expect(media.binding()).toBeNull();
});

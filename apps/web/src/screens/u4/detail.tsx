// 로봇 탭 점검 창(시안 u4_4)의 「상세」: 옛 관제 상세 서랍(screens.tsx Detail)에만 있던 값을 시안 점검 줄(.r) 모양으로.
// 서버 · 로봇 · 잠금 연결 줄 · 장치와 장치 상태 코드 · 장치 문제 · 주의 · 자세(robot_info) · 폰 경유 · 위치 · 최근 사건.
// 담당 · 기체번호 · 담당 지정 · 관리는 「로봇 설정」 창(u4_5), 배터리는 위 칩 줄, 조종 화면 단추는 조종 탭 「조종 시작」.
// 고를 때 GET /robots/{id}(서랍과 같음) · 구독 로봇의 장치 · 위치는 실시간 state 가 덮는다. 남의 로봇(요약)은 「확인 안 됨」, 값이 없으면 없다고 쓴다.
import { useEffect, useState, type ReactNode } from 'react';
import type { RobotSummary } from '../../../../contracts/ts';
import { api, type ApiFail } from '../../api';
import { toRobot, type Robot } from '../../fake';
import { rt, useRt, withLive } from '../../rt';
import { stopLine } from '../../serverdrive';
import { PhoneRelay, useRelayExpiry } from '../../phoneRelay';
import { pickInfo, sdeg } from '../../go2status';
import { RecentEvents } from '../history';
import { Chip, DEVICE, KIND, LINK, SHOWN, attn, codeText, type Ctx } from '../../screens';

const hms = (at: string) => new Date(at).toTimeString().slice(0, 8);
const row = (k: string, name: ReactNode, small: ReactNode, attrs: Record<string, unknown> = {}) =>
  <div className="r" key={k} data-line={k} {...attrs}>{name}<small>{small}</small></div>;

export function Detail({ c, r: r0 }: { c: Ctx; r: Robot }) {
  useRt();
  const [got, setGot] = useState<RobotSummary | null>(null), [err, setErr] = useState('');
  useEffect(() => {
    api.robot(r0.id, c.cancel).then(setGot, (e: ApiFail) => {
      if (e.code === 'CANCELED') return;
      if (e.status !== 404) return setErr(`상세를 받지 못했습니다. ${e.message}`);
      setErr('이 로봇을 찾을 수 없습니다. 지워졌을 수 있어 목록을 다시 받습니다.');
      c.refresh();
    });
  }, []);
  const r = got ? withLive(toRobot(got)) : r0, hidden = r.unknown === 'summary';
  useRelayExpiry(r.phoneRelay, r.phoneRelayAt);
  const l = rt.get(r.id), s = r.unknown ? null : l.state, loc = s ? s.location : r.location ?? null, devices = s ? s.devices : r.devices ?? [];
  const server = LINK[rt.link().at] ?? { tone: 'off' as const, text: '연결 중' };
  const robot = hidden ? { tone: 'off' as const, text: '확인 안 됨' } : !s ? { tone: 'off' as const, text: '모름' } : s.connection === 'ONLINE' ? { tone: 'ok' as const, text: '연결' }
    : r.status ? { tone: 'bad' as const, text: '끊김' } : { tone: 'off' as const, text: '연결 전' };
  const lock = stopLine(l) ?? (hidden ? { tone: 'off' as const, text: '확인 안 됨' } : s?.latched == null ? { tone: 'off' as const, text: '모름' }
    : s.latched ? { tone: 'bad' as const, text: '잠김' } : { tone: 'ok' as const, text: '풀림' });
  const broken = hidden ? [] : devices.filter((v) => v.state !== 'OK'), note = hidden ? '' : attn(r0, SHOWN);
  // 시뮬도 서버가 robot_info(자세 · fallen)를 보내면 그대로 보인다. 넘어짐은 서버 fallen 값만(화면에서 각도로 판단하지 않음)
  const info = pickInfo(r.sim && r.robotInfo ? { ...r, sim: false } : r), v = info?.v ?? null;
  const pose = !info ? null : !v ? info.why ?? '모름'
    : [`roll ${sdeg(v.roll) ?? '모름'} · pitch ${sdeg(v.pitch) ?? '모름'}`, v.code == null ? '상태 번호 모름' : v.code === 0 ? '상태 번호 0(정상 범위)' : `상태 번호 ${v.code}`, info.via].filter(Boolean).join(' · ');
  const fallen = v?.fallen ? <Chip tone="warn" text="넘어짐 의심" /> : null;
  const m = (x: number | null) => (x == null ? '모름' : `${x.toFixed(1)} m`);
  return <section aria-label="로봇 상세" data-u4-detail>
    <div className="r" data-line="연결" data-detail-links><span className="dl">서버</span><Chip {...server} /><span className="dl">로봇</span><Chip {...robot} /><span className="dl">잠금</span><Chip {...lock} /></div>
    {broken.length > 0 && <p className="fh-msg" role="status" data-detail-alert>장치 문제: {broken.map((x) => `${x.label} ${(DEVICE[x.state] ?? DEVICE.ERROR).text}`).join(', ')}</p>}
    {note && row('주의', '주의', note)}
    {pose != null && row('자세', <>자세{fallen}</>, pose, { 'data-robot-info': v ? (info?.via ? 'phone' : 'direct') : 'none' })}
    {row('위치', '위치', hidden ? '확인 안 됨' : loc ? `x ${m(loc.x)} · y ${m(loc.y)} (${hms(loc.updated_at)})` : '위치 없음')}
    {!hidden && r.phoneRelay && <div className="r" data-line="폰 경유">폰 경유<small><PhoneRelay key={r.id} report={r.phoneRelay} receivedAt={r.phoneRelayAt} compact /></small></div>}
    {hidden ? row('장치', '장치', '확인 안 됨') : !devices.length ? row('장치', '장치', '장치 정보 없음')
      : <div aria-label="장치" data-line="장치">{devices.map((x) => <div className="r" key={x.key} data-device={x.key}>{x.label}
        <small>{KIND[x.kind] ?? KIND.OTHER} · <Chip {...(DEVICE[x.state] ?? DEVICE.ERROR)} />{codeText(x)}</small></div>)}</div>}
    {(c.user.role === 'ORG_ADMIN' || r0.owner === c.user.id) && <div className="u4-events"><RecentEvents robot={r.id} cancel={c.cancel} /></div>}
    {err && <p className="fh-msg" role="alert">{err}</p>}
  </section>;
}

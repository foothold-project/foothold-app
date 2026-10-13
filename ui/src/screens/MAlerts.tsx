// 휴대폰 알림(원본 묶음·항목 틀): 지금 할 일 + 서버 경보 사건 — web/live.js pageMAlerts 와 같은 규칙. 예시 항목은 쓰지 않는다.
import { useState } from 'react';
import { CSS, View } from './MAlerts.view';
import { LV, fmtT, store, themeClass, tms } from '../data/fmt';
import { activeRun, alertsOf, noteOf, useDocs, useMedia } from '../data/shared';
import { href } from '../data/hist';
import { LiveStatus } from '../app/status';
import { stopProps } from '../app/shell';

const READ = 'fh.live.alerts.read';
const ago = (at: string) => { const m = Math.round((Date.now() - tms(at)) / 60000); return m < 1 ? '방금' : m < 60 ? `${m}분 전` : fmtT(at).slice(0, 11); };
type It = { ic: string; lv: string; title: string; sub: string; time: string; href: string; unread: boolean };
const Item = (x: It) => (
  <a className={`n${x.unread ? ' unread' : ''}`} href={x.href}>
    <span className={`ic ${x.lv}`}>{x.ic}</span>
    <span style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}><b style={{ fontSize: '14px' }}>{x.title}</b><span className="lbl">{x.sub}</span></span>
    <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '4px' }}><span className="mono lbl">{x.time}</span><span className="dot" style={x.unread ? undefined : { visibility: 'hidden' }} /></span>
  </a>);

export default function MAlerts() {
  const D = useDocs(), M = useMedia(), [rd, setRd] = useState(() => store.get<string>(READ, ''));
  const al = alertsOf(M), run = activeRun(D), wait = M.photos.filter((p) => !noteOf(D, p.url)).length;
  const out: JSX.Element[] = [], g = (t: string) => out.push(<div className="grp" key={`g${out.length}`}>{t}</div>);
  const it = (x: It) => out.push(<Item key={out.length} {...x} />);
  if (run || wait) {
    g('지금 할 일');
    if (wait) it({ ic: '✓', lv: 'acc', title: `관찰 사진 분류 대기 ${wait}장`, sub: '확인·보류·제외 + 메모(운영자)', time: '', href: href('MFinding'), unread: true });
    if (run) { const n = run.doc.wps.filter((w) => w.st !== '대기').length; it({ ic: '●', lv: 'acc', title: `수동 임무 진행 중 · «${run.doc.name}»`, sub: `지점 기록 ${n}/${run.doc.wps.length} · 직접 조종`, time: ago(run.doc.started), href: href('MHome'), unread: false }); }
  }
  if (!M.ok) g(M.err || '서버 기록 읽는 중…');
  else if (!al.length) g('경보 사건 없음(서버 최근 300건 중)');
  else {
    const now = Date.now(); let grp: string | null = null;
    for (const e of al.slice(0, 150)) {
      const gn = now - tms(e.at) < 3600e3 ? '경보 · 최근 1시간' : '경보 · 이전'; if (gn !== grp) { grp = gn; g(gn); }
      it({ ic: LV[e.st], lv: e.st, title: e.text, sub: '서버 사건 원문 · 원인 판단 없음', time: ago(e.at), href: href('MAlert', { at: e.at, t: e.text }), unread: !rd || tms(e.at) > tms(rd) });
    }
  }
  const v = {
    themeClass: themeClass(false), stopProps, status: <LiveStatus D={D} style={{ padding: '4px 14px' }} />,
    readAll: () => { const a = al[0], t = a ? a.at : ''; store.set(READ, t); setRd(t); },
    list: out, foot: '읽음 표시는 이 기기에만 저장 · 잠금 화면·푸시 알림 미연결(화면이 켜져 있어야 함)',
  };
  return <><style>{CSS}</style><div id="dc-root"><View v={v} /></div></>;
}

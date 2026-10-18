// 휴대폰 알림(원본 묶음·항목 틀): 지금 할 일 + 서버 경보 사건 — web/live.js pageMAlerts 와 같은 규칙. 예시 항목은 쓰지 않는다.
import { useReducer } from 'react';
import { CSS, View } from './MAlerts.view';
import { LV, fmtT, themeClass, tms } from '../data/fmt';
import { READ_NOTE, isUnread, markRead } from '../data/alerts';
import { evShow } from '../data/facts';
import { activeRun, alertsOf, docsSt, noteOf, useDocs, useMedia } from '../data/shared';
import { href } from '../data/hist';
import { LiveStatus, MediaStale } from '../app/status';

const ago = (at: string) => { const m = Math.round((Date.now() - tms(at)) / 60000); return m < 1 ? '방금' : m < 60 ? `${m}분 전` : fmtT(at).slice(0, 11); };
type It = { ic: string; lv: string; title: string; sub: string; time: string; href: string; unread: boolean };
const Item = (x: It) => (
  <a className={`n${x.unread ? ' unread' : ''}`} href={x.href}>
    <span className={`ic ${x.lv}`}>{x.ic}</span>
    <span style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}><b style={{ fontSize: '14px' }}>{x.title}</b><span className="lbl">{x.sub}</span></span>
    <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '4px' }}><span className="mono lbl">{x.time}</span><span className="dot" style={x.unread ? undefined : { visibility: 'hidden' }} /></span>
  </a>);

export default function MAlerts() {
  const D = useDocs(), M = useMedia(), [, bump] = useReducer((x: number) => x + 1, 0);
  const al = alertsOf(M), shown = M.ok ? al.slice(0, 150) : [], run = activeRun(D), wait = docsSt(D) ? 0 : M.photos.filter((p) => !noteOf(D, p.url)).length;   // 문서가 정상일 때만 «분류 대기»(못 읽음·오류·보관이면 대기로 단정 0 — 문서 오류는 상태 줄)
  const out: JSX.Element[] = [], g = (t: string) => out.push(<div className="grp" key={`g${out.length}`}>{t}</div>);
  const it = (x: It) => out.push(<Item key={out.length} {...x} />);
  if (run || wait) {
    g('지금 할 일');
    if (wait) it({ ic: '✓', lv: 'acc', title: `관찰 사진 분류 대기 ${wait}장`, sub: '확인·보류·제외 + 메모(운영자)', time: '', href: href('MFinding', { f: '미분류' }), unread: true });
    if (run) { const n = run.doc.wps.filter((w) => w.st !== '대기').length; it({ ic: '●', lv: 'acc', title: `수동 임무 진행 중 · «${run.doc.name}»`, sub: `지점 기록 ${n}/${run.doc.wps.length} · 직접 조종`, time: ago(run.doc.started), href: href('MHome'), unread: false }); }
  }
  if (!M.ok) g(M.err || '서버 기록 읽는 중…');
  else if (!al.length) g('경보 사건 없음(서버 최근 300건 중)');
  else {
    const now = Date.now(); let grp: string | null = null;
    for (const e of shown) {
      const gn = now - tms(e.at) < 3600e3 ? '경보 · 최근 1시간' : '경보 · 이전'; if (gn !== grp) { grp = gn; g(gn); }
      const sh = evShow(e.text);   // U3-a: 표시 문장만 — 주소·읽음 키는 원문
      it({ ic: LV[e.st], lv: e.st, title: sh, sub: sh === e.text ? '서버 사건 원문 · 원인 판단 없음' : '서버 사건 · 원문은 상세 · 원인 판단 없음', time: ago(e.at), href: href('MAlert', { at: e.at, t: e.text }), unread: isUnread(e) });
    }
  }
  const v = {
    themeClass: themeClass(false), status: <><LiveStatus D={D} style={{ padding: '4px 14px' }} /><MediaStale M={M} D={D} /></>,
    readAll: () => { markRead(shown, al); bump(); },   // R14: 지금 그려진 경보 키만(표시 밖·뒤에 온 경보 0)
    readAllT: `보이는 경보 ${shown.length}건 읽음 표시(이 기기)`,
    list: out, foot: `${READ_NOTE} · 이 기기에만 저장 · 잠금 화면·푸시 알림 미연결(화면이 켜져 있어야 함)`,
  };
  return <><style>{CSS}</style><div id="dc-root"><View v={v} /></div></>;
}

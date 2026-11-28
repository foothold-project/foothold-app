// PC 공통 머리줄: 시안 pc.css .bar 와 화면 머리 마크업(u5_1 등 모든 PC 화면이 같음)을 그대로 옮긴 것.
// 태그 · 클래스 · 순서 · 글은 시안 그대로, 고정 글 자리만 앱 값(메뉴 이동 · 연결 수 · 서버 상태 · 알림 · 사용자 · STOP)으로 바꾼다.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Role } from '../fake';
import './ui.pv.css';
import './pc.pv.css';
import './light.pv.css';
import './dark.pv.css';
import './frame.pv.css';

export type BarTab = { id: string; label: string };
/** 서버 실시간 연결 상태(rt.link().at) → 시안 «서버 정상» 자리 글 */
export const serverText = (at: string) => (at === 'open' ? '서버 정상' : at === 'connecting' || at === 'idle' ? '서버 연결 중' : at === 'denied' ? '서버 연결 거부' : '서버 연결 끊김');
/** 시안 «로봇 8 대 연결» (총괄) · «내 로봇 4 대 연결» (운영자) · 0 대면 «연결된 로봇 없음» (u11_6) */
export const linkText = (role: Role, n: number) => (!n ? '연결된 로봇 없음' : role === 'ORG_ADMIN' ? `로봇 ${n} 대 연결` : `내 로봇 ${n} 대 연결`);
/** 시안 나 칸: 총괄 = «나 총괄», 운영자 = 이름 끝 글자 + 이름 («A 운영자 A», u5_6) */
export const whoFace = (role: Role, name: string): [string, string] => (role === 'ORG_ADMIN' ? ['나', '총괄'] : [name.trim().slice(-1) || '나', name]);

export function PcBar({ light, tabs, cur, go, role, name, roleName, online, net, bell, stop, menu, approvals, driving = [] }: {
  light: boolean; tabs: BarTab[]; cur: string; go: (id: string) => void; role: Role; name: string; roleName: string; online: number; net: string;
  /** 알림 종 자리(시안 종 · 빨간 수) */ bell: ReactNode; /** 시안 «모두 정지» 자리 · 없으면 비움 */ stop: ReactNode; /** 나 칸을 누르면 여는 차림(로그아웃 · 화면 밝기) */ menu: ReactNode;
  /** 총괄: 결재 대기 수(GET /dashboard). 시안 머리줄에 자리가 없어 메뉴 끝에 작은 표(0 이면 숨김 · 받지 못하면 값을 비움) */ approvals?: { n: number | null; why?: string };
  /** 내 조종권(서버 lease)이 있는 로봇 이름들 · 시안 «K-01 조종 중» 칩(없으면 칩 없음) */ driving?: string[];
}) {
  const [i, label] = whoFace(role, name), [open, setOpen] = useState(false), who = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const out = (e: Event) => { if (!who.current?.parentElement?.contains(e.target as Node)) setOpen(false); };
    addEventListener('pointerdown', out); addEventListener('hashchange', () => setOpen(false), { once: true });
    return () => removeEventListener('pointerdown', out);
  }, [open]);
  const key = (f: () => void) => (e: { key: string; preventDefault: () => void }) => { if (e.key === 'Enter') { e.preventDefault(); f(); } };
  return <div className="bar"><span className="logo">FOOTHOLD</span><div className="tabs" role="navigation" aria-label="주 메뉴">
    {tabs.map((t) => <span key={t.id} className={t.id === cur ? 'on' : ''} role="link" tabIndex={0} data-href={`#/${t.id}`} aria-current={t.id === cur ? 'page' : undefined}
      onClick={() => go(t.id)} onKeyDown={key(() => go(t.id))}>{t.label}</span>)}
    {approvals && <b className="ap-appr" data-approvals={approvals.n ?? ''} hidden={!approvals.n} role="link" tabIndex={approvals.n ? 0 : -1} title={approvals.why ?? `결재 대기 ${approvals.n ?? ''}`}
      onClick={() => go('approval')} onKeyDown={key(() => go('approval'))}>결재 {approvals.n}</b>}
  </div>{' '}<div className="rt">
    <span className="row" style={{ gap: '7px' }} data-link-count={online}><i className="dot" style={online ? undefined : { background: '#5e6662', boxShadow: 'none' }}></i>{linkText(role, online)}</span>
    <span className="mu2" data-server={net} data-link={net === 'lost' || net === 'denied' ? net : undefined}>{serverText(net)}</span>{' '}{bell}{' '}<span className="ap-whobox">
      <span className="who" ref={who} role="button" tabIndex={0} aria-haspopup="menu" aria-expanded={open} aria-label={`${name}(${roleName})`} title={`${name}(${roleName})`}
        onClick={() => setOpen((o) => !o)} onKeyDown={key(() => setOpen((o) => !o))}><i>{i}</i>{label}</span>
      {open && <span className={`ap-menu fh${light ? ' light' : ''}`} role="menu" aria-label="내 차림" onClick={(e) => { if ((e.target as HTMLElement).closest('button:not([data-theme-pick])')) setOpen(false); }}>
        <b className="fh-me">{name}({roleName})</b>{menu}</span>}
    </span>{driving.length > 0 && <span className="livechip" role="status" data-driving={driving.join(' ')}><i></i>{driving.length > 1 ? `${driving[0]} 외 ${driving.length - 1} 대 조종 중` : `${driving[0]} 조종 중`}</span>}
    {stop}
  </div></div>;
}

/** 시안 알림 종(svg 20px · 빨간 수 17px) · 안 읽은 수가 0 이면 수 칸을 그리지 않는다 */
export function BellFace({ unread }: { unread: number }) {
  return <span style={{ position: 'relative', display: 'flex', padding: '7px 8px 0 0', marginTop: '-7px' }}><svg className="ic" viewBox="0 0 24 24" style={{ width: '20px', height: '20px' }}><path d="M10.268 21a2 2 0 0 0 3.464 0" /><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326" /></svg>
    {unread > 0 && <span className="badge" style={{ position: 'absolute', right: '0', top: '0', minWidth: '17px', height: '17px', borderRadius: '9px', background: '#ff4d4f', color: '#fff', fontSize: '10px', fontWeight: '800', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 4px' }}>{unread > 99 ? '99+' : unread}</span>}</span>;
}

/** 시안 «모두 정지» 단추 겉모양(속은 App 의 STOP 처리) */
/** name 이 있으면 시안 u5_2 처럼 «K-01 정지»(관제에서 고른 로봇 한 대), 없으면 «모두 정지» */
export const stopFace = (name?: string | null) => <><svg className="ic" viewBox="0 0 24 24" style={{ width: '16px', height: '16px' }}><path d="M8 3h8l5 5v8l-5 5H8l-5-5V8z" /><rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor" stroke="none" /></svg>{name ? `${name} 정지` : '모두 정지'}</>;

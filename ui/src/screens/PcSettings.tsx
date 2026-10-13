// PC 설정(원본 절 그대로) — web/live.js pagePcSettings 와 같은 글. 서버 고정값은 보여 주기만, 이 브라우저 설정(테마·막대 배치·지도 보기)만 실제로 저장.
// 나머지(알림·경보 기준·계정 편집·보존 기간)는 미연결 — 시안 예시값을 진실처럼 남기지 않는다.
import { useNote } from '../data/transport';
import { useState } from 'react';
import { CSS, View } from './PcSettings.view';
import { store, themeClass } from '../data/fmt';
import { LAYOUTS, STOP_FACT, UNSUP, WHY } from '../data/facts';
import { linkView, useLink } from '../data/link';
import { logoutNow } from '../data/auth';
import { useDocs } from '../data/shared';
import { LiveStatus } from '../app/status';
import { stopProps, toast, whyProps } from '../app/shell';

const GATED = location.protocol === 'https:';   // 보호 관문으로 연 화면(로그인 세션 있음)
const val = (t: string, off?: boolean, wrap?: boolean) => <span className="mono" style={{ color: off ? 'var(--muted)' : undefined, whiteSpace: wrap ? 'normal' : undefined }}>{t}</span>;
const offRe = /미연결|미제공|해당 없음/;
const SAFETY = [`${STOP_FACT[0].replace(' 끊김', '')} → 명령 0 · 화면 신호 1 s → STOP 잠금`, STOP_FACT[1], '미연결 — 영상 멎음 자동 잠금 없음(화면에 영상 나이 표시)', '0.3 s (서버 고정)',
  '해당 없음 — 자동 임무 미연결 · 사람이 «STOP 해제»', '앞 0.6 m/s · 회전 ±0.5 rad/s (시뮬에서 시험한 값만)', '미제공 — 배터리 값 없음'];
const RECS = ['서버 media 폴더 · 사진 최근 200 · 사건 최근 300 보관', '공유 문서(구역·양식·계획·진행·분류) 전부 · 서버 docs', 'CSV 내보내기(기록·사진 검토) · 보고서는 인쇄', '미제공'];
const TH = [['자동', null], ['어두운', 'dark'], ['밝은', 'light']] as const;

export default function PcSettings() {
  const note = useNote((s) => s.note);
  const D = useDocs(), L = useLink(), v = linkView(L), st = L.st;
  const [, redraw] = useState(0), theme = store.get<string | null>('fh.live.theme', null);
  const lay0 = store.get('fh.live.layout', LAYOUTS[0]), [lay, setLay] = useState(LAYOUTS.includes(lay0) ? lay0 : LAYOUTS[0]);
  const [mm, setMm] = useState(store.get<string>('fh.live.mapmode', 'robot') === 'all' ? 'all' : 'robot');
  const pickTheme = (t: string | null) => {
    if (t) { if (!store.set('fh.live.theme', t)) toast('테마 저장 실패(브라우저 저장소) — 이번 화면에만 적용'); }
    else { store.set('fh.live.theme', null); toast('자동: 다음에 열 때 시안 기본(PC 어두운 · 휴대폰 밝은)'); }
    redraw((n) => n + 1);
  };
  const sv: JSX.Element[] = [
    ...SAFETY.map((t) => val(t, offRe.test(t))),
    ...Array.from({ length: 5 }, () => val('미연결', true)),
    ...RECS.map((t) => val(t, t === '미제공')),
    <div role="radiogroup" aria-label="테마" style={{ display: 'flex', border: '1px solid var(--line2)', borderRadius: '6px', overflow: 'hidden' }}>
      {TH.map(([t, k]) => { const on = theme ? theme === k : !k; return (
        <button key={t} type="button" role="radio" aria-checked={on} onClick={() => pickTheme(k)}
          style={{ height: '36px', padding: '0 12px', border: '0', background: on ? 'var(--acc-bg)' : 'transparent', fontSize: '13px', fontWeight: on ? '600' : undefined }}>{t}</button>); })}
    </div>,
    <select className="inp" value={lay} onChange={(e) => { setLay(e.target.value); toast(store.set('fh.live.layout', e.target.value) ? '휴대폰 조종 막대 배치 저장(이 브라우저)' : '저장 실패(브라우저 저장 막힘)'); }}>
      {LAYOUTS.map((t) => <option key={t} value={t}>{t}</option>)}</select>,
    val('미연결 — 가로 조종 화면 미니맵 위치 고정', true),
    val(`${location.host === '127.0.0.1:8790' || location.hostname === 'localhost' ? '이 PC' : '보호 주소(https)'} · ${v.linkOk ? '● 링크 정상' : `▲ 링크 ${v.linkTxt}`}`),
    val(GATED ? '보호 관문 인증서 사용 중 · 만료일은 앱에서 확인 안 함' : '해당 없음(이 PC 전용 주소 · TLS 없음)', !GATED),
    val(`화면 ${L.firstVer || '미확인'} · 서버 ${st?.ver || '미확인'}`),
  ];
  const set = (b: string, lbl: string | null, ctl: JSX.Element) => (
    <div className="set" key={b}><span className="t"><b>{b}</b>{lbl && <span className="lbl">{lbl}</span>}</span>{ctl}</div>);
  const tr = (a: string, b: string, c: string, d: string, e: JSX.Element) => (
    <tr key={a}><td style={{ fontWeight: '600' }}>{a}</td><td>{b}</td><td className="lbl">{c}</td><td className="mono">{d}</td><td>{e}</td></tr>);
  const vals = {
    themeClass: themeClass(true), stopProps, status: <LiveStatus D={D} />,
    hdrA: '설정', hdrNote: '여기서 바꾸는 값은 이 브라우저에만 저장(테마·막대 배치·지도 보기) · 변경 기록 미연결',
    sv, lostLbl: '직접 조종 중 · 서버 고정 동작(자율 이동 미연결)',
    safetyLbl: '현재 v2 서버의 고정값입니다(앱에서 바꾸지 않음). 현장 값은 실기 연결 뒤 정합니다.',
    alertsH: '알림 · 미연결(화면에 경보 사건만 표시)',
    thLbl: `미제공 — ${WHY['가스·측정값·통신 품질']}. 기준값을 쓰지 않습니다.`,
    thBody: <tr><td className="lbl" colSpan={4}>가스 측정값이 없어 기준표 미사용</td></tr>,
    addP: { ...whyProps('계정 추가·편집 미연결 — 계정은 서버 관리자가 이 PC 에서 관리'), className: 'btn pri lv-why' },
    accRows: <>{tr(st?.me || '미확인', '이 기기', '조종(조종권을 받을 때) · 임무 기록 · 사진 분류', st?.holder ? `조종 중 기기: ${st.holder}` : '조종 중인 기기 없음',
      GATED ? <><button type="button" className="btn" title="조종권 해제 · 명령 0 · STOP 잠금(서버) 뒤 로그인 화면" onClick={() => logoutNow().then((e) => e && toast(e))}>로그아웃</button>{note && <span className="lbl"> {note}</span>}</> : <span className="lbl">로그인 없음(이 PC 전용)</span>)}
      {tr('다른 계정', '—', '계정 목록 보기 미연결(서버 관리자만)', '—', <></>)}</>,
    dispExtra: set('지도 기본 보기', '로봇 중심 = 지도가 움직임',
      <select className="inp" value={mm} onChange={(e) => { setMm(e.target.value); if (!store.set('fh.live.mapmode', e.target.value)) toast('저장 실패 — 이번 화면에만'); }}>
        <option value="robot">로봇 중심</option><option value="all">전체 보기</option></select>),
    limits: <section id="limits" className="card" aria-label="현재 v2 연결의 한계"><h2>현재 v2 연결에서 안 되는 것(미제공·미연결·미검증)</h2>
      <div>{UNSUP.map(([a, b]) => set(a, null, val(b, true, true)))}</div></section>,
  };
  return <><style>{CSS}</style><div id="dc-root"><View v={vals} /></div></>;
}

// PC 설정(원본 절 그대로) — web/live.js pagePcSettings 와 같은 글. 서버 고정값은 보여 주기만, 이 브라우저 설정(테마·막대 배치·지도 보기)만 실제로 저장.
// 나머지(알림·경보 기준·계정 편집·보존 기간)는 미연결 — 시안 예시값을 진실처럼 남기지 않는다.
import { useNote } from '../data/transport';
import { useState } from 'react';
import { CSS, View } from './PcSettings.view';
import { store, themeClass } from '../data/fmt';
import { LAYOUTS, STOP_TIP, TERMS, UNSUP, WHY } from '../data/facts';
import { linkView, useLink } from '../data/link';
import { logoutNow } from '../data/auth';
import { useDocs } from '../data/shared';
import { LiveStatus } from '../app/status';
import { stopProps, toast, whyProps } from '../app/shell';
import { DevSwitch, DirTag, Help, LostHelp } from '../app/chip';

const GATED = location.protocol === 'https:';   // 보호 관문으로 연 화면(로그인 세션 있음)
const val = (t: string, off?: boolean, wrap?: boolean) => <span className="mono" style={{ color: off ? 'var(--muted)' : undefined, whiteSpace: wrap ? 'normal' : undefined }}>{t}</span>;
const offRe = /미연결|미제공|해당 없음/;
// U5-b(v3 §2-4·§2-5): 안전 정책 운영 = 쉬운 말(PcPlan·조종 화면과 같은 글) + ? 전문(STOP_FACT·SAFE_NOTE·STOP_OBS·RELURCH·NOMOVE·WHY 배터리)
// 서버 고정 동작·값은 그대로 보여 주기만 — 새 예시값·정책 추정·실기 안전 보장 0
const batHelp = <Help label="배터리 · 설명">{WHY['배터리']}</Help>;
const SAFETY: (string | JSX.Element)[] = ['조종 입력 0.3초 끊김 → 입력 차단 · 화면 신호 1초 끊김 → 입력 차단·잠금',
  <>{val('입력 차단 (몸 정지는 별도) · 자동 후퇴 미연결')}<LostHelp /></>, '미연결 — 영상 멎음 자동 잠금 없음(화면에 영상 나이 표시)', '0.3 s (서버 고정)',
  '해당 없음 — 자동 임무 미연결 · 사람이 «조종 시작»(확인 1회)', <>{val('시뮬에서 시험한 값만 · ')}<DirTag /></>, <>{val('값 없음', true)}{batHelp}</>];
const RECS = ['서버 media 폴더 · 사진 최근 200 · 사건 최근 300 보관', '공유 문서(구역·양식·계획·진행·분류) 전부 · 서버 docs', 'CSV 내보내기(기록·사진 검토) · 보고서는 인쇄', '값 없음'];
const TH = [['자동', null], ['어두운', 'dark'], ['밝은', 'light']] as const;

export default function PcSettings() {
  const note = useNote((s) => s.note);
  const D = useDocs(), L = useLink(), v = linkView(L), st = L.st;
  const realVer = (x?: string | null) => !!x && !x.startsWith('미확인');
  const verCmp = v.linkOk && !L.bad && !!st && L.stGen === L.gen && realVer(L.firstVer) && realVer(st.ver);
  const [, redraw] = useState(0), theme = store.get<string | null>('fh.live.theme', null);
  const lay0 = store.get('fh.live.layout', LAYOUTS[0]), [lay, setLay] = useState(LAYOUTS.includes(lay0) ? lay0 : LAYOUTS[0]);
  const [mm, setMm] = useState(store.get<string>('fh.live.mapmode', 'robot') === 'all' ? 'all' : 'robot');
  const pickTheme = (t: string | null) => {
    if (t) { if (!store.set('fh.live.theme', t)) toast('테마 저장 실패(브라우저 저장소) — 이번 화면에만 적용'); }
    else { store.set('fh.live.theme', null); toast('자동: 다음에 열 때 시안 기본(PC 어두운 · 휴대폰 밝은)'); }
    redraw((n) => n + 1);
  };
  const sv: JSX.Element[] = [
    ...SAFETY.map((t) => (typeof t === 'string' ? val(t, offRe.test(t)) : t)),
    ...Array.from({ length: 5 }, () => val('미연결', true)),
    ...RECS.map((t) => val(t, t === '값 없음')),
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
    // U5-b B1(715): firstVer = 이 탭이 처음 받은 status.ver(화면 번들 해시 아님) · 서버 version() 실패값 = «미확인»(+수정) 문자열.
    // 비교 = 이 연결의 신선한 수신(linkOk·bad 없음·stGen=gen) + 두 값 모두 실제 판일 때만, 범위는 «처음·지금 받은 서버 판 표기». 아니면 판 비교 미확인(warn — 꺼짐 아님)
    <>{verCmp ? val(v.newVer ? '서버 판 바뀜(이 탭이 처음 받은 판과 다름) · 새로고침 권장' : '서버 판 그대로(이 탭이 처음 받은 판과 같음)')
      : <span className="mono" style={{ color: 'var(--warn)' }}>판 비교 미확인</span>}
      <span data-dev>{val(` · 화면 ${L.firstVer || '미확인'} · 서버 ${st?.ver || '미확인'}`)}</span></>,
  ];
  const set = (b: string, lbl: string | null, ctl: JSX.Element) => (
    <div className="set" key={b}><span className="t"><b>{b}</b>{lbl && <span className="lbl">{lbl}</span>}</span>{ctl}</div>);
  const tr = (a: string, b: string, c: string, d: string, e: JSX.Element) => (
    <tr key={a}><td style={{ fontWeight: '600' }}>{a}</td><td>{b}</td><td className="lbl">{c}</td><td className="mono">{d}</td><td>{e}</td></tr>);
  const vals = {
    themeClass: themeClass(true), stopProps, status: <LiveStatus D={D} />,
    stopSub: '스페이스 · 입력 차단·잠금', stopHelp: <Help label="STOP 설명">{STOP_TIP}</Help>,   // 공용 STOP 글(PcRobot·PcMissions·PcPlan 과 같음)
    hdrA: '설정', hdrNote: '여기서 바꾸는 값은 이 브라우저에만 저장(테마·막대 배치·지도 보기) · 변경 기록 미연결',
    sv, lostLbl: '직접 조종 중 · 서버 고정 동작(자율 이동 미연결)',
    safetyLbl: '지금 서버의 고정값입니다(앱에서 바꾸지 않음). 현장 값은 실기 연결 뒤 정합니다.',
    alertsH: '알림 · 미연결(화면에 경보 사건만 표시)',
    thLbl: <>값 없음 — 가스 측정값이 들어오지 않아 기준값을 쓰지 않습니다.<Help label="가스 측정 · 설명">{WHY['가스·측정값·통신 품질']}</Help></>,
    thBody: <tr><td className="lbl" colSpan={4}>가스 측정값이 없어 기준표 미사용</td></tr>,
    addP: { ...whyProps('계정 추가·편집 미연결 — 계정은 서버 관리자가 이 PC 에서 관리'), className: 'btn pri lv-why' },
    accRows: <>{tr(st?.me || '미확인', '이 기기', '조종(조종권을 받을 때) · 임무 기록 · 사진 분류', st?.holder ? `조종 중 기기: ${st.holder}` : '조종 중인 기기 없음',
      GATED ? <><button type="button" className="btn" title="조종권 해제 · 입력 차단·잠금(서버) 뒤 로그인 화면" onClick={() => logoutNow().then((e) => e && toast(e))}>로그아웃</button>{note && <span className="lbl"> {note}</span>}</> : <span className="lbl">로그인 없음(이 PC 전용)</span>)}
      {tr('다른 계정', '—', '계정 목록 보기 미연결(서버 관리자만)', '—', <></>)}</>,
    dispExtra: <>{set('지도 기본 보기', '로봇 중심 = 지도가 움직임',
      <select className="inp" value={mm} onChange={(e) => { setMm(e.target.value); if (!store.set('fh.live.mapmode', e.target.value)) toast('저장 실패 — 이번 화면에만'); }}>
        <option value="robot">로봇 중심</option><option value="all">전체 보기</option></select>)}
      {/* U1-a: 개발자 모드 = 진단 정보 표시만(권한·안전·명령 무관). 주소 ?dev=1/0 으로도 바뀜 */}
      {set('개발자 모드', '진단 정보 표시만 · 권한·안전 동작은 그대로 · 주소 ?dev=1 / ?dev=0',
        <DevSwitch />)}</>,   // U5-b: 공용 스위치 재사용(같은 마크업·같은 setDev)
    // B2 R31: 이 빌드에 입구가 있는 기능은 «서버가 허용할 때만»으로(facts.ts 한 출처)
    // U5-b(v3 §2-4): UNSUP 을 표로 그대로(원어 포함 — 금지어 검사 제외 구역) · 용어 원문 TERMS 는 개발자 모드
    limits: <section id="limits" className="card" aria-label="지원 범위와 한계"><h2>지원 범위와 한계(미제공·미연결·미검증 · 서버가 허용할 때만)</h2>
      <table><thead><tr><th>기능</th><th>지금</th></tr></thead>
        <tbody>{UNSUP.map(([a, b]) => <tr key={a}><td style={{ fontWeight: '600' }}>{a}</td><td className="lbl">{b}</td></tr>)}</tbody></table>
      <p className="lbl" data-dev style={{ marginTop: 8 }}>{TERMS}</p></section>,
  };
  return <><style>{CSS}</style><div id="dc-root"><View v={vals} /></div></>;
}

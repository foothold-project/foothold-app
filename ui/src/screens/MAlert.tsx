// 휴대폰 알림 상세(원본 경보 틀): 서버 사건 원문 + 지금 할 수 있는 조치 — web/live.js pageMAlert 와 같은 규칙.
// 가스 수치·추이 그래프·자동 후퇴는 v2 에 없음 → 수치 칸은 숨기고 그래프 자리에 앞뒤 2분 사건 원문을 둔다.
import { CSS, View } from './MAlert.view';
import { LV, fmtT, themeClass, tms } from '../data/fmt';
import { READ_NOTE, markRead } from '../data/alerts';
import { useDocs, useMedia } from '../data/shared';
import { href } from '../data/hist';
import { linkView, useLink } from '../data/link';
import { LATCH_TXT, STOP_FACT, WHY, evShow } from '../data/facts';
import { LiveStatus } from '../app/status';
import { stopOn, stopProps, useRoute } from '../app/shell';


export default function MAlert() {
  const D = useDocs(), M = useMedia(), { q } = useRoute(), lk = linkView(useLink());
  const e = M.events.find((x) => x.at === q.get('at') && x.text === q.get('t')), none = !q.get('at');
  const near = e ? M.events.filter((x) => x !== e && Math.abs(tms(x.at) - tms(e.at)) < 120e3).slice(0, 20) : [];
  const rows: [string, string, string][] = [[lk.linkOk && lk.latch ? '✓' : '·', LATCH_TXT(lk), lk.linkOk ? '지금' : '링크 끊김'], ['·', `서버 정지: ${STOP_FACT[0]} → 명령 0`, '항상'],
    ['·', `자동 후퇴·자동 조치 — ${WHY['자동 목적지 이동·자동 복귀'].split(' — ')[0]}`, '실행 안 함'], ['·', '경보 공유 — 미연결(외부 알림·메시지 발송 없음)', '실행 안 함']];   // B2 R11: 공유 버튼 대신 사실 한 줄
  const v = {
    themeClass: themeClass(false), stopProps, status: <LiveStatus D={D} style={{ padding: '6px 14px' }} />,
    ...(e ? { lv: `${LV[e.st] || '·'} ${({ bad: '위험', warn: '경고' } as Record<string, string>)[e.st] || e.st}`, time: fmtT(e.at), title: evShow(e.text), sub: `${evShow(e.text) === e.text ? '서버 사건 원문' : `원문: ${e.text}`} · Go2 시뮬(foothold-v2) · 원인 판단은 포함하지 않음` }   // U3-a: 제목만 표시 문장, 원문 전문은 이 줄
      : { lv: !M.ok ? '읽는 중…' : none ? '고른 경보 없음' : '사건을 찾지 못함', time: '', title: !M.ok ? M.err || '' : none ? '알림 목록에서 경보를 고르세요' : '서버 최근 300건 밖이거나 주소가 틀렸습니다', sub: '' }),
    valDisplay: 'none',
    didT: '지금 서버·로봇 상태', didL: '이 앱에서 지금 할 수 있는 조치: STOP · 직접 조종. 자동 규칙에 따른 조치는 미연결입니다.',
    rows: rows.map(([a, b, c], i) => <div className="row" key={i}><span style={{ color: 'var(--ok)', fontWeight: '700' }}>{a}</span><span>{b}</span><span className="mono lbl">{c}</span></div>),
    trT: '앞뒤 2분 서버 사건', trS: `같은 시각 근처 원문 · ${READ_NOTE}`,
    near: <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>{e ? (near.length ? near.map((x, i) => <span className="lbl" key={i}>{`${fmtT(x.at)} ${LV[x.st] || '·'} ${x.text}`}</span>) : <span className="lbl">앞뒤 2분 안 다른 사건 없음</span>) : null}</div>,
    okT: '이 경보만 읽음 표시(이 기기)', okClick: () => { if (e) markRead([e], M.events); location.hash = href('MAlerts'); },   // R14: 이 사건 키 1개만
    stopOn, stopT: 'STOP(명령 0 요청·잠금)', shareProps: { hidden: true, 'aria-hidden': true, tabIndex: -1 },
  };
  return <><style>{CSS}</style><div id="dc-root"><View v={v} /></div></>;
}

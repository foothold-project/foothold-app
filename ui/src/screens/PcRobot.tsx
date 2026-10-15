// PC 로봇(원본 카드 틀): 시뮬 상태 원값·연결·센서·정지 계층 — web/live.js pagePcRobot 과 같은 글.
// 값이 없는 칸(배터리·모터 온도·보행 모드·라이다 등)은 «미제공/미연결», 판정 기준을 덧붙이지 않는다. 자세 명령은 보내지 않는다.
import { CSS, View } from './PcRobot.view';
import { deg, num, posTxt, saveBlob, themeClass } from '../data/fmt';
import { WHY } from '../data/facts';
import { linkView, stateRows, useLink } from '../data/link';
import { useDocs } from '../data/shared';
import { LiveStatus } from '../app/status';
import { stopProps, toast } from '../app/shell';

type Lv = 'ok' | 'warn' | 'off';
const rows = (rs: [Lv, string, string][], top0 = true) => rs.map(([lv, a, b], i) => (
  <div className="row" key={a} style={top0 && !i ? { borderTop: '0' } : undefined}>
    <span className={`m-${lv}`}>{lv === 'ok' ? '●' : lv === 'warn' ? '▲' : '○'}</span><span>{a}</span><b style={lv === 'off' ? { color: 'var(--muted)' } : undefined}>{b}</b>
  </div>));
const OFF = { hidden: true, 'aria-hidden': true, tabIndex: -1 };   // B2 R11: 미연결·미검증 기능은 버튼 모양 0 — 숨기고 글로 설명
const eq = (name: string, sub: string) => (
  <div className="eq" key={name}><span className="ei" /><span style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}><b style={{ fontSize: '14px' }}>{name}</b><span className="lbl">{sub}</span></span>
    <span className="m-off" style={{ fontSize: '13px' }}>○ 미연결</span></div>);
const POSE = ['일어서기', '앉기', '엎드리기 · 모터 끄기 전', '넘어짐에서 다시 일어서기'];

export default function PcRobot() {
  const D = useDocs(), L = useLink(), v = linkView(L), s = v.s, st = L.st;
  const f = (x: string) => (s ? x : '미확인'), newVer = v.newVer;
  const latchTxt = !v.linkOk ? '잠금 상태 미확인(서버 연결 끊김)' : v.latch ? 'STOP 잠금 켜짐(명령 0 유지)' : 'STOP 잠금 꺼짐';
  const vals = {
    themeClass: themeClass(true), stopProps, status: <LiveStatus D={D} />,
    hdrA: '로봇', hdrB: 'Go2 시뮬 · foothold-v2 Gazebo(실기 아님)',
    pill: `${v.linkOk ? '●' : '▲'} 링크 ${v.linkTxt}`, pillStyle: v.linkOk ? undefined : { color: 'var(--warn)', background: 'var(--warn-bg)' },
    role: <span className="lbl">{`조종권: ${v.roleTxt}`}</span>,
    bodyH: 'v2 시뮬 상태 원값 · 모터 온도·보행 모드 미제공', noSvg: true,
    bodyRows: rows([[s ? 'ok' : 'off', '몸', v.body], ['off', '보행 모드', '미제공'], ['off', '다리 모터 온도', '미제공'],
      [!s ? 'off' : s.fallen === true ? 'warn' : 'ok', '넘어짐', f(String(s?.fallen ?? '미확인'))], [s ? 'ok' : 'off', '기울기', f(num(s?.tilt_deg, 1, '°'))],
      [s ? 'ok' : 'off', '속도 vx · vy', f(`${num(s?.vx)} · ${num(s?.vy)} m/s`)], [s ? 'ok' : 'off', '위치(시뮬) · 방향', f(`${posTxt(s?.x, s?.y)} · ${deg(s?.yaw)}`)]]),
    bodyNote: '넘어짐·기울기·속도는 Gazebo 시뮬 원값입니다. 판정 기준을 덧붙이지 않습니다.',
    batBig: <><span className="mono" style={{ fontSize: '28px', fontWeight: '600', lineHeight: '1', whiteSpace: 'nowrap' }}>미제공</span><span className="lbl">{WHY['배터리']}</span></>,
    batBarHide: true, batLbl: '복귀 기준(배터리)은 값이 없어 쓰지 않습니다',
    batRows: rows([['off', '전압 · 사이클', '미제공'], [v.linkOk ? 'ok' : 'warn', '링크 · 상태 나이', `${v.linkTxt} · ${st ? num(st.state_age, 2, ' s') : '미확인'}`],
      ['off', '로봇 PC', '미제공'], [newVer ? 'warn' : 'ok', '화면 판 · 서버 판', `${L.firstVer || '미확인'} · ${st?.ver || '미확인'}`]], false),
    sensRows: rows([[v.camOk ? 'ok' : 'warn', '전방 카메라(시뮬 카메라)', v.camTxt], ['off', 'L1 라이다', '미제공'], ['off', 'IMU', '미제공(기울기는 시뮬 원값)'],
      ['off', '뎁스 카메라 D435i', WHY['뎁스 영상·3D 점군'].split(' — ')[0]], ['off', 'XT-16 라이다', '미연결']]),
    eqH: '등록된 장비 없음 · 장비 등록(열화상 카메라·계기판 카메라·조명 등) 미연결(현재 v2 연결은 시뮬 영상·상태만) · 지금 앱 모듈은 사진·운영자 확인·대기만',
    eqCardP: OFF,   // B2 R11: «+ 장비 등록» 점선 카드도 누를 것처럼 보임 → 카드째 숨김(예시 장비는 eqH 글로)
    eqs: <>{eq('가스 검지기', WHY['가스·측정값·통신 품질'])}{eq('스피커', '음성 방송 — 현재 v2 연결에 스피커 출력 없음')}</>,
    eqAddP: OFF,
    pose: Object.fromEntries(POSE.map((t) => [t, OFF])),
    poseNote: `자세 명령(${POSE.join('·')})은 미검증이라 보내지 않습니다 — ${WHY['후진·제자리 회전·옆걸음·저속·자세']}. 이동은 관제·조종 화면에서 앞 0.6 m/s · 앞+회전(초당 약 29°)만.`,
    stopRows: rows([[!v.linkOk || v.latch ? 'warn' : 'ok', '앱 STOP → 서버', `${latchTxt} · ${v.sent}`], ['ok', '서버 deadman 0.3 s', '켜짐(서버 설정값 · 현장 정지 시간 보증 아님)'],
      ['ok', '화면 신호 끊김 1.0 s → 정지·잠금', '켜짐(서버)'], ['off', '정지 시험 자동 실행', '미연결 — STOP 버튼으로 직접 확인'], ['warn', '로봇 쪽 명령 끊김 감시', '실기 미검증'], ['off', '리모컨 비상 정지', '미연결(시뮬)']]),
    testP: OFF,
    logT: '상태 원값 내려받기 (JSON)',
    logP: { onClick: () => toast(saveBlob(`foothold-v2-state-${Date.now()}.json`, new Blob([JSON.stringify(Object.fromEntries(stateRows(L)), null, 1)], { type: 'application/json' }))) },
  };
  return <><style>{CSS}</style><div id="dc-root"><View v={vals} /></div></>;
}

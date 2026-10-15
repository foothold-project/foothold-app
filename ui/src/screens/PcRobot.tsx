// PC 로봇(원본 카드 틀): 시뮬 상태·연결·센서/보기·정지 계층.
// U4-b: 값 없는 줄만 동적으로 접고(넘어짐·오래됨·잠금은 상시), 예시·추정 값 0, 진단(판 해시·원값·JSON)은 개발자 모드. 자세 명령은 보내지 않는다.
import { CSS, View } from './PcRobot.view';
import { deg, num, ok, posTxt, saveBlob, sgn, themeClass } from '../data/fmt';
import { RELURCH, RELURCH_OBS, SAFE_NOTE, STOP_FACT, STOP_OBS, STOP_TIP, TRIAL_SAFE, WHY } from '../data/facts';
import { linkView, stateRows, useLink } from '../data/link';
import { useDocs } from '../data/shared';
import { LiveStatus } from '../app/status';
import { stopProps, toast, whyProps } from '../app/shell';
import { Help } from '../app/chip';

type Lv = 'ok' | 'warn' | 'off';
// U4-b(v3 §4 PcRobot): 줄 = [톤, 이름, 값(null = 받은 값 없음), keep(값 없어도 늘 보임 — 넘어짐·오래됨·잠금), dev(개발자 모드만)]
type It = [Lv, string, string | null, boolean?, boolean?];
// 670 P2(8373ea3): 긴 값(진단 덧붙임)이 auto 값 칸을 넓혀 이름 칸(1fr)이 한 글자 폭으로 밀림 → 이 화면 행만 국소 배치(전역 .row 무변경):
// 이름 칸 최소 읽기 폭 확보 · 값 칸은 남는 폭 안에서 단어 단위 줄바꿈(생략·잘림 0) · 짧은 값 행은 이전과 같은 폭
const ROW = { gridTemplateColumns: '18px minmax(min(7.5em, 45%), 1fr) minmax(0, max-content)', wordBreak: 'keep-all', overflowWrap: 'anywhere' } as const;
const rows = (rs: It[], top0 = true) => rs.map(([lv, a, b, , dev], i) => (
  <div className="row" key={a} data-dev={dev ? '' : undefined} style={top0 && !i ? { ...ROW, borderTop: '0' } : ROW}>
    <span className={`m-${lv}`}>{lv === 'ok' ? '●' : lv === 'warn' ? '▲' : '○'}</span><span>{a}</span><b style={lv === 'off' ? { color: 'var(--muted)' } : lv === 'warn' ? { color: 'var(--warn)' } : undefined}>{b ?? '받은 값 없음'}</b>
  </div>));
/** R4: 값 없는 줄만 접음(«값 없는 줄 n개 ›») — 값이 들어오면 그 줄은 밖으로 나옴. keep 줄(넘어짐·오래됨·잠금)은 접지 않음 */
const block = (its: It[], top0 = true) => { const on = its.filter((x) => x[2] != null || x[3]), off = its.filter((x) => x[2] == null && !x[3]);
  return <>{rows(on, top0)}{off.length > 0 && <details data-none=""><summary className="lbl" style={{ padding: '8px 0', cursor: 'pointer' }}>{`값 없는 줄 ${off.length}개 ›`}</summary>{rows(off, false)}</details>}</>; };
const OFF = { hidden: true, 'aria-hidden': true, tabIndex: -1 };   // B2 R11: 미연결·미검증 기능은 버튼 모양 0 — 숨기고 글로 설명
const VIEWS: [k: 'follow' | 'lidar' | 'points', name: string][] = [['follow', '외부 3인칭 영상'], ['lidar', '라이다(센서 기준)'], ['points', '지도 누적 점군']];
// B2(715): 계약 ViewSrc.st off = «미수신»(꺼짐 아님) — 받은 것 없음(warn).
// B2-R(715): prod.enabled 는 run/epoch 결속이 없는 최근 발행 진단(계약 ViewProd) — false 여도 «꺼짐» 확정 0, 받은 것 없음 + 최근 진단 + 지금 실행 미확인(warn)
const OFF_DIAG = '최근 발행 진단: 외부카메라 끔(지금 실행인지 미확인)';
const VST: Record<string, [Lv, string]> = { ok: ['ok', '시뮬이 보냄'], stale: ['warn', '오래됨'], bad: ['warn', '오류'], off: ['warn', '받은 것 없음'] };
// B3(715): 줄 값 = 그 줄의 필드 중 실제로 받은(유한 숫자, 0 포함) 것만 — 전부 없음 = null(접힘·warn), 일부만 = 받은 부분 보존 + 나머지 «미확인»(warn), 전부 = ok
const part = (fs: unknown[], txt: string): [Lv, string | null] => { const n = fs.filter(ok).length; return [n === fs.length ? 'ok' : 'warn', n ? txt : null]; };

export default function PcRobot() {
  const D = useDocs(), L = useLink(), v = linkView(L), s = v.s, st = L.st, sim = L.provider === 'simulation_gate';
  const newVer = v.newVer;
  // B1(715): 잠금·보기 확정은 «현재 연결에서 받은 유효 status»가 있을 때만 — 머리줄 headChips 의 known(linkOk·bad 없음·st 있음) + 이 연결 세대(stGen === gen). 아니면 «확인 안 됨»(warn)
  const known = v.linkOk && !L.bad && !!st && L.stGen === L.gen;
  const latch: [Lv, string] = !known ? ['warn', '잠금 확인 안 됨'] : v.latch ? ['warn', '잠금 켜짐'] : ['ok', '잠금 꺼짐'];
  const tilt = part([s?.tilt_deg], num(s?.tilt_deg, 1, '°')), spd = part([s?.vx, s?.vy], `${num(s?.vx)} · ${num(s?.vy)} m/s`), pos = part([s?.x, s?.y, s?.yaw], `${ok(s?.x) && ok(s?.y) ? posTxt(s?.x, s?.y) : `x ${sgn(s?.x, 2, ' m')} · y ${sgn(s?.y, 2, ' m')}`} · ${deg(s?.yaw)}`);   // B3-R: 축별 — 받은 축(0 포함) 보존, 빠진 축만 미확인
  // 보기(시뮬이 보내는 화면 자료) — 서버가 받은 상태 그대로(views[k].st). 실기 센서 연결·건강 판정 아님. 서버가 이 보기를 안 주면(이전 판) 줄 없음
  const vs = st?.views as Record<string, { st: string; why: string; age_s: number | null } | null | undefined> | undefined;
  const viewRows: It[] = VIEWS.flatMap(([k, n]): It[] => { const x = vs?.[k] as ({ st: string; why: string; age_s: number | null; prod?: { enabled?: boolean | null } | null } | null | undefined); if (!known) return [['warn', n, '확인 안 됨', true]]; if (!x) return [];
    const [lv, t] = VST[x.st] ?? ['warn', '확인 안 됨'], w = x.why && !(x.st === 'off' && x.why === t) ? ` · ${x.why}` : '';
    const dg = x.st === 'off' && k === 'follow' && x.prod?.enabled === false ? ` · ${OFF_DIAG}` : '';   // B2-R: 진단은 덧붙이기만(톤·«꺼짐» 확정 0)
    return [[lv, n, `${t}${x.st === 'ok' && x.age_s != null ? ` · ${x.age_s.toFixed(1)} s 전` : ''}${x.st !== 'ok' ? w : ''}${dg}`, true]]; });
  const vals = {
    themeClass: themeClass(true), stopProps, status: <LiveStatus D={D} />,
    stopSub: '스페이스 · 입력 차단·잠금', stopHelp: <Help label="STOP 설명">{STOP_TIP}</Help>,   // 공용 STOP 글(v3 §3) — Main·PcMap 과 같음
    hdrA: '로봇', hdrB: sim ? 'Go2 시뮬' : 'Go2 실기 · 명령 미지원',
    pill: '',   // U4-b: 연결·역할·잠금은 머리줄 공통 칩(중복 0)
    role: <></>,   // U1-b: 조종권은 머리줄 역할 칩 한 곳(null 이면 view 기본 문구가 나와 빈 조각)
    bodyH: '', noSvg: true,
    bodyRows: block([s ? [v.body.includes('미확인') ? 'warn' : 'ok', '몸', v.body, true] : ['warn', '몸', `확인 안 됨 · ${v.linkTxt}`, true],   // B3: «미확인» 글은 정상 톤 0
      [s?.fallen === false ? 'ok' : 'warn', '넘어짐', s?.fallen === true ? '넘어짐' : s?.fallen === false ? '아님' : '미확인', true],
      [tilt[0], '기울기', tilt[1]], [spd[0], '속도(앞 · 옆)', spd[1]], [pos[0], '위치 · 방향', pos[1]], ['off', '보행 모드', null], ['off', '다리 모터 온도', null]]),
    bodyNote: <span data-dev="">넘어짐·기울기·속도는 Gazebo 시뮬 원값입니다. 판정 기준을 덧붙이지 않습니다. 보행 모드·다리 모터 온도는 미제공.</span>,
    batBig: <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><span className="m-off">○</span><span className="lbl" style={{ fontSize: 14 }}>배터리 값 없음</span><Help label="배터리 · 설명">{WHY['배터리']}</Help></span>,
    batBarHide: true, batLbl: '',
    batRows: block([[known ? 'ok' : 'warn', '연결 · 상태 나이', `${v.linkTxt} · ${st ? num(st.state_age, 2, ' s') : '미확인'}`, true],   // B1: 형식 오류·상태 없음 = «상태 미확인» 글이 정상 톤 0
      ...(newVer ? [['warn', '화면 판 ≠ 서버 판', '새로고침 필요', true] as It] : []),
      ['ok', '화면 판 · 서버 판', `${L.firstVer || '미확인'} · ${st?.ver || '미확인'}`, true, true],   // 해시 = 개발자 모드
      ['off', '전압 · 사이클', null], ['off', '로봇 PC', null]], false),
    // 센서: 보기 수신(시뮬 화면 자료)과 실기 센서 연결을 나눔 — «RGB만»·«센서 없음» 고정 단정 0
    sensRows: <>{block([[v.camOk ? 'ok' : 'warn', '전방 카메라 영상(RGB)', v.camTxt, true], ...viewRows])}
      <span className="lbl" style={{ display: 'block', padding: '6px 0' }}>위는 시뮬이 보내는 보기 · 실기 센서 연결·건강 판정 아님</span>
      {block([['off', '실기 L1 라이다', null], ['off', '실기 IMU', null], ['off', '실기 뎁스 카메라 D435i', null], ['off', '실기 XT-16 라이다', null]], false)}</>,
    eqH: '등록된 장비 없음',
    eqs: <></>,   // U4-b: 예시 장비 줄 0(값 없음에 예시 0)
    eqCardP: {},
    eqAddP: { ...whyProps('장비 등록 미연결 — 지금 연결은 시뮬 영상·상태만, 앱 모듈은 사진·운영자 확인·대기만'), className: 'btn lv-why' },
    poseCardP: OFF,   // U4-b: 자세 명령 카드째 숨김 — 이유 전문은 설정 «지원 범위»(후진·제자리 회전·옆걸음·저속·자세)
    pose: Object.fromEntries(['일어서기', '앉기', '엎드리기 · 모터 끄기 전', '넘어짐에서 다시 일어서기'].map((t) => [t, OFF])),
    poseNote: WHY['후진·제자리 회전·옆걸음·저속·자세'],
    stopRows: block([[latch[0], '앱 STOP → 서버', latch[1], true], ['ok', '서버 deadman 0.3 s (입력 만료)', '켜짐', true],
      ['ok', '화면 신호 1.0 s 끊김 → 입력 차단·잠금', '켜짐', true], ['off', '정지 시험 자동 실행', '없음', true], ['warn', '로봇 쪽 명령 끊김 감시', '실기 미검증', true],
      ['off', '리모컨 비상 정지', '시뮬 없음', true], ['ok', '보낸 명령', v.sent, true, true]]),
    // v3 §4 «알려진 정지 특성»(운영에서도 보임 · warn): 정본 facts.ts · 전문(조건·출처)은 ? — 시간/거리 상한 아님
    stopFacts: <div role="note" aria-label="알려진 정지 특성" style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '8px 10px', border: '1px solid var(--warn)', borderRadius: 8, background: 'var(--warn-bg)' }}>
      <b style={{ fontSize: 13, color: 'var(--warn)', display: 'flex', alignItems: 'center', gap: 6 }}>▲ 알려진 정지 특성<Help label="알려진 정지 특성 · 설명">
        <span style={{ display: 'block' }}>{SAFE_NOTE}</span>
        <span style={{ display: 'block', marginTop: 4 }}>{`${STOP_FACT[0]} → ${STOP_FACT[1]}`}</span>
        <span style={{ display: 'block', marginTop: 4 }}>{`주의: ${RELURCH}`}</span>
        <span style={{ display: 'block', marginTop: 4 }}>{TRIAL_SAFE}</span></Help></b>
      <span style={{ fontSize: 13 }}>{STOP_OBS}</span><span style={{ fontSize: 13 }}>{RELURCH_OBS}</span></div>,
    testP: OFF,
    logT: '상태 원값 내려받기 (JSON)',
    logP: { 'data-dev': '', onClick: () => toast(saveBlob(`foothold-v2-state-${Date.now()}.json`, new Blob([JSON.stringify(Object.fromEntries(stateRows(L)), null, 1)], { type: 'application/json' }))) },   // 개발자 모드
  };
  return <><style>{CSS}</style><div id="dc-root"><View v={vals} /></div></>;
}

// #/Field — 폰 현장 «내 로봇» 입구(새 기획 10-18, SPEC §5). 기존 폰 화면(MHome·MDrive·MMap·MFinding·MHistory)은 그대로 두고 링크만.
// 새 명령 경로 0: 이 화면은 sendOp·startDrive·setProvider 를 부르지 않음. STOP = 기존 stopProps(stopNow). 조종은 #/MDrive 로 이동만.
// 내 로봇 고르기 = 화면 표시만. 실측(MapCanvas)과 계획(SceneCanvas)은 «실측 | 계획» 전환 — 겹쳐 그리지 않고 거리·지남 계산 0(좌표 정합 근거 없음, root 10-18).
import { useEffect, useMemo, useState } from 'react';
import { Chip } from '../app/chip';
import { camChip, useHeadChips } from '../app/status';
import { stopProps } from '../app/shell';
import { SourceTag, listErr, liveOf, useProject, useProjects } from '../app/fleetui';
import { TRAIL, camURL, linkView, useLink } from '../data/link';
import { themeClass } from '../data/fmt';
import { brokenTxt, damagedTxt, pathLen, r3, type Scene } from '../data/rehearsal';
import { MapCanvas } from '../map/MapCanvas';
import { SceneCanvas, robotTags } from '../map/SceneCanvas';

const LIVE = '';   // «내 로봇» 값: '' = 연결 로봇, 그 밖 = 계획 로봇 id
type Tab = 'now' | 'map' | 'report' | 'hist';
// 가로(높이 ≤ 500): 왼쪽 지도/영상 · 오른쪽 상태 — STOP 은 오른쪽 아래 그대로
const CSS = `.fd-body{display:grid;gap:12px;padding:12px 16px 168px}
@media (orientation: landscape) and (max-height: 500px){.fd-body{grid-template-columns:minmax(0,1fr) minmax(0,1fr);padding-bottom:150px}}`;

/** 계획 로봇의 경로 요약(설계도 점의 기하 길이·점 수만 — 실제 위치와의 거리 계산 0) */
export function routeSummary(s: Scene, robot: string, scRoutes: string[]) {
  const rs = s.routes.filter((r) => r.robot === robot && scRoutes.includes(r.id));
  return { n: rs.length, pts: rs.reduce((t, r) => t + r.points.length, 0), len: r3(rs.reduce((t, r) => t + pathLen(r.points), 0)) };
}

export default function Field() {
  const L = useLink(), v = linkView(L), chips = useHeadChips(), cam = camChip(v), direct = L.provider !== 'simulation_gate';
  const P = useProjects();
  const [pid, setPid] = useState<string | null>(null), [scId, setScId] = useState<string | null>(null);
  const G = useProject(pid), s = G.st === 'ok' ? G.data!.scene : null;
  const [me, setMe] = useState(LIVE), [pair, setPair] = useState(''), [tab, setTab] = useState<Tab>('now'), [view, setView] = useState<'live' | 'plan'>('live');
  useEffect(() => { setScId(s?.scenarios[0]?.id || null); setMe(LIVE); setPair(''); }, [s]);
  const sc = s?.scenarios.find((x) => x.id === scId) || null;
  const tags = useMemo(() => (s ? robotTags(s, sc) : new Map<string, { tag: string; i: number }>()), [s, sc]);
  const plan = me !== LIVE && sc?.robots.includes(me) ? me : null;   // 고른 계획 로봇(배치안이 바뀌어 빠지면 연결 로봇으로)
  const shown = plan || pair || null, rb = shown && s ? s.robots.find((x) => x.id === shown) : null;
  const sum = rb && s && sc ? routeSummary(s, rb.id, sc.routes) : null;
  const liveName = pair && tags.get(pair) ? `${tags.get(pair)!.tag} · 연결 대상` : '연결 대상';
  const liveTxt = liveOf(v, direct).txt;   // 몸 상태 없으면 «관문 연결 · 몸 상태 미확인»(로봇 연결 성공으로 쓰지 않음)

  const projects = P.st === 'ok' ? P.data!.projects : [], broken = P.st === 'ok' ? brokenTxt(P.data!) : null, damaged = P.st === 'ok' ? damagedTxt(P.data!) : null;
  const listRev = pid ? projects.find((p) => p.id === pid)?.rev : undefined, gone = P.st === 'ok' && !broken && !!pid && listRev === undefined;
  const pick = <div style={{ display: 'grid', gap: 8 }}>
    {P.st === 'loading' || P.st === 'idle' ? <p style={{ margin: 0 }}>리허설 저장소 읽는 중…</p>
      : P.st === 'err' ? <p role="alert" style={{ margin: 0 }}>{listErr(P.code, P.error)} <button type="button" className="lv-btn" onClick={P.reload}>다시 시도</button></p>
      : broken ? <p role="alert" style={{ margin: 0 }}>{broken} <button type="button" className="lv-btn" onClick={P.reload}>다시 읽기</button></p>
      : <>
        {damaged && <p role="alert" style={{ margin: 0, fontSize: 13 }}>{damaged}</p>}
        {!projects.length ? <p style={{ margin: 0 }}>{damaged ? '열 수 있는 리허설 프로젝트가 없습니다' : '리허설 프로젝트가 없습니다 · PC 지도 편집에서 저장한 뒤 «목록 새로 읽기»'}</p>
          : <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>프로젝트
            <select className="lv-inp" value={pid || ''} onChange={(e) => setPid(e.target.value || null)} style={{ minHeight: 44 }}>
              <option value="">고르세요</option>{projects.map((p) => <option key={p.id} value={p.id}>{`${p.name} · r${p.rev}`}</option>)}</select></label>}
        {/* 누를 때만 다시 읽음(자동 폴링·자동 새 판 전환 0) · 고른 것은 그대로(WORDING-CHECK §2) */}
        <button type="button" className="lv-btn" onClick={P.reload} style={{ minHeight: 44, justifySelf: 'start' }}>목록 새로 읽기</button>
        {gone && <p role="status" style={{ margin: 0, fontSize: 13 }}>고른 프로젝트가 목록에 없습니다</p>}
        {G.st === 'ok' && <p style={{ margin: 0, fontSize: 13 }}>{`읽은 판 r${G.data!.project.rev}${listRev && listRev !== G.data!.project.rev ? ` · 목록은 r${listRev}(계획 다시 읽기로 바꿈)` : ''} `}
          <button type="button" className="lv-btn" onClick={G.reload} style={{ minHeight: 44 }}>계획 다시 읽기</button></p>}
        {G.st === 'err' && <p role="alert" style={{ margin: 0 }}>{`프로젝트를 불러오지 못했습니다 · ${G.error}`}</p>}
        {pid && G.st === 'loading' && <p style={{ margin: 0 }}>프로젝트 읽는 중…</p>}
        {s && (s.scenarios.length ? <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>배치안
          <select className="lv-inp" value={scId || ''} onChange={(e) => { setScId(e.target.value || null); setMe(LIVE); setPair(''); }} style={{ minHeight: 44 }}>
            {s.scenarios.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label> : <p style={{ margin: 0 }}>이 설계도에 배치안이 없습니다</p>)}
      </>}
  </div>;

  const thumb = <a href="#/MDrive" aria-label="조종 화면에서 영상 보기" style={{ position: 'relative', display: 'block', aspectRatio: '16/9', borderRadius: 8, overflow: 'hidden', background: 'var(--panel2)', color: 'var(--muted)' }}>
    <img data-live-cam="" alt="" src={camURL || undefined} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', visibility: v.camOk ? 'visible' : 'hidden' }} />
    {!v.camOk && <span style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', fontSize: 13 }}>{v.camTxt}</span>}
  </a>;

  const links = (a: [string, string][]) => <div style={{ display: 'grid', gap: 8 }}>{a.map(([h, t]) => <a key={h} className="lv-btn" href={h} style={{ minHeight: 48, display: 'flex', alignItems: 'center', textDecoration: 'none' }}>{t}</a>)}</div>;
  // 계획 로봇을 고른 동안 보고·기록은 보류(715 U3): 기존 화면(MFinding·Report·MHistory)은 연결 대상 자료라 계획 로봇의 결과처럼 보이면 안 됨
  const held = (what: string) => <div role="note" style={{ display: 'grid', gap: 8 }}>
    <p style={{ margin: 0 }}>{`${plan ? tags.get(plan)?.tag : ''} 계획 로봇은 실제 연결이 없어 ${what}이 없습니다 · 보류`}</p>
    <p className="lv-note" style={{ margin: 0 }}>{`기존 ${what} 화면은 ${liveName}(${liveTxt})의 자료입니다`}</p>
    <button type="button" className="lv-btn" onClick={() => setMe(LIVE)} style={{ minHeight: 48 }}>{`${liveName}으로 돌아가기`}</button>
  </div>;

  const now = <>
    {plan ? null : thumb}
    {!plan && <Chip tone={cam.tone} text={cam.text} why={cam.why} />}
    <section style={{ display: 'grid', gap: 6 }}>
      <h2 style={{ margin: 0, fontSize: 15 }}>{plan ? `${tags.get(plan)?.tag} 계획` : '짝지은 계획'}</h2>
      {!sc ? <><p style={{ margin: 0 }}>고른 계획 없음 · PC 지도 편집에서 저장한 프로젝트·배치안을 아래에서 직접 고릅니다</p>{pick}</>
        : <>
          {!plan && <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>짝짓기(이름표만)
            <select className="lv-inp" value={pair} onChange={(e) => setPair(e.target.value)} style={{ minHeight: 44 }}>
              <option value="">짝짓지 않음</option>{sc.robots.map((id) => <option key={id} value={id}>{`이 연결을 ${tags.get(id)?.tag} 로 보기 · ${s?.robots.find((r) => r.id === id)?.name || id}`}</option>)}</select></label>}
          {rb && sum ? <p style={{ margin: 0, fontSize: 14 }}>{`${tags.get(rb.id)?.tag} ${rb.name} · 경로 ${sum.n}개 · 길이 ${sum.len} m · 점 ${sum.pts}개 `}<SourceTag k="geo" /></p>
            : <p className="lv-note" style={{ margin: 0 }}>짝지은 계획 로봇 없음</p>}
          {(pair || plan) && <p className="lv-note" style={{ margin: 0 }}>좌표 정합 미확인 — 이름표만 같음 · 실제 위치와의 거리는 계산하지 않습니다</p>}
          <details><summary style={{ minHeight: 44, display: 'flex', alignItems: 'center' }}>프로젝트·배치안 바꾸기</summary>{pick}</details>
        </>}
    </section>
    <p style={{ margin: 0, fontSize: 14 }}>배터리 · 온도 <span className="lv-note">미수신</span></p>
    {links([['#/MHome', `기존 홈 · ${liveName} 자료`], ['#/MMap', `실행 지도 · ${liveName} 자료`]])}
  </>;

  const fl = rb?.floor || s?.floors[0]?.id || '';
  const map = <>
    <div role="group" aria-label="지도 보기" style={{ display: 'flex', gap: 2, padding: 2, border: '1px solid var(--line)', borderRadius: 8, justifySelf: 'start' }}>
      {(['live', 'plan'] as const).map((k) => <button key={k} type="button" className="lv-btn" aria-pressed={view === k} onClick={() => setView(k)}
        style={{ minHeight: 44, fontWeight: view === k ? 700 : 400, background: view === k ? 'var(--acc-bg)' : undefined }}>{k === 'live' ? '실측' : '계획'}</button>)}
    </div>
    <p className="lv-note" style={{ margin: 0 }}>좌표 정합 미확인 · 실측과 계획은 겹쳐 그리지 않습니다</p>
    {view === 'live' ? <p style={{ margin: 0, fontSize: 13 }}>{`기존 연결 대상의 실측 · ${liveName} · ${liveTxt}`}</p> : null}
    {view === 'live' ? <div style={{ position: 'relative', height: 320 }}><MapCanvas name="field-live" small trail={TRAIL.pts} robot={v.robot} showTrail /></div>
      : s ? <SceneCanvas scene={s} floor={fl} scenario={sc} analysis={null} issues={[]} focus={null} sel={rb ? { k: 'robot', id: rb.id } : null} height={320}
        label={`계획 지도 · ${s.name}${sc ? ` · ${sc.name}` : ''}`} />
      : <><p style={{ margin: 0 }}>고른 계획 없음</p>{pick}</>}
  </>;

  const body = tab === 'now' ? now : tab === 'map' ? map
    : tab === 'report' ? (plan ? held('보고') : links([['#/MFinding', `발견 기록 · 사진 · 메모 · ${liveName}`], ['#/Report', `보고서 · ${liveName}`]]))
    : plan ? held('기록') : links([['#/MHistory', `사진 · 사건 · 개입 기록 · ${liveName}`]]);

  const driveOff = plan ? '계획 대상 · 연결 없음' : direct ? '조종 미지원 · 보기 전용' : !v.linkOk ? '연결 없음' : '';
  return <>
    <style>{CSS}</style>
    <div id="dc-root"><div className={themeClass(false)} style={{ minHeight: '100dvh', background: 'var(--bg)', color: 'var(--text)', fontSize: 14 }}>
      <header style={{ position: 'sticky', top: 0, zIndex: 3, padding: '10px 16px', background: 'var(--panel)', borderBottom: plan ? '2px dashed var(--line2)' : '1px solid var(--line)', display: 'grid', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <img src={`${import.meta.env.BASE_URL}brand/assets/logo/v1/foothold-favicon.svg`} alt="FOOTHOLD" width={18} height={18} />
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0, fontWeight: 600 }}>내 로봇
            <select className="lv-inp" value={plan || LIVE} onChange={(e) => setMe(e.target.value)} style={{ flex: 1, minWidth: 0, minHeight: 44 }}>
              <option value={LIVE}>{`${liveName} · ${liveTxt}`}</option>
              {sc?.robots.map((id) => <option key={id} value={id}>{`${tags.get(id)?.tag} · ${s?.robots.find((r) => r.id === id)?.name || id} · 계획`}</option>)}
            </select></label>
        </div>
        {plan && <p role="status" style={{ margin: 0, fontSize: 13 }}>계획 대상 · 연결 없음 · 계획 조작은 로봇 명령 없음 · STOP은 기존 연결 대상에 요청</p>}
        <p className="lv-note" style={{ margin: 0, fontSize: 12 }}>{`아래 상태 = ${liveName}(${liveTxt})${plan ? ' · 고른 계획 로봇 아님' : ''}`}</p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>{chips.map((c) => <Chip key={c.k} tone={c.tone} text={c.text} why={c.why} />)}</div>
      </header>
      <main className="fd-body">{body}</main>
      <div style={{ position: 'fixed', left: 0, right: 0, bottom: 64, zIndex: 4, display: 'flex', alignItems: 'center', gap: 12, padding: '8px 16px', pointerEvents: 'none' }}>
        {driveOff ? <span className="lv-note" style={{ pointerEvents: 'auto', flex: 1, minHeight: 48, display: 'flex', alignItems: 'center' }}>{`조종 화면 열기 꺼짐 · ${driveOff}`}</span>
          : <a className="lv-btn pri" href="#/MDrive" style={{ pointerEvents: 'auto', flex: 1, minHeight: 48, display: 'flex', alignItems: 'center', justifyContent: 'center', textDecoration: 'none' }}>조종 화면 열기</a>}
        <button type="button" {...stopProps} style={{ pointerEvents: 'auto', height: 64, minWidth: 112, padding: '0 14px', border: 0, borderRadius: 12, background: 'var(--stop)', color: '#FFFFFF', fontWeight: 700, letterSpacing: '.06em', boxShadow: '0 0 0 3px rgba(215,38,30,.22)' }}>
          {plan ? `STOP · 연결된 ${liveName}` : 'STOP'}</button>
      </div>
      <nav aria-label="현장 탭" style={{ position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 4, height: 64, display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', background: 'var(--panel)', borderTop: '1px solid var(--line)' }}>
        {([['now', '현황'], ['map', '지도'], ['report', '보고'], ['hist', '기록']] as const).map(([k, t]) => <button key={k} type="button" aria-pressed={tab === k} onClick={() => setTab(k)}
          style={{ border: 0, background: 'transparent', color: tab === k ? 'var(--accent)' : 'var(--text)', fontWeight: tab === k ? 700 : 400, borderTop: tab === k ? '3px solid var(--accent)' : '3px solid transparent', fontSize: 15 }}>{t}</button>)}
      </nav>
    </div></div>
  </>;
}

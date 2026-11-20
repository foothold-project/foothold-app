// PC 로봇 탭 «바로 조종» 세 칸 화면(RB-PC-DRIVE-3COL 11-19): 서버가 조종을 허용한 실기 로봇(canDrive)을 고르면 로봇 탭 본문이 곧 이 화면.
// 맨 위 줄 = STOP(가장 크게)·조종 시작/끝내기·잠금 해제·연결 상태. 왼쪽 = 상태 글자(위) + Go2 3D(go2model.tsx — 실제 모양·관절 값·움직임 화살표, 글자와 안 겹침) + 자세 단추,
// 가운데 = quad.tsx 4칸(지도·카메라·라이다·뎁스 — 처음은 큰 1 + 작은 3), 오른쪽 = 지도 만들기(mapmake 흐름 그대로)·속도·시나리오·목표.
// 조종 논리(조종권·키·deadman 0·STOP·잠금 해제·자세)는 serverdrive.tsx useServerDrive 하나 — 이 파일은 배치만, 새 명령 값·서버 길 없음.
import { useEffect, useState, type ReactNode } from 'react';
import type { MapVersion, Scenario } from '../../contracts/ts';
import { api, type ApiFail } from './api';
import { rt, type Live } from './rt';
import { holderText } from './drive';
import { Chip, LINK, type Ctx } from './screens';
import { TRIAL, MAX_TURN_RATE, DriveView, stacked, useServerDrive } from './serverdrive';
import { driveFeedText, useDriveFeed, type DriveCh } from './drivemedia';
import { LidarMap } from './lidarmap';
import { OccMap } from './occmap';
import { Quad, type QTile } from './quad';
import { STALLED } from './simdrive';
import { MakeMap } from './screens/mapmake';
import { floorsOf, purposeOf, useTree } from './screens/maps';
import type { Robot } from './fake';
import { Go2Figure, JOINTS, jointName, useGo2Motion, type Pose } from './go2model';
import './pcdrive.css';

/** 이만큼 넘게 새 보고가 없으면 «로봇 보고 없음»(서버 state 는 0.1 s 마다) */
export const REPORT_STALE_MS = 1000;
/** state.robot_info 에서 그림에 쓸 관절 12개 + 몸 자세. 모양이 틀리거나 연결이 끊겼거나 오래되면 null(지어내지 않음) */
export function go2Pose(s: Live['state'], fresh: boolean): Pose {
  const j = s?.robot_info?.joints, w = s?.robot_info?.quaternion?.wxyz;
  if (!fresh || s?.connection !== 'ONLINE' || !j || j.positions.length !== 12 || j.names.length !== 12 || !j.positions.every(Number.isFinite) || !(j.age_s <= 1)) return null;
  const q = JOINTS.map((n) => j.positions[j.names.indexOf(n as never)]);
  if (q.some((v) => v === undefined)) return null;
  const norm = w && w.length === 4 && w.every(Number.isFinite) ? Math.hypot(...w) : 0;
  return { q, wxyz: norm > 0.9 && norm < 1.1 ? w!.map((v) => v / norm) : [1, 0, 0, 0] };
}

/** 온도 보고가 이보다 오래되면(초) 온도만 «—»(그림 흐림 규칙과 따로) */
export const TEMP_STALE_S = 3;
export type Temps = { joints: (number | null)[]; hot: number; battery: number | null; inside: number | null } | null;
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const top = (a: unknown[]) => { const f = a.map(num).filter((v): v is number => v != null); return f.length ? Math.max(...f) : null; };
/** 관절 12개(JOINTS 순서)·가장 뜨거운 관절·배터리 4개 중 최고·몸 안(자세 센서·본체) 중 최고. 연결이 끊겼거나 보고가 오래되면 null(지어내지 않음).
 *  ago = 이 state 를 받은 뒤 화면 시계로 지난 초 — 나이 = age_s + ago(RV-409 4: 다음 보고를 기다리지 않고 3초 넘으면 «—») */
export function go2Temps(s: Live['state'], fresh: boolean, ago = 0): Temps {
  const t = s?.robot_info?.temperature;   // 계약 Go2Temperature(#407) — 값 없으면 키 없음. 받은 값은 그래도 수·길이를 확인
  if (!fresh || s?.connection !== 'ONLINE' || !t || !(t.age_s + ago <= TEMP_STALE_S)) return null;
  const joints = Array.isArray(t.joints) && t.joints.length === 12 ? t.joints.map(num) : JOINTS.map(() => null), hi = top(joints);
  return { joints, hot: hi == null ? -1 : joints.indexOf(hi), battery: top(Array.isArray(t.battery) ? t.battery : []), inside: top([t.imu, ...(Array.isArray(t.body) ? t.body : [])]) };
}
const deg = (v: number | null | undefined) => (v == null ? '—' : `${Math.round(v)}°C`);

const POSTURE: Record<string, string> = { STANDING: '서 있음', LYING: '엎드림', TRANSITIONING: '바뀌는 중', UNKNOWN: '모름' };
const n1 = (v: number | undefined) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(1));

/** 가운데 칸 하나 — 이 칸이 그려지는 동안만 그 채널을 받는다(작은 칸 숨김 = 받기 끝) */
function Feed({ robot, ch, big }: { robot: string; ch: Exclude<DriveCh, 'lidar'>; big: boolean }) {
  return <DriveView f={useDriveFeed(robot, ch)} ch={ch} big={big} />;
}

/** 오른쪽 칸: 층 고르기 → 지도 만들기(mapmake 그대로) · 속도 · 시나리오(목록) · 목표 */
function RightCol({ c, r, trial }: { c: Ctx; r: Robot; trial: ReactNode }) {
  const t = useTree(c.cancel), places = floorsOf(t.tree).filter((p) => purposeOf(p.site) === 'REAL');
  const here = rt.get(r.id).state?.location?.floor_id ?? r.location?.floor_id ?? '';
  const [pick, setPick] = useState(''), p = places.find((x) => x.floor.id === pick) ?? places.find((x) => x.floor.id === here) ?? places[0];
  const fid = p?.floor.id ?? '', [list, setList] = useState<MapVersion[] | null>(null), [scen, setScen] = useState<Scenario[] | null>(null), [scenErr, setScenErr] = useState('');
  const [chosen, setChosen] = useState(''), [made, setMade] = useState(''), [n, setN] = useState(0);
  useEffect(() => {
    setList(null); setScen(null); setScenErr(''); setChosen('');
    if (!fid) return;
    const ac = new AbortController();
    api.versions(fid, ac.signal).then(setList, () => setList([]));
    api.plans('scenarios', false, null, ac.signal, { mine: false, floor: fid }).then((x) => setScen(x.items), (e: ApiFail) => { if (e.code !== 'CANCELED') setScenErr(e.message); });
    return () => ac.abort();
  }, [fid, n]);
  const many = new Set(places.map((x) => x.building.id)).size > 1;
  return <div className="pd-right">
    <section className="lv-card pd-sec" aria-label="층">
      <label className="fh-row lbl">층<select className="fh-user fh-sel" aria-label="층" data-pd-floor value={fid} onChange={(e) => { setPick(e.target.value); setMade(''); }} disabled={!places.length}>
        {!places.length && <option value="">{t.tree ? '실기 층 없음' : '불러오는 중…'}</option>}
        {places.map((x) => <option key={x.floor.id} value={x.floor.id}>{many ? `${x.building.name} ${x.floor.name}` : `${x.site.name} · ${x.floor.name}`}</option>)}</select></label>
      {t.err && <p className="fh-msg" role="alert">층 목록을 받지 못했습니다. {t.err}</p>}
    </section>
    <section className="lv-card pd-sec" aria-label="지도 만들기" data-pd-make>
      <h3>지도 만들기</h3>
      {!p ? <p className="lv-note">지도 탭에서 실기 장소·층을 만들면 여기서 지도를 그릴 수 있습니다.</p>
        : <MakeMap key={fid} bare floor={fid} user={c.user} robots={[r]} places={places} cancel={c.cancel} approved={p.floor.approved_version_id ?? null} list={list}
          made={() => { setMade('새 지도를 저장했습니다. 지도 탭에서 확인·승인하세요.'); setN((k) => k + 1); c.refresh(); }} />}
      {made && <p className="fh-msg ok" role="status">{made}</p>}
    </section>
    <section className="lv-card pd-sec" aria-label="속도" data-pd-speed>
      <h3>속도</h3>
      <div className="fh-row" role="group" aria-label="속도 단계">
        {/* 서버·에이전트 허용 표가 고정 값 하나라 지금은 «보통»만(표 밖 값은 화면이 만들지 않음) */}
        <button type="button" className="btn" disabled title="준비 중">느림</button>
        <button type="button" className="btn" aria-pressed="true" data-pd-speed-on>보통(지금 값)</button>
        <button type="button" className="btn" disabled title="준비 중">빠름</button>
      </div>
      <p className="lv-note">느림·빠름은 준비 중입니다. 앞뒤 1.5 m/s · 옆걸음 1.0 m/s · 회전 최대 {MAX_TURN_RATE} rad/s. 회전 키나 단추를 누르고 있으면 2초에 걸쳐 빨라집니다.</p>
    </section>
    <section className="lv-card pd-sec" aria-label="시나리오" data-pd-scen>
      <h3>시나리오</h3>
      {scenErr ? <p className="fh-msg" role="alert">시나리오 목록을 받지 못했습니다. {scenErr}</p>
        : !fid ? <p className="lv-note">층을 고르면 그 층 시나리오가 보입니다.</p>
        : !scen ? <p className="lv-note" role="status">불러오는 중…</p>
        : !scen.length ? <p className="lv-note">이 층에 시나리오가 없습니다.</p>
        : <label className="fh-row lbl">고르기<select className="fh-user fh-sel" aria-label="시나리오" value={chosen} onChange={(e) => setChosen(e.target.value)}>
          <option value="">고르지 않음</option>{scen.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>}
      <p className="lv-note">실기 시나리오 실행은 준비 중입니다(고르기만).</p>
    </section>
    <section className="lv-card pd-sec" aria-label="목표" data-pd-goal>
      <h3>목표</h3>
      <button type="button" className="btn" disabled>지도에서 목표 찍기 — 준비 중</button>
    </section>
    {trial}
  </div>;
}

/** 세 칸 조종 화면. back = 목록으로. floorMap = 고른 층 지도(fleet FleetMap — 로봇 위치 점) */
export function PcDrive({ c, r, back, floorMap }: { c: Ctx; r: Robot; back: () => void; floorMap: ReactNode }) {
  const d = useServerDrive(c, r), { l, s, mine } = d;
  // 라이다 하나를 지도 칸(쌓이는 지도)·라이다 칸(3D)이 같이 본다 — 둘 다 안 보이면(카메라·뎁스만) 구독을 놓는다(RV-397 4)
  const [wantLidar, setWantLidar] = useState(true), lidar = useDriveFeed(r.id, 'lidar', wantLidar), stack = stacked(lidar);
  const ago = s ? (rt.now() - l.stateAt) / 1000 : null, a = s?.applied ?? null;
  const fresh = !!s && rt.now() - l.stateAt < REPORT_STALE_MS, pose = go2Pose(s, fresh), temps = go2Temps(s, fresh, ago ?? 0), motion = useGo2Motion(s?.robot_info, pose);
  const [tags, setTags] = useState(true);
  // 로봇 연결 끊김(useServerDrive off): 화면은 그대로, 조종 시작만 꺼 둔다(누른 것 버림·0·조종권 반납은 useServerDrive)
  const off = d.off;
  const server = LINK[d.link] ?? { tone: 'off' as const, text: '연결 중' };
  const robot = !s ? { tone: 'off' as const, text: '모름' } : s.connection === 'ONLINE' ? { tone: 'ok' as const, text: '연결' } : { tone: 'bad' as const, text: '끊김' };
  const why = !s?.latched ? '' : d.stalled ? STALLED : d.refused || (l.stop ? '정지 요청으로 잠겼습니다.' : '로봇이 정지 잠금을 알렸습니다 — 잠금 해제 전에 현장을 확인하세요.');
  const lidarText = driveFeedText(lidar, 'lidar');
  const tiles: QTile[] = [
    { id: 'map', label: stack ? '지도 — 걸으며 만드는 중' : '지도', body: (z) => (stack ? <OccMap small={z === 'thumb'} feed={lidar} empty={lidarText} /> : <div className="pd-floor">{floorMap}</div>) },
    { id: 'rgb', label: '카메라', body: (z) => <Feed robot={r.id} ch="rgb" big={z === 'big'} /> },
    { id: 'lidar', label: '라이다', body: (z) => <LidarMap small={z === 'thumb'} feed={lidar} empty={lidarText} /> },
    { id: 'depth', label: '뎁스', body: (z) => <Feed robot={r.id} ch="depth" big={z === 'big'} /> },
  ];
  const fact = (k: string, v: ReactNode, attr: string) => <div className="pd-fact" data-pd={attr}><span className="lbl">{k}</span><b>{v}</b></div>;
  return <section className="pd" aria-label="조종 화면" data-server-drive data-pc-drive>
    <div className="pd-top" data-pd-top>
      <button type="button" className="btn" onClick={back} data-pd-back>← 목록</button>
      <h2>{r.name}</h2><Chip tone="warn" text={TRIAL} /><Chip {...d.lock} />
      <span className="lbl pd-link" data-pd-link>서버 <Chip {...server} /> 로봇 <Chip {...robot} /></span>
      {mine ? d.end : off ? <button type="button" className="btn pri" disabled data-pd-begin-off>조종 시작</button> : d.begin}
      {d.unlock}{d.stopNote}
      <span className="fh-grow" />
      {d.stop(true)}
    </div>
    {off && <p className="fh-msg" role="status" data-pd-offline>로봇 연결이 끊겼습니다 · 다시 연결되면 «조종 시작»을 다시 누르세요</p>}
    {d.latency}
    {d.notes}
    {d.releasing}
    <div className="pd-cols">
      <section className="lv-card pd-left" aria-label="로봇 상태" data-pd-left data-stale={pose ? undefined : ''}>
        <div className="pd-facts" data-pd-facts>
          {fact('자세', POSTURE[s?.posture?.state ?? ''] ?? '모름', 'posture')}
          {fact('움직일 수', d.lock.text, 'move')}
          {fact('배터리', s?.battery?.soc != null ? `${s.battery.soc}%` : '—', 'battery')}
          {fact('관절 최고 온도', temps && temps.hot >= 0 ? `${deg(temps.joints[temps.hot])} (${jointName(JOINTS[temps.hot])})` : '—', 'temp-joint')}
          {fact('배터리 온도', deg(temps?.battery), 'temp-battery')}
          {fact('몸 안 온도', deg(temps?.inside), 'temp-inside')}
          {fact('수평 속도', s?.speed != null ? `${s.speed.toFixed(1)} m/s` : '—', 'hspeed')}
          {fact('보내는 속도', a ? `앞뒤 ${n1(a[0])} · 옆 ${n1(a[1])} m/s · 회전 ${n1(a[2])} rad/s` : '—', 'speed')}
          {fact('조종하는 사람', holderText(l, c.user.id, r), 'holder')}
          {fact('마지막 보고', ago == null ? '없음' : `${ago.toFixed(1)}초 전`, 'ago')}
          {why && fact('잠긴 까닭', why, 'why')}
          <button type="button" className="btn pd-tags" aria-pressed={tags} onClick={() => setTags((v) => !v)} data-pd-tags>관절 값</button>
        </div>
        <div className="pd-stage" data-pd-stage>
          <Go2Figure pose={pose} motion={motion} showJoints={tags} temps={temps?.joints} />
          {!pose && <span className="pd-noreport" role="status" data-pd-noreport>로봇 보고 없음</span>}
        </div>
        {d.poseRow}
        {d.pad}
        {mine && <p className="lv-note">{d.hint}</p>}
      </section>
      <section className="pd-mid" aria-label="지도·카메라·라이다·뎁스">
        <Quad label="조종 보기 4칸" first="map" tiles={tiles} fs={<>{d.stopNote}{d.stop(true)}</>} onLeave={() => d.zero()}
          onShown={(ids) => setWantLidar(ids.includes('map') || ids.includes('lidar'))} />
      </section>
      <RightCol c={c} r={r} trial={d.trial} />
    </div>
  </section>;
}

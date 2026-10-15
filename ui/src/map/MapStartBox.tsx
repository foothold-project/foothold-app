// «지도 열기»: 지도용 Gazebo 시뮬을 1회 시작(op map_start → RL 래퍼) + «SLAM 지도 저장»(op map_save → /v2_map/save).
// 위의 «지도 보기» 선택(화면만)과 별개 — 실제 Gazebo 지형·층을 바꾸는 건 이 상자의 «지도 열기» 버튼뿐(끄고 새로 열기).
// 평지 시뮬(op sim_start, 지도·라이다 없음)은 이 상자에 없다 — 관제·조종 화면의 «시뮬 시작». 계약 id(world_id·floor_id·mode)는 그대로, 화면 이름만 바꿈.
// 상시 표시: 고른 곳 · 지금 실제 실행 중인 곳 · 열 수 있나(서버 why) · 다음 행동 · 마지막 요청 결과. 자동 기동·중단·재시도 0.
import { useState } from 'react';
import { create } from 'zustand';
import type { MapInfo } from '@contracts';
import { ask, dropAll, useLink } from '../data/link';
import { whyProps } from '../app/shell';
import { BLD, FLOOR, TASK, WF, mapKey, listMaps, place, runAt, runLine, type Sess } from '../data/maps';

type W = 'v5_single' | 'v5_building' | 'rooms_a';
const PLACES: { w: W; sub: string }[] = [
  { w: 'v5_single', sub: '단층 · 계단 위끝 낭떠러지 있음' },
  { w: 'v5_building', sub: '1·2층이 연결된 한 건물 · 시작층만 고름 · 실제 계단·경사로 통과 미검증' },
  { w: 'rooms_a', sub: 'SLAM 지도 만들기용' },
];
type Res = { t: string; ok: boolean; text: string; what: string; key?: string } | null;   // key = 목록에서 확인된 저장본(보기 버튼)
// 마지막 요청 결과는 화면을 오가도 남게(이 기기 메모리만 — 새로고침하면 서버 «최근 결과»만)
const useRes = create<{ open: Res; save: Res }>(() => ({ open: null, save: null }));
const now = () => new Date().toTimeString().slice(0, 8);

/** 서버 거부 이유(why) → 사용자가 할 일 한 줄. 모르는 이유는 서버 글 그대로 보라고만(추측 0) */
export function nextStep(why: string | null | undefined): string {
  const w = why || '';
  if (!w) return '';
  if (w.startsWith('로그인한 기기에서만')) return '관문 주소(https)로 로그인한 기기에서 여세요';
  if (w.startsWith('Gazebo 가 이미 켜짐')) return '지금 켜진 시뮬을 먼저 «Gazebo 끄기» → 꺼짐 확인 뒤 다시 «지도 열기»';
  if (w.startsWith('방금 요청함')) return '표시된 시간이 지난 뒤 다시 누르세요(평지·지도 시작이 같은 120 s 간격을 씀 · 자동 재시도 없음)';
  if (w.includes('조종 중')) return '조종 중인 기기에서 STOP·조종권 반납 뒤 다시';
  if (w.includes('처리 중') || w.includes('진행 중')) return '진행 중인 요청이 끝날 때까지 기다리세요';
  if (w.includes('미확인') || w.includes('확인 못 함')) return '서버 상태 확인 중 — 잠시 뒤 다시(자동 재시도 없음)';
  if (w.includes('SLAM 실시간 지도가 보일 때만')) return '«SLAM 지도 만들기»로 연 뒤, 실시간 지도가 보일 때 저장';
  if (w.includes('저장 서비스 없음')) return '지도 시뮬이 완전히 켜진 뒤 다시(저장 서비스 대기)';
  return '위 서버 이유를 확인한 뒤 다시';
}

/** 저장 요청 때 출처(건물·층·epoch·연결 세대) → 결과 판정. 응답 ok + 다시 받은 목록에 같은 world·건물·층·버전이 있어야 «확인됨».
 *  응답 사이 epoch·층·연결이 바뀌었으면 그 출처 결과로만 따로 적고 «지금 지도 저장 성공»으로 쓰지 않음. 버전 = 서버 고정 문구 «지도 저장됨 · <버전>»(기존 reply 에 구조 칸 없음) */
export type SaveSrc = { world_id: string | null; building_id: string | null; floor_id: string | null; epoch: number | null; floor_rev: number | null; gen: number };
const CTX = ['world_id', 'building_id', 'floor_id', 'epoch', 'floor_rev'] as const;
/** 저장 응답 판정 — 요청 때 출처(req)로만. 서버가 확인한 응답 문맥(r.save)이 있으면 req 와 정확히 같아야, 연결 건물(floor_rev 있음)은 필수(늦은 다른 층 결과 성공 0) */
export function saveVerdict(req: SaveSrc, r: { ok: boolean; text: string; save?: Record<string, unknown> | null }, list: MapInfo[] | string, now: SaveSrc, t: string): NonNullable<Res> {
  const sv = r.save, svOk = !!sv && CTX.every((k) => (sv[k] ?? null) === req[k]) && typeof sv.map_version === 'string';
  if (r.ok && (sv ? !svOk : req.floor_rev != null))
    return { t, ok: false, text: `${place(req.world_id, req.floor_id)}(요청 때 지도) 결과 미확인 · 응답 문맥이 요청과 다르거나 없음 — 이번 요청 성공으로 안 씀, 목록 다시 확인`, what: `${place(req.world_id, req.floor_id)}(요청 때 지도)` };
  const ver = !r.ok ? undefined : svOk ? sv!.map_version as string : /지도 저장됨 · (\S+)/.exec(r.text || '')?.[1];
  const hit = ver && Array.isArray(list) ? list.find((m) => m.world_id === req.world_id && m.building_id === req.building_id && m.floor_id === req.floor_id && m.map_version === ver) : undefined;
  const moved = now.gen !== req.gen || now.epoch !== req.epoch || now.world_id !== req.world_id || now.floor_id !== req.floor_id || now.floor_rev !== req.floor_rev;
  const src = `${place(req.world_id, req.floor_id)}(요청 때 지도)`;
  if (!r.ok) return { t, ok: false, text: r.text || '응답 없음(결과 미확인)', what: src };
  if (!hit) return { t, ok: false, text: `${r.text} · 목록에 그 건물·층·버전 없음(목록 다시 받기)`, what: src };
  return moved ? { t, ok: false, text: `${src} 결과 · ${r.text} · 목록 확인됨 — 지금 열린 지도와 다름(지금 지도 저장으로 안 씀)`, what: src, key: mapKey(hit) }
    : { t, ok: true, text: `${r.text} · 목록 확인됨`, what: mapKey(hit), key: mapKey(hit) };
}

/** U4-a: SLAM 지도 저장이 지금 안 되는 이유(운영 한 줄 + 다음 행동). 서버 why 의 지금 이유(끊김·층 이동·리셋·오류)를 일반 조건으로 덮지 않고,
 *  끊긴 초·서비스 경로만 원문(raw → 개발자 모드)으로. null = 저장 가능(서버 ok — 판정은 서버 그대로, 새 막음 0) */
export function saveBlock(sv: { ok: boolean; why?: string | null; busy?: boolean } | null | undefined, lvMode?: string | null): { txt: string; next: string; raw: string } | null {
  if (!sv) return { txt: '저장 상태 확인 안 됨', next: '서버 상태가 들어온 뒤 다시(자동 재시도 없음)', raw: '' };
  if (sv.ok) return null;
  const raw = sv.why || '';
  if (sv.busy) return { txt: '지도 저장 중', next: '끝날 때까지 기다리세요', raw };
  let txt = raw.replace(/ \d+(?:\.\d+)? s 끊김/, ' 끊김(오래됨)').replace('(/v2_map/save)', '') || '저장 안 됨 · 서버 이유 없음';
  if (raw === 'SLAM 실시간 지도가 보일 때만 저장' && lvMode === 'static') txt += ' · 지금은 저장 지도로 연 시뮬(SLAM 만들기 아님)';
  const next = /끊김|미수신/.test(raw) ? '지도 상태가 다시 들어오면 저장(자동 재시도 없음)' : /층 이동|층 미확인|층 확정|층 지도/.test(raw) ? '층 이동이 끝나 그 층 지도가 보이면 저장'
    : /리셋/.test(raw) ? '리셋이 끝나 새 지도가 보이면 저장' : /지도 오류|실패/.test(raw) ? '오류 원문을 확인한 뒤, 지도가 다시 보이면 저장' : nextStep(raw);
  return { txt, next, raw };
}

// part(U4-a PcMap): 'open' = 지도 열기만(PC 시뮬 메뉴) · 'save' = SLAM 지도 저장만(PC 지도 화면) · 없음 = 둘 다(폰 지도·다른 화면 시뮬 메뉴 — 기존 그대로).
// pc: 고른 곳·지금 실행·열 수 있음·서버 최근(성공)·기술 원값 = 개발자 모드(data-dev) / 고른 곳 ≠ 지금 실행·막힌 이유·다음·이 기기 결과·실패는 운영에 남김
// onShowLive: 지금 실시간 보기가 아닐 때만 받음 → «실시간 지도 보기»(화면 선택만 · 시작·조종 0). onView(key): 저장 지도 보기 선택(화면만)
export function MapStartBox({ pc, part, onSaved, onShowLive, onView }: { pc: boolean; part?: 'open' | 'save'; onSaved?: () => void; onShowLive?: () => void; onView?: (key: string) => void }) {
  const ms = useLink((x) => x.st?.map_start) || null, sv = useLink((x) => x.st?.map_save) || null, lv = useLink((x) => x.st?.live_map) || null;
  const [w, setW] = useState<W>('rooms_a'), [f, setF] = useState('f1'), [mode, setMode] = useState<'slam' | 'static'>('slam'), [ver, setVer] = useState('');
  const [vers, setVers] = useState<MapInfo[] | string | null>(null), [fc, setFc] = useState(true);   // fc: 외부 3인칭 렌더(기본 켬 — 서버 래퍼가 지원할 때만 보이고 보냄)
  const { open: rOpen, save: rSave } = useRes();
  const B = pc ? 'btn' : 'lv-btn', I = pc ? 'inp' : 'lv-inp', key = `${w}/${f}`, lg = ms?.ledger, ux = ms?.usage_scope === 'user_experience';
  const loadVers = () => listMaps().then((v) => { setVers(v); return v; });
  const mine = Array.isArray(vers) ? vers.filter((m) => m.building_id === BLD[w] && m.floor_id === f) : [];
  const used = !ux && !!lg && lg.keys.includes(key), fcOn = fc && ms?.follow_cam_ok === true;
  const can = !!ms?.ok && !used && (mode === 'slam' || !!ver);
  const sel = `${place(w, f)} · ${mode === 'slam' ? `${TASK.slam}(직접 조종)` : `${TASK.static} · ${ver || '버전 고르기'}`}`;

  // 지금 실제로 켜진 것(서버 세션 — 고른 것과 별개)
  const ss = ms?.session as Sess, run = runLine(ss), at = runAt(ss);
  const other = !!at && `${at[0]}/${at[1]}` !== `${BLD[w]}/${f}`;

  const start = async () => {
    if (!ms?.ok) return;
    if (mode === 'static' && !ver) return;
    dropAll();
    if (!confirm(`지도를 열까요? (Gazebo 시뮬 시작)\n· ${sel}${ux ? '\n· 횟수 제한 없음(동시 1개 · 30분 뒤 자동 종료)' : `\n· 지도 원장 1회 사용${lg ? ` (지금 ${lg.used}/${lg.max})` : ''}`}\n· 외부 3인칭 카메라(Gazebo 렌더 추가): ${fcOn ? '켬 — 렌더 1개 추가, 부하 미검증(느려지면 세션이 멈출 수 있음)' : '끔'}\n· STOP 상태로 시작, 자동 재시작·연장 없음`)) return;
    const r = await ask('map_start', { world_id: w, floor_id: f, mode, ...(mode === 'static' ? { map_version: ver } : {}), follow_cam: fcOn });
    useRes.setState({ open: { t: now(), ok: !!r.ok, text: r.text || '응답 없음(결과 미확인)', what: sel } });
  };
  const src = (): SaveSrc => { const s = useLink.getState(), l = s.st?.live_map; return { world_id: l?.world_id ?? null, building_id: l?.building_id ?? null, floor_id: l?.floor_id ?? null, epoch: l?.epoch ?? null, floor_rev: l?.floor_rev ?? null, gen: s.gen }; };
  const save = async () => {
    if (!sv?.ok) return;
    const req = src();                           // 요청 때 출처 캡처(응답 뒤 현재 값으로 판정하지 않음)
    const r = await ask('map_save', {}, 12000);   // 서버 제한 10 s + 여유. 넘으면 «결과 미확인»(늦게 저장될 수 있음) — 자동 재요청 0
    const v = await listMaps(); setVers(v); onSaved?.();   // 화면을 떠났어도 결과는 전역(useRes)에 출처와 함께 남음
    useRes.setState({ save: saveVerdict(req, r, v, src(), now()) });
  };

  const row = { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' } as const;
  const kv = (a: string, b: React.ReactNode, c?: string, dev?: boolean) => <span data-dev={pc && dev ? '' : undefined} style={{ display: 'flex', gap: 6 }}><span className="lbl" style={{ flex: '0 0 74px' }}>{a}</span><span style={c ? { color: `var(--${c})` } : undefined}>{b}</span></span>;
  const seg = (on: boolean) => ({ 'aria-pressed': on, className: `${B}${on ? ' pri' : ''}`, type: 'button' as const });
  const blk = pc ? saveBlock(sv, lv?.mode) : null;
  return <div id={part === 'save' ? undefined : 'fh-mapopen'} style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 }}>
    {part !== 'save' && <>
    {!pc && <b style={{ fontSize: 13 }}>지도 열기 · Gazebo 시뮬 시작</b>}
    <span className="lbl">{pc ? '«지도 보기»는 화면만 바뀝니다. 실제 시뮬 지형·층을 바꾸는 건 «지도 열기»뿐(끄고 새로 열기).' : '위 «지도 보기»는 화면만 바뀝니다. 실제 시뮬 지형·층을 바꾸는 건 이 «지도 열기»뿐(끄고 새로 열기).'}</span>
    <span role="group" aria-label="지형" style={row}>
      {PLACES.map((p) => <button key={p.w} {...seg(w === p.w)} title={p.sub}
        onClick={() => { setW(p.w); setF(WF[p.w][0]); setVer(''); if (p.w === 'rooms_a') setMode('slam'); }}>{place(p.w, WF[p.w][0]).split(' · ')[0]}</button>)}
    </span>
    <span className="lbl">{PLACES.find((p) => p.w === w)!.sub}</span>
    {WF[w].length > 1 && <span role="group" aria-label="시작층(2층 건물 · 열 때만)" style={row}>
      <span className="lbl">시작층</span>
      {WF[w].map((k) => <button key={k} {...seg(f === k)} onClick={() => { setF(k); setVer(''); }}>{`${FLOOR[k as keyof typeof FLOOR]}(${k})`}</button>)}</span>}
    <span style={row}>
      <select className={I} aria-label="여는 방식" value={mode} onChange={(e) => { setMode(e.target.value as 'slam' | 'static'); setVer(''); if (e.target.value === 'static') loadVers(); }}>
        <option value="slam">{TASK.slam}</option><option value="static">{TASK.static}</option></select>
      {mode === 'static' && <select className={I} aria-label="저장 지도 버전" value={ver} onFocus={() => { loadVers(); }} onChange={(e) => setVer(e.target.value)}>
        <option value="">버전 고르기</option>
        {mine.map((m) => <option key={m.map_version} value={m.map_version}>{`${m.map_version} · ${m.map_source === 'gt_raster' ? '시뮬 도면' : 'SLAM'}`}</option>)}
        {typeof vers === 'string' && <option disabled value="-">{`목록 · ${vers}`}</option>}
        {Array.isArray(vers) && !mine.length && <option disabled value="-">이 층 저장 지도 없음</option>}</select>}
    </span>
    {mode === 'static' && <span className="lbl">{`실제 ${pc ? '' : 'Gazebo '}시뮬을 켭니다(화면만 보기는 위 «지도 보기» 선택).${mine.find((m) => m.map_version === ver)?.map_source === 'slam' ? ' 저장 SLAM 지도 — 위치 추정 없음 · 자동 이동 없음(직접 조종).' : ''}`}</span>}
    {ms?.follow_cam_ok === true && <label style={{ ...row, gap: 4 }}><input type="checkbox" checked={fc} onChange={(e) => setFc(e.target.checked)} />
      {pc ? '외부 3인칭 카메라(렌더 추가) · 부하 미검증 · 지도 열기에만(평지 시뮬엔 없음)' : '외부 3인칭 카메라(Gazebo 렌더 추가) · 부하 미검증 · 지도 열기에만(평지 시뮬엔 없음)'}</label>}
    <button type="button" className={`${B} pri`} disabled={!can} onClick={start}>{used ? `${place(w, f)} 원장 사용함` : `지도 열기 · ${place(w, f)}`}</button>
    <div role="status" style={{ display: 'flex', flexDirection: 'column', gap: 3, padding: '6px 8px', border: '1px solid var(--line2)', borderRadius: 6 }}>
      {kv('고른 곳', sel, undefined, true)}
      {kv('지금 실행', run, other ? 'warn' : undefined, true)}
      {other && kv('', pc ? `고른 곳 ≠ 지금 실행(${run}) — 바꾸려면 시뮬 끄고 새로 열기` : '고른 곳과 지금 실행 중인 곳이 다릅니다 — 바꾸려면 끄고 새로 열기', 'warn')}
      {kv('열 수 있나', !ms ? '서버 상태 없음(연결 확인)' : ms.ok ? (mode === 'static' && !ver ? '저장 지도 버전을 고르면 열 수 있음' : '열 수 있음') : `안 됨 · ${ms.why}`, ms?.ok ? 'ok' : 'warn', !!ms?.ok && !(mode === 'static' && !ver))}
      {ms && !ms.ok && kv('다음', nextStep(ms.why))}
      {rOpen && kv('이 기기 요청', `${rOpen.t} · ${rOpen.what} → ${rOpen.ok ? '요청 수락(아직 켜진 것 아님 — «지금 실행»으로 확인)' : `거부 · ${rOpen.text}`}`, rOpen.ok ? 'ok' : 'bad')}
      {rOpen && !rOpen.ok && kv('다음', nextStep(rOpen.text))}
      {ms?.last && kv('서버 최근', `${ms.last.t} · ${ms.last.text}`, ms.last.st === 'ok' ? 'ok' : 'bad', ms.last.st === 'ok')}
      <details data-dev={pc ? '' : undefined}><summary className="lbl">상태 상세(기술 원값)</summary>
        <span className="lbl" style={{ wordBreak: 'break-all' }}>{`고른 것 world_id=${w} floor_id=${f} mode=${mode}${ver ? ` map_version=${ver}` : ''} · 실행 runner=${ss?.runner ?? '-'} world_id=${ss?.world_id ?? '-'} floor_id=${ss?.floor_id ?? '-'} map_mode=${ss?.map_mode ?? '-'} result=${ss?.result ?? '-'} · 실시간 지도 st=${lv?.st ?? '-'} epoch=${lv?.epoch ?? '-'} topic=/v2_map/map`}</span></details>
    </div>
    {onShowLive && (rOpen?.ok || (lv && lv.st !== 'off')) && <button type="button" className={B} onClick={onShowLive}>현재 열린 지도 보기(화면만)</button>}
    <span className="lbl">평지 시뮬(지도·라이다 없음)은 다른 경로 — 관제·조종 화면의 «시뮬 시작».{ux ? ' 횟수 제한 없음(동시 1개 · 30분 뒤 자동 종료).' : ` 지도 원장 ${lg ? `${lg.used}/${lg.max}` : '미확인'}.`}</span>
    </>}

    {part !== 'open' && <>
    <b style={{ fontSize: 13, marginTop: part === 'save' ? 0 : 6 }}>SLAM 지도 저장</b>
    {pc ? <>   {/* U4-a: 막히면 회색(aria-disabled) + 누르면 지금 이유 · 다음(전송 0, save() 의 sv.ok 관문 그대로). 일반 조건 글로 지금 이유를 덮지 않음 */}
      {!blk && <span className="lbl">{lv?.mode === 'slam' && lv.st === 'ok' ? `${place(lv.world_id, lv.floor_id)}에 새 버전으로 저장(버전 이름 = 저장 시각·epoch, 서버가 정함 · 덮어쓰기 없음)` : '저장할 수 있음(서버 확인)'}</span>}
      <button type="button" {...(blk ? { ...whyProps(`${blk.txt} — ${blk.next}`), className: `${B} lv-why` } : { className: B, onClick: save })}>{sv?.busy ? '지도 저장 중…' : 'SLAM 지도 저장'}</button>
      {blk && <>{kv('저장 안 됨', blk.txt, 'warn')}{kv('다음', blk.next)}{blk.raw && blk.raw !== blk.txt && kv('원문', blk.raw, undefined, true)}</>}
    </> : <>
    <span className="lbl">{lv?.mode === 'slam' && lv.st === 'ok' ? `${place(lv.world_id, lv.floor_id)}에 새 버전으로 저장(버전 이름 = 저장 시각·epoch, 서버가 정함 · 덮어쓰기 없음)` : '«SLAM 지도 만들기»로 연 시뮬에서 실시간 지도가 보일 때 저장할 수 있습니다'}</span>
    <button type="button" className={B} disabled={!sv?.ok} onClick={save}>{sv?.busy ? '지도 저장 중…' : 'SLAM 지도 저장'}</button>
    {sv && !sv.ok && !sv.busy && <>{kv('저장 안 됨', sv.why, 'warn')}{kv('다음', nextStep(sv.why))}</>}
    </>}
    {rSave && kv('이 기기 저장', `${rSave.t} · ${rSave.text}`, rSave.ok ? 'ok' : 'bad')}
    {rSave?.key && onView && <button type="button" className={B} onClick={() => onView(rSave.key!)}>{`저장한 버전 보기(화면만)${rSave.ok ? '' : ' · 요청 때 지도'}`}</button>}
    {lv?.last_save && kv('서버 최근', `${lv.last_save.ok ? '성공' : '실패'} · ${lv.last_save.map_version || '버전 없음'}${lv.last_save.reason ? ` · ${lv.last_save.reason}` : ''}`)}
    {part !== 'save' && <span className="lbl">저장 지도는 높이가 없는 2D 점유 격자(occupancy)입니다 — 계단·벽 높이 정보 없음.</span>}   {/* save(PcMap): 지도 «?» 설명으로 옮김 */}
    </>}
  </div>;
}

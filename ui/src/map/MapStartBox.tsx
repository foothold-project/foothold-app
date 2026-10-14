// «지도 체험 시작»(RL start_map.sh 1회) + SLAM 실시간일 때만 «지도 저장»(/v2_map/save). 지도 보기 선택과 별개 — 세계를 바꾸는 건 이 버튼뿐.
// 원장 두 개는 섞지 않는다: 지도 체험(map_ledger) ↔ 기존 체험(시뮬 시작). 실행 가능 여부·거부 이유는 서버 map_start/map_save 상태를 그대로 쓴다
import { useState } from 'react';
import type { MapInfo } from '@contracts';
import { ask, dropAll, useLink } from '../data/link';
import { BLD, FLOOR, WF, WORLD, listMaps } from '../data/maps';
import { toast } from '../app/shell';

type W = keyof typeof WORLD;

// onShowLive: 지금 실시간 보기가 아닐 때만 받음 → «실시간 지도 보기» 버튼(화면 선택만 바꿈 · 시작·조종 0)
export function MapStartBox({ pc, onSaved, onShowLive }: { pc: boolean; onSaved?: () => void; onShowLive?: () => void }) {
  const ms = useLink((x) => x.st?.map_start) || null, sv = useLink((x) => x.st?.map_save) || null, lv = useLink((x) => x.st?.live_map) || null;
  const [w, setW] = useState<W>('rooms_a'), [f, setF] = useState('f1'), [mode, setMode] = useState<'slam' | 'static'>('slam'), [ver, setVer] = useState('');
  const [vers, setVers] = useState<MapInfo[] | string | null>(null), [started, setStarted] = useState(false);
  const B = pc ? 'btn' : 'lv-btn', I = pc ? 'inp' : 'lv-inp', key = `${w}/${f}`, lg = ms?.ledger;
  const loadVers = () => { listMaps().then(setVers); };
  const mine = Array.isArray(vers) ? vers.filter((m) => m.building_id === BLD[w] && m.floor_id === f) : [];
  const used = !!lg && lg.keys.includes(key);
  const can = !!ms?.ok && !used && (mode === 'slam' || !!ver);

  const start = async () => {
    if (!ms?.ok) return toast(`지도 체험 시작 안 됨 · ${ms?.why || '서버 응답 없음'}`);
    if (used) return toast(`${key} 는 이미 사용(지형·층마다 1회)`);
    if (mode === 'static' && !ver) return toast('저장 지도 버전을 고르세요');
    dropAll();
    if (!confirm(`지도 체험을 시작할까요?\n· ${WORLD[w]} ${FLOOR[f as keyof typeof FLOOR]} · ${mode === 'slam' ? 'SLAM 지도 만들기(직접 조종)' : `저장 지도 ${ver}`}\n· 지도 체험 원장 1회 사용${lg ? ` (지금 ${lg.used}/${lg.max})` : ''} — 기존 체험 원장과 별개\n· STOP 상태로 시작, 자동 재시작·연장 없음`)) return;
    const r = await ask('map_start', { world_id: w, floor_id: f, mode, ...(mode === 'static' ? { map_version: ver } : {}) });
    toast(r.text || '응답 없음'); if (r.ok) setStarted(true);
  };
  const save = async () => {
    if (!sv?.ok) return toast(`지도 저장 안 됨 · ${sv?.why || '서버 응답 없음'}`);
    const r = await ask('map_save', {}, 12000);   // 서버 제한 10 s + 여유. 넘으면 «결과 미확인»(늦게 저장될 수 있음) — 자동 재요청 0
    toast(r.text || '응답 없음'); loadVers(); onSaved?.();
  };

  const row = { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' } as const;
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 }}>
    <b>지도 체험 시작</b>
    <span style={row}>
      <select className={I} aria-label="지형" value={w} onChange={(e) => { const x = e.target.value as W; setW(x); setF(WF[x][0]); setVer(''); }}>
        {(Object.keys(WORLD) as W[]).map((k) => <option key={k} value={k}>{WORLD[k]}</option>)}</select>
      <select className={I} aria-label="층" value={f} onChange={(e) => { setF(e.target.value); setVer(''); }}>
        {WF[w].map((k) => <option key={k} value={k}>{FLOOR[k as keyof typeof FLOOR]}</option>)}</select>
      <select className={I} aria-label="모드" value={mode} onChange={(e) => { setMode(e.target.value as 'slam' | 'static'); setVer(''); if (e.target.value === 'static') loadVers(); }}>
        <option value="slam">SLAM 지도 만들기</option><option value="static">저장 지도로</option></select>
      {mode === 'static' && <select className={I} aria-label="저장 지도 버전" value={ver} onFocus={loadVers} onChange={(e) => setVer(e.target.value)}>
        <option value="">버전 고르기</option>
        {mine.map((m) => <option key={m.map_version} value={m.map_version}>{`${m.map_version} · ${m.map_source === 'gt_raster' ? 'GT 기하' : 'SLAM'}`}</option>)}
        {typeof vers === 'string' && <option disabled value="-">{`목록 · ${vers}`}</option>}
        {Array.isArray(vers) && !mine.length && <option disabled value="-">이 층 저장 지도 없음</option>}</select>}
    </span>
    <span className="lbl">{`지도 체험 원장 ${lg ? `${lg.used}/${lg.max}${lg.keys.length ? ` · 사용: ${lg.keys.join(', ')}` : ''}` : '미확인'} · 기존 체험(시뮬 시작) 원장과 별개`}</span>
    <button type="button" className={`${B} pri`} disabled={!can} onClick={start}>{used ? `${key} 사용함` : '지도 체험 시작'}</button>
    {ms && !ms.ok && <span style={{ color: 'var(--warn)' }}>{`시작 안 됨 · ${ms.why}`}</span>}
    {ms?.last && <span style={{ color: `var(--${ms.last.st === 'ok' ? 'ok' : 'bad'})` }}>{`최근 ${ms.last.t} · ${ms.last.text}`}</span>}
    {onShowLive && (started || (lv && lv.st !== 'off')) && <button type="button" className={B} onClick={onShowLive}>실시간 지도 보기(화면만)</button>}
    <span className="lbl">위 «지도 보기» 선택은 화면만 바꿉니다. 세계·층을 바꾸는 건 이 버튼뿐(끄고 새로 시작).</span>
    {lv?.mode === 'slam' && <>
      <button type="button" className={B} disabled={!sv?.ok} onClick={save}>{sv?.busy ? '지도 저장 중…' : '지도 저장(SLAM)'}</button>
      {sv && !sv.ok && !sv.busy && <span className="lbl">{`저장 안 됨 · ${sv.why}`}</span>}
      {lv.last_save && <span className="lbl">{`최근 저장 · ${lv.last_save.ok ? '성공' : '실패'} · ${lv.last_save.map_version || '버전 없음'}${lv.last_save.reason ? ` · ${lv.last_save.reason}` : ''}`}</span>}
    </>}
  </div>;
}

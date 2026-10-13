// 수동 임무 기록 버튼(휴대폰 현황·PC 조종 공용) — live.js btn/wpActs/endRow
import type { RunWaypoint } from '@contracts';
import { attachPhoto, isoNow, runEdit, runEnd } from '../data/run';

export const Btn = ({ t, on, pri, ...p }: { t: string; on: () => void; pri?: boolean } & React.ButtonHTMLAttributes<HTMLButtonElement>) =>
  <button type="button" className={`lv-btn${pri ? ' pri' : ''}`} onClick={on} {...p}>{t}</button>;

// 지점 기록 버튼: 방문 확인(시각 기록)·미방문 사유·운영자 판단·사진 (live.js wpActs)
export function WpActs({ id, i, w }: { id: string; i: number; w: RunWaypoint }) {
  const n = `WP${i + 1}`, set = (o: Partial<RunWaypoint>, what: string) => runEdit(id, (d) => { Object.assign(d.wps[i], o); }, what);
  return (
    <div className="lv-row">
      {w.st === '대기' ? <>
        <Btn pri t="방문 확인" on={() => set({ st: '방문', at: isoNow(), why: '' }, `${n} 방문 확인`)} />
        <Btn t="미방문…" on={() => { const y = prompt(`${n} 미방문 사유(예: 길 막힘·위험·시간 부족)`); if (y && y.trim()) set({ st: '미방문', at: '', why: y.trim().slice(0, 120) }, `${n} 미방문`); }} />
      </> : <Btn t="대기로 되돌리기" on={() => set({ st: '대기', at: '', why: '' }, `${n} 되돌림`)} />}
      {w.mods.includes('운영자 확인') && (['확인', '보류', '제외'] as const).map((c) =>
        <Btn key={c} t={c} aria-pressed={w.chk === c} title="운영자 판단(로봇 자동 판정 아님)" on={() => runEdit(id, (d) => { d.wps[i].chk = d.wps[i].chk === c ? '' : c; }, `${n} 운영자 판단 ${c}`)} />)}
      <Btn t="📷 사진" on={() => attachPhoto(id, i)} />
    </div>);
}


export const EndRow = ({ id }: { id: string }) =>
  <div className="lv-row">{(['완료', '실패', '중단'] as const).map((s) => <Btn key={s} pri={s === '완료'} t={`임무 ${s}`} on={() => runEnd(id, s)} />)}</div>;

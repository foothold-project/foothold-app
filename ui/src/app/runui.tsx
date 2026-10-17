// 수동 임무 기록 버튼(휴대폰 현황·PC 조종 공용) — live.js btn/wpActs/endRow
import type { Run, RunWaypoint } from '@contracts';
import { attachPhoto, cutName, isoNow, pickWp, runEdit, runEnd } from '../data/run';
import { useSel } from '../data/scratch';
import { wpName } from '../data/fmt';

export const Btn = ({ t, on, pri, ...p }: { t: string; on: () => void; pri?: boolean } & React.ButtonHTMLAttributes<HTMLButtonElement>) =>
  <button type="button" className={`lv-btn${pri ? ' pri' : ''}`} onClick={on} {...p}>{t}</button>;

// 지점 기록 버튼: 방문 확인(시각 기록)·미방문 사유·운영자 판단·사진 (live.js wpActs)
// R01: 방문 확인·미방문은 그 지점 상태만 바꾸고 선택은 그대로(같은 지점에 사진·판단을 이어서). 다음 지점은 «다음 지점»·지점 줄로만.
// 선택은 이 탭 메모리(scratch.useSel, 진행 기록 id 별) — 서버 문서·다른 기기·다른 계정에 영향 0.
const pin = (id: string, i: number) => useSel.setState({ [id]: i });
export function WpActs({ id, R, i }: { id: string; R: Run; i: number }) {
  const w = i >= 0 ? R.wps[i] : null, { next } = pickWp(R, i);
  const n = `WP${i + 1}`, set = (o: Partial<RunWaypoint>, what: string) => { pin(id, i); return runEdit(id, (d) => { Object.assign(d.wps[i], o); }, what); };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <div className="lv-row" role="group" aria-label="기록할 지점 고르기">
        {R.wps.map((x, k) => <button key={k} type="button" className="lv-btn" aria-pressed={k === i} style={{ minHeight: 44, minWidth: 44 }}
          title={`${wpName(x, k)} · ${x.st}`} onClick={() => pin(id, k)}>{`${x.st === '방문' ? '✓' : x.st === '미방문' ? '✕' : '○'} WP${k + 1}`}</button>)}
      </div>
      {w && <div className="lv-row">
        {w.st === '대기' ? <>
          <Btn pri t="방문 확인" on={() => set({ st: '방문', at: isoNow(), why: '' }, `${n} 방문 확인`)} />
          <Btn t="미방문…" on={() => { const y = prompt(`${n} 미방문 사유(예: 길 막힘·위험·시간 부족)`); if (y && y.trim()) set({ st: '미방문', at: '', why: cutName(y.trim(), 120) }, `${n} 미방문`); }} />
        </> : <>
          {next >= 0 && <Btn pri t={`다음 지점 ▸ WP${next + 1}`} on={() => pin(id, next)} />}
          <Btn t="대기로 되돌리기" on={() => set({ st: '대기', at: '', why: '' }, `${n} 되돌림`)} />
        </>}
        {w.mods.includes('운영자 확인') && (['확인', '보류', '제외'] as const).map((c) =>
          <Btn key={c} t={c} aria-pressed={w.chk === c} title="운영자 판단(로봇 자동 판정 아님)" on={() => runEdit(id, (d) => { d.wps[i].chk = d.wps[i].chk === c ? '' : c; }, `${n} 운영자 판단 ${c}`)} />)}
        <Btn t="📷 사진" on={() => attachPhoto(id, i)} />
      </div>}
    </div>);
}


export const EndRow = ({ id }: { id: string }) =>
  <div className="lv-row">{(['완료', '실패', '중단'] as const).map((s) => <Btn key={s} pri={s === '완료'} t={`임무 ${s}`} on={() => runEnd(id, s)} />)}</div>;

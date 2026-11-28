// 폰 지도 스캔 입구(u2_3 · u14_2): 붙이기 끝 화면(pairing.tsx) «이 현장 지도 스캔하기», 폰 로봇 연결 화면 ⋯ «지도 스캔»(App). 둘 다 PhoneScan(시안 u14_2 틀)을 연다.
// 권한은 PhoneScan 과 같은 makers()(운영자 · 자기 담당 실기, 서버도 403 MAPPING_OWNER_ONLY). 없으면 단추 대신 까닭 한 줄.
// 층은 실기 현장(REAL)만 고른다. 이 파일은 주행 명령을 만들지 않는다(조종 · STOP 은 폰 조종 화면).
import { useState } from 'react';
import type { Robot, User } from '../fake';
import { makers } from './mapmake';
import { floorsOf, purposeOf, useTree } from './maps';
import { CLOSE_IC, PhoneScan, ScanFrame, SideBtn } from './phonescan';

export const SCAN_NO = '지도 스캔은 로봇의 담당 운영자만 할 수 있습니다.';

/** 단추 하나 또는 까닭 한 줄 */
export function ScanStart({ user, robots, label, start }: { user: User; robots: Robot[]; label: string; start: () => void }) {
  return makers(user, robots).length ? <button type="button" className="btn" onClick={start} data-scan-start>{label}</button>
    : <p className="lbl" data-scan-no>{SCAN_NO}</p>;
}

/** 스캔 칸(시안 u14_2 틀 · phonescan.tsx): 고를 로봇(담당 실기)이 여럿이면 오른쪽 단추 줄 맨 위에 고르기 → PhoneScan. 칸 안 칸 없이 화면 하나 */
export function ScanPanel({ user, robots, close, cancel }: { user: User; robots: Robot[]; close: () => void; cancel?: AbortSignal }) {
  const list = makers(user, robots), [pick, setPick] = useState(''), r = list.find((x) => x.id === pick) ?? list[0];
  const t = useTree(cancel), places = floorsOf(t.tree).filter((p) => purposeOf(p.site) === 'REAL');
  const picker = list.length > 1 && <label className="g dk u142-pick"><span>로봇</span><select aria-label="스캔할 로봇" data-scan-robot value={r.id} onChange={(e) => setPick(e.target.value)}>
    {list.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>;
  const shut = <SideBtn ic={CLOSE_IC} text="닫기" onClick={close} data-scan-close />;
  if (r && t.tree) return <PhoneScan key={r.id} user={user} robot={r} places={places} cancel={cancel} close={close} pick={picker} />;
  return <ScanFrame side={<>{picker}{shut}</>}><div className="u142-says">
    {!r ? <p className="u142-say" data-scan-no>{SCAN_NO}</p> : <p className={`u142-say${t.err ? ' bad' : ''}`} role={t.err ? 'alert' : 'status'}>{t.err || '층 목록을 받는 중…'}</p>}</div></ScanFrame>;
}

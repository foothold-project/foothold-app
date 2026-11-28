// 지도 탭 지도 파일 올리기 = 시안 u7 틀(머리줄 · 옆 칸 · 큰 칸). 시안에 올리기 화면이 따로 없어 u7_6 과 같은 꼴로 둔다(떠 있는 창 없음).
// place = null 이면 머리줄 층 칩에서 고른다(pick). 파일 칸(Upload · VoxelUpload)은 children 으로 받는다.
import type { ReactNode } from 'react';
import type { Place } from '../maps';
import '../../proto/ui.pv.css';
import '../../proto/pc.pv.css';
import '../../proto/light.pv.css';
import './u7.css';

const light = () => typeof document !== 'undefined' && document.documentElement.dataset.theme === 'light';

/** head · side = 다른 장소 칸 화면(이름 바꾸기 · 삭제)에서 같은 틀을 쓸 때 머리 제목 · 옆 칸 글 */
export function UploadScreen({ label, place, floors = [], pick, back, lock, children, head, side }: { label: string; place: Place | null; floors?: Place[]; pick?: (floor: string) => void; back: () => void; lock?: boolean; children: ReactNode; head?: string; side?: { ttl: string; text: string; foot: string } }) {
  return <div className={`proto${light() ? ' light' : ''} u7`} data-u7="u7_upload">
    <div className="pane side"><span className="ttl">{side?.ttl ?? '지도 올리기'}</span>
      <p className="mu2" style={{ fontSize: '12.5px', margin: '8px 4px 0', lineHeight: '1.6' }}>{side?.text ?? '지도 그림(.png · .pgm)과 설정 파일(.yaml)을 함께 올리거나, 관리자는 3D 지도 파일(.pcd · .ply)을 올립니다. 올리면 이 층의 새 버전이 됩니다.'}</p>
      <div style={{ position: 'absolute', left: '20px', right: '20px', bottom: '20px', fontSize: '12.5px', lineHeight: '1.55', color: 'var(--mu2)' }}>{side?.foot ?? '지금 지도의 구역 · 지점 · 연결점은 새 버전에 그대로 옮깁니다.'}</div>
    </div>
    <div className="head">
      <span className="g dk" style={{ position: 'relative', width: '44px', height: '44px', borderRadius: '13px', display: 'flex', alignItems: 'center', justifyContent: 'center' }} role="button" tabIndex={0}
        aria-label={`${label} 닫기`} aria-disabled={lock || undefined} data-u7-back onClick={() => lock || back()}>
        <svg className="ic" viewBox="0 0 24 24" style={{ width: '20px', height: '20px' }}><path d="m15 18-6-6 6-6" /></svg></span>
      <span className="ttl" style={{ fontSize: '24px', marginRight: '6px' }}>{head ?? (place ? `새 지도 올리기 · ${place.building.name} ${place.floor.name}` : '새 지도 올리기')}</span>
      {!place && <span className="g dk st" style={{ position: 'relative' }} data-chip="floor">
        <select value="" aria-label="지도 올릴 층" style={{ background: 'transparent', color: 'inherit', border: 0, font: 'inherit' }} onChange={(e) => e.target.value && pick?.(e.target.value)}>
          <option value="">층 고르기</option>{floors.map((x) => <option key={x.floor.id} value={x.floor.id}>{`${x.site.name} ${x.building.name} ${x.floor.name}`}</option>)}</select>
        <small>지도 올릴 층</small></span>}
    </div>
    <div className="pane" style={{ left: '348px', top: '160px', right: '24px', bottom: '24px', padding: '22px 24px', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: '12px' }} aria-label={`${label} 화면`}>
      {children}
    </div>
  </div>;
}

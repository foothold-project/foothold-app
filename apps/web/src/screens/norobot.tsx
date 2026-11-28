/** 폰 로봇 없음 = 시안 u13_4 (proto/screens/u13_4_no_robot.html). 화면 마크업은 시안 body 를 옮긴 것(태그 · class · 순서 그대로), 단추 div 는 button.
 *  「로봇 연결」은 로봇 연결 화면의 «+ 로봇 연결하기»와 같은 길(drive.tsx Connect: 앱 밖 = 새 로봇 추가 pairing.tsx, 앱 안 = 고르기).
 *  글 둘은 앱 사실에 맞췄다: 시안 「폰에 뜬 QR 을 로봇 앞 카메라에…」는 폰이 QR 을 띄우는 연결(u14_1)이라 이 앱의 연결(노트북 화면 QR · 6자리)과 다르고,
 *  운영자는 담당 로봇만 보므로 제목이 「담당 로봇이 없습니다」. 「시뮬 로봇 띄우기」는 시안 밖 단추(시안 .sec 결 · 시뮬 띄우기 칸을 연다) */
import '../proto/ui.pv.css';
import '../proto/light.pv.css';
import './u13.css';
import './u13.app.css';
import type { Role } from '../fake';

export const NO_ROBOT_WHY = '노트북 화면의 QR 또는 6자리 코드로 로봇을 연결합니다. 처음 한 번만 합니다.';
export const noRobotTitle = (role: Role) => (role === 'ORG_ADMIN' ? '등록된 로봇이 없습니다' : '담당 로봇이 없습니다');

export function NoRobot({ role, light, add, sim }: { role: Role; light: boolean; add: () => void; sim: () => void }) {
  return <div className={`proto pv u13 u134${light ? ' light' : ''}`} aria-label="로봇 없음" data-u13="no-robot">
    <div className="bg" />
    <div className="g" style={{ left: '50%', top: '50%', transform: 'translate(-50%,-50%)', width: '360px', padding: '22px', borderRadius: '22px', textAlign: 'center' }}>
      <div style={{ width: '56px', height: '56px', margin: '0 auto', borderRadius: '18px', background: 'var(--pr)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 8px 18px rgba(14,127,99,.35)' }}>
        <svg className="ic" viewBox="0 0 24 24" style={{ width: '28px', height: '28px' }} aria-hidden="true"><path d="M4 13h11l3-3h2v4l-2 1H5z" /><path d="M6 15l-1 4M10 15v4M14 15v4M17 15l1 4" /></svg></div>
      <h2 style={{ fontSize: '18px', fontWeight: 800, marginTop: '12px' }}>{noRobotTitle(role)}</h2>
      <div style={{ fontSize: '12.5px', fontWeight: 600, color: '#5e6662', marginTop: '6px', lineHeight: 1.5 }}>{NO_ROBOT_WHY}</div>
      <button type="button" className="prim" style={{ marginTop: '14px' }} id="go-add" onClick={add} data-robot-connect>
        <svg className="ic" viewBox="0 0 24 24" style={{ width: '16px', height: '16px' }} aria-hidden="true"><path d="M5 12h14" /><path d="M12 5v14" /></svg>로봇 연결</button>
      <button type="button" className="sec" onClick={sim} data-sim-open>시뮬 로봇 띄우기</button>
    </div>
  </div>;
}

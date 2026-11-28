/** 조종권 요청 창 = 시안 u13_5 아래 요청 칸 (proto/screens/u13_5_takeover_ask.html 의 .veil + 가운데 .g). 마크업은 시안 그대로, 단추 div 는 button.
 *  조종 화면(조이스틱 · 동작 단추)은 이 파일 몫이 아니다. 창은 조종 판 위에 겹치기만 하고 가림막(.veil)은 손가락을 막지 않는다(조종 · STOP 은 요청 중에도 그대로).
 *  넘기기 · 계속 조종 · 남은 시간은 부르는 쪽(drive.tsx 서버 경유 · simdrive.tsx · realdrive.tsx 직결) 값 그대로 */
import type { MouseEventHandler } from 'react';
import '../proto/ui.pv.css';
import '../proto/light.pv.css';
import './u135.css';
import './u135.app.css';
import { useTheme } from '../theme';

/** left = 남은 초 · bar = 남은 비율(0..100). 직결(시뮬 · 실기)은 요청 메시지에 만료 시각이 없어 둘 다 없음 */
export function TakeoverAsk({ id, title, left, bar, give, keep }: { id: string; title: string; left?: number; bar?: number; give: MouseEventHandler; keep: MouseEventHandler }) {
  const light = useTheme()[1];
  return <div className={`proto pv u135${light ? ' light' : ''}`} role="dialog" aria-labelledby={id} aria-live="assertive" data-takeover>
    <div className="veil" />
    <div className="g" style={{ left: '50%', top: '50%', transform: 'translate(-50%,-50%)', width: '600px', padding: '18px 20px', borderRadius: '22px', zIndex: 6 }}>
      <div className="row" style={{ gap: '12px' }}>
        <span style={{ width: '40px', height: '40px', borderRadius: '13px', background: 'rgba(24,160,126,.14)', color: '#0e7f63', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <svg className="ic" viewBox="0 0 24 24" style={{ width: '20px', height: '20px' }} aria-hidden="true"><path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V11M11 10V4.5a1.5 1.5 0 0 1 3 0V11M14 10.5V6a1.5 1.5 0 0 1 3 0v8a6 6 0 0 1-6 6h-1a5 5 0 0 1-4-2l-2.5-3.5a1.5 1.5 0 0 1 2.4-1.8L8 14" /></svg></span>
        <div><div id={id} style={{ fontSize: '15.5px', fontWeight: 800 }}>{title}</div>
          <div style={{ fontSize: '12.5px', fontWeight: 600, color: '#5e6662', marginTop: '2px' }} data-takeover-left>
            {left == null ? '넘겨주시겠습니까?' : `넘겨주시겠습니까? ${left} 초 안에 답하지 않으면 조종권을 넘기지 않습니다`}</div></div>
      </div>
      {bar != null && <div style={{ height: '5px', borderRadius: '3px', background: 'rgba(0,0,0,.08)', marginTop: '12px', overflow: 'hidden' }} aria-label={`남은 시간 ${left}초`} data-takeover-bar>
        <i style={{ display: 'block', height: '100%', width: `${bar}%`, background: 'linear-gradient(90deg,#0e7f63,#18a07e)' }} /></div>}
      <div style={{ display: 'flex', gap: '10px', marginTop: '14px' }}>
        <button type="button" className="sec" style={{ flex: '1 1 0' }} id="go-keep" data-ask="keep" onClick={keep}>계속 조종</button>
        <button type="button" className="prim" style={{ flex: '1 1 0' }} id="go-give" data-ask="give" onClick={give}>
          <svg className="ic" viewBox="0 0 24 24" style={{ width: '16px', height: '16px' }} aria-hidden="true"><path d="M8 3 4 7l4 4" /><path d="M4 7h16" /><path d="m16 21 4-4-4-4" /><path d="M20 17H4" /></svg>넘기기</button>
      </div>
    </div>
  </div>;
}

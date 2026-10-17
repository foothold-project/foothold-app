// System(원본 틀): 디자인 체계 참고 화면 — 센서·로봇 기능이 아니다. 숫자(ppm·시각 등)는 시안 예시이며 측정값이 아님.
// 표본 STOP 은 실제 STOP 으로 잇는다(STOP 처럼 생긴 버튼이 멈추지 않으면 안 되므로). 그 밖의 표본 버튼은 동작 없음.
import { CSS, View } from './System.view';
import { themeClass } from '../data/fmt';
import { stopProps } from '../app/shell';

export const SYS_NOTE = '디자인 체계 참고 화면 — 센서·로봇 기능이 아닙니다. 아래 숫자(가스 ppm·시각 등)는 시안 예시이며 측정값이 아니고, 가스·측정 센서는 미연결입니다. 공식 색·글꼴 규격은 foothold-brand. 이 화면의 STOP 은 실제 STOP 입니다(스페이스 키도).';

export default function System() {
  return <><style>{CSS}</style><div id="dc-root">
    <p role="note" className="lv-note" style={{ margin: 0, padding: '10px 16px', background: 'var(--warn-bg, rgba(255,181,71,.12))', color: 'inherit', fontSize: 13 }}>{`▲ ${SYS_NOTE}`}</p>
    <View v={{ themeClass: themeClass(true), stopP: stopProps }} />
  </div></>;
}

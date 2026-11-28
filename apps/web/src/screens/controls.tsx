// 설정 › 조작의 키보드 · 모바일 (폰 터치) 설명(u9_7 · U9-05). 읽기 전용: 켜고 끄기 · 감도를 저장할 서버 값이 없어 지금 배치만 적는다.
// 키 표는 시뮬 조종 키(simdrive KEYS)와 Space 정지(App 공통 층)만. 실기 조종 화면 키(serverdrive.tsx · drive.tsx KEY)는 달라서 «다르다» 한 줄만.

/** [보이는 키, 하는 일, 물리 키(e.code)]. controls.test 가 simdrive KEYS 와 맞춘다 */
export const KEY_GUIDE: [string, string, string[]][] = [
  ['W · S · ↑ · ↓', '앞 · 뒤', ['KeyW', 'KeyS', 'ArrowUp', 'ArrowDown']],
  ['A · D', '돌기', ['KeyA', 'KeyD']],
  ['← · →', '옆걸음', ['ArrowLeft', 'ArrowRight']],
  ['Space', '정지 (모든 화면 · 글 입력 칸에서는 띄어쓰기)', ['Space']],
];
/** 실기 폰 조종(drive.tsx 174)은 전후를 0 아래로 내리지 않고, 뒤로 밀면 «후진은 아직 지원하지 않습니다»(298) 를 보인다 */
export const PHONE_BASIS = '시뮬 조종 기준입니다. 실기는 지금 뒤로 가지 않고, 막힌 동작은 조종 화면에 까닭이 나옵니다.';
export const NO_SAVE = '켜고 끄기 · 감도를 저장할 서버 값이 아직 없어 지금 배치만 보여 줍니다. 속도 값은 아래 시뮬 값에서 바꿉니다.';

const Row = ({ k, what }: { k: string; what: string }) => <div className="st-row"><span>{what}</span><b className="mono">{k}</b></div>;

export function ControlsGuide() {
  return <>
    <section className="lv-card" aria-label="키보드">
      <h2>키보드</h2>
      {KEY_GUIDE.map(([k, what]) => <div key={k} className="st-row st-keyrow"><span className="st-keys">{k.split(' · ').map((x) => <kbd key={x}>{x}</kbd>)}</span><span>{what}</span></div>)}
      <p className="st-note">시뮬 조종 기준입니다. 실기 조종 화면은 조종 방식에 따라 키가 다릅니다.</p>
    </section>
    <section className="lv-card" aria-label="모바일 (폰 터치)">
      <h2>모바일 (폰 터치)</h2>
      <Row k="왼쪽 스틱" what="앞 · 뒤 (시뮬은 옆으로 밀면 옆걸음)" />
      <Row k="오른쪽 스틱" what="돌기" />
      <Row k="떼기" what="손을 떼면 그 스틱 입력 0" />
      <Row k="STOP" what="화면의 붉은 STOP 단추" />
      <p className="st-note" data-ctl-basis>{PHONE_BASIS}</p>
      <p className="st-note" data-ctl-why>{NO_SAVE}</p>
    </section>
  </>;
}

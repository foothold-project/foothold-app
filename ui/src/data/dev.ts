// 개발자 모드(UI-SIMPLIFY v3 §2-1) — «표시만» 바꾼다. 권한·안전 정책·명령 경로·서버 연결은 그대로.
// 켜기/끄기: hash 바깥 쿼리 ?dev=1 / ?dev=0 (예: /?dev=1#/PcPlan?mission=…) 또는 설정 화면 스위치.
// 초기값 우선순위: 유효한 URL dev=1/0 > localStorage['fh.dev'] 1/0 > 꺼짐. 모르는 값은 무시.
// 켜지면 <html class="fh-dev"> — 운영에서 접을 요소는 data-dev 를 붙이면 live.css 가 숨긴다.
import { create } from 'zustand';
import { dropAll } from './link';

const K = 'fh.dev';
const bit = (v: string | null | undefined) => (v === '1' ? true : v === '0' ? false : null);

/** 초기값(순수 — 시험용으로 search·저장값을 받는다) */
export function devInit(search: string, saved: string | null): boolean {
  return bit(new URLSearchParams(search).get('dev')) ?? bit(saved) ?? false;
}
/** hash 바깥 쿼리에서 dev 만 바꾼다(다른 쿼리 순서·인코딩 그대로, 중복 dev 는 하나로).
 *  dev 판별은 읽기(devInit 의 URLSearchParams)와 같은 디코드 키 — ?%64ev=1 · ?de%76=1 도 dev 로 지운다(남으면 재진입 때 다시 켜짐).
 *  D2(10-15 검토): 조각 앞에 '&' 를 붙여 파싱 — 조각 맨 앞 '?' 를 쿼리 접두로 다시 떼지 않게(전체 search 에서의 키와 같은 뜻: ?a=1&?dev=x 의 키는 '?dev') */
const keyOf = (p: string) => new URLSearchParams(`&${p}`).keys().next().value;
export function devSearch(search: string, on: boolean): string {
  const ps = search.replace(/^\?/, '').split('&').filter((p) => p && keyOf(p) !== 'dev');
  return `?${[...ps, `dev=${on ? 1 : 0}`].join('&')}`;
}

export const useDev = create<{ on: boolean }>(() => ({ on: false }));
const paint = (on: boolean) => document.documentElement.classList.toggle('fh-dev', on);

/** 앱 입구에서 한 번 */
export function devStart() {
  let saved: string | null = null;
  try { saved = localStorage.getItem(K); } catch { /* 저장 막힘 = 저장값 없음 */ }
  const on = devInit(location.search, saved);
  useDev.setState({ on }); paint(on);
}

/** 스위치: 누르던 입력 먼저 폐기(새 명령·조종권·재개 송신 0) → 이 탭 즉시 전환 → 저장값·주소 dev 만 맞춤(새로고침·재연결 0).
 *  저장/주소가 막혀도 이 탭은 바뀐다 — 그때 알릴 글을 돌려준다(없으면 null). */
export function setDev(on: boolean): string | null {
  dropAll();
  useDev.setState({ on }); paint(on);
  const miss: string[] = [];
  try { localStorage.setItem(K, on ? '1' : '0'); } catch { miss.push('브라우저 저장'); }
  try { history.replaceState(history.state, '', `${location.pathname}${devSearch(location.search, on)}${location.hash}`); } catch { miss.push('주소'); }
  return miss.length ? `개발자 모드 ${on ? '켬' : '끔'} — 이 탭에만 적용(${miss.join('·')} 반영 안 됨)` : null;
}

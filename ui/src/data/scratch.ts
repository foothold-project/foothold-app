// 화면 밖 임시 보관 — 이 탭 메모리만(서버·기기 저장소 0). 새로고침·앱 종료·로그인 성공(새로 읽음) 때 사라진다.
//  drafts: 저장 안 한 문서 초안(화면을 떠났다 돌아오면 이어서 편집). sel: 기록 중인 지점(진행 기록 id → 지점 번호).
// 계정·관문 문맥이 바뀌면(로그아웃·관문 주소 변경·세션 끝) dropScratch() 로 모두 버린다 — 다른 계정·대상으로 복원·오채택 0.
// 조종권·STOP·누름 같은 조종 상태는 여기 두지 않는다(복원 0).
// 같은 때 영속 초안(persistDraft)도 폐기 — nonce 교체·보관본 삭제(다른 탭도 storage 이벤트로 폐기).
import { create } from 'zustand';
import { drop as dropPersist, snapshot as pdSnap, subscribe as pdSub } from './persistDraft';

export type Draft = { id: string | null; rev: number | null; d: unknown };
export const drafts = new Map<string, Draft>();
export const useSel = create<Record<string, number>>(() => ({}));
/** 문맥 번호 — dropScratch 마다 +1. 화면이 떠날 때 «들어올 때와 같은 문맥»일 때만 초안을 보관(로그아웃 뒤 언마운트가 되살리지 않게) */
export const ctx = { n: 0 };
const clear = () => { ctx.n++; drafts.clear(); useSel.setState({}, true); };
let pdGen = pdSnap().gen, own = false;
/** 폐기: 탭 메모리 + 영속 초안. ctx.n 은 한 번만 +1(dropPersist 의 gen 변화 알림은 own 으로 건너뜀 — 다시 dropPersist 부르는 고리 0) */
export function dropScratch() { clear(); own = true; try { dropPersist(); } finally { own = false; pdGen = pdSnap().gen; } }
// 영속 초안 쪽 단독 폐기(다른 탭 nonce 교체 — storage 이벤트·get/put 재대조)로 gen 이 바뀌면 탭 메모리·ctx 도 폐기(다음 useEditor 가 옛 drafts 로 되살리지 않게)
pdSub(() => { const g = pdSnap().gen; if (g === pdGen) return; pdGen = g; if (!own) clear(); });

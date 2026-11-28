// PC 머리줄 아래 알림 카드(.fh-band). 폰 알림처럼 한쪽 모서리에서 미끄러져 나오고, 같은 원인은 한 장으로 합친다.
// 글 · 단추 · 정지 동작은 App.tsx 가 만든 그대로 넣고, 여기서는 보이는 방식(합침 · 사라짐 · 장수 · 닫기)만 정한다.
// 등급은 카드의 data-tone(info · warn)로만 정한다. 표가 없는 카드(정지 결과 · 서버 연결 · 권한 등)는 안전 알림으로 보고
// 예전처럼 늘 보이며 합치거나 숨기거나 닫기를 더하지 않는다.
import { Children, isValidElement, useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react';

/** 카드가 나오는 쪽. 'top' = 오른쪽 위에서 내려옴 · 'bottom' = 오른쪽 아래에서 올라옴 */
export const TOAST_FROM: 'top' | 'bottom' = 'top';
/** 한 화면에 보이는 카드 수(안전 알림은 이 수와 상관없이 늘 보임) */
export const TOAST_MAX = 3;
/** 정보 카드가 저절로 사라지는 시간 */
export const TOAST_INFO_MS = 6000;

/** 같은 원인 여러 건을 합친 카드의 제목. 열쇠 = data-cause */
const GROUP_TITLE: Record<string, (n: number) => string> = {
  lost: (n) => `${n} 대 연결 끊김 · 현장에서 로봇 전원과 통신을 확인하세요.`,
};

type Tone = 'info' | 'warn' | 'safe';
type Card = { id: string; tone: Tone; keys: string[]; els: ReactElement[]; title?: string };
type Props = Record<string, unknown>;

/** 카드 묶기: data-tone 이 info · warn 인 것만 원인(data-cause, 없으면 제 열쇠)으로 합친다 */
export function toCards(items: ReactNode): Card[] {
  const out: Card[] = [], at = new Map<string, Card>();
  Children.forEach(items, (el) => {
    if (!isValidElement(el)) return;
    const p = el.props as Props, key = String(el.key ?? out.length);
    const tone: Tone = p['data-tone'] === 'info' || p['data-tone'] === 'warn' ? p['data-tone'] : 'safe';
    const cause = tone !== 'safe' && typeof p['data-cause'] === 'string' ? `${tone}:${p['data-cause']}` : '';
    const same = cause ? at.get(cause) : undefined;
    if (same) { same.keys.push(key); same.els.push(el); return; }
    const c: Card = { id: cause || `k:${key}`, tone, keys: [key], els: [el] };
    out.push(c);
    if (cause) at.set(cause, c);
  });
  for (const c of out) if (c.els.length > 1) {
    const cause = String((c.els[0].props as Props)['data-cause']);
    c.title = GROUP_TITLE[cause]?.(c.els.length) ?? `${c.els.length} 건`;
  }
  return out;
}

/** 넘친 카드 보기: 머리줄 알림 종을 펼치고, 종이 없으면 기록 탭으로 */
function openList() {
  const bell = document.querySelector<HTMLDetailsElement>('details.ap-bell');
  if (bell) { bell.open = true; bell.querySelector('summary')?.focus(); } else location.hash = '#/history';
}

export function Toasts({ pc, children }: { pc: boolean; children: ReactNode }) {
  if (!pc) return <div className="fh-band" role="status" data-band>{children}</div>;   // 폰은 예전 띠 그대로
  return <PcToasts>{children}</PcToasts>;
}

function PcToasts({ children }: { children: ReactNode }) {
  const cards = toCards(children);
  // 닫은 카드: 카드 id → 닫을 때 들어 있던 열쇠들. 새 열쇠가 들어오면(9 대째 끊김 등) 다시 보인다
  const [shut, setShut] = useState<Record<string, string[]>>({});
  const open = cards.filter((c) => c.tone === 'safe' || !c.keys.every((k) => shut[c.id]?.includes(k)));
  const close = (c: Card) => setShut((s) => ({ ...s, [c.id]: c.keys }));
  // 정보 카드는 처음 보인 뒤 TOAST_INFO_MS 에 닫음(열쇠가 바뀌면 다시 셈)
  const infos = open.filter((c) => c.tone === 'info'), sig = infos.map((c) => `${c.id}=${c.keys.join(',')}`).join('|');
  const infoNow = useMemo(() => infos, [sig]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!infoNow.length) return;
    const t = setTimeout(() => setShut((s) => { const n = { ...s }; for (const c of infoNow) n[c.id] = c.keys; return n; }), TOAST_INFO_MS);
    return () => clearTimeout(t);
  }, [infoNow]);
  const safe = open.filter((c) => c.tone === 'safe'), rest = open.filter((c) => c.tone !== 'safe');
  const room = Math.max(0, TOAST_MAX - safe.length), shown = [...safe, ...rest.slice(0, room)], more = rest.length - Math.min(rest.length, room);
  return <div className="fh-band" role="status" data-band data-from={TOAST_FROM}>
    {shown.map((c) => <div key={c.id} className="ap-toast" data-toast={c.tone} data-count={c.els.length > 1 ? c.els.length : undefined}>
      {c.title ? <>
        <span className="ap-toast-t">▲ {c.title}</span><b className="ap-toast-n" aria-label={`${c.els.length} 건`}>{c.els.length}</b>
        <details className="ap-toast-d"><summary>자세히</summary>{c.els}</details>
      </> : c.els}
      {c.tone !== 'safe' && <button type="button" className="btn ap-toast-x" aria-label="알림 닫기" onClick={() => close(c)}>닫기</button>}
    </div>)}
    {more > 0 && <button type="button" className="ap-toast-more" data-toast-more onClick={openList}>{more} 건 더</button>}
  </div>;
}

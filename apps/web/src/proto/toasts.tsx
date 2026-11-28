// PC 머리줄 아래 알림 카드(.fh-band). 폰 알림처럼 위에서 내려와 화면을 덮고, 여러 장이면 겹쳐 쌓인다(가장 새것이 맨 앞).
// 쌓인 카드를 누르면 아래로 펼쳐 다 보이고, 다시 누르거나 바깥을 누르면 접힌다. 카드는 TOAST_MS 뒤 사라지되 펼친 동안 · 마우스를 올린 동안은 멈춘다.
// 글 · 단추 · 정지 동작은 App.tsx 가 만든 그대로 넣고, 여기서는 보이는 방식만 정한다.
// 등급은 카드의 data-tone(info · warn)로만 정한다. 표가 없는 카드(정지 결과 · 서버 연결 · 권한 등)는 안전 알림으로 보고
// 예전처럼 늘 보이며 쌓거나 사라지게 하거나 닫기를 더하지 않는다.
import { Children, isValidElement, useEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactElement, type ReactNode } from 'react';

/** 카드가 나오는 쪽. 'top' = 오른쪽 위에서 내려옴 · 'bottom' = 오른쪽 아래에서 올라옴 */
export const TOAST_FROM: 'top' | 'bottom' = 'top';
/** 정보 · 경고 카드가 저절로 사라지는 시간(펼침 · 마우스 올림 동안은 멈춤) */
export const TOAST_MS = 6000;

type Tone = 'info' | 'warn' | 'safe';
type Card = { key: string; tone: Tone; el: ReactElement };

function toCards(items: ReactNode): Card[] {
  const out: Card[] = [];
  Children.forEach(items, (el) => {
    if (!isValidElement(el)) return;
    const t = (el.props as Record<string, unknown>)['data-tone'];
    out.push({ key: String(el.key ?? out.length), tone: t === 'info' || t === 'warn' ? t : 'safe', el });
  });
  return out;
}

export function Toasts({ pc, children }: { pc: boolean; children: ReactNode }) {
  if (!pc) return <div className="fh-band" role="status" data-band>{children}</div>;   // 폰은 예전 띠 그대로
  return <PcToasts>{children}</PcToasts>;
}

function PcToasts({ children }: { children: ReactNode }) {
  const cards = toCards(children), safe = cards.filter((c) => c.tone === 'safe');
  const born = useRef(new Map<string, number>());   // 카드 열쇠 → 처음 보인 시각(멈춘 동안만큼 뒤로 밂)
  const [gone, setGone] = useState<string[]>([]);   // 시간이 다 됐거나 닫은 카드
  const [open, setOpen] = useState(false), [hover, setHover] = useState(false);
  const band = useRef<HTMLDivElement>(null);
  const live = cards.filter((c) => c.tone !== 'safe'), liveKeys = live.map((c) => c.key);
  const now = Date.now();
  for (const k of liveKeys) if (!born.current.has(k)) born.current.set(k, now);
  for (const k of [...born.current.keys()]) if (!liveKeys.includes(k)) born.current.delete(k);   // 풀렸다 다시 생기면 새 카드
  const stack = live.filter((c) => !gone.includes(c.key)).sort((a, b) => born.current.get(b.key)! - born.current.get(a.key)!);   // 새것이 맨 앞
  const sig = stack.map((c) => c.key).join('|'), paused = open || hover;
  useEffect(() => { setGone((g) => { const n = g.filter((k) => liveKeys.includes(k)); return n.length === g.length ? g : n; }); }, [liveKeys.join('|')]);   // eslint-disable-line react-hooks/exhaustive-deps
  // 멈춘 동안은 시간을 세지 않음: 풀릴 때 멈춘 만큼 처음 시각을 뒤로 민다
  useEffect(() => {
    if (!paused) return;
    const at = Date.now();
    return () => { const d = Date.now() - at; for (const [k, v] of born.current) born.current.set(k, v + d); };
  }, [paused]);
  useEffect(() => {
    if (paused || !stack.length) return;
    const next = Math.min(...stack.map((c) => born.current.get(c.key)! + TOAST_MS));
    const t = setTimeout(() => { const at = Date.now(); setGone((g) => [...g, ...stack.filter((c) => born.current.get(c.key)! + TOAST_MS <= at).map((c) => c.key)]); }, Math.max(0, next - Date.now()));
    return () => clearTimeout(t);
  }, [sig, paused]);   // eslint-disable-line react-hooks/exhaustive-deps
  // 펼친 동안 바깥을 누르거나 Esc 면 접음
  useEffect(() => {
    if (!open) return;
    const out = (e: Event) => { if (!band.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', out); document.addEventListener('mousedown', out); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', out); document.removeEventListener('mousedown', out); document.removeEventListener('keydown', esc); };
  }, [open]);
  const many = stack.length > 1, isOpen = open && many;
  useEffect(() => { if (open && !many) setOpen(false); }, [open, many]);
  const tap = (e: MouseEvent) => { if (many && !(e.target as Element).closest('button,a,summary,select,input')) setOpen((o) => !o); };
  const card = (c: Card, i: number | null) => <div key={c.key} className="ap-toast" data-toast={c.tone} data-depth={i ?? undefined}
    style={i == null ? undefined : { '--i': i } as CSSProperties}>{c.el}
    {c.tone !== 'safe' && <button type="button" className="btn ap-toast-x" aria-label="알림 닫기" onClick={() => setGone((g) => [...g, c.key])}>닫기</button>}</div>;
  return <div className="fh-band" role="status" data-band data-from={TOAST_FROM} ref={band}>
    {safe.map((c) => card(c, null))}
    {!!stack.length && <div className="ap-stack" data-open={isOpen || undefined} data-n={stack.length}
      onClick={tap} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      {stack.map((c, i) => card(c, i))}
      {many && <button type="button" className="ap-stack-t" aria-expanded={isOpen} onClick={() => setOpen((o) => !o)}>{isOpen ? '접기' : `${stack.length} 건 모두 보기`}</button>}
    </div>}
  </div>;
}

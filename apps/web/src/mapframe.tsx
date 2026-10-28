// 지도 그림 공용 틀(지도 보기·편집·판 비교·시나리오 지점·시뮬 지도): 앱 색으로 칠한 판 그림, 빈 여백을 자른 첫 화면, 축척 막대, 확대·이동.
// 지도 원본·서버는 그대로다 — 색은 SVG 필터(기존 토큰만), 자르기는 같은 그림을 브라우저에서 한 번 더 읽어 벽 범위를 잰다(실패하면 전체 그림).
// 이동: 보기 = 끌기·두 손가락, 편집(edit) = 가운데 단추·두 손가락만(왼쪽 누름·한 손가락은 부른 쪽의 그리기·찍기). 확대 = 휠·집기·단추.
// 키는 잡지 않는다(Space = STOP 은 App 그대로). 누름 좌표는 svg 의 viewBox 를 읽어 바꾼다(toView) — 확대·자르기 뒤에도 같은 계산.
import { forwardRef, useEffect, useId, useRef, useState, useSyncExternalStore, type CSSProperties, type PointerEvent, type SVGProps } from 'react';
import type { MapVersion } from '../../contracts/ts';
import { api } from './api';

export type Box = [number, number, number, number];   // x y 폭 높이(그림 픽셀)
type P = [number, number];

/** 그림 값(빨강 0~1) → 토큰. ROS 3값 지도: 0 = 벽, 205 = 미확인, 254 = 빈 곳. 경계 0.4·0.9(10칸 계단) — WALL 은 벽 찾기(bounds)와 같다 */
const TINT: [string, string][] = [['1 1 1 1 0 0 0 0 0 0', 'var(--text)'], ['0 0 0 0 1 1 1 1 1 0', 'var(--bg)'], ['0 0 0 0 0 0 0 0 0 1', 'var(--panel)']];
const WALL = 102;   // 255 × 0.4

/** 판 그림(<image>, 쿠키로 따로 받음)을 앱 색으로. 나머지 속성(onLoad·onError·transform·style…)은 <image> 그대로 */
export function MapImage({ id, style, ...rest }: { id: string; width: number; height: number } & Omit<SVGProps<SVGImageElement>, 'href' | 'filter'>) {
  const f = `fh-tint${useId().replace(/:/g, '')}`;
  return <>
    <filter id={f} x="0" y="0" width="1" height="1" colorInterpolationFilters="sRGB">
      <feColorMatrix type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  1 0 0 0 0" result="l" />
      {TINT.map(([t, c], i) => [
        <feComponentTransfer key={`m${i}`} in="l" result={`m${i}`}><feFuncA type="discrete" tableValues={t} /></feComponentTransfer>,
        <feFlood key={`f${i}`} style={{ floodColor: c }} result={`f${i}`} />,
        <feComposite key={`c${i}`} in={`f${i}`} in2={`m${i}`} operator="in" result={`c${i}`} />])}
      <feMerge result="all">{TINT.map((_, i) => <feMergeNode key={i} in={`c${i}`} />)}</feMerge>
      <feComposite in="all" in2="SourceAlpha" operator="in" />
    </filter>
    <image href={api.imageUrl(id)} filter={`url(#${f})`} style={{ imageRendering: 'pixelated', opacity: 'var(--fh-map-a, 1)', ...style }} {...rest} />
  </>;
}

/** 시뮬 월드 «실제 모습»: mobile/scripts/make-top.mjs 가 구운 top.png 와 그 범위 top.json(사진이 덮는 지도 좌표 [x0, y0, x1, y1] m + 그 지도 판).
 *  판과 사진은 서버가 준 그림 sha256 으로만 잇는다 — 서버가 시뮬 월드를 등록할 때 쓰는 그림(apps/simmgr/worlds/<월드>/maps/<층>.png, sim_maps.py)의 sha256.
 *  이름으로 맞추지 않는다(tests/maptop.test 가 worlds.json·그림과 대조). 잔해 험지(rubble)·연결 건물·실기·올린 지도는 사진 없음.
 *  같은 PNG·YAML 을 사람이 올린 판(provenance HUMAN)도 사진 없음 — 서버가 시뮬 등록으로 남긴 판(SIMULATION, 편집·되돌림도 이어받음)만 */
export const SIM_TOP = new Map([
  ['ce79faafe42fbe7c3239699802c6422701e760d98edc96e8b980f7f322c3480b', 'warehouse'],   // warehouse/f1
  ['8669ef9e9300c7a6372d02b230aaee98f984337bac9cebe5b1316be1e7d61721', 'factory-inspection'],   // factory_inspection/f1
  ['52597920b820608c7de49ef63b562e72f7480324a0da75af5b1a96b061bda1a8', 'factory-inspection-alt1'],   // factory_inspection_alt1/f1
  ['d3daa2c7c767ce7d7d58b31c44c703b2d1b9f79b2179b9f908d96ba315641a2d', 'factory-zone-f1'],   // factory_zone/f1
  ['a28e13e398c5984c5a315c12182593e4552324adb7bfec0fcef5438a73b2425d', 'factory-zone-f2'],   // factory_zone/f2
  ['e36a96d7619a8a721e0a922f6a57491cf9d99c31f47de5995ff413ba25302955', 'element-course'],   // element_course/f1
]);
type TopMeta = { bounds: [number, number, number, number]; map: { origin: number[]; res: number; w: number; h: number } };
const TOP_PNG = import.meta.glob<string>('../../../mobile/sim/assets/*/top.png', { eager: true, query: '?url', import: 'default' });
const TOP_META = import.meta.glob<TopMeta>('../../../mobile/sim/assets/*/top.json', { eager: true, import: 'default' });
export type Top = { href: string; x: number; y: number; width: number; height: number };
type Ver = Pick<MapVersion, 'provenance' | 'image_sha256' | 'origin' | 'resolution' | 'width' | 'height'>;
/** 판에 깔 사진 자리(그림 픽셀). 시뮬 등록 판이 아니거나 연결된 시뮬 그림이 아니거나 판 좌표(origin·해상도·크기)가 사진을 구운 지도와 다르면 null */
export function topOf(v?: Ver | null): Top | null {
  const id = v?.provenance === 'SIMULATION' && SIM_TOP.get(v.image_sha256), t = id && TOP_META[`../../../mobile/sim/assets/${id}/top.json`], href = id && TOP_PNG[`../../../mobile/sim/assets/${id}/top.png`];
  if (!v || !t || !href) return null;
  const { map: m, bounds: [x0, y0, x1, y1] } = t, r = v.resolution;
  if (m.res !== r || m.w !== v.width || m.h !== v.height || m.origin.length !== 3 || m.origin.some((o, i) => o !== v.origin[i])) return null;
  return { href, x: (x0 - v.origin[0]) / r, y: v.height - (y1 - v.origin[1]) / r, width: (x1 - x0) / r, height: (y1 - y0) / r };   // origin 방향 0(위 검사) — 사진 위쪽 = +y
}

/** 지도 보기(실제 모습 = 사진 + 장애물 지도 반투명 / 장애물 지도만) — 이 기기에 기억(localStorage fh.mapLook), 못 읽거나 못 써도 이 탭에는 반영 */
export type Look = 'photo' | 'map';
const LOOK_KEY = 'fh.mapLook', lookers = new Set<() => void>();
let look: Look = (() => { try { return localStorage.getItem(LOOK_KEY) === 'map' ? 'map' : 'photo'; } catch { return 'photo'; } })();
export function setLook(x: Look) {
  look = x;
  try { localStorage.setItem(LOOK_KEY, x); } catch { /* 기억 못 해도 이 탭에는 반영 */ }
  lookers.forEach((f) => f());
}
export const useLook = () => useSyncExternalStore((f) => { lookers.add(f); return () => { lookers.delete(f); }; }, () => look);

/** RGBA 화소에서 벽(빨강 < 0.4, 불투명) 범위. 없으면 null */
export function bounds(d: ArrayLike<number>, w: number, h: number): Box | null {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    if (d[i] < WALL && d[i + 3] > 127) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  return x1 < 0 ? null : [x0, y0, x1 - x0 + 1, y1 - y0 + 1];
}

const seen = new Map<string, Box | null>();   // 판 ID → 벽 범위(판 그림은 바뀌지 않는다)
/** 판 그림의 벽 범위(그림 픽셀). 못 읽으면(받는 중·실패·너무 큼) null = 전체 그림 */
export function useWalls(id?: string): Box | null {
  const [b, setB] = useState<{ id?: string; box: Box | null }>({ box: null });
  useEffect(() => {
    if (!id) return;
    if (seen.has(id)) return setB({ id, box: seen.get(id)! });
    let live = true;
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth, h = img.naturalHeight;
      let box: Box | null = null;
      try {   // ponytail: 1600만 화소(4000²)가 넘으면 읽지 않고 전체 그림 — 더 큰 지도가 오면 줄여 읽기
        const c = document.createElement('canvas'), g = w * h <= 16e6 ? (c.width = w, c.height = h, c.getContext('2d', { willReadFrequently: true })) : null;
        if (g) { g.drawImage(img, 0, 0); box = bounds(g.getImageData(0, 0, w, h).data, w, h); }
      } catch { box = null; }
      seen.set(id, box);
      if (live) setB({ id, box });
    };
    img.src = api.imageUrl(id);
    return () => { live = false; img.onload = null; };
  }, [id]);
  return b.id === id ? b.box : null;
}

/** 처음 화면: 벽 범위 + 꼭 보일 점(요소 자리, 그림 픽셀) + 여백(1 m 또는 6%), 전체 그림 안으로. 벽을 모르면 전체 */
export function around(walls: Box | null, pts: P[], full: Box, res: number): Box {
  if (!walls) return full;
  let x0 = walls[0], y0 = walls[1], x1 = x0 + walls[2], y1 = y0 + walls[3];
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const m = Math.max(1 / res, 0.06 * Math.max(x1 - x0, y1 - y0));
  x0 = Math.max(full[0], x0 - m); y0 = Math.max(full[1], y0 - m); x1 = Math.min(full[0] + full[2], x1 + m); y1 = Math.min(full[1] + full[3], y1 + m);
  return x1 > x0 && y1 > y0 ? [x0, y0, x1 - x0, y1 - y0] : full;
}

/** 화면 좌표 → svg viewBox 좌표. svg 는 viewBox 를 가운데 맞춤으로 늘린다(preserveAspectRatio 기본값) */
export function toView(svg: Element, cx: number, cy: number): P {
  return inBox(svg.getBoundingClientRect(), (svg.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number) as Box, cx, cy);
}
const inBox = (b: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>, [x, y, w, h]: Box, cx: number, cy: number): P => {
  const k = Math.min(b.width / w, b.height / h);
  return [x + (cx - b.left - (b.width - w * k) / 2) / k, y + (cy - b.top - (b.height - h * k) / 2) / k];
};

/** 축척 막대: k = 화면 px / 그림 픽셀. 화면 100px 쯤 안의 1·2·5 단위 길이 */
export function scaleBar(res: number, k: number): { m: number; px: number; text: string } | null {
  if (!(k > 0) || !(res > 0)) return null;
  const want = (100 * res) / k, e = 10 ** Math.floor(Math.log10(want)), m = [5, 2, 1].map((n) => n * e).find((n) => n <= want * (1 + 1e-9))!;
  return { m, px: (m / res) * k, text: m >= 1 ? `${+m.toPrecision(3)} m` : `${Math.round(m * 100)} cm` };
}

const SLOP = 8;   // 화면 px — 편집 한 손가락이 이만큼 움직이기 전엔 집기일 수 있어 넘기지 않는다
type View = { cx: number; cy: number; z: number };   // 가운데(그림 픽셀) + 배율(1 = 맞춤)
type Props = Omit<SVGProps<SVGSVGElement>, 'viewBox' | 'ref'> & {
  full: Box; fit?: Box; res: number;
  edit?: boolean;   // 왼쪽 누름·한 손가락은 부른 쪽(그리기·찍기) — 이동은 가운데 단추·두 손가락
  still?: boolean;   // 확대·이동·단추 없음(작은 지도 단추 안)
  at?: CSSProperties;   // 단추·축척 칸을 지도 위에 띄울 자리(가장 가까운 position 조상 기준, 시뮬 영상 칸). 없으면 지도 아래 줄
  photo?: Ver | null;   // 이 판이 시뮬 월드 그림이면 «실제 모습» 사진을 그림 밑에 깔고 보기 단추를 단다(topOf)
};

/** 판 그림 틀(svg + 확대 단추·축척). 포인터 처리기는 이동·집기 아닐 때만 넘긴다 */
export const MapFrame = forwardRef<SVGSVGElement, Props>(function MapFrame({ full, fit = full, res, edit, still, at, photo, style, children, onPointerDown, onPointerMove, onPointerUp, onPointerCancel, ...rest }, ref) {
  const own = useRef<SVGSVGElement | null>(null), home = (): View => ({ cx: fit[0] + fit[2] / 2, cy: fit[1] + fit[3] / 2, z: 1 });
  const [v, setV] = useState(home), [size, setSize] = useState<P>([0, 0]);
  const fk = fit.join(' '), uk = full.join(' '), last = useRef({ fk, uk, moved: false });
  // 새 판이면 맞춤으로. 벽 범위가 늦게 오면 아직 움직이지 않았을 때만 맞춤으로
  useEffect(() => {
    const l = last.current, fresh = l.uk !== uk;
    if (fresh || (l.fk !== fk && !l.moved)) { setV(home()); last.current = { fk, uk, moved: false }; } else last.current = { ...l, fk };
  }, [fk, uk]);
  const box = (o: View): Box => [o.cx - fit[2] / o.z / 2, o.cy - fit[3] / o.z / 2, fit[2] / o.z, fit[3] / o.z];
  const clamp = (o: View): View => {
    const lo = Math.min(1, 1 / (1.1 * Math.max(full[2] / fit[2], full[3] / fit[3])));   // 전체 그림이 다 보일 만큼까지 줄임
    return { z: Math.min(40, Math.max(lo, o.z)), cx: Math.min(full[0] + full[2], Math.max(full[0], o.cx)), cy: Math.min(full[1] + full[3], Math.max(full[1], o.cy)) };
  };
  const put = (f: (o: View) => View) => { last.current.moved = true; setV((o) => clamp(f(o))); };
  const rect = () => own.current?.getBoundingClientRect() ?? { left: 0, top: 0, width: 0, height: 0 };
  /** f 배로 확대(화면 점 sx·sy 를 그 자리에 둔 채, 없으면 가운데) */
  const zoom = (f: number, sx?: number, sy?: number) => put((o) => {
    const [px, py] = sx == null ? [o.cx, o.cy] : inBox(rect(), box(o), sx, sy!), z = clamp({ ...o, z: o.z * f }).z, r = o.z / z;
    return { z, cx: px + (o.cx - px) * r, cy: py + (o.cy - py) * r };
  });
  /** 화면 px 만큼 끌기 */
  const pan = (dx: number, dy: number) => put((o) => { const b = rect(), [, , w, h] = box(o), k = Math.min(b.width / w, b.height / h) || 1; return { ...o, cx: o.cx - dx / k, cy: o.cy - dy / k }; });

  useEffect(() => {
    const el = own.current;
    if (!el) return;
    const m = () => { const b = el.getBoundingClientRect(); setSize([b.width, b.height]); };
    m();
    if (typeof ResizeObserver === 'undefined') return;
    const o = new ResizeObserver(m);
    o.observe(el);
    return () => o.disconnect();
  }, []);
  // 휠 = 확대(쪽 굴림 막기라 passive 아님). 지도 위에서만
  useEffect(() => {
    const el = own.current;
    if (!el || still) return;
    const on = (e: WheelEvent) => { e.preventDefault(); zoom(Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.002)), e.clientX, e.clientY); };
    el.addEventListener('wheel', on, { passive: false });
    return () => el.removeEventListener('wheel', on);
  }, [still, fk, uk]);

  // 누른 손가락·단추. mode: pan = 끌어 옮김, pinch = 두 손가락, pass = 부른 쪽에 넘김(편집 한 손가락)
  // 편집 한 손가락 누름은 바로 넘기지 않고 쥐고 있다(held): 뗄 때나 SLOP 넘게 움직일 때 넘긴다 — 그 전에 둘째 손가락이 오면 집기라 버린다(지점이 남지 않게)
  const pts = useRef(new Map<number, P>()), mode = useRef<'' | 'pan' | 'pinch' | 'pass'>(''), held = useRef<PointerEvent<SVGSVGElement> | null>(null);
  const grab = (e: PointerEvent<SVGSVGElement>) => { pts.current.set(e.pointerId, [e.clientX, e.clientY]); own.current?.setPointerCapture?.(e.pointerId); };
  const down = (e: PointerEvent<SVGSVGElement>) => {
    if (still) return onPointerDown?.(e);
    if (e.pointerType === 'touch') {
      if (pts.current.size) {   // 두 번째 손가락: 집기. 편집 중 한 손가락 그리기는 취소로 알린다(끌기·사각형이 남지 않게)
        if (mode.current === 'pass' && !held.current) onPointerCancel?.(e);
        held.current = null; mode.current = 'pinch'; grab(e); return;
      }
      if (edit) { mode.current = 'pass'; pts.current.set(e.pointerId, [e.clientX, e.clientY]); held.current = e; return; }
      mode.current = 'pan'; grab(e); return;
    }
    if (e.button === 1 || (!edit && e.button === 0)) { e.preventDefault(); mode.current = 'pan'; grab(e); return; }
    onPointerDown?.(e);
  };
  const move = (e: PointerEvent<SVGSVGElement>) => {
    const m = mode.current, was = pts.current.get(e.pointerId);
    if ((m === 'pan' || m === 'pinch') && was) {
      const all = [...pts.current.entries()];
      pts.current.set(e.pointerId, [e.clientX, e.clientY]);
      if (m === 'pan' || all.length < 2) { if (m === 'pan' || !edit) pan(e.clientX - was[0], e.clientY - was[1]); return; }
      const [a, b] = all.slice(0, 2).map(([, q]) => q), now = all.slice(0, 2).map(([id, q]) => (id === e.pointerId ? [e.clientX, e.clientY] as P : q));   // 앞 두 손가락의 전·후
      const d0 = Math.hypot(a[0] - b[0], a[1] - b[1]), d1 = Math.hypot(now[0][0] - now[1][0], now[0][1] - now[1][1]);
      const mx = (now[0][0] + now[1][0]) / 2, my = (now[0][1] + now[1][1]) / 2;
      pan(mx - (a[0] + b[0]) / 2, my - (a[1] + b[1]) / 2);
      if (d0 > 0 && d1 > 0) zoom(d1 / d0, mx, my);
      return;
    }
    const h = held.current;
    if (h && h.pointerId === e.pointerId) {
      if (Math.hypot(e.clientX - h.clientX, e.clientY - h.clientY) < SLOP) return;
      held.current = null; onPointerDown?.(h);
    }
    if (m === 'pass' && was) pts.current.set(e.pointerId, [e.clientX, e.clientY]);
    if (m !== 'pinch') onPointerMove?.(e);
  };
  const end = (e: PointerEvent<SVGSVGElement>) => {
    const had = pts.current.delete(e.pointerId), m = mode.current;
    if (!pts.current.size) mode.current = '';
    if ((m === 'pan' || m === 'pinch') && had) return;
    const h = held.current;
    if (h && h.pointerId === e.pointerId) { held.current = null; if (e.type !== 'pointerup') return; onPointerDown?.(h); }   // 누름(탭)
    (e.type === 'pointerup' ? onPointerUp : onPointerCancel)?.(e);
  };

  const [x, y, w, h] = box(v), bar = scaleBar(res, Math.min(size[0] / w, size[1] / h));
  const top = topOf(photo), want = useLook(), [bad, setBad] = useState(''), shown = !!top && want === 'photo' && bad !== top.href;
  const set = (el: SVGSVGElement | null) => { own.current = el; if (typeof ref === 'function') ref(el); else if (ref) ref.current = el; };
  const svg = <svg ref={set} viewBox={`${x} ${y} ${w} ${h}`} onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }} onPointerDown={down} onPointerMove={move} onPointerUp={end} onPointerCancel={end}
    style={{ background: 'var(--bg)', ...(!still && { touchAction: 'none', cursor: edit ? undefined : 'grab' }), ...(shown && ({ '--fh-map-a': 0.45 } as CSSProperties)), ...style }} data-look={top ? (shown ? 'photo' : 'map') : undefined} {...rest}>
    {shown && <image href={top.href} x={top.x} y={top.y} width={top.width} height={top.height} preserveAspectRatio="none" data-map-top onError={() => setBad(top.href)} style={{ pointerEvents: 'none' }} />}
    {children}</svg>;
  if (still) return svg;
  // 고른 보기 = 테두리·바탕 강조(drive.css .dv-views 단추와 같은 값)
  const pick = top && <div role="group" aria-label="지도 보기" style={{ display: 'flex', gap: 4, pointerEvents: 'auto' }}>
    {([['photo', '실제 모습'], ['map', '장애물 지도']] as const).map(([k, t]) => <button key={k} type="button" className="btn" aria-pressed={want === k} data-look-btn={k} style={{ padding: '0 10px', ...(want === k && { borderColor: 'var(--accent)', background: 'var(--acc-bg)' }) }} onClick={() => setLook(k)}>{t}</button>)}
  </div>;
  const miss = top && want === 'photo' && bad === top.href && <p className="lv-note" role="status" data-top-bad style={{ margin: 0, pointerEvents: 'none' }}>실제 모습 사진을 불러오지 못해 장애물 지도만 보입니다.</p>;
  const btns = <div role="group" aria-label="지도 확대" style={{ display: 'flex', gap: 4, pointerEvents: 'auto' }}>
    <button type="button" className="btn" aria-label="축소" style={{ padding: '0 12px' }} onClick={() => zoom(1 / 1.5)}>−</button>
    <button type="button" className="btn" aria-label="확대" style={{ padding: '0 12px' }} onClick={() => zoom(1.5)}>+</button>
    <button type="button" className="btn" style={{ padding: '0 12px' }} onClick={() => { setV(home()); last.current.moved = false; }}>맞춤</button>
  </div>;
  const scale = bar && <div data-scale role="img" aria-label={`축척 ${bar.text}`} style={{ padding: '2px 8px 4px', borderRadius: 6, background: 'var(--panel)', border: '1px solid var(--line)', color: 'var(--text)', fontSize: 12, lineHeight: 1.3, pointerEvents: 'none' }}>
    {bar.text}<span style={{ display: 'block', width: bar.px, height: 5, border: '2px solid var(--text)', borderTop: 'none' }} /></div>;
  // at 이 있으면(시뮬 영상 칸) 단추·축척을 그 자리에 띄우고, 없으면 축척은 지도 왼쪽 아래 모서리·단추는 지도 아래 줄(좁은 화면에서 지도를 가리지 않게)
  return at ? <>{svg}<div data-map-ctl style={{ position: 'absolute', zIndex: 1, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 6, pointerEvents: 'none', ...at }}>{btns}{pick}{scale}{miss}</div></>
    : <><div style={{ position: 'relative' }}>{svg}<div style={{ position: 'absolute', left: 8, bottom: 8 }}>{scale}</div></div>
      <div data-map-ctl className="fh-row" style={{ justifyContent: 'flex-end', marginTop: 6 }}>{miss}{pick}{btns}</div></>;
});

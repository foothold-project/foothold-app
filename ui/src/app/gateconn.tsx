// 로그인 화면 서버 카드 보조(①): 연결 단계 줄 · 저장한 접속 프로필 · 붙여넣기 · QR 스캔(카메라, 있을 때만) · 이 관문 주소 QR/공유.
// 다루는 값은 관문 origin(https://호스트:포트)뿐 — 계정·비밀번호·토큰·표는 QR·공유·저장에 넣지 않는다. 로그인 요청으로 연결을 시험하지 않는다.
import { useEffect, useRef, useState } from 'react';
import qrcode from 'qrcode-generator';
import { STEPS, originFromText, type StepSt } from '../data/gate_profile';
import { startScan } from '../data/qrscan';
import { startNearby, type Found, type NearbyApi } from '../data/discover';

const MARK: Record<StepSt, string> = { ok: '✓', bad: '✕', unk: '–', brw: '?' };
const COL: Record<StepSt, string> = { ok: 'var(--ok)', bad: 'var(--bad, #FF5A4F)', unk: 'var(--muted, #8A96A0)', brw: 'var(--muted, #8A96A0)' };
const SMALL = { minHeight: 44, padding: '0 12px', borderRadius: 10, fontSize: 14, fontWeight: 600, cursor: 'pointer', background: 'transparent', color: 'var(--accent)', border: '1px solid var(--line2)' } as const;

/** 단계 줄: 앞 네 칸은 검사 결과, 로그인·링크는 로그인 뒤 조종 화면에서 확인 */
export function ConnSteps({ st, why, ms }: { st: StepSt[]; why: string; ms: number | null }) {
  const all: StepSt[] = [...st, ...(st.length < 6 ? Array(6 - st.length).fill('unk') : [])];
  return <div role="status" aria-label="연결 단계" style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 10px', fontSize: 12, padding: '6px 2px', alignItems: 'center' }}>
    {STEPS.map((n, i) => <span key={n} style={{ color: COL[all[i]], whiteSpace: 'nowrap' }}>{`${MARK[all[i]]} ${n}${all[i] === 'brw' ? '(브라우저 처리 · 신뢰 미확인)' : ''}`}</span>)}
    {ms != null && <span className="mono" style={{ color: 'var(--muted, #8A96A0)' }}>{`앱↔관문 ${Math.round(ms)} ms`}</span>}
    {why && <span style={{ flexBasis: '100%', color: 'var(--warn, #FFB547)', overflowWrap: 'anywhere' }}>{why}</span>}
  </div>;
}

/** 주소 QR(평문 origin 하나). 라이브러리 출력은 GIF data URL → img(문서에 HTML 삽입 0) */
export function QrImg({ text, size = 4 }: { text: string; size?: number }) {
  const q = qrcode(0, 'M'); q.addData(text); q.make();
  return <img src={q.createDataURL(size, 8)} alt={`QR: ${text}`} style={{ imageRendering: 'pixelated', background: '#fff', borderRadius: 6, display: 'block' }} />;
}

/** 카메라 QR 스캔 — BarcodeDetector + getUserMedia 둘 다 있을 때만 버튼이 보인다. 닫기·숨김·떠남에서 카메라 즉시 끔 */
export const canScan = () => typeof window !== 'undefined' && 'BarcodeDetector' in window && !!navigator.mediaDevices?.getUserMedia;
export function QrScan({ onOrigin, onClose }: { onOrigin: (o: string) => void; onClose: (why?: string) => void }) {
  const vid = useRef<HTMLVideoElement>(null), [msg, setMsg] = useState('카메라 여는 중…'), kill = useRef<() => boolean>(() => false);
  useEffect(() => {
    const stop = kill.current = startScan({
      getMedia: () => navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false }),
      video: vid.current!, makeDet: () => new (window as any).BarcodeDetector({ formats: ['qr_code'] }), parse: originFromText,
      onOrigin, onClose, setMsg,
    });
    const hid = () => { if (document.visibilityState === 'hidden' && stop()) onClose('화면을 떠나 카메라를 껐습니다'); };
    const left = () => { stop(); };
    document.addEventListener('visibilitychange', hid); addEventListener('pagehide', left);
    return () => { stop(); document.removeEventListener('visibilitychange', hid); removeEventListener('pagehide', left); };
  }, []);
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
    <video ref={vid} muted playsInline style={{ width: '100%', maxHeight: 240, background: '#000', borderRadius: 8, objectFit: 'cover' }} />
    <span role="status" style={{ fontSize: 12 }}>{msg}</span>
    <button type="button" style={SMALL} onClick={() => { kill.current(); onClose(); }}>스캔 닫기</button>
  </div>;
}

/** 이 관문 주소 보내기: 주소 고르기 → QR + 공유/복사(주소만) */
export function ShareGate({ urls }: { urls: string[] }) {
  const [i, setI] = useState(0), [note, setNote] = useState('');
  if (!urls.length) return null;
  const u = urls[Math.min(i, urls.length - 1)];
  const share = async () => {
    try {
      if (navigator.share) { await navigator.share({ title: 'FOOTHOLD 관문 주소', text: u }); setNote('공유 창 열림'); return; }
      await navigator.clipboard.writeText(u); setNote('주소 복사됨');
    } catch (e) { setNote((e as Error).name === 'AbortError' ? '공유 취소' : `공유·복사 안 됨 — 주소를 길게 눌러 복사(${(e as Error).message || e})`); }
  };
  return <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
    <QrImg text={u} />
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0, flex: 1 }}>
      <span style={{ fontSize: 12 }}>다른 기기에서 이 QR 을 찍으면 이 관문 주소가 열립니다(주소만 — 계정·비밀번호 없음)</span>
      {urls.length > 1 && <select className="inp" aria-label="보낼 주소" value={i} onChange={(e) => setI(Number(e.target.value))}>
        {urls.map((x, k) => <option key={x} value={k}>{x}</option>)}</select>}
      <span className="mono" style={{ fontSize: 12, overflowWrap: 'anywhere', userSelect: 'all' }}>{u}</span>
      <button type="button" style={SMALL} onClick={share}>{typeof navigator !== 'undefined' && 'share' in navigator ? '주소 공유' : '주소 복사'}</button>
      {note && <span role="status" style={{ fontSize: 12 }}>{note}</span>}
    </div>
  </div>;
}
export { SMALL };

/** 주변 기기(같은 Wi-Fi 의 FOOTHOLD 관문 광고) — 이 칸이 보이는 동안만 검색, 닫기·숨김·떠남에서 멈춤. 고르면 입력칸에 넣기까지만(저장은 «주소 저장») */
export function Nearby({ api, native, cur, onPick }: { api: NearbyApi | null; native: boolean; cur: string; onPick: (o: string) => void }) {
  const [f, setF] = useState<Found | null>(null), [run, setRun] = useState(0);
  useEffect(() => {
    if (!api) return;
    setF(null);
    const stop = startNearby(api, 5000, setF), left = () => stop();
    const hid = () => { if (document.visibilityState === 'hidden') stop('화면을 떠나 검색을 멈춤 — 다시 검색'); };
    document.addEventListener('visibilitychange', hid); addEventListener('pagehide', left);
    return () => { stop(); document.removeEventListener('visibilitychange', hid); removeEventListener('pagehide', left); };
  }, [api, run]);
  const note = { fontSize: 12, color: 'var(--muted, #8A96A0)' } as const;
  return <div role="group" aria-label="주변 기기" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
    <span className="lbl" style={{ fontSize: 12 }}>주변 기기 · 같은 Wi-Fi 의 FOOTHOLD 관문(미검증 — 고르면 입력칸에만)</span>
    {!api ? <span role="status" style={note}>{native ? '이 앱 판에는 주변 검색이 없음 — 새 앱 설치 뒤 · 지금은 저장한 주소·QR·주소 입력' : '이 브라우저는 주변 검색 불가 — 저장한 주소·QR·주소 입력'}</span> : <>
      {f?.items.map((it) => <button type="button" key={it.origin} style={{ ...SMALL, textAlign: 'left', color: 'inherit', overflowWrap: 'anywhere' }} onClick={() => onPick(it.origin)}>
        {`${it.name || it.origin} · 미검증${it.origin === cur ? ' · 지금' : ''}`}{it.name && <span className="mono" style={{ display: 'block', ...note }}>{it.origin}</span>}</button>)}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span role="status" style={{ ...note, flex: 1, minWidth: 0 }}>{f ? f.msg || `${f.items.length}개 찾음` : '찾는 중…(최대 5초)'}</span>
        <button type="button" style={SMALL} disabled={!f} onClick={() => setRun((n) => n + 1)}>다시 검색</button>
      </div></>}
    <span style={note}>Tailscale 주소는 주변 검색에 안 나옴 — 저장한 주소를 쓰세요</span>
    <span style={note}>Go2 로봇 직접 검색: 미지원(확인된 공식 프로토콜·연결 어댑터 없음) — FOOTHOLD 관문을 거친 로봇만 연결</span>
  </div>;
}

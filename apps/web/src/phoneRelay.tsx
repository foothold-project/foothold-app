import { useEffect, useRef, useState } from 'react';
import type { PhoneRelayState } from '../../contracts/ts';

/** 폰 경유 값이 지금 쓸 만한가: 폰 나이 3초 미만 + 서버가 준 유효 시간 안 */
export function relayFresh(r: PhoneRelayState | null | undefined, at: number | undefined, now = performance.now()) {
  if (r?.source !== 'PHONE' || at === undefined || !Number.isFinite(at)) return false;
  const e = (now - at) / 1000, age = r.age_s + e;
  return Number.isFinite(age) && e >= 0 && age < 3 && e < r.valid_for_s;
}

/** 폰 경유 값이 relayFresh 로 낡는 순간 다시 그린다(새 state 없이 유효 시간만 지나도). seconds = 그때까지 1초마다도(나이 표시용) */
export function useRelayExpiry(report: PhoneRelayState | null | undefined, receivedAt: number | undefined, seconds = false) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!report || receivedAt === undefined) return;
    const elapsed = (performance.now() - receivedAt) / 1000;
    const remaining = Math.min(3 - report.age_s, report.valid_for_s) - elapsed;
    if (!(remaining > 0)) return;
    const interval = seconds ? setInterval(() => tick((n) => n + 1), 1000) : undefined;
    const expiry = setTimeout(() => { clearInterval(interval); tick((n) => n + 1); }, remaining * 1000);
    return () => { clearInterval(interval); clearTimeout(expiry); };
  }, [report, receivedAt, seconds]);
}

/** Display provenance only. Nothing here updates Robot.online, direct values or actions. */
export function PhoneRelay({ report, receivedAt, compact = false }: {
  report?: PhoneRelayState | null; receivedAt?: number; compact?: boolean;
}) {
  const last = useRef<{ report: PhoneRelayState; at: number } | null>(null);
  const current = report?.source === 'PHONE' ? { report, at: receivedAt ?? performance.now() } : null;
  if (current) last.current = current;
  useRelayExpiry(report, receivedAt, true);
  if (!last.current) return null;
  const sample = last.current, elapsed = (performance.now() - sample.at) / 1000;
  const age = sample.report.age_s + elapsed;
  const fresh = relayFresh(report, receivedAt);
  const label = `폰 경유 · ${fresh ? `${Math.floor(age)}초 전` : '모름'}`;
  if (compact) return <span className="lbl" data-phone-relay>{label}</span>;
  return <div aria-label="폰 경유 상태" data-phone-relay>
    <span className="lbl">{label}</span>
    {fresh && <p className="lv-note">배터리 {sample.report.battery?.soc == null ? '모름' : `${sample.report.battery.soc}%`}
      {' · '}속도 {sample.report.speed == null ? '모름' : `${sample.report.speed.toFixed(1)} m/s`}
      {sample.report.devices.map((d) => <span key={d.key}>{' · '}{d.label}: {d.state === 'OK' ? '정상' : d.state === 'ERROR' ? '오류' : '모름'}</span>)}</p>}
  </div>;
}

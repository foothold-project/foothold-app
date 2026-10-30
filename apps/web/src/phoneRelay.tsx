import { useEffect, useRef, useState } from 'react';
import type { PhoneRelayState } from '../../contracts/ts';

/** Display provenance only. Nothing here updates Robot.online, direct values or actions. */
export function PhoneRelay({ report, receivedAt, compact = false }: {
  report?: PhoneRelayState | null; receivedAt?: number; compact?: boolean;
}) {
  const [, tick] = useState(0);
  const last = useRef<{ report: PhoneRelayState; at: number } | null>(null);
  const current = report?.source === 'PHONE' ? { report, at: receivedAt ?? performance.now() } : null;
  if (current) last.current = current;
  useEffect(() => {
    if (!report || receivedAt === undefined) return;
    const elapsed = (performance.now() - receivedAt) / 1000;
    const remaining = Math.min(3 - report.age_s, report.valid_for_s) - elapsed;
    if (!(remaining > 0)) return;
    const interval = setInterval(() => tick((n) => n + 1), 1000);
    const expiry = setTimeout(() => { clearInterval(interval); tick((n) => n + 1); }, remaining * 1000);
    return () => { clearInterval(interval); clearTimeout(expiry); };
  }, [report, receivedAt]);
  if (!last.current) return null;
  const sample = last.current, elapsed = (performance.now() - sample.at) / 1000;
  const age = sample.report.age_s + elapsed;
  const fresh = current !== null && receivedAt !== undefined && Number.isFinite(receivedAt)
    && Number.isFinite(age) && elapsed >= 0 && age < 3 && elapsed < sample.report.valid_for_s;
  const label = `폰 경유 · ${fresh ? `${Math.floor(age)}초 전` : '모름'}`;
  if (compact) return <span className="lbl" data-phone-relay>{label}</span>;
  return <div aria-label="폰 경유 상태" data-phone-relay>
    <span className="lbl">{label}</span>
    {fresh && <p className="lv-note">배터리 {sample.report.battery?.soc == null ? '모름' : `${sample.report.battery.soc}%`}
      {' · '}속도 {sample.report.speed == null ? '모름' : `${sample.report.speed.toFixed(1)} m/s`}
      {sample.report.devices.map((d) => <span key={d.key}>{' · '}{d.label}: {d.state === 'OK' ? '정상' : d.state === 'ERROR' ? '오류' : '모름'}</span>)}</p>}
  </div>;
}

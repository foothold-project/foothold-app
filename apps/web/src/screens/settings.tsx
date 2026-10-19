// 설정 탭(02 F-ST-01·02, 03 UX §5) — 개인 설정 + 조직 기준값(서버 값). 총괄에게만 계정·로봇 배정.
import { useEffect, useState, type FormEvent } from 'react';
import type { OrgSettings } from '../../../contracts/ts';
import { api } from '../api';
import type { Ctx } from '../screens';

/** 로봇이 0대여도 열리는 탭이라 Ctx 전체가 아니라 필요한 것만 받는다 */
export function Settings(c: Pick<Ctx, 'user' | 'light' | 'setLight'>) {
  const admin = c.user.role === 'ORG_ADMIN';
  return <>
    <section className="lv-card" aria-label="개인 설정">
      <h2>개인 설정</h2>
      <div className="fh-row"><span>화면 밝기</span><button type="button" className="btn" aria-pressed={c.light} onClick={() => c.setLight(!c.light)}>{c.light ? '밝게' : '어둡게'}</button></div>
    </section>
    <OrgLimits admin={admin} />
    {admin && <section className="lv-card" aria-label="조직 설정"><h2>계정 · 로봇 배정</h2><div className="fh-slot">계정·로봇 배정 자리</div></section>}
  </>;
}

/** 조직 기준값(05 API §8 GET·PATCH /org/settings). 범위는 계약(apps/contracts/models.py OrgSettingsPatch)과 같게 — 검사는 서버가 한다 */
const LIMITS: { key: keyof OrgSettings; label: string; unit: string; min: number; max: number; step: number }[] = [
  { key: 'battery_low_pct', label: '배터리 부족 기준', unit: '%', min: 5, max: 50, step: 1 },
  { key: 'run_min_battery_pct', label: '실행 시작 최소 배터리', unit: '%', min: 10, max: 90, step: 1 },
  { key: 'deviation_m', label: '경로 이탈 거리', unit: 'm', min: 0.5, max: 5, step: 0.1 },
  { key: 'lease_request_timeout_s', label: '조종권 요청 응답 시간', unit: '초', min: 5, max: 30, step: 1 },
  { key: 'link_loss_wait_s', label: '연결 끊김 대기 시간', unit: '초', min: 0, max: 30, step: 1 },
];
const range = (f: (typeof LIMITS)[number]) => `${f.min}~${f.max} ${f.unit}`;
const NO_EDIT = '조직 기준값은 총괄 운영 관리자만 바꿀 수 있습니다.';

function OrgLimits({ admin }: { admin: boolean }) {
  const [saved, setSaved] = useState<OrgSettings | null>(null), [draft, setDraft] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ text: string; ok?: boolean } | null>(null), [busy, setBusy] = useState(false);
  const show = (s: OrgSettings) => { setSaved(s); setDraft(Object.fromEntries(LIMITS.map((f) => [f.key, String(s[f.key])]))); };
  useEffect(() => { api.settings().then(show, (e: Error) => setMsg({ text: e.message })); }, []);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!saved || busy) return;
    const patch = Object.fromEntries(LIMITS.filter((f) => draft[f.key] !== String(saved[f.key])).map((f) => [f.key, draft[f.key].trim() === '' ? NaN : Number(draft[f.key])]));
    if (!Object.keys(patch).length) return setMsg({ text: '바뀐 값이 없습니다.', ok: true });
    setBusy(true);
    try { show(await api.saveSettings(patch)); setMsg({ text: '저장했습니다. 다음 실행부터 적용됩니다.', ok: true }); }
    catch (err) {
      // 서버 범위 검사(400 VALIDATION)는 어느 칸인지 알려 주지 않으므로 범위를 벗어난 칸을 함께 적는다
      const bad = LIMITS.filter((f) => f.key in patch && !(patch[f.key] >= f.min && patch[f.key] <= f.max && (f.step < 1 || Number.isInteger(patch[f.key]))));
      setMsg({ text: `${(err as Error).message}${bad.length ? ` 허용 범위: ${bad.map((f) => `${f.label} ${range(f)}${f.step < 1 ? '' : '(정수)'}`).join(', ')}` : ''}` });
    } finally { setBusy(false); }
  };
  return <section className="lv-card" aria-label="조직 기준값">
    <h2>조직 기준값</h2>
    {saved && <form className="fh-form" onSubmit={save} noValidate>
      {LIMITS.map((f) => <label key={f.key} className="fh-field"><span>{f.label} <span className="lbl">({range(f)})</span></span>
        <input className="inp" name={f.key} type="number" inputMode="decimal" min={f.min} max={f.max} step={f.step} readOnly={!admin} aria-describedby={admin ? undefined : 'why-org'}
          value={draft[f.key]} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })} /></label>)}
      <div className="fh-row">
        <button type="submit" className="btn pri" disabled={!admin || busy} aria-describedby={admin ? undefined : 'why-org'}>저장</button>
        {!admin && <span id="why-org" className="fh-why" data-why>{NO_EDIT}</span>}
      </div>
    </form>}
    {msg && <p className={`fh-msg${msg.ok ? ' ok' : ''}`} role={msg.ok ? 'status' : 'alert'}>{msg.text}</p>}
  </section>;
}

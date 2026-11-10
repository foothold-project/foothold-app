// 설정 탭(02 F-ST-01·02, 03 UX §5) — [공통 | 실기 | 시뮬 | 계정] 탭(11-02 설정 개편, 미리보기 runs/settings-preview). 조직 값은 서버(05 §8)가 범위·교차 검사,
// 고치기는 총괄만(운영 관리자는 보기만). 계정 관리(05 §2 /users)·시뮬 로봇 이름(05 §3)은 총괄에게만 보인다(01 AU-04: 권한 없는 기능은 숨김).
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import type { OrgSettings, OrgSettingsPatch, RobotSummary, Session, User as ApiUser } from '../../../contracts/ts';
import { api, expireAuth, type ApiFail } from '../api';
import { ROLE_NAME, robotName, type Role, type User } from '../fake';
import { REAL_CAPS, simTune } from '../phone';
import { Chip, type Ctx } from '../screens';
import './settings.css';

type Msg = { text: string; ok?: boolean } | null;
/** 긴 이름·아이디(128자)는 칸 안에서 줄을 바꾼다 */
const WRAP = { minWidth: 0, overflowWrap: 'anywhere' } as const;
const Note = ({ msg }: { msg: Msg }) => (msg ? <p style={WRAP} className={`fh-msg${msg.ok ? ' ok' : ''}`} role={msg.ok ? 'status' : 'alert'}>{msg.text}</p> : null);

const TABS = [['common', '공통'], ['real', '실기'], ['sim', '시뮬'], ['acct', '계정']] as const;
type Tab = (typeof TABS)[number][0];

/** 시뮬 탭에서 고를 모델: 등록부(mobile/sim/policy-modes.js) 정식 id·이름. go2-demo 는 명령·물리 없는 보기 전용이라 고칠 값이 없어 뺀다.
 *  등록부에 실기로 도는 모델이 없어 실기 탭은 «공통»만 보인다 */
export const SIM_MODELS = [['nvidia-demo', 'nvidia'], ['ame2-demo', 'AME-2'], ['start-demo', 'start']] as const;

/** 로봇이 0대여도 열리는 탭이라 Ctx 전체가 아니라 필요한 것만 받는다. 고른 탭은 화면 상태(주소 #해시 아님).
 *  네 묶음은 늘 그려 두고 hidden 으로만 숨긴다 — 탭을 바꿔도 쓰던 칸·한 번만 보이는 임시 비밀번호가 사라지지 않게 */
export function Settings(c: Pick<Ctx, 'user' | 'setMe' | 'refresh' | 'cancel'>) {
  const admin = c.user.role === 'ORG_ADMIN', [tab, setTab] = useState<Tab>('common'), org = useOrg(c.cancel), list = useRef<HTMLDivElement>(null);
  // 탭 목록 키(WAI-ARIA tabs): ←/→ 앞뒤(끝에서 돌아감), Home/End 처음·끝 — 고르면서 초점도 옮긴다
  const key = (e: KeyboardEvent) => {
    const i = TABS.findIndex(([id]) => id === tab), n = TABS.length;
    const j = e.key === 'ArrowRight' ? (i + 1) % n : e.key === 'ArrowLeft' ? (i + n - 1) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1;
    if (j < 0) return;
    e.preventDefault(); setTab(TABS[j][0]); list.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[j]?.focus();
  };
  const panel = (id: Tab, kids: ReactNode) => <div className="st-grid" role="tabpanel" id={`st-p-${id}`} aria-labelledby={`st-t-${id}`} hidden={tab !== id}>{kids}</div>;
  const card = (p: Omit<CardProps, 'org' | 'admin' | 'cancel'>) => <OrgCard org={org} admin={admin} cancel={c.cancel} {...p} />;
  // 고른 모델의 카드는 처음 고를 때 그려 두고 hidden 으로만 숨긴다 — 모델을 오가도 쓰던 칸이 사라지지 않게(탭과 같은 방식). '' = 공통
  const [model, setModel] = useState(''), [opened, setOpened] = useState<string[]>([]);
  const pickModel = (m: string) => { setModel(m); if (m && !opened.includes(m)) setOpened([...opened, m]); };
  const simCards = (m: string) => <div key={m} className="st-scope" data-model={m || undefined} hidden={model !== m}>
    {card({ id: 'simcap', model: m, label: '시뮬 속도 상한', cap: true, note: '모드·연결별 상한 안에서 적용합니다. 조직 설정으로 상한을 넓히지는 않습니다.', fields: SIM_CAP })}
    {card({ id: 'siminput', model: m, label: '조종 입력·임무 실행기', fields: SIM_INPUT })}
    {card({ id: 'simview', model: m, label: '표시', fields: SIM_VIEW })}
  </div>;
  const modelName = SIM_MODELS.find(([id]) => id === model)?.[1];
  return <div className="st">
    <div className="st-tabs" role="tablist" aria-label="설정 묶음" ref={list} onKeyDown={key}>
      {TABS.map(([id, name]) => <button key={id} type="button" role="tab" id={`st-t-${id}`} aria-controls={`st-p-${id}`} aria-selected={tab === id} tabIndex={tab === id ? 0 : -1} onClick={() => setTab(id)}>{name}</button>)}
    </div>
    <div className="st-legend" aria-label="표시 뜻"><span className="st-tag adm">총괄만 고침</span><span className="st-tag cap">시뮬 모드·연결 상한 안에서만</span><span className="st-tag lock">바꾸려면 별도 승인(보기만)</span></div>
    {org.err && <p className="fh-msg" role="alert">{org.err}</p>}
    {panel('common', card({ id: 'org', label: '조직 기준값', note: '실기·시뮬 모두에 쓰는 값. 저장하면 다음 실행부터 적용.', fields: COMMON }))}
    {panel('real', <>
      <div className="st-modelbar">
        <div className="st-tabs" role="group" aria-label="실기 값을 고칠 모델"><button type="button" aria-pressed="true">공통</button></div>
        <p className="st-note">실기에서 도는 모델이 하나뿐이라 모델별 값 없음</p>
      </div>
      {card({ id: 'lease', label: '조종권·연결', fields: LEASE })}
      {card({ id: 'speed', label: '속도 제한', bad: '실기 미검증', confirm: true, note: '로봇 쪽 상한보다 높게 넣어도 로봇 상한까지만. 0은 그 축을 끕니다. 폰 막대 끝은 실효 상한이며, 서버 경유 고정 명령이 상한을 넘으면 비활성·STOP 거절합니다.', fields: REAL, top: <RealTable /> })}
      <section className="lv-card st-fixed" aria-label="고정 안전값">
        <h2>고정 안전값</h2>
        <p className="st-note">로봇·서버 코드에 묶인 값. 화면에서는 보기만 합니다.</p>
        <div className="st-row"><span>입력이 끊기면 정지</span><b>0.3초 뒤</b></div>
        <div className="st-row"><span>로봇 출력 마감</span><b>0.30초</b></div>
        <div className="st-row"><span>실기 조종 시작 전 현장 승인</span><b>필요</b></div>
        <span><span className="st-tag lock">바꾸려면 별도 승인(보기만)</span></span>
      </section>
    </>)}
    {panel('sim', <>
      <div className="st-modelbar">
        <div className="st-tabs" role="group" aria-label="값을 고칠 모델">
          {[['', '공통'] as const, ...SIM_MODELS].map(([id, name]) => <button key={id} type="button" aria-pressed={model === id} onClick={() => pickModel(id)}>{name}</button>)}
        </div>
        <p className="st-note">{modelName ? `${modelName} 모델이 돌 때만 공통 값 대신 씁니다. 안 바꾼 칸은 공통 값을 따릅니다.` : '모든 모델의 기본값입니다. 모델을 고르면 그 모델에서만 쓸 값을 정할 수 있습니다.'}</p>
      </div>
      {simCards('')}
      {SIM_MODELS.filter(([id]) => opened.includes(id)).map(([id]) => simCards(id))}
      {admin && <Robots refresh={c.refresh} cancel={c.cancel} />}
    </>)}
    {panel('acct', <>
      <MyInfo user={c.user} setMe={c.setMe} cancel={c.cancel} />
      {admin && <Accounts me={c.user} cancel={c.cancel} />}
    </>)}
  </div>;
}

/** 고정표는 조직 상한으로 늘리거나 비례 조정하지 않는다. */
const RealTable = () => <details><summary>서버 경유 고정 명령표</summary><p className="st-note">전후·옆 1.5 m/s, 회전 0.5 라디안/초. 옆 명령 1.5는 조직 최대 1.0을 넘어 사용할 수 없습니다. 폰 실효 상한은 연결한 로봇의 조종 화면에서 확인하세요.</p></details>;

/** 조직 값(05 API §8 GET·PATCH /org/settings). 범위는 계약(apps/contracts/models.py OrgSettingsPatch)과 같게 — 검사는 서버가 한다.
 *  kind: 기본 숫자 칸, range = 미끄럼 막대, switch = 켜고 끄기. int = 정수만. cap = 시뮬 모드·연결 상한 안에서만 */
type Field = { key: keyof OrgSettings; label: string; unit: string; min: number; max: number; step: number; kind?: 'range' | 'switch'; cap?: boolean; hint?: string };
const num = (key: keyof OrgSettings, label: string, unit: string, min: number, max: number, step: number, more: Partial<Field> = {}): Field => ({ key, label, unit, min, max, step, ...more });
const COMMON = [
  num('battery_low_pct', '배터리 부족 기준', '%', 5, 50, 1),
  num('run_min_battery_pct', '실행 시작 최소 배터리', '%', 10, 90, 1),
  num('deviation_m', '경로 이탈 거리', 'm', 0.5, 5, 0.1),
];
const LEASE = [
  num('lease_request_timeout_s', '조종권 요청 응답 시간', '초', 5, 30, 1),
  num('link_loss_wait_s', '연결 끊김 대기 시간', '초', 0, 30, 1),
];
const REAL = [
  num('real_max_vx', '최대 전진 속도', 'm/s', 0, 1.5, 0.05, { hint: '기본 1.5' }),
  num('real_max_vx_back', '최대 후진 속도', 'm/s', 0, 1.5, 0.05, { hint: '기본 1.5' }),
  num('real_max_vy', '최대 옆걸음', 'm/s', 0, 1, 0.05, { hint: '기본 1.0' }),
  num('real_max_wz', '최대 회전', '라디안/초', 0, 4, 0.05, { hint: '기본 4.0' }),
  num('real_no_fast_server_drive', '서버 경유 빠른 이동 끄기', '', 0, 1, 1, { kind: 'switch', hint: '켜면 서버 경유 1.5 m/s 이동을 받지 않고 STOP 합니다. 회전·정지는 그대로.' })];
const SIM_CAP = [
  num('sim_max_vx', '최대 전진 속도', 'm/s', 0.2, 1.5, 0.05, { kind: 'range', hint: '기본 1.5. 모드 상한 안에서 적용합니다. AME-2는 위치 목표 정책으로 손 조종 목표에 속도 상한을 적용하지 않습니다.' }),
  num('sim_min_vx', '최소 이동 속도', 'm/s', 0, 0.5, 0.05, { kind: 'range', hint: '기본 0.2' }),
  num('sim_max_vy', '최대 옆걸음', 'm/s', 0, 0.5, 0.05, { kind: 'range', hint: '기본 0.5. 실기 옆걸음 한도와 별개입니다.' }),
  num('sim_max_wz', '최대 회전', '라디안/초', 0, 1.2, 0.05, { kind: 'range', hint: '기본 1.2. 모드별 제자리·이동 중 회전 상한 안에서 적용합니다.' }),
];
const SIM_INPUT = [
  num('sim_key_vx', '키보드 전진 속도', 'm/s', 0.1, 1.5, 0.05, { cap: true, hint: '기본 1.5' }),
  num('stick_deadzone', '막대 데드존', '', 0, 0.5, 0.01),
  num('sim_runner_vx', '시뮬 임무 실행기 최대 전진', 'm/s', 0.1, 1.5, 0.05, { cap: true }),
  num('sim_runner_wz', '시뮬 임무 실행기 최대 회전', '라디안/초', 0.1, 1, 0.05),
];
const SIM_VIEW = [num('lidar_view_m', '라이다 표시 거리', 'm', 1, 30, 1)];
/** 화면 요청은 모두 로그인 세션의 취소 신호(cancel)를 넘긴다 — 세션이 끝난 뒤 온 답(401 포함)은 api 가 버린다 */
type Cancel = { cancel?: AbortSignal };
const range = (f: Field) => `${f.min}~${f.max}${f.unit ? ` ${f.unit}` : ''}`;
const NO_EDIT = '조직 기준값은 총괄 운영 관리자만 바꿀 수 있습니다.';
/** 서버 교차 검사(models.py OrgSettings.simulation_speed_order) 문구 → 걸린 칸들. 칸 옆에 그 문구를 보인다 */
const CROSS: [string, (keyof OrgSettings)[]][] = [['최소 전진', ['sim_min_vx', 'sim_max_vx']], ['키보드 전진', ['sim_key_vx', 'sim_max_vx']]];
/** 서버 모델 오류 문구는 «모델 id: 문장» — 고치는 모델 자신이면 id 를 떼고, 다른 모델(공통 값을 바꿔 그 모델 실효값이 깨진 422)이면 화면 이름으로 안내한다 */
const modelMessage = (text: string, mine?: string) => {
  const hit = SIM_MODELS.find(([id]) => text.startsWith(`${id}: `));
  if (!hit) return text;
  const rest = text.slice(hit[0].length + 2);
  return hit[0] === mine ? rest : `${hit[1]} 모델 값과 맞지 않아 저장하지 못했습니다. ${rest}`;
};

type Org = ReturnType<typeof useOrg>;
/** 조직 값 한 벌(GET 한 번) — 카드마다 자기 칸만 저장하고, 저장된 값은 시뮬 조종에도 바로 알린다(phone.ts simTune) */
function useOrg(cancel?: AbortSignal) {
  const [saved, setSaved] = useState<OrgSettings | null>(null), [err, setErr] = useState('');
  useEffect(() => { api.settings(cancel).then(setSaved, (e: Error) => setErr(e.message)); }, []);
  return { saved, err, put: (s: OrgSettings) => { setSaved(s); simTune(s); } };
}

/** model: 고치는 모델 id(없으면 공통 값). 초안의 null = 저장하면 그 칸을 공통으로 되돌림(모델 칸만) */
/** confirm = 실기 값: 저장 전에 바뀌는 값(지금 → 새 값)을 보이고 «이대로 저장»을 한 번 더 받는다 */
type CardProps = { org: Org; admin: boolean; id: string; model?: string; label: string; note?: string; bad?: string; cap?: boolean; confirm?: boolean; fields: Field[]; top?: ReactNode } & Cancel;
function OrgCard({ org, admin, id, model, label, note, bad, cap, confirm, fields, top, cancel }: CardProps) {
  const { saved } = org, [draft, setDraft] = useState<Record<string, string | boolean | null>>({});
  const [msg, setMsg] = useState<Msg>(null), [errs, setErrs] = useState<Record<string, string>>({}), [busy, setBusy] = useState(false), [check, setCheck] = useState<string | null>(null);
  const over: Record<string, number | boolean> = (model && saved?.model_overrides?.[model]) || {};
  const current = (f: Field) => over[f.key] ?? saved?.[f.key] ?? REAL_CAPS[f.key as keyof typeof REAL_CAPS];   // 저장된 실효값(공통 화면이면 공통 값)
  const shown = (f: Field) => {
    const d = draft[f.key];
    if (d != null) return d;
    const v = d === null ? saved?.[f.key] : current(f);
    return f.kind === 'switch' ? !!v : String(v ?? '');
  };
  const value = (f: Field) => { const v = shown(f); return typeof v === 'boolean' ? v : v.trim() === '' ? NaN : Number(v); };
  const pending = (f: Field) => f.key in draft && (draft[f.key] === null ? f.key in over : value(f) !== current(f));
  const own = (f: Field) => draft[f.key] !== null && (f.key in over || (f.key in draft && value(f) !== saved?.[f.key]));
  const edit = (f: Field, v: string | boolean) => { setDraft({ ...draft, [f.key]: v }); setErrs({ ...errs, [f.key]: '' }); setCheck(null); };
  const say = (f: Field, v: unknown) => (typeof v === 'boolean' ? (v ? '켬' : '끔') : `${v ?? '기본값'}${f.unit ? ` ${f.unit}` : ''}`);
  // 되돌리기도 저장 때 한꺼번에 보낸다 — 최대·최소를 함께 되돌릴 때 중간 상태가 교차 검사에 걸리지 않게
  const back = (f: Field) => { const rest = { ...draft }; delete rest[f.key]; setDraft(f.key in over ? { ...rest, [f.key]: null } : rest); setErrs({ ...errs, [f.key]: '' }); };
  const pre = model ? `${model}-` : '', why = admin ? undefined : `why-${pre}${id}`;
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!saved || busy) return;
    const patch = Object.fromEntries(fields.filter(pending).map((f) => [f.key, draft[f.key] === null ? null : value(f)])) as Record<string, number | boolean | null>;
    setErrs({});
    if (!Object.keys(patch).length) return setMsg({ text: '바뀐 값이 없습니다.', ok: true });
    // 모델 칸의 null 은 «되돌리기»라, 빈 칸(NaN → JSON null)을 보내면 값이 조용히 지워진다 — 보내기 전에 막는다.
    // 확인 카드도 «→ NaN» 확인 대신 칸 옆에 알린다(Codex 검토 R2)
    const empty = model || confirm ? fields.filter((f) => Number.isNaN(patch[f.key])) : [];
    if (empty.length) return setErrs(Object.fromEntries(empty.map((f) => [f.key, `값을 입력하세요. 허용 범위: ${f.label} ${range(f)}`])));
    if (confirm && check === null) return setCheck(fields.filter(pending).map((f) => `${f.label} ${say(f, current(f))} → ${draft[f.key] === null ? '공통 값' : say(f, value(f))}`).join(' · '));
    setCheck(null); setBusy(true); setMsg(null);
    try { org.put(await api.saveSettings((model ? { model_overrides: { [model]: patch } } : patch) as OrgSettingsPatch, cancel)); setDraft({}); setMsg({ text: '저장했습니다. 다음 실행부터 적용됩니다.', ok: true }); }
    catch (err) {
      // 서버 검사(400·422 VALIDATION)는 어느 칸인지 알려 주지 않는다 — 교차 검사 문구는 걸린 칸 옆, 범위를 벗어난 칸은 그 칸 옆에 허용 범위와 함께
      const text = modelMessage((err as Error).message, model), mine = fields.map((f) => f.key);
      const cross = CROSS.find(([w]) => text.includes(w))?.[1].filter((k) => mine.includes(k)) ?? [];
      const hit = cross.filter((k) => k in patch).length ? cross.filter((k) => k in patch) : cross;
      const bad = fields.filter((f) => typeof patch[f.key] === 'number' && !(patch[f.key] as number >= f.min && patch[f.key] as number <= f.max && (f.step < 1 || Number.isInteger(patch[f.key]))));
      const at: Record<string, string> = hit.length ? Object.fromEntries(hit.map((k) => [k, text]))
        : Object.fromEntries(bad.map((f) => [f.key, `${text} 허용 범위: ${f.label} ${range(f)}${f.step < 1 ? '' : '(정수)'}`]));
      setErrs(at);
      if (!Object.keys(at).length) setMsg({ text });
    } finally { setBusy(false); }
  };
  const row = (f: Field) => {
    const v = shown(f), er = errs[f.key], eid = `st-e-${pre}${f.key}`, desc = [er && eid, why, model && `st-o-${pre}${f.key}`].filter(Boolean).join(' ') || undefined;
    const tags = <>{f.cap && <span className="st-tag cap">시뮬 모드·연결 상한 안에서만</span>}</>;
    const tail = er && <span id={eid} className="fh-msg" role="alert">{er}</span>;
    if (f.kind === 'switch') return <div key={f.key} className="st-sw-wrap">
      <label className="st-sw"><span>{f.label} {tags}</span>
        <input type="checkbox" role="switch" name={f.key} checked={v === true} disabled={!admin} aria-describedby={[`st-h-${f.key}`, desc].filter(Boolean).join(' ')} onChange={(e) => edit(f, e.target.checked)} /></label>
      <span id={`st-h-${f.key}`} className="st-note">{f.hint}</span>{tail}</div>;
    const head = <span className="st-lab">{f.label} <span className="lbl">({range(f)}{f.hint ? `, ${f.hint}` : ''})</span>{tags}</span>;
    if (f.kind === 'range') return <label key={f.key} className="fh-field">{head}
      <span className="st-rng"><input type="range" name={f.key} min={f.min} max={f.max} step={f.step} value={String(v)} disabled={!admin} aria-describedby={desc} onChange={(e) => edit(f, e.target.value)} />
        <output>{Number(v).toFixed(2)} {f.unit}</output></span>{tail}</label>;
    return <label key={f.key} className="fh-field">{head}
      <span className="st-unit"><input className="inp" name={f.key} type="number" inputMode="decimal" min={f.min} max={f.max} step={f.step} readOnly={!admin} aria-describedby={desc}
        aria-invalid={er ? true : undefined} value={String(v)} onChange={(e) => edit(f, e.target.value)} />{f.unit && <span className="lbl">{f.unit}</span>}</span>{tail}</label>;
  };
  // 모델 칸: 이 칸 값이 어디서 오는지 + 되돌리기
  const modelRow = (f: Field) => <div key={f.key} className="st-ov-wrap">{row(f)}
    <div className="st-ov">
      <span id={`st-o-${pre}${f.key}`} className={`st-tag${own(f) ? ' own' : ''}`}>{own(f) ? '이 모델 값' : `공통 값 사용(${saved?.[f.key] ?? '기본값'}${f.unit ? ` ${f.unit}` : ''})`}{pending(f) && ' · 저장 전'}</span>
      {admin && own(f) && <button type="button" className="btn" onClick={() => back(f)}>공통으로 되돌리기</button>}
    </div></div>;
  return <section className="lv-card" aria-label={label}>
    <h2>{label}{bad && <> <span className="st-tag bad">{bad}</span></>}</h2>
    <p className="st-note">{note}{cap && <> <span className="st-tag cap">시뮬 모드·연결 상한 안에서만</span></>} <span className="st-tag adm">총괄만 고침</span></p>
    {top}
    {saved && <form className="fh-form" onSubmit={save} noValidate>
      {fields.map(model ? modelRow : row)}
      <div className="fh-row">
        {check !== null && <p className="fh-msg warn" role="status" data-save-check>바뀌는 값: {check}</p>}
        <button type="submit" className="btn pri" disabled={!admin || busy} aria-describedby={why}>{check !== null ? '이대로 저장' : '저장'}</button>
        {check !== null && <button type="button" className="btn" onClick={() => setCheck(null)}>취소</button>}
        {!admin && <span id={why} className="fh-why" data-why>{NO_EDIT}</span>}
      </div>
    </form>}
    <Note msg={msg} />
  </section>;
}

// ── 내 정보(모두, 05 §2 PATCH /me · POST /me/password) ──
export const PW_DONE = '비밀번호를 바꿨습니다. 모든 기기에서 로그아웃됐습니다. 새 비밀번호로 다시 로그인하세요.';

function MyInfo({ user, setMe, cancel }: { user: User; setMe: (u: ApiUser) => void } & Cancel) {
  const [name, setName] = useState(user.name), [msg, setMsg] = useState<Msg>(null), [busy, setBusy] = useState(false);
  const rename = async (e: FormEvent) => {
    e.preventDefault();
    const v = name.trim();
    if (busy) return;
    if (!v) return setMsg({ text: '이름을 입력하세요.' });
    if (v === user.name) return setMsg({ text: '바뀐 값이 없습니다.', ok: true });
    setBusy(true);
    try { const u = await api.saveMe({ display_name: v }, cancel); setMe(u); setName(u.display_name); setMsg({ text: '이름을 바꿨습니다.', ok: true }); }
    catch (err) { setMsg({ text: (err as ApiFail).message }); }
    finally { setBusy(false); }
  };
  // 성공하면 서버가 지금 기기까지 모든 세션을 끝낸다(05 §2) — 다음 요청이 401 이 되기 전에 바로 로그인 화면으로
  const change = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy) return;
    const f = new FormData(e.currentTarget), cur = String(f.get('current')), next = String(f.get('next'));
    if (!cur || !next) return setMsg({ text: '현재 비밀번호와 새 비밀번호를 입력하세요.' });
    if (next !== String(f.get('again'))) return setMsg({ text: '새 비밀번호 두 칸이 서로 다릅니다.' });
    setBusy(true); setMsg(null);
    try { await api.password({ current_password: cur, new_password: next }, cancel); expireAuth(PW_DONE); }
    catch (err) { setMsg({ text: (err as ApiFail).message }); setBusy(false); }
  };
  return <section className="lv-card" aria-label="내 정보">
    <h2>내 정보</h2>
    <form className="fh-form" onSubmit={rename} noValidate>
      <label className="fh-field"><span>내 이름</span><input className="inp" name="display_name" maxLength={128} value={name} onChange={(e) => setName(e.target.value)} /></label>
      <div className="fh-row"><button type="submit" className="btn pri" disabled={busy}>이름 저장</button></div>
    </form>
    <form className="fh-form" onSubmit={change} noValidate aria-label="비밀번호 바꾸기">
      <h2>비밀번호 바꾸기</h2>
      <label className="fh-field"><span>현재 비밀번호</span><input className="inp" name="current" type="password" autoComplete="current-password" maxLength={1024} /></label>
      <label className="fh-field"><span>새 비밀번호</span><input className="inp" name="next" type="password" autoComplete="new-password" maxLength={1024} /></label>
      <label className="fh-field"><span>새 비밀번호 다시</span><input className="inp" name="again" type="password" autoComplete="new-password" maxLength={1024} /></label>
      <span className="lbl">띄어쓰기는 입력되지 않습니다(띄어쓰기=STOP).</span>
      <div className="fh-row"><button type="submit" className="btn pri" disabled={busy}>비밀번호 바꾸기</button><span className="lbl">바꾸면 모든 기기에서 로그아웃됩니다.</span></div>
    </form>
    <Note msg={msg} />
  </section>;
}

// ── 계정 관리(총괄, 05 §2 /users · /users/{id}/sessions) ──
/** 409 는 code 로 이 화면에 맞는 문구(05 §1.4 — code 는 분기용). 그 밖은 서버 문장 그대로 */
export const LAST_ADMIN = '남은 총괄 계정이 이 계정 하나뿐이라 잠그거나 지우거나 운영 관리자로 바꿀 수 없습니다. 다른 총괄 계정을 먼저 만드세요.';
export const HAS_ROBOTS = '담당 로봇이 있어 지울 수 없습니다. 로봇의 담당자를 먼저 바꾸세요.';
export const TAKEN = '같은 아이디가 이미 있습니다(지운 계정 포함). 다른 아이디를 쓰세요.';
const failText = (e: unknown, conflict?: string) => {
  const f = e as ApiFail;
  return f.code === 'LAST_ORG_ADMIN' ? LAST_ADMIN : f.code === 'VERSION_CONFLICT' && conflict ? conflict : f.message;
};
const SELF = '내 계정은 잠그거나 지우거나 역할을 바꿀 수 없습니다. 다른 총괄에게 부탁하세요.';

const ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
/** 임시 비밀번호 12자(헷갈리는 0·O·1·l·I 뺌). 서버는 1~1024자만 검사한다(05 §1.2 — 최소 길이·복잡도 정책은 미정) */
export const tempPassword = () => Array.from(crypto.getRandomValues(new Uint32Array(12)), (n) => ABC[n % ABC.length]).join('');

function Accounts({ me, cancel }: { me: User } & Cancel) {
  const [list, setList] = useState<ApiUser[] | null>(null), [sel, setSel] = useState(''), [msg, setMsg] = useState<Msg>(null);
  const [adding, setAdding] = useState(false), [made, setMade] = useState<{ name: string; username: string; pw: string } | null>(null);
  useEffect(() => { api.users(cancel).then(setList, (e: ApiFail) => setMsg({ text: e.message })); }, []);
  // 내 이름은 «내 정보»에서만 바꾼다(편집기 하나) — 목록의 내 줄은 그 값
  const rows = list?.map((u) => (u.id === me.id ? { ...u, display_name: me.name } : u)), cur = rows?.find((u) => u.id === sel);
  const put = (u: ApiUser) => setList((l) => l && l.map((x) => (x.id === u.id ? u : x)));
  return <>
    <section className="lv-card" aria-label="계정">
      <div className="fh-row"><h2 className="fh-grow">계정{rows ? ` (${rows.length})` : ''}</h2>
        {!adding && <button type="button" className="btn pri" onClick={() => { setAdding(true); setMade(null); setMsg(null); }}>새 계정</button>}</div>
      {adding && <NewAccount cancel={cancel} close={() => setAdding(false)} done={(u, pw) => { setList((l) => [...(l ?? []), u]); setAdding(false); setMade({ name: u.display_name, username: u.username, pw }); setSel(u.id); }} />}
      {made && <TempPassword {...made} close={() => setMade(null)} />}
      {rows && <ul className="fh-list">{rows.map((u) => <li key={u.id}>
        <button type="button" aria-pressed={u.id === sel} style={{ flexWrap: 'wrap' }} onClick={() => { setSel(u.id); setMsg(null); }}>
          <span style={WRAP}><b>{u.display_name}</b> <span className="mono">{u.username}</span></span><span className="fh-grow">{ROLE_NAME[u.role]}{u.id === me.id ? ' · 나' : ''}</span>
          {u.locked && <Chip tone="bad" text="잠김" />}<span className="lbl">로봇 {u.robot_ids.length}대</span>
        </button></li>)}</ul>}
      <Note msg={msg} />
    </section>
    {cur && <Account key={cur.id} u={cur} self={cur.id === me.id} put={put} cancel={cancel}
      gone={(text) => { setList((l) => l && l.filter((x) => x.id !== cur.id)); setSel(''); setMsg({ text, ok: true }); }} />}
  </>;
}

function NewAccount({ close, done, cancel }: { close: () => void; done: (u: ApiUser, pw: string) => void } & Cancel) {
  const [msg, setMsg] = useState<Msg>(null), [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy) return;
    const f = new FormData(e.currentTarget), username = String(f.get('username')).trim(), display_name = String(f.get('display_name')).trim();
    if (!username || !display_name) return setMsg({ text: '아이디와 이름을 입력하세요.' });
    const pw = tempPassword();
    setBusy(true);
    try { done(await api.createUser({ username, display_name, role: String(f.get('role')) as Role, temp_password: pw }, cancel), pw); }
    catch (err) { setMsg({ text: failText(err, TAKEN) }); setBusy(false); }
  };
  return <form className="fh-form" onSubmit={submit} noValidate aria-label="새 계정">
    <label className="fh-field"><span>아이디</span><input className="inp" name="username" autoComplete="off" maxLength={128} autoFocus /></label>
    <label className="fh-field"><span>이름</span><input className="inp" name="display_name" autoComplete="off" maxLength={128} /></label>
    <label className="fh-field"><span>역할</span><select className="inp" name="role" defaultValue="OPERATOR">
      <option value="OPERATOR">{ROLE_NAME.OPERATOR}</option><option value="ORG_ADMIN">{ROLE_NAME.ORG_ADMIN}</option></select></label>
    <div className="fh-row"><button type="submit" className="btn pri" disabled={busy}>만들기</button><button type="button" className="btn" onClick={close}>취소</button>
      <span className="lbl">임시 비밀번호는 만들 때 한 번만 보입니다.</span></div>
    <Note msg={msg} />
  </form>;
}

/** 만든 직후 한 번만 보임 — 닫으면 화면 어디에도 남지 않는다 */
function TempPassword({ name, username, pw, close }: { name: string; username: string; pw: string; close: () => void }) {
  return <Once label="임시 비밀번호" value={pw} close={close} text={`${name}(${username}) 계정을 만들었습니다. 임시 비밀번호를 본인에게 전하고, 첫 로그인 뒤 «내 정보»에서 바꾸게 하세요.`} />;
}
/** 한 번만 보이는 비밀 값(임시 비밀번호·로봇 토큰) + 복사. 값은 부른 쪽 상태에만 있고 닫으면 버린다 */
function Once({ label, value, text, close, more }: { label: string; value: string; text: string; close: () => void; more?: string }) {
  const [msg, setMsg] = useState<Msg>(null);
  const copy = () => (navigator.clipboard ? navigator.clipboard.writeText(value) : Promise.reject()).then(
    () => setMsg({ text: '복사했습니다.', ok: true }), () => setMsg({ text: '복사하지 못했습니다. 글자를 직접 골라 복사하세요.' }));
  return <div className="card fh-form" role="group" aria-label={label} style={{ padding: 12 }}>
    <span style={WRAP}>{text}</span>
    <div className="fh-row"><input className="inp mono" readOnly value={value} aria-label={label} style={{ flex: '1 1 160px', width: 'auto', minWidth: 0 }} onFocus={(e) => e.currentTarget.select()} />
      <button type="button" className="btn pri" onClick={copy}>복사</button><button type="button" className="btn" onClick={close}>닫기</button></div>
    <span className="lbl">닫으면 다시 볼 수 없습니다.{more ? ` ${more}` : ''}</span>
    <Note msg={msg} />
  </div>;
}

function Account({ u, self, put, gone, cancel }: { u: ApiUser; self: boolean; put: (u: ApiUser) => void; gone: (text: string) => void } & Cancel) {
  const [name, setName] = useState(u.display_name), [role, setRole] = useState<Role>(u.role);
  const [ask, setAsk] = useState<'lock' | 'delete' | null>(null), [msg, setMsg] = useState<Msg>(null), [busy, setBusy] = useState(false);
  const run = async (f: () => Promise<string>, conflict?: string) => {
    if (busy) return;
    setBusy(true); setAsk(null);
    try { setMsg({ text: await f(), ok: true }); } catch (err) { setMsg({ text: failText(err, conflict) }); } finally { setBusy(false); }
  };
  const save = (e: FormEvent) => {
    e.preventDefault();
    const v = name.trim(), patch = { ...(v !== u.display_name && { display_name: v }), ...(role !== u.role && { role }) };
    if (!v) return setMsg({ text: '이름을 입력하세요.' });
    if (!Object.keys(patch).length) return setMsg({ text: '바뀐 값이 없습니다.', ok: true });
    run(async () => { const n = await api.saveUser(u.id, patch, cancel); put(n); setName(n.display_name); setRole(n.role); return '저장했습니다.'; });
  };
  const lock = (locked: boolean) => run(async () => { put(await api.saveUser(u.id, { locked }, cancel)); return locked ? '잠갔습니다. 이 계정의 로그인이 모두 끝났습니다.' : '잠금을 풀었습니다.'; });
  const del = () => { if (busy) return; setBusy(true); setAsk(null); api.deleteUser(u.id, cancel).then(() => gone(`${u.display_name} 계정을 지웠습니다.`), (err) => { setMsg({ text: failText(err, HAS_ROBOTS) }); setBusy(false); }); };
  const why = self ? SELF : null, noDel = self ? SELF : u.robot_ids.length ? HAS_ROBOTS : null;
  return <section className="lv-card" aria-label="계정 상세">
    <div className="fh-row"><h2 className="fh-grow" style={WRAP}>{u.display_name}</h2><span className="mono" style={WRAP}>{u.username}</span>{u.locked ? <Chip tone="bad" text="잠김" /> : <Chip tone="ok" text="사용 중" />}</div>
    {self ? <p className="lv-note">내 이름은 위 «내 정보»에서 바꿉니다.</p> : <form className="fh-form" onSubmit={save} noValidate>
      <label className="fh-field"><span>이름</span><input className="inp" name="display_name" maxLength={128} value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label className="fh-field"><span>역할</span><select className="inp" name="role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
        <option value="OPERATOR">{ROLE_NAME.OPERATOR}</option><option value="ORG_ADMIN">{ROLE_NAME.ORG_ADMIN}</option></select></label>
      <div className="fh-row"><button type="submit" className="btn pri" disabled={busy}>저장</button></div>
    </form>}
    <div className="fh-row">
      {u.locked ? <button type="button" className="btn" disabled={busy || !!why} aria-describedby={why ? 'why-self' : undefined} onClick={() => lock(false)}>잠금 풀기</button>
        : <button type="button" className="btn" disabled={busy || !!why} aria-describedby={why ? 'why-self' : undefined} onClick={() => setAsk('lock')}>잠그기</button>}
      <button type="button" className="btn" disabled={busy || !!noDel} aria-describedby={self ? 'why-self' : noDel ? 'why-del' : undefined} onClick={() => setAsk('delete')}>지우기</button>
    </div>
    {self && <span id="why-self" className="fh-why" data-why>{SELF}</span>}
    {!self && noDel && <span id="why-del" className="fh-why" data-why>{noDel}</span>}
    {ask && <div className="fh-row" role="group" aria-label="확인">
      <span>{ask === 'lock' ? `${u.display_name} 계정을 잠글까요? 이 사람의 로그인이 모두 끝납니다.` : `${u.display_name} 계정을 지울까요? 이 사람의 로그인이 모두 끝나고 되돌릴 수 없습니다.`}</span>
      <button type="button" className={ask === 'lock' ? 'btn pri' : 'btn bad'} onClick={() => (ask === 'lock' ? lock(true) : del())}>{ask === 'lock' ? '잠그기' : '지우기'}</button>
      <button type="button" className="btn" onClick={() => setAsk(null)}>취소</button>
    </div>}
    <Note msg={msg} />
    <Devices key={String(u.locked)} u={u} cancel={cancel} />
  </section>;
}

const when = (at: string) => new Date(at).toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' });
/** 로그인 기기(세션) — 지금 쓰는 것만. 끝난 것은 기록 탭에 남는다 */
function Devices({ u, cancel }: { u: ApiUser } & Cancel) {
  const [list, setList] = useState<Session[] | null>(null), [msg, setMsg] = useState<Msg>(null), [busy, setBusy] = useState(''), [ask, setAsk] = useState<Session | null>(null);
  const load = () => api.sessions(u.id, cancel).then((l) => setList(l.filter((s) => !s.revoked_at && new Date(s.expires_at) > new Date())), (e: ApiFail) => setMsg({ text: e.message }));
  useEffect(() => { load(); }, []);
  const end = (s: Session) => {
    if (busy) return;
    setBusy(s.id); setAsk(null);
    api.endSession(u.id, s.id, cancel).then(() => { setMsg({ text: `${s.device_label} 로그인을 끝냈습니다.`, ok: true }); return load(); }, (e: ApiFail) => setMsg({ text: e.message })).finally(() => setBusy(''));
  };
  return <div className="fh-form" aria-label="로그인 기기">
    <h2>로그인 기기{list ? ` (${list.length})` : ''}</h2>
    {list && !list.length && <p className="lv-note">로그인한 기기가 없습니다.</p>}
    {list && !!list.length && <ul className="fh-form" style={{ listStyle: 'none', margin: 0, padding: 0 }}>{list.map((s) => <li key={s.id} className="fh-row">
      <b style={WRAP}>{s.device_label}</b><span className="lbl">{s.client === 'web' ? '웹' : '앱'}</span><span className="fh-grow lbl">마지막 사용 {when(s.last_seen_at)}</span>
      <button type="button" className="btn" disabled={!!busy} onClick={() => setAsk(s)}>로그아웃시키기</button></li>)}</ul>}
    {ask && <div className="fh-row" role="group" aria-label="확인">
      <span style={WRAP}>{`${u.display_name}의 «${ask.device_label}» 로그인을 끝낼까요? 그 기기는 바로 로그아웃되어 다시 로그인해야 합니다.`}</span>
      <button type="button" className="btn pri" onClick={() => end(ask)}>로그아웃시키기</button>
      <button type="button" className="btn" onClick={() => setAsk(null)}>취소</button>
    </div>}
    <Note msg={msg} />
  </div>;
}

// ── 로봇(05 §3). 실기 로봇 등록·토큰은 총괄 화면에 없다(ROBOT-PAIRING — 운영 관리자가 연결 프로그램 코드로 연결, 상태는 «로봇» 탭).
// 여기는 총괄의 시뮬 로봇 이름만(시뮬 담당·지우기·연결 키는 시뮬 관리자 — 서버 409 SIM_ROBOT_MANAGED·SIM_TOKEN_MANAGED) ──
/** 409 는 code 로 이 화면에 맞는 문구(05 §1.4). 지울 때 조종권·넘김·진행 중 실행이 있으면 VERSION_CONFLICT(apps/server) */
export const ROBOT_IN_USE = '누군가 조종 중이거나 조종권을 넘기는 중, 또는 실행 중이라 지울 수 없습니다. 조종을 끝내거나 실행을 멈춘 뒤 다시 누르세요.';
export const ROBOT_GONE = '이 로봇은 이미 지워졌습니다. 목록을 다시 받았습니다.';
export const ROBOT_BUSY = '서버가 이 로봇의 다른 변경을 처리하는 중입니다. 잠시 뒤 다시 누르세요.';
export const robotFail = (e: unknown) => {
  const f = e as ApiFail;
  return f.code === 'VERSION_CONFLICT' ? ROBOT_IN_USE : f.status === 404 ? ROBOT_GONE : f.code === 'SERVER_BUSY' ? ROBOT_BUSY : f.message;
};

/** 담당 고르기: 잠기지 않은 운영 관리자 + «담당 없음». 지금 담당이 목록에 없으면(잠김 등) 그 이름도 둔다 */
export function OwnerSelect({ ops, value, onChange, current }: { ops: ApiUser[]; value: string; onChange?: (v: string) => void; current?: RobotSummary['owner'] }) {
  const extra = current && !ops.some((u) => u.id === current.id) ? [current] : [];
  return <label className="fh-field"><span>담당 운영 관리자</span><select className="inp" name="owner" value={value} onChange={(e) => onChange?.(e.target.value)}>
    <option value="">담당 없음</option>
    {ops.map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}
    {extra.map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}</select></label>;
}

function Robots({ refresh, cancel }: { refresh: () => void } & Cancel) {
  const [list, setList] = useState<RobotSummary[] | null>(null), [sel, setSel] = useState(''), [msg, setMsg] = useState<Msg>(null);
  const load = () => api.robots('all', cancel).then((l) => setList(l.filter((r) => r.simulation)), (e: ApiFail) => setMsg({ text: e.message }));
  useEffect(() => { load(); }, []);
  // 바꾼 뒤에는 이 목록과 관제·조종 목록(App)을 함께 다시 받는다
  const changed = () => { load(); refresh(); };
  const cur = list?.find((r) => r.id === sel);
  return <>
    <section className="lv-card" aria-label="로봇">
      <h2>시뮬 로봇{list ? ` (${list.length})` : ''}</h2>
      <p className="lv-note" data-real-note>실기 로봇은 운영 관리자가 폰의 «+ 로봇 연결하기 › 새 로봇 추가»로 연결합니다. 실기 상태·담당·현장 승인은 «로봇» 탭에서 봅니다.</p>
      {list && !list.length && <p className="lv-note">시뮬 로봇이 없습니다. «시뮬» 탭에서 띄우면 여기에 보입니다.</p>}
      {list && !!list.length && <ul className="fh-list">{list.map((r) => <li key={r.id}>
        <button type="button" aria-pressed={r.id === sel} style={{ flexWrap: 'wrap' }} onClick={() => { setSel(r.id); setMsg(null); }}>
          <b style={WRAP}>{robotName(r)}</b><span className="fh-grow">{r.owner?.display_name ?? '담당 없음'}</span></button></li>)}</ul>}
      <Note msg={msg} />
    </section>
    {cur && <RobotEdit key={cur.id} r={cur} cancel={cancel} changed={changed} gone={(text) => { setSel(''); setMsg({ text, ok: true }); changed(); }} />}
  </>;
}

function RobotEdit({ r, changed, gone, cancel }: { r: RobotSummary; changed: () => void; gone: (text: string) => void } & Cancel) {
  const [name, setName] = useState(r.name), [msg, setMsg] = useState<Msg>(null), [busy, setBusy] = useState(false);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const v = name.trim();
    if (!v) return setMsg({ text: '로봇 이름을 입력하세요.' });
    if (v === r.name) return setMsg({ text: '바뀐 값이 없습니다.', ok: true });
    if (busy) return;
    setBusy(true); setMsg(null);
    try { await api.saveRobot(r.id, { name: v }, cancel); changed(); setMsg({ text: '저장했습니다.', ok: true }); }
    catch (err) { if ((err as ApiFail).status === 404) return gone(ROBOT_GONE); setMsg({ text: robotFail(err) }); }
    finally { setBusy(false); }
  };
  return <section className="lv-card" aria-label="로봇 설정">
    <div className="fh-row"><h2 className="fh-grow" style={WRAP}>{robotName(r)}</h2><span className="lbl">{r.model}</span></div>
    <form className="fh-form" onSubmit={save} noValidate>
      <label className="fh-field"><span>로봇 이름</span><input className="inp" name="name" maxLength={128} value={name} onChange={(e) => setName(e.target.value)} /></label>
      <div className="fh-row"><button type="submit" className="btn pri" disabled={busy}>저장</button><span className="lbl">담당·끝내기는 «시뮬» 탭(시뮬 관리자)에서 합니다.</span></div>
    </form>
    <Note msg={msg} />
  </section>;
}

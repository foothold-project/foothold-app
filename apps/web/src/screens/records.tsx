// 기록 탭의 「지금 남기기」 · 클립 칸 · 재현 재생기(U8-03 · U8-08 · U8-09 · U8-11, 05 §8.1 계약 RecordMark · EventClip · JointLogReplay).
// event.data.clip 은 «클립을 원했나» 참 · 거짓일 뿐이다. 영상 주소 · 상태는 records.clips 의 EventClip 으로만 받는다.
// 영상 만들기 · 관절 기록 재생은 서버에 아직 없어 501 이 온다: 그 문장을 한 줄로 보이고, 받지 않은 영상 · 재현을 그리지 않는다.
import { useEffect, useRef, useState } from 'react';
import type { Event as Ev, EventClip, JointLogReplay, RecordMarkResult } from '../../../contracts/ts';
import { ApiFail, records } from '../api';
import { myRobots } from '../fake';
import type { Ctx } from '../screens';
import './records.css';

/** N2 대응표: 화면 이름은 위험 · 주의 · 정보만, 서버 값은 보내기에만. clip = 클립 칸이 늘 켜짐(true) · 늘 꺼짐(false) · 고름(null) */
export const MARK_GRADES = [['ERROR', '위험', true], ['WARN', '주의', null], ['INFO', '정보', false]] as const;
type Grade = (typeof MARK_GRADES)[number][0];
/** 까닭 코드 → 문장. 서버 501 문장(records.py)과 같은 말 */
const REASON: Record<string, string> = { CLIP_PIPELINE_NOT_BUILT: '사건 영상 만들기는 아직 서버에 없습니다.', JOINT_LOG_NOT_BUILT: '관절 기록 재생은 아직 서버에 없습니다.' };
const reason = (c: Pick<EventClip, 'status' | 'reason'>) =>
  c.status === 'PENDING' ? '서버가 클립을 만드는 중입니다.'
    : c.status === 'FAILED' ? `클립을 만들지 못했습니다.${c.reason && REASON[c.reason] ? ` ${REASON[c.reason]}` : ''}`
      : c.reason && REASON[c.reason] ? REASON[c.reason] : '클립이 아직 없습니다.';
const fail = (e: unknown) => (e instanceof ApiFail ? e.message : '서버에 닿지 못했습니다. 잠시 뒤 다시 시도하세요.');

/** 「지금 남기기」 단추 + 창. done = 남긴 뒤(목록 다시 받기) */
export function MarkNow({ c, done }: { c: Pick<Ctx, 'user' | 'robots' | 'cancel'> & { robot?: Ctx['robot'] }; done: () => void }) {
  const mine = myRobots(c.user, c.robots);
  const [open, setOpen] = useState(false), [robot, setRobot] = useState(''), [grade, setGrade] = useState<Grade>('WARN'), [clip, setClip] = useState(true);
  const [note, setNote] = useState(''), [busy, setBusy] = useState(false), [err, setErr] = useState(''), [out, setOut] = useState<RecordMarkResult | null>(null);
  const sending = useRef(false);
  const start = () => {
    const here = c.robot?.id;
    setRobot(here && mine.some((r) => r.id === here) ? here : mine[0]?.id ?? '');
    setGrade('WARN'); setClip(true); setNote(''); setErr(''); setOut(null); setOpen(true);
  };
  const lock = MARK_GRADES.find(([k]) => k === grade)![2], on = lock ?? clip;
  const send = async () => {
    if (sending.current || !robot) return;   // 두 번 눌러도 한 번만
    sending.current = true; setBusy(true); setErr('');
    try {
      // 계약: clip 은 WARN 만 고른다. 위험 · 정보는 빼고 보내 서버 규칙 기본값(늘 · 없음)
      setOut(await records.markNow(robot, { severity: grade, note: note.trim() || null, ...(lock === null ? { clip } : {}) }, c.cancel));
      done();
    } catch (e) {
      if (!(e instanceof ApiFail && e.code === 'CANCELED')) setErr(`남기지 못했습니다. ${fail(e)}`);
    } finally { sending.current = false; setBusy(false); }
  };
  // 단추 아래에 뜨는 창(필터 줄을 밀지 않음). 열린 동안 단추는 눌림으로
  return <span className="rc-anchor"><button type="button" className="btn" aria-expanded={open} disabled={!mine.length} title={mine.length ? undefined : '남길 로봇이 없습니다'} onClick={() => (open ? setOpen(false) : start())}>지금 남기기</button>
  {open && <div className="lv-card rc-mark" role="dialog" aria-label="지금 남기기" onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); }}>
    <b>지금 남기기</b>
    {out ? <>
      <p className="rc-out" role="status" data-mark-out>기록을 남겼습니다. {out.clip ? out.clip.status === 'READY' ? '클립이 준비됐습니다.' : reason(out.clip) : '영상 없이 기록만 남겼습니다.'}</p>
      <div className="fh-row"><span className="fh-grow" /><button type="button" className="btn" onClick={() => setOpen(false)}>닫기</button></div>
    </> : <>
      <label className="fh-row"><span className="lbl">로봇</span>
        <select className="fh-user" aria-label="로봇" value={robot} onChange={(e) => setRobot(e.target.value)}>{mine.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
      <div className="fh-row" role="group" aria-label="남길 등급"><span className="lbl">등급</span>
        {MARK_GRADES.map(([k, name]) => <button key={k} type="button" className="btn" aria-pressed={grade === k} onClick={() => setGrade(k)}>{name}</button>)}</div>
      <label className="rc-clip"><input type="checkbox" aria-label="영상 클립 남기기" checked={on} disabled={lock !== null} onChange={(e) => setClip(e.target.checked)} />
        <span>영상 클립 남기기{lock === true ? ' · 위험은 늘 남깁니다' : lock === false ? ' · 정보는 기록만 남깁니다' : ''}</span></label>
      <textarea className="fh-user rc-note" aria-label="메모" maxLength={200} rows={2} placeholder="메모(200 자까지)" value={note} onChange={(e) => setNote(e.target.value)} />
      <p className="lv-note">지금 시각의 10 초 전부터 5 초 뒤까지{on ? ' 영상 클립 · ' : ' '}메모 · 남긴 사람이 남습니다. 클립은 서버가 만듭니다.</p>
      {err && <p className="fh-msg" role="alert">{err}</p>}
      <div className="fh-row"><span className="fh-grow" />
        <button type="button" className="btn" onClick={() => setOpen(false)}>취소</button>
        <button type="button" className="btn pri" disabled={busy || !robot} onClick={send}>{busy ? '남기는 중…' : '남기기'}</button></div>
    </>}
  </div>}</span>;
}

type Got<T> = { ok: T } | { why: string } | null;
/** 표 «내용» 칸의 클립 자리. data.clip === true 인 사건만 단추, 누를 때 클립 목록 · 관절 기록을 받는다(줄마다 미리 부르지 않음) */
export function Clip({ e, cancel }: { e: Ev; cancel?: AbortSignal }) {
  const [open, setOpen] = useState(false), [clip, setClip] = useState<Got<EventClip | undefined>>(null), [joint, setJoint] = useState<Got<JointLogReplay>>(null);
  const robot = e.robot_id;
  // false = 영상 없이 남긴 사건(정보 · 클립 안 고름) → «기록만». 값이 없거나 참 · 거짓이 아니면 클립 칸 없음(계약 밖 모양을 영상으로 보지 않음)
  if (e.data?.clip === false) return <span className="lbl rc-none">기록만</span>;
  if (e.data?.clip !== true || !robot) return null;
  const load = () => {
    setOpen(true); setClip(null); setJoint(null);
    records.clips(robot, cancel).then((r) => setClip({ ok: r.items.find((x) => x.event_id === e.id) }), (x) => setClip({ why: fail(x) }));
    records.jointLog(robot, e.id, cancel).then((r) => setJoint({ ok: r }), (x) => setJoint({ why: fail(x) }));
  };
  const again = (id: string) => records.clip(robot, id, cancel).then((r) => setClip({ ok: r }), (x) => setClip({ why: fail(x) }));
  const got = clip && 'ok' in clip ? clip.ok : undefined;
  return <div className="rc-clipbox">
    <button type="button" className="btn" data-clip aria-expanded={open} onClick={() => (open ? setOpen(false) : load())}>{open ? '클립 닫기' : '클립 · 재현'}</button>
    {open && <>
      {!clip ? <p className="lv-note" role="status">클립을 확인하는 중…</p>
        : 'why' in clip ? <p className="fh-why" data-clip-why>영상을 볼 수 없습니다. {clip.why}</p>
          : got?.status === 'READY' && got.url ? <Player clip={got} at={e.at} />
            : <p className="fh-why" data-clip-why>{got ? reason(got) : '이 사건의 클립이 아직 없습니다.'}
              {got?.status === 'PENDING' && got.clip_id && <> <button type="button" className="btn" onClick={() => again(got.clip_id!)}>다시 확인</button></>}</p>}
      {!joint ? null : 'why' in joint ? <p className="fh-why" data-joint-why>관절 재현을 볼 수 없습니다. {joint.why}</p>
        : <p className="lv-note" data-joint>받은 관절 기록: 관절 {joint.ok.joint_names.length} 개 · {joint.ok.frames.length} 프레임 · {joint.ok.rate_hz} Hz</p>}
    </>}
  </div>;
}

const SPEEDS = [0.25, 0.5, 1, 2];
/** READY 클립 재생: 배속 · 반복은 웹이 한다(05 §8.1). 시각 막대는 사건(0 초) 기준 */
function Player({ clip, at }: { clip: EventClip; at: string }) {
  const v = useRef<HTMLVideoElement>(null), [rate, setRate] = useState(1), [loop, setLoop] = useState(false);
  useEffect(() => { if (v.current) { v.current.playbackRate = rate; v.current.loop = loop; } }, [rate, loop]);
  const sec = (iso: string) => Math.round((Date.parse(iso) - Date.parse(at)) / 1000);
  const before = sec(clip.start_at), after = clip.end_at ? sec(clip.end_at) : null;
  return <div className="rc-player">
    <video ref={v} src={clip.url!} controls preload="metadata" playsInline />
    <div className="rc-bar" role="group" aria-label="사건 기준 시각">
      <span data-tick>{before} 초</span><span data-tick className="rc-zero">0 초 사건</span><span data-tick>{after === null ? '일어설 때까지' : `+${after} 초`}</span></div>
    <div className="fh-row">
      <span className="fh-row" role="group" aria-label="재생 속도">{SPEEDS.map((s) => <button key={s} type="button" className="btn" aria-pressed={rate === s} onClick={() => setRate(s)}>{s}배</button>)}</span>
      <button type="button" className="btn" aria-pressed={loop} onClick={() => setLoop(!loop)}>반복</button></div>
  </div>;
}

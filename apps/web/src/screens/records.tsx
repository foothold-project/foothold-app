// 폰 기록 타일의 클립 칸 · 재현 재생기(U8-08 · U8-09, 05 §8.1 계약 EventClip · JointLogReplay) · PC 기록(historyu8)이 같이 쓰는 까닭 문장.
// 「지금 장면 저장」(RecordMark) 창은 PC 시안 u8_8(historyu8.tsx).
// event.data.clip 은 «클립을 원했나» 참 · 거짓일 뿐이다. 영상 주소 · 상태는 records.clips 의 EventClip 으로만 받는다.
// 영상 만들기 · 관절 기록 재생은 서버에 아직 없어 501 이 온다: 그 문장을 한 줄로 보이고, 받지 않은 영상 · 재현을 그리지 않는다.
import { useEffect, useRef, useState } from 'react';
import type { Event as Ev, EventClip, JointLogReplay } from '../../../contracts/ts';
import { ApiFail, records } from '../api';
import './records.css';

/** 까닭 코드 → 문장. 서버 501 문장(records.py)과 같은 말 */
const REASON: Record<string, string> = { CLIP_PIPELINE_NOT_BUILT: '사건 영상 만들기는 아직 서버에 없습니다.', JOINT_LOG_NOT_BUILT: '관절 기록 재생은 아직 서버에 없습니다.' };
export const reason = (c: Pick<EventClip, 'status' | 'reason'>) =>
  c.status === 'PENDING' ? '서버가 클립을 만드는 중입니다.'
    : c.status === 'FAILED' ? `클립을 만들지 못했습니다.${c.reason && REASON[c.reason] ? ` ${REASON[c.reason]}` : ''}`
      : c.reason && REASON[c.reason] ? REASON[c.reason] : '클립이 아직 없습니다.';
export const fail = (e: unknown) => (e instanceof ApiFail ? e.message : '서버에 닿지 못했습니다. 잠시 뒤 다시 시도하세요.');

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

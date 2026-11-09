// 실기 직결 조종 화면(10-30 PHONE-REAL-CONNECT, 09 ADR-002 §3·§5): 주변 찾기에서 고른 로봇 에이전트에 폰이 직접(앱 중계 Go2Link) 붙은 뒤.
// 상태·요청은 phone.ts(시뮬과 같은 fh-phone/1 — 출입증·조종권·잠금·STOP·deadman 판정은 에이전트), 이 파일은 그림만. 틀은 시뮬 조종 화면(dv) 그대로.
// 실기는 아직 실제 기체에서 확인하지 않았다 — 알약·안내에 «미검증»을 늘 보인다. 명령은 로봇이 알린 limits 로만 자른다(실기 = 정지·전진·전진하며 좌우 회전).
// STOP 은 App 머리줄(늘 보임). 끊기면 로봇이 스스로 0·잠금, 자동 다시 연결·자동 재개 없음.
import { useEffect, useRef, useState } from 'react';
import { UNVERIFIED, allowed, sim, useSim } from './phone';
import { Stick } from './drive';
import { Video, stopText, useTick } from './simdrive';
import type { Tone } from './fake';

export function RealDrive() {
  const s = useSim(), l = s.link!, st = l.st, w = l.welcome, real = s.real!;
  const open = l.at === 'open', mine = !!l.lease, ready = open && mine && st?.latched === false;
  const input = useRef<[number, number]>([0, 0]), gen = useRef(0);   // [전후, 회전]
  const [leaving, setLeaving] = useState<'' | 'wait' | 'fail'>('');
  const live = ready && !leaving;
  useTick(true);
  useEffect(() => () => sim.axes([0, 0]), []);
  useEffect(() => { input.current = [0, 0]; sim.axes([0, 0]); }, [live]);   // 움직일 수 없게 되면 입력 0(다시 눌러야)
  const put = (i: 0 | 1, v: number) => { input.current[i] = v; sim.axes([input.current[0], input.current[1]]); };
  /** 나가기: 0 → 조종권 반납(답 2 s 까지) → 확인된 반납만 연결·중계를 닫고 로봇 연결 화면으로. 못 하면 남는다(입력 0, «다시 반납») */
  const leave = async () => {
    setLeaving('wait');
    const k = sim.get().link;
    const ok = k?.lease ? await Promise.race([sim.release(), new Promise<boolean>((f) => setTimeout(() => f(false), 2000))])
      : k?.at === 'closed' || !k?.st?.lease_id && k?.busy !== 'release';   // 끊긴 연결 = 로봇이 이미 0·잠금·조종권 비움
    if (sim.get().real !== real) return;
    if (ok) sim.reset(); else setLeaving('fail');
  };
  const left = l.exp ? Math.floor(l.exp - Date.now() / 1000) : Infinity, can = allowed(w);
  const lock: { tone: Tone; text: string } = !open ? { tone: 'bad', text: l.at === 'connecting' ? '연결 중' : '연결 끊김' } : !st ? { tone: 'off', text: '상태 확인 중' }
    : st.latched ? { tone: 'bad', text: '정지 잠금' } : !mine ? { tone: 'off', text: '보는 중' } : { tone: 'ok', text: '움직일 수 있음' };
  const notes = [
    stopText(s),
    leaving === 'wait' && '조종권을 반납하고 나가는 중입니다…',
    leaving === 'fail' && '조종권 반납을 확인하지 못했습니다 — 입력은 0 입니다. 다시 반납하거나 STOP 을 누르세요.',
    l.at === 'closed' && l.why,
    l.notice,
    mine && l.clipped && '명령 범위 조정 — 로봇이 허용한 명령으로 잘랐습니다.',
    open && left < 60 && `출입증 ${Math.max(0, left)}초 남음 — 만료되면 로봇이 멈추고 조종권이 비워집니다. 새 출입증으로 다시 연결하세요.`,
  ].filter(Boolean) as string[];
  const acts = [
    leaving === 'fail' && <button key="rel" type="button" className="btn pri" onClick={leave}>다시 반납</button>,
    !leaving && open && !mine && <button key="take" type="button" className="btn pri" disabled={l.busy === 'take'} onClick={() => sim.take()}>조종 시작</button>,
    !leaving && open && mine && st?.latched !== false && <button key="unlock" type="button" className="btn pri" disabled={l.busy === 'unlock'} onClick={() => sim.unlock()}>잠금 해제</button>,
    l.at === 'closed' && <button key="re" type="button" className="btn pri" onClick={() => sim.connect()}>다시 연결</button>,
    !leaving && open && left < 60 && <button key="pass" type="button" className="btn" onClick={() => sim.connect()}>새 출입증으로 다시 연결</button>,
  ].filter(Boolean);
  const range = w && `로봇 허용: 앞 ${w.limits.vx_max.toFixed(2)} m/s${can.back ? '' : ' · 후진 없음'}${can.left || can.right ? '' : ' · 옆걸음 없음'} · 회전 ±${w.limits.wz_max} rad/s${can.spin ? '' : '(앞으로 밀면서만)'}`;
  return <section className="dv ph" style={{ flexBasis: '100%' }} aria-label="실기 조종" data-real-drive onContextMenu={(e) => e.preventDefault()}>
    <div className="dv-body"><div className="dv-stage rgb">
      <Video ch="rgb" fit="cover" />
      <div className="dv-safe">
        <button type="button" className="dv-gear dv-leave" aria-label="나가기" disabled={leaving === 'wait'} data-real-leave onClick={leave}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="M15 5l-7 7 7 7" /></svg></button>
        <div className="dv-top" aria-label="상태" data-tone={lock.tone} data-real-pill>실기 · 미검증 · {real.name} · {lock.text}</div>
        <div className="dv-act" data-real-card>
          <div className="dv-act-t">
            <p className="dv-note" role="note" data-real-unverified>{UNVERIFIED}</p>
            {range && <p className="dv-note" data-real-range>{range}</p>}
            {notes.map((t) => <p key={t} className="dv-note" role="status">{t}</p>)}
          </div>
          {acts.length > 0 && <div className="fh-row">{acts}</div>}
        </div>
        {l.ask && mine && <div className="dv-ask" role="dialog" aria-labelledby="real-ask-t" aria-live="assertive">
          <b id="real-ask-t">조종권 요청</b><p>다른 사람이 이 로봇의 조종권을 요청했습니다. 넘겨주시겠습니까?</p>
          <div className="fh-row"><button type="button" className="btn" onClick={() => sim.respond(true)}>넘기기</button><button type="button" className="btn" onClick={() => sim.respond(false)}>계속 조종</button></div></div>}
        {mine && open && <>
          <Stick label="전후" vertical on={live} epoch={+live} gen={gen} set={(v) => put(0, v)} />
          <Stick label="회전" on={live} epoch={+live} gen={gen} set={(v) => put(1, v)} />
        </>}
      </div>
    </div></div>
  </section>;
}

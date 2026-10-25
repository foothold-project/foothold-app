// PC 웹 «시뮬» 탭(10 ADR-003 §1 결정 3·§7 ③): 월드·시작 층 골라 띄우기 → 보기(«시뮬»·상태·위치·영상) → 끝내기.
// 띄우기·정리·직결·영상은 폰과 같은 phone.ts(sim)·SimLaunch 그대로. 조종 입력은 없다(④ 키보드) — 직결은 보기만, 조종권을 받지 않는다.
// STOP 은 App 머리줄(PR #94 규칙 그대로) — 이 화면은 STOP 을 덮지 않는다.
import { useEffect } from 'react';
import { sim, useSim } from '../phone';
import { CAM, STATE, SimLaunch, remainingTime, short, stopText, timeNotice, useDeadline, useTick, worldName } from '../simdrive';
import { SimMap, useFloorMap } from '../simmap';
import { Chip } from '../screens';
import type { Tone, User } from '../fake';

export function SimTab({ user, refresh }: { user: User; refresh: () => void }) {
  const s = useSim(), ids = s.mine.map((r) => r.robot_id).join();
  // 띄우기·끝내기로 내 시뮬 목록이 바뀌면 로봇 목록도 다시 받는다(머리줄 STOP 후보·로봇 탭에 바로 보이게)
  useEffect(() => { if (s.listed) refresh(); }, [ids]);
  return s.step === 'drive' && s.link && s.robot ? <SimView /> : <SimLaunch me={user.id} view />;
}

/** 띄운 시뮬 보기: 이름·«시뮬»·월드·상태·위치(좌표 + 층 지도 점)·영상, 끝내기·보기 닫기(시뮬은 켠 채) */
function SimView() {
  const s = useSim(), l = s.link!, r = s.robot!, st = l.st, open = l.at === 'open';
  useDeadline(!!r.expires_at);
  useTick(true);
  const floors = s.catalog?.worlds.find((w) => w.id === r.world_id)?.floors ?? [], fm = useFloorMap(st, r, floors), hasMap = floors.length > 0 || !!fm.ctx;
  const p = st?.pose, at = p && p.x != null && p.y != null ? `x ${p.x.toFixed(2)} m · y ${p.y.toFixed(2)} m` : '위치 확인 중';
  const lock: { tone: Tone; text: string } = !open ? { tone: 'bad', text: l.at === 'connecting' ? '연결 중' : '연결 끊김' } : !st ? { tone: 'off', text: '상태 확인 중' }
    : st.latched ? { tone: 'bad', text: '정지 잠금' } : { tone: 'off', text: '보는 중' };
  const wait = Math.max(0, Math.ceil((s.retryAt - performance.now()) / 1000));
  const notes = [timeNotice(remainingTime(s.runtimeUntil)), l.at === 'closed' && l.why, l.notice, fm.notice, stopText(s)].filter(Boolean) as string[];
  return <>
    <section className="lv-card" style={{ flexBasis: '100%' }} aria-label="시뮬 로봇" data-sim-view>
      <div className="fh-row" style={{ flexWrap: 'wrap' }}>
        <h2>{short(r.robot_id)}</h2><Chip tone="off" text="시뮬" /><span className="lbl">{worldName(s, r.world_id)}</span>
        <span data-sim-state>{STATE[r.state]}</span><Chip {...lock} /><span className="mono" data-sim-pos>{at}</span>
      </div>
      {notes.map((t) => <p key={t} className="fh-why" role="status">{t}</p>)}
      <div className="fh-row">
        {l.at === 'closed' && <button type="button" className="btn pri" disabled={!!wait} onClick={() => sim.connect()}>{wait ? `다시 연결(${wait}초 뒤)` : '다시 연결'}</button>}
        <button type="button" className="btn" onClick={() => sim.end()}>끝내기</button>
        <button type="button" className="btn" onClick={() => sim.reset()}>보기 닫기</button>
        <span className="lbl">조종은 아직 없습니다(키보드 조종 준비 중). 보기 닫기는 시뮬을 켠 채 둡니다.</span>
      </div>
    </section>
    <section className="dv" style={{ flexBasis: '100%' }} aria-label="보기">
      <div className="dv-body" style={{ flexWrap: 'wrap' }}>
        <div className="dv-stage rgb" style={{ flexBasis: 420 }}>
          {l.cam === 'frame' ? <img className="dv-video" draggable={false} src={l.img} alt="RGB 영상" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
            : <div className="dv-video" role="img" aria-label="RGB 영상"><span>{CAM[l.cam]}</span></div>}
        </div>
        {hasMap && <div className="dv-stage" style={{ flexBasis: 320 }} data-sim-mapbox><SimMap m={fm} big /></div>}
      </div>
    </section>
  </>;
}

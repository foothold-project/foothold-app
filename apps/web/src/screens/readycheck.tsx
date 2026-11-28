// 순서 점검(u2_4 · L66) · 「조종 준비」 칸 안 접힌 「자세히 점검」: 에이전트 Wi-Fi → 서버 → 에이전트 → 걷기 정책 → 몸통 → 센서 → 배터리 · 관절을 차례로 한 표에.
// 보기 전용이다. 단계마다 «확인됨 · 막힘(까닭) · 서버에 값 없음» 셋 중 하나만 쓰고, 조종을 허락하는 듯한 말은 쓰지 않는다(조종 가부는 조종 화면 판정이 정함).
// 로봇 쪽 컴퓨터 프로그램은 다른 화면(근처 로봇 · 시뮬 · 실행) 처럼 «에이전트» 로 부른다.
// 계약에 없는 값(에이전트 쪽 Wi-Fi 이름 · 걷기 정책)은 «서버에 값 없음» 으로 두고 짓지 않는다. 로봇이 끊기면 마지막 값으로 «확인됨» 하지 않는다.
// «다시 점검» 은 받는 값을 다시 받기만 한다(로봇 목록 다시 받기 · 로봇에 명령 없음).
import { useState } from 'react';
import type { Robot } from '../fake';
import { pickInfo } from '../go2status';
import { JOINTS, jointName } from '../go2model';
import { TEMP_STALE_S } from '../go2model';
import './readycheck.css';

type State = 'ok' | 'blocked' | 'none';
type Step = { key: string; name: string; state: State; why: string };
const STATE: Record<State, [string, string]> = { ok: ['✓', '확인됨'], blocked: ['!', '막힘'], none: ['·', '서버에 값 없음'] };
const SENSORS = new Set(['CAMERA_RGB', 'CAMERA_DEPTH', 'LIDAR']);
const NOW_NONE = '로봇이 연결되어 있지 않아 지금 값이 없습니다.';

/** 최고 관절 온도 한 마디(u4_4 가): 값 · 어느 관절만. 문턱이 정해지지 않아(#389 잠정) 단계 상태 · 색은 바꾸지 않는다.
 *  12 개가 아니거나 · 값이 없거나 · 3 초 넘게 오래된 값(pcdrive TEMP_STALE_S)은 지금 값이 아니라 «서버에 값 없음» */
export function hotJoint(r: Robot): string {
  const t = r.robotInfo?.temperature, j = Array.isArray(t?.joints) && t.joints.length === 12 && t.age_s <= TEMP_STALE_S ? t.joints : [];
  const hi = j.reduce<number>((b, v, i) => (typeof v === 'number' && Number.isFinite(v) && (b < 0 || v > (j[b] as number)) ? i : b), -1);
  return `최고 관절 온도 ${hi < 0 ? STATE.none[1] : `${Math.round(j[hi] as number)} °C (${jointName(JOINTS[hi])})`}`;
}

/** 단계 판정. server = 이 화면과 관제 서버 연결 */
export function checks(r: Robot, server: boolean): Step[] {
  const live = r.online && !r.unknown;   // 지금 값인지(끊김 · 요약만 · 대기면 마지막 값을 쓰지 않음)
  const agent: [State, string] = r.unknown ? ['none', r.unknown === 'summary' ? '남의 로봇은 서버가 요약만 보냅니다.' : r.unknown === 'wait' ? '서버에서 이 로봇의 첫 상태를 기다리는 중입니다.' : '서버와 끊겨 로봇 상태를 모릅니다.']
    : r.online ? ['ok', '로봇 상태를 받고 있습니다.'] : ['blocked', r.status ? '에이전트와 연결이 끊겼습니다.' : '에이전트가 아직 연결된 적이 없습니다.'];
  const v = live ? pickInfo(r)?.v ?? null : null;
  const body: [State, string] = !live ? ['none', NOW_NONE] : v?.fallen ? ['blocked', '넘어짐 의심 (기울기로 추정한 값)'] : v?.fallen === false ? ['ok', '넘어지지 않음 (기울기로 추정한 값)'] : ['none', '자세 값을 받지 못했습니다.'];
  const dev = (r.devices ?? []).filter((d) => SENSORS.has(d.kind)), bad = dev.find((d) => d.state !== 'OK');
  const sensors: [State, string] = !live ? ['none', NOW_NONE] : !dev.length ? ['none', '카메라 · 라이다 목록을 받지 못했습니다.']
    : bad ? ['blocked', `${bad.label} ${bad.state === 'MISSING' ? '없음' : '오류'}`] : ['ok', dev.map((d) => d.label).join(' · ')];
  const bat = live && r.battery != null, joints = live && !!r.robotInfo?.joints;
  const power: [State, string] = !live ? ['none', NOW_NONE] : [bat && joints ? 'ok' : 'none', `${bat ? `배터리 ${Math.round(r.battery!)} %` : '배터리 값 없음'} · ${joints ? '관절 값 받음' : '관절 값 없음'} · ${hotJoint(r)}`];
  return ([
    ['wifi', '에이전트 Wi-Fi', ['none', '에이전트가 붙은 Wi-Fi 이름은 서버가 아직 보내지 않습니다.']],
    ['server', '서버', server ? ['ok', '이 화면이 관제 서버와 연결되어 있습니다.'] : ['blocked', '이 화면이 관제 서버와 연결되어 있지 않습니다.']],
    ['agent', '에이전트', agent],
    ['policy', '걷기 정책', ['none', '걷기 정책 상태는 서버가 아직 보내지 않습니다.']],
    ['body', '몸통', body],
    ['sensors', '센서', sensors],
    ['power', '배터리 · 관절', power],
  ] as [string, string, [State, string]][]).map(([key, name, [state, why]]) => ({ key, name, state, why }));
}

/** 「조종 준비」 칸 맨 아래 접힌 「자세히 점검 (7 단계)」. 접힌 동안은 첫 막힘 한 줄만(없으면 아무것도), 펼치면 일곱 단계 + 다시 점검 */
export function ReadyCheck({ r, server, again }: { r: Robot; server: boolean; again: () => void }) {
  const [open, setOpen] = useState(false), list = checks(r, server), first = list.find((s) => s.state === 'blocked');
  return <div className="ck-box">
    {!open && first && <p className="fh-msg" role="status" data-check-head>{first.name} 막힘 · {first.why}</p>}
    <details className="fh-fold ck-fold" data-readycheck onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>자세히 점검 (7 단계)</summary>
      <ol className="ck-steps">{list.map((s) => <li key={s.key} className="ck-step" data-check={s.key} data-state={s.state} data-first={s === first || undefined}>
        <span className="ck-mark" data-check-mark aria-hidden="true">{STATE[s.state][0]}</span>
        <span className="ck-name">{s.name}</span>
        <span className="ck-state" data-check-state>{STATE[s.state][1]}</span>
        <span className="lbl ck-why" data-check-why>{s.why}</span>
      </li>)}</ol>
      <div className="fh-row ck-foot"><p className="lv-note fh-grow">보기 전용입니다. 조종 가부는 조종 화면이 정합니다. «다시 점검» 은 서버 값을 다시 받기만 합니다.</p>
        <button type="button" className="btn" onClick={again}>다시 점검</button></div>
    </details>
  </div>;
}

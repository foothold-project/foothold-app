// 걷기 모드 넷(Classic · Sport · START · AME-2) 칸과 Shift+1~4 (u03 · 11-28, 계약 #525 ScreenGait · GaitState · GaitResult).
// PC 서버 경유 조종(serverdrive)과 폰 조종(drive «정책» 시트)이 같이 쓴다. 보내기는 rt.gait, 지금 모드 · 쓸 수 있는 모드 · 결과는 로봇이 보고한 state 로만.
// 결과 SUCCEEDED 에서만 «바꿨습니다» · 서버 접수 · RUNNING 은 «바꾸는 중». 지금 서버는 GAIT_UNSUPPORTED(501)로 거절하므로 받은 척하지 않고 까닭 한 줄.
// 움직이는 중 · 조종권 없음 · 잠금 · 바꾸는 중이면 보내지 않고 까닭. STOP 은 이 칸과 따로라 언제나 먼저(바꾸는 중에도 눌림)
import { useEffect, useState } from 'react';
import { rt, useLive } from './rt';
import type { GaitName } from '../../contracts/ts';

export const GAITS = [
  { g: 'classic', name: 'Classic', n: 1 }, { g: 'sport', name: 'Sport', n: 2 }, { g: 'start', name: 'START', n: 3 }, { g: 'ame2', name: 'AME-2', n: 4 },
] as const satisfies readonly { g: GaitName; name: string; n: number }[];
const NAME = Object.fromEntries(GAITS.map((x) => [x.g, x.name])) as Record<GaitName, string>;
const BY_CODE: Record<string, GaitName> = Object.fromEntries(GAITS.map((x) => [`Digit${x.n}`, x.g]));
/** Shift+1~4(다른 수정 키 없이) → 모드. 숫자 줄 물리 키(e.code)라 자판 배열과 무관 */
export const gaitKey = (e: KeyboardEvent): GaitName | undefined => (e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey ? BY_CODE[e.code] : undefined);
export const GAIT_KEYS = 'Shift+1~4 걷기 모드 (Classic · Sport · START · AME-2)';
/** 보낸 뒤 이 시간 안에 로봇 결과가 없으면 «결과를 받지 못함» */
export const GAIT_WAIT_MS = 20000;
/** 로봇이 보낸 쓸 수 있는 모드가 빈 목록(시뮬 등) = 바꾸기 단추 꺼짐 · 까닭 */
export const NO_GAIT = '이 로봇은 걷기 모드를 바꿀 수 없습니다 (로봇이 보낸 쓸 수 있는 모드 없음).';
/** 거절 · 실패 코드(계약 GaitRejectCode, 열린 문자열) → 다음 할 일 한 줄 */
const WHY: Record<string, string> = {
  GAIT_MOVING: '로봇이 움직이고 있습니다. 멈춘 뒤 바꿀 수 있습니다.',
  GAIT_NOT_STANDING: '로봇이 서 있지 않습니다. «일어서기» 뒤 바꿀 수 있습니다.',
  GAIT_NOT_READY: '로봇이 아직 모드를 바꿀 준비가 안 됐습니다. 잠시 뒤 다시 고르세요.',
  GAIT_LATCHED: '정지 잠금 중입니다. 잠금을 푼 뒤 바꿀 수 있습니다.',
  GAIT_BUSY: '모드를 바꾸는 중입니다. 끝난 뒤 다시 고르세요.',
  GAIT_UNSUPPORTED: '걷기 모드 바꾸기는 아직 준비 중이라 서버가 받지 않았습니다. 모드는 그대로입니다.',
  GAIT_CANCELLED: '정지 요청으로 모드 바꾸기를 멈췄습니다. 현장에서 로봇을 확인하세요.',
  GAIT_LEASE_LOST: '바꾸는 중에 조종권이 바뀌었습니다. [조종 시작]부터 다시 하세요.',
  GAIT_TIMEOUT: '시간 안에 끝나지 않았습니다. 현장에서 로봇을 확인하세요.',
  GAIT_SDK_ERROR: '로봇이 모드 바꾸기를 받지 않았습니다. 잠시 뒤 다시 고르세요.',
};
export const gaitWhy = (code?: string | null) => WHY[code ?? ''] ?? `로봇이 모드를 바꾸지 못했습니다 (${code || '까닭 모름'}). 현장에서 로봇을 확인하세요.`;
const LOST = '로봇에서 결과를 받지 못했습니다. 모드가 바뀌었는지 현장에서 확인하세요.';

/** moving = 지금 입력이 0 이 아님(누른 키 · 단추 · 스틱, 로봇이 적용 중인 명령). 돌려주는 press 는 단추 · 단축키가 같이 쓴다 */
export function useGait(id: string, moving: () => boolean) {
  const l = useLive(id), s = l.state, link = rt.link().at, mine = !!l.lease;
  const cur = s?.gait?.gait ?? null, avail = s?.gait?.available ?? null, res = s?.gait_result ?? null;
  // ask = 내가 보낸 바꾸기(결과까지), rid = 보낸 메시지 id(결과 gait_result.request_id 와 짝)
  const [ask, setAsk] = useState<{ g: GaitName; rid: string } | null>(null), [msg, setMsg] = useState('');
  const off = (g: GaitName) => !!avail && !avail.includes(g);
  /** 보내지 않을 까닭(없으면 '') */
  const block = (g: GaitName) => !mine ? '조종 시작 뒤 바꿀 수 있습니다.'
    : avail && !avail.length ? NO_GAIT
    : link !== 'open' ? '서버 연결이 끊겨 바꿀 수 없습니다.'
    : s?.connection !== 'ONLINE' ? '로봇 연결이 끊겨 바꿀 수 없습니다.'
    : s.latched !== false ? WHY.GAIT_LATCHED
    // 이 화면이 STOP 을 보낸 뒤 로봇 잠금 보고(새 stop_gen)가 오기 전 틈도 막는다. 조종권이 바뀌면(rev) 그 STOP 은 지난 것
    : l.stop && !l.stop.latched && l.stop.rev === l.rev && (s.stop_gen ?? -1) <= l.stop.g0 ? '정지 요청을 처리하는 중입니다. 로봇이 멈춘 것을 확인한 뒤 바꾸세요.'
    : ask ? WHY.GAIT_BUSY
    : moving() ? WHY.GAIT_MOVING
    : off(g) ? `${NAME[g]}: 이 로봇에서 지금 쓸 수 없는 모드입니다.`
    : cur === g ? `이미 ${NAME[g]} 모드입니다.` : '';
  const press = (g: GaitName) => {
    const no = block(g);
    if (no) return setMsg(no);
    setMsg('');
    let failed = false;
    const rid = rt.gait(id, g, (bad, code) => { if (bad) { failed = true; setAsk(null); setMsg(code && WHY[code] ? WHY[code] : bad); } });
    if (rid && !failed) setAsk({ g, rid });
  };
  useEffect(() => {
    if (!ask || !res || res.request_id !== ask.rid || res.status === 'RUNNING') return;
    setAsk(null); setMsg(res.status === 'SUCCEEDED' ? `${NAME[res.gait]} 모드로 바꿨습니다.` : gaitWhy(res.code));
  }, [ask, res?.request_id, res?.status]);
  useEffect(() => { if (!ask) return; const t = setTimeout(() => { setAsk(null); setMsg(LOST); }, GAIT_WAIT_MS); return () => clearTimeout(t); }, [ask]);
  useEffect(() => { if (!mine) { setAsk(null); setMsg(''); } }, [mine]);
  // STOP(머리줄 · Space · 패널 단추)은 이 칸을 기다리지 않는다. 바꾸는 중이었으면 대기를 끝내고 결과는 로봇 보고로
  useEffect(() => { if (l.stop && ask) { setAsk(null); setMsg('정지 요청을 먼저 보냈습니다. 모드가 바뀌었는지는 로봇 보고로 확인하세요.'); } }, [l.stop?.n]);   // eslint-disable-line react-hooks/exhaustive-deps

  const offs = avail ? GAITS.filter((x) => off(x.g)).map((x) => x.name) : [];
  const row = mine && <div className="fh-row gait-row" role="group" aria-label="걷기 모드" data-gait-row>
    <span className="lbl">걷기 모드 · 지금 {cur ? NAME[cur] : '모름'}</span>
    {GAITS.map((x) => <button key={x.g} type="button" className="btn" data-gait={x.g} aria-pressed={cur === x.g} aria-disabled={off(x.g) || !!ask}
      onClick={() => press(x.g)}>{x.name}<small className="mono">Shift+{x.n}</small></button>)}
    {offs.length > 0 && <span className="lbl" data-gait-off style={{ flexBasis: '100%' }}>{offs.join(' · ')}: 이 로봇에서 지금 쓸 수 없음</span>}
    {(ask || msg) && <span role="status" className="lbl" style={{ flexBasis: '100%' }} data-gait-msg>{ask ? `${NAME[ask.g]} 모드로 바꾸는 중…` : msg}</span>}
  </div>;
  return { row, press, cur, avail, msg: ask ? `${NAME[ask.g]} 모드로 바꾸는 중…` : msg };
}

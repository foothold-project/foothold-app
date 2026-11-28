// 로봇 자세 · 동작 단추 일곱과 손잡이 → 명령 낱말 규칙(PC 로봇 탭 screens/u4/robotu4.tsx · 폰 실기 조종 drive.tsx 가 함께 쓴다).
// 보내기는 rt.action(서버 길 하나) · 막음은 actiontrial 표(FACTORY_OFF 순정 확인 전 · LOWLEVEL 저수준 중 되는 것). 화면마다 다른 것은 꼴과 앞 조건(조종권 · 연결)뿐
import { useEffect, useState, type ReactNode } from 'react';
import type { ScreenAction } from '../../contracts/ts';
import type { Tok } from './serverdrive';
import { ACTION_NAMES, FACTORY_OFF, LOWLEVEL } from './screens/actiontrial';

/** 자세 · 동작 단추 일곱(시안 순서 · 글 · 리모컨 조합 글 그대로) → 계약 ScreenAction 이름 */
export const ACTS: [ScreenAction['action'], string, string, ReactNode][] = [
  ['Sit', '앉기', 'R1+B', <><path d="M8 20v-6l-2-4 4-2 4 2v4h4v6" /><circle cx="10" cy="5" r="2" /></>],
  ['StandUp', '일어서기', 'START 중 안 됨', <><circle cx="12" cy="4.5" r="2" /><path d="M12 7v7M8 10h8M9 21l3-7 3 7" /></>],
  ['StandDown', '엎드리기', 'L2+A', <><path d="M3 18h18M6 14h12l-2-4H8z" /><path d="M12 3v5M9.5 6L12 8.5 14.5 6" /></>],
  ['Stretch', '기지개', 'R2+A', <><path d="M3 16c3-6 6-6 9-3s6 3 9-3" /><path d="M4 20h4M16 20h4" /></>],
  ['Hello', '악수', 'R2+B', <><path d="M7 11l3-3 4 1 3-2 3 3-6 6-3-2-2 1z" /><path d="M4 13l3-2" /></>],
  ['Heart', '하트', 'R2+Y', <path d="M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 10c0 5.5-7 10-7 10z" />],
  ['Greet', '인사', 'L1+A', <path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V11M11 10V4.5a1.5 1.5 0 0 1 3 0V11M14 10.5V6a1.5 1.5 0 0 1 3 0v8a6 6 0 0 1-6 6h-1a5 5 0 0 1-4-2l-2.5-3.5a1.5 1.5 0 0 1 2.4-1.8L8 14" />],
];

/** 시안 일어서기 「START 중 안 됨」 까닭 글 그대로 */
export const STANDUP_WHY = 'START 에서는 일어서기를 보낼 수 없습니다 · 앉은 뒤 「앉기」 를 다시 누르면 일어납니다';

/** 손잡이(팀장 11-28 17:33 · 키보드와 같은 배치): 왼쪽 = 이동(위 앞 · 아래 뒤 · 왼 · 오른 옆걸음), 오른쪽 = 돌기(왼 · 오른).
 *  한 손잡이는 큰 축 하나만 보낸다(대각은 더 크게 민 쪽). 문턱 0.3 아래는 0. 두 손잡이 조합 · 상한은 serverdrive 명령표가 판단 */
export function stickTok(side: 'L' | 'R', x: number, y: number): Tok[] {
  const on = (u: number) => shape(u, REAL_DEAD, 1, 1);   // 실기 = 켜짐/꺼짐(표 값) — 같은 문턱 식의 lo = hi = 1
  if (side === 'R') return on(-x) > 0 ? ['rotl'] : on(-x) < 0 ? ['rotr'] : [];
  if (Math.abs(y) >= Math.abs(x)) return on(-y) > 0 ? ['up'] : on(-y) < 0 ? ['down'] : [];
  return on(-x) > 0 ? ['left'] : on(-x) < 0 ? ['right'] : [];
}
/** 실기 손잡이 문턱(표 값 켜짐/꺼짐) */
export const REAL_DEAD = 0.3;
/** 문턱 · 최소값 대응(데모 · 실기 같은 식 · app-lx 11-28 22:59): |u| ≤ dead 는 0, 넘으면 부호 × [lo, hi] 에 curve(0..1) 대응(기본 직선). 실기 표 값은 lo = hi */
export function shape(u: number, dead: number, lo: number, hi: number, curve: (a: number) => number = (a) => a) {
  const a = Math.min(Math.abs(u), 1);
  if (a <= dead || hi <= 0) return 0;
  return Math.sign(u) * (lo + curve((a - dead) / (1 - dead)) * (hi - lo));
}

/** 지금 누를 수 없는 동작(일어서기는 저수준 중만 막힘) */
export const actOff = (name: ScreenAction['action'], lowlevel: boolean) => name === 'StandUp' ? lowlevel : lowlevel ? !LOWLEVEL.has(name) : FACTORY_OFF.has(name);
/** 막은 까닭 한 줄(없으면 '') · 앞 조건(조종권 · 연결)은 부르는 화면이 먼저 본다 */
export function actWhy(name: ScreenAction['action'], lowlevel: boolean) {
  if (name === 'StandUp' && lowlevel) return STANDUP_WHY;
  if (lowlevel ? !LOWLEVEL.has(name) : FACTORY_OFF.has(name)) return `${ACTION_NAMES[name]}: ${lowlevel ? '저수준 제어 중에는 쓸 수 없음' : '순정 번호 확인 전'}`;
  return '';
}

/** 「다시 시작」 확인 창 글(시안 u4_10 · 폰 실기 조종 u1 도 같은 글). 일어서기 = 잠금 해제(rt.unlock) 한 번 */
export const RESTART_ASK = (name: string) => `${name} 을 일으킬까요?`;
export const RESTART_TEXT = '그 자리에서 일어선 뒤 조종과 동작이 다시 켜집니다. 주변에 사람이 없는지 보세요.';

/** 「다시 시작」 창이 묶이는 값: 연 때의 stop_gen · 조종권(lease). mine = 지금 내 조종권이고 연결이 열림 */
export type RestartNow = { mine: boolean; latched: boolean | null | undefined; gen: number | null | undefined; lease: string | null | undefined };
const same = (k: Pick<RestartNow, 'gen' | 'lease'> | null, c: RestartNow) => !!k && c.mine && c.latched !== false && c.gen === k.gen && c.lease === k.lease;
/** 「다시 시작」 확인 창 열림(reviewer H1): 연 때의 stop_gen · 조종권에 묶는다. 잠금 풀림 · stop_gen 바뀜 · 조종권 바뀜 · 연결 끊김이면 열림 자체를 닫고,
 *  「일어서기」 는 누르는 순간 저장소 값(now)으로 다시 봐서 같을 때만 unlock 을 보낸다 — 다른 곳에서 풀린 뒤 새 STOP 에 창이 저절로 다시 뜨지 않게.
 *  now 는 그리는 값이 아니라 저장소에서 바로 읽는 함수(서버 경유 rt.get · 직결 sim.get) */
export function useRestartAsk(now: () => RestartNow) {
  const [at, setAt] = useState<Pick<RestartNow, 'gen' | 'lease'> | null>(null);
  const live = same(at, now());
  useEffect(() => { if (at && !live) setAt(null); }, [at, live]);
  return {
    live,
    open: () => { const n = now(); setAt({ gen: n.gen, lease: n.lease }); },
    close: () => setAt(null),
    go: (unlock: () => void) => { const k = at; setAt(null); if (same(k, now())) unlock(); },
  };
}

/** 직결 조종 화면(simdrive · realdrive · PC 시뮬 탭 · 임무 실행 칸)의 「다시 시작」 확인 창 · 꼴은 .dv-ask(drive.css), 글은 u4_10 그대로.
 *  inline = 화면 위에 띄우지 않고 그 자리 줄에(PC 시뮬 탭 · 임무 실행 칸처럼 조종 판이 없는 곳) */
export function RestartAskBox({ name, cancel, go, inline }: { name: string; cancel: () => void; go: () => void; inline?: boolean }) {
  return <div className="dv-ask" role="dialog" aria-labelledby="restart-ask-t" data-restart-ask style={inline ? { position: 'static', transform: 'none', width: 'auto' } : undefined}>
    <b id="restart-ask-t">{RESTART_ASK(name)}</b><p>{RESTART_TEXT}</p>
    <div className="fh-row"><button type="button" className="btn" onClick={cancel}>취소</button>
      <button type="button" className="btn pri" data-restart-go onClick={go}>일어서기</button></div>
  </div>;
}

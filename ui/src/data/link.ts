// WebSocket 링크 — 이 앱에서 WS 를 여는 곳은 여기 하나(소유자 하나). 명령 송신도 여기서만.
// 묶음 1 은 읽기 전용: 보내는 명령은 STOP(명령 0 요청) 하나. 조종 입력(cmd 20 Hz)·조종권은 묶음 3 에서 같은 파일에 붙인다.
// STOP 은 명령 0 요청일 뿐 몸 정지가 아니다(시뮬 관측: STOP 뒤 약 3.6 s·0.32 m 더 움직임, 원인 미확인).
import { create } from 'zustand';
import type { ClientOp, ServerMsg, Status } from '@contracts';
import { refreshShared } from './shared';

type LinkState = { st: Status | null; lastMsg: number; firstVer: string | null; authEnd: boolean; tick: number };
export const useLink = create<LinkState>(() => ({ st: null, lastMsg: 0, firstVer: null, authEnd: false, tick: 0 }));

let ws: WebSocket | null = null, started = false;
const send = (o: ClientOp) => { if (ws && ws.readyState === 1) { ws.send(JSON.stringify(o)); return true; } return false; };
export const sendStop = () => send({ op: 'stop' });

export function startLink() {
  if (started) return; started = true;
  const open = () => {
    const u = new URL('ws', location.href); u.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'; u.hash = ''; u.search = '';
    ws = new WebSocket(u); ws.binaryType = 'blob';
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return;   // 카메라 JPEG — 묶음 1 화면은 영상을 쓰지 않음
      const m = JSON.parse(e.data) as ServerMsg;
      if (m.op !== 'status') return;            // reply(rid 응답)는 묶음 1 에서 안 씀
      useLink.setState((s) => ({ st: m, lastMsg: performance.now(), firstVer: s.firstVer ?? m.ver }));
      refreshShared(m.docs_rev, (m.events || [])[0]);
    };
    ws.onclose = (e) => {
      if (e.code === 4401) { useLink.setState({ authEnd: true }); return; }   // 로그인 끝남: 다시 잇지 않음(로그인 화면 연결은 묶음 4)
      setTimeout(open, 1000);
    };
  };
  open();
  setInterval(() => useLink.setState((s) => ({ tick: s.tick + 1 })), 500);   // 메시지가 끊겨도 «끊김 N s» 표시가 갱신되게
}

// live.js view() 의 링크·잠금·조종권 글(같은 규칙). 끊기면 «꺼짐»이 아니라 «미확인».
export function linkView(s: LinkState) {
  const age = s.lastMsg ? (performance.now() - s.lastMsg) / 1000 : null, linkOk = age != null && age < 1, st = s.st;
  return {
    linkOk, latch: !!(linkOk && st?.latch), simBlock: linkOk ? st?.sim_block || '' : '',
    linkTxt: s.authEnd ? '로그인 끝남 · 다시 로그인 필요' : !linkOk ? (age == null ? '연결 중' : `끊김 ${age.toFixed(0)} s`) : st!.sim_block || '정상',
    roleTxt: st?.role === 'control' ? '조종권 · 이 기기' : st?.role === 'view_other' ? `다른 기기가 조종 중${st.holder ? ` · ${st.holder}` : ''}` : '보기 전용',
    newVer: !!(st && s.firstVer && st.ver && st.ver !== s.firstVer),
  };
}

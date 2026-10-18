// «지도 열기»: 지도용 Gazebo 시뮬을 1회 시작(op map_start → RL 래퍼) + «SLAM 지도 저장»(op map_save → /v2_map/save).
// 위의 «지도 보기» 선택(화면만)과 별개 — 실제 Gazebo 지형·층을 바꾸는 건 이 상자의 «지도 열기» 버튼뿐(끄고 새로 열기).
// 10-18 저장 지도 시작(root SAVED-START · 결정 A 대체): «시작 지도» 기본 = 저장한 지도로 열기(map_start mode static + 목록에 있는 map_version 정확히),
//   «새 지도 만들기»(mode slam · map_version 없음)는 직접 고를 때만. 저장본 = 고른 지형·층의 map_source slam 만(GT·다른 지형·층 대체 0) — 1개면 그것, 여러 개면 직접 고르기 전 실행 0,
//   0개·목록 읽는 중·목록 실패면 저장 시작 0(새 지도 자동 전환 0). 서버·계약 변경 0. 평지 sim_start 는 새 UI 에서 보내지 않음(옛 앱·직접 API 는 서버가 계속 받음).
// 상시 표시: 고른 곳 · 지금 실제 실행 중인 곳 · 열 수 있나(서버 why) · 다음 행동 · 마지막 요청 결과. 자동 기동·중단·재시도 0.
import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import type { MapInfo } from '@contracts';
import { ask, askPage, dropAll, dropAsk, startGen, useLink } from '../data/link';
import { whyProps } from '../app/shell';
import { BLD, FLOOR, TASK, WF, loadList, mapKey, listMaps, place, runAt, runLine, savedOf, staticSeen, useCatalog, type ListSeq, type Sess } from '../data/maps';
import { TerrainPreview, useTerrainPreview } from './TerrainPreview';
import { Help } from '../app/chip';

type W = 'v5_single' | 'v5_building' | 'rooms_a';
const PLACES: { w: W; sub: string }[] = [
  { w: 'v5_single', sub: '단층 · 계단 위끝 낭떠러지 있음' },
  { w: 'v5_building', sub: '1·2층이 연결된 한 건물 · 시작층만 고름 · 실제 계단·경사로 통과 미검증' },
  { w: 'rooms_a', sub: '방 여러 개 · 저장한 지도를 열거나 새 지도를 만들며 직접 이동' },
];
type Res = { t: string; ok: boolean; text: string; what: string; key?: string; sent?: boolean } | null;   // key = 목록에서 확인된 저장본(보기 버튼) · sent = 확인 뒤 ask 호출함(시도 — 실제 WS 송신 증거 아님)
// 마지막 요청 결과는 화면을 오가도 남게(이 기기 메모리만 — 새로고침하면 서버 «최근 결과»만)
const useRes = create<{ open: Res; save: Res }>(() => ({ open: null, save: null }));
const now = () => new Date().toTimeString().slice(0, 8);
const plainSave = (s: string) => s.replace(/SLAM 실시간 지도/g, '실시간 지도').replace(/SLAM 만들기 아님/g, '새 지도를 만드는 중이 아님');

/** 서버 거부 이유(why) → 사용자가 할 일 한 줄. 모르는 이유는 서버 글 그대로 보라고만(추측 0) */
/** 이 기기 요청 결과 한 줄(r3 · 715 P2-1). sent 참이어도 «보냄» 이라 쓰지 않음 — 원문(«보내지 못함» 포함)과 모순 0. sent 거짓 = ask 호출 전 멈춤(정말 안 보냄) */
export const reqLine = (r: { ok: boolean; text: string; sent?: boolean }) => r.ok ? '요청 수락(아직 켜진 것 아님 — «지금 실행»으로 확인)'
  : r.sent ? `요청 처리 결과 · 수락 안 됨·결과 미확인 · ${r.text}(켜짐 여부는 «지금 실행»으로)` : `안 보냄 · ${r.text}`;
export function nextStep(why: string | null | undefined): string {
  const w = why || '';
  if (!w) return '';
  if (w.startsWith('로그인한 기기에서만')) return '관문 주소(https)로 로그인한 기기에서 여세요';
  if (w.startsWith('Gazebo 가 이미 켜짐')) return '지금 켜진 시뮬을 먼저 «Gazebo 끄기» → 꺼짐 확인 뒤 다시 «지도 열기»';
  if (w.startsWith('방금 요청함')) return '표시된 시간이 지난 뒤 다시 누르세요(서버의 시작 간격 120 s — 옛 평지 시작 경로와 같은 간격, 이 화면엔 평지 시작 없음 · 자동 재시도 없음)';
  if (w.includes('조종 중')) return '조종 중인 기기에서 STOP·조종권 반납 뒤 다시';
  if (w.includes('처리 중') || w.includes('진행 중')) return '진행 중인 요청이 끝날 때까지 기다리세요';
  if (w.includes('미확인') || w.includes('확인 못 함')) return '서버 상태 확인 중 — 잠시 뒤 다시(자동 재시도 없음)';
  if (w.includes('SLAM 실시간 지도가 보일 때만')) return '시뮬을 실행한 뒤 지도가 보이면 저장하세요';
  if (w.includes('저장 서비스 없음')) return '지도 시뮬이 완전히 켜진 뒤 다시(저장 서비스 대기)';
  return '위 서버 이유를 확인한 뒤 다시';
}

/** 저장 요청 때 출처(건물·층·epoch·연결 세대) → 결과 판정. 응답 ok + 다시 받은 목록에 같은 world·건물·층·버전이 있어야 «확인됨».
 *  응답 사이 epoch·층·연결이 바뀌었으면 그 출처 결과로만 따로 적고 «지금 지도 저장 성공»으로 쓰지 않음. 버전 = 서버 고정 문구 «지도 저장됨 · <버전>»(기존 reply 에 구조 칸 없음) */
export type SaveSrc = { world_id: string | null; building_id: string | null; floor_id: string | null; epoch: number | null; floor_rev: number | null; gen: number };
const CTX = ['world_id', 'building_id', 'floor_id', 'epoch', 'floor_rev'] as const;
/** 저장 응답 판정 — 요청 때 출처(req)로만. 서버가 확인한 응답 문맥(r.save)이 있으면 req 와 정확히 같아야, 연결 건물(floor_rev 있음)은 필수(늦은 다른 층 결과 성공 0) */
export function saveVerdict(req: SaveSrc, r: { ok: boolean; text: string; save?: Record<string, unknown> | null }, list: MapInfo[] | string, now: SaveSrc, t: string): NonNullable<Res> {
  const sv = r.save, svOk = !!sv && CTX.every((k) => (sv[k] ?? null) === req[k]) && typeof sv.map_version === 'string';
  if (r.ok && (sv ? !svOk : req.floor_rev != null))
    return { t, ok: false, text: `${place(req.world_id, req.floor_id)}(요청 때 지도) 결과 미확인 · 응답 문맥이 요청과 다르거나 없음 — 이번 요청 성공으로 안 씀, 목록 다시 확인`, what: `${place(req.world_id, req.floor_id)}(요청 때 지도)` };
  const ver = !r.ok ? undefined : svOk ? sv!.map_version as string : /지도 저장됨 · (\S+)/.exec(r.text || '')?.[1];
  const hit = ver && Array.isArray(list) ? list.find((m) => m.world_id === req.world_id && m.building_id === req.building_id && m.floor_id === req.floor_id && m.map_version === ver) : undefined;
  const moved = now.gen !== req.gen || now.epoch !== req.epoch || now.world_id !== req.world_id || now.floor_id !== req.floor_id || now.floor_rev !== req.floor_rev;
  const src = `${place(req.world_id, req.floor_id)}(요청 때 지도)`;
  if (!r.ok) return { t, ok: false, text: r.text || '응답 없음(결과 미확인)', what: src };
  if (!hit) return { t, ok: false, text: `${r.text} · 목록에 그 건물·층·버전 없음(목록 다시 받기)`, what: src };
  return moved ? { t, ok: false, text: `${src} 결과 · ${r.text} · 목록 확인됨 — 지금 열린 지도와 다름(지금 지도 저장으로 안 씀)`, what: src, key: mapKey(hit) }
    : { t, ok: true, text: `${r.text} · 목록 확인됨`, what: mapKey(hit), key: mapKey(hit) };
}

// ── SLAM-1 시작 확인(페이지 안 StartAsk 재사용 · native confirm 0) ──
// 확인창 = 기존 askPage/StartAsk: 비차단(status 계속 받음) · STOP 단추/Space 그대로 눌리고 누르면 창 닫힘(sendStop→cancelStart) · STOP·연 단추 피해 놓기 ·
//   자리 없음/크기·전체화면 변화/Escape/숨김·이탈(hide)/다른 확인창 열림 = 취소. 이 함수가 더하는 것: 결속 대조(열린 동안 구독 + 송신 직전 한 번 더) · 응답 전 다시 누름 0.
// 결속 = 누른 순간의 지형·층·카메라(sel) · 연결 세대·대상 · 사용 범위 · 지도 원장(used/max/이 key) · 화면(hash) · 중단 세대(startGen) · 양식·요청 수명(아래).
// r2 수명(715 R1·R2 — 이 시작 흐름의 UI 수명만 · 전역 조종 정책 변경 0):
//   양식 = 시작 상자 한 번의 장착(part 'save' 제외). 장착마다 formSeq+1 → 앞 양식이 연 «송신 전» 요청은 무효(메뉴 다시 열기 = 새 기본 선택이므로 옛 확인 무효).
//   «시뮬 ▾» 팝오버가 확인 단추 pointerdown 에 닫혀 상자가 사라지는 것(일시 소멸)만으로는 무효 아님 — 새 양식이 장착될 때·고른 값이 바뀔 때만.
//   요청 = openMapAsk 한 번(Req). 무효 사유는 요청 기록에 남아(sticky) true 로 답한 뒤에도 송신 직전에 봄. ask 호출 뒤(sent)는 무효로 바꾸지 않고 «보낸 것 0» 이라 쓰지 않음.
//   r3(715 P2-1): sent 참 = 확인 뒤 ask 를 «호출»함일 뿐 — 링크가 닫히는 중(readyState≠1, close 이벤트 전)이면 ask 가 «링크 끊김 — 보내지 못함» 으로 바로 답함. 결과 글은 «보냄» 단정 0, ask 가 준 글(서버 답 또는 이 기기의 미송신·시간 초과 글) 그대로(reqLine).
// mode·v·lt(10-18): 시작 지도(기본 slam = 옛 호출 그대로) · 저장 버전 · 그 층 저장본 목록 토큰(목록이 바뀌면 송신 전 확인 무효 — 마지막 값 자동 갈아끼우기 0)
export type MapSel = { w: string; f: string; fc: boolean; label: string; mode?: 'slam' | 'static'; v?: string | null; lt?: string };
export type MapForm = { id: number; cur: () => MapSel };   // cur = 그 양식에 지금 고른 값(렌더마다 갱신 · 상자가 사라졌으면 마지막 값)
export const MAP_ASK_OK = '시뮬 시작';
type LS = ReturnType<typeof useLink.getState>;
type Req = { form: number; dead: string; sent: boolean; owner: object };
let inflight = false;   // 확인 뒤 응답(최대 5 s)까지 — 그 사이 다시 누름은 보낸 것 0(서버 busy 칸이 오기 전 틈)
let formSeq = 0, cur: Req | null = null;   // cur = 지금 열린(송신 전·응답 대기 포함) 마지막 요청 — 이 모듈만
const kill = (r: Req | null, d: string) => { if (!r || r.sent || r.dead) return false; r.dead = d; dropAsk(r.owner); return true; };   // 송신 전 요청만 무효 + 그 주인 창 닫기(이미 답했으면 창 없음 — 기록만)
const same = (a: MapSel, b: MapSel) => a.w === b.w && a.f === b.f && a.fc === b.fc && (a.mode ?? 'slam') === (b.mode ?? 'slam') && (a.v ?? null) === (b.v ?? null) && (a.lt ?? '') === (b.lt ?? '');
const CHG = '고른 지형·층·카메라 바뀜(시작 지도·저장 목록 포함)';
/** 시작 상자 장착(새 양식) → 앞 양식의 송신 전 요청 무효. 반환 = 이 양식 id */
export function mapFormOpen(): number { kill(cur, '새 시작 양식이 열림(메뉴 다시 열기·다른 상자)'); return ++formSeq; }
/** 양식의 고른 값 변경 → 그 양식의 송신 전 요청만 무효(다른 양식·보낸 요청 그대로). 무효로 만들었으면 true */
export function mapFormChanged(id: number): boolean { return cur?.form === id ? kill(cur, CHG) : false; }
/** 반환: null = 사람이 취소(보낸 것 0 · 알림 없음) · sent 거짓 = 안 보냄(글에 이유) · sent 참 = 확인 뒤 ask 호출함(실제 WS 송신 여부는 text 원문 — «보내지 못함» 가능 · ok = 서버가 요청 수락 — 켜짐·지도 준비 아님 / 거짓 = 미송신·거부·시간 초과·결과 미확인 — 켜짐 여부 단정 0) */
export async function openMapAsk(sel: MapSel, owner: object, from?: Element | null, confirmFn?: (t: string) => boolean | Promise<boolean>, form?: MapForm): Promise<{ ok: boolean; text: string; sent: boolean } | null> {
  const s0 = useLink.getState(), m0 = s0.st?.map_start, key = `${sel.w}/${sel.f}`, no = (text: string) => ({ ok: false, text, sent: false });
  if (s0.provider !== 'simulation_gate') return no('실기 대상 — 시뮬 시작 안 함(보낸 것 0)');
  const st = sel.mode === 'static';
  if (st && !sel.v) return no('저장한 지도 버전을 고르지 않음 — 보낸 것 0');   // 버전 없는 static 송신 0(서버도 거부 — 앞에서 막음)
  if (inflight) return no('앞 시작 요청의 응답을 기다리는 중 — 보낸 것 0');
  if (!m0?.ok) return no(`시작 안 됨 · ${m0?.why || '서버 상태 없음'} — 보낸 것 0`);
  if (sel.fc && m0.follow_cam_ok !== true) return no('외부 3인칭 카메라를 이 서버가 지원하지 않음 — 보낸 것 0');
  if (m0.usage_scope !== 'user_experience' && m0.ledger?.keys.includes(key)) return no(`${sel.label} 지도 원장 사용함 — 보낸 것 0`);   // 상자 단추 조건(used)과 같은 사실 — 직접 호출도
  const lg = m0.ledger, k = { gen: s0.gen, prov: s0.provider, scope: m0.usage_scope ?? null, hash: location.hash, used: lg?.used ?? null, max: lg?.max ?? null, tok: startGen() };
  const ux = k.scope === 'user_experience';
  const why = (s: LS): string => {   // 누른 순간과 달라진 것(없으면 '') — 서버 status 로 보이는 것
    const m = s.st?.map_start;
    if (s.gen !== k.gen || s.provider !== k.prov) return '연결·대상 바뀜';
    if (!s.open || s.bad || !s.st || s.stGen !== s.gen || performance.now() - s.lastMsg > 1000) return '링크 끊김·상태 미확인';
    if (!m?.ok) return `시작 불가로 바뀜 · ${m?.why || '상태 없음'}`;
    if ((m.usage_scope ?? null) !== k.scope) return '사용 범위 바뀜';
    if (!ux && ((m.ledger?.used ?? null) !== k.used || (m.ledger?.max ?? null) !== k.max)) return '지도 원장 바뀜';
    if (!ux && m.ledger?.keys.includes(key)) return '이 지형·층 원장 사용됨';
    if (sel.fc && m.follow_cam_ok !== true) return '외부 3인칭 카메라 지원 바뀜';
    if (location.hash !== k.hash) return '화면 바뀜';
    return '';
  };
  const late = (): string => startGen() !== k.tok ? 'STOP·숨김·이탈·조종 변화로 중단'   // status 로 안 보이는 것 — 송신 직전에만
    : cur !== req ? '새 시작 확인이 열림'
    : form && formSeq !== form.id ? '새 시작 양식이 열림(메뉴 다시 열기·다른 상자)'
    : form && !same(form.cur(), sel) ? CHG : '';
  const use = ux ? '사용자 체험 — 횟수 제한 없음(동시 1개)'
    : k.scope === 'experiment' ? `지도 원장 1회 사용 (${lg ? `지금 ${lg.used}/${lg.max}` : '원장 미확인'})`
    : `사용 범위 미확인(서버가 안 알림) — 지도 원장을 1회 쓸 수 있음${lg ? ` (지금 ${lg.used}/${lg.max})` : ''}`;
  const how = st ? `저장한 지도 ${sel.v}를 그림으로 열기 — 로봇 위치를 이 지도에 맞추지 않음(위치 표시 없음) · 이어 그리기·저장 없음 · 이 지도로 자동 길찾기 없음${sel.w === 'v5_building' ? ' · 다른 층으로 가면 그 층 지도는 빈칸(자동으로 불러오지 않음)' : ''}`
    : '새 지도를 만들며 시작(기존 지도 이어 만들기는 아직 지원하지 않음 · 미리보기의 기본 도면은 예고일 뿐 저장본 복원 아님 — 실행하면 새로 그림)';
  const text = `시뮬을 실행할까요?\n· 지형·시작층: ${sel.label}\n· ${how}\n· 외부 3인칭 카메라: ${sel.fc ? '켬 — 렌더 1개 추가, 부하 미검증' : '끔'}\n· ${use}\n· STOP 잠금 상태로 시작 — 움직이려면 따로 «조종 시작»\n· 30분 뒤 자동 종료 · 자동 재시작·연장 없음\n· 이 창이 열린 동안 STOP·화면 이동·연결 변화·고른 값 변경이 생기면 취소`;
  kill(cur, '새 시작 확인이 열림');   // 앞 요청(송신 전) 무효 — askPage 도 앞 창을 false 로 닫음
  const req: Req = { form: form?.id ?? -1, dead: '', sent: false, owner }; cur = req;
  const un = useLink.subscribe((s) => { if (!req.dead && !req.sent) { const d = why(s); if (d) kill(req, d); } });
  const hc = () => { kill(req, '화면 바뀜'); };
  addEventListener('hashchange', hc);
  try {
    dropAll();
    const yes = await (confirmFn ?? ((t: string) => askPage(t, MAP_ASK_OK, owner, from)))(text);
    dropAll();
    const d = req.dead || late() || why(useLink.getState());   // 송신 직전 대조 — true 로 답한 뒤 생긴 무효(고른 값·STOP·숨김·이탈·새 양식·새 요청)도
    if (d) { req.dead = d; return no(`시작 확인 취소 · ${d} — 보낸 것 0 · 다시 누르세요`); }
    if (!yes) return null;
    if (inflight) return no('앞 시작 요청의 응답을 기다리는 중 — 보낸 것 0');
    inflight = true; req.sent = true;   // 여기서부터 ask 호출(시도 — 실제 송신은 ask 안 send 가 정함) · 뒤 STOP·이탈은 이 요청을 «보낸 것 0» 으로 바꾸지 않음
    try {
      const r = await ask('map_start', st ? { world_id: sel.w, floor_id: sel.f, mode: 'static', map_version: sel.v as string, follow_cam: sel.fc } : { world_id: sel.w, floor_id: sel.f, mode: 'slam', follow_cam: sel.fc });
      return { ok: !!r.ok, text: r.text || '응답 없음(결과 미확인)', sent: true };
    } finally { inflight = false; }
  } finally { un(); removeEventListener('hashchange', hc); if (cur === req) cur = null; }
}

/** U4-a: SLAM 지도 저장이 지금 안 되는 이유(운영 한 줄 + 다음 행동). 서버 why 의 지금 이유(끊김·층 이동·리셋·오류)를 일반 조건으로 덮지 않고,
 *  끊긴 초·서비스 경로만 원문(raw → 개발자 모드)으로. null = 저장 가능(서버 ok — 판정은 서버 그대로, 새 막음 0) */
export function saveBlock(sv: { ok: boolean; why?: string | null; busy?: boolean } | null | undefined, lvMode?: string | null): { txt: string; next: string; raw: string } | null {
  if (!sv) return { txt: '저장 상태 확인 안 됨', next: '서버 상태가 들어온 뒤 다시(자동 재시도 없음)', raw: '' };
  if (sv.ok) return null;
  const raw = sv.why || '';
  if (sv.busy) return { txt: '지도 저장 중', next: '끝날 때까지 기다리세요', raw };
  let txt = raw.replace(/ \d+(?:\.\d+)? s 끊김/, ' 끊김(오래됨)').replace('(/v2_map/save)', '') || '저장 안 됨 · 서버 이유 없음';
  if (raw === 'SLAM 실시간 지도가 보일 때만 저장' && lvMode === 'static') txt += ' · 지금은 저장한 지도를 보는 중이라 새로 저장할 지도가 없음 · 새 지도는 시뮬을 끄고 «새 지도 만들기»로 열기';
  const next = /끊김|미수신/.test(raw) ? '지도 상태가 다시 들어오면 저장(자동 재시도 없음)' : /층 이동|층 미확인|층 확정|층 지도/.test(raw) ? '층 이동이 끝나 그 층 지도가 보이면 저장'
    : /리셋/.test(raw) ? '리셋이 끝나 새 지도가 보이면 저장' : /지도 오류|실패/.test(raw) ? '오류 원문을 확인한 뒤, 지도가 다시 보이면 저장' : nextStep(raw);
  return { txt, next, raw };
}

// part(U4-a PcMap): 'open' = 지도 열기만(PC 시뮬 메뉴) · 'save' = SLAM 지도 저장만(PC 지도 화면) · 없음 = 둘 다(폰 지도·다른 화면 시뮬 메뉴 — 기존 그대로).
// pc: 고른 곳·지금 실행·열 수 있음·서버 최근(성공)·기술 원값 = 개발자 모드(data-dev) / 고른 곳 ≠ 지금 실행·막힌 이유·다음·이 기기 결과·실패는 운영에 남김
// onShowLive: 지금 실시간 보기가 아닐 때만 받음 → «실시간 지도 보기»(화면 선택만 · 시작·조종 0). onView(key): 저장 지도 보기 선택(화면만)
export function MapStartBox({ pc, part, preview = false, catalog, reloadCatalog, onSaved, onShowLive, onView }: { pc: boolean; part?: 'open' | 'save'; preview?: boolean; catalog?: MapInfo[] | string | null; reloadCatalog?: () => unknown; onSaved?: () => void; onShowLive?: () => void; onView?: (key: string) => void }) {
  const ms = useLink((x) => x.st?.map_start) || null, sv = useLink((x) => x.st?.map_save) || null, lv = useLink((x) => x.st?.live_map) || null;
  const [w, setW] = useState<W | ''>(preview ? '' : 'rooms_a'), [f, setF] = useState('f1'), own = useRef({}).current, form = useRef(0), latest = useRef<MapSel | null>(null);   // 관제에서는 직접 고르기 전 실행 불가
  // 목록 출처(10-18): 부모가 준 catalog > 같은 화면 지도 보기(useMapPick)가 받은 공유 목록(같은 연결 세대만) > 없으면 이 상자가 1회 조회. 겹친 map_list(map_busy) 0 · 자동 재시도 0
  const ready = useLink((x) => x.open && x.stGen === x.gen), g = useLink((x) => x.gen), shared = useCatalog();
  const sq = useRef<ListSeq>({ n: 0, busy: null }).current, [selfCat, setSelfCat] = useState<MapInfo[] | string | null>(null);
  const selfLoad = part !== 'save' && catalog === undefined && shared.owners === 0, loadSelf = () => loadList(sq, setSelfCat);
  useEffect(() => {
    setSelfCat(null);
    if (!selfLoad || !ready) return;
    let on = true;   // 같은 commit 에서 부모의 useMapPick 장착(owners+1)이 자식 effect 뒤에 돌므로 microtask 에서 다시 확인 — 그때도 0 일 때만 보냄
    queueMicrotask(() => { if (on && useCatalog.getState().owners === 0) loadSelf(); });
    return () => { on = false; sq.n++; };   // 늦은 결과 채택 0(loadList 최신 대조)
  }, [selfLoad, ready, g]);
  const cat = catalog !== undefined ? catalog : selfLoad ? selfCat : shared.gen === g ? shared.v : null;
  const reloadCat = catalog !== undefined ? reloadCatalog : selfLoad ? loadSelf : shared.reload ?? undefined;
  // 시작 지도: 기본 저장(root override — 0개여도 새 지도 자동 선택 0). pick = 직접(또는 1개일 때 고정한) 버전 — 목록이 바뀌어 없어지면 다른 버전으로 자동 바꾸지 않고 비움
  const [sm, setSm] = useState<'static' | 'slam'>('static'), [pick, setPick] = useState('');
  const cands = w ? savedOf(cat, w, f) : null;
  const lt = cands ? cands.map((m) => m.map_version).join(',') : typeof cat === 'string' ? `!${cat}` : '…';
  const slt = sm === 'static' ? lt : '';   // 목록 토큰은 저장 시작에만 결속(새 지도 확인창은 목록 도착으로 무효 0)
  const ver = sm !== 'static' || !cands ? null : pick ? (cands.some((m) => m.map_version === pick) ? pick : null) : cands.length === 1 ? cands[0].map_version : null;
  const gone = sm === 'static' && !!pick && !!cands && !ver;
  useEffect(() => { if (!pick && cands?.length === 1) setPick(cands[0].map_version); }, [pick, lt]);   // 1개 자동 = 그 버전에 고정(뒤에 목록이 바뀌어도 새 1개로 갈아끼우지 않음)
  const pv = useTerrainPreview(w, f, cat, preview, reloadCat, sm === 'static' ? ver ?? '' : undefined);   // S1(715): 새 지도 만들기 = 저장본 유무와 무관하게 기존 기본 도면 미리보기 관문(예고) · 저장 모드만 고른 저장본 PNG(GT 대체 0)
  const [fc, setFc] = useState(true);   // fc: 외부 3인칭 렌더(기본 켬 — 서버 래퍼가 지원할 때만 보이고 보냄)
  const { open: rOpen, save: rSave } = useRes();
  const B = pc ? 'btn' : 'lv-btn', I = pc ? 'inp' : 'lv-inp', key = `${w}/${f}`, lg = ms?.ledger, ux = ms?.usage_scope === 'user_experience';
  const used = !ux && !!lg && lg.keys.includes(key), fcOn = fc && ms?.follow_cam_ok === true;
  const can = !!w && !!ms?.ok && !used && (sm === 'slam' || !!ver) && (!preview || pv.ready);
  const verWhy = !cands ? (typeof cat === 'string' ? `지도 목록을 받지 못함 · ${cat}` : '지도 목록 읽는 중') : !cands.length ? '저장한 지도 없음 — «새 지도 만들기»를 직접 고르세요'
    : gone ? '고른 저장 지도가 지금 목록에 없음 — 다시 고르세요' : '저장한 지도 버전을 고르세요';
  const sel = `${place(w, f)} · ${sm === 'static' ? `${TASK.static} · ${ver ?? '버전 미정'}` : `${TASK.slam}(직접 조종)`}`;

  // 지금 실제로 켜진 것(서버 세션 — 고른 것과 별개)
  const ss = ms?.session as Sess, run = runLine(ss), at = runAt(ss), seen = staticSeen(ss, lv);   // seen: 저장 지도 세션의 실제 표시 확인(요청 수락·시작 중 ≠ 준비)
  const other = !!w && !!at && `${at[0]}/${at[1]}` !== `${BLD[w]}/${f}`;

  latest.current = { w, f, fc: fcOn, label: place(w, f), mode: sm, v: ver, lt: slt };   // 렌더마다 지금 고른 값 — 송신 직전 대조(r2 R2) · 상자가 일시로 사라져도 마지막 값
  useEffect(() => { if (part !== 'save') form.current = mapFormOpen(); }, []);   // r2 R1: 장착 = 새 양식 → 앞 양식이 연 송신 전 확인 무효(메뉴 다시 열기). 일시 소멸(unmount)만으로는 무효 0
  // 고른 지형·층·카메라가 바뀌면 이 양식의 송신 전 요청을 무효(true 로 답한 뒤여도 — 요청 기록에 남김). 첫 장착 땐 요청 없음
  const chg = () => { if (mapFormChanged(form.current)) useRes.setState({ open: { t: now(), ok: false, text: '고른 지형·층·카메라·시작 지도(또는 저장 목록)가 바뀌어 시작 확인을 닫음 — 보낸 것 0 · 다시 누르세요', what: sel, sent: false } }); };
  useEffect(chg, [w, f, fcOn, sm, ver, slt]);   // 서버 쪽 카메라 지원 변화(fcOn)도 · 단추는 아래 onClick 에서 동기로 먼저(렌더 전 같은 틱 확인도 무효)
  const start = async (e: React.MouseEvent<HTMLButtonElement>) => {
    if (!can) return;
    const r = await openMapAsk(latest.current!, own, e.currentTarget, undefined, { id: form.current, cur: () => latest.current! });   // 연 단추 = 여는 click 안에서 동기로(StartAsk 회피 r0)
    if (r) useRes.setState({ open: { t: now(), ok: r.ok, text: r.text, what: sel, sent: r.sent } });
  };
  const src = (): SaveSrc => { const s = useLink.getState(), l = s.st?.live_map; return { world_id: l?.world_id ?? null, building_id: l?.building_id ?? null, floor_id: l?.floor_id ?? null, epoch: l?.epoch ?? null, floor_rev: l?.floor_rev ?? null, gen: s.gen }; };
  const save = async () => {
    if (!sv?.ok) return;
    const req = src();                           // 요청 때 출처 캡처(응답 뒤 현재 값으로 판정하지 않음)
    const r = await ask('map_save', {}, 12000);   // 서버 제한 10 s + 여유. 넘으면 «결과 미확인»(늦게 저장될 수 있음) — 자동 재요청 0
    const v = await listMaps(); onSaved?.();   // 화면을 떠났어도 결과는 전역(useRes)에 출처와 함께 남음
    useRes.setState({ save: saveVerdict(req, r, v, src(), now()) });
  };

  const row = { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' } as const;
  const kv = (a: string, b: React.ReactNode, c?: string, dev?: boolean) => <span data-dev={pc && dev ? '' : undefined} style={{ display: 'flex', gap: 6 }}><span className="lbl" style={{ flex: '0 0 74px' }}>{a}</span><span style={c ? { color: `var(--${c})` } : undefined}>{b}</span></span>;
  const seg = (on: boolean) => ({ 'aria-pressed': on, className: `${B}${on ? ' pri' : ''}`, type: 'button' as const });
  const blk = pc ? saveBlock(sv, lv?.mode) : null;
  return <div id={part === 'save' ? undefined : 'fh-mapopen'} style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 }}>
    {part !== 'save' && <>
    {!pc && <b style={{ fontSize: 13 }}>시뮬 실행</b>}
    <span className="lbl">지형을 고르고 시뮬을 실행하세요. 실행 전 한 번 더 확인합니다.</span>
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span className="lbl">시작 지형</span>
      <select aria-label="시작 지형" className={I} value={w} style={{ width: '100%', minWidth: 0, minHeight: 40, padding: '0 10px', boxSizing: 'border-box', border: '1px solid var(--line2)', borderRadius: 6, background: 'var(--panel2)', color: 'inherit', font: 'inherit' }}
        onChange={(e) => { chg(); const next = e.target.value as W; setW(next); setF(WF[next][0]); setSm('static'); setPick(''); }}>
        <option value="" disabled>지형을 고르세요</option>
        {PLACES.map((p) => <option key={p.w} value={p.w}>{place(p.w, WF[p.w][0]).split(' · ')[0]}</option>)}
      </select>
    </label>
    {w && <span className="lbl">{PLACES.find((p) => p.w === w)!.sub}</span>}
    {w && WF[w].length > 1 && <span role="group" aria-label="시작층(2층 건물 · 열 때만)" style={row}>
      <span className="lbl">시작층</span>
      {WF[w].map((k) => <button key={k} {...seg(f === k)} onClick={() => { chg(); setF(k); setSm('static'); setPick(''); }}>{`${FLOOR[k as keyof typeof FLOOR]}(${k})`}</button>)}</span>}
    {w && <span role="group" aria-label="시작 지도" style={row}>
      <span className="lbl">시작 지도</span>
      <button {...seg(sm === 'static')} onClick={() => { chg(); setSm('static'); }}>저장한 지도로 열기</button>
      <button {...seg(sm === 'slam')} onClick={() => { chg(); setSm('slam'); }}>새 지도 만들기</button></span>}
    {w && sm === 'static' && <>
      {cands && (cands.length > 1 || gone) ? <select aria-label="저장한 지도 버전" className={I} value={ver ?? ''} style={{ minHeight: 40, padding: '0 10px', border: '1px solid var(--line2)', borderRadius: 6, background: 'var(--panel2)', color: 'inherit', font: 'inherit' }}
          onChange={(e) => { chg(); setPick(e.target.value); }}>
          <option value="" disabled>고르세요</option>
          {cands.map((m) => <option key={m.map_version} value={m.map_version}>{m.map_version}</option>)}</select>
        : cands?.length === 1 ? <span className="lbl">{`저장한 지도 · ${place(w, f)} · ${cands[0].map_version}`}</span> : null}
      {!ver && <span role="status" className="lbl" style={cands && !cands.length ? undefined : { color: 'var(--warn)' }}>{cands && !cands.length
        ? '저장한 지도 없음 · «새 지도 만들기»를 직접 고르세요(다른 지형·층 지도나 기본 도면으로 대신 열지 않음)' : gone ? `${verWhy}(다른 버전으로 자동으로 바꾸지 않음)` : cands ? verWhy : `${verWhy}${typeof cat === 'string' ? '' : '…'}`}</span>}
      {typeof cat === 'string' && reloadCat && <button type="button" className={B} onClick={() => { reloadCat(); }}>지도 목록 다시 읽기</button>}
      <span className="lbl">{`저장한 지도는 그림으로만 보입니다 · 로봇 위치를 이 지도에 맞추지 않아 위치 표시 없음 · 이어 그리기·저장 안 됨 · 이 지도로 자동 길찾기 없음${w === 'v5_building' ? ' · 다른 층으로 가면 그 층 지도는 빈칸(자동으로 불러오지 않음)' : ''}`}</span>
    </>}
    {preview && <TerrainPreview w={w} f={f} preview={pv} />}
    {ms?.follow_cam_ok === true && <label style={{ ...row, gap: 4 }}><input type="checkbox" checked={fc} onChange={(e) => { chg(); setFc(e.target.checked); }} />
      외부 시점 카메라<Help label="외부 시점 카메라 설명">로봇 바깥에서 보는 카메라를 추가합니다. 렌더 작업이 하나 늘며 성능 영향은 확인되지 않았습니다.</Help></label>}
    <button type="button" className={`${B} pri`} disabled={!can} onClick={start}
      title={!w ? '먼저 지형을 고르세요' : sm === 'static' && !ver ? verWhy : preview && !pv.ready ? '2D 미리보기를 확인한 뒤 실행할 수 있습니다' : ms?.why || undefined}>시뮬 실행</button>
    {used && <span role="status" className="lbl">이 지형은 시작 횟수를 이미 사용했습니다.</span>}
    <div role="status" hidden={preview && !!ms?.ok && !other && !rOpen} style={{ display: 'flex', flexDirection: 'column', gap: 3, padding: '6px 8px', border: '1px solid var(--line2)', borderRadius: 6 }}>
      {kv('고른 곳', sel, undefined, true)}
      {kv('지금 실행', run, other ? 'warn' : undefined, true)}
      {other && kv('', pc ? `고른 곳 ≠ 지금 실행(${run}) — 바꾸려면 시뮬 끄고 새로 열기` : '고른 곳과 지금 실행 중인 곳이 다릅니다 — 바꾸려면 끄고 새로 열기', 'warn')}
      {kv('열 수 있나', !ms ? '서버 상태 없음(연결 확인)' : ms.ok ? '열 수 있음' : `안 됨 · ${ms.why}`, ms?.ok ? 'ok' : 'warn', !!ms?.ok)}
      {ms && !ms.ok && kv('다음', nextStep(ms.why))}
      {rOpen && kv('이 기기 요청', `${rOpen.t} · ${rOpen.what} → ${reqLine(rOpen)}`, rOpen.ok ? 'ok' : 'warn')}   {/* r3: 요청 처리 결과/안 보냄 구분 · «보냄» 단정 0 · 시간 초과·거부를 «안 켜짐»으로 단정 0 */}
      {rOpen && !rOpen.ok && kv('다음', nextStep(rOpen.text))}
      {ms?.last && kv('서버 최근', `${ms.last.t} · ${ms.last.text}`, ms.last.st === 'ok' ? 'ok' : 'bad', ms.last.st === 'ok')}
      <details data-dev={pc ? '' : undefined}><summary className="lbl">상태 상세(기술 원값)</summary>
        <span className="lbl" style={{ wordBreak: 'break-all' }}>{`고른 것 world_id=${w} floor_id=${f} mode=${sm}${sm === 'static' ? ` map_version=${ver ?? '-'}` : ''} · 실행 runner=${ss?.runner ?? '-'} world_id=${ss?.world_id ?? '-'} floor_id=${ss?.floor_id ?? '-'} map_mode=${ss?.map_mode ?? '-'} result=${ss?.result ?? '-'} · 실시간 지도 st=${lv?.st ?? '-'} epoch=${lv?.epoch ?? '-'} topic=/v2_map/map`}</span></details>
    </div>
    {seen === 'saved' && <span role="status" className="lbl" style={{ color: 'var(--warn)' }}>
      {`지금 실행 중 = 저장한 지도 보기(위치 없음) · 로봇 위치를 지도에 맞추지 않음 · 이어 그리기·저장 없음 · 자동 길찾기 없음${ss!.world_id === 'v5_building' ? ' · 다른 층은 빈칸' : ''}`}</span>}   {/* 출처 = 서버 session + live_map 수신 확인(숨김 상자 밖 — 한계 숨김 0) */}
    {seen === 'wait' && <span role="status" className="lbl">{`${ss!.result === 'starting' ? '저장 지도 시작 처리 중' : '저장 지도 세션 실행 중'} · 지도 표시·출처 확인 전`}</span>}   {/* P2-3(715): 시작 중·미수신·다른 층은 사실만 — 저장 그림 보기로 단정 0 · GT static 은 SLAM 그림 한계 줄 0 */}
    {onShowLive && (rOpen?.ok || (lv && lv.st !== 'off')) && <button type="button" className={B} onClick={onShowLive}>현재 열린 지도 보기(화면만)</button>}
    <span className="lbl">동시에 하나만 실행 · 30분 뒤 자동 종료</span>
    </>}

    {part !== 'open' && <>
    <b style={{ fontSize: 13, marginTop: part === 'save' ? 0 : 6 }}>만든 지도 보관</b>
    {pc ? <>   {/* U4-a: 막히면 회색(aria-disabled) + 누르면 지금 이유 · 다음(전송 0, save() 의 sv.ok 관문 그대로). 일반 조건 글로 지금 이유를 덮지 않음 */}
      {!blk && <span className="lbl">{lv?.mode === 'slam' && lv.st === 'ok' ? `${place(lv.world_id, lv.floor_id)}에 새 버전으로 저장(버전 이름 = 저장 시각·epoch, 서버가 정함 · 덮어쓰기 없음)` : '저장할 수 있음(서버 확인)'}</span>}
      <button type="button" {...(blk ? { ...whyProps(`${plainSave(blk.txt)} — ${blk.next}`), className: `${B} lv-why` } : { className: B, onClick: save })}>{sv?.busy ? '지도 저장 중…' : '지도 저장'}</button>
      {blk && <>{kv('저장 안 됨', plainSave(blk.txt), 'warn')}{kv('다음', blk.next)}{blk.raw && blk.raw !== blk.txt && kv('원문', blk.raw, undefined, true)}</>}
    </> : <>
    <span className="lbl">{lv?.mode === 'slam' && lv.st === 'ok' ? `${place(lv.world_id, lv.floor_id)}에 새 버전으로 저장(버전 이름 = 저장 시각·epoch, 서버가 정함 · 덮어쓰기 없음)` : '시뮬을 실행한 뒤 만들어진 지도를 저장할 수 있습니다'}</span>
    <button type="button" className={B} disabled={!sv?.ok} onClick={save}>{sv?.busy ? '지도 저장 중…' : '지도 저장'}</button>
    {sv && !sv.ok && !sv.busy && <>{kv('저장 안 됨', plainSave(sv.why || ''), 'warn')}{kv('다음', nextStep(sv.why))}</>}
    </>}
    {rSave && kv('이 기기 저장', `${rSave.t} · ${rSave.text}`, rSave.ok ? 'ok' : 'bad')}
    {rSave?.key && onView && <button type="button" className={B} onClick={() => onView(rSave.key!)}>{`저장한 버전 보기(화면만)${rSave.ok ? '' : ' · 요청 때 지도'}`}</button>}
    {lv?.last_save && kv('서버 최근', `${lv.last_save.ok ? '성공' : '실패'} · ${lv.last_save.map_version || '버전 없음'}${lv.last_save.reason ? ` · ${lv.last_save.reason}` : ''}`)}
    {part !== 'save' && <span className="lbl">저장 지도는 높이가 없는 2D 점유 격자(occupancy)입니다 — 계단·벽 높이 정보 없음.</span>}   {/* save(PcMap): 지도 «?» 설명으로 옮김 */}
    </>}
  </div>;
}

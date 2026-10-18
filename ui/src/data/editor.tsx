// 문서 편집기 — web/live.js editor() 와 같은 규칙: 초안(d)·기준 판(rev). 400·409·404·저장 실패 어느 경우에도 초안은 지우지 않는다.
// gen: 다른 문서를 열 때마다 +1 — 옛 저장 응답이 새로 연 편집기를 덮지 않게.
import { useEffect, useReducer, useRef, useSyncExternalStore, type ReactNode } from 'react';
import type { DocEnvelope, DocWrite } from '@contracts';
import { docById, saveDoc, type Docs, type SaveRes } from './shared';
import { fmtT } from './fmt';
import { toast } from '../app/shell';
import { ctx, drafts } from './scratch';
import { dropAsk } from './link';
import * as PD from './persistDraft';

type Kind = DocEnvelope['kind'];
export type Editor<T> = {
  kind: Kind; id: string | null; rev: number | null; d: T | null; dirty: boolean; busy: boolean; gen: number; msg: ReactNode;
  // 10-19 ROOT 10: 이어 편집 안내는 화면이 그림(PcPlan 맨 위) — 어디서 온 초안인가(tab = 이 탭 메모리 · pd = 브라우저 보관본, at = 보관 시각 · API 가 주면) · load() 때 지움
  restored: { src: 'tab' | 'pd'; at?: number } | null;
  pdNote: string;   // 영속 초안 한 줄(PD note 또는 보관 실패) — 빈 글 = 표시 0
  load(doc: { id: string; rev: number; doc: unknown } | null | undefined, init?: T): void;
  save(rev?: number | null): Promise<(SaveRes & { other?: boolean }) | null>;
  del(): Promise<(SaveRes & { same: boolean }) | null>;   // same: write() 와 같은 뜻 — 응답 때 같은 대상·같은 초안일 때만 화면 정리
  stale(D: Docs): DocEnvelope | null;
  touch(): void;   // 화면 다시 그리기
  write(m: DocWrite): Promise<{ r: SaveRes; same: boolean } | null>;
};

function make<T>(kind: Kind, rebuild: () => void): Editor<T> {
  const say = (t: string, bad?: boolean) => { E.msg = <p className="lv-note" style={bad ? { color: 'var(--bad)' } : undefined}>{t}</p>; rebuild(); };
  const box = (t: string, ...b: ReactNode[]) => { E.msg = <div className="lv-warnbox" role="alert"><span>{t}</span><div className="lv-row">{b}</div></div>; rebuild(); };
  const E: Editor<T> = {
    kind, id: null, rev: null, d: null, dirty: false, busy: false, gen: 0, msg: null, restored: null, pdNote: '',
    load(doc, init) { E.gen++; dropAsk(E); E.id = doc ? doc.id : null; E.rev = doc ? doc.rev : null; E.d = structuredClone((doc ? doc.doc : init) ?? null) as T | null; E.dirty = false; E.msg = null; E.restored = null; rebuild(); },
    async save(rev = E.rev) {
      if (E.busy) return null; E.busy = true; say('저장 중…');
      const sent = JSON.stringify(E.d), gen = E.gen;   // 보낸 판 그대로 — 저장 중 입력은 E.d 에만 쌓임
      const r = await saveDoc({ op: 'put', kind, id: E.id, rev, doc: JSON.parse(sent) }); E.busy = false;
      if (gen !== E.gen) { toast(r.ok ? `앞 문서 저장됨 · 판 ${r.rev}` : `앞 문서 저장 안 됨 · ${r.error}`); rebuild(); return { ...r, ok: false, code: 0, error: '', other: true } as SaveRes & { other: true }; }
      if (r.ok) {
        E.id = r.id; E.rev = r.rev; E.dirty = JSON.stringify(E.d) !== sent;   // 실제로 저장된 판과 같을 때만 깨끗함
        say(E.dirty ? `판 ${r.rev} 저장됨 · 저장 중에 고친 내용은 아직 저장 안 됨` : `저장됨 · 판 ${r.rev} · 모든 기기 공유`); return r;
      }
      if (r.code === 409 && r.cur) {
        const c = r.cur;
        box(`다른 기기가 먼저 고침 · ${c.by} · ${fmtT(c.at)} (판 ${c.rev}). 내 초안은 화면에 그대로 있습니다.`,
          <button key="a" type="button" className="lv-btn" onClick={() => E.load(c)}>최신 판 불러오기(내 초안 버림)</button>,
          <button key="b" type="button" className="lv-btn pri" onClick={() => { E.id = c.id; E.save(c.rev); }}>내 초안을 최신 판 위에 저장</button>);
      } else if (r.code === 404) {
        box('다른 기기가 이 문서를 지웠습니다. 내 초안은 화면에 그대로 있습니다.',
          <button key="a" type="button" className="lv-btn pri" onClick={() => { E.id = null; E.rev = null; E.save(); }}>새 문서로 저장</button>);
      } else say(`저장 안 됨 · ${r.error} — 초안은 화면에 그대로`, true);
      return r;
    },
    async del() {
      if (E.busy) { toast('저장 중 — 잠시 뒤 다시 누르세요'); return null; }   // 지우는 중 두 번째 지우기·저장 막음
      if (!E.id || !confirm('지울까요? 모든 기기에서 사라집니다.')) return null;
      E.busy = true; rebuild(); const g = E.gen, snap = JSON.stringify(E.d);
      const r = await saveDoc({ op: 'del', id: E.id, rev: E.rev! }); E.busy = false;
      const same = g === E.gen && snap === JSON.stringify(E.d);
      if (!r.ok && same) say(r.code === 409 ? '다른 기기가 먼저 고침 — 최신 판을 확인한 뒤 다시 지우세요' : `지우지 못함 · ${r.error}`, true);
      else { if (!same) toast(r.ok ? '앞 문서 지움' : `앞 문서 안 지워짐 · ${r.error}`); rebuild(); }
      return { ...r, same };
    },
    // 더 새 판만(방금 저장해 서버 목록이 아직 옛 판일 때 되돌리지 않음)
    stale(D) { const c = !E.busy && E.id && D.rev != null ? docById(D, E.id) : null; return c && E.rev != null && c.rev > E.rev ? c : null; },
    touch: () => rebuild(),
    // 편집 중인 문서 밖 쓰기(새로 만들기·복제·지우기·진행 기록 시작) — 공용 계약:
    // 쓰기는 한 번에 하나(busy 를 save 와 같이 씀, 겹치면 null). same = 응답이 왔을 때 편집 대상(gen)·초안이 보낸 때와 같음.
    // 호출하는 화면은 same 일 때만 화면 이동·정리를 하고, 아니면 서버 결과만 알린다(그사이 연 문서·고친 초안은 그대로).
    async write(m) {
      if (E.busy) { toast('저장 중 — 잠시 뒤 다시 누르세요'); return null; }
      E.busy = true; rebuild(); const g = E.gen, snap = JSON.stringify(E.d);
      const r = await saveDoc(m); E.busy = false; rebuild();
      return { r, same: g === E.gen && snap === JSON.stringify(E.d) };
    },
  };
  return E;
}

/** 화면 하나에 편집기 하나. 객체는 화면이 사는 동안 같은 것(ref) — 값이 바뀌면 touch()/load()/save() 가 다시 그린다.
 *  화면을 떠나면(unmount) gen 을 올려, 늦게 온 save/write 응답은 서버 결과 알림만 하고 이동·초안 정리는 하지 않는다.
 *  StrictMode 의 setup→cleanup→setup 에서도 gen 이 오를 뿐 다시 쓸 수 있다(진행 중 요청이 없을 때라 영향 없음).
 *  keep(R02): 이름이 있으면 저장 안 한 초안(dirty)을 화면을 떠날 때 탭 메모리(scratch.drafts, 키 kind:keep)에 두고, 다시 열 때 이어서 편집.
 *   보관본은 «화면 밖에 있는 동안»만 있다 — 저장 실패·409·404·다른 문서 주소에서도 초안은 그대로(편집기 규칙),
 *   깨끗한 상태(저장 성공·불러오기·버리기)로 떠나면 보관 0. 로그아웃·관문 변경·세션 끝(dropScratch)은 문맥 번호로 버림. */
export const PD_FAIL = '이 브라우저에 초안을 보관하지 못합니다 · 탭을 닫으면 사라짐 · 저장하려면 «임무 만들기/변경 저장»';
export function useEditor<T>(kind: Kind, keep?: string): Editor<T> {
  const [, bump] = useReducer((n: number) => n + 1, 0), r = useRef<Editor<T>>(), at = useRef(ctx.n);
  // ---- 10-19 ROOT 10 영속 초안(RL persistDraft API — 이 파일은 부르기만) · opt-in 키(PD_KEYS)만 ----
  // pg = 연 때의 PD gen(= put/remove atGen) · g0 = 연 때의 문서 세대 · mine = 이 편집기가 보관본을 채택·보관함(깨끗해지면 지움, 남의 보관본은 안 지움)
  const k = `${kind}:${keep}`, pk = keep && (PD.PD_KEYS as readonly string[]).includes(k) ? (k as PD.PdKey) : null;
  const pd = useSyncExternalStore(PD.subscribe, PD.snapshot, PD.snapshot), pg = useRef(pd.gen), g0 = useRef(0), mine = useRef(false);
  const tm = useRef<ReturnType<typeof setTimeout>>(), last = useRef(''), fail = useRef(false);
  const adopt = (E: Editor<T>, h: { id: string | null; rev: number | null; d: unknown; at?: unknown }, src: 'tab' | 'pd') => {
    E.id = h.id; E.rev = h.rev; E.d = structuredClone(h.d) as T; E.dirty = true;   // id/rev 그대로 → 저장은 기존 409·404·CAS
    E.restored = { src, ...(typeof h.at === 'number' ? { at: h.at } : {}) };
  };
  if (!r.current) {
    const E = r.current = make<T>(kind, bump), h = keep ? drafts.get(k) : undefined;
    if (h) { drafts.delete(k); adopt(E, h, 'tab'); mine.current = !!pk; }   // 탭 메모리가 우선(같은 초안의 브라우저 사본도 이 편집기 몫)
    else if (pk) { const p = PD.get(pk); if (p) { adopt(E, p, 'pd'); mine.current = true; } }   // ready 아니면 null(아래 늦은 ready)
    g0.current = E.gen;
  }
  // 늦은 ready(앱 시작 check 응답): 연 뒤 아무것도 안 고치고 다른 문서도 안 연 새 편집기 + 같은 문맥(ctx·PD gen)일 때만 1회 채택 — 사용자 편집·연 문서 덮기 0
  // 10-19 ROOT(PD-R3 통합 · U10): 화면을 떠나지 않은 채 문맥 폐기(외부 PD gen 변화 = 다른 탭 폐기·dropScratch·로그인 교체) → 지금 편집기도 폐기.
  // 옛 문맥 E.d·id·rev·안내를 비움(E.load(null) = gen++ → 늦은 save 응답은 기존 gen 대조로 «앞 문서» 알림만 · 화면 되살림 0) · 화면은 E.d 없음 → 새 빈 계획.
  // 새 문맥(pg·at)으로 다시 묶음 — 이후 편집은 새 gen 으로만 보관. authEnd 는 route 이동(화면 해제)이라 여기 아님
  useEffect(() => {
    const E = r.current!;
    if (!pk || (pd.gen === pg.current && at.current === ctx.n)) return;
    clearTimeout(tm.current); tm.current = undefined;
    pg.current = pd.gen; at.current = ctx.n; mine.current = false; last.current = ''; fail.current = false;
    E.load(null); g0.current = E.gen;   // load 가 다시 그림 · 이 뒤 늦은 ready 채택은 아래 효과의 같은 조건(새 문맥·안 고친 새 편집기)
  }, [pd.gen]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const E = r.current!;
    if (!pk || pd.status !== 'ready' || pd.gen !== pg.current || at.current !== ctx.n || E.gen !== g0.current || E.dirty || E.id || mine.current) return;
    const p = PD.get(pk); if (!p) return;
    adopt(E, p, 'pd'); mine.current = true; bump();
  }, [pd.status, pd.gen]);   // eslint-disable-line react-hooks/exhaustive-deps
  // 보관: dirty = put(atGen) · 깨끗 = mine 일 때만 remove(atGen). 같은 값 다시 쓰기 0 · 300 ms 안 묶음(다시 그리기가 잦아도 늦어지지 않게 «첫 변화 뒤 300 ms»)
  const sync = () => {
    const E = r.current!; if (!pk || at.current !== ctx.n) return;   // 폐기된 문맥 = 쓰기·지우기 0(put/remove 도 atGen 으로 한 번 더 막음)
    const sig = E.dirty && E.d ? JSON.stringify([E.id, E.rev, E.d]) : '';
    if (sig === last.current) return;
    // ROOT(10-19): 실패한 쓰기·지우기는 «보낸 것»으로 치지 않음 — last 는 성공(또는 할 일 없음)일 때만 확정.
    // whoami 대기(ready 전) 중 편집 → put false → ready 로 바뀌면 다시 그려질 때(useSyncExternalStore) 같은 sig 를 다시 넣음(dedupe 영구 고착 0)
    let f = false, done = true;
    if (sig) { const ok = PD.put(pk, { id: E.id, rev: E.rev, d: E.d }, pg.current); if (ok) mine.current = true; else { done = false; f = PD.snapshot().status === 'ready' && PD.snapshot().gen === pg.current; } }
    else if (mine.current) { if (PD.remove(pk, pg.current)) mine.current = false; else done = false; }
    if (done) last.current = sig;
    if (f !== fail.current) { fail.current = f; bump(); }
  };
  useEffect(() => { if (pk && !tm.current) tm.current = setTimeout(() => { tm.current = undefined; sync(); }, 300); });
  r.current.pdNote = pk ? pd.note || (fail.current ? PD_FAIL : '') : '';
  // 10-19 ROOT G2 영속 닫기: 마지막 편집 직후 새로고침·탭 닫기는 React cleanup 이 안 돌 수 있음 → opt-in 키(pk)일 때만 pagehide·beforeunload 에서 같은 sync() 를 동기로 1회.
  // 가드(문맥 at·PD atGen·dedupe)는 sync 그대로 → 폐기된 문맥 = 쓰기 0 · 서버 쓰기·자동 check 0 · 화면 해제 때 리스너 제거
  useEffect(() => {
    if (!pk) return;
    const f = () => { clearTimeout(tm.current); tm.current = undefined; sync(); };
    addEventListener('pagehide', f); addEventListener('beforeunload', f);
    return () => { removeEventListener('pagehide', f); removeEventListener('beforeunload', f); };
  }, [pk]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (keep) drafts.delete(`${kind}:${keep}`);   // 화면에 있는 동안 보관본 0(StrictMode 의 cleanup→setup 에서도 남지 않게)
    return () => {
      const E = r.current!; clearTimeout(tm.current); tm.current = undefined; sync();   // 떠날 때 마지막 값 1회(같은 문맥일 때만)
      E.gen++; dropAsk(E);
      if (keep && E.dirty && E.d && at.current === ctx.n) drafts.set(`${kind}:${keep}`, { id: E.id, rev: E.rev, d: structuredClone(E.d) });
    };
  }, [kind, keep]);
  return r.current;
}

// 문서 편집기 — web/live.js editor() 와 같은 규칙: 초안(d)·기준 판(rev). 400·409·404·저장 실패 어느 경우에도 초안은 지우지 않는다.
// gen: 다른 문서를 열 때마다 +1 — 옛 저장 응답이 새로 연 편집기를 덮지 않게.
import { useEffect, useReducer, useRef, type ReactNode } from 'react';
import type { DocEnvelope, DocWrite } from '@contracts';
import { docById, saveDoc, type Docs, type SaveRes } from './shared';
import { fmtT } from './fmt';
import { toast } from '../app/shell';

type Kind = DocEnvelope['kind'];
export type Editor<T> = {
  kind: Kind; id: string | null; rev: number | null; d: T | null; dirty: boolean; busy: boolean; gen: number; msg: ReactNode;
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
    kind, id: null, rev: null, d: null, dirty: false, busy: false, gen: 0, msg: null,
    load(doc, init) { E.gen++; E.id = doc ? doc.id : null; E.rev = doc ? doc.rev : null; E.d = structuredClone((doc ? doc.doc : init) ?? null) as T | null; E.dirty = false; E.msg = null; rebuild(); },
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
 *  StrictMode 의 setup→cleanup→setup 에서도 gen 이 오를 뿐 다시 쓸 수 있다(진행 중 요청이 없을 때라 영향 없음). */
export function useEditor<T>(kind: Kind): Editor<T> {
  const [, bump] = useReducer((n: number) => n + 1, 0), r = useRef<Editor<T>>();
  if (!r.current) r.current = make<T>(kind, bump);
  useEffect(() => () => { r.current!.gen++; }, []);
  return r.current;
}

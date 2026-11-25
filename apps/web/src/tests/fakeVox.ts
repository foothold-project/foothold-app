// 시험용 가짜 서버 3D 칸 저장(apps/server/SLAM-CONTRACT.md «Durable live voxel recovery»): agent 보고(voxels 증분)를 판마다 쌓고
// GET …/voxels?revision&since&cursor 쪽을 돌려준다. 칸마다 마지막 seq·있음/지움, reset·새 판이면 비움, since=0 은 있는 칸만, 그 밖은 since 뒤 바뀐 칸.
import { ApiFail } from '../api';
import type { MappingVoxelPage, MappingVoxels } from '../../../contracts/ts';

type C = [number, number, number];
export class FakeVox {
  rev = 0; seq = 0; resetSeq = 0; last = -1; cells = new Map<string, { cell: C; seq: number; on: boolean }>();
  constructor(readonly sid: string, readonly size = 512) {}
  /** agent 보고 하나 — 이미 받은 seq 는 무시, 새 판이면 옛 판을 버림 */
  report(v: MappingVoxels) {
    if (v.revision !== this.rev) { this.rev = v.revision; this.seq = this.resetSeq = 0; this.last = -1; this.cells.clear(); }
    if (v.seq <= this.last) return;
    if (v.reset) { this.cells.clear(); this.resetSeq = v.seq; }
    for (const c of v.removed ?? []) if (this.cells.get(c.join())?.on) this.cells.set(c.join(), { cell: c, seq: v.seq, on: false });
    for (const c of v.added ?? []) if (!this.cells.get(c.join())?.on) this.cells.set(c.join(), { cell: c, seq: v.seq, on: true });
    this.seq = this.last = v.seq;
  }
  /** 한 쪽 — 맞지 않으면 계약 오류(ApiFail) */
  page(revision: number, since: number, cursor: string | null): MappingVoxelPage {
    if (revision !== this.rev) throw new ApiFail(409, 'MAPPING_REVISION_CONFLICT', '지도 판이 바뀌었습니다.', true);
    if (since > this.seq) throw new ApiFail(409, 'MAPPING_VOXEL_SEQUENCE_CONFLICT', '순번이 맞지 않습니다.', true);
    const reset = since === 0 || since < this.resetSeq, at = cursor == null ? 0 : Number(cursor);
    const all = [...this.cells.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, v]) => v).filter((v) => (reset ? v.on : v.seq > since));
    const part = all.slice(at, at + this.size), more = at + this.size < all.length;
    return { session_id: this.sid, revision: this.rev, seq: this.seq, reset, reset_seq: this.resetSeq, resolution: 0.05, frame_id: this.rev ? 'map' : null,
      added: part.filter((v) => v.on).map((v) => ({ cell: v.cell, seq: v.seq })), removed: part.filter((v) => !v.on).map((v) => ({ cell: v.cell, seq: v.seq })),
      next_cursor: more ? String(at + this.size) : null };
  }
  /** fetch 가짜 서버(mapmake 시험) 응답 모양 */
  reply(q: URLSearchParams) {
    try { return { status: 200, body: this.page(Number(q.get('revision')), Number(q.get('since') ?? 0), q.get('cursor')) }; }
    catch (e) { const f = e as ApiFail; return { status: f.status, body: { error: { code: f.code, message: f.message, detail: {} } } }; }
  }
}

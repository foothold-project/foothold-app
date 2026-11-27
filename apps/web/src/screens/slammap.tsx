// 지도 만들기 그림(RB-SLAM-WEB2 11-25, 계약 apps/server/SLAM-CONTRACT.md): Jetson 이 계산해 보낸 5 cm 칸을 받은 대로 놓기만 한다 — 브라우저 점군 누적·격자 계산 없음.
// 2D = 서버 tiles(64×64칸 조각) — cursor 를 끝까지 따라가고, 다음 번은 첫 쪽 update_seq 이후 바뀐 조각만. 판(revision)이 바뀌면(409 포함) 비우고 처음부터.
// 3D = 서버 voxels API(판·since·cursor, 11-25 RB-SLAM-WEB4)로 빠짐없이 — 진행 자료의 마지막 증분은 «새로 왔음» 신호로만. lidar3d «상자» 보기로. 로봇 = 진행 자료 odom.
// 저장된 지도 = bundle 의 voxels(int32 LE x·y·z)·grid(칸마다 1바이트)를 같은 그리기로. 그림만 — 명령 0.
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { MappingGridTile, MappingOdom, MappingProgress, MappingVoxelPage } from '../../../contracts/ts';
import { ApiFail, api } from '../api';
import type { DriveFeed, Pose } from '../drivemedia';
import { Lidar3D } from '../lidar3d';
import { COL, OccLegend, RGB } from '../occmap';
import { QEmpty } from '../quad';

/** 칸(m) · 조각 한 변 칸 수 */
export const RES = 0.05, TILE = 64;
/** 2D 한 장: 왼쪽 아래 (x0,y0) m, w×h 칸, 아래 줄부터 행 우선 0 모름·1 빈 곳·2 벽. key·seq = 그림 캐시(같은 key 의 seq 가 바뀔 때만 다시 칠함) */
export type Patch = { key: string; seq: number; x0: number; y0: number; w: number; h: number; cells: ArrayLike<number> };
/** 그릴 것: 3D 칸 가운데(xyz, n 개, ver = 3D·로봇이 바뀔 때마다)·2D 조각(tver = 바뀔 때마다)·로봇. gap = 서버가 이 세션 3D 를 처음부터 줄 수 없음(MAPPING_VOXELS_RESET_REQUIRED).
 *  sid·rev·frame = 지금 들어 있는 그림의 세션·판·기준(진행 중 그림만 — 겹침은 이 값이 미리보기와 같을 때만, RV-519) */
export type SlamPic = { xyz: Float32Array; n: number; ver: number; patches: Patch[]; tver: number; pose: Pose | null; gap: boolean; sid?: string; rev?: number; frame?: string | null };
const blank = (): SlamPic => ({ xyz: new Float32Array(0), n: 0, ver: 0, patches: [], tver: 0, pose: null, gap: false });
const poseOf = (o?: MappingOdom | null): Pose | null => (o ? { x: o.x, y: o.y, z: o.z, yaw: o.yaw } : null);
/** key 에 세션·판을 넣음 — 판이 바뀌면 같은 좌표·tile_seq 여도 그림 캐시를 다시 칠함(RV-485) */
const tilePatch = (sid: string) => (t: MappingGridTile): Patch => ({ key: `${sid}/${t.revision}/${t.x},${t.y}`, seq: t.tile_seq, x0: t.x * TILE * RES, y0: t.y * TILE * RES, w: TILE, h: TILE, cells: t.cells });

/** 지금 있는 3D 칸만(RV-490: 지운 칸은 빼고 보관하지 않음 — 크기 ≤ 점유 칸). 자리 i = keys[i]·seq[i]·xyz[3i..3i+2](칸 가운데 m).
 *  지우면 끝 자리를 그 자리로 옮김 — 그릴 때 전체를 다시 만들지 않는다. seq = 칸마다 마지막으로 바뀐 seq(같거나 더 새 것만 덮음) */
export class VoxSet {
  idx = new Map<string, number>(); keys: string[] = []; seq: number[] = []; xyz = new Float32Array(0);
  get n() { return this.keys.length; }
  clear() { this.idx.clear(); this.keys = []; this.seq = []; }
  put(c: readonly [number, number, number], seq: number, on: boolean) {
    const k = c.join(), i = this.idx.get(k);
    if (i != null && seq < this.seq[i]) return;
    if (!on) {
      if (i == null) return;
      const j = this.keys.length - 1, lk = this.keys[j];
      if (i !== j) { this.keys[i] = lk; this.seq[i] = this.seq[j]; this.xyz.copyWithin(i * 3, j * 3, j * 3 + 3); this.idx.set(lk, i); }
      this.idx.delete(k); this.keys.pop(); this.seq.pop();
      return;
    }
    if (i != null) { this.seq[i] = seq; return; }
    const j = this.keys.length;
    if (this.xyz.length < j * 3 + 3) { const b = new Float32Array(Math.max(3072, this.xyz.length * 2)); b.set(this.xyz); this.xyz = b; }
    this.idx.set(k, j); this.keys.push(k); this.seq.push(seq);
    this.xyz[j * 3] = (c[0] + 0.5) * RES; this.xyz[j * 3 + 1] = (c[1] + 0.5) * RES; this.xyz[j * 3 + 2] = (c[2] + 0.5) * RES;
  }
}
/** 3D 를 다시 그리는 간격(ms) — 쪽마다 전부 다시 놓지 않게(끝 쪽은 늘 그림) */
const SHOW_MS = 250;

/** 진행 중 그림: p = 1초마다 받는 진행 자료(세션·판이 바뀌면 비움). 조각은 update_seq 가 늘 때마다 tiles API 로,
 *  3D 칸은 voxels API(cursor) 로만 채운다 — p.voxels(마지막 증분 하나)는 «새로 왔음» 신호로만 쓰고 직접 놓지 않는다(한 길).
 *  link = 진행 조회가 끊겼다 다시 이어질 때마다 늘리는 값 — 바뀌면 받던 3D 회차를 버리고(늦은 응답 무시) 처음부터(since=0) 새 회차 */
export function useSlamLive(robot: string, p: MappingProgress | null, link = 0): SlamPic {
  const [pic, setPic] = useState(blank);
  const st = useRef({ gen: 0, sid: '', rev: 0, seen: -1, since: 0, busy: false, again: false, gap: false, ver: 0, tver: 0, pose: null as Pose | null,
    vseen: -1, vsince: 0, vbusy: false, vagain: false, vgen: 0, link, xyz: new Float32Array(0), n: 0, frame: null as string | null,
    vox: new VoxSet(), tiles: new Map<string, MappingGridTile>(), ac: new AbortController(), vac: new AbortController() });
  useEffect(() => () => { st.current.ac.abort(); st.current.vac.abort(); }, []);
  /** 그려진 그림의 기준 = 받은 2D 조각의 frame, 조각이 없으면 진행 자료의 기준 */
  const frameOf = () => st.current.tiles.values().next().value?.frame_id ?? st.current.frame;
  useEffect(() => {
    const s = st.current, rev = p?.revision;
    if (!p || !rev) return;
    let dv = false, dt = false, dm = false, fresh = false;
    /** 받던 3D 회차를 끝냄 — 늦게 온 응답·오류는 vgen 이 달라 버려진다(RV-490: 공유 since 를 바꾸지 않음) */
    const vstop = () => { s.vac.abort(); s.vac = new AbortController(); s.vgen++; Object.assign(s, { vbusy: false, vagain: false, vsince: 0 }); fresh = true; };
    if (p.session_id !== s.sid || rev !== s.rev) {   // 새 세션·새 판 = 지난 칸·조각·위치를 다 비움(계약: revision 바뀌면 처음부터)
      s.ac.abort(); s.ac = new AbortController(); s.gen++; vstop();
      Object.assign(s, { sid: p.session_id, rev, seen: -1, since: 0, busy: false, again: false, gap: false, pose: null, vseen: -1, link, xyz: new Float32Array(0), n: 0 });
      s.vox.clear(); s.tiles.clear(); dv = dt = true;
    }
    const fr = p.tiles?.[0]?.frame_id ?? p.voxels?.frame_id ?? p.grid?.frame_id ?? p.odom?.frame_id ?? null;
    if (fr !== s.frame) { s.frame = fr; dm = true; }
    if (link !== s.link) { s.link = link; vstop(); }   // 다시 연결 = 새 회차로 3D 처음부터(받는 동안은 지난 그림 유지, 첫 쪽 reset 에서 한 번 비움)
    const pose = p.odom && (!p.odom.provider || !p.source || p.odom.provider === p.source) ? poseOf(p.odom) : s.pose;
    if (pose?.x !== s.pose?.x || pose?.y !== s.pose?.y || pose?.z !== s.pose?.z || pose?.yaw !== s.pose?.yaw) { s.pose = pose; dv = true; }
    if (dv || dt || dm) setPic({ xyz: s.xyz, n: s.n, ver: dv ? ++s.ver : s.ver, patches: [...s.tiles.values()].map(tilePatch(s.sid)), tver: dt ? ++s.tver : s.tver, pose: s.pose, gap: s.gap,
      sid: s.sid, rev: s.rev, frame: frameOf() });
    const sig = p.voxels?.revision === rev ? p.voxels.seq : 0;   // «새로 왔음» 신호
    if (fresh || sig > s.vseen) { s.vseen = Math.max(s.vseen, sig); void pullVox(); }
    if (p.update_seq != null && p.update_seq > s.seen) { s.seen = p.update_seq; void pull(); }
  }, [p, link]);   // eslint-disable-line react-hooks/exhaustive-deps

  /** 3D 칸 받기(한 번에 하나, SLAM-CONTRACT.md voxels «Recovery»): since 부터 cursor 를 null 까지 그대로 따라가고(reset 이면 첫 쪽에서 한 번만 비움),
   *  다음 since = 이번 첫 쪽 seq. 쪽을 받는 사이 seq 가 늘었거나 새 신호가 왔으면 한 번 더. 칸마다 seq 로 더 새 것만 덮는다.
   *  회차의 판·since 는 회차 지역 값(cursor 가 거기에 묶임 — RV-490). 다시 연결·판 바뀜은 vstop 이 회차를 버린다(vgen).
   *  409 판 바뀜 = 칸을 비우고 다음 진행 자료의 새 판으로 · 그 밖 409·422·끊김·서버 오류 = since=0 처음부터(받는 사이 신호가 왔으면 바로, 아니면 다음 신호에) · RESET_REQUIRED = 서버가 못 줌(gap) */
  async function pullVox() {
    const s = st.current, vgen = s.vgen, { sid, rev } = s, signal = s.vac.signal;
    if (s.vbusy) { s.vagain = true; return; }
    s.vbusy = true;
    let at = -Infinity;
    const show = (now = false) => {
      const t = performance.now();
      if (!now && t - at < SHOW_MS) return;
      at = t;
      s.xyz = s.vox.xyz; s.n = s.vox.n;
      setPic((o) => ({ ...o, xyz: s.xyz, n: s.n, ver: ++s.ver, gap: s.gap }));
    };
    try {
      do {
        s.vagain = false;
        const since = s.vsince;
        try {
          let cursor: string | null = null, base = -1, top = -1;
          do {
            const pg: MappingVoxelPage = await api.slamVoxels(robot, sid, rev, since, cursor, signal);
            if (vgen !== s.vgen) return;
            if (pg.session_id !== sid || pg.revision !== rev) throw new ApiFail(409, 'MAPPING_REVISION_CONFLICT', '');
            if (base < 0) { base = pg.seq; if (pg.reset) s.vox.clear(); }   // reset 은 그 한 번(pass) 시작에만 비움 — 쪽마다 비우지 않음
            top = Math.max(top, pg.seq);
            for (const ch of pg.removed ?? []) s.vox.put(ch.cell, ch.seq, false);
            for (const ch of pg.added ?? []) s.vox.put(ch.cell, ch.seq, true);
            cursor = pg.next_cursor;
            show(cursor == null);
          } while (cursor != null);
          s.gap = false;
          s.vsince = base; if (top > base) s.vagain = true;   // 받는 사이 바뀐 것 — 첫 쪽 seq 부터 한 번 더
        } catch (e) {
          const f = e as ApiFail;
          if (vgen !== s.vgen || f.code === 'CANCELED') return;
          s.vsince = 0; s.vseen = -1;   // 처음부터(화면에 남은 칸은 그 첫 쪽 reset 때 비움)
          if (f.code === 'MAPPING_REVISION_CONFLICT' || f.code === 'MAPPING_VOXELS_RESET_REQUIRED') { s.vagain = false; s.vox.clear(); s.gap = f.code === 'MAPPING_VOXELS_RESET_REQUIRED'; show(true); }
        }
      } while (s.vagain);
    } finally { if (vgen === s.vgen) s.vbusy = false; }
  }

  /** 조각 따라가기(한 번에 하나): cursor=0 부터 null 까지, 다음 번 since = 이번 첫 쪽의 update_seq. 409(판 바뀜)면 조각을 비우고 다음 진행 자료의 새 판으로 */
  async function pull() {
    const s = st.current, gen = s.gen, { sid, rev } = s, signal = s.ac.signal;
    if (s.busy) { s.again = true; return; }
    s.busy = true;
    const show = () => setPic((o) => ({ ...o, patches: [...s.tiles.values()].map(tilePatch(sid)), tver: ++s.tver, frame: frameOf() }));
    try {
      do {
        s.again = false;
        let cursor: number | null = 0, first = -1;
        while (cursor != null) {
          const pg = await api.slamTiles(robot, sid, rev, cursor, s.since, signal);
          if (gen !== s.gen) return;
          if (first < 0) first = pg.update_seq;
          let got = false;
          for (const t of pg.tiles ?? []) {
            const k = `${t.x},${t.y}`, o = s.tiles.get(k);
            if (t.revision === rev && Array.isArray(t.cells) && t.cells.length === TILE * TILE && (!o || t.tile_seq > o.tile_seq)) { s.tiles.set(k, t); got = true; }
          }
          if (got) show();
          cursor = pg.next_cursor;
        }
        s.since = first;
      } while (s.again && s.seen > s.since);
    } catch (e) {
      if (gen !== s.gen || (e as ApiFail).code === 'CANCELED') return;
      if ((e as ApiFail).status === 409) { s.tiles.clear(); s.since = 0; show(); }
      s.seen = -1;   // 다음 진행 자료에서 다시(끊김·서버 오류 포함 — 화면에 남은 조각은 그대로)
    } finally { if (gen === s.gen) s.busy = false; }
  }
  return pic;
}

/** 저장된 지도 묶음(bundle) — 담당 운영자만(남은 403). 받는 중 null */
export function useSlamSaved(robot: string, session: string, cancel?: AbortSignal, again = 0): { pic: SlamPic | null; err: string } {
  const [r, setR] = useState<{ pic: SlamPic | null; err: string }>({ pic: null, err: '' });
  useEffect(() => {
    const ac = new AbortController(), off = () => ac.abort();
    cancel?.addEventListener('abort', off);
    (async () => {
      try {
        const [m, vb, gb] = await Promise.all([api.slamBundle(robot, session, ac.signal), api.slamBundleFile(robot, session, 'voxels', ac.signal), api.slamBundleFile(robot, session, 'grid', ac.signal)]);
        const b = m?.bundle, g = b?.grid, [vx, gr] = await Promise.all([vb.arrayBuffer(), gb.arrayBuffer()]);
        if (!b || !g || !Number.isInteger(b.voxel_count) || vx.byteLength !== b.voxel_count * 12 || gr.byteLength !== g.width * g.height) throw new ApiFail(0, 'BAD_SHAPE', '받은 지도 자료 형식이 맞지 않습니다.');
        const dv = new DataView(vx), n = b.voxel_count, xyz = new Float32Array(n * 3);
        for (let i = 0; i < n * 3; i++) xyz[i] = (dv.getInt32(i * 4, true) + 0.5) * RES;
        setR({ err: '', pic: { xyz, n, ver: 1, tver: 1, gap: false, pose: poseOf(b.odom),
          patches: [{ key: 'grid', seq: 0, x0: g.origin[0], y0: g.origin[1], w: g.width, h: g.height, cells: new Uint8Array(gr) }] } });
      } catch (e) {
        const f = e as ApiFail;
        if (f.code !== 'CANCELED' && !ac.signal.aborted) setR({ pic: null, err: f.message });
      }
    })();
    return () => { ac.abort(); cancel?.removeEventListener('abort', off); };
  }, [robot, session, again]);   // eslint-disable-line react-hooks/exhaustive-deps
  return r;
}

/** 겹쳐 그릴 다른 칸(지도 만들기의 GLIM 미리보기): 칸 번호 [x,y,z] × res m — 위에서 본 2D 에만, 같은 좌표라고 확인된 것만 넘긴다 */
export type Over = { cells: readonly (readonly [number, number, number])[]; res: number };
/** 계약 MappingGlimPreview: 칸 [x,y,z] 정수 |v| ≤ 40000, 1024칸까지, 해상도 양수 */
export const OVER_MAX = 1024;
const okCell = (c: unknown) => Array.isArray(c) && c.length === 3 && c.every((v) => Number.isInteger(v) && Math.abs(v) <= 40000);
/** 받은 겹칠 칸에서 잘못된 칸만 빼고 OVER_MAX 칸까지(RV-519 — 한 칸이 틀려도 아래 Point-LIO 그림을 지우지 않게). 해상도가 틀리면 겹치지 않음 */
export function cleanOver(o?: Over | null): Over | null {
  const res = o?.res;
  if (!o || !Array.isArray(o.cells) || typeof res !== 'number' || !Number.isFinite(res) || res <= 0) return null;
  const cells: Over['cells'][number][] = [];
  for (const c of o.cells) { if (cells.length >= OVER_MAX) break; if (okCell(c)) cells.push(c); }
  return { cells, res };
}

/** 위에서 본 2D: 조각을 제자리에 놓기만(조각마다 칸 그림을 한 번 칠해 두고 늘이기). 받은 조각·겹친 칸·로봇이 다 들어오게 맞춤. hideBase = 조각은 빼고 겹친 칸만 */
function SlamGrid({ pic, over, hideBase = false }: { pic: SlamPic; over?: Over | null; hideBase?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null), cache = useRef(new Map<string, { seq: number; img: HTMLCanvasElement }>()), draw = useRef(() => {});
  draw.current = () => {
    const cv = ref.current, g = cv?.getContext?.('2d');
    if (!cv || !g) return;
    const dpr = window.devicePixelRatio || 1, W = Math.round(cv.clientWidth * dpr) || cv.width, H = Math.round(cv.clientHeight * dpr) || cv.height, r = pic.pose;
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    const keep = new Set(pic.patches.map((q) => q.key));   // 그릴 게 없어 아래에서 돌아가도(판 바뀐 직후 조각 0개) 지난 그림은 먼저 버림
    for (const key of cache.current.keys()) if (!keep.has(key)) cache.current.delete(key);
    g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = `rgb(${RGB[0].join(',')})`; g.fillRect(0, 0, W, H);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const base = hideBase ? [] : pic.patches, oc = over?.cells ?? [], or = over?.res ?? 0;
    for (const [i, j] of oc) { x0 = Math.min(x0, i * or); y0 = Math.min(y0, j * or); x1 = Math.max(x1, (i + 1) * or); y1 = Math.max(y1, (j + 1) * or); }
    for (const q of base) { x0 = Math.min(x0, q.x0); y0 = Math.min(y0, q.y0); x1 = Math.max(x1, q.x0 + q.w * RES); y1 = Math.max(y1, q.y0 + q.h * RES); }
    if (r) { x0 = Math.min(x0, r.x - 1); y0 = Math.min(y0, r.y - 1); x1 = Math.max(x1, r.x + 1); y1 = Math.max(y1, r.y + 1); }
    if (!(x1 > x0)) return;
    const k = Math.min(W / (x1 - x0 + 1), H / (y1 - y0 + 1)), cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const X = (x: number) => W / 2 + (x - cx) * k, Y = (y: number) => H / 2 - (y - cy) * k;
    g.imageSmoothingEnabled = false;
    for (const q of base) {
      let c = cache.current.get(q.key);
      if (!c || c.seq !== q.seq) {
        const img = document.createElement('canvas'), ig = (img.width = q.w, img.height = q.h, img.getContext('2d'));
        if (!ig) continue;
        const d = ig.createImageData(q.w, q.h), px = new Uint32Array(d.data.buffer);
        for (let y = 0; y < q.h; y++) for (let x = 0, o = (q.h - 1 - y) * q.w, b = y * q.w; x < q.w; x++) px[o + x] = COL[q.cells[b + x]] ?? COL[0];   // 아래 줄부터 → 그림은 위 줄부터
        ig.putImageData(d, 0, 0);
        cache.current.set(q.key, c = { seq: q.seq, img });
      }
      g.drawImage(c.img, X(q.x0), Y(q.y0 + q.h * RES), q.w * RES * k, q.h * RES * k);
    }
    if (oc.length) {   // 겹친 칸: 강조색 반투명(아래 조각이 비쳐 보이게)
      g.save(); g.globalAlpha = 0.55; g.fillStyle = getComputedStyle(cv).getPropertyValue('--accent').trim() || '#36c';
      for (const [i, j] of oc) g.fillRect(X(i * or), Y((j + 1) * or), Math.max(1, or * k), Math.max(1, or * k));
      g.restore();
    }
    if (r) {   // 로봇: 앞을 가리키는 화살표(occmap.tsx 와 같은 모양·색)
      const st = getComputedStyle(cv), s = 9 * dpr;
      g.save(); g.translate(X(r.x), Y(r.y)); g.rotate(-r.yaw);
      g.fillStyle = st.getPropertyValue('--warn').trim() || '#e90'; g.strokeStyle = '#fff'; g.lineWidth = dpr;
      g.beginPath(); g.moveTo(s * 1.6, 0); g.lineTo(-s, s * 0.9); g.lineTo(-s * 0.4, 0); g.lineTo(-s, -s * 0.9); g.closePath(); g.fill(); g.stroke(); g.restore();
    }
  };
  useEffect(() => draw.current(), [pic.tver, pic.pose, over, hideBase]);
  useEffect(() => {
    const ro = typeof ResizeObserver === 'undefined' || !ref.current ? null : new ResizeObserver(() => draw.current());
    if (ro && ref.current) ro.observe(ref.current);
    return () => ro?.disconnect();
  }, []);
  return <div style={{ position: 'absolute', inset: 0 }}>
    <canvas ref={ref} width={640} height={400} role="img" aria-label="위에서 본 지도" data-slam-tiles={hideBase ? 0 : pic.patches.length} data-over-cells={over ? over.cells.length : undefined} data-slam-robot={pic.pose ? '' : undefined}
      style={{ display: 'block', width: '100%', height: '100%' }} />
    <OccLegend />
  </div>;
}

/** 3D 상자: 받은 칸 가운데를 lidar3d «상자» 보기에 그대로(5 cm 상자 = 칸 하나) */
function SlamBoxes({ pic, fail }: { pic: SlamPic; fail: () => void }) {
  const feed = useMemo<DriveFeed>(() => ({ state: 'live', why: '', at: 0, seq: pic.ver, img: '', xyz: pic.xyz, n: pic.n, frame: 'map', truncated: false, ver: pic.ver,
    range: null, pose: pic.pose }), [pic.ver]);   // eslint-disable-line react-hooks/exhaustive-deps
  return <Lidar3D feed={feed} small={false} look="boxes" ratio={1} onFail={fail} />;
}

/** 지도 칸(부모 크기를 채움): «위에서 2D» / «3D 상자» 고르기 + 그 그림(first3d = 3D 로 시작). 아무것도 안 왔으면 안내만.
 *  over·hideBase = 2D 에 겹칠 칸·조각 숨김(지도 만들기 GLIM 미리보기 — 안 주면 그대로). 조각을 숨기면 3D 상자도 막는다 */
export function SlamView({ pic, empty, first3d = false, over: raw, hideBase = false }: { pic: SlamPic; empty: string; first3d?: boolean; over?: Over | null; hideBase?: boolean }) {
  const over = useMemo(() => cleanOver(raw), [raw]);
  const [d3, setD3] = useState(first3d), [no3d, setNo3d] = useState(false), show3d = d3 && !no3d && !hideBase, whyId = useId();
  // 3D 상자가 회색인 까닭 한 줄 (폰에는 마우스 올림이 없다)
  const why3d = no3d ? '이 브라우저는 3D 를 그릴 수 없습니다' : !pic.n ? '3D 칸을 아직 받지 못했습니다' : hideBase ? '고친 지도 미리보기는 위에서만 봅니다' : '';
  const any = (!hideBase && (pic.n > 0 || pic.patches.length > 0)) || !!over?.cells.length;
  return <div style={{ position: 'absolute', inset: 0, background: 'var(--panel)' }} data-slam-view={show3d ? '3d' : '2d'} data-slam-boxes={pic.n}>
    {!any ? <QEmpty text={empty} /> : show3d ? <SlamBoxes pic={pic} fail={() => setNo3d(true)} /> : <SlamGrid pic={pic} over={over} hideBase={hideBase} />}
    {any && <div className="fh-row" role="group" aria-label="지도 보기 고르기" style={{ position: 'absolute', right: 8, top: 8, zIndex: 1 }}>
      <button type="button" className="btn" aria-pressed={!show3d} data-slam-pick="2d" onClick={() => setD3(false)}>위에서</button>
      <button type="button" className="btn" aria-pressed={show3d} data-slam-pick="3d" disabled={!!why3d} aria-describedby={why3d ? whyId : undefined} onClick={() => setD3(true)}>3D 상자</button>
      {why3d && <span style={{ flexBasis: '100%', display: 'flex', justifyContent: 'flex-end' }}><span className="lbl" id={whyId} data-slam-3d-why style={{ background: 'var(--panel)', padding: '2px 6px', borderRadius: 6 }}>{why3d}</span></span>}
    </div>}
  </div>;
}

/** 저장된 «로봇으로 만든 지도» 다시 열기 — 같은 그리기 */
export function SlamSavedView({ robot, session, cancel }: { robot: string; session: string; cancel?: AbortSignal }) {
  const [n, setN] = useState(0), { pic, err } = useSlamSaved(robot, session, cancel, n);
  return <div className="vx" data-slam-saved>
    {pic ? <SlamView pic={pic} empty="이 지도에는 받은 칸이 없습니다." first3d />
      : err ? <div className="mx-center"><p className="fh-msg" role="alert">지도 자료를 받지 못했습니다. {err}</p><button type="button" className="btn" onClick={() => setN(n + 1)}>다시 시도</button></div>
      : <p className="lv-note mx-center" role="status">지도 자료를 받는 중…</p>}
  </div>;
}

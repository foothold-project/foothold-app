# Source: control-app/experiments/33-foothold-v2-gazebo-20261012/vmap-verify4-20261015/connected.py
# Original sha256: 645cc0791f196d2f; phase 1/2 pure logic copied verbatim.
import json, math, threading
import numpy as np

FLOORS = {"l1": 0.0, "l2": 2.4}
TOL_Z, HOLD_S, TILT_MAX, CLR, DELTA = 0.10, 1.0, math.radians(35), 0.15, 0.20
MARGIN = 0.40                       # ponytail: 연결부 사각형 여유(몸 반길이 근사). 실 Go2 치수로 보정할 손잡이
# 연결부 영역(x0,x1,y0,y1) — 원 metadata connectors: 계단 (3,4,0)→(7.8,4,2.4) 폭 3 · 경사로 (-18,-10,0)→(-18,6,2.4) 폭 3.2 + 착지
ZONES = {"stairs": (3.0, 7.8, 2.5, 5.5), "ramp": (-19.6, -16.4, -10.0, 6.0), "ramp_landing": (-19.6, -15.9, 6.0, 9.2)}


def in_zone(x, y, m=MARGIN):
    for k, (x0, x1, y0, y1) in ZONES.items():
        if x0 - m <= x <= x1 + m and y0 - m <= y <= y1 + m:
            return k
    return None


class ColsGround:
    def __init__(self, path):
        z = np.load(path); self.meta = json.loads(str(z["meta"]))
        self.lo, self.hi = z["lo"], z["hi"]
        self.x0, self.y0, self.res = self.meta["x0"], self.meta["y0"], self.meta["res"]
        self.H, self.W = self.lo.shape[:2]

    def _cells(self, pts):
        ix = np.floor((pts[:, 0] - self.x0) / self.res).astype(int); iy = np.floor((pts[:, 1] - self.y0) / self.res).astype(int)
        ok = (ix >= 0) & (ix < self.W) & (iy >= 0) & (iy < self.H)
        return ix, iy, ok

    def ground_fn(self, base_z):
        """height_scan 용 ground((N,2)) → (N,): 규칙 B. 래스터 밖·해당 고체 없음 = nan."""
        def fn(pts):
            ix, iy, ok = self._cells(np.asarray(pts, float)); out = np.full(len(pts), np.nan)
            lo, hi = self.lo[iy[ok], ix[ok]], self.hi[iy[ok], ix[ok]]
            h = np.where(lo < base_z + DELTA, hi, np.nan)          # nan 자리는 비교 False → nan 유지
            with np.errstate(all="ignore"):
                m = np.nanmax(np.where(np.isnan(h), -np.inf, h), axis=1)
            out[ok] = np.where(np.isfinite(m), m, np.nan)
            return out
        return fn

    def support(self, x, y, base_z):
        """몸 중심 칸 지지면: hi ≤ base_z − CLR 인 고체 윗면 최대(층 판정 전용, 낙상 판정엔 안 씀). 없으면 nan."""
        ix, iy, ok = self._cells(np.array([[x, y]]))
        if not ok[0]: return float("nan")
        hi = self.hi[iy[0], ix[0]]; k = hi <= base_z - CLR
        return float(hi[k].max()) if k.any() else float("nan")


class FloorTracker:
    def __init__(self, spawn_floor):
        assert spawn_floor in FLOORS
        self.lock = threading.Lock()
        self.spawn, self.rev, self.epoch = spawn_floor, 0, None
        self.current, self.state, self.reason, self.cand, self.cand_since, self.confirm_t = None, "unknown", "start", None, None, None
        self.ref_floor = spawn_floor        # 마지막 확정층(TF base_footprint 높이용). 확정 전 = spawn

    def reset(self, epoch):                 # RESET/boot: 새 Gazebo — 미확정으로, rev +1(옛 epoch 작업 무효)
        with self.lock:
            self.epoch, self.rev = epoch, self.rev + 1
            self.current, self.state, self.reason, self.cand, self.cand_since, self.confirm_t = None, "unknown", "reset", None, None, None
            self.ref_floor = self.spawn
            return self.rev

    def update(self, sim_t, x, y, base_z, tilt, fallen, support):
        """한 tick. 반환 = (event, rev): event ∈ {None, 'leave', 'confirm'} — leave/confirm 때 rev 는 새 값.
        불변식: state == 'on_floor' ⇔ current ∈ FLOORS. 이탈은 언제나 transit|unknown 으로(on_floor 로 남기지 않음)."""
        with self.lock:
            return self._update(sim_t, x, y, base_z, tilt, fallen, support)

    def _update(self, sim_t, x, y, base_z, tilt, fallen, support):   # self.lock 보유 상태에서만
        vals = (sim_t, x, y, base_z, tilt)
        if not all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in vals):
            st, why, f = "unknown", "invalid_input", None                       # NaN·inf 시각/자세 = 판정 불가
        elif fallen or tilt >= TILT_MAX: st, why, f = "unknown", "fallen_or_tilt", None
        elif not (isinstance(support, float) and math.isfinite(support)): st, why, f = "unknown", "support_nan", None
        else:
            zone = in_zone(x, y); near = [f for f, z in FLOORS.items() if abs(support - z) <= TOL_Z]
            if zone: st, why, f = "transit", f"connector_{zone}", None
            elif not near: st, why, f = "transit", "support_off_floor", None
            else: st, why, f = "on_floor", "ok", near[0]
        if self.state == "on_floor":
            if st == "on_floor" and f == self.current:
                return None, self.rev
            if st == "on_floor":                                               # 연결부 없이 다른 층 지지면(고도 점프) — 확정층 철회, transit
                st, why = "transit", f"floor_jump_{self.current}_to_{f}"
            self.rev += 1; self.current, self.state, self.reason, self.cand, self.cand_since = None, st, why, None, None
            return "leave", self.rev
        if st != "on_floor":
            self.state, self.reason, self.cand, self.cand_since = st, why, None, None; return None, self.rev
        self.reason = "confirming"                                       # state 는 transit|unknown 그대로(확정 전 on_floor 0)
        if self.cand != f or sim_t < self.cand_since:
            self.cand, self.cand_since = f, sim_t; return None, self.rev
        if sim_t - self.cand_since >= HOLD_S - 1e-9:
            self.rev += 1; self.current, self.state, self.reason, self.confirm_t, self.ref_floor = f, "on_floor", "ok", sim_t, f
            return "confirm", self.rev
        return None, self.rev

    def snapshot(self):
        with self.lock:
            return self._snap()

    def _snap(self):
        return {"epoch": self.epoch, "spawn_floor": self.spawn, "current_floor": self.current, "floor_state": self.state, "floor_rev": self.rev,
                "floor_reason": self.reason, "floor_src": "gt_geometry", "floor_confirm_sim_t": self.confirm_t, "connected": True}


class Gate:
    """SLAM 입력 문. 상태는 tracker.lock 하나로 보호(tracker 의 leave·confirm·reset 과 같은 lock).
    forward(stamp, publish): 검사와 publish 를 그 lock 안에서 한 번에 — 검사 뒤 leave/RESET 이 끼어 옛 scan 이 새 SLAM 으로 가는 창 0.
    open(epoch, rev, then): worker 가 그 (epoch, rev) 의 새 slam 준비를 끝냈을 때. then() 은 같은 lock 안(ctx ready 표기를 문 열기와 원자로).
    tracker rev·epoch 가 바뀌면 그 토큰은 자동 무효."""
    def __init__(self, tracker):
        self.t, self.ready = tracker, None
        self.passed = self.dropped = 0

    def open(self, epoch, rev, then=None):
        with self.t.lock:
            if (self.t.epoch, self.t.rev) != (epoch, rev) or self.t.state != "on_floor":
                return False                                  # 늦은 worker 완료 — 이미 다른 rev
            self.ready = (epoch, rev)
            if then:
                then()
            return True

    def close(self):
        with self.t.lock:
            self.ready = None

    def forward(self, stamp, publish):
        with self.t.lock:
            s = self.t._snap()
            ok = (s["floor_state"] == "on_floor" and self.ready == (s["epoch"], s["floor_rev"])
                  and s["floor_confirm_sim_t"] is not None and isinstance(stamp, float) and math.isfinite(stamp)
                  and stamp >= s["floor_confirm_sim_t"])
            if ok:
                publish(); self.passed += 1                   # ponytail: publish 는 DDS 큐 넣기(비차단)라 lock 안에서 호출
            else:
                self.dropped += 1
            return ok


def bind_view(mode, fs, ctx, sel, ms_ctx):
    """status 표시 층 결속. 입력은 모두 같은 lock 스냅샷(ft.lock → ms.lock): fs = tracker _snap()(epoch 포함), ctx = worker ctx,
    sel = static 선택, ms_ctx = (epoch, rev, floor, has_grid). 반환 (bf, why): bf = 지도·위치를 보여도 되는 층(아니면 None), why ∈ MAP_NULL_REASONS|None."""
    on = fs["floor_state"] == "on_floor"; cur, rev = fs["current_floor"], fs["floor_rev"]
    if mode == "slam":
        bf = ctx["floor"] if on and ctx["state"] == "ready" and ctx["floor"] == cur and ctx["rev"] == rev else None
        why = None if bf else "floor_transit" if not on else "slam_" + str(ctx["state"]) if ctx["state"] != "ready" else "context_mismatch"
    else:
        same = sel["floor"] == cur and sel["rev"] == rev
        bf = sel["floor"] if on and same and sel["g"] is not None else None
        why = None if bf else "floor_transit" if not on else (sel["why"] if same else "context_mismatch")
    if bf and tuple(ms_ctx[:3]) != (fs["epoch"], rev, bf):
        return None, "context_mismatch"
    if bf and not ms_ctx[3]:
        return bf, "no_grid_yet"
    return bf, why

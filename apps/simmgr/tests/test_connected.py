# Source: control-app/experiments/33-foothold-v2-gazebo-20261012/vmap-verify4-20261015/connected.py
# Original sha256: 645cc0791f196d2f; phase 1/2 tracker selftest assertions unchanged.
import json
import math
from types import SimpleNamespace
import threading

import numpy as np
import pytest

from apps.simmgr.connected import ColsGround, FloorTracker, FLOORS, TILT_MAX, in_zone, bind_view


def test_original_tracker_selftest():
    rng = np.random.default_rng(0)
    T = FloorTracker("l1"); r0 = T.reset(1); assert r0 == 1 and T.snapshot()["current_floor"] is None
    st = lambda t, x, y, z, s, fallen=False, tilt=0.0: T.update(t, x, y, z, tilt, fallen, s)
    assert st(0.0, -12, -9, 0.3, 0.0) == (None, 1) and st(0.5, -12, -9, 0.3, 0.0) == (None, 1)
    ev, r1 = st(1.0, -12, -9, 0.3, 0.0); assert ev == "confirm" and r1 == 2 and T.snapshot()["current_floor"] == "l1"
    assert st(1.1, -12, -9, 0.3, 0.0) == (None, 2)
    ev, r2 = st(1.2, 3.5, 4, 0.3, 0.0); assert ev == "leave" and r2 == 3                               # 계단 진입 = 즉시 철회
    s = T.snapshot(); assert s["current_floor"] is None and s["floor_state"] == "transit" and s["floor_reason"] == "connector_stairs"
    for t in (1.3, 2.0, 3.0): assert st(t, 5.5, 4, 1.5, 1.2) == (None, 3)                              # 계단 위 = transit 유지
    assert st(3.1, 9.0, 4, 2.7, 2.4) == (None, 3) and T.snapshot()["floor_reason"] == "confirming"     # 연결부 밖 l2 — 후보
    assert st(3.6, 9.0, 4, 2.7, 2.4) == (None, 3)
    ev, r3 = st(4.1, 9.0, 4, 2.7, 2.4); assert ev == "confirm" and r3 == 4 and T.snapshot()["current_floor"] == "l2" and T.ref_floor == "l2"
    # 후보 중 흔들림(지지면 ±0.10 밖) → 후보 초기화, 1.0 s 다시
    T2 = FloorTracker("l2"); T2.reset(1)
    T2.update(0.0, 10.5, 4.5, 2.8, 0, False, 2.4); T2.update(0.6, 10.5, 4.5, 2.8, 0, False, 2.6); T2.update(0.7, 10.5, 4.5, 2.8, 0, False, 2.4)
    assert T2.update(1.5, 10.5, 4.5, 2.8, 0, False, 2.4) == (None, 1) and T2.update(1.7, 10.5, 4.5, 2.8, 0, False, 2.4)[0] == "confirm"
    # 낙상·nan 지지면 = unknown(확정 0), 이탈은 rev+1
    ev, r = T2.update(2.0, 10.5, 4.5, 0.15, 0, True, 0.0); assert ev == "leave" and T2.snapshot()["floor_state"] == "unknown"
    assert T2.update(2.1, 10.5, 4.5, 0.15, 0, False, float("nan")) == (None, r) and T2.snapshot()["floor_reason"] == "support_nan"
    # RESET: rev 계속 증가(0 아님), 미확정으로
    rr = T2.reset(2); assert rr == r + 1 and T2.snapshot()["current_floor"] is None and T2.epoch == 2

    # root②-1: 직접 층 점프(연결부 표본 없이) l1→l2·l2→l1 = 철회 후 transit, rev 는 한 번만 오르고 확정 가능
    for a, b in (("l1", "l2"), ("l2", "l1")):
        Tj = FloorTracker(a); Tj.reset(1); za, zb = FLOORS[a], FLOORS[b]
        for t in (0.0, 1.0): Tj.update(t, 12, 8, za + 0.3, 0, False, za)
        assert Tj.snapshot()["current_floor"] == a; r = Tj.rev
        ev, r1 = Tj.update(1.1, 12, 8, zb + 0.3, 0, False, zb)
        s1 = Tj.snapshot(); assert ev == "leave" and r1 == r + 1 and s1["floor_state"] == "transit" and s1["current_floor"] is None
        assert s1["floor_reason"] == f"floor_jump_{a}_to_{b}"
        assert Tj.update(1.2, 12, 8, zb + 0.3, 0, False, zb) == (None, r + 1)          # 다음 tick 에 또 leave 0
        assert Tj.update(2.15, 12, 8, zb + 0.3, 0, False, zb) == (None, r + 1)
        ev, r2 = Tj.update(2.2, 12, 8, zb + 0.3, 0, False, zb); assert ev == "confirm" and r2 == r + 2 and Tj.snapshot()["current_floor"] == b
    # NaN·inf 시각/자세: on_floor 에서 들어오면 즉시 철회(unknown), 그 뒤 반복해도 rev 증가 0 · 시각 되감김 = 후보 재시작
    Tn = FloorTracker("l1"); Tn.reset(1)
    for t in (0.0, 1.0): Tn.update(t, -12, -9, 0.3, 0, False, 0.0)
    r = Tn.rev
    ev, rn = Tn.update(float("nan"), -12, -9, 0.3, 0, False, 0.0); assert ev == "leave" and rn == r + 1 and Tn.snapshot()["floor_reason"] == "invalid_input"
    for bad in ((float("inf"), -12, -9, 0.3), (1.2, float("nan"), -9, 0.3), (1.2, -12, -9, float("-inf"))):
        assert Tn.update(*bad, 0, False, 0.0) == (None, rn) and Tn.snapshot()["floor_state"] == "unknown"
    Tn.update(5.0, -12, -9, 0.3, 0, False, 0.0); Tn.update(4.0, -12, -9, 0.3, 0, False, 0.0)          # 되감김 → 후보 4.0 부터
    assert Tn.update(4.9, -12, -9, 0.3, 0, False, 0.0) == (None, rn) and Tn.update(5.0, -12, -9, 0.3, 0, False, 0.0)[0] == "confirm"
    # 불변식 무작위 열: state=='on_floor' ⇔ current∈FLOORS, rev 단조
    Tr = FloorTracker("l1"); Tr.reset(1); prev = Tr.rev; t = 0.0
    pts = [(-12, -9, 0.0), (12, 8, 0.0), (12, 8, 2.4), (5.5, 4, 1.2), (9, 4, 2.4), (-18, 0, 1.0), (12, 8, float("nan")), (12, 8, 1.3)]
    for k in range(4000):
        x, y, sp = pts[int(rng.integers(len(pts)))] if rng.random() < 0.15 or k == 0 else (x, y, sp)
        t = t + 0.02 if rng.random() > 0.01 else float(rng.choice([float("nan"), float("inf"), t - 0.5]))
        Tr.update(t, x, y, (sp if math.isfinite(sp) else 0.0) + 0.3, 0, bool(rng.random() < 0.005), sp)
        s_ = Tr.snapshot(); assert (s_["floor_state"] == "on_floor") == (s_["current_floor"] in FLOORS) and s_["floor_rev"] >= prev
        prev = s_["floor_rev"]
        if not math.isfinite(t): t = 0.0 + k * 0.02



def test_rule_b_columns_and_support_use_independent_thresholds(tmp_path):
    rng = np.random.default_rng(0)
    lo = rng.uniform(-1, 4, (8, 9, 4))
    hi = lo + rng.uniform(.01, .5, lo.shape)
    lo[0, 0], hi[0, 0] = [-.1, 2.3, 4, np.nan], [0, 2.4, 5, np.nan]
    path = tmp_path / 'cols.npz'
    np.savez(path, lo=lo, hi=hi, meta=json.dumps(dict(x0=0., y0=0., res=1.)))
    ground = ColsGround(path)
    assert ground.support(.5, .5, .3) == 0.
    assert ground.support(.5, .5, 2.7) == 2.4
    assert ground.ground_fn(.3)(np.array([[.5, .5]]))[0] == 0.
    assert ground.ground_fn(2.7)(np.array([[.5, .5]]))[0] == 2.4
    assert np.isnan(ground.support(99, 0, .3))
    assert np.isnan(ground.ground_fn(.3)(np.array([[99, 0]]))[0])
    for _ in range(400):
        x, y, z = rng.uniform(0, 9), rng.uniform(0, 8), rng.uniform(-1, 4)
        i, j = int(y), int(x)
        heights = [h for l, h in zip(lo[i, j], hi[i, j]) if l < z + .20]
        expected = max(heights, default=float('nan'))
        actual = ground.ground_fn(z)(np.array([[x, y]]))[0]
        assert (math.isnan(expected) and math.isnan(actual)) or expected == actual
        heights = [h for h in hi[i, j] if h <= z - .15]
        expected = max(heights, default=float('nan'))
        actual = ground.support(x, y, z)
        assert (math.isnan(expected) and math.isnan(actual)) or expected == actual


@pytest.mark.parametrize('tilt', [34.99, 35., 36.])
def test_tilt_adapter_degrees_are_converted_to_radians(tilt):
    t = FloorTracker('l1'); t.reset(1)
    for stamp in (0., 1.):
        t.update(stamp, 12., 8., .3, math.radians(tilt), False, 0.)
    assert (t.state == 'on_floor') == (tilt < 35)
    assert TILT_MAX == math.radians(35)


def test_l1_l2_l1_roundtrip_and_margin_boundary():
    t = FloorTracker('l1'); t.reset(1)
    for stamp in (0., 1.):
        t.update(stamp, 12., 8., .3, 0., False, 0.)
    assert t.current == 'l1' and t.rev == 2
    assert in_zone(8.2, 4.) == 'stairs' and in_zone(8.201, 4.) is None
    for stamp, x, support in ((1.1, 8.2, 0.), (2., 8.201, 2.4), (2.9, 8.2, 2.4),
                              (3., 9., 2.4), (4., 9., 2.4)):
        t.update(stamp, x, 4., support + .3, 0., False, support)
    assert t.current == 'l2' and t.rev == 4
    t.update(4.1, -18., 0., 1.5, 0., False, 1.2)
    for stamp in (5., 6.):
        t.update(stamp, -12., -9., .3, 0., False, 0.)
    assert t.current == 'l1' and t.rev == 6


def test_static_selection_fences_late_confirmation_and_reset():
    # Run the verbatim nested source with small fakes, no source assets or ROS.
    from apps.simmgr import connected_static as static
    from apps.simmgr.connected_runtime import decorate_status
    ft = FloorTracker('l1'); ft.reset(1)
    calls = []
    grid = SimpleNamespace(header=SimpleNamespace(stamp=None))
    selected = {}
    static.ft, static.static_sel = ft, selected
    static.static_by_floor = {'l1': dict(g=grid, meta={'sha256_pgm': 'a'*64, 'origin': [0, 0, 0]}, why=None)}
    static.stamp = lambda t: t
    static.ms = SimpleNamespace(new_epoch=lambda *args: calls.append(args), close=lambda: calls.append('closed'))
    for stamp in (0., 1.):
        ft.update(stamp, 12., 8., .3, 0., False, 0.)
    revision = ft.rev
    assert static.static_floor(1, 'l1', revision)['g'] is grid
    assert grid.header.stamp == 1.
    assert decorate_status({}, selected)['source_pgm_sha256'] == 'a'*64
    ft.update(1.1, 4., 4., .3, 0., False, 0.)
    assert static.static_floor(1, None, ft.rev)['g'] is None and calls[-1] == 'closed'
    assert static.static_floor(1, 'l1', revision) is None and selected['g'] is None
    ft.reset(2)
    assert static.static_floor(1, 'l1', ft.rev) is None


def test_static_bind_view_rejects_previous_floor_revision_and_absent_grid():
    fs = dict(floor_state='on_floor', current_floor='l2', floor_rev=4, epoch=1)
    sel = dict(floor='l2', rev=4, g=object(), why=None)
    assert bind_view('static', fs, {}, sel, (1, 4, 'l2', True)) == ('l2', None)
    assert bind_view('static', fs, {}, sel, (1, 2, 'l1', True)) == (None, 'context_mismatch')
    assert bind_view('static', fs, {}, sel, (1, 4, 'l2', False)) == ('l2', 'no_grid_yet')
    assert bind_view('static', {**fs, 'floor_state': 'transit', 'current_floor': None}, {}, sel,
                     (1, 4, 'l2', True)) == (None, 'floor_transit')


def test_runtime_transplants_only_floor_hooks_and_disables_unused_slam_gate():
    from apps.simmgr.connected_runtime import compile_static_runtime
    source = '''
def main():
    gate = CN.Gate(ft) if CONN else None
    def static_floor(ep, f, rev): pass
    def floor_tick(sim_t, pos, tilt, fallen): pass
    def publish_status():
        st = {'untouched': 'sensor-state'}
        pub_status.publish(st)
    return 'unchanged control and sensors'
'''
    assert compile_static_runtime(source, 'fake-runtime') is not None
    for broken in [source.replace('def static_floor(', 'def other('),
                   source.replace('pub_status.publish(st)', 'other.publish(st)'),
                   source.replace('gate = CN.Gate(ft) if CONN else None', 'other = None')]:
        with pytest.raises(ValueError, match='hooks changed|hook changed'):
            compile_static_runtime(broken, 'fake-runtime')

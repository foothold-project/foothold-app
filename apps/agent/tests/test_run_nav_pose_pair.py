"""Product adapter replay: 10 Hz state and 50 Hz TF share source stamps."""
import json
import math
from collections import deque
from types import SimpleNamespace as N

import pytest

from foothold_agent.ros_bridge.run_nav import RunNav, LIFECYCLE_NODES
from foothold_agent.ros_bridge.nav_odometry import SimOdom
from test_ros_bridge import Clock


def adapter():
    clock = Clock()
    nav = RunNav.__new__(RunNav)
    nav.now = clock
    nav.state, nav.state_at = {}, float('-inf')
    nav.tf_poses = deque(maxlen=32)
    nav.pose_agreement = None
    nav.odom = SimOdom(.25, .02, .15)
    nav.odom_at = float('-inf')
    nav.map_identity = True
    nav.publisher = N(publish=lambda msg: None)
    nav.Odometry = lambda: N(header=N(), pose=N(pose=N(position=N())),
                            twist=N(twist=N(linear=N(), angular=N())))
    nav.actions = N(take=lambda: (None, None), health=lambda ready: setattr(nav, 'ready', ready))
    nav.navigator = N(server_is_ready=lambda: True)
    nav.lifecycle_clients, nav.lifecycle_pending = {}, {}
    nav.last_lifecycle = 0.
    return nav, clock


def state(nav, stamp, *, x=None, yaw=0., episode=1):
    nav._state(N(data=json.dumps(dict(episode=episode, sim_t=stamp,
        x=.6*stamp if x is None else x, y=0., yaw=yaw))))


def tf(nav, clock, stamp, *, x=None, yaw=0.):
    clock.t = stamp
    nav.clock = nav.scan = (stamp, clock())
    header = N(frame_id='odom', stamp=N(sec=int(stamp), nanosec=round((stamp-int(stamp))*1e9)))
    t = N(header=header, child_frame_id='base_footprint', transform=N(
        translation=N(x=.6*stamp if x is None else x, y=0.),
        rotation=N(x=0., y=0., z=math.sin(yaw/2), w=math.cos(yaw/2))))
    nav._tf(N(transforms=[t]))
    nav.lifecycle = {name: (True, clock()) for name in LIFECYCLE_NODES}
    nav.spin()


@pytest.mark.parametrize('state_first', [False, True])
def test_moving_10hz_state_50hz_tf_retains_fresh_equal_stamp_proof(state_first):
    nav, clock = adapter()
    state(nav, 0.)
    tf(nav, clock, 0.)
    for i in range(1, 101):
        stamp = round(i*.02, 6)
        clock.t = stamp
        if i % 5 == 0 and state_first:
            state(nav, stamp)
        tf(nav, clock, stamp)
        if i % 5 == 0 and not state_first:
            state(nav, stamp)
            nav.spin()
        if i >= 5:
            assert nav.ready, (stamp, nav.diagnostics())
            assert 0 <= clock()-nav.odom_at <= .2


@pytest.mark.parametrize('fault', ['pose', 'yaw', 'stopped_state', 'stopped_tf', 'episode', 'rewind'])
def test_pairing_keeps_existing_mismatch_and_freshness_gates(fault):
    nav, clock = adapter()
    state(nav, 0.)
    tf(nav, clock, 0.)
    tf(nav, clock, .1)
    state(nav, .1)
    nav.spin()
    assert nav.ready
    if fault == 'pose':
        tf(nav, clock, .2)
        state(nav, .2, x=.6*.2+.05001)
    elif fault == 'yaw':
        tf(nav, clock, .2)
        state(nav, .2, yaw=.05001)
    elif fault == 'episode':
        state(nav, .2, episode=2)
    elif fault == 'rewind':
        state(nav, .0)
    elif fault == 'stopped_state':
        tf(nav, clock, .2)
        tf(nav, clock, .30001)
    elif fault == 'stopped_tf':
        clock.t = .30001
        state(nav, .30001)
    nav.spin()
    assert not nav.ready


def test_duplicate_state_never_renews_pair_receipt_and_cache_is_bounded():
    nav, clock = adapter()
    state(nav, 0.)
    tf(nav, clock, 0.)
    tf(nav, clock, .1)
    state(nav, .1)
    original = nav.odom_at
    clock.t = .30001
    state(nav, .1)
    nav.spin()
    assert nav.odom_at == original and not nav.ready
    for i in range(16, 100):
        tf(nav, clock, i*.02)
    assert len(nav.tf_poses) <= 32


@pytest.mark.parametrize('state_first', [False, True])
def test_late_pair_uses_older_receipt_and_never_match_time(state_first):
    nav, clock = adapter()
    state(nav, 0.)
    tf(nav, clock, 0.)
    if state_first:
        clock.t = .1
        state(nav, .1)
        tf(nav, clock, .1)
    else:
        tf(nav, clock, .1)
    clock.t = .19
    if not state_first:
        state(nav, .1)
    nav.spin()
    assert nav.ready and nav.odom_at == .1
    clock.t = .30001
    nav.spin()
    assert not nav.ready

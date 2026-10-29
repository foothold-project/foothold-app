"""Offline geometry/unchanged-policy regression; no ROS/DDS imports."""
import math
import sys
from types import SimpleNamespace

import pytest

from replay_paths import HERE, simulation_parameters, regulated_command
from replay_turns import ANGLES, STARTS, carrot, replay
from foothold_agent.executor.nav2.simulation import SimulationPolicyAdapter


@pytest.fixture
def params():
    return simulation_parameters()


@pytest.mark.parametrize('end', (.001, .05, .3, .8, 1.2, 2.))
@pytest.mark.parametrize('yaw', range(-180, 181, 5))
def test_short_and_long_paths_have_bounded_commands_without_near_stationary_turns(params, end, yaw):
    cx, cy = carrot([(0., 0.), (end, 0.)], 0., 0., params['curvature_lookahead'])
    distance = math.hypot(cx, cy)
    assert distance == pytest.approx(1.2)
    curvature = 2*(-math.sin(math.radians(yaw))*cx+math.cos(math.radians(yaw))*cy)/distance**2
    vx, vy, wz = regulated_command(curvature, params)
    assert .24 <= vx <= .6
    assert vy == 0 and abs(wz) <= .400000000001
    value, reason = SimulationPolicyAdapter.validate((vx, vy, wz))
    if vx >= .4:
        assert (value, reason) == ((vx, vy, wz), 'TESTED')
    else:
        assert (value, reason) == ((0, 0, 0), 'UNSUPPORTED_VELOCITY')


@pytest.mark.parametrize('angle', ANGLES)
def test_heading_and_position_fixtures_use_real_latch_and_keep_completion_separate(params, angle):
    for start in STARTS:
        result = replay(start, angle, params)
        if abs(angle) in (60, 90, 135):
            assert result['latch_count'] == 1
            assert result['assessment']['first_latched_rejection_index'] == 0
            assert not result['model_completed']
        else:
            assert result['latch_count'] == 0
            assert result['assessment']['first_latched_rejection_index'] is None
        assert result['max_abs_wz'] <= .400000000001
        assert .24 <= result['min_moving_vx'] <= .6
        if angle in (0, 30, -30):
            assert result['model_completed']
        if angle == 180:
            assert not result['model_completed']


def test_low_speed_rejection_precedes_stateful_yaw_success(params):
    result = replay((0., 0.), 60, params)
    assert result['nav_stateful_successes'] == 0
    assert result['latch_count'] == 1
    assert result['assessment']['first_latched_rejection_index'] == 0
    assert result['geometric_goals_reached'] == 0
    assert not result['model_completed']


def test_body_intersection_is_not_reported_as_wall_clear_completion(params):
    result = replay((0., 0.), 0, params, clearance=lambda x, y: -.1)
    assert result['model_completed']
    assert not result['wall_clear_model_completed']
    assert result['failure_reason'] == 'RASTER_BODY_INTERSECTION'


@pytest.mark.parametrize('key', ('use_fixed_curvature_lookahead', 'interpolate_curvature_after_goal',
                                  'use_regulated_linear_velocity_scaling'))
def test_removing_each_required_bound_assumption_is_rejected(key):
    text = (HERE/'nav2_simulation_params.yaml').read_text().replace(key+': true', key+': false')
    with pytest.raises(ValueError):
        simulation_parameters(text)


def test_only_simmgr_launch_selects_overlay_and_default_launch_keeps_physical_profile(monkeypatch):
    import launch_nav2
    from apps.simmgr.nav2_entry import BOOTSTRAP
    class Node:
        def __init__(self, **kw):
            self.kw = kw
    monkeypatch.setenv('FH_NAV2_EXECUTE', '1')
    monkeypatch.setattr('foothold_agent.ros_bridge.config.validate_isolation', lambda: None)
    monkeypatch.setitem(sys.modules, 'launch', SimpleNamespace(LaunchDescription=lambda nodes: nodes))
    monkeypatch.setitem(sys.modules, 'launch_ros.actions', SimpleNamespace(Node=Node))
    assert 'generate_launch_description(simulation=True)' in BOOTSTRAP
    for simulation in (False, True):
        nodes = launch_nav2.generate_launch_description(simulation=simulation)
        controller = next(n for n in nodes if n.kw['name'] == 'controller_server')
        files = [p for p in controller.kw['parameters'] if isinstance(p, str)]
        assert [p.rsplit('/', 1)[-1] for p in files] == (
            ['nav2_params.yaml', 'nav2_simulation_params.yaml'] if simulation else ['nav2_params.yaml'])

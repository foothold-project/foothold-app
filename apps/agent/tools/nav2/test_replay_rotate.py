"""Rotation, goal yaw and progress regression in the ROS-free RPP model."""
import math

import pytest

from replay_paths import simulation_parameters
from replay_turns import ANGLES, STARTS, USER_START, USER_GOALS, replay, rotate_command


@pytest.mark.parametrize('angle', ANGLES)
def test_rotating_fixtures_fail_closed_on_adapter_rejection(angle):
    params = simulation_parameters()
    for start, goals in [(p, ((.8, 0.), (1.6, 0.))) for p in STARTS] + [(USER_START, USER_GOALS)]:
        result = replay(start, angle, params, rotate=True, goals=goals)
        # This overlay still generates sub-.4 speeds or in-place rotations.
        rejected = (abs(angle) >= 60 or start == USER_START
                    or (angle == 30 and start == (0., -.2))
                    or (angle == -30 and start == (0., .2)))
        assert result['latch_count'] == int(rejected)
        if rejected:
            assert result['assessment']['first_latched_rejection_index'] is not None
            assert result['assessment']['counts']['UNSUPPORTED_VELOCITY'] >= 1
        else:
            assert result['assessment']['first_latched_rejection_index'] is None
        assert result['max_abs_wz'] <= .400000000001
        assert result['model_completed'] is not rejected
        assert not result['progress_failed']
        if abs(angle) >= 135:
            assert result['rotation_samples']['path'] > 0


@pytest.mark.parametrize('goal_yaw', (math.pi/2, -math.pi/2))
def test_goal_heading_in_place_rotation_is_rejected_inside_xy(goal_yaw):
    result = replay((0., 0.), 0, simulation_parameters(), rotate=True,
                    goals=((.8, 0.),), goal_yaws=(goal_yaw,))
    assert not result['model_completed']
    assert result['latch_count'] == 1
    assert result['rotation_samples']['goal'] > 0
    assert abs(result['final_pose'][0]-.8) <= .3
    assert abs(result['final_pose'][1]) < 1e-12


def test_rotation_is_rejected_before_progress_timeout():
    params = {**simulation_parameters(), 'progress_timeout': .1}
    result = replay((0., 0.), 180, params, rotate=True)
    assert not result['progress_failed']
    assert result['assessment']['first_latched_rejection_index'] == 0
    assert not result['model_completed']
    assert result['final_pose'][:2] == (0., 0.)


def test_official_rotation_acceleration_and_braking_formula():
    params = simulation_parameters()
    assert rotate_command(1., 0., params) == (0., 0., .04)
    assert rotate_command(-1., 0., params) == (0., 0., -.04)
    assert rotate_command(1., .4, params) == (0., 0., .4)
    assert rotate_command(.001, .4, params)[2] == pytest.approx(.04)


@pytest.mark.parametrize('key', ('use_rotate_to_heading',))
def test_rotation_profile_cannot_silently_drop_required_parameters(key):
    from replay_paths import HERE
    text = (HERE/'nav2_simulation_params.yaml').read_text().replace(key+': true', key+': false')
    with pytest.raises(ValueError):
        simulation_parameters(text)

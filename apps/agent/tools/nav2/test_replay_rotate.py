"""Rotation, goal yaw and progress regression in the ROS-free RPP model."""
import math

import pytest

from replay_paths import simulation_parameters
from replay_turns import ANGLES, STARTS, USER_START, USER_GOALS, replay, rotate_command


@pytest.mark.parametrize('angle', ANGLES)
def test_rotating_fixtures_pass_real_executor_without_hiding_progress_failure(angle):
    params = simulation_parameters()
    for start, goals in [(p, ((.8, 0.), (1.6, 0.))) for p in STARTS] + [(USER_START, USER_GOALS)]:
        result = replay(start, angle, params, rotate=True, goals=goals)
        assert result['latch_count'] == 0
        assert result['assessment']['first_latched_rejection_index'] is None
        assert result['max_abs_wz'] <= .400000000001
        assert result['model_completed']
        assert not result['progress_failed']
        if abs(angle) >= 135:
            assert result['rotation_samples']['path'] > 0


@pytest.mark.parametrize('goal_yaw', (math.pi/2, -math.pi/2))
def test_goal_heading_rotates_in_place_and_finishes_inside_xy(goal_yaw):
    result = replay((0., 0.), 0, simulation_parameters(), rotate=True,
                    goals=((.8, 0.),), goal_yaws=(goal_yaw,))
    assert result['model_completed']
    assert result['rotation_samples']['goal'] > 0
    assert abs(result['final_pose'][0]-.8) <= .3
    assert abs(result['final_pose'][1]) < 1e-12


def test_rotation_keeps_progress_timeout_instead_of_reporting_false_completion():
    params = {**simulation_parameters(), 'progress_timeout': .1}
    result = replay((0., 0.), 180, params, rotate=True)
    assert result['progress_failed']
    assert result['failure_reason'] == 'PROGRESS_TIMEOUT'
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

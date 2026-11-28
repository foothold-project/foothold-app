"""SimCatalog.max_robots: MuJoCo local runs up to 8 robots (app-design-lx 11/28 12:27); 9 is refused."""
import pytest
from pydantic import ValidationError

from apps.contracts.models import SimCatalog


def catalog(n):
    return dict(worlds=[], slots=[], max_robots=n, launcher='mujoco-local')


@pytest.mark.parametrize('n', [1, 2, 3, 4, 8])
def test_up_to_eight_robots(n):
    assert SimCatalog.model_validate(catalog(n)).max_robots == n


@pytest.mark.parametrize('n', [0, 9])
def test_zero_and_nine_refused(n):
    with pytest.raises(ValidationError):
        SimCatalog.model_validate(catalog(n))


def robot_row(remaining):
    return dict(robot_id='3fd5a7d0-6b5e-5c2a-9719-56de1b331748', owner_id='3fd5a7d0-6b5e-5c2a-9719-56de1b331748',
                generation=1, world_id='plant_a', simulation=True, state='RUNNING', agent_address='127.0.0.1:1',
                namespace='n', tf_prefix='t', command_topic='c', launcher='mujoco-local', remaining_s=remaining)


def test_sim_robot_remaining_up_to_a_day():
    """MuJoCo local runtime goes to 86400 s (app-design-lx 11/28 13:32); the response must carry it."""
    from apps.contracts.models import SimRobot
    assert SimRobot.model_validate(robot_row(86400)).remaining_s == 86400
    with pytest.raises(ValidationError):
        SimRobot.model_validate(robot_row(86401))

"""SimCatalog.max_robots: MuJoCo local runs up to 4 robots (demo-day 11/28); 5 is refused."""
import pytest
from pydantic import ValidationError

from apps.contracts.models import SimCatalog


def catalog(n):
    return dict(worlds=[], slots=[], max_robots=n, launcher='mujoco-local')


@pytest.mark.parametrize('n', [1, 2, 3, 4])
def test_up_to_four_robots(n):
    assert SimCatalog.model_validate(catalog(n)).max_robots == n


@pytest.mark.parametrize('n', [0, 5])
def test_zero_and_five_refused(n):
    with pytest.raises(ValidationError):
        SimCatalog.model_validate(catalog(n))

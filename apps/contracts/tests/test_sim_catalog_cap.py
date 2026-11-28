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

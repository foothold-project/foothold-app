"""Screen accepts exact trial SI tuples while other axes stay normalized."""
from uuid import uuid4
import pytest
from jsonschema import Draft202012Validator
from apps.contracts import models as C
from apps.contracts.server_drive import ALLOWED


def frame(axes):
    return dict(t='cmd',id='fake-speed',robot=str(uuid4()),lease_id=str(uuid4()),seq=0,axes=axes)


@pytest.mark.parametrize('axes',[list(value) for value in ALLOWED])
def test_exact_server_speed_table_matches_wire_schema(axes):
    value=frame(axes)
    assert C.ScreenCmd.model_validate(value).axes==axes
    Draft202012Validator(C.ScreenCmd.model_json_schema()).validate(value)


@pytest.mark.parametrize('axes',[[1.2,0,0],[1.5,1.5,0],[-1.5,0,.5],[1.50001,0,0],[True,0,0]])
def test_non_normalized_non_table_values_are_rejected(axes):
    value=frame(axes)
    with pytest.raises(ValueError):C.ScreenCmd.model_validate(value)
    if axes != [True,0,0]:
        assert not Draft202012Validator(C.ScreenCmd.model_json_schema()).is_valid(value)

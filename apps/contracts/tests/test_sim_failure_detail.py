"""Additive diagnostic reasons retain the existing strict, bounded wire shape."""
import pytest
from pydantic import ValidationError
from apps.contracts.models import SimFailureDetail


@pytest.mark.parametrize('reason',['resources_low','manager_unreachable','slot_busy','unknown','guard_access'])
def test_sim_failure_reason_compatibility(reason):
    detail=SimFailureDetail(reason=reason,start_not_created=True)
    assert detail.model_dump(exclude_none=True)==dict(reason=reason,start_not_created=True)


def test_guard_diagnostic_does_not_expand_payload_or_coerce_proof():
    with pytest.raises(ValidationError):SimFailureDetail(reason='guard_access',errno=13)
    with pytest.raises(ValidationError):SimFailureDetail(reason='guard_access',start_not_created='true')

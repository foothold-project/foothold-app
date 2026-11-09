"""Place purpose is explicit in responses and immutable in name patches."""
from uuid import uuid4

import pytest
from pydantic import ValidationError
from apps.contracts import models as C


def test_site_create_defaults_and_purpose_values():
    assert C.SiteCreate(name='실기 장소').purpose == 'REAL'
    assert C.SiteCreate(name='시뮬 장소', purpose='SIM').purpose == 'SIM'
    for value in ('OTHER', '', None):
        with pytest.raises(ValidationError):
            C.SiteCreate(name='장소', purpose=value)
    with pytest.raises(ValidationError):
        C.MapName(name='장소', purpose='SIM')


def test_site_response_requires_purpose_and_tree_carries_it():
    with pytest.raises(ValidationError):
        C.MapSite(id=uuid4(), name='장소')
    site = C.MapSite(id=uuid4(), name='장소', purpose='SIM')
    assert C.SiteTree(items=[site]).model_dump(mode='json')['items'][0]['purpose'] == 'SIM'

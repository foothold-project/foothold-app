"""Bound recovery pages independently of the unchanged agent delta contract."""
from uuid import uuid4

import pytest
from pydantic import ValidationError

from apps.contracts.models import (MAX_SAFE_INTEGER, MAPPING_VOXEL_PAGE_BYTES,
    MAPPING_VOXEL_PAGE_CELLS, MappingVoxelChange, MappingVoxelPage)


def test_worst_case_page_fits_byte_ceiling_and_rejects_extra_changes():
    change = MappingVoxelChange(cell=(-200000, -200000, -200000), seq=MAX_SAFE_INTEGER)
    body = dict(session_id=uuid4(), revision=MAX_SAFE_INTEGER, seq=MAX_SAFE_INTEGER,
        reset=False, reset_seq=MAX_SAFE_INTEGER, frame_id='界' * 80,
        added=[change] * MAPPING_VOXEL_PAGE_CELLS, removed=[], next_cursor='a' * 1024)
    page = MappingVoxelPage(**body)
    assert len(page.model_dump_json().encode()) <= MAPPING_VOXEL_PAGE_BYTES
    with pytest.raises(ValidationError, match='Voxel page exceeds cell limit'):
        MappingVoxelPage(**{**body, 'removed': [change]})
    with pytest.raises(ValidationError):
        MappingVoxelChange(cell=(200001, 0, 0), seq=1)

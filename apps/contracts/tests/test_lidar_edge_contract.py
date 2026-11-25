import base64

import pytest
from pydantic import ValidationError

from apps.contracts.models import MediaPointCloudHeader
from test_media_execution import POINTS


def test_old_header_is_identical_after_validation_and_serialization():
    assert MediaPointCloudHeader.model_validate(POINTS).model_dump(mode='json') == POINTS


@pytest.mark.parametrize('count', [0, 1, 4000])
def test_optional_edge_bytes_align_with_transmitted_points(count):
    edge = base64.b64encode(bytes([255]) * count).decode()
    header = dict(POINTS, count=count, byte_length=count*12, edge_u8=edge)
    assert MediaPointCloudHeader.model_validate(header).model_dump(mode='json') == header


@pytest.mark.parametrize('edge', [None, 0, [], '!!!', '/w=', '/w===', '/x==', 'AA==\n', '', 'AAAA', 'A'*5337])
def test_malformed_or_mismatched_edges_rejected(edge):
    with pytest.raises(ValidationError):
        MediaPointCloudHeader.model_validate(dict(POINTS, edge_u8=edge))

"""Records tab server gaps (#613): event list counts, retention, clip thumbnail/length."""
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest
from pydantic import ValidationError

from apps.contracts import models as C

AT = datetime(2026, 11, 28, 5, 2, tzinfo=timezone.utc)


def clip(**changes):
    value = dict(clip_id=None, event_id='7', robot_id=str(uuid4()), start_at=AT - timedelta(seconds=10),
                 end_at=AT + timedelta(seconds=5), status='NOT_BUILT', url=None, reason='CLIP_PIPELINE_NOT_BUILT')
    value.update(changes)
    return value


def zero_counts():
    return dict(total=0, category={key: 0 for key in C.CATEGORIES}, severity={'INFO': 0, 'WARN': 0, 'ERROR': 0},
                simulation={'real': 0, 'sim': 0, 'none': 0}, clip={'with_clip': 0, 'without_clip': 0})


def test_previous_event_list_shape_still_valid():
    old = C.EventList.model_validate({'items': [], 'next_cursor': None})
    assert old.counts is None and old.clip_retention_days is None
    assert 'counts' not in C.EventList.model_json_schema()['required']
    assert 'clip_retention_days' not in C.EventList.model_json_schema()['required']


def test_counts_have_every_bucket():
    counts = C.EventCounts.model_validate(zero_counts())
    assert set(counts.category.model_dump()) == set(C.CATEGORIES)
    broken = zero_counts()
    del broken['category']['RUN']
    with pytest.raises(ValidationError):
        C.EventCounts.model_validate(broken)
    negative = zero_counts()
    negative['severity']['WARN'] = -1
    with pytest.raises(ValidationError):
        C.EventCounts.model_validate(negative)


def test_retention_days_positive_or_null():
    assert C.EventList(items=[], next_cursor=None, clip_retention_days=30).clip_retention_days == 30
    with pytest.raises(ValidationError):
        C.EventList(items=[], next_cursor=None, clip_retention_days=0)


def test_clip_thumbnail_and_length_default_null_and_only_when_ready():
    value = C.EventClip(**clip())
    assert value.thumbnail_url is None and value.duration_s is None
    assert 'thumbnail_url' not in C.EventClip.model_json_schema()['required']
    ready = dict(status='READY', clip_id=str(uuid4()), url='/x.mp4', reason=None)
    assert C.EventClip(**clip(**ready, thumbnail_url='/x.jpg', duration_s=15.0)).duration_s == 15.0
    for changes in (dict(thumbnail_url='/x.jpg'), dict(duration_s=15.0), dict(**ready, duration_s=-1)):
        with pytest.raises(ValidationError):
            C.EventClip(**clip(**changes))

"""u07 records contract: event clip, joint-log replay frame, mark-now (05 §8.1)."""
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


def test_clip_window_rule_and_not_built_shape():
    assert (C.CLIP_PRE_S, C.CLIP_POST_S) == (10, 5)
    window = C.clip_window(AT)
    assert window == (AT - timedelta(seconds=10), AT + timedelta(seconds=5))
    assert C.EventClip(**clip()).status == 'NOT_BUILT'


@pytest.mark.parametrize('changes', [
    dict(status='READY'),                                          # READY needs url and clip_id
    dict(status='READY', url='/x.mp4'),                            # READY needs clip_id
    dict(status='NOT_BUILT', reason=None),                         # not built needs a reason
    dict(status='FAILED', reason=None),
    dict(status='PENDING', url='/x.mp4', clip_id=str(uuid4()), reason=None),  # url only when READY
    dict(end_at=AT - timedelta(seconds=11)),                       # end before start
    dict(status='NOT_BUILT', clip_id=str(uuid4())),                # nothing built, nothing to name
])
def test_clip_rejects_inconsistent_states(changes):
    with pytest.raises(ValidationError):
        C.EventClip(**clip(**changes))


def test_clip_ready_and_open_fall_window():
    ready = C.EventClip(**clip(status='READY', clip_id=str(uuid4()), url='/api/v1/x.mp4', reason=None))
    assert ready.url
    # A fall clip stays open (end_at null) until the robot is back up.
    assert C.EventClip(**clip(status='PENDING', end_at=None, reason=None)).end_at is None


def test_clip_policy_by_severity():
    assert C.clip_wanted('ERROR', None) is True
    assert C.clip_wanted('WARN', None) is True      # mark-now itself is the choice
    assert C.clip_wanted('WARN', False) is False
    assert C.clip_wanted('INFO', None) is False
    with pytest.raises(ValueError):
        C.clip_wanted('ERROR', False)                # danger always gets a clip
    with pytest.raises(ValueError):
        C.clip_wanted('INFO', True)                  # info is recorded only


def test_mark_request_defaults_and_policy():
    assert C.RecordMarkRequest().severity == 'WARN'
    assert C.RecordMarkRequest(note='계단 앞 흔들림').note == '계단 앞 흔들림'
    for bad in (dict(severity='ERROR', clip=False), dict(severity='INFO', clip=True),
                dict(note='x' * 201), dict(clip='yes'), dict(extra=1)):
        with pytest.raises(ValidationError):
            C.RecordMarkRequest(**bad)


def frame(**changes):
    value = dict(t=0.0, q=[0.1] * 12, base=dict(xyz=[0, 0, .3], wxyz=[1, 0, 0, 0]), gait='classic')
    value.update(changes)
    return value


def test_joint_log_frame_and_replay():
    assert C.JointLogFrame(**frame()).q == [0.1] * 12
    assert C.JointLogFrame(**frame(gait=None)).gait is None
    replay = C.JointLogReplay(event_id='7', robot_id=str(uuid4()), start_at=AT - timedelta(seconds=10),
        joint_names=list(C.Go2JointName.__args__), rate_hz=50, frames=[frame(), frame(t=.02)])
    assert len(replay.frames) == 2
    for bad in (dict(q=[0.1] * 11), dict(t=-1), dict(t=float('nan')),
                dict(base=dict(xyz=[0, 0], wxyz=[1, 0, 0, 0])), dict(base=dict(xyz=[0, 0, 0], wxyz=[0, 0, 0, 0]))):
        with pytest.raises(ValidationError):
            C.JointLogFrame(**frame(**bad))
    with pytest.raises(ValidationError):  # frames must be time ordered
        C.JointLogReplay(event_id='7', robot_id=str(uuid4()), start_at=AT, joint_names=list(C.Go2JointName.__args__),
                         rate_hz=50, frames=[frame(t=.5), frame(t=.1)])


def test_not_built_codes_and_generated_files():
    assert set(C.RecordsNotBuiltCode.__args__) == {'CLIP_PIPELINE_NOT_BUILT', 'JOINT_LOG_NOT_BUILT'}
    for name in ('EventClip', 'EventClipList', 'JointLogFrame', 'JointLogReplay', 'RecordMarkRequest',
                 'RecordMarkResult', 'RecordsNotBuiltCode', 'ClipStatus'):
        assert name in C.TOP, name
    assert C.RecordMarkRequest in C.REQUEST_MODELS

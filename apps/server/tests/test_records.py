"""u07 records skeleton: mark-now stores a real event; clip/joint-log answer 501 (05 §8.1)."""
from datetime import datetime, timedelta

import pytest

from apps.contracts import models as C
from .test_maps import P, auth


def path(seeded, robot='mine', tail='mark-now'):
    return f"{P}/robots/{seeded['robots'][robot]}/records/{tail}"


def test_mark_now_stores_event_and_reports_clip_not_built(client, seeded):
    headers = auth(client, 'one')
    response = client.post(path(seeded), headers=headers, json={'note': '계단 앞 흔들림'})
    assert response.status_code == 201, response.text
    body = C.RecordMarkResult.model_validate(response.json())
    event, clip = body.event, body.clip
    assert (event.code, event.category, event.severity) == ('RECORD_MARKED', 'RUN', 'WARN')
    assert event.robot_id == seeded['robots']['mine'] and event.user_id == seeded['users']['one']
    assert event.data['note'] == '계단 앞 흔들림' and event.data['clip'] is True
    assert '기록' in event.message
    assert clip.status == 'NOT_BUILT' and clip.reason == 'CLIP_PIPELINE_NOT_BUILT'
    assert clip.url is None and clip.clip_id is None and clip.event_id == event.id
    assert (clip.start_at, clip.end_at) == (event.at - timedelta(seconds=10), event.at + timedelta(seconds=5))
    # Real row in the existing events table, visible through the ordinary records API.
    stored = client.get(f'{P}/events/{event.id}', headers=headers)
    assert stored.status_code == 200 and stored.json() == response.json()['event']


def test_mark_now_info_has_no_clip_and_policy_is_checked(client, seeded):
    headers = auth(client, 'one')
    info = client.post(path(seeded), headers=headers, json={'severity': 'INFO'})
    assert info.status_code == 201, info.text
    assert info.json()['clip'] is None and info.json()['event']['data']['clip'] is False
    danger = client.post(path(seeded), headers=headers, json={'severity': 'ERROR'})
    assert danger.status_code == 201 and danger.json()['clip']['status'] == 'NOT_BUILT'
    quiet = client.post(path(seeded), headers=headers, json={'severity': 'WARN', 'clip': False})
    assert quiet.status_code == 201 and quiet.json()['clip'] is None
    for bad in ({'severity': 'ERROR', 'clip': False}, {'severity': 'INFO', 'clip': True}, {'note': 'x' * 201}):
        refused = client.post(path(seeded), headers=headers, json=bad)  # server-wide body rule: 400 VALIDATION
        assert refused.status_code == 400 and refused.json()['error']['code'] == 'VALIDATION', (bad, refused.text)


def test_mark_now_uses_robot_read_permission(client, seeded):
    assert client.post(path(seeded, 'theirs'), headers=auth(client, 'one'), json={}).status_code == 404
    assert client.post(path(seeded, 'foreign'), headers=auth(client, 'admin'), json={}).status_code == 404
    assert client.post(path(seeded), json={}).status_code == 401
    admin = client.post(path(seeded), headers=auth(client, 'admin'), json={})
    assert admin.status_code == 201, admin.text


@pytest.mark.parametrize('tail, code', [
    ('clips', 'CLIP_PIPELINE_NOT_BUILT'),
    ('clips/00000000-0000-4000-8000-000000000001', 'CLIP_PIPELINE_NOT_BUILT'),
    ('events/1/joint-log', 'JOINT_LOG_NOT_BUILT'),
])
def test_not_built_answers_501_with_reason_after_permission(client, seeded, tail, code):
    own = client.get(path(seeded, tail=tail), headers=auth(client, 'one'))
    assert own.status_code == 501, own.text
    error = C.ApiError.model_validate(own.json()).error
    assert error.code == code and error.message and '\n' not in error.message
    assert client.get(path(seeded, 'theirs', tail), headers=auth(client, 'one')).status_code == 404

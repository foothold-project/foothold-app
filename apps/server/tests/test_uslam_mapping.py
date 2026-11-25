"""Built-in SLAM contract/state/pair persistence with synthetic data, no robot."""
import asyncio
import copy
import json
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from pydantic import ValidationError
from sqlalchemy.orm import Session

from apps.contracts import models as C
from apps.server.fh_server.models import MappingSession, Robot, Upload, MapVersion
from apps.server.fh_server.realtime import Peer
from apps.server.fh_server import uslam_storage
from .test_maps import P, auth, maps  # noqa: F401
from .test_mapping import setup, action  # noqa: F401


def start(s):
    http, headers, floor, rid, rt, peer, _ = s
    peer.last_rx = rt.clock()
    response = http.post(P + f'/robots/{rid}/slam/start', headers=headers,
                         json={'floor_id': floor, 'name': '시험 방'})
    assert response.status_code == 202, response.text
    return response.json()


def bundle(sid):
    # A supported floor plus a column: source XYZ remains in native USLAM axes.
    cells = [(x, y, 0) for x in range(-40, 40) for y in range(-40, 40)]
    cells += [(30, 30, z) for z in range(1, 12)]
    return dict(session_id=sid, revision=1, frame_id='uslam_map', resolution=.05,
        voxels=cells, grid=dict(revision=1, resolution=.05, frame_id='uslam_map',
            origin=[-2, -2, 0], floor_z=0, width=80, height=80, cells=[1] * 6400), robot_save='UNKNOWN')


def post_bundle(s, body):
    http, _, _, rid, rt, peer, _ = s
    peer.last_rx = rt.clock()
    return http.post(P + f'/agent/robots/{rid}/slam/{body["session_id"]}/bundle',
        headers={'authorization': 'Bearer mapping-token'}, json=body)


def report(s, initial, **changes):
    http, _, floor, rid, _, _, _ = s
    body = dict(t='slam.update', session_id=initial['session_id'], floor_id=floor,
        status='RUNNING', phase='STARTED', revision=1, update_seq=1, command_id=initial['command_id'])
    body.update(changes)
    return http.post(P + f'/agent/robots/{rid}/slam/{initial["session_id"]}/progress',
                     headers={'authorization': 'Bearer mapping-token'}, json=body)


def current(s):
    http, headers, _, rid, _, _, _ = s
    return http.get(P + f'/robots/{rid}/slam', headers=headers).json()


def test_start_ack_sequence_revision_and_motion_independence(setup):
    s = setup
    http, headers, floor, rid, rt, peer, engine = s
    initial = start(s)
    assert initial['status'] == 'STARTING' and initial['phase'] == 'START_REQUESTED'
    assert initial['times']['server_received_at'] and initial['times']['start_requested_at']
    assert not rt.field_approved(rid)  # no movement approval or lease
    assert http.post(P + f'/robots/{rid}/slam/start', headers=headers, json={'floor_id': floor}).status_code == 409
    command = next(x for x in peer.queue._queue if x.get('t') == 'slam')
    assert command['source'] == 'unitree_uslam' and command['command_id'] == initial['command_id']
    assert not rt.blocked_agent_control(peer, command)
    assert rt.blocked_agent_control(peer, {**command, 'source': 'legacy'})
    assert rt.blocked_agent_control(peer, {**command, 'command_id': str(uuid4())})
    assert report(s, initial, command_id=str(uuid4())).status_code == 202
    assert current(s)['status'] == 'STARTING'
    delta = dict(revision=1, seq=1, reset=True, frame_id='uslam_map', added=[[-1, 2, 3]], removed=[])
    assert report(s, initial, voxels=delta).status_code == 202
    assert current(s)['status'] == 'RUNNING'
    assert current(s)['voxels']['added'] == [[-1, 2, 3]]
    assert current(s)['times']['first_data_at']
    assert current(s)['times']['start_ack_at']
    report(s, initial, status='FAILED', phase='FAILED', voxels=delta)  # duplicate seq ignored
    assert current(s)['status'] == 'RUNNING'
    report(s, initial, update_seq=2, revision=2, voxels={**delta, 'seq': 2, 'revision': 2, 'reset': False})
    assert current(s)['revision'] == 1
    report(s, initial, update_seq=2, revision=2, voxels={**delta, 'seq': 2, 'revision': 2})
    assert current(s)['revision'] == 2
    report(s, initial, update_seq=3, revision=2, odom=dict(frame_id='other', source='/uslam/frontend/odom',
        stamp=dict(sec=123, nanosec=456), x=0, y=0, z=0, yaw=0))
    assert current(s)['update_seq'] == 2
    # Reconnection invalidates all queued commands; start is not replayed.
    rt.agents[rid] = Peer(socket=None, last_rx=rt.clock())
    assert not rt.mapping.command_allowed(rid, command)
    assert rt.agents[rid].queue.empty()


def test_pair_roundtrip_retries_hash_and_cancel(setup):
    s = setup
    http, headers, _, rid, rt, peer, engine = s
    initial = start(s)
    sid = initial['session_id']
    body = bundle(sid)
    assert post_bundle(s, body).status_code == 409
    save = action(s, 'save', sid).json()
    assert save['phase'] == 'SAVE_REQUESTED' and save['command_id'] != initial['command_id']
    report(s, initial, update_seq=2)  # old start ack cannot resurrect SAVING
    assert current(s)['status'] == 'SAVING'
    response = post_bundle(s, body)
    assert response.status_code == 201, response.text
    saved = response.json()
    assert saved['status'] == 'SAVED' and saved['robot_save'] == 'UNKNOWN'
    assert saved['terrain_status'] == 'READY' and saved['terrain_id']
    assert saved['times']['saved_at'] and saved['times']['save_requested_at']
    assert post_bundle(s, body).json() == saved
    changed = copy.deepcopy(body)
    changed['grid']['cells'][0] = 2
    assert post_bundle(s, changed).status_code == 409
    prefix = P + f'/robots/{rid}/slam/{sid}/bundle'
    manifest = http.get(prefix, headers=headers).json()
    assert manifest['bundle']['name'] == '시험 방'
    assert manifest['bundle']['resolution'] == .05
    assert manifest['terrain']['source_translation']
    assert http.get(prefix + '/grid', headers=headers).content == bytes(body['grid']['cells'])
    assert len(http.get(prefix + '/voxels', headers=headers).content) == len(set(body['voxels'])) * 12
    assert http.get(prefix, headers=auth(http, 'two')).status_code == 403
    with Session(engine) as db:
        version = db.get(MapVersion, saved['map_version_id'])
        assert version.resolution == .05 and version.origin_x == -2
        image = db.get(Upload, version.upload_id)
        assert image.metadata_json['uslam_bundle']['frame_id'] == 'uslam_map'
    # Late stop acknowledgement does not replace either saved artifact.
    report(s, save, status='FINALIZING', phase='ROBOT_SAVED', update_seq=10)
    late = current(s)
    assert late['status'] == 'SAVED' and late['robot_save'] == 'ROBOT_SAVED'
    assert late['map_version_id'] == saved['map_version_id'] and late['times']['save_ack_at']
    assert post_bundle(s, {**body, 'robot_save': 'ROBOT_SAVED'}).json()['map_version_id'] == saved['map_version_id']
    next_session = start(s)['session_id']
    action(s, 'save', next_session)
    action(s, 'cancel', next_session)
    assert post_bundle(s, bundle(next_session)).status_code == 409


def test_one_artifact_failure_pins_pair_and_optional_terrain_failure(setup, monkeypatch):
    s = setup
    sid = start(s)['session_id']
    action(s, 'save', sid)
    body = bundle(sid)
    original = Path.open
    def broken(path, *args, **kwargs):
        if path.name == 'uslam-grid.bin' and args and args[0] == 'xb':
            raise OSError('synthetic storage failure')
        return original(path, *args, **kwargs)
    with monkeypatch.context() as patch:
        patch.setattr(Path, 'open', broken)
        assert post_bundle(s, body).status_code == 503
    assert current(s)['status'] == 'FAILED'
    altered = copy.deepcopy(body)
    altered['grid']['cells'][0] = 2
    assert post_bundle(s, altered).status_code == 409
    with Session(s[-1]) as db:
        assert db.get(MappingSession, sid).result['map_version_id'] is None
    def no_terrain(*args, **kwargs):
        raise OSError('synthetic terrain failure')
    with monkeypatch.context() as patch:
        patch.setattr(uslam_storage, 'convert', no_terrain)
        response = post_bundle(s, body)
    assert response.status_code == 201, response.text
    assert response.json()['status'] == 'SAVED' and response.json()['terrain_status'] == 'FAILED'
    # Exact retry can recover terrain independently, never replacing the saved map.
    retried = post_bundle(s, body)
    assert retried.json()['map_version_id'] == response.json()['map_version_id']
    assert retried.json()['terrain_status'] == 'READY'


def test_cancel_and_token_rotation_during_bundle_processing(setup, monkeypatch):
    s = setup
    sid = start(s)['session_id']
    action(s, 'save', sid)
    original = uslam_storage.encode
    def cancel(bundle):
        encoded = original(bundle)
        with Session(s[-1]) as db:
            db.get(MappingSession, sid).status = 'CANCELLED'
            db.commit()
        return encoded
    monkeypatch.setattr(uslam_storage, 'encode', cancel)
    assert post_bundle(s, bundle(sid)).status_code == 409
    assert current(s)['status'] == 'CANCELLED'


def test_final_send_rechecks_owner(setup):
    s = setup
    start(s)
    http, _, _, rid, rt, peer, engine = s
    command = next(x for x in peer.queue._queue if x.get('t') == 'slam')
    sent = []
    class Socket:
        async def send_json(self, body):
            sent.append(body)
    peer.socket = Socket()
    with Session(engine) as db:
        db.get(Robot, rid).owner_user_id = None
        db.commit()
    assert not http.portal.call(rt.send_body, peer, command)
    assert not sent


def test_limits_and_legacy_compatibility(setup):
    s = setup
    initial = start(s)
    sid = initial['session_id']
    assert report(s, initial, voxels=dict(revision=1, seq=1, reset=True, frame_id='m',
        added=[[0, 0, 0]] * 2001)).status_code == 422
    http, _, _, rid, _, _, _ = s
    progress_url = P + f'/agent/robots/{rid}/slam/{sid}/progress'
    assert http.post(progress_url, headers={'authorization': 'Bearer mapping-token'}, content=b'x'*65537).status_code == 413
    action(s, 'save', sid)
    url = P + f'/agent/robots/{rid}/slam/{sid}/bundle'
    assert http.post(url, headers={'authorization': 'Bearer mapping-token',
        'content-length': str(C.MAPPING_BUNDLE_BYTES + 1)}, content=b'x').status_code == 413
    assert C.AgentMappingCommand(op='start', session_id=uuid4(), floor_id=uuid4()).model_dump(mode='json').keys() == {'t','op','session_id','floor_id'}
    assert C.AgentMappingUpdate(session_id=uuid4(), floor_id=uuid4(), status='RUNNING').phase is None
    body = bundle(sid)
    body['grid']['revision'] = 2
    assert post_bundle(s, body).status_code == 422
    with pytest.raises(ValidationError):
        C.MappingOdom(source='/utlidar/robot_odom', frame_id='map', stamp=dict(sec=123, nanosec=456), x=0,y=0,z=0,yaw=0)


def test_tiles_persist_paginate_catchup_and_reset(setup):
    s = setup
    initial = start(s)
    http, headers, _, rid, rt, peer, engine = s
    sid = initial['session_id']
    def tile(x, seq=1, value=1, revision=1):
        return dict(revision=revision, tile_seq=seq, x=x, y=-1, frame_id='uslam_map',
                    floor_z=0, cells=[value] * 4096)
    assert report(s, initial, tiles=[tile(i) for i in range(4)]).status_code == 202
    assert report(s, initial, update_seq=2, tiles=[tile(4), tile(5)]).status_code == 202
    url = P + f'/robots/{rid}/slam/{sid}/tiles'
    first = http.get(url, headers=headers, params={'revision': 1}).json()
    assert len(first['tiles']) == 4 and first['update_seq'] == 2
    assert first['next_cursor']
    second = http.get(url, headers=headers, params={'revision': 1, 'cursor': first['next_cursor']}).json()
    assert [t['x'] for t in second['tiles']] == [4, 5] and second['next_cursor'] is None
    # Newly inserted coordinate before the prior cursor is caught by since.
    report(s, initial, update_seq=3, tiles=[tile(-1), tile(0, 2, 2)])
    delta = http.get(url, headers=headers, params={'revision': 1, 'since': 2}).json()
    assert [t['x'] for t in delta['tiles']] == [-1, 0]
    assert delta['tiles'][1]['tile_seq'] == 2 and delta['tiles'][1]['cells'][0] == 2
    report(s, initial, update_seq=4, tiles=[tile(0, 1, 0)])
    assert http.get(url, headers=headers, params={'revision': 1, 'since': 2}).json()['tiles'][1]['cells'][0] == 2
    report(s, initial, update_seq=5, tiles=[{**tile(0, 3), 'frame_id': 'wrong'}])
    assert current(s)['update_seq'] == 4
    # Durable recovery uses a fresh Mapping object, no in-memory tile cache.
    from apps.server.fh_server.mapping import Mapping
    replacement = Mapping(rt, rt.mapping.fail)
    message = C.AgentMappingUpdate(session_id=sid, floor_id=initial['floor_id'], status='RUNNING',
        phase='STARTED', command_id=initial['command_id'], revision=2, update_seq=5, tiles=[tile(7, revision=2)])
    replacement.report(rid, message)
    assert http.get(url, headers=headers, params={'revision': 1}).status_code == 409
    fresh = http.get(url, headers=headers, params={'revision': 2}).json()
    assert [t['x'] for t in fresh['tiles']] == [7]
    assert http.get(url, headers=auth(http, 'two'), params={'revision': 2}).status_code == 403
    assert not rt.field_approved(rid)


def test_bundle_rechecks_rotated_token_and_changed_base(setup, monkeypatch):
    from apps.server.fh_server.models import Floor
    from apps.server.fh_server.security import digest
    s = setup
    initial = start(s)
    sid = initial['session_id']
    action(s, 'save', sid)
    original = uslam_storage.encode
    def rotate(bundle):
        result = original(bundle)
        with Session(s[-1]) as db:
            db.get(Robot, s[3]).agent_token_hash = digest('replacement-test-token')
            db.commit()
        return result
    with monkeypatch.context() as patch:
        patch.setattr(uslam_storage, 'encode', rotate)
        assert post_bundle(s, bundle(sid)).status_code == 403
    with Session(s[-1]) as db:
        db.get(Robot, s[3]).agent_token_hash = digest('mapping-token')
        db.commit()
    assert post_bundle(s, bundle(sid)).status_code == 201
    second = start(s)['session_id']
    action(s, 'save', second)
    with Session(s[-1]) as db:
        db.get(Floor, s[2]).approved_version_id = None
        db.commit()
    assert post_bundle(s, bundle(second)).status_code == 409


def test_cross_robot_and_organization_progress_rejected(setup, seeded):
    s = setup
    initial = start(s)
    http, headers, floor, rid, _, _, _ = s
    foreign = str(seeded['robots']['foreign'])
    assert http.post(P + f'/robots/{foreign}/slam/start', headers=headers,
        json={'floor_id': floor}).status_code == 404
    assert http.post(P + f'/agent/robots/{rid}/slam/{initial["session_id"]}/progress',
        headers={'authorization': 'Bearer ' + foreign}, json={}).status_code == 403


def test_unknown_save_can_preserve_pair_and_accept_late_ack(setup):
    s = setup
    initial = start(s)
    sid = initial['session_id']
    save = action(s, 'save', sid).json()
    report(s, save, status='UNKNOWN', phase='UNKNOWN', update_seq=1)
    assert current(s)['status'] == 'UNKNOWN'
    report(s, save, status='RUNNING', phase='STARTED', update_seq=2)
    assert current(s)['status'] == 'UNKNOWN'
    response = post_bundle(s, bundle(sid))
    assert response.status_code == 201 and response.json()['robot_save'] == 'UNKNOWN'
    report(s, save, status='FINALIZING', phase='ROBOT_SAVED', update_seq=3)
    assert current(s)['status'] == 'SAVED' and current(s)['robot_save'] == 'ROBOT_SAVED'

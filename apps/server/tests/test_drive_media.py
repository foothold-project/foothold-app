"""Observation uploads/receive-only viewers cannot bypass robot ACLs or command."""
import asyncio
import base64
from dataclasses import replace
from datetime import datetime,timezone
import struct
import time
from uuid import uuid4

import pytest
from starlette.websockets import WebSocketDisconnect

from .test_server_drive import trial as drive_trial
from .test_realtime import agent, app_token, receive


@pytest.fixture
def trial(drive_trial, monkeypatch):
    # Isolate media payload/ACL tests from the control socket's liveness timer.
    monkeypatch.setattr(drive_trial.app.state.realtime, 'field_approved', lambda rid: True)
    return drive_trial


# Synthetic 64x36 black JPEG; server tests need no image codec dependency.
JPEG = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAkAEADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD5/ooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigD//Z'


def frame(rid,channel='rgb',seq=1):
    header=dict(version='media/1',robot=str(rid),epoch=123,episode_id=None,channel=channel,
        seq=seq,captured_at=datetime.now(timezone.utc).isoformat())
    if channel in ('rgb','depth'):
        header.update(t='media.video',source='go2_depth' if channel=='depth' else 'go2_front',frame='go2_front_camera',
            mime='image/jpeg',width=64,height=36,jpeg=JPEG)
        if channel=='depth': header.update(depth_min_m=.2, depth_max_m=5.)
    else:
        header.update(t='media.points',source='l1',frame='lidar_link',map_version_id=None,pose=None,
            count=1,truncated=False,encoding='xyz_f32le',byte_length=12)
    return header


def upload(client,rid,header,points=None,token=None):
    return client.post('/api/v1/agent/drive-media/'+header.get('channel','rgb'),headers={
        'authorization':'Bearer '+(token or 'fake-test-'+str(rid))},
        json={'header':header,'points':None if points is None else base64.b64encode(points).decode()})


@pytest.mark.parametrize('edge', [None, 'AP8='])
def test_lidar_optional_edges_and_legacy_header_relay_unchanged(trial, seeded, edge):
    rid = seeded['robots']['mine']
    header = frame(rid, 'lidar')
    header.update(count=2, byte_length=24)
    if edge is not None:
        header['edge_u8'] = edge
    payload = struct.pack('<ffffff', 1., 2., 3., 4., 5., 6.)
    with trial.websocket_connect(f'/api/v1/robots/{rid}/drive-media/lidar', headers=app_token(trial)) as viewer:
        receive(viewer, 'media.status')
        assert upload(trial, rid, header, payload).status_code == 202
        got = receive(viewer, 'media.points')
        assert got.get('edge_u8') == edge
        assert ('edge_u8' in got) == (edge is not None)
        assert got['count'] == 2 and got['byte_length'] == 24
        assert viewer.receive_bytes() == payload


@pytest.mark.parametrize('edge', [None, 'AAAA', '!!!', '/x=='])
def test_lidar_relay_rejects_invalid_edge_length_or_base64(trial, seeded, edge):
    rid = seeded['robots']['mine']
    header = dict(frame(rid, 'lidar'), edge_u8=edge)
    assert upload(trial, rid, header, struct.pack('<fff', 1., 2., 3.)).status_code == 400


@pytest.mark.parametrize('enabled,listed', [(True, False), (False, True)])
def test_media_follows_server_drive_permission(drive_trial, seeded, monkeypatch, enabled, listed):
    client = drive_trial
    rt = client.app.state.realtime
    rid = seeded['robots']['mine']
    monkeypatch.setattr(rt, 'settings', replace(rt.settings, server_drive_enabled=enabled,
        server_drive_robots=frozenset({rid}) if listed else frozenset()))
    owner = app_token(client)
    path = f'/api/v1/robots/{rid}'

    def check_denied():
        assert client.get(path, headers=owner).json()['server_drive_allowed'] is False
        assert upload(client, rid, frame(rid)).status_code == 403
        with pytest.raises(WebSocketDisconnect) as denied:
            with client.websocket_connect(path + '/drive-media/rgb', headers=owner):
                pytest.fail('ineligible viewer accepted')
        assert denied.value.code == 4403

    check_denied()
    with agent(client, seeded, direct=not enabled) as ws:
        if enabled:
            receive(ws, 'field_approval', predicate=lambda m: m['expires_at'] is not None)
            assert client.get(path, headers=owner).json()['server_drive_allowed'] is True
            with client.websocket_connect(path + '/drive-media/rgb', headers=owner) as viewer:
                assert upload(client, rid, frame(rid)).status_code == 202
                assert receive(viewer, 'media.video')['robot'] == str(rid)
        else:
            check_denied()
    check_denied()


@pytest.mark.parametrize('case', ['valid', 'missing-pose', 'map-version', 'map-frame'])
def test_odom_scan_relay_requires_pose_and_never_claims_map(trial, seeded, case):
    rid = seeded['robots']['mine']
    header = frame(rid, 'lidar')
    header.update(frame='odom', pose=dict(x=1., y=2., z=.3, yaw=.5))
    if case == 'missing-pose': header['pose'] = None
    if case == 'map-version': header['map_version_id'] = str(uuid4())
    if case == 'map-frame':
        header.update(frame='map', map_version_id=str(uuid4()))
    points = struct.pack('<fff', 3., 4., 5.)
    with trial.websocket_connect(f'/api/v1/robots/{rid}/drive-media/lidar', headers=app_token(trial)) as viewer:
        receive(viewer, 'media.status')
        result = upload(trial, rid, header, points)
        assert result.status_code == (202 if case == 'valid' else 400)
        if case == 'valid':
            got = receive(viewer, 'media.points')
            assert got['frame'] == 'odom' and got['pose'] == header['pose']
            assert got['map_version_id'] is None and viewer.receive_bytes() == points
    assert str(rid) not in trial.app.state.realtime.arbiter.robots


def test_three_channels_relay_media_one_without_control_socket(trial,seeded):
    rid=seeded['robots']['mine']; headers=app_token(trial)
    for channel in ('rgb','lidar','depth'):
        path=f'/api/v1/robots/{rid}/drive-media/{channel}'
        with trial.websocket_connect(path,headers=headers) as viewer:
            assert receive(viewer,'media.status')['episode_id'] is None
            header=frame(rid,channel); points=struct.pack('<fff',1,2,3) if channel=='lidar' else None
            assert upload(trial,rid,header,points).status_code==202
            received=receive(viewer,header['t'])
            assert received['robot']==str(rid) and received['epoch']==123
            if channel=='depth':
                assert received['depth_min_m']==.2 and received['depth_max_m']==5.
            if channel=='lidar': assert viewer.receive_bytes()==points
            # No fresh upload => bounded stale status, not a fabricated last image.
            assert receive(viewer,'media.status')['state'] in ('NO_VIDEO','NO_POINTS')


@pytest.mark.parametrize('channel',['rgb','depth'])
@pytest.mark.parametrize('case',['other-owner','foreign-robot','bad-origin','outside-list'])
def test_media_viewer_authentication_and_robot_scope(trial,seeded,case,channel):
    rid=seeded['robots']['mine']; headers=app_token(trial)
    path=f'/api/v1/robots/{rid}/drive-media/{channel}'
    if case=='other-owner': headers=app_token(trial,'two')
    elif case=='foreign-robot': path=f"/api/v1/robots/{seeded['robots']['foreign']}/drive-media/{channel}"
    elif case=='outside-list': path=f"/api/v1/robots/{seeded['robots']['theirs']}/drive-media/{channel}"; headers=app_token(trial,'two')
    elif case=='bad-origin': headers={'origin':'https://untrusted.invalid'}
    with pytest.raises(WebSocketDisconnect):
        with trial.websocket_connect(path,headers=headers): pass


@pytest.mark.parametrize('bad',['binding','oversize','rate','points','command','token','raster','replay'])
def test_invalid_observation_rejected_without_touching_arbiter(trial,seeded,bad):
    rid=seeded['robots']['mine']; channel='lidar' if bad=='points' else 'rgb'
    header=frame(rid,channel); points=None; token=None
    if bad=='binding': header['robot']=str(uuid4())
    if bad=='command': header={'t':'cmd','axes':[.4,0,0]}
    if bad=='oversize': header['jpeg']='A'*100000
    if bad=='points': points=b'wrong'
    if bad=='token': token='fake-wrong-token'
    if bad=='raster': header['width']=65
    if bad in ('rate','replay'):
        assert upload(trial,rid,header).status_code==202
        if bad=='replay': time.sleep(.21)
    result=upload(trial,rid,header,points,token)
    assert result.status_code in (400,403,413,429), result.text
    assert str(rid) not in trial.app.state.realtime.arbiter.robots


def test_viewer_is_receive_only_and_queue_is_latest_one(trial,seeded):
    rid=seeded['robots']['mine']; path=f'/api/v1/robots/{rid}/drive-media/rgb'
    with trial.websocket_connect(path,headers=app_token(trial)) as viewer:
        receive(viewer,'media.status')
        viewer.send_json({'t':'cmd','axes':[.4,0,0]})
        with pytest.raises(WebSocketDisconnect): viewer.receive_json()
    relay=trial.app.state.realtime.drive_media
    async def bounded():
        key=str(rid),'rgb'; queue=asyncio.Queue(maxsize=1); relay.viewers[key]={queue}
        try:
            for seq in range(100): relay.publish(key,{'seq':seq})
            assert queue.qsize()==1 and (await queue.get())[1]['seq']==99
            class Slow:
                async def send_json(self,value): await asyncio.Event().wait()
            queue.put_nowait((time.monotonic(),{},None))
            with pytest.raises(asyncio.TimeoutError): await relay.frames(Slow(),key,queue)
        finally: relay.viewers.pop(key)
    trial.portal.call(bounded)


@pytest.mark.parametrize('channel',['rgb','depth'])
def test_viewer_closes_after_user_lock_and_upload_token_rotation(trial,seeded,channel):
    from sqlalchemy.orm import Session
    from apps.server.fh_server.models import User,Robot
    from apps.server.fh_server.security import digest
    rid=seeded['robots']['mine']
    with trial.websocket_connect(f'/api/v1/robots/{rid}/drive-media/{channel}',headers=app_token(trial)) as viewer:
        receive(viewer,'media.status')
        with Session(trial.app.state.engine) as db:
            db.get(User,seeded['users']['one']).locked=True
            db.get(Robot,rid).agent_token_hash=digest('fake-rotated-token')
            db.commit()
        assert upload(trial,rid,frame(rid,channel)).status_code==403
        with pytest.raises(WebSocketDisconnect): receive(viewer)


def test_duplicate_jpeg_frame_headers_are_rejected_before_browser_decode(trial,seeded):
    rid=seeded['robots']['mine']; header=frame(rid)
    raw=base64.b64decode(header['jpeg']); at=raw.index(b'\xff\xc0')
    length=int.from_bytes(raw[at+2:at+4],'big')
    raw=raw[:at]+raw[at:at+2+length]+raw[at:]
    header['jpeg']=base64.b64encode(raw).decode()
    assert upload(trial,rid,header).status_code==400


@pytest.mark.parametrize('bad',['source','missing-range','negative','reversed','rgb-range','payload','oversize','binding','replay','rate','raster'])
def test_depth_relay_rejects_false_or_invalid_depth(trial,seeded,bad):
    rid=seeded['robots']['mine']; header=frame(rid,'depth'); points=None
    if bad=='source': header['source']='go2_front'
    elif bad=='missing-range': del header['depth_min_m']
    elif bad=='negative': header['depth_min_m']=-1.
    elif bad=='reversed': header['depth_min_m']=6.
    elif bad=='rgb-range': header.update(channel='rgb',source='go2_front')
    elif bad=='payload': points=b'fake'
    elif bad=='oversize': header['jpeg']='A'*100000
    elif bad=='binding': header['robot']=str(uuid4())
    elif bad=='raster': header['width']=65
    elif bad in ('replay','rate'):
        assert upload(trial,rid,header).status_code==202
        if bad=='replay': time.sleep(.21)
    result=upload(trial,rid,header,points)
    assert result.status_code in (400,413,429),result.text
    assert str(rid) not in trial.app.state.realtime.arbiter.robots


def test_unknown_channels_rejected_for_both_agent_and_viewer(trial,seeded):
    rid=seeded['robots']['mine']
    header=frame(rid);header['channel']='unknown'
    assert upload(trial,rid,header).status_code==403
    with pytest.raises(WebSocketDisconnect):
        with trial.websocket_connect(f'/api/v1/robots/{rid}/drive-media/unknown',headers=app_token(trial)): pass


def run_slam_reader(client, rid, channel, monkeypatch):
    """Fake DDS supplies one SDK-shaped sample; route the agent's HTTP bytes into ASGI."""
    from io import BytesIO
    from pathlib import Path
    from threading import Timer
    from types import SimpleNamespace as NS
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[2] / 'agent'))
    from foothold_agent.go2_direct import uslam
    from foothold_agent.go2_direct.media import Publisher, Source

    header = NS(stamp=NS(sec=1, nanosec=0), frame_id='world')
    xyz = struct.pack('<fff', 1., 2., 3.)
    def subscribe(topic, callback, *, odometry=False):
        if topic == uslam.CLOUD:
            callback(NS(header=header, width=4001, height=1, point_step=12, row_step=4001*12,
                        data=xyz*4001, is_bigendian=False,
                        fields=[NS(name=n, offset=i*4, datatype=7, count=1) for i, n in enumerate('xyz')]))
        elif topic == uslam.LOCALIZATION:
            assert odometry
            callback(NS(header=header, child_frame_id='body', pose=NS(pose=NS(
                position=NS(x=1., y=-2., z=.5), orientation=NS(w=1., x=0., y=0., z=0.)))))
        return NS(Close=lambda: None)

    config = NS(robot=rid, approval=NS(robot_serial='fake'), link=NS(
        url='wss://testserver/api/v1/agent/ws', token='fake-test-'+rid))
    publisher = Publisher(config, {}, NS(cloud_bus=NS(subscribe=subscribe)),
                          source_factory=lambda *args: Source(*args, include_depth=False, authorize=lambda *_: None))
    posted = []
    def open_request(request, timeout):
        response = client.post(request.full_url, headers=dict(request.header_items()), content=request.data)
        publisher.source.close()
        assert response.status_code == 202, response.text
        posted.append(request.full_url)
        stream = BytesIO(response.content)
        stream.status = response.status_code
        return stream
    publisher.opener = NS(open=open_request)
    deadline = Timer(3, publisher.source.close)
    deadline.start()
    try:
        uslam.Reader(publisher.source, channel).run()
        assert posted == [publisher.url(channel)]
    finally:
        deadline.cancel()
        publisher.source.close()
        publisher.executor.shutdown()


@pytest.mark.parametrize('channel', ['slam', 'slam_pose'])
def test_slam_upload_to_viewer_and_screen_state(trial, seeded, monkeypatch, channel):
    from apps.server.fh_server import drive_media
    monkeypatch.setattr(drive_media, 'SLAM_TTL', .3)
    rid = str(seeded['robots']['mine'])
    rt = trial.app.state.realtime
    header = dict(version='media/1', robot=rid, epoch=3, episode_id=None, channel=channel,
                  seq=1, captured_at=datetime.now(timezone.utc).isoformat(), frame='world')
    payload = None
    if channel == 'slam':
        header.update(t='media.slam_points', source='rt/uslam/frontend/cloud_world_ds',
                      count=4000, truncated=True, encoding='xyz_f32le', byte_length=48000)
        payload = struct.pack('<fff', 1., 2., 3.) * 4000
    else:
        header.update(t='media.slam_pose', source='rt/uslam/localization/odom', child_frame='body',
                      pose=dict(x=1., y=-2., z=.5, yaw=.25))
    with trial.websocket_connect(f'/api/v1/robots/{rid}/drive-media/{channel}', headers=app_token(trial)) as viewer:
        assert receive(viewer, 'media.status')['state'] == 'NO_SLAM'
        assert upload(trial, rid, header, payload, token='wrong-token').status_code == 403
        assert upload(trial, rid, header, b'invalid').status_code == 400
        run_slam_reader(trial, rid, channel, monkeypatch)
        received = receive(viewer, header['t'])
        assert received['source'] == header['source'] and received['frame'] == 'world'
        if payload is None:
            assert received['pose'] == dict(x=1., y=-2., z=.5, yaw=0.)
            assert rt.screen_state(rid)['slam_pose'] == received
            monkeypatch.setattr(rt, 'field_approved', lambda _: False)
            assert 'slam_pose' not in rt.screen_state(rid)
            monkeypatch.setattr(rt, 'field_approved', lambda _: True)
        else:
            assert received['count'] == 4000 and received['byte_length'] == 48000 and received['truncated']
            assert viewer.receive_bytes() == payload
        status = receive(viewer, 'media.status')
        assert status['state'] == 'NO_SLAM' and status['reason'] == 'SLAM 자료 없음'
        assert 'slam_pose' not in rt.screen_state(rid)
    assert rid not in rt.arbiter.robots

"""Observation uploads/receive-only viewers cannot bypass robot ACLs or command."""
import asyncio
import base64
from datetime import datetime,timezone
import struct
import time
from uuid import uuid4

import pytest
from starlette.websockets import WebSocketDisconnect

from .test_server_drive import trial
from .test_realtime import app_token, receive


# Synthetic 64x36 black JPEG; server tests need no image codec dependency.
JPEG = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAkAEADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD5/ooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigD//Z'


def frame(rid,channel='rgb',seq=1):
    header=dict(version='media/1',robot=str(rid),epoch=123,episode_id=None,channel=channel,
        seq=seq,captured_at=datetime.now(timezone.utc).isoformat())
    if channel=='rgb':
        header.update(t='media.video',source='go2_front',frame='go2_front_camera',
            mime='image/jpeg',width=64,height=36,jpeg=JPEG)
    else:
        header.update(t='media.points',source='l1',frame='lidar_link',map_version_id=None,pose=None,
            count=1,truncated=False,encoding='xyz_f32le',byte_length=12)
    return header


def upload(client,rid,header,points=None,token=None):
    return client.post('/api/v1/agent/drive-media/'+header.get('channel','rgb'),headers={
        'authorization':'Bearer '+(token or 'fake-test-'+str(rid))},
        json={'header':header,'points':None if points is None else base64.b64encode(points).decode()})


def test_two_channels_relay_media_one_without_control_socket(trial,seeded):
    rid=seeded['robots']['mine']; headers=app_token(trial)
    for channel in ('rgb','lidar'):
        path=f'/api/v1/robots/{rid}/drive-media/{channel}'
        with trial.websocket_connect(path,headers=headers) as viewer:
            assert receive(viewer,'media.status')['episode_id'] is None
            header=frame(rid,channel); points=struct.pack('<fff',1,2,3) if channel=='lidar' else None
            assert upload(trial,rid,header,points).status_code==202
            received=receive(viewer,header['t'])
            assert received['robot']==str(rid) and received['epoch']==123
            if channel=='lidar': assert viewer.receive_bytes()==points
            # No fresh upload => bounded stale status, not a fabricated last image.
            assert receive(viewer,'media.status')['state'] in ('NO_VIDEO','NO_POINTS')


@pytest.mark.parametrize('case',['other-owner','foreign-robot','bad-origin','outside-list'])
def test_media_viewer_authentication_and_robot_scope(trial,seeded,case):
    rid=seeded['robots']['mine']; headers=app_token(trial)
    path=f'/api/v1/robots/{rid}/drive-media/rgb'
    if case=='other-owner': headers=app_token(trial,'two')
    elif case=='foreign-robot': path=f"/api/v1/robots/{seeded['robots']['foreign']}/drive-media/rgb"
    elif case=='outside-list': path=f"/api/v1/robots/{seeded['robots']['theirs']}/drive-media/rgb"; headers=app_token(trial,'two')
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


def test_viewer_closes_after_user_lock_and_upload_token_rotation(trial,seeded):
    from sqlalchemy.orm import Session
    from apps.server.fh_server.models import User,Robot
    from apps.server.fh_server.security import digest
    rid=seeded['robots']['mine']
    with trial.websocket_connect(f'/api/v1/robots/{rid}/drive-media/rgb',headers=app_token(trial)) as viewer:
        receive(viewer,'media.status')
        with Session(trial.app.state.engine) as db:
            db.get(User,seeded['users']['one']).locked=True
            db.get(Robot,rid).agent_token_hash=digest('fake-rotated-token')
            db.commit()
        assert upload(trial,rid,frame(rid)).status_code==403
        with pytest.raises(WebSocketDisconnect): receive(viewer)


def test_duplicate_jpeg_frame_headers_are_rejected_before_browser_decode(trial,seeded):
    rid=seeded['robots']['mine']; header=frame(rid)
    raw=base64.b64decode(header['jpeg']); at=raw.index(b'\xff\xc0')
    length=int.from_bytes(raw[at+2:at+4],'big')
    raw=raw[:at]+raw[at:at+2+length]+raw[at:]
    header['jpeg']=base64.b64encode(raw).decode()
    assert upload(trial,rid,header).status_code==400

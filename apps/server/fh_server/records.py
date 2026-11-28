"""u07 records skeleton (05 §8.1): mark-now is a real event row; clip and
joint-log pipelines are not built, so they answer 501 with a reason code.
Nothing here talks to a robot; sim and real robots share the same records."""
from typing import Annotated
from uuid import UUID

from fastapi import Path

from apps.contracts import models as C
from .event_messages import render
from .events_api import event_object
from .models import Event, Robot

CLIP_NOT_BUILT = '사건 영상 만들기는 아직 서버에 없습니다.'
JOINT_LOG_NOT_BUILT = '관절 기록 재생은 아직 서버에 없습니다.'


def install(app, DB, Identity, fail, authorize):
    def readable(db, user, robot_id):
        row = db.get(Robot, robot_id)
        if row is None:
            fail(404, 'NOT_FOUND', '로봇을 찾을 수 없습니다.')
        authorize(user, 'ROBOT_READ', row)
        return row

    @app.post('/api/v1/robots/{robot_id}/records/mark-now', status_code=201, response_model=C.RecordMarkResult)
    def mark_now(robot_id: UUID, body: C.RecordMarkRequest, auth: Identity, db: DB):
        user = auth[0]
        readable(db, user, robot_id)
        wanted = C.clip_wanted(body.severity, body.clip)
        row = render(db, Event(org_id=user.org_id, robot_id=robot_id, user_id=user.id, category='RUN',
            code='RECORD_MARKED', severity=body.severity, data={'note': body.note, 'clip': wanted}))
        db.add(row)
        db.flush()
        event = event_object(row)
        clip = None
        if wanted:
            start, end = C.clip_window(event.at)
            clip = C.EventClip(clip_id=None, event_id=event.id, robot_id=robot_id, start_at=start, end_at=end,
                               status='NOT_BUILT', url=None, reason='CLIP_PIPELINE_NOT_BUILT')
        return C.RecordMarkResult(event=event, clip=clip)

    @app.get('/api/v1/robots/{robot_id}/records/clips', response_model=C.EventClipList)
    def clips(robot_id: UUID, auth: Identity, db: DB):
        readable(db, auth[0], robot_id)
        fail(501, 'CLIP_PIPELINE_NOT_BUILT', CLIP_NOT_BUILT)

    @app.get('/api/v1/robots/{robot_id}/records/clips/{clip_id}', response_model=C.EventClip)
    def clip(robot_id: UUID, clip_id: UUID, auth: Identity, db: DB):
        readable(db, auth[0], robot_id)
        fail(501, 'CLIP_PIPELINE_NOT_BUILT', CLIP_NOT_BUILT)

    @app.get('/api/v1/robots/{robot_id}/records/events/{event_id}/joint-log', response_model=C.JointLogReplay)
    def joint_log(robot_id: UUID, event_id: Annotated[str, Path(pattern=r'^[1-9][0-9]{0,18}$')], auth: Identity, db: DB):
        readable(db, auth[0], robot_id)
        fail(501, 'JOINT_LOG_NOT_BUILT', JOINT_LOG_NOT_BUILT)

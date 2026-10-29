"""Tower requests notify people; only a robot report can confirm STOP application."""
from uuid import UUID
from sqlalchemy import select
from apps.contracts import models as C
from .models import Event, Robot
from .event_messages import render
from .notifications import append_for_event


def find(db, org, request_id):
    return db.scalar(select(Event).where(Event.org_id == org, Event.code == 'STOP_REQUESTED',
        Event.category == 'SAFETY', Event.user_id.is_not(None),
        Event.data['request_id'].astext == str(request_id)))


def response(db, event):
    observed = set(db.scalars(select(Event.code).where(Event.org_id == event.org_id,
        Event.robot_id == event.robot_id, Event.category == 'SAFETY',
        Event.code.in_(['STOP_REQUEST_CONFIRMED', 'STOP_REQUEST_ACKNOWLEDGED', 'STOP_REQUEST_RECEIVED']),
        Event.data['request_id'].astext == event.data['request_id'])))
    status, message = 'REQUESTED', '요청 전달됨 — 실제 정지 확인 아님'
    for code, stage, text in [
            ('STOP_REQUEST_RECEIVED', 'PHONE_RECEIVED', '폰 받음 — 실제 정지 확인 아님'),
            ('STOP_REQUEST_ACKNOWLEDGED', 'HUMAN_CONFIRMED', '사람 확인 — 실제 정지 확인 아님'),
            ('STOP_REQUEST_CONFIRMED', 'STOP_CONFIRMED', '정지 확인')]:
        if code in observed:
            status, message = stage, text
    return C.StopRequestStatus(request_id=event.data['request_id'], robot_id=event.robot_id,
                               status=status, message=message)


def confirm(factory, org, rid, data):
    """Called only for the authenticated robot's dedicated applied report."""
    from .api import lock_organization
    try:
        request_id = UUID(data['request_id'])
    except (KeyError, ValueError, TypeError, AttributeError):
        return
    if (set(data) != {'request_id', 'stop_gen', 'latched', 'applied', 'bridge_confirmed'}
            or data['latched'] is not True or data['bridge_confirmed'] is not True
            or type(data['stop_gen']) is not int or not 0 <= data['stop_gen'] <= C.MAX_SAFE_INTEGER
            or not isinstance(data['applied'], list) or len(data['applied']) != 3
            or not all(type(v) in (int, float) and v == 0 for v in data['applied'])):
        return
    with factory.begin() as db:
        lock_organization(db, org)
        event = find(db, org, request_id)
        if event is None or str(event.robot_id) != rid or response(db, event).status == 'STOP_CONFIRMED':
            return
        confirmed = render(db, Event(org_id=org, robot_id=event.robot_id, category='SAFETY',
            code='STOP_REQUEST_CONFIRMED', severity='INFO',
            data={**event.data, 'stop_gen': data['stop_gen']}))
        db.add(confirmed)
        append_for_event(db, confirmed)


def install(app, DB, Identity, fail):
    def robot(db, user, rid):
        row = db.scalar(select(Robot).where(Robot.org_id == user.org_id, Robot.id == rid,
            Robot.archived_at.is_(None)))
        if row is None:
            fail(404, 'NOT_FOUND', '로봇을 찾을 수 없습니다.')
        return row

    @app.post('/api/v1/robots/{robot_id}/stop-requests', response_model=C.StopRequestStatus, status_code=202)
    def request_stop(robot_id: UUID, body: C.StopRequest, auth: Identity, db: DB):
        from .api import authorize
        user = auth[0]
        authorize(user, 'A')
        row = robot(db, user, robot_id)
        existing = find(db, user.org_id, body.request_id)
        if existing:
            if existing.robot_id != robot_id:
                fail(409, 'VERSION_CONFLICT', '다른 로봇에 사용한 요청 번호입니다.')
            return response(db, existing)
        # Inbox is user-scoped, so every logged-in phone for the recipient sees it.
        from .robots import live_state
        _, state = live_state(app.state.realtime, str(robot_id))
        controller = state.get('controller')
        recipients = {str(row.owner_user_id)} if row.owner_user_id else set()
        if controller:
            recipients.add(controller)
        event = render(db, Event(org_id=user.org_id, robot_id=robot_id, user_id=user.id,
            category='SAFETY', code='STOP_REQUESTED', severity='WARN',
            data={'request_id': str(body.request_id), 'recipients': sorted(recipients)}))
        db.add(event)
        if append_for_event(db, event) == 0:
            fail(409, 'STOP_REQUEST_NO_RECIPIENTS', '받을 폰 사용자가 없음 — 현장에 직접 연락')
        return response(db, event)

    @app.post('/api/v1/robots/{robot_id}/stop-requests/{request_id}/ack', response_model=C.StopRequestStatus)
    def acknowledge_request(robot_id: UUID, request_id: UUID, body: C.StopRequestAck, auth: Identity, db: DB):
        user = auth[0]
        robot(db, user, robot_id)
        event = find(db, user.org_id, request_id)
        if (event is None or event.robot_id != robot_id or str(user.id) not in event.data['recipients']):
            fail(404, 'NOT_FOUND', '정지 요청을 찾을 수 없습니다.')
        code = 'STOP_REQUEST_RECEIVED' if body.stage == 'PHONE_RECEIVED' else 'STOP_REQUEST_ACKNOWLEDGED'
        duplicate = db.scalar(select(Event.id).where(Event.org_id == user.org_id,
            Event.robot_id == robot_id, Event.category == 'SAFETY', Event.code == code,
            Event.data['request_id'].astext == str(request_id)))
        if duplicate is None:
            db.add(render(db, Event(org_id=user.org_id, robot_id=robot_id, user_id=user.id,
                category='SAFETY', code=code, severity='INFO', data=event.data)))
        return response(db, event)

    @app.get('/api/v1/robots/{robot_id}/stop-requests/{request_id}', response_model=C.StopRequestStatus)
    def get_stop_request(robot_id: UUID, request_id: UUID, auth: Identity, db: DB):
        user = auth[0]
        row = robot(db, user, robot_id)
        event = find(db, user.org_id, request_id)
        if (event is None or event.robot_id != robot_id or (user.role != 'ORG_ADMIN'
                and user.id != row.owner_user_id and str(user.id) not in event.data['recipients'])):
            fail(404, 'NOT_FOUND', '정지 요청을 찾을 수 없습니다.')
        return response(db, event)

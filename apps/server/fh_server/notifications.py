"""Durable, recipient-only inbox. Event and notifications commit atomically."""
from typing import Annotated
from uuid import UUID
from fastapi import Query, Response
from sqlalchemy import func, or_, select, tuple_, update
from apps.contracts import models as C
from .events_api import cursor_decode, cursor_encode
from .models import Notification, Robot, User, now

# F-COM-03; emergency execution is connected by its S7 owner.
KINDS = {
    'STOP_REQUESTED': ('STOP_REQUESTED', '정지 요청'),
    'STOP_REQUEST_CONFIRMED': ('STOP_REQUEST_CONFIRMED', '정지 확인'),
    'APPROVAL_REQUESTED': ('APPROVAL_REQUESTED', '결재 요청'),
    'APPROVAL_DECIDED': ('APPROVAL_DECIDED', '결재 결과'),
    'APPROVAL_CANCELED': ('APPROVAL_DECIDED', '결재 취소'),
    'APPROVAL_STALE': ('APPROVAL_DECIDED', '지도 변경으로 승인 불가'),
    'REQUEST': ('LEASE_REQUESTED', '조종권 요청'),
    'AGENT_DISCONNECTED': ('LINK_LOST', '연결 끊김'),
    'LINK_LOST': ('LINK_LOST', '연결 끊김'),
    'SERVER_LINK_LOST': ('LINK_LOST', '연결 끊김'),
    'BATTERY_LOW': ('BATTERY_LOW', '배터리 부족'),
    'ROUTE_DEVIATION': ('ROUTE_DEVIATION', '경로 이탈'),
    'RUN_FAILED': ('RUN_FAILED', '실행 실패'),
    'RUN_COMPLETED': ('RUN_COMPLETED', '실행 완료'),
}


def append_for_event(db, event, *, other_user_id=None):
    definition = KINDS.get(event.code)
    if definition is None:
        return 0
    kind, title = definition
    if event.code == 'APPROVAL_STALE' and event.data.get('approval_kind') == 'SCENARIO_ASSIGNMENT':
        title = '배정 대상 변경으로 승인 불가'
    if kind in ('STOP_REQUESTED', 'STOP_REQUEST_CONFIRMED'):
        recipients = select(User).where(User.id.in_([UUID(v) for v in event.data['recipients']]))
    elif event.code == 'APPROVAL_REQUESTED':
        recipients = select(User).where(User.role == 'ORG_ADMIN')
    elif kind == 'APPROVAL_DECIDED':
        recipients = select(User).where(User.id == UUID(event.data['requester_id']), User.id != event.user_id)
    elif kind == 'LEASE_REQUESTED':
        recipients = select(User).where(User.id == UUID(str(other_user_id))) if other_user_id else select(User).where(False)
    else:
        owner = select(Robot.owner_user_id).where(Robot.org_id == event.org_id,
            Robot.id == event.robot_id, Robot.archived_at.is_(None)).scalar_subquery()
        recipients = select(User).where(or_(User.role == 'ORG_ADMIN', User.id == owner))
    recipients = recipients.where(User.org_id == event.org_id, User.locked.is_(False), User.archived_at.is_(None))
    db.flush()  # event ID is allocated inside the same audit transaction
    inserted = 0
    for user in db.scalars(recipients):
        if not kind.startswith('STOP_REQUEST') and user.notify_prefs.get(kind, True) is False:
            continue
        db.add(Notification(org_id=event.org_id, user_id=user.id, event_id=event.id,
            kind=kind, title=title, body=event.message, link=(f'#/drive?robot_id={event.robot_id}&stop_request_id={event.data["request_id"]}'
                if kind.startswith('STOP_REQUEST') else f'#/approvals?approval_id={event.approval_id}'
                if event.approval_id else f'#/history?event_id={event.id}')))
        inserted += 1
    return inserted


def notification_object(row):
    return C.Notification(id=str(row.id), event_id=str(row.event_id) if row.event_id is not None else None,
        **{key: getattr(row, key) for key in C.Notification.model_fields if key not in ('id', 'event_id')})


def install(app, DB, Identity, fail):
    def own(user):
        return select(Notification).where(Notification.org_id == user.org_id, Notification.user_id == user.id)

    @app.get('/api/v1/notifications', response_model=C.NotificationList)
    def notifications(auth: Identity, db: DB, response: Response,
                      unread: Annotated[int, Query(ge=0, le=1)] = 0,
                      limit: Annotated[int, Query(ge=1, le=100)] = 50, cursor: str | None = None):
        query = own(auth[0])
        count = db.scalar(query.where(Notification.read_at.is_(None)).with_only_columns(func.count()).order_by(None))
        if unread:
            query = query.where(Notification.read_at.is_(None))
        after = cursor_decode(cursor, fail)
        if after:
            query = query.where(tuple_(Notification.created_at, Notification.id) < after)
        rows = list(db.scalars(query.order_by(Notification.created_at.desc(), Notification.id.desc()).limit(limit + 1)))
        more = len(rows) > limit
        rows = rows[:limit]
        response.headers['Cache-Control'] = 'no-store'
        return C.NotificationList(items=[notification_object(row) for row in rows], unread_count=count,
            next_cursor=cursor_encode(rows[-1].created_at, rows[-1].id) if more else None)

    @app.post('/api/v1/notifications/read', status_code=204)
    def read(body: C.NotificationsRead, auth: Identity, db: DB):
        user = auth[0]
        condition = [Notification.org_id == user.org_id, Notification.user_id == user.id]
        if body.ids is not None:
            ids = {int(value) for value in body.ids}
            found = set(db.scalars(select(Notification.id).where(*condition, Notification.id.in_(ids))))
            if found != ids:
                fail(404, 'NOT_FOUND', '알림을 찾을 수 없습니다.')
            condition.append(Notification.id.in_(ids))
        db.execute(update(Notification).where(*condition, Notification.read_at.is_(None)).values(read_at=now()))

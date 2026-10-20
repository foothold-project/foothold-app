"""Read-only event queries: current ownership OR own action, inside one tenant."""
import base64
import csv
from datetime import datetime, timezone
import json
import tempfile
import threading
from typing import Annotated, Literal
from uuid import UUID

from fastapi import Depends, Query, Response
from fastapi.responses import StreamingResponse
from sqlalchemy import or_, select, tuple_
from apps.contracts import models as C
from .models import Event, Robot, User

EXPORT_LIMIT = 10_000
EXPORT_BATCH = 100
EXPORT_SLOT = threading.Lock()


class CSVDownload(StreamingResponse):
    """Own the file and process slot through completion, errors and disconnects."""
    def __init__(self, output):
        self.output = output
        super().__init__(iter(lambda: output.read(64 * 1024), ''),
            media_type='text/csv; charset=utf-8',
            headers={'Content-Disposition': 'attachment; filename="events.csv"', 'Cache-Control': 'no-store'})

    async def __call__(self, scope, receive, send):
        try:
            await super().__call__(scope, receive, send)
        finally:
            self.output.close()
            EXPORT_SLOT.release()


def write_csv(db, query, output):
    output.write('\ufeff')
    writer = csv.writer(output)
    columns = list(C.Event.model_fields)
    writer.writerow(columns)
    for row in db.scalars(query.execution_options(yield_per=EXPORT_BATCH)):
        value = event_object(row).model_dump(mode='json')
        value['data'] = json.dumps(value['data'], ensure_ascii=False)
        writer.writerow([csv_cell(value[column]) for column in columns])
    output.seek(0)


def cursor_decode(value, fail):
    if value is None:
        return None
    try:
        if not value or len(value) > 512:
            raise ValueError('invalid length')
        stamp, identifier = json.loads(base64.b64decode(value.encode(), altchars=b'-_', validate=True))
        at = datetime.fromisoformat(stamp)
        if at.tzinfo is None or not isinstance(identifier, str) or not identifier.isascii() or not identifier.isdecimal():
            raise ValueError('invalid cursor')
        identifier = int(identifier)
        if not 0 < identifier <= 2**63 - 1:
            raise ValueError('invalid ID')
        return at, identifier
    except (ValueError, TypeError, UnicodeError, OverflowError):
        fail(400, 'VALIDATION', '목록 위치가 올바르지 않습니다.')


def cursor_encode(at, identifier):
    return base64.urlsafe_b64encode(json.dumps([at.astimezone(timezone.utc).isoformat(), str(identifier)]).encode()).decode()


def event_object(row):
    return C.Event(id=str(row.id), **{key: getattr(row, key) for key in C.Event.model_fields if key != 'id'})


def visible_events(user):
    query = select(Event).where(Event.org_id == user.org_id)
    if user.role != 'ORG_ADMIN':
        owned = select(Robot.id).where(Robot.org_id == user.org_id,
            Robot.owner_user_id == user.id, Robot.archived_at.is_(None))
        query = query.where(or_(Event.robot_id.in_(owned), Event.user_id == user.id))
    return query


def csv_cell(value):
    value = str(value) if value is not None else ''
    # Spreadsheet importers may strip whitespace before interpreting formulas.
    if value.lstrip().startswith(('=', '+', '-', '@')) or value.startswith(('\t', '\r', '\n')):
        value = "'" + value
    return value


def install(app, DB, Identity, fail):
    def filters(category: C.Category | None = None, severity: Literal['INFO', 'WARN', 'ERROR'] | None = None,
                robot_id: UUID | None = None, user_id: UUID | None = None, run_id: UUID | None = None,
                start: Annotated[C.UTCDateTime | None, Query(alias='from')] = None,
                end: Annotated[C.UTCDateTime | None, Query(alias='to')] = None):
        if start and end and start > end:
            fail(400, 'VALIDATION', '시작 시각은 끝 시각보다 늦을 수 없습니다.')
        return dict(category=category, severity=severity, robot_id=robot_id, user_id=user_id,
                    run_id=run_id, start=start, end=end)

    def filtered(db, user, values):
        query = visible_events(user)
        def missing():
            fail(404, 'NOT_FOUND', '기록을 찾을 수 없습니다.')
        robot_id = values['robot_id']
        if robot_id:
            robot = db.scalar(select(Robot.id).where(Robot.org_id == user.org_id, Robot.id == robot_id))
            # An own action on another robot is visible under the provisional D3 rule.
            if robot is None or (user.role != 'ORG_ADMIN' and not db.scalar(
                    query.where(Event.robot_id == robot_id).with_only_columns(Event.id).limit(1)) and
                    not db.scalar(select(Robot.id).where(Robot.id == robot_id, Robot.org_id == user.org_id,
                        Robot.owner_user_id == user.id, Robot.archived_at.is_(None)))):
                missing()
        if values['user_id'] and not db.scalar(select(User.id).where(
                User.org_id == user.org_id, User.id == values['user_id'])):
            missing()
        # runs does not exist yet; only an already-visible event proves the ID.
        if values['run_id'] and not db.scalar(query.where(Event.run_id == values['run_id']).with_only_columns(Event.id).limit(1)):
            missing()
        for key in ('category', 'severity', 'robot_id', 'user_id', 'run_id'):
            if values[key] is not None:
                query = query.where(getattr(Event, key) == values[key])
        if values['start']:
            query = query.where(Event.at >= values['start'])
        if values['end']:
            query = query.where(Event.at <= values['end'])
        return query.order_by(Event.at.desc(), Event.id.desc())

    @app.get('/api/v1/events', response_model=C.EventList)
    def events(auth: Identity, db: DB, response: Response, values: Annotated[dict, Depends(filters)],
               limit: Annotated[int, Query(ge=1, le=100)] = 50, cursor: str | None = None):
        query = filtered(db, auth[0], values)
        after = cursor_decode(cursor, fail)
        if after:
            query = query.where(tuple_(Event.at, Event.id) < after)
        rows = list(db.scalars(query.limit(limit + 1)))
        more = len(rows) > limit
        rows = rows[:limit]
        response.headers['Cache-Control'] = 'no-store'
        return C.EventList(items=[event_object(row) for row in rows],
            next_cursor=cursor_encode(rows[-1].at, rows[-1].id) if more else None)

    @app.get('/api/v1/events/export.csv')
    def export(auth: Identity, db: DB, values: Annotated[dict, Depends(filters)]):
        if not EXPORT_SLOT.acquire(blocking=False):
            fail(429, 'RATE_LIMITED', '다른 기록을 내보내는 중입니다. 잠시 뒤 다시 시도하세요.')
        output = None
        try:
            query = filtered(db, auth[0], values)
            identifiers = list(db.scalars(query.with_only_columns(Event.id).limit(EXPORT_LIMIT + 1)))
            if len(identifiers) > EXPORT_LIMIT:
                fail(400, 'EXPORT_LIMIT', '기록이 10,000개를 넘습니다. 기간이나 필터를 좁혀 주세요.')
            # Freeze the selected IDs: concurrent INSERTs cannot exceed the checked cap.
            output = tempfile.TemporaryFile(mode='w+', encoding='utf-8', newline='')
            write_csv(db, query.where(Event.id.in_(identifiers)), output)
            db.commit()  # Fail before transferring file/slot ownership to the response.
            return CSVDownload(output)
        except BaseException:
            if output is not None:
                output.close()
            EXPORT_SLOT.release()
            raise

    @app.get('/api/v1/events/{event_id}', response_model=C.Event)
    def detail(event_id: str, auth: Identity, db: DB, response: Response):
        if not event_id.isascii() or not event_id.isdecimal() or len(event_id) > 19 or not 0 < int(event_id) <= 2**63 - 1:
            fail(404, 'NOT_FOUND', '기록을 찾을 수 없습니다.')
        row = db.scalar(visible_events(auth[0]).where(Event.id == int(event_id)))
        if row is None:
            fail(404, 'NOT_FOUND', '기록을 찾을 수 없습니다.')
        response.headers['Cache-Control'] = 'no-store'
        return event_object(row)

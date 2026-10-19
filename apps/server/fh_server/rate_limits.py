"""Durable, mutable counters and one append-only summary per closed window."""
from datetime import timedelta, timezone

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert

from .models import AuthRateWindow, Event
from .security import digest


def window_start(at):
    at = at.astimezone(timezone.utc)
    return at.replace(minute=at.minute // 5 * 5, second=0, microsecond=0)


def record_rate_limit(db, org_id, key_type, key_value, at, *, user_id=None, data=None):
    statement = insert(AuthRateWindow).values(org_id=org_id, key_type=key_type,
        key_hash=digest(key_value).hex(), window_start=window_start(at),
        denied_count=1, user_id=user_id, data=data or {})
    db.execute(statement.on_conflict_do_update(
        index_elements=['org_id', 'key_type', 'key_hash', 'window_start'],
        set_={'denied_count': AuthRateWindow.denied_count + 1}))


def close_rate_windows(db, org_id, at):
    # A bounded batch is drained by subsequent authentication requests. Counters
    # survive restarts, and SKIP LOCKED makes concurrent drainers independent.
    rows = db.scalars(select(AuthRateWindow).where(AuthRateWindow.org_id == org_id,
        AuthRateWindow.window_start < window_start(at)).order_by(
        AuthRateWindow.window_start, AuthRateWindow.key_type, AuthRateWindow.key_hash)
        .limit(100).with_for_update(skip_locked=True)).all()
    for row in rows:
        start = row.window_start.astimezone(timezone.utc)
        password = row.key_type == 'PASSWORD_ACCOUNT'
        code = 'PASSWORD_CHANGE_RATE_LIMITED' if password else 'LOGIN_RATE_LIMITED'
        label = '비밀번호 확인' if password else '로그인'
        db.add(Event(org_id=row.org_id, user_id=row.user_id, category='ACCOUNT', code=code,
            severity='WARN', message=f'{label} 횟수 제한으로 {row.denied_count}회 거절했습니다.',
            data={**row.data, 'key_type': row.key_type, 'count': row.denied_count,
                  'window_start': start.isoformat().replace('+00:00', 'Z'),
                  'window_end': (start + timedelta(minutes=5)).isoformat().replace('+00:00', 'Z')}))
        # Deleting the mutable counter and appending its immutable summary are
        # committed together, so a crash cannot lose or duplicate the summary.
        db.delete(row)

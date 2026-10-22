"""Optional, transactional receipts: the UNIQUE key arbitrates concurrent retries."""
from datetime import timedelta
import hashlib
import json
from typing import Annotated

from fastapi import Header
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert

from apps.contracts.models import IdempotencyKey
from .models import IdempotencyReceipt, now

KeyHeader = Annotated[IdempotencyKey | None, Header(alias='Idempotency-Key')]


def begin(db, user, key, operation, body, fail):
    if key is None:
        return None, None
    fingerprint = hashlib.sha256(json.dumps([operation, body.model_dump(mode='json')],
        sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()).hexdigest()
    # ponytail: 24h retry window; expired rows are reused under lock. Physical
    # deletion of old keys belongs to a future privileged retention job, not fh_app.
    expires = now() + timedelta(hours=24)
    db.execute(insert(IdempotencyReceipt).values(org_id=user.org_id, user_id=user.id,
        key=key, request_hash=fingerprint, expires_at=expires).on_conflict_do_nothing(
            index_elements=['user_id', 'key']))
    row = db.scalar(select(IdempotencyReceipt).where(IdempotencyReceipt.user_id == user.id,
        IdempotencyReceipt.key == key).with_for_update())
    if row.expires_at <= now():
        row.request_hash, row.response, row.status_code, row.expires_at = fingerprint, None, None, expires
    if row.request_hash != fingerprint:
        fail(422, 'IDEMPOTENCY_MISMATCH', '같은 멱등 키에 다른 요청을 사용할 수 없습니다.')
    if row.response is not None:
        return row, JSONResponse(status_code=row.status_code, content=row.response)
    return row, None


def finish(row, value, status=201):
    if row is not None:
        row.response, row.status_code = value.model_dump(mode='json'), status
    return value

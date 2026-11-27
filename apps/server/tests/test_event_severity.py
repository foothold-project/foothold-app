"""#552: failure events are stored at WARN or higher on every server write path."""
import itertools

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session as DBSession

from apps.server.fh_server.leases import Actor, Arbiter, Effect
from apps.server.fh_server.models import Event, now, severity_floor


class Clock:
    at = 0.0
    def __call__(self):
        return self.at


@pytest.mark.parametrize('code, given, stored', [
    ('PHONE_LEASE_TIMEOUT', 'INFO', 'WARN'), ('MAPPING_FAILED', 'INFO', 'WARN'),
    ('NAV_GOAL_REJECTED', None, 'WARN'), ('PHONE_PASS_DENIED', 'INFO', 'WARN'),
    ('MAPPING_FAILED', 'WARN', 'WARN'), ('PHOTO_STORE_FAILED', 'ERROR', 'ERROR'),
    ('PHONE_LEASE_TAKEN', 'INFO', 'INFO'), ('TIMEOUT', 'INFO', 'INFO'),
    ('FAILED_LOGIN_NOTE', 'INFO', 'INFO'), ('PHONE_LEASE_TAKEN', 'WARN', 'WARN'),
    ('STOP_CONFIRM_FAILED', None, 'ERROR'), ('STOP_CONFIRM_FAILED', 'WARN', 'ERROR'), ('MAPPING_FAILED', 'info', 'WARN'),
])
def test_floor_rule_raises_failures_only_and_never_lowers(code, given, stored):
    assert severity_floor(code, given) == stored


def test_stop_confirm_failed_audit_effect_carries_error():
    clock, ids = Clock(), itertools.count()
    arbiter = Arbiter(clock, lambda: str(next(ids)))
    owner, other = Actor('a', 'sa', 'ca'), Actor('b', 'sb', 'cb')
    arbiter.take('r', owner)
    arbiter.state('r', True, [0, 0, 0], 1, stop_ref=1)
    arbiter.request('r', other)
    arbiter.respond('r', owner, arbiter.robot('r').request.id, True)
    clock.at = 2
    audits = [e.body for e in arbiter.tick() if e.target == 'audit' and e.body['op'] == 'STOP_CONFIRM_FAILED']
    assert audits and all(b['severity'] == 'ERROR' for b in audits)


def stored(seeded, code):
    engine = create_engine(seeded['urls']['migrate'])
    with DBSession(engine) as db:
        rows = db.scalars(select(Event.severity).where(Event.code == code)).all()
    engine.dispose()
    return rows


def record(client, seeded, op, **body):
    return client.app.state.realtime.record(Effect('audit', str(seeded['robots']['mine']),
        {'op': op, 'at': now(), **body}))


def test_stop_confirm_failed_without_severity_is_stored_as_error(client, seeded):
    assert record(client, seeded, 'STOP_CONFIRM_FAILED')['severity'] == 'ERROR'
    assert stored(seeded, 'STOP_CONFIRM_FAILED') == ['ERROR']


def test_agent_failure_sent_as_info_is_stored_as_warn_and_other_events_stay_info(client, seeded):
    assert record(client, seeded, 'AGENT_EVENT', code='PHONE_LEASE_TIMEOUT', severity='info')['severity'] == 'WARN'
    assert record(client, seeded, 'AGENT_EVENT', code='MAPPING_FAILED', severity='info')['severity'] == 'WARN'
    assert record(client, seeded, 'AGENT_EVENT', code='RUN_FAILED', severity='error')['severity'] == 'ERROR'
    assert record(client, seeded, 'AGENT_EVENT', code='PHONE_LEASE_TAKEN', severity='info')['severity'] == 'INFO'
    assert stored(seeded, 'PHONE_LEASE_TIMEOUT') == ['WARN']
    assert stored(seeded, 'MAPPING_FAILED') == ['WARN']
    assert stored(seeded, 'RUN_FAILED') == ['ERROR']
    assert stored(seeded, 'PHONE_LEASE_TAKEN') == ['INFO']


def test_direct_event_insert_without_severity_is_raised(seeded):
    engine = create_engine(seeded['urls']['migrate'])
    with DBSession(engine) as db:
        db.add_all([Event(org_id=seeded['org'], category='ACCOUNT', code='SIM_MODEL_REJECTED', message='x', data={}),
                    Event(org_id=seeded['org'], category='ACCOUNT', code='SIM_MAP_REGISTERED', message='x', data={})])
        db.commit()
    engine.dispose()
    assert stored(seeded, 'SIM_MODEL_REJECTED') == ['WARN']
    assert stored(seeded, 'SIM_MAP_REGISTERED') == ['INFO']

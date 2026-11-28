"""#552: failure events from the phone hub leave the robot at WARN or higher."""
from test_phone import h  # noqa: F401  (fixture)


def test_phone_lease_timeout_is_sent_as_warn_and_ordinary_lease_events_stay_info(h):
    a, _ = h.moving()
    b, _, _ = h.connect()
    assert h.send(b, 'lease.request')['ok']
    h.advance(10)
    assert h.hub.drain(b)[0]['result'] == 'TIMEOUT'
    timeout = [e for e in h.events if e.get('code') == 'PHONE_LEASE_TIMEOUT']
    assert timeout and all(e['severity'] == 'warn' for e in timeout)
    ordinary = [e for e in h.events if e.get('code') in ('PHONE_LEASE_TAKEN', 'PHONE_LEASE_REQUESTED')]
    assert ordinary and all(e['severity'] == 'info' for e in ordinary)


def test_phone_hub_raises_any_failure_code_and_keeps_others_info(h):
    for code in ('PHONE_LEASE_FAILED', 'PHONE_LEASE_REJECTED', 'PHONE_PASS_DENIED', 'PHONE_LEASE_DECLINED'):
        h.hub._audit(code)
    severity = {e['code']: e['severity'] for e in h.events if e.get('t', 'event') == 'event' and 'code' in e}
    assert severity['PHONE_LEASE_FAILED'] == severity['PHONE_LEASE_REJECTED'] == severity['PHONE_PASS_DENIED'] == 'warn'
    assert severity['PHONE_LEASE_DECLINED'] == 'info'

"""STOP request metadata never changes the original safety Core contract."""
from uuid import uuid4
from foothold_agent.phone.observer import Observer
from test_phone import h


def test_request_stop_confirms_only_after_new_bridge_stop_and_still_report(h):
    peer, _, _ = h.connect()
    assert h.take(peer)['ok']
    request_id = str(uuid4())
    assert h.send(peer, 'stop', request_id=request_id)['ok']
    assert h.hub.session.core.latch and not any(h.hub.session.core.out)
    h.clock.t += .05
    h.state(stop=False)
    assert not [e for e in h.events if e.get('code') == 'STOP_REQUEST_APPLIED']
    h.clock.t += .05
    h.state(stop=True)
    confirmed = [e for e in h.events if e.get('code') == 'STOP_REQUEST_APPLIED']
    assert len(confirmed) == 1 and confirmed[0]['data']['request_id'] == request_id
    assert confirmed[0]['data']['bridge_confirmed'] is True
    h.clock.t += .05
    h.state(stop=True)
    assert len([e for e in h.events if e.get('code') == 'STOP_REQUEST_APPLIED']) == 1


def test_observer_reports_the_single_phone_controller_and_keeps_legacy_stop_defense(h):
    peer, claims, _ = h.connect()
    assert h.take(peer)['ok']
    observer = Observer(h.hub)
    first = observer._state()
    assert first['controller'] == claims['sub'] and first['controller_device'] == claims['device']
    assert first['controller_connected'] is True and first['controller_since']
    h.clock.t += .1
    assert observer._state()['controller_since'] == first['controller_since']
    observer.receive({'t':'stop'})
    assert h.hub.session.core.latch and not any(h.hub.session.core.out)
    h.hub.disconnect(peer)
    reserved = observer._state()
    assert reserved['controller'] == claims['sub']
    assert reserved['controller_connected'] is False

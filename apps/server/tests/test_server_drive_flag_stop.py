"""Settings-triggered STOP scope and retained-command lifetime, without I/O."""
from types import SimpleNamespace
from uuid import uuid4

import pytest

from apps.server.fh_server.leases import Actor, Arbiter, Holder
from apps.server.fh_server.realtime import Peer, Realtime


@pytest.fixture
def relay():
    realtime = Realtime.__new__(Realtime)
    realtime.settings = SimpleNamespace(org_id=uuid4())
    realtime.clock = lambda: 0
    realtime.arbiter = Arbiter(realtime.clock)
    realtime.owner_uncertain = False
    realtime.field_approved = lambda rid: True
    realtime.robot_changes = set()
    realtime.effect_depth = 0
    realtime.finish_effects = lambda: None
    realtime.screens = {}
    realtime.agents = {}
    records = []
    realtime.note_audit = lambda rid, body: records.append((rid, body))
    actor = Actor(str(uuid4()), str(uuid4()), str(uuid4()))
    rid = str(uuid4())
    peer = Peer(socket=None, server_drive=True)
    realtime.agents[rid] = peer
    realtime.arbiter.robot(rid).holder = Holder(actor, 'fake-lease', 0, 0)
    realtime.apply(realtime.arbiter.cmd(rid, actor, 'fake-lease', 1, [1.5, 0, 0]))
    return realtime, rid, peer, actor, records


def stops(peer):
    return [frame for frame in peer.queue._queue if frame.get('t') == 'stop']


@pytest.mark.parametrize('excluded', ('simulation', 'direct', 'no_holder', 'run', 'closing', 'other_org'))
def test_enable_does_not_stop_outside_active_real_server_user_scope(relay, excluded):
    realtime, rid, peer, actor, records = relay
    org_id = realtime.settings.org_id
    if excluded == 'simulation':
        peer.simulation = True
    elif excluded == 'direct':
        peer.server_drive = False
    elif excluded == 'no_holder':
        realtime.arbiter.robot(rid).holder = None
    elif excluded == 'run':
        realtime.arbiter.robot(rid).holder.holder_type = 'RUN'
    elif excluded == 'closing':
        peer.closing = True
    else:
        org_id = uuid4()
    realtime.stop_fast_server_drives(org_id, actor)
    assert stops(peer) == []
    assert records == []


@pytest.mark.parametrize('transition', ('stop', 'release', 'handoff', 'disconnect',
                                       'screen_disconnect', 'other_screen_disconnect', 'neutral', 'rotation'))
def test_old_translation_cannot_trigger_stop_after_safety_or_input_transition(relay, transition):
    realtime, rid, peer, actor, records = relay
    if transition == 'stop':
        realtime.apply(realtime.arbiter.stop(rid, actor))
    elif transition == 'release':
        realtime.apply(realtime.arbiter.release(rid, actor))
    elif transition == 'handoff':
        realtime.apply(realtime.arbiter.begin(rid, actor))
    elif transition == 'disconnect':
        realtime.agents.pop(rid)
        realtime.apply(realtime.arbiter.revoke(rid, op='EXPIRE'))
        peer = Peer(socket=None, server_drive=True)
        realtime.agents[rid] = peer
    elif transition == 'screen_disconnect':
        realtime.disconnect_pending(actor)
    elif transition == 'other_screen_disconnect':
        realtime.disconnect_pending(Actor(actor.user, actor.session, 'other-connection'))
        assert peer.server_drive_axes == (1.5, 0, 0)
        return
    else:
        axes = [0, 0, 0] if transition == 'neutral' else [0, 0, .5]
        realtime.apply(realtime.arbiter.cmd(rid, actor, 'fake-lease', 2, axes))
    assert not any(peer.server_drive_axes[:2])
    # Give the new/current connection a lease, so scope alone cannot hide a
    # retained old translation after release, transfer or reconnect.
    realtime.arbiter.robot(rid).holder = Holder(actor, 'new-fake-lease', 0, 0)
    before, record_count = len(stops(peer)), len(records)
    realtime.stop_fast_server_drives(realtime.settings.org_id, actor)
    assert len(stops(peer)) == before
    assert len(records) == record_count


def test_enable_discards_pending_movement_and_records_only_one_stop(relay):
    realtime, rid, peer, actor, records = relay
    realtime.stop_fast_server_drives(realtime.settings.org_id, actor)
    assert [frame['t'] for frame in peer.queue._queue] == ['stop']
    assert len(records) == 1
    assert records[0][1]['op'] == 'STOP'
    assert records[0][1]['code'] == 'SERVER_DRIVE_COMMAND'
    assert realtime.arbiter.robot(rid).holder.actor == actor
    realtime.stop_fast_server_drives(realtime.settings.org_id, actor)
    assert len(stops(peer)) == len(records) == 1

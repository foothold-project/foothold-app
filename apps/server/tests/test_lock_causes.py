"""No DB required: actual arbiter -> transport effect enqueue with fake peer."""
import asyncio
from types import SimpleNamespace as NS
from uuid import uuid4
from typing import get_args

import pytest
from apps.contracts import models as C
from apps.server.fh_server.leases import Actor, Arbiter
from apps.server.fh_server.realtime import Realtime


def relay(effects):
    realtime = object.__new__(Realtime)
    peer = NS(queue=asyncio.Queue(), server_drive_axes=(1., 0., 0.))
    realtime.agents = {'fake': peer}
    peer.queue.put_nowait(dict(t='cmd', axes=[1.,0.,0.]))
    peer.queue.put_nowait(dict(t='ping'))
    realtime.effect_depth = 0
    realtime.finish_effects = lambda: None
    realtime.blocked_agent_control = lambda *args: False
    output = []
    realtime.put = lambda peer, frame: output.append(frame)
    realtime.apply([e for e in effects if e.target == 'agent'])
    assert peer.server_drive_axes == (0, 0, 0)
    assert peer.queue.empty()
    return output


@pytest.mark.parametrize('cause', get_args(C.AgentLockCause))
def test_revoke_enqueues_same_cause_in_order_and_clears_pending_motion(cause):
    arbiter = Arbiter(lambda: 100.)
    frames = relay(arbiter.revoke('fake', cause=cause))
    assert [f['t'] for f in frames] == ['lease', 'stop']
    assert all(f['cause'] == cause for f in frames)
    for f in frames:
        C.AgentLease.model_validate(f) if f['t']=='lease' else C.AgentStop.model_validate(f)
    assert arbiter.robot('fake').holder is None


def rig():
    arbiter = Arbiter(lambda: 100.)
    actor = Actor(str(uuid4()), str(uuid4()), str(uuid4()))
    return arbiter, actor


def grant(arbiter, actor):
    relay(arbiter.take('fake', actor))
    arbiter.state('fake', True, [0,0,0], 1, stop_ref=1)


@pytest.mark.parametrize('operation,expected', [
    ('take', 'lease_take'), ('release', 'lease_release'), ('hidden', 'screen_hidden'),
    ('expire', 'lease_expired'), ('stop', 'user_stop'),
])
def test_user_and_timeout_paths_have_distinct_diagnostics(operation, expected):
    arbiter, actor = rig()
    if operation not in ('take',): grant(arbiter, actor)
    effects = (arbiter.revoke('fake', op='EXPIRE') if operation=='expire' else
               getattr(arbiter, operation)('fake', actor))
    frames = relay(effects)
    assert all(f['cause'] == expected for f in frames)
    if operation == 'stop': assert arbiter.robot('fake').holder.actor == actor


def test_transfer_and_cancel_codes_do_not_change_stop_reference():
    arbiter, actor = rig()
    grant(arbiter, actor)
    other = Actor(str(uuid4()), str(uuid4()), str(uuid4()))
    arbiter.request('fake', other)
    frames = relay(arbiter.respond('fake', actor, arbiter.robot('fake').request.id, True))
    assert frames[-1]['cause'] == 'lease_transfer' and frames[-1]['stop_ref'] == 2
    frames = relay(arbiter.cancel('fake', other))
    assert frames[-1]['cause'] == 'transfer_canceled' and frames[-1]['stop_ref'] == 3
    assert arbiter.robot('fake').holder is None and arbiter.robot('fake').transfer is None


def test_actual_server_stop_frame_reaches_agent_log_unchanged(monkeypatch, caplog):
    from pathlib import Path
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[3] / 'apps' / 'agent'))
    from foothold_agent.link.session import Session
    arbiter, actor = rig()
    grant(arbiter, actor)
    frame = relay(arbiter.stop('fake', actor, cause='drive_command_rejected'))[-1]
    session = Session(lambda: 100.)
    session.connect()
    caplog.clear()
    session.receive(frame)
    assert session.core.latch and session.stop_ref == frame['stop_ref']
    assert any('GO2_LOCK kind=stop cause=drive_command_rejected source=server held_ms=' in r.getMessage()
               for r in caplog.records)

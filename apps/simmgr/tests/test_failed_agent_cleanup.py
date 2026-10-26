"""Owner DELETE after exit1: real API/DB/lifecycle, synthetic OS metadata only."""
import asyncio
from dataclasses import replace
import json
from pathlib import Path
import threading
from types import SimpleNamespace
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest
from sqlalchemy.orm import Session

from apps.server.tests.conftest import postgres, migrated, seeded, client
from apps.server.tests.test_api import csrf
from apps.server.tests.test_simulation import LocalRelay
from apps.server.fh_server.models import Robot
from apps.simmgr import agent_unit, launcher
from apps.simmgr.agent_unit import AgentUnit
from apps.simmgr.api import create_app
from apps.simmgr.launcher import CleanupUnconfirmed, NativeLauncher
from apps.simmgr.service import Manager
from test_manager import settings
from test_review_environment import isolation


@pytest.fixture
def failed_episode(tmp_path, monkeypatch):
    monkeypatch.setenv('FH_SIM_RUN', '1')
    # Exercise the same bounded polling without spending 45s on each survivor.
    monkeypatch.setattr(launcher, 'RESOURCE_EXIT_WAIT_SECONDS', .05)
    monkeypatch.setattr(launcher, 'RESOURCE_EXIT_POLL_SECONDS', .001)
    cfg = replace(settings(), real=True, source='synthetic', ros_setup='synthetic',
                  run_dir=str(tmp_path))
    state = SimpleNamespace(events=[], rows=[], ports=[], number=0, leftover=[], denied=0)
    monkeypatch.setattr(isolation, 'processes', lambda: (state.rows, state.denied))
    monkeypatch.setattr(isolation, 'dds_ports', lambda: (state.ports, ''))
    monkeypatch.setattr(isolation, 'source_hashes', lambda source: {})
    original_read = Path.read_text
    def read(path, *args, **kwargs):
        if str(path) == '/proc/123/stat':
            return '123 (synthetic) ' + ' '.join(['0'] * 19 + [str(state.ticks)])
        return original_read(path, *args, **kwargs)
    monkeypatch.setattr(Path, 'read_text', read)

    def command(*args):
        if args[:3] == ('systemctl', '--user', 'kill'):
            assert args[3:] == ('--kill-whom=main', '--signal=SIGINT', state.sim.unit)
            state.events.append('native_sigint')
            state.native['MainPID'] = '0'
            state.rows = state.leftover
        else:
            assert args[:2] == ('journalctl', '--user')
        return ''
    monkeypatch.setattr(isolation, 'command', command)
    def run(args, **kwargs):
        if args == ['systemctl', '--user', 'stop', state.child.unit]:
            state.events.append('agent_exit0')
            state.agent = dict(LoadState='not-found')
            return SimpleNamespace(stdout='')
        assert args == ['systemctl', '--user', 'reset-failed', state.child.unit]
        state.events.append('agent_reaped')
        state.agent = dict(LoadState='not-found')
        return SimpleNamespace(stdout='')
    monkeypatch.setattr(agent_unit.subprocess, 'run', run)
    launch = NativeLauncher(cfg)

    def prepare():
        state.number += 1
        folder = tmp_path / ('episode-' + str(state.number)); folder.mkdir()
        source = folder / 'source'; source.mkdir()
        sim = isolation.Simulation.__new__(isolation.Simulation)
        sim.folder = sim.out = folder
        sim.source, sim.hashes, sim.before = source, {}, {'domain61': []}
        sim.unit, sim.cg = 'fh-rb-sim-synthetic.service', '/synthetic'
        sim.pid = dict(pid=123, start_ticks=100, ppid=1, domain='93',
                       cgroup='0::/synthetic', partition='fh-srv-aaaaaaaaaaaa')
        sim.identity = dict(partition=sim.pid['partition'], main_pid=123,
                            main_start_ticks=100, cgroup=sim.cg, ros_domain='93')
        sim.reason, sim.started, sim.interrupted = None, True, False
        sim.done, sim.signal_lock, sim.thread = threading.Event(), threading.Lock(), None
        state.native = dict(MainPID='123', ControlGroup=sim.cg, ActiveState='active')
        state.ticks = 100
        state.rows = [sim.pid.copy()]
        sim.show = lambda: state.native
        isolation.write(folder / 'unit.json', dict(unit=sim.unit, pid=sim.pid, cgroup=sim.cg))
        isolation.write(folder / 'manifest.json', dict(ros_domain='93', partition=sim.pid['partition'],
            cleanup={'complete': True}, kids_stop=[{'complete': True}],
            isolation={'ledger_sha_before': {'synthetic': 'same'},
                       'ledger_sha_after': {'synthetic': 'same'}}))
        child = AgentUnit.__new__(AgentUnit)
        child.unit, child.invocation_id = 'fh-simmgr-agent-synthetic.service', 'invocation-' + str(state.number)
        child.private = folder / 'agent-env.json'; child.private.touch()
        state.agent = dict(LoadState='loaded', ActiveState='failed', Result='exit-code',
                           MainPID='0', ControlGroup='', ExecMainCode='1', ExecMainStatus='1',
                           InvocationID=child.invocation_id)
        child.show = lambda: state.agent
        state.sim, state.child = sim, child
        launch.sim, launch.child, launch.folder = sim, child, folder
        return folder

    return cfg, state, launch, prepare


@pytest.mark.parametrize('complete', [True, False])
@pytest.mark.parametrize('native_crash', [False, True])
def test_owner_app_delete_requires_native_proof(failed_episode, seeded, client, monkeypatch, complete, native_crash):
    cfg, state, launch, prepare = failed_episode
    slot = next(iter(cfg.slots.values()))
    slot = replace(slot, org_id=str(seeded['org']))
    from apps.simmgr.config import World
    cfg = replace(cfg, slots={slot.robot_id: slot},
                  worlds={'test': World('test', Path(__file__), Path(__file__))})
    launch.settings = cfg
    async def start(world):
        state.events.append('startup_preflight')
        prepare()
        if native_crash:
            # Gazebo crashes after POST; native supervisor has already exited
            # and the agent exits normally, as in the warehouse preview logs.
            state.sim.reason = 'unit_exited'
            state.native['MainPID'] = '0'
            state.rows = []
            state.agent.update(Result='success', ExecMainStatus='0', ActiveState='inactive')
    async def add(slot, credentials):
        pass  # agent has already exited1 by the first health observation
    monkeypatch.setattr(launch, 'start_world', start)
    monkeypatch.setattr(launch, 'add', add)
    simapp = create_app(cfg, launch)
    with TestClient(simapp, client=('127.0.0.1', 9650)) as sim:
        client.app.state.simmgr = LocalRelay(sim, cfg.secret)
        client.app.state.phone_pass_issuer.keys[slot.robot_id] = ('test', {'test': b'x' * 32})
        headers = csrf(client, 'one')
        for generation in (1, 2):
            response = client.post('/api/v1/simulation/robots', headers=headers,
                                   json={'world_id': 'test', 'robot_id': slot.robot_id})
            assert response.status_code == 201, response.text
            folder = launch.folder
            listed = client.get('/api/v1/simulation/robots').json()
            assert listed['items'][0]['state'] == 'ERROR'
            # Even after a rejected POST latches Manager.failed, DELETE may clean up.
            assert sim.post('/v1/worlds', headers={'Authorization': 'Bearer ' + cfg.secret},
                            json={'world_id': 'test'}).status_code == 503
            before = list(state.events)
            other = csrf(client, 'two')
            assert client.delete('/api/v1/simulation/robots/' + slot.robot_id, headers=other).status_code == 403
            assert state.events == before
            headers = csrf(client, 'one')
            if not complete:
                manifest = json.loads((folder / 'manifest.json').read_text())
                manifest['cleanup']['complete'] = False
                isolation.write(folder / 'manifest.json', manifest)
            response = client.delete('/api/v1/simulation/robots/' + slot.robot_id, headers=headers)
            if not complete:
                assert response.status_code == 409, response.text
                assert response.json()['error']['code'] == 'SIM_CLEANUP_NATIVE_UNPROVEN'
                with Session(client.app.state.engine) as db:
                    row = db.get(Robot, slot.robot_id)
                    assert row.owner_user_id == seeded['users']['one'] and row.sim_state == 'STOPPING'
                manager = simapp.state.manager
                assert manager.robots[slot.robot_id].state == 'ERROR'
                assert manager.failed and launch.failed and launch.recovery_blocked
                assert 'agent_reaped' not in state.events
                async def preserve():
                    pass  # test doubles remain retained; no real runtime was started
                monkeypatch.setattr(manager, 'close', preserve)
                return
            assert response.status_code == 204, response.text
            # The manager cancellation receipt remains usable if its first reply
            # was lost, while app authorization still follows released ownership.
            receipt = sim.request('DELETE', '/v1/robots/' + slot.robot_id,
                headers={'Authorization': 'Bearer ' + cfg.secret},
                json={'generation': generation, 'request_nonce': str(uuid4())})
            assert receipt.status_code == 200 and receipt.json()['startup_clean'] is True
            assert receipt.json()['absent'] is True
            with Session(client.app.state.engine) as db:
                row = db.get(Robot, slot.robot_id)
                assert row.sim_state == 'IDLE' and row.owner_user_id is None
                assert row.sim_generation == generation
            result = json.loads((folder / 'cleanup.json').read_text())
            assert result['native_cleanup_complete'] is True
            assert result['native_manifest_matches_live'] is True
            assert result['leftovers'] == result['dds_ports'] == []
            assert launch.sim is launch.child is launch.folder is None
            assert not launch.failed and not simapp.state.manager.failed
        expected = ['startup_preflight', 'agent_exit0'] if native_crash else ['startup_preflight', 'native_sigint', 'agent_reaped']
        assert state.events == expected * 2


@pytest.mark.parametrize('failure,stage,signalled', [
    ('agent_invocation', 'AGENT', False), ('agent_live', 'AGENT', False),
    ('unit_record', 'IDENTITY', False), ('start_ticks', 'IDENTITY', False),
    ('cgroup', 'IDENTITY', False), ('domain', 'IDENTITY', False), ('partition', 'IDENTITY', False),
    ('watcher', 'IDENTITY', False), ('manifest', 'NATIVE', True),
    ('cleanup', 'NATIVE', True), ('kids', 'NATIVE', True),
    ('ledger_missing', 'NATIVE', True), ('ledger_changed', 'NATIVE', True),
    ('dds', 'NATIVE', True), ('leftover', 'NATIVE', True),
])
def test_unproven_exit_or_cleanup_retains_owner_and_latch(failed_episode, failure, stage, signalled):
    cfg, state, launch, prepare = failed_episode
    folder = prepare()
    if failure == 'agent_invocation': state.agent['InvocationID'] = 'replacement'
    if failure == 'agent_live': state.agent['MainPID'] = '456'
    if failure == 'unit_record': (folder / 'unit.json').write_text('{}')
    if failure == 'start_ticks': state.rows[0]['start_ticks'] += 1
    if failure == 'cgroup': state.rows[0]['cgroup'] = '0::/foreign'
    if failure == 'domain': state.rows[0]['domain'] = '61'
    if failure == 'partition': state.rows[0]['partition'] = 'fh-srv-bbbbbbbbbbbb'
    if failure == 'watcher': state.sim.reason = 'watcher_error:RuntimeError'
    if failure in ('manifest', 'cleanup', 'kids', 'ledger_missing', 'ledger_changed'):
        value = json.loads((folder / 'manifest.json').read_text())
        if failure == 'manifest': value['partition'] = 'fh-srv-bbbbbbbbbbbb'
        if failure == 'cleanup': value['cleanup']['complete'] = False
        if failure == 'kids': value['kids_stop'][0]['complete'] = False
        if failure == 'ledger_missing': value.pop('isolation')
        if failure == 'ledger_changed': value['isolation']['ledger_sha_after'] = {'synthetic': 'changed'}
        isolation.write(folder / 'manifest.json', value)
    if failure == 'dds': state.ports = [30650]
    if failure == 'leftover': state.leftover = [state.sim.pid.copy()]
    from apps.simmgr.service import Robot as ManagerRobot
    manager = Manager(cfg, launch)
    slot = next(iter(cfg.slots.values())); owner = str(uuid4())
    manager.robots[slot.robot_id] = ManagerRobot(slot, owner, 'test', 'ERROR', 1)
    async def exercise():
        with pytest.raises(CleanupUnconfirmed) as caught:
            await manager.remove(slot.robot_id, 1)
        assert caught.value.code == 'SIM_CLEANUP_' + stage + '_UNPROVEN'
        assert manager.robots[slot.robot_id].owner == owner
        assert manager.robots[slot.robot_id].state == 'ERROR'
        assert launch.failed and manager.failed and launch.recovery_blocked
        assert launch.sim is state.sim and launch.child is state.child
        assert ('native_sigint' in state.events) == signalled
        assert 'agent_reaped' not in state.events
        with pytest.raises(CleanupUnconfirmed, match='SIM_CLEANUP_LATCHED'):
            await manager.remove(slot.robot_id, 1)
    asyncio.run(exercise())


@pytest.mark.parametrize('populated', ['0', '1', 'unknown'])
def test_failed_agent_cgroup_requires_proven_empty(failed_episode, monkeypatch, populated):
    _, state, _, prepare = failed_episode
    prepare()
    state.agent['ControlGroup'] = '/synthetic-agent'
    original = Path.read_text
    def read(path, *args, **kwargs):
        if str(path) == '/sys/fs/cgroup/synthetic-agent/cgroup.events':
            return 'populated ' + populated + '\n'
        return original(path, *args, **kwargs)
    monkeypatch.setattr(Path, 'read_text', read)
    if populated == '0':
        state.child.confirm_failed_exit()
    else:
        with pytest.raises(RuntimeError, match='populated'):
            state.child.confirm_failed_exit()
    assert not state.events


@pytest.mark.parametrize('missing', ['identity', 'unit_record', 'manifest', 'cleanup', 'kids', 'ledgers', 'dds', 'leftover'])
def test_native_crash_without_complete_proof_latches(failed_episode, missing):
    cfg, state, launch, prepare = failed_episode
    folder = prepare()
    launch.child = None  # already confirmed normal agent shutdown
    launch.failed = True
    state.sim.reason = 'unit_exited'
    state.native['MainPID'] = '0'
    state.rows = []
    if missing == 'identity': state.sim.identity = None
    if missing == 'unit_record': (folder / 'unit.json').unlink()
    if missing in ('manifest', 'cleanup', 'kids', 'ledgers'):
        manifest = json.loads((folder / 'manifest.json').read_text())
        if missing == 'manifest': manifest['partition'] = 'fh-srv-bbbbbbbbbbbb'
        if missing == 'cleanup': manifest['cleanup']['complete'] = False
        if missing == 'kids': manifest['kids_stop'][-1]['complete'] = False
        if missing == 'ledgers': manifest.pop('isolation')
        isolation.write(folder / 'manifest.json', manifest)
    if missing == 'dds': state.ports = [30650]
    if missing == 'leftover': state.rows = [state.sim.pid.copy()]
    async def exercise():
        with pytest.raises(CleanupUnconfirmed) as error:
            await launch.close_world()
        assert error.value.code == ('SIM_CLEANUP_IDENTITY_UNPROVEN' if missing in ('identity', 'unit_record')
                                    else 'SIM_CLEANUP_NATIVE_UNPROVEN')
        assert launch.failed and launch.recovery_blocked and launch.sim is state.sim
        with pytest.raises(CleanupUnconfirmed, match='SIM_CLEANUP_LATCHED'):
            await launch.close_world()
        assert state.events == []  # no signal to an already exited native unit
    asyncio.run(exercise())


@pytest.mark.parametrize('reason', ['low_memory', 'swap_in_10s', 'runtime_limit'])
@pytest.mark.parametrize('survivor', [False, True])
def test_resource_exit_deadline_releases_db_only_after_absence(
        failed_episode, seeded, client, monkeypatch, reason, survivor):
    """Real API/DB expiration path; only process/unit metadata are synthetic."""
    cfg, state, launch, prepare = failed_episode
    slot = replace(next(iter(cfg.slots.values())), org_id=str(seeded['org']))
    from apps.simmgr.config import World
    cfg = replace(cfg, slots={slot.robot_id: slot},
                  worlds={'test': World('test', Path(__file__), Path(__file__))})
    launch.settings = cfg

    async def start(world):
        prepare()
        launch.child = None  # watcher already confirmed agent STOP/zero
        state.sim.reason = reason
        if not survivor:
            state.native.update(MainPID='0', ActiveState='inactive')
            state.rows = []

    async def add(*args):
        pass

    monkeypatch.setattr(launch, 'start_world', start)
    monkeypatch.setattr(launch, 'add', add)
    simapp = create_app(cfg, launch)
    with TestClient(simapp, client=('127.0.0.1', 9600)) as sim:
        client.app.state.simmgr = LocalRelay(sim, cfg.secret)
        client.app.state.phone_pass_issuer.keys[slot.robot_id] = ('test', {'test': b'x' * 32})
        headers = csrf(client, 'one')
        response = client.post('/api/v1/simulation/robots', headers=headers,
                               json={'world_id': 'test', 'robot_id': slot.robot_id})
        assert response.status_code == 201, response.text
        manager = simapp.state.manager

        async def expire():
            manager.expiry_task.cancel()
            await asyncio.gather(manager.expiry_task, return_exceptions=True)
            await manager._expire_at(asyncio.get_running_loop().time())

        sim.portal.call(expire)
        client.app.state.simulation_reconcile()
        if survivor:
            assert manager.failed and launch.recovery_blocked
            assert manager.robots[slot.robot_id].owner == str(seeded['users']['one'])
            assert manager.completions(slot.org_id) == []
            response = client.delete('/api/v1/simulation/robots/' + slot.robot_id, headers=headers)
            assert response.status_code == 409
            assert response.json()['error']['code'] == 'SIM_CLEANUP_LATCHED'
            with Session(client.app.state.engine) as db:
                row = db.get(Robot, slot.robot_id)
                assert row.sim_state == 'STOPPING' and row.owner_user_id == seeded['users']['one']
            assert not state.events  # no signal to a surviving resource-aborted unit
            # Operator retries the same authorized DELETE after the unit finishes.
            # No restart, replacement manager UUID, or new generation is needed.
            state.native.update(MainPID='0', ActiveState='inactive')
            state.rows = []
            response = client.delete('/api/v1/simulation/robots/' + slot.robot_id, headers=headers)
            assert response.status_code == 204, response.text
        with Session(client.app.state.engine) as db:
            row = db.get(Robot, slot.robot_id)
            assert row.sim_state == 'IDLE' and row.owner_user_id is None and row.sim_generation == 1
        assert not manager.robots and manager.world is None
        assert not manager.failed and not launch.failed and not launch.recovery_blocked
        assert launch.sim is launch.child is launch.folder is None
        assert not state.events


@pytest.mark.parametrize('blocker', ['cgroup', 'unknown_cgroup', 'domain', 'partition',
                                    'descendant', 'dds', 'unit_status', 'unit_reused', 'bus', 'denied'])
def test_resource_abort_requires_unit_cgroup_and_runtime_absence(failed_episode, monkeypatch, blocker):
    cfg, state, launch, prepare = failed_episode
    prepare()
    launch.child = None
    state.sim.reason = 'low_memory'
    state.native.update(MainPID='0', ActiveState='inactive')
    state.rows = []
    if blocker in ('cgroup', 'unknown_cgroup'):
        original = Path.read_text
        def read(path, *args, **kwargs):
            if str(path) == '/sys/fs/cgroup/synthetic/cgroup.events':
                return 'populated ' + ('1' if blocker == 'cgroup' else 'unknown') + '\n'
            return original(path, *args, **kwargs)
        monkeypatch.setattr(Path, 'read_text', read)
    if blocker in ('domain', 'partition', 'descendant'):
        row = dict(state.sim.pid, domain='', partition='', cgroup='0::/elsewhere')
        if blocker == 'domain': row['domain'] = '93'
        if blocker == 'partition': row['partition'] = state.sim.identity['partition']
        if blocker == 'descendant': row['cgroup'] = '0::/synthetic/child'
        state.rows = [row]
    if blocker == 'dds': state.ports = [30650]
    if blocker == 'denied': state.denied = 1
    if blocker == 'unit_status': state.native.pop('ActiveState')
    if blocker == 'unit_reused': state.native['MainPID'] = '456'
    if blocker == 'bus':
        def unavailable():
            raise RuntimeError('user bus unavailable')
        state.sim.show = unavailable

    async def exercise():
        with pytest.raises(CleanupUnconfirmed, match='SIM_CLEANUP_IDENTITY_UNPROVEN'):
            await launch.close_world()
        with pytest.raises(CleanupUnconfirmed, match='SIM_CLEANUP_LATCHED'):
            await launch.close_world()
        assert launch.failed and launch.recovery_blocked and launch.sim is state.sim
        assert not state.events
    asyncio.run(exercise())


@pytest.mark.parametrize('recheck', ['before_close', 'after_close'])
def test_latched_reason_none_rechecks_absence_without_signals(failed_episode, monkeypatch, recheck):
    """Each latched absence guard must independently prevent release/signalling."""
    _, state, launch, prepare = failed_episode
    folder = prepare()
    launch.child = None
    launch.failed = launch.recovery_blocked = True
    assert state.sim.reason is None
    if recheck == 'after_close':
        state.native.update(MainPID='0', ActiveState='inactive')
        state.rows = []
        close = state.sim.close
        def revive_after_cleanup():
            close()
            state.native.update(MainPID='123', ActiveState='active')
            state.rows = [state.sim.pid.copy()]
        monkeypatch.setattr(state.sim, 'close', revive_after_cleanup)

    async def exercise():
        with pytest.raises(CleanupUnconfirmed, match='SIM_CLEANUP_LATCHED'):
            await launch.close_world()
        assert launch.sim is state.sim and launch.folder == folder
        assert launch.failed and launch.recovery_blocked
        assert state.events == []
        assert (folder / 'cleanup.json').exists() == (recheck == 'after_close')
    asyncio.run(exercise())


@pytest.mark.parametrize('reason', ['low_memory', 'swap_in_10s', 'runtime_limit'])
@pytest.mark.parametrize('timeout', [False, True])
def test_first_resource_abort_watcher_waits_before_cleanup(
        failed_episode, seeded, client, monkeypatch, reason, timeout):
    cfg, state, launch, prepare = failed_episode
    slot = replace(next(iter(cfg.slots.values())), org_id=str(seeded['org']))
    from apps.simmgr.config import World
    cfg = replace(cfg, slots={slot.robot_id: slot},
                  worlds={'test': World('test', Path(__file__), Path(__file__))})
    launch.settings = cfg

    async def start(world):
        prepare()
        launch.child = None  # agent STOP/zero already confirmed, no extra signal

    async def add(*args):
        pass

    monkeypatch.setattr(launch, 'start_world', start)
    monkeypatch.setattr(launch, 'add', add)
    simapp = create_app(cfg, launch)
    with TestClient(simapp, client=('127.0.0.1', 9600)) as sim:
        client.app.state.simmgr = LocalRelay(sim, cfg.secret)
        client.app.state.phone_pass_issuer.keys[slot.robot_id] = ('test', {'test': b'x' * 32})
        headers = csrf(client, 'one')
        response = client.post('/api/v1/simulation/robots', headers=headers,
                               json={'world_id': 'test', 'robot_id': slot.robot_id})
        assert response.status_code == 201, response.text
        state.sim.reason = reason
        state.native['ActiveState'] = 'deactivating'
        reads = []
        def stopping():
            reads.append(dict(state.native))
            if not timeout and len(reads) == 2:
                state.native['MainPID'] = '0'  # still deactivating: not absent yet
            if not timeout and len(reads) == 3:
                state.native.update(MainPID='0', ActiveState='inactive')
                state.rows = []
            return dict(state.native)
        state.sim.show = stopping
        async def watch():
            launch._watching = True
            await launch._watch_children(launch.folder)
        sim.portal.call(watch)
        assert len(reads) >= 3
        assert launch.recovery_blocked == timeout
        assert launch.recovery_complete == (not timeout)
        assert state.events == []
        response = client.delete('/api/v1/simulation/robots/' + slot.robot_id, headers=headers)
        if timeout:
            assert response.status_code == 409, response.text
            assert response.json()['error']['code'] == 'SIM_CLEANUP_LATCHED'
            with Session(client.app.state.engine) as db:
                row = db.get(Robot, slot.robot_id)
                assert row.sim_state == 'STOPPING' and row.owner_user_id == seeded['users']['one']
            assert state.events == []
            state.native.update(MainPID='0', ActiveState='inactive')
            state.rows = []
            response = client.delete('/api/v1/simulation/robots/' + slot.robot_id, headers=headers)
        assert response.status_code == 204, response.text
        with Session(client.app.state.engine) as db:
            row = db.get(Robot, slot.robot_id)
            assert row.sim_state == 'IDLE' and row.owner_user_id is None
        assert launch.sim is launch.child is launch.folder is None
        assert not launch.failed and not launch.recovery_blocked
        assert state.events == []


def test_resource_exit_status_query_cannot_outlive_wait_budget(failed_episode):
    _, state, launch, prepare = failed_episode
    prepare()
    launch.child = None
    state.sim.reason = 'low_memory'
    release = threading.Event()
    def stalled_bus():
        release.wait(.5)  # bounded even if the deadline guard is accidentally removed
        return dict(state.native)
    state.sim.show = stalled_bus
    async def exercise():
        start = asyncio.get_running_loop().time()
        try:
            with pytest.raises(CleanupUnconfirmed, match='SIM_CLEANUP_IDENTITY_UNPROVEN'):
                await launch.close_world()
            assert asyncio.get_running_loop().time() - start < .3
            assert launch.failed and launch.recovery_blocked and launch.sim is state.sim
            assert state.events == []
        finally:
            release.set()
    asyncio.run(exercise())


def test_native_main_disappears_between_systemctl_and_proc(failed_episode, monkeypatch):
    _, state, launch, prepare = failed_episode
    prepare()
    launch.child = None
    launch.failed = True
    def exited():
        state.native.update(MainPID='0', ActiveState='inactive')
        state.rows = []
        raise RuntimeError('live simulation identity not verified')
    monkeypatch.setattr(state.sim, 'live_identity', exited)
    asyncio.run(launch.close_world())
    assert launch.sim is None and not launch.failed and not launch.recovery_blocked
    assert not state.events

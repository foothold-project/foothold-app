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
from apps.simmgr import agent_unit
from apps.simmgr.agent_unit import AgentUnit
from apps.simmgr.api import create_app
from apps.simmgr.launcher import CleanupUnconfirmed, NativeLauncher
from apps.simmgr.service import Manager
from test_manager import settings
from test_review_environment import isolation


@pytest.fixture
def failed_episode(tmp_path, monkeypatch):
    monkeypatch.setenv('FH_SIM_RUN', '1')
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
def test_exit1_owner_app_delete_requires_native_proof(failed_episode, seeded, client, monkeypatch, complete):
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
        assert state.events == ['startup_preflight', 'native_sigint', 'agent_reaped'] * 2


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

"""Exercise the actual driver against a deterministic, ROS-free protocol peer."""
from collections import defaultdict, deque
import json
from pathlib import Path
import sys
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import motion


class Clock:
    def __init__(self):
        self.now = 0.0

    def monotonic(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds


class Peer:
    """Protocol acknowledgements and scripted stop feedback, not simulated physics."""
    def __init__(self, folder, clock, fault=None, stop_failure=False, stop_timeout=False):
        self.folder, self.clock = folder, clock
        self.fault, self.stop_failure, self.stop_timeout = fault, stop_failure, stop_timeout
        self.fault_raised = False
        self.messages, self.pending = [], deque()
        self.latched, self.stopped, self.applied = True, True, [0, 0, 0]
        self.gen, self.trial = 2, 0
        self.expiry, self.still_at = float('inf'), 0
        self.nonzero = defaultdict(list)
        self.snapshot()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def snapshot(self):
        if self.clock.now >= self.expiry:
            if any(self.applied):
                self.still_at = self.clock.now+.1
            self.applied = [0, 0, 0]
            self.expiry = float('inf')
        data = {'fallen': False, 'plugin_mode': 'LOCKSTEP', 'policy_running': True,
                'body_still': not any(self.applied) and self.clock.now >= self.still_at,
                'stop_requested': self.stopped, 'cmd_applied': list(self.applied),
                'x': 0.0, 'y': 0.0, 'z': .4, 'yaw': 0.0}
        (self.folder / 'state.json').write_text(json.dumps({'mono': self.clock.now, 'data': data}))

    def send(self, payload):
        msg = json.loads(payload)
        self.messages.append((self.clock.now, msg))
        if msg['t'] == 'lease.take':
            self.pending.append({'t': 'lease', 'lease_id': 'test-lease'})
        elif msg['t'] == 'unlock':
            self.trial += 1
            assert self.trial <= 2, 'more than two motion trials'
            self.latched = self.stopped = False
        elif msg['t'] == 'cmd' and any(msg['axes']):
            entries = self.nonzero[self.trial]
            entries.append(self.clock.now)
            # Independent safety envelope asserted while the driver is running;
            # a stretched burst must fail by assertion, not a later runtime error.
            assert len(entries) <= 8, 'nonzero command count exceeded bounded burst'
            assert entries[-1]-entries[0] <= .35, 'nonzero input burst exceeded safety margin'
            self.applied = [.6, 0, 0]
            self.expiry = self.clock.now+.35
            self.still_at = float('inf')
            if self.fault and not self.fault_raised:
                self.fault_raised = True
                if self.fault == 'interrupt':
                    raise KeyboardInterrupt('test interrupt')
                raise RuntimeError('test original motion failure')
        elif msg['t'] == 'stop':
            if self.stop_failure and self.fault_raised:
                raise OSError('test stop transport failure')
            self.latched = self.stopped = True
            self.applied = [0, 0, 0]
            self.still_at = self.clock.now+.1
            self.gen += 1
        self.snapshot()

    def recv(self, timeout):
        self.clock.now += .02
        self.snapshot()
        if self.pending:
            return json.dumps(self.pending.popleft())
        return json.dumps({'t': 'state', 'connection': 'ONLINE',
                           'latched': False if self.stop_timeout and self.fault_raised else self.latched,
                           'stop_gen': self.gen, 'applied': list(self.applied)})


@pytest.fixture
def scenario(tmp_path, monkeypatch):
    source = tmp_path / 'sensor-spec-20261016/stage/sensor-runtime-r1'
    source.mkdir(parents=True)
    maps = tmp_path / 'map-20261014'
    maps.mkdir()
    world = maps / 'world.sdf'
    world.touch()
    (maps / 'worlds.json').write_text(json.dumps({'worlds': {'v5_single/f1': {
        'world_id': 'v5_single', 'floor_id': 'f1', 'world': 'world.sdf'}}}))
    monkeypatch.setenv('FH_SIM_D1_MOTION', '1')
    monkeypatch.setenv('SIM_WORLD_SDF', str(world))
    clock = Clock()
    monkeypatch.setattr(motion, 'time', clock)
    monkeypatch.setattr(motion, 'stamp', lambda: {'utc': 'synthetic', 'mono': clock.now})
    import websockets.sync.client

    def run(*, fault=None, stop_failure=False, stop_timeout=False, reject_proof=None):
        peer = Peer(tmp_path, clock, fault, stop_failure, stop_timeout)
        connect_options, proofs = [], []
        def connect(url, **kwargs):
            connect_options.append(kwargs)
            return peer
        def prove(world, state):
            proofs.append((clock.now, dict(state)))
            return {'pass': len(proofs) != reject_proof, 'source_sha256': {str(world): 'test-world-sha'}}
        monkeypatch.setattr(websockets.sync.client, 'connect', connect)
        monkeypatch.setattr(motion, 'prove', prove)
        def execute():
            return motion.exercise(tmp_path, 'http://127.0.0.1:9020', 'test-access', 'test-robot',
                                   SimpleNamespace(source=source, reason=None))
        return SimpleNamespace(peer=peer, proofs=proofs, options=connect_options,
                               execute=execute, folder=tmp_path)
    return run


def test_two_bounded_forward_trials_each_recheck_gt_and_finish_latched(scenario):
    run = scenario()
    assert run.execute().startswith('completed:')
    messages = [msg for _, msg in run.peer.messages]
    axes = [msg['axes'] for msg in messages if msg['t'] == 'cmd']
    assert all(a in ([0, 0, 0], [1, 0, 0]) for a in axes)
    assert sum(m['t'] == 'unlock' for m in messages) == 2
    assert len(run.proofs) == 3  # before connection and immediately before each unlock
    unlocks = [t for t, m in run.peer.messages if m['t'] == 'unlock']
    assert all(proof[0] <= unlock for proof, unlock in zip(run.proofs[1:], unlocks))
    assert messages[-1]['t'] == 'stop'
    assert run.options[0]['proxy'] is None
    cleanup = json.loads((run.folder / 'motion-stop-cleanup.json').read_text())
    assert cleanup['sent'] is True and cleanup['confirmed'] is True
    results = json.loads((run.folder / 'motion-results.json').read_text())
    assert [r['mode'] for r in results] == ['stop_button', 'input_gap']
    assert all(r['last_input']['mono']-r['first_input']['mono'] <= .35 for r in results)


@pytest.mark.parametrize('proof', [2, 3])
def test_changed_gt_blocks_that_trial_before_unlock_or_nonzero(scenario, proof):
    run = scenario(reject_proof=proof)
    assert run.execute().startswith('skipped remaining motion')
    messages = [msg for _, msg in run.peer.messages]
    assert sum(m['t'] == 'unlock' for m in messages) == proof-2
    assert len(run.proofs) == proof
    assert messages[-1]['t'] == 'stop'
    assert json.loads((run.folder / 'motion-stop-cleanup.json').read_text())['confirmed'] is True


@pytest.mark.parametrize('fault,error', [('runtime', RuntimeError), ('interrupt', KeyboardInterrupt)])
def test_error_and_ctrl_c_finish_with_confirmed_stop(scenario, fault, error):
    run = scenario(fault=fault)
    with pytest.raises(error, match='test (original motion failure|interrupt)'):
        run.execute()
    assert run.peer.messages[-1][1]['t'] == 'stop'
    cleanup = json.loads((run.folder / 'motion-stop-cleanup.json').read_text())
    assert cleanup['confirmed'] is True


@pytest.mark.parametrize('failure', ['transport', 'confirmation'])
def test_final_stop_failure_is_recorded_without_masking_original_error(scenario, failure):
    run = scenario(fault='runtime', stop_failure=failure == 'transport', stop_timeout=failure == 'confirmation')
    with pytest.raises(RuntimeError, match='test original motion failure'):
        run.execute()
    cleanup = json.loads((run.folder / 'motion-stop-cleanup.json').read_text())
    assert cleanup['confirmed'] is False
    assert cleanup['error_type'] == ('OSError' if failure == 'transport' else 'RuntimeError')

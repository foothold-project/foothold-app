"""ROS-free regression checks for the resource and signal boundaries."""
import os
from pathlib import Path
import sys
import tempfile
from unittest.mock import patch

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from isolation import Simulation, abort_reason, dds_ports, domain61, preflight
from d1 import ready


def sample(t, *, mem=3000, pages=0):
    return {'mono': t, 'mem_available_mib': mem, 'pswpin': pages, 'load1': 1}


def test_resource_abort_thresholds_and_sustained_swap():
    assert abort_reason(sample(1, mem=1499), sample(0), None, 200)[0] == 'low_memory'
    assert abort_reason(sample(1, mem=1500), sample(0), None, 200)[0] is None
    high = None
    pages = 0
    page_kib = os.sysconf('SC_PAGE_SIZE') / 1024
    for second in range(1, 11):
        before = sample(second - 1, pages=pages)
        pages += int(2100 / page_kib) + 1
        reason, high, _ = abort_reason(sample(second, pages=pages), before, high, 200)
        assert reason == ('swap_in_10s' if second == 10 else None)
    assert abort_reason(sample(11, pages=pages), sample(10, pages=pages), high, 200)[1] is None
    assert abort_reason(sample(200), sample(199), None, 200)[0] == 'runtime_limit'


def test_domain61_includes_descendants_without_selecting_domain93():
    rows = [dict(pid=1, ppid=0, domain='61'), dict(pid=2, ppid=1, domain=''),
            dict(pid=3, ppid=2, domain=''), dict(pid=4, ppid=0, domain='93')]
    assert [r['pid'] for r in domain61(rows)] == [1, 2, 3]


def test_dds_uses_local_port_column_with_wildcard_peer():
    raw = ('UNCONN 0 0 127.0.0.1:30660 0.0.0.0:*\n'
           'UNCONN 0 0 [::]:30651 [::]:*\n'
           'UNCONN 0 0 0.0.0.0:22660 0.0.0.0:*\n')
    with patch('isolation.command', return_value=raw):
        assert dds_ports() == ([30651, 30660], raw)


@pytest.mark.parametrize('domain,ports,mem,load', [('93', [], 3000, 1), ('', [30660], 3000, 1),
                                                   ('', [], 2499, 1), ('', [], 3000, 9.1)])
def test_preflight_refuses_occupied_or_low_resource_host(domain, ports, mem, load):
    with tempfile.TemporaryDirectory() as folder, patch('isolation.processes', return_value=([{'domain': domain, 'pid': 2, 'ppid': 0}], 0)), \
         patch('isolation.dds_ports', return_value=(ports, '')), patch('isolation.command', return_value=''), \
         patch('isolation.resources', return_value={**sample(0, mem=mem), 'load1': load}):
        with pytest.raises(RuntimeError):
            preflight(Path(folder))


def test_owned_main_signal_once_and_refuse_reused_pid():
    with tempfile.TemporaryDirectory() as folder:
        source = Path(folder) / 'sensor-spec-20261016/stage/sensor-runtime-r1'
        source.mkdir(parents=True)
        (source / 'live_map.py').touch()
        sim = Simulation(Path(folder), source, Path('/unused/setup'))
        sim.pid = {'pid': 123, 'start_ticks': 100}
        sim.cg = '/owned'
        info = {'MainPID': '123', 'ControlGroup': '/owned'}
        # stat field 22 is starttime; indexing begins at field3 after comm.
        stat = '123 (process with spaces) ' + ' '.join(['0'] * 19 + ['100'])
        with patch.object(sim, 'show', return_value=info), patch('pathlib.Path.read_text', return_value=stat), patch('isolation.command') as call:
            sim.interrupt('test')
            sim.interrupt('again')
            call.assert_called_once_with('systemctl', '--user', 'kill', '--kill-whom=main', '--signal=SIGINT', sim.unit)
        sim.interrupted = False
        with patch.object(sim, 'show', return_value={**info, 'MainPID': '124'}), patch('isolation.command') as call:
            with pytest.raises(RuntimeError):
                sim.interrupt('pid_changed')
            call.assert_not_called()
        with patch.object(sim, 'show', return_value=info), patch('pathlib.Path.read_text', return_value=stat.replace('100', '101')), patch('isolation.command') as call:
            with pytest.raises(RuntimeError):
                sim.interrupt('pid_reused')
            call.assert_not_called()


def test_readiness_requires_actual_policy_stop_camera_and_no_fall():
    state = dict(episode=1, stop_requested=True, cmd_applied=[0, 0, 0], policy_running=True,
                 plugin_mode='LOCKSTEP', reset_in_progress=False, fallen=False, camera_frames=2)
    assert ready(state)
    for key, value in [('stop_requested', False), ('cmd_applied', [0.6, 0, 0]), ('fallen', True),
                       ('camera_frames', 0), ('policy_running', False), ('episode', 0)]:
        assert not ready({**state, key: value})

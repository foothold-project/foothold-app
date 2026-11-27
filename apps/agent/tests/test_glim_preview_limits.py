"""Real Linux process limits with fake subscriptions, never DDS or robot access."""
import multiprocessing
import os
from pathlib import Path
import socket
import sys
import threading
import time
from types import SimpleNamespace as NS

import pytest

from foothold_agent.mapping import glim_preview as preview


ENV = {'FH_MAPPING_GLIM_CLOUD_TOPIC': '/fake/glim', 'FH_MAPPING_GLIM_FRAME': 'map',
       'FH_MAPPING_GLIM_PREVIEW_MAX_MB': '256'}


@pytest.mark.parametrize('value,expected', [(None, 1536), ('bad', 1536), ('64', 1536),
    ('255', 1536), ('256', 256), ('4096', 4096), ('4097', 1536)])
def test_preview_memory_configuration(value, expected):
    assert preview.preview_max_mb({'FH_MAPPING_GLIM_PREVIEW_MAX_MB': value}) == expected


def checked_subscription(source, nic, callback):
    import resource
    assert Path('/proc/self/oom_score_adj').read_text().strip() == '1000'
    assert resource.getrlimit(resource.RLIMIT_AS) == (256*1024*1024,)*2
    Path(nic).write_text(str(os.getpid()))
    return lambda: None


def oversized_subscription(source, nic, callback):
    # Simulates deserialization before a callback can reject a huge cloud.
    bytearray(512*1024*1024)
    raise AssertionError('allocation escaped the cap')


def oversized_thread_subscription(source, nic, callback):
    threading.Thread(target=lambda: oversized_subscription(source, nic, callback), daemon=True).start()
    return lambda: None


def failed_setup_worker(output):
    def fail(env):
        raise PermissionError('synthetic procfs failure')
    preview.limit_memory = fail
    preview.preview_worker(output, ENV, 'fake', subscribe=oversized_subscription)


@pytest.mark.skipif(sys.platform != 'linux', reason='Linux procfs and RLIMIT_AS')
def test_real_child_oom_score_and_address_limit(tmp_path):
    child = preview.GlimPreviewProcess(ENV)
    marker = tmp_path/'limits-checked'
    try:
        child.start(str(marker), subscribe=checked_subscription)
        deadline = time.monotonic()+10
        while not marker.exists() and child.process.is_alive() and time.monotonic() < deadline:
            time.sleep(.02)
        assert marker.read_text() == str(child.process.pid)
        assert Path(f'/proc/{child.process.pid}/oom_score_adj').read_text().strip() == '1000'
        assert child.process.is_alive()
    finally:
        child.close()


@pytest.mark.skipif(sys.platform != 'linux', reason='Linux procfs and RLIMIT_AS')
@pytest.mark.parametrize('subscribe', [oversized_subscription, oversized_thread_subscription])
def test_memory_exhaustion_only_kills_child_and_mapping_continues(tmp_path, subscribe):
    # Keep numpy/BLAS initialization out of this spawned module's import path.
    from test_slam_mapping import runtime, command, pose, cloud, own_services, FRONTEND, CLOUD
    from test_mapping_service_invariants import close_runtime, drain
    rt = runtime(tmp_path)
    rt.online = True
    rt.command(command())
    drain(rt)
    own_services(rt)
    child = rt.glim_preview
    child.env['FH_MAPPING_GLIM_PREVIEW_MAX_MB'] = '256'
    try:
        child.start('fake', subscribe=subscribe)
        child.process.join(10)
        assert not child.process.is_alive()
        assert child.process.exitcode == preview.MEMORY_EXIT
        child.poll(rt.glim_live, rt.not_before)
        assert '미리보기 메모리 상한' in child.reason
        assert '미리보기 메모리 상한' in rt.sources_body()['glim']['reason']
        session = rt.core.session_id
        rt.receive(FRONTEND, pose(stamp=1))
        rt.receive(CLOUD, cloud(points=((2., 0., .3),), stamp=1))
        drain(rt)
        assert (40, 0, 6) in rt.core.cells and rt.core.session_id == session
        assert rt.services.status == 'STARTED' and rt.services.glim in rt.services.owned
    finally:
        close_runtime(rt)


def test_setup_failure_disables_preview_before_subscription_and_logs_once(monkeypatch, caplog):
    def fail(env):
        raise PermissionError('synthetic')
    monkeypatch.setattr(preview, 'limit_memory', fail)
    output = NS(close=lambda: None)
    with pytest.raises(SystemExit) as error:
        preview.preview_worker(output, ENV, 'fake', subscribe=oversized_subscription)
    assert error.value.code == preview.LIMIT_SETUP_EXIT
    assert len(caplog.records) == 1 and 'memory limit setup failed' in caplog.text


def test_failed_setup_exit_reaches_parent_reason():
    parent, output = socket.socketpair(type=socket.SOCK_DGRAM)
    process = multiprocessing.get_context('spawn').Process(target=failed_setup_worker, args=(output,))
    child = preview.GlimPreviewProcess(ENV)
    try:
        process.start()
        output.close()
        child.process, child.input = process, parent
        process.join(10)
        assert process.exitcode == preview.LIMIT_SETUP_EXIT
        child.poll(None, 0)
        assert '메모리 상한을 설정하지 못해' in child.reason
    finally:
        child.close()

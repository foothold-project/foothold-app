"""Offline output failure reproduction: fake SDK only, no DDS or robot I/O."""
import builtins
import socket
import threading
import time
from types import SimpleNamespace as NS

import pytest

from foothold_agent.go2_direct.approval import Approval
from foothold_agent.go2_direct.sdk import connect_approved
from foothold_agent.go2_direct.sink import Go2Sink, OutputError, ZERO
from foothold_agent.go2_readonly.sdk import Subscriptions


def test_successful_output_is_silent_and_stop_pair_preserves_first_exception(capsys):
    original, calls = TimeoutError('private SDK details'), []
    def move(*velocity):
        calls.append(('Move', velocity))
        raise original
    def stop():
        calls.append(('StopMove', ()))
        return 3104
    client = NS(Move=move, StopMove=stop)
    sink = Go2Sink(client, object(), offline_test_mode=True)
    sink._call(NS(Move=lambda *args: 0), 'Move', *ZERO)
    assert not capsys.readouterr().err
    with pytest.raises(TimeoutError) as caught:
        sink._stop_output(client)
    assert caught.value is original
    assert calls == [('Move', ZERO), ('StopMove', ())]
    assert capsys.readouterr().err.splitlines() == [
        'SDK_OUTPUT_FAILED method=Move code=TimeoutError',
        'SDK_OUTPUT_FAILED method=StopMove code=3104']


@pytest.mark.parametrize('method', ['Move', 'StopMove'])
@pytest.mark.parametrize('result,label', [(3102, '3102'), (3104, '3104'),
    (-1, '-1'), (None, 'InvalidReturnType'), (False, 'InvalidReturnType'),
    ('private serial address token', 'InvalidReturnType')])
def test_failed_submission_reports_only_method_and_code(method, result, label, capsys):
    client = NS(**{method: lambda *args: result})
    sink = Go2Sink(client, object(), offline_test_mode=True)
    with pytest.raises(OutputError, match='SDK command submission failed'):
        sink._call(client, method, *(ZERO if method == 'Move' else ()))
    assert capsys.readouterr().err == f'SDK_OUTPUT_FAILED method={method} code={label}\n'


@pytest.mark.parametrize('method', ['Move', 'StopMove'])
@pytest.mark.parametrize('exception,label', [(TimeoutError, 'TimeoutError'),
    (type('private_serial_in_type', (Exception,), {}), 'Exception')])
def test_sdk_exception_reports_safe_type_and_preserves_original(method, exception, label, capsys):
    original = exception('private serial address token')
    def fail(*_args):
        raise original
    client = NS(**{method: fail})
    sink = Go2Sink(client, object(), offline_test_mode=True)
    with pytest.raises(exception) as caught:
        sink._call(client, method, *(ZERO if method == 'Move' else ()))
    assert caught.value is original
    assert capsys.readouterr().err == f'SDK_OUTPUT_FAILED method={method} code={label}\n'


@pytest.mark.parametrize('method,code', [('Move', 3102), ('StopMove', 3104)])
def test_first_output_after_init_fails_closed_without_retrying_motion(method, code, monkeypatch, capsys):
    made, calls = [], []
    stopped = threading.Event()
    class Sport:
        def __init__(self):
            self.number = len(made)
            self.failed = False
            self.initialized = False
            made.append(self)
        def SetTimeout(self, value):
            assert value == .1
        def Init(self):
            self.initialized = True
        def Move(self, *velocity):
            assert self.initialized and velocity == ZERO
            calls.append((self.number, 'Move', velocity))
            return self.result('Move')
        def StopMove(self):
            assert self.initialized
            calls.append((self.number, 'StopMove', ()))
            if self.number == 1:
                stopped.set()
            return self.result('StopMove')
        def result(self, current):
            if self.number == 0 and current == method and not self.failed:
                self.failed = True
                return code
            return 0
    original_import = builtins.__import__
    def fake_import(name, *args, **kwargs):
        if name == 'unitree_sdk2py.go2.sport.sport_client':
            return NS(SportClient=Sport)
        assert not name.startswith(('unitree_sdk2py', 'cyclonedds'))
        return original_import(name, *args, **kwargs)
    monkeypatch.setattr(builtins, '__import__', fake_import)
    monkeypatch.setattr(socket, 'if_nameindex', lambda: [(7, 'eth0')])
    subscriptions = Subscriptions(NS(), 'eth0')
    subscriptions._started = True  # fake already-open readonly channel
    pair = connect_approved(Approval('eth0', '1234-5678', time.time()+60),
                            '1234-5678', subscriptions)
    assert len(made) == 2 and made[0] is not made[1] and not calls
    sink = Go2Sink(*pair)
    sink.select_source('server')
    try:
        sink.start_threads()
        assert stopped.wait(1), 'independent emergency STOP must be attempted'
        with pytest.raises(OutputError):
            sink.apply(NS(kind='apply', velocity=ZERO), source='server')
        assert sink.error is not None and sink.latched and sink.pending == ZERO
        assert {which for which, current, _ in calls if current == 'StopMove'} == {0, 1}
    finally:
        sink.close()
    # Later fake calls succeed, but that cannot erase the first failure or unlock.
    assert sink.error is not None and sink.latched
    assert f'SDK_OUTPUT_FAILED method={method} code={code}' in capsys.readouterr().err.splitlines()

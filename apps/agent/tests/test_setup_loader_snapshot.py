"""Fresh-process inherited loader checks; no real SDK, DDS or network access."""
import os
from pathlib import Path
import subprocess
import sys
import textwrap

import pytest


@pytest.mark.parametrize('inherited', [None, 'LD_LIBRARY_PATH', 'CYCLONEDDS_URI', 'CYCLONEDDS_HOME'])
def test_reconnect_uses_entry_snapshot_even_after_cv2_style_environment_mutation(inherited, tmp_path):
    env = dict(os.environ)
    for key in ('LD_LIBRARY_PATH', 'CYCLONEDDS_URI', 'CYCLONEDDS_HOME'):
        env.pop(key, None)
    if inherited is not None:
        env[inherited] = 'unreviewed-private-startup-value'
    env['PYTHONPATH'] = str(Path(__file__).resolve().parents[1])
    script = textwrap.dedent('''
        import asyncio
        import builtins
        import os
        import sys
        from types import SimpleNamespace as NS
        original_import = builtins.__import__
        def guarded(name, *args, **kwargs):
            assert not name.startswith(('unitree_sdk2py', 'cyclonedds', 'cv2'))
            return original_import(name, *args, **kwargs)
        builtins.__import__ = guarded
        from foothold_agent.setup import __main__ as setup
        from foothold_agent.go2_direct import preflight
        from foothold_agent.setup import windows_preflight
        from foothold_agent.setup.view import Status
        inherited = sys.argv[1] == 'yes'
        # Model cv2's post-start environment mutation, without importing cv2.
        # Even removing a real inherited override must NOT erase its rejection.
        for name in ('CYCLONEDDS_URI', 'CYCLONEDDS_HOME', 'LD_LIBRARY_PATH'):
            os.environ.pop(name, None)
        os.environ['LD_LIBRARY_PATH'] = 'cv2-added-private-path'
        reached = []
        class ReachedPreflight(Exception):
            pass
        def inspect(_):
            reached.append(True)
            raise ReachedPreflight()
        async def scenario():
            for _ in range(2):
                try:
                    await setup.connect(NS(wheel_dir=sys.argv[2]), Status(), asyncio.Event(), preflight=inspect)
                except PermissionError:
                    assert inherited
                except ReachedPreflight:
                    assert not inherited
                else:
                    raise AssertionError('fake preflight must stop before DDS')
                for implementation in (preflight, windows_preflight):
                    report = implementation.inspect(sys.argv[2])
                    assert ('inherited-dds-loader-override' in report['issues']) == inherited
        asyncio.run(scenario())
        assert len(reached) == (0 if inherited else 2)
        print('snapshot verified')
    ''')
    result = subprocess.run([sys.executable, '-c', script, 'yes' if inherited else 'no', str(tmp_path)],
                            env=env, capture_output=True, text=True, timeout=15)
    assert result.returncode == 0, result.stderr
    assert result.stdout == 'snapshot verified\n'


@pytest.mark.parametrize('inherited', [None, 'LD_LIBRARY_PATH', 'CYCLONEDDS_URI', 'CYCLONEDDS_HOME'])
def test_desktop_repair_passes_entry_aware_environment_to_restarted_process(inherited, tmp_path):
    env = dict(os.environ)
    for key in ('LD_LIBRARY_PATH', 'CYCLONEDDS_URI', 'CYCLONEDDS_HOME'):
        env.pop(key, None)
    if inherited is not None:
        env[inherited] = 'unreviewed-private-startup-value'
    env['PYTHONPATH'] = str(Path(__file__).resolve().parents[1])
    env['FOOTHOLD_RESTART_TEST'] = 'preserved'
    # The replacement interpreter must make its own snapshot and still refuse
    # real inherited overrides before any SDK/DDS import or discovery.
    restarted = textwrap.dedent('''
        import asyncio
        import builtins
        import sys
        from types import SimpleNamespace as NS
        original_import = builtins.__import__
        def guarded(name, *args, **kwargs):
            assert not name.startswith(('unitree_sdk2py', 'cyclonedds', 'cv2'))
            return original_import(name, *args, **kwargs)
        builtins.__import__ = guarded
        from foothold_agent.go2_direct import loader, preflight
        from foothold_agent.setup import __main__ as setup, windows_preflight
        from foothold_agent.setup.view import Status
        inherited = sys.argv[1] != 'none'
        assert loader.INHERITED_LOADER_OVERRIDE == inherited
        class ReachedPreflight(Exception):
            pass
        def inspect(_):
            raise ReachedPreflight()
        async def scenario():
            try:
                await setup.connect(NS(wheel_dir=sys.argv[2]), Status(), asyncio.Event(), preflight=inspect)
            except PermissionError as error:
                assert inherited and str(error) == 'DDS loader overrides require review'
            except ReachedPreflight:
                assert not inherited
            else:
                raise AssertionError('fake preflight must stop before DDS')
            for implementation in (preflight, windows_preflight):
                report = implementation.inspect(sys.argv[2])
                assert ('inherited-dds-loader-override' in report['issues']) == inherited
        asyncio.run(scenario())
        print('restarted snapshot verified')
    ''')
    script = textwrap.dedent('''
        import builtins
        import os
        from pathlib import Path
        import subprocess
        import sys
        from types import SimpleNamespace as NS
        original_import = builtins.__import__
        def guarded(name, *args, **kwargs):
            assert not name.startswith(('unitree_sdk2py', 'cyclonedds', 'cv2'))
            return original_import(name, *args, **kwargs)
        builtins.__import__ = guarded
        from foothold_agent.desktop import __main__ as desktop, locking
        from foothold_agent.go2_direct import loader
        inherited, temporary, child_script = sys.argv[1:]
        assert loader.INHERITED_LOADER_OVERRIDE == (inherited != 'none')
        interpreter = sys.executable
        root = Path(temporary)
        (root/'server.json').write_text('{"server":"https://example.invalid"}')
        desktop.sys.executable = str(root/'python/bin/python3')
        desktop.default_path = lambda: root/'private/agent.json'
        desktop.state_dir = lambda: root/'state'
        cleanup = []
        class FakeLock:
            def __init__(self, _):
                pass
            def __enter__(self):
                pass
            def __exit__(self, *args):
                cleanup.append('lock')
        locking.InstanceLock = FakeLock
        desktop.setup.inspect = lambda _: {'installation_ready':True, 'issues':[]}
        desktop.make_server = lambda *args, **kwargs: NS(
            serve_forever=lambda: None,
            shutdown=lambda: cleanup.append('shutdown'),
            server_close=lambda: cleanup.append('close'))
        async def repair(args, status, controls):
            # Model cv2 adding a library path after process-entry imports.
            os.environ['LD_LIBRARY_PATH'] = os.environ.get('LD_LIBRARY_PATH', '') + ':cv2-added-private-path'
            if inherited == 'none':
                os.environ['CYCLONEDDS_URI'] = 'runtime-added-uri'
                os.environ['CYCLONEDDS_HOME'] = 'runtime-added-home'
            controls.restart = True
        desktop.connect_when_ready = repair
        calls = []
        def execve(executable, argv, environment):
            calls.append(True)
            assert cleanup == ['shutdown', 'close', 'lock']
            assert executable == desktop.sys.executable
            assert argv == [executable, '-I', '-m', 'foothold_agent.desktop', '--managed', '--repair']
            assert environment is not os.environ
            assert environment['FOOTHOLD_RESTART_TEST'] == 'preserved'
            assert 'cv2-added-private-path' in os.environ['LD_LIBRARY_PATH']
            if inherited == 'none':
                assert all(name not in environment for name in loader.LOADER_OVERRIDE_NAMES)
            else:
                assert environment == dict(os.environ)
                assert 'unreviewed-private-startup-value' in environment[inherited]
            result = subprocess.run([interpreter, '-c', child_script, inherited, temporary],
                                    env=environment, capture_output=True, text=True, timeout=10)
            assert result.returncode == 0, result.stderr
            assert result.stdout == 'restarted snapshot verified\\n'
        def forbidden_execv(*args):
            raise AssertionError('repair must pass an explicit environment')
        desktop.os.execv = forbidden_execv
        desktop.os.execve = execve
        assert desktop.main(['--managed', '--no-browser']) == 0
        assert calls == [True]
        print('repair verified')
    ''')
    result = subprocess.run([sys.executable, '-c', script, inherited or 'none', str(tmp_path), restarted],
                            env=env, capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, result.stderr
    assert result.stdout == 'repair verified\n'

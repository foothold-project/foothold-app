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

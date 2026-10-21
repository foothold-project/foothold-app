"""P1-C assertion kills, disposable source copies within this worktree only."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[3]
MUTATIONS = [
    ('camera backpressure coupled into control receive', 'apps/agent/foothold_agent/phone/server.py',
     'result = self.hub.receive(peer, raw)',
     'result = self.hub.receive(peer, raw)\n            if self.camera is not None and self.camera.active:\n                await asyncio.sleep(.3)',
     'apps/agent/foothold_agent/camera/tests/test_camera.py::test_camera_ws_contract_and_separate_control_socket'),
    ('domain 61 allowed', 'apps/agent/foothold_agent/ros_bridge/config.py',
     '"ROS_DOMAIN_ID": "93"', '"ROS_DOMAIN_ID": "61"',
     'apps/simmgr/tests/test_manager.py::test_isolation_rejects_before_any_launch[ROS_DOMAIN_ID-61]'),
    ('robot removal omits STOP/zero', 'apps/simmgr/service.py',
     'await self.launcher.stop_agent(row.slot)', 'pass',
     'apps/simmgr/tests/test_manager.py::test_manager_limits_isolation_and_stop_order'),
    ('configured robot cap removed', 'apps/simmgr/service.py',
     'if len(self.robots) >= self.settings.max_robots:', 'if False:',
     'apps/simmgr/tests/test_manager.py::test_cap_and_one_person_one_robot'),
    ('camera survives parent close', 'apps/agent/foothold_agent/camera/transport.py',
     'return parent is not None and parent.user is not None and self.hub.now() < parent.deadline',
     'return True',
     'apps/agent/foothold_agent/camera/tests/test_camera.py::test_parent_close_revocation_expiry_and_receive_only'),
]


def main():
    temp = ROOT / 'tmp/p1c/mutations'
    temp.mkdir(parents=True, exist_ok=True)
    results = []
    for name, path, before, after, test in MUTATIONS:
        with tempfile.TemporaryDirectory(dir=temp) as folder:
            dest = Path(folder)
            for package in ('agent','contracts','simmgr'):
                shutil.copytree(ROOT / 'apps' / package, dest / 'apps' / package,
                    ignore=shutil.ignore_patterns('__pycache__','.pytest_cache','node_modules','*.egg-info'))
            source = dest / path
            text = source.read_text()
            if text.count(before) != 1:
                raise RuntimeError('nonunique anchor: ' + name)
            source.write_text(text.replace(before, after))
            shutil.copyfile(ROOT/'apps/agent/tools/mutation_reporter.py',dest/'foothold_link_mutation_probe.py')
            report = dest / 'report.json'
            env = {**os.environ, 'PYTHONPATH':os.pathsep.join([str(dest/'apps/simmgr/tools'),str(dest/'apps/agent'),str(dest)]),
                   'TMPDIR':str(ROOT/'tmp/p1c'), 'FH_TEST_PORT_RANGE':'9430:9449'}
            result = subprocess.run([sys.executable,'-m','pytest',test,'-q','--tb=short',
                '-p','foothold_link_mutation_probe','--link-mutation-report',str(report)],cwd=dest,env=env,
                text=True,capture_output=True,timeout=20)
            data = json.loads(report.read_text()) if report.exists() else {}
            killed = result.returncode == 1 and data.get('collected',0)>0 and data.get('assertions') and not data.get('errors')
            row = {'name':name,'result':'KILLED' if killed else 'SURVIVED/ERROR','assertions':len(data.get('assertions',[]))}
            results.append(row)
            print(json.dumps(row),flush=True)
            if not killed:
                print(result.stdout[-4000:]+result.stderr[-500:])
    (ROOT/'tmp/p1c/new-mutations.json').write_text(json.dumps(results,indent=2)+'\n')
    return int(any(row['result'] != 'KILLED' for row in results))


if __name__ == '__main__':
    raise SystemExit(main())

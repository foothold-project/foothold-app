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


CAM = 'apps/agent/foothold_agent/camera/tests/test_review_boundaries.py::'
ENV = 'apps/simmgr/tests/test_review_environment.py::'
SRV = 'apps/server/tests/test_simulation.py::'
MUTATIONS += [
    ('camera token not consumed', 'apps/agent/foothold_agent/camera/transport.py',
     'self.tokens.pop(peer)\n', 'pass\n', CAM+'test_token_cannot_reopen_after_first_video_closes'),
    ('camera active guard removed', 'apps/agent/foothold_agent/camera/transport.py',
     ' or peer in self.active:', ':', CAM+'test_active_camera_rejects_even_a_fresh_parent_token'),
    ('camera pending cap removed', 'apps/agent/foothold_agent/camera/transport.py',
     'if self.pending >= 16:', 'if False:', CAM+'test_pending_capacity_is_bounded_per_address_and_globally[False]'),
    ('camera address cap removed', 'apps/agent/foothold_agent/camera/transport.py',
     'if self.waiting_addresses.get(address, 0) >= 2:', 'if False:', CAM+'test_pending_capacity_is_bounded_per_address_and_globally[True]'),
    ('camera send timeout removed', 'apps/agent/foothold_agent/camera/transport.py',
     "separators=(',', ':'))), .2)", "separators=(',', ':'))), 1000)", CAM+'test_slow_camera_timeout_has_transport_reason'),
    ('camera source throttle removed', 'apps/agent/foothold_agent/camera/stream.py',
     'throttled = received < self.next_submit', 'throttled = False', CAM+'test_source_throttle_precedes_jpeg_parse'),
    ('overspeed source does not yield GIL', 'apps/agent/foothold_agent/camera/stream.py',
     'time.sleep(0)', 'pass', CAM+'test_source_throttle_precedes_jpeg_parse'),
    ('phone TCP_NODELAY omitted', 'apps/agent/foothold_agent/phone/server.py',
     'native_socket.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)', 'pass', CAM+'test_20ms_rtt_and_nagle_diagnosis'),
    ('manager ROS environment accepted', 'apps/simmgr/environment.py',
     "if any(name.startswith('ROS_') or name in (*DDS_OVERRIDES, 'RMW_IMPLEMENTATION') for name in env):", 'if False:',
     ENV+'test_manager_rejects_any_ros_environment_before_reading_files'),
    ('child inherits entire parent environment', 'apps/simmgr/environment.py',
     'child = {name: env[name] for name in BASE_KEYS if name in env}', 'child = dict(env)',
     ENV+'test_child_environment_does_not_inherit_secrets'),
    ('unit inherits user manager environment', 'apps/agent/tools/sim/isolation.py',
     "args[index:index] = ['/usr/bin/env', '-i', *[f'{key}={value}' for key, value in sorted(self.launch_env.items())]]", 'pass',
     ENV+'test_unit_clears_user_manager_environment_before_setup'),
    ('manager loopback host guard removed', 'apps/simmgr/api.py',
     "if request.client and request.client.host not in ('127.0.0.1',):", 'if False:',
     'apps/simmgr/tests/test_manager.py::test_manager_rejects_external_peer_even_with_correct_secret'),
    ('relay slot owner guard removed', 'apps/server/fh_server/simulation.py',
     'if row.owner_user_id != user.id:', 'if False:', SRV+'test_admin_cannot_steal_owned_slot_even_when_manager_is_empty'),
    ('relay missing key guard removed', 'apps/server/fh_server/simulation.py',
     'if rid not in issuer.keys:', 'if False:', SRV+'test_missing_key_fails_before_manager_start'),
    ('relay accepts real robot row', 'apps/server/fh_server/simulation.py',
     'if row is not None and (row.org_id != user.org_id or not row.simulation or row.archived_at):',
     'if row is not None and (row.org_id != user.org_id or row.archived_at):', SRV+'test_existing_real_robot_cannot_be_adopted'),
    ('late pass sweep omitted at release', 'apps/server/fh_server/simulation.py',
     'db.refresh(row)\n        phone_pass.revoke(db, user.org_id, robot_id=robot_id, clock=issuer.clock)',
     'db.refresh(row)', SRV+'test_pass_issued_during_removal_is_revoked_before_release'),
    ('relay removal audit omitted', 'apps/server/fh_server/simulation.py',
     "event(db, user.org_id, 'SIM_ROBOT_REMOVED'", "(lambda *a, **k: None)(db, user.org_id, 'SIM_ROBOT_REMOVED'",
     SRV+'test_released_slot_can_change_owner_and_revokes_live_passes'),
]


def main():
    temp = ROOT / 'tmp/p1c/mutations'
    temp.mkdir(parents=True, exist_ok=True)
    results = []
    for name, path, before, after, test in MUTATIONS:
        with tempfile.TemporaryDirectory(dir=temp) as folder:
            dest = Path(folder)
            for package in ('agent','contracts','simmgr','server'):
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

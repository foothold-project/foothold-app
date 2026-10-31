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
     'throttled = received < self.next_submit or self.pending is not None', 'throttled = False', CAM+'test_source_throttle_precedes_jpeg_parse'),
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
     "phone_pass.revoke(db, org_id, robot_id=robot_id, clock=issuer.clock)\n        row.sim_state = 'IDLE'",
     "row.sim_state = 'IDLE'", SRV+'test_pass_issued_during_removal_is_revoked_before_release'),
    ('relay removal audit omitted', 'apps/server/fh_server/simulation.py',
     "event(db, org_id, 'SIM_ROBOT_REMOVED'", "(lambda *a, **k: None)(db, org_id, 'SIM_ROBOT_REMOVED'",
     SRV+'test_released_slot_can_change_owner_and_revokes_live_passes'),
]

MUTATIONS += [
    ('manager generation guard removed', 'apps/simmgr/service.py',
     'if generation != row.generation:', 'if False:',
     'apps/simmgr/tests/test_manager.py::test_manager_rejects_stale_generation_before_stop'),
    ('server final generation guard removed', 'apps/server/fh_server/simulation.py',
     "if row.sim_generation != generation or row.sim_state != 'STOPPING':", 'if False:',
     'apps/server/tests/test_sim_generation.py::test_old_delete_preserves_reacquired_generation[one-after_manager]'),
    ('normal simulation delete allowed', 'apps/server/fh_server/api.py',
     "            if row.simulation:\n                fail(409, 'SIM_ROBOT_MANAGED', '시뮬 관리자에서만 제거합니다.')",
     '            if False:\n                pass',
     'apps/server/tests/test_sim_generation.py::test_normal_delete_and_owner_patch_cannot_change_simulation'),
    ('normal simulation owner edit allowed', 'apps/server/fh_server/api.py',
     "if row.simulation and 'owner_user_id' in body.model_fields_set:", 'if False:',
     'apps/server/tests/test_sim_generation.py::test_normal_delete_and_owner_patch_cannot_change_simulation'),
    ('oversize source accepted before parser', 'apps/agent/foothold_agent/camera/stream.py',
     ' or len(data) > MAX_BYTES', '', CAM+'test_oversize_source_rejected_before_parser'),
    ('camera token expiry ignored', 'apps/agent/foothold_agent/camera/transport.py',
     "self.now() < deadline and hmac.compare_digest", 'hmac.compare_digest',
     CAM+'test_expiry_and_receive_only_are_assertion_boundaries[True]'),
    ('camera application input accepted', 'apps/agent/foothold_agent/camera/transport.py',
     "await ws.close(4403, 'CAMERA_RECEIVE_ONLY')", 'await asyncio.Future()',
     CAM+'test_expiry_and_receive_only_are_assertion_boundaries[False]'),
]

RECOVERY = 'apps/server/tests/test_sim_recovery.py::'
UNIT = 'apps/simmgr/tests/test_recovery_boundaries.py::'
MUTATIONS += [
    ('absent robot still requires manager generation', 'apps/simmgr/service.py',
     'return  # server DB owns generations; absent robots are already removed',
     "raise SimError('SIM_GENERATION_MISMATCH')", UNIT+'test_absent_robot_delete_api_accepts_any_generation'),
    ('definite start rejection retains reservation', 'apps/server/fh_server/simulation.py',
     "if row.sim_generation == generation and row.sim_state == 'STARTING':", 'if False:',
     RECOVERY+'test_missing_world_rejected_without_consuming_slot'),
    ('STARTING deletion prohibited', 'apps/server/fh_server/simulation.py',
     "        row.sim_state = 'STOPPING'", "        if row.sim_state == 'STARTING':\n            fail(409, 'SIM_SLOT_BUSY', 'synthetic mutant')\n        row.sim_state = 'STOPPING'",
     RECOVERY+'test_uncertain_start_can_delete_and_reacquire[before]'),
    ('same generation duplicate DELETE final guard removed', 'apps/server/fh_server/simulation.py',
     "if row.sim_generation != generation or row.sim_state != 'STOPPING':", 'if row.sim_generation != generation:',
     RECOVERY+'test_duplicate_delete_same_generation_releases_only_once'),
    ('manager startup proof skipped', 'apps/simmgr/api.py',
     'app.state.preflight = await asyncio.to_thread(startup_preflight, settings.real)', 'app.state.preflight = None',
     UNIT+'test_service_startup_requires_absence_proof_even_in_fake'),
    ('agent expiry uses wrong signal', 'apps/simmgr/agent_unit.py',
     "'--property=KillSignal=SIGINT',", "'--property=KillSignal=SIGTERM',",
     ENV+'test_agent_unit_is_bounded_and_environment_is_private'),
    ('agent unit name reuse allowed', 'apps/simmgr/agent_unit.py',
     "if state.get('LoadState') != 'not-found':", 'if False:',
     UNIT+'test_agent_unit_reuse_and_missing_bus_are_distinct[state0]'),
    ('agent private environment file retained', 'apps/simmgr/agent_entry.py',
     'private.unlink()  # no durable credential copy after exec', 'pass',
     UNIT+'test_agent_entry_unlinks_private_file_before_exec'),
]

MUTATIONS += [
    ('definite rejection skips in-flight pass revocation', 'apps/server/fh_server/simulation.py',
     'phone_pass.revoke(db, user.org_id, robot_id=row.id, clock=issuer.clock)', 'pass',
     RECOVERY+'test_definite_rejection_revokes_pass_issued_while_starting'),
]


DELAYED = 'apps/server/tests/test_sim_delayed_start.py::'
BOUNDARY = 'apps/simmgr/tests/test_delayed_start.py::'
MUTATIONS += [
    ('cancelled generation POST accepted', 'apps/simmgr/service.py',
     'if generation <= self.removed_generation.get(robot_id, 0):', 'if False:',
     BOUNDARY+'test_absent_delete_cancels_old_start_but_allows_successor'),
    ('absent DELETE receipt omitted', 'apps/simmgr/service.py',
     'self.removed_generation[robot_id] = max(generation, self.removed_generation.get(robot_id, 0))',
     'if robot_id in self.robots: self.removed_generation[robot_id] = max(generation, self.removed_generation.get(robot_id, 0))',
     BOUNDARY+'test_absent_delete_cancels_old_start_but_allows_successor'),
    ('stale success compensation omitted', 'apps/server/fh_server/simulation.py',
     "app.state.simmgr.request('DELETE', '/v1/robots/' + rid, {'generation': generation})", 'pass',
     DELAYED+'test_stale_success_compensates_once_without_touching_successor[False]'),
    ('STALE classified definite rejection', 'apps/server/fh_server/simulation.py',
     "(409, 'SIM_NATIVE_SINGLE_ONLY'), (409, 'SIM_ROBOT_LIMIT'),",
     "(409, 'SIM_NATIVE_SINGLE_ONLY'), (409, 'SIM_ROBOT_LIMIT'), (409, 'SIM_GENERATION_STALE'),",
     RECOVERY+'test_uncertain_start_can_delete_and_reacquire[stale]'),
    ('manager ready guard removed', 'apps/simmgr/api.py', 'if not app.state.ready:', 'if False:',
     BOUNDARY+'test_manager_not_ready_rejects_requests_before_lifespan'),
    ('rejection callback generation and state ignored', 'apps/server/fh_server/simulation.py',
     "if row.sim_generation == generation and row.sim_state == 'STARTING':", 'if True:',
     DELAYED+'test_definite_rejection_rechecks_generation_and_state'),
    ('rejected start hash retained', 'apps/server/fh_server/simulation.py',
     "                row.agent_token_hash = digest(token())", '                pass',
     RECOVERY+'test_definite_start_rejection_releases_immediately'),
    ('listing health poll omitted', 'apps/simmgr/service.py',
     '            await self.launcher.check_health()', '            pass',
     BOUNDARY+'test_native_listing_observes_failed_child_and_latches'),
    ('health poll error latch omitted', 'apps/simmgr/launcher.py',
     '        except RuntimeError:\n            self.failed = True', '        except RuntimeError:\n            self.failed = False',
     BOUNDARY+'test_health_poll_failure_latches_even_after_poll_recovers'),
    ('health nonzero exit latch omitted', 'apps/simmgr/launcher.py',
     '            if self.child is not None and await self._poll() is not None:\n                self.failed = True',
     '            if self.child is not None and await self._poll() is not None:\n                pass',
     BOUNDARY+'test_native_listing_observes_failed_child_and_latches'),
    ('agent unit start error latch omitted', 'apps/simmgr/launcher.py',
     "            self.failed = True\n            raise RuntimeError('agent unit startup failed')",
     "            self.failed = False\n            raise RuntimeError('agent unit startup failed')",
     BOUNDARY+'test_agent_unit_creation_error_latches'),
    ('POST final STARTING guard omitted', 'apps/server/fh_server/simulation.py',
     "if row.sim_generation != generation or row.sim_state != 'STARTING' or not_created:", 'if row.sim_generation != generation or not_created:',
     DELAYED+'test_post_success_does_not_overwrite_stopping'),
]


RESTART = 'apps/server/tests/test_sim_restart_delivery.py::'
MUTATIONS += [
    ('uncertain POST skips final generation check', 'apps/server/fh_server/simulation.py',
     '        # Even an uncertain first delivery can cross a manager restart.',
     "        if start_error is not None: fail(start_error.status, start_error.code, 'synthetic mutant')\n        # Even an uncertain first delivery can cross a manager restart.",
     RESTART+'test_first_delivery_after_manager_restart_cannot_escape_delete[True]'),
    ('STALE rejection audit omitted', 'apps/server/fh_server/simulation.py',
     "event(db, user.org_id, 'SIM_ROBOT_START_STALE'",
     "((lambda *a, **k: None) if not_created else event)(db, user.org_id, 'SIM_ROBOT_START_STALE'",
     DELAYED+'test_delayed_post_cannot_escape_completed_delete[delete_first]'),
    ('HTTP protocol exception not wrapped', 'apps/server/fh_server/simulation.py',
     'except Exception:', 'except (OSError, ValueError):',
     RESTART+'test_http_protocol_exception_is_relay_uncertainty'),
    ('compensation retains organization write lock', 'apps/server/fh_server/simulation.py',
     "            db.commit()\n            compensation =", "            pass\n            compensation =",
     RESTART+'test_compensation_releases_organization_lock_before_remote_delete'),
    ('native startup uses fake resource mode', 'apps/simmgr/api.py',
     'asyncio.to_thread(startup_preflight, settings.real)', 'asyncio.to_thread(startup_preflight, False)',
     BOUNDARY+'test_api_startup_passes_real_mode_to_preflight'),
    ('existing robot DELETE cancellation not recorded', 'apps/simmgr/service.py',
     'self.removed_generation[robot_id] = max(generation, self.removed_generation.get(robot_id, 0))',
     'if robot_id not in self.robots: self.removed_generation[robot_id] = max(generation, self.removed_generation.get(robot_id, 0))',
     BOUNDARY+'test_existing_robot_delete_records_cancellation_receipt'),
]


# R6: run just these with --only for the final focused review.
RELAY_NORMALIZED = """        try:
            request = Request(self.url + path, method=method,
                data=json.dumps(body).encode() if body is not None else None,
                headers={'Authorization': 'Bearer ' + self.secret, 'Content-Type': 'application/json'})
            try:
                with self.opener.open(request, timeout=5 if method == 'GET' else 180) as response:
                    raw = response.read(65537)
                if len(raw) > 65536:
                    raise RelayError()
                return json.loads(raw)
            except HTTPError as error:
                # The outer boundary also covers reading/decoding an error body.
                # Only code/status crosses it, never remote text/credentials.
                code = json.loads(error.read(4097))['error']['code']
                if not isinstance(code, str) or not code.startswith('SIM_') or len(code) > 64:
                    code = 'SIM_UNAVAILABLE'
                raise RelayError(code, error.code if error.code in (400, 404, 409, 503) else 503) from None
        except RelayError as error:
            raise error from None
        except Exception:
            # Transport, status, body and decoder failures are all uncertain.
            # BaseException (interrupts, cancellation, exit) deliberately escapes.
            raise RelayError() from None"""
RELAY_ERROR_BODY_UNWRAPPED = """        try:
            request = Request(self.url + path, method=method,
                data=json.dumps(body).encode() if body is not None else None,
                headers={'Authorization': 'Bearer ' + self.secret, 'Content-Type': 'application/json'})
            with self.opener.open(request, timeout=5 if method == 'GET' else 180) as response:
                raw = response.read(65537)
            if len(raw) > 65536:
                raise RelayError()
            return json.loads(raw)
        except HTTPError as error:
            # The outer boundary also covers reading/decoding an error body.
            # Only code/status crosses it, never remote text/credentials.
            code = json.loads(error.read(4097))['error']['code']
            if not isinstance(code, str) or not code.startswith('SIM_') or len(code) > 64:
                code = 'SIM_UNAVAILABLE'
            raise RelayError(code, error.code if error.code in (400, 404, 409, 503) else 503) from None
        except RelayError as error:
            raise error from None
        except Exception:
            # Transport, status, body and decoder failures are all uncertain.
            # BaseException (interrupts, cancellation, exit) deliberately escapes.
            raise RelayError() from None"""
MUTATIONS += [
    ('relay normalization narrowed', 'apps/server/fh_server/simulation.py',
     'except Exception:', "except (OSError, ValueError, __import__('http.client', fromlist=['HTTPException']).HTTPException):",
     'apps/server/tests/test_sim_restart_delivery.py::test_http_protocol_exception_is_relay_uncertainty[recursion]'),
    ('HTTPError body outside normalization', 'apps/server/fh_server/simulation.py',
     RELAY_NORMALIZED, RELAY_ERROR_BODY_UNWRAPPED,
     'apps/server/tests/test_sim_restart_delivery.py::test_http_protocol_exception_is_relay_uncertainty[error_reset]'),
    ('final STARTING organization lock omitted', 'apps/server/fh_server/simulation.py',
     '        lock_organization(db, user.org_id)\n        db.refresh(row)\n        not_created', '        db.refresh(row)\n        not_created',
     'apps/server/tests/test_sim_delayed_start.py::test_final_start_check_serializes_delete_after_refresh'),
]


EXIT = 'apps/simmgr/tests/test_agent_retained_exit.py::'
NATIVE_HOME_TEST = 'apps/simmgr/tests/test_native_catalogue.py::test_registered_l2_launcher_passes_the_selected_native_pair'
MUTATIONS += [
    ('retained exit treated as running', 'apps/simmgr/agent_unit.py',
     "state.get('ActiveState') == 'active' and state.get('SubState') == 'exited'",
     "False and state.get('SubState') == 'exited'",
     EXIT + 'test_retained_nonzero_returns_failure_without_wait_or_signal'),
    ('retained exit ignores live main PID', 'apps/simmgr/agent_unit.py',
     "                and state.get('MainPID') == '0'\n                and state.get('ExecMainCode')",
     "                and state.get('ExecMainCode')",
     EXIT + 'test_incomplete_or_live_exit_evidence_stays_pending'),
    ('retained exit ignores substate', 'apps/simmgr/agent_unit.py',
     " and state.get('SubState') == 'exited'", '',
     EXIT + 'test_incomplete_or_live_exit_evidence_stays_pending'),
    ('retained exit ignores main code', 'apps/simmgr/agent_unit.py',
     "                and state.get('ExecMainCode') in ('1', '2', '3')\n", '',
     EXIT + 'test_incomplete_or_live_exit_evidence_stays_pending'),
    ('agent show omits substate', 'apps/simmgr/agent_unit.py',
     'LoadState,ActiveState,SubState,Result', 'LoadState,ActiveState,Result',
     EXIT + 'test_show_requests_substate'),
    ('native inherits sealed home', 'apps/simmgr/launcher.py',
     "        native_env['HOME'] = str(native_home)", '        pass', NATIVE_HOME_TEST),
    ('native logger directory absent', 'apps/simmgr/launcher.py',
     "        (native_home / '.gz').mkdir(parents=True, mode=0o700)",
     '        native_home.mkdir(mode=0o700)', NATIVE_HOME_TEST),
]


def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--only', action='append', choices=[m[0] for m in MUTATIONS])
    args = parser.parse_args()
    temp = ROOT / 'tmp/p1c/mutations'
    temp.mkdir(parents=True, exist_ok=True)
    results = []
    for name, path, before, after, test in MUTATIONS:
        if args.only and name not in args.only:
            continue
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

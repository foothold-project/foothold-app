#!/usr/bin/env python3
"""Mutate disposable copies only; require a pytest failure, never collection errors.

Each transport mutation names a regression test. No production service is touched;
the tests use the existing disposable PostgreSQL harness and ASGI fake peers.
"""
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[3]
L = 'apps/server/fh_server/leases.py'
R = 'apps/server/fh_server/realtime.py'
PURE = 'apps/server/tests/test_leases.py'
REVIEW = 'apps/server/tests/test_realtime_review.py'
R2 = 'apps/server/tests/test_realtime_r2.py'
WIRE = 'apps/server/tests/test_realtime.py'
MUTATIONS = [
    ('request timeout 10 -> 20', L, 'timeout=10', 'timeout=20', PURE),
    ('TIMEOUT cooldown omitted', L, 'r.cooldown[req.actor.user] = at + 30', 'r.cooldown[req.actor.user] = at', PURE),
    ('lease heartbeat 15 -> 30', L, 'at - r.holder.heartbeat >= 15', 'at - r.holder.heartbeat >= 30', PURE),
    ('duplicate seq accepted', L, 'if seq <= h.seq:', 'if seq < h.seq:', PURE),
    ('command budget removed', L, 'if h.tokens < 1 and not neutral:', 'if False:', PURE),
    ('unlock CAS removed', L, 'if stop_gen != r.stop_gen:', 'if False:', PURE),
    ('stale stop generation accepted', L, 'or stop_gen <= tr.stop_gen:', ':', PURE),
    ('nonzero applied accepted', L, 'or applied != [0, 0, 0]', '', PURE),
    ('latch check removed', L, 'or not latched', '', PURE),
    ('late transfer ack accepted', L, 'or self.clock() >= tr.deadline', '', PURE),
    ('lease null replaced by stale lease', L,
     "self.effect('agent', robot, t='lease', lease_id=None, holder_type=None)",
     "self.effect('agent', robot, t='lease', lease_id='stale', holder_type='USER')", PURE),
    ('connection binding weakened', L, 'h.actor != actor', 'h.actor.user != actor.user', PURE),
    ('respond holder check omitted', L, '        self.owned(r, actor)\n        req = r.request', '        req = r.request', PURE),
    ('take allowed during transfer', L, 'if r.holder or r.transfer:', 'if r.holder:', PURE),
    ('request during transfer', L, '        if r.transfer:\n', '        if False:\n', PURE),
    ('second pending request allowed', L, 'or r.holder.actor.user == actor.user or r.request:', 'or r.holder.actor.user == actor.user:', PURE),
    ('hidden transferee not revoked', L, 'if r.transfer and r.transfer.actor == actor:', 'if False:', PURE),
    ('unreported earlier STOP ignored', L, 'r.stop_floor - 1, req)', 'r.stop_gen, req)', PURE),
    ('initial take cancel not notified', L, 'elif tr and tr.actor:', 'elif False:', PURE),
    ('strict 50 ms gate reintroduced', L, '        at = self.clock()\n        # 20 Hz',
     "        at = self.clock()\n        if at - h.last_cmd < .05:\n            raise LeaseError('CMD_RATE_LIMIT', 'too fast', 429)\n        # 20 Hz", PURE),
    ('zero input rate rejected', L, 'if h.tokens < 1 and not neutral:', 'if h.tokens < 1:', PURE),
    ('disconnect leaves request', R,
     '            if r.request and r.request.actor == actor:\n                self.apply(self.arbiter.cancel_request(rid))',
     '            if False:\n                pass', REVIEW + '::test_disconnect_pending_request_is_canceled'),
    ('disconnect leaves transfer', R,
     '            if r.transfer and r.transfer.actor == actor:\n                self.apply(self.arbiter.revoke(rid, actor))',
     '            if False:\n                pass', REVIEW + '::test_disconnect_pending_transfer_is_revoked'),
    ('safety enqueue keeps stale cmd', R, "if body['t'] in ('stop', 'lease', 'cmd'):", "if body['t'] == 'cmd':", REVIEW + '::test_safety_enqueue_discards_pre_stop_commands'),
    ('requester gone accepted', R, 'if pending.actor.connection not in self.screens:', 'if False:', REVIEW + '::test_disconnected_requester_cannot_be_granted_even_before_cleanup'),
    ('failed input gate ignored', R, "if (self.failed or self.audit_overloaded or self.owner_uncertain) and msg.t != 'stop':", 'if False:', REVIEW + '::test_failed_runtime_refuses_existing_connection_control_but_allows_stop'),
    ('audit overflow does not revoke', R, '                self.audit_overloaded = True\n                self.free_pending = True\n                self.finish_effects()', '                self.audit_overloaded = True', REVIEW + '::test_b1_full_queue_revokes_notifies_keeps_stop_and_recovers'),
    ('delivery policy omitted', R, "self.cached_access(peer, [body['robot']], 'ROBOT_READ')", 'pass', REVIEW + '::test_r7_delivery_checks_cached_policy_without_db'),
    ('replaced state handler gate omitted', R,
     '    def accept_state(self, rid, peer, msg):\n        if self.agents.get(rid) is not peer or peer.closing:\n            return False',
     '    def accept_state(self, rid, peer, msg):', REVIEW + '::test_replaced_agent_state_handler_has_its_own_identity_gate'),
    ('repeat audit aggregation omitted', R, '        if group is not None:\n', '        if False:\n', REVIEW + '::test_b1_repeated_denied_stop_agent_events_bounded_and_new_take_survives'),
    ('audit overload never recovers', R, '            self.audit_overloaded = False\n', '            pass\n', REVIEW + '::test_b1_full_queue_revokes_notifies_keeps_stop_and_recovers'),
    ('STOP waits for DB again', R,
     "                    if msg.t == 'stop':\n                        self.apply(self.arbiter.stop(rid, actor))",
     "                    if msg.t == 'stop':\n                        await asyncio.to_thread(self.load_policy, actor)\n                        self.apply(self.arbiter.stop(rid, actor))", REVIEW + '::test_b2_stop_bypasses_slow_db_and_twenty_queued_commands'),
    ('auth close retains lease', R, '        self.revoke_actor(peer.actor)\n        await peer.socket.close(code=code)', '        await peer.socket.close(code=code)', REVIEW + '::test_r3_deny_screen_revokes_before_socket_close_io'),
    ('emergency FREE not notified', R, "self.apply([effect for effect in effects if effect.target != 'audit'])", "self.apply([effect for effect in effects if effect.target == 'agent'])", REVIEW + '::test_r4_emergency_notifies_and_authority_recovers'),
    ('ownership never recovers', R, '                    self.failed = False  # recovery', '                    self.failed = True  # recovery', REVIEW + '::test_r4_emergency_notifies_and_authority_recovers'),
    ('RUN identity not bound', R, "body['holder_type'] = 'RUN:' + self.runs[rid]['run_id']", "body['holder_type'] = 'RUN'", REVIEW + '::test_r6_run_takeover_and_i1_bound_run_lease'),
    ('RUN takeover audit omitted', R, "'RUN_TAKE', 'RUN_PAUSE_TAKEOVER'):", "'RUN_TAKE'):", REVIEW + '::test_r6_run_takeover_and_i1_bound_run_lease'),
    ('invalid agent body disconnects', R,
     "                except ValidationError:\n                    self.note_audit(rid, {'op': 'AGENT_INVALID_FRAME'})\n                    if not admitted:\n                        await ws.close(code=1013)\n                        return\n                    continue",
     "                except ValidationError:\n                    await ws.close(code=4403)\n                    return", REVIEW + '::test_i2_invalid_agent_body_unknown_fields_and_binary_do_not_close'),
    ('invalid JSON renews liveness', R, '                if not isinstance(raw, dict) or not isinstance(raw.get(\'t\'), str):', '                peer.last_rx = self.clock()\n                if not isinstance(raw, dict) or not isinstance(raw.get(\'t\'), str):', REVIEW + '::test_i2_liveness_only_parseable_envelopes'),
    ('streams falsely enabled', R, "**{k: False for k in ('rgb', 'depth', 'lidar', 'map')}", "**{k: True for k in ('rgb', 'depth', 'lidar', 'map')}", REVIEW + '::test_i3_streams_remain_disabled'),
    ('origin prefix accepted', R, 'if not origin or origin != expected:', 'if not origin or not origin.startswith(expected):', WIRE + '::test_cookie_origin_and_first_protocol'),
    ('ingress budget omitted', R, 'if not self.ingress_allowed(peer):', 'if False:', REVIEW + '::test_b1_connection_ingress_bound_closes_flooder_only'),
    ('WebSocket backend pin omitted', 'apps/server/requirements.txt', 'websockets==15.0.1\n', '', 'apps/server/tests/test_ws_deployment.py::test_deployment_pins_websocket_backend_and_wire_size'),
    ('transport frame cap undocumented', 'apps/server/README.md', '--ws-max-size 4096', '--ws-max-size 65536', 'apps/server/tests/test_ws_deployment.py::test_deployment_pins_websocket_backend_and_wire_size'),
    ('agent severity normalization omitted', R, "severity=body.get('severity', 'INFO').upper()", "severity=body.get('severity', 'INFO')", REVIEW + '::test_i2_invalid_agent_body_unknown_fields_and_binary_do_not_close'),
    ('agent future fields forbidden', 'apps/contracts/models.py', "model_config = ConfigDict(extra='ignore', allow_inf_nan=False", "model_config = ConfigDict(extra='forbid', allow_inf_nan=False", REVIEW + '::test_i2_invalid_agent_body_unknown_fields_and_binary_do_not_close'),
    ('binary agent frame closes link', R, '        if agent and raw is None:\n            return None', "        if agent and raw is None:\n            await ws.close(code=1003)\n            raise WebSocketDisconnect(1003)", REVIEW + '::test_i2_invalid_agent_body_unknown_fields_and_binary_do_not_close'),
    ('operation denial closes connection', R, "(exc.status == 401 or msg.t == 'sub')", "exc.status in (401, 403, 404)", REVIEW + '::test_r9_invalid_hidden_replies_without_closing'),
    ('lease audit index omitted', 'apps/server/migrations/versions/0005_lease_log_index.py', "    op.create_index('lease_log_org_robot_at', 'lease_log', ['org_id', 'robot_id', sa.text('at DESC')])", '    pass', REVIEW + '::test_r10_lease_history_index_exists'),
    ('stale cache permits motion', R, 'if not safety and self.clock() - policy.checked > 0.5:', 'if False:', REVIEW + '::test_stale_authorization_blocks_motion_but_cached_stop_remains_immediate'),

    ('N1 transient rejection before accept', R, '        await ws.accept()\n        await ws.close(code=1013)', '        await ws.close(code=1013)', 'apps/server/tests/test_ws_recovery.py::test_n1_busy_is_retryable_1013_over_real_uvicorn'),
    ('N1 real PR8 reconnect forbidden', R, '        await ws.accept()\n        await ws.close(code=1013)', '        await ws.close(code=1013)', '@agent-reconnect'),
    ('N2 stale notification discarded', R, '                                except LeaseError:\n                                    try:', '                                except LeaseError:\n                                    return\n                                    try:', R2 + '::test_n2_stale_free_is_retried_after_snapshot_refresh'),
    ('N3 hello timeout fatal', R, "await ws.close(code=1013, reason='HELLO_TIMEOUT')", "await ws.close(code=4403, reason='HELLO_TIMEOUT')", R2 + '::test_n3_hello_deadline_is_retryable'),
    ('N4 screen denial bypasses ingress', R, '                if not self.ingress_allowed(peer):', '                if False:', R2 + '::test_n4_screen_denials_spend_ingress_before_validation'),
    ('N4 malformed agent bypasses ingress', R, 'admitted = self.ingress_allowed(peer, archive=archive)', 'admitted = True', R2 + '::test_n4_agent_invalid_frames_are_budgeted'),
    ('N5 emergency interleaves accepted batch', R, '                self.free_pending = True\n                self.finish_effects()', '                self.free_pending = False\n                self.emergency_free()', R2 + '::test_n5_overflow_free_follows_entire_accepted_effect_batch'),
    ('N6 startup standby never elects', R, '            self.failed = True\n        self.tasks', '            self.failed = True\n            return\n        self.tasks', R2 + '::test_n6_startup_standby_acquires_after_owner_stops'),
    ('N7 policy transient disconnects', R, '                except TRANSIENT_DB:\n                    age = self.clock() - peer.policy.checked', '                except TRANSIENT_DB:\n                    await self.deny_screen(peer, 1013)\n                    return\n                    age = self.clock() - peer.policy.checked', R2 + '::test_n7_single_policy_db_error_retries_without_dropping_lease'),
    ('N7 agent auth transient disconnects', R, '            except TRANSIENT_DB:\n                if self.agents.get(rid) is not peer:', '            except TRANSIENT_DB:\n                await peer.socket.close(code=1013)\n                return\n                if self.agents.get(rid) is not peer:', R2 + '::test_n7_single_agent_auth_db_error_keeps_connection'),
    ('N7 uncertain ownership disconnects', R, '                    self.owner_error_since = self.clock()\n                    self.emergency_free()', '                    self.owner_error_since = self.clock()\n                    self.emergency_free()\n                    for peer in self.agents.values():\n                        asyncio.create_task(peer.socket.close(code=1013))', R2 + '::test_n7_unknown_ownership_frees_but_keeps_stop_and_rechecks'),
    ('N7 stale policy fails to revoke', R, '                    if age > 0.5 and not peer.stale_revoked:\n                        self.revoke_actor(peer.actor)', '                    if False:\n                        self.revoke_actor(peer.actor)', R2 + '::test_n7_stale_policy_revokes_motion_but_preserves_stop_during_retry'),
    ('N7 retry grace unbounded', R, 'DB_RETRY_GRACE = 5.0', 'DB_RETRY_GRACE = 50.0', R2 + '::test_n7_retry_grace_is_bounded_and_closes_temporarily'),
    ('N8 duplicate RUN release restored', 'apps/server/fh_server/leases.py', 'effects = self.begin(robot, actor, op=None)', 'effects = self.begin(robot, actor)', R2 + '::test_n8_run_takeover_has_no_duplicate_release'),
    ('N9 event backlog disconnects', R, 'if not admitted and not archive:', 'if not admitted:', R2 + '::test_n9_backlog_events_do_not_disconnect_or_starve_state'),
    ('N9 events exhaust control budget', R, 'admitted = self.ingress_allowed(peer, archive=archive)', 'admitted = self.ingress_allowed(peer)', R2 + '::test_n9_backlog_events_do_not_disconnect_or_starve_state'),

    ('N7 stale read mislabeled forbidden', R, "                except LeaseError:\n                    # A stale snapshot is uncertainty, not an authorization denial.", "                except LeaseError:\n                    await self.deny_screen(peer, 4403)\n                    return\n                    # A stale snapshot is uncertainty, not an authorization denial.", R2 + '::test_n7_stale_successful_read_is_not_a_permanent_authorization_denial'),

]


def run(tree, tests):
    if tests == ['@agent-reconnect']:
        result = subprocess.run([sys.executable, 'apps/server/tools/check_agent_reconnect.py',
            '--agent-repo', str(ROOT)], cwd=tree, capture_output=True, text=True, timeout=90)
        return result.returncode, result.stdout + result.stderr
    result = subprocess.run([sys.executable, '-m', 'pytest', '-q', '-x', '-p', 'no:cacheprovider', *tests],
                            cwd=tree, capture_output=True, text=True, timeout=90)
    return result.returncode, result.stdout + result.stderr


def main():
    failed = []
    with tempfile.TemporaryDirectory(prefix='fh-realtime-mutations-') as folder:
        tree = Path(folder)
        shutil.copytree(ROOT / 'apps', tree / 'apps', ignore=shutil.ignore_patterns(
            '.venv', 'node_modules', '__pycache__', '.pytest_cache'))
        baseline, output = run(tree, [PURE, WIRE, REVIEW, R2, 'apps/server/tests/test_ws_deployment.py', 'apps/server/tests/test_ws_recovery.py'])
        if baseline:
            print(output)
            raise SystemExit('Baseline did not pass')
        print('| Broken decision | Detection |', flush=True)
        print('|---|---|', flush=True)
        for name, path, before, after, test in MUTATIONS:
            file = tree / path
            original = file.read_text()
            if before not in original:
                raise SystemExit('Mutation target missing: ' + name)
            file.write_text(original.replace(before, after, 1))
            try:
                code, output = run(tree, [test])
            finally:
                file.write_text(original)
            detected = code == 1 and ' failed' in output and 'ERROR collecting' not in output
            print(f'| {name} | {"detected" if detected else "MISSED"} |', flush=True)
            if not detected:
                failed.append(name)
                print(output, flush=True)
    if failed:
        raise SystemExit('Undetected mutations: ' + ', '.join(failed))
    print(f'{len(MUTATIONS)}/{len(MUTATIONS)} detected by pytest failures (no collection errors)')


if __name__ == '__main__':
    main()

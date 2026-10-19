#!/usr/bin/env python3
"""Mutate disposable copies only; require a pytest failure, never collection errors.

Each transport mutation names a regression test. No production service is touched;
the tests use the existing disposable PostgreSQL harness and ASGI fake peers.
"""
from pathlib import Path
import shutil
import json
import os
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[3]
L = 'apps/server/fh_server/leases.py'
R = 'apps/server/fh_server/realtime.py'
PURE = 'apps/server/tests/test_leases.py'
REVIEW = 'apps/server/tests/test_realtime_review.py'
R2 = 'apps/server/tests/test_realtime_r2.py'
R3 = 'apps/server/tests/test_realtime_r3.py'
WIRE = 'apps/server/tests/test_realtime.py'
MUTATIONS = [
    ('request timeout 10 -> 20', L, 'timeout=10', 'timeout=20', PURE),
    ('TIMEOUT cooldown omitted', L, 'r.cooldown[req.actor.user] = at + 30', 'r.cooldown[req.actor.user] = at', PURE),
    ('lease heartbeat 15 -> 30', L, 'at - r.holder.heartbeat >= 15', 'at - r.holder.heartbeat >= 30', PURE),
    ('duplicate seq accepted', L, 'or seq <= h.seq:', 'or seq < h.seq:', PURE),
    ('command budget removed', L, 'if h.tokens < 1 and not neutral:', 'if False:', PURE),
    ('unlock CAS removed', L, 'or stop_gen != r.stop_gen:', 'or False:', PURE),
    ('causal STOP reference ignored', L, 'or stop_ref != tr.stop_ref:', ':', R3 + '::test_b1_real_session_old_release_cannot_confirm_new_stop'),
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
    ('new STOP reuses earlier reference', L, 'r.stop_ref = min(MAX_SAFE_INTEGER, r.stop_ref + 1)', 'r.stop_ref = max(1, r.stop_ref)', R3 + '::test_b1_real_session_old_release_cannot_confirm_new_stop'),
    ('initial take cancel not notified', L, 'elif tr and tr.actor:', 'elif False:', PURE),
    ('strict 50 ms gate reintroduced', L, '        at = self.clock()\n        # 20 Hz',
     "        at = self.clock()\n        if at - h.last_cmd < .05:\n            raise LeaseError('CMD_RATE_LIMIT', 'too fast', 429)\n        # 20 Hz", PURE + '::test_twenty_hz_with_processing_jitter_has_no_false_rejections'),
    ('zero input rate rejected', L, 'if h.tokens < 1 and not neutral:', 'if h.tokens < 1:', PURE + '::test_zero_command_remains_valid_after_motion_budget_is_spent'),
    ('disconnect leaves request', R,
     '            if r.request and r.request.actor == actor:\n                self.apply(self.arbiter.cancel_request(rid))',
     '            if False:\n                pass', REVIEW + '::test_disconnect_pending_request_is_canceled'),
    ('disconnect leaves transfer', R,
     '            if r.transfer and r.transfer.actor == actor:\n                self.apply(self.arbiter.revoke(rid, actor))',
     '            if False:\n                pass', REVIEW + '::test_disconnect_pending_transfer_is_revoked'),
    ('safety enqueue keeps stale cmd', R, "if body['t'] in ('stop', 'lease', 'cmd'):", "if body['t'] == 'cmd':", REVIEW + '::test_safety_enqueue_discards_pre_stop_commands'),
    ('requester gone accepted', R, 'if pending.actor.connection not in self.screens:', 'if False:', REVIEW + '::test_disconnected_requester_cannot_be_granted_even_before_cleanup'),
    ('failed input gate ignored', R, "if (self.failed or self.audit_overloaded or self.owner_uncertain) and not safe and msg.t not in ('ping', 'sub'):", 'if False:', REVIEW + '::test_failed_runtime_refuses_existing_connection_control_but_allows_stop'),
    ('audit overflow does not revoke', R, '            self.audit_overloaded = True\n            self.free_pending = True\n            self.finish_effects()', '            self.audit_overloaded = True', REVIEW + '::test_b1_full_queue_revokes_notifies_keeps_stop_and_recovers'),
    ('delivery policy omitted', R, "self.cached_access(peer, [body['robot']], 'ROBOT_READ')", 'pass', REVIEW + '::test_r7_delivery_checks_cached_policy_without_db'),
    ('replaced state handler gate omitted', R,
     '    def accept_state(self, rid, peer, msg):\n        if self.agents.get(rid) is not peer or peer.closing:\n            return False',
     '    def accept_state(self, rid, peer, msg):', REVIEW + '::test_replaced_agent_state_handler_has_its_own_identity_gate'),
    ('repeat audit aggregation omitted', R, '        if group is not None:\n', '        if False:\n', 'apps/server/tests/test_realtime_pr13.py::test_repeated_ordinary_audits_preserve_full_aggregate_count'),
    ('audit overload never recovers', R, '            self.audit_overloaded = False\n', '            pass\n', REVIEW + '::test_b1_full_queue_revokes_notifies_keeps_stop_and_recovers'),
    ('STOP waits for DB again', R,
     "                    if msg.t == 'stop':\n                        self.apply(self.arbiter.stop(rid, actor))",
     "                    if msg.t == 'stop':\n                        await asyncio.to_thread(self.load_policy_batch, 'control')\n                        self.apply(self.arbiter.stop(rid, actor))", REVIEW + '::test_b2_stop_bypasses_slow_db_and_twenty_queued_commands'),
    ('auth close retains lease', R, '        self.revoke_actor(peer.actor)\n        await peer.socket.close(code=code)', '        await peer.socket.close(code=code)', REVIEW + '::test_r3_deny_screen_revokes_before_socket_close_io'),
    ('emergency FREE not notified', 'apps/server/fh_server/realtime.py', 'self.apply(safety + records)', "self.apply([e for e in safety if e.target == 'agent'] + records)", 'apps/server/tests/test_realtime_review.py::test_r4_emergency_notifies_and_authority_recovers'),
    ('ownership never recovers', R, '                    self.failed = False  # recovery', '                    self.failed = True  # recovery', REVIEW + '::test_r4_emergency_notifies_and_authority_recovers'),
    ('RUN identity not bound', R, "body['holder_type'] = 'RUN:' + self.runs[rid]['run_id']", "body['holder_type'] = 'RUN'", REVIEW + '::test_r6_run_takeover_and_i1_bound_run_lease'),
    ('RUN takeover audit omitted', R, "'RUN_TAKE', 'RUN_PAUSE_TAKEOVER'):", "'RUN_TAKE'):", REVIEW + '::test_r6_run_takeover_and_i1_bound_run_lease'),
    ('invalid agent body disconnects', 'apps/server/fh_server/realtime.py', '                except ValidationError:\n                    if archive:', '                except ValidationError:\n                    await ws.close(code=4400)\n                    return\n                    if archive:', 'apps/server/tests/test_realtime_review.py::test_i2_invalid_agent_body_unknown_fields_and_binary_do_not_close'),
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
    ('N4 malformed agent bypasses ingress', 'apps/server/fh_server/realtime.py', 'admitted = True if archive else self.ingress_allowed(peer)', 'admitted = True', 'apps/server/tests/test_realtime_r2.py::test_n4_agent_invalid_frames_are_budgeted'),
    ('N5 emergency interleaves accepted batch', R, '            self.free_pending = True\n            self.finish_effects()', '            self.free_pending = False\n            self.emergency_free()', R2 + '::test_n5_overflow_free_follows_entire_accepted_effect_batch'),
    ('N6 startup standby never elects', R, '            self.failed = True\n        self.watch_stop_invalidations()\n        self.tasks', '            self.failed = True\n            return\n        self.watch_stop_invalidations()\n        self.tasks', R2 + '::test_n6_startup_standby_acquires_after_owner_stops'),
    ('N7 policy transient disconnects', R, '                except TRANSIENT_DB:\n                    age = self.clock() - peer.policy.checked', '                except TRANSIENT_DB:\n                    await self.deny_screen(peer, 1013)\n                    return\n                    age = self.clock() - peer.policy.checked', R2 + '::test_n7_single_policy_db_error_retries_without_dropping_lease'),
    ('N7 agent auth transient disconnects', R, '            except TRANSIENT_DB:\n                if self.agents.get(rid) is not peer:', '            except TRANSIENT_DB:\n                await peer.socket.close(code=1013)\n                return\n                if self.agents.get(rid) is not peer:', 'apps/server/tests/test_realtime_pr13.py::test_brief_agent_verifier_error_retries_before_revoking_fresh_authority'),
    ('N7 uncertain ownership disconnects', R, '                    self.owner_error_since = self.clock()\n                    self.emergency_free()', '                    self.owner_error_since = self.clock()\n                    self.emergency_free()\n                    for peer in self.agents.values():\n                        asyncio.create_task(peer.socket.close(code=1013))', R2 + '::test_n7_unknown_ownership_frees_but_keeps_stop_and_rechecks'),
    ('N7 stale policy fails to revoke', R, '                    if age > 0.5 and not peer.stale_revoked:\n                        self.revoke_actor(peer.actor)', '                    if False:\n                        self.revoke_actor(peer.actor)', R2 + '::test_n7_stale_policy_revokes_motion_but_preserves_stop_during_retry'),
    ('N7 retry grace unbounded', R, 'DB_RETRY_GRACE = 5.0', 'DB_RETRY_GRACE = 50.0', R2 + '::test_n7_retry_grace_is_bounded_and_closes_temporarily'),
    ('N8 duplicate RUN release restored', 'apps/server/fh_server/leases.py', 'effects = self.begin(robot, actor, op=None)', 'effects = self.begin(robot, actor)', R2 + '::test_n8_run_takeover_has_no_duplicate_release'),
    ('M4 event backlog discarded', 'apps/server/fh_server/realtime.py', '                    if not self.queue_audit(effect):', '                    if False:', 'apps/server/tests/test_realtime_r2.py::test_n9_backlog_events_do_not_disconnect_or_starve_state'),
    ('M4 events bypass bounded audit queue', 'apps/server/fh_server/audit.py', '        self._unfinished_tasks += 1 - evicted', '        self._unfinished_tasks += 1', 'apps/server/tests/test_realtime_pr13.py::test_audit_capacity_evicts_only_ordinary_and_retains_fifo_and_safety'),

    ('N7 stale read mislabeled forbidden', R, "                except LeaseError:\n                    # A stale snapshot is uncertainty, not an authorization denial.", "                except LeaseError:\n                    await self.deny_screen(peer, 4403)\n                    return\n                    # A stale snapshot is uncertainty, not an authorization denial.", R2 + '::test_n7_stale_successful_read_is_not_a_permanent_authorization_denial'),

    ('B1 causal reference counter exhausted', 'apps/server/fh_server/leases.py', '        if exhausted:', '        if False:', 'apps/server/tests/test_realtime_r3.py::test_b1_reference_exhaustion_never_reuses_for_a_grant'),
    ('B2 recursive event validation bypassed', 'apps/contracts/models.py', '\n\nclass AgentRunUpdate(AgentInput):', "\n\n    @model_validator(mode='wrap')\n    @classmethod\n    def bypass_nested_validation(cls, value, handler):\n        return cls.model_construct(**value)\n\n\nclass AgentRunUpdate(AgentInput):", 'apps/server/tests/test_realtime_r3.py::test_b2_nested_data_must_be_postgresql_json'),
    ('B2 permanent audit retried forever', 'apps/server/fh_server/realtime.py', 'if self.permanent_audit_error(exc):', 'if False:', 'apps/server/tests/test_realtime_r3.py::test_b2_auditor_quarantines_permanent_but_retries_transient'),
    ('B3 conflicting schema silently overwritten', 'apps/contracts/generate.py', 'if name in defs and defs[name] != body:', 'if False:', 'apps/server/tests/test_realtime_r3.py::test_b3_generator_rejects_conflicting_nested_definitions'),
    ('B3 followup proto made required', 'apps/contracts/models.py', "proto: Literal['fh-rt/1'] = omitted(description='첫 메시지는 필수, 후속은 생략 가능; null은 거부한다.')", "proto: Literal['fh-rt/1']", 'apps/server/tests/test_realtime_r3.py::test_b3_wire_fixture_python_and_schema_match'),
    ('B3 optional observer lease serialized required', 'apps/contracts/models.py', "if key != 'lease_id'", "if True", 'apps/server/tests/test_realtime_r3.py::test_b3_wire_fixture_python_and_schema_match'),
    ('C1 server sequence upper bound omitted', 'apps/server/fh_server/leases.py', 'not 0 <= seq <= MAX_SAFE_INTEGER', 'not 0 <= seq', 'apps/server/tests/test_realtime_r3.py::test_c1_sequence_bounds_are_enforced_before_heartbeat'),
    ('C2 constant time token compare omitted', 'apps/server/fh_server/realtime.py', "hmac.compare_digest(robot.agent_token_hash or b'\\x00' * 32, candidate)", '(robot.agent_token_hash == candidate)', 'apps/server/tests/test_realtime_r3.py::test_c2_token_verification_uses_constant_time_comparison'),
    ('C3 terminal run revokes human lease', 'apps/server/fh_server/realtime.py', "if (msg.status != 'PAUSED' and holder and holder.holder_type == 'RUN'\n                                and run.get('lease_id') == holder.lease_id):", "if msg.status != 'PAUSED':", 'apps/server/tests/test_realtime_r3.py::test_c3_late_run_terminal_does_not_revoke_human'),
    ('M1 STOP reply waits behind stale notification', 'apps/server/fh_server/realtime.py', "(peer.urgent if body.get('t') == 'reply' else peer.queue).put_nowait(body)", 'peer.queue.put_nowait(body)', 'apps/server/tests/test_realtime_r3.py::test_m1_stop_reply_bypasses_notification_waiting_for_policy'),
    ('M2 release blocked by stale robot authorization', 'apps/server/fh_server/realtime.py', "elif msg.t == 'lease.release':\n                        self.apply", "elif msg.t == 'lease.release':\n                        if self.clock() - self.agents[rid].auth_checked > 0.5:\n                            raise LeaseError('ROBOT_AUTH_PENDING', 'fake pending', 503)\n                        self.apply", 'apps/server/tests/test_realtime_r3.py::test_m2_release_not_blocked_by_stale_robot_auth'),
    ('M3 policy timestamp taken after read', 'apps/server/fh_server/realtime.py', 'cached = replace(cached, checked=min(started, cached.checked))', 'cached = replace(cached, checked=self.clock())', 'apps/server/tests/test_realtime_r3.py::test_m3_policy_and_robot_auth_age_start_before_db_read'),
    ('M3 robot authorization timestamp taken after read', 'apps/server/fh_server/realtime.py', '                peer.auth_checked = max(peer.auth_checked, started)', '                peer.auth_checked = self.clock()', 'apps/server/tests/test_realtime_r3.py::test_m3_policy_and_robot_auth_age_start_before_db_read'),
    ('M5 read client deadline removed', 'apps/server/fh_server/realtime.py', 'asyncio.timeout(DB_READ_TIMEOUT)', 'asyncio.timeout(50)', 'apps/server/tests/test_realtime_r3.py::test_m5_stalled_db_has_client_deadline_and_stop_stays_live'),
    ('M6 default uses obsolete agent', 'apps/server/tools/check_agent_reconnect.py', "default='WORKTREE'", "default='e0cd2741ef9aecfc5cdd4c4962044213640a2428'", '@agent-reconnect'),
    ('M5 owner cleanup blocks safety loop', R, 'await self.read(conn.close)', 'conn.close()', R3 + '::test_m5_failed_owner_read_cleanup_never_blocks_stop'),
    ('W4 bounded read overlap removed', 'apps/server/fh_server/realtime.py', 'len(self.pending) < self.limit', 'len(self.pending) < 1', 'apps/server/tests/test_realtime_followup.py::test_read_ahead_has_finite_pending_slots_and_start_based_age'),
    ('W4 archival reader blocks state', 'apps/server/fh_server/realtime.py', '                    if not self.queue_audit(effect):', '                    await asyncio.sleep(.01)\n                    if not self.queue_audit(effect):', 'apps/server/tests/test_realtime_followup.py::test_400_event_backlog_does_not_delay_take_confirmation_or_safety'),
    ('W4 event FIFO reversed', 'apps/server/fh_server/history.py', 'sequence, result = self.memory.popleft()', 'sequence, result = self.memory.pop()', 'apps/server/tests/test_realtime_pr13.py::test_audit_capacity_evicts_only_ordinary_and_retains_fifo_and_safety'),
    ('W4 robot recheck scans fleet', 'apps/server/fh_server/realtime.py', 'if bound is not None:', 'if False:', 'apps/server/tests/test_realtime_followup.py::test_bound_agent_recheck_reads_one_robot_and_compares_digest'),
    ('W4 hello protocol rejection mislabeled auth', 'apps/server/fh_server/realtime.py', "                        await ws.close(code=4406, reason='PROTOCOL_MISMATCH')", "                        await ws.close(code=4403, reason='PROTOCOL_MISMATCH')", 'apps/server/tests/test_realtime_followup.py::test_old_agent_proto_is_explicit_protocol_close_with_reason_audit[hello]'),
    ('W4 uvicorn fixed production port', 'apps/server/tests/ws_process.py', "sock.bind(('127.0.0.1', 0))", "sock.bind(('127.0.0.1', 8453))", 'apps/server/tests/test_realtime_followup.py::test_tracked_uvicorn_launches_use_only_os_assigned_loopback_fds'),
    ('W4 full audit fails open', 'apps/server/fh_server/realtime.py', 'if self.audit.full() and not self.audit_overloaded:', 'if False:', 'apps/server/tests/test_realtime_followup.py::test_global_audit_full_preserves_safety_and_frees_control'),
    ('W4 pool serializes read-ahead', 'apps/server/fh_server/realtime.py', 'self.control_engine = reserved_engine(32)', 'self.control_engine = reserved_engine(1)', 'apps/server/tests/test_realtime_followup.py::test_slow_reads_keep_20hz_commands_and_take_available[connection-0.45]'),
    ('PR13 followup protocol rejection mislabeled auth', 'apps/server/fh_server/realtime.py', "\n                    await ws.close(code=4406, reason='PROTOCOL_MISMATCH')", "\n                    await ws.close(code=4403, reason='PROTOCOL_MISMATCH')", 'apps/server/tests/test_realtime_followup.py::test_old_agent_proto_is_explicit_protocol_close_with_reason_audit[followup]'),
    ('PR13 preaccept producer leaked', 'apps/server/fh_server/realtime.py', '            if not accepted:\n                await self.release_policy(peer)', '            if not accepted:\n                pass', 'apps/server/tests/test_realtime_pr13.py::test_preaccept_failure_releases_policy_producer[denied]'),
    ('PR13 reconnect owns another archive worker', 'apps/server/fh_server/realtime.py', '            peer.archive = self.audit', '            peer.archive = self.audit\n            self.archive_tasks.add(asyncio.create_task(asyncio.Event().wait()))', 'apps/server/tests/test_realtime_pr13.py::test_reconnects_have_one_runtime_backlog_and_safety_survives'),
    ('PR13 disconnect cancels in-flight auditor', 'apps/server/fh_server/realtime.py', '            peer.closing = True\n            for task in (sender, watcher):', '            peer.closing = True\n            self.tasks[1].cancel()\n            for task in (sender, watcher):', 'apps/server/tests/test_realtime_pr13.py::test_disconnect_does_not_cancel_last_inflight_safety'),
    ('PR13 safety-only spill dropped', 'apps/server/fh_server/history.py', 'if not self.safety(message):', 'if True:', 'apps/server/tests/test_realtime_pr13.py::test_audit_capacity_evicts_only_ordinary_and_retains_fifo_and_safety'),
    ('PR13 shared executor backlog reintroduced', 'apps/server/fh_server/realtime.py', '                    await self.capacity.acquire()', '                    pass', 'apps/server/tests/test_realtime_pr13.py::test_shared_read_capacity_never_builds_executor_queue'),
    ('PR13 control pool shares admission', 'apps/server/fh_server/realtime.py', 'self.control_factory = sessionmaker(self.control_engine, expire_on_commit=False)', 'self.control_factory = self.factory', 'apps/server/tests/test_realtime_pr13.py::test_take_stop_and_release_survive_exhausted_admission_pool'),
    ('PR13 control shares viewer executor', 'apps/server/fh_server/realtime.py', "self.control_executor = ThreadPoolExecutor(max_workers=32, thread_name_prefix='fh-control')", 'self.control_executor = self.auth_executor', 'apps/server/tests/test_realtime_pr13.py::test_reserved_resources_are_distinct'),
    ('PR13 forced EXPIRE record discarded', 'apps/server/fh_server/realtime.py', 'self.apply(safety + records)', 'self.apply(safety)', 'apps/server/tests/test_realtime_followup.py::test_global_audit_full_preserves_safety_and_frees_control'),
    ('PR13 dead policy producer never restarted', 'apps/server/fh_server/realtime.py', 'if current is None or current.task.done():', 'if current is None:', 'apps/server/tests/test_realtime_pr13.py::test_dead_snapshot_producers_restart_and_keep_start_based_freshness'),
    ('PR13 internal validation mislabeled protocol', 'apps/server/fh_server/realtime.py', "await ws.close(code=1011, reason='INTERNAL_VALIDATION')", "await ws.close(code=4406, reason='PROTOCOL_MISMATCH')", 'apps/server/tests/test_realtime_pr13.py::test_internal_validation_error_is_not_protocol_mismatch'),
    ('PR13 invalid archival envelope bypasses ingress', 'apps/server/fh_server/realtime.py', '                    if archive:\n                        admitted = self.ingress_allowed(peer)', '                    if archive:\n                        admitted = True', 'apps/server/tests/test_realtime_r2.py::test_n4_agent_invalid_frames_are_budgeted[bad-event]'),
    ('PR13 stale robot authority permits take', R, 'if self.clock() - self.agents[rid].auth_checked > 0.5:', 'if False:', R2 + '::test_n7_stale_agent_auth_blocks_authority_but_stop_is_still_forwarded'),
    ('PR13 pending consumer loses shared producer', R, '        if members:\n            self.policy_peers[sid] = next(iter(members.values()))', '        if False:\n            self.policy_peers[sid] = next(iter(members.values()))', 'apps/server/tests/test_realtime_pr13.py::test_pending_same_session_consumer_keeps_shared_producers_alive'),
    ('PR13 memoized rights bypass session revocation', R, 'or row.revoked_at or row.expires_at <= now()', 'or row.expires_at <= now()', 'apps/server/tests/test_realtime_pr13.py::test_live_rows_still_control_memoized_rights_and_session_validity'),
    ('PR13 screen denial allows input until close', 'apps/server/fh_server/realtime.py', '        peer.closing = True\n        peer.revoke_on_close = True', '        peer.revoke_on_close = True', 'apps/server/tests/test_realtime_pr13.py::test_known_screen_denial_blocks_input_before_close_finishes'),
    ('PR13 known agent denial leaves fresh authority', 'apps/server/fh_server/realtime.py', '            except self.api_error:\n                if self.agents.get(rid) is peer:\n                    self.retire_agent(rid, peer)', "            except self.api_error:\n                if self.agents.get(rid) is peer:\n                    self.apply(self.arbiter.revoke(rid, op='EXPIRE'))", 'apps/server/tests/test_realtime_pr13.py::test_known_agent_denial_cannot_confirm_a_new_take_during_close'),
    ('R2 dequeue fault fails open', 'apps/server/fh_server/realtime.py', "            except Exception as exc:\n                self.fail_audit_storage()\n                log.warning('Realtime history dequeue", "            except Exception as exc:\n                log.warning('Realtime history dequeue", 'apps/server/tests/test_realtime_storage.py::test_dequeue_failure_latches_gate_and_keeps_auditor_alive'),
    ('R2 storage fault clears input gate', 'apps/server/fh_server/realtime.py', '        self.audit_storage_failed = self.audit_overloaded = True', '        self.audit_storage_failed = self.audit_overloaded = False', 'apps/server/tests/test_realtime_storage.py::test_dequeue_failure_latches_gate_and_keeps_auditor_alive'),
    ('R2 dead auditor not supervised', 'apps/server/fh_server/realtime.py', 'if len(self.tasks) > 1 and self.tasks[1].done() and not self.tasks[1].cancelled():', 'if False:', 'apps/server/tests/test_realtime_storage.py::test_failed_auditor_is_restarted_with_gate_closed'),
    ('R2 robot event rate bypassed', 'apps/server/fh_server/realtime.py', 'if isinstance(self.audit, FairAuditQueue) and not self.audit.event_allowed(rid):', 'if False:', 'apps/server/tests/test_realtime_storage.py::test_one_robot_event_flood_cannot_revoke_or_starve_another[NOTE-info]'),
    ('R2 robot count unbounded', 'apps/server/fh_server/audit.py', '    MAX_RECORDS = 512', '    MAX_RECORDS = 1000000', 'apps/server/tests/test_realtime_storage.py::test_record_reservations_have_480_admission_slots_and_32_safety_slots'),
    ('R2 robot bytes unbounded', 'apps/server/fh_server/audit.py', '    MAX_BYTES = 2 * 1024 * 1024', '    MAX_BYTES = 200 * 1024 * 1024', 'apps/server/tests/test_realtime_storage.py::test_payload_quota_and_response_reservations_are_bounded_and_keep_robot_fifo'),
    ('R2 source fault revokes whole fleet', 'apps/server/fh_server/realtime.py', "        self.apply(self.arbiter.revoke(rid, op='EXPIRE'))\n        peer = self.agents.get(rid)", '        self.emergency_free()\n        peer = self.agents.get(rid)', 'apps/server/tests/test_realtime_storage.py::test_one_robot_event_flood_cannot_revoke_or_starve_another[NOTE-info]'),
    ('R2 fair robot rotation removed', 'apps/server/fh_server/audit.py', '            self.channels.move_to_end(rid)', '            pass', 'apps/server/tests/test_realtime_storage.py::test_fair_consumer_cannot_drain_one_robot_before_another_ready_robot'),
    ('R2 response reservation FIFO ignored', 'apps/server/fh_server/audit.py', '            while c.staged and c.staged[0][1]:', '            while c.staged:', 'apps/server/tests/test_realtime_storage.py::test_payload_quota_and_response_reservations_are_bounded_and_keep_robot_fifo'),
    ('R2 STOP audit runs before response', 'apps/server/fh_server/realtime.py', '        async def __call__(self, scope, receive, send):\n            try:', '        async def __call__(self, scope, receive, send):\n            if self.reservations is not None:\n                for reservation in self.reservations:\n                    realtime.audit.commit(reservation)\n            try:', 'apps/server/tests/test_realtime_storage.py::test_cancelled_http_response_still_owns_stop_record_and_does_not_block_other_robot'),
    ('R2 STOP cache invalidation removed', 'apps/server/fh_server/realtime.py', '            self.stop_cache_epoch += 1\n            self.stop_cache.clear()', '            pass', 'apps/server/tests/test_realtime_storage.py::test_cached_http_stop_is_invalidated_immediately_by_account_or_session_change[lock]'),
    ('R2 STOP cold read ignores revocation', 'apps/server/fh_server/realtime.py', 'if epoch != self.stop_cache_epoch:', 'if False:', 'apps/server/tests/test_realtime_storage.py::test_cold_authorization_crossing_revocation_cannot_publish_a_cached_stop'),
    ('R2 warm STOP waits for DB', 'apps/server/fh_server/realtime.py', 'if cached and started - cached[0] <= self.stop_cache_ttl and cached[2] > now():', 'if False:', 'apps/server/tests/test_realtime_storage.py::test_warm_http_stop_never_waits_for_db_and_saturation_is_explicit'),
    ('R2 cold STOP has only two slots', 'apps/server/fh_server/realtime.py', 'self.stop_slots = asyncio.Semaphore(12)', 'self.stop_slots = asyncio.Semaphore(2)', 'apps/server/tests/test_realtime_r3_followup.py::test_twenty_distinct_logins_all_reach_stop_after_slot_wait[0.45]'),
    ('R2 physical file cap omitted', 'apps/server/fh_server/history.py', "self.spill.execute('PRAGMA max_page_count=2048')", "self.spill.execute('PRAGMA max_page_count=0')", 'apps/server/tests/test_realtime_storage.py::test_spill_file_has_enforced_eight_mib_limit'),
    ('R2 file INSERT blocks event loop', 'apps/server/fh_server/history.py', "                self.io.submit('insert', sequence, message)", "                self._disk().execute('INSERT INTO history VALUES (?, ?)', (sequence, pickle.dumps(message)))\n                self.io.submit('peek')", 'apps/server/tests/test_realtime_storage.py::test_gated_robot_file_write_does_not_occupy_other_robots_event_loop'),

    ('R2 blocked source drops shutdown safety', 'apps/server/fh_server/realtime.py', "and body['op'] not in self.audit.RESERVED", 'and True', 'apps/server/tests/test_realtime_storage.py::test_source_shutdown_preserves_reserved_expiry_and_disconnect_records'),

    ('R2 failed startup leaks STOP cache hooks', 'apps/server/fh_server/realtime.py', '        self.owner_connection = self.read_engine.connect()', '        self.watch_stop_invalidations()\n        self.owner_connection = self.read_engine.connect()', 'apps/server/tests/test_realtime_storage.py::test_failed_start_does_not_register_global_stop_cache_listeners'),

    ('R2 cold STOP accepts session expired during read', 'apps/server/fh_server/realtime.py', 'if expires <= now():', 'if False:', 'apps/server/tests/test_realtime_storage.py::test_cold_stop_rechecks_session_expiry_after_the_read'),

    ('R3 full STOP slots reject immediately', 'apps/server/fh_server/realtime.py', '                await self.stop_slots.acquire()', "                if self.stop_slots.locked():\n                    raise self.api_error(503, 'SERVER_BUSY', 'busy')\n                await self.stop_slots.acquire()", 'apps/server/tests/test_realtime_r3_followup.py::test_twenty_distinct_logins_all_reach_stop_after_slot_wait[0]'),
    ('R3 STOP admission wait has no deadline', 'apps/server/fh_server/realtime.py', '            async with asyncio.timeout(DB_READ_TIMEOUT):\n                await self.stop_slots.acquire()', '            await self.stop_slots.acquire()\n            async with asyncio.timeout(DB_READ_TIMEOUT):', 'apps/server/tests/test_realtime_r3_followup.py::test_cold_slot_deadline_rejects_without_unverified_stop_or_slot_leak'),
    ('R3 join summary cascade restored', 'apps/server/fh_server/audit.py', '        self.flush_drop_summaries()\n        while True:\n            if not self._unfinished_tasks:', '        while True:\n            self.flush_drop_summaries()\n            if not self._unfinished_tasks:', 'apps/server/tests/test_realtime_r3_followup.py::test_join_preserves_latest_ordinary_records_instead_of_summary_cascade[255]'),

    ('S1 registration permits operator', 'apps/server/fh_server/api.py',
     "    def create_robot(body: C.RobotCreate, auth: Identity, db: DB, response: Response):\n        user = auth[0]\n        authorize(user, 'A')",
     "    def create_robot(body: C.RobotCreate, auth: Identity, db: DB, response: Response):\n        user = auth[0]\n        authorize(user, 'O')", 'apps/server/tests/test_robots.py::test_robot_crud_roles_owner_validation_one_time_token_and_audit'),
    ('S1 patch permits operator', 'apps/server/fh_server/api.py',
     "    async def patch_robot(robot_id: UUID, body: C.RobotPatch, auth: Identity, db: DB):\n        user = auth[0]\n        authorize(user, 'A')",
     "    async def patch_robot(robot_id: UUID, body: C.RobotPatch, auth: Identity, db: DB):\n        user = auth[0]\n        authorize(user, 'O')", 'apps/server/tests/test_robots.py::test_robot_crud_roles_owner_validation_one_time_token_and_audit'),
    ('S1 delete permits operator', 'apps/server/fh_server/api.py',
     "    async def delete_robot(robot_id: UUID, auth: Identity, db: DB):\n        user = auth[0]\n        authorize(user, 'A')",
     "    async def delete_robot(robot_id: UUID, auth: Identity, db: DB):\n        user = auth[0]\n        authorize(user, 'O')", 'apps/server/tests/test_robots.py::test_robot_crud_roles_owner_validation_one_time_token_and_audit'),
    ('S1 token stored raw', 'apps/server/fh_server/api.py',
     'owner_user_id=body.owner_user_id, agent_token_hash=digest(raw))',
     'owner_user_id=body.owner_user_id, agent_token_hash=raw.encode())', 'apps/server/tests/test_robots.py::test_robot_crud_roles_owner_validation_one_time_token_and_audit'),
    ('S1 other-owner telemetry leaked', 'apps/server/fh_server/robots.py',
     "full = user.role == 'ORG_ADMIN' or robot.owner_user_id == user.id", 'full = True',
     'apps/server/tests/test_robots.py::test_rest_summaries_reflect_state_and_mask_other_owner'),
    ('S1 REST summary ignores live state', 'apps/server/fh_server/robots.py',
     'peer = realtime.agents.get(str(robot.id)) if full else None', 'peer = None',
     'apps/server/tests/test_robots.py::test_rest_summaries_reflect_state_and_mask_other_owner'),
    ('S1 pose discarded', R, "peer.state['location'] = C.Location(**data['pose'], updated_at=now()).model_dump(mode='json')",
     "peer.state['location'] = None", 'apps/server/tests/test_robots.py::test_rest_summaries_reflect_state_and_mask_other_owner'),
    ('S1 hello inventory not stored', R,
     "[d.model_dump(mode='json') for d in hello.devices], hello.robot_model)",
     "[], hello.robot_model)", 'apps/server/tests/test_robots.py::test_rest_summaries_reflect_state_and_mask_other_owner'),
    ('S1 assignment keeps disconnected old lease', R,
     'self.apply(self.arbiter.revoke(rid, actor))', 'pass',
     'apps/server/tests/test_robots.py::test_assignment_revokes_disconnected_holder_without_waiting_fifteen_seconds'),
    ('S1 assignment clears all subscriptions', R,
     'peer.subscriptions.pop(rid, None)', 'peer.subscriptions.clear()',
     'apps/server/tests/test_robots.py::test_assignment_stops_before_revoke_notification_and_keeps_other_subscription'),
    ('S1 active control deletion allowed', 'apps/server/fh_server/api.py',
     '(record and (record.holder or record.transfer)) or active_run:', 'active_run:',
     'apps/server/tests/test_robots.py::test_assignment_stops_before_revoke_notification_and_keeps_other_subscription'),
    ('S1 active run deletion allowed', 'apps/server/fh_server/api.py',
     '(record and (record.holder or record.transfer)) or active_run:', '(record and (record.holder or record.transfer)):',
     'apps/server/tests/test_robots.py::test_delete_running_conflict_then_closes_agent_and_preserves_history'),
    ('S1 dashboard leaks organization totals', 'apps/server/fh_server/api.py',
     "if user.role != 'ORG_ADMIN':\n            query = query.where(Robot.owner_user_id == user.id)", 'if False:\n            pass',
     'apps/server/tests/test_robots.py::test_rest_summaries_reflect_state_and_mask_other_owner'),

    ('S1 assignment invalidates every user', R,
     "self.robot_changed_at[(rid, old_owner)] = self.clock()",
     "self.robot_changed_at.update({(rid, p.actor.user): self.clock() for p in self.screens.values()})",
     'apps/server/tests/test_robots.py::test_assignment_change_preserves_admin_holder_and_subscription'),

]


def run(tree, tests):
    report = tree / 'mutation-result.json'
    report.unlink(missing_ok=True)
    plugin = ['-p', 'fh_realtime_mutation_probe', '--realtime-mutation-report', str(report)]
    if tests == ['@agent-reconnect']:
        env = {**os.environ, 'FH_REALTIME_MUTATION_REPORT': str(report)}
        result = subprocess.run([sys.executable, 'apps/server/tools/check_agent_reconnect.py',
            '--agent-repo', str(ROOT)], cwd=tree, env=env, capture_output=True, text=True, timeout=300)
    else:
        result = subprocess.run([sys.executable, '-m', 'pytest', '-q', '-x', '-p', 'no:cacheprovider',
                                 *plugin, *tests], cwd=tree, capture_output=True, text=True, timeout=300)
    output = result.stdout + result.stderr
    try:
        data = json.loads(report.read_text())
        valid = (data['collected'] > 0 and data['exitstatus'] == result.returncode
                 and not data['errors'])
        code = result.returncode if valid and (result.returncode == 0 or data['assertions']) else 2
    except (OSError, ValueError, KeyError, TypeError):
        code = 2
    return code, output


def main():
    # Reject stale probes before spending a full database/integration baseline.
    for name, path, before, _, _ in MUTATIONS:
        if before not in (ROOT / path).read_text():
            raise SystemExit('Mutation target missing: ' + name)
    failed = []
    with tempfile.TemporaryDirectory(prefix='fh-realtime-mutations-') as folder:
        tree = Path(folder)
        shutil.copytree(ROOT / 'apps', tree / 'apps', ignore=shutil.ignore_patterns(
            '.venv', 'node_modules', '__pycache__', '.pytest_cache'))
        shutil.copyfile(ROOT / 'apps/server/tools/mutation_reporter.py', tree / 'fh_realtime_mutation_probe.py')
        baseline, output = run(tree, ['apps/server/tests'])
        if baseline:
            print(output)
            raise SystemExit('Baseline did not pass')
        summary = next((line for line in reversed(output.splitlines()) if ' passed' in line), 'passed')
        print('Full server baseline: ' + summary, flush=True)
        print('| Broken decision | Detection |', flush=True)
        print('|---|---|', flush=True)
        for name, path, before, after, test in MUTATIONS:
            file = tree / path
            original = file.read_text()
            if before not in original:
                raise SystemExit('Mutation target missing: ' + name)
            file.write_text(original.replace(before, after) if name in ('M5 read client deadline removed', 'R2 STOP cold read ignores revocation') else original.replace(before, after, 1))
            try:
                code, output = run(tree, [test])
            finally:
                file.write_text(original)
            detected = code == 1 and ' failed' in output and 'ERROR collecting' not in output
            print(f'| {name} | {"detected" if detected else "ERROR" if code != 0 else "MISSED"} |', flush=True)
            if not detected:
                failed.append(name)
                print(output, flush=True)
    if failed:
        raise SystemExit('Undetected mutations: ' + ', '.join(failed))
    print(f'{len(MUTATIONS)}/{len(MUTATIONS)} detected by assertion failures (no execution/collection errors)')


if __name__ == '__main__':
    main()

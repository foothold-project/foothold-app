"""Offline phone mutation checks, disposable copies INSIDE this worktree only."""
from pathlib import Path
import json
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
MUTATIONS = [
    ('controller guard removed', 'hub.py',
     "elif self.owner != peer or f['lease_id'] != self.session.lease_id:", 'elif False:',
     'test_phone_single_controller_and_connection_bound_lease'),
    ('open ticket expiry removed', 'hub.py',
     'if p.user is not None and self.now() >= p.deadline:', 'if False:',
     'test_phone_open_ticket_expiry_stops_locks_and_clears'),
    ('disconnect STOP and revocation removed', 'hub.py',
     "self._drop(peer, reserve=reserve, reason='DISCONNECTED')", 'pass',
     'test_phone_disconnect_stops_and_reserves_then_reconnects_with_new_lease'),
    ('expired ticket admitted', 'tickets.py',
     'or not issued <= current < expires', 'or False',
     'test_phone_rejects_invalid_ticket'),
    ('reservation protection removed', 'hub.py',
     "and self.reservation['identity'] != identity", 'and False',
     'test_phone_disconnect_stops_and_reserves_then_reconnects_with_new_lease'),
    ('legitimate same-device reacquisition denied', 'hub.py',
     "and self.reservation['identity'] != identity", 'and True',
     'test_phone_disconnect_stops_and_reserves_then_reconnects_with_new_lease'),
    ('cloud command isolation removed', 'observer.py',
     "return self.tick()  # lease/cmd/unlock/run.* never reach the real Session",
     'return self.phone.session.receive(f)',
     'test_phone_no_cloud_lease_cmd_unlock_run_or_reconnect_can_change_authority'),
    ('unsupported input fakes neutral', 'protocol.py',
     'if not any(limited) and any((vx, vy, wz)):', 'if False:',
     'test_phone_clipped_zero_cannot_replace_explicit_neutral'),
]


def review(label, target, before, after, test):
    return (label, target, before, after, 'tests/test_phone_review.py::'+test)


MUTATIONS += [
    review('transport validation close bypasses STOP', 'server.py',
           'if invalid is not None and peer in self.hub.peers and self.hub.peers[peer].user is not None:',
           'if False:', 'test_transport_viewer_invalid_close_stops_but_normal_close_does_not'),
    review('disconnect failure not propagated', 'server.py',
           'self._failed(primary if not isinstance(primary, asyncio.CancelledError) else error)',
           'pass', 'test_disconnect_sink_error_is_service_failure_and_always_cleans_tasks'),
    review('first cleanup error not preserved', 'server.py',
           'elif primary is not error:\n                    self._note(primary, error)',
           'elif primary is not error:\n                    pass',
           'test_handler_cleanup_preserves_first_error_or_cancellation'),
    review('production memory journal allowed', 'server.py', "or self.replay_path == ':memory:'", '',
           'test_production_settings_reject_memory_and_require_explicit_simulation'),
    review('private file permissions ignored', 'tickets.py', 'info.st_mode & 0o077', 'False',
           'test_private_files_reject_unsafe_modes_or_nonregular_files'),
    review('self cancellation cooldown removed', 'hub.py', "or self_cancel:",
           "or False:", 'test_request_cancel_flood_closes_only_requester_and_bounds_events'),
    review('request flood gate removed', 'hub.py', 'if p.request_count > 8:', 'if False:',
           'test_request_flood_rate_gate_closes_only_the_flooder'),
    review('notification replacement removed', 'hub.py', "if old['t'] == message['t']:", 'if False:',
           'test_notifications_are_latest_per_kind_without_process_failure'),
    review('unapproved socket can STOP', 'hub.py',
           'if safety and peer in self.peers and self.peers[peer].user is not None:', 'if safety:',
           'test_unapproved_socket_cannot_stop_authenticated_owner'),
    review('global pending hello capacity removed', 'server.py', 'else pending if len(pending) >= 16 else []', 'else []',
           'test_global_pending_cap_and_hello_verification_protection'),
    review('hello deadline removed', 'hub.py', 'if self.now() - p.last_ping >= 3:', 'if False:',
           'test_pending_hello_deadline_has_no_robot_effect'),
    review('view ticket can acquire authority', 'hub.py', "if p.purpose != 'control':", 'if False:',
           'test_view_credential_cannot_take_or_request_authority'),
    review('five second clock drift ignored', 'tickets.py',
           'or abs((current - self.anchor_wall) - (self.now() - self.anchor_mono)) > 5', 'or False',
           'test_open_clock_trust_or_five_second_drift_stops_and_clears'),
    review('fatal sequence guard removed', 'hub.py', "if f['seq'] <= self.session.last_seq:", 'if False:',
           'test_duplicate_or_reversed_sequence_is_fatal'),
    review('journal capacity ignored', 'tickets.py',
           "if self.db.execute('SELECT count(*) FROM used').fetchone()[0] >= MAX_USED:", 'if False:',
           'test_replay_capacity_retains_all_unexpired_ids'),
    review('restart clock rollback ignored', 'tickets.py', 'or self.last_wall < rows[0][1]', '',
           'test_restart_rejects_journal_utc_rollback'),
    review('viewer malformed frame bypasses STOP', 'hub.py',
           'if safety and peer in self.peers and self.peers[peer].user is not None:',
           'if safety and peer == self.owner:', 'test_authenticated_viewer_malformed_frame_stops_owner'),
    review('expired transfer target allowed', 'hub.py', 'if p.user is not None and self.now() >= p.deadline:',
           'if False:', 'test_expired_transfer_target_never_gets_authority'),
    review('reservation exceeds ticket deadline', 'hub.py', 'min(p.last_ping + 15, p.deadline)', 'p.last_ping + 15',
           'test_reservation_never_outlives_ticket_deadline'),
    review('JOSE header policy bypassed', 'tickets.py',
           "if set(header) != {'alg', 'typ', 'kid'} or header['alg'] != 'HS256' or header['typ'] != 'JWT':",
           'if False:', 'test_jose_header_manipulation_is_rejected'),
    review('JWS padding accepted', 'tickets.py',
           "if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_-]+', value):\n        raise ValueError(\"invalid base64url\")\n    decoded = base64.urlsafe_b64decode(value + '=' * (-len(value) % 4))\n    if base64.urlsafe_b64encode(decoded).rstrip(b'=').decode() != value:\n        raise ValueError(\"noncanonical base64url\")\n    return decoded",
           "return base64.urlsafe_b64decode(value + '=' * (-len(value) % 4))",
           'test_jws_padding_is_rejected'),
    review('second phone link timer restored', 'hub.py', 'server_link=False', 'server_link=True',
           'test_hub_is_only_link_timer_and_owner_matches_session_lease'),
    review('server stop_ref replaced with phone counter', 'observer.py', "'stop_ref': self.server_stop_ref",
           "'stop_ref': self.phone.session.stop_ref", 'test_observer_server_stop_reference_never_uses_phone_counter'),
    review('authority expiry omitted before receive', 'hub.py',
           'self._expire()  # expire ALL authority before any frame can emit motion', 'pass',
           'test_other_phone_frame_expires_owner_before_emitting_old_output'),
    review('intermediate input erases confirmed neutral', 'hub.py', 'core_axes = list(axes)',
           "core_axes = list(axes) if f['vx'] == .6 or not any(f[k] for k in ('vx', 'vy', 'wz')) else None",
           'test_intermediate_input_preserves_confirmed_neutral_but_never_creates_it'),
    ('simulation flag hardcoded', '../ros_bridge/__main__.py', 'simulation=config.phone.simulation',
     'simulation=True', 'test_phone_ros_entrypoint_uses_one_session_and_one_sink_without_starting_ros'),
    ('jti commit deferred past approval', 'tickets.py', 'with self.db:', 'if True:',
     'test_phone_replay_journal_survives_restart_and_fails_closed'),
]


MUTATIONS += [
    ('lateral input fakes neutral', 'protocol.py',
     '(0.0, 1.0 if vy > 0 else -1.0, 0.0) if vy else', '(0.0, 0.0, 0.0) if vy else',
     'test_phone_clipped_zero_cannot_replace_explicit_neutral'),
    ('rotation input fakes neutral', 'protocol.py',
     '(0.0, 0.0, 1.0 if wz > 0 else -1.0)', '(0.0, 0.0, 0.0)',
     'test_phone_clipped_zero_cannot_replace_explicit_neutral'),
    review('per source hello limit removed', 'server.py', 'len(same) >= 2', 'False',
           'test_other_source_churn_allows_same_device_reconnect_ten_of_ten'),
    review('validating hellos may be evicted', 'server.py', 'if p not in self.hello_started', 'if True',
           'test_same_source_pending_cap_cannot_evict_validating_hellos'),
    review('all cancellation causes penalize requester', 'hub.py', 'or self_cancel:', "or result == 'CANCELED':",
           'test_nonself_cancellation_does_not_penalize_requester'),
    review('authenticated capacity removed', 'hub.py',
           'if sum(other.user is not None for other in self.peers.values()) >= 16:', 'if False:',
           'test_authenticated_capacity_sixteen_denies_seventeenth_without_stop'),
    review('runtime file owner ignored', 'tickets.py', 'or info.st_uid != os.geteuid()', '',
           'test_private_files_require_runtime_uid'),
    review('journal inode swap accepted', 'tickets.py',
           'if (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino):', 'if False:',
           'test_replay_journal_inode_swap_is_refused'),
    review('request rate window never resets', 'hub.py', 'if self.now() - p.request_window >= 1:',
           "if p.request_window == float('-inf'):",
           'test_request_window_reset_keeps_normal_phone_alive_after_ninth_request'),
]
for code in (1002, 1003, 1007):
    codes = tuple(c for c in (1002, 1003, 1007, 1009) if c != code)
    MUTATIONS.append(review(f'transport {code} STOP removed', 'server.py', '(1002, 1003, 1007, 1009)',
                            repr(codes), 'test_transport_validation_close_codes_stop_authenticated_viewer'))


MUTATIONS += [
    review('requester release withdrawal unpenalized', 'hub.py',
           "if self.pending is not None and self.pending['peer'] == peer:\n            self._request_result('CANCELED', self_cancel=True)",
           "if self.pending is not None and self.pending['peer'] == peer:\n            self._request_result('CANCELED')",
           'test_requester_withdrawal_all_aliases_keep_identity_cooldown'),
    review('requester disconnect withdrawal unpenalized', 'hub.py',
           "self._request_result('CANCELED', self_cancel=requester_withdrawal)",
           "self._request_result('CANCELED')",
           'test_requester_withdrawal_all_aliases_keep_identity_cooldown'),
    review('release and view soft rate limit removed', 'hub.py',
           'if p.release_count > 8:', 'if False:',
           'test_release_and_view_excess_is_replied_ignored_without_disconnect'),
    review('global replacement ignores source load', 'server.py',
           'oldest = min(replaceable, key=lambda p: -counts[self.addresses[p]])',
           'oldest = replaceable[0]',
           'test_global_pending_replacement_uses_busiest_source_then_oldest'),
    review('global pending capacity regresses to four', 'server.py',
           'else pending if len(pending) >= 16 else []', 'else pending if len(pending) >= 4 else []',
           'test_global_pending_cap_and_hello_verification_protection'),
    review('clock cleanup counts as requester withdrawal', 'hub.py',
           "requester_withdrawal = code != 'CLOCK_UNTRUSTED'",
           'requester_withdrawal = True',
           'test_requester_cleanup_uses_cause_for_withdrawal_penalty'),
]


MUTATIONS += [
    review('REQUEST_FLOOD cleanup unpenalized', 'hub.py',
           "requester_withdrawal = code != 'CLOCK_UNTRUSTED'",
           "requester_withdrawal = code not in ('CLOCK_UNTRUSTED', 'REQUEST_FLOOD')",
           'test_requester_ws_fault_reconnect_cannot_repeat_accepted_requests'),
    review('malformed frame cleanup unpenalized', 'hub.py',
           "requester_withdrawal = code != 'CLOCK_UNTRUSTED'",
           "requester_withdrawal = code not in ('CLOCK_UNTRUSTED', 'VALIDATION')",
           'test_requester_ws_fault_reconnect_cannot_repeat_accepted_requests'),
    review('internal failure penalizes requester', 'server.py',
           'requester_withdrawal=primary is None and not self.stopping.is_set()',
           'requester_withdrawal=True', 'test_handler_cleanup_only_peer_causes_withdrawal_penalty'),
    review('cooldown spills to same users other devices', 'hub.py',
           'elif identity in self.cooldowns and self.now() < self.cooldowns[identity]:',
           'elif any(k[0] == identity[0] and self.now() < v for k, v in self.cooldowns.items()):',
           'test_request_cooldown_is_scoped_to_exact_user_device_pair'),
    review('release view excess closes phone', 'hub.py',
           "reply.update(ok=False, error=self.error('REQUEST_FLOOD'))\n                return reply  # Keep this phone connected and able to STOP.",
           "self.fail(peer, 'REQUEST_FLOOD', 1013, safety=False)",
           'test_release_and_view_excess_is_replied_ignored_without_disconnect'),
    review('release view excess still cancels pending request', 'hub.py',
           'return reply  # Keep this phone connected and able to STOP.', 'pass',
           'test_release_and_view_excess_is_replied_ignored_without_disconnect'),
    review('direct Hub pending cap removed', 'hub.py',
           'if sum(p.user is None for p in self.peers.values()) >= 16:', 'if False:',
           'test_direct_hub_unapproved_capacity_sixteen'),
]


MUTATIONS += [
    review('owner release is also rate limited', 'hub.py',
           "elif kind in ('lease.release', 'view') and self.owner != peer:",
           "elif kind in ('lease.release', 'view'):",
           'test_owner_release_is_safe_even_if_window_is_already_exhausted'),
    review('granted owner inherits nonowner windows', 'hub.py',
           "p.request_window = p.release_window = float('-inf')\n        p.request_count = p.release_count = 0", 'pass',
           'test_owner_release_ignores_limits_after_role_change_and_does_not_count'),
    review('requester ticket expiry is unpenalized', 'hub.py',
           'self.disconnect(peer, reserve=False, requester_withdrawal=True)',
           'self.disconnect(peer, reserve=False, requester_withdrawal=False)',
           'test_requester_short_ticket_expiry_cannot_repeat_request_with_new_tickets'),
    review('direct Hub cap regresses to four', 'hub.py',
           'if sum(p.user is None for p in self.peers.values()) >= 16:',
           'if sum(p.user is None for p in self.peers.values()) >= 4:',
           'test_direct_hub_unapproved_capacity_sixteen'),
]


def main():
    if sys.platform == 'linux':
        available = next(int(line.split()[1]) for line in Path('/proc/meminfo').read_text().splitlines()
                         if line.startswith('MemAvailable:'))
        if available < 2500000:
            raise SystemExit('MemAvailable below 2.5 GB; mutation checks not started')
    temp_root = ROOT.parents[1] / 'tmp' / 'phone-mutations'
    temp_root.mkdir(parents=True, exist_ok=True)
    failed = False
    for label, target, before, after, test in MUTATIONS:
        with tempfile.TemporaryDirectory(prefix='mutant-', dir=temp_root) as tmp:
            dest = Path(tmp)
            shutil.copytree(ROOT/'foothold_agent', dest/'foothold_agent', ignore=shutil.ignore_patterns('__pycache__'))
            shutil.copytree(ROOT/'tests', dest/'tests', ignore=shutil.ignore_patterns('__pycache__'))
            shutil.copyfile(ROOT/'tools/mutation_reporter.py', dest/'foothold_link_mutation_probe.py')
            source = dest/'foothold_agent/phone'/target
            original = source.read_text()
            if original.count(before) != 1:
                raise RuntimeError('mutation anchor is not unique: ' + label)
            source.write_text(original.replace(before, after))
            report = dest/'report.json'
            env = {**os.environ, 'TMPDIR': str(dest)}
            selected = test if '::' in test else 'tests/test_phone.py::'+test
            result = subprocess.run([sys.executable, '-m', 'pytest', selected,
                '-q', '--tb=short', '-p', 'foothold_link_mutation_probe', '--link-mutation-report', str(report)],
                cwd=dest, env=env, text=True, capture_output=True, timeout=25)
            data = json.loads(report.read_text()) if report.exists() else {}
            killed = (result.returncode == 1 and data.get('collected', 0) > 0
                      and bool(data.get('assertions')) and not data.get('errors'))
            print(f"{'KILLED' if killed else 'SURVIVED/ERROR'} | {label}", flush=True)
            if not killed:
                failed = True
                print(result.stdout[-2000:] + result.stderr[-500:])
    return int(failed)


if __name__ == '__main__':
    raise SystemExit(main())

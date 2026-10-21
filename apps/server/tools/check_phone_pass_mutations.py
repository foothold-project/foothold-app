"""Issuer mutations in disposable worktree-local copies, with assertion-only kills."""
from pathlib import Path
import json
import os
import shutil
import subprocess
import sys
import tempfile

ROOT=Path(__file__).resolve().parents[3]
MUTATIONS=[
    ('one phone one robot removed', 'if blocked:', 'if False:',
     'test_one_phone_one_robot_requires_explicit_switch_and_every_ack'),
    ('issuance rate limit removed', 'if len(recent) >= 10:', 'if False:',
     'test_issuer_limits_persist_across_sessions_and_device_slots'),
    ('switch allowed without ack', 'PhoneRevocation.acked_at.is_not(None))))', 'True)))',
     'test_one_phone_one_robot_requires_explicit_switch_and_every_ack'),
]


MUTATIONS = [(label,'phone_pass.py',before,after,test) for label,before,after,test in MUTATIONS] + [
    ('unsent ACK accepted','realtime.py',
     "if seq <= getattr(peer, 'phone_revoke_sent', 0):",'if True:',
     'test_ack_rejects_other_robot_and_unsent_sequence'),
    ('ACK robot binding removed','phone_pass.py',
     'PhoneRevocation.robot_id == UUID(robot_id), PhoneRevocation.batch_id == seq,',
     'PhoneRevocation.batch_id == seq,',
     'test_ack_rejects_other_robot_and_unsent_sequence'),
    ('revocation capacity reservation removed','phone_pass.py',
     'if reserved_rows + 1 > MAX_REVOCATIONS or reserved_bytes + MAX_REVOCATION_FRAME > MAX_REVOCATION_BYTES:', 'if False:',
     'test_revocation_capacity_reserves_at_issue_but_never_blocks_logout'),
    ('batch sends one JTI per frame','phone_pass.py',
     'if len(candidate) > 16 or size > 4096:', 'if len(members) >= 1:',
     'test_batches_are_wire_bounded_stable_and_ack_all_contained_jtis'),
    ('denial audit batching removed','phone_pass.py',
     'current - row.reported_at >= 1', 'True',
     'test_denial_audits_are_globally_batched_and_counter_survives_issuer_restart'),
    ('pending uses real UTC instead of injected clock','phone_pass.py',
     'PhoneRevocationBatch.until > int(clock())','PhoneRevocationBatch.until > int(time.time())',
     'test_revocation_and_pending_use_injected_issuer_utc'),
    ('revoke uses real UTC instead of injected clock','phone_pass.py',
     'PhonePass.exp > int(clock())','PhonePass.exp > int(time.time())',
     'test_revocation_and_pending_use_injected_issuer_utc'),
    ('ACK queue overflow retry removed','realtime.py',
     "retry = seq - 1\n                    previous = getattr(peer,'phone_revoke_retry',None)\n                    peer.phone_revoke_retry = retry if previous is None else min(previous,retry)\n                    peer.phone_revoke_sent = min(peer.phone_revoke_sent,retry)",
     'pass','test_full_ack_queue_retries_lowest_unconfirmed_and_deduplicates'),
    ('pending repeats sent sequence','phone_pass.py',
     'PhoneRevocationBatch.id > after','PhoneRevocationBatch.id >= after',
     'test_pending_does_not_repeat_sent_sequence_and_switch_preserves_view'),
    ('switch revokes view too','phone_pass.py',
     "device=device, purpose='control',clock=self.clock)","device=device,clock=self.clock)",
     'test_pending_does_not_repeat_sent_sequence_and_switch_preserves_view'),
    ('ACK queue deduplication removed','realtime.py',
     'if seq not in peer.phone_ack_pending:','if True:',
     'test_ack_deduplicates_while_saving_and_ignores_old_peer'),
    ('ACK storage failure keeps connection open','realtime.py',
     'await peer.socket.close(code=1013,reason=reason)','pass',
     'test_ack_storage_error_closes_1013_without_confirmation'),
    ('retained batches excluded from reservation','phone_pass.py',
     'return len(batches) + active, batch_bytes + active * MAX_REVOCATION_FRAME',
     'return active, active * MAX_REVOCATION_FRAME',
     'test_acked_batches_still_reserve_agent_rows'),
    ('background denial audit flush removed','api.py',
     'await asyncio.to_thread(issuer.flush_denials,factory,settings.org_id)','pass',
     'test_denial_audit_keeps_top_eight_users_and_quiet_background_flush'),
    ('revocation byte reservation removed','phone_pass.py',
     ' or reserved_bytes + MAX_REVOCATION_FRAME > MAX_REVOCATION_BYTES','',
     'test_revocation_byte_reservation_is_independent_of_rows'),
    ('robot clock retention grace removed','phone_pass.py',
     'ROBOT_CLOCK_GRACE = 60','ROBOT_CLOCK_GRACE = 0',
     'test_reservation_expiry_includes_robot_clock_grace'),
    ('ACK timeout mislabeled as storage failure','realtime.py',
     "'REVOCATION_ACK_STORAGE_TIMEOUT' if isinstance(","'REVOCATION_ACK_STORAGE_UNAVAILABLE' if isinstance(",
     'test_ack_timeout_late_commit_and_reconnect_are_bounded_and_idempotent'),

]


def main():
    available=next(int(line.split()[1]) for line in Path('/proc/meminfo').read_text().splitlines()
                   if line.startswith('MemAvailable:'))
    if available<2500000:
        raise SystemExit('MemAvailable below2.5GB')
    temp=ROOT/'tmp'/'phone-pass-mutations';temp.mkdir(parents=True,exist_ok=True)
    pgtemp=ROOT/'tmp'/'ppg'; pgtemp.mkdir(parents=True,exist_ok=True)
    failed=False
    for label,target,before,after,test in MUTATIONS:
        with tempfile.TemporaryDirectory(dir=temp,prefix='mutant-') as folder:
            dest=Path(folder)
            shutil.copytree(ROOT/'apps'/'server',dest/'apps'/'server',ignore=shutil.ignore_patterns('__pycache__'))
            shutil.copytree(ROOT/'apps'/'contracts',dest/'apps'/'contracts',ignore=shutil.ignore_patterns('__pycache__','node_modules'))
            shutil.copytree(ROOT/'apps'/'agent'/'foothold_agent',dest/'apps'/'agent'/'foothold_agent',ignore=shutil.ignore_patterns('__pycache__'))
            shutil.copyfile(ROOT/'apps'/'agent'/'tools'/'mutation_reporter.py',dest/'foothold_link_mutation_probe.py')
            source=dest/'apps'/'server'/'fh_server'/target
            original=source.read_text()
            if original.count(before)!=1: raise RuntimeError('nonunique anchor: '+label)
            source.write_text(original.replace(before,after))
            report=dest/'report.json'
            result=subprocess.run([sys.executable,'-m','pytest','apps/server/tests/test_phone_pass.py::'+test,
                '-q','--tb=short','-p','foothold_link_mutation_probe','--link-mutation-report',str(report)],
                cwd=dest,env={**os.environ,'TMPDIR':str(pgtemp),'FH_TEST_PORT_RANGE':os.environ.get('FH_TEST_PORT_RANGE','9450:9469')},
                capture_output=True,text=True,timeout=90)
            data=json.loads(report.read_text()) if report.exists() else {}
            killed=result.returncode==1 and data.get('collected',0)>0 and bool(data.get('assertions')) and not data.get('errors')
            print(('KILLED' if killed else 'SURVIVED/ERROR')+' | '+label,flush=True)
            if not killed:
                failed=True;print(result.stdout[-2500:]+result.stderr[-500:])
    return int(failed)


if __name__=='__main__': raise SystemExit(main())

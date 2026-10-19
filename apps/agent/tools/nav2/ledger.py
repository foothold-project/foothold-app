"""Registered, fsynced attempt ledger. No ROS, retries or selected-history input.

This is a local experiment audit, not authentication against a hostile filesystem
owner. A supervisor supplies explicit approval/cleanup receipts. A new experiment
requires a NEW registration and approval artifact; it is never auto-created by run.
"""
import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import time
from uuid import uuid4


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def sync_file(path, data):
    with path.open('x') as file:
        file.write(json.dumps(data, sort_keys=True)+'\n')
        file.flush()
        os.fsync(file.fileno())


class Ledger:
    def __init__(self, folder, config):
        self.folder, self.config = Path(folder), config
        self.registration = json.loads((self.folder/'registration.json').read_text())
        if self.registration['preregistration_sha256'] != digest(config):
            raise ValueError('preregistration differs; new approval/registration required')
        if not (self.folder/'attempts.jsonl').is_file():
            raise ValueError('registered ledger missing; never reconstruct a success prefix')

    @classmethod
    def register(cls, folder, config, approval):
        if (approval.get('preregistration_sha256') != digest(config)
                or not approval.get('experiment_id') or not approval.get('approval_id')
                or approval.get('approved_trials') != [1, 2, 3, 4]):
            raise ValueError('explicit safety-four approval with matching preregistration required')
        folder = Path(folder)
        folder.mkdir(parents=True, exist_ok=False)
        sync_file(folder/'registration.json', {**approval, 'schema': 'fh-nav2-ledger/1',
                  'registered_wall': time.time(), 'approval_sha256': digest(approval)})
        with (folder/'attempts.jsonl').open('x') as file:
            file.flush()
            os.fsync(file.fileno())
        fd = os.open(folder, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
        return cls(folder, config)

    @contextmanager
    def locked(self):
        # Separate processes serialize reservation, result and cleanup appends.
        with (self.folder/'attempts.jsonl').open('r+') as file:
            fcntl.flock(file, fcntl.LOCK_EX)
            rows, previous = [], digest(self.registration)
            for line in file:
                row = json.loads(line)  # partial/invalid append blocks, never discard
                claim = row.pop('sha256')
                if row.get('previous_sha256') != previous or digest(row) != claim:
                    raise ValueError('attempt ledger chain mismatch')
                row['sha256'] = claim
                previous = claim
                rows.append(row)
            def append(data):
                row = {**data, 'previous_sha256': previous, 'wall': time.time()}
                row['sha256'] = digest(row)
                file.seek(0, os.SEEK_END)
                file.write(json.dumps(row, sort_keys=True)+'\n')
                file.flush()
                os.fsync(file.fileno())  # durable BEFORE any ROS creation
                rows.append(row)
                return row
            yield rows, append

    @staticmethod
    def attempts(rows):
        reports = []
        for row in rows:
            if row['event'] == 'attempt_started':
                reports.append({**row, 'status': 'IN_PROGRESS', 'cleanup_verified': False})
            elif row['event'] in ('attempt_finished', 'cleanup_verified'):
                matches = [r for r in reports if r['attempt_id'] == row['attempt_id']]
                if len(matches) != 1:
                    raise ValueError('result without unique reservation')
                matches[0].update(row)
        return reports

    def approve_go(self, receipt):
        with self.locked() as (rows, append):
            reports = self.attempts(rows)
            if (len(reports) != 4 or any(r['status'] != 'SUCCEEDED' or not r['cleanup_verified'] for r in reports)
                    or any(r['event'] == 'attempt_denied' for r in rows)
                    or receipt.get('experiment_id') != self.registration['experiment_id']
                    or receipt.get('preregistration_sha256') != digest(self.config)
                    or not receipt.get('approval_id') or receipt.get('approval_id') == self.registration['approval_id']
                    or receipt.get('approved_trials') != list(range(5, 11))
                    or any(r['event'] == 'goal_phase_approved' for r in rows)):
                raise ValueError('fresh goal-phase GO requires clean successful safety four')
            append({'event': 'goal_phase_approved', 'receipt': receipt, 'receipt_sha256': digest(receipt)})

    def reserve(self, trial, isolated_start_id, confirmation):
        with self.locked() as (rows, append):
            reports = self.attempts(rows)
            valid = (type(trial) is int and 1 <= trial <= len(self.config['trials'])
                     and isinstance(confirmation, str) and bool(confirmation.strip())
                     and isinstance(isolated_start_id, str) and bool(isolated_start_id.strip())
                     and len(reports) == trial-1
                     and [r['trial_index'] for r in reports] == list(range(1, trial))
                     and all(r['status'] == 'SUCCEEDED' and r['cleanup_verified'] for r in reports)
                     and all(r['isolated_start_id'] != isolated_start_id and r['operator_confirmation'] != confirmation for r in reports)
                     and not any(r['event'] == 'attempt_denied' for r in rows)
                     and (trial <= 4 or any(r['event'] == 'goal_phase_approved' for r in rows)))
            if not valid:
                append({'event': 'attempt_denied', 'trial_index': trial, 'reason': 'HOLD_NO_RETRY_OR_APPROVAL',
                        'isolated_start_id': isolated_start_id})
                raise ValueError('HOLD: attempted/failed/incomplete trial, missing approval or reused confirmation')
            return append({'event': 'attempt_started', 'attempt_id': str(uuid4()), 'trial_index': trial,
                           'trial': self.config['trials'][trial-1], 'isolated_start_id': isolated_start_id,
                           'operator_confirmation': confirmation, 'experiment_id': self.registration['experiment_id'],
                           'preregistration_sha256': digest(self.config)})

    def finish(self, attempt, result):
        if result['status'] not in ('SUCCEEDED', 'FAILED', 'BLOCKED_NOT_STARTED'):
            raise ValueError('terminal result required')
        with self.locked() as (rows, append):
            reports = self.attempts(rows)
            matching = [r for r in reports if r['attempt_id'] == attempt['attempt_id']]
            if len(matching) != 1 or matching[0]['status'] != 'IN_PROGRESS':
                raise ValueError('attempt already settled or unknown')
            append({'event': 'attempt_finished', 'attempt_id': attempt['attempt_id'],
                    'status': result['status'], 'reason': result.get('reason'), 'cleanup_verified': False,
                    'result_sha256': digest(result)})

    def cleanup(self, receipt):
        with self.locked() as (rows, append):
            reports = self.attempts(rows)
            matching = [r for r in reports if r['attempt_id'] == receipt.get('attempt_id')]
            if (len(matching) != 1 or matching[0]['status'] != 'SUCCEEDED' or matching[0]['cleanup_verified']
                    or receipt.get('experiment_id') != self.registration['experiment_id']
                    or receipt.get('isolated_start_id') != matching[0]['isolated_start_id']
                    or not receipt.get('evidence_sha256')
                    or any(receipt.get(k) is not True for k in ('owned_processes_gone', 'cgroups_empty',
                         'partition_released', 'original_sources_unchanged'))):
                raise ValueError('matching explicit supervisor cleanup evidence required')
            append({'event': 'cleanup_verified', 'attempt_id': receipt['attempt_id'],
                    'cleanup_verified': True, 'receipt': receipt, 'receipt_sha256': digest(receipt)})

    def summary(self, config):
        if digest(config) != digest(self.config):
            raise ValueError('summary preregistration mismatch')
        with self.locked() as (rows, _):
            reports = self.attempts(rows)
            complete = (len(reports) == len(config['trials'])
                and [r['trial'] for r in reports] == config['trials']
                and [r['trial_index'] for r in reports] == list(range(1, 11))
                and len({r['isolated_start_id'] for r in reports}) == len(reports)
                and all(r['status'] == 'SUCCEEDED' and r['cleanup_verified'] for r in reports)
                and not any(r['event'] == 'attempt_denied' for r in rows))
            return {'r0_complete': complete, 'next_start': 'SEPARATE_APPROVAL_REQUIRED' if complete else 'HOLD',
                    'attempts': reports, 'success_count': sum(r['status'] == 'SUCCEEDED' for r in reports),
                    'blocked_not_started': sum(r['status'] == 'BLOCKED_NOT_STARTED' for r in reports),
                    'denied_invocations': sum(r['event'] == 'attempt_denied' for r in rows)}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('action', choices=['register', 'approve-go', 'cleanup', 'summary'])
    p.add_argument('--experiment', type=Path, required=True)
    p.add_argument('--receipt', type=Path)
    args = p.parse_args()
    config = json.loads(Path(__file__).with_name('preregistration.json').read_text())
    receipt = json.loads(args.receipt.read_text()) if args.receipt else None
    if args.action == 'register':
        Ledger.register(args.experiment, config, receipt or {})
    else:
        ledger = Ledger(args.experiment, config)
        if args.action == 'approve-go':
            ledger.approve_go(receipt or {})
        elif args.action == 'cleanup':
            ledger.cleanup(receipt or {})
        else:
            print(json.dumps(ledger.summary(config), indent=2))


if __name__ == '__main__':
    main()

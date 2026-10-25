"""Bounded commit-before-send run journal; disk I/O stays off the safety loop."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import json
import os
import sqlite3
from uuid import uuid4

from foothold_agent.phone.tickets import private_file


class RunOutbox:
    def __init__(self, path, *, limit=4096):
        path = os.fspath(path)
        if path != ':memory:':
            os.close(private_file(path, create=True))
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.execute('PRAGMA max_page_count=8192')
        self.db.execute('CREATE TABLE IF NOT EXISTS reports (instance TEXT, seq INTEGER, body TEXT, PRIMARY KEY(instance,seq))')
        self.db.execute('CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, body TEXT NOT NULL)')
        self.quarantine_path = path + '.quarantine' if path != ':memory:' else ':memory:'
        if self.quarantine_path != ':memory:':
            os.close(private_file(self.quarantine_path, create=True))
        self.quarantine = sqlite3.connect(self.quarantine_path, check_same_thread=False)
        self.quarantine.execute('PRAGMA synchronous=FULL')
        self.quarantine.execute('CREATE TABLE IF NOT EXISTS rejected (instance TEXT, seq INTEGER, body TEXT NOT NULL, rejection TEXT NOT NULL, PRIMARY KEY(instance,seq))')
        self.has_quarantine = self.quarantine.execute('SELECT 1 FROM rejected LIMIT 1').fetchone() is not None
        self.quarantining = set()
        self.runs = {i: json.loads(b) for i, b in self.db.execute('SELECT id,body FROM runs')}
        self.entries = {(i, s): json.loads(b) for i, s, b in self.db.execute('SELECT instance,seq,body FROM reports ORDER BY rowid')}
        archived = set()
        for instance, seq, body in self.quarantine.execute('SELECT instance,seq,body FROM rejected'):
            key = (instance,seq)
            if key in self.entries and self.entries[key] != json.loads(body):
                raise ValueError('quarantine/outbox identity conflict')
            archived.add(key)
        self.quarantining.update(archived)
        # Complete an interrupted move only after verifying the durable archive.
        with self.db:
            for key in archived:
                self.db.execute('DELETE FROM reports WHERE instance=? AND seq=?', key)
                self.entries.pop(key, None)
        self.committed = set(self.entries)
        self.instance = str(uuid4())
        self.seq = 0
        self.limit = limit
        self.jobs = []
        self.error = None
        self.quarantine_jobs = []
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix='run-journal')

    @property
    def available(self):
        return self.error is None and len(self.entries) < self.limit

    def append(self, message, now):
        if not self.available:
            raise RuntimeError('RECORDING_UNAVAILABLE')
        sequence = self.seq + 1
        message = deepcopy(message)
        identity = dict(agent_instance_id=self.instance, report_seq=sequence, monotonic_s=float(now))
        message.update(identity)
        if message.get('code') in ('RUN_WAYPOINT_ARRIVED', 'RUN_WAYPOINT_RECORDED'):
            message['data'].update(identity)
        key = (self.instance, sequence)
        body = json.dumps(message, allow_nan=False)
        self.seq = sequence
        self.entries[key] = message
        def write():
            with self.db:
                self.db.execute('INSERT INTO reports VALUES (?,?,?)', (*key, body))
                if message['t'] == 'run.update':
                    self.db.execute('INSERT OR REPLACE INTO runs VALUES (?,?)', (message['run_id'], body))
                elif message.get('code') == 'RUN_STARTED':
                    initial = dict(t='run.update', run_id=message['data']['run_id'], status='QUEUED',
                                   step=0, progress={'done': 0, 'total': 0}, wait_reason=None, fail_code=None)
                    self.db.execute('INSERT OR IGNORE INTO runs VALUES (?,?)',
                                    (initial['run_id'], json.dumps(initial)))
        self.jobs.append((self.pool.submit(write), key, message))
        return message

    def poll(self):
        # Quarantine is copy+FULL commit before deleting from the live outbox.
        # A crash between commits leaves two copies, never zero; startup removes
        # archived keys from replay below. The archive is append-only.
        for future, key in list(self.quarantine_jobs):
            if future.done():
                self.quarantine_jobs.remove((future, key))
                try:
                    future.result()
                    self.entries.pop(key, None)
                    self.committed.discard(key)
                except Exception as exc:
                    self.error = exc
        committed = []
        while self.jobs and self.jobs[0][0].done():
            future, key, message = self.jobs.pop(0)
            try:
                future.result()
            except Exception as exc:
                self.error = exc
                break
            if message is not None:
                self.committed.add(key)
                committed.append(message)
            else:
                self.entries.pop(key, None)
                self.committed.discard(key)
        return committed

    def replay(self):
        return [deepcopy(m) for key, m in self.entries.items() if key in self.committed and key not in self.quarantining]

    def reject(self, rejection):
        key = (rejection['agent_instance_id'], rejection['report_seq'])
        if key not in self.committed or key in self.quarantining:
            return False
        message = self.entries[key]
        run_id = message.get('run_id') if message['t'] == 'run.update' else message.get('data', {}).get('run_id')
        if rejection['run_id'] != run_id:
            return False
        if rejection['disposition'] != 'QUARANTINE':
            return False
        body, reason = json.dumps(message, allow_nan=False), json.dumps(rejection, allow_nan=False)
        self.quarantining.add(key)
        self.has_quarantine = True
        def archive():
            with self.quarantine:
                self.quarantine.execute('INSERT OR IGNORE INTO rejected VALUES (?,?,?,?)', (*key, body, reason))
            with self.db:
                self.db.execute('DELETE FROM reports WHERE instance=? AND seq=?', key)
        self.quarantine_jobs.append((self.pool.submit(archive), key))
        return True

    def ack(self, instance, seq):
        key = (instance, seq)
        if key in self.quarantining or key not in self.committed or any(k == key for _, k, _ in self.jobs):
            return False
        def delete():
            with self.db:
                self.db.execute('DELETE FROM reports WHERE instance=? AND seq=?', key)
        # Entry remains owned until the delete itself commits.
        self.jobs.append((self.pool.submit(delete), key, None))
        return True

    def close(self):
        self.pool.shutdown(wait=True)
        self.db.close()
        self.quarantine.close()

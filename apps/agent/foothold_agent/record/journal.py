"""Project only lock times and bounded cause labels from the local agent's journal."""
import json
import re
import subprocess
import time

from ..safety.lock_log import AGENT_CAUSES, SERVER_CAUSES

LOCK = re.compile(r'GO2_LOCK kind=lock cause=([a-z_]+)\b')


def event(message, mono, wall):
    match = LOCK.search(message)
    if match:
        cause = match[1]
        return dict(mono=mono, wall=wall, cause=cause if cause in AGENT_CAUSES | SERVER_CAUSES else 'unknown')


class Journal:
    def __init__(self):
        self.since = int(time.time())
        self.cursor = None
        self.pid = None
        self.due = 0
        self.state = 'no_agent'

    def poll(self, pid, *, final=False):
        now = time.monotonic()
        if not pid:
            self.state = 'no_agent'
            return []
        if now < self.due and not final:
            return []
        self.due = now + 5
        if self.pid != pid:
            self.pid, self.cursor = pid, None
        args = ['journalctl', '-b', '--no-pager', '-o', 'json', '--output-fields=MESSAGE',
                '--grep=GO2_LOCK kind=lock ', f'_PID={pid}']
        args.append('--after-cursor=' + self.cursor if self.cursor else f'--since=@{self.since}')
        try:
            result = subprocess.run(args, capture_output=True, timeout=1)
        except (OSError, subprocess.TimeoutExpired):
            self.state = 'unavailable'
            return []
        if result.returncode not in (0, 1) or result.stderr:
            self.state = 'unavailable'
            return []
        self.state = 'read'
        events = []
        for line in result.stdout.splitlines():
            if not line.startswith(b'{'):
                continue
            row = json.loads(line)
            self.cursor = row['__CURSOR']  # memory only; never retain journal identity or text
            entry = event(row['MESSAGE'], int(row['__MONOTONIC_TIMESTAMP']) * 1000,
                          int(row['__REALTIME_TIMESTAMP']) * 1000)
            if entry:
                events.append(entry)
        if not self.cursor:
            # Overlap the empty query by a second to cover records in flight.
            self.since = int(time.time()) - 1
        return events

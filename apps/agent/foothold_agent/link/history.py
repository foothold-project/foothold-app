"""FIFO history with bounded RAM and a disk spill for safety-only saturation.

Only locally created objects are pickled; no received pickle is ever decoded.
The spill belongs to this process (not an acknowledged crash-recovery journal).
Disk errors propagate so the caller stops rather than silently losing safety.
"""
from collections import deque
import pickle
import sqlite3
import tempfile


class History:
    def __init__(self, limit, safety, weight=lambda _: 1):
        self.limit, self.safety, self.weight = limit, safety, weight
        self.memory = deque()
        self.ordinary = deque()
        self.spill = None
        self.file = None
        self.disk_count = 0
        self.sequence = 0
        self.first = 0
        self.dropped = 0

    def __len__(self):
        return len(self.memory) + self.disk_count

    def __iter__(self):
        # Diagnostics only. Sending uses pop(), one record at a time.
        disk = [] if self.spill is None else [(n, pickle.loads(b)) for n, b in
                self.spill.execute('SELECT seq, body FROM history ORDER BY seq')]
        return iter([m for _, m in sorted([*self.memory, *disk], key=lambda item: item[0])])

    def __getitem__(self, index):
        return list(self)[index]

    def _disk(self):
        if self.spill is None:
            self.file = tempfile.TemporaryDirectory(prefix='fh-history-')
            # Each spill has its own private directory and unique database path.
            # SQLite must not open /proc/fd aliases (fd reuse aliases databases).
            self.spill = sqlite3.connect(self.file.name + '/history.sqlite', check_same_thread=False)
            self.spill.execute('PRAGMA journal_mode=OFF')
            self.spill.execute('PRAGMA synchronous=OFF')
            self.spill.execute('CREATE TABLE history (seq INTEGER PRIMARY KEY, body BLOB)')
        return self.spill

    def append(self, message, *, front=False):
        if len(self) >= self.limit:
            if not self.ordinary:
                if not self.safety(message):
                    self.dropped += self.weight(message)
                    return False
            else:
                removed = self.ordinary.popleft()
                self.memory.remove(removed)
                self.dropped += self.weight(removed[1])
        if front:
            self.first -= 1
            sequence = self.first
        else:
            self.sequence += 1
            sequence = self.sequence
        if len(self.memory) < self.limit:
            if front:
                self.memory.appendleft((sequence, message))
                if not self.safety(message):
                    self.ordinary.appendleft((sequence, message))
            else:
                self.memory.append((sequence, message))
                if not self.safety(message):
                    self.ordinary.append((sequence, message))
        else:
            self._disk().execute('INSERT INTO history VALUES (?, ?)', (sequence, pickle.dumps(message)))
            self.disk_count += 1
        return True

    def pop(self, index=0):
        if index != 0:
            raise IndexError('history only drains in FIFO order')
        row = None if self.spill is None or not self.disk_count else self.spill.execute(
            'SELECT seq, body FROM history ORDER BY seq LIMIT 1').fetchone()
        if self.memory and (row is None or self.memory[0][0] < row[0]):
            sequence, result = self.memory.popleft()
            if self.ordinary and self.ordinary[0][0] == sequence:
                self.ordinary.popleft()
            return result
        if row is None:
            raise IndexError('empty history')
        self.spill.execute('DELETE FROM history WHERE seq=?', (row[0],))
        self.disk_count -= 1
        result = pickle.loads(row[1])
        if not self.disk_count:
            self.spill.close()
            self.file.cleanup()
            self.spill = self.file = None
        return result

    def drain(self, limit):
        return [self.pop() for _ in range(min(limit, len(self)))]

    def close(self):
        if self.spill is not None:
            self.spill.close()
            self.file.cleanup()
            self.spill = self.file = None

    def __del__(self):
        self.close()

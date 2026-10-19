"""FIFO history with bounded RAM and a disk spill for safety-only saturation.

Only locally created objects are pickled; no received pickle is ever decoded.
The spill belongs to this process (not an acknowledged crash-recovery journal).
Disk errors propagate so the caller stops rather than silently losing safety.
"""
import asyncio
import queue
import threading
import time
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
        self.io = None
        self.disk_first = None
        self.last_evicted = None

    def __len__(self):
        return len(self.memory) + self.disk_count

    def __iter__(self):
        # Diagnostics only. Sending uses pop(), one record at a time.
        if self.io is not None and self.disk_count:
            raise RuntimeError('use await history.snapshot() for file diagnostics')
        disk = [] if self.spill is None or self.io is not None else [(n, pickle.loads(b)) for n, b in
                self.spill.execute('SELECT seq, body FROM history ORDER BY seq')]
        return iter([m for _, m in sorted([*self.memory, *disk], key=lambda item: item[0])])

    def __getitem__(self, index):
        return list(self)[index]

    def _disk(self):
        if self.spill is None:
            if self.file is None:
                self.file = tempfile.TemporaryDirectory(prefix='fh-history-')
            # Each spill has its own private directory and unique database path.
            # SQLite must not open /proc/fd aliases (fd reuse aliases databases).
            self.spill = sqlite3.connect(self.file.name + '/history.sqlite', check_same_thread=False)
            self.spill.execute('PRAGMA page_size=4096')
            self.spill.execute('PRAGMA journal_mode=OFF')
            self.spill.execute('PRAGMA synchronous=OFF')
            self.spill.execute('PRAGMA max_page_count=2048')  # hard 8MiB at default 4KiB pages
            self.spill.execute('PRAGMA cache_size=-128')
            self.spill.execute('CREATE TABLE IF NOT EXISTS history (seq INTEGER PRIMARY KEY, body BLOB)')
        return self.spill

    def append(self, message, *, front=False):
        self.last_evicted = None
        if len(self) >= self.limit:
            if not self.ordinary:
                if not self.safety(message):
                    self.dropped += self.weight(message)
                    return False
            else:
                removed = self.ordinary.popleft()
                self.memory.remove(removed)
                self.last_evicted = removed[1]
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
            if self.io is None:
                self._disk().execute('INSERT INTO history VALUES (?, ?)', (sequence, pickle.dumps(message)))
            else:
                self.io.submit('insert', sequence, message)
            self.disk_first = sequence if not self.disk_count else (
                min(self.disk_first, sequence) if self.disk_first is not None else
                sequence if front else None)
            self.disk_count += 1
        return True

    def pop(self, index=0):
        if index != 0:
            raise IndexError('history only drains in FIFO order')
        if self.io is not None:
            if self.memory and (not self.disk_count or (
                    self.disk_first is not None and self.memory[0][0] < self.disk_first)):
                return self._pop_memory()
            if self.disk_count and self.io.error is not None:
                raise self.io.error
            if self.disk_count and (self.io.pending or self.io.head is None):
                self.io.ready.clear()
                raise HistoryPending()
            if not self.disk_count:
                raise IndexError('empty history')
            sequence, result = self.io.head
            self.io.submit('delete', sequence)
            self.disk_count -= 1
            self.disk_first = None
            self.io.head = None
            return result
        row = None if self.spill is None or not self.disk_count else self.spill.execute(
            'SELECT seq, body FROM history ORDER BY seq LIMIT 1').fetchone()
        if self.memory and (row is None or self.memory[0][0] < row[0]):
            return self._pop_memory()
        if row is None:
            raise IndexError('empty history')
        result = pickle.loads(row[1])  # decode before deleting the retained row
        self.spill.execute('DELETE FROM history WHERE seq=?', (row[0],))
        self.disk_count -= 1
        if not self.disk_count:
            self._close_disk()
        return result

    def _pop_memory(self):
        sequence, result = self.memory.popleft()
        if self.ordinary and self.ordinary[0][0] == sequence:
            self.ordinary.popleft()
        return result

    def drain(self, limit):
        messages = []
        for _ in range(min(limit, len(self))):
            try:
                messages.append(self.pop())
            except HistoryPending:
                break
        return messages

    def _close_disk(self, *, cleanup=True):
        if self.spill is not None:
            self.spill.close()
            self.spill = None
        if cleanup and self.file is not None:
            self.file.cleanup()
            self.file = None

    def background(self, on_error=lambda _: None, on_pressure=lambda: None, *, limit=256, on_ready=lambda: None):
        if self.io is not None and self.io.closing and self.io.closed.is_set():
            self.io = None
        if self.io is None:
            # Existing offline spill is handed over (check_same_thread=False).
            # Seed its first sequence without issuing SQL on the event loop.
            self.disk_first = None if self.disk_count else self.disk_first
            self.io = FileWorker(self, asyncio.get_running_loop(), on_error, on_pressure, limit, on_ready)
            if self.disk_count:
                self.io.submit('peek')
        return self.io

    async def readable(self):
        if self.io is not None:
            await self.io.ready.wait()

    async def writable(self):
        if self.io is not None:
            await self.io.writable.wait()

    async def snapshot(self):
        if self.io is None or not self.disk_count:
            return list(self)
        memory = list(self.memory)
        result = asyncio.get_running_loop().create_future()
        self.io.submit('snapshot', result=result)
        disk = await asyncio.shield(result)
        return [m for _, m in sorted(memory + disk, key=lambda item: item[0])]

    def close(self):
        if self.io is not None:
            self.io.close()
        else:
            self._close_disk()

    def __del__(self):
        self.close()
        if self.io is not None and self.io.closed.is_set() and self.file is not None:
            # Keep unlink/cleanup out of another live robot's event loop too.
            folder, self.file = self.file, None
            threading.Thread(target=folder.cleanup, name='fh-history-cleanup', daemon=True).start()


class HistoryPending(Exception):
    """FIFO head is still owned by the file worker; await readable()."""


class HistoryCapacityError(RuntimeError):
    """Producer exceeded its reserved admission budget."""


class FileWorker:
    """One daemon, bounded submissions, one retrying in-flight file operation.

    Metadata/RAM are owned by the event loop. Only this worker touches SQLite.
    Completion never needs the event loop to finish an operation. Shutdown does
    not join stalled storage before STOP; queued records remain owned here.
    """
    HIGH_WATER = 64

    def __init__(self, history, loop, on_error, on_pressure, limit, on_ready):
        self.history, self.loop = history, loop
        self.on_error, self.on_pressure, self.on_ready = on_error, on_pressure, on_ready
        self.limit = limit
        self.commands = queue.Queue(maxsize=limit)
        self.pending = 0
        self.error = None
        self.head = None
        self.closing = False
        self.ready = asyncio.Event()
        self.ready.set()
        self.writable = asyncio.Event()
        self.writable.set()
        self.closed = threading.Event()
        self.thread = None

    @property
    def pressured(self):
        return self.pending >= self.HIGH_WATER or self.error is not None

    def reserve(self, limit):
        self.limit = max(self.limit, limit)
        with self.commands.mutex:
            self.commands.maxsize = self.limit

    def submit(self, operation, sequence=None, message=None, result=None):
        if self.closing or self.pending >= self.limit:
            raise HistoryCapacityError('history producer admission is closed')
        self.pending += 1
        self.commands.put_nowait((operation, sequence, message, result))
        if self.thread is None:
            self.thread = threading.Thread(target=self.run, name='fh-history', daemon=True)
            self.thread.start()
        if self.pressured:
            self.writable.clear()
            self.on_pressure()

    def notify(self, callback, *args):
        try:
            self.loop.call_soon_threadsafe(callback, *args)
        except RuntimeError:
            pass  # process/loop shutdown; records stay owned until drained

    def failed(self, error):
        first = self.error is None
        self.error = error
        self.writable.clear()
        self.ready.set()
        self.on_ready()
        if first:
            self.on_error(error)

    def completed(self, head, result, value):
        self.pending -= 1
        self.error = None
        if self.pending == 0:
            self.head = head
            self.history.disk_first = None if head is None else head[0]
            self.ready.set()
            self.writable.set()
        self.on_ready()
        if result is not None and not result.done():
            result.set_result(value)

    def run(self):
        try:
            while not self.closing or not self.commands.empty():
                try:
                    job = self.commands.get(timeout=.05)
                except queue.Empty:
                    continue
                operation, sequence, message, result = job
                # Retain the operation, including its payload, until success.
                applied = False
                while True:
                    try:
                        disk = self.history._disk()
                        value = None
                        if not applied:
                            if operation == 'insert':
                                disk.execute('INSERT OR IGNORE INTO history VALUES (?, ?)', (sequence, pickle.dumps(message)))
                            elif operation == 'delete':
                                disk.execute('DELETE FROM history WHERE seq=?', (sequence,))
                            applied = True
                        if operation == 'snapshot':
                            value = [(n, pickle.loads(b)) for n, b in disk.execute('SELECT seq, body FROM history ORDER BY seq')]
                        row = disk.execute('SELECT seq, body FROM history ORDER BY seq LIMIT 1').fetchone()
                        head = None if row is None else (row[0], pickle.loads(row[1]))
                        break
                    except Exception as error:
                        self.notify(self.failed, error)
                        time.sleep(.1)
                self.notify(self.completed, head, result, value)
                self.commands.task_done()
        finally:
            # File close/unlink are file I/O too: keep them on this worker.
            self.history._close_disk(cleanup=not self.history.disk_count)
            self.closed.set()

    def close(self):
        self.on_error, self.on_pressure, self.on_ready = lambda _: None, lambda: None, lambda: None
        self.closing = True
        if self.thread is None:
            if self.history.spill is not None or self.history.file is not None:
                self.thread = threading.Thread(target=self.run, name='fh-history', daemon=True)
                self.thread.start()
            else:
                self.closed.set()

"""Bounded nonblocking event submission; disk work runs outside the owner loop."""
import json
import math
import queue
import threading


def finite_json(value):
    if isinstance(value, dict):
        return {k: finite_json(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [finite_json(v) for v in value]
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


class Journal:
    def __init__(self, path, *, capacity=256):
        self.queue = queue.Queue(maxsize=capacity)
        self.error = None
        self.file = path.open('x')
        self.closed = False
        self.thread = threading.Thread(target=self._write, name='nav-journal', daemon=True)
        self.thread.start()

    def emit(self, record):
        if self.error is not None:
            raise RuntimeError('trial journal failed') from self.error
        if self.closed:
            raise RuntimeError('trial journal closed')
        # No waiting, including on full/failed disks. Overflow reaches runner's
        # finally -> Core STOP/0 and cancel; do not silently lose safety evidence.
        self.queue.put_nowait(json.dumps(finite_json(record), allow_nan=False)+'\n')

    def _write(self):
        try:
            while True:
                text = self.queue.get()
                if text is None:
                    break
                self.file.write(text)
                self.file.flush()
        except BaseException as exc:
            self.error = exc
        finally:
            try:
                self.file.close()
            except BaseException as exc:
                self.error = self.error or exc

    def close(self):
        self.closed = True
        try:
            self.queue.put(None, timeout=1)
        except queue.Full:
            raise RuntimeError('journal shutdown queue stalled') from None
        self.thread.join(timeout=1)
        if self.thread.is_alive():
            raise RuntimeError('journal writer did not finish')
        if self.error is not None:
            raise RuntimeError('trial journal failed') from self.error

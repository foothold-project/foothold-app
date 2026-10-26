"""One overwrite slot in shared memory; no Queue feeder/backlog or blocking put."""
import pickle


class LatestSlot:
    def __init__(self, context, capacity):
        self.buffer = context.RawArray('B', capacity)
        self.length = context.RawValue('i', 0)
        self.lock = context.Lock()

    def put(self, item):
        data = pickle.dumps(item, protocol=5)
        if len(data) > len(self.buffer) or not self.lock.acquire(False):
            return False
        try:
            memoryview(self.buffer).cast('B')[:len(data)] = data
            self.length.value = len(data)
            return True
        finally:
            self.lock.release()

    def take(self):
        if not self.lock.acquire(False):
            return None
        try:
            length = self.length.value
            if not length:
                return None
            data = bytes(memoryview(self.buffer).cast('B')[:length])
            self.length.value = 0
        finally:
            self.lock.release()
        # Only our own bounded producer writes these bytes, never a network peer.
        return pickle.loads(data)

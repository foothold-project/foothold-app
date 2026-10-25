"""Bounded, thread-safe multi-goal port; never waits on the Hub safety loop."""
from copy import deepcopy
import threading


class GoalActions:
    def __init__(self):
        self.lock = threading.Lock()
        self.active = self.pending = None
        self.cancel_requested = False
        self.finished = False
        self.available = False

    def ready(self):
        with self.lock:
            return self.available

    def submit(self, binding, point):
        with self.lock:
            if not self.available or self.active is not None and not self.finished:
                raise ValueError('previous goal cancellation unconfirmed')
            self.active, self.pending = binding, (binding, deepcopy(point))
            self.cancel_requested = self.finished = False

    def cancel(self, binding):
        with self.lock:
            if binding == self.active:
                self.cancel_requested = True

    def cancel_confirmed(self, binding):
        with self.lock:
            return self.active != binding or self.finished

    def take(self):
        with self.lock:
            pending, self.pending = self.pending, None
            return pending, self.active if self.cancel_requested and not self.finished else None

    def complete(self, binding):
        with self.lock:
            if binding == self.active:
                self.finished = True

    def health(self, available):
        with self.lock:
            self.available = bool(available)

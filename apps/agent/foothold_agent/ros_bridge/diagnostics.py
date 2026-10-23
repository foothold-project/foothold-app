"""Bounded in-memory phase stamps; one asynchronous dump on publisher stall."""

import faulthandler
from collections import deque
import json
import os
import re
import sys
import threading
import time


def thread_stacks():
    """Capture all threads without exposing full filenames, source or locals."""
    fd = os.memfd_create("ros-stall-stack", flags=os.MFD_CLOEXEC)
    try:
        faulthandler.dump_traceback(file=fd, all_threads=True)
        os.lseek(fd, 0, os.SEEK_SET)
        raw = os.read(fd, 1024 * 1024).decode("utf-8", errors="replace")
    finally:
        os.close(fd)
    return re.sub(r'File "([^"]*)"',
                  lambda match: 'File "' + os.path.basename(match[1]) + '"', raw)


class StallDiagnostics:
    """Diagnostic I/O never runs on the publisher, watchdog or owning loop.

    Phase names are fixed by the bridge; no message, address, exception text or
    credential enters the record. Only the first stall requests a dump. Stamps
    describe the detection instant; stacks have their own later capture time.
    """

    def __init__(self, *, now=time.monotonic, write=None, dump=thread_stacks):
        self.now = now
        self.write = write if write is not None else sys.stderr.write
        self.dump = dump
        self._lock = threading.Lock()
        self._phases = {}
        self._history = deque(maxlen=256)
        self._active = {}
        self._sequence = 0
        self._incident = None
        self._wake = threading.Event()
        self._thread = None

    def start(self):
        try:
            worker = threading.Thread(target=self._run, name="ros-stall-diagnostics", daemon=True)
            worker.start()
            self._thread = worker
        except Exception:
            pass  # unavailable diagnostics cannot prevent startup ZERO/STOP

    def mark(self, phase, edge):
        try:
            with self._lock:
                self._phases[phase + "_" + edge] = self.now()
        except Exception:
            pass

    def call(self, phase, function, *args, **kwargs):
        sequence = None
        try:
            started, cpu_started = self.now(), time.thread_time()
            with self._lock:
                self._sequence += 1
                sequence = self._sequence
                self._active[sequence] = dict(phase=phase, thread_id=threading.get_native_id(),
                                             start=started, cpu_start=cpu_started)
        except Exception:
            pass
        self.mark(phase, "start")
        try:
            return function(*args, **kwargs)
        finally:
            self.mark(phase, "end")
            try:
                ended, cpu_ended = self.now(), time.thread_time()
                with self._lock:
                    record = self._active.pop(sequence)
                    self._history.append(dict(record, end=ended, cpu_end=cpu_ended))
            except Exception:
                pass

    def wrap(self, phase, function):
        def measured(*args, **kwargs):
            return self.call(phase, function, *args, **kwargs)
        return measured

    def stall(self, *, detected_at, last_apply, last_flush):
        try:
            with self._lock:
                if self._incident is not None:
                    return
                self._incident = dict(detected_monotonic_s=detected_at,
                                      last_apply_monotonic_s=last_apply,
                                      last_flush_monotonic_s=last_flush,
                                      phases=dict(self._phases), history=list(self._history),
                                      active=list(self._active.values()))
            self._wake.set()
        except Exception:
            pass  # the watchdog must still issue its original emergency output

    def _run(self):
        self._wake.wait()
        with self._lock:
            incident = self._incident
        if incident is None:
            return
        try:
            captured_at = self.now()
            stacks = self.dump()
            self.write("ROS publisher stall diagnostics " + json.dumps(
                dict(incident, stack_capture_monotonic_s=captured_at), sort_keys=True) + "\n" + stacks)
        except BaseException as exc:
            # Diagnostic failure must not reach sink health or suppress STOP.
            try:
                self.write("ROS stall diagnostics unavailable: " + type(exc).__name__ + "\n")
            except BaseException:
                pass

    def close(self):
        self._wake.set()
        if self._thread is not None:
            self._thread.join(timeout=0.1)  # a blocked log writer cannot delay ROS teardown

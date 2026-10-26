"""Nonblocking scenario/2 steps. No robot commands, camera readers or disk I/O."""
import base64
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
from urllib.error import HTTPError, URLError

from foothold_agent.camera.stream import MAX_BYTES, jpeg_size
from .photos import validate_receipt


class PhotoFrameTooLarge(ValueError):
    pass


class ExecutionSupport:
    """Snapshot only on hello; advertised revision is fixed until next hello."""
    def __init__(self, *, camera=None, media=None, now, uploader=None):
        self.camera, self.media, self.now, self.uploader = camera, media, now, uploader
        self.revision = 0
        self.advertised = None

    def rgb_ready(self):
        if self.media is not None and self.media.available('rgb'):
            latest = self.media.latest.get('rgb')
            if latest is not None and 0 <= self.now() - latest[0] <= 1:
                return True
        return (self.camera is not None and not self.camera.closed
                and self.camera.latest is not None and self.camera.received is not None
                and 0 <= self.now() - self.camera.received <= 1)

    def hello(self):
        ready = self.rgb_ready() and self.uploader is not None
        actions = [dict(key='wait', state='SUPPORTED', reason=None),
                   dict(key='photo.rgb', state='SUPPORTED' if ready else 'UNAVAILABLE',
                        reason=None if ready else 'Fresh RGB source or photo storage client unavailable')]
        if self.advertised is None or self.advertised['actions'] != actions:
            self.revision += 1
        self.advertised = dict(contract='scenario/2', revision=self.revision, actions=actions)
        return deepcopy(self.advertised)

    def require(self, required, revision):
        caps = self.advertised
        if (caps is None or type(revision) is not int or revision != caps['revision']
                or not set(required) <= {a['key'] for a in caps['actions'] if a['state'] == 'SUPPORTED'}):
            raise ValueError('EXECUTION_UNAVAILABLE')

    def frame_after(self, requested):
        oversized = False
        if self.media is not None and self.media.available('rgb'):
            item = self.media.latest.get('rgb')
            if item is not None and requested < item[0] <= self.now() and self.now() - item[0] <= 1:
                encoded = item[1]['jpeg']
                # Media video may exceed the photo API limit. Bound decoding and
                # prefer an existing eligible camera frame instead of uploading it.
                if len(encoded) <= 4 * ((MAX_BYTES + 2) // 3):
                    payload = base64.b64decode(encoded, validate=True)
                    if len(payload) <= MAX_BYTES:
                        return payload, item[1]['captured_at']
                oversized = True
        camera = self.camera
        if (camera is not None and not camera.closed and camera.latest is not None
                and camera.received is not None and requested < camera.received <= self.now()
                and self.now() - camera.received <= 1):
            # Timestamp is the source reception time, never the later upload time.
            captured = datetime.now(timezone.utc).timestamp() - (self.now() - camera.received)
            return base64.b64decode(camera.latest['jpeg'], validate=True), datetime.fromtimestamp(captured, timezone.utc).isoformat()
        if oversized:
            raise PhotoFrameTooLarge('RGB media frame exceeds 65536-byte photo limit; fresh camera frame unavailable')
        return None


class StepRunner:
    def __init__(self, support, *, org, robot, run, waypoint, steps, now,
                 capture_timeout_s=3, upload_timeout_s=4, max_attempts=3):
        self.support, self.now = support, now
        self.org, self.robot, self.run, self.waypoint = org, robot, run, waypoint
        self.steps = deepcopy(steps)
        self.capture_timeout, self.upload_timeout, self.max_attempts = capture_timeout_s, upload_timeout_s, max_attempts
        self.results = []
        self.state = 'READY'
        self.generation = 0
        self.future = None
        self.packet = None
        self.remaining = None
        self.attempts = 0
        self.retry_at = 0
        self.deadline = None

    @property
    def done(self):
        return self.state in ('DONE', 'FAILED')

    def interrupt(self):
        self.generation += 1
        if self.state == 'WAITING':
            self.remaining = max(0, self.deadline - self.now())
        if not self.done:
            self.state = 'SUSPENDED'
        # Keep a bounded in-flight request and the immutable packet. Never cancel
        # a worker synchronously or consume its result after a generation change.

    def resume(self):
        if self.state == 'SUSPENDED':
            self.state = 'READY'

    def _result(self, code=None, reason=None, receipt=None):
        step = self.steps[len(self.results)]
        photo = None if receipt is None else {k: receipt[k] for k in ('photo_id', 'source', 'captured_at', 'sha256')}
        self.results.append(dict(step_idx=len(self.results), action=step['action'],
            source=step['params'].get('camera') if step['action'] == 'PHOTO' else None,
            status='FAILED' if code else 'SUCCEEDED', failure_code=code,
            failure_reason=reason, photo=photo))
        self.state = 'FAILED' if code else 'DONE' if len(self.results) == len(self.steps) else 'READY'
        self.remaining = None
        self.packet = None
        self.future = None
        self.attempts = 0

    def fail(self, code, reason):
        if len(self.results) < len(self.steps) and not self.done:
            self._result(code, reason)
        else:
            self.state = 'FAILED'

    def tick(self):
        if self.done or self.state == 'SUSPENDED':
            return
        if not self.steps:
            self.state = 'DONE'
            return
        step = self.steps[len(self.results)]
        now = self.now()
        if self.state == 'READY':
            if step['action'] == 'WAIT':
                self.deadline = now + (step['params']['seconds'] if self.remaining is None else self.remaining)
                self.state = 'WAITING'
            elif step['action'] == 'PHOTO' and step['params']['camera'] == 'rgb':
                if self.packet is not None:
                    self.state = 'RETRY'
                elif not self.support.rgb_ready() or self.support.uploader is None:
                    self.fail('DEVICE_UNAVAILABLE', 'Fresh RGB source unavailable')
                else:
                    self.requested = now
                    self.deadline = now + self.capture_timeout
                    self.state = 'CAPTURING'
            else:
                self.fail('UNSUPPORTED', 'Action is not implemented')
        if self.state == 'WAITING' and now >= self.deadline:
            self._result()
        elif self.state == 'CAPTURING':
            if now >= self.deadline:
                self.fail('CAPTURE_TIMEOUT', 'No new RGB frame before capture deadline')
                return
            try:
                frame = self.support.frame_after(self.requested)
                if frame is None:
                    return
                payload, captured = frame
                jpeg_size(payload)
                metadata = dict(org_id=self.org, robot_id=self.robot, run_id=self.run,
                    waypoint_idx=self.waypoint, step_idx=len(self.results), source='rgb',
                    captured_at=captured, mime='image/jpeg', byte_length=len(payload),
                    sha256=hashlib.sha256(payload).hexdigest(),
                    idempotency_key=f'{self.run}:{self.waypoint}:{len(self.results)}')
                self.packet = metadata, payload
                self.state = 'RETRY'
            except PhotoFrameTooLarge as error:
                self.fail('NO_FRESH_FRAME', str(error))
            except (ValueError, KeyError, TypeError):
                self.fail('NO_FRESH_FRAME', 'RGB frame is invalid')
        if self.state == 'RETRY':
            # A timed-out/interrupted HTTP request may still be running. Do not
            # queue unbounded work or let its late completion advance this step.
            if self.future is not None and not self.future.done():
                if self.deadline is not None and now >= self.deadline + self.upload_timeout:
                    self.fail('UPLOAD_FAILED', 'Photo upload worker did not finish before deadline')
                return
            if now < self.retry_at:
                return
            if self.attempts >= self.max_attempts:
                self.fail('UPLOAD_FAILED', 'Photo upload attempts exhausted')
                return
            self.attempts += 1
            self.job_generation = self.generation
            try:
                self.future = self.support.uploader.upload(*self.packet)
            except Exception:
                self.fail('UPLOAD_FAILED', 'Photo upload could not start')
                return
            self.deadline = now + self.upload_timeout
            self.state = 'UPLOADING'
        if self.state == 'UPLOADING':
            if self.job_generation != self.generation:
                return
            if now >= self.deadline:
                self.retry_at = now + .2
                if self.attempts >= self.max_attempts:
                    self.fail('UPLOAD_FAILED', 'Photo receipt deadline exceeded')
                else:
                    self.state = 'RETRY'
                return
            if not self.future.done():
                return
            try:
                receipt = validate_receipt(self.future.result(), self.packet[0])
            except Exception as error:
                retryable = (isinstance(error, HTTPError) and error.code in (503, 507)
                             or isinstance(error, (OSError, URLError, TimeoutError)) and not isinstance(error, HTTPError))
                if retryable and self.attempts < self.max_attempts:
                    self.state, self.retry_at = 'RETRY', now + .2
                else:
                    self.fail('STORAGE_UNAVAILABLE' if isinstance(error, HTTPError) and error.code in (503, 507) else 'UPLOAD_FAILED',
                              'Photo storage did not return a valid commit receipt')
            else:
                self._result(receipt=receipt)

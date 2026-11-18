"""One-shot high-level SDK trial, on the existing output worker and STOP lane.

No SDK imports here. RPC timeout is configured by SportBoundary (.10 s); the
watcher also cancels jobs while a broken/blocked SDK is still in flight. A zero
return is SDK acceptance, never evidence that the physical motion completed.
"""
import math
from collections import deque

ACTIONS = frozenset('Damp BalanceStand StopMove StandUp StandDown RecoveryStand Euler Sit RiseSit SpeedLevel Hello Stretch Content Dance1 Dance2 SwitchJoystick Pose Scrape FrontFlip FrontJump FrontPounce Heart StaticWalk TrotRun EconomicGait LeftFlip BackFlip HandStand FreeWalk FreeBound FreeJump FreeAvoid ClassicWalk WalkUpright CrossStep AutoRecoverySet AutoRecoveryGet SwitchAvoidMode CheckMode SelectMode'.split())
FLAGS = frozenset('SwitchJoystick Pose HandStand FreeBound FreeJump FreeAvoid ClassicWalk WalkUpright CrossStep AutoRecoverySet'.split())
DANGEROUS = frozenset('FrontFlip LeftFlip BackFlip FrontJump FrontPounce HandStand WalkUpright FreeJump FreeBound Damp'.split())
TIMEOUT_S = 2.


def arguments(action, params):
    """Exact, finite, typed parameters; conservative Euler trial bounds in rad."""
    if not isinstance(action, str) or action not in ACTIONS or not isinstance(params, dict):
        raise ValueError('unknown action')
    # Wire defaults may contain nulls; an extra key is still never accepted.
    if set(params) - {'roll', 'pitch', 'yaw', 'level', 'enabled', 'mode'}:
        raise ValueError('extra parameter')
    p = {k: v for k, v in params.items() if v is not None}
    keys = ('roll', 'pitch', 'yaw') if action == 'Euler' else ('level',) if action == 'SpeedLevel' else ('enabled',) if action in FLAGS else ('mode',) if action == 'SelectMode' else ()
    if set(p) != set(keys):
        raise ValueError('exact parameters required')
    if action == 'Euler' and not all(type(p[k]) in (int, float) and math.isfinite(p[k]) and -.5 <= p[k] <= .5 for k in keys):
        raise ValueError('Euler outside trial bounds')
    if action == 'SpeedLevel' and (type(p['level']) is not int or p['level'] not in (-1, 0, 1)):
        raise ValueError('invalid speed level')
    if action in FLAGS and type(p['enabled']) is not bool:
        raise ValueError('boolean required')
    if action == 'SelectMode':
        import re
        if not isinstance(p['mode'], str) or not re.fullmatch(r'[A-Za-z][A-Za-z0-9_-]{0,31}', p['mode']):
            raise ValueError('invalid mode name')
    return tuple(p[k] for k in keys)


class Actions:
    def __init__(self, sink):
        self.sink = sink
        self.job = None
        self.inflight = False
        self.result = None
        self.seen = deque(maxlen=256)

    @property
    def busy(self):
        return self.job is not None or self.inflight

    def report(self, request_id, action, status, code, sdk_code=None, *, mode=None, enabled=None):
        self.result = dict(request_id=request_id, action=action, status=status, code=code,
                           sdk_code=sdk_code, mode=mode, enabled=enabled)

    def reason(self, lease, action, confirmed):
        s = self.sink
        sample = s._posture_sample()
        return ('NOT_AUTHORIZED' if not s.posture_authorized(lease) else
                'STALE_STATE' if sample.get('sequence', -1) < 0 else
                'MOVING' if s.pending != (0., 0., 0.) or s._ramp_velocity != (0., 0., 0.) or not sample['still'] else
                'CONFIRM_REQUIRED' if action in DANGEROUS and confirmed is not True else
                'STANDING_REQUIRED' if action in DANGEROUS and sample['state'] != 'STANDING' else None)

    def request(self, request_id, action, params, lease, confirmed=False, *, moving=False):
        s = self.sink
        with s._lock:
            if not isinstance(action, str) or action not in ACTIONS or not isinstance(request_id, str) or not 1 <= len(request_id) <= 128:
                return False
            try:
                args = arguments(action, params)
                if type(confirmed) is not bool: raise ValueError('boolean confirmation required')
                reason = ('BUSY' if self.busy or s._posture is not None else
                          'DUPLICATE' if request_id in self.seen else
                          'MOVING' if moving else self.reason(lease, action, confirmed))
            except (ValueError, TypeError):
                reason, args = 'INVALID_ARGUMENTS', ()
            if reason:
                self.report(request_id, action, 'REJECTED', reason)
                return False
            self.seen.append(request_id)
            s._hold()
            s._posture_stop_only = True
            self.job = dict(request_id=request_id, action=action, args=args,
                            lease=lease, confirmed=confirmed, deadline=s.now()+TIMEOUT_S)
            self.report(request_id, action, 'RUNNING', 'STARTED')
            return True

    def cancel(self, reason='STOPPED'):
        with self.sink._lock:
            if self.job is not None:
                job, self.job = self.job, None
                self.report(job['request_id'], job['action'], 'FAILED', reason)
                self.sink._stop_requested.set()

    def poll(self):
        with self.sink._lock:
            if self.job is not None:
                if self.sink.now() >= self.job['deadline']:
                    self.cancel('TIMEOUT')
                elif not self.sink.posture_authorized(self.job['lease']):
                    self.cancel('AUTHORITY_LOST')

    def step(self):
        s = self.sink
        with s._lock:
            self.poll()
            job = self.job
            if job is None or self.inflight:
                return
            reason = self.reason(job['lease'], job['action'], job['confirmed'])
            if reason:
                self.cancel(reason)
                return
            # Never switch an unverified mode. CheckMode is the only switcher RPC.
            if job['action'] == 'SelectMode':
                self.job = None
                self.report(job['request_id'], job['action'], 'REJECTED', 'MODE_READ_ONLY')
                return
            self.inflight = True
        code, mode, enabled, failure = None, None, None, None
        try:
            value = getattr(s.client, job['action'])(*job['args'])
            if job['action'] in ('CheckMode', 'AutoRecoveryGet'):
                code, data = value
                if job['action'] == 'CheckMode' and isinstance(data, dict):
                    name = data.get('name')
                    if isinstance(name, str): mode = name[:64].replace('\x00', '')
                elif job['action'] == 'AutoRecoveryGet' and type(data) is bool:
                    enabled = data
            else:
                code = value
        except (AttributeError, NotImplementedError):
            failure = 'UNSUPPORTED'
        except TimeoutError:
            failure = 'TIMEOUT'
        except PermissionError:
            failure = 'AUTHORITY_LOST'
        except Exception:
            failure = 'SDK_ERROR'
        finally:
            with s._lock:
                self.inflight = False
                self.poll()
                if self.job is job:
                    self.job = None
                    valid = type(code) is int
                    ok = valid and code == 0 and failure is None
                    self.report(job['request_id'], job['action'], 'SUCCEEDED' if ok else 'FAILED',
                                'SDK_ACCEPTED' if ok else failure or 'SDK_REJECTED',
                                code if valid else None, mode=mode, enabled=enabled)

"""Direct scenario/1 owner. Uses the Hub's existing Session/Core/sink only.

Nav2, verified map context and measured arrival evidence are explicit local ports.
Absent ports never create motion. All methods are serialized on the Hub loop.
"""
from copy import deepcopy
import hashlib
import hmac
import math
import secrets
from uuid import uuid4

from foothold_agent.safety.core import Z, STATE_STALE
from .nav2 import Binding
from .scenario import plan_from_data

TERMINAL = {'COMPLETED', 'FAILED', 'CANCELED'}


class ScenarioRun:
    def __init__(self, hub, *, nav=None, source=None, journal=None, context=None,
                 arrival=None, run_pause_timeout_s=600, nav_timeout_s=120):
        if (type(run_pause_timeout_s) not in (int, float) or not math.isfinite(run_pause_timeout_s)
                or run_pause_timeout_s <= 0 or type(nav_timeout_s) not in (int, float)
                or not math.isfinite(nav_timeout_s) or not 0 < nav_timeout_s <= 600):
            raise ValueError('invalid run timeout')
        self.hub, self.nav, self.source, self.journal = hub, nav, source, journal
        self.context, self.arrival = context, arrival
        self.pause_timeout, self.nav_timeout = run_pause_timeout_s, nav_timeout_s
        self.current = None
        self.starts = {}  # bounded process-lifetime tombstones; no ID reuse
        self.binding = None
        self.cancel_binding = None
        self.preparing = None
        self.outgoing = []
        self.storage_failed = False
        # Previous process runs are evidence only. Close them; never resume.
        if journal is not None:
            latest = deepcopy(journal.runs)
            for m in journal.replay():
                if m['t'] == 'run.update':
                    latest.setdefault(m['run_id'], m)
            for run_id, m in latest.items():
                self.starts[run_id] = None
                if m['status'] not in TERMINAL:
                    journal.append({**{k: m[k] for k in ('t', 'run_id', 'step', 'progress')},
                                    'status': 'FAILED', 'fail_code': 'AGENT_RESTARTED', 'wait_reason': None}, hub.now())

    @property
    def active(self):
        return self.current is not None and self.current['status'] not in TERMINAL

    def snapshot(self):
        if self.current is None:
            return None
        return deepcopy({k: self.current[k] for k in ('run_id', 'status', 'step', 'progress', 'wait_reason', 'fail_code')})

    @staticmethod
    def identity(peer):
        return peer.user, peer.device, peer.surface

    def owns(self, peer, frame, *, token=False):
        c = self.current
        if c is None or self.identity(self.hub.peers[peer]) != c['identity'] or frame.get('screen_id') != c['screen_id']:
            return False
        if token:
            supplied = hashlib.sha256(frame.get('resume_token', '').encode()).digest()
            return hmac.compare_digest(supplied, c['token_hash'])
        return peer is c['peer']

    def _safe(self):
        s, core = self.hub.session, self.hub.session.core
        s._state()  # incorporate the independent sink watchdog before transfer
        return (s.lease_confirmed and s.holder_type == 'USER' and not core.latch
                and core.resume_pending is None and core.reset_pending is None
                and not core.need_neutral and not core.sim_block()
                and 0 <= self.hub.now() - core.intent_t <= .3
                and core.intent == Z)

    def _publish(self, message):
        try:
            if self.journal is None:
                raise RuntimeError('no run journal')
            stamped = self.journal.append(message, self.hub.now())
        except Exception:
            self.storage_failed = True
            if self.active:
                self._halt('PAUSED', 'RECORDING_UNAVAILABLE', report=False)
            return
        if message['t'] == 'run.update':
            visible = {'t': 'run.update', **self.snapshot()}
            for peer, p in self.hub.peers.items():
                if p.user is not None:
                    self.hub._notify(peer, visible)
        elif message.get('code') in ('RUN_WAYPOINT_ARRIVED', 'RUN_WAYPOINT_RECORDED'):
            for peer, p in self.hub.peers.items():
                if p.user is not None:
                    # Event queue is FIFO (two waypoint events may share t).
                    self.hub._notify(peer, stamped)

    def _event(self, code, data):
        self._publish({'t': 'event', 'code': code, 'severity': 'info', 'robot_at': None, 'data': deepcopy(data)})

    def _status(self, status, *, reason=None):
        c = self.current
        was_paused = c['status'] == 'PAUSED'
        c.update(status=status, wait_reason=reason if status == 'PAUSED' else None,
                 fail_code=reason if status in ('CANCELED', 'FAILED') else None)
        if status == 'PAUSED' and not was_paused:
            c['pause_deadline'] = self.hub.now() + self.pause_timeout
        if status != 'PAUSED':
            c['pause_deadline'] = None
        self._publish({'t': 'run.update', **self.snapshot()})

    def _halt(self, status, reason=None, *, report=True):
        # Block output before requesting asynchronous cancel. Invalidate binding
        # before any late action callback can be considered by tick().
        s = self.hub.session
        s.core.stop(reason or status)
        s.run = None
        binding, self.binding = self.binding, None
        self.hub.owner = self.hub.reservation = None
        self.preparing = None
        try:
            self.hub._emit(s.receive({'t': 'lease', 'lease_id': None, 'holder_type': None}))
        finally:
            if binding is not None:
                self.cancel_binding = binding
                self.nav.revoke(reason or status)
        if report:
            self._status(status, reason=reason)
        else:
            c = self.current
            if c['status'] != 'PAUSED':
                c['pause_deadline'] = self.hub.now() + self.pause_timeout
            c.update(status=status, wait_reason=reason, fail_code=None)

    def cancel_confirmed(self):
        if self.cancel_binding is None:
            return True
        try:
            confirmed = self.nav.actions.cancel_confirmed(self.cancel_binding) is True
        except Exception:
            confirmed = False
        if confirmed:
            self.cancel_binding = None
        return confirmed

    def lost(self, peer):
        if self.active and self.current['peer'] is peer and self.current['status'] != 'PAUSED':
            self._halt('PAUSED', 'LINK_LOST')

    def stopped(self):
        if self.active:
            self._halt('PAUSED', 'STOPPED_BY_USER')

    def _promote(self, peer):
        # Preserve the already verified USER neutral/unlock gates, but discard
        # input. This local transfer creates no new Core or command output path.
        s, c = self.hub.session, self.current
        self.hub._request_result('CANCELED')  # USER handovers cannot survive RUN entry
        s.core._void()
        s.holder_type, s.holder_run_id = 'RUN', c['run_id']
        s.run = {'run_id': c['run_id'], 'status': 'RUNNING', 'step': c['step']}
        s.executor_t = self.hub.now()
        c['peer'] = peer
        self.hub.owner = peer

    def handle(self, peer, f):
        h, c, kind = self.hub, self.current, f['t']
        if kind == 'run.confirm' or f.get('op') == 'return':
            return 'UNSUPPORTED_OPERATION', None
        if kind == 'run.start':
            request = {k: v for k, v in f.items() if k not in ('id', 'proto')}
            old = self.starts.get(f['run_id'], False)
            if old is not False:
                if old is None or old != request:
                    return 'RUN_CONFLICT', None
                if c is None or c['run_id'] != f['run_id'] or not self.owns(peer, f):
                    return 'RUN_OWNER_MISMATCH', None
                # Token is never stored plaintext. Retry detail is available only
                # from Hub's per-connection response cache below.
                return None, deepcopy(h.peers[peer].run_start_reply)
            if self.active:
                return 'RUN_ACTIVE', None
            if len(self.starts) >= 4096:
                return 'RECORDING_UNAVAILABLE', None
            if h.simulation is not True:
                return 'FORBIDDEN', None  # physical approval/SF-12 not enabled
            if not self.cancel_confirmed():
                return 'RESUME_REJECTED', None
            if self.nav is None or not self.nav.actions.ready():
                return 'NAV_UNAVAILABLE', None
            if self.source is None or self.context is None:
                return 'PLAN_UNAVAILABLE', None
            if self.journal is None or not self.journal.available or self.storage_failed:
                return 'RECORDING_UNAVAILABLE', None
            if h.owner is not peer or f['lease_id'] != h.session.lease_id or not self._safe():
                return 'NOT_CONTROLLER', None
            token = secrets.token_urlsafe(32)
            detail = dict(run_id=f['run_id'], screen_id=f['screen_id'], resume_token=token)
            self.current = c = dict(run_id=f['run_id'], status='QUEUED', step=0,
                progress={'done': 0, 'total': 0}, wait_reason=None, fail_code=None,
                identity=self.identity(h.peers[peer]), peer=peer, screen_id=f['screen_id'],
                token_hash=hashlib.sha256(token.encode()).digest(),
                request=request, pause_deadline=None, plan=None, end=None, ending=False)
            h.peers[peer].run_start_reply = deepcopy(detail)
            self.starts[f['run_id']] = deepcopy(request)
            self._promote(peer)
            p = h.peers[peer]
            self._event('RUN_STARTED', {k: f[k] for k in ('run_id', 'scenario_id', 'scenario_version', 'floor_id', 'map_version_id')} |
                        dict(user_id=p.user, device_id=p.device, surface=p.surface, screen_id=f['screen_id'], simulation=True))
            self._status('QUEUED')
            if not self.active or self.storage_failed:
                return 'RECORDING_UNAVAILABLE', None
            self._status('PREPARING')
            try:
                self.preparing = self.source.fetch(deepcopy(request))
            except Exception:
                self._halt('FAILED', 'PLAN_UNAVAILABLE')
            return None, detail
        if c is None or c['run_id'] != f['run_id']:
            return 'RUN_NOT_FOUND', None
        op = f['op']
        if c['status'] in TERMINAL:
            if op == 'abort' and c['status'] == 'CANCELED' and (peer is c['peer'] or h.peers[peer].run_cancel):
                return None, None
            return 'RUN_STATE_CONFLICT', None
        if op == 'abort':
            owner = peer is c['peer'] and self.identity(h.peers[peer]) == c['identity']
            if not owner and not (c['status'] == 'PAUSED' and h.peers[peer].run_cancel):
                return 'FORBIDDEN', None
            self._halt('CANCELED', 'OPERATOR_ABORT')
            return None, None
        if not self.owns(peer, f, token=op == 'resume'):
            return 'RUN_OWNER_MISMATCH', None
        if op == 'pause':
            if c['status'] == 'PAUSED':
                return None, None
            if h.owner is not peer or f['lease_id'] != h.session.lease_id:
                return 'NOT_CONTROLLER', None
            self._halt('PAUSED')
            return None, None
        if c['status'] != 'PAUSED':
            return 'RUN_STATE_CONFLICT', None
        if (not self.cancel_confirmed() or c['plan'] is None or h.owner is not peer
                or f['lease_id'] != h.session.lease_id or not self._safe()):
            return 'RESUME_REJECTED', None
        if self.storage_failed or self.journal is None or not self.journal.available:
            return 'RECORDING_UNAVAILABLE', None
        if not self.nav.actions.ready() or not self.context(c['request'], c['plan']):
            return 'RESUME_REJECTED', None
        token = secrets.token_urlsafe(32)
        c['token_hash'] = hashlib.sha256(token.encode()).digest()
        h.peers[peer].run_start_reply = None  # rotated proof is never exposed by start replay
        self._promote(peer)
        self._goal()
        return None, dict(run_id=c['run_id'], screen_id=c['screen_id'], resume_token=token)

    def _goal(self):
        c, s = self.current, self.hub.session
        goal = c['end'] if c['ending'] else c['plan']['segments'][0]['goals'][c['step']]
        self.binding = Binding(c['run_id'], str(uuid4()), s.core.episode, s.core.stop_gen,
                               '', c['request']['floor_id'], c['request']['map_version_id'])
        self.goal_started = self.hub.now()
        try:
            self.nav.begin(self.binding, deepcopy(goal))
            # Explicit human start/resume already passed neutral. Never invent
            # a neutral from a Nav2 movement sample.
            s.core.cmd(s.lease_id, Z)
            self._status('MOVING')
        except Exception:
            self._halt('FAILED', 'NAV_GOAL_REJECTED')

    def expire(self):
        if (self.active and self.current['status'] == 'PAUSED'
                and self.hub.now() >= self.current['pause_deadline']):
            self._halt('CANCELED', 'PAUSE_TIMEOUT')

    def tick(self):
        if self.journal is not None:
            self.outgoing.extend(self.journal.poll())
            if self.journal.error is not None or not self.journal.available:
                self.storage_failed = True
                if self.active and self.current['wait_reason'] != 'RECORDING_UNAVAILABLE':
                    self._halt('PAUSED', 'RECORDING_UNAVAILABLE', report=False)
        if not self.active:
            return
        h, c, s = self.hub, self.current, self.hub.session
        if c['status'] == 'PAUSED':
            self.expire()
            return
        if s.core.latch:
            self._halt('PAUSED', 'STOPPED_BY_USER')
            return
        if c['peer'] not in h.peers or h.now() - h.peers[c['peer']].last_ping >= 3:
            self.lost(c['peer'])
            return
        if c['status'] == 'PREPARING':
            # Health ZERO while awaiting data; never feed a cached Nav2 command.
            h._emit(s.executor_command(c['run_id'], Z))
            if self.preparing is not None and self.preparing.done():
                try:
                    c['plan'], c['end'] = plan_from_data(self.preparing.result(), c['request'])
                    if not self.context(c['request'], c['plan']):
                        raise ValueError('MAP_VERSION_MISMATCH')
                    c['progress']['total'] = len(c['plan']['segments'][0]['goals'])
                except Exception as exc:
                    code = str(exc) if str(exc) in ('FLOOR_TRANSITION_UNSUPPORTED', 'MAP_VERSION_MISMATCH') else 'PLAN_UNAVAILABLE'
                    self._halt('FAILED', code)
                    return
                if self.journal.jobs:
                    return  # initial metadata commits before goal submission
                self.preparing = None
                self._goal()
            return
        if self.binding is None:
            return
        if s.run is None or s.run['status'] != 'RUNNING' or self.nav.source_expired() or h.now() - self.goal_started >= self.nav_timeout:
            self._halt('FAILED', 'NAV_TIMEOUT')
            return
        if not self.context(c['request'], c['plan']):
            self._halt('FAILED', 'LOCALIZATION_LOST')
            return
        axes = self.nav.poll(deepcopy(s.run))
        if self.nav.rejected:
            self._halt('FAILED', 'NAV_GOAL_REJECTED')
            return
        if axes is not None:
            h._emit(s.executor_command(c['run_id'], axes))
        if self.nav.result not in (None, 'SUCCEEDED'):
            self._halt('FAILED', 'NAV_GOAL_REJECTED')
            return
        if self.nav.result == 'SUCCEEDED':
            goal = c['end'] if c['ending'] else c['plan']['segments'][0]['goals'][c['step']]
            # This local port must prove fresh measured map pose AND body still;
            # action success and output ZERO alone can never produce arrival.
            proof = self.arrival(self.binding, goal) if self.arrival is not None else None
            if proof is None:
                return
            if (not isinstance(proof, dict) or not isinstance(proof.get('pose'), dict)
                    or proof.get('body_still') is not True
                    or type(proof.get('received_at')) not in (int, float)
                    or not 0 <= h.now() - proof['received_at'] <= STATE_STALE
                    or proof.get('binding') != self.binding):
                return
            pose = proof['pose']
            if (pose.get('floor_id') != c['request']['floor_id']
                    or pose.get('map_version_id') != c['request']['map_version_id']
                    or not all(type(pose.get(k)) in (int, float) and math.isfinite(pose[k]) for k in ('x', 'y', 'yaw'))
                    or math.hypot(pose['x']-goal['x'], pose['y']-goal['y']) > .5):
                return
            s.core._void()
            h._emit(s.tick())
            self.nav.revoke('ARRIVED')
            self.binding = None
            if c['ending']:
                self._halt('COMPLETED')
                return
            self._status('AT_WAYPOINT')
            data = {k: goal[k] for k in ('idx', 'waypoint_ref', 'mission_id', 'mission_version', 'mission_name')}
            data.update(run_id=c['run_id'], floor_id=c['request']['floor_id'], map_version_id=c['request']['map_version_id'], pose=pose)
            self._event('RUN_WAYPOINT_ARRIVED', data)
            if not self.active or self.storage_failed:
                return
            self._status('PERFORMING')
            self._event('RUN_WAYPOINT_RECORDED', {**data, 'results': {'mode': 'DISPLAY_ONLY'}})
            if not self.active or self.storage_failed:
                return
            c['progress']['done'] += 1
            if c['progress']['done'] < c['progress']['total']:
                c['step'] += 1
                s.run['step'] = c['step']
                self._goal()
            elif c['end'] is not None:
                c['ending'] = True
                self._goal()
            else:
                self._halt('COMPLETED')

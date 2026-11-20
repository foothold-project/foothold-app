"""Explicit field-only SDK boundary; validation precedes every SDK import."""

import socket
import threading
import time
import os
from weakref import WeakKeyDictionary
from foothold_agent.mapping.inputs import ObservationInputs, RAW_TOPIC
from .approval import validate
from .identity import verify

SDK_TIMEOUT_S = .10


class _SportTransports:
    """Two independent SDK response readers for one setup DDS participant."""
    def __init__(self):
        self.ready = []
        self.pending = None

    def initialize(self):
        from unitree_sdk2py.go2.sport.sport_client import SportClient
        while len(self.ready) < 2:
            # Construction opens the DDS reader. If configuration fails, retry
            # on that same object; the SDK provides no close for a SportClient.
            if self.pending is None:
                self.pending = SportClient()
            self.pending.SetTimeout(SDK_TIMEOUT_S)
            self.pending.Init()
            self.ready.append(self.pending)
            self.pending = None
        return self.ready


# Keep raw motion clients private to the SDK boundary. Only initialization
# takes this lock; neither ordinary RPCs nor the emergency lane acquire it.
_setup_sport_transports = WeakKeyDictionary()
_sport_init_lock = threading.Lock()


class _Channel(ObservationInputs):
    def __init__(self, approval):
        self.init_observations()
        self.approval = approval
        self.subscribers = []

    def subscribe(self, inputs):
        from unitree_sdk2py.core.channel import ChannelSubscriber
        from unitree_sdk2py.idl.unitree_go.msg.dds_ import LowState_, SportModeState_
        try:
            for topic, data_type, callback in (
                    ('rt/lowstate', LowState_, inputs.lowstate),
                    ('rt/sportmodestate', SportModeState_, lambda msg: self.sport(inputs.sportmodestate, msg))):
                subscriber = ChannelSubscriber(topic, data_type)
                self.subscribers.append(subscriber)
                subscriber.Init(callback, 0)  # direct callback; no stale DDS queue
        except BaseException:
            self.close()
            raise

    def close(self):
        self.cloud_bus.close()
        first = None
        for subscriber in reversed(self.subscribers):
            try:
                subscriber.Close()
            except Exception as error:
                first = first or error
        self.subscribers.clear()
        if first is not None:
            raise first


def open_channel(env, *, wall=time.time):
    approval = validate(env, now=wall())
    if approval.nic not in {name for _, name in socket.if_nameindex()}:
        raise ValueError('robot NIC does not exist')
    if any(os.environ.get(k) or env.get(k) for k in ('CYCLONEDDS_URI', 'CYCLONEDDS_HOME', 'LD_LIBRARY_PATH')):
        raise PermissionError('review inherited DDS/loader settings before SDK initialization')
    from unitree_sdk2py.core.channel import ChannelFactoryInitialize
    ChannelFactoryInitialize(0, approval.nic)
    return _Channel(approval)


class SportBoundary:
    def __init__(self, client, approval, *, now=time.monotonic, wall=time.time):
        self.client = client
        self.identity = (approval.nic, approval.robot_serial)
        self.deadline = now()+max(0., approval.expires_at-wall())
        self.now = now
        self._switcher = None

    def __getattr__(self, name):
        from .actions import ACTIONS
        if name not in ACTIONS or name == 'SelectMode':
            raise AttributeError(name)
        def call(*args):
            self._authorized()
            if name == 'CheckMode':
                if self._switcher is None:
                    from unitree_sdk2py.comm.motion_switcher.motion_switcher_client import MotionSwitcherClient
                    switcher = MotionSwitcherClient()
                    switcher.SetTimeout(SDK_TIMEOUT_S)
                    switcher.Init()
                    self._switcher = switcher
                return self._switcher.CheckMode()
            return getattr(self.client, name)(*args)
        return call

    def renew(self, approval, *, deadline):
        if (approval.nic, approval.robot_serial) != self.identity:
            raise PermissionError('approval identity changed')
        self.deadline = deadline

    def revoke(self):
        self.deadline = float('-inf')

    def _authorized(self):
        if self.now() >= self.deadline:
            raise PermissionError('field marker expired; only zero and stop allowed')

    def Move(self, vx, vy, wz):
        if (vx, vy, wz) != (0., 0., 0.):
            self._authorized()
        return self.client.Move(vx, vy, wz)

    def StopMove(self):
        return self.client.StopMove()

    def StandUp(self):
        self._authorized()
        return self.client.StandUp()

    def BalanceStand(self):
        self._authorized()
        return self.client.BalanceStand()

    def StandDown(self):
        self._authorized()
        return self.client.StandDown()


def connect(env, *, observed_serial, wall=time.time, monotonic=time.monotonic, channel=None):
    """Field-only factory; caller must independently read and match robot serial.

    No stand-up, mode switch or motion occurs here. The entrypoint shares its
    already validated subscription channel instead of reinitializing DDS.
    """
    approval = validate(env, now=wall())
    verify(approval, observed_serial)
    if channel is None:
        channel = open_channel(env, wall=wall)
    elif type(channel) is not _Channel or channel.approval != approval:
        raise PermissionError('channel does not match current field approval')
    from unitree_sdk2py.go2.sport.sport_client import SportClient
    # Separate RPC objects prevent a blocked ordinary output from owning the
    # emergency object's client lock. Both belong to this one local adapter.
    clients = []
    for _ in range(2):
        client = SportClient()
        client.SetTimeout(SDK_TIMEOUT_S)
        client.Init()
        clients.append(SportBoundary(client, approval, now=monotonic, wall=wall))
    return tuple(clients)


def authorize_observation(env, channel, observed_serial):
    approval = validate(env)
    verify(approval, observed_serial)
    if (type(channel) is not _Channel
            or channel.approval != approval):
        raise PermissionError('observation channel identity mismatch')


def observation(env, channel, observed_serial, *, callback=None):
    authorize_observation(env, channel, observed_serial)
    if callback is not None:
        return channel.cloud(RAW_TOPIC, callback)
    from unitree_sdk2py.go2.video.video_client import VideoClient
    client = VideoClient()
    client.SetTimeout(SDK_TIMEOUT_S)
    client.Init()
    return client


def connect_approved(approval, observed_serial, subscriptions):
    """Pairing path: already-running readonly DDS, authenticated field marker.

    File-based/manual entrypoints keep their existing validation path. This
    path reuses exactly the marker validator before importing motion SDK types.
    """
    from .approval import Approval, SERVER_CLOCK_SKEW_S, validate_value
    from foothold_agent.go2_readonly.sdk import Subscriptions
    if type(approval) is not Approval or type(subscriptions) is not Subscriptions:
        raise PermissionError('validated approval and readonly subscriptions required')
    validate_value(dict(v=1, purpose='go2-field-motion', nic=approval.nic,
                        robot_serial=approval.robot_serial, expires_at=approval.expires_at), approval.nic,
                   clock_skew_s=SERVER_CLOCK_SKEW_S)
    verify(approval, observed_serial)
    if (not subscriptions._started or subscriptions.nic != approval.nic
            or approval.nic not in {name for _, name in socket.if_nameindex()}):
        raise PermissionError('current dedicated subscription NIC required')
    with _sport_init_lock:
        transports = _setup_sport_transports.setdefault(subscriptions, _SportTransports())
        clients = transports.initialize()
    # Each approval still owns independent deadlines and revocation state.
    return tuple(SportBoundary(client, approval) for client in clients)

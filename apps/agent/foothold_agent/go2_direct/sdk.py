"""Explicit field-only SDK boundary; validation precedes every SDK import."""

import socket
import time
import os
from .approval import validate

SDK_TIMEOUT_S = .10


class _Channel:
    def __init__(self, approval):
        self.approval = approval
        self.subscribers = []

    def subscribe(self, inputs):
        from unitree_sdk2py.core.channel import ChannelSubscriber
        from unitree_sdk2py.idl.unitree_go.msg.dds_ import LowState_, SportModeState_
        try:
            for topic, data_type, callback in (
                    ('rt/lowstate', LowState_, inputs.lowstate),
                    ('rt/sportmodestate', SportModeState_, inputs.sportmodestate)):
                subscriber = ChannelSubscriber(topic, data_type)
                self.subscribers.append(subscriber)
                subscriber.Init(callback, 0)  # direct callback; no stale DDS queue
        except BaseException:
            self.close()
            raise

    def close(self):
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
        self.deadline = now()+max(0., approval.expires_at-wall())
        self.now = now

    def Move(self, vx, vy, wz):
        if (vx, vy, wz) != (0., 0., 0.) and self.now() >= self.deadline:
            raise PermissionError('field marker expired; only zero and stop allowed')
        return self.client.Move(vx, vy, wz)

    def StopMove(self):
        return self.client.StopMove()


def connect(env, *, observed_serial, wall=time.time, monotonic=time.monotonic, channel=None):
    """Field-only factory; caller must independently read and match robot serial.

    No stand-up, mode switch or motion occurs here. The entrypoint shares its
    already validated subscription channel instead of reinitializing DDS.
    """
    approval = validate(env, now=wall())
    if observed_serial != approval.robot_serial:
        raise PermissionError('robot serial does not match field approval')
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

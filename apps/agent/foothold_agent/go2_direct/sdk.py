"""Only explicit connect() may import SDK; there is deliberately no live CLI."""

import socket
import time
import os
from .approval import validate

SDK_TIMEOUT_S = .10


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


def connect(env, *, observed_serial, wall=time.time, monotonic=time.monotonic):
    """Field-only factory; caller must independently read and match robot serial.

    No stand-up, mode switch or motion occurs here. Not wired to Hub/Core: real
    feedback mapping and APK authenticated transport remain separate gates.
    """
    approval = validate(env, now=wall())
    if observed_serial != approval.robot_serial:
        raise PermissionError('robot serial does not match field approval')
    if approval.nic not in {name for _, name in socket.if_nameindex()}:
        raise ValueError('robot NIC does not exist')
    if any(os.environ.get(k) or env.get(k) for k in ('CYCLONEDDS_URI', 'CYCLONEDDS_HOME', 'LD_LIBRARY_PATH')):
        raise PermissionError('review inherited DDS/loader settings before SDK initialization')
    from unitree_sdk2py.core.channel import ChannelFactoryInitialize
    from unitree_sdk2py.go2.sport.sport_client import SportClient
    ChannelFactoryInitialize(0, approval.nic)
    # Separate RPC objects prevent a blocked ordinary output from owning the
    # emergency object's client lock. Both belong to this one local adapter.
    clients = []
    for _ in range(2):
        client = SportClient()
        client.SetTimeout(SDK_TIMEOUT_S)
        client.Init()
        clients.append(SportBoundary(client, approval, now=monotonic, wall=wall))
    return tuple(clients)

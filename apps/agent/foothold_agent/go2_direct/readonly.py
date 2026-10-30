"""Explicit server observation mode: two DDS subscribers, no SportClient/sink."""
import asyncio
from dataclasses import dataclass, field
import math
import os
import re
import socket
import threading
import time

from foothold_agent.go2_readonly.sdk import Subscriptions
from foothold_agent.go2_readonly.state import State, number
from foothold_agent.link.client import Client, Settings
from foothold_agent.link.session import Session
from foothold_agent.phone.observer import DiscardSink
from foothold_agent.phone.tickets import uuid
from foothold_agent.phone.tickets import json_object
from .reporting import devices, project


@dataclass
class Config:
    robot: str
    nic: str
    link: Settings = field(repr=False)
    server: bool = True
    readonly: bool = True
    verifier: None = None

    @classmethod
    def from_env(cls, env, nic):
        if env.get('FH_GO2_DIRECT_ENABLED') == '1' or env.get('FH_GO2_FIELD_APPROVAL'):
            raise PermissionError('readonly requires motion enable/approval to be absent')
        if not isinstance(nic, str) or not re.fullmatch(r'[A-Za-z0-9_.:-]{1,15}', nic):
            raise ValueError('explicit observation NIC required')
        if nic not in {name for _, name in socket.if_nameindex()}:
            raise ValueError('observation NIC unavailable')
        if any(os.environ.get(k) or env.get(k) for k in ('CYCLONEDDS_URI','CYCLONEDDS_HOME','LD_LIBRARY_PATH')):
            raise PermissionError('review inherited DDS loader settings')
        return cls(uuid(env.get('FOOTHOLD_ROBOT_ID')), nic,
            Settings(env.get('FOOTHOLD_AGENT_WS_URL',''), env.get('FOOTHOLD_AGENT_TOKEN','')))


class Measurements(State):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.speed_lock = threading.Lock()
        self.speed_sample = None

    def sportmodestate(self, message):
        received = self.now()
        with self._lock:
            previous = self._sport_message
        super().sportmodestate(message)
        with self._lock:
            accepted = self._sport_message is message and message is not previous
        value = getattr(message, 'velocity', None)
        if accepted and isinstance(value, (tuple,list)) and len(value)==3 and all(number(x) for x in value):
            with self.speed_lock:
                self.speed_sample = dict(speed=math.hypot(value[0], value[1]), received=received)

    def telemetry(self):
        snapshot = self.snapshot()
        with self.speed_lock:
            snapshot['speed_sample'] = None if self.speed_sample is None else dict(self.speed_sample)
        return snapshot


class Observer(Session):
    def __init__(self, measurements):
        self.measurements = measurements
        super().__init__(identity={'robot_model':'unitree_go2'})

    def receive(self, raw):
        # No server frame can acquire authority or even request a hardware STOP.
        # Client maintains liveness; physical feedback/stop_ref are never forged.
        try:
            frame = json_object(raw) if isinstance(raw, (str,bytes)) else raw
        except (ValueError, TypeError, UnicodeError, RecursionError):
            return self.tick()
        return super().receive(frame) if isinstance(frame,dict) and frame.get('t')=='ping' else self.tick()

    def _state(self):
        state = {**super()._state(), **project(self.measurements.telemetry(), self.now())}
        state['stop_ref'] = 0
        return state


async def run(config, *, stop=None, subscriptions_factory=Subscriptions, client_factory=Client):
    stop = stop or asyncio.Event()
    measurements = Measurements()
    subscriptions = subscriptions_factory(measurements, config.nic)
    session = Observer(measurements)
    client = client_factory(session, DiscardSink(), config.link)
    tasks = []
    try:
        subscriptions.start()
        tasks = [asyncio.create_task(client.run()), asyncio.create_task(stop.wait())]
        while not any(task.done() for task in tasks):
            session.update_devices(devices(measurements.telemetry(), session.now()))
            await asyncio.sleep(.05)
        for task in tasks:
            if task.done():
                task.result()
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        subscriptions.close()

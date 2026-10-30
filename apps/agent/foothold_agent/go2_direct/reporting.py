"""Optional registered-server telemetry; no second Core or cloud motion port."""
from copy import deepcopy

from foothold_agent.link.client import Client
from foothold_agent.link.telemetry import STALE_S, number
from foothold_agent.phone.observer import Observer, DiscardSink
from foothold_agent.phone.tickets import json_object


def fresh(snapshot, topic):
    value = snapshot.get('sources', {}).get(topic, {})
    age = value.get('age_s')
    return value.get('fresh') is True and number(age) and 0 <= age <= STALE_S


def project(snapshot, now):
    """Existing AgentState fields only; no invented pose or simulation clock."""
    result = dict(speed=None, battery={'soc': None},
                  pose=dict.fromkeys(('floor_id', 'map_version_id', 'x', 'y', 'yaw', 'confidence')))
    if fresh(snapshot, 'lowstate'):
        battery = snapshot.get('battery', {})
        if number(battery.get('soc')) and 0 <= battery['soc'] <= 100:
            result['battery']['soc'] = battery['soc']
        if number(battery.get('voltage')) and battery['voltage'] >= 0:
            result['battery']['voltage'] = battery['voltage']
    speed = snapshot.get('speed_sample')
    if (fresh(snapshot, 'sportmodestate') and isinstance(speed, dict) and
            number(speed.get('received')) and 0 <= now-speed['received'] <= STALE_S and
            number(speed.get('speed')) and speed['speed'] >= 0):
        result['speed'] = speed['speed']
    return result


def devices(snapshot, now):
    low, sport = fresh(snapshot, 'lowstate'), fresh(snapshot, 'sportmodestate')
    pose = snapshot.get('attitude', {})
    tilt_known = all(number(pose.get(k)) for k in ('roll', 'pitch'))
    error = snapshot.get('error_code')
    result = [dict(key='go2-battery', kind='BATTERY', label='기체 배터리',
                 state='OK' if low and number(snapshot.get('battery', {}).get('soc')) else 'MISSING'),
            dict(key='go2-imu', kind='OTHER', label='기체 자세 센서',
                 state='MISSING' if not low or not tilt_known else
                       'ERROR' if snapshot.get('fallen') is True else 'OK'),
            dict(key='go2-sport', kind='OTHER', label='기체 기본 보행 상태',
                 state='MISSING' if not sport or not number(error) else 'ERROR' if error != 0 else 'OK')]
    for device, topic in zip(result, ('lowstate', 'lowstate', 'sportmodestate')):
        age = snapshot.get('sources', {}).get(topic, {}).get('age_s')
        device['received_monotonic_s'] = now-age if number(age) and age >= 0 else float('-inf')
    return result


class ReadOnlyObserver(Observer):
    """The cloud may maintain liveness and revoke credentials; never command Go2."""
    def __init__(self, hub, feedback):
        super().__init__(hub)
        self.feedback = feedback

    def _state(self):
        return {**super()._state(), **project(self.feedback.telemetry(), self.now())}

    def receive(self, raw):
        try:
            frame = json_object(raw) if isinstance(raw, (str, bytes)) else raw
        except (ValueError, TypeError, UnicodeError, RecursionError):
            return self.tick()
        if isinstance(frame, dict) and frame.get('t') in ('ping', 'phone.revoke'):
            return super().receive(frame)
        return self.tick()  # includes STOP, lease, cmd, unlock, reset, all run.*


class Reporting:
    def __init__(self, hub, feedback, settings):
        self.hub, self.feedback = hub, feedback
        self.observer = ReadOnlyObserver(hub, feedback)
        hub.session.identity['robot_model'] = 'unitree_go2'
        self.update()
        self.client = Client(self.observer, DiscardSink(), settings)
        hub.record = self.observer.retain

    def update(self):
        # Updated on the same loop as Hub; unknown/stale values remain MISSING.
        self.observer.update_devices(deepcopy(devices(self.feedback.telemetry(), self.observer.now())))

    async def run(self):
        await self.client.run()

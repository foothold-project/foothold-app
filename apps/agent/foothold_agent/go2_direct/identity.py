"""Explicit zero-serial trial fallback: read kernel neighbours, never scan/ping."""
import asyncio
from copy import deepcopy
from ipaddress import IPv4Address, IPv4Network
import json
import re
import subprocess
import time

NETWORK = IPv4Network('192.168.123.0/24')
PEERS = {'192.168.123.161', '192.168.123.18'}
GO2 = '192.168.123.161'


def expected_serial(approval):
    return '0-0' if getattr(approval, 'serial_unavailable', False) else approval.robot_serial


def neighbors(nic):
    # No ARP scan, ping, flush, interface change or packet publication.
    result = subprocess.run(['ip','-j','-4','neigh','show','dev',nic], check=True,
                            capture_output=True, text=True, timeout=.15)
    if len(result.stdout) > 65536:
        raise PermissionError('neighbor snapshot exceeds bound')
    return json.loads(result.stdout)


def verify(approval, observed_serial, *, entries=None):
    if not getattr(approval, 'serial_unavailable', False):
        if (not isinstance(approval.robot_serial,str) or observed_serial == '0-0'
                or observed_serial != approval.robot_serial):
            raise PermissionError('robot serial does not match field approval')
        return True
    if (approval.robot_serial is not None or observed_serial != '0-0' or
            not approval.robot_mac):
        raise PermissionError('explicit zero-serial fallback required')
    entries = neighbors(approval.nic) if entries is None else entries
    if not isinstance(entries, list) or len(entries) > 256:
        raise PermissionError('bounded neighbor snapshot required')
    found = {}
    for row in entries:
        if not isinstance(row, dict):
            raise PermissionError('invalid neighbor snapshot')
        try:
            address = IPv4Address(row.get('dst'))
        except (ValueError, TypeError):
            raise PermissionError('invalid neighbor address') from None
        if address not in NETWORK:
            continue
        key, mac = str(address), row.get('lladdr')
        states = row.get('state', [])
        if isinstance(states, str):
            states = [states]
        if (key not in PEERS or key in found or row.get('dev', approval.nic) != approval.nic
                or not isinstance(states,list) or not states
                or any(x not in ('REACHABLE','STALE','DELAY','PROBE','PERMANENT') for x in states)
                or not isinstance(mac,str) or not re.fullmatch(r'[0-9a-f]{2}(?::[0-9a-f]{2}){5}', mac)
                or mac == '00:00:00:00:00:00' or int(mac[:2],16) & 1):
            raise PermissionError('dedicated neighbor identity unavailable')
        found[key] = mac
    if set(found) != PEERS or found[GO2] != approval.robot_mac:
        raise PermissionError('dedicated neighbor identity differs from approval')
    return True


class ResumeGate:
    """One bounded asynchronous query; STOP/lease/CAS changes invalidate it."""
    def __init__(self, approval, feedback, *, check=verify, now=time.monotonic):
        self.approval, self.feedback, self.check, self.now = approval, feedback, check, now
        self.task = self.frame = self.snapshot = None

    def context(self, session):
        return (session.core.stop_gen, session.lease_id,
                self.feedback.sink.feedback_context()[0])

    def request(self, frame, session):
        if self.task is not None:
            return
        if (not session.connected or not session.lease_confirmed or
                frame.get('lease_id') != session.lease_id or
                frame.get('stop_gen') != session.core.stop_gen or
                not session.core.st or session.core.st.get('stop_requested') is not True or
                self.feedback.fault or self.feedback.sample() is None):
            return
        self.frame = deepcopy(frame)
        self.snapshot, self.requested = self.context(session), self.now()
        self.task = asyncio.create_task(asyncio.to_thread(self.check, self.approval, self.feedback.serial))

    def poll(self, client):
        if self.task is None or not self.task.done():
            return
        task, frame, snapshot = self.task, self.frame, self.snapshot
        self.task = self.frame = self.snapshot = None
        try:
            valid = (task.result() is True and client.session.connected and
                client.session.lease_confirmed and self.context(client.session) == snapshot and
                0 <= self.now()-self.requested < .30 and not self.feedback.fault and
                self.feedback.sample() is not None and self.feedback.serial == '0-0')
        except Exception:
            valid = False
        if valid:
            client._emit(client.session.unlock_verified(frame))
        else:
            client._emit(client.session.feedback_lost())

    def close(self):
        if self.task is not None:
            self.task.cancel()
        self.task = self.frame = self.snapshot = None

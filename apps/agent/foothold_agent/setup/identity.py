"""Operator-confirmed 0-0 identity; no network writes or DDS initialization."""
import asyncio
import time

from foothold_agent.go2_direct.identity import neighbor_identity
from .storage import mac_serial


class IdentityUnavailable(PermissionError):
    """A safe, user-facing explanation for refusing the zero-serial flow."""


class MacIdentity:
    def __init__(self, nic, mac, inputs, *, query=neighbor_identity, now=time.monotonic):
        self.nic, self.mac, self.inputs = nic, mac, inputs
        self.query, self.now = query, now
        self.serial = mac_serial(mac)
        self.checked = float('-inf')
        self.fault = False

    def check(self, _approval=None, observed_serial='0-0'):
        # Used on the background worker and on EVERY explicit unlock. A
        # failure is permanent for this process, including a transient swap.
        started = self.now()
        try:
            if self.fault or observed_serial != '0-0' or self.inputs.observed_identity() != '0-0':
                raise PermissionError('zero identity changed')
            mac, addresses = self.query(self.nic)
            if (mac != self.mac or self.inputs.observed_identity() != '0-0'
                    or not 0 <= self.now()-started < .20):
                raise PermissionError('body identity changed or expired')
            return addresses
        except Exception:
            self.fault = True
            raise

    def verify_resume(self, approval, observed_serial):
        self.check(approval, observed_serial)
        return True

    async def refresh(self):
        started = self.now()
        addresses = await asyncio.to_thread(self.check)
        self.checked = started
        return addresses

    def valid(self):
        return not self.fault and 0 <= self.now()-self.checked < .20


async def confirm_zero_identity(inputs, nic, status, stop, credentials, *,
                                query=neighbor_identity, windows=False):
    if windows:
        raise IdentityUnavailable('이 로봇은 기체번호를 보내지 않습니다. Windows에서는 아직 연결할 수 없습니다. Ubuntu 노트북을 사용해 주세요.')
    try:
        mac, addresses = await asyncio.to_thread(query, nic.name)
        identity = MacIdentity(nic.name, mac, inputs, query=query)
        await identity.refresh()
        if credentials is not None and (credentials.identity_source != 'mac'
                or credentials.robot_mac != mac or credentials.robot_serial != identity.serial):
            raise PermissionError('saved identity differs')
    except Exception:
        raise IdentityUnavailable('로봇 몸의 연결 주소를 확인하지 못했습니다. 랜선이 로봇에 직접 꽂혀 있는지 확인한 뒤 프로그램을 다시 실행해 주세요.') from None
    request = status.request_identity(mac, addresses)
    try:
        while not stop.is_set():
            decision = status.identity_decision(request)
            if decision is False:
                status.update(mode='연결을 취소했습니다. 다시 연결하려면 프로그램을 다시 실행해 주세요.')
                return None
            await identity.refresh()
            if stop.is_set():
                return None
            if decision is True:
                inputs.mac_identity = identity
                return identity
            await asyncio.sleep(.05)
        return None
    except Exception:
        raise IdentityUnavailable('로봇의 연결 정보가 바뀌었습니다. 랜선을 확인한 뒤 프로그램을 다시 실행해 주세요.') from None
    finally:
        status.clear_identity(request)

"""0-0 body identity for mounted computers and operator-confirmed laptops."""
import asyncio
import hashlib
import logging
from pathlib import Path
import re
import time
import threading

from foothold_agent.go2_direct.identity import neighbor_identity, valid_mac
from .storage import mac_serial


class IdentityUnavailable(PermissionError):
    """A safe, user-facing explanation for refusing the zero-serial flow."""


class IdentityConflict(PermissionError):
    """Positive evidence of another body; restarting is required."""


def computer_identity(path=Path('/etc/machine-id')):
    """Local OS installation identity, hashed and never published or logged."""
    value = path.read_text().strip()
    if not re.fullmatch(r'[0-9a-f]{32}', value) or value == '0'*32:
        raise PermissionError('stable computer identity unavailable')
    return hashlib.sha256(('foothold-onboard-v1:'+value).encode()).hexdigest()


def mounted_binding(nic, mac, *, computer=None):
    if not valid_mac(nic.mac):
        raise PermissionError('stable internal NIC identity unavailable')
    return dict(nic=nic.name, nic_mac=nic.mac, robot_mac=mac, computer=(computer or computer_identity)())


class MacIdentity:
    def __init__(self, nic, mac, inputs, *, query=neighbor_identity, now=time.monotonic):
        self.nic, self.mac, self.inputs = nic, mac, inputs
        self.query, self.now = query, now
        self.serial = mac_serial(mac)
        self.checked = float('-inf')
        self.fault = False
        self.binding = None
        self.failure_epoch = 0
        self.unavailable = False
        self._lock = threading.Lock()

    def _zero_identity(self):
        # Check retained serial conflicts before freshness: a stale sample must
        # not hide positive evidence that a different body was observed.
        if self.inputs.zero_identity_changed():
            raise IdentityConflict('zero identity changed')
        if self.inputs.observed_identity() != '0-0':
            raise IdentityConflict('zero identity changed')

    def check(self, _approval=None, observed_serial='0-0', *, started=None):
        # Used on the background worker and on EVERY explicit unlock. Only
        # positive conflicting evidence permanently poisons this process.
        started = self.now() if started is None else started
        with self._lock:
            epoch = self.failure_epoch
        try:
            if self.fault or observed_serial != '0-0':
                raise IdentityConflict('zero identity changed')
            self._zero_identity()
            mac, addresses = self.query(self.nic)
            if mac != self.mac:
                raise IdentityConflict('body identity changed')
            self._zero_identity()
            if not 0 <= self.now()-started < .20:
                raise PermissionError('body identity expired')
            with self._lock:
                if self.fault or epoch != self.failure_epoch:
                    raise PermissionError('identity check superseded by failure')
                self.checked = started
                if self.unavailable:
                    logging.getLogger(__name__).warning('기체 확인 다시 확인됨')
                self.unavailable = False
            return addresses
        except Exception as error:
            with self._lock:
                self.checked = float('-inf')
                self.failure_epoch += 1
                self.fault = self.fault or isinstance(error, IdentityConflict)
                if not self.fault and not self.unavailable:
                    logging.getLogger(__name__).warning('기체 확인 잠시 안 됨')
                self.unavailable = True
            raise

    def verify_resume(self, approval, observed_serial):
        self.check(approval, observed_serial)
        return True

    async def refresh(self):
        # Include executor queue time in the unchanged .20 s freshness bound.
        return await asyncio.to_thread(self.check, started=self.now())

    def valid(self):
        return not self.fault and 0 <= self.now()-self.checked < .20


async def confirm_zero_identity(inputs, nic, status, stop, credentials, *,
                                query=neighbor_identity, windows=False, onboard=False, computer=None):
    if windows:
        raise IdentityUnavailable('이 로봇은 기체번호를 보내지 않습니다. Windows에서는 아직 연결할 수 없습니다. Ubuntu 노트북을 사용해 주세요.')
    try:
        mac, addresses = await asyncio.to_thread(query, nic.name)
        identity = MacIdentity(nic.name, mac, inputs, query=query)
        await identity.refresh()
        if not onboard and credentials is not None and (credentials.identity_source != 'mac'
                or credentials.robot_mac != mac or credentials.robot_serial != identity.serial):
            raise PermissionError('saved identity differs')
    except Exception:
        raise IdentityUnavailable('로봇 몸의 연결 주소를 확인하지 못했습니다. 랜선이 로봇에 직접 꽂혀 있는지 확인한 뒤 프로그램을 다시 실행해 주세요.') from None
    if onboard:
        if credentials is not None and (credentials.identity_source != 'mac'
                or credentials.robot_mac != mac or credentials.robot_serial != identity.serial):
            raise IdentityUnavailable('저장된 로봇과 다른 로봇입니다. 이 로봇으로 바꾸려면 등록을 다시 하세요')
        try:
            identity.binding = mounted_binding(nic, mac, computer=computer)
        except (OSError, ValueError, PermissionError):
            raise IdentityUnavailable('로봇 컴퓨터의 연결 정보를 저장할 수 없습니다. 설치 상태를 확인한 뒤 다시 실행해 주세요.') from None
        # A dedicated mounted computer accepts its directly observed body on
        # first registration too. Saved credentials may only follow that same
        # body; local installation/NIC changes merely renew the private binding.
        inputs.mac_identity = identity
        return identity
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

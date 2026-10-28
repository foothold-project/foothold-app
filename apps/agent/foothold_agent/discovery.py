"""Optional DNS-SD metadata only; no ROS, credentials, or motion interfaces.

The advertiser owns a daemon thread. Startup and cleanup never wait on mDNS
from the phone event loop. Missing extras or network failures only disable ads.
"""

from dataclasses import dataclass
from ipaddress import IPv4Address
import logging
import os
import signal
import threading
from uuid import UUID, uuid4

SERVICE_TYPE = '_foothold._tcp.local.'
LOG = logging.getLogger(__name__)


@dataclass(frozen=True)
class Advertisement:
    address: str
    port: int
    name: str = 'Go2 EDU'
    model: str = 'Go2 EDU'
    rid: str | None = None
    discovery_only: bool = False

    def __post_init__(self):
        ip = IPv4Address(self.address)
        if ip.is_unspecified or ip.is_multicast or ip.is_loopback or ip.is_reserved:
            raise ValueError('mDNS requires a reachable local IPv4 address')
        if type(self.port) is not int or not 1 <= self.port <= 65535:
            raise ValueError('invalid mDNS service port')
        for value in (self.name, self.model):
            if (not value or len(value.encode('utf-8')) > 100
                    or any(ord(char) < 32 for char in value)):
                raise ValueError('invalid mDNS display metadata')
        if self.rid is not None:
            UUID(self.rid)

    @property
    def properties(self):
        values = dict(v='1', name=self.name, model=self.model,
                      agent=f'ws://{self.address}:{self.port}/phone/ws')
        if self.rid is not None:
            values['rid'] = str(UUID(self.rid))
        if self.discovery_only:
            values['mode'] = 'discovery-only'
        return {key.encode('ascii'): value.encode('utf-8') for key, value in values.items()}

    @classmethod
    def from_env(cls, host, port, *, rid=None, env=None, discovery_only=False):
        env = os.environ if env is None else env
        enabled = env.get('FOOTHOLD_MDNS_ENABLED', '1')
        if enabled == '0':
            return None
        if enabled != '1':
            raise ValueError('FOOTHOLD_MDNS_ENABLED must be 0 or 1')
        address = env.get('FOOTHOLD_MDNS_ADDRESS', host)
        # Loopback listeners are private, even if an address override is set.
        if host in ('127.0.0.1', '::1', 'localhost'):
            return None
        return cls(address, port, env.get('FOOTHOLD_MDNS_NAME', 'Go2 EDU'),
                   env.get('FOOTHOLD_MDNS_MODEL', 'Go2 EDU'), rid, discovery_only)


class Advertiser:
    def __init__(self, advertisement):
        self.advertisement = advertisement
        self.stopped = threading.Event()
        self.ready = threading.Event()
        self.failed = threading.Event()
        self.thread = None

    @classmethod
    def for_listener(cls, host, port, *, rid=None, env=None):
        try:
            advertisement = Advertisement.from_env(host, port, rid=rid, env=env)
        except (ValueError, TypeError, AttributeError):
            LOG.warning('mDNS disabled: check discovery metadata and local IPv4 configuration')
            advertisement = None
        return cls(advertisement)

    def start(self):
        if self.advertisement is None or self.thread is not None or self.stopped.is_set():
            return
        try:
            self.thread = threading.Thread(target=self._run, name='foothold-mdns', daemon=True)
            self.thread.start()
        except RuntimeError:
            self.failed.set()
            LOG.warning('mDNS unavailable; agent service continues')

    def close(self):
        # No join: discovery must never delay the safety/phone shutdown path.
        self.stopped.set()

    def _run(self):
        zc = None
        info = None
        registered = False
        try:
            from zeroconf import IPVersion, ServiceInfo, Zeroconf
            ad = self.advertisement
            identity = uuid4().hex
            info = ServiceInfo(SERVICE_TYPE, f'foothold-{identity}.{SERVICE_TYPE}',
                               addresses=[IPv4Address(ad.address).packed], port=ad.port,
                               properties=ad.properties, server=f'foothold-{identity}.local.')
            zc = Zeroconf(interfaces=[ad.address], ip_version=IPVersion.V4Only)
            if self.stopped.is_set():
                return
            zc.register_service(info, allow_name_change=True)
            registered = True
            self.ready.set()
            LOG.info('mDNS advertisement registered%s', ' (discovery only)' if ad.discovery_only else '')
            self.stopped.wait()
        except Exception:
            # Do not log exceptions: interface/URL/configuration may be sensitive.
            self.failed.set()
            LOG.warning('mDNS unavailable; check discovery extra and multicast network')
        finally:
            if zc is not None:
                try:
                    if registered:
                        zc.unregister_service(info)
                except Exception:
                    LOG.warning('mDNS withdrawal failed; cached discovery may persist briefly')
                finally:
                    try:
                        zc.close()
                    except Exception:
                        LOG.warning('mDNS cleanup failed')


def main():
    import argparse
    parser = argparse.ArgumentParser(description='Advertise discovery metadata only; no robot service or ROS')
    parser.add_argument('--discovery-only', required=True, action='store_true')
    parser.add_argument('--address', required=True, help='local IPv4 on the phone network')
    parser.add_argument('--port', type=int, default=8790, help='metadata only; no TCP listener is opened')
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO)
    try:
        ad = Advertisement.from_env(args.address, args.port, discovery_only=True)
    except (ValueError, TypeError, AttributeError):
        parser.error('invalid discovery configuration')
    if ad is None:
        LOG.info('mDNS disabled by configuration')
        return 0
    advertiser = Advertiser(ad)
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: advertiser.close())
    LOG.warning('Discovery-only mode: no agent connection, registration, status, or motion service')
    advertiser.start()
    try:
        while not advertiser.stopped.wait(.2):
            if advertiser.failed.is_set():
                return 1
    finally:
        advertiser.close()
        if advertiser.thread is not None:
            advertiser.thread.join(timeout=3)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

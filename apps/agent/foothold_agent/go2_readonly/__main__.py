"""Dedicated field process; starting this command intentionally joins DDS domain 0."""

import argparse
from ipaddress import IPv4Address
import json
import logging
import signal
import socket
import threading

from foothold_agent.discovery import Advertiser
from .http import Access, ReadonlyAdvertisement, make_server
from .sdk import Subscriptions
from .state import State


def main(argv=None):
    parser = argparse.ArgumentParser(description='Go2 status only: no robot commands')
    parser.add_argument('--nic', required=True, help='robot Ethernet NIC (explicit; domain 0)')
    parser.add_argument('--listen', default='127.0.0.1', help='this host IPv4 on the phone LAN')
    parser.add_argument('--port', type=int, default=9610)
    parser.add_argument('--advertise', action='store_true', help='enable LAN mDNS discovery')
    parser.add_argument('--json', action='store_true',
                        help='print status JSON every second (default off; never pipe to tee)')
    parser.add_argument('--name', default='Go2 EDU (상태 전용)')
    parser.add_argument('--rid', help='optional confirmed robot UUID; no registration is performed')
    args = parser.parse_args(argv)
    try:
        address = IPv4Address(args.listen)
        if address.is_unspecified or address.is_multicast or address.is_reserved:
            raise ValueError('invalid listen address')
        if not 1 <= args.port <= 65535:
            raise ValueError('invalid port')
        if args.nic not in {name for _, name in socket.if_nameindex()}:
            raise ValueError('NIC does not exist')
        ad = (ReadonlyAdvertisement(args.listen, args.port, args.name, rid=args.rid)
              if args.advertise else None)
        state = State()
        subscriptions = Subscriptions(state, args.nic)
    except ValueError:
        parser.error('check explicit NIC, local IPv4, port, and discovery metadata')

    logging.basicConfig(level=logging.INFO)
    access = Access()
    stopping = threading.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stopping.set())
    advertiser = Advertiser(ad)
    server = None
    worker = None
    try:
        # Bind before joining DDS, so a port/configuration error cannot join a robot network.
        server = make_server((args.listen, args.port), state, access)
        subscriptions.start()
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        print(f'Read-only status: http://{args.listen}:{args.port}/go2/status', flush=True)
        print(f'Field code (30 minutes; restart to renew): {access.code}', flush=True)
        advertiser.start()
        while not stopping.wait(1):
            if args.json:
                print(json.dumps(state.snapshot(), ensure_ascii=False, allow_nan=False), flush=True)
    except Exception:
        logging.error('Read-only startup/runtime failed; check optional extra, NIC and listener')
        return 1
    finally:
        advertiser.close()
        if worker is not None and worker.is_alive():
            server.shutdown()
            worker.join(timeout=3)
        if server is not None:
            server.server_close()
        subscriptions.close()
        if advertiser.thread is not None:
            advertiser.thread.join(timeout=3)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

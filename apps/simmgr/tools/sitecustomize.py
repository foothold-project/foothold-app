"""Offline test socket fence, opt-in via FH_TEST_PORT_RANGE (including children).

Legacy phone fixtures ask for 9450..9469; map these and listener ephemeral binds
to an available approved port. Loopback client source :0 remains OS-assigned. Any attempted connection elsewhere fails BEFORE OS
connect. Not a runtime module: put this directory on test PYTHONPATH only.
"""
import os
import socket
import ipaddress
import sys

if os.environ.get('FH_TEST_PORT_RANGE'):
    first, last = map(int, os.environ['FH_TEST_PORT_RANGE'].split(':'))
    if (first, last) != (9430, 9449):
        raise RuntimeError('P1-C tests require 9430:9449')
    _bind = socket.socket.bind
    _connect = socket.socket.connect
    _connect_ex = socket.socket.connect_ex

    def bind(sock, address):
        if isinstance(address, tuple):
            host, port = address[:2]
            if not ipaddress.ip_address(host).is_loopback:
                raise RuntimeError('test attempted non-loopback bind')
            # asyncio client source ports may remain OS-assigned, as approved.
            if port == 0 and sys._getframe(1).f_code.co_name == '_connect_sock':
                return _bind(sock, address)
            if port == 0 or 9450 <= port <= 9469:
                for candidate in range(first, last + 1):
                    try:
                        return _bind(sock, (host, candidate, *address[2:]))
                    except OSError:
                        pass
                raise OSError('approved test ports exhausted')
            if not first <= port <= last:
                raise RuntimeError('test attempted protected port bind')
        return _bind(sock, address)

    def check(address):
        if isinstance(address, tuple) and (not ipaddress.ip_address(address[0]).is_loopback or not first <= address[1] <= last):
            raise RuntimeError('test attempted connection outside approved loopback range')

    def connect(sock, address):
        check(address)
        return _connect(sock, address)

    def connect_ex(sock, address):
        check(address)
        return _connect_ex(sock, address)

    socket.socket.bind, socket.socket.connect, socket.socket.connect_ex = bind, connect, connect_ex

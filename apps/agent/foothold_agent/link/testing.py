"""Explicit loopback test socket reservation; importing this starts nothing."""
from contextlib import contextmanager
import socket
import os


@contextmanager
def reserved_socket():
    """Reserve within FH_TEST_PORT_RANGE (default 9060..9079) until consumer closes."""
    sock = socket.socket()
    try:
        # Reuse our own closed test listeners after TIME_WAIT, while listen()
        # keeps each live reservation exclusive (SO_REUSEPORT is never enabled).
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        first, last = map(int, os.environ.get('FH_TEST_PORT_RANGE', '9060:9079').split(':'))
        if not 1024 <= first <= last <= 65535:
            raise ValueError('invalid FH_TEST_PORT_RANGE')
        for port in range(first, last + 1):
            try:
                sock.bind(('127.0.0.1', port))
            except OSError:
                continue
            sock.listen(1)
            yield sock
            return
        raise RuntimeError('no authorized loopback port available')
    finally:
        sock.close()

"""Explicit loopback test socket reservation; importing this starts nothing."""
from contextlib import contextmanager
import socket


@contextmanager
def reserved_socket():
    """Keep one available 9060..9079 socket reserved until its consumer closes."""
    sock = socket.socket()
    try:
        # Reuse our own closed test listeners after TIME_WAIT, while listen()
        # keeps each live reservation exclusive (SO_REUSEPORT is never enabled).
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        for port in range(9060, 9080):
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

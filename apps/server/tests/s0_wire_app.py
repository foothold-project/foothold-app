"""Explicit test-only uvicorn target for deterministic cold STOP/refresh overlap."""
import asyncio
import threading
import time
from apps.server.fh_server.main import app

rt = app.state.realtime
loaded = 0
release = threading.Event()
original = rt.load_stop_scope


def held_scope(key):
    global loaded
    result = original(key)
    loaded += 1
    if not release.wait(5):
        raise TimeoutError('test did not release cold STOP reads')
    time.sleep(.45)
    return result


rt.load_stop_scope = held_scope


@app.get('/_s0/loaded')
async def count():
    return {'loaded': loaded}


@app.post('/_s0/release')
async def resume():
    release.set()
    return {'released': True}

"""Small OS dispatchers; safety/runtime policies remain shared."""
import asyncio
import os
import signal


def install_stop_handlers(stop):
    loop = asyncio.get_running_loop()
    previous = {}
    for sig in (signal.SIGINT, signal.SIGTERM):
        previous[sig] = signal.getsignal(sig)
        if os.name == 'nt':
            signal.signal(sig, lambda *_: loop.call_soon_threadsafe(stop.set))
        else:
            loop.add_signal_handler(sig, stop.set)
    def restore():
        for sig, handler in previous.items():
            if os.name != 'nt':
                loop.remove_signal_handler(sig)
            signal.signal(sig, handler)
    return restore


def inspect(wheel_dir):
    if os.name == 'nt':
        from .windows_preflight import inspect as implementation
    else:
        from foothold_agent.go2_direct.preflight import inspect as implementation
    return implementation(wheel_dir)

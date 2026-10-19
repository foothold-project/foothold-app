"""Explicit simulation runner. No simulation launch, reset service or hardware SDK."""

import asyncio
import signal

from foothold_agent.link.client import Client
from foothold_agent.link.session import Session
from .config import Config
from .node import RosNode


async def run(config):
    bridge = RosNode(config)
    client = None
    tasks = []
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)
    try:
        # A closure defers Client construction until local startup ZERO/STOP.
        sink = await bridge.start(lambda raw: client.on_robot_state(raw) if client is not None else None,
            on_telemetry=lambda snapshot: client.update_telemetry(snapshot) if client is not None else None,
            on_devices=lambda devices: client.update_devices(devices) if client is not None else None)
        session = Session()  # always starts latched, including process restart
        client = Client(session, sink, config.settings)
        # Startup callbacks may have run before Client existed. Seed hello from
        # actual receptions, then update via the serialized callbacks above.
        client.update_telemetry(bridge.inputs.telemetry.snapshot())
        client.update_devices(bridge.inputs.device_snapshot())
        tasks = [asyncio.create_task(client.run()), asyncio.create_task(bridge.wait_failure()),
                 asyncio.create_task(stop.wait())]
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            task.result()
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        try:
            bridge.close()
        finally:
            for sig in (signal.SIGINT, signal.SIGTERM):
                loop.remove_signal_handler(sig)


def main():
    # Fail isolation/credential validation before importing rclpy or connecting WS.
    config = Config.from_env()
    asyncio.run(run(config))


if __name__ == "__main__":
    main()

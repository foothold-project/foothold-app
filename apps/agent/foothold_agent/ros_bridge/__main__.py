"""Explicit simulation runner. No simulation launch, reset service or hardware SDK."""

import asyncio
import signal

from foothold_agent.link.client import Client
from foothold_agent.link.session import Session
from foothold_agent.phone.hub import Hub
from foothold_agent.phone.server import Server
from foothold_agent.phone.observer import Observer, DiscardSink
from .config import Config
from .node import RosNode


async def run(config):
    bridge = RosNode(config)
    client = None
    phone = None
    tasks = []
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)
    try:
        def on_state(raw):
            if phone is not None:
                phone.hub.on_robot_state(raw)
            if client is not None:
                client.on_robot_state(raw)

        def on_telemetry(snapshot):
            if phone is not None:
                phone.hub.session.update_telemetry(snapshot)
            if client is not None:
                client.update_telemetry(snapshot)

        def on_devices(devices):
            if phone is not None:
                phone.hub.session.update_devices(devices)
            if client is not None:
                client.update_devices(devices)

        # A closure defers Client construction until local startup ZERO/STOP.
        sink = await bridge.start(on_state,
            on_telemetry=on_telemetry, on_devices=on_devices)
        if getattr(config, 'phone', None) is not None:
            hub = Hub(config.phone_verifier, sink,
                      policy_name=config.phone.policy_name, policy_version=config.phone.policy_version,
                      simulation=True)
            phone = Server(hub, config.phone)
            session = Observer(hub)
            client = Client(session, DiscardSink(), config.settings)
            hub.record = session.retain
        else:
            session = Session()  # always starts latched, including process restart
            client = Client(session, sink, config.settings)
        # Startup callbacks may have run before Client existed. Seed hello from
        # actual receptions, then update via the serialized callbacks above.
        client.update_telemetry(bridge.inputs.telemetry.snapshot())
        client.update_devices(bridge.inputs.device_observations())
        if phone is not None:
            phone.hub.session.update_telemetry(bridge.inputs.telemetry.snapshot())
            phone.hub.session.update_devices(bridge.inputs.device_observations())
        tasks = [asyncio.create_task(client.run()), asyncio.create_task(bridge.wait_failure()),
                 asyncio.create_task(stop.wait())]
        if phone is not None:
            tasks.append(asyncio.create_task(phone.run()))
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            task.result()
    finally:
        try:
            if phone is not None:
                phone.hub.close()  # local STOP before network task cancellation
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            try:
                verifier = getattr(config, 'phone_verifier', None)
                if verifier is not None:
                    verifier.close()
            finally:
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

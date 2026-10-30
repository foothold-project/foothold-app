"""One local phone Hub, one Core, one Go2Sink; no server command authority."""
import asyncio
import socket
import sys
import time

from foothold_agent.phone.hub import Hub
from foothold_agent.phone.server import Server
from . import sdk
from .feedback import Feedback
from .phone import PhoneSink
from .sink import Go2Sink


async def run(config, env, *, stop=None, startup_timeout=5., channel_factory=None,
              server_factory=Server, reporting_factory=None):
    """Dependencies are injectable for fake DDS/SDK + real loopback WS tests."""
    channel_factory = channel_factory or sdk.open_channel
    stop = stop or asyncio.Event()
    feedback = Feedback(config.approval.robot_serial)
    channel = sink = hub = phone = reporting = None
    tasks = []
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    deadline = time.monotonic()+max(0, config.approval.expires_at-time.time())
    try:
        # Bind failures and all credential/configuration validation precede DDS.
        sock.bind((config.phone.host, config.phone.port))
        sock.setblocking(False)
        channel = channel_factory(env)
        channel.subscribe(feedback)
        until = time.monotonic()+startup_timeout
        while feedback.sample() is None:
            if feedback.fault:
                raise PermissionError('robot identity conflict on dedicated NIC')
            if stop.is_set():
                return
            if time.monotonic() >= min(until, deadline):
                raise TimeoutError('fresh identity and advancing robot telemetry required')
            await asyncio.sleep(.02)
        clients = sdk.connect(env, observed_serial=feedback.serial, channel=channel)
        sink = Go2Sink(*clients, phone_watchdog=True)
        feedback.sink = sink
        sink.start_threads()
        phone_sink = PhoneSink(sink)
        hub = Hub(config.verifier, phone_sink, policy_name=config.phone.policy_name,
                  policy_version=config.phone.policy_version, simulation=False)
        phone_sink.hub = hub
        phone = server_factory(hub, config.phone, sock=sock)
        tasks = [asyncio.create_task(phone.run()), asyncio.create_task(stop.wait())]
        if reporting_factory is not None and config.link is not None:
            reporting = reporting_factory(hub, feedback, config.link)
            tasks.append(asyncio.create_task(reporting.run()))
        healthy = False
        while not any(task.done() for task in tasks):
            if feedback.fault:
                raise PermissionError('robot identity changed; restart after field review')
            if sink.error is not None:
                raise RuntimeError('Go2 output worker failed') from sink.error
            if time.monotonic() >= deadline:
                raise PermissionError('field approval expired')
            ready = feedback.consume(hub)
            if not ready and healthy:
                hub.stop()  # sensor expiry/invalidity locks before Core's 1 s stale gate
            healthy = ready
            if reporting is not None:
                reporting.update()
            await asyncio.sleep(.02)
        for task in tasks:
            if task.done():
                task.result()
    finally:
        # Physical zero/STOP precedes listener close, cloud teardown and waits.
        primary = sys.exc_info()[1]
        errors = []
        try:
            if hub is not None:
                hub.close()
        except BaseException as error:
            errors.append(error)
        finally:
            for task in tasks:
                task.cancel()
            results = await asyncio.gather(*tasks, return_exceptions=True)
            errors.extend(r for r in results if isinstance(r, BaseException)
                          and not isinstance(r, asyncio.CancelledError) and r is not primary)
            try:
                if sink is not None:
                    sink.close()
            except BaseException as error:
                errors.append(error)
            finally:
                try:
                    if channel is not None:
                        channel.close()
                except BaseException as error:
                    errors.append(error)
                finally:
                    sock.close()
        if errors:
            if primary is not None:
                primary.output_errors = [*getattr(primary, 'output_errors', []), *errors]
            else:
                raise errors[0]

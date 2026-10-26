"""Explicit simulation runner. No simulation launch, reset service or hardware SDK."""

import asyncio
import signal
import os
from uuid import UUID

from foothold_agent.media import Media, MediaTransport
from .media import MediaRosSource, external_source

from foothold_agent.camera import Camera, CameraTransport

from foothold_agent.link.client import Client
from foothold_agent.link.session import Session
from foothold_agent.phone.hub import Hub
from foothold_agent.phone.server import Server
from foothold_agent.phone.observer import Observer, DiscardSink
from .config import Config
from .node import RosNode
from .run_context import RunContext


async def run(config, *, simulation_binding=None):
    camera = Camera(config.robot_id) if os.environ.get('FOOTHOLD_CAMERA_ENABLED') == '1' else None
    media = media_source = None
    nav = maps = None
    bridge_options = {'camera': camera} if camera is not None else {}
    if os.environ.get('FOOTHOLD_RUN_MAP_ASSETS_JSON'):
        from foothold_agent.executor.nav2 import NavExecutor, PolicyAdapter
        from foothold_agent.executor.nav2.actions import GoalActions
        from .run_maps import RunMaps
        from .run_nav import RunNav
        maps = RunMaps.from_env(getattr(config, 'floor_bindings', None), os.environ)
        # Physical fallback. Hub can select SI only with a simmgr launch binding.
        adapter = PolicyAdapter(dict(allow_curves=False, yaw_zero_threshold_rps=.04,
            commands=[dict(si=[0,0,0],axes=[0,0,0]),dict(si=[.6,0,0],axes=[1,0,0])]))
        nav = NavExecutor(adapter, GoalActions())
        bridge_options['extension_factory'] = lambda node: RunNav(node, nav)
    bridge = RosNode(config, **bridge_options)
    client = None
    phone = None
    run_journal = None
    scenario_source = photo_client = None
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
            if media is not None:
                observation = snapshot.get('observation')
                media.bind(media_identity(observation['episode']) if observation is not None else None)
                if observation is not None:
                    media_source.update_time(observation['episode'], observation['sim_t'],
                                             observation['received_monotonic_s'])
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
            from foothold_agent.executor.run_outbox import RunOutbox
            from foothold_agent.executor.scenario import ScenarioSource
            if os.environ.get('FOOTHOLD_RUN_OUTBOX_PATH') == ':memory:':
                raise ValueError('production run journal must be durable')
            if os.environ.get('FOOTHOLD_RUN_OUTBOX_PATH'):
                run_journal = RunOutbox(os.environ['FOOTHOLD_RUN_OUTBOX_PATH'])
            if os.environ.get('FOOTHOLD_SCENARIO_DATA_ORIGIN'):
                scenario_source = ScenarioSource(os.environ['FOOTHOLD_SCENARIO_DATA_ORIGIN'], config.settings.token)
            run_context = RunContext(bridge, maps, nav)

            def arrival(binding, goal):
                snapshot = bridge.inputs.telemetry.snapshot()
                location = snapshot.get('location')
                if not location or location.get('episode') != binding.episode:
                    return None
                return dict(binding=binding, received_at=location['received_monotonic_s'],
                    pose={k: location[k] for k in ('floor_id','map_version_id','x','y','yaw','confidence')})

            hub = Hub(config.phone_verifier, sink, nav=nav, run_context=run_context,
                      arrival_evidence=arrival,
                      policy_name=config.phone.policy_name, policy_version=config.phone.policy_version,
                      simulation=config.phone.simulation, scenario_source=scenario_source, run_journal=run_journal,
                      simulation_binding=simulation_binding,
                      run_pause_timeout_s=float(os.environ.get('FOOTHOLD_RUN_PAUSE_TIMEOUT_S', '600')))
            if camera is not None or os.environ.get('FOOTHOLD_MEDIA_ENABLED') == '1':
                media = Media(config.robot_id, rgb_enabled=camera is not None,
                              external_source=external_source(config, simulation_binding))
                media_source = MediaRosSource(media)
                def media_identity(epoch):
                    if not config.phone.simulation:
                        return dict(robot=config.robot_id, epoch=epoch, episode_id=None)
                    floors = getattr(config, 'floor_bindings', None)
                    try:
                        episode = str(UUID(floors.run_id))
                    except (AttributeError, ValueError, TypeError):
                        return None
                    return dict(robot=config.robot_id, epoch=epoch, episode_id=episode)
                media.start()
                media_source.start()
                initial = bridge.inputs.telemetry.snapshot().get('observation')
                if initial is not None:
                    media.bind(media_identity(initial['episode']))
                    media_source.update_time(initial['episode'], initial['sim_t'])
            phone = Server(hub, config.phone, camera=CameraTransport(camera, hub) if camera else None,
                           media=MediaTransport(media, hub) if media is not None else None)
            from foothold_agent.executor.steps import ExecutionSupport
            if scenario_source is not None:
                from foothold_agent.executor.photos import PhotoClient
                photo_client = PhotoClient(scenario_source.origin, config.settings.token)
            hub.runs.support = ExecutionSupport(camera=camera, media=media, now=hub.now, uploader=photo_client)
            if scenario_source is not None:
                scenario_source.support = hub.runs.support
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
        if camera is not None:
            tasks.append(asyncio.create_task(camera.run()))
        if media is not None:
            tasks.append(asyncio.create_task(media.run()))
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
                    if media_source is not None:
                        await asyncio.to_thread(media_source.close)
                    if media is not None:
                        await asyncio.to_thread(media.close)
                    if run_journal is not None:
                        await asyncio.to_thread(run_journal.close)
                    if photo_client is not None:
                        photo_client.close()
                    if scenario_source is not None:
                        scenario_source.pool.shutdown(wait=False, cancel_futures=True)
                    for sig in (signal.SIGINT, signal.SIGTERM):
                        loop.remove_signal_handler(sig)


def main():
    # Fail isolation/credential validation before importing rclpy or connecting WS.
    config = Config.from_env()
    from foothold_agent.executor.nav2.simulation import SimulationBinding
    binding = SimulationBinding.from_launch(globals().get('_simmgr_launch_proof'), config, os.environ)
    asyncio.run(run(config, simulation_binding=binding))


if __name__ == "__main__":
    main()

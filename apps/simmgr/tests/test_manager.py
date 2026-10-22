import asyncio
from dataclasses import replace
from pathlib import Path
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest

from apps.simmgr.config import Settings, Slot, World
from apps.simmgr.service import Manager, SimError
from apps.simmgr.launcher import FakeLauncher, NativeLauncher
from apps.simmgr.api import create_app
from foothold_agent.ros_bridge.config import REQUIRED_ENV, validate_isolation


def settings():
    org = str(uuid4())
    slots = [Slot(str(uuid4()), org, '/private/key', '/private/replay-' + str(i), 9433 + i) for i in range(2)]
    return Settings({'a': World('a', Path('/private/a.sdf'), Path('/private/a.yaml')),
                     'b': World('b', Path('/private/b.sdf'), Path('/private/b.yaml'))},
                    {s.robot_id: s for s in slots}, 'x' * 32)


def test_manager_limits_isolation_and_stop_order():
    async def run():
        cfg = settings(); launch = FakeLauncher(); manager = Manager(cfg, launch)
        slots = list(cfg.slots.values()); owners = [str(uuid4()), str(uuid4())]
        one, two = await asyncio.gather(*[manager.add('a', s.robot_id, owners[i], s.org_id, 'x' * 32, 1)
                                          for i, s in enumerate(slots)])
        assert one['namespace'] != two['namespace'] and one['tf_prefix'] != two['tf_prefix']
        assert one['command_topic'] != two['command_topic'] and one['agent_address'] != two['agent_address']
        assert [e[0] for e in launch.events].count('world') == 1
        assert one['state'] == 'PREPARED' and one['simulation'] is True
        with pytest.raises(SimError) as error:
            await manager.start_world('b')
        assert error.value.code == 'SIM_WORLD_BUSY'
        await manager.close()
        for slot in slots:
            sequence = [e[0] for e in launch.events if len(e) > 1 and e[1] == slot.robot_id]
            assert sequence == ['agent', 'STOP', 'zero', 'agent_exit', 'remove']
        assert launch.events[-1] == ('world_exit',)
    asyncio.run(run())


def test_cap_and_one_person_one_robot():
    async def run():
        cfg = replace(settings(), max_robots=1); manager = Manager(cfg); a, b = cfg.slots.values()
        owner = str(uuid4())
        await manager.add('a', a.robot_id, owner, a.org_id, 'x' * 32, 1)
        with pytest.raises(SimError) as error:
            await manager.add('a', b.robot_id, str(uuid4()), b.org_id, 'x' * 32, 1)
        assert error.value.code == 'SIM_ROBOT_LIMIT'
        with pytest.raises(SimError) as error:
            await manager.add('a', b.robot_id, owner, b.org_id, 'x' * 32, 1)
        assert error.value.code == 'SIM_OWNER_LIMIT'
    asyncio.run(run())


def test_stop_failure_retains_robot_and_world():
    class Broken(FakeLauncher):
        async def stop_agent(self, slot):
            raise RuntimeError('unconfirmed')
    async def run():
        cfg = settings(); launch = Broken(); manager = Manager(cfg, launch); slot = next(iter(cfg.slots.values()))
        await manager.add('a', slot.robot_id, str(uuid4()), slot.org_id, 'x' * 32, 1)
        with pytest.raises(RuntimeError):
            await manager.close()
        assert slot.robot_id in manager.robots and manager.robots[slot.robot_id].state == 'ERROR'
        assert ('world_exit',) not in launch.events
        assert all(e[0] != 'remove' for e in launch.events)
    asyncio.run(run())


@pytest.mark.parametrize('name,value', [('ROS_DOMAIN_ID','61'), ('ROS_LOCALHOST_ONLY','0'),
    ('ROS_AUTOMATIC_DISCOVERY_RANGE','SUBNET'), ('ROS_STATIC_PEERS','external'), ('CYCLONEDDS_URI','external')])
def test_isolation_rejects_before_any_launch(name, value):
    with pytest.raises(ValueError):
        validate_isolation({**REQUIRED_ENV, name:value})


def test_real_optin_and_single_robot(monkeypatch):
    monkeypatch.delenv('FH_SIM_RUN', raising=False)
    with pytest.raises(ValueError, match='FH_SIM_RUN'):
        NativeLauncher(settings())
    class NativeFake(FakeLauncher):
        real = True
    async def run():
        cfg = replace(settings(), real=True, source='source', ros_setup='setup', run_dir='run')
        # Assets must exist for native-mode validation; no native process is used.
        cfg = replace(cfg, worlds={'a': World('a', Path(__file__), Path(__file__))})
        mgr = Manager(cfg, NativeFake()); a,b = cfg.slots.values()
        await mgr.add('a', a.robot_id, str(uuid4()), a.org_id, 'x'*32,1)
        with pytest.raises(SimError) as error:
            await mgr.add('a', b.robot_id, str(uuid4()), b.org_id, 'x'*32,1)
        assert error.value.code == 'SIM_NATIVE_SINGLE_ONLY'
    asyncio.run(run())


def test_loopback_auth_api_and_shutdown():
    cfg = settings(); slot = next(iter(cfg.slots.values())); launch = FakeLauncher()
    app = create_app(cfg, launch)
    with TestClient(app, client=('127.0.0.1', 9438)) as client:
        assert client.get('/v1/worlds', params={'org_id':slot.org_id}).status_code == 401
        headers = {'Authorization':'Bearer '+cfg.secret}
        catalog = client.get('/v1/worlds', params={'org_id':slot.org_id}, headers=headers).json()
        assert catalog['launcher'] == 'fake' and catalog['max_robots'] == 2
        body = dict(world_id='a', robot_id=slot.robot_id, org_id=slot.org_id, owner_id=str(uuid4()), agent_token='x'*32,generation=1)
        result = client.post('/v1/robots', json=body, headers=headers)
        assert result.status_code == 200 and result.json()['state'] == 'PREPARED'
        assert 'agent_token' not in result.text
        assert client.post('/v1/robots', content='x'*4097, headers=headers).status_code == 413
        assert len(client.get('/v1/robots', params={'org_id':slot.org_id}, headers=headers).json()['items']) == 1
    assert ('STOP',slot.robot_id) in launch.events


def test_configuration_rejects_public_bind_duplicate_ports():
    cfg = settings()
    for values in ({'host':'0.0.0.0'}, {'port':8453}, {'max_robots':3}):
        with pytest.raises(ValueError):
            replace(cfg, **values)
    slots = list(cfg.slots.values())
    with pytest.raises(ValueError):
        replace(cfg, slots={s.robot_id:replace(s,port=9433) for s in slots})


def test_default_fake_never_creates_process(monkeypatch):
    import subprocess
    def forbidden(*args, **kwargs):
        raise AssertionError('fake mode attempted a process')
    monkeypatch.setattr(subprocess,'Popen',forbidden)
    async def run():
        cfg=settings(); manager=Manager(cfg); slot=next(iter(cfg.slots.values()))
        await manager.add('a',slot.robot_id,str(uuid4()),slot.org_id,'x'*32,1)
        await manager.close()
    asyncio.run(run())


def test_native_bad_exit_prevents_world_removal(monkeypatch):
    from types import SimpleNamespace
    monkeypatch.setenv('FH_SIM_RUN','1')
    async def run():
        cfg=replace(settings(),real=True,source='unused',ros_setup='unused',run_dir='unused')
        launch=NativeLauncher(cfg)
        events=[]
        child=SimpleNamespace(poll=lambda:None,send_signal=lambda sig:events.append('signal'),
                              wait=lambda **kwargs:1)
        launch.child=child
        with pytest.raises(RuntimeError,match='STOP/zero'):
            await launch.stop_agent(next(iter(cfg.slots.values())))
        assert launch.child is child and launch.failed and events == ['signal']
        with pytest.raises(RuntimeError,match='STOP/zero'):
            await launch.close_world()
    asyncio.run(run())


def test_config_from_env_rejects_domain61_before_reading_catalogue():
    with pytest.raises(ValueError,match='control plane'):
        Settings.from_env({**REQUIRED_ENV,'ROS_DOMAIN_ID':'61'})


def test_from_env_uses_private_auth_and_defaults_to_fake(tmp_path):
    import json
    cfg=settings()
    catalogue=tmp_path/'catalog.json'
    catalogue.write_text(json.dumps({'worlds':[dict(id='a',world_file='/private/a.sdf',map_file='/private/a.pgm')],
        'slots':[dict(robot_id=s.robot_id,org_id=s.org_id,key_path=s.key_path,replay_path=s.replay_path,port=s.port)
                 for s in cfg.slots.values()]}))
    secret=tmp_path/'auth';secret.write_text('x'*32);secret.chmod(0o600)
    env={'FH_SIM_CATALOG':str(catalogue),'FH_SIM_AUTH_FILE':str(secret),
         'FH_SIM_AGENT_WS_URL':'ws://127.0.0.1:9431/api/v1/agent/ws'}
    result=Settings.from_env(env)
    assert not result.real and result.max_robots == 2 and result.secret == 'x'*32
    origin = 'https://example.trycloudflare.com'
    env['FH_TUNNEL_ORIGIN'] = origin
    assert Settings.from_env(env).origins == result.origins
    env['FH_TUNNEL'] = '1'
    assert Settings.from_env(env).origins == (*result.origins, origin)
    env['FH_TUNNEL_ORIGIN'] = 'https://*.trycloudflare.com'
    assert Settings.from_env(env).origins == result.origins
    secret.chmod(0o644)
    with pytest.raises(ValueError,match='private'):
        Settings.from_env(env)


def test_native_waits_for_identity_after_unit_birth(tmp_path,monkeypatch):
    import json
    import sys
    from types import SimpleNamespace
    from apps.simmgr import launcher as module
    monkeypatch.setenv('FH_SIM_RUN','1')
    source=tmp_path/'experiment/spec/stage/source'
    source.mkdir(parents=True)
    maps=source.parent.parent.parent/'maps';maps.mkdir()
    world=maps/'world.sdf';world.write_text('synthetic')
    mapfile=maps/'map.pgm';mapfile.write_text('synthetic')
    (maps/'worlds.json').write_text(json.dumps({'worlds':{'v5_single/f1':{'world':'world.sdf','gt_map':'map.pgm'}}}))
    root=tmp_path/'checkout';(root/'runs').mkdir(parents=True)
    class Sim:
        reason=None
        started=False
        calls=0
        def __init__(self,folder,src,setup,launch_env=None,seconds=None):
            assert seconds == 1890
            assert launch_env['ROS_DOMAIN_ID'] == '93'
            self.source=src
        def start(self):
            self.started=True
        def live_identity(self):
            self.calls += 1
            if self.calls == 1:
                raise RuntimeError('Gazebo not born yet')
            return {'domain':'93'}
        def close(self):
            self.started=False
    monkeypatch.setattr(module,'ROOT',root)
    monkeypatch.setattr(module,'startup_preflight',lambda real: {})
    monkeypatch.setitem(sys.modules,'isolation',SimpleNamespace(Simulation=Sim))
    monkeypatch.setitem(sys.modules,'constants',SimpleNamespace(MAP_DIRECTORY='maps'))
    async def run():
        cfg=replace(settings(),real=True,source=str(source),ros_setup='unused',run_dir=str(root/'runs/approved'))
        launch=NativeLauncher(cfg)
        await launch.start_world(World('v5_single/f1',world,mapfile))
        assert launch.sim.calls == 2 and launch.sim.started
        await launch.close_world()
    asyncio.run(run())


def test_manager_rejects_external_peer_even_with_correct_secret():
    cfg=settings()
    with TestClient(create_app(cfg),client=('192.0.2.10',9438)) as client:
        response=client.get('/v1/worlds',params={'org_id':next(iter(cfg.slots.values())).org_id},
                            headers={'Authorization':'Bearer '+cfg.secret})
        assert response.status_code==403 and response.json()['error']['code']=='SIM_LOOPBACK_ONLY'


def test_manager_rejects_stale_generation_before_stop():
    async def run():
        cfg=settings(); manager=Manager(cfg); slot=next(iter(cfg.slots.values())); owner=str(uuid4())
        await manager.add('a',slot.robot_id,owner,slot.org_id,'x'*32,1)
        await manager.remove(slot.robot_id,1)
        await manager.add('a',slot.robot_id,owner,slot.org_id,'y'*32,2)
        before=list(manager.launcher.events)
        with pytest.raises(SimError) as error:
            await manager.remove(slot.robot_id,1)
        assert error.value.code=='SIM_GENERATION_MISMATCH'
        assert manager.robots[slot.robot_id].generation==2 and manager.launcher.events==before
        await manager.close()
    asyncio.run(run())

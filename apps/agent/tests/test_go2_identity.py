"""Zero-serial exception is explicit, read-only, and rechecked for each resume."""
import asyncio
from dataclasses import replace
import importlib.util
import json
from pathlib import Path
import threading
import time
from types import SimpleNamespace as NS

import pytest

from foothold_agent.go2_direct.approval import Approval,validate
from foothold_agent.go2_direct.config import Config
from foothold_agent.go2_direct.identity import verify,ResumeGate,neighbors
from test_go2_runtime_config import env
from test_go2_server_drive import rig

MAC='02:00:00:00:00:01'


def entries():
    return [dict(dst='192.168.123.161',dev='fake0',lladdr=MAC,state=['REACHABLE']),
            dict(dst='192.168.123.18',dev='fake0',lladdr='02:00:00:00:00:02',state=['STALE'])]


def approval():
    return Approval('fake0',None,time.time()+600,True,MAC)


def test_zero_serial_explicit_marker_and_exact_neighbors_pass(env):
    marker=Path(env['FH_GO2_FIELD_APPROVAL']);value=json.loads(marker.read_text())
    value.update(robot_serial=None,serial_unavailable=True,robot_mac=MAC);marker.write_text(json.dumps(value))
    config=Config.from_env({**env,'FOOTHOLD_AGENT_WS_URL':'wss://server.invalid/api/v1/agent/ws','FOOTHOLD_AGENT_TOKEN':'fake'},server=True)
    assert config.approval.serial_unavailable and config.approval.robot_serial is None
    assert verify(config.approval,'0-0',entries=entries())
    with pytest.raises(ValueError):Config.from_env(env)  # phone policy stays unchanged


@pytest.mark.parametrize('bad',['missing-flag','missing-serial','serial-string','missing-mac','multicast','normal-with-flag'])
def test_fallback_marker_cannot_be_inferred_or_partially_enabled(env,bad):
    path=Path(env['FH_GO2_FIELD_APPROVAL']);value=json.loads(path.read_text())
    value.update(robot_serial=None,serial_unavailable=True,robot_mac=MAC)
    if bad=='missing-flag':value.pop('serial_unavailable')
    elif bad=='missing-serial':value.pop('robot_serial')
    elif bad=='serial-string':value['robot_serial']='0-0'
    elif bad=='missing-mac':value.pop('robot_mac')
    elif bad=='multicast':value['robot_mac']='01:00:00:00:00:01'
    else:value['robot_serial']='1234-5678'
    path.write_text(json.dumps(value))
    with pytest.raises(PermissionError):validate(env)


@pytest.mark.parametrize('bad',['mac','third','missing-orin','other-serial','wrong-nic','failed','duplicates','normal-zero'])
def test_identity_mismatch_never_passes(bad):
    values=entries();marker=approval();serial='0-0'
    if bad=='mac':values[0]['lladdr']='02:00:00:00:00:03'
    elif bad=='third':values.append(dict(dst='192.168.123.42',dev='fake0',lladdr='02:00:00:00:00:03',state=['STALE']))
    elif bad=='missing-orin':values.pop()
    elif bad=='other-serial':serial='1234-5678'
    elif bad=='wrong-nic':values[0]['dev']='other0'
    elif bad=='failed':values[0]['state']=['FAILED']
    elif bad=='duplicates':values.append(dict(values[0]))
    else:marker=Approval('fake0','0-0',time.time()+600)
    with pytest.raises(PermissionError):verify(marker,serial,entries=values)


def test_neighbor_query_only_reads_ip_table(monkeypatch):
    calls=[]
    def command(args,**kw):calls.append((args,kw));return NS(stdout=json.dumps(entries()))
    monkeypatch.setattr('foothold_agent.go2_direct.identity.subprocess.run',command)
    assert neighbors('fake0')==entries()
    assert calls[0][0]==['ip','-j','-4','neigh','show','dev','fake0']
    assert calls[0][1]['timeout']==.15


@pytest.mark.parametrize('change',['none','stop','lease','socket','mac','late'])
def test_async_resume_neighbor_check_cannot_outlive_stop_or_authority(change):
    now,sink,normal,emergency,session,client,measured,frame=rig()
    frame('stop',stop_ref=42);measured()
    released=threading.Event();entered=threading.Event();checks=[]
    def check(marker,serial):
        checks.append(serial);entered.set();released.wait(1)
        if change=='mac':raise PermissionError('mismatch')
        return True
    feedback=NS(serial='0-0',sink=sink,fault=False,sample=lambda:object())
    gate=ResumeGate(approval(),feedback,check=check,now=now)
    session.identity_gate=gate
    async def scenario():
        frame('unlock',lease_id='fake-lease',stop_gen=session.core.stop_gen)
        assert sink.latched
        async with asyncio.timeout(.5):
            while not entered.is_set():await asyncio.sleep(.001)
        if change=='stop':frame('stop',stop_ref=43)
        elif change=='lease':frame('lease',lease_id=None,holder_type=None)
        elif change=='socket':client._emit(session.disconnect())
        elif change=='late':now.value+=.301
        released.set()
        async with asyncio.timeout(.5):
            while not gate.task.done():await asyncio.sleep(.001)
        gate.poll(client)
        if change=='none':
            assert not sink.latched
            measured()
            frame('cmd',lease_id='fake-lease',seq=1,axes=[.4,0,0]);assert sink.pending==(0,0,0)
            frame('cmd',lease_id='fake-lease',seq=2,axes=[0,0,0])
            frame('cmd',lease_id='fake-lease',seq=3,axes=[.4,0,0]);assert sink.pending==(.4,0,0)
        else:assert sink.latched and sink.pending==(0,0,0)
        gate.close()
    try:asyncio.run(scenario())
    finally:released.set()
    assert checks==['0-0']


def test_make_approval_explicit_zero_serial_option_has_no_sdk_or_neighbor_io(tmp_path):
    path=Path('deploy/jetson/make_approval.py').resolve()
    spec=importlib.util.spec_from_file_location('make_approval_add2',path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    target=tmp_path/'marker.json'
    assert module.main(['--output',str(target),'--nic','fake0','--serial-unavailable','--robot-mac',MAC,'--approve-field-motion'])==0
    value=json.loads(target.read_text())
    assert value['robot_serial'] is None and value['serial_unavailable'] is True and value['robot_mac']==MAC
    assert target.stat().st_mode&0o777==0o600

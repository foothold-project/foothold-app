"""Retained shutdown admission, read-only audit and native publication evidence."""
import asyncio
from copy import deepcopy
import json
import os
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi.testclient import TestClient

from apps.simmgr import recovery, startup_evidence
from apps.simmgr.api import create_app
from apps.simmgr.service import Manager, SimError
from apps.agent.tools.sim.target_recording import Publications, compile_runtime, scope
from test_manager import settings


@pytest.mark.parametrize('slot_state', [None, 'ERROR', 'RUNNING', 'STARTING', 'STOPPING', 'PREPARED'])
def test_prepare_only_error_or_empty_keeps_latch_and_never_calls_cleanup(tmp_path, monkeypatch, slot_state):
    (tmp_path/'state').mkdir(); latch=tmp_path/'state/unproven'; latch.touch()
    monkeypatch.setenv('FH_SIM_DEPLOY_GUARD_DIR', str(tmp_path))
    proof=Mock(return_value=dict(processes=0)); monkeypatch.setattr(recovery, 'local_absence', proof)
    async def run():
        mgr=Manager(settings()); cleanup=AsyncMock(); mgr.launcher.close_world=cleanup
        if slot_state:
            mgr.robots['owned']=SimpleNamespace(state=slot_state)
        if slot_state not in (None, 'ERROR'):
            with pytest.raises(SimError): await mgr.prepare_retained_shutdown()
            assert not mgr.closing; proof.assert_not_called()
            return
        mgr.deployment_lease.fd = os.open(tmp_path/'lease', os.O_RDWR | os.O_CREAT, 0o600)
        assert (await mgr.prepare_retained_shutdown())['prepared'] is True
        # Listing, removal and startup must not restart health/cleanup work.
        with pytest.raises(SimError): await mgr.remove('owned', 1)
        with pytest.raises(SimError): await mgr.start_world('a')
        await mgr.close()
        cleanup.assert_not_called(); assert latch.exists()
        assert mgr.retained_shutdown and mgr.closing and mgr.failed
    asyncio.run(run())


@pytest.mark.parametrize('fault', ['missing-latch', 'live', 'starting', 'expiring', 'closing'])
def test_prepare_unknown_or_live_refuses_without_closing(tmp_path, monkeypatch, fault):
    (tmp_path/'state').mkdir()
    if fault != 'missing-latch': (tmp_path/'state/unproven').touch()
    monkeypatch.setenv('FH_SIM_DEPLOY_GUARD_DIR',str(tmp_path))
    proof=Mock(side_effect=ValueError('unknown')) if fault == 'live' else Mock(return_value={})
    monkeypatch.setattr(recovery,'local_absence',proof)
    async def run():
        mgr=Manager(settings()); mgr.starting=object() if fault == 'starting' else None
        mgr.expiring=fault == 'expiring'
        mgr.closing=fault == 'closing'
        with pytest.raises((SimError,ValueError)): await mgr.prepare_retained_shutdown()
        assert mgr.closing == (fault == 'closing') and not mgr.retained_shutdown
    asyncio.run(run())


def test_endpoint_still_requires_service_authentication(tmp_path, monkeypatch):
    cfg=settings(); app=create_app(cfg)
    with TestClient(app, client=('127.0.0.1',9438)) as client:
        assert client.post('/v1/recovery/retain-stop').status_code == 401
        assert client.post('/v1/recovery/retain-stop',headers={'Authorization':'Bearer '+cfg.secret}).status_code == 409


@pytest.fixture
def evidence():
    binding=dict(partition='fh-srv-123456abcdef',domain='93')
    manifest=dict(counts=dict(ticks=0,policy_calls=0),partition=binding['partition'],ros_domain='93',
        native_target_publications=dict(complete=True,attempts=0,count=0,first_monotonic_ns=None,last_monotonic_ns=None))
    agent=dict(complete=True,rosnode_created=False,**binding)
    observations=dict(complete=True,cmd=0,resume=0,**binding)
    return manifest,agent,observations


def test_audit_reads_without_modifying_inputs(tmp_path,evidence):
    for name,data in zip(('manifest.json','agent-startup.json','command-observations.json'),evidence):
        (tmp_path/name).write_text(json.dumps(data))
    before={p.name:p.read_bytes() for p in tmp_path.iterdir()}
    assert recovery.audit(tmp_path)==dict(classification='pre-start-abort',stop_zero_substitute=True,native_target='zero')
    assert {p.name:p.read_bytes() for p in tmp_path.iterdir()} == before


@pytest.mark.parametrize('field', ['ticks','policy_calls','rosnode_created','cmd','resume','missing-agent',
                                  'incomplete-observer','partition','domain','bool-counter'])
def test_audit_cannot_infer_zero_from_missing_or_positive_evidence(evidence,field):
    manifest,agent,obs=deepcopy(evidence)
    if field in ('ticks','policy_calls'): manifest['counts'][field]=1
    elif field=='rosnode_created': agent[field]=True
    elif field in ('cmd','resume'): obs[field]=1
    elif field=='missing-agent': agent.clear()
    elif field=='incomplete-observer': obs['complete']=False
    elif field=='partition': agent['partition']='fh-srv-other'
    elif field=='domain': obs['domain']='61'
    else: manifest['counts']['ticks']=False
    result=recovery.classify(manifest,agent,obs)
    assert result['classification']=='unproven' and result['stop_zero_substitute'] is False


@pytest.mark.parametrize('field', ['missing','count','attempts','complete','first_monotonic_ns','last_monotonic_ns'])
def test_prestart_agent_is_not_native_target_absence(evidence,field):
    manifest,agent,obs=deepcopy(evidence)
    if field=='missing': manifest.pop('native_target_publications')
    else: manifest['native_target_publications'][field]=False if field=='complete' else 1
    result=recovery.classify(manifest,agent,obs)
    assert result['classification']=='pre-start-abort' and result['stop_zero_substitute'] is False


@pytest.mark.parametrize('row,denied', [({'domain':'93','partition':'','cgroup':''},0),
    ({'domain':'','partition':'fh-srv-123','cgroup':''},0),
    ({'domain':'','partition':'','cgroup':'0::/fh-simmgr-observer-a.service'},0),
    ({'domain':'','partition':'','cgroup':''},1)])
def test_absence_refuses_every_runtime_identity_and_denied_rows(row,denied):
    with pytest.raises(ValueError): recovery.absence(lambda:([row],denied),Mock(),Mock())


@pytest.mark.parametrize('port',[9433,30650,30700,30899])
def test_absence_rejects_tcp_udp_and_ipv6_port(port):
    with pytest.raises(ValueError): recovery.absence(lambda:([],0),lambda *args:'',
        lambda:f'udp UNCONN 0 0 [::]:{port} [::]:*')


def test_target_attempt_before_tick_and_exception_recorded_in_manifest():
    source='''
class Sim:
    def send(self, seq, tgt):
        self.pub.publish(tgt)
def main():
    man = {}
    def save():
        return man
    sim = Sim()
    sim.pub = publisher
    sim.send(0, 'default-joints-before-first-tick')
    return save()
'''
    publisher=Mock(); ns=dict(publisher=publisher,**scope())
    exec(compile_runtime(source,'synthetic-native'),ns)
    result=ns['main']()['native_target_publications']
    assert result['attempts']==result['count']==1 and result['complete'] is True
    assert result['first_monotonic_ns']==result['last_monotonic_ns']
    publisher.publish.assert_called_once_with('default-joints-before-first-tick')
    recorder=Publications(); publisher.publish.side_effect=ValueError('transport unavailable')
    with pytest.raises(ValueError): recorder.publish(publisher,'target')
    assert recorder.value['attempts']==1 and recorder.value['count']==0 and recorder.value['complete'] is False


def test_target_changed_hook_refuses_execution():
    with pytest.raises(ValueError): compile_runtime('class Sim:\n    def send(self): pass','broken')


def test_startup_import_interrupted_is_complete_without_rosnode(tmp_path):
    with pytest.raises(KeyboardInterrupt):
        with startup_evidence.monitor(tmp_path): raise KeyboardInterrupt
    data=json.loads((tmp_path/'agent-startup.json').read_text())
    assert data['complete'] is True and data['rosnode_created'] is False
    assert (tmp_path/'agent-startup.json').stat().st_mode&0o777==0o600


def test_startup_constructor_entry_is_conservatively_created(tmp_path):
    ns={}; exec(compile('class RosNode:\n def __init__(self): pass','/synthetic/ros_bridge/node.py','exec'),ns)
    with startup_evidence.monitor(tmp_path): ns['RosNode']()
    assert json.loads((tmp_path/'agent-startup.json').read_text())['rosnode_created'] is True


@pytest.mark.parametrize('contents', ['populated 1\n', 'frozen 0\n', 'invalid'])
def test_populated_or_unknown_cgroup_refuses(tmp_path, monkeypatch, contents):
    monkeypatch.setattr(recovery,'CGROUP',tmp_path)
    (tmp_path/'owned').mkdir(); (tmp_path/'owned/cgroup.events').write_text(contents)
    with pytest.raises(ValueError): recovery.empty_cgroup('/owned')
    with pytest.raises(ValueError): recovery.empty_cgroup('/../outside')


def test_empty_and_removed_cgroups_are_distinct_from_unknown(tmp_path, monkeypatch):
    monkeypatch.setattr(recovery,'CGROUP',tmp_path)
    (tmp_path/'owned').mkdir(); (tmp_path/'owned/cgroup.events').write_text('populated 0\nfrozen 0\n')
    recovery.empty_cgroup('/owned'); recovery.empty_cgroup('/already-removed')


def test_prepare_waits_for_independent_watcher_before_proving_absence(tmp_path,monkeypatch):
    (tmp_path/'state').mkdir(); (tmp_path/'state/unproven').touch()
    monkeypatch.setenv('FH_SIM_DEPLOY_GUARD_DIR',str(tmp_path))
    proof=Mock(return_value={}); monkeypatch.setattr(recovery,'local_absence',proof)
    async def run():
        mgr=Manager(settings()); mgr.launcher.lifecycle_lock=asyncio.Lock(); mgr.launcher._watching=True
        await mgr.launcher.lifecycle_lock.acquire()
        task=asyncio.create_task(mgr.prepare_retained_shutdown())
        await asyncio.sleep(0)
        proof.assert_not_called(); assert not mgr.closing
        mgr.launcher.lifecycle_lock.release()
        await task
        assert not mgr.launcher._watching and mgr.closing
        await mgr.close()
    asyncio.run(run())


def test_recorded_bootstrap_keeps_private_proof_and_writes_startup(tmp_path,monkeypatch):
    import runpy
    import sys
    from apps.simmgr.agent_entry import recorded_bootstrap
    proof=dict(identity={'synthetic':True})
    monkeypatch.setattr(sys,'argv',['bootstrap','/synthetic',json.dumps(proof)])
    monkeypatch.setattr(sys,'path',sys.path.copy())
    called=Mock(); monkeypatch.setattr(runpy,'run_module',called)
    exec(recorded_bootstrap(tmp_path),{})
    assert called.call_args.kwargs['init_globals']=={'_simmgr_launch_proof':proof}
    data=json.loads((tmp_path/'agent-startup.json').read_text())
    assert data['complete'] is True and data['rosnode_created'] is False


def test_missing_events_in_existing_cgroup_is_unknown(tmp_path,monkeypatch):
    monkeypatch.setattr(recovery,'CGROUP',tmp_path); (tmp_path/'owned').mkdir()
    with pytest.raises(ValueError,match='events unavailable'): recovery.empty_cgroup('/owned')


def test_missing_unit_cgroup_field_is_unknown():
    def ctl(*args):
        if args[0]=='list-units': return 'fh-simmgr-agent-owned.service loaded active exited'
        return 'LoadState=loaded\nActiveState=active\nSubState=exited\nMainPID=0\n'
    with pytest.raises(ValueError): recovery.absence(lambda:([],0),ctl,lambda:'')


def test_missing_target_timestamps_are_not_null_zero_evidence(evidence):
    manifest,agent,obs=deepcopy(evidence)
    manifest['native_target_publications'].pop('first_monotonic_ns')
    assert recovery.classify(manifest,agent,obs)['stop_zero_substitute'] is False


def test_lost_startup_tracking_cannot_claim_complete_absence(tmp_path):
    import sys
    with startup_evidence.monitor(tmp_path): sys.setprofile(None)
    assert json.loads((tmp_path/'agent-startup.json').read_text())['complete'] is False

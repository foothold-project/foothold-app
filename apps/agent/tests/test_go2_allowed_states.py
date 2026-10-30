"""Confirmed V2 sport states require matching marker+env and server source."""
import importlib.util
import json
from pathlib import Path

import pytest

from foothold_agent.go2_direct.approval import validate,parse_codes
from foothold_agent.go2_direct.config import Config
from foothold_agent.go2_direct.feedback import Feedback
from test_go2_runtime_config import env
from test_go2_feedback import fixture,low,sport


def server_env(env):
    return {**env,'FOOTHOLD_AGENT_WS_URL':'wss://server.invalid/api/v1/agent/ws',
            'FOOTHOLD_AGENT_TOKEN':'fake-token'}


@pytest.mark.parametrize('accepted,code,ready',[((),100,False),((100,),100,True),((100,),101,False),
    ((),0,True),((100,),0,True)])
def test_only_confirmed_server_states_pass_readiness(accepted,code,ready):
    now,sink,old_feedback,hub,states=fixture()
    sink.select_source('server')
    feedback=Feedback('1234-5678',now=now,accept_error_codes=accepted);feedback.sink=sink
    feedback.lowstate(low());feedback.sportmodestate(sport(error_code=code))
    assert feedback.consume(hub) is ready
    assert states[-1]['policy_running'] is ready and states[-1]['stop_requested'] is ready


def test_phone_source_does_not_accept_server_only_state_list():
    now,sink,old_feedback,hub,states=fixture()
    feedback=Feedback('1234-5678',now=now,accept_error_codes=(100,));feedback.sink=sink
    feedback.lowstate(low());feedback.sportmodestate(sport(error_code=100))
    assert not feedback.consume(hub) and not states[-1]['stop_requested']


@pytest.mark.parametrize('marker_codes,env_codes,allowed',[([], '',True),([100],'100',True),
    ([100],'',False),([], '100',False),([100],'101',False),([100,101],'101,100',True)])
def test_marker_and_server_environment_must_match(env,marker_codes,env_codes,allowed):
    path=Path(env['FH_GO2_FIELD_APPROVAL']);value=json.loads(path.read_text())
    value['accept_error_codes']=marker_codes;path.write_text(json.dumps(value))
    changed={**server_env(env),'FH_GO2_ACCEPT_ERROR_CODES':env_codes}
    if allowed:
        config=Config.from_env(changed,server=True)
        assert config.approval.accept_error_codes==frozenset(marker_codes)
    else:
        with pytest.raises(PermissionError):Config.from_env(changed,server=True)


def test_server_state_environment_does_not_change_phone_configuration(env):
    config=Config.from_env({**env,'FH_GO2_ACCEPT_ERROR_CODES':'100'})
    try:assert not config.server and config.approval.accept_error_codes==frozenset()
    finally:config.verifier.close()


@pytest.mark.parametrize('bad',['true','-1','1.0','0100','4294967296','100,','100,100'])
def test_state_environment_is_explicit_uint32_list(bad):
    with pytest.raises(ValueError):parse_codes(bad)


@pytest.mark.parametrize('bad',[[True],[100.0],['100'],[100,100],[-1],[4294967296]])
def test_marker_state_numbers_are_strict(env,bad):
    path=Path(env['FH_GO2_FIELD_APPROVAL']);value=json.loads(path.read_text())
    value['accept_error_codes']=bad;path.write_text(json.dumps(value))
    with pytest.raises(PermissionError):validate(env)


def test_marker_generator_can_record_confirmed_state_list(tmp_path):
    path=Path('deploy/jetson/make_approval.py').resolve()
    spec=importlib.util.spec_from_file_location('make_approval_add3',path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    target=tmp_path/'marker.json'
    assert module.main(['--output',str(target),'--nic','fake0','--serial-unavailable',
        '--robot-mac','02:00:00:00:00:01','--accept-error-codes','100','--approve-field-motion'])==0
    assert json.loads(target.read_text())['accept_error_codes']==[100]


@pytest.mark.parametrize('changes',[dict(mode=7),dict(body_height=.1),dict(progress=1),dict(velocity=(.4,0,0))])
def test_confirmed_state_does_not_bypass_other_stop_evidence(changes):
    now,sink,old_feedback,hub,states=fixture();sink.select_source('server')
    feedback=Feedback('1234-5678',now=now,accept_error_codes=(100,));feedback.sink=sink
    feedback.lowstate(low());feedback.sportmodestate(sport(error_code=100,**changes))
    feedback.consume(hub)
    assert states[-1]['stop_requested'] is False and sink._confirmed_generation is None

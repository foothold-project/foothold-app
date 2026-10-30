"""Configuration failures must precede any SDK import, socket, or robot I/O."""
import base64
import builtins
import json
import time
from uuid import uuid4

import pytest

from foothold_agent.go2_direct.config import Config


@pytest.fixture
def env(tmp_path):
    marker = tmp_path/'approval.json'
    marker.write_text(json.dumps(dict(v=1, purpose='go2-field-motion', nic='fake0',
                                     robot_serial='1234-5678', expires_at=time.time()+600)))
    marker.chmod(0o600)
    key = tmp_path/'keys.json'
    key.write_text(json.dumps({'test': base64.urlsafe_b64encode(b'x'*32).rstrip(b'=').decode()}))
    key.chmod(0o600)
    return dict(FH_GO2_DIRECT_ENABLED='1', FH_GO2_DIRECT_NIC='fake0', FH_GO2_DEDICATED_NIC='1',
                FH_GO2_FIELD_APPROVAL=str(marker), FOOTHOLD_ROBOT_ID=str(uuid4()),
                FOOTHOLD_PHONE_HOST='127.0.0.1', FOOTHOLD_PHONE_PORT='9530',
                FOOTHOLD_PHONE_KEY_PATH=str(key), FOOTHOLD_PHONE_POLICY_NAME='go2-flat',
                FOOTHOLD_PHONE_POLICY_VERSION='1', FOOTHOLD_PHONE_ORG_ID=str(uuid4()),
                FOOTHOLD_PHONE_REPLAY_DB=str(tmp_path/'replay.sqlite'),
                FOOTHOLD_PHONE_CLOCK_TRUSTED='1', FOOTHOLD_PHONE_SIMULATION='0')


@pytest.fixture(autouse=True)
def no_sdk(monkeypatch):
    original = builtins.__import__
    def guarded(name, *args, **kwargs):
        assert not name.startswith(('unitree', 'cyclonedds', 'rclpy'))
        return original(name, *args, **kwargs)
    monkeypatch.setattr(builtins, '__import__', guarded)


def test_disabled_and_missing_marker_are_closed():
    with pytest.raises(PermissionError):
        Config.from_env({})


def test_physical_phone_config_without_cloud_credentials_is_local_only(env):
    config = Config.from_env(env)
    try:
        assert config.link is None and config.phone.simulation is False
        assert config.verifier.robot == env['FOOTHOLD_ROBOT_ID']
    finally:
        config.verifier.close()


@pytest.mark.parametrize('change', [dict(FOOTHOLD_PHONE_SIMULATION='1'),
    dict(FH_GO2_DEDICATED_NIC='0'), dict(FOOTHOLD_PHONE_HOST='0.0.0.0'),
    dict(FOOTHOLD_AGENT_WS_URL='wss://server.invalid/ws'),
    dict(FOOTHOLD_AGENT_TOKEN='fake-token'), dict(FOOTHOLD_ROBOT_ID='invalid'),
    dict(FOOTHOLD_PHONE_CLOCK_TRUSTED='0')])
def test_incomplete_or_simulation_configuration_fails(env, change):
    with pytest.raises(ValueError):
        Config.from_env({**env, **change})


def test_cloud_opt_in_does_not_expose_credentials_in_repr(env):
    config = Config.from_env({**env, 'FOOTHOLD_AGENT_WS_URL': 'wss://server.invalid/ws',
                            'FOOTHOLD_AGENT_TOKEN': 'fake-test-token'})
    try:
        assert config.link is not None
        assert 'fake-test-token' not in repr(config) and 'server.invalid' not in repr(config)
    finally:
        config.verifier.close()

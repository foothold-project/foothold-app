"""Entry script: .env from the example, free-port check, private account file."""
import importlib.util
from pathlib import Path
import shutil
import hashlib
import socket
import stat

import pytest
from sqlalchemy.engine import make_url

from docker import seed, server


REPOSITORY = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('local_up', REPOSITORY / 'tools/local_up.py')
local_up = importlib.util.module_from_spec(spec)
spec.loader.exec_module(local_up)


@pytest.fixture
def checkout(tmp_path, monkeypatch):
    root = tmp_path / 'checkout'
    root.mkdir()
    shutil.copyfile(REPOSITORY / '.env.example', root / '.env.example')
    for key in (*seed.secret_keys(), 'FH_API_PORT', 'FH_WEB_PORT', 'FH_DB_PORT'):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv('FH_SIM_ASSETS', str(assets(tmp_path / 'sim-assets')))
    return root


def assets(folder):
    """A synthetic asset folder in the same shape: files plus SHA256SUMS."""
    (folder / 'ort').mkdir(parents=True)
    files = {'policy_v2.onnx': b'synthetic-policy', 'ort/ort.wasm.min.mjs': b'synthetic-ort'}
    lines = []
    for name, data in files.items():
        (folder / name).write_bytes(data)
        lines.append(f'{hashlib.sha256(data).hexdigest()}  ./{name}')
    (folder / 'SHA256SUMS').write_text('\n'.join(lines) + '\n')
    return folder


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def test_prepare_creates_env_and_private_accounts(checkout, tmp_path, capsys):
    secrets_file = tmp_path / 'private' / 'accounts.env'
    values, passwords = local_up.prepare(checkout, secrets_file, docker=True, check=False)
    # The script supplies seed passwords, so its .env turns seeding on; the example keeps it off.
    assert (checkout / '.env').read_text() == (checkout / '.env.example').read_text().replace(
        '\nFH_SEED=0\n', '\nFH_SEED=1\n')
    assert values['FH_SEED'] == '1'
    assert values['FH_WS_ORIGIN'] == 'http://localhost:' + values['FH_WEB_PORT']
    assert stat.S_IMODE(secrets_file.stat().st_mode) == 0o600
    assert set(passwords) == set(seed.secret_keys()) and all(passwords.values())
    # Second run keeps an edited .env and the same passwords.
    (checkout / '.env').write_text((checkout / '.env').read_text().replace('FH_API_PORT=8810', 'FH_API_PORT=18895'))
    again, same = local_up.prepare(checkout, secrets_file, docker=True, check=False)
    assert again['FH_API_PORT'] == '18895' and same == passwords
    out = capsys.readouterr()
    assert not any(value in out.out + out.err for value in passwords.values())


def test_busy_port_refused_before_anything_starts(checkout, tmp_path, monkeypatch):
    with socket.socket() as busy:
        busy.bind(('127.0.0.1', 0))
        busy.listen()
        monkeypatch.setenv('FH_API_PORT', str(busy.getsockname()[1]))
        with pytest.raises(SystemExit, match=f'FH_API_PORT={busy.getsockname()[1]}'):
            local_up.prepare(checkout, tmp_path / 'accounts.env', docker=False)
    assert not (tmp_path / 'accounts.env').exists()


def test_time_wait_port_counts_as_free(checkout):
    with socket.socket() as listener:
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind(('127.0.0.1', 0))
        listener.listen()
        port = listener.getsockname()[1]
        client = socket.create_connection(('127.0.0.1', port))
        accepted, _ = listener.accept()
        accepted.close()  # server side closes first and holds TIME_WAIT
        client.close()
    assert local_up.port_free(port)


def test_free_ports_pass(checkout, tmp_path, monkeypatch):
    for key in ('FH_API_PORT', 'FH_DB_PORT', 'FH_WEB_PORT'):
        monkeypatch.setenv(key, str(free_port()))
    values, _ = local_up.prepare(checkout, tmp_path / 'accounts.env', docker=False)
    assert values['FH_API_PORT'] == local_up.os.environ['FH_API_PORT']


def test_no_docker_server_environment_passes_server_guard(checkout, tmp_path, monkeypatch):
    values, passwords = local_up.prepare(checkout, tmp_path / 'accounts.env', docker=False, check=False)
    env = local_up.server_env(values, passwords, tmp_path / 'data')
    url = make_url(env['FH_DATABASE_URL'])
    assert (url.host, url.port) == ('127.0.0.1', int(values['FH_DB_PORT']))
    assert env['FH_PORT'] == values['FH_API_PORT'] and env['FH_API_HOST'] == '127.0.0.1'
    assert env['FH_ROBOT_INSTALLER_ENABLED'] == env['FH_SERVER_DRIVE_ENABLED'] == '0'
    assert not {'FH_SIM_MANAGER_URL', 'FH_SIM_AUTH_FILE', 'FH_PHONE_PASS_KEYS'} & set(env)
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    server.configuration()


def fill_env(checkout, **filled):
    text = (checkout / '.env.example').read_text()
    for key, value in filled.items():
        text = text.replace(f'\n{key}=\n', f'\n{key}={value}\n')
    (checkout / '.env').write_text(text)


def test_env_passwords_win_on_every_path(checkout, tmp_path):
    filled = {'FH_DB_PASSWORD': 'synthetic-env-db', 'FH_SEED_PASSWORD_LOCAL_OPERATOR': 'synthetic-env-op'}
    fill_env(checkout, **filled)
    secrets_file = tmp_path / 'accounts.env'
    # (1) the account file never shadows a filled .env value
    values, passwords = local_up.prepare(checkout, secrets_file, docker=True, check=False)
    assert {key: passwords[key] for key in filled} == filled
    assert passwords['FH_BOOTSTRAP_PASSWORD'] and passwords['FH_BOOTSTRAP_PASSWORD'] not in filled.values()
    assert not set(filled) & set(seed.read_secrets(secrets_file))
    # (2) --docker: Compose reads only .env; the shell environment carries the same resolved values
    command, env = local_up.compose(checkout, passwords, values)
    assert command.count('--env-file') == 1 and str(secrets_file) not in command
    assert {key: env[key] for key in passwords} == passwords
    # (3) --no-docker: the server sees the .env values
    env = local_up.server_env(values, passwords, tmp_path / 'data')
    assert {key: env[key] for key in filled} == filled


def test_generated_value_used_only_for_blank_env_keys(checkout, tmp_path):
    fill_env(checkout)
    _, passwords = local_up.prepare(checkout, tmp_path / 'accounts.env', docker=True, check=False)
    assert seed.read_secrets(tmp_path / 'accounts.env') == passwords


def test_sim_assets_missing_or_blank_stops_with_guidance(checkout, tmp_path, monkeypatch):
    for value in ('', str(tmp_path / 'absent')):
        monkeypatch.setenv('FH_SIM_ASSETS', value)
        with pytest.raises(SystemExit, match='FH_SIM_ASSETS') as error:
            local_up.prepare(checkout, tmp_path / 'accounts.env', docker=True, check=False)
        assert 'SHA256SUMS' in str(error.value) and 'http' not in str(error.value)
    assert not (tmp_path / 'accounts.env').exists()


@pytest.mark.parametrize('damage', ['changed', 'removed', 'no_sums', 'escape'])
def test_sim_assets_hash_mismatch_stops(checkout, tmp_path, monkeypatch, damage):
    folder = assets(tmp_path / 'other-assets')
    if damage == 'changed':
        (folder / 'policy_v2.onnx').write_bytes(b'tampered')
    elif damage == 'removed':
        (folder / 'ort/ort.wasm.min.mjs').unlink()
    elif damage == 'no_sums':
        (folder / 'SHA256SUMS').unlink()
    else:
        (tmp_path / 'outside').write_bytes(b'x')
        with (folder / 'SHA256SUMS').open('a') as sums:
            sums.write(hashlib.sha256(b'x').hexdigest() + '  ../outside\n')
    monkeypatch.setenv('FH_SIM_ASSETS', str(folder))
    with pytest.raises(SystemExit, match='시뮬 자산'):
        local_up.prepare(checkout, tmp_path / 'accounts.env', docker=True, check=False)


def test_sim_assets_place_from_env_over_env_file(checkout, tmp_path, monkeypatch):
    good = assets(tmp_path / 'chosen')
    fill_env(checkout, FH_SIM_ASSETS=str(tmp_path / 'absent'))
    with pytest.raises(SystemExit, match='FH_SIM_ASSETS'):
        monkeypatch.delenv('FH_SIM_ASSETS')
        local_up.prepare(checkout, tmp_path / 'accounts.env', docker=True, check=False)
    monkeypatch.setenv('FH_SIM_ASSETS', str(good))
    values, passwords = local_up.prepare(checkout, tmp_path / 'accounts.env', docker=True, check=False)
    assert values['FH_SIM_ASSETS'] == str(good)
    command, env = local_up.compose(checkout, passwords, values)
    assert env['FH_SIM_ASSETS'] == str(good)


def test_no_docker_does_not_need_sim_assets(checkout, tmp_path, monkeypatch):
    monkeypatch.setenv('FH_SIM_ASSETS', '')
    local_up.prepare(checkout, tmp_path / 'accounts.env', docker=False, check=False)


# --sim mujoco: simmgr with the local MuJoCo backend (#594). Code and wiring only here.
import json
import subprocess
import sys
from uuid import UUID


def sim_checkout(checkout):
    (checkout / 'apps/simmgr').mkdir(parents=True)
    (checkout / 'apps/simmgr/mujoco_launcher.py').write_text('# stands in for #594\n')
    return checkout


def test_sim_off_by_default(checkout, tmp_path):
    values, passwords = local_up.prepare(checkout, tmp_path / 'accounts.env', docker=False, check=False)
    env = local_up.server_env(values, passwords, tmp_path / 'data')
    assert not {'FH_SIM_MANAGER_URL', 'FH_SIM_AUTH_FILE', 'FH_PHONE_PASS_KEYS', 'FH_SIM_LOCAL_BACKEND'} & set(env)


def test_sim_mujoco_needs_no_docker(monkeypatch):
    with pytest.raises(SystemExit, match='--no-docker'):
        local_up.main(['--sim', 'mujoco'])
    with pytest.raises(SystemExit, match='--no-docker'):
        local_up.main(['--docker', '--sim', 'mujoco'])


def test_sim_mujoco_needs_backend_from_594(checkout, tmp_path):
    values, _ = local_up.prepare(checkout, tmp_path / 'accounts.env', docker=False, check=False)
    with pytest.raises(SystemExit, match='#594'):
        local_up.sim_setup(checkout, values, tmp_path / 'data')


def test_sim_files_private_stable_and_slot_is_seed_robot(checkout, tmp_path, monkeypatch):
    sim_checkout(checkout)
    values, passwords = local_up.prepare(checkout, tmp_path / 'accounts.env', docker=False, check=False)
    data = tmp_path / 'data'
    sim = local_up.sim_setup(checkout, values, data)
    for key in ('FH_SIM_AUTH_FILE', 'FH_PHONE_PASS_KEYS', 'FH_SIM_CATALOG'):
        assert stat.S_IMODE(Path(sim[key]).stat().st_mode) == 0o600, key
    key = Path(sim['FH_SIM_AUTH_FILE']).read_text()
    assert local_up.sim_setup(checkout, values, data) == sim
    assert Path(sim['FH_SIM_AUTH_FILE']).read_text() == key  # not rotated on rerun
    catalog = json.loads(Path(sim['FH_SIM_CATALOG']).read_text())
    robot = str(seed.sim_robot_id(UUID(values['FH_ORG_ID'])))
    assert [s['robot_id'] for s in catalog['slots']] == [robot]
    assert catalog['slots'][0]['org_id'] == values['FH_ORG_ID']
    assert [w['id'] for w in catalog['worlds']] == ['collapsed-house-v2']
    assert set(json.loads(Path(sim['FH_PHONE_PASS_KEYS']).read_text())) == {robot}

    manager = local_up.simmgr_env(checkout, values, sim)
    assert manager['FH_SIM_LOCAL_BACKEND'] == 'mujoco'
    assert manager['FH_SIM_SRC'] == values['FH_SIM_ASSETS']  # default: the checked asset folder
    assert manager['FH_SIM_AGENT_WS_URL'] == f"ws://127.0.0.1:{values['FH_API_PORT']}/api/v1/agent/ws"
    assert manager['FH_SIM_AUTH_FILE'] == sim['FH_SIM_AUTH_FILE']
    assert values['FH_API_PORT'] in manager['FH_SIM_EXTRA_PORTS'].split(',')
    # Database and account secrets never reach the simulator.
    assert not {'FH_DATABASE_URL', *seed.secret_keys()} & set(manager)
    assert not any(k.startswith(('ROS_', 'RMW_')) or k == 'FH_SIM_RUN' for k in manager)

    env = local_up.server_env(values, passwords, data, sim)
    assert env['FH_SIM_MANAGER_URL'] == f"http://127.0.0.1:{values['FH_SIM_PORT']}"
    assert env['FH_SIM_AUTH_FILE'] == sim['FH_SIM_AUTH_FILE']
    assert env['FH_PHONE_PASS_KEYS'] == sim['FH_PHONE_PASS_KEYS']
    from apps.server.fh_server.simulation import Relay
    monkeypatch.setenv('FH_SIM_EXTRA_PORTS', env['FH_SIM_EXTRA_PORTS'])
    Relay(env['FH_SIM_MANAGER_URL'], env['FH_SIM_AUTH_FILE'])  # the server accepts this URL and key file


def test_sim_source_from_env(checkout, tmp_path, monkeypatch):
    sim_checkout(checkout)
    source = tmp_path / 'mujoco-src'
    source.mkdir()
    monkeypatch.setenv('FH_SIM_SRC', str(source))
    values, _ = local_up.prepare(checkout, tmp_path / 'accounts.env', docker=False, check=False)
    sim = local_up.sim_setup(checkout, values, tmp_path / 'data')
    assert local_up.simmgr_env(checkout, values, sim)['FH_SIM_SRC'] == str(source)
    monkeypatch.setenv('FH_SIM_SRC', str(tmp_path / 'absent'))
    values, _ = local_up.prepare(checkout, tmp_path / 'accounts.env', docker=False, check=False)
    with pytest.raises(SystemExit, match='FH_SIM_SRC'):
        local_up.sim_setup(checkout, values, tmp_path / 'data')


def test_sim_port_busy_refused(checkout, tmp_path, monkeypatch):
    with socket.socket() as busy:
        busy.bind(('127.0.0.1', 0))
        busy.listen()
        monkeypatch.setenv('FH_SIM_PORT', str(busy.getsockname()[1]))
        with pytest.raises(SystemExit, match='FH_SIM_PORT'):
            local_up.prepare(checkout, tmp_path / 'accounts.env', docker=False, check=True, sim=True,
                             db_running=True)


def test_stop_ends_only_our_simmgr(tmp_path):
    pidfile = tmp_path / 'simmgr.pid'
    ours = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)', 'apps.simmgr'])
    other = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])
    try:
        pidfile.write_text(str(ours.pid))
        local_up.stop_simmgr(pidfile)
        assert ours.wait(timeout=5) is not None and not pidfile.exists()
        pidfile.write_text(str(other.pid))  # a reused pid that is not simmgr
        local_up.stop_simmgr(pidfile)
        assert other.poll() is None and not pidfile.exists()
        local_up.stop_simmgr(pidfile)  # nothing recorded: no error
    finally:
        for proc in (ours, other):
            if proc.poll() is None:
                proc.kill()
                proc.wait()

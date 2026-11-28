"""Entry script: .env from the example, free-port check, private account file."""
import importlib.util
from pathlib import Path
import shutil
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
    return root


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def test_prepare_creates_env_and_private_accounts(checkout, tmp_path, capsys):
    secrets_file = tmp_path / 'private' / 'accounts.env'
    values, passwords = local_up.prepare(checkout, secrets_file, docker=True, check=False)
    assert (checkout / '.env').read_text() == (checkout / '.env.example').read_text()
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

"""Installer routes use existing tenant authentication and fixed stored paths."""
from datetime import timedelta
import hashlib
from pathlib import Path
from types import SimpleNamespace
from typing import Annotated

from fastapi import Depends, FastAPI
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session as DBSession

from apps.contracts import models as C
from apps.server.fh_server.api import APIError, authorize, fail
from apps.server.fh_server import robot_installer as R, robot_installer_api
from apps.server.fh_server.models import Session, User, now
from apps.server.fh_server.security import digest
from .conftest import login

P = '/api/v1/robot-installer'
SHA = '1' * 40


def artifact(root, tmp_path, commit=SHA, payload=b'fake deb', platform='linux'):
    root.mkdir(parents=True, exist_ok=True)
    source = tmp_path / 'fake.deb'
    source.write_bytes(payload)
    version = '0.2.0+' + commit[:12]
    info = dict(platform=platform, available=True, version=version, size=len(payload),
                filename=R.BUILDERS[platform].filename.format(version=version),
                sha256=hashlib.sha256(payload).hexdigest(),
                built_at='2026-11-12T00:00:00+00:00', commit=commit)
    R.publish(root, source, info, 'unchanged')
    return info


@pytest.fixture
def installer(client, tmp_path):
    manager = client.app.state.robot_installer
    manager.root = tmp_path / 'fixed-store'
    manager.commit = None  # no subprocesses from API fixture
    return manager


@pytest.mark.parametrize('suffix', ['/info', '/linux', '/windows'])
def test_auth_required_and_foreign_session_denied(client, seeded, installer, suffix):
    assert client.get(P + suffix).status_code == 401
    engine = create_engine(seeded['urls']['migrate'])
    with DBSession(engine) as db:
        user = db.get(User, seeded['users']['foreign'])
        db.add(Session(org_id=user.org_id, user_id=user.id, client='app',
                       token_hash=digest('foreign-installer-session'),
                       expires_at=now() + timedelta(minutes=5)))
        db.commit()
    engine.dispose()
    response = client.get(P + suffix, headers={'Authorization': 'Bearer foreign-installer-session'})
    assert response.status_code == 401


@pytest.mark.parametrize('user', ['admin', 'one'])
def test_allowed_roles_missing_file_and_windows(client, installer, user):
    assert login(client, user).status_code == 200
    response = client.get(P + '/info')
    assert response.status_code == 200
    assert response.headers['cache-control'] == 'private, no-store'
    C.RobotInstallerInfo.model_validate(response.json())
    assert response.json() == {'items': [
        {'platform': 'linux', 'available': False, 'reason': 'not_built'},
        {'platform': 'windows', 'available': False, 'reason': 'not_built'}]}
    assert client.get(P + '/linux').status_code == 404
    assert client.get(P + '/windows').json()['error']['detail']['reason'] == 'not_built'


def test_download_fixed_path_headers_and_metadata(client, installer, tmp_path):
    info = artifact(installer.root / 'linux', tmp_path)
    assert login(client).status_code == 200
    response = client.get(P + '/info')
    C.RobotInstallerInfo.model_validate(response.json())
    assert response.json()['items'][0] == {**info, 'built_at': '2026-11-12T00:00:00Z'}
    response = client.get(P + '/linux', params={'path': '/etc/passwd', 'filename': '../../private'})
    assert response.status_code == 200 and response.content == b'fake deb'
    assert response.headers['content-disposition'] == f'attachment; filename="{info["filename"]}"'
    assert response.headers['cache-control'] == 'private, no-store'
    assert response.headers['content-length'] == str(info['size'])
    assert client.get(P + '/macos').status_code == 404


@pytest.mark.parametrize('corruption', ['pointer', 'filename', 'size', 'symlink'])
def test_no_arbitrary_paths_or_invalid_artifact(client, installer, tmp_path, corruption):
    base = installer.root / 'linux'
    artifact(base, tmp_path)
    if corruption == 'pointer':
        (base / 'current').unlink()
        (base / 'current').symlink_to(tmp_path)
    elif corruption == 'symlink':
        (base / 'current/installer').unlink()
        (base / 'current/installer').symlink_to('/etc/passwd')
    else:
        data = R.read_json(base / 'current/info.json')
        data['filename' if corruption == 'filename' else 'size'] = ('../../private' if corruption == 'filename' else 100)
        R.atomic_json(base / 'current/info.json', data)
    login(client)
    assert client.get(P + '/info').json()['items'][0]['reason'] == 'invalid_artifact'
    assert client.get(P + '/linux').status_code == 404


def test_disabled_never_serves_or_builds(client, installer, tmp_path):
    artifact(installer.root / 'linux', tmp_path)
    installer.enabled = False
    login(client)
    assert all(x['reason'] == 'disabled' for x in client.get(P + '/info').json()['items'])
    assert client.get(P + '/linux').status_code == 404


@pytest.mark.parametrize('path', ['/info', '/linux', '/windows'])
def test_viewer_denied_at_route_gate(tmp_path, path):
    # VIEWER is intentionally not a DB role; exercise future/invalid roles at
    # the actual download route without relaxing the production DB constraint.
    app = FastAPI()
    @app.exception_handler(APIError)
    async def error(request, exc):
        return JSONResponse({'code': exc.code}, status_code=exc.status)
    def viewer():
        return (SimpleNamespace(role='VIEWER'), None)
    identity = Annotated[tuple, Depends(viewer)]
    settings = SimpleNamespace(files_root=str(tmp_path), ws_origin=None, robot_installer_enabled=True)
    robot_installer_api.install(app, identity, fail, authorize, settings)
    with TestClient(app) as http:
        assert http.get(P + path).status_code == 403
    assert not (tmp_path / 'robot-installer').exists()


def test_snapshot_survives_atomic_replacement_and_only_one_old_copy(tmp_path):
    base = tmp_path / 'linux'
    artifact(base, tmp_path, '1' * 40, b'first')
    meta, stream = R.snapshot(base, 'linux')
    artifact(base, tmp_path, '2' * 40, b'second')
    artifact(base, tmp_path, '3' * 40, b'third')
    try:
        assert stream.read() == b'first'
    finally:
        stream.close()
    assert {p.name for p in (base / 'releases').iterdir()} == {'2' * 40, '3' * 40}
    assert (base / 'previous/installer').read_bytes() == b'second'


def test_windows_download_zip_content_type_filename_hash_and_fixed_path(client, installer, tmp_path):
    info = artifact(installer.root/'windows', tmp_path, payload=b'PK-fake-zip', platform='windows')
    assert login(client).status_code == 200
    state = client.get(P+'/info').json()['items'][1]
    assert state['available'] and state['filename'] == info['filename']
    assert state['filename'].endswith('_windows_amd64.zip')
    response = client.get(P+'/windows', params={'path':'/etc/passwd','filename':'../../private'})
    assert response.status_code == 200 and response.content == b'PK-fake-zip'
    assert response.headers['content-type'] == 'application/zip'
    assert response.headers['content-disposition'] == f'attachment; filename="{info["filename"]}"'
    assert response.headers['content-length'] == str(info['size'])
    assert response.headers['cache-control'] == 'private, no-store'
    assert response.headers['x-content-type-options'] == 'nosniff'
    assert hashlib.sha256(response.content).hexdigest() == state['sha256']

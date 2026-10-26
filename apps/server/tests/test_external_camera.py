"""Temporary PostgreSQL and fake loopback HTTP only; never starts a simulator."""
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from threading import Thread
import time
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest
from sqlalchemy.orm import Session

from apps.server.fh_server import external_camera
from apps.server.fh_server.api import Settings, create_app
from apps.server.fh_server.models import Robot, Session as UserSession, User
from apps.server.fh_server.simulation import Relay
from .conftest import login
from .test_api import csrf


@pytest.fixture
def camera(client, seeded, tmp_path, monkeypatch):
    rid = seeded['robots']['mine']
    with Session(client.app.state.engine) as db:
        row = db.get(Robot, rid)
        row.simulation, row.sim_state, row.sim_generation = True, 'ACTIVE', 1
        db.commit()
    state = dict(calls=[], headers=[], delay=0, error=None, reply=None, on_get=None,
        slot=dict(robot_id=str(rid), owner_id=str(seeded['users']['one']), generation=1,
            world_id='warehouse/f1', simulation=True, state='RUNNING', agent_address='ws://unused',
            namespace='/unused', tf_prefix='unused', command_topic='/unused', launcher='native-single'))

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            state['headers'].append(self.headers.get('Authorization'))
            if state['on_get']:
                state['on_get']()
            self.respond(200, dict(items=[state['slot']] if state['slot'] else []))

        def do_POST(self):
            state['headers'].append(self.headers.get('Authorization'))
            body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            state['calls'].append((self.path, body))
            if state['delay']:
                time.sleep(state['delay'])
            if state['error']:
                status, code = state['error']
                self.respond(status, {'error': {'code': code}})
            else:
                self.respond(200, state['reply'] if state['reply'] is not None else
                    dict(accepted=True, shared=True, seq=body['seq'], operation=self.path.rsplit('/', 1)[1]))

        def respond(self, status, body):
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            try:
                self.wfile.write(json.dumps(body).encode())
            except BrokenPipeError:
                pass  # expected when exercising the bounded client timeout

        def log_message(self, *_):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    secret = tmp_path / 'service-key'
    secret.write_text('fake-test-service-secret-xxxxxxxx')
    secret.chmod(0o600)
    monkeypatch.setenv('FH_SIM_EXTRA_PORTS', str(server.server_port))
    client.app.state.simmgr = Relay(f'http://127.0.0.1:{server.server_port}', secret)
    state['rid'] = rid
    state['body'] = dict(t='external.view', version='observer/1', robot=str(rid),
        episode_id=str(uuid4()), epoch=7, seq=0, yaw=1.2, pitch=.45, radius=3.)
    state['path'] = f'/api/v1/robots/{rid}/external-camera/'
    yield client, state
    client.app.state.simmgr = None
    server.shutdown()
    server.server_close()
    thread.join()


def post(client, state, headers, operation='view', **change):
    return client.post(state['path'] + operation, json={**state['body'], **change}, headers=headers)


def test_cookie_bearer_shared_sequence_and_all_operations(camera, seeded):
    client, state = camera
    headers = csrf(client, 'one')
    first = post(client, state, headers, seq=9007199254740991)
    assert first.status_code == 200, first.text
    assert first.headers['cache-control'] == 'no-store'
    app_login = login(client, 'admin', client='app')
    assert app_login.status_code == 200
    bearer = {'Authorization': 'Bearer ' + app_login.json()['access_token']}
    second = post(client, state, bearer, 'reset')
    assert second.status_code == 200, second.text
    time.sleep(.11)
    third = post(client, state, bearer, 'cancel')
    assert third.status_code == 200, third.text
    seqs = [r.json()['seq'] for r in (first, second, third)]
    assert seqs[0] < seqs[1] < seqs[2] < 9007199254740991
    for (path, body), operation, seq in zip(state['calls'], ('view', 'reset', 'cancel'), seqs):
        assert path == f"/v1/robots/{state['rid']}/external-camera/{operation}"
        assert body == {**state['body'], 'seq': seq}
    assert state['headers'] == ['Bearer fake-test-service-secret-xxxxxxxx'] * 6
    with Session(client.app.state.engine) as db:
        row = db.get(Robot, state['rid'])
        assert row.sim_state == 'ACTIVE' and row.sim_generation == 1


@pytest.mark.parametrize('operation', ['view', 'reset', 'cancel'])
def test_auth_csrf_media_and_robot_tokens_rejected(camera, operation):
    client, state = camera
    assert post(client, state, {}, operation).status_code == 401
    for raw in ('fake-agent-token', 'fake-phone-media-token'):
        assert post(client, state, {'Authorization': 'Bearer ' + raw}, operation).status_code == 401
    csrf(client, 'one')
    assert post(client, state, {}, operation).status_code == 403
    assert not state['headers']


@pytest.mark.parametrize('user', ['two', 'foreign'])
def test_current_owner_and_organization_required(camera, seeded, user):
    client, state = camera
    if user == 'foreign':
        state['path'] = f"/api/v1/robots/{seeded['robots']['foreign']}/external-camera/"
        state['body']['robot'] = str(seeded['robots']['foreign'])
    result = post(client, state, csrf(client, 'one' if user == 'foreign' else user))
    assert result.status_code == 404
    assert not state['headers']


@pytest.mark.parametrize('mutation', ['owner', 'locked', 'archived', 'session'])
def test_auth_and_permission_rechecked_after_manager_get(camera, seeded, mutation):
    client, state = camera
    headers = csrf(client, 'one')
    def revoke():
        with Session(client.app.state.engine) as db:
            if mutation == 'owner':
                db.get(Robot, state['rid']).owner_user_id = seeded['users']['two']
            elif mutation == 'session':
                from apps.server.fh_server.models import now
                for row in db.query(UserSession).filter_by(user_id=seeded['users']['one']):
                    row.revoked_at = now()
            else:
                user = db.get(User, seeded['users']['one'])
                if mutation == 'locked':
                    user.locked = True
                else:
                    from apps.server.fh_server.models import now
                    user.archived_at = now()
            db.commit()
    state['on_get'] = revoke
    assert post(client, state, headers).status_code in (401, 404)
    assert not state['calls']


@pytest.mark.parametrize('field,value', [('state', 'PREPARED'), ('generation', 2),
    ('owner_id', '00000000-0000-0000-0000-000000000001'), ('robot_id', '00000000-0000-0000-0000-000000000001')])
def test_registered_running_slot_required(camera, field, value):
    client, state = camera
    state['slot'][field] = value
    result = post(client, state, csrf(client, 'one'))
    assert result.status_code == 409
    assert not state['calls']


@pytest.mark.parametrize('kind', ['hardware', 'inactive', 'missing', 'binding'])
def test_unavailable_and_binding(camera, kind):
    client, state = camera
    headers = csrf(client, 'one')
    if kind in ('hardware', 'inactive'):
        with Session(client.app.state.engine) as db:
            row = db.get(Robot, state['rid'])
            if kind == 'hardware':
                row.simulation = False
            else:
                row.sim_state = 'IDLE'
            db.commit()
    elif kind == 'missing':
        state['slot'] = None
    result = post(client, state, headers, **({'robot': str(uuid4())} if kind == 'binding' else {}))
    assert result.status_code == 409
    if kind == 'hardware':
        assert result.json()['error']['code'] == 'UNAVAILABLE'
    assert not state['calls']


@pytest.mark.parametrize('change', [{'service': '/evil'}, {'entity': 'robot'}, {'world': 'evil'},
    {'yaw': 4.}, {'pitch': -1.3}, {'radius': 11.}, {'radius': True}, {'epoch': -1},
    {'episode_id': None}, {'seq': -1}, {'robot': 'invalid'}, {'t': 'stop'}])
def test_contract_validation(camera, change):
    client, state = camera
    assert post(client, state, csrf(client, 'one'), **change).status_code == 400
    assert not state['headers']


@pytest.mark.parametrize('padding,status', [(4096, 200), (4097, 413)])
def test_exact_body_limit_including_whitespace(camera, padding, status):
    client, state = camera
    body = json.dumps(state['body']).encode()
    body += b' ' * (padding - len(body))
    result = client.post(state['path'] + 'view', content=body, headers=csrf(client, 'one'))
    assert result.status_code == status


def test_chunked_body_limit(camera):
    client, state = camera
    result = client.post(state['path'] + 'cancel', content=iter([b' ' * 2048, b' ' * 2049]),
        headers=csrf(client, 'one'))
    assert result.status_code == 413
    assert not state['headers']


@pytest.mark.parametrize('status,code', [(409, 'SIM_OBSERVER_UNAVAILABLE'), (409, 'SIM_OBSERVER_BINDING'),
    (503, 'SIM_UNAVAILABLE')])
def test_manager_error_reason_preserved(camera, status, code):
    client, state = camera
    state['error'] = (status, code)
    result = post(client, state, csrf(client, 'one'))
    assert result.status_code == status
    assert result.json()['error']['code'] == code


def test_timeout_and_invalid_acceptance(camera):
    client, state = camera
    headers = csrf(client, 'one')
    state['delay'] = .8
    started = time.monotonic()
    result = post(client, state, headers)
    assert result.status_code == 503
    assert time.monotonic() - started < .75
    state['delay'] = 0
    state['reply'] = dict(accepted=True, shared=True, seq=0, operation='view')
    result = post(client, state, headers)
    assert result.status_code == 503


def test_rate_limit_shared_by_operations_not_users(camera, monkeypatch):
    client, state = camera
    # Freeze only admission's monotonic clock, leaving HTTP timers real.
    clock = type('Clock', (), {'monotonic': staticmethod(lambda: 100.), 'time_ns': staticmethod(time.time_ns)})
    monkeypatch.setattr(external_camera, 'time', clock)
    headers = csrf(client, 'one')
    assert post(client, state, headers).status_code == 200
    for op in ('reset', 'cancel'):
        result = post(client, state, headers, op)
        assert result.status_code == 409
        assert result.json()['error']['code'] == 'SIM_OBSERVER_RATE_LIMIT'
    assert len(state['headers']) == 2  # excess requests never reach the manager
    assert post(client, state, csrf(client, 'admin'), 'cancel').status_code == 200


def test_admission_concurrent_sequences_clock_regression_and_restart(monkeypatch):
    clock = type('Clock', (), {'monotonic': staticmethod(time.monotonic),
        'time_ns': staticmethod(lambda: 1790000000000000000)})
    monkeypatch.setattr(external_camera, 'time', clock)
    admission = external_camera.Admission()
    with ThreadPoolExecutor(max_workers=8) as pool:
        seqs = list(pool.map(lambda user: admission.reserve(user, 'robot'), range(32)))
    assert len(set(seqs)) == 32
    assert min(seqs) == 1790000000000000
    clock.time_ns = staticmethod(lambda: 1780000000000000000)
    assert admission.reserve('new-user', 'robot') == max(seqs) + 1
    clock.time_ns = staticmethod(lambda: 1790000001000000000)
    assert external_camera.Admission().reserve('user', 'robot') > max(seqs)


def test_app_restart_sequence_exceeds_old_view(camera, seeded):
    client, state = camera
    first = post(client, state, csrf(client, 'one'))
    app = create_app(Settings(seeded['urls']['app'], seeded['org']))
    try:
        with TestClient(app, base_url='https://testserver') as other:
            app.state.simmgr = client.app.state.simmgr
            second = post(other, state, csrf(other, 'one'), 'cancel')
            assert second.status_code == 200
            assert second.json()['seq'] > first.json()['seq']
    finally:
        app.state.engine.dispose()


@pytest.mark.parametrize('failure,stage,status,code', [
    ('disabled', 'manager_disabled', 503, 'SIM_DISABLED'),
    ('get_transport', 'slots_transport', 503, 'SIM_UNAVAILABLE'),
    ('slots_invalid', 'slots_response', 503, 'SIM_UNAVAILABLE'),
    ('post_transport', 'command_transport', 503, 'SIM_UNAVAILABLE'),
    ('observer_not_ready', 'command_transport', 409, 'SIM_OBSERVER_UNAVAILABLE'),
    ('acceptance_invalid', 'command_response', 503, 'SIM_UNAVAILABLE'),
])
def test_relay_failure_stage_logged_without_remote_data(camera, monkeypatch, caplog,
                                                       failure, stage, status, code):
    from apps.server.fh_server.simulation import RelayError
    client, state = camera
    relay = client.app.state.simmgr
    request = relay.request
    def fail_at_stage(method, path, body=None, **kwargs):
        if failure == 'get_transport' and method == 'GET':
            raise RelayError()
        if failure == 'slots_invalid' and method == 'GET':
            return {'unexpected': 'private-upstream-value'}
        if failure == 'post_transport' and method == 'POST':
            raise RelayError()
        if failure == 'observer_not_ready' and method == 'POST':
            raise RelayError('SIM_OBSERVER_UNAVAILABLE', 409)
        if failure == 'acceptance_invalid' and method == 'POST':
            return {'accepted': 'private-upstream-value'}
        return request(method, path, body, **kwargs)
    monkeypatch.setattr(relay, 'request', fail_at_stage)
    if failure == 'disabled':
        client.app.state.simmgr = None
    result = post(client, state, csrf(client, 'one'))
    assert result.status_code == status and result.json()['error']['code'] == code
    records = [r.getMessage() for r in caplog.records if r.name == external_camera.__name__]
    assert records == [f'external camera relay stage={stage} status={status} code={code}']
    assert 'private-upstream-value' not in caplog.text
    assert str(state['rid']) not in '\n'.join(records)

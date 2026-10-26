"""Temporary PostgreSQL and fake loopback HTTP only; never starts a simulator."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from threading import Thread
import time
from types import SimpleNamespace
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


def serialized_manager_slots(seeded, monkeypatch, *, native=True):
    """Real listing/describe and FastAPI serialization, without a runtime/lifespan."""
    from apps.simmgr.api import create_app as manager_app
    from apps.simmgr.config import Slot
    from apps.simmgr.launcher import FakeLauncher
    from apps.simmgr.service import Robot as ManagerRobot
    import os

    for name in tuple(os.environ):
        if name.startswith(('ROS_', 'RMW_', 'CYCLONEDDS_', 'FASTRTPS_', 'FASTDDS_')):
            monkeypatch.delenv(name)
    rid, owner, org = map(str, (seeded['robots']['mine'], seeded['users']['one'], seeded['org']))
    launcher = FakeLauncher()
    launcher.real = native  # native response shape, never a NativeLauncher/process
    app = manager_app(SimpleNamespace(real=native, agent_host='127.0.0.1',
        secret='fake-test-service-secret-xxxxxxxx'), launcher)
    app.state.ready = True
    manager = app.state.manager
    manager.robots[rid] = ManagerRobot(Slot(rid, org, 'unused', 'unused', 9608),
        owner, 'warehouse/f1', 'RUNNING', 1)
    manager.expires_at = datetime.now(timezone.utc) + timedelta(seconds=1800)
    manager.deadline = time.monotonic() + 1800
    # No context manager: do not invoke startup_preflight or lifecycle teardown.
    http = TestClient(app, client=('127.0.0.1', 9609))
    try:
        response = http.get('/v1/robots', params={'org_id': org},
            headers={'Authorization': 'Bearer fake-test-service-secret-xxxxxxxx'})
        assert response.status_code == 200, response.text
        assert launcher.events == []
        return response.json()
    finally:
        http.close()


@pytest.fixture
def camera(client, seeded, tmp_path, monkeypatch):
    rid = seeded['robots']['mine']
    with Session(client.app.state.engine) as db:
        row = db.get(Robot, rid)
        row.simulation, row.sim_state, row.sim_generation = True, 'ACTIVE', 1
        db.commit()
    slots = serialized_manager_slots(seeded, monkeypatch)
    state = dict(calls=[], headers=[], delay=0, error=None, reply=None, on_get=None,
        slots=slots, slot=slots['items'][0], get_fault=None)

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            state['headers'].append(self.headers.get('Authorization'))
            if state['on_get']:
                state['on_get']()
            fault = state['get_fault']
            if fault == 'slow_headers':
                time.sleep(.65)
            if fault in ('error_list', 'error_string', 'nested_list', 'nested_string'):
                body = {'error_list': [], 'error_string': 'private-upstream-value-token',
                    'nested_list': {'error': []}, 'nested_string': {'error': 'private-upstream-value-token'}}[fault]
                self.respond(503, body)
                return
            if fault in ('invalid_json', 'partial_json', 'slow_body'):
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                if fault == 'slow_body':
                    time.sleep(.65)
                try:
                    self.wfile.write(b'private-upstream-value-token' if fault == 'invalid_json' else b'{"items":[')
                except BrokenPipeError:
                    pass
                return
            self.respond(200, {**state['slots'], 'items': [state['slot']] if state['slot'] else []})

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


@pytest.mark.parametrize('native', [False, True])
@pytest.mark.parametrize('operation', ['view', 'reset', 'cancel'])
def test_real_manager_serialization_for_list_and_camera(camera, seeded, monkeypatch, native, operation):
    client, state = camera
    state['slots'] = serialized_manager_slots(seeded, monkeypatch, native=native)
    state['slot'] = state['slots']['items'][0]
    assert state['slot']['expires_at'].endswith('Z')
    assert 0 < state['slot']['remaining_s'] <= 1800
    assert state['slot']['launcher'] == ('native-single' if native else 'fake')
    headers = csrf(client, 'one')
    listing = client.get('/api/v1/simulation/robots')
    assert listing.status_code == 200, listing.text
    assert listing.json()['manager_error'] is None
    assert listing.json()['items'] == state['slots']['items']
    result = post(client, state, headers, operation)
    assert result.status_code == 200, result.text
    assert len(state['calls']) == 1


@pytest.mark.parametrize('failure,fields', [
    ('generation', 'items.0.generation:int_parsing'),
    ('timestamp', 'items.0.expires_at:datetime_from_date_parsing'),
    ('extra', 'items.0.<extra>:extra_forbidden'),
    ('root_extra', '<extra>:extra_forbidden'),
    ('type_error', '$:type_error'),
])
def test_slots_validation_diagnostics_without_values(camera, monkeypatch, caplog, failure, fields):
    from apps.contracts import models as C
    client, state = camera
    private = 'private-upstream-value-token'
    if failure == 'generation':
        state['slot']['generation'] = private
    elif failure == 'timestamp':
        state['slot']['expires_at'] = private
    elif failure == 'extra':
        state['slot'][private] = private
    elif failure == 'root_extra':
        state['slots'][private] = private
    else:
        def invalid(cls, value, **kwargs):
            raise TypeError(private)
        monkeypatch.setattr(C.SimRobotList, 'model_validate', classmethod(invalid))
    headers = csrf(client, 'one')
    # A 200 list can mask the same invalid manager response as cleanup-only data.
    listing = client.get('/api/v1/simulation/robots')
    assert listing.status_code == 200
    assert listing.json()['manager_error'] == 'SIM_UNAVAILABLE'
    assert listing.json()['items'] == []
    result = post(client, state, headers)
    assert result.status_code == 503 and result.json()['error']['code'] == 'SIM_UNAVAILABLE'
    records = [r.getMessage() for r in caplog.records if r.name == external_camera.__name__]
    assert records == ['external camera relay stage=slots_response status=503 '
        f'code=SIM_UNAVAILABLE fields={fields}' +
        (' type_site=parse type_kind=other' if failure == 'type_error' else '')]
    assert not state['calls']
    assert private not in caplog.text
    assert 'fake-test-service-secret' not in caplog.text
    assert str(state['rid']) not in '\n'.join(records)


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
    fields = ' fields=items:missing,<extra>:extra_forbidden' if failure == 'slots_invalid' else ''
    assert records == [f'external camera relay stage={stage} status={status} code={code}{fields}']
    assert 'private-upstream-value' not in caplog.text
    assert str(state['rid']) not in '\n'.join(records)


@pytest.mark.parametrize('fault', ['error_list', 'error_string', 'nested_list', 'nested_string',
    'invalid_json', 'partial_json', 'slow_headers', 'slow_body'])
def test_slots_transport_faults_do_not_escape_as_type_error(camera, caplog, fault):
    client, state = camera
    headers = csrf(client, 'one')
    state['get_fault'] = fault
    result = post(client, state, headers)
    assert result.status_code == 503 and result.json()['error']['code'] == 'SIM_UNAVAILABLE'
    messages = [r.getMessage() for r in caplog.records if r.name == external_camera.__name__]
    assert messages == ['external camera relay stage=slots_transport status=503 code=SIM_UNAVAILABLE']
    assert not state['calls']
    assert 'private-upstream-value-token' not in caplog.text
    # A slow listing fits the default 5s budget; a 200 alone still proves nothing.
    if fault == 'slow_headers':
        listing = client.get('/api/v1/simulation/robots')
        assert listing.status_code == 200 and listing.json()['manager_error'] is None
        assert listing.json()['items'] == state['slots']['items']


def test_concurrent_real_serialized_listings_do_not_raise_type_error(camera):
    from apps.server.fh_server.simulation import parse_robot_list
    client, state = camera
    relay = client.app.state.simmgr
    def read(_):
        return parse_robot_list(relay.request('GET', '/v1/robots', timeout=.5)).model_dump(mode='json')
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(read, range(12)))
    assert all(result == state['slots'] for result in results)
    assert not state['calls']


def test_request_signature_type_error_is_distinguished_from_parser(camera, monkeypatch, caplog):
    client, state = camera
    original = Relay.request
    # The preview observation launcher installs this signature on Relay itself.
    # Argument binding fails before the real transport's exception boundary.
    def observed(self, method, path, body=None):
        return original(self, method, path, body)
    monkeypatch.setattr(Relay, 'request', observed)
    headers = csrf(client, 'one')
    listing = client.get('/api/v1/simulation/robots')
    assert listing.status_code == 200 and listing.json()['manager_error'] is None
    assert listing.json()['items'] == state['slots']['items']
    result = post(client, state, headers)
    assert result.status_code == 503
    messages = [r.getMessage() for r in caplog.records if r.name == external_camera.__name__]
    assert messages == ['external camera relay stage=slots_response status=503 '
        'code=SIM_UNAVAILABLE fields=$:type_error type_site=request type_kind=unexpected_timeout']
    assert not state['calls']
    assert 'observed' not in '\n'.join(messages)
    assert str(state['rid']) not in '\n'.join(messages)

    # Proposed launcher repair only: preserve kwargs, including the 500ms budget.
    # The live launcher is never imported, executed, edited or restarted here.
    forwarded = []
    def transparent(self, method, path, body=None, **kwargs):
        forwarded.append(kwargs)
        return original(self, method, path, body, **kwargs)
    monkeypatch.setattr(Relay, 'request', transparent)
    time.sleep(.11)
    repaired = post(client, state, headers)
    assert repaired.status_code == 200, repaired.text
    assert forwarded == [{'timeout': .5}, {'timeout': .5}]
    assert len(state['calls']) == 1

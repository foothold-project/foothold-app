"""scenario/2 unit boundaries: fake clocks/frames/HTTP, no ROS or real photos."""
from concurrent.futures import Future
from copy import deepcopy
from datetime import datetime, timezone
import json
from urllib.error import HTTPError
from uuid import uuid4

import pytest

from foothold_agent.camera.stream import Camera
from foothold_agent.executor.photos import PhotoClient, validate_receipt
from foothold_agent.executor.scenario import ScenarioSource, ExecutionUnavailable, plan_from_data
from foothold_agent.executor.steps import ExecutionSupport, StepRunner
from test_phone import Clock


def jpeg():
    return b'\xff\xd8\xff\xc0\x00\x08\x08\x00\xf0\x01\xa8\x01\xff\xd9'


class Uploads:
    def __init__(self):
        self.calls = []
        self.jobs = []

    def upload(self, metadata, payload):
        self.calls.append((deepcopy(metadata), payload))
        future = Future()
        self.jobs.append(future)
        return future

    def receipt(self, index=-1, **override):
        return {**self.calls[index][0], 'photo_id': str(uuid4()),
                'stored_at': datetime.now(timezone.utc).isoformat(), **override}


@pytest.fixture
def step_env():
    clock = Clock()
    camera = Camera(str(uuid4()), now=clock)
    camera.submit(jpeg())
    camera.sample()
    uploads = Uploads()
    support = ExecutionSupport(camera=camera, now=clock, uploader=uploads)
    support.hello()
    def make(steps):
        return StepRunner(support, org=str(uuid4()), robot=camera.robot, run=str(uuid4()),
                          waypoint=0, steps=steps, now=clock)
    return clock, camera, uploads, support, make


def photo(make):
    return make([dict(action='PHOTO', params=dict(camera='rgb'))])


def capture(env, runner):
    clock, camera, uploads, _, _ = env
    runner.tick()
    clock.t += .2
    camera.submit(jpeg())
    camera.sample()
    runner.tick()
    assert len(uploads.calls) == 1


def test_wait_deadline_pause_remaining(step_env):
    clock, _, _, _, make = step_env
    runner = make([dict(action='WAIT', params=dict(seconds=10))])
    runner.tick()
    clock.t = 3
    runner.interrupt()
    assert runner.remaining == 7
    clock.t = 100
    runner.tick()
    assert not runner.results
    runner.resume()
    runner.tick()
    clock.t = 106.99
    runner.tick()
    assert not runner.done
    clock.t = 107
    runner.tick()
    assert runner.done and runner.results[0]['status'] == 'SUCCEEDED'


def test_photo_requires_new_frame_and_receipt(step_env):
    clock, camera, uploads, support, make = step_env
    runner = photo(make)
    runner.tick()
    runner.tick()  # cached image received before request is forbidden
    assert runner.state == 'CAPTURING' and not uploads.calls
    capture(step_env, runner)
    assert not runner.done
    receipt = uploads.receipt()
    uploads.jobs[-1].set_result(receipt)
    runner.tick()
    assert runner.results[0]['photo'] == {k: receipt[k] for k in ('photo_id', 'source', 'captured_at', 'sha256')}


def test_photo_capture_timeout(step_env):
    clock, _, uploads, _, make = step_env
    runner = photo(make)
    runner.tick()
    clock.t = 3
    runner.tick()
    assert runner.results[0]['failure_code'] == 'CAPTURE_TIMEOUT'
    assert not uploads.calls


@pytest.mark.parametrize('status', [503, 507])
def test_photo_storage_retries_identical_key_time_bytes(step_env, status):
    clock, _, uploads, _, make = step_env
    runner = photo(make)
    capture(step_env, runner)
    for attempt in range(3):
        uploads.jobs[-1].set_exception(HTTPError('https://example.test', status, 'storage failed', {}, None))
        runner.tick()
        if attempt < 2:
            assert not runner.done
            clock.t += .21
            runner.tick()
    assert runner.results[0]['failure_code'] == 'STORAGE_UNAVAILABLE'
    assert uploads.calls == [uploads.calls[0]] * 3
    metadata, payload = uploads.calls[0]
    assert metadata['idempotency_key'] == f'{runner.run}:0:0'
    assert metadata['byte_length'] == len(payload)
    from apps.contracts.models import PhotoUploadMetadata
    PhotoUploadMetadata.model_validate(metadata).validate_payload(payload)


def test_photo_retry_success(step_env):
    clock, _, uploads, _, make = step_env
    runner = photo(make)
    capture(step_env, runner)
    uploads.jobs[0].set_exception(HTTPError('https://example.test', 503, '', {}, None))
    runner.tick()
    clock.t += .21
    runner.tick()
    uploads.jobs[1].set_result(uploads.receipt())
    runner.tick()
    assert runner.results[0]['status'] == 'SUCCEEDED'
    assert uploads.calls[0] == uploads.calls[1]


def test_late_upload_after_interrupt_does_not_advance(step_env):
    clock, _, uploads, _, make = step_env
    runner = photo(make)
    capture(step_env, runner)
    runner.interrupt()
    uploads.jobs[0].set_result(uploads.receipt())
    clock.t += 1
    runner.tick()
    assert not runner.results
    runner.resume()
    runner.tick()
    assert len(uploads.calls) == 2 and not runner.results
    assert uploads.calls[0] == uploads.calls[1]
    uploads.jobs[1].set_result(uploads.receipt())
    runner.tick()
    assert runner.results[0]['status'] == 'SUCCEEDED'


def test_late_frame_after_pause_requires_new_request(step_env):
    clock, camera, uploads, _, make = step_env
    runner = photo(make)
    runner.tick()
    runner.interrupt()
    clock.t = .2
    camera.submit(jpeg())
    camera.sample()
    runner.resume()
    runner.tick()
    assert not uploads.calls and runner.state == 'CAPTURING'


def test_upload_timeout_is_bounded_and_late_receipt_ignored(step_env):
    clock, _, uploads, _, make = step_env
    runner = photo(make)
    capture(step_env, runner)
    clock.t = 4.3
    runner.tick()
    assert not runner.results
    clock.t = 8.3
    runner.tick()
    assert runner.results[0]['failure_code'] == 'UPLOAD_FAILED'
    uploads.jobs[0].set_result(uploads.receipt())
    runner.tick()
    assert runner.results[0]['status'] == 'FAILED'


@pytest.mark.parametrize('field,value', [('sha256', 'f'*64), ('run_id', str(uuid4())), ('photo_id', 'invalid'), ('captured_at', 'invalid')])
def test_invalid_receipt_is_never_success(step_env, field, value):
    _, _, uploads, _, make = step_env
    runner = photo(make)
    capture(step_env, runner)
    uploads.jobs[0].set_result(uploads.receipt(**{field: value}))
    runner.tick()
    assert runner.results[0]['failure_code'] == 'UPLOAD_FAILED'


def test_no_step_follows_failure(step_env):
    clock, _, uploads, _, make = step_env
    runner = make([dict(action='PHOTO', params=dict(camera='rgb')), dict(action='WAIT', params=dict(seconds=1))])
    runner.tick()
    clock.t = 3
    runner.tick()
    clock.t = 100
    runner.tick()
    assert len(runner.results) == 1 and runner.state == 'FAILED'


def test_capability_no_rgb_and_revision(step_env):
    clock, camera, uploads, support, _ = step_env
    first = support.hello()
    assert first['actions'][0] == dict(key='wait', state='SUPPORTED', reason=None)
    assert first['actions'][1]['state'] == 'SUPPORTED'
    assert all(a['key'] != 'photo.depth' for a in first['actions'])
    clock.t = 2
    second = support.hello()
    assert second['revision'] > first['revision']
    assert second['actions'][1]['state'] == 'UNAVAILABLE'
    with pytest.raises(ValueError):
        support.require(['photo.rgb'], second['revision'])
    with pytest.raises(ValueError):
        support.require(['wait'], first['revision'])
    empty = ExecutionSupport(now=clock)
    assert empty.hello()['actions'][1]['state'] == 'UNAVAILABLE'


def test_receipt_accepts_server_utc_normalization(step_env):
    _, _, uploads, _, make = step_env
    runner = photo(make)
    capture(step_env, runner)
    receipt = uploads.receipt()
    receipt['captured_at'] = receipt['captured_at'].replace('+00:00', 'Z')
    assert validate_receipt(receipt, uploads.calls[0][0]) == receipt


def test_negotiated_scenario_query_and_422(step_env, monkeypatch):
    _, _, _, support, _ = step_env
    source = ScenarioSource('https://example.test', 'test-token', support=support)
    seen = []
    class Opener:
        def open(self, request, timeout):
            seen.append(request)
            import io
            raise HTTPError(request.full_url, 422, '', {}, io.BytesIO(json.dumps(dict(error=dict(
                code='EXECUTION_UNAVAILABLE', message='RGB unavailable'))).encode()))
    monkeypatch.setattr('urllib.request.build_opener', lambda *a: Opener())
    try:
        with pytest.raises(ExecutionUnavailable, match='EXECUTION_UNAVAILABLE') as error:
            source.fetch(dict(scenario_id=str(uuid4()), scenario_version=7)).result(timeout=2)
        assert error.value.reason == 'RGB unavailable'
        assert '?version=7&run_contract=scenario/2&execution_capability_revision=1' in seen[0].full_url
        assert seen[0].get_header('Authorization') == 'Bearer test-token'
    finally:
        source.pool.shutdown()


def test_photo_client_sends_raw_and_requires_200(step_env, monkeypatch):
    _, _, uploads, _, make = step_env
    runner = photo(make)
    capture(step_env, runner)
    metadata, payload = uploads.calls[0]
    seen = []
    class Reply:
        status = 200
        def __enter__(self): return self
        def __exit__(self, *a): pass
        def read(self, limit): return json.dumps(uploads.receipt()).encode()
    class Opener:
        def open(self, request, timeout):
            seen.append(request)
            return Reply()
    monkeypatch.setattr('foothold_agent.executor.photos.build_opener', lambda *a: Opener())
    client = PhotoClient('https://example.test', 'test-token')
    try:
        assert client.upload(metadata, payload).result(timeout=2)['sha256'] == metadata['sha256']
        request = seen[0]
        assert request.data == payload and request.full_url.endswith('/api/v1/agent/photos')
        assert json.loads(request.get_header('X-photo-metadata')) == metadata
        assert request.get_header('Content-type') == 'image/jpeg'
        Reply.status = 201
        with pytest.raises(ValueError, match='receipt'):
            client.upload(metadata, payload).result(timeout=2)
    finally:
        client.close()


def test_media_video_reuses_base64_header_without_new_camera_subscription(step_env):
    import base64
    clock, _, uploads, _, _ = step_env
    class Media:
        latest = {}
        def available(self, channel): return channel == 'rgb'
    media = Media()
    captured = datetime.now(timezone.utc).isoformat()
    media.latest['rgb'] = (clock(), dict(jpeg=base64.b64encode(jpeg()).decode(), captured_at=captured), None)
    support = ExecutionSupport(media=media, now=clock, uploader=uploads)
    assert support.hello()['actions'][1]['state'] == 'SUPPORTED'
    assert support.frame_after(clock()) is None
    clock.t = .2
    media.latest['rgb'] = (clock(), dict(jpeg=base64.b64encode(jpeg()).decode(), captured_at=captured), None)
    assert support.frame_after(0) == (jpeg(), captured)
    clock.t = 2
    assert not support.rgb_ready() and support.frame_after(0) is None


def test_photo_client_has_no_cross_run_upload_backlog(step_env, monkeypatch):
    import threading
    _, _, uploads, _, make = step_env
    runner = photo(make)
    capture(step_env, runner)
    metadata, payload = uploads.calls[0]
    entered, release = threading.Event(), threading.Event()
    class Reply:
        status = 200
        def __enter__(self): return self
        def __exit__(self, *a): pass
        def read(self, limit): return json.dumps(uploads.receipt()).encode()
    class Opener:
        def open(self, *args, **kwargs):
            entered.set()
            assert release.wait(2)
            return Reply()
    monkeypatch.setattr('foothold_agent.executor.photos.build_opener', lambda *a: Opener())
    client = PhotoClient('https://example.test', 'test-token')
    try:
        first = client.upload(metadata, payload)
        assert entered.wait(1)
        with pytest.raises(RuntimeError, match='busy'):
            client.upload({**metadata, 'run_id': str(uuid4())}, payload)
        release.set()
        assert first.result(timeout=2)['sha256'] == metadata['sha256']
    finally:
        release.set()
        client.close()


@pytest.mark.parametrize('camera_fallback', [True, False])
@pytest.mark.parametrize('byte_length', [65537, 65539])
def test_oversized_media_uses_bounded_camera_or_fails_before_upload(step_env, camera_fallback, byte_length):
    import base64
    clock, camera, uploads, _, _ = step_env
    class Media:
        latest = {}
        def available(self, channel): return channel == 'rgb'
    media = Media()
    captured = datetime.now(timezone.utc).isoformat()
    media.latest['rgb'] = (clock(), dict(jpeg=base64.b64encode(jpeg()).decode(), captured_at=captured), None)
    support = ExecutionSupport(media=media, camera=camera if camera_fallback else None,
                               now=clock, uploader=uploads)
    runner = StepRunner(support, org=str(uuid4()), robot=camera.robot, run=str(uuid4()),
                        waypoint=0, steps=[dict(action='PHOTO', params=dict(camera='rgb'))], now=clock)
    runner.tick()
    clock.t = .2
    media.latest['rgb'] = (clock(), dict(jpeg=base64.b64encode(b'x' * byte_length).decode(), captured_at=captured), None)
    if camera_fallback:
        assert camera.submit(jpeg())
        camera.sample()
    runner.tick()
    if camera_fallback:
        assert runner.state == 'UPLOADING' and uploads.calls[0][1] == jpeg()
        assert uploads.calls[0][0]['byte_length'] <= 65536
    else:
        assert runner.results[0]['status'] == 'FAILED'
        assert runner.results[0]['failure_code'] == 'NO_FRESH_FRAME'
        assert '65536-byte' in runner.results[0]['failure_reason']
        assert not uploads.calls

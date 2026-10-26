"""Media and scenario/2 boundaries, with no sockets, services, or motion sinks."""
import base64
import hashlib
import json
import struct
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator, FormatChecker
from pydantic import TypeAdapter, ValidationError

from apps.contracts import generate, models as C

U = '00000000-0000-0000-0000-000000000001'
V = '00000000-0000-0000-0000-000000000002'
STAMP = '2026-10-26T00:00:00Z'
BINDING = dict(robot=U, epoch=1, episode_id=U)
HEADER = dict(BINDING, version='media/1', seq=0, captured_at=STAMP,
              channel='rgb', source='d435i_rgb', frame='camera_color_optical_frame')
# Marker-only bytes exercise framing. Real JPEG decoding/dimensions belong to ingress.
JPEG = b'\xff\xd8\xff\xd9'
VIDEO = dict(HEADER, t='media.video', mime='image/jpeg', width=640, height=360,
             jpeg=base64.b64encode(JPEG).decode())
POINTS = dict(HEADER, t='media.points', channel='lidar', source='l1', frame='lidar_link',
              map_version_id=None, pose=None, count=1, truncated=False,
              encoding='xyz_f32le', byte_length=12)
GOAL = dict(idx=0, waypoint_ref=None, x=1.0, y=2.0, yaw=0.0,
            mission_id=U, mission_version=1, mission_name='사진 대기',
            mission_steps=[dict(action='WAIT', params={'seconds': 30}),
                           dict(action='PHOTO', params={'camera': 'rgb'})],
            required_capabilities=['wait', 'photo.rgb'])
WAYPOINT = dict(floor_id=U, map_version_id=U, **{k: v for k, v in GOAL.items() if k != 'idx'})
PROOF = dict(floor_id=U, map_version_id=U, image_sha256='a' * 64,
             source_pgm_sha256='b' * 64, origin=[0.0, 0.0, 0.0], resolution=0.05,
             width=100, height=100, source='SIMULATION', world_id='warehouse', ros_floor_id='f1')
SCENARIO = dict(id=U, number=1, waypoints=[WAYPOINT], finish={'mode': 'STAY'},
                map_proofs=[PROOF], run_contract='scenario/2', execution_capability_revision=1)
CAPABILITIES = dict(contract='scenario/2', revision=1, actions=[
    dict(key='wait', state='SUPPORTED', reason=None),
    dict(key='photo.rgb', state='SUPPORTED', reason=None),
    dict(key='photo.depth', state='UNSUPPORTED', reason='Depth photo is not implemented')])
WAIT = dict(step_idx=0, action='WAIT', source=None, status='SUCCEEDED',
            failure_code=None, failure_reason=None, photo=None)
PHOTO = dict(step_idx=1, action='PHOTO', source='rgb', status='SUCCEEDED',
             failure_code=None, failure_reason=None,
             photo=dict(photo_id=U, source='rgb', captured_at=STAMP, sha256='a' * 64))
RESULTS = dict(mode='EXECUTED', run_contract='scenario/2', execution_capability_revision=1,
               steps=[WAIT, PHOTO])
UPLOAD = dict(org_id=U, robot_id=U, run_id=U, waypoint_idx=0, step_idx=1, source='rgb',
              captured_at=STAMP, mime='image/jpeg', byte_length=4,
              sha256=hashlib.sha256(JPEG).hexdigest(), idempotency_key='run:waypoint:step')


def test_legacy_camera_and_phone_execution_shapes_remain_unchanged():
    assert set(C.CameraHello.model_fields) == {'t', 'robot', 'token'}
    assert set(C.CameraFrame.model_fields) == {'t', 'robot', 'seq', 'mime', 'width', 'height', 'jpeg'}
    assert set(C.CameraStatus.model_fields) == {'t', 'robot', 'state'}
    old = dict(t='camera.frame', robot=U, seq=0, mime='image/jpeg', width=640, height=360, jpeg='AAAA')
    assert C.CameraFrame(**old).model_dump(mode='json') == old
    assert C.PhoneCapabilities(run_contract='scenario/1').model_dump(exclude_unset=True) == {'run_contract': 'scenario/1'}
    assert C.PhoneCapabilities(run_contract='scenario/1').model_dump() == {'run_contract': 'scenario/1'}
    assert C.RunDisplayResults().mode == 'DISPLAY_ONLY'
    with pytest.raises(ValidationError):
        C.PhoneCapabilities(run_contract='scenario/2')
    with pytest.raises(ValidationError):
        C.RunDisplayResults(mode='EXECUTED')


def test_media_is_separate_from_safety_and_legacy_camera_sockets():
    assert isinstance(TypeAdapter(C.MediaMessage).validate_python(VIDEO), C.MediaVideoFrame)
    for model in (C.AgentMessage, C.PhoneMessage, C.CameraFrame):
        with pytest.raises(ValidationError):
            TypeAdapter(model).validate_python(VIDEO)
    hello = dict(BINDING, t='media.hello', version='media/1', channel='lidar', token='x' * 43)
    assert C.MediaHello(**hello).channel == 'lidar'
    with pytest.raises(ValidationError):
        C.CameraHello(**hello)


@pytest.mark.parametrize('change', [dict(source='gazebo_external'), dict(channel='depth'),
    dict(robot='robot'), dict(epoch=-1), dict(epoch=True), dict(seq=2**53),
    dict(captured_at='2026-10-26T00:00:00'), dict(captured_at='yesterday'),
    dict(width=641), dict(height=361), dict(width=True), dict(jpeg='AAAA'),
    dict(jpeg='////='), dict(jpeg=' /9j/2Q=='), dict(frame=''), dict(frame='world;service')])
def test_media_rejects_invalid_header_video_and_timestamp(change):
    with pytest.raises(ValidationError):
        C.MediaVideoFrame(**{**VIDEO, **change})


def test_jpeg_exact_byte_cap_and_channel_device_identity():
    exact = b'\xff\xd8' + b'\x00' * (C.MEDIA_JPEG_MAX_BYTES - 4) + b'\xff\xd9'
    assert C.MediaVideoFrame(**{**VIDEO, 'jpeg': base64.b64encode(exact).decode()})
    # 65537 and 65536 produce the same base64 length: decoded cap is essential.
    over = exact[:-2] + b'\x00\xff\xd9'
    with pytest.raises(ValidationError):
        C.MediaVideoFrame(**{**VIDEO, 'jpeg': base64.b64encode(over).decode()})
    assert C.MediaVideoFrame(**{**VIDEO, 'source': 'go2_front'})
    external = dict(VIDEO, channel='external', source='gazebo_external')
    assert C.MediaVideoFrame(**external)
    with pytest.raises(ValidationError):
        C.MediaVideoFrame(**{**external, 'episode_id': None})
    assert C.MediaVideoFrame(**{**VIDEO, 'episode_id': None})  # Hardware RGB.


def test_point_payload_requires_exact_little_endian_xyz_and_verified_map_frame():
    cloud = C.MediaPointCloudHeader(**POINTS)
    cloud.validate_payload(struct.pack('<fff', 1.0, -2.0, 3.0))
    for payload in (b'', b'\x00' * 11, b'\x00' * 13, struct.pack('<fff', float('nan'), 0, 0),
                    struct.pack('<fff', float('inf'), 0, 0), struct.pack('<fff', 10001, 0, 0)):
        with pytest.raises(ValueError):
            cloud.validate_payload(payload)
    maximum = C.MediaPointCloudHeader(**{**POINTS, 'count': 4000, 'byte_length': 48000, 'truncated': True})
    maximum.validate_payload(b'\x00' * 48000)
    C.MediaPointCloudHeader(**{**POINTS, 'count': 0, 'byte_length': 0}).validate_payload(b'')
    for change in (dict(count=4001), dict(count=True), dict(byte_length=13), dict(encoding='xyz_f64le'),
                   dict(frame='map'), dict(map_version_id=U), dict(pose={'x': 0, 'y': 0, 'z': 0, 'yaw': 0})):
        with pytest.raises(ValidationError):
            C.MediaPointCloudHeader(**{**POINTS, **change})
    assert C.MediaPointCloudHeader(**{**POINTS, 'frame': 'map', 'map_version_id': U,
                                      'pose': dict(x=0, y=0, z=0, yaw=0)})


def test_observer_request_has_no_robot_pose_or_service_escape_hatch():
    view = dict(BINDING, t='external.view', version='observer/1', seq=1, yaw=0.0, pitch=0.0, radius=2.0)
    assert C.ExternalCameraViewRequest(**view)
    for change in (dict(yaw=3.15), dict(pitch=1.21), dict(radius=0.49), dict(radius=10.1),
                   dict(yaw=float('nan')), dict(radius=True), dict(episode_id=None),
                   dict(entity='robot'), dict(service='/world/demo/set_pose'), dict(x=1.0),
                   dict(pose={'x': 1}), dict(reset=True)):
        with pytest.raises(ValidationError):
            C.ExternalCameraViewRequest(**{**view, **change})
    assert C.MediaLimits().external_view_max_hz == 10


def test_v2_fixed_steps_require_exact_capabilities_and_map_proofs():
    scenario = C.ExecutableAgentScenario(**SCENARIO)
    assert scenario.waypoints[0].mission_steps[0].params == {'seconds': 30}
    legacy = {k: v for k, v in WAYPOINT.items() if k not in ('mission_steps', 'required_capabilities')}
    parsed = C.AgentScenarioWaypoint(**legacy)
    assert parsed.model_dump(mode='json') == legacy
    assert C.AgentScenarioWaypoint.model_validate(parsed.model_dump()) == parsed
    old_goal = {k: v for k, v in GOAL.items() if k not in ('mission_steps', 'required_capabilities')}
    assert C.RunGoal(**old_goal).model_dump(mode='json') == old_goal
    for change in (dict(mission_steps=None), dict(required_capabilities=None),
                   dict(required_capabilities=[]), dict(required_capabilities=['photo.depth', 'wait']),
                   dict(required_capabilities=['wait', 'photo.rgb', 'wait']),
                   dict(mission_steps=[{'action': 'WAIT', 'params': {'seconds': 0}}])):
        with pytest.raises(ValidationError):
            C.ExecutableAgentScenarioWaypoint(**{**WAYPOINT, **change})
    for remove in ('mission_steps', 'required_capabilities'):
        with pytest.raises(ValidationError):
            C.ExecutableAgentScenarioWaypoint(**{k: v for k, v in WAYPOINT.items() if k != remove})
        with pytest.raises(ValidationError):
            C.AgentScenarioWaypoint(**{k: v for k, v in WAYPOINT.items() if k != remove})
    with pytest.raises(ValidationError):
        C.ExecutableAgentScenario(**{**SCENARIO, 'map_proofs': []})
    assert C.ExecutableAgentScenarioWaypoint(**{**WAYPOINT, 'mission_steps': [], 'required_capabilities': []})


def test_executor_capability_revision_and_depth_unsupported_fail_closed():
    caps = C.ExecutionCapabilities(**CAPABILITIES)
    caps.require(['wait', 'photo.rgb'], revision=1)
    for required, revision in ((['photo.depth'], 1), (['wait'], 2), (['sensor_log.lidar'], 1)):
        with pytest.raises(ValueError):
            caps.require(required, revision)
    unavailable = C.ExecutionCapabilities(**{**CAPABILITIES, 'actions': [
        dict(key='photo.rgb', state='UNAVAILABLE', reason='No fresh RGB or photo storage')]})
    with pytest.raises(ValueError):
        unavailable.require(['photo.rgb'], 1)
    for change in (dict(revision=0), dict(revision=True), dict(actions=[CAPABILITIES['actions'][0]] * 2),
                   dict(actions=[dict(key='photo.depth', state='UNSUPPORTED', reason=None)])):
        with pytest.raises(ValidationError):
            C.ExecutionCapabilities(**{**CAPABILITIES, **change})


def test_explicit_start_v2_cannot_be_parsed_as_legacy_start():
    start = dict(t='run.start.v2', id='start', robot=U, lease_id=U, run_id=U, screen_id=U,
                 scenario_id=U, scenario_version=1, floor_id=U, map_version_id=U,
                 run_contract='scenario/2', execution_capability_revision=1)
    assert isinstance(TypeAdapter(C.PhoneMessage).validate_python(start), C.PhoneRunStartV2)
    with pytest.raises(ValidationError):
        C.PhoneRunStart(**start)
    for key in ('run_contract', 'execution_capability_revision'):
        with pytest.raises(ValidationError):
            C.PhoneRunStartV2(**{k: v for k, v in start.items() if k != key})
    started = dict(run_id=U, scenario_id=U, scenario_version=1, floor_id=U, map_version_id=U,
                   user_id=U, device_id=U, surface='pc', screen_id=U, simulation=True, map_proof=PROOF,
                   run_contract='scenario/2', execution_capability_revision=1)
    assert C.ExecutableRunStarted(**started)
    with pytest.raises(ValidationError):
        C.RunStarted(**{k: v for k, v in started.items() if k != 'execution_capability_revision'})


def test_step_results_require_committed_photo_and_match_fixed_snapshot():
    result = C.RunExecutedResults(**RESULTS)
    goal = C.ExecutableRunGoal(**GOAL)
    result.validate_plan(goal, revision=1)
    for change in (dict(photo=None), dict(failure_code='CAPTURE_TIMEOUT'), dict(source='depth'),
                   dict(status='FAILED'), dict(photo={**PHOTO['photo'], 'sha256': 'bad'})):
        with pytest.raises(ValidationError):
            C.RunStepResult(**{**PHOTO, **change})
    depth_failed = dict(PHOTO, source='depth', photo=None, status='FAILED',
                        failure_code='UNSUPPORTED', failure_reason='Depth photo is not implemented')
    assert C.RunStepResult(**depth_failed)
    for change in (dict(steps=[PHOTO, WAIT]), dict(steps=[WAIT, {**PHOTO, 'step_idx': 0}]),
                   dict(steps=[{**WAIT, 'status': 'FAILED', 'failure_code': 'INTERRUPTED',
                                'failure_reason': 'Stopped'}, PHOTO])):
        with pytest.raises(ValidationError):
            C.RunExecutedResults(**{**RESULTS, **change})
    for candidate, revision in (({**RESULTS, 'steps': [WAIT]}, 1), (RESULTS, 2),
                                ({**RESULTS, 'steps': [WAIT, depth_failed]}, 1)):
        with pytest.raises(ValueError):
            C.RunExecutedResults(**candidate).validate_plan(goal, revision)
    failure = dict(PHOTO, photo=None, status='FAILED', failure_code='UPLOAD_FAILED', failure_reason='Disk full')
    C.RunExecutedResults(**{**RESULTS, 'steps': [WAIT, failure]}).validate_plan(goal, 1)


def test_photo_metadata_and_payload_exclude_image_bytes_urls_and_unowned_identifiers():
    upload = C.PhotoUploadMetadata(**UPLOAD)
    upload.validate_payload(JPEG)
    for payload in (b'', b'bad!', b'\xff\xd8\x00\xd9'):
        with pytest.raises(ValueError):
            upload.validate_payload(payload)
    for change in (dict(byte_length=65537), dict(byte_length=True), dict(mime='image/png'),
                   dict(source='depth'), dict(sha256='A' * 64), dict(idempotency_key='a b'),
                   dict(jpeg='AAAA'), dict(url='https://example.com/photo.jpg'), dict(org_id='tenant'),
                   dict(waypoint_idx=200), dict(step_idx=100)):
        with pytest.raises(ValidationError):
            C.PhotoUploadMetadata(**{**UPLOAD, **change})
    for key in ('org_id', 'robot_id', 'run_id', 'waypoint_idx', 'step_idx', 'idempotency_key'):
        with pytest.raises(ValidationError):
            C.PhotoUploadMetadata(**{k: v for k, v in UPLOAD.items() if k != key})
    assert C.PhotoUploadReceipt(**UPLOAD, photo_id=U, stored_at=STAMP)
    with pytest.raises(ValidationError):
        C.PhotoUploadReceipt(**UPLOAD, photo_id=U, stored_at='2026-10-25T23:59:59Z')
    assert len(upload.model_dump_json()) < 1024


def test_executed_results_use_existing_durable_event_identity_and_small_references():
    arrival = dict(run_id=U, idx=0, waypoint_ref=None, mission_id=U, mission_version=1,
                   mission_name='photo', floor_id=U, map_version_id=U,
                   pose=dict(floor_id=U, map_version_id=U, x=0.0, y=0.0, yaw=0.0, confidence=1.0),
                   agent_instance_id=U, report_seq=2, monotonic_s=1.0, results=RESULTS)
    event = dict(t='event', code='RUN_WAYPOINT_RECORDED', severity='INFO', robot_at=STAMP,
                 data=arrival, agent_instance_id=U, report_seq=2, monotonic_s=1.0)
    assert C.DurableAgentEvent(**event)
    assert len(C.DurableAgentEvent(**event).model_dump_json()) < 4096
    with pytest.raises(ValidationError):
        C.DurableAgentEvent(**{**event, 'report_seq': 3})


def test_shared_typescript_media_execution_fixtures_validate_in_python_and_schema():
    for line in Path(__file__).with_name('media-consumer.ts').read_text().splitlines():
        if not line.startswith('export const '):
            continue
        declaration, value = line.split(' = ', 1)
        name = declaration.split(': ')[1]
        payload = json.loads(value.removesuffix(';'))
        TypeAdapter(C.TOP[name]).validate_python(payload)
        schema = json.loads((generate.OUT / 'schema' / f'{name}.json').read_text())
        Draft202012Validator(schema, format_checker=FormatChecker()).validate(payload)


def test_phone_media_welcome_is_optional_and_tokens_match_capabilities():
    from apps.contracts.models import PhoneMediaChannelCapability, PhoneMediaWelcome
    from pydantic import ValidationError
    available = dict(available=True, reason='Ready', token='a'*43)
    unavailable = dict(available=False, reason='Source absent', token=None)
    value = dict(version='media/1', path='/phone/media/ws', robot='00000000-0000-0000-0000-000000000001',
                 epoch=1, episode_id=None, rgb=available, external=unavailable, lidar=available)
    PhoneMediaWelcome.model_validate(value)
    for bad in ({**available, 'token': None}, {**unavailable, 'token': 'a'*43}):
        with pytest.raises(ValidationError):
            PhoneMediaChannelCapability.model_validate(bad)

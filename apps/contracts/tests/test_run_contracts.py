"""Scenario/1 wire boundaries; no server, robot, or motion sink is started."""
import json
from pathlib import Path
from typing import get_args

import pytest
from jsonschema import Draft202012Validator, FormatChecker
from pydantic import TypeAdapter, ValidationError

from apps.contracts import generate, models as C

U = '00000000-0000-0000-0000-000000000001'
BASE = dict(id='request', robot=U)
START = dict(BASE, t='run.start', lease_id=U, run_id=U, screen_id=U,
             scenario_id=U, scenario_version=1, floor_id=U, map_version_id=U)
REPORT = dict(t='run.update', run_id=U, status='PAUSED', step=0,
              progress=dict(done=0, total=1), wait_reason='LINK_LOST',
              agent_instance_id=U, report_seq=1, monotonic_s=10.0)
GOAL = dict(idx=0, waypoint_ref=None, x=1.0, y=2.0, yaw=0.0,
            mission_id=U, mission_version=1, mission_name='순찰')
POSE = dict(floor_id=U, map_version_id=U, x=1.0, y=2.0, yaw=0.0, confidence=1.0)
ARRIVAL = dict(run_id=U, **{k: v for k, v in GOAL.items() if k not in ('x', 'y', 'yaw')},
               floor_id=U, map_version_id=U, pose=POSE,
               agent_instance_id=U, report_seq=2, monotonic_s=11.0)


def test_generated_contracts_are_current():
    files = generate.build()
    assert not generate.stale_files(files)
    for name, expected in files.items():
        assert (generate.OUT / name).read_text() == expected, name


@pytest.mark.parametrize('change', [dict(scenario_version=0), dict(scenario_version=True),
                                    dict(scenario_version='1'), dict(screen_id='tab'),
                                    dict(plan={}), dict(resume_token='secret'), dict(assignment_id=None)])
def test_start_accepts_fixed_references_only(change):
    with pytest.raises(ValidationError):
        TypeAdapter(C.PhoneMessage).validate_python({**START, **change})


def test_direct_envelope_and_small_reference_frame():
    result = TypeAdapter(C.PhoneMessage).validate_python(START)
    assert isinstance(result, C.PhoneRunStart)
    assert len(result.model_dump_json(exclude_unset=True).encode()) < 4096
    assert 'assignment_id' not in result.model_dump(exclude_unset=True)
    for field in ('id', 'robot', 'screen_id', 'lease_id', 'scenario_version'):
        with pytest.raises(ValidationError):
            TypeAdapter(C.PhoneMessage).validate_python({k: v for k, v in START.items() if k != field})
    with pytest.raises(ValidationError):
        TypeAdapter(C.ScreenMessage).validate_python(START)


def test_control_proof_and_reserved_operations():
    abort = dict(BASE, t='run.control', run_id=U, op='abort')
    assert C.PhoneRunControl(**abort).lease_id is None
    # Server-signed run_cancel and PAUSED checks belong to the authenticated Hub.
    for op in ('pause', 'resume'):
        with pytest.raises(ValidationError):
            C.PhoneRunControl(**{**abort, 'op': op})
    assert C.PhoneRunControl(**{**abort, 'op': 'pause', 'lease_id': U, 'screen_id': U})
    resume = dict(abort, op='resume', lease_id=U, screen_id=U)
    with pytest.raises(ValidationError):
        C.PhoneRunControl(**resume)
    assert C.PhoneRunControl(**resume, resume_token='memory-only')
    assert C.PhoneRunControl(**{**abort, 'op': 'return'})
    assert C.PhoneRunConfirm(**BASE, t='run.confirm', lease_id=U, run_id=U, kind='OPERATOR', data={})
    assert 'UNSUPPORTED_OPERATION' in get_args(C.RunRejectCode)


@pytest.mark.parametrize('status', get_args(C.RunStatus))
def test_new_statuses_and_legacy_read_compatibility(status):
    assert C.AgentRunUpdate(**{**REPORT, 'status': status, 'wait_reason': None})
    assert C.CurrentRun(id=U, status='ABORTED', scenario_name='old', progress={'done': 0, 'total': 1})


@pytest.mark.parametrize('status', ['RUNNING', 'PAUSED', 'COMPLETED', 'FAILED', 'ABORTED'])
def test_existing_agent_reports_pass_server_adapter(status):
    frame = dict(t='run.update', run_id=U, status=status, step=1, progress=None)
    result = TypeAdapter(C.AgentMessage).validate_python(frame)
    assert result.status == status
    assert result.model_dump(mode='json', exclude_unset=True) == frame
    # Direct phone state still uses only the new detailed statuses.
    if status in ('RUNNING', 'ABORTED'):
        with pytest.raises(ValidationError):
            C.PhoneRunUpdate(**frame)


@pytest.mark.parametrize('identity', [dict(agent_instance_id=U), dict(report_seq=1),
                                    dict(monotonic_s=1.0), dict(agent_instance_id=U, report_seq=1),
                                    dict(agent_instance_id=None, report_seq=1, monotonic_s=1.0)])
def test_partial_or_null_report_identity_is_rejected(identity):
    frame = dict(t='run.update', run_id=U, status='RUNNING', step=0, progress=None)
    with pytest.raises(ValidationError):
        TypeAdapter(C.AgentMessage).validate_python({**frame, **identity})


@pytest.mark.parametrize('reason', get_args(C.RunWaitReason))
def test_pause_reasons_are_not_failures(reason):
    assert C.AgentRunUpdate(**{**REPORT, 'wait_reason': reason})
    with pytest.raises(ValidationError):
        C.AgentRunUpdate(**{**REPORT, 'status': 'FAILED', 'wait_reason': reason})
    with pytest.raises(ValidationError):
        C.AgentRunUpdate(**{**REPORT, 'wait_reason': None, 'fail_code': reason})


def test_pause_timeout_and_unknown_future_failure():
    assert 'PAUSE_TIMEOUT' in get_args(C.RunFailCode)
    canceled = C.AgentRunUpdate(**{**REPORT, 'status': 'CANCELED', 'wait_reason': None, 'fail_code': 'PAUSE_TIMEOUT'})
    assert canceled.wait_reason is None
    assert C.AgentRunUpdate(**{**REPORT, 'status': 'FAILED', 'wait_reason': None, 'fail_code': 'FUTURE_CODE'})
    assert 'run_pause_timeout_s' not in C.PhoneRunStart.model_fields
    assert 'run_pause_timeout_s' not in C.PhoneTicketClaims.model_fields


@pytest.mark.parametrize('change', [dict(report_seq=True), dict(report_seq=-1),
                                    dict(report_seq=2**53), dict(monotonic_s=-1.0),
                                    dict(monotonic_s=float('nan'))])
def test_report_identity_and_clock(change):
    with pytest.raises(ValidationError):
        C.AgentRunUpdate(**{**REPORT, **change})


def test_single_floor_ordered_finite_plan():
    segment = dict(floor_id=U, map_version_id=U, goals=[GOAL])
    assert C.RunPlan(segments=[segment])
    for segments in ([], [segment, segment]):
        with pytest.raises(ValidationError):
            C.RunPlan(segments=segments)
    for goals in ([], [dict(GOAL, idx=1)], [dict(GOAL, x=float('inf'))], [GOAL] * 201):
        with pytest.raises(ValidationError):
            C.RunSegment(**{**segment, 'goals': goals})


def test_waypoint_events_and_durable_ack():
    event = dict(t='event', code='RUN_WAYPOINT_ARRIVED', severity='INFO', robot_at=None,
                 data=ARRIVAL, agent_instance_id=U, report_seq=2, monotonic_s=11.0)
    assert C.AgentEvent(**event)
    with pytest.raises(ValidationError):
        C.AgentEvent(**{**event, 'report_seq': 3})
    with pytest.raises(ValidationError):
        C.AgentEvent(**{k: v for k, v in event.items() if k != 'report_seq'})
    recorded = dict(ARRIVAL, results={'mode': 'DISPLAY_ONLY'})
    assert C.AgentEvent(**{**event, 'code': 'RUN_WAYPOINT_RECORDED', 'data': recorded})
    with pytest.raises(ValidationError):
        C.RunWaypointRecorded(**{**recorded, 'results': {'mode': 'SUCCESS'}})
    assert C.RunRecorded(agent_instance_id=U, report_seq=2).t == 'run.recorded'
    receipt = TypeAdapter(C.ServerAgentMessage).validate_python(
        dict(t='run.recorded', agent_instance_id=U, report_seq=2))
    assert isinstance(receipt, C.RunRecorded)
    with pytest.raises(ValidationError):
        TypeAdapter(C.AgentMessage).validate_python(receipt.model_dump())
    # Non-run event producers can keep their existing shape.
    assert C.AgentEvent(t='event', code='LOGIN', severity='INFO', robot_at=None, data={})


def test_fixed_scenario_response_keeps_stored_order_versions_and_finish():
    waypoint = dict(floor_id=U, map_version_id=U,
                    **{k: v for k, v in GOAL.items() if k != 'idx'})
    response = dict(id=U, number=3, waypoints=[waypoint],
                    finish=dict(mode='GO_TO', target={k: waypoint[k] for k in
                                ('floor_id', 'map_version_id', 'x', 'y', 'yaw', 'waypoint_ref')}))
    parsed = C.AgentScenario(**response)
    assert parsed.number == 3 and parsed.waypoints[0].mission_version == 1
    assert parsed.waypoints[0].mission_name == '순찰'
    assert parsed.finish.target.map_version_id == parsed.waypoints[0].map_version_id
    for change in (dict(number=0), dict(number=True), dict(waypoints=[]),
                   dict(waypoints=[{k: v for k, v in waypoint.items() if k != 'mission_name'}]),
                   dict(waypoints=[dict(waypoint, mission_version=0)])):
        with pytest.raises(ValidationError):
            C.AgentScenario(**{**response, **change})


def test_started_event_requires_fixed_references_actor_and_no_resume_secret():
    data = dict(run_id=U, scenario_id=U, scenario_version=1, floor_id=U,
                map_version_id=U, user_id=U, device_id=U, surface='pc', screen_id=U,
                simulation=True)
    event = dict(t='event', code='RUN_STARTED', severity='INFO', robot_at=None,
                 data=data, agent_instance_id=U, report_seq=0, monotonic_s=0.0)
    assert TypeAdapter(C.AgentMessage).validate_python(event)
    for field in data:
        with pytest.raises(ValidationError):
            C.AgentEvent(**{**event, 'data': {k: v for k, v in data.items() if k != field}})
    for change in (dict(resume_token='secret'), dict(scenario_version=0), dict(surface='web')):
        with pytest.raises(ValidationError):
            C.AgentEvent(**{**event, 'data': {**data, **change}})


def test_cancel_claim_defaults_and_surface_do_not_grant_control():
    claims = dict(iss='fh-control', aud='fh-phone/1', org=U, robot=U, sub=U, device=U,
                  purpose='view', iat=0, exp=600, jti=U)
    assert C.PhoneTicketClaims(**claims).run_cancel is False
    assert C.PhoneTicketClaims(**claims).surface == 'phone'
    signed = C.PhoneTicketClaims(**claims, run_cancel=True, surface='pc')
    assert signed.purpose == 'view' and signed.surface == 'pc'
    for value in (1, 'true', None):
        with pytest.raises(ValidationError):
            C.PhoneTicketClaims(**claims, run_cancel=value)


def test_shared_typescript_literals_validate_in_python_and_json_schema():
    source = Path(__file__).with_name('run-consumer.ts').read_text()
    for line in source.splitlines():
        if not line.startswith('export const '):
            continue
        declaration, value = line.split(' = ', 1)
        name = declaration.split(': ')[1]
        payload = json.loads(value.removesuffix(';'))
        model = C.TOP[name]
        TypeAdapter(model).validate_python(payload)
        schema = json.loads((generate.OUT / 'schema' / f'{name}.json').read_text())
        Draft202012Validator(schema, format_checker=FormatChecker()).validate(payload)

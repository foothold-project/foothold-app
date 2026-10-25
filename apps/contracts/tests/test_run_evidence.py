"""Map evidence, poison-report disposition, and staged persistent-run boundaries."""
from typing import get_args

import pytest
from pydantic import TypeAdapter, ValidationError

from apps.contracts import models as C
from apps.contracts.tests.test_run_contracts import U, GOAL, REPORT

OTHER = '00000000-0000-0000-0000-000000000002'
PROOF = dict(floor_id=U, map_version_id=U, image_sha256='a' * 64,
             source_pgm_sha256='b' * 64, origin=[-7.5, -11.0, 0.0], resolution=0.05,
             width=300, height=440, source='SIMULATION', world_id='warehouse', ros_floor_id='f1')
POINT = dict(floor_id=U, map_version_id=U, **{k: v for k, v in GOAL.items() if k != 'idx'})
SCENARIO = dict(id=U, number=1, waypoints=[POINT], finish=dict(mode='STAY'))
STARTED = dict(run_id=U, scenario_id=U, scenario_version=1, floor_id=U, map_version_id=U,
               user_id=U, device_id=U, surface='pc', screen_id=U, simulation=True)


def test_old_read_models_remain_compatible_but_new_execution_requires_map_evidence():
    assert C.AgentScenario(**SCENARIO).map_proofs is None
    assert C.RunStarted(**STARTED).map_proof is None
    with pytest.raises(ValidationError):
        C.ProvenAgentScenario(**SCENARIO)
    with pytest.raises(ValidationError):
        C.ProvenRunStarted(**STARTED)
    assert C.ProvenAgentScenario(**SCENARIO, map_proofs=[PROOF])
    assert C.ProvenRunStarted(**STARTED, map_proof=PROOF)
    event = dict(t='event', code='RUN_STARTED', severity='INFO', robot_at=None,
                 data=STARTED, agent_instance_id=U, report_seq=1, monotonic_s=1.)
    assert C.AgentEvent(**event)  # old producer still readable in this contract-only PR
    with pytest.raises(ValidationError):
        C.DurableAgentEvent(**event)
    assert C.DurableAgentEvent(**{**event, 'data': {**STARTED, 'map_proof': PROOF}})


@pytest.mark.parametrize('change', [dict(image_sha256=U), dict(source_pgm_sha256=U),
    dict(image_sha256='A' * 64), dict(source_pgm_sha256=None), dict(origin=[0., 0.]),
    dict(origin=[0., float('inf'), 0.]), dict(origin=['0', 0., 0.]),
    dict(resolution=0), dict(resolution=True), dict(width=True), dict(height=0),
    dict(world_id=None), dict(ros_floor_id=''), dict(source='HUMAN')])
def test_map_proof_rejects_fake_hashes_invalid_geometry_and_unbound_world(change):
    with pytest.raises(ValidationError):
        C.RunMapProof(**{**PROOF, **change})


def test_map_proof_covers_finish_and_all_versions_without_duplicates():
    second = dict(POINT, floor_id=OTHER, map_version_id=OTHER)
    response = dict(SCENARIO, finish=dict(mode='GO_TO', target={k: second[k] for k in
        ('floor_id', 'map_version_id', 'x', 'y', 'yaw')}))
    for proofs in ([], [PROOF], [PROOF, PROOF]):
        with pytest.raises(ValidationError):
            C.ProvenAgentScenario(**response, map_proofs=proofs)
    # The data response preserves multi-floor references; the executor must reject travel.
    assert C.ProvenAgentScenario(**response, map_proofs=[PROOF,
        dict(PROOF, floor_id=OTHER, map_version_id=OTHER)])
    for proof in (dict(PROOF, floor_id=OTHER), dict(PROOF, map_version_id=OTHER),
                  dict(PROOF, source='HUMAN', world_id=None, ros_floor_id=None)):
        with pytest.raises(ValidationError):
            C.ProvenRunStarted(**STARTED, map_proof=proof)


@pytest.mark.parametrize('missing', ['agent_instance_id', 'report_seq', 'monotonic_s'])
def test_all_persistent_transitions_and_cause_events_require_identity(missing):
    payload = {k: v for k, v in REPORT.items() if k != missing}
    with pytest.raises(ValidationError):
        C.DurableAgentRunUpdate(**payload)
    event = dict(t='event', code='RUN_PAUSED', severity='WARN', robot_at=None,
                 data={'run_id': U}, **{k: REPORT[k] for k in
                    ('agent_instance_id', 'report_seq', 'monotonic_s') if k != missing})
    with pytest.raises(ValidationError):
        C.DurableAgentEvent(**event)


def test_new_persistent_statuses_and_rejection_failure_code():
    assert C.DurableAgentRunUpdate(**REPORT)
    for status in ('RUNNING', 'ABORTED'):
        with pytest.raises(ValidationError):
            C.DurableAgentRunUpdate(**{**REPORT, 'status': status, 'wait_reason': None})
    assert C.DurableAgentRunUpdate(**{**REPORT, 'status': 'FAILED', 'wait_reason': None,
                                     'fail_code': 'RECORDING_REJECTED'})
    with pytest.raises(ValidationError):
        C.DurableAgentEvent(t='event', code='RUN_PAUSED', severity='WARN', robot_at=None,
                           data={}, agent_instance_id=U, report_seq=1, monotonic_s=1.)


@pytest.mark.parametrize('code', get_args(C.RunReportTransientCode) + get_args(C.RunReportPermanentCode))
def test_report_rejection_is_correlated_and_distinct_from_commit_receipt(code):
    transient = code in get_args(C.RunReportTransientCode)
    frame = dict(t='run.report_rejected', agent_instance_id=U, report_seq=2, run_id=U,
                 code=code, disposition='RETRY' if transient else 'QUARANTINE')
    if code == 'RUN_REPORT_SEQUENCE':
        frame['expected_report_seq'] = 1
    parsed = TypeAdapter(C.ServerAgentMessage).validate_python(frame)
    assert isinstance(parsed, C.RunReportRejected) and not isinstance(parsed, C.RunRecorded)
    with pytest.raises(ValidationError):
        TypeAdapter(C.AgentMessage).validate_python(frame)
    with pytest.raises(ValidationError):
        C.RunReportRejected(**{**frame, 'disposition': 'QUARANTINE' if transient else 'RETRY'})
    if code == 'RUN_REPORT_SEQUENCE':
        with pytest.raises(ValidationError):
            C.RunReportRejected(**{k: v for k, v in frame.items() if k != 'expected_report_seq'})
    else:
        with pytest.raises(ValidationError):
            C.RunReportRejected(**frame, expected_report_seq=0)
    for field in ('agent_instance_id', 'report_seq', 'run_id'):
        with pytest.raises(ValidationError):
            C.RunReportRejected(**{k: v for k, v in frame.items() if k != field})
    with pytest.raises(ValidationError):
        C.RunReportRejected(**{**frame, 'code': 'FUTURE_REJECTION'})

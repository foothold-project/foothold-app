"""Live diagnostics and GLIM preview reach GET independently of the saved map."""
from datetime import timedelta

from sqlalchemy.orm import Session

from apps.server.fh_server import mapping
from apps.server.fh_server.models import MappingSession, now
from .test_slam_mapping import start, report, current, setup, maps  # noqa: F401


def sources():
    return dict(point_lio=dict(active=True, fresh=True, pose_age_s=.1, cloud_age_s=.2,
        position_valid=True, reason_code=None, reason=None, position_m=[1.23, -2.34, .3], pose_hz=10, cloud_hz=10),
        glim=dict(stage='RECEIVING', data_age_s=.3, processed_chunks=None, gpu=None),
        reported_at='2099-01-01T00:00:00Z')  # agent cannot forge receipt freshness


def preview(seq=1):
    return dict(source='glim', seq=seq, frame_id='glim_map', stamp=dict(sec=42, nanosec=0),
        resolution=.25, cells=[[-5, 16, 1]])


def test_sources_preview_survive_get_without_replacing_live_revision(setup, monkeypatch):
    initial = start(setup)
    received = now()
    monkeypatch.setattr(mapping, 'now', lambda: received)
    assert report(setup, initial, sources=sources(), glim_preview=preview(),
        voxels=dict(revision=1, seq=1, reset=True, frame_id='pointlio_map', added=[[1, 2, 3]])).status_code == 202
    body = current(setup)
    assert body['source'] == 'point_lio' and body['revision'] == 1 and body['slam_save'] is None
    assert body['glim_preview'] == preview()
    assert body['sources']['point_lio']['fresh']
    assert body['sources']['point_lio']['position_m'] == [1.23, -2.34, .3]
    assert body['sources']['reported_at'].startswith(str(received.year))
    # Intermediate 4 Hz reports omit the 1 Hz GLIM snapshot; latest is retained.
    assert report(setup, initial, update_seq=2, sources=sources()).status_code == 202
    assert current(setup)['glim_preview'] == preview()
    assert report(setup, initial, update_seq=3, sources=sources(), glim_preview=preview(2)).status_code == 202
    assert current(setup)['glim_preview'] == preview(2)
    monkeypatch.setattr(mapping, 'now', lambda: received+timedelta(seconds=.35))
    assert not current(setup)['sources']['point_lio']['fresh']  # .2 + .35 > .5, despite recent receipt
    # GET ages grow even when no more agent observations arrive.
    monkeypatch.setattr(mapping, 'now', lambda: received+timedelta(seconds=2))
    body = current(setup)
    point = body['sources']['point_lio']
    assert point['pose_age_s'] == 2.1 and point['cloud_age_s'] == 2.2
    assert not point['fresh'] and point['reason_code'] == 'STALE'
    assert point['pose_hz'] == point['cloud_hz'] == 0
    assert body['sources']['glim']['data_age_s'] == 2.3
    # Reading never writes the computed ages back and compounds them.
    assert current(setup)['sources']['point_lio']['pose_age_s'] == 2.1


def test_start_refusal_diagnostics_and_sequence_gates(setup):
    initial = start(setup)
    diagnostic = sources()
    diagnostic['point_lio'].update(fresh=False, position_valid=False, reason_code='POSITION_OUT_OF_RANGE',
        reason='위치가 허용 좌표 범위를 벗어났습니다.', position_m=[30000, 0, .3])
    diagnostic['glim']['stage'] = 'OFF'
    assert report(setup, initial, status='UNKNOWN', phase='UNKNOWN', sources=diagnostic,
        error_code='MAPPING_SERVICES_FAILED').status_code == 202
    body = current(setup)
    assert body['status'] == 'UNKNOWN'
    assert body['sources']['point_lio']['reason_code'] == 'POSITION_OUT_OF_RANGE'
    # A stale or wrong-command report cannot overwrite the diagnostic/latest preview.
    assert report(setup, initial, sources=sources(), glim_preview=preview()).status_code == 202
    assert current(setup)['sources']['point_lio']['reason_code'] == 'POSITION_OUT_OF_RANGE'
    with Session(setup[-1]) as db:
        row = db.get(MappingSession, initial['session_id'])
        assert row.progress['sources']['point_lio']['position_m'][0] == 30000
        assert row.progress.get('glim_preview') is None


def test_preview_size_and_type_are_validated_at_ingress(setup):
    initial = start(setup)
    for invalid in ({**preview(), 'cells': [[0, 0, 0]]*1025},
                    {**preview(), 'cells': [[40001, 0, 0]]}, {**preview(), 'source': 'point_lio'}):
        assert report(setup, initial, sources=sources(), glim_preview=invalid).status_code == 422
    assert current(setup)['status'] == 'STARTING'

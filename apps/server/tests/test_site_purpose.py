"""SIM/REAL places, scenario boundaries and retained pre-migration assignments."""
import copy
from uuid import UUID

from alembic import command
from alembic.config import Config
import pytest
from sqlalchemy import create_engine, select, text
from sqlalchemy.orm import Session

from apps.server.fh_server import approvals
from apps.server.fh_server.api import APIError, fail
from apps.server.fh_server.models import Assignment, ScenarioVersion, User
from .conftest import CONFIG
from .legacy_approvals import pending_assignment
from .test_assignments import assignment, scenario
from .test_maps import P, auth, maps, save, upload  # noqa: F401


def purpose_floor(http, headers, purpose):
    site = http.post(P + '/sites', headers=headers, json={'name': purpose, 'purpose': purpose}).json()
    building = http.post(P + f'/sites/{site["id"]}/buildings', headers=headers, json={'name': '건물'}).json()
    floor = http.post(P + f'/buildings/{building["id"]}/floors', headers=headers,
                      json={'name': '1층', 'level': 1}).json()
    version = save(http, headers, floor['id'], upload(http, headers)).json()
    return site, floor, version


def test_site_create_default_explicit_tree_and_immutable_purpose(maps):
    http, headers, _ = maps
    default = http.post(P + '/sites', headers=headers, json={'name': '실기 기본 장소'})
    assert default.status_code == 201 and default.json()['purpose'] == 'REAL'
    sim = http.post(P + '/sites', headers=headers, json={'name': '시뮬 장소', 'purpose': 'SIM'})
    assert sim.status_code == 201 and sim.json()['purpose'] == 'SIM'
    assert http.post(P + '/sites', headers=headers, json={'name': '잘못된 장소', 'purpose': 'OTHER'}).status_code == 400
    path = P + '/sites/' + sim.json()['id']
    assert http.patch(path, headers=headers, json={'name': '새 이름'}).json()['purpose'] == 'SIM'
    assert http.patch(path, headers=headers, json={'name': '새 이름', 'purpose': 'REAL'}).status_code == 400
    tree = http.get(P + '/sites', headers=headers).json()['items']
    assert {s['id']: s['purpose'] for s in tree} == {default.json()['id']: 'REAL', sim.json()['id']: 'SIM'}
    assert http.delete(path, headers=headers).status_code == 204
    assert next(s for s in http.get(P + '/sites?archived=true', headers=headers).json()['items']
                if s['id'] == sim.json()['id'])['purpose'] == 'SIM'


@pytest.mark.parametrize('mixed_point', ['waypoint', 'finish'])
def test_mixed_scenario_create_update_and_preview_reject_atomically(maps, mixed_point):
    http, headers, _ = maps
    real, _, _, _ = scenario(http, headers)
    _, floor, version = purpose_floor(http, headers, 'SIM')
    body = {k: copy.deepcopy(real[k]) for k in ('name', 'waypoints', 'finish', 'notes')}
    point = {**body['waypoints'][0], 'floor_id': floor['id'], 'map_version_id': version['id']}
    if mixed_point == 'waypoint':
        body['waypoints'].append(point)
    else:
        body['finish'] = {'mode': 'GO_TO', 'target': {k: v for k, v in point.items()
            if k not in ('mission_id', 'mission_version')}}
    for method, path, extra in [('post', '/scenarios', {}), ('post', '/scenarios/preview', {}),
                                ('put', '/scenarios/' + real['id'], {'If-Match': '"1"'})]:
        denied = getattr(http, method)(P + path, headers={**headers, **extra}, json=body)
        assert denied.status_code == 409, denied.text
        assert denied.json()['error']['code'] == 'SCENARIO_MIXED_PURPOSE'
        assert '시뮬 장소와 실기 장소' in denied.json()['error']['message']
    assert http.get(P + '/scenarios/' + real['id'], headers=headers).json()['number'] == 1
    assert len(http.get(P + '/scenarios', headers=headers).json()['items']) == 1


@pytest.mark.parametrize('robot_simulation', [False, True])
def test_sim_scenario_no_assignment_or_approval_real_unchanged(maps, seeded, robot_simulation):
    http, headers, _ = maps
    real, _, _, _ = scenario(http, headers)
    _, floor, version = purpose_floor(http, headers, 'SIM')
    # HUMAN map content on a SIM place still follows the place purpose.
    assert version['provenance'] == 'HUMAN'
    body = {k: copy.deepcopy(real[k]) for k in ('name', 'waypoints', 'finish', 'notes')}
    for point in body['waypoints']:
        point.update(floor_id=floor['id'], map_version_id=version['id'])
    sim = http.post(P + '/scenarios', headers=headers, json=body)
    assert sim.status_code == 201, sim.text
    sim = sim.json()
    engine = create_engine(seeded['urls']['migrate'])
    try:
        with engine.begin() as conn:
            conn.execute(text('UPDATE robots SET simulation=:sim WHERE id=:id'),
                         {'sim': robot_simulation, 'id': seeded['robots']['mine']})
        for actor in (headers, auth(http, 'one')):
            denied = assignment(http, actor, sim, seeded['robots']['mine'])
            assert denied.status_code == 409, denied.text
            assert denied.json()['error']['code'] == 'SIM_SCENARIO_NO_ASSIGN'
            assert denied.json()['error']['message'] == '시뮬 시나리오는 시뮬 탭에서 바로 실행합니다'
        # Exercise the approval-request boundary directly (there is no new
        # public approval-request endpoint). Roll back the rejected candidate.
        with Session(engine) as db:
            user = db.get(User, seeded['users']['one'])
            snapshot = db.scalar(select(ScenarioVersion).where(ScenarioVersion.scenario_id == UUID(sim['id'])))
            candidate = Assignment(org_id=user.org_id, scenario_version_id=snapshot.id,
                robot_id=seeded['robots']['mine'], status='PENDING', memo='', created_by=user.id)
            db.add(candidate)
            db.flush()
            with pytest.raises(APIError) as exc:
                approvals.request_assignment(db, user, candidate, fail)
            assert exc.value.status == 409 and exc.value.code == 'SIM_SCENARIO_NO_ASSIGN'
            db.rollback()
        assert http.get(P + '/assignments', headers=headers).json()['items'] == []
        assert http.get(P + '/approvals', headers=headers).json()['items'] == []
        allowed = assignment(http, auth(http, 'one'), real, seeded['robots']['mine'])
        assert allowed.status_code == 201 and allowed.json()['status'] == 'ACTIVE', allowed.text
    finally:
        engine.dispose()


def test_legacy_pending_assignment_cannot_approve_after_place_becomes_sim(maps, seeded):
    http, headers, _ = maps
    value, _, _, version = scenario(http, headers)
    assert version['provenance'] == 'HUMAN'
    pending = pending_assignment(http, auth(http, 'one'), value, seeded['robots']['mine'])
    engine = create_engine(seeded['urls']['migrate'])
    try:
        with engine.begin() as conn:
            assert conn.scalar(text('SELECT simulation FROM robots WHERE id=:id'),
                               {'id': seeded['robots']['mine']}) is False
            assert set(conn.scalars(text('SELECT purpose FROM sites WHERE org_id=:org'),
                                    {'org': seeded['org']})) == {'REAL'}
            # Reproduce 0026 reclassifying an existing HUMAN map's place.
            conn.execute(text("UPDATE sites SET purpose='SIM' WHERE org_id=:org"), {'org': seeded['org']})
        path = P + '/approvals/' + pending['approval_id']
        denied = http.post(path + '/approve', headers=headers)
        assert denied.status_code == 409, denied.text
        assert denied.json()['error']['code'] == 'APPROVAL_STALE'
        assert http.get(path, headers=headers).json()['status'] == 'STALE'
        assignments = http.get(P + '/assignments', headers=headers).json()['items']
        assert len(assignments) == 1 and assignments[0]['id'] == pending['id']
        assert assignments[0]['status'] == 'REJECTED'
        assert assignments[0]['approval_id'] == pending['approval_id']
        assert http.post(path + '/approve', headers=headers).json()['error']['code'] == 'ALREADY_DECIDED'
    finally:
        engine.dispose()


def test_purpose_migration_roundtrip_preserves_existing_assignment(maps, seeded, monkeypatch):
    http, headers, _ = maps
    value, _, _, _ = scenario(http, headers)
    created = assignment(http, auth(http, 'one'), value, seeded['robots']['mine'])
    assert created.status_code == 201, created.text
    archived = http.post(P + '/sites', headers=headers, json={'name': '보관 장소'}).json()['id']
    assert http.delete(P + '/sites/' + archived, headers=headers).status_code == 204
    monkeypatch.setenv('FH_MIGRATE_DATABASE_URL', seeded['urls']['migrate'])
    config = Config(str(CONFIG))
    engine = create_engine(seeded['urls']['migrate'])
    try:
        command.downgrade(config, '0025')
        with engine.begin() as conn:
            # Also covers a different tenant; all old sites move, with no filter.
            foreign_org = conn.scalar(text('SELECT org_id FROM users WHERE id=:id'), {'id': seeded['users']['foreign']})
            conn.execute(text("INSERT INTO sites(org_id,name) VALUES (:org,'다른 조직 장소')"), {'org': foreign_org})
            old_sites = conn.execute(text('SELECT id, org_id, name, archived_at FROM sites ORDER BY id')).all()
            old_assignments = conn.execute(text('SELECT * FROM assignments ORDER BY id')).all()
        command.upgrade(config, 'head')
        with engine.begin() as conn:
            assert conn.execute(text('SELECT id, org_id, name, archived_at FROM sites ORDER BY id')).all() == old_sites
            assert set(conn.scalars(text('SELECT purpose FROM sites'))) == {'SIM'}
            assert conn.execute(text('SELECT * FROM assignments ORDER BY id')).all() == old_assignments
            assert len(old_assignments) == 1
            assert conn.scalar(text("INSERT INTO sites(org_id,name) VALUES (:org,'새 기본 장소') RETURNING purpose"),
                               {'org': seeded['org']}) == 'REAL'
        for purpose in ('OTHER', None):
            from sqlalchemy.exc import IntegrityError
            with engine.begin() as conn, pytest.raises(IntegrityError):
                conn.execute(text('UPDATE sites SET purpose=:purpose'), {'purpose': purpose})
        # Existing assignment remains readable and can be removed; no new SIM assignment.
        listed = http.get(P + '/assignments', headers=headers).json()['items']
        assert [r['id'] for r in listed] == [created.json()['id']]
        denied = assignment(http, headers, value, seeded['robots']['theirs'])
        assert denied.status_code == 409 and denied.json()['error']['code'] == 'SIM_SCENARIO_NO_ASSIGN'
        assert http.delete(P + '/assignments/' + created.json()['id'], headers=headers).status_code == 204
        command.downgrade(config, '0025')
        command.upgrade(config, 'head')
    finally:
        engine.dispose()

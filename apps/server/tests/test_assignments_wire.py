"""S5b real uvicorn integration; no robot transport or execution."""
import httpx
from .test_assignments import scenario, assignment, listing
from .test_maps import P, auth, FEATURES
from .ws_process import server_process


def test_uvicorn_assignment_direct_remove_and_idempotent_map_save(seeded, tmp_path, monkeypatch):
    monkeypatch.setenv('FH_FILES_ROOT', str(tmp_path / 'files'))
    with server_process(seeded, tmp_path) as server:
        with httpx.Client(base_url=server['base'].replace('ws://', 'http://'), timeout=15) as http:
            admin, one = auth(http), auth(http, 'one')
            value, floor, image, version = scenario(http, admin)
            created = assignment(http, {**one, 'Idempotency-Key': 'wire-assignment'}, value, seeded['robots']['mine'])
            assert created.status_code == 201 and created.json()['status'] == 'ACTIVE', created.text
            row = created.json()
            repeated = assignment(http, {**one, 'Idempotency-Key': 'wire-assignment'}, value, seeded['robots']['mine'])
            assert repeated.status_code == 201 and repeated.json() == row
            assert row['approval_id'] is None
            assert listing(http, one)[0]['status'] == 'ACTIVE'
            assert http.delete(P + '/assignments/' + row['id'], headers=one).status_code == 204
            assert listing(http, one)[0]['status'] == 'REMOVED'
            headers = {**one, 'Idempotency-Key': 'wire-map'}
            body = {'base_version_id': version['id'], 'image': image, 'features': FEATURES, 'reason': 'HTTP 재요청'}
            responses = [http.post(P + f'/floors/{floor}/map-versions', headers=headers, json=body) for _ in range(2)]
            assert [r.status_code for r in responses] == [201, 201]
            assert responses[0].json() == responses[1].json()
            pending = http.get(P + '/approvals?status=PENDING', headers=admin).json()['items']
            assert pending == [] and responses[0].json()['status'] == 'APPROVED'
            print('S5b uvicorn: operator ACTIVE -> REMOVED; same map key twice -> one APPROVED map, no requests: PASS')

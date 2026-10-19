import subprocess
import sys
from datetime import datetime, timezone

import pytest
from pydantic import ValidationError

from apps.contracts.models import Event
from apps.contracts import generate, models as C


def test_generated_contracts_current():
    subprocess.run([sys.executable, 'apps/contracts/generate.py', '--check'], check=True)


def test_event_bigint_decimal_string_and_aware_time():
    payload = dict(id='18446744073709551615', at=datetime.now(timezone.utc), robot_at=None,
        category='ACCOUNT', code='LOGIN', severity='INFO', message='로그인했습니다.',
        robot_id=None, user_id=None, run_id=None, data={})
    assert Event(**payload).model_dump(mode='json')['id'] == '18446744073709551615'
    with pytest.raises(ValidationError):
        Event(**{**payload, 'id': 18446744073709551615})
    with pytest.raises(ValidationError):
        Event(**{**payload, 'at': datetime(2026, 1, 1)})


def test_b3_nested_contract_timestamps_normalize_to_utc():
    from datetime import timedelta
    instant = datetime(2026, 10, 19, 14, 2, tzinfo=timezone(timedelta(hours=9)))
    battery = C.Battery(soc=82, updated_at=instant)
    lease = C.Lease(holder_type='USER', user=None, since=instant)
    event = C.Event(id='1', at=instant, robot_at=instant, category='LINK', code='FAKE',
                    severity='INFO', message='시험', robot_id=None, user_id=None, run_id=None, data={})
    assert battery.model_dump(mode='json')['updated_at'] == '2026-10-19T05:02:00Z'
    assert lease.model_dump(mode='json')['since'] == '2026-10-19T05:02:00Z'
    assert event.model_dump(mode='json')['at'] == event.model_dump(mode='json')['robot_at'] == '2026-10-19T05:02:00Z'


def test_r4_response_schema_has_required_serialized_defaults():
    import json
    files = generate.build()
    settings = json.loads(files['schema/OrgSettings.json'])
    assert set(settings['required']) == set(settings['properties'])
    response = json.loads(files['schema/LoginResponse.json'])
    assert {'csrf_token', 'access_token', 'refresh_token'} <= set(response['required'])
    body = json.loads(files['schema/ErrorBody.json'])
    assert 'detail' in body['required']
    assert 'export interface Error {' not in files['ts/index.ts']
    assert 'export interface ErrorBody {' in files['ts/index.ts']


@pytest.mark.parametrize('model', [C.MePatch, C.UserPatch, C.OrgSettingsPatch])
def test_r4_patch_fields_omit_but_do_not_accept_null(model):
    schema = model.model_json_schema(mode='validation')
    assert model().model_dump(exclude_unset=True) == {}
    assert not schema.get('required')
    for field, spec in schema['properties'].items():
        assert spec.get('type') != 'null'
        assert all(item.get('type') != 'null' for item in spec.get('anyOf', []))
        assert 'default' not in spec
        with pytest.raises(ValidationError):
            model(**{field: None})


@pytest.mark.parametrize('extra', ['schema/Old.json', 'ts/old.ts', 'ts/nested/old.ts'])
def test_r5_check_detects_extra_generated_files(tmp_path, monkeypatch, extra, capsys):
    monkeypatch.setattr(generate, 'OUT', tmp_path)
    monkeypatch.setattr(sys, 'argv', ['generate.py'])
    assert generate.main() == 0
    old = tmp_path / extra
    old.parent.mkdir(exist_ok=True, parents=True)
    old.write_text('{}')
    monkeypatch.setattr(sys, 'argv', ['generate.py', '--check'])
    assert generate.main() == 1
    assert extra in capsys.readouterr().out
    monkeypatch.setattr(sys, 'argv', ['generate.py'])
    assert generate.main() == 0
    assert not old.exists()

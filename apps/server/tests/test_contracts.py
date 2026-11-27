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
    # Additive settings stay optional for clients with an older response shape.
    assert set(settings['required']) == {'battery_low_pct', 'run_min_battery_pct',
        'deviation_m', 'lease_request_timeout_s', 'link_loss_wait_s'}
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


def test_gait_mode_messages_accept_four_gaits_only():
    from pydantic import TypeAdapter
    from uuid import uuid4
    screen, agent = TypeAdapter(C.ScreenMessage), TypeAdapter(C.ServerAgentMessage)
    for gait in ('classic', 'sport', 'start', 'ame2'):
        assert screen.validate_python({'t': 'gait', 'id': 'g1', 'robot': str(uuid4()), 'lease_id': str(uuid4()), 'gait': gait}).gait == gait
        assert isinstance(agent.validate_python({'t': 'gait', 'request_id': 'r1', 'lease_id': str(uuid4()), 'gait': gait}), C.AgentGait)
    with pytest.raises(ValidationError):
        screen.validate_python({'t': 'gait', 'id': 'g1', 'robot': str(uuid4()), 'lease_id': str(uuid4()), 'gait': 'free_walk'})
    # 모르는 code 하나로 상태 프레임이 버려지면 안 된다 (열린 문자열 · 64 자 상한)
    assert C.GaitResult(request_id='r1', gait='ame2', status='REJECTED', code='GAIT_SOMETHING_NEW', sdk_code=None).sdk_code is None
    with pytest.raises(ValidationError):
        C.GaitResult(request_id='r1', gait='ame2', status='REJECTED', code='x' * 65, sdk_code=None)
    assert C.GaitState(gait='classic', available=['classic', 'start']).available == ['classic', 'start']
    for bad in (['start', 'classic'], ['classic', 'classic']):
        with pytest.raises(ValidationError):
            C.GaitState(gait=None, available=bad)

import subprocess
import sys
from datetime import datetime, timezone

import pytest
from pydantic import ValidationError

from apps.contracts.models import Event


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

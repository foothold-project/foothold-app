"""tools/seed_org_settings: 시안 html 에서 읽은 값과 API 로 보내는 꼴 (팀장 11/28 20:23)."""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from apps.contracts import models as C  # noqa: E402
from tools import seed_org_settings as seed  # noqa: E402

CROWD = ('<span style="width:28px">월</span><div class="tl2"><b style="left:218.75px;width:61.24999999999994px">출근</b>'
         '<b style="left:525.0px;width:87.5px">점심</b></div>'
         '<span style="width:28px">일</span><div class="tl2"></div>'
         '<div class="step"><span>−</span><b>4 시간</b><span>+</span></div>')
DISPLAY = '<span class="sw"></span><div>데모 로봇 표시</div><span class="sw on"></span>'


def write(tmp_path, crowd=CROWD, display=DISPLAY):
    (tmp_path / 'u9_8_crowd.html').write_text(crowd, encoding='utf-8')
    (tmp_path / 'u9_6_display.html').write_text(display, encoding='utf-8')
    return tmp_path


def test_reads_bars_as_clock_times_switch_and_hours(tmp_path):
    payload = seed.from_proto(write(tmp_path))
    assert payload == {'show_demo_label': True, 'dup_inspect_min': 240, 'busy_hours': [
        {'day': 'mon', 'start': '08:30', 'end': '09:12', 'label': '출근'},
        {'day': 'mon', 'start': '12:00', 'end': '13:00', 'label': '점심'}]}
    C.OrgSettingsPatch.model_validate(payload)


def test_switch_off_and_missing_parts_fail(tmp_path):
    assert seed.from_proto(write(tmp_path, display=DISPLAY.replace('sw on', 'sw')))['show_demo_label'] is False
    with pytest.raises(SystemExit):
        seed.from_proto(write(tmp_path, crowd=CROWD.replace('4 시간', '')))


@pytest.mark.skipif(not seed.PROTO_DIR.is_dir(), reason='시안 폴더 없음')
def test_real_proto_values_are_valid_patch():
    payload = seed.from_proto(seed.PROTO_DIR)
    C.OrgSettingsPatch.model_validate(payload)
    assert len(payload['busy_hours']) == 17 and payload['dup_inspect_min'] == 240


def test_seed_logs_in_as_admin_patches_once_and_logs_out():
    calls = []
    payload = {'show_demo_label': True, 'busy_hours': [], 'dup_inspect_min': 240}
    def send(method, path, body, token):
        calls.append((method, path, token))
        if path.endswith('/login'):
            return 200, {'role': 'ORG_ADMIN', 'access_token': 't'}
        return (200, {**payload, 'battery_low_pct': 20}) if method == 'PATCH' else (204, None)
    assert seed.seed(send, 'admin', 'pw', payload) == payload
    assert calls == [('POST', '/api/v1/auth/login', None), ('PATCH', '/api/v1/org/settings', 't'),
                     ('POST', '/api/v1/auth/logout', 't')]


def test_seed_refuses_operator():
    def send(method, path, body, token):
        assert method == 'POST'
        return 200, {'role': 'OPERATOR', 'access_token': 't'}
    with pytest.raises(SystemExit):
        seed.seed(send, 'one', 'pw', {})

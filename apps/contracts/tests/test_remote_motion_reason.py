"""#511·#512 에이전트가 리모컨 순정 모드 중 보내는 장치 상태 까닭을 서버가 받는다 (11/27 실기: 거절돼 연결이 끊김)."""
from apps.contracts import models as C


def test_device_status_reason_remote_motion_state_is_valid():
    device = C.Device.model_validate({'key': 'go2-sport', 'kind': 'OTHER', 'label': 'sport', 'state': 'OK',
                                      'status_code': {'raw': 2010, 'level': 'ACCEPTED', 'reason': 'REMOTE_MOTION_STATE'}})
    assert device.status_code.reason == 'REMOTE_MOTION_STATE'

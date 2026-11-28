"""u08 robot side of the phone-shown QR: fake HTTP only, no camera or real robot."""
import pytest

from foothold_agent.setup.pairing import Pairing, offer_code, read_offer_qr_from_front_camera

CODE = 'Ab3_-' + 'x' * 19
PID = '8b6f1d3e-1c2a-4f5b-9e7d-0a1b2c3d4e5f'


def test_offer_code_accepts_only_offer_qr():
    assert offer_code('foothold-offer:' + CODE) == CODE
    for bad in ['foothold-pair:123456', 'foothold-offer:' + CODE[:-1], 'foothold-offer:' + CODE + '!',
                'foothold-offer:https://evil/' + CODE, None, 42]:
        with pytest.raises(ValueError):
            offer_code(bad)


def test_claim_offer_then_poll_uses_existing_path():
    calls = []

    def post(path, body):
        calls.append((path, body))
        if path.endswith('/offer/claim'):
            return {'pairing_id': PID, 'expires_at': '2026-11-28T00:05:00Z', 'poll_secret': 's' * 43}
        return {'state': 'waiting'}
    pairing = Pairing('https://server.invalid', post=post, wall=lambda: 1795824000.0)
    pairing.claim_offer('foothold-offer:' + CODE, '1234-5678')
    assert calls[0] == ('/api/v1/pairing/offer/claim', {'code': CODE, 'robot_serial': '1234-5678'})
    assert pairing.poll('1234-5678') is None
    assert calls[1] == (f'/api/v1/pairing/{PID}/poll', {'poll_secret': 's' * 43})


def test_claim_offer_rejects_bad_reply():
    pairing = Pairing('https://server.invalid', wall=lambda: 1795824000.0,
                      post=lambda p, b: {'pairing_id': PID, 'expires_at': '2026-11-28T00:05:00Z', 'poll_secret': 'short'})
    with pytest.raises(ValueError):
        pairing.claim_offer('foothold-offer:' + CODE, '1234-5678')


def test_front_camera_reader_is_a_stub():
    with pytest.raises(NotImplementedError):
        read_offer_qr_from_front_camera()

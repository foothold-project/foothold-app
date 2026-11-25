from foothold_agent.policy.fall_watch import FallWatch

LEVEL = (0., 0., -1.)


def run(seq, hz=50):
    w, out = FallWatch(), []
    for i, g in enumerate(seq):
        ev = w.update(g, i / hz)
        if ev:
            out.append(ev['code'])
    return out


def test_backflip_like_1124_1855_is_one_fall_then_recovered():
    # 11/24 18:55 R2+Y Love: 뒷다리 서기 → 뒤로 뒤집힘 → 옆으로 구름 → 스스로 일어섬
    seq = [LEVEL] * 50 + [(-.98, .03, .22)] * 25 + [(.08, .05, 1.)] * 75 + [(.06, .83, .56)] * 25 + [LEVEL] * 100
    assert run(seq) == ['FACTORY_FALL', 'FACTORY_FALL_RECOVERED']


def test_hind_leg_stand_is_not_a_fall():
    # 11/24 18:39~18:53 · 11/25 11:11: 몸 약 100° 세움 4~5 s (grav ≈ [-0.98, 0, 0.2~0.33])
    assert run([LEVEL] * 50 + [(-.97, .0, .33)] * 260 + [LEVEL] * 100) == []


def test_side_roll_needs_half_a_second():
    assert run([LEVEL] * 10 + [(.0, .95, .3)] * 20 + [LEVEL] * 10) == []
    assert run([LEVEL] * 10 + [(.0, .95, .3)] * 30 + [LEVEL] * 60) == ['FACTORY_FALL', 'FACTORY_FALL_RECOVERED']

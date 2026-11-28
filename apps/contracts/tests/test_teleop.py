"""손 조종 한 식: 키보드 · 화면 조이스틱 · 폰 손잡이 · 실기 리모컨이 같은 입력에 같은 속도를 낸다 (팀장 11/28 23:08)."""
import json
import math
import shutil
import subprocess
from pathlib import Path

import pytest

from apps.contracts import teleop
from apps.contracts.models import OrgSettings

TS = Path(__file__).resolve().parents[1] / 'teleop.ts'
DEFAULT = OrgSettings().model_dump()
SIM = teleop.teleop_caps(DEFAULT, simulation=True)
REAL = teleop.teleop_caps(DEFAULT, simulation=False)
GATE = teleop.deadzone(DEFAULT)


def ts_run(calls):
    """teleop.ts 를 node 로 직접 불러 (형 지우기) 같은 호출을 돌린다."""
    if shutil.which('node') is None:
        pytest.skip('node 없음')
    script = ("import * as t from " + json.dumps(TS.as_uri()) + ";\n"
              "import { readFileSync } from 'node:fs';\n"
              "const calls = JSON.parse(readFileSync(0, 'utf8'));\n"
              "const out = calls.map(([fn, ...args]) => t[fn](...args));\n"
              "process.stdout.write(JSON.stringify(out));\n")
    done = subprocess.run(['node', '--no-warnings', '--input-type=module', '-e', script],
                          input=json.dumps(calls), capture_output=True, text=True, check=True, timeout=30)
    return json.loads(done.stdout)


def test_ceilings_are_org_settings_upper_bounds():
    def le(name):
        return next(m.le for m in OrgSettings.model_fields[name].metadata if hasattr(m, 'le'))
    assert teleop.SIM_CEILING == {'max_vx': le('sim_max_vx'), 'max_vx_back': le('sim_max_vx'),
                                  'max_vy': le('sim_max_vy'), 'max_wz': le('sim_max_wz')}
    assert teleop.REAL_CEILING == {'max_vx': le('real_max_vx'), 'max_vx_back': le('real_max_vx_back'),
                                   'max_vy': le('real_max_vy'), 'max_wz': le('real_max_wz')}
    assert teleop.DEFAULT_DEADZONE == OrgSettings.model_fields['stick_deadzone'].default
    # 기본 설정이면 상한 = 위 끝 (시뮬 후진도 전진과 같은 1.5)
    assert SIM == teleop.SIM_CEILING and REAL == teleop.REAL_CEILING and GATE == .1


@pytest.mark.parametrize('stick,expected', [
    ((1, 0, 0), (1.5, 0, 0)), ((-1, 0, 0), (-1.5, 0, 0)),          # 전진 · 후진 끝
    ((0, 1, 0), (0, .5, 0)), ((0, -1, 0), (0, -.5, 0)),             # 옆 끝
    ((0, 0, 1), (0, 0, 1.2)), ((0, 0, -1), (0, 0, -1.2)),           # 돌기 끝 (제자리)
    ((.5, 0, 0), (.375, 0, 0)), ((-.5, 0, 0), (-.375, 0, 0)),       # 제곱: 반 = 1/4
    ((0, .5, .5), (0, .25, .6)),                                    # 옆 · 돌기는 직선
    ((.099, -.099, .099), (0, 0, 0)), ((.1, 0, 0), (.015, 0, 0)),   # 문턱 0.1 안은 0, 문턱 값은 늘리지 않음
    ((2, -3, 9), (1.5, -.5, 1.2)), ((math.nan, math.inf, 'x'), (0, 0, 0)),
])
def test_stick_velocity_sim_defaults(stick, expected):
    got = teleop.stick_velocity(stick, SIM, GATE)
    assert got == pytest.approx(expected, abs=1e-12)


def test_forward_square_curve_matches_start_remote_table():
    """REMOTE.md 2 절 · lowlevel.remote_want 설명: 1/3 → 0.17, 2/3 → 0.67, 끝 → 1.5 (상한 1.5)."""
    v = [teleop.stick_velocity((s, 0, 0), REAL, .05)[0] for s in (1 / 3, 2 / 3, 1)]
    assert [round(x, 2) for x in v] == [.17, .67, 1.5]


KEYSETS = [(), ('forward',), ('back',), ('left',), ('right',), ('turn_left',), ('turn_right',),
           ('forward', 'turn_left'), ('back', 'right'), ('forward', 'back'), ('left', 'right', 'turn_right')]
SETTINGS = [DEFAULT, {**DEFAULT, 'sim_key_vx': .6, 'sim_max_vx': 1.2, 'sim_max_vy': .3, 'sim_max_wz': .8,
                      'stick_deadzone': .2}]


def table():
    rows = []
    for s in SETTINGS:
        for simulation in (True, False):
            caps, gate = teleop.teleop_caps(s, simulation=simulation), teleop.deadzone(s)
            for keys in KEYSETS:
                stick = teleop.key_stick(keys, caps, s['sim_key_vx'])
                rows.append((s, simulation, keys, stick, teleop.stick_velocity(stick, caps, gate)))
            for stick in [(f, y, t) for f in (-1, -.6, -.1, 0, .05, .3, 1) for y in (-1, 0, .4) for t in (-.7, 0, 1)]:
                rows.append((s, simulation, None, stick, teleop.stick_velocity(stick, caps, gate)))
    return rows


def test_keyboard_screen_stick_and_phone_handle_give_one_table():
    """한 표: 키보드 (키 → 막대 → 속도, Python) · 화면 조이스틱 (TS keyStick 위치 → stickVelocity) ·
    폰 손잡이 (같은 막대 값 그대로 → TS stickVelocity). 세 칸이 비트 단위로 같아야 한다."""
    rows = table()
    calls = []
    for s, simulation, keys, stick, _ in rows:
        calls += [['teleopCaps', s, simulation], ['deadzone', s]]
        if keys is not None:
            calls.append(['keyStick', list(keys), teleop.teleop_caps(s, simulation=simulation), s['sim_key_vx']])
        calls.append(['stickVelocity', list(stick), teleop.teleop_caps(s, simulation=simulation), teleop.deadzone(s)])
    out = iter(ts_run(calls))
    for s, simulation, keys, stick, keyboard in rows:
        caps, gate = next(out), next(out)
        assert caps == teleop.teleop_caps(s, simulation=simulation) and gate == teleop.deadzone(s)
        if keys is not None:
            screen_stick = next(out)
            assert screen_stick == list(stick), (keys, simulation)   # 키를 누르면 화면 막대가 그 위치로
        phone = next(out)
        assert phone == list(keyboard), (keys, stick, simulation)


def test_keyboard_forward_reaches_key_speed_and_moves_stick():
    s = {**DEFAULT, 'sim_key_vx': .6}
    caps = teleop.teleop_caps(s, simulation=True)
    stick = teleop.key_stick(['forward'], caps, .6)
    assert stick[0] == pytest.approx(math.sqrt(.6 / 1.5)) and stick[1:] == (0, 0)
    assert teleop.stick_velocity(stick, caps, GATE)[0] == pytest.approx(.6)
    back = teleop.key_stick(['back'], caps, .6)
    assert teleop.stick_velocity(back, caps, GATE)[0] == pytest.approx(-.6)
    assert teleop.stick_velocity(teleop.key_stick(['left', 'turn_right'], caps, .6), caps, GATE) == (0, .5, -1.2)


def test_real_caps_follow_org_real_fields():
    caps = teleop.teleop_caps({'real_max_vx': .8, 'real_max_vx_back': .4, 'real_max_vy': 0, 'real_max_wz': 9},
                              simulation=False)
    assert caps == {'max_vx': .8, 'max_vx_back': .4, 'max_vy': 0, 'max_wz': 2.5}
    assert teleop.stick_velocity((-1, 1, 0), caps, .1) == (-.4, 0, 0)


def test_same_formula_as_real_start_remote():
    """실기 START 실행기 리모컨 (lowlevel.remote_want) 과 같은 상한 · 문턱이면 같은 값."""
    pytest.importorskip('numpy')
    lowlevel = pytest.importorskip('foothold_agent.policy.lowlevel')
    caps = {'max_vx': lowlevel.FWD_TOP, 'max_vx_back': -lowlevel.CAPS['vx'][0],
            'max_vy': lowlevel.CAPS['vy'][1], 'max_wz': lowlevel.CAPS['wz'][1]}
    grid = (-1, -.7, -1 / 3, -.05, -.049, 0, .049, .05, .2, 1 / 3, .5, 2 / 3, .9, 1)
    for lx in grid:
        for ly in grid:
            for rx in (-1, -.3, 0, .04, .6, 1):
                want = lowlevel.remote_want(lowlevel.Remote(frozenset(), lx, ly, rx, 0.))
                got = teleop.stick_velocity((ly, -lx, -rx), caps, lowlevel.STICK_DEADBAND)
                assert got == pytest.approx(want, abs=1e-12), (lx, ly, rx)

"""Joint / temperature replay from real trace slices, and drain-rate fitting."""
import json
import os

import pytest

from foothold_agent.demo import measure, replay

FIXTURE = os.path.join(os.path.dirname(__file__), 'fixtures', 'demo', 'trace-slices.jsonl')
# runner_cpp/src/core.cpp: to_policy order {3,0,9,6,4,1,10,7,5,2,11,8}
RUNNER_TO_POLICY = (3, 0, 9, 6, 4, 1, 10, 7, 5, 2, 11, 8)


def rows():
    with open(FIXTURE, encoding='utf-8') as fh:
        return [json.loads(line) for line in fh if '"phase"' in line]


def test_fixture_is_small_and_names_its_real_sources():
    assert os.path.getsize(FIXTURE) < 200_000
    with open(FIXTURE, encoding='utf-8') as fh:
        header = json.loads(fh.readline())
    assert {s['file'] for s in header['sources']} == {
        'start-20261124-153708-000.jsonl', 'factory-auto-20261125-141051-002.jsonl'}


def test_to_sdk_inverts_the_runner_policy_order():
    sdk = list(range(12))
    policy = [sdk[i] for i in RUNNER_TO_POLICY]
    assert measure.to_sdk(policy) == sdk


def test_activity_classes_on_real_rows():
    kinds = [measure.activity(r) for r in rows()]
    assert {'walk', 'stand', 'lie'} <= set(kinds)
    walking = [r for r in rows() if measure.activity(r) == 'walk']
    assert all(r['phase'] == 'policy' for r in walking)
    lying = [r for r in rows() if measure.activity(r) == 'lie']
    assert all(r['sport']['height'] < measure.LIE_HEIGHT_M for r in lying)


def test_index_cuts_clips_by_activity_in_sdk_order_with_real_values():
    library = replay.index([FIXTURE])
    clips = library['clips']
    assert [len(clips[k]) for k in ('lie', 'stand', 'walk')] == [1, 1, 1]
    walk = clips['walk'][0]
    first = next(r for r in rows() if measure.activity(r) == 'walk')
    assert walk['q'][0] == [round(v, 4) for v in measure.to_sdk(first['q'])]
    assert walk['temp'][0] == [int(v) for v in measure.to_sdk(first['temp'])]
    assert walk['seconds'] > 20 and len(walk['q']) > 200
    # every stored temperature is a recorded value, inside the real range
    assert all(19 <= v <= 74 for c in sum(clips.values(), []) for t in c['temp'] for v in t)
    assert library['sources'] == ['trace-slices.jsonl']


def test_player_plays_matching_activity_and_switches_without_temperature_jump(tmp_path):
    library = replay.index([FIXTURE])
    path = str(tmp_path / 'lib.json')
    replay.write(library, path)
    player = replay.Player(replay.load(path))
    first = player.advance('walk', 0)
    assert first['activity'] == 'walk' and first['t'] == library['clips']['walk'][0]['t0']
    assert first['positions'] == library['clips']['walk'][0]['q'][0]
    later = player.advance('walk', 1.0)
    assert later['positions'] == library['clips']['walk'][0]['q'][10]
    standing = player.advance('stand', 0.1)
    assert standing['activity'] == 'stand' and standing['positions'] == library['clips']['stand'][0]['q'][0]
    lying = player.advance('lie', 0.1)
    assert lying['positions'] == library['clips']['lie'][0]['q'][0]
    for _ in range(200):  # past the clip end: next recorded clip, never synthesized
        sample = player.advance('lie', 0.1)
        assert sample['positions'] in library['clips']['lie'][0]['q']


def test_player_falls_back_to_stand_when_an_activity_was_never_recorded():
    library = replay.index([FIXTURE])
    library['clips']['lie'] = []
    player = replay.Player(library)
    assert player.advance('lie', 0)['activity'] == 'stand' and player.fallbacks == 1


def test_fit_recovers_known_rates():
    truth = {'lie': 20.0, 'stand': 30.0, 'walk': 90.0}
    mixes = [(1, 0, 0), (0, 1, 0), (0.2, 0.5, 0.3), (0, 0.4, 0.6), (0.5, 0.5, 0)]
    fake = []
    for n, (a, b, c) in enumerate(mixes):
        seconds = dict(lie=a * 1800, stand=b * 1800, walk=c * 1800)
        drop = sum(truth[k] * s / 3600 for k, s in seconds.items())
        fake.append(dict(file=f'f{n}', hours=0.5, soc0=100, soc1=100 - drop, seconds=seconds))
    result = measure.fit(fake)
    assert result['rates'] == pytest.approx(truth)
    assert result['hours']['walk'] == pytest.approx(0.45)


def test_clip_choice_follows_the_last_reported_temperature():
    library = replay.index([FIXTURE])
    stand = library['clips']['stand'][0]
    cool = dict(stand, temp=[[25] * 12] * len(stand['temp']))
    hot = dict(stand, temp=[[50] * 12] * len(stand['temp']))
    library['clips']['stand'] = [cool, hot]
    library['clips']['walk'][0]['temp'] = [[48] * 12] * len(library['clips']['walk'][0]['temp'])
    player = replay.Player(library)
    player.advance('walk', 0)
    assert player.advance('stand', 0.1)['joint_temp'] == [50] * 12  # hot after a walk

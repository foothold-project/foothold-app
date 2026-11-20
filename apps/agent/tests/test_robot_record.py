"""Recorder reliability, private metadata and playback at the agent input boundary."""
import asyncio
import json
import sys
import struct
from types import SimpleNamespace as NS

import pytest

from foothold_agent.depth.discovery import IMAGE
from foothold_agent.record import analyze, capture, replay
from foothold_agent.record.journal import Journal
from foothold_agent.record.metrics import Metrics
from foothold_agent.record.storage import Chunks, Sample, samples
from foothold_agent.record.topics import CAMERA, LOW_TOPIC, SPORT_TOPIC, SYSTEM


def frame(t, topic=LOW_TOPIC, kind='low', data=b'123'):
    return Sample(t, t + 10**18, dict(topic=topic, kind=kind), data, len(data))


def test_rotates_for_time_and_size_drops_only_old_chunks_and_recovers_tail(tmp_path):
    chunks = Chunks(tmp_path, 500, 240, .5)
    for i in range(20):
        chunks.append(frame(i * 10**9, data=b'x' * 80))
        assert sum(path.stat().st_size for path in tmp_path.iterdir()) <= 500
    chunks.close()
    rows = list(samples(tmp_path))
    assert [r.mono for r in rows] == [i * 10**9 for i in range(17, 20)]
    with sorted(tmp_path.iterdir())[-1].open('ab') as stream:
        stream.write(b'incomplete')
    with pytest.warns(UserWarning, match='incomplete'):
        assert list(samples(tmp_path)) == rows
    with pytest.raises(ValueError, match='empty'):
        Chunks(tmp_path, 500, 240, .5)


def test_size_rotation_and_oversize_preserve_last_complete_frame(tmp_path):
    chunks = Chunks(tmp_path, 340, 165, 100)
    for i in range(10):
        chunks.append(frame(i, data=b'x' * 70))
    before = list(samples(tmp_path))
    with pytest.raises(ValueError):
        chunks.append(frame(20, data=b'x' * 999))
    assert list(samples(tmp_path)) == before
    chunks.close()
    assert len(before) == 2 and len(list(tmp_path.iterdir())) == 2


@pytest.mark.parametrize('order,encapsulation', [('<', 1), ('>', 0)])
def test_only_camera_binary_after_explicit_opt_in(order, encapsulation):
    jpeg = b'\xff\xd8\xff\xe1\x00\x08secret\xff\xd9'
    def prepare(video, api=1001):
        raw = bytes([0, encapsulation, 0, 0]) + struct.pack(order+'qqiI', 999, api, 0, 7)
        raw += b'secret\0\0' + struct.pack(order+'I', len(jpeg)) + jpeg
        return capture.prepare(frame(2, CAMERA, 'camera', raw), video, {})
    assert prepare(False) == Sample(2, 10**18+2, dict(topic=CAMERA, kind='camera'), b'', len(jpeg))
    assert prepare(True).payload == b'\xff\xd8\xff\xd9'
    assert prepare(True, api=9) is None


def test_anonymous_cloud_names_keep_geometry_and_common_frames():
    msg = NS(header=NS(frame_id='unit/private-name'), fields=[NS(name='x'), NS(name='private-name')])
    msg.serialize = lambda: (msg.header.frame_id + ',' + ','.join(f.name for f in msg.fields)).encode()
    data = capture.prepare(frame(1, 'test', 'cloud'), False, dict(cloud=NS(deserialize=lambda _: msg)))
    assert b'private-name' not in data.payload and b',x,' in data.payload
    msg.header.frame_id = 'lidar_link'
    msg.fields = [NS(name='intensity')]
    assert capture.prepare(frame(2, 'test', 'cloud'), False, dict(cloud=NS(deserialize=lambda _: msg))).payload == b'123'


def test_depth_follows_one_actual_selected_row_and_discards_private_name(monkeypatch):
    live = capture.Live.__new__(capture.Live)
    live.depth = live.selected = None
    handles = []
    def reader(name, stored, kind):
        handle = NS(name=name, stored=stored, kind=kind, closed=False)
        handle.set_listener = lambda _: setattr(handle, 'closed', True)
        handles.append(handle)
        return handle
    live.reader = reader
    args = NS(status_port=123)
    row = dict(name='private-depth-sensor', type=IMAGE, supported=True)
    monkeypatch.setattr(capture, 'selected_status', lambda _: row)
    live.select(args)
    live.select(args)
    row = None
    live.select(args)
    assert len(handles) == 1 and handles[0].closed
    assert handles[0].stored == 'depth_selected' and handles[0].kind == 'image'


def test_gap_percentiles_strict_threshold_and_embedded_journal_alignment(tmp_path, capsys):
    chunks = Chunks(tmp_path, 65536, 4096, 1)
    origin = 15_000_000_000
    for ms in (0, 200, 450):
        chunks.append(frame(origin + ms * 10**6))
    row = dict(locks=[dict(mono=origin+240_000_000, wall=10**18+origin+240_000_000, cause='feedback_lost')],
               cpu_pct={'cpu': 20}, task_pct={'recorder': 1}, recorder_rss_bytes=1024,
               lock_journal='read', queue_drops={})
    chunks.append(frame(origin+500_000_000, SYSTEM, 'system', json.dumps(row).encode()))
    chunks.close()
    analyze.analyze(tmp_path)
    result = capsys.readouterr().out
    assert f'| {LOW_TOPIC} | 3 | 200 | 250 | 250.0 | 1 | 9 | 3 | 18.0 |' in result
    assert '| 1 | 0.240 | feedback_lost | 40.0 | — | — |' in result


def test_journal_extracts_only_bounded_labels_and_numeric_clocks(monkeypatch):
    payload = dict(__CURSOR='local-only', __MONOTONIC_TIMESTAMP='300', __REALTIME_TIMESTAMP='400',
                   MESSAGE='test GO2_LOCK kind=lock cause=output_stalled source=agent held_ms=9 SECRET')
    result = NS(returncode=0, stderr=b'', stdout=json.dumps(payload).encode())
    monkeypatch.setattr('subprocess.run', lambda *a, **kw: result)
    journal = Journal()
    assert journal.poll(111) == [dict(cause='output_stalled', mono=300000, wall=400000)]
    assert journal.poll(111) == []


def test_proc_sample_distinguishes_thread_and_process():
    import os
    m = Metrics(os.getpid(), 'lo')
    m.sample()
    row = m.sample()
    assert row['task_pct']['agent'] is not None and str(os.getpid()) in row['task_pct']
    assert row['recorder_rss_bytes'] > 0 and 'cpu0' in row['cpu_pct']
    assert len(row['net_rx_tx_bytes']['robot_nic']) == 2 and row['memory_kib']['MemTotal'] > 0


def test_replay_uses_recorded_deadlines_at_speed_across_rotations(tmp_path):
    chunks = Chunks(tmp_path, 10000, 120, 1)
    for ms in (0, 3, 13, 413):
        chunks.append(frame(ms * 10**6))
    chunks.close()
    at, seen = [42_000_000], []
    def wait(seconds):
        at[0] += round(seconds * 10**9)
        return False
    replay.play(tmp_path, 2, NS(wait=wait), lambda _: seen.append(at[0]), clock=lambda: at[0])
    assert [n - seen[0] for n in seen] == [0, 1_500_000, 6_500_000, 206_500_000]


def test_fake_output_and_feedback_replay_without_robot_or_network(tmp_path, monkeypatch):
    from test_setup_pairing import low, sport
    chunks = Chunks(tmp_path, 100000, 500, 1)
    for i in range(1, 46):
        data = bytes([i])
        chunks.append(frame(i * 10_000_000, data=data))
        chunks.append(frame(i * 10_000_000 + 1, SPORT_TOPIC, 'sport', data))
    chunks.close()
    idls = dict(low=NS(deserialize=lambda b: low(b[0])),
                sport=NS(deserialize=lambda b: sport(b[0], error_code=100)))
    monkeypatch.setitem(sys.modules, 'unitree_sdk2py', None)
    monkeypatch.setitem(sys.modules, 'cyclonedds', None)
    monkeypatch.setattr('socket.socket.connect', lambda *a: pytest.fail('offline playback opened network'))
    result = asyncio.run(replay.replay(tmp_path, 1, None, idls=idls))
    assert result['received'] == {LOW_TOPIC: 45, SPORT_TOPIC: 45}
    assert result['fake_output']['StopMove'] > 0

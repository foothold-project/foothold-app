"""Local clocks, fake DDS messages and offline output only."""
import threading
from types import SimpleNamespace as NS

import pytest

from foothold_agent.go2_direct.feedback import Feedback
from foothold_agent.setup.identity import MacIdentity
from foothold_agent.setup.runtime import Gate, GatedSession, Inputs
from test_go2_direct import Clock, FakeSport, command
from test_go2_feedback import low, sport
from test_setup_pairing import NIC_VALUE, OfflineSink, SERIAL


def rig(monkeypatch, *, zero=False):
    clock = Clock()
    monkeypatch.setattr('foothold_agent.setup.runtime.time', NS(monotonic=clock))
    inputs = Inputs()
    inputs.feedback = Feedback('0-0' if zero else SERIAL, now=clock)
    inputs.lowstate(low(sn=(0, 0) if zero else (1234, 5678)))
    inputs.sportmodestate(sport())
    serial = SERIAL
    if zero:
        mac = '02:00:00:00:00:11'
        identity = inputs.mac_identity = MacIdentity(NIC_VALUE.name, mac, inputs,
                                                      now=clock, query=lambda _: (mac, []))
        identity.check()
        serial = identity.serial
    gate = Gate(NIC_VALUE, serial, inputs, ready=True, nic_matches=lambda: True,
                now=clock, wall=clock)
    session = GatedSession(inputs.feedback, gate)
    session.core.lock_log.now = clock
    session.connected = True
    gate.approve(clock() + 60)
    gate.activate(None, connect=lambda *_: (FakeSport(), FakeSport()),
                  sink_factory=lambda *args, **kw: OfflineSink(*args, now=clock, **kw))
    assert gate.active
    return clock, inputs, gate, session


def fields(caplog, cause):
    messages = [r.getMessage() for r in caplog.records]
    line, = [line for line in messages if line.startswith(f'GO2_LOCK kind=lock cause={cause} ')]
    return dict(token.split('=', 1) for token in line.split()[1:])


@pytest.mark.parametrize('zero,branch', [(False, 'serial_stale'), (True, 'body_check_stale')])
def test_identity_revoke_records_failed_branch_and_clocks(monkeypatch, caplog, zero, branch):
    clock, inputs, gate, session = rig(monkeypatch, zero=zero)
    clock.value += .25
    if zero:
        inputs.lowstate(low(2, sn=(0, 0)))
    inputs.sportmodestate(sport())  # replay or stale low, never adopted
    assert not gate.allowed() and session.core.latch
    row = fields(caplog, 'identity_unavailable')
    assert row['identity_branch'] == branch
    assert float(row['serial_refresh_ms']) == (0 if zero else 250)
    assert float(row['body_refresh_ms']) == (250 if zero else -1)
    assert float(row['sport_rx_ms']) == 0 and float(row['sport_accepted_ms']) == 250
    assert {'cpu_pct', 'cpu_window_ms', 'load1'} <= set(row['detail_missing'].split(','))
    assert float(row['host_sample_age_ms']) == -1
    assert SERIAL not in caplog.text and NIC_VALUE.mac not in caplog.text


def test_feedback_lock_retains_failed_decision_even_if_next_sample_is_ready(monkeypatch, caplog):
    clock, inputs, gate, session = rig(monkeypatch)
    hub = NS(on_robot_state=lambda _: None)
    feedback = inputs.feedback
    assert feedback.consume(hub)
    clock.value += .25
    inputs.lowstate(low(2))
    inputs.sportmodestate(sport())  # reject duplicate, adopted sample passes 200 ms
    assert not feedback.consume(hub)
    session.feedback_lost()
    row = fields(caplog, 'feedback_lost')
    assert row['feedback_failed'] == 'sport_stale'
    assert float(row['low_accepted_ms']) == float(row['sport_rx_ms']) == 0
    assert float(row['sport_accepted_ms']) == 250
    clock.value += 1
    tilted = low(3)
    tilted.imu_state.rpy[0] = 1.2
    inputs.lowstate(tilted)
    inputs.sportmodestate(sport(3, mode=8, error_code=1002, progress=1, body_height=.1))
    assert not feedback.consume(hub)
    inputs.lowstate(low(4))
    inputs.sportmodestate(sport(4))
    caplog.clear()
    session.feedback_lost()
    row = fields(caplog, 'feedback_lost')
    assert set(row['feedback_failed'].split(',')) == {'mode', 'error', 'progress', 'height', 'tilt'}
    assert row['feedback_latest'] == 'none'


def test_output_lock_shows_rejected_packet_age(monkeypatch, caplog):
    clock, inputs, gate, _ = rig(monkeypatch)
    sink = gate.active.sink
    assert sink.confirm_stopped(generation=sink.generation, sequence=1,
                                received_at=clock(), stationary=True)
    sink.apply(command('unlock'), source='server')
    sink.apply(command(), source='server', input_received_at=clock())
    sink.apply(command(velocity=(1.5, 0., 0.)), source='server', input_received_at=clock()-.5)
    row = fields(caplog, 'output_input_stale')
    assert float(row['output_input_ms']) == 500 and float(row['watchdog_input_ms']) == 0
    assert sink.latched and sink.pending == (0., 0., 0.)


def test_interval_window_includes_rejects_and_cross_window_gap(monkeypatch, caplog):
    clock, inputs, _, _ = rig(monkeypatch)
    caplog.clear()
    start = clock()
    clock.value += .0625
    inputs.sportmodestate(sport())  # repeated stamp
    clock.value = start + .125
    inputs.lowstate(low())  # repeated tick
    clock.value = start + .375
    inputs.lowstate(low(2))
    inputs.sportmodestate(sport(2))
    inputs.report_intervals(clock())
    assert not caplog.records
    clock.value = start + 30
    inputs.report_intervals(clock())
    inputs.report_intervals(clock())
    line, = [r.getMessage() for r in caplog.records]
    assert 'low_n=2 low_p50_ms=125 low_p95_ms=250 low_max_ms=250.00 low_over_200ms=1' in line
    assert 'sport_n=2 sport_p50_ms=62 sport_p95_ms=312 sport_max_ms=312.50 sport_over_200ms=1' in line
    assert 'drops=2 drop_reasons=low_tick_replay:1,sport_stamp_replay:1' in line
    caplog.clear()
    inputs.lowstate(low(3))
    inputs.report_intervals(clock()+30)
    line, = [r.getMessage() for r in caplog.records]
    assert 'low_n=1' in line and 'low_max_ms=29625.00 low_over_200ms=1' in line
    assert 'sport_n=0 sport_p50_ms=-1' in line and 'drops=0 drop_reasons=none' in line


def test_interval_overflow_preserves_tail_and_next_window():
    from foothold_agent.go2_readonly.sdk import ReceiptIntervals

    receipts = ReceiptIntervals()
    receipts.CAPACITY = 2
    for stamp in (1., 1.125, 1.5, 2.):
        receipts.record(stamp)
    assert receipts.summary('low') == (
        'low_n=3 low_p50_ms=375 low_p95_ms=500 low_max_ms=500.00 low_over_200ms=2')
    receipts.record(2.25)
    assert receipts.summary('low') == (
        'low_n=1 low_p50_ms=250 low_p95_ms=250 low_max_ms=250.00 low_over_200ms=1')


def test_stalled_host_sampler_does_not_block_or_strip_later_locks(monkeypatch, caplog):
    clock, inputs, gate, _ = rig(monkeypatch)
    sink = gate.active.sink
    entered, release, done = threading.Event(), threading.Event(), threading.Event()
    clock.value += 1
    monkeypatch.setattr('foothold_agent.setup.runtime.os.getloadavg', lambda: (3., 0., 0.))
    inputs.sample_host()
    first = clock()

    def unavailable():
        entered.set()
        release.wait(5)
        raise OSError('private sampler failure')

    sample_host = inputs.sample_host
    def collect():
        try:
            sample_host()
        finally:
            done.set()

    monkeypatch.setattr(inputs, 'sample_host', collect)
    monkeypatch.setattr('foothold_agent.setup.runtime.os.getloadavg', unavailable)
    clock.value += 1
    inputs.report_intervals(clock())
    try:
        assert entered.wait(2)
        for source in ('phone', 'server', 'phone'):
            caplog.clear()
            clock.value += 1
            sink.select_source(source)
            assert sink.latched and sink.source == source
            row = fields(caplog, 'output_source_changed')
            assert float(row['low_rx_ms']) == float(row['sport_accepted_ms']) == (clock() - first + 1) * 1000
            assert float(row['cpu_pct']) >= 0 and float(row['cpu_window_ms']) == 1000
            assert float(row['load1']) == 3 and float(row['host_sample_age_ms']) == (clock() - first) * 1000
            assert not done.is_set()
    finally:
        release.set()
        assert done.wait(2)
    caplog.clear()
    clock.value += 1
    sink.select_source('server')
    row = fields(caplog, 'output_source_changed')
    assert 'load1' in row['detail_missing'].split(',') and float(row['load1']) == -1
    assert float(row['cpu_pct']) >= 0 and float(row['low_rx_ms']) > 0
    assert 'private sampler failure' not in caplog.text


def test_failed_readiness_detail_preserves_clocks_and_latch(monkeypatch, caplog):
    clock, _, gate, _ = rig(monkeypatch)
    def faulty(*_):
        raise ValueError('private detail failure')
    monkeypatch.setattr(Feedback, 'journal_readiness', faulty)
    caplog.clear()
    clock.value += 1
    sink = gate.active.sink
    sink.select_source('phone')
    row = fields(caplog, 'output_source_changed')
    assert 'feedback_latest' in row['detail_missing'].split(',')
    assert float(row['sport_rx_ms']) == 1000
    assert sink.latched and sink.source == 'phone'
    assert 'private detail failure' not in caplog.text

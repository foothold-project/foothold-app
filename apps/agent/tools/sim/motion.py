"""Explicit bounded D1 motion: two straight 0.6 m/s tests, never arbitrary axes."""
import json
import math
import os
from pathlib import Path
import sys
import time

from clearance import prove
from isolation import stamp, write
from constants import MAP_DIRECTORY, WORLD_ID, FLOOR_ID, WORLD_KEY


def exercise(folder, base, access, robot, sim):
    if os.environ.get('FH_SIM_D1_MOTION') != '1':
        return 'skipped: explicit FH_SIM_D1_MOTION=1 not set'
    world = Path(os.environ['SIM_WORLD_SDF']).resolve()
    map_root = sim.source.parent.parent.parent / MAP_DIRECTORY
    catalog = json.loads((map_root / 'worlds.json').read_text())
    configured = catalog['worlds'][WORLD_KEY]
    if (configured['world_id'] != WORLD_ID or configured['floor_id'] != FLOOR_ID
            or (map_root / configured['world']).resolve() != world):
        raise RuntimeError('GT world must match the isolated runtime catalog before motion')
    from websockets.sync.client import connect

    def state():
        row = json.loads((folder / 'state.json').read_text())
        s = row['data']
        if (sim.reason or time.monotonic()-row['mono'] > 1 or s.get('fallen') is not False
                or s.get('plugin_mode') != 'LOCKSTEP' or s.get('policy_running') is not True):
            raise RuntimeError('motion aborted: stale/fallen/unhealthy simulation')
        return row

    proof = prove(world, state()['data'])
    write(folder / 'clearance-before.json', {**stamp(), **proof})
    if not proof['pass']:
        return 'skipped: GT forward 3m corridor/support proof failed'
    # Match the provided world to the world source recorded by the runtime at exit.
    sim.gt_world_sha = proof['source_sha256'][str(world)]
    actions, samples, outcomes = [], [], []
    screen_state = {}
    lease = None
    seq = 0
    request_id = 0
    with connect(base.replace('http:', 'ws:')+'/api/v1/ws', proxy=None, additional_headers={
            'authorization': 'Bearer '+access}) as ws:
        def send(kind, **fields):
            nonlocal request_id
            request_id += 1
            message = {'t': kind, 'id': f'd1-{request_id}', **fields}
            if kind != 'sub':
                message['robot'] = robot
            if request_id == 1:
                message['proto'] = 'fh-rt/1'
            when = stamp()
            ws.send(json.dumps(message))
            actions.append({**when, 'message': message})
            return message['id'], when

        def pump():
            nonlocal screen_state, lease
            row = state()
            if not samples or samples[-1]['mono'] != row['mono']:
                samples.append(row)
            try:
                frame = json.loads(ws.recv(timeout=.02))
                if frame.get('t') == 'state':
                    screen_state = frame
                if frame.get('t') == 'lease' and frame.get('lease_id'):
                    lease = frame['lease_id']
                if frame.get('t') == 'reply' and not frame.get('ok'):
                    raise RuntimeError('motion request refused: ' + frame.get('error', {}).get('code', 'unknown'))
            except TimeoutError:
                frame = {}
            return row, frame

        def until(predicate, seconds=5):
            end = time.monotonic()+seconds
            while time.monotonic() < end:
                row, frame = pump()
                if predicate(row, frame):
                    return row
            raise RuntimeError('motion confirmation timeout')

        def cmd(axes):
            nonlocal seq
            seq += 1
            return send('cmd', lease_id=lease, seq=seq, axes=axes)

        stop_cleanup = {'sent': False, 'confirmed': False, 'error_type': None}

        def finalize_stop():
            _, requested = send('stop')
            stop_cleanup.update(sent=True, requested=requested)
            deadline = time.monotonic()+2
            while time.monotonic() < deadline:
                try:
                    frame = json.loads(ws.recv(timeout=.02))
                except TimeoutError:
                    continue
                # Even during a fall/policy failure, observe STOP without calling
                # the health guard that caused the original abort.
                row = json.loads((folder / 'state.json').read_text())
                if (frame.get('t') == 'state' and frame.get('connection') == 'ONLINE'
                        and frame.get('latched') is True and frame.get('applied') == [0, 0, 0]
                        and time.monotonic()-row['mono'] <= 1 and row['mono'] >= requested['mono']
                        and row['data'].get('stop_requested') is True and row['data'].get('cmd_applied') == [0, 0, 0]):
                    stop_cleanup.update(confirmed=True, observed=stamp())
                    return
            raise RuntimeError('final STOP confirmation timeout')

        try:
            send('sub', robots=[robot], streams=['state'])
            until(lambda r, f: screen_state.get('latched') is True and screen_state.get('connection') == 'ONLINE')
            send('lease.take')
            until(lambda r, f: bool(lease) and f.get('t') == 'state' and screen_state.get('latched') is True)
            settle = time.monotonic()+.3
            while time.monotonic() < settle:
                pump()
            for number, mode in enumerate(('stop_button', 'input_gap'), 1):
                until(lambda r, f: r['data'].get('body_still') is True and r['data']['stop_requested'] is True
                      and screen_state.get('latched') is True)
                start = state()
                proof = prove(world, start['data'])
                write(folder / f'clearance-{number}.json', {**stamp(), **proof})
                if not proof['pass']:
                    return 'skipped remaining motion: GT 3m corridor no longer clear'
                generation = screen_state['stop_gen']
                send('unlock', lease_id=lease, stop_gen=generation)
                until(lambda r, f: r['data']['stop_requested'] is False and screen_state.get('latched') is False)
                # Fresh neutral only after actual RESUME feedback.
                end = time.monotonic()+.2
                while time.monotonic() < end:
                    cmd([0, 0, 0])
                    pump()
                    time.sleep(.03)
                first_command = last_command = None
                # Reserve margin for deadman .30 + tick .05 + output .05 +
                # policy/state observation .10; .30 burst totals ~.80s before
                # transport/scheduling jitter. This is not an OS deadline guarantee.
                burst_start = time.monotonic()
                next_command = burst_start
                while time.monotonic()-burst_start < .30:
                    if time.monotonic() >= next_command:
                        _, last_command = cmd([1, 0, 0])
                        first_command = first_command or last_command
                        next_command += .05
                    pump()
                if mode == 'stop_button':
                    _, trigger = send('stop')
                else:
                    trigger = last_command
                # Require real policy nonzero observation, then actual zero.
                if not any(r['mono'] >= first_command['mono'] and r['data'].get('cmd_applied') == [.6, 0, 0] for r in samples):
                    raise RuntimeError('nonzero policy application was not observed; no further motion')
                zero = until(lambda r, f: r['mono'] > trigger['mono'] and r['data'].get('cmd_applied') == [0, 0, 0], seconds=2)
                if zero['mono']-first_command['mono'] > 1.0:
                    raise RuntimeError('nonzero application exceeded 1s ceiling')
                if mode == 'input_gap':
                    send('stop')  # every trial ends explicitly latched
                stopped = until(lambda r, f: r['mono'] >= zero['mono'] and r['data'].get('body_still') is True
                                and r['data']['stop_requested'] is True, seconds=12)
                distance = lambda a, b: math.hypot(a['data']['x']-b['data']['x'], a['data']['y']-b['data']['y'])
                record = {'trial': number, 'mode': mode, 'first_input': first_command, 'last_input': last_command,
                          'trigger': trigger, 'policy_zero_observation': zero, 'body_still_observation': stopped,
                          'trigger_to_policy_zero_s': zero['mono']-trigger['mono'],
                          'trigger_to_body_still_s': stopped['mono']-trigger['mono'],
                          'total_displacement_m': distance(start, stopped),
                          'source_clocks': 'host monotonic observations; policy/body evidence sampled at 10Hz'}
                outcomes.append(record)
                write(folder / 'motion-results.json', outcomes)
        finally:
            original_error = sys.exc_info()[1]
            try:
                finalize_stop()
            except BaseException as exc:
                stop_cleanup['error_type'] = type(exc).__name__
                if original_error is None:
                    raise RuntimeError('final STOP unconfirmed; inspect motion-stop-cleanup.json') from None
                if hasattr(original_error, 'add_note'):
                    original_error.add_note('final STOP unconfirmed; inspect motion-stop-cleanup.json')
            finally:
                write(folder / 'motion-stop-cleanup.json', stop_cleanup)
                write(folder / 'motion-actions.json', actions)
                write(folder / 'motion-states.json', samples)
    return 'completed: STOP button and input-gap trials; measured timing in report, no strict 0.300s deadline assertion'

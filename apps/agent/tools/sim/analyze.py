#!/usr/bin/env python3
"""Summarize a completed D1 record, retaining measured clocks and limitations."""
import json
import math
from pathlib import Path
import sys


def analyze(folder):
    observations = [json.loads(line) for line in (folder / 'ros-observations.jsonl').read_text().splitlines()]
    resources = [json.loads(line) for line in (folder / 'resources.jsonl').read_text().splitlines()]
    states = [r for r in observations if r['kind'] == 'state']
    result = {'run': str(folder), 'result': json.loads((folder / 'result.json').read_text()),
              'cleanup': json.loads((folder / 'cleanup.json').read_text()), 'trials': []}
    path = folder / 'motion-results.json'
    for trial in json.loads(path.read_text()) if path.exists() else []:
        t = trial['trigger']['mono']
        end = trial['body_still_observation']['mono']
        after = [o for o in observations if t <= o['mono'] <= end]
        zero = next((o for o in after if o['kind'] == 'cmd' and o['data'] == [0, 0, 0]), None)
        stop = next((o for o in after if o['kind'] == 'stop'), None)
        before = [o for o in states if o['mono'] <= t][-1]
        still = trial['body_still_observation']
        displacement = math.hypot(still['data']['x']-before['data']['x'], still['data']['y']-before['data']['y'])
        row = {'mode': trial['mode'], 'trigger_mono': t,
               'input_burst_s': trial['last_input']['mono']-trial['first_input']['mono'],
               'bridge_zero_mono': zero['mono'] if zero else None,
               'bridge_stop_mono': stop['mono'] if stop else None,
               'bridge_zero_delay_s': zero['mono']-t if zero else None,
               'bridge_stop_delay_s': stop['mono']-t if stop else None,
               'policy_zero_mono': trial['policy_zero_observation']['mono'],
               'policy_zero_delay_s': trial['trigger_to_policy_zero_s'],
               'body_still_mono': end, 'body_still_delay_s': trial['trigger_to_body_still_s'],
               'displacement_after_trigger_m': displacement, 'total_displacement_m': trial['total_displacement_m'],
               'distance_note': 'XY displacement from last state <= trigger to first body_still; state sampled at 10Hz',
               'body_still_note': 'native threshold marker, not mathematically exact zero speed'}
        if trial['mode'] == 'input_gap':
            positives = [o for o in after if o['kind'] == 'cmd' and any(o['data'])]
            last_positive = positives[-1] if positives else None
            row['last_nonzero_ros_delay_s'] = last_positive['mono']-t if last_positive else None
            row['last_nonzero_to_zero_ros_s'] = zero['mono']-last_positive['mono'] if zero and last_positive else None
            row['measurement_origin'] = 'screen ws.send before last input; agent receipt time was not measured'
            row['agent_last_cmd_received_mono'] = None
            row['spec_note'] = '0.300s is agent-receipt expiry; this end-to-end observation is not a spec deadline test'
            row['stop_note'] = 'explicit STOP sent after zero feedback; input expiry itself need not latch STOP'
        result['trials'].append(row)
    peaks = [int(r['unit']['MemoryPeak']) for r in resources if r['unit'].get('MemoryPeak', '').isdigit()]
    result['resources'] = {'min_available_mib': min(r['mem_available_mib'] for r in resources),
                           'max_load1': max(r['load1'] for r in resources),
                           'max_unit_memory_mib': max(peaks)/2**20 if peaks else None,
                           'max_swap_in_kib_s': max(r['swap_in_kib_s'] for r in resources)}
    result['stop_latched_nonzero_policy_samples'] = sum(bool(s['data'].get('stop_requested') and
        s['data'].get('cmd_applied') and any(s['data']['cmd_applied'])) for s in states)
    result['max_camera_frames_observed'] = max(s['data'].get('camera_frames', 0) for s in states)
    result['fallen_samples'] = sum(s['data'].get('fallen') is True for s in states)
    result['timing_note'] = ('Host monotonic timestamps from the observer and driver; policy/body snapshots at 10Hz. '
                             'Input-gap origin is screen send, not agent receipt. Agent expiry is sampled on a 50ms tick '
                             'and ordinary ROS output on a 50ms cycle; delivery is also included, so this is not a 0.300s end-to-end deadline test.')
    return result


if __name__ == '__main__':
    result = analyze(Path(sys.argv[1]).resolve())
    print(json.dumps(result, ensure_ascii=False, indent=2))

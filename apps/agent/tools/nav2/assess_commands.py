#!/usr/bin/env python3
"""Offline Nav2 SI-output replay. No command changes, ROS imports or actuation.

Input JSONL: {"input_si":[vx,vy,wz]}. The TESTED ratio describes only that file;
synthetic cases are never reported as measured controller feasibility.
"""
import argparse
import json
from pathlib import Path
from foothold_agent.executor.nav2 import PolicyAdapter


def assess(rows, policy):
    adapter=PolicyAdapter(policy)
    counts={}
    first_rejection=None
    for i,row in enumerate(rows):
        _, reason=adapter.adapt(row['input_si'])
        counts[reason]=counts.get(reason,0)+1
        if reason not in ('TESTED','TESTED_YAW_REDUCED','ZERO') and first_rejection is None:
            first_rejection=i
    total=sum(counts.values())
    return {'samples':total, 'counts':counts, 'tested_ratio':(counts.get('TESTED',0)+counts.get('TESTED_YAW_REDUCED',0))/total if total else None,
            'first_latched_rejection_index':first_rejection, 'actual_nav2_feasibility_proven':False}


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('input',type=Path)
    a=p.parse_args()
    rows=[json.loads(line) for line in a.input.read_text().splitlines()]
    print(json.dumps(assess(rows,json.loads(Path(__file__).with_name('policy.json').read_text())),indent=2))

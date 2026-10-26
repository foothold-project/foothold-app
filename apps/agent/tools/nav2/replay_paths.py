#!/usr/bin/env python3
"""Synthetic straight-path command compatibility estimate, never a Nav2 run.

Fixtures assume nominal forward motion and a fixed lateral carrot displacement.
RPP curvature = 2*y/(x*x+y*y); near goal the carrot distance shrinks. No tracking,
TF, timing, physical stopping or goal-result success is inferred from this model.
"""
import json
import math
from pathlib import Path
import re

from foothold_agent.executor.nav2 import PolicyAdapter

HERE = Path(__file__).resolve().parent
ACCEPTED = ('TESTED', 'TESTED_YAW_REDUCED', 'ZERO')


def parameters(text):
    """Read only unique literal scalars of the checked-in fixture YAML, fail closed.

    This is not a YAML loader and does not accept substitutions/overrides. Avoids
    adding a dependency to the ROS-free agent purely for an offline estimate.
    """
    def scalar(name):
        values=re.findall(r'^\s*'+re.escape(name)+r':\s*([^#\n]+)',text,re.M)
        if len(values)!=1:
            raise ValueError('unique literal parameter required: '+name)
        return values[0].strip()
    for name in ('use_regulated_linear_velocity_scaling','use_cost_regulated_linear_velocity_scaling',
                 'use_velocity_scaled_lookahead_dist','use_rotate_to_heading','allow_reversing'):
        if scalar(name)!='false':
            raise ValueError('synthetic straight replay requires disabled '+name)
    if float(scalar('approach_velocity_scaling_dist'))!=0:
        raise ValueError('D22 requires disabled approach scaling')
    return {key:float(scalar(name)) for key,name in (
        ('speed','desired_linear_vel'),('lookahead','lookahead_dist'),
        ('tolerance','xy_goal_tolerance'),('frequency','controller_frequency'))}


def replay_paths(config, policy, params, offsets=(0.,.001,.02,.05), *, adapter=None):
    """Uniform 4-profile x 8-autonomous-trial fixtures, not a probability sample."""
    adapter=PolicyAdapter(policy) if adapter is None else adapter
    results=[]
    if not all(math.isfinite(v) and v>0 for v in params.values()):
        raise ValueError('positive finite replay parameters required')
    dt=1/params['frequency']
    speed=params['speed']
    for index,name in enumerate(config['trials'],1):
        if name.startswith('manual'):
            continue
        point=next(p for p in config['points'] if p['id']==name) if index>4 else config['points'][-1]
        length=point['x']-config['spawn']['x']
        for offset in offsets:
            if not math.isfinite(offset) or offset<0:
                raise ValueError('finite nonnegative fixture offset required')
            elapsed=0.;counts={};reason=None
            # Nominal x advance is a fixture assumption; no integration of a robot.
            for step in range(math.ceil(config['trial_wall_s']/dt)):
                remaining=max(0.,length-speed*elapsed)
                if ((index<=4 and elapsed>=config['manual_burst_wall_s'])
                        or (index>4 and math.hypot(remaining,offset)<=params['tolerance'])):
                    adapter.adapt((0,0,0))
                    break
                carrot=min(params['lookahead'],remaining)
                yaw=speed*2*offset/(carrot*carrot+offset*offset) if carrot or offset else 0.
                _,reason=adapter.adapt((speed,0,yaw))
                counts[reason]=counts.get(reason,0)+1
                if reason not in ACCEPTED:
                    break
                elapsed=(step+1)*dt
            else:
                reason='FIXTURE_TIMEOUT'
            supported=reason in ACCEPTED
            budget_fit=(elapsed<=config['nonzero_burst_wall_s'] and elapsed<=config['nonzero_total_wall_s'])
            results.append({'trial_index':index,'trial':name,'offset_m':offset,
                'terminal_command_status':'TESTED' if supported else 'REJECTED',
                'last_reason':reason,'counts':counts,'nominal_nonzero_s':elapsed,
                'motion_budget_fits':budget_fit})
    tested=sum(r['terminal_command_status']=='TESTED' for r in results)
    budget=sum(r['terminal_command_status']=='TESTED' and r['motion_budget_fits'] for r in results)
    return {'schema':'fh-nav2-synthetic-paths/1','cases':len(results),'tested_cases':tested,
        'tested_ratio':tested/len(results),'tested_and_budget_cases':budget,
        'tested_and_budget_ratio':budget/len(results),'actual_nav2_feasibility_proven':False,
        'assumptions':'uniform fixed lateral carrot offsets; nominal .6 m/s motion; zero terminal at tolerance or safety trigger; no actual controller, robot or timing',
        'trials':results}


if __name__=='__main__':
    config=json.loads((HERE/'preregistration.json').read_text())
    policy=json.loads((HERE/'policy.json').read_text())
    print(json.dumps(replay_paths(config,policy,parameters((HERE/'nav2_params.yaml').read_text())),indent=2))

"""ROS-free RPP 1.3.13 heading fixtures; no physical feasibility claim.

Model: 5 cm straight global plan computed once per goal, nearest-point pruning,
analytic circle/segment carrot, final segment extension, exact unicycle steps.
No NavFn, TF, controller timing, dynamics, collision prediction or STOP proof.
"""
import argparse
import json
import math
from pathlib import Path
from types import SimpleNamespace

from foothold_agent.executor.nav2 import NavExecutor, PolicyAdapter
from foothold_agent.executor.nav2.intent import Binding
from foothold_agent.executor.nav2.simulation import SimulationPolicyAdapter
from assess_commands import assess
from replay_paths import HERE, simulation_parameters, regulated_command

ANGLES = (0, 30, -30, 60, -60, 90, -90, 135, -135, 180)
STARTS = ((0., 0.), (-.4, 0.), (0., .2), (0., -.2))


def carrot(plan, x, y, distance):
    """RPP getLookAheadPoint with interpolate_after_goal=true, world frame."""
    for i, point in enumerate(plan):
        if math.hypot(point[0]-x, point[1]-y) >= distance:
            if i == 0:
                return point
            a, b = plan[i-1], point
            break
    else:
        a, previous = plan[-1], plan[-2]
        heading = math.atan2(a[1]-previous[1], a[0]-previous[0])
        b = (a[0]+distance*math.cos(heading), a[1]+distance*math.sin(heading))
    ax, ay, bx, by = a[0]-x, a[1]-y, b[0]-x, b[1]-y
    dx, dy = bx-ax, by-ay
    dr2, determinant = dx*dx+dy*dy, ax*by-bx*ay
    dd = bx*bx+by*by-ax*ax-ay*ay
    root = math.sqrt(max(0., distance*distance*dr2-determinant*determinant))
    # Preserve Jazzy's copysign(dd) selection even if the projected endpoint
    # lies inside the circle (e.g. after overshooting the final segment).
    return (x+(determinant*dy+math.copysign(1., dd)*dx*root)/dr2,
            y+(-determinant*dx+math.copysign(1., dd)*dy*root)/dr2)


def integrate(x, y, yaw, vx, wz, dt):
    if abs(wz) < 1e-12:
        return x+vx*dt*math.cos(yaw), y+vx*dt*math.sin(yaw), yaw+wz*dt
    return (x+vx/wz*(math.sin(yaw+wz*dt)-math.sin(yaw)),
            y-vx/wz*(math.cos(yaw+wz*dt)-math.cos(yaw)), yaw+wz*dt)


def replay(start, degrees, params, *, clearance=None, timeout=30.):
    policy = json.loads((HERE/'policy.json').read_text())
    adapter = SimulationPolicyAdapter(PolicyAdapter(policy), lambda: True)
    now = [0.]
    executor = NavExecutor(adapter, SimpleNamespace(submit=lambda *a: None, cancel=lambda *a: None), now=lambda: now[0])
    run = dict(run_id='offline', status='RUNNING')
    x, y = start
    yaw = math.atan2(-y, .8-x)+math.radians(degrees)
    rows, poses, radii = [], [(x, y, yaw)], []
    reached, nav_success, latched = 0, 0, False
    dt = 1/params['frequency']
    minimum_clearance = clearance(x, y) if clearance else None
    # Wall intersections are reported over the unconstrained trajectory, never
    # interpreted as commands that collision-enabled RPP would actually issue.
    for goal_index, goal in enumerate(((.8, 0.), (1.6, 0.))):
        length = math.hypot(goal[0]-x, goal[1]-y)
        count = max(1, math.ceil(length/.05))
        plan = [(x+(goal[0]-x)*i/count, y+(goal[1]-y)*i/count) for i in range(count+1)]
        nearest = 0
        xy_latched = False
        binding = Binding('offline', str(goal_index), 1, 0, 'warehouse', 'f1', 'offline')
        executor.begin(binding, goal)
        goal_reached = False
        for _ in range(math.ceil(timeout/dt)):
            distance = math.hypot(goal[0]-x, goal[1]-y)
            xy_latched |= distance <= params['tolerance']
            if xy_latched and abs(math.atan2(math.sin(yaw), math.cos(yaw))) <= params['yaw_tolerance']:
                nav_success += 1
                goal_reached = distance <= params['tolerance']
                reached += int(goal_reached)
                break
            nearest = min(range(nearest, len(plan)), key=lambda i: math.hypot(plan[i][0]-x, plan[i][1]-y))
            # Retain the last segment for after-goal interpolation.
            remaining = plan[min(nearest, len(plan)-2):]
            cx, cy = carrot(remaining, x, y, params['curvature_lookahead'])
            dx, dy = cx-x, cy-y
            d2 = dx*dx+dy*dy
            lateral = -math.sin(yaw)*dx+math.cos(yaw)*dy
            curvature = 2*lateral/d2 if d2 > .001 else 0.
            command = regulated_command(curvature, params)
            rows.append({'input_si': command})
            executor.intent(binding, command)
            executor.poll(run)
            latched |= executor.rejected
            if latched:
                break
            if abs(command[2]) > 1e-10:
                radii.append(abs(command[0]/command[2]))
            x, y, yaw = integrate(x, y, yaw, command[0], command[2], dt)
            poses.append((x, y, yaw))
            if clearance:
                minimum_clearance = min(minimum_clearance, clearance(x, y))
            now[0] += dt
        # Real goal/cancel emits a full zero; use the unchanged latch machinery.
        rows.append({'input_si': (0., 0., 0.)})
        executor.intent(binding, (0., 0., 0.))
        executor.poll(run)
        latched |= executor.rejected
        executor.revoke('OFFLINE_GOAL_END')
        if not goal_reached or latched:
            break
    assessed = assess(rows, policy, adapter=adapter)
    wall_clear = minimum_clearance is None or minimum_clearance >= 0
    return dict(start=start, heading_error_deg=degrees, latch_count=int(latched),
                max_abs_wz=max(abs(r['input_si'][2]) for r in rows),
                min_moving_vx=min(r['input_si'][0] for r in rows if r['input_si'][0]),
                min_turn_radius_m=min(radii) if radii else None,
                minimum_raster_body_clearance_m=minimum_clearance,
                geometric_goals_reached=reached, nav_stateful_successes=nav_success,
                model_completed=reached == 2, wall_clear_model_completed=reached == 2 and wall_clear,
                maximum_lateral_excursion_m=max(abs(p[1]) for p in poses),
                failure_reason=(None if reached == 2 and wall_clear else
                    'RASTER_BODY_INTERSECTION' if not wall_clear else
                    'GOAL_YAW_ALIGNED_OUTSIDE_XY' if nav_success > reached else
                    'FIXTURE_TIMEOUT_HEADING_ALIGNMENT_REQUIRED'),
                final_pose=(x, y, yaw), assessment=assessed)


def warehouse_clearance(image):
    """Conservative .782 m circular body + half cell diagonal; unknown is blocked.

    Optional Pillow reads the existing raster only. Grid resolution/origin are
    the checked-in warehouse f1.yaml's .05 and (-7.5,-11); no map generation.
    Nearest blocked-centre distances are an offline geometry estimate only.
    """
    from PIL import Image
    raster = Image.open(image).convert('L')
    width, height = raster.size
    blocked = [(-7.5+(c+.5)*.05, -11+(height-r-.5)*.05)
               for r in range(height) for c in range(width) if raster.getpixel((c, r)) != 254]
    cache = {}

    def distance(x, y):
        # Round to a cell for a cached bound, subtract rounding displacement.
        key = round(x/.05), round(y/.05)
        qx, qy = key[0]*.05, key[1]*.05
        if key not in cache:
            cache[key] = min(math.hypot(qx-bx, qy-by) for bx, by in blocked)-.782-math.sqrt(2)*.025
        edge = min(x+7.5, 7.5-x, y+11, 11-y)-.782
        return min(edge, cache[key]-math.hypot(qx-x, qy-y))
    return distance


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--heading-sweep', action='store_true')
    parser.add_argument('--warehouse-map', type=Path)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args(argv)
    params = simulation_parameters()
    clearance = warehouse_clearance(args.warehouse_map) if args.warehouse_map else None
    results = [replay(start, angle, params, clearance=clearance) for angle in ANGLES for start in STARTS]
    report = dict(schema='fh-nav2-heading-fixtures/1', parameters=params, cases=len(results),
                  actual_nav2_feasibility_proven=False,
                  assumptions=__doc__, trials=results)
    output = json.dumps(report, indent=2, allow_nan=False)+'\n'
    if args.output:
        args.output.write_text(output)
    else:
        print(output, end='')


if __name__ == '__main__':
    main()

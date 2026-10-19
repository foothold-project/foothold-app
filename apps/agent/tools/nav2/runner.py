#!/usr/bin/env python3
"""Server-free R0' point-list runner. Default = offline plan; no ROS imports.

--execute is for separately approved A3a-2/3 ONLY. It joins an ALREADY isolated
simulation and Nav2, never launches or kills processes. One invocation/trial,
one goal, no retries. Local Session authority is an explicit experiment fixture.
"""
import argparse
import asyncio
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
import json
import os
from pathlib import Path
from types import SimpleNamespace
import time
from uuid import uuid4

from foothold_agent.executor.nav2 import Binding, NavExecutor, Owner, PolicyAdapter
from foothold_agent.link.session import Session
from foothold_agent.safety.core import Z
from prepare import map_manifest, GTWorld
from resources import ResourceGate, scope_limits, snapshot
from ros_adapter import ActionMailbox, RosAdapter
from trial import Observation, Trial
from journal import Journal
from ledger import Ledger

HERE = Path(__file__).resolve().parent


def load(name):
    return json.loads((HERE/name).read_text())


def select_point(config, name):
    return next(p for p in config['points'] if p['id'] == name)


def experiment_lease(owner, run_id, manual=False):
    """Local fixture; NOT server authentication or A3b integration."""
    owner._apply(owner.session.connect())
    owner.receive({'t': 'lease', 'lease_id': 'local-fixture-'+run_id,
                   'holder_type': 'USER' if manual else 'RUN:'+run_id})
    if not manual:
        owner.receive({'t': 'run.start', 'run_id': run_id, 'plan': {'segments': []}, 'missions': {}})


def explicit_unlock(owner, confirmation, emit):
    # Called once AFTER operator opt-in, actual STOP feedback, and preflight.
    if not confirmation:
        raise ValueError('fresh per-trial operator confirmation required')
    emit({'event': 'operator_confirmed_unlock', 'confirmation': confirmation})
    return owner.receive({'t': 'unlock', 'lease_id': owner.session.lease_id,
                          'stop_gen': owner.session.core.stop_gen})


def replay(config, point, path):
    rows = [json.loads(line) for line in path.read_text().splitlines()]
    first = next((r for r in rows if 'observation' in r), None)
    if first is None:
        return {'status': 'BLOCKED_NOT_STARTED', 'reason': 'NO_OBSERVATIONS', 'records': []}
    if first.get('goal') in config['points']:
        point = first['goal']
    trial = Trial(config, point, first['observation']['episode'], kind=first.get('kind', 'goal'))
    previous = None
    for row in rows:
        if 'observation' in row:
            obs = Observation(**row['observation'])
            if trial.status == 'NOT_STARTED':
                trial.start(obs)
            else:
                trial.update(obs, row.get('nav_result'))
            previous = obs
        elif row.get('event') == 'stop_trigger' and previous is not None:
            obs = replace(previous, wall=row['monotonic_s'])
            trial.trigger_stop(obs, last_intent_receive=row.get('t_executor_or_manual_receive'))
        elif row.get('event') == 'ros_zero_receive':
            trial.ros_zero(row['monotonic_s'])
    if trial.status == 'RUNNING':
        trial.finish('FAILED', 'REPLAY_INCOMPLETE')
    return {'status': trial.status, 'reason': trial.reason, 'records': trial.records}


def classify_rejection(trial, executor):
    # A rejected command is a failed experiment even if the resulting STOP
    # subsequently satisfies the safety trial's physical stopping criteria.
    if executor.rejected:
        trial.finish('FAILED', 'UNSUPPORTED_COMMAND')


def failure_reason(exc):
    return str(exc) or type(exc).__name__


async def _execute(args, config, policy):
    # This function was NOT executed in A3a-1. Node construction occurs only here.
    from foothold_agent.ros_bridge.config import validate_isolation
    from foothold_agent.ros_bridge.node import RosNode
    if os.environ.get('FH_NAV2_EXECUTE') != '1':
        raise ValueError('separate execution approval plus FH_NAV2_EXECUTE=1 required')
    validate_isolation()
    scope = scope_limits(config)
    manifest = map_manifest(args.map_source)
    geometry = GTWorld(args.world)
    name = config['trials'][args.trial-1]
    gate = ResourceGate(config)
    initial_resources = snapshot()
    if not gate.update(initial_resources, starting=True):
        raise ValueError('prestart resource gate refused')
    log = Journal(args.output/'events.jsonl')
    hard_deadline = time.monotonic()+config['trial_wall_s']
    run_id = str(uuid4())
    actions = ActionMailbox()
    executor = NavExecutor(PolicyAdapter(policy), actions, dead_s=policy['intent_dead_s'])
    session = Session()
    owner = None
    bridge = RosNode(SimpleNamespace(robot_id=run_id), extension_factory=lambda node:
        RosAdapter(node, executor, policy, config, actions, map_manifest=manifest))
    pose_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix='nav-pose-proof')
    path_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix='nav-path-proof')
    resource_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix='nav-resources')
    pose_pending = path_pending = resource_pending = None
    trial = None
    proof_at = float('-inf')
    proof_ok = path_ok = False
    last_resources = initial_resources
    resources_ok = True
    last_resource_at = time.monotonic()
    point = select_point(config, name if name in ('G1', 'G2') else 'G2')
    manual = name.startswith('manual')
    trigger = None
    seq = 0
    failures = []

    def emit(record):
        log.emit({'schema': 'fh-nav2-trial/1', **record})

    def drain(records):
        submitted = 0
        try:
            for event in records:
                emit(event)
                submitted += 1
        finally:
            del records[:submitted]  # retain the unsent suffix, never replay a submitted prefix

    def feed_state(raw):
        if owner is not None:
            cached = bridge.inputs.telemetry.state or {}
            owner.on_state(raw, received_at=cached.get('received_monotonic_s', float('-inf')),
                           progress_at=cached.get('progress_monotonic_s', float('-inf')))

    try:
        sink = await asyncio.wait_for(bridge.start(feed_state), timeout=5)
        owner = Owner(session, sink, executor, state_age_s=policy['state_age_s'])
        experiment_lease(owner, run_id, manual)
        emit({'event': 'local_authority_fixture', 'run_id': run_id, 'lease_id': session.lease_id,
              'trial': name, 'isolated_start_id': args.isolated_start_id, 'scope': scope,
              'map_manifest': manifest, 'seed': args.seed, 'seed_applied': False,
              'authentication_tested': False, 'cleanup_owner': 'A3a-2 supervisor'})
        trial = Trial(config, point, -1, kind='safety' if args.trial <= 4 else 'goal')

        def idle_tick():
            owner.receive({'t': 'ping'})  # explicit local fixture liveness, no server/network
            if not manual and executor.binding is None and session.run and session.run['status'] in ('RUNNING', 'PAUSED'):
                owner._apply(session.executor_command(run_id, Z))
            owner.tick()
            # Preflight/RESUME also produce sink/session evidence. Submit each
            # tick, before yielding to the writer, rather than bursting the
            # entire startup backlog into its bounded queue at the first goal.
            # Keep overflow/disk errors fatal and retain unsubmitted records.
            drain(owner.journal)

        deadline = time.monotonic()+10
        # Actual STOP/zero, time, lifecycle and GT preflight; never unlock here.
        while time.monotonic() < deadline:
            if bridge.error:
                raise RuntimeError('bridge failure') from bridge.error
            view = bridge.extension.snapshot()
            raw, receipt = view.get('state', ({}, float('-inf')))
            if (raw.get('stop_requested') is True and raw.get('cmd_applied') == [0, 0, 0]
                    and raw.get('body_still') is True and view.get('frames_ready')
                    and view.get('map_ready') and view.get('lifecycle_ready')
                    and time.monotonic()-receipt <= config['fresh_state_s']):
                actual = {k: raw[k] for k in ('x', 'y', 'z', 'yaw')}
                proof = await asyncio.get_running_loop().run_in_executor(path_pool,
                    lambda: geometry.path(actual, point, [actual, point],
                        deviation=policy['path_deviation_m'], heading_tolerance=config['start_yaw_rad']))
                emit({'event': 'prestart_gt_swept', 'proof': proof})
                if not proof['pass']:
                    raise ValueError('BLOCKED_NOT_STARTED: actual GT corridor refused')
                break
            idle_tick()
            await asyncio.sleep(.05)
        else:
            raise ValueError('BLOCKED_NOT_STARTED: STOP/frame/map/lifecycle timeout')
        # Core public handshake: actual STOP state was delivered by bridge, one
        # explicit unlock, fresh RESUME feedback, then a NEW neutral input.
        explicit_unlock(owner, args.operator_confirmation, emit)
        deadline = time.monotonic()+3
        while session.core.latch and time.monotonic() < deadline:
            idle_tick()
            await asyncio.sleep(.05)
        if session.core.latch:
            raise ValueError('BLOCKED_NOT_STARTED: RESUME feedback absent')
        if manual:
            seq += 1
            owner.receive({'t': 'cmd', 'lease_id': session.lease_id, 'seq': seq, 'axes': [0, 0, 0]})
        else:
            owner._apply(session.executor_command(run_id, Z))
        binding = Binding(run_id, str(uuid4()), raw['episode'], session.core.stop_gen,
                          config['world'], config['floor'], config['map_sha'])
        trial = Trial(config, point, binding.episode, kind='safety' if args.trial <= 4 else 'goal')
        start_at = time.monotonic()
        first_nonzero = None
        path_digest = None
        last_sync = None

        def guard():
            if not resources_ok:
                return False, 'RESOURCE_GATE'
            if time.monotonic()-proof_at > config['fresh_state_s']:
                return None, 'GT_PROOF_PENDING'
            if not proof_ok:
                return False, 'GT_RUNTIME_REFUSED'
            return (True if path_ok else None), 'PATH_PROOF_PENDING'
        owner.guard = guard

        while time.monotonic() < hard_deadline:
            if bridge.error:
                raise RuntimeError('bridge failure') from bridge.error
            view = bridge.extension.snapshot()
            raw, receipt = view.get('state', ({}, float('-inf')))
            now = time.monotonic()
            if raw.get('sim_t') != last_sync:
                last_sync = raw.get('sim_t')
                emit({'event': 'input_sync', 'monotonic_s': now, 'state_received': receipt,
                      'clock': view.get('clock'), 'scan': view.get('scan'), 'odom': view.get('odom'),
                      'frames_ready': view.get('frames_ready'), 'map_ready': view.get('map_ready'),
                      'alignment': view.get('alignment'), 'pose_agrees': view.get('pose_agrees')})
            if resource_pending is None and now-last_resource_at >= 1:
                resource_pending = resource_pool.submit(snapshot, last_resources, rtf=raw.get('rtf', 0))
                last_resource_at = now
            if resource_pending is not None and resource_pending.done():
                last_resources = resource_pending.result()
                resources_ok = gate.update(last_resources)
                emit({'event': 'resources', **last_resources})
                resource_pending = None
            path = view.get('path')
            if pose_pending is not None and pose_pending.done():
                proof, proof_at = pose_pending.result()
                proof_ok = proof['pass']
                pose_pending = None
                emit({'event': 'gt_proof', 'kind': 'pose', 'pass': proof_ok, 'receipt': proof_at})
                if not proof_ok:
                    owner.stop('ACTUAL_GT_REFUSED')
                    trial.finish('FAILED', 'ACTUAL_GT_REFUSED')
            if path_pending is not None and path_pending.done():
                proof = path_pending.result()
                path_pending = None
                path_ok = proof['pass']
                emit({'event': 'gt_proof', 'kind': 'path', 'proof': proof})
                if not path_ok:
                    owner.stop('PATH_GT_REFUSED')
                    trial.finish('FAILED', 'PATH_GT_REFUSED')
            if raw and pose_pending is None:
                pose = {k: raw[k] for k in ('x', 'y', 'z', 'yaw')}
                pose_pending = pose_pool.submit(lambda p=pose, t=receipt: (geometry.pose(p), t))
            if path is not path_digest and not manual:
                path_ok = False
                if path_pending is None and path and raw:
                    path_digest = path
                    actual = {k: raw[k] for k in ('x', 'y', 'z', 'yaw')}
                    path_pending = path_pool.submit(geometry.path, actual, point, path,
                        deviation=policy['path_deviation_m'], heading_tolerance=config['start_yaw_rad'])
            if manual:
                path_ok = True
            obs = Observation(wall=now, sim=raw.get('sim_t', -1), received=receipt,
                episode=raw.get('episode', -1), map_sha=config['map_sha'] if view.get('map_ready') else '',
                x=raw.get('x'), y=raw.get('y'), yaw=raw.get('yaw'),
                vx=raw.get('vx'), vy=raw.get('vy'), wz=raw.get('wz'),
                tilt=raw.get('tilt_deg', 90), fallen=raw.get('fallen', True),
                policy_running=raw.get('policy_running', False), lockstep=raw.get('plugin_mode') == 'LOCKSTEP',
                cmd=tuple(raw.get('cmd_applied', [float('inf')]*3)),
                gt_clear=proof_ok and now-proof_at <= config['fresh_state_s'],
                frames_ready=bool(view.get('frames_ready')), single_writer=bridge.error is None,
                resources_ok=resources_ok, lifecycle_ready=bool(view.get('lifecycle_ready')),
                body_still=raw.get('body_still'))
            classify_rejection(trial, executor)
            if trial.status == 'NOT_STARTED':
                if not obs.gt_clear:
                    idle_tick()
                    await asyncio.sleep(.05)
                    continue
                trial.start(obs)
                if trial.status == 'RUNNING':
                    args.started = True
                if trial.status == 'RUNNING' and not manual:
                    executor.begin(binding, point)
            else:
                if args.trial > 4 and session.run and session.run['status'] != 'RUNNING':
                    trial.finish('FAILED', session.run.get('wait_reason') or 'RUN_AUTHORITY_LOST')
                trial.update(obs, executor.result)
            if any(obs.cmd) and first_nonzero is None:
                first_nonzero = now
            if args.trial <= 4 and first_nonzero is not None and trigger is None and now-first_nonzero >= config['manual_burst_wall_s']:
                trigger = now
                last_intent = view.get('intent_receive') if not manual else last_manual_receive
                trial.trigger_stop(obs, last_intent_receive=last_intent if name.endswith('silence') else None)
                if name.endswith('stop'):
                    owner.stop('PREREGISTERED_STOP')
                else:
                    bridge.extension.silenced = True
            if trigger is not None:
                output = view.get('ros_output')
                if output and output[0] == Z and output[1] >= trigger:
                    trial.ros_zero(output[1])
            if trial.status in ('SUCCEEDED', 'FAILED', 'BLOCKED_NOT_STARTED'):
                owner.stop(trial.reason)
                break
            if manual and trigger is None:
                allowed, reason = guard()
                seq += 1
                last_manual_receive = time.monotonic()
                owner.receive({'t': 'cmd', 'lease_id': session.lease_id, 'seq': seq,
                               'axes': [1, 0, 0] if allowed is True else [0, 0, 0]})
            idle_tick()
            drain(trial.records)
            await asyncio.sleep(.05)
        else:
            trial.finish('FAILED', 'HARD_LIMIT')
    except BaseException as exc:
        failures.append(exc)
        if trial is not None:
            trial.finish('BLOCKED_NOT_STARTED' if trial.status == 'NOT_STARTED' else 'FAILED', failure_reason(exc))
    finally:
        def attempt(operation):
            try:
                operation()
            except BaseException as exc:
                failures.append(exc)

        if owner is not None:
            attempt(owner.close)  # fixture ends -> 0 BEFORE ROS close/cancel
        attempt(bridge.close)
        for pool in (pose_pool, path_pool, resource_pool):
            attempt(lambda p=pool: p.shutdown(wait=False, cancel_futures=True))
        # Includes terminal owner.stop() before break AND close() effects, even
        # when close/bridge teardown raises. A failed drain cannot skip result
        # writing or journal closure, or leave a successful result behind.
        if owner is not None:
            attempt(lambda: drain(owner.journal))
        if failures:
            attempt(lambda: emit({'event': 'exception', 'type': type(failures[0]).__name__,
                                  'reason': failure_reason(failures[0])}))
        if trial is not None:
            attempt(lambda: drain(trial.records))
        attempt(log.close)
        result = {
            'trial': name, 'status': trial.status if trial else 'BLOCKED_NOT_STARTED',
            'reason': trial.reason if trial else 'NOT_STARTED',
            'isolated_start_id': args.isolated_start_id, 'cleanup_verified': False,
            'cleanup_reason': 'external native/Nav supervisor must verify owned process/cgroup cleanup',
            'adapter_counts': executor.counts, 'metrics': trial.metrics if trial else {},
            'r0_complete': False}
        if failures:
            result.update(status='FAILED' if getattr(args, 'started', False) else 'BLOCKED_NOT_STARTED',
                          reason=failure_reason(failures[0]),
                          errors=[{'type': type(e).__name__, 'reason': failure_reason(e)} for e in failures],
                          unsubmitted_owner_records=len(owner.journal) if owner else 0,
                          unsubmitted_trial_records=len(trial.records) if trial else 0)
        (args.output/'result.json').write_text(json.dumps(result, indent=2)+'\n')
    if failures:
        if hasattr(failures[0], 'add_note'):
            for exc in failures[1:]:
                failures[0].add_note(type(exc).__name__+': '+failure_reason(exc))
        raise failures[0]


async def execute(args, config, policy):
    # A fixed registered experiment is the authority for ALL attempts. --history
    # is deliberately not consumed. Reserve+fsync before opt-in/preflight/ROS.
    root = HERE.parents[3]/'runs'
    if not args.experiment.resolve().is_relative_to(root.resolve()):
        raise ValueError('experiment ledger must be registered under this worktree runs/')
    ledger = Ledger(args.experiment, config)
    attempt = ledger.reserve(args.trial, args.isolated_start_id, args.operator_confirmation)
    args.started = False
    result = None
    output_created = False
    try:
        if os.environ.get('FH_NAV2_EXECUTE') != '1':
            raise ValueError('separate execution approval plus FH_NAV2_EXECUTE=1 required')
        if not args.output.resolve().is_relative_to(root.resolve()):
            raise ValueError('output must be a NEW directory under this worktree runs/')
        args.output.mkdir(parents=True, exist_ok=False)
        output_created = True
        await _execute(args, config, policy)
        result = json.loads((args.output/'result.json').read_text())
        return result
    except BaseException as exc:
        result = {'trial': config['trials'][args.trial-1],
            'status': 'FAILED' if args.started else 'BLOCKED_NOT_STARTED', 'reason': failure_reason(exc),
            'isolated_start_id': args.isolated_start_id, 'cleanup_verified': False, 'r0_complete': False}
        if output_created:
            result_path = args.output/'result.json'
            try:
                details = json.loads(result_path.read_text())
            except (OSError, ValueError):
                details = {}
            result = {**details, **result}  # preserve teardown/recording failure evidence
            result_path.write_text(json.dumps(result, indent=2)+'\n')
        raise
    finally:
        if result is not None:
            ledger.finish(attempt, result)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--points', type=Path, default=HERE/'preregistration.json')
    p.add_argument('--trial', type=int, choices=range(1, 11), default=1)
    p.add_argument('--execute', action='store_true')
    p.add_argument('--replay', type=Path)
    p.add_argument('--map-source', type=Path)
    p.add_argument('--world', type=Path)
    p.add_argument('--output', type=Path)
    p.add_argument('--experiment', type=Path)
    p.add_argument('--operator-confirmation')
    p.add_argument('--isolated-start-id')
    p.add_argument('--seed', default='native seed not configurable/unverified')
    args = p.parse_args()
    config = json.loads(args.points.read_text())
    # Alternative point lists require a new reviewed preregistration, no quiet edits.
    if config != load('preregistration.json'):
        p.error('point list differs from frozen R0 preregistration')
    if args.execute:
        if not all((args.map_source, args.world, args.output, args.isolated_start_id, args.experiment, args.operator_confirmation)):
            p.error('execute requires map-source/world/output/isolated-start-id/registered experiment/operator-confirmation')
        asyncio.run(execute(args, config, load('policy.json')))
    elif args.replay:
        print(json.dumps(replay(config, select_point(config, 'G1'), args.replay), indent=2))
    else:
        print(json.dumps({'mode': 'OFFLINE_PLAN_ONLY', 'trial': config['trials'][args.trial-1],
                          'preregistration': config, 'ROS_started': False}, indent=2))


if __name__ == '__main__':
    main()

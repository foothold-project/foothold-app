"""Robot presentation and durable hello inventory; no inferred telemetry."""
from datetime import timedelta
from uuid import UUID

from sqlalchemy import select

from apps.contracts import models as C
from .models import Organization, Robot, RobotDevice, Run, ScenarioVersion, User, now


def save_inventory(factory, org_id, rid, devices, model=None, token_hash=None):
    with factory.begin() as db:
        robot = db.scalar(select(Robot).where(Robot.org_id == org_id, Robot.id == UUID(rid),
                                             Robot.archived_at.is_(None)).with_for_update())
        if robot is None or (token_hash is not None and robot.agent_token_hash != token_hash):
            return
        if model:
            robot.model = model
        robot.last_seen_at = now()
        existing = {d.key: d for d in db.scalars(select(RobotDevice).where(
            RobotDevice.org_id == org_id, RobotDevice.robot_id == robot.id))}
        for device in devices:
            row = existing.pop(device['key'], None)
            if row is None:
                row = RobotDevice(org_id=org_id, robot_id=robot.id, **device)
                db.add(row)
            else:
                for key, value in device.items():
                    setattr(row, key, value)
            row.updated_at = now()
        for row in existing.values():
            row.state, row.updated_at = 'MISSING', now()



def live_state(realtime, rid):
    peer = realtime.agents.get(rid)
    online = peer is not None and not peer.closing
    fresh = online and realtime.clock() - peer.state_received_at <= 3
    state = dict(peer.state) if fresh else {}
    location = state.get('location')
    if location and location.get('floor_context'):
        from datetime import datetime
        stamp = location['updated_at']
        stamp = datetime.fromisoformat(stamp.replace('Z', '+00:00')) if isinstance(stamp, str) else stamp
        if (now() - stamp).total_seconds() > 1:
            state['location'] = None
    return online, state


def reported_devices(realtime, rid):
    peer = realtime.agents.get(rid)
    return peer.state.get('devices', []) if peer and not peer.closing else None


def phone_relay(realtime, rid):
    """Separate display projection. Never used by online or capability checks."""
    cache = getattr(realtime, 'phone_telemetry', None)
    return cache.get(rid) if cache is not None else None


def device_error(realtime, rid, stored_error):
    # A connected agent's complete inventory supersedes persisted states;
    # omitted stored devices become MISSING, including any old ERROR.
    reported = reported_devices(realtime, rid)
    return any(d['state'] == 'ERROR' for d in reported) if reported is not None else stored_error


def attention(online, state, device_error, settings):
    if not online:
        return ['OFFLINE']
    result = ['STATE_STALE'] if not state else []
    if state.get('battery') and state['battery']['soc'] < settings.battery_low_pct:
        result.append('BATTERY_LOW')
    if state.get('status') in ('ERROR', 'STOP_LATCHED'):
        result.append(state['status'])
    if device_error:
        result.append('DEVICE_ERROR')
    return result


TERMINAL_RUNS = {'COMPLETED', 'FAILED', 'CANCELED', 'ABORTED'}


def is_running(state):
    reported = state.get('reported_run')
    if reported is not None:
        return reported['status'] not in TERMINAL_RUNS | {'PAUSED'}
    return state.get('status') == 'RUNNING'


def robot_objects(db, robots, user, realtime):
    if not robots:
        return []
    full_ids = [r.id for r in robots if user.role == 'ORG_ADMIN' or r.owner_user_id == user.id]
    snapshots = {str(rid): live_state(realtime, str(rid)) for rid in full_ids}
    owner_ids = {r.owner_user_id for r in robots if r.owner_user_id}
    owner_ids.update(UUID(state['controller']) for _, state in snapshots.values() if state.get('controller'))
    owners = {u.id: u for u in db.scalars(select(User).where(User.org_id == user.org_id,
        User.id.in_(owner_ids)))} if owner_ids else {}
    devices = {}
    if full_ids:
        for device in db.scalars(select(RobotDevice).where(RobotDevice.org_id == user.org_id,
                RobotDevice.robot_id.in_(full_ids)).order_by(RobotDevice.key)):
            devices.setdefault(device.robot_id, {})[device.key] = C.Device(key=device.key,
                kind=device.kind, label=device.label, state=device.state)
    settings = C.OrgSettings.model_validate(db.get(Organization, user.org_id).settings)
    current_runs = {}
    if full_ids:
        for run, version in db.execute(select(Run, ScenarioVersion).join(ScenarioVersion,
                ScenarioVersion.id == Run.scenario_version_id).where(Run.org_id == user.org_id,
                ScenarioVersion.org_id == user.org_id, Run.robot_id.in_(full_ids),
                Run.status.not_in(TERMINAL_RUNS))):
            current_runs[run.robot_id] = C.CurrentRun(id=run.id, status=run.status,
                scenario_name=version.name, progress=run.progress or
                {'done': min(run.step, len(version.waypoints)), 'total': len(version.waypoints)})
    result = []
    for robot in robots:
        owner = owners.get(robot.owner_user_id)
        full = user.role == 'ORG_ADMIN' or robot.owner_user_id == user.id
        online, state = snapshots[str(robot.id)] if full else (False, {})
        inventory = devices.get(robot.id, {})
        live_devices = reported_devices(realtime, str(robot.id)) if full else None
        if live_devices is not None:
            reported = {d['key']: C.Device(**d) for d in live_devices}
            inventory = {key: value.model_copy(update={'state': 'MISSING'})
                         for key, value in inventory.items() if key not in reported} | reported
        if not online:
            # Persisted inventory is history, not evidence that a disconnected
            # device is currently available. Keep rows unchanged for reconnect.
            inventory = {key: value.model_copy(update={'state': 'MISSING'})
                         for key, value in inventory.items()}
        lease = None
        record = realtime.arbiter.robots.get(str(robot.id)) if full else None
        holder = record.holder if record else None
        if holder and robot.simulation is True and not state.get('phone_reported'):
            lease = C.Lease(holder_type=holder.holder_type,
                user=C.Person(id=holder.actor.user, display_name=holder.actor.display_name) if holder.actor else None,
                since=now() - timedelta(seconds=max(0, realtime.clock() - holder.since)))
        controller = owners.get(UUID(state['controller'])) if state.get('controller') else None
        if (controller is not None and state.get('controller_since')
                and state.get('controller_connected') is True):
            lease = C.Lease(holder_type='RUN' if state.get('mode') == 'RUN' else 'USER',
                user=C.Person(id=controller.id, display_name=controller.display_name),
                since=state['controller_since'])
        current_run = current_runs.get(robot.id) if full else None
        reported_run = state.get('reported_run')
        if state.get('phone_reported') and reported_run is None:
            current_run = None
        if reported_run is not None:
            current_run = (C.CurrentRun(id=reported_run['run_id'], status=reported_run['status'],
                scenario_name=current_run.scenario_name if current_run and str(current_run.id) == reported_run['run_id']
                    else '시나리오 이름 수신 대기', progress=reported_run['progress'])
                if reported_run['status'] not in TERMINAL_RUNS else None)
        result.append(C.RobotSummary(id=robot.id, name=robot.name, model=robot.model, simulation=robot.simulation,
            phone_relay=phone_relay(realtime, str(robot.id)) if full else None,
            owner=C.Person(id=owner.id, display_name=owner.display_name) if owner else None,
            connection=('ONLINE' if online else 'OFFLINE') if full else 'UNKNOWN', status=state.get('status'),
            battery=state.get('battery'), location=state.get('location'), lease=lease,
            last_state_received_at=getattr(realtime, 'last_state_received', {}).get(str(robot.id)) if full else None,
            state_stale=(not bool(state)) if full else None,
            controller=C.Person(id=controller.id, display_name=controller.display_name) if controller else None,
            controller_device=state.get('controller_device'),
            controller_connected=state.get('controller_connected') if state else None,
            current_run=current_run, devices=list(inventory.values()) if full else [],
            attention=attention(online, state, any(d.state == 'ERROR' for d in inventory.values()), settings) if full else []))
    return result


def robot_object(db, robot, user, realtime):
    return robot_objects(db, [robot], user, realtime)[0]

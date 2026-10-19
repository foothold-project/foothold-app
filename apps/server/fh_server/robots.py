"""Robot presentation and durable hello inventory; no inferred telemetry."""
from datetime import timedelta
from uuid import UUID

from sqlalchemy import select

from apps.contracts import models as C
from .models import Organization, Robot, RobotDevice, User, now


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
    return online, dict(peer.state) if fresh else {}


def attention(online, state, device_error, settings):
    if not online:
        return ['OFFLINE']
    result = []
    if state.get('battery') and state['battery']['soc'] < settings.battery_low_pct:
        result.append('BATTERY_LOW')
    if state.get('status') in ('ERROR', 'STOP_LATCHED'):
        result.append(state['status'])
    if device_error:
        result.append('DEVICE_ERROR')
    return result


def robot_objects(db, robots, user, realtime):
    if not robots:
        return []
    owner_ids = {r.owner_user_id for r in robots if r.owner_user_id}
    owners = {u.id: u for u in db.scalars(select(User).where(User.org_id == user.org_id,
        User.id.in_(owner_ids)))} if owner_ids else {}
    full_ids = [r.id for r in robots if user.role == 'ORG_ADMIN' or r.owner_user_id == user.id]
    devices = {}
    if full_ids:
        for device in db.scalars(select(RobotDevice).where(RobotDevice.org_id == user.org_id,
                RobotDevice.robot_id.in_(full_ids)).order_by(RobotDevice.key)):
            devices.setdefault(device.robot_id, {})[device.key] = C.Device(key=device.key,
                kind=device.kind, label=device.label, state=device.state)
    settings = C.OrgSettings.model_validate(db.get(Organization, user.org_id).settings)
    result = []
    for robot in robots:
        owner = owners.get(robot.owner_user_id)
        full = user.role == 'ORG_ADMIN' or robot.owner_user_id == user.id
        online, state = live_state(realtime, str(robot.id)) if full else (False, {})
        inventory = devices.get(robot.id, {})
        peer = realtime.agents.get(str(robot.id)) if full else None
        if peer and not peer.closing:
            reported = {d['key']: C.Device(**d) for d in peer.state.get('devices', [])}
            inventory = {key: value.model_copy(update={'state': 'MISSING'})
                         for key, value in inventory.items() if key not in reported} | reported
        lease = None
        record = realtime.arbiter.robots.get(str(robot.id)) if full else None
        holder = record.holder if record else None
        if holder:
            lease = C.Lease(holder_type=holder.holder_type,
                user=C.Person(id=holder.actor.user, display_name=holder.actor.display_name) if holder.actor else None,
                since=now() - timedelta(seconds=max(0, realtime.clock() - holder.since)))
        result.append(C.RobotSummary(id=robot.id, name=robot.name, model=robot.model,
            owner=C.Person(id=owner.id, display_name=owner.display_name) if owner else None,
            connection=('ONLINE' if online else 'OFFLINE') if full else 'UNKNOWN', status=state.get('status'),
            battery=state.get('battery'), location=state.get('location'), lease=lease,
            current_run=None, devices=list(inventory.values()) if full else [],
            attention=attention(online, state, any(d.state == 'ERROR' for d in inventory.values()), settings) if full else []))
    return result


def robot_object(db, robot, user, realtime):
    return robot_objects(db, [robot], user, realtime)[0]

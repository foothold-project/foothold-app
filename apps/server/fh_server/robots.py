"""Robot presentation and durable hello inventory; no inferred telemetry."""
from datetime import timedelta
from uuid import UUID

from sqlalchemy import select

from apps.contracts import models as C
from .models import Organization, Robot, RobotDevice, User, now


def save_inventory(factory, org_id, rid, devices, model=None):
    with factory.begin() as db:
        robot = db.scalar(select(Robot).where(Robot.org_id == org_id, Robot.id == UUID(rid),
                                             Robot.archived_at.is_(None)).with_for_update())
        if robot is None:
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


def robot_object(db, robot, user, realtime):
    owner = db.get(User, robot.owner_user_id) if robot.owner_user_id else None
    full = user.role == 'ORG_ADMIN' or robot.owner_user_id == user.id
    peer = realtime.agents.get(str(robot.id)) if full else None
    online = peer is not None and not peer.closing
    state = dict(peer.state) if online else dict(realtime.last_states.get(str(robot.id), {})) if full else {}
    lease = None
    record = realtime.arbiter.robots.get(str(robot.id)) if full else None
    holder = record.holder if record else None
    if holder:
        lease = C.Lease(holder_type=holder.holder_type,
            user=C.Person(id=holder.actor.user, display_name=holder.actor.display_name) if holder.actor else None,
            since=now() - timedelta(seconds=max(0, realtime.clock() - holder.since)))
    devices = [C.Device(key=d.key, kind=d.kind, label=d.label, state=d.state)
        for d in db.scalars(select(RobotDevice).where(RobotDevice.org_id == robot.org_id,
            RobotDevice.robot_id == robot.id).order_by(RobotDevice.key))] if full else []
    attention = []
    if full:
        if not online:
            attention.append('OFFLINE')
        if state.get('battery') and state['battery']['soc'] < C.OrgSettings.model_validate(
                db.get(Organization, robot.org_id).settings).battery_low_pct:
            attention.append('BATTERY_LOW')
        if state.get('status') in ('ERROR', 'STOP_LATCHED'):
            attention.append(state['status'])
        if any(d.state == 'ERROR' for d in devices):
            attention.append('DEVICE_ERROR')
    return C.RobotSummary(id=robot.id, name=robot.name, model=robot.model,
        owner=C.Person(id=owner.id, display_name=owner.display_name) if owner else None,
        connection='ONLINE' if online else 'OFFLINE', status=state.get('status'),
        battery=state.get('battery'), location=state.get('location'), lease=lease,
        current_run=None, devices=devices, attention=attention)

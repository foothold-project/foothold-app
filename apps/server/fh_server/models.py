from datetime import datetime, timezone
from uuid import UUID, uuid4

from sqlalchemy import BigInteger, Boolean, Computed, Float, Integer, CheckConstraint, DateTime, ForeignKeyConstraint, Index, LargeBinary, Text, UniqueConstraint, func, text
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID as PGUUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


def now():
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


class Organization(Base):
    __tablename__ = 'organizations'
    id: Mapped[UUID] = mapped_column(PGUUID, primary_key=True, default=uuid4, server_default=text("gen_random_uuid()"))
    name: Mapped[str] = mapped_column(Text)
    settings: Mapped[dict] = mapped_column(JSONB, default=dict, server_default=text("'{}'::jsonb"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, server_default=func.now())


class Tenant:
    org_id: Mapped[UUID] = mapped_column(PGUUID, nullable=False)


class User(Tenant, Base):
    __tablename__ = 'users'
    __table_args__ = (
        ForeignKeyConstraint(['org_id'], ['organizations.id']),
        UniqueConstraint('org_id', 'id'),
        CheckConstraint("role IN ('ORG_ADMIN','OPERATOR')", name='user_role'),
    )
    id: Mapped[UUID] = mapped_column(PGUUID, primary_key=True, default=uuid4, server_default=text("gen_random_uuid()"))
    username: Mapped[str] = mapped_column(Text)
    display_name: Mapped[str] = mapped_column(Text)
    role: Mapped[str] = mapped_column(Text)
    password_hash: Mapped[str] = mapped_column(Text)
    locked: Mapped[bool] = mapped_column(Boolean, default=False, server_default=text("false"))
    notify_prefs: Mapped[dict] = mapped_column(JSONB, default=dict, server_default=text("'{}'::jsonb"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, server_default=func.now())
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


Index('users_org_username', User.org_id, func.lower(User.username), unique=True)


class Session(Tenant, Base):
    __tablename__ = 'sessions'
    __table_args__ = (
        ForeignKeyConstraint(['org_id', 'user_id'], ['users.org_id', 'users.id']),
        CheckConstraint("client IN ('web','app')", name='session_client'),
    )
    id: Mapped[UUID] = mapped_column(PGUUID, primary_key=True, default=uuid4, server_default=text("gen_random_uuid()"))
    user_id: Mapped[UUID] = mapped_column(PGUUID)
    token_hash: Mapped[bytes] = mapped_column(LargeBinary, unique=True)
    client: Mapped[str] = mapped_column(Text)
    device_label: Mapped[str] = mapped_column(Text, default='')
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, server_default=func.now())
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, server_default=func.now())
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Extensions needed for rotating app credentials and session-bound CSRF.
    refresh_hash: Mapped[bytes | None] = mapped_column(LargeBinary, unique=True)
    refresh_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    retired_refresh_hashes: Mapped[list] = mapped_column(JSONB, default=list, server_default=text("'[]'::jsonb"))
    csrf_hash: Mapped[bytes | None] = mapped_column(LargeBinary)


class Robot(Tenant, Base):
    simulation: Mapped[bool] = mapped_column(Boolean, default=False, server_default=text('false'))
    sim_generation: Mapped[int] = mapped_column(BigInteger, default=0, server_default=text('0'))
    sim_state: Mapped[str] = mapped_column(Text, default='IDLE', server_default=text("'IDLE'"))
    sim_manager_instance_id: Mapped[UUID | None] = mapped_column(PGUUID)
    __tablename__ = 'robots'
    __table_args__ = (
        ForeignKeyConstraint(['org_id'], ['organizations.id']),
        ForeignKeyConstraint(['org_id', 'owner_user_id'], ['users.org_id', 'users.id']),
        Index('robots_active_org_name', 'org_id', 'name', unique=True,
              postgresql_where=text('archived_at IS NULL')),
        UniqueConstraint('org_id', 'id'),
        ForeignKeyConstraint(['org_id', 'last_floor_id'], ['floors.org_id', 'floors.id'], name='robots_last_floor_fk'),
        CheckConstraint("last_floor_source IN ('HUMAN','AUTO')", name='floor_source'),
    )
    id: Mapped[UUID] = mapped_column(PGUUID, primary_key=True, default=uuid4, server_default=text("gen_random_uuid()"))
    name: Mapped[str] = mapped_column(Text)
    model: Mapped[str] = mapped_column(Text)
    owner_user_id: Mapped[UUID | None] = mapped_column(PGUUID)
    agent_token_hash: Mapped[bytes] = mapped_column(LargeBinary)
    # Floor FK is added in 0009; run/approval FKs follow their owned tables.
    last_floor_id: Mapped[UUID | None] = mapped_column(PGUUID)
    last_floor_source: Mapped[str | None] = mapped_column(Text)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, server_default=func.now())
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Event(Tenant, Base):
    __tablename__ = 'events'
    __table_args__ = (
        ForeignKeyConstraint(['org_id'], ['organizations.id']),
        ForeignKeyConstraint(['org_id', 'robot_id'], ['robots.org_id', 'robots.id']),
        ForeignKeyConstraint(['org_id', 'user_id'], ['users.org_id', 'users.id']),
        ForeignKeyConstraint(['org_id', 'approval_id'], ['approvals.org_id', 'approvals.id'], name='events_approval_fk'),
        ForeignKeyConstraint(['org_id', 'run_id'], ['runs.org_id', 'runs.id'], name='events_run_fk'),
        CheckConstraint("category IN ('RUN','ROUTE','LINK','LEASE','APPROVAL','SAFETY','ACCOUNT')", name='event_category'),
        CheckConstraint("severity IN ('INFO','WARN','ERROR')", name='event_severity'),
        UniqueConstraint('org_id', 'id'),
    )
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, server_default=func.now())
    robot_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    category: Mapped[str] = mapped_column(Text)
    code: Mapped[str] = mapped_column(Text)
    severity: Mapped[str] = mapped_column(Text, default='INFO')
    message: Mapped[str] = mapped_column(Text)
    robot_id: Mapped[UUID | None] = mapped_column(PGUUID)
    user_id: Mapped[UUID | None] = mapped_column(PGUUID)
    run_id: Mapped[UUID | None] = mapped_column(PGUUID)
    approval_id: Mapped[UUID | None] = mapped_column(PGUUID)
    data: Mapped[dict] = mapped_column(JSONB, default=dict, server_default=text("'{}'::jsonb"))


class AuthRateWindow(Tenant, Base):
    """Mutable denial counters; each closed key/window produces one audit row."""
    __tablename__ = 'auth_rate_windows'
    __table_args__ = (
        ForeignKeyConstraint(['org_id'], ['organizations.id']),
        ForeignKeyConstraint(['org_id', 'user_id'], ['users.org_id', 'users.id']),
        CheckConstraint("key_type IN ('LOGIN_IP','LOGIN_ACCOUNT','PASSWORD_ACCOUNT')", name='rate_window_key_type'),
        CheckConstraint('denied_count > 0', name='rate_window_positive_count'),
    )
    org_id: Mapped[UUID] = mapped_column(PGUUID, primary_key=True)
    key_type: Mapped[str] = mapped_column(Text, primary_key=True)
    key_hash: Mapped[str] = mapped_column(Text, primary_key=True)
    window_start: Mapped[datetime] = mapped_column(DateTime(timezone=True), primary_key=True)
    denied_count: Mapped[int] = mapped_column(BigInteger, default=1, server_default=text('1'))
    user_id: Mapped[UUID | None] = mapped_column(PGUUID)
    data: Mapped[dict] = mapped_column(JSONB, default=dict, server_default=text("'{}'::jsonb"))


Index('events_org_at', Event.org_id, Event.at.desc())
Index('events_robot_at', Event.robot_id, Event.at.desc())
Index('events_run_at', Event.run_id, Event.at)
Index('events_category_at', Event.category, Event.at.desc())
Index('events_org_at_id', Event.org_id, Event.at.desc(), Event.id.desc())
Index('auth_rate_windows_org_start', AuthRateWindow.org_id, AuthRateWindow.window_start)


class Notification(Tenant, Base):
    __tablename__ = 'notifications'
    __table_args__ = (
        ForeignKeyConstraint(['org_id', 'user_id'], ['users.org_id', 'users.id']),
        ForeignKeyConstraint(['org_id', 'event_id'], ['events.org_id', 'events.id']),
        UniqueConstraint('user_id', 'event_id', 'kind'),
    )
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    user_id: Mapped[UUID] = mapped_column(PGUUID)
    event_id: Mapped[int | None] = mapped_column(BigInteger)
    kind: Mapped[str] = mapped_column(Text)
    title: Mapped[str] = mapped_column(Text)
    body: Mapped[str] = mapped_column(Text)
    link: Mapped[str] = mapped_column(Text)
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, server_default=func.now())


Index('notifications_user_created_id', Notification.user_id, Notification.created_at.desc(), Notification.id.desc())
Index('notifications_user_unread', Notification.user_id, postgresql_where=text('read_at IS NULL'))


class LeaseLog(Tenant, Base):
    __tablename__ = 'lease_log'
    __table_args__ = (
        ForeignKeyConstraint(['org_id'], ['organizations.id']),
        ForeignKeyConstraint(['org_id', 'robot_id'], ['robots.org_id', 'robots.id']),
        ForeignKeyConstraint(['org_id', 'user_id'], ['users.org_id', 'users.id']),
        ForeignKeyConstraint(['org_id', 'other_user_id'], ['users.org_id', 'users.id']),
        CheckConstraint("op IN ('TAKE','RELEASE','REQUEST','ACCEPT','DECLINE','TIMEOUT','EXPIRE','RUN_TAKE','RUN_PAUSE_TAKEOVER')", name='lease_log_op'),
    )
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    robot_id: Mapped[UUID] = mapped_column(PGUUID)
    op: Mapped[str] = mapped_column(Text)
    user_id: Mapped[UUID | None] = mapped_column(PGUUID)
    other_user_id: Mapped[UUID | None] = mapped_column(PGUUID)
    session_id: Mapped[UUID | None] = mapped_column(PGUUID)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, server_default=func.now())


Index('lease_log_org_robot_at', LeaseLog.org_id, LeaseLog.robot_id, LeaseLog.at.desc())


class RobotDevice(Tenant, Base):
    __tablename__ = 'robot_devices'
    __table_args__ = (
        ForeignKeyConstraint(['org_id', 'robot_id'], ['robots.org_id', 'robots.id']),
        CheckConstraint("kind IN ('CAMERA_RGB','CAMERA_DEPTH','LIDAR','BATTERY','OTHER')", name='device_kind'),
        CheckConstraint("state IN ('OK','MISSING','ERROR')", name='device_state'),
    )
    robot_id: Mapped[UUID] = mapped_column(PGUUID, primary_key=True)
    key: Mapped[str] = mapped_column(Text, primary_key=True)
    kind: Mapped[str] = mapped_column(Text)
    label: Mapped[str] = mapped_column(Text)
    state: Mapped[str] = mapped_column(Text)
    info: Mapped[dict] = mapped_column(JSONB, default=dict, server_default=text("'{}'::jsonb"))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, server_default=func.now())


class Site(Tenant, Base):
    __tablename__ = 'sites'
    __table_args__ = (ForeignKeyConstraint(['org_id'], ['organizations.id']), UniqueConstraint('org_id', 'id'))
    id: Mapped[UUID] = mapped_column(PGUUID, primary_key=True, default=uuid4, server_default=text("gen_random_uuid()"))
    name: Mapped[str] = mapped_column(Text)


class Building(Tenant, Base):
    __tablename__ = 'buildings'
    __table_args__ = (ForeignKeyConstraint(['org_id', 'site_id'], ['sites.org_id', 'sites.id']), UniqueConstraint('org_id', 'id'),
        UniqueConstraint('org_id', 'sim_world_id'))
    sim_world_id: Mapped[str | None] = mapped_column(Text)
    id: Mapped[UUID] = mapped_column(PGUUID, primary_key=True, default=uuid4, server_default=text("gen_random_uuid()"))
    site_id: Mapped[UUID] = mapped_column(PGUUID)
    name: Mapped[str] = mapped_column(Text)


class Floor(Tenant, Base):
    __tablename__ = 'floors'
    __table_args__ = (
        CheckConstraint("provenance IN ('HUMAN','SIMULATION')", name='floor_provenance'),
        UniqueConstraint('building_id', 'sim_floor_id'),
        ForeignKeyConstraint(['org_id', 'building_id'], ['buildings.org_id', 'buildings.id']),
        UniqueConstraint('org_id', 'id'),
        ForeignKeyConstraint(['org_id', 'id', 'approved_version_id'],
            ['map_versions.org_id', 'map_versions.floor_id', 'map_versions.id'],
            name='floors_approved_version_fk', use_alter=True),
    )
    id: Mapped[UUID] = mapped_column(PGUUID, primary_key=True, default=uuid4, server_default=text("gen_random_uuid()"))
    provenance: Mapped[str] = mapped_column(Text, default='HUMAN', server_default=text("'HUMAN'"))
    sim_floor_id: Mapped[str | None] = mapped_column(Text)
    floor_z: Mapped[float | None] = mapped_column(Float)
    building_id: Mapped[UUID] = mapped_column(PGUUID)
    name: Mapped[str] = mapped_column(Text)
    level: Mapped[int] = mapped_column(Integer)
    approved_version_id: Mapped[UUID | None] = mapped_column(PGUUID)


class Upload(Tenant, Base):
    provenance: Mapped[str] = mapped_column(Text, default='HUMAN', server_default=text("'HUMAN'"))
    __tablename__ = 'uploads'
    __table_args__ = (
        CheckConstraint("provenance IN ('HUMAN','SIMULATION')", name='upload_provenance'),
        ForeignKeyConstraint(['org_id', 'created_by'], ['users.org_id', 'users.id']),
        UniqueConstraint('org_id', 'id'),
    )
    id: Mapped[UUID] = mapped_column(PGUUID, primary_key=True, default=uuid4, server_default=text("gen_random_uuid()"))
    image_path: Mapped[str] = mapped_column(Text)
    image_sha256: Mapped[bytes] = mapped_column(LargeBinary)
    png_sha256: Mapped[bytes] = mapped_column(LargeBinary)
    size_bytes: Mapped[int] = mapped_column(Integer)
    width: Mapped[int] = mapped_column(Integer)
    height: Mapped[int] = mapped_column(Integer)
    metadata_json: Mapped[dict] = mapped_column(JSONB)
    created_by: Mapped[UUID] = mapped_column(PGUUID)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, server_default=func.now())


class MapVersion(Tenant, Base):
    provenance: Mapped[str] = mapped_column(Text, default='HUMAN', server_default=text("'HUMAN'"))
    __tablename__ = 'map_versions'
    __table_args__ = (
        CheckConstraint("provenance IN ('HUMAN','SIMULATION')", name='map_version_provenance'),
        ForeignKeyConstraint(['org_id', 'floor_id'], ['floors.org_id', 'floors.id']),
        ForeignKeyConstraint(['org_id', 'floor_id', 'base_version_id'], ['map_versions.org_id', 'map_versions.floor_id', 'map_versions.id']),
        ForeignKeyConstraint(['org_id', 'upload_id'], ['uploads.org_id', 'uploads.id']),
        ForeignKeyConstraint(['org_id', 'created_by'], ['users.org_id', 'users.id']),
        UniqueConstraint('org_id', 'floor_id', 'id'), UniqueConstraint('org_id', 'id'),
        UniqueConstraint('floor_id', 'number'),
        CheckConstraint("status IN ('PENDING','APPROVED','REJECTED','CANCELED','SUPERSEDED')", name='map_version_status'),
        CheckConstraint("source IN ('SLAM','EDIT','ROLLBACK','IMPORT')", name='map_version_source'),
    )
    id: Mapped[UUID] = mapped_column(PGUUID, primary_key=True, default=uuid4, server_default=text("gen_random_uuid()"))
    floor_id: Mapped[UUID] = mapped_column(PGUUID)
    number: Mapped[int] = mapped_column(Integer)
    base_version_id: Mapped[UUID | None] = mapped_column(PGUUID)
    copied_from_id: Mapped[UUID | None] = mapped_column(PGUUID)
    upload_id: Mapped[UUID] = mapped_column(PGUUID)
    status: Mapped[str] = mapped_column(Text)
    image_path: Mapped[str] = mapped_column(Text)
    image_sha256: Mapped[bytes] = mapped_column(LargeBinary)
    width: Mapped[int] = mapped_column(Integer)
    height: Mapped[int] = mapped_column(Integer)
    resolution: Mapped[float] = mapped_column(Float)
    origin_x: Mapped[float] = mapped_column(Float)
    origin_y: Mapped[float] = mapped_column(Float)
    origin_yaw: Mapped[float] = mapped_column(Float)
    features: Mapped[dict] = mapped_column(JSONB)
    reason: Mapped[str] = mapped_column(Text)
    source: Mapped[str] = mapped_column(Text)
    created_by: Mapped[UUID] = mapped_column(PGUUID)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, server_default=func.now())


class FloorConnector(Tenant, Base):
    __tablename__ = 'floor_connectors'
    __table_args__ = (
        ForeignKeyConstraint(['org_id', 'building_id'], ['buildings.org_id', 'buildings.id']),
        ForeignKeyConstraint(['org_id', 'floor_a_id', 'map_version_a_id'], ['map_versions.org_id', 'map_versions.floor_id', 'map_versions.id']),
        ForeignKeyConstraint(['org_id', 'floor_b_id'], ['floors.org_id', 'floors.id']),
        ForeignKeyConstraint(['org_id', 'floor_b_id', 'map_version_b_id'], ['map_versions.org_id', 'map_versions.floor_id', 'map_versions.id']),
        CheckConstraint("kind IN ('STAIRS','ELEVATOR')", name='connector_kind'),
    )
    id: Mapped[UUID] = mapped_column(PGUUID, primary_key=True, default=uuid4)
    building_id: Mapped[UUID] = mapped_column(PGUUID)
    kind: Mapped[str] = mapped_column(Text)
    floor_a_id: Mapped[UUID] = mapped_column(PGUUID)
    floor_b_id: Mapped[UUID] = mapped_column(PGUUID)
    a_pose: Mapped[dict] = mapped_column(JSONB)
    b_pose: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    map_version_a_id: Mapped[UUID] = mapped_column(PGUUID)
    map_version_b_id: Mapped[UUID | None] = mapped_column(PGUUID)
    active: Mapped[bool] = mapped_column(Boolean)


class Approval(Tenant, Base):
    __tablename__ = 'approvals'
    __table_args__ = (
        ForeignKeyConstraint(['org_id', 'requester_id'], ['users.org_id', 'users.id']),
        ForeignKeyConstraint(['org_id', 'decider_id'], ['users.org_id', 'users.id']),
        ForeignKeyConstraint(['org_id', 'map_target_id'], ['map_versions.org_id', 'map_versions.id'], name='approval_map_target_fk'),
        ForeignKeyConstraint(['org_id', 'assignment_target_id'], ['assignments.org_id', 'assignments.id'], name='approval_assignment_target_fk', use_alter=True),
        ForeignKeyConstraint(['org_id', 'base_ref_id'], ['map_versions.org_id', 'map_versions.id']),
        UniqueConstraint('org_id', 'id'),
        CheckConstraint("kind IN ('MAP_REVISION','MAP_ROLLBACK','SCENARIO_ASSIGNMENT')", name='approval_kind'),
        CheckConstraint("status IN ('PENDING','APPROVED','REJECTED','CANCELED','STALE')", name='approval_status'),
        CheckConstraint("(kind IN ('MAP_REVISION','MAP_ROLLBACK') AND target_type = 'map_version') OR (kind = 'SCENARIO_ASSIGNMENT' AND target_type = 'assignment' AND base_ref_id IS NULL)", name='approval_target_type'),
        CheckConstraint("(base_ref_id IS NULL AND base_ref_type IS NULL) OR (base_ref_id IS NOT NULL AND base_ref_type IS NOT NULL AND base_ref_type = 'map_version')", name='approval_base_ref'),
        CheckConstraint("status != 'REJECTED' OR (decision_comment IS NOT NULL AND decision_comment ~ '[^[:space:]]')", name='approval_reject_reason'),
        CheckConstraint("(status = 'PENDING' AND decided_at IS NULL AND decider_id IS NULL) OR (status != 'PENDING' AND decided_at IS NOT NULL AND decider_id IS NOT NULL)", name='approval_decision'),
        Index('approvals_org_status_created', 'org_id', 'status', 'created_at'),
        Index('approvals_requester_status', 'requester_id', 'status'),
        Index('approvals_pending_target', 'target_type', 'target_id', unique=True, postgresql_where=text("status = 'PENDING'")),
    )
    id: Mapped[UUID] = mapped_column(PGUUID, primary_key=True, default=uuid4, server_default=text("gen_random_uuid()"))
    kind: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(Text)
    target_type: Mapped[str] = mapped_column(Text, default='map_version')
    map_target_id: Mapped[UUID | None] = mapped_column(PGUUID, Computed("CASE WHEN target_type = 'map_version' THEN target_id END", persisted=True))
    assignment_target_id: Mapped[UUID | None] = mapped_column(PGUUID, Computed("CASE WHEN target_type = 'assignment' THEN target_id END", persisted=True))
    target_id: Mapped[UUID] = mapped_column(PGUUID)
    base_ref_type: Mapped[str | None] = mapped_column(Text)
    base_ref_id: Mapped[UUID | None] = mapped_column(PGUUID)
    requester_id: Mapped[UUID] = mapped_column(PGUUID)
    reason: Mapped[str] = mapped_column(Text)
    decider_id: Mapped[UUID | None] = mapped_column(PGUUID)
    decision_comment: Mapped[str | None] = mapped_column(Text)
    emergency: Mapped[bool] = mapped_column(Boolean, default=False, server_default=text('false'))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, server_default=func.now())
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class VersionedResource(Tenant):
    id: Mapped[UUID] = mapped_column(PGUUID, primary_key=True, default=uuid4, server_default=text('gen_random_uuid()'))
    name: Mapped[str] = mapped_column(Text)
    created_by: Mapped[UUID] = mapped_column(PGUUID)
    latest_version: Mapped[int] = mapped_column(Integer)
    version: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, server_default=func.now())
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Mission(VersionedResource, Base):
    __tablename__ = 'missions'
    __table_args__ = (
        ForeignKeyConstraint(['org_id', 'created_by'], ['users.org_id', 'users.id']),
        UniqueConstraint('org_id', 'id'),
        CheckConstraint('latest_version > 0 AND version > 0', name='mission_versions_positive'),
        Index('missions_org_created', 'org_id', 'created_at', 'id'),
    )


class Scenario(VersionedResource, Base):
    __tablename__ = 'scenarios'
    __table_args__ = (
        ForeignKeyConstraint(['org_id', 'created_by'], ['users.org_id', 'users.id']),
        UniqueConstraint('org_id', 'id'),
        CheckConstraint('latest_version > 0 AND version > 0', name='scenario_versions_positive'),
        Index('scenarios_org_created', 'org_id', 'created_at', 'id'),
    )


class ResourceSnapshot(Tenant):
    id: Mapped[UUID] = mapped_column(PGUUID, primary_key=True, default=uuid4, server_default=text('gen_random_uuid()'))
    name: Mapped[str] = mapped_column(Text)
    number: Mapped[int] = mapped_column(Integer)
    required_devices: Mapped[list[str]] = mapped_column(ARRAY(Text))
    created_by: Mapped[UUID] = mapped_column(PGUUID)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, server_default=func.now())


class MissionVersion(ResourceSnapshot, Base):
    __tablename__ = 'mission_versions'
    __table_args__ = (
        ForeignKeyConstraint(['org_id', 'mission_id'], ['missions.org_id', 'missions.id']),
        ForeignKeyConstraint(['org_id', 'created_by'], ['users.org_id', 'users.id']),
        UniqueConstraint('mission_id', 'number'),
        CheckConstraint('number > 0', name='mission_number_positive'),
    )
    mission_id: Mapped[UUID] = mapped_column(PGUUID)
    steps: Mapped[list] = mapped_column(JSONB)


class ScenarioVersion(ResourceSnapshot, Base):
    __tablename__ = 'scenario_versions'
    __table_args__ = (
        ForeignKeyConstraint(['org_id', 'scenario_id'], ['scenarios.org_id', 'scenarios.id']),
        ForeignKeyConstraint(['org_id', 'created_by'], ['users.org_id', 'users.id']),
        UniqueConstraint('scenario_id', 'number'),
        UniqueConstraint('org_id', 'id'),
        CheckConstraint('number > 0', name='scenario_number_positive'),
    )
    scenario_id: Mapped[UUID] = mapped_column(PGUUID)
    waypoints: Mapped[list] = mapped_column(JSONB)
    finish: Mapped[dict] = mapped_column(JSONB)
    notes: Mapped[str] = mapped_column(Text)
    floor_ids: Mapped[list[UUID]] = mapped_column(ARRAY(PGUUID))
    map_version_ids: Mapped[list[UUID]] = mapped_column(ARRAY(PGUUID))
    est_distance_m: Mapped[float] = mapped_column(Float)


class Assignment(Tenant, Base):
    __tablename__ = 'assignments'
    __table_args__ = (
        UniqueConstraint('org_id', 'id'),
        ForeignKeyConstraint(['org_id', 'scenario_version_id'], ['scenario_versions.org_id', 'scenario_versions.id']),
        ForeignKeyConstraint(['org_id', 'robot_id'], ['robots.org_id', 'robots.id']),
        ForeignKeyConstraint(['org_id', 'created_by'], ['users.org_id', 'users.id']),
        ForeignKeyConstraint(['org_id', 'approval_id'], ['approvals.org_id', 'approvals.id']),
        CheckConstraint("status IN ('PENDING','ACTIVE','REJECTED','REMOVED')", name='assignment_status'),
        CheckConstraint("(status = 'REMOVED') = (removed_at IS NOT NULL)", name='assignment_removed'),
        Index('assignments_live_pair', 'robot_id', 'scenario_version_id', unique=True,
              postgresql_where=text("status IN ('ACTIVE','PENDING')")),
        Index('assignments_org_created', 'org_id', 'created_at', 'id'),
    )
    id: Mapped[UUID] = mapped_column(PGUUID, primary_key=True, default=uuid4, server_default=text('gen_random_uuid()'))
    scenario_version_id: Mapped[UUID] = mapped_column(PGUUID)
    robot_id: Mapped[UUID] = mapped_column(PGUUID)
    status: Mapped[str] = mapped_column(Text)
    approval_id: Mapped[UUID | None] = mapped_column(PGUUID)
    memo: Mapped[str] = mapped_column(Text)
    created_by: Mapped[UUID] = mapped_column(PGUUID)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, server_default=func.now())
    removed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class IdempotencyReceipt(Tenant, Base):
    __tablename__ = 'idempotency_receipts'
    __table_args__ = (
        ForeignKeyConstraint(['org_id', 'user_id'], ['users.org_id', 'users.id']),
        CheckConstraint("key ~ '^[A-Za-z0-9._:-]{1,128}$'", name='receipt_key'),
    )
    user_id: Mapped[UUID] = mapped_column(PGUUID, primary_key=True)
    key: Mapped[str] = mapped_column(Text, primary_key=True)
    request_hash: Mapped[str] = mapped_column(Text)
    response: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    status_code: Mapped[int | None] = mapped_column(Integer)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class PhonePass(Tenant, Base):
    """Issuer metadata only: never persist the compact JWS or its signature."""
    __tablename__ = 'phone_passes'
    __table_args__ = (
        ForeignKeyConstraint(['org_id', 'user_id'], ['users.org_id', 'users.id']),
        ForeignKeyConstraint(['org_id', 'robot_id'], ['robots.org_id', 'robots.id']),
        Index('phone_passes_identity_exp', 'org_id', 'user_id', 'device', 'exp'),
        CheckConstraint("purpose IN ('control','view')", name='phone_pass_purpose'),
        CheckConstraint('exp > iat AND exp - iat <= 600', name='phone_pass_lifetime'),
    )
    jti: Mapped[UUID] = mapped_column(PGUUID, primary_key=True)
    user_id: Mapped[UUID] = mapped_column(PGUUID)
    device: Mapped[UUID] = mapped_column(PGUUID)
    robot_id: Mapped[UUID] = mapped_column(PGUUID)
    purpose: Mapped[str] = mapped_column(Text)
    iat: Mapped[int] = mapped_column(BigInteger)
    exp: Mapped[int] = mapped_column(BigInteger)


class PhoneRevocationBatch(Tenant, Base):
    __tablename__ = 'phone_revocation_batches'
    __table_args__ = (
        ForeignKeyConstraint(['org_id', 'robot_id'], ['robots.org_id', 'robots.id']),
        UniqueConstraint('org_id', 'robot_id', 'id'),
        Index('phone_revocation_batches_robot_until', 'org_id', 'robot_id', 'until'),
    )
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    robot_id: Mapped[UUID] = mapped_column(PGUUID)
    items: Mapped[list] = mapped_column(JSONB)
    until: Mapped[int] = mapped_column(BigInteger)


class PhonePassDenials(Tenant, Base):
    __tablename__ = 'phone_pass_denials'
    __table_args__ = (ForeignKeyConstraint(['org_id'], ['organizations.id']),)
    org_id: Mapped[UUID] = mapped_column(PGUUID, primary_key=True)
    count: Mapped[int] = mapped_column(BigInteger)
    reported_at: Mapped[float] = mapped_column(Float)
    reasons: Mapped[dict] = mapped_column(JSONB)
    users: Mapped[dict] = mapped_column(JSONB)


class PhoneRevocation(Tenant, Base):
    __tablename__ = 'phone_revocations'
    __table_args__ = (
        ForeignKeyConstraint(['org_id', 'robot_id'], ['robots.org_id', 'robots.id']),
        UniqueConstraint('jti'),
        ForeignKeyConstraint(['org_id', 'robot_id', 'batch_id'],
            ['phone_revocation_batches.org_id', 'phone_revocation_batches.robot_id', 'phone_revocation_batches.id']),
        Index('phone_revocations_robot_until', 'org_id', 'robot_id', 'until'),
    )
    seq: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    robot_id: Mapped[UUID] = mapped_column(PGUUID)
    jti: Mapped[UUID] = mapped_column(PGUUID)
    until: Mapped[int] = mapped_column(BigInteger)
    batch_id: Mapped[int] = mapped_column(BigInteger)
    acked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Run(Tenant, Base):
    __tablename__ = 'runs'
    __table_args__ = (
        UniqueConstraint('org_id', 'id'),
        ForeignKeyConstraint(['org_id', 'robot_id'], ['robots.org_id', 'robots.id']),
        ForeignKeyConstraint(['org_id', 'assignment_id'], ['assignments.org_id', 'assignments.id']),
        ForeignKeyConstraint(['org_id', 'scenario_version_id'], ['scenario_versions.org_id', 'scenario_versions.id']),
        ForeignKeyConstraint(['org_id', 'started_by'], ['users.org_id', 'users.id']),
        ForeignKeyConstraint(['org_id', 'map_version_id'], ['map_versions.org_id', 'map_versions.id']),
        ForeignKeyConstraint(['org_id', 'floor_id'], ['floors.org_id', 'floors.id']),
        CheckConstraint('simulation OR assignment_id IS NOT NULL', name='run_real_assignment'),
        CheckConstraint("status IN ('QUEUED','PREPARING','MOVING','RUNNING','AT_WAYPOINT','PERFORMING','WAIT_CONFIRM','PAUSED','COMPLETED','FAILED','CANCELED','ABORTED')", name='run_status'),
        Index('one_active_run', 'robot_id', unique=True, postgresql_where=text("status NOT IN ('COMPLETED','FAILED','CANCELED','ABORTED')")),
    )
    id: Mapped[UUID] = mapped_column(PGUUID, primary_key=True)
    robot_id: Mapped[UUID] = mapped_column(PGUUID)
    assignment_id: Mapped[UUID | None] = mapped_column(PGUUID)
    simulation: Mapped[bool] = mapped_column(Boolean)
    scenario_version_id: Mapped[UUID] = mapped_column(PGUUID)
    floor_id: Mapped[UUID] = mapped_column(PGUUID)
    map_version_id: Mapped[UUID] = mapped_column(PGUUID)
    started_by: Mapped[UUID] = mapped_column(PGUUID)
    device_id: Mapped[UUID] = mapped_column(PGUUID)
    surface: Mapped[str] = mapped_column(Text)
    screen_id: Mapped[UUID] = mapped_column(PGUUID)
    agent_instance_id: Mapped[UUID] = mapped_column(PGUUID)
    status: Mapped[str] = mapped_column(Text)
    step: Mapped[int] = mapped_column(Integer, default=0, server_default=text('0'))
    progress: Mapped[dict | None] = mapped_column(JSONB)
    wait_reason: Mapped[str | None] = mapped_column(Text)
    fail_code: Mapped[str | None] = mapped_column(Text)
    fail_message: Mapped[str | None] = mapped_column(Text)
    emergency: Mapped[bool] = mapped_column(Boolean, default=False, server_default=text('false'))
    emergency_reason: Mapped[str | None] = mapped_column(Text)
    plan: Mapped[dict] = mapped_column(JSONB)
    path_actual: Mapped[list] = mapped_column(JSONB, default=list, server_default=text("'[]'::jsonb"))
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, server_default=func.now())
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class RunStep(Tenant, Base):
    __tablename__ = 'run_steps'
    __table_args__ = (
        ForeignKeyConstraint(['org_id', 'run_id'], ['runs.org_id', 'runs.id']),
        CheckConstraint('idx >= 0 AND idx < 200', name='run_step_idx'),
        CheckConstraint("status IN ('PENDING','ARRIVED','DONE','SKIPPED','FAILED')", name='run_step_status'),
    )
    run_id: Mapped[UUID] = mapped_column(PGUUID, primary_key=True)
    idx: Mapped[int] = mapped_column(Integer, primary_key=True)
    status: Mapped[str] = mapped_column(Text)
    arrived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    done_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    results: Mapped[dict] = mapped_column(JSONB, default=dict, server_default=text("'{}'::jsonb"))


class RunReport(Tenant, Base):
    """Immutable receipt in the same transaction as the reported changes."""
    __tablename__ = 'run_reports'
    __table_args__ = (
        ForeignKeyConstraint(['org_id', 'robot_id'], ['robots.org_id', 'robots.id']),
        CheckConstraint('report_seq >= 0', name='run_report_seq'),
    )
    robot_id: Mapped[UUID] = mapped_column(PGUUID, primary_key=True)
    agent_instance_id: Mapped[UUID] = mapped_column(PGUUID, primary_key=True)
    report_seq: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    request_hash: Mapped[str] = mapped_column(Text)
    monotonic_s: Mapped[float] = mapped_column(Float)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, server_default=func.now())


class RunReportRejection(Tenant, Base):
    """Immutable quarantine decisions; these consume FIFO sequence numbers too."""
    __tablename__ = 'run_report_rejections'
    __table_args__ = (
        ForeignKeyConstraint(['org_id', 'robot_id'], ['robots.org_id', 'robots.id']),
        CheckConstraint('report_seq >= 0', name='run_rejection_seq'),
    )
    robot_id: Mapped[UUID] = mapped_column(PGUUID, primary_key=True)
    agent_instance_id: Mapped[UUID] = mapped_column(PGUUID, primary_key=True)
    report_seq: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    request_hash: Mapped[str] = mapped_column(Text, primary_key=True)
    monotonic_s: Mapped[float] = mapped_column(Float)
    run_id: Mapped[UUID | None] = mapped_column(PGUUID)
    code: Mapped[str] = mapped_column(Text)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, server_default=func.now())


class AgentPlanMap(Tenant, Base):
    """Map access granted only by an authenticated immutable scenario lookup."""
    __tablename__ = 'agent_plan_maps'
    __table_args__ = (
        ForeignKeyConstraint(['org_id', 'robot_id'], ['robots.org_id', 'robots.id']),
        ForeignKeyConstraint(['org_id', 'scenario_version_id'], ['scenario_versions.org_id', 'scenario_versions.id']),
        ForeignKeyConstraint(['org_id', 'map_version_id'], ['map_versions.org_id', 'map_versions.id']),
    )
    robot_id: Mapped[UUID] = mapped_column(PGUUID, primary_key=True)
    scenario_version_id: Mapped[UUID] = mapped_column(PGUUID, primary_key=True)
    map_version_id: Mapped[UUID] = mapped_column(PGUUID, primary_key=True)


class Photo(Tenant, Base):
    """Immutable upload identity/receipt; failed attempts retain metadata only."""
    __tablename__ = 'photos'
    __table_args__ = (
        UniqueConstraint('org_id', 'id'),
        UniqueConstraint('org_id', 'robot_id', 'idempotency_key'),
        UniqueConstraint('org_id', 'run_id', 'waypoint_idx', 'step_idx'),
        ForeignKeyConstraint(['org_id', 'robot_id'], ['robots.org_id', 'robots.id']),
        ForeignKeyConstraint(['org_id', 'run_id'], ['runs.org_id', 'runs.id']),
        ForeignKeyConstraint(['run_id', 'waypoint_idx'], ['run_steps.run_id', 'run_steps.idx']),
        CheckConstraint("status IN ('STORED','FAILED')", name='photo_status'),
        CheckConstraint("source = 'rgb'", name='photo_source'),
        CheckConstraint('byte_length BETWEEN 4 AND 65536', name='photo_size'),
        CheckConstraint('step_idx BETWEEN 0 AND 99', name='photo_step'),
        CheckConstraint("sha256 ~ '^[0-9a-f]{64}$'", name='photo_sha256'),
        CheckConstraint("(status = 'STORED') = (stored_at IS NOT NULL)", name='photo_receipt'),
    )
    id: Mapped[UUID] = mapped_column(PGUUID, primary_key=True, default=uuid4)
    robot_id: Mapped[UUID] = mapped_column(PGUUID)
    run_id: Mapped[UUID] = mapped_column(PGUUID)
    waypoint_idx: Mapped[int] = mapped_column(Integer)
    step_idx: Mapped[int] = mapped_column(Integer)
    source: Mapped[str] = mapped_column(Text)
    captured_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    sha256: Mapped[str] = mapped_column(Text)
    byte_length: Mapped[int] = mapped_column(Integer)
    path: Mapped[str] = mapped_column(Text)
    idempotency_key: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(Text)
    stored_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

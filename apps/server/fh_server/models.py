from datetime import datetime, timezone
from uuid import UUID, uuid4

from sqlalchemy import BigInteger, Boolean, CheckConstraint, DateTime, ForeignKeyConstraint, Index, LargeBinary, Text, UniqueConstraint, func, text
from sqlalchemy.dialects.postgresql import JSONB, UUID as PGUUID
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
    __tablename__ = 'robots'
    __table_args__ = (
        ForeignKeyConstraint(['org_id'], ['organizations.id']),
        ForeignKeyConstraint(['org_id', 'owner_user_id'], ['users.org_id', 'users.id']),
        UniqueConstraint('org_id', 'name'),
        UniqueConstraint('org_id', 'id'),
        CheckConstraint("last_floor_source IN ('HUMAN','AUTO')", name='floor_source'),
    )
    id: Mapped[UUID] = mapped_column(PGUUID, primary_key=True, default=uuid4, server_default=text("gen_random_uuid()"))
    name: Mapped[str] = mapped_column(Text)
    model: Mapped[str] = mapped_column(Text)
    owner_user_id: Mapped[UUID | None] = mapped_column(PGUUID)
    agent_token_hash: Mapped[bytes] = mapped_column(LargeBinary)
    # Floor/run/approval FKs follow when their owned tables are implemented.
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
        CheckConstraint("category IN ('RUN','ROUTE','LINK','LEASE','APPROVAL','SAFETY','ACCOUNT')", name='event_category'),
        CheckConstraint("severity IN ('INFO','WARN','ERROR')", name='event_severity'),
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
Index('auth_rate_windows_org_start', AuthRateWindow.org_id, AuthRateWindow.window_start)


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

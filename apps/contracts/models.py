"""Pydantic v2 source for FH-SPEC-05 §§1, 2, 3, 8."""
from typing import Any, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field

Role = Literal['ORG_ADMIN', 'OPERATOR']
Category = Literal['RUN', 'ROUTE', 'LINK', 'LEASE', 'APPROVAL', 'SAFETY', 'ACCOUNT']


class Contract(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)


class Error(Contract):
    code: str
    message: str
    detail: dict[str, Any] = Field(default_factory=dict)


class ApiError(Contract):
    error: Error


class LoginRequest(Contract):
    username: str = Field(min_length=1, max_length=128)
    password: str = Field(min_length=1, max_length=1024)
    client: Literal['web', 'app'] = 'web'
    device_label: str = Field(default='', max_length=128)


class User(Contract):
    id: UUID
    username: str
    display_name: str
    role: Role
    locked: bool
    robot_ids: list[UUID]
    created_at: AwareDatetime


class LoginResponse(User):
    csrf_token: str | None = None
    access_token: str | None = None
    refresh_token: str | None = None


class RefreshRequest(Contract):
    refresh_token: str = Field(min_length=1, max_length=256)


class TokenResponse(Contract):
    access_token: str
    refresh_token: str


class MePatch(Contract):
    display_name: str | None = Field(default=None, min_length=1, max_length=128)
    notify_prefs: dict[str, bool] | None = None


class PasswordChange(Contract):
    current_password: str = Field(min_length=1, max_length=1024)
    new_password: str = Field(min_length=1, max_length=1024)


class UserCreate(Contract):
    username: str = Field(min_length=1, max_length=128)
    display_name: str = Field(min_length=1, max_length=128)
    role: Role
    temp_password: str = Field(min_length=1, max_length=1024)


class UserPatch(Contract):
    display_name: str | None = Field(default=None, min_length=1, max_length=128)
    role: Role | None = None
    locked: bool | None = None


class Session(Contract):
    id: UUID
    client: Literal['web', 'app']
    device_label: str
    created_at: AwareDatetime
    last_seen_at: AwareDatetime
    expires_at: AwareDatetime
    revoked_at: AwareDatetime | None


class Person(Contract):
    id: UUID
    display_name: str


class Battery(Contract):
    soc: float = Field(ge=0, le=100)
    updated_at: AwareDatetime


class Location(Contract):
    floor_id: UUID
    map_version_id: UUID
    x: float
    y: float
    yaw: float
    confidence: float = Field(ge=0, le=1)
    updated_at: AwareDatetime


class Lease(Contract):
    holder_type: Literal['USER', 'RUN']
    user: Person | None
    since: AwareDatetime


class Progress(Contract):
    done: int = Field(ge=0)
    total: int = Field(ge=0)


class CurrentRun(Contract):
    id: UUID
    status: Literal['QUEUED', 'PREPARING', 'MOVING', 'AT_WAYPOINT', 'PERFORMING', 'PAUSED', 'WAIT_CONFIRM', 'COMPLETED', 'FAILED', 'ABORTED']
    scenario_name: str
    progress: Progress


class Device(Contract):
    key: str
    kind: Literal['CAMERA_RGB', 'CAMERA_DEPTH', 'LIDAR', 'BATTERY', 'OTHER']
    label: str
    state: Literal['OK', 'MISSING', 'ERROR']


class RobotSummary(Contract):
    id: UUID
    name: str
    model: str
    owner: Person | None
    connection: Literal['ONLINE', 'OFFLINE']
    status: Literal['IDLE', 'TELEOP', 'RUNNING', 'PAUSED', 'STOP_LATCHED', 'ERROR'] | None
    battery: Battery | None
    location: Location | None
    lease: Lease | None
    current_run: CurrentRun | None
    devices: list[Device]
    attention: list[str]


class Event(Contract):
    id: str = Field(pattern=r'^[0-9]+$')
    at: AwareDatetime
    robot_at: AwareDatetime | None
    category: Category
    code: str
    severity: Literal['INFO', 'WARN', 'ERROR']
    message: str
    robot_id: UUID | None
    user_id: UUID | None
    run_id: UUID | None
    data: dict[str, Any]


class OrgSettings(Contract):
    battery_low_pct: int = Field(default=20, ge=5, le=50, strict=True)
    run_min_battery_pct: int = Field(default=30, ge=10, le=90, strict=True)
    deviation_m: float = Field(default=1.5, ge=0.5, le=5, strict=True)
    lease_request_timeout_s: int = Field(default=10, ge=5, le=30, strict=True)
    link_loss_wait_s: int = Field(default=30, ge=0, le=30, strict=True)


class OrgSettingsPatch(Contract):
    battery_low_pct: int | None = Field(default=None, ge=5, le=50, strict=True)
    run_min_battery_pct: int | None = Field(default=None, ge=10, le=90, strict=True)
    deviation_m: float | None = Field(default=None, ge=0.5, le=5, strict=True)
    lease_request_timeout_s: int | None = Field(default=None, ge=5, le=30, strict=True)
    link_loss_wait_s: int | None = Field(default=None, ge=0, le=30, strict=True)


class RobotList(Contract):
    items: list[RobotSummary]
    next_cursor: str | None


class UserList(Contract):
    items: list[User]
    next_cursor: str | None


class SessionList(Contract):
    items: list[Session]
    next_cursor: str | None


TOP = {name: value for name, value in list(globals().items())
       if isinstance(value, type) and issubclass(value, Contract) and value is not Contract}

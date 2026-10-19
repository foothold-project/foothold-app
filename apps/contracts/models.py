"""Pydantic v2 source for FH-SPEC-05 §§1, 2, 3, 8."""
from datetime import timezone
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import AfterValidator, AwareDatetime, BaseModel, ConfigDict, Field, model_validator

UTCDateTime = Annotated[AwareDatetime, AfterValidator(lambda value: value.astimezone(timezone.utc))]


def omitted(**constraints):
    # Missing PATCH fields are omitted with exclude_unset; supplied null is invalid.
    return Field(default=None, json_schema_extra=lambda schema: schema.pop('default', None), **constraints)

Role = Literal['ORG_ADMIN', 'OPERATOR']
Category = Literal['RUN', 'ROUTE', 'LINK', 'LEASE', 'APPROVAL', 'SAFETY', 'ACCOUNT']


class Contract(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False,
                              json_schema_serialization_defaults_required=True)

    @model_validator(mode='before')
    @classmethod
    def reject_nul(cls, value):
        def visit(item):
            if isinstance(item, str) and '\x00' in item:
                raise ValueError('NUL is not allowed')
            if isinstance(item, dict):
                for key, child in item.items():
                    visit(key)
                    visit(child)
            elif isinstance(item, (list, tuple)):
                for child in item:
                    visit(child)
        visit(value)
        return value


class ErrorBody(Contract):
    code: str
    message: str
    detail: dict[str, Any] = Field(default_factory=dict)


class ApiError(Contract):
    error: ErrorBody


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
    created_at: UTCDateTime


class LoginResponse(User):
    csrf_token: str | None = None
    access_token: str | None = None
    refresh_token: str | None = None


class RefreshRequest(Contract):
    refresh_token: str = Field(min_length=1, max_length=256)


class TokenResponse(Contract):
    access_token: str
    refresh_token: str


class SessionInfo(Contract):
    client: Literal['web', 'app']
    csrf_token: str | None


class MePatch(Contract):
    display_name: str = omitted(min_length=1, max_length=128)
    notify_prefs: dict[str, bool] = omitted()


class PasswordChange(Contract):
    current_password: str = Field(min_length=1, max_length=1024)
    new_password: str = Field(min_length=1, max_length=1024)


class UserCreate(Contract):
    username: str = Field(min_length=1, max_length=128)
    display_name: str = Field(min_length=1, max_length=128)
    role: Role
    temp_password: str = Field(min_length=1, max_length=1024)


class UserPatch(Contract):
    display_name: str = omitted(min_length=1, max_length=128)
    role: Role = omitted()
    locked: bool = omitted()


class Session(Contract):
    id: UUID
    client: Literal['web', 'app']
    device_label: str
    created_at: UTCDateTime
    last_seen_at: UTCDateTime
    expires_at: UTCDateTime
    revoked_at: UTCDateTime | None


class Person(Contract):
    id: UUID
    display_name: str


class Battery(Contract):
    soc: float = Field(ge=0, le=100)
    updated_at: UTCDateTime


class Location(Contract):
    floor_id: UUID
    map_version_id: UUID
    x: float
    y: float
    yaw: float
    confidence: float = Field(ge=0, le=1)
    updated_at: UTCDateTime


class Lease(Contract):
    holder_type: Literal['USER', 'RUN']
    user: Person | None
    since: UTCDateTime


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
    at: UTCDateTime
    robot_at: UTCDateTime | None
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
    battery_low_pct: int = omitted(ge=5, le=50, strict=True)
    run_min_battery_pct: int = omitted(ge=10, le=90, strict=True)
    deviation_m: float = omitted(ge=0.5, le=5, strict=True)
    lease_request_timeout_s: int = omitted(ge=5, le=30, strict=True)
    link_loss_wait_s: int = omitted(ge=0, le=30, strict=True)


class RobotList(Contract):
    items: list[RobotSummary]
    next_cursor: str | None


class UserList(Contract):
    items: list[User]
    next_cursor: str | None


class SessionList(Contract):
    items: list[Session]
    next_cursor: str | None


# FH-SPEC-05 §§9–10: flat envelopes, no WebSocket subprotocol header.
Axis = Annotated[float, Field(ge=-1, le=1, strict=True)]
Axes = Annotated[list[Axis], Field(min_length=3, max_length=3)]
Vector3 = Annotated[list[float], Field(min_length=3, max_length=3)]
Sequence = Annotated[int, Field(ge=0, strict=True)]


class ScreenEnvelope(Contract):
    id: str = Field(min_length=1, max_length=128)
    proto: Literal['fh-rt/1'] | None = None


class ScreenRobot(ScreenEnvelope):
    robot: UUID


class ScreenSub(ScreenEnvelope):
    t: Literal['sub']
    robots: list[UUID] = Field(max_length=100)
    streams: list[Literal['state', 'rgb', 'depth', 'lidar', 'map']]


class ScreenLease(ScreenRobot):
    t: Literal['lease.take', 'lease.request', 'lease.release', 'hidden', 'stop']


class ScreenRespond(ScreenRobot):
    t: Literal['lease.respond']
    request_id: UUID
    accept: bool = Field(strict=True)


class ScreenCmd(ScreenRobot):
    t: Literal['cmd']
    lease_id: UUID
    seq: Sequence
    axes: Axes


class ScreenUnlock(ScreenRobot):
    t: Literal['unlock']
    lease_id: UUID
    stop_gen: Sequence


class ScreenPing(ScreenEnvelope):
    t: Literal['ping']


ScreenMessage = Annotated[ScreenSub | ScreenLease | ScreenRespond | ScreenCmd | ScreenUnlock | ScreenPing,
                          Field(discriminator='t')]


class RunCopy(Contract):
    run_id: UUID
    status: str = Field(max_length=64)
    step: Sequence
    wait_reason: str | None = None


class AgentHello(Contract):
    t: Literal['hello']
    proto: Literal['fh-agent/1']
    agent_version: str = Field(max_length=128)
    robot_model: str | None
    firmware: str | None
    devices: list[Device]
    map_versions: list[str]
    last_floor_id: UUID | None
    latched: bool = Field(strict=True)
    stop_gen: Sequence
    lease_id: UUID | None
    run: RunCopy | None


class AgentPose(Contract):
    floor_id: UUID | None
    x: float | None
    y: float | None
    yaw: float | None
    confidence: Annotated[float, Field(ge=0, le=1)] | None


class AgentBattery(Contract):
    soc: Annotated[float, Field(ge=0, le=100)] | None
    voltage: float | None = None


class AgentState(Contract):
    t: Literal['state']
    pose: AgentPose
    speed: float | None
    battery: AgentBattery
    latched: bool = Field(strict=True)
    stop_gen: Sequence
    applied: Vector3
    mode: str = Field(max_length=64)
    devices_changed: list[Device] | None = None


class AgentPing(Contract):
    t: Literal['ping']


class AgentEvent(Contract):
    t: Literal['event']
    code: str = Field(min_length=1, max_length=128)
    severity: Literal['INFO', 'WARN', 'ERROR', 'info', 'warn', 'error']
    robot_at: UTCDateTime | None
    data: dict[str, Any]


class AgentRunUpdate(Contract):
    t: Literal['run.update']
    run_id: UUID
    status: str = Field(max_length=64)
    step: Sequence
    progress: Progress | None
    path_deviation_m: float | None = None
    fail_code: str | None = None


class AgentCmdAck(Contract):
    t: Literal['cmd.ack']
    seq: int = Field(ge=-1, strict=True)
    applied: Vector3
    reason: str | None = None


class AgentMedia(Contract):
    t: Literal['media']
    kind: Literal['photo']
    run_id: UUID | None = None
    step: Sequence | None = None
    upload_id: UUID


AgentMessage = Annotated[AgentHello | AgentState | AgentPing | AgentEvent | AgentRunUpdate | AgentCmdAck | AgentMedia,
                         Field(discriminator='t')]


class AgentLease(Contract):
    t: Literal['lease'] = 'lease'
    lease_id: UUID | None
    holder_type: Literal['USER', 'RUN'] | None


class AgentCommand(Contract):
    t: Literal['cmd'] = 'cmd'
    lease_id: UUID
    seq: Sequence
    axes: Axes
    t_server: UTCDateTime


class AgentStop(Contract):
    t: Literal['stop'] = 'stop'
    by_user_id: UUID | None


class AgentUnlock(Contract):
    t: Literal['unlock'] = 'unlock'
    lease_id: UUID
    stop_gen: Sequence


class AgentServerPing(Contract):
    t: Literal['ping'] = 'ping'
    t_server: UTCDateTime


class AgentStreams(Contract):
    t: Literal['streams'] = 'streams'
    rgb: bool
    depth: bool
    lidar: bool
    map: bool


class ScreenReply(Contract):
    t: Literal['reply'] = 'reply'
    id: str
    ok: bool
    error: ErrorBody | None = None


class ScreenLeaseUpdate(Contract):
    t: Literal['lease'] = 'lease'
    robot: UUID
    holder: dict[str, Any] | None
    lease_id: UUID | None = None
    since: UTCDateTime | None


class ScreenLeaseRequested(Contract):
    t: Literal['lease.requested'] = 'lease.requested'
    robot: UUID
    request_id: UUID
    requester: dict[str, str]
    expires_at: UTCDateTime


class ScreenLeaseResult(Contract):
    t: Literal['lease.result'] = 'lease.result'
    robot: UUID
    request_id: UUID | None
    result: Literal['ACCEPTED', 'DECLINED', 'TIMEOUT', 'CANCELED']
    error: str | None = None


class ScreenState(Contract):
    t: Literal['state'] = 'state'
    robot: UUID
    connection: Literal['ONLINE', 'OFFLINE']
    status: Literal['IDLE', 'TELEOP', 'RUNNING', 'PAUSED', 'STOP_LATCHED', 'ERROR'] | None
    battery: Battery | None
    location: Location | None
    devices: list[Device]
    speed: float | None
    latency_ms: float | None
    latched: bool | None
    stop_gen: Sequence | None
    applied: Vector3 | None


class AgentTokenResponse(Contract):
    agent_token: str


TOP = {name: value for name, value in list(globals().items())
       if isinstance(value, type) and issubclass(value, Contract) and value is not Contract}

REQUEST_MODELS = {LoginRequest, RefreshRequest, MePatch, PasswordChange,
                  UserCreate, UserPatch, OrgSettingsPatch}

TOP.update(ScreenMessage=ScreenMessage, AgentMessage=AgentMessage)
REQUEST_MODELS.update({ScreenSub, ScreenLease, ScreenRespond, ScreenCmd, ScreenUnlock, ScreenPing,
                       AgentHello, AgentState, AgentPing, AgentEvent, AgentRunUpdate, AgentCmdAck, AgentMedia})

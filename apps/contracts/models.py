"""Pydantic v2 source for FH-SPEC-05 §§1, 2, 3, 5, 7, 8."""
from datetime import timezone
import unicodedata
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import AfterValidator, AwareDatetime, BaseModel, ConfigDict, Field, JsonValue, model_validator

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
        def visit(item, depth=0):
            if depth > 64:
                raise ValueError('JSON nesting exceeds 64')
            if isinstance(item, str):
                item.encode('utf-8')  # PostgreSQL UTF8 cannot store lone surrogates.
                if '\x00' in item:
                    raise ValueError('NUL is not allowed')
            if isinstance(item, dict):
                for key, child in item.items():
                    visit(key, depth + 1)
                    visit(child, depth + 1)
            elif isinstance(item, (list, tuple)):
                for child in item:
                    visit(child, depth + 1)
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
    floor_id: UUID | None
    map_version_id: UUID | None
    x: float | None
    y: float | None
    yaw: float | None
    confidence: Annotated[float, Field(ge=0, le=1)] | None
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
    connection: Literal['ONLINE', 'OFFLINE', 'UNKNOWN']
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


class EventList(Contract):
    items: list[Event]
    next_cursor: str | None


DecimalID = Annotated[str, Field(pattern=r'^[1-9][0-9]{0,18}$')]


class Notification(Contract):
    id: DecimalID
    event_id: DecimalID | None
    kind: str
    title: str
    body: str
    link: str
    read_at: UTCDateTime | None
    created_at: UTCDateTime


class NotificationList(Contract):
    items: list[Notification]
    next_cursor: str | None
    unread_count: int = Field(ge=0)


class NotificationsRead(Contract):
    ids: list[DecimalID] = omitted(min_length=1, max_length=100)
    all: Literal[True] = omitted()

    @model_validator(mode='after')
    def one_selection(self):
        if self.model_fields_set not in ({'ids'}, {'all'}):
            raise ValueError('Supply ids or all:true')
        if self.ids is not None and any(int(value) > 2**63 - 1 for value in self.ids):
            raise ValueError('ID exceeds bigint')
        return self


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
MAX_SAFE_INTEGER = 2**53 - 1
Sequence = Annotated[int, Field(ge=0, le=MAX_SAFE_INTEGER, strict=True)]
StopReference = Annotated[int, Field(gt=0, le=MAX_SAFE_INTEGER, strict=True)]


class ScreenEnvelope(Contract):
    id: str = Field(min_length=1, max_length=128)
    proto: Literal['fh-rt/1'] = omitted(description='첫 메시지는 필수, 후속은 생략 가능; null은 거부한다.')


class ScreenRobot(ScreenEnvelope):
    robot: UUID


class ScreenSub(ScreenEnvelope):
    t: Literal['sub']
    robots: list[UUID] = Field(max_length=100)
    streams: list[Literal['state', 'rgb', 'depth', 'lidar', 'map']]


class ScreenLease(ScreenRobot):
    t: Literal['lease.take', 'lease.request', 'lease.release', 'lease.cancel', 'hidden', 'stop']


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


class AgentInput(Contract):
    model_config = ConfigDict(extra='ignore', allow_inf_nan=False,
                              json_schema_serialization_defaults_required=True)



class RunCopy(AgentInput):
    run_id: UUID
    status: str = Field(max_length=64)
    step: Sequence
    wait_reason: str | None = None


class AgentHello(AgentInput):
    t: Literal['hello']
    proto: Literal['fh-agent/2']
    agent_version: str = Field(max_length=128)
    robot_model: str | None
    firmware: str | None
    devices: list[Device]

    @model_validator(mode="after")
    def unique_devices(self):
        if len({d.key for d in self.devices}) != len(self.devices):
            raise ValueError("duplicate device key")
        return self

    map_versions: list[str]
    last_floor_id: UUID | None
    latched: bool = Field(strict=True)
    stop_gen: Sequence
    lease_id: UUID | None
    run: RunCopy | None


class AgentPose(AgentInput):
    map_version_id: UUID | None = None
    floor_id: UUID | None
    x: float | None
    y: float | None
    yaw: float | None
    confidence: Annotated[float, Field(ge=0, le=1)] | None


class AgentBattery(AgentInput):
    soc: Annotated[float, Field(ge=0, le=100)] | None
    voltage: float | None = None


class AgentState(AgentInput):
    t: Literal['state']
    pose: AgentPose
    speed: float | None
    battery: AgentBattery
    latched: bool = Field(strict=True)
    stop_gen: Sequence
    stop_ref: Sequence
    applied: Vector3
    mode: str = Field(max_length=64)
    devices_changed: list[Device] | None = None

    @model_validator(mode='after')
    def unique_devices(self):
        if self.devices_changed is not None and len({d.key for d in self.devices_changed}) != len(self.devices_changed):
            raise ValueError('duplicate device key')
        return self


class AgentPing(AgentInput):
    t: Literal['ping']


class AgentEvent(AgentInput):
    t: Literal['event']
    code: str = Field(min_length=1, max_length=128)
    severity: Literal['INFO', 'WARN', 'ERROR', 'info', 'warn', 'error']
    robot_at: UTCDateTime | None
    data: dict[str, JsonValue]

    @model_validator(mode='after')
    def storable_json(self):
        import json
        # Also checks finite numbers in recursive JsonValue leaves.
        json.dumps(self.data, ensure_ascii=False, allow_nan=False).encode('utf-8')
        return self


class AgentRunUpdate(AgentInput):
    t: Literal['run.update']
    run_id: UUID
    status: str = Field(max_length=64)
    step: Sequence
    progress: Progress | None
    path_deviation_m: float | None = None
    fail_code: str | None = None


class AgentCmdAck(AgentInput):
    t: Literal['cmd.ack']
    seq: int = Field(ge=-1, le=MAX_SAFE_INTEGER, strict=True)
    applied: Vector3
    reason: str | None = None


class AgentMedia(AgentInput):
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
    holder_type: Literal['USER'] | Annotated[str, Field(pattern=r'^RUN:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')] | None


class AgentCommand(Contract):
    t: Literal['cmd'] = 'cmd'
    lease_id: UUID
    seq: Sequence
    axes: Axes
    t_server: UTCDateTime


class AgentStop(Contract):
    t: Literal['stop'] = 'stop'
    by_user_id: UUID | None
    stop_ref: StopReference


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


class ScreenServerPing(Contract):
    t: Literal['ping'] = 'ping'
    t_server: UTCDateTime


class ScreenReply(Contract):
    model_config = ConfigDict(json_schema_extra=lambda schema: schema.update(
        required=[key for key in schema.get('required', []) if key != 'error']))
    t: Literal['reply'] = 'reply'
    id: str
    ok: bool
    error: ErrorBody | None = None


class ScreenLeaseUpdate(Contract):
    model_config = ConfigDict(json_schema_extra=lambda schema: schema.update(
        required=[key for key in schema.get('required', []) if key != 'lease_id']))
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
    model_config = ConfigDict(json_schema_extra=lambda schema: schema.update(
        required=[key for key in schema.get('required', []) if key != 'error']))
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


class RobotCreate(Contract):
    name: str = Field(min_length=1, max_length=128)
    owner_user_id: UUID | None = None


class RobotPatch(Contract):
    name: str = omitted(min_length=1, max_length=128)
    owner_user_id: UUID | None = omitted()


class RobotCreated(Contract):
    robot: RobotSummary
    agent_token: str


class OperatorCount(Contract):
    user_id: UUID
    display_name: str
    robot_count: int = Field(ge=0)


class Dashboard(Contract):
    robots_total: int = Field(ge=0)
    robots_online: int = Field(ge=0)
    robots_attention: int = Field(ge=0)
    robots_running: int = Field(ge=0)
    approvals_pending: int = Field(ge=0)
    operators: list[OperatorCount]


class ScreenSubscriptionRevoked(Contract):
    t: Literal['subscription.revoked'] = 'subscription.revoked'
    robot: UUID
    reason: Literal['ACCESS_REVOKED', 'ROBOT_DELETED']


class AgentTokenResponse(Contract):
    agent_token: str



def map_name(value):
    if any(unicodedata.category(c) in ('Cc', 'Cf') for c in value):
        raise ValueError('지도 이름에는 제어·서식 문자를 쓸 수 없습니다.')
    return value


MapNameText = Annotated[str, AfterValidator(map_name)]


class MapName(Contract):
    name: MapNameText = Field(min_length=1, max_length=128, pattern=r'\S')


class FloorCreate(MapName):
    level: int = Field(strict=True, ge=-1000, le=1000)


class FloorPatch(Contract):
    name: MapNameText = omitted(min_length=1, max_length=128, pattern=r'\S')
    level: int = omitted(strict=True, ge=-1000, le=1000)


class MapFloor(Contract):
    id: UUID
    building_id: UUID
    name: str
    level: int
    approved_version_id: UUID | None
    pending_count: int = 0


class MapBuilding(Contract):
    id: UUID
    site_id: UUID
    name: str
    floors: list[MapFloor] = Field(default_factory=list)


class MapSite(Contract):
    id: UUID
    name: str
    buildings: list[MapBuilding] = Field(default_factory=list)


class SiteTree(Contract):
    items: list[MapSite]
    next_cursor: None = None


MapCoordinate = Annotated[float, Field(strict=True)]


class MapZone(Contract):
    id: str = Field(min_length=1, max_length=128, pattern=r'\S')
    type: Literal['NO_GO', 'SLOW']
    name: str = Field(min_length=1, max_length=128, pattern=r'\S')
    polygon: list[tuple[MapCoordinate, MapCoordinate]] = Field(min_length=3, max_length=256)


class MapWaypoint(Contract):
    id: str = Field(min_length=1, max_length=128, pattern=r'\S')
    name: str = Field(min_length=1, max_length=128, pattern=r'\S')
    x: MapCoordinate
    y: MapCoordinate
    yaw: MapCoordinate


class MapConnector(Contract):
    id: str = Field(min_length=1, max_length=128, pattern=r'\S')
    kind: Literal['STAIRS', 'ELEVATOR']
    pair_floor_id: UUID
    x: MapCoordinate
    y: MapCoordinate
    yaw: MapCoordinate


class MapEdit(Contract):
    id: str | None = Field(default=None, min_length=1, max_length=128, pattern=r'\S', exclude_if=lambda value: value is None)
    op: Literal['ERASE', 'WALL']
    polyline: list[tuple[MapCoordinate, MapCoordinate]] = Field(min_length=2, max_length=256)
    width: MapCoordinate = Field(gt=0, le=100)


class MapFeatures(Contract):
    zones: list[MapZone] = Field(max_length=256)
    waypoints: list[MapWaypoint] = Field(max_length=1000)
    connectors: list[MapConnector] = Field(max_length=256)
    edits: list[MapEdit] = Field(max_length=256)


def approval_text(value):
    if any(unicodedata.category(c) in ('Cc', 'Cf') for c in value):
        raise ValueError('사유와 의견에는 제어·서식 문자를 쓸 수 없습니다.')
    return value


ApprovalText = Annotated[str, AfterValidator(approval_text)]


class MapVersionCreate(Contract):
    base_version_id: UUID | None
    image: UUID
    features: MapFeatures
    reason: ApprovalText = Field(min_length=1, max_length=2000, pattern=r'\S')


class MapVersion(Contract):
    upload_id: UUID
    id: UUID
    floor_id: UUID
    number: int
    base_version_id: UUID | None
    copied_from_id: UUID | None = None
    status: Literal['APPROVED', 'SUPERSEDED', 'PENDING', 'REJECTED', 'CANCELED']
    image_sha256: str
    width: int
    height: int
    resolution: float
    origin: tuple[float, float, float]
    features: MapFeatures
    reason: str
    source: Literal['IMPORT', 'EDIT', 'ROLLBACK', 'SLAM']
    created_by: UUID
    created_at: UTCDateTime


class MapRollback(Contract):
    base_version_id: UUID
    reason: ApprovalText = Field(min_length=1, max_length=2000, pattern=r'\S')


class MapFeatureChange(Contract):
    kind: Literal['zones', 'waypoints', 'connectors', 'edits']
    key: str
    change: Literal['added', 'removed', 'changed']
    before: MapZone | MapWaypoint | MapConnector | MapEdit | None
    after: MapZone | MapWaypoint | MapConnector | MapEdit | None
    before_index: int | None = Field(default=None, ge=0, le=255)
    after_index: int | None = Field(default=None, ge=0, le=255)


class MapDiff(Contract):
    version: MapVersion
    against: MapVersion | None
    image_changed: bool
    changes: list[MapFeatureChange]


class MapVersionList(Contract):
    items: list[MapVersion]
    next_cursor: str | None


class MapUpload(Contract):
    upload_id: UUID
    sha256: str


class FloorConnector(Contract):
    id: UUID
    building_id: UUID
    kind: Literal['STAIRS', 'ELEVATOR']
    floor_a_id: UUID
    floor_b_id: UUID
    a_pose: dict[str, float]
    b_pose: dict[str, float] | None
    map_version_a_id: UUID
    map_version_b_id: UUID | None
    active: bool


class FloorConnectorList(Contract):
    items: list[FloorConnector]
    next_cursor: None = None

ApprovalStatus = Literal['PENDING', 'APPROVED', 'REJECTED', 'CANCELED', 'STALE']


class ApprovalRef(Contract):
    type: Literal['map_version'] = 'map_version'
    id: UUID


class Approval(Contract):
    id: UUID
    kind: Literal['MAP_REVISION', 'MAP_ROLLBACK']
    status: ApprovalStatus
    requester: Person
    decider: Person | None
    reason: str
    decision_comment: str | None
    target: ApprovalRef
    base_ref: ApprovalRef | None
    emergency: bool = False
    created_at: UTCDateTime
    decided_at: UTCDateTime | None


class ApprovalMapPreview(Contract):
    floor_id: UUID
    floor_name: str
    target_version_number: int
    base_version_number: int | None


class ApprovalDetail(Approval):
    preview: ApprovalMapPreview


class ApprovalList(Contract):
    items: list[Approval]
    next_cursor: str | None


class ApprovalApprove(Contract):
    comment: ApprovalText | None = Field(default=None, max_length=2000)


class ApprovalReject(Contract):
    reason: ApprovalText = Field(min_length=1, max_length=2000, pattern=r'\S')


TOP = {name: value for name, value in list(globals().items())
       if isinstance(value, type) and issubclass(value, Contract) and value is not Contract}

REQUEST_MODELS = {ApprovalApprove, ApprovalReject, MapRollback, MapName, FloorCreate, FloorPatch, MapZone, MapWaypoint, MapConnector, MapEdit, MapFeatures, MapVersionCreate, LoginRequest, RefreshRequest, MePatch, PasswordChange,
                  UserCreate, UserPatch, OrgSettingsPatch, RobotCreate, RobotPatch, NotificationsRead}

TOP.update(ScreenMessage=ScreenMessage, AgentMessage=AgentMessage)
REQUEST_MODELS.update({ScreenSub, ScreenLease, ScreenRespond, ScreenCmd, ScreenUnlock, ScreenPing,
                       AgentHello, AgentState, AgentPing, AgentEvent, AgentRunUpdate, AgentCmdAck, AgentMedia, ScreenMessage, AgentMessage})
# Nested input models must have the same mode as their enclosing input union.
REQUEST_MODELS.update(T for T in TOP.values() if isinstance(T, type)
                      and issubclass(T, (AgentInput, ScreenEnvelope)))

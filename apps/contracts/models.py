"""Pydantic v2 source for FH-SPEC-05 §§1, 2, 3, 5, 6, 7, 8."""
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
    simulation: bool = False
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


class PhoneRevocationItem(Contract):
    jtis: list[UUID] | None = Field(default=None, min_length=1, max_length=64)
    sub: UUID | None = None
    device: UUID | None = None
    until: Sequence

    @model_validator(mode='after')
    def selector(self):
        if (self.jtis is None) == (self.sub is None) or (self.device is not None and self.sub is None):
            raise ValueError('exactly one revocation selector required')
        return self


class AgentPhoneRevoke(Contract):
    t: Literal['phone.revoke'] = 'phone.revoke'
    seq: Annotated[int, Field(ge=1, le=MAX_SAFE_INTEGER, strict=True)]
    items: list[PhoneRevocationItem] = Field(min_length=1, max_length=16)


class AgentPhoneRevokeAck(AgentInput):
    t: Literal['phone.revoke.ack']
    seq: Annotated[int, Field(ge=1, le=MAX_SAFE_INTEGER, strict=True)]


AgentMessage = Annotated[AgentHello | AgentState | AgentPing | AgentEvent | AgentRunUpdate | AgentCmdAck | AgentMedia | AgentPhoneRevokeAck,
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
    type: Literal['map_version', 'assignment'] = 'map_version'
    id: UUID


class Approval(Contract):
    id: UUID
    kind: Literal['MAP_REVISION', 'MAP_ROLLBACK', 'SCENARIO_ASSIGNMENT']
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


class ApprovalAssignmentPreview(Contract):
    scenario_id: UUID
    scenario_name: str
    scenario_version: int
    robot_id: UUID
    robot_name: str


class ApprovalDetail(Approval):
    preview: ApprovalMapPreview | ApprovalAssignmentPreview


class ApprovalList(Contract):
    items: list[Approval]
    next_cursor: str | None


class ApprovalApprove(Contract):
    comment: ApprovalText | None = Field(default=None, max_length=2000)


class ApprovalReject(Contract):
    reason: ApprovalText = Field(min_length=1, max_length=2000, pattern=r'\S')


class PhotoParams(Contract):
    camera: Literal['rgb', 'depth'] = 'rgb'


class WaitParams(Contract):
    seconds: int = Field(default=30, strict=True, ge=1, le=3600)


class ConfirmParams(Contract):
    prompt: MapNameText = Field(default='계기판 이상 없음?', min_length=1, max_length=500, pattern=r'\S')


class SensorLogParams(Contract):
    device: Literal['rgb', 'depth', 'lidar', 'battery'] = 'lidar'
    seconds: int = Field(default=10, strict=True, ge=1, le=3600)


ACTION_PARAMS = {'PHOTO': PhotoParams, 'WAIT': WaitParams,
                 'OPERATOR_CONFIRM': ConfirmParams, 'SENSOR_LOG': SensorLogParams}
ActionKey = Literal['PHOTO', 'WAIT', 'OPERATOR_CONFIRM', 'SENSOR_LOG']


class MissionStep(Contract):
    model_config = ConfigDict(json_schema_serialization_defaults_required=False)
    action: ActionKey
    params: dict[str, JsonValue] = Field(default_factory=dict)

    @model_validator(mode='after')
    def parameters(self):
        self.params = ACTION_PARAMS[self.action].model_validate(self.params).model_dump()
        return self


class ActionOption(Contract):
    param: Literal['camera', 'device']
    value: Literal['rgb', 'depth', 'lidar', 'battery']
    requires: list[str]
    available: bool
    why_unavailable: str | None


class Action(Contract):
    key: ActionKey
    label: str
    params: dict[str, JsonValue]
    requires: list[str]
    available: bool
    why_unavailable: str | None
    options: list[ActionOption]


class MissionWrite(MapName):
    steps: list[MissionStep] = Field(min_length=1, max_length=100)


class Mission(MissionWrite):
    id: UUID
    number: int
    latest_version: int
    version: int
    required_devices: list[str]
    created_by: UUID
    created_at: UTCDateTime
    version_created_by: UUID
    version_created_at: UTCDateTime
    archived_at: UTCDateTime | None


class MissionList(Contract):
    items: list[Mission]
    next_cursor: str | None


class ScenarioPoint(Contract):
    model_config = ConfigDict(json_schema_serialization_defaults_required=False)
    floor_id: UUID
    map_version_id: UUID
    x: float = Field(strict=True)
    y: float = Field(strict=True)
    yaw: float = Field(default=0, strict=True)
    waypoint_ref: str | None = Field(default=None, min_length=1, max_length=128)


class ScenarioWaypoint(ScenarioPoint):
    mission_id: UUID
    mission_version: int = Field(strict=True, ge=1, le=2**31 - 1)


class ScenarioFinish(Contract):
    model_config = ConfigDict(json_schema_serialization_defaults_required=False)
    mode: Literal['STAY', 'RETURN_TO_START', 'GO_TO'] = 'STAY'
    target: ScenarioPoint | None = None

    @model_validator(mode='after')
    def target_for_mode(self):
        if (self.mode == 'GO_TO') != (self.target is not None):
            raise ValueError('GO_TO requires target; other modes cannot have target')
        return self


class ScenarioWrite(MapName):
    waypoints: list[ScenarioWaypoint] = Field(min_length=1, max_length=200)
    finish: ScenarioFinish = Field(default_factory=ScenarioFinish)
    notes: str = Field(default='', max_length=4000)


class Scenario(ScenarioWrite):
    id: UUID
    number: int
    latest_version: int
    version: int
    floor_ids: list[UUID]
    map_version_ids: list[UUID]
    required_devices: list[str]
    est_distance_m: float
    created_by: UUID
    created_at: UTCDateTime
    version_created_by: UUID
    version_created_at: UTCDateTime
    archived_at: UTCDateTime | None


class ScenarioList(Contract):
    items: list[Scenario]
    next_cursor: str | None


class PreviewPoint(Contract):
    element: str
    reachable: bool
    reasons: list[str]


class PreviewSegment(Contract):
    start: str
    end: str
    reachable: bool
    reason: str | None
    connector_id: UUID | None
    distance_m: float | None
    via: list[ScenarioPoint]


class ScenarioPreview(Contract):
    reachable: bool
    points: list[PreviewPoint]
    segments: list[PreviewSegment]
    floor_ids: list[UUID]
    map_version_ids: list[UUID]
    required_devices: list[str]
    est_distance_m: float
    distance_note: str = '직선과 직접 연결점 경유 거리이며 Nav2 경로가 아닙니다.'


AssignmentStatus = Literal['PENDING', 'ACTIVE', 'REJECTED', 'REMOVED']
IdempotencyKey = Annotated[str, Field(min_length=1, max_length=128, pattern=r'^[A-Za-z0-9._:-]+$')]


class IdempotencyHeaders(Contract):
    idempotency_key: IdempotencyKey | None = Field(default=None, description='Idempotency-Key header; same user/key replays the first successful response for 24 hours.')


class AssignmentCreate(Contract):
    scenario_id: UUID
    scenario_version: int = Field(ge=1, le=2147483647)
    robot_id: UUID
    memo: ApprovalText = Field(default='', max_length=2000)


class Assignment(AssignmentCreate):
    id: UUID
    scenario_name: str
    robot_name: str
    status: AssignmentStatus
    approval_id: UUID | None
    created_by: UUID
    created_at: UTCDateTime
    removed_at: UTCDateTime | None


class AssignmentList(Contract):
    items: list[Assignment]
    next_cursor: str | None


# FH-SPEC-05 §13: phone -> robot, never routed through the control server.
PhoneRobotID = Annotated[str, Field(pattern=r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
                                    description='소문자 하이픈 UUID 표준형만 허용한다.',
                                    json_schema_extra={'format': 'uuid'})]


class PhoneEnvelope(Contract):
    id: str = Field(min_length=1, max_length=128)
    robot: PhoneRobotID
    proto: Literal['fh-phone/1'] = omitted()


class PhoneHello(PhoneEnvelope):
    t: Literal['hello']
    proto: Literal['fh-phone/1']
    ticket: str = Field(min_length=1, max_length=2048)
    device: UUID


class PhoneLease(PhoneEnvelope):
    t: Literal['lease.take', 'lease.request', 'lease.release', 'lease.cancel', 'view', 'stop']


class PhoneRespond(PhoneEnvelope):
    t: Literal['lease.respond']
    request_id: UUID
    accept: bool = Field(strict=True)


class PhoneCommand(PhoneEnvelope):
    t: Literal['cmd']
    lease_id: UUID
    seq: Sequence
    vx: float = Field(strict=True, gt=-1e100, lt=1e100)
    vy: float = Field(strict=True, gt=-1e100, lt=1e100)
    wz: float = Field(strict=True, gt=-1e100, lt=1e100)


class PhoneUnlock(PhoneEnvelope):
    t: Literal['unlock']
    lease_id: UUID
    stop_gen: Sequence


class PhonePing(PhoneEnvelope):
    t: Literal['ping']
    client_time_ms: Sequence


PhoneMessage = Annotated[PhoneHello | PhoneLease | PhoneRespond | PhoneCommand | PhoneUnlock | PhonePing,
                         Field(discriminator='t')]


class PhoneLimits(Contract):
    vx_min: float
    vx_max: float
    vy_min: float
    vy_max: float
    wz_min: float
    wz_max: float
    commands: list[Vector3]


class PhonePolicy(Contract):
    name: str = Field(min_length=1, max_length=128)
    version: str = Field(min_length=1, max_length=128)


class PhoneWelcome(Contract):
    camera_token: str | None = Field(default=None, min_length=43, max_length=43, description='10초·1회용 영상 연결 토큰; 부모 연결에 종속')
    t: Literal['hello']
    id: str
    robot: PhoneRobotID
    proto: Literal['fh-phone/1']
    limits: PhoneLimits
    policy: PhonePolicy
    simulation: bool
    ping_interval_ms: Literal[1000]
    link_timeout_ms: Literal[3000]
    lease_timeout_ms: Literal[15000]


class PhoneReply(Contract):
    t: Literal['reply']
    id: str
    ok: bool
    error: ErrorBody | None
    lease_id: UUID | None
    request_id: UUID | None


class PhoneRequester(Contract):
    user_id: UUID
    device_id: UUID


class PhoneLeaseRequested(Contract):
    t: Literal['lease.requested']
    robot: PhoneRobotID
    request_id: UUID
    requester: PhoneRequester
    expires_at: UTCDateTime


class PhoneLeaseResult(Contract):
    t: Literal['lease.result']
    robot: PhoneRobotID
    request_id: UUID
    result: Literal['ACCEPTED', 'DECLINED', 'TIMEOUT', 'CANCELED']
    error: str | None


class PhoneCmdAck(Contract):
    t: Literal['cmd.ack']
    id: str
    seq: Sequence
    applied: Vector3
    clipped: bool
    reason: str | None


class PhonePosture(Contract):
    z: float | None
    tilt_deg: float | None
    fallen: bool | None
    body_still: bool | None


class PhoneEcho(Contract):
    id: str
    client_time_ms: Sequence
    agent_time_ms: Sequence


class PhoneState(AgentState):
    robot: PhoneRobotID
    controller: UUID | None
    controller_device: UUID | None
    controller_connected: bool
    lease_id: UUID | None
    stop_requested: bool | None
    posture: PhonePosture
    velocity: tuple[float | None, float | None, float | None]
    echo: PhoneEcho | None
    wall_time_ms: Sequence
    sim_time_s: float | None
    sim_wall_delta_s: float | None
    simulation: bool


class PhoneTicketClaims(Contract):
    iss: Literal['fh-control']
    aud: Literal['fh-phone/1']
    org: UUID
    robot: PhoneRobotID
    sub: UUID
    device: UUID
    purpose: Literal['control', 'view']
    iat: Sequence
    exp: Sequence
    jti: UUID

    @model_validator(mode='after')
    def short_lifetime(self):
        if not 0 < self.exp - self.iat <= 600:
            raise ValueError('ticket lifetime must be 1..600 seconds')
        return self



class PhonePassRequest(Contract):
    device: UUID
    purpose: Literal['control', 'view']
    switch: bool = Field(default=False, strict=True, description='앞 로봇 반납 확인 뒤에만 명시 true')


class PhonePassResponse(Contract):
    token: str
    exp: Sequence
    kid: str


class CameraHello(Contract):
    t: Literal['camera.hello']
    robot: PhoneRobotID
    token: str = Field(min_length=43, max_length=43)


class CameraFrame(Contract):
    t: Literal['camera.frame']
    robot: PhoneRobotID
    seq: Sequence
    mime: Literal['image/jpeg']
    width: int = Field(ge=1, le=640)
    height: int = Field(ge=1, le=360)
    jpeg: str = Field(min_length=4, max_length=87384, pattern=r'^[A-Za-z0-9+/]+={0,2}$')


class CameraStatus(Contract):
    t: Literal['camera.status']
    robot: PhoneRobotID
    state: Literal['NO_VIDEO']


class SimFailureDetail(Contract):
    """Allowlisted diagnostics; only exact resource pre-creation proof releases a slot."""
    model_config = ConfigDict(json_schema_serialization_defaults_required=False)
    reason: Literal['resources_low', 'manager_unreachable', 'slot_busy', 'unknown']
    start_not_created: bool = Field(default=False, strict=True)
    mem_available_mib: float | None = Field(default=None, ge=0, strict=True)
    load1: float | None = Field(default=None, ge=0, strict=True)
    min_mem_available_mib: float | None = Field(default=None, ge=0, strict=True)
    max_load1: float | None = Field(default=None, ge=0, strict=True)


class SimWorld(Contract):
    id: str = Field(min_length=1, max_length=128)
    name: str = Field(min_length=1, max_length=40)
    description: str = Field(default='', max_length=200)


class SimWorldStart(Contract):
    world_id: str = Field(min_length=1, max_length=128)


class SimStartRequest(SimWorldStart):
    robot_id: UUID


class SimRemove(Contract):
    generation: int = Field(ge=1, le=9223372036854775807)
    request_nonce: UUID


class SimProvision(SimStartRequest):
    generation: int = Field(ge=1, le=9223372036854775807)
    owner_id: UUID
    org_id: UUID
    agent_token: str = Field(min_length=32, max_length=256, repr=False)


class SimCatalog(Contract):
    worlds: list[SimWorld]
    slots: list[UUID]
    max_robots: int = Field(ge=1, le=2)
    launcher: Literal['fake', 'native-single']
    manager_instance_id: UUID | None = None


class SimRemoval(Contract):
    robot_id: UUID
    generation: int = Field(ge=1, le=9223372036854775807)
    request_nonce: UUID
    manager_instance_id: UUID
    absent: bool = Field(strict=True)
    startup_clean: bool = Field(strict=True)


class SimCleanupSlot(Contract):
    robot_id: UUID
    owner_id: UUID
    generation: int = Field(ge=1, le=9223372036854775807)
    can_recover: bool


class SimRobot(Contract):
    generation: int = Field(ge=1, le=9223372036854775807)
    robot_id: UUID
    owner_id: UUID
    world_id: str
    simulation: Literal[True]
    state: Literal['STARTING', 'PREPARED', 'RUNNING', 'STOPPING', 'ERROR']
    agent_address: str
    namespace: str
    tf_prefix: str
    command_topic: str
    launcher: Literal['fake', 'native-single']
    expires_at: UTCDateTime | None = None


class SimExpired(Contract):
    robot_id: UUID
    owner_id: UUID
    generation: int = Field(ge=1, le=9223372036854775807)
    reason: Literal['time_limit'] = 'time_limit'


class SimRobotList(Contract):
    items: list[SimRobot]
    expired: list[SimExpired] = Field(default_factory=list)
    cleanup: list[SimCleanupSlot] = Field(default_factory=list)
    manager_error: Literal['SIM_DISABLED', 'SIM_UNAVAILABLE'] | None = None


TOP = {name: value for name, value in list(globals().items())
       if isinstance(value, type) and issubclass(value, Contract) and value is not Contract}

REQUEST_MODELS = {AssignmentCreate, IdempotencyHeaders, ApprovalApprove, ApprovalReject, MapRollback, MapName, FloorCreate, FloorPatch, MapZone, MapWaypoint, MapConnector, MapEdit, MapFeatures, MapVersionCreate, LoginRequest, RefreshRequest, MePatch, PasswordChange,
                  UserCreate, UserPatch, OrgSettingsPatch, RobotCreate, RobotPatch, NotificationsRead}
REQUEST_MODELS.update({PhonePassRequest, CameraHello, SimWorldStart, SimStartRequest, SimProvision, SimRemove})
REQUEST_MODELS.update({PhotoParams, WaitParams, ConfirmParams, SensorLogParams, MissionStep,
                       MissionWrite, ScenarioPoint, ScenarioWaypoint, ScenarioFinish, ScenarioWrite})

TOP.update(ScreenMessage=ScreenMessage, AgentMessage=AgentMessage, PhoneMessage=PhoneMessage)
REQUEST_MODELS.update({PhoneHello, PhoneLease, PhoneRespond, PhoneCommand, PhoneUnlock, PhonePing, PhoneMessage, PhoneEnvelope})
REQUEST_MODELS.update({ScreenSub, ScreenLease, ScreenRespond, ScreenCmd, ScreenUnlock, ScreenPing,
                       AgentHello, AgentState, AgentPing, AgentEvent, AgentRunUpdate, AgentCmdAck, AgentMedia, ScreenMessage, AgentMessage})
# Nested input models must have the same mode as their enclosing input union.
REQUEST_MODELS.update(T for T in TOP.values() if isinstance(T, type)
                      and issubclass(T, (AgentInput, ScreenEnvelope)))

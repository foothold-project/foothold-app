"""Pydantic v2 source for FH-SPEC-05 §§1, 2, 3, 5, 6, 7, 8."""
from datetime import timezone
import base64
import binascii
import math
import struct
import unicodedata
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import AfterValidator, AwareDatetime, BaseModel, ConfigDict, Field, JsonValue, model_validator

UTCDateTime = Annotated[AwareDatetime, AfterValidator(lambda value: value.astimezone(timezone.utc))]


def omitted(**constraints):
    # Missing PATCH fields are omitted with exclude_unset; supplied null is invalid.
    return Field(default=None, json_schema_extra=lambda schema: schema.pop('default', None), **constraints)

# 422: simulated map snapshots can only target server-provisioned simulation robots.
SIM_MAP_REQUIRES_SIM_ROBOT = 'SIM_MAP_REQUIRES_SIM_ROBOT'

Role = Literal['ORG_ADMIN', 'OPERATOR']
Category = Literal['RUN', 'ROUTE', 'LINK', 'LEASE', 'APPROVAL', 'SAFETY', 'ACCOUNT']
SafetyReason = Literal['OUTPUT_STALLED']
RunStatus = Literal['QUEUED', 'PREPARING', 'MOVING', 'AT_WAYPOINT', 'PERFORMING',
                    'WAIT_CONFIRM', 'PAUSED', 'COMPLETED', 'FAILED', 'CANCELED']
# Read compatibility only: new direct reports must use RunStatus.
RunRecordStatus = RunStatus | Literal['ABORTED']
RunWaitReason = Literal['LINK_LOST', 'STOPPED_BY_USER', 'RECORDING_UNAVAILABLE']
RunFailCode = Literal['NAV_GOAL_REJECTED', 'NAV_TIMEOUT', 'LOCALIZATION_LOST',
                      'BATTERY_LOW', 'DEVICE_MISSING', 'OPERATOR_ABORT', 'PAUSE_TIMEOUT',
                      'FLOOR_TRANSITION_FAILED', 'NAV_UNAVAILABLE', 'MAP_VERSION_MISMATCH',
                      'FLOOR_TRANSITION_UNSUPPORTED', 'PLAN_UNAVAILABLE', 'RECORDING_REJECTED']
RunRejectCode = Literal['NOT_CONTROLLER', 'FORBIDDEN', 'RUN_ACTIVE', 'RUN_CONFLICT',
                        'RUN_NOT_FOUND', 'RUN_STATE_CONFLICT', 'RUN_OWNER_MISMATCH',
                        'RESUME_REJECTED', 'UNSUPPORTED_OPERATION', 'RECORDING_UNAVAILABLE',
                        'NAV_UNAVAILABLE', 'MAP_VERSION_MISMATCH',
                        'FLOOR_TRANSITION_UNSUPPORTED', 'PLAN_UNAVAILABLE']


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


def optional_response_fields(*names):
    # Keep existing response defaults required; only additive fields are optional
    # so clients compiled against the previous contract remain valid.
    def adjust(schema):
        schema['required'] = [key for key in schema.get('required', []) if key not in names]
    return adjust


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


class FloorContext(Contract):
    """Observation identity; compare the entire token before using asynchronous map results.

    This context never grants control or changes STOP/deadman gates. Positions are
    absent during transit/unknown and when the approved grid binding is invalid.
    """
    robot_id: UUID
    generation: int = Field(ge=1, strict=True)
    run_id: str = Field(min_length=1, max_length=128)
    epoch: int = Field(ge=0, strict=True)
    floor_rev: int = Field(ge=0, strict=True)
    world_id: Literal['v5_building', 'warehouse']
    building_id: UUID
    spawn_floor_id: Literal['l1', 'l2', 'f1']
    current_floor_id: Literal['l1', 'l2', 'f1'] | None
    floor_id: UUID | None
    map_version_id: UUID | None
    sha256: str | None = Field(pattern=r'^[0-9a-f]{64}$')
    source_pgm_sha256: str | None = Field(pattern=r'^[0-9a-f]{64}$')
    source: Literal['gt_geometry']
    floor_state: Literal['on_floor', 'transit', 'unknown']
    reason: str = Field(min_length=1, max_length=128)
    confirmed_sim_t: float | None

    @model_validator(mode='after')
    def coherent_floor(self):
        if self.world_id == 'warehouse':
            if (self.spawn_floor_id != 'f1' or self.current_floor_id != 'f1'
                    or self.floor_state != 'on_floor'):
                raise ValueError('static world has one fixed floor')
        elif self.spawn_floor_id == 'f1' or self.current_floor_id == 'f1':
            raise ValueError('connected building floors are l1/l2')
        if (self.floor_state == 'on_floor') != (self.current_floor_id is not None):
            raise ValueError('current_floor_id is present exactly when on_floor')
        ready = self.map_version_id is not None
        if ready != (self.floor_id is not None) or ready != (self.sha256 is not None) or ready != (self.source_pgm_sha256 is not None):
            raise ValueError('grid identity must be complete or absent')
        if ready and (self.floor_state != 'on_floor' or self.confirmed_sim_t is None):
            raise ValueError('grid identity requires a confirmed floor')
        return self


class Location(Contract):
    model_config = ConfigDict(json_schema_extra=optional_response_fields('floor_context'))
    floor_context: FloorContext | None = None
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
    status: RunRecordStatus
    scenario_name: str
    progress: Progress


class Device(Contract):
    key: str
    kind: Literal['CAMERA_RGB', 'CAMERA_DEPTH', 'LIDAR', 'BATTERY', 'OTHER']
    label: str
    state: Literal['OK', 'MISSING', 'ERROR']


class StopRequest(Contract):
    request_id: UUID


class StopRequestAck(Contract):
    stage: Literal['PHONE_RECEIVED', 'HUMAN_CONFIRMED']


class StopRequestStatus(Contract):
    request_id: UUID
    robot_id: UUID
    status: Literal['REQUESTED', 'PHONE_RECEIVED', 'HUMAN_CONFIRMED', 'STOP_CONFIRMED']
    message: str


class RobotSummary(Contract):
    model_config = ConfigDict(json_schema_extra=optional_response_fields(
        'last_state_received_at', 'state_stale', 'controller', 'controller_device', 'controller_connected', 'telemetry_source'))
    telemetry_source: Literal['PHONE'] | None = Field(default=None, exclude_if=lambda value: value is None)
    last_state_received_at: UTCDateTime | None = None
    state_stale: bool | None = True
    controller: Person | None = None
    controller_device: UUID | None = None
    controller_connected: bool | None = None
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
    # Legacy Session/Core hello copy; RUNNING here is not a detailed run status.
    run_id: UUID
    status: str = Field(max_length=64)
    step: Sequence
    wait_reason: str | None = None


ExecutionCapabilityKey = Literal['wait', 'photo.rgb', 'photo.depth', 'operator_confirm',
                                 'sensor_log.rgb', 'sensor_log.depth', 'sensor_log.lidar',
                                 'sensor_log.battery']
CapabilityRevision = Annotated[int, Field(ge=1, le=2**53 - 1, strict=True)]


class ExecutionCapability(Contract):
    key: ExecutionCapabilityKey
    state: Literal['SUPPORTED', 'UNAVAILABLE', 'UNSUPPORTED']
    reason: str | None = Field(max_length=256)

    @model_validator(mode='after')
    def availability_reason(self):
        if self.state == 'SUPPORTED':
            if self.reason is not None:
                raise ValueError('supported capability has no failure reason')
        elif not self.reason or not self.reason.strip():
            raise ValueError('unavailable/unsupported capability requires reason')
        return self


class ExecutionCapabilities(Contract):
    """Revision changes on executor/source/freshness/storage readiness changes."""
    contract: Literal['scenario/2']
    revision: CapabilityRevision
    actions: list[ExecutionCapability] = Field(max_length=8)

    @model_validator(mode='after')
    def unique_actions(self):
        if len({a.key for a in self.actions}) != len(self.actions):
            raise ValueError('duplicate execution capability')
        return self

    def require(self, required: list[ExecutionCapabilityKey], revision: int) -> None:
        if revision != self.revision:
            raise ValueError('execution capability revision changed')
        supported = {a.key for a in self.actions if a.state == 'SUPPORTED'}
        if not set(required) <= supported:
            raise ValueError('required execution capability is not supported/ready')


class AgentHello(AgentInput):
    execution_capabilities: ExecutionCapabilities = omitted(exclude_if=lambda value: value is None)
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
    model_config = ConfigDict(json_schema_extra=optional_response_fields('floor_context'))
    floor_context: FloorContext | None = None
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
    controller: UUID | None = None
    controller_device: UUID | None = None
    controller_connected: bool = False
    controller_since: UTCDateTime | None = None
    reported_run: 'RunSnapshot | None' = None
    t: Literal['state']
    pose: AgentPose
    speed: float | None
    battery: AgentBattery
    latched: bool = Field(strict=True)
    safety_reason: SafetyReason | None = None
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
    agent_instance_id: UUID = omitted()
    report_seq: Sequence = omitted()
    monotonic_s: float = omitted(ge=0, strict=True)

    @model_validator(mode='after')
    def storable_json(self):
        import json
        # Also checks finite numbers in recursive JsonValue leaves.
        json.dumps(self.data, ensure_ascii=False, allow_nan=False).encode('utf-8')
        identity = {'agent_instance_id', 'report_seq', 'monotonic_s'} & self.model_fields_set
        if identity and len(identity) != 3:
            raise ValueError('report identity and monotonic time must be supplied together')
        if self.code in ('RUN_STARTED', 'RUN_WAYPOINT_ARRIVED', 'RUN_WAYPOINT_RECORDED'):
            if len(identity) != 3:
                raise ValueError('run events require durable report identity')
        if self.code == 'RUN_STARTED':
            RunStarted.model_validate(self.data)
        if self.code in ('RUN_WAYPOINT_ARRIVED', 'RUN_WAYPOINT_RECORDED'):
            payload = (RunWaypointArrived if self.code == 'RUN_WAYPOINT_ARRIVED'
                       else RunWaypointRecorded).model_validate(self.data)
            if (payload.agent_instance_id != self.agent_instance_id
                    or payload.report_seq != self.report_seq
                    or payload.monotonic_s != self.monotonic_s):
                raise ValueError('waypoint event identity must match report envelope')
        return self


class AgentRunUpdate(AgentInput):
    t: Literal['run.update']
    run_id: UUID
    # Transitional server input: existing Session producers still use these names.
    status: RunStatus | Literal['RUNNING', 'ABORTED']
    step: Sequence
    progress: Progress | None
    path_deviation_m: float | None = None
    fail_code: str | None = None
    wait_reason: RunWaitReason | None = None
    agent_instance_id: UUID = omitted()
    report_seq: Sequence = omitted()
    monotonic_s: float = omitted(ge=0, strict=True)

    @model_validator(mode='after')
    def paused_reason(self):
        identity = {'agent_instance_id', 'report_seq', 'monotonic_s'} & self.model_fields_set
        if identity and len(identity) != 3:
            raise ValueError('report identity and monotonic time must be supplied together')
        if self.wait_reason is not None and self.status != 'PAUSED':
            raise ValueError('wait_reason is only valid while PAUSED')
        if self.fail_code in ('LINK_LOST', 'STOPPED_BY_USER', 'RECORDING_UNAVAILABLE'):
            raise ValueError('pause reasons are not failure codes')
        return self


class RunRecorded(Contract):
    """Data receipt after DB commit; never an execution permission."""
    t: Literal['run.recorded'] = 'run.recorded'
    agent_instance_id: UUID
    report_seq: Sequence


class DurableAgentRunUpdate(AgentRunUpdate):
    """Required for every new persistent run transition; legacy input is read-only."""
    status: RunStatus
    agent_instance_id: UUID
    report_seq: Sequence
    monotonic_s: float = Field(ge=0, strict=True)


class DurableAgentEvent(AgentEvent):
    """Required for all events attached to a persistent run, including diagnostics."""
    agent_instance_id: UUID
    report_seq: Sequence
    monotonic_s: float = Field(ge=0, strict=True)

    @model_validator(mode='after')
    def proven_start(self):
        UUID(str(self.data.get('run_id')))
        if self.code == 'RUN_STARTED':
            ProvenRunStarted.model_validate(self.data)
        return self


RunReportTransientCode = Literal['RUN_REPORT_SEQUENCE', 'RUN_REPORT_STORAGE']
RunReportPermanentCode = Literal['RUN_REPORT_OWNER', 'RUN_REPORT_MAP', 'RUN_REPORT_PLAN',
                                  'RUN_REPORT_STATE', 'RUN_REPORT_STEP', 'RUN_REPORT_PROVENANCE',
                                  'RUN_REPORT_CONFLICT', 'RUN_REPORT_INSTANCE', 'RUN_REPORT_ROBOT',
                                  'RUN_REPORT_NOT_FOUND', 'RUN_REPORT_INVALID']


class RunReportRejected(Contract):
    """Data rejection, never a commit ACK or an instruction to resume execution."""
    model_config = ConfigDict(json_schema_serialization_defaults_required=False)
    t: Literal['run.report_rejected'] = 'run.report_rejected'
    agent_instance_id: UUID
    report_seq: Sequence
    run_id: UUID | None
    disposition: Literal['RETRY', 'QUARANTINE']
    code: RunReportTransientCode | RunReportPermanentCode
    expected_report_seq: Sequence = omitted()

    @model_validator(mode='after')
    def disposition_matches_code(self):
        retry = self.code in ('RUN_REPORT_SEQUENCE', 'RUN_REPORT_STORAGE')
        if (self.disposition == 'RETRY') != retry:
            raise ValueError('transient reports retry; permanent reports quarantine')
        expected = 'expected_report_seq' in self.model_fields_set
        if expected != (self.code == 'RUN_REPORT_SEQUENCE'):
            raise ValueError('only sequence gaps require expected_report_seq')
        return self


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


ServerAgentMessage = Annotated[
    AgentLease | AgentCommand | AgentStop | AgentUnlock | AgentServerPing | AgentStreams
    | AgentPhoneRevoke | RunRecorded | RunReportRejected, Field(discriminator='t')]


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
    model_config = ConfigDict(json_schema_extra=optional_response_fields('safety_reason', 'telemetry_source'))
    telemetry_source: Literal['PHONE'] | None = Field(default=None, exclude_if=lambda value: value is None)
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
    safety_reason: SafetyReason | None = None
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
    archived_at: UTCDateTime | None = None
    model_config = ConfigDict(json_schema_extra=optional_response_fields('provenance', 'floor_z', 'archived_at'))
    provenance: Literal['HUMAN', 'SIMULATION'] = 'HUMAN'
    floor_z: float | None = None
    id: UUID
    building_id: UUID
    name: str
    level: int
    approved_version_id: UUID | None
    pending_count: int = 0


class MapBuilding(Contract):
    archived_at: UTCDateTime | None = None
    model_config = ConfigDict(json_schema_extra=optional_response_fields('sim_world_id', 'archived_at'))
    sim_world_id: str | None = None
    id: UUID
    site_id: UUID
    name: str
    floors: list[MapFloor] = Field(default_factory=list)


class MapSite(Contract):
    model_config = ConfigDict(json_schema_extra=optional_response_fields('archived_at'))
    archived_at: UTCDateTime | None = None
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
    model_config = ConfigDict(json_schema_extra=optional_response_fields('provenance'))
    provenance: Literal['HUMAN', 'SIMULATION'] = 'HUMAN'
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
    # Imported display/log labels have no executable steps (ADR-003 decision 5).
    steps: list[MissionStep] = Field(max_length=100)
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


def mission_capabilities(steps: list[MissionStep]) -> list[ExecutionCapabilityKey]:
    keys = set()
    for step in steps:
        if step.action == 'WAIT':
            keys.add('wait')
        elif step.action == 'PHOTO':
            keys.add('photo.' + step.params['camera'])
        elif step.action == 'SENSOR_LOG':
            keys.add('sensor_log.' + step.params['device'])
        else:
            keys.add('operator_confirm')
    return sorted(keys)


class AgentScenarioWaypoint(ScenarioWaypoint):
    mission_name: str
    # Optional only for scenario/1 read compatibility; presence is not permission.
    mission_steps: list[MissionStep] = omitted(max_length=100, exclude_if=lambda value: value is None)
    required_capabilities: list[ExecutionCapabilityKey] = omitted(max_length=8, exclude_if=lambda value: value is None)

    @model_validator(mode='after')
    def fixed_steps_requirements(self):
        supplied = {'mission_steps', 'required_capabilities'} & self.model_fields_set
        if supplied and len(supplied) != 2:
            raise ValueError('fixed steps and required capabilities must be supplied together')
        if supplied and sorted(self.required_capabilities) != mission_capabilities(self.mission_steps):
            raise ValueError('required capabilities must exactly match fixed mission steps')
        return self


class ExecutableAgentScenarioWaypoint(AgentScenarioWaypoint):
    mission_steps: list[MissionStep] = Field(max_length=100)
    required_capabilities: list[ExecutionCapabilityKey] = Field(max_length=8)


class RunMapProof(Contract):
    """Immutable map bytes/geometry; UUID is an identifier, never a content digest."""
    floor_id: UUID
    map_version_id: UUID
    image_sha256: str = Field(pattern=r'^[0-9a-f]{64}$')
    source_pgm_sha256: str = Field(pattern=r'^[0-9a-f]{64}$')
    origin: tuple[Annotated[float, Field(strict=True)], Annotated[float, Field(strict=True)],
                  Annotated[float, Field(strict=True)]]
    resolution: float = Field(gt=0, strict=True)
    width: int = Field(gt=0, le=4096, strict=True)
    height: int = Field(gt=0, le=4096, strict=True)
    source: Literal['HUMAN', 'SIMULATION']
    # Static world/floor binding. Live episode/epoch must also be checked locally.
    world_id: str | None = Field(min_length=1, max_length=128)
    ros_floor_id: str | None = Field(min_length=1, max_length=64)

    @model_validator(mode='after')
    def simulation_binding(self):
        if self.source == 'SIMULATION':
            if not self.world_id or not self.ros_floor_id:
                raise ValueError('simulation maps require world and floor binding')
        elif self.world_id is not None or self.ros_floor_id is not None:
            raise ValueError('human maps cannot claim a simulation world')
        return self


class AgentScenario(Contract):
    """GET /agent/scenarios/{id}?version=n: stored references, before agent validation."""
    model_config = ConfigDict(json_schema_extra=optional_response_fields('map_proofs'))
    id: UUID
    number: int = Field(ge=1, le=2**31 - 1, strict=True)
    waypoints: list[AgentScenarioWaypoint] = Field(min_length=1, max_length=200)
    finish: ScenarioFinish
    # Transitional read compatibility only; ProvenAgentScenario is the start gate.
    map_proofs: list[RunMapProof] | None = None

    @model_validator(mode='after')
    def complete_map_proofs(self):
        if self.map_proofs is not None:
            points = [*self.waypoints]
            if self.finish.target is not None:
                points.append(self.finish.target)
            wanted = {(p.floor_id, p.map_version_id) for p in points}
            supplied = [(p.floor_id, p.map_version_id) for p in self.map_proofs]
            if len(set(supplied)) != len(supplied) or set(supplied) != wanted:
                raise ValueError('map proofs must cover every referenced floor/map exactly once')
        return self


class ProvenAgentScenario(AgentScenario):
    """New execution input: missing map evidence fails closed before motion."""
    model_config = ConfigDict(json_schema_extra=optional_response_fields())
    map_proofs: list[RunMapProof] = Field(min_length=1, max_length=201)


class ExecutableAgentScenario(ProvenAgentScenario):
    """Explicit scenario/2 response; scenario/1 remains DISPLAY_ONLY."""
    run_contract: Literal['scenario/2']
    execution_capability_revision: CapabilityRevision
    waypoints: list[ExecutableAgentScenarioWaypoint] = Field(min_length=1, max_length=200)


class RunStarted(Contract):
    """RUN_STARTED.data; robot/org and receive time come from the authenticated link."""
    run_contract: Literal['scenario/2'] = omitted(exclude_if=lambda value: value is None)
    execution_capability_revision: CapabilityRevision = omitted(exclude_if=lambda value: value is None)
    run_id: UUID
    scenario_id: UUID
    scenario_version: int = Field(ge=1, le=2**31 - 1, strict=True)
    floor_id: UUID
    map_version_id: UUID
    user_id: UUID
    device_id: UUID
    surface: Literal['phone', 'pc']
    screen_id: UUID
    simulation: bool = Field(strict=True)
    map_proof: RunMapProof = omitted()

    @model_validator(mode='after')
    def matching_map_proof(self):
        execution = {'run_contract', 'execution_capability_revision'} & self.model_fields_set
        if execution and len(execution) != 2:
            raise ValueError('scenario/2 start requires contract and capability revision together')
        if self.map_proof is not None:
            proof = self.map_proof
            if (proof.floor_id != self.floor_id or proof.map_version_id != self.map_version_id
                    or (proof.source == 'SIMULATION') != self.simulation):
                raise ValueError('start proof must match floor/map and simulation provenance')
        return self


class ProvenRunStarted(RunStarted):
    """New RUN_STARTED payload after the local map validator has succeeded."""
    map_proof: RunMapProof


class ExecutableRunStarted(ProvenRunStarted):
    run_contract: Literal['scenario/2']
    execution_capability_revision: CapabilityRevision


class RunGoal(Contract):
    model_config = ConfigDict(json_schema_serialization_defaults_required=False)
    mission_steps: list[MissionStep] = omitted(max_length=100, exclude_if=lambda value: value is None)
    required_capabilities: list[ExecutionCapabilityKey] = omitted(max_length=8, exclude_if=lambda value: value is None)
    idx: int = Field(ge=0, le=199, strict=True)
    waypoint_ref: str | None = Field(min_length=1, max_length=128)
    x: float = Field(strict=True)
    y: float = Field(strict=True)
    yaw: float = Field(strict=True)
    mission_id: UUID
    mission_version: int = Field(ge=1, strict=True)
    mission_name: str

    @model_validator(mode='after')
    def fixed_steps_requirements(self):
        supplied = {'mission_steps', 'required_capabilities'} & self.model_fields_set
        if supplied and len(supplied) != 2:
            raise ValueError('fixed steps and required capabilities must be supplied together')
        if supplied and sorted(self.required_capabilities) != mission_capabilities(self.mission_steps):
            raise ValueError('required capabilities must exactly match fixed mission steps')
        return self


class ExecutableRunGoal(RunGoal):
    mission_steps: list[MissionStep] = Field(max_length=100)
    required_capabilities: list[ExecutionCapabilityKey] = Field(max_length=8)


class RunSegment(Contract):
    floor_id: UUID
    map_version_id: UUID
    goals: list[RunGoal] = Field(min_length=1, max_length=200)

    @model_validator(mode='after')
    def ordered_goals(self):
        if [goal.idx for goal in self.goals] != list(range(len(self.goals))):
            raise ValueError('goals must be ordered idx=0..N-1')
        return self


class RunPlan(Contract):
    """Agent-verified snapshot, never accepted as a direct run.start body."""
    segments: list[RunSegment] = Field(min_length=1, max_length=1)


class ExecutableRunSegment(RunSegment):
    goals: list[ExecutableRunGoal] = Field(min_length=1, max_length=200)


class ExecutableRunPlan(RunPlan):
    run_contract: Literal['scenario/2']
    execution_capability_revision: CapabilityRevision
    segments: list[ExecutableRunSegment] = Field(min_length=1, max_length=1)


class RunWaypointArrived(Contract):
    run_id: UUID
    idx: int = Field(ge=0, le=199, strict=True)
    waypoint_ref: str | None = Field(min_length=1, max_length=128)
    mission_id: UUID
    mission_version: int = Field(ge=1, strict=True)
    mission_name: str
    floor_id: UUID
    map_version_id: UUID
    pose: AgentPose
    agent_instance_id: UUID
    report_seq: Sequence
    monotonic_s: float = Field(ge=0, strict=True)


class RunDisplayResults(Contract):
    model_config = ConfigDict(json_schema_serialization_defaults_required=False)
    mode: Literal['DISPLAY_ONLY'] = 'DISPLAY_ONLY'


class RunPhotoReference(Contract):
    """Only server-committed JPEG references; never image bytes or arbitrary URLs."""
    photo_id: UUID
    source: Literal['rgb']
    captured_at: UTCDateTime
    sha256: str = Field(pattern=r'^[0-9a-f]{64}$')


class RunStepResult(Contract):
    step_idx: int = Field(ge=0, le=99, strict=True)
    action: ActionKey
    source: Literal['rgb', 'depth', 'lidar', 'battery'] | None
    status: Literal['SUCCEEDED', 'FAILED']
    failure_code: Literal['UNSUPPORTED', 'CAPABILITY_CHANGED', 'DEVICE_UNAVAILABLE',
                          'NO_FRESH_FRAME', 'CAPTURE_TIMEOUT', 'UPLOAD_FAILED',
                          'STORAGE_UNAVAILABLE', 'INTERRUPTED', 'ACTION_FAILED'] | None
    failure_reason: str | None = Field(max_length=512)
    photo: RunPhotoReference | None

    @model_validator(mode='after')
    def result_consistency(self):
        if self.status == 'SUCCEEDED':
            if self.failure_code is not None or self.failure_reason is not None:
                raise ValueError('success cannot carry failure fields')
        elif not self.failure_code or not self.failure_reason or not self.failure_reason.strip():
            raise ValueError('failed step requires code and reason')
        if self.action == 'PHOTO':
            if self.source not in ('rgb', 'depth'):
                raise ValueError('PHOTO requires camera source')
            if self.status == 'SUCCEEDED':
                if self.photo is None or self.photo.source != self.source:
                    raise ValueError('successful PHOTO requires committed matching photo reference')
            elif self.photo is not None:
                raise ValueError('failed PHOTO cannot claim committed success')
        elif self.photo is not None:
            raise ValueError('only PHOTO can carry a photo reference')
        if self.action in ('WAIT', 'OPERATOR_CONFIRM') and self.source is not None:
            raise ValueError('WAIT/OPERATOR_CONFIRM have no media source')
        if self.action == 'SENSOR_LOG' and self.source is None:
            raise ValueError('SENSOR_LOG requires device source')
        return self


class RunExecutedResults(Contract):
    mode: Literal['EXECUTED']
    run_contract: Literal['scenario/2']
    execution_capability_revision: CapabilityRevision
    steps: list[RunStepResult] = Field(max_length=100)

    @model_validator(mode='after')
    def ordered_results(self):
        if [s.step_idx for s in self.steps] != list(range(len(self.steps))):
            raise ValueError('results must be ordered step_idx=0..N-1')
        failures = [i for i, s in enumerate(self.steps) if s.status == 'FAILED']
        if failures and failures != [len(self.steps) - 1]:
            raise ValueError('no step may follow a failed step')
        return self

    def validate_plan(self, goal: ExecutableRunGoal, revision: int) -> None:
        """Server/executor must bind results to their authenticated fixed run snapshot."""
        if self.execution_capability_revision != revision:
            raise ValueError('result capability revision differs from run snapshot')
        if len(self.steps) > len(goal.mission_steps):
            raise ValueError('too many step results')
        if (not self.steps or self.steps[-1].status == 'SUCCEEDED') and len(self.steps) != len(goal.mission_steps):
            raise ValueError('successful waypoint requires all fixed steps')
        for result, step in zip(self.steps, goal.mission_steps):
            source = step.params.get('camera') if step.action == 'PHOTO' else step.params.get('device')
            if result.action != step.action or result.source != source:
                raise ValueError('step result differs from fixed action/source')


class RunWaypointRecorded(RunWaypointArrived):
    results: Annotated[RunDisplayResults | RunExecutedResults, Field(discriminator='mode')]


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
    t: Literal['lease.take', 'lease.request', 'lease.release', 'lease.cancel', 'view']


class PhoneStop(PhoneEnvelope):
    t: Literal['stop']
    request_id: UUID = omitted()


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


class PhoneRunStart(PhoneEnvelope):
    t: Literal['run.start']
    lease_id: UUID
    run_id: UUID
    screen_id: UUID
    scenario_id: UUID
    scenario_version: int = Field(ge=1, strict=True)
    floor_id: UUID
    map_version_id: UUID
    assignment_id: UUID = omitted(description='시뮬은 생략, 실기는 필수. 인증된 simulation으로 실행기가 판정한다.')


class PhoneRunStartV2(PhoneEnvelope):
    t: Literal['run.start.v2']
    run_contract: Literal['scenario/2']
    execution_capability_revision: CapabilityRevision
    lease_id: UUID
    run_id: UUID
    screen_id: UUID
    scenario_id: UUID
    scenario_version: int = Field(ge=1, strict=True)
    floor_id: UUID
    map_version_id: UUID
    assignment_id: UUID = omitted()


class PhoneRunControl(PhoneEnvelope):
    t: Literal['run.control']
    run_id: UUID
    op: Literal['pause', 'resume', 'abort', 'return'] = Field(description='return은 예약된 요청이며 항상 UNSUPPORTED_OPERATION으로 거부한다.')
    lease_id: UUID = omitted()
    screen_id: UUID = omitted()
    resume_token: str = omitted(min_length=1, repr=False,
                                description='같은 화면 재개의 비밀 증명. 에이전트는 해시만 보관하고 재바인딩 때 회전한다.')

    @model_validator(mode='after')
    def controller_proof(self):
        if self.op in ('pause', 'resume') and (self.lease_id is None or self.screen_id is None):
            raise ValueError('pause/resume require lease_id and screen_id')
        if self.op == 'resume' and self.resume_token is None:
            raise ValueError('resume requires same-screen proof')
        return self


class PhoneRunConfirm(PhoneEnvelope):
    """Reserved shape: first implementation always replies UNSUPPORTED_OPERATION."""
    t: Literal['run.confirm']
    lease_id: UUID
    run_id: UUID
    kind: Literal['FLOOR', 'OPERATOR']
    data: dict[str, JsonValue]


PhoneMessage = Annotated[PhoneHello | PhoneLease | PhoneStop | PhoneRespond | PhoneCommand | PhoneUnlock | PhonePing
                         | PhoneRunStart | PhoneRunStartV2 | PhoneRunControl | PhoneRunConfirm,
                         Field(discriminator='t')]


class PhonePolicyVelocityRange(Contract):
    """Accepted SI policy range, separate from the legacy phone input envelope."""
    vx_min_moving: float = Field(ge=0)
    vx_max: float
    vy_min: float
    vy_max: float
    wz_min: float
    wz_max: float


class PhoneLimits(Contract):
    # Additive metadata: old physical agents keep the original six bounds and
    # commands. Missing vx_mode means discrete; never infer a continuous range.
    model_config = ConfigDict(json_schema_serialization_defaults_required=False)
    policy_adapter_id: str | None = Field(default=None, min_length=1, max_length=128)
    requires_forward_motion: bool = False
    policy_velocity_range: PhonePolicyVelocityRange | None = None
    vx_mode: Literal['discrete', 'continuous'] = 'discrete'
    vx_min_moving: float | None = Field(default=None, ge=0)
    experimental: list[Literal['reverse', 'lateral', 'turn_in_place']] = Field(default_factory=list)
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


class PhoneCapabilities(Contract):
    model_config = ConfigDict(json_schema_serialization_defaults_required=False)
    run_contract: Literal['scenario/1']
    execution: ExecutionCapabilities = omitted(exclude_if=lambda value: value is None)


class PhoneMediaChannelCapability(Contract):
    available: bool = Field(strict=True)
    reason: str = Field(min_length=1, max_length=256)
    token: str | None = Field(min_length=43, max_length=43, repr=False)

    @model_validator(mode='after')
    def token_matches_availability(self):
        if self.available != (self.token is not None):
            raise ValueError('only available media channels receive a one-use token')
        return self


class PhoneMediaWelcome(Contract):
    version: Literal['media/1']
    path: Literal['/phone/media/ws']
    robot: PhoneRobotID
    epoch: Sequence
    episode_id: UUID | None
    rgb: PhoneMediaChannelCapability
    external: PhoneMediaChannelCapability
    lidar: PhoneMediaChannelCapability


class PhoneWelcome(Contract):
    model_config = ConfigDict(json_schema_extra=optional_response_fields('capabilities', 'media'))
    media: PhoneMediaWelcome = omitted(exclude_if=lambda value: value is None)
    capabilities: PhoneCapabilities | None = None
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


class PhoneMediaUpdate(Contract):
    """Authenticated parent notification after media binding changes, including revocation."""
    t: Literal['media.update']
    robot: PhoneRobotID
    media: PhoneMediaWelcome | None

    @model_validator(mode='after')
    def same_robot(self):
        if self.media is not None and self.media.robot != self.robot:
            raise ValueError('media update must belong to its parent robot')
        return self


class RunResumeDetail(Contract):
    run_id: UUID
    screen_id: UUID
    resume_token: str = Field(min_length=1, repr=False,
                              description='256 bit 이상 난수. 원래/재바인딩된 실행 연결에만 반환하며 기록·보기 연결에는 금지한다.')


class PhoneReply(Contract):
    model_config = ConfigDict(json_schema_extra=optional_response_fields('detail'))
    detail: RunResumeDetail | None = None
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


class RunSnapshot(Contract):
    run_id: UUID
    status: RunStatus
    step: Sequence
    progress: Progress
    wait_reason: RunWaitReason | None
    # Unknown future failure codes still reach the generic failure UI.
    fail_code: str | None

    @model_validator(mode='after')
    def paused_reason(self):
        if self.wait_reason is not None and self.status != 'PAUSED':
            raise ValueError('wait_reason is only valid while PAUSED')
        if self.fail_code in ('LINK_LOST', 'STOPPED_BY_USER', 'RECORDING_UNAVAILABLE'):
            raise ValueError('pause reasons are not failure codes')
        return self


class PhoneRunUpdate(RunSnapshot):
    t: Literal['run.update'] = 'run.update'


class PhoneState(AgentState):
    model_config = ConfigDict(json_schema_extra=optional_response_fields(
        'run', 'controller_since', 'reported_run', 'robot_serial', 'sensor_age_ms'))
    robot_serial: str | None = Field(default=None, pattern=r'^(0|[1-9][0-9]{0,9})-(0|[1-9][0-9]{0,9})$',
                                    exclude_if=lambda value: value is None)
    sensor_age_ms: int | None = Field(default=None, ge=0, strict=True,
                                     exclude_if=lambda value: value is None)
    run: RunSnapshot | None = None
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


class PhoneStateUpload(Contract):
    """Display-only relay. Possession of an issued pass is checked with app auth."""
    t: Literal['phone.state']
    robot: UUID
    pass_token: str = Field(min_length=1, max_length=4096, repr=False)
    sequence: Sequence
    observed_at: UTCDateTime
    robot_serial: str = Field(pattern=r'^(0|[1-9][0-9]{0,9})-(0|[1-9][0-9]{0,9})$')
    sensor_age_ms: int = Field(ge=0, le=1000, strict=True)
    state: AgentState

    @model_validator(mode='after')
    def physical_display_only(self):
        if any(int(part) > 0xFFFFFFFF for part in self.robot_serial.split('-')):
            raise ValueError('DDS serial must contain uint32 values')
        if self.state.mode not in ('FREE', 'USER') or self.state.reported_run is not None:
            raise ValueError('physical manual display only')
        if self.state.speed is not None and self.state.speed < 0:
            raise ValueError('nonnegative measured speed required')
        if self.state.devices_changed is not None and len(self.state.devices_changed) > 16:
            raise ValueError('at most sixteen physical devices')
        if any(len(d.key) > 64 or len(d.label) > 128 for d in self.state.devices_changed or []):
            raise ValueError('bounded physical device descriptors required')
        if any(value is not None for value in self.state.pose.model_dump().values()):
            raise ValueError('physical relay does not accept map poses')
        return self


class PhoneTicketClaims(Contract):
    model_config = ConfigDict(json_schema_extra=optional_response_fields('run_cancel'))
    iss: Literal['fh-control']
    aud: Literal['fh-phone/1']
    org: UUID
    robot: PhoneRobotID
    sub: UUID
    device: UUID
    purpose: Literal['control', 'view']
    surface: Literal['phone', 'pc'] = 'phone'
    run_cancel: bool = Field(default=False, strict=True,
                            description='서버 서명 PAUSED 취소 권한만. 생략=false; 조종·해제·재개 권한을 주지 않는다.')
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
    surface: Literal['phone', 'pc'] = 'phone'
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


# media/1 is a dedicated observation socket, never AgentMessage/PhoneMessage.
MEDIA_JPEG_MAX_BYTES = 65_536
MEDIA_JPEG_MAX_HZ = 5
MEDIA_POINT_MAX_COUNT = 4_000
MEDIA_POINT_MAX_HZ = 2
MEDIA_POINT_MAX_ABS_M = 10_000
EXTERNAL_VIEW_MAX_HZ = 10
MediaChannel = Literal['rgb', 'external', 'lidar']
MediaSource = Literal['d435i_rgb', 'go2_front', 'gazebo_external', 'l1']


class MediaLimits(Contract):
    jpeg_max_bytes: Literal[65536] = 65536
    jpeg_max_width: Literal[640] = 640
    jpeg_max_height: Literal[360] = 360
    jpeg_max_hz: Literal[5] = 5
    point_max_count: Literal[4000] = 4000
    point_max_hz: Literal[2] = 2
    point_max_abs_m: Literal[10000] = 10000
    external_view_max_hz: Literal[10] = 10
    latest_queue_size: Literal[1] = 1


class MediaBinding(Contract):
    robot: PhoneRobotID
    epoch: Sequence
    # Required null for hardware; simulation uses the current episode UUID.
    episode_id: UUID | None


class MediaHello(MediaBinding):
    t: Literal['media.hello']
    version: Literal['media/1']
    channel: MediaChannel
    token: str = Field(min_length=43, max_length=43, repr=False)


class MediaHeader(MediaBinding):
    version: Literal['media/1']
    channel: MediaChannel
    source: MediaSource
    seq: Sequence
    captured_at: UTCDateTime
    frame: str = Field(min_length=1, max_length=128, pattern=r'^[A-Za-z0-9_/-]+$')

    @model_validator(mode='after')
    def channel_source(self):
        allowed = {'rgb': ('d435i_rgb', 'go2_front'),
                   'external': ('gazebo_external',), 'lidar': ('l1',)}
        if self.source not in allowed[self.channel]:
            raise ValueError('source does not belong to channel')
        if self.channel == 'external' and self.episode_id is None:
            raise ValueError('external camera requires simulation episode')
        return self


class MediaVideoFrame(MediaHeader):
    t: Literal['media.video']
    channel: Literal['rgb', 'external']
    mime: Literal['image/jpeg']
    width: int = Field(ge=1, le=640, strict=True)
    height: int = Field(ge=1, le=360, strict=True)
    jpeg: str = Field(min_length=4, max_length=87384, pattern=r'^[A-Za-z0-9+/]+={0,2}$')

    @model_validator(mode='after')
    def bounded_jpeg(self):
        try:
            data = base64.b64decode(self.jpeg, validate=True)
        except (ValueError, binascii.Error) as error:
            raise ValueError('invalid JPEG base64') from error
        if len(data) > MEDIA_JPEG_MAX_BYTES or not data.startswith(b'\xff\xd8') or not data.endswith(b'\xff\xd9'):
            raise ValueError('expected JPEG markers and at most 65536 decoded bytes')
        if base64.b64encode(data).decode('ascii') != self.jpeg:
            raise ValueError('JPEG base64 must be canonical')
        return self


class MediaPose(Contract):
    x: float = Field(ge=-10000, le=10000, strict=True)
    y: float = Field(ge=-10000, le=10000, strict=True)
    z: float = Field(ge=-10000, le=10000, strict=True)
    yaw: float = Field(ge=-math.pi, le=math.pi, strict=True)


class MediaPointCloudHeader(MediaHeader):
    """One JSON header followed immediately by one binary message of count*12 bytes."""
    t: Literal['media.points']
    channel: Literal['lidar']
    source: Literal['l1']
    frame: Literal['map', 'lidar_link']
    map_version_id: UUID | None
    pose: MediaPose | None
    count: int = Field(ge=0, le=4000, strict=True)
    truncated: bool = Field(strict=True)
    encoding: Literal['xyz_f32le']
    byte_length: int = Field(ge=0, le=48000, strict=True)

    @model_validator(mode='after')
    def point_layout(self):
        if self.byte_length != self.count * 12:
            raise ValueError('XYZ float32 LE requires byte_length = count * 12')
        if self.frame == 'map' and (self.map_version_id is None or self.pose is None):
            raise ValueError('map points require a verified map version and pose/TF')
        if self.frame == 'lidar_link' and (self.map_version_id is not None or self.pose is not None):
            raise ValueError('raw lidar points must not claim map pose/version')
        return self

    def validate_payload(self, payload: bytes) -> None:
        if not isinstance(payload, bytes) or len(payload) != self.byte_length:
            raise ValueError('point binary length differs from header')
        for (coordinate,) in struct.iter_unpack('<f', payload):
            if not math.isfinite(coordinate) or abs(coordinate) > MEDIA_POINT_MAX_ABS_M:
                raise ValueError('point coordinate must be finite and within 10000 m')


class MediaStatus(MediaBinding):
    t: Literal['media.status']
    version: Literal['media/1']
    channel: MediaChannel
    state: Literal['NO_VIDEO', 'NO_POINTS', 'UNAVAILABLE']
    reason: str = Field(min_length=1, max_length=256)


MediaMessage = Annotated[MediaVideoFrame | MediaPointCloudHeader | MediaStatus, Field(discriminator='t')]


class ExternalCameraViewRequest(MediaBinding):
    """Observer-only request; server fixes camera entity/service, never robot pose."""
    t: Literal['external.view']
    version: Literal['observer/1']
    episode_id: UUID
    seq: Sequence
    yaw: float = Field(ge=-math.pi, le=math.pi, strict=True, description='Orbit yaw in radians.')
    pitch: float = Field(ge=-1.2, le=1.2, strict=True, description='Orbit pitch in radians.')
    radius: float = Field(ge=0.5, le=10, strict=True, description='Orbit radius in metres.')


class PhotoUploadMetadata(Contract):
    """Agent-authenticated REST metadata; ownership is rechecked against auth/DB."""
    org_id: UUID
    robot_id: UUID
    run_id: UUID
    waypoint_idx: int = Field(ge=0, le=199, strict=True)
    step_idx: int = Field(ge=0, le=99, strict=True)
    source: Literal['rgb']
    captured_at: UTCDateTime
    mime: Literal['image/jpeg']
    byte_length: int = Field(ge=4, le=65536, strict=True)
    sha256: str = Field(pattern=r'^[0-9a-f]{64}$')
    idempotency_key: IdempotencyKey

    def validate_payload(self, payload: bytes) -> None:
        import hashlib
        if not isinstance(payload, bytes) or len(payload) != self.byte_length:
            raise ValueError('photo binary length differs from metadata')
        if not payload.startswith(b'\xff\xd8') or not payload.endswith(b'\xff\xd9'):
            raise ValueError('expected JPEG markers')
        if hashlib.sha256(payload).hexdigest() != self.sha256:
            raise ValueError('photo SHA-256 differs from metadata')


class PhotoUploadReceipt(PhotoUploadMetadata):
    """Emitted only after atomic bytes + metadata commit; ACK precedes step success."""
    photo_id: UUID
    stored_at: UTCDateTime

    @model_validator(mode='after')
    def stored_after_capture(self):
        if self.stored_at < self.captured_at:
            raise ValueError('storage receipt cannot precede capture')
        return self


class SimFailureDetail(Contract):
    """Allowlisted diagnostics; only exact resource pre-creation proof releases a slot."""
    model_config = ConfigDict(json_schema_serialization_defaults_required=False)
    reason: Literal['resources_low', 'manager_unreachable', 'slot_busy', 'unknown']
    start_not_created: bool = Field(default=False, strict=True)
    mem_available_mib: float | None = Field(default=None, ge=0, strict=True)
    load1: float | None = Field(default=None, ge=0, strict=True)
    min_mem_available_mib: float | None = Field(default=None, ge=0, strict=True)
    max_load1: float | None = Field(default=None, ge=0, strict=True)


class SimWorldFloor(Contract):
    model_config = ConfigDict(json_schema_extra=optional_response_fields('ros_floor_id'))
    floor_id: UUID
    name: str
    floor_z: float
    map_version_id: UUID
    ros_floor_id: str | None = None


class SimWorld(Contract):
    model_config = ConfigDict(json_schema_extra=optional_response_fields('map_id', 'floors', 'spawn_floor_ids'))
    map_id: UUID | None = None
    floors: list[SimWorldFloor] = Field(default_factory=list)
    spawn_floor_ids: list[Literal['l1', 'l2']] = Field(default_factory=list)
    id: str = Field(min_length=1, max_length=128)
    name: str = Field(min_length=1, max_length=40)
    description: str = Field(default='', max_length=200)


class SimWorldStart(Contract):
    world_id: str = Field(min_length=1, max_length=128)
    spawn_floor_id: Literal['l1', 'l2'] | None = None

    @model_validator(mode='after')
    def normalize_building(self):
        if self.world_id in ('v5_building/l1', 'v5_building/l2'):
            floor = self.world_id.rsplit('/', 1)[1]
            if self.spawn_floor_id is not None and self.spawn_floor_id != floor:
                raise ValueError('conflicting spawn floor alias')
            self.world_id, self.spawn_floor_id = 'v5_building', floor
        if self.world_id == 'v5_building':
            if self.spawn_floor_id is None:
                self.spawn_floor_id = 'l1'
        elif self.spawn_floor_id is not None:
            raise ValueError('spawn floor selection requires v5_building')
        return self


class SimStartRequest(SimWorldStart):
    robot_id: UUID


class SimRemove(Contract):
    generation: int = Field(ge=1, le=9223372036854775807)
    request_nonce: UUID


class SimMapBinding(Contract):
    """Server-verified canonical GT registration; PNG and PGM hashes are distinct."""
    world_id: Literal['v5_building', 'warehouse']
    building_id: UUID
    ros_building_id: str = Field(min_length=1, max_length=64)
    ros_floor_id: Literal['l1', 'l2', 'f1']
    ros_map_version: str = Field(min_length=1, max_length=64)
    floor_id: UUID
    map_version_id: UUID
    sha256: str = Field(pattern=r'^[0-9a-f]{64}$')
    source_pgm_sha256: str = Field(pattern=r'^[0-9a-f]{64}$')
    resolution: float = Field(gt=0)
    origin: tuple[float, float, float]
    width: int = Field(gt=0, le=4096, strict=True)
    height: int = Field(gt=0, le=4096, strict=True)
    source: Literal['SIMULATION']

    @model_validator(mode='after')
    def world_floor(self):
        if (self.world_id == 'warehouse') != (self.ros_floor_id == 'f1'):
            raise ValueError('floor does not belong to world')
        return self


class SimProvision(SimStartRequest):
    map_bindings: list[SimMapBinding] = Field(default_factory=list, max_length=2)
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
    model_config = ConfigDict(json_schema_extra=optional_response_fields('spawn_floor_id'))
    spawn_floor_id: Literal['l1', 'l2'] | None = None
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
    remaining_s: int | None = Field(default=None, ge=0, le=3600,
                                  description='Manager monotonic runtime remaining at this response, in seconds.')


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

TOP['ScenarioTargetErrorCode'] = Literal['SIM_MAP_REQUIRES_SIM_ROBOT']
TOP.update(RunStatus=RunStatus, RunRecordStatus=RunRecordStatus, RunWaitReason=RunWaitReason,
           RunFailCode=RunFailCode, RunRejectCode=RunRejectCode,
           RunReportTransientCode=RunReportTransientCode, RunReportPermanentCode=RunReportPermanentCode)
TOP.update(ScreenMessage=ScreenMessage, AgentMessage=AgentMessage, PhoneMessage=PhoneMessage,
           ServerAgentMessage=ServerAgentMessage)
REQUEST_MODELS.update({PhoneHello, PhoneLease, PhoneRespond, PhoneCommand, PhoneUnlock, PhonePing, PhoneMessage, PhoneEnvelope})
REQUEST_MODELS.update({PhoneRunStart, PhoneRunControl, PhoneRunConfirm})
REQUEST_MODELS.update({RunStarted, ProvenRunStarted, ExecutableRunStarted, RunWaypointArrived, RunWaypointRecorded})
REQUEST_MODELS.update({ScreenSub, ScreenLease, ScreenRespond, ScreenCmd, ScreenUnlock, ScreenPing,
                       AgentHello, AgentState, AgentPing, AgentEvent, AgentRunUpdate, AgentCmdAck, AgentMedia, ScreenMessage, AgentMessage})
# Nested input models must have the same mode as their enclosing input union.
REQUEST_MODELS.update(T for T in TOP.values() if isinstance(T, type)
                      and issubclass(T, (AgentInput, ScreenEnvelope)))

TOP.update(MediaMessage=MediaMessage, MediaChannel=MediaChannel, MediaSource=MediaSource,
           ExecutionCapabilityKey=ExecutionCapabilityKey)
REQUEST_MODELS.update({MediaHello, ExternalCameraViewRequest, PhotoUploadMetadata, PhoneRunStartV2})

TOP.update(StopRequest=StopRequest, StopRequestStatus=StopRequestStatus)

REQUEST_MODELS.update({StopRequest, PhoneStop})

REQUEST_MODELS.add(StopRequestAck)
REQUEST_MODELS.add(PhoneStateUpload)

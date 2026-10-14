"""FOOTHOLD 앱 계약 v1 — 정본(Pydantic). 현행 sim/v2_link.py 메시지를 이름·단위 그대로 기술한다(재설계 아님).

생성물(수정 금지): contracts/v1/schema/*.json · contracts/v1/ts/index.ts ← `python tools/generate_contracts.py`
의미 정의(단위·좌표·시각·나이·episode·버전·오류·unknown/null): contracts/v1/CONTRACT.md

방향별 추가 필드 정책
  - 화면 → 서버(WS op): 모르는 필드는 무시(v2_link 와 같음). 조종 판단의 정본은 서버 Core.
  - 서버 → 화면(status·reply·조회): 모르는 필드는 무시 — 받는 쪽은 새 필드 때문에 메시지를 버리지 않는다.
  - 공용 문서 본문(doc): 정확히 정해진 키만(추가·누락 = 400). 저장 형식이라 엄격.
숫자: bool 은 숫자가 아니다, NaN·Inf 거부(strict). 생성 TS 는 타입일 뿐 런타임 검증이 아니다.
"""
import re
from typing import Annotated, Literal, Optional, Union

from pydantic import (AfterValidator, BaseModel, ConfigDict, Field, TypeAdapter, ValidationError, WithJsonSchema)

CONTRACT_VERSION = 'fh-app/1'      # 메시지에 실리지 않는다 — 필드가 없으면 v1 (CONTRACT.md «버전»)


class In(BaseModel):               # 화면 → 서버
    model_config = ConfigDict(strict=True, extra='ignore')


class Out(BaseModel):              # 서버 → 화면
    model_config = ConfigDict(strict=True, extra='ignore')


class Body(BaseModel):             # 공용 문서 본문(저장 형식)
    model_config = ConfigDict(strict=True, extra='forbid')


Fin = Annotated[float, Field(allow_inf_nan=False)]
Unit = Annotated[float, Field(ge=-1, le=1, allow_inf_nan=False)]
Num = Annotated[float, Field(ge=-1e4, le=1e4, allow_inf_nan=False)]      # 문서 좌표 m, ±10000
Rid = Optional[int]


def S(n):
    return Annotated[str, Field(max_length=n)]


# 서버가 만든 사진 경로만(임의 주소·javascript:·.. 불가). 서버 검사는 v2_link 와 같은 파이썬 정규식(\w 유니코드),
# 스키마 pattern 은 ASCII — 서버가 만드는 이름은 ASCII 뿐이라 실제 차이 없음.
_PHOTO_RE = re.compile(r'media/photos/\d{8}/[\w.-]{1,80}\.jpg')


def _photo(v):
    if not _PHOTO_RE.fullmatch(v) or '..' in v:
        raise ValueError('서버 사진 경로(media/photos/날짜/이름.jpg)만')
    return v


Photo = Annotated[str, AfterValidator(_photo),
                  WithJsonSchema({'type': 'string', 'pattern': r'^media/photos/[0-9]{8}/[A-Za-z0-9_.-]{1,80}\.jpg$'})]
DocId = Annotated[str, Field(pattern=r'^[a-z][A-Za-z0-9_]{1,40}$')]

# ---------------------------------------------------------------- WS 화면 → 서버 (/ws, 관문 OPS 와 같은 목록)


class OpSimple(In):
    op: Literal['take', 'release', 'stop', 'resume', 'reset', 'hidden']


class OpCmd(In):
    """20 Hz. 손 뗌 = 0,0,0. 형식이 틀리면 서버는 거부가 아니라 «명령 0 + 입력 무효화»로 처리한다."""
    op: Literal['cmd']
    fx: Unit    # 앞 +
    fy: Unit    # 왼쪽 +
    fw: Unit    # 왼회전 +


class OpRid(In):
    """응답(op=reply)이 오는 요청. rid 가 정수가 아니면 서버는 rid=null 로 답한다."""
    op: Literal['photo', 'sim_start', 'sim_stop', 'map_list', 'map_live_get', 'map_save']
    rid: Rid = None


class OpMapGet(In):
    """저장 지도 한 장. 이름은 서버 허용목록·정규식으로 다시 검사한다(docs/CONTRACT-maps-sim-stop.md)."""
    op: Literal['map_get']
    rid: Rid = None
    building_id: Literal['v5', 'v5_single', 'rooms_a']
    floor_id: Literal['f1', 'l1', 'l2']
    map_version: Annotated[str, Field(pattern=r'^(\d{8}-\d{6}-e\d+|gt-\d{8})$')]


class OpMapStart(In):
    """지도 체험 시작(RL start_map.sh 1회). 허용표·버전 규칙·원장·조종 상태는 서버가 다시 검사한다(docs/CONTRACT-maps-sim-stop.md 8절)."""
    op: Literal['map_start']
    rid: Rid = None
    world_id: Literal['v5_single', 'v5_building', 'rooms_a']
    floor_id: Literal['f1', 'l1', 'l2']
    mode: Literal['slam', 'static']
    map_version: Optional[Annotated[str, Field(pattern=r'^(\d{8}-\d{6}-e\d+|gt-\d{8})$')]] = None   # static 만(필수), slam 은 없음


ClientOp = Annotated[Union[OpSimple, OpCmd, OpRid, OpMapGet, OpMapStart], Field(discriminator='op')]

# ---------------------------------------------------------------- WS 서버 → 화면


class SimState(Out):
    """status.sim = v2_link clean_state() 결과. 관문값 4개는 항상 형식이 맞다(아니면 sim 자체를 받지 않음).
    나머지는 시뮬이 형식에 맞게 보냈을 때만 값, 아니면 null(=미확인). 키는 항상 모두 있다."""
    episode: int
    stop_requested: bool
    reset_in_progress: bool
    policy_running: bool
    sim_t: Optional[Fin]; x: Optional[Fin]; y: Optional[Fin]; z: Optional[Fin]; yaw: Optional[Fin]
    vx: Optional[Fin]; vy: Optional[Fin]; wz: Optional[Fin]; tilt_deg: Optional[Fin]; rtf: Optional[Fin]
    cmd_age_s: Optional[Fin]; ttl_s: Optional[Fin]
    fallen: Optional[bool]; body_still: Optional[bool]; resume_wait: Optional[bool]; ttl_expired: Optional[bool]
    cmd_tested: Optional[bool]; fallback_active: Optional[bool]; online_ready: Optional[bool]; safe_fallback_verified: Optional[bool]
    source: Optional[str]; terrain_input: Optional[str]; camera: Optional[str]; plugin_mode: Optional[str]
    cmd_applied: Optional[Annotated[list[Fin], Field(min_length=3, max_length=3)]]


class Event(Out):
    t: str                                  # 'HH:MM:SS' 서버 지역 시각
    st: Literal['ok', 'warn', 'bad']
    text: str


class SimSession(Out):
    result: Optional[Literal['running', 'starting', 'idle']]
    reason: Optional[str]; started_at: Optional[str]; ends_at: Optional[str]; remaining_s: Optional[Fin]


class SimStartState(Out):
    ok: bool
    why: str
    busy: bool
    session: Optional[SimSession]


class SimStopLast(Out):
    t: str                                  # 서버 HH:MM:SS
    st: Literal['ok', 'bad']                # ok = ROS 세션 종료 확인(unit 비활성 + 상태 3 s 끊김)일 때만. 미확인·시간 초과 = bad
    text: str


class SimStopState(Out):
    """«Gazebo 종료»(로봇 STOP 아님). 거부 이유·실행 판단의 정본은 서버. Gazebo 잔여 프로세스 0 은 확인 범위 밖"""
    ok: bool                                # 지금 이 기기가 누를 수 있나
    why: str                                # 못 누르는 이유('' = 가능)
    busy: bool
    on: bool                                # 시뮬 켜짐(상태 수신 중 또는 RL 세션 running/starting)
    ledger_left: Optional[int]              # RL 기동 원장 남은 횟수, null = 미확인
    last: Optional[SimStopLast]


class LiveGrid(Out):
    seq: int                                # 서버가 새 격자를 결속할 때마다 +1 — 바뀌면 map_live_get
    w: int; h: int
    res: Fin
    origin: Annotated[list[Fin], Field(min_length=3, max_length=3)]   # 왼쪽 아래 칸의 map 좌표(x, y, z). 회전 0 만


class LivePose(Out):
    x: Fin; y: Fin; yaw: Fin
    source: Literal['slam_tf', 'gt_identity']   # slam_tf = SLAM 보정 / gt_identity = GT 기하 지도에 시뮬 GT(SLAM 아님)


class LiveSave(Out):
    ok: bool
    map_version: Optional[str]
    reason: str
    epoch: Optional[int]


class LiveMap(Out):
    """/v2_map/* 실시간 지도 요약(서버 결속 정본). 경로 없음. st: off 미수신 · stale 3 s 끊김 · unknown 형식 모름 · reset 리셋 중 · wait 이번 epoch 지도 전 · bad 지도 오류 · ok 표시"""
    st: Literal['off', 'stale', 'unknown', 'reset', 'wait', 'bad', 'ok']
    why: str
    age_s: Optional[Fin] = None
    world_id: Optional[Literal['v5_single', 'v5_building', 'rooms_a']] = None
    building_id: Optional[Literal['v5', 'v5_single', 'rooms_a']] = None
    floor_id: Optional[Literal['f1', 'l1', 'l2']] = None
    mode: Optional[Literal['slam', 'static']] = None
    map_source: Optional[Literal['slam', 'gt_raster']] = None
    map_version: Optional[str] = None
    epoch: Optional[int] = None
    sim_t: Optional[Fin] = None
    scan: Optional[dict] = None             # {n, age_s}
    slam: Optional[str] = None              # 현재 epoch 의 slam 수명주기 결과(ok = 활성화 성공)
    last_save: Optional[LiveSave] = None
    grid: Optional[LiveGrid] = None
    pose: Optional[LivePose] = None
    pose_why: Optional[str] = None


class MapLedger(Out):
    used: int; max: int
    keys: list[str]                         # 이미 쓴 «지형/층» 키(지형·층마다 1회)


class MapStartState(Out):
    """지도 체험 시작. 원장은 지도 체험 것(map-20261014)만 — 기존 체험 원장(sim_stop.ledger_left)과 섞지 않는다"""
    ok: bool; why: str; busy: bool
    ledger: Optional[MapLedger]             # null = 미확인
    session: Optional[dict]                 # {result, runner, world_id, floor_id, map_mode, remaining_s}
    last: Optional[SimStopLast]


class MapSaveState(Out):
    ok: bool; why: str; busy: bool


class Status(Out):
    """10 Hz 상태. 안전 판단(latch·applied·reason)의 정본은 서버. role 은 송신 허용에만 쓴다."""
    op: Literal['status']
    role: Literal['control', 'view_other', 'view']
    latch: bool
    applied: Annotated[list[Fin], Field(min_length=3, max_length=3)]   # 지금 발행 중 (vx m/s, vy m/s, wz rad/s)
    reason: str
    sim_block: str                          # '' = 막힘 없음
    resume_pending: bool
    reset_pending: bool
    episode: Optional[int]
    ros_domain: Optional[str]
    state_age: Optional[Fin]                # s, 마지막 시뮬 상태 이후. null = 한 번도 못 받음
    cam_age: Optional[Fin]                  # s, 마지막 카메라 프레임 이후. null = 한 번도 못 받음
    sim: Optional[SimState]
    events: Annotated[list[Event], Field(max_length=6)]   # 최신 먼저
    note: str
    me: str
    holder: Optional[str]
    ver: str
    sim_start: SimStartState
    docs_rev: int
    sim_stop: Optional[SimStopState] = None   # 없는 서버(이전 판)도 있음 — 없으면 버튼을 숨긴다
    live_map: Optional[LiveMap] = None
    map_start: Optional[MapStartState] = None
    map_save: Optional[MapSaveState] = None


class PhotoMeta(Out):
    """photos.jsonl 한 줄 = 사진 저장 응답. 위치는 저장 요청 때의 최신 GT(프레임 동기 아님)."""
    frame_at: str
    frame_stamp_sim_s: Optional[Fin]
    episode: Optional[int]
    by: str
    source: Optional[str]
    x: Optional[Fin]; y: Optional[Fin]; yaw: Optional[Fin]
    gt_note: str
    gt_age_s: Fin
    camera: str
    saved_at: str
    bytes: int
    url: Photo


class MapInfo(Out):
    """저장 지도 meta 요약(서버가 sha·크기 검증을 마친 것만). 행 순서는 PGM 그대로 — 첫 행 = y 가 가장 큰 쪽, origin = 왼쪽 아래 칸의 월드 좌표."""
    world_id: Literal['v5_single', 'v5_building', 'rooms_a']
    building_id: Literal['v5', 'v5_single', 'rooms_a']
    floor_id: Literal['f1', 'l1', 'l2']
    map_version: str
    map_source: Literal['slam', 'gt_raster']
    epoch: Optional[Annotated[int, Field(ge=1)]]   # slam ≥1 · gt_raster null
    resolution: Annotated[Fin, Field(gt=0)]
    origin: Annotated[list[Fin], Field(min_length=3, max_length=3)]
    width: Annotated[int, Field(ge=1, le=2000)]
    height: Annotated[int, Field(ge=1, le=2000)]
    saved_sim_t: Optional[Fin]


class MapData(MapInfo):
    png: str        # base64 8비트 회색 PNG(0 막힘·205 미지·254 빈칸, trinary)


class Reply(Out):
    op: Literal['reply']
    rid: Rid
    ok: bool
    text: str
    photo: Optional[PhotoMeta] = None       # op=photo 성공 때만
    maps: Optional[list[MapInfo]] = None    # op=map_list 성공 때만
    map: Optional[MapData] = None           # op=map_get 성공 때만
    live: Optional[dict] = None             # op=map_live_get 성공 때만 {seq, epoch, world_id, floor_id, png}


ServerMsg = Annotated[Union[Status, Reply], Field(discriminator='op')]   # 텍스트 프레임. 바이너리 프레임 = JPEG 원본

# ---------------------------------------------------------------- 공용 문서 본문(doc) — v2_link DOC_KINDS 와 같은 형식

Mod = Literal['사진', '운영자 확인', '대기']     # 지금 앱으로 실제 할 수 있는 모듈만
Point = Annotated[list[Num], Field(min_length=2, max_length=2)]


class Zone(Body):
    name: S(40)
    type: Literal['금지', '감속']
    pts: Annotated[list[Point], Field(min_length=3, max_length=40)]


class TmplMod(Body):
    type: Mod
    detail: S(80)


class Tmpl(Body):
    name: S(60)
    desc: S(120)
    mods: Annotated[list[TmplMod], Field(max_length=6)]


class Waypoint(Body):
    x: Num
    y: Num
    name: S(40)
    mods: Annotated[list[Mod], Field(max_length=3)]


class Mission(Body):
    name: S(60)
    tmpl: S(40)
    memo: S(400)
    wps: Annotated[list[Waypoint], Field(max_length=30)]


class RunWaypoint(Waypoint):
    st: Literal['대기', '방문', '미방문']
    at: S(32)
    why: S(120)
    chk: Literal['', '확인', '보류', '제외']
    photos: Annotated[list[Photo], Field(max_length=10)]


class Run(Body):
    """수동 임무 진행(운영자 기록 — 로봇 자동 완료 아님). status=진행 은 전체에서 하나만."""
    mode: Literal['수동']
    mission: S(40)
    tmpl: S(60)
    name: S(60)
    status: Literal['진행', '완료', '실패', '중단']
    started: S(32)
    ended: S(32)
    memo: S(400)
    wps: Annotated[list[RunWaypoint], Field(max_length=30)]


class Note(Body):
    """사진 분류(운영자 관찰, AI 탐지 없음). 같은 photo 에 하나만."""
    photo: Photo
    cls: Literal['확인', '보류', '제외']
    memo: S(400)


DOC_KINDS = {'zone': Zone, 'tmpl': Tmpl, 'mission': Mission, 'run': Run, 'note': Note}
DocKind = Literal['zone', 'tmpl', 'mission', 'run', 'note']
DOC_MAX, DOC_TOTAL = 12000, 2000            # 본문 UTF-8 JSON 바이트 상한 · 전체 문서 수 상한


class _Env(Out):
    id: DocId
    rev: Annotated[int, Field(ge=1)]
    by: str                                 # 관문이 붙인 «계정 · 기기»(서버가 붙임)
    at: str                                 # 서버 지역 시각 ISO, %z 오프셋(+0900, 콜론 없음)


class ZoneEnv(_Env):
    kind: Literal['zone']; doc: Zone


class TmplEnv(_Env):
    kind: Literal['tmpl']; doc: Tmpl


class MissionEnv(_Env):
    kind: Literal['mission']; doc: Mission


class RunEnv(_Env):
    kind: Literal['run']; doc: Run


class NoteEnv(_Env):
    kind: Literal['note']; doc: Note


DocEnvelope = Annotated[Union[ZoneEnv, TmplEnv, MissionEnv, RunEnv, NoteEnv], Field(discriminator='kind')]

# ---------------------------------------------------------------- HTTP /api/docs · /api/media


class DocsList(Out):
    """GET /api/docs. broken = 저장소 사용 불가 이유(쓰기 503) 또는 null."""
    docs: list[DocEnvelope]
    rev: int                                # 전체 판 — 바뀌면 다시 읽는다(status.docs_rev 와 비교)
    broken: Optional[str]


class DocPut(In):
    """POST /api/docs 새 문서: id=null + kind. 고침: id + 화면이 읽은 rev(kind 는 무시 — 기존 문서 종류)."""
    op: Literal['put']
    kind: Optional[DocKind] = None
    id: Optional[DocId] = None
    rev: Optional[Annotated[int, Field(ge=1)]] = None
    doc: Union[Zone, Tmpl, Mission, Run, Note]


class DocDel(In):
    op: Literal['del']
    id: DocId
    rev: Annotated[int, Field(ge=1)]


DocWrite = Annotated[Union[DocPut, DocDel], Field(discriminator='op')]


class DocPutOk(Out):
    ok: Literal[True]; id: DocId; rev: int; kind: DocKind; name: str; new: bool


class DocDelOk(Out):
    ok: Literal[True]; id: DocId; kind: DocKind; name: str


class ApiError(Out):
    """400·403·404·409·500·503 공통. 409 는 cur(지금 저장된 판) 포함 — 화면은 초안을 지우지 않는다."""
    error: str
    cur: Optional[DocEnvelope] = None


class MediaEvent(Event):
    at: str                                 # events.jsonl 기록 시각(ISO, %z)


class MediaList(Out):
    """GET /api/media. 최신 먼저, 사진 ≤200 · 사건 ≤300. 깨진 줄은 서버가 건너뜀."""
    photos: list[PhotoMeta]
    events: list[MediaEvent]
    ver: str


# ---------------------------------------------------------------- 서버용 검사(문서 본문)

_KO = {'missing': '빠짐', 'extra_forbidden': '정해지지 않은 키', 'string_too_long': '글자 수 초과', 'string_type': '글이어야 함',
       'too_short': '개수 부족', 'too_long': '개수 초과', 'list_type': '목록이어야 함', 'literal_error': '허용값 아님',
       'finite_number': '유한 숫자여야 함', 'float_type': '숫자여야 함', 'greater_than_equal': '범위 밖', 'less_than_equal': '범위 밖',
       'model_type': '객체여야 함', 'value_error': '형식'}
_BODY = {k: TypeAdapter(m) for k, m in DOC_KINDS.items()}


def check_doc(kind, doc):
    """형식이 맞으면 None, 아니면 «doc.경로: 이유». kind 는 DOC_KINDS 키여야 한다."""
    try:
        _BODY[kind].validate_python(doc, strict=True)
        return None
    except ValidationError as e:
        x = e.errors()[0]
        return f"doc{''.join(f'[{p}]' if isinstance(p, int) else f'.{p}' for p in x['loc'])}: {_KO.get(x['type'], x['msg'])}"


TOP = {'ClientOp': ClientOp, 'ServerMsg': ServerMsg, 'Status': Status, 'Reply': Reply, 'SimState': SimState,
       'PhotoMeta': PhotoMeta, 'DocEnvelope': DocEnvelope, 'DocsList': DocsList, 'DocWrite': DocWrite,
       'DocPutOk': DocPutOk, 'DocDelOk': DocDelOk, 'ApiError': ApiError, 'MediaList': MediaList}

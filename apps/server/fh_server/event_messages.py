"""F-LG-02: one registry, rendered only when appending a new event.

Server codes are closed: missing templates raise. Agent event codes are an open
wire extension; unknown ones use the explicit AGENT_EVENT template and retain
the original code/data. Reading never regenerates historical messages.
"""
from sqlalchemy import select
import math
import unicodedata
from datetime import timedelta
from zoneinfo import ZoneInfo
from .models import Robot, User, now

MESSAGE_TIMEZONE = ZoneInfo('Asia/Seoul')
MAX_VALUE_LENGTH = 128
UNKNOWN = '확인되지 않음'

TEMPLATES = {
    'SIM_ROBOT_REMOVE_STALE': '{person}님의 이전 시뮬 종료 요청을 현재 세대에서 거부했습니다.',
    'SIM_ROBOT_REMOVE_FAILED': '{person}님의 시뮬 로봇 종료 요청을 처리하지 못했습니다.',
    'SIM_ROBOT_REQUESTED': '{person}님이 시뮬 로봇 시작을 요청했습니다.',
    'SIM_ROBOT_REGISTERED': '{person}님이 시뮬 로봇을 등록했습니다.',
    'SIM_ROBOT_REMOVED': '{person}님이 시뮬 로봇을 종료했습니다.',
    'PHONE_PASS_ISSUED': '{person}님의 폰 출입증을 발급했습니다.',
    'PHONE_PASS_DENIED': '폰 출입증 발급을 거절했습니다.',
    'MISSION_CREATED': '{person}님이 임무 {place} {number}판을 만들었습니다.',
    'MISSION_VERSION_CREATED': '{person}님이 임무 {place} {number}판을 저장했습니다.',
    'MISSION_ARCHIVED': '{person}님이 임무 {place}을(를) 보관했습니다.',
    'SCENARIO_CREATED': '{person}님이 시나리오 {place} {number}판을 만들었습니다.',
    'SCENARIO_VERSION_CREATED': '{person}님이 시나리오 {place} {number}판을 저장했습니다.',
    'SCENARIO_ARCHIVED': '{person}님이 시나리오 {place}을(를) 보관했습니다.',
    'APPROVAL_REQUESTED': '{person}님이 {kind} {number}판 결재를 요청했습니다. 이유: {reason}.',
    'APPROVAL_CANCELED': '{person}님이 {kind} {number}판 요청을 취소했습니다.',
    'APPROVAL_STALE': '{other}님의 {kind} {number}판 요청 이후 지도가 바뀌어 승인을 막았습니다. 새 승인 판에서 다시 요청하세요.',
    'SITE_CREATED': '{person}님이 장소 {place}을(를) 만들었습니다.',
    'SITE_UPDATED': '{person}님이 장소 {place}을(를) 변경했습니다.',
    'SITE_DELETED': '{person}님이 장소 {place}을(를) 지웠습니다.',
    'BUILDING_CREATED': '{person}님이 건물 {place}을(를) 만들었습니다.',
    'BUILDING_UPDATED': '{person}님이 건물 {place}을(를) 변경했습니다.',
    'BUILDING_DELETED': '{person}님이 건물 {place}을(를) 지웠습니다.',
    'FLOOR_CREATED': '{person}님이 층 {place}을(를) 만들었습니다.',
    'FLOOR_UPDATED': '{person}님이 층 {place}을(를) 변경했습니다.',
    'FLOOR_DELETED': '{person}님이 층 {place}을(를) 지웠습니다.',
    'MAP_VERSION_ROLLED_BACK': '{person}님이 {copied_from_number}판을 복사한 {number}판으로 되돌렸습니다. 이유: {reason}.',
    'MAP_VERSION_APPROVED': '{person}님이 지도 {number}판을 승인했습니다.',
    'LOGIN': '{person}님이 로그인했습니다.',
    'LOGIN_FAILED': '로그인에 실패했습니다.',
    'LOGOUT': '{person}님이 로그아웃했습니다.',
    'TOKEN_REFRESHED': '앱 로그인 토큰을 갱신했습니다.',
    'SESSION_REVOKED': '기기 로그인을 종료했습니다.',
    'PASSWORD_CHANGE_FAILED': '현재 비밀번호 확인에 실패했습니다.',
    'PASSWORD_CHANGED': '비밀번호를 변경했습니다.',
    'LOGIN_RATE_LIMITED': '로그인 횟수 제한으로 {count}회 거절했습니다.',
    'PASSWORD_CHANGE_RATE_LIMITED': '비밀번호 확인 횟수 제한으로 {count}회 거절했습니다.',
    'USER_CREATED': '{person}님이 계정을 만들었습니다.',
    'USER_UPDATED': '{person}님이 계정 권한·정보를 변경했습니다.',
    'USER_ARCHIVED': '{person}님이 계정을 보관했습니다.',
    'ORG_SETTINGS_UPDATED': '{person}님이 조직 기준값을 변경했습니다.',
    'ROBOT_CREATED': '{person}님이 {robot}{object_particle} 등록했습니다.',
    'ROBOT_UPDATED': '{person}님이 {robot} 이름·담당을 변경했습니다.',
    'ROBOT_ARCHIVED': '{person}님이 {robot}{object_particle} 해제했습니다.',
    'AGENT_TOKEN_ROTATED': '{person}님이 로봇 인증 토큰을 재발급했습니다.',
    'TAKE': '{person}님이 {robot} 조종권을 받았습니다.',
    'RELEASE': '{person}님이 {robot} 조종을 끝냈습니다.',
    'REQUEST': '{person}님이 {robot} 조종권을 요청했습니다.',
    'ACCEPT': '{person}님이 {robot} 조종권을 {other}님에게 넘겼습니다.',
    'DECLINE': '{person}님이 {robot} 조종권 요청을 거절했습니다.',
    'TIMEOUT': '응답이 없어 {robot} 조종권 요청이 끝났습니다.',
    'EXPIRE': '{robot} 조종권이 만료되었습니다.',
    'RUN_TAKE': '{robot} 실행이 조종권을 받았습니다.',
    'RUN_PAUSE_TAKEOVER': '{robot} 실행을 일시정지하고 {person}님이 조종권을 받았습니다.',
    'STOP': '{person}님이 {robot} STOP 을 눌렀습니다.',
    'STOP_CONFIRM_FAILED': '{robot} 정지 확인에 실패했습니다.',
    'AUDIT_DROPPED': '{robot} 감사 기록 {count}개를 묶거나 생략했습니다.',
    'AUDIT_QUARANTINED': '{robot} 저장할 수 없는 사건을 격리했습니다.',
    'HISTORY_STORAGE_BLOCKED': '서버에서 {robot} 사건 저장이 막혔습니다.',
    'AGENT_HISTORY_STORAGE_BLOCKED': '{robot} 자체 사건 저장에 실패했습니다.',
    'AGENT_INVENTORY_FAILED': '{robot} 장치 정보를 저장하지 못했습니다.',
    'AGENT_INVALID_HELLO': '{robot} 장치 목록·초기 연결 정보가 올바르지 않습니다.',
    'AGENT_CONNECTED': '{robot}{subject} 연결되었습니다.',
    'AGENT_DISCONNECTED': '{robot}{with_particle} 연결이 끊겼습니다. 마지막 확인 상태: {status}. 이후 상태는 확인되지 않았습니다.',
    'AGENT_PROTOCOL_MISMATCH': '{robot} 연결 규약이 맞지 않습니다.',
    'AGENT_INVALID_FRAME': '{robot}에서 올바르지 않은 메시지를 보냈습니다.',
    'AGENT_BACKLOG_OVERFLOW': '{robot} 사건 대기 용량이 초과되었습니다.',
    'AGENT_EVENT': '{robot}에서 사건 {code}이(가) 기록되었습니다.',
    'LEASE_MISMATCH': '{robot} 조종권이 일치하지 않아 요청을 거절했습니다.',
    'LEASE_REQUEST_STALE': '{robot} 조종권 요청이 끝나 요청을 거절했습니다.',
    'LEASE_HELD': '{robot}{object_particle} 다른 사람이 조종 중입니다.',
    'LEASE_REQUEST_COOLDOWN': '{robot} 조종권 요청을 잠시 뒤 다시 해 주세요.',
    'LEASE_FREE': '{robot}{object_particle} 조종 중인 사람이 없습니다.',
    'LEASE_REQUEST_PENDING': '{robot} 조종권 요청이 이미 대기 중입니다.',
    'NOT_FOUND': '{robot}{object_particle} 찾을 수 없어 요청을 거절했습니다.',
    'POLICY_STALE': '{robot} 조종 권한을 확인할 수 없어 요청을 거절했습니다.',
    'ROBOT_ARCHIVE_BUSY': '{robot} 사건 저장이 지연되어 요청을 거절했습니다.',
    'ROBOT_AUTH_PENDING': '{robot} 연결 권한을 확인 중입니다.',
    'ROBOT_OFFLINE': '{robot} 연결이 끊겨 요청을 거절했습니다.',
    'SERVER_BUSY': '{robot} 요청을 처리할 수 없습니다. 잠시 뒤 다시 시도하세요.',
    'SUBSCRIPTION_REQUIRED': '{robot}{object_particle} 다시 선택한 뒤 조종해 주세요.',
    'CMD_SEQ': '{robot} 조종 입력 순서가 올바르지 않아 거절했습니다.',
    'CMD_RATE_LIMIT': '{robot} 조종 입력이 너무 많아 거절했습니다.',
    'STOP_GEN_MISMATCH': '{robot} 정지 상태가 바뀌어 잠금 해제를 거절했습니다.',
    'SERVER_LINK_LOST': '{robot}{with_particle} 서버 연결이 끊겼습니다.',
    'LINK_LOSS_TIMEOUT': '{robot} 연결 복구 대기 시간이 끝났습니다.',
    'EXECUTOR_STALLED': '{robot} 실행기가 응답하지 않습니다.',
    'PROTOCOL_MISMATCH': '{robot} 연결 규약이 맞지 않습니다.',
    'TRANSPORT_BACKPRESSURE': '{robot} 통신이 지연되고 있습니다.',
    'STOP_GEN_EXHAUSTED': '{robot} 정지 확인 번호를 더 발급할 수 없습니다.',
    'LEASE_INVALID': '{robot} 조종권이 유효하지 않습니다.',
    'BRIDGE_STATE_INVALID': '{robot} 상태를 확인할 수 없습니다.',
    'LINK_BUFFER_DROPPED': '{robot} 연결 대기 사건 {count}개를 묶거나 생략했습니다.',
    'SERVER_CLOSED': '{robot} 서버 연결이 닫혔습니다.',
    'SERVER_RETRY': '{robot} 서버에 다시 연결합니다.',
    'RUN_SERVER_CMD_IGNORED': '{robot} 실행 요청을 적용하지 않았습니다.',
    'RUN_COMPLETED': "{robot}{subject} '{scenario}'를 마쳤습니다. 지점 {points}곳, {minutes}분.",
    'RUN_FAILED': "{robot}의 '{scenario}'가 지점 {step}에서 실패했습니다. 이유: {reason}.",
    'ROUTE_DEVIATION': '{robot}{subject} 계획 경로에서 {distance} m 벗어났습니다.',
    'LINK_LOST': '{robot}{with_particle} 연결이 끊겼습니다. 마지막 확인 상태: {status}. 이후 상태는 확인되지 않았습니다.',
    'OPERATOR_DISCONNECTED': '{person}의 연결이 끊겨 {robot} 조종권이 비워졌습니다.',
    'LEASE_HANDOVER': '{person}님이 {robot} 조종권을 {other}님에게 넘겼습니다.',
    'STOP_PRESSED': '{person}님이 {robot} STOP 을 눌렀습니다.',
    'APPROVAL_DECIDED': '{person}님이 {other}님의 {kind} 요청을 {decision}했습니다.',
    'EMERGENCY_RUN': "{person}님이 결재 없이 '{scenario}'를 긴급 실행했습니다. 이유: {reason}.",
    'BATTERY_LOW': '{robot} 배터리가 부족합니다. 남은 배터리: {battery} %.',
}

# Known agent event semantics override the previous all-agent LINK category.
CATEGORIES = {
    **dict.fromkeys(('RUN_COMPLETED', 'RUN_FAILED', 'EMERGENCY_RUN'), 'RUN'),
    'ROUTE_DEVIATION': 'ROUTE', 'LEASE_HANDOVER': 'LEASE',
    **dict.fromkeys(('STOP_PRESSED', 'BATTERY_LOW', 'SERVER_LINK_LOST', 'LINK_LOSS_TIMEOUT',
                    'EXECUTOR_STALLED', 'PROTOCOL_MISMATCH', 'TRANSPORT_BACKPRESSURE',
                    'STOP_GEN_EXHAUSTED', 'LEASE_INVALID', 'BRIDGE_STATE_INVALID',
                    'HISTORY_STORAGE_BLOCKED'), 'SAFETY'),
}

# Robot diagnostics and run observations only; human/account/approval actions
# cannot be asserted by an agent even when their code exists in TEMPLATES.
# HISTORY_STORAGE_BLOCKED is also emitted by agent Session.storage_blocked:
# its local archival fault uses an explicitly different sentence from the server.
AGENT_CODES = frozenset({
    'SERVER_LINK_LOST', 'LINK_LOSS_TIMEOUT', 'EXECUTOR_STALLED', 'PROTOCOL_MISMATCH',
    'TRANSPORT_BACKPRESSURE', 'STOP_GEN_EXHAUSTED', 'LEASE_INVALID', 'BRIDGE_STATE_INVALID',
    'HISTORY_STORAGE_BLOCKED', 'LINK_BUFFER_DROPPED', 'SERVER_CLOSED', 'SERVER_RETRY',
    'RUN_SERVER_CMD_IGNORED', 'RUN_COMPLETED', 'RUN_FAILED', 'ROUTE_DEVIATION', 'LINK_LOST', 'BATTERY_LOW',
})


def text_value(value, default=UNKNOWN):
    if not isinstance(value, str):
        return default
    value = ''.join(c for c in value if unicodedata.category(c) not in ('Cc', 'Cf', 'Cs'))
    return value.strip()[:MAX_VALUE_LENGTH] or default


def number_value(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return UNKNOWN
    if isinstance(value, float) and not math.isfinite(value):
        return UNKNOWN
    rendered = str(value)
    return rendered if len(rendered) <= MAX_VALUE_LENGTH else UNKNOWN


def particle(word, consonant, vowel):
    last = word[-1:] or ' '
    # Numeric robot suffixes use their Korean reading (삼/칠/팔 have 받침).
    closed = last in '013678' or ('가' <= last <= '힣' and (ord(last) - ord('가')) % 28 != 0)
    return consonant if closed else vowel


def render(db, ev, *, agent=False, other_user_id=None):
    if agent:
        template = TEMPLATES.get(ev.code) if ev.code in AGENT_CODES else TEMPLATES['AGENT_EVENT']
    else:
        template = TEMPLATES[ev.code]
    if template is None:
        template = TEMPLATES['AGENT_EVENT']
    if agent and ev.code in AGENT_CODES and ev.code == 'HISTORY_STORAGE_BLOCKED':
        template = TEMPLATES['AGENT_HISTORY_STORAGE_BLOCKED']
    data = ev.data or {}
    # Lookup is tenant-bound; names are frozen into the message at INSERT time.
    def name(model, identifier, default, column):
        if identifier is None:
            return default
        return text_value(db.scalar(select(column).where(model.org_id == ev.org_id, model.id == identifier)), default)
    robot = name(Robot, ev.robot_id, '로봇', Robot.name)
    person = name(User, ev.user_id, '운영자', User.display_name)
    other = name(User, other_user_id, '운영자', User.display_name)
    values = dict(copied_from_number=number_value(data.get('copied_from_number')), place=text_value(data.get('name')), number=number_value(data.get('number')), robot=robot, person=person, other=other, code=text_value(ev.code),
        subject=particle(robot, '이', '가'), with_particle=particle(robot, '과', '와'),
        object_particle=particle(robot, '을', '를'),
        count=number_value(data.get('count', 1)), status=text_value(data.get('last_status')),
        scenario=text_value(data.get('scenario_name'), '시나리오'), points=number_value(data.get('points')),
        minutes=number_value(data.get('minutes')), step=number_value(data.get('step')),
        reason=text_value(data.get('reason')), distance=number_value(data.get('distance_m')),
        battery=number_value(data.get('soc')), kind=text_value(data.get('kind'), '결재'),
        decision='승인' if data.get('approved') is True else '반려' if data.get('approved') is False else '처리')
    ev.at = ev.at or now()
    stamp = ev.at
    if ev.robot_at is not None and timedelta(0) <= ev.at - ev.robot_at <= timedelta(hours=24):
        stamp = ev.robot_at
    ev.message = stamp.astimezone(MESSAGE_TIMEZONE).strftime('%H:%M') + ' ' + template.format(**values)
    return ev

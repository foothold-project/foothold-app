"""F-LG-02: one registry, rendered only when appending a new event.

Server codes are closed: missing templates raise. Agent event codes are an open
wire extension; unknown ones use the explicit AGENT_EVENT template and retain
the original code/data. Reading never regenerates historical messages.
"""
from sqlalchemy import select
from datetime import timezone
from .models import Robot, User, now

TEMPLATES = {
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
    'ROBOT_CREATED': '{person}님이 {robot}을 등록했습니다.',
    'ROBOT_UPDATED': '{person}님이 {robot} 이름·담당을 변경했습니다.',
    'ROBOT_ARCHIVED': '{person}님이 {robot}을 해제했습니다.',
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
    'HISTORY_STORAGE_BLOCKED': '{robot} 사건 저장이 막혔습니다.',
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
    'LEASE_HELD': '{robot}을 다른 사람이 조종 중입니다.',
    'LEASE_REQUEST_COOLDOWN': '{robot} 조종권 요청을 잠시 뒤 다시 해 주세요.',
    'LEASE_FREE': '{robot}을 조종 중인 사람이 없습니다.',
    'LEASE_REQUEST_PENDING': '{robot} 조종권 요청이 이미 대기 중입니다.',
    'NOT_FOUND': '{robot}을 찾을 수 없어 요청을 거절했습니다.',
    'POLICY_STALE': '{robot} 조종 권한을 확인할 수 없어 요청을 거절했습니다.',
    'ROBOT_ARCHIVE_BUSY': '{robot} 사건 저장이 지연되어 요청을 거절했습니다.',
    'ROBOT_AUTH_PENDING': '{robot} 연결 권한을 확인 중입니다.',
    'ROBOT_OFFLINE': '{robot} 연결이 끊겨 요청을 거절했습니다.',
    'SERVER_BUSY': '{robot} 요청을 처리할 수 없습니다. 잠시 뒤 다시 시도하세요.',
    'SUBSCRIPTION_REQUIRED': '{robot}을 다시 선택한 뒤 조종해 주세요.',
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


def particle(word, consonant, vowel):
    last = word[-1:] or ' '
    # Numeric robot suffixes use their Korean reading (삼/칠/팔 have 받침).
    closed = last in '013678' or ('가' <= last <= '힣' and (ord(last) - ord('가')) % 28 != 0)
    return consonant if closed else vowel


def render(db, ev, *, agent=False, other_user_id=None):
    template = TEMPLATES.get(ev.code) if agent else TEMPLATES[ev.code]
    if template is None:
        template = TEMPLATES['AGENT_EVENT']
    data = ev.data or {}
    # Lookup is tenant-bound; names are frozen into the message at INSERT time.
    def name(model, identifier, default, column):
        if identifier is None:
            return default
        return db.scalar(select(column).where(model.org_id == ev.org_id, model.id == identifier)) or default
    robot = name(Robot, ev.robot_id, '로봇', Robot.name)
    person = name(User, ev.user_id, '운영자', User.display_name)
    other = name(User, other_user_id, '운영자', User.display_name)
    values = dict(robot=robot, person=person, other=other, code=ev.code,
        subject=particle(robot, '이', '가'), with_particle=particle(robot, '과', '와'),
        count=data.get('count', 1), status=data.get('last_status', '확인되지 않음'),
        scenario=data.get('scenario_name', '시나리오'), points=data.get('points', '확인되지 않음'),
        minutes=data.get('minutes', '확인되지 않음'), step=data.get('step', '확인되지 않음'),
        reason=data.get('reason', '확인되지 않음'), distance=data.get('distance_m', '확인되지 않음'),
        battery=data.get('soc', '확인되지 않음'), kind=data.get('kind', '결재'),
        decision='승인' if data.get('approved') is True else '반려' if data.get('approved') is False else '처리')
    ev.at = ev.at or now()
    ev.message = ev.at.astimezone(timezone.utc).strftime('%H:%M') + ' ' + template.format(**values)
    return ev

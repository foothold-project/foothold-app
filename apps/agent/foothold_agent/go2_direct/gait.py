"""걷기 모드 요청 하나 (계약 apps/contracts AgentGait · GaitResult · GaitState, PR #525).

길 (멈춰 있을 때만, 실기 0 회):
  순정 (FACTORY, START 표시 파일 없음)
    classic -> 순정 SDK ClassicWalk(True), sport -> ClassicWalk(False). 기존 동작 일감 (actions.py) 을 그대로 써서
    정지 · 서 있음 · 조종권 · STOP 취소 관문이 같다. SDK 접수가 끝 (SUCCEEDED · OK), 실제 걸음 바뀜 확인 아님.
    start -> GAIT_UNSUPPORTED: 실행기 앱 키표에 START+UP (정책 시작) 이 없다 (C++ 남은 일).
  START (LOWLEVEL, 실행기가 쥠)
    classic -> 실행기 키 START+RIGHT (ClassicWalk). 실행기가 멈춘 뒤 1 초를 다시 확인하고 앉아 순정 Classic 으로 넘긴다.
      보냄 RUNNING · RUNNER_SENT -> 실행기 STARTED 면 RUNNING · RUNNER_STARTED -> 표시 파일이 사라지면 SUCCEEDED · OK.
    start -> 정책 중이면 그대로 SUCCEEDED · OK.
    sport -> GAIT_UNSUPPORTED: 「감쇠 뒤 순정 기본 걸음으로 서기」 키가 실행기에 없다 (C++ 남은 일).
  ame2 -> GAIT_NOT_READY (student ONNX 받기 전).
"""

GAITS = ('classic', 'sport', 'start', 'ame2')
RUNNER_KEY = ('START+RIGHT', 'ClassicWalk')
DEADLINE_S = 20.   # 실행기 넘김 (앉기 2 초 · 모드 선택 · 다시 서기 · 걸음 선택) 상한
# 동작 일감 코드 -> 계약 GaitRejectCode. 나머지 SDK 실패는 GAIT_SDK_ERROR.
ACTION_CODES = {
    'SDK_ACCEPTED': 'OK', 'MOVING': 'GAIT_MOVING', 'STALE_STATE': 'GAIT_MOVING',
    'STANDING_REQUIRED': 'GAIT_NOT_STANDING', 'BUSY': 'GAIT_BUSY', 'DUPLICATE': 'GAIT_BUSY', 'START_ACTIVE': 'GAIT_BUSY',
    'NOT_AUTHORIZED': 'GAIT_LEASE_LOST', 'AUTHORITY_LOST': 'GAIT_LEASE_LOST', 'TIMEOUT': 'GAIT_TIMEOUT',
    'STOPPED': 'GAIT_CANCELLED', 'UNSUPPORTED': 'GAIT_UNSUPPORTED',
}
RUNNER_REASONS = {'not_stopped': 'GAIT_MOVING', 'remote': 'GAIT_BUSY', 'busy': 'GAIT_BUSY', 'phase': 'GAIT_NOT_STANDING'}


def valid(request_id, gait):
    return isinstance(request_id, str) and 1 <= len(request_id) <= 128 and gait in GAITS


class Gait:
    def __init__(self, sink):
        self.sink = sink
        self.result = None
        self.pending = None   # dict(request_id, gait, route='factory' | 'runner', deadline)

    def _report(self, request_id, gait, status, code, sdk_code=None):
        self.result = dict(request_id=request_id, gait=gait, status=status, code=code, sdk_code=sdk_code)

    def request(self, request_id, gait, lease, *, moving, latched):
        """한 요청. 참이면 순정 동작 일감이 잡혔다 (부르는 쪽이 Core 를 정지로 묶는다, 동작 요청과 같음).
        정지 잠김이면 어느 길이든 아무것도 시작하지 않는다 (SF-02: 넘김 키는 몸을 다시 세운다)."""
        from .sink import start_active
        s = self.sink
        with s._lock:
            if self.pending is not None:
                self.refresh()
            code = ('GAIT_LATCHED' if latched or s.latched else
                    'GAIT_NOT_READY' if gait == 'ame2' else
                    'GAIT_LEASE_LOST' if not s.posture_authorized(lease) else
                    'GAIT_BUSY' if self.pending is not None else
                    'GAIT_MOVING' if moving else None)
            if code is None and not start_active():
                if gait == 'start':
                    code = 'GAIT_UNSUPPORTED'
                else:
                    queued = s.actions.request(request_id, 'ClassicWalk', {'enabled': gait == 'classic'}, lease, False)
                    self.pending = dict(request_id=request_id, gait=gait, route='factory', deadline=None)
                    self.refresh()
                    return queued
            elif code is None:
                status = s.runner.status() if s.runner is not None else None
                if gait == 'start':
                    if status is not None and status['phase'] == 'policy':
                        self._report(request_id, gait, 'SUCCEEDED', 'OK')
                        return False
                    code = 'GAIT_UNSUPPORTED' if s.runner is None else 'GAIT_BUSY'
                elif gait == 'sport' or s.runner is None:
                    code = 'GAIT_UNSUPPORTED'
                elif s.actions.busy or s._posture is not None:
                    code = 'GAIT_BUSY'
                else:
                    try:
                        s.runner.key(*RUNNER_KEY, request_id)
                    except OSError:
                        self._report(request_id, gait, 'FAILED', 'GAIT_SDK_ERROR')
                        return False
                    self.pending = dict(request_id=request_id, gait=gait, route='runner', deadline=s.now()+DEADLINE_S)
                    self._own(self.pending, 'RUNNING', 'RUNNER_SENT')
                    return False
            self._report(request_id, gait, 'REJECTED', code)
            return False

    def runner_pending(self):
        return self.pending is not None and self.pending['route'] == 'runner'

    def cancel(self):
        """실행기 넘김을 끊었다 (앱 STOP · 조종권 회수). 실행기 쪽은 정지 묶음이 다시 서기를 지운다."""
        p = self.pending
        if p is not None and p['route'] == 'runner':
            self.pending = None
            self._report(p['request_id'], p['gait'], 'FAILED', 'GAIT_CANCELLED')

    def _own(self, p, status, code):
        # 결과 칸은 하나라 다른 요청의 거절이 덮을 수 있다: 이 요청의 진행은 pending 에 따로 둔다 (Codex pr550 M7).
        p['code'] = code
        self._report(p['request_id'], p['gait'], status, code)

    def runner_ack(self, ack):
        p = self.pending
        if p is None or p['route'] != 'runner' or ack.get('request_id') != p['request_id']:
            return
        if p.get('code') != 'RUNNER_SENT':
            return
        if ack['result'] == 'STARTED':
            self._own(p, 'RUNNING', 'RUNNER_STARTED')
        else:
            self.pending = None
            self._report(p['request_id'], p['gait'], 'REJECTED', RUNNER_REASONS.get(ack.get('reason'), 'GAIT_NOT_STANDING'))

    def refresh(self):
        """동작 일감 결과 · 실행기 넘김 끝을 걷기 결과로 옮긴다 (상태 보고마다)."""
        from .sink import start_active
        p = self.pending
        if p is None:
            return self.result
        if p['route'] == 'factory':
            r = self.sink.actions.result
            if r is not None and r['request_id'] == p['request_id']:
                if r['status'] == 'RUNNING':
                    self._report(p['request_id'], p['gait'], 'RUNNING', 'STARTED')
                else:
                    code = ACTION_CODES.get(r['code'], 'GAIT_SDK_ERROR')
                    status = 'SUCCEEDED' if code == 'OK' else r['status']
                    self._report(p['request_id'], p['gait'], status, code, r.get('sdk_code'))
                    self.pending = None
            elif not self.sink.actions.busy:
                # 일감 결과를 다른 요청이 덮었고 일감도 끝났다: 결과를 모르니 끝난 척하지 않는다.
                self.pending = None
                self._report(p['request_id'], p['gait'], 'FAILED', 'GAIT_CANCELLED')
        elif self.sink._operator_stop:
            self.cancel()
        elif not start_active() and p.get('code') == 'RUNNER_STARTED':
            self.pending = None
            self._report(p['request_id'], p['gait'], 'SUCCEEDED', 'OK')
        elif self.sink.now() >= p['deadline']:
            self.pending = None
            self._report(p['request_id'], p['gait'], 'FAILED', 'GAIT_TIMEOUT')
        return self.result

    def state(self):
        """지금 모드 · 고를 수 있는 모드. 순정 SDK 는 지금 걸음을 읽어 주지 않아 순정 중에는 모름 (None)."""
        from .sink import start_active
        s = self.sink
        if not start_active():
            return dict(gait=None, available=['classic', 'sport'])
        status = s.runner.status() if s.runner is not None else None
        return dict(gait='start' if status is not None and status['phase'] == 'policy' else None,
                    available=['classic', 'start'] if s.runner is not None else [])

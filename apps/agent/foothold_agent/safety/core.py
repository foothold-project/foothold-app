"""Safety Core ported from sim/v2_link.py; see PORTING.md.

No ROS, web, network, or process integration is imported here.
The caller must serialize access and publish the result of applied().
Default quantization and all safety gates retain the original behavior. Only
the simulation phone Hub explicitly supplies a continuous velocity projection.
"""

import math
import logging
import sys
import time
from collections import deque

SCHEMA = 'v2_live/state/1'
DEAD = 0.3            # 입력 끊김 → 0 (s)
STATE_STALE = 1.0     # 시뮬 상태가 이만큼 안 오면 «끊김»
RESUME_TIMEOUT = 3.0  # STOP 해제 요청 뒤 시뮬 확인을 기다리는 시간
RESET_TIMEOUT = 35.0  # 리셋 응답 대기(계약: 첫 새 state 뒤 응답, 30 s 이내)
Z = (0.0, 0.0, 0.0)


class _SafetyLog:
    """Diagnostic only: fixed labels, eight lines/key/second, no input values.

    stderr is captured in agent.log by the agent unit. Logging failures must
    never prevent a safety transition. stop_gen is unavailable in the ROS sink;
    its local generation is explicitly named separately.
    """

    def __init__(self, now):
        self.now = now
        self.windows = {}

    def emit(self, event, reason, source, *, stop_gen='unavailable', sink_generation='unavailable'):
        try:
            now = self.now()
            key = (event, reason, source)
            start, count, suppressed = self.windows.get(key, (now, 0, 0))
            if now - start >= 1:
                start, count = now, 0
            if count >= 8:
                self.windows[key] = (start, count, suppressed + 1)
                return
            self.windows[key] = (start, count + 1, 0)
            logging.getLogger('foothold_agent.safety').warning(
                'SAFETY event=%s reason=%s source=%s stop_gen=%s sink_generation=%s monotonic_s=%.6f suppressed=%s',
                event, reason, source, stop_gen, sink_generation, now, suppressed)
        except Exception:
            pass


def _log_source(depth=1):
    """Code location only; never inspect frame locals or format message data."""
    frame = sys._getframe(depth)
    return '%s.%s:%s' % (frame.f_globals.get('__name__', 'unknown'), frame.f_code.co_name, frame.f_lineno)


def finite(v):
    return type(v) in (int, float) and math.isfinite(v)    # bool·문자·None·NaN·Inf 는 아님


def valid_axes(m):
    """브라우저 입력 {fx, fy, fw}: 정확히 세 유한 숫자, -1..1. 아니면 None(→ 0). 임의 클램프 없음."""
    v = [m.get(k) for k in ('fx', 'fy', 'fw')]
    return tuple(float(x) for x in v) if all(finite(x) and -1 <= x <= 1 for x in v) else None


GATE = {'episode': int, 'stop_requested': bool, 'reset_in_progress': bool, 'policy_running': bool}
NUM = ('sim_t', 'x', 'y', 'z', 'yaw', 'vx', 'vy', 'wz', 'tilt_deg', 'rtf', 'cmd_age_s', 'ttl_s')
BOOL = ('fallen', 'body_still', 'resume_wait', 'ttl_expired', 'cmd_tested', 'fallback_active', 'online_ready', 'safe_fallback_verified')
STR = ('source', 'terrain_input', 'camera', 'plugin_mode')


def clean_state(d):
    """시뮬 state JSON → 정리본. 관문값(GATE)이 형식에 안 맞으면 None(받지 않은 것으로). 표시값은 형식이 틀리면 None(=미확인)."""
    if not isinstance(d, dict) or d.get('schema') != SCHEMA:
        return None
    if any(type(d.get(k)) is not t for k, t in GATE.items()):      # type() 비교 — bool 이 int 로 통과하지 않게
        return None
    out = {k: d[k] for k in GATE}
    out.update({k: float(d[k]) if finite(d.get(k)) else None for k in NUM})
    out.update({k: d[k] if type(d.get(k)) is bool else None for k in BOOL})
    out.update({k: d[k] if isinstance(d.get(k), str) else None for k in STR})
    ca = d.get('cmd_applied')
    out['cmd_applied'] = [float(x) for x in ca] if isinstance(ca, list) and len(ca) == 3 and all(map(finite, ca)) else None
    return out


def quantize(fx, fy, fw):
    """막대 입력(-1..1: 앞+, 왼쪽+, 왼회전+) → (명령, 이유). 시험한 값만 통과."""
    if abs(fx) < 0.2 and abs(fy) < 0.2 and abs(fw) < 0.2:
        return Z, ''
    if fx <= -0.2:
        return Z, '후진 미검증 — 보내지 않음'
    if abs(fy) >= 0.5:
        return Z, '옆걸음 미검증 — 보내지 않음'
    if fx < 0.5:
        if abs(fw) >= 0.5 and fx < 0.2:
            return Z, '제자리 회전 미검증 — 앞으로 밀면서 돌리세요'
        return Z, '저속 미검증 — 앞으로 끝까지 밀면 0.6 m/s'
    wz = 0.5 if fw >= 0.5 else -0.5 if fw <= -0.5 else 0.0
    return (0.6, 0.0, wz), ''


class Core:
    """조종권·래치·재개·리셋·시뮬 관문. ROS·웹과 무관해 --selftest 로 시험한다. 호출자가 lock 을 잡는다.
    비영 명령 조건: 신선한 형식 맞는 state · policy_running · 리셋 중 아님 · 조종권 · 래치 없음 · 재개/리셋 대기 없음
                    · 마지막 «무효화» 뒤 새 손 뗌(0) · 0.3 s 안의 입력."""

    def __init__(self, now=time.monotonic, *, velocity_projection=quantize):
        self.now = now
        self._safety_log = _SafetyLog(now)
        self.velocity_projection = velocity_projection
        self.controller = None      # 조종권을 가진 연결 id
        self.latch = False          # 앱 STOP 래치
        self.stop_gen = 0           # 잠금 세대(N1 10-15): 잠그는 모든 일(STOP — 이미 잠겼어도·조종권 해제·리셋·episode 변경·시뮬 STOP·시뮬 바쁨)마다 +1.
                                    # «조종 시작» 확인 때 본 값과 resume 의 stop_gen 이 다르면 거부 — 확인 뒤 끼어든 STOP 을 풀지 않는다(CAS)
        self.need_neutral = True    # 손 뗌(0) 한 번을 받아야 움직임
        self.intent = Z; self.intent_t = -1e9
        self.reason = ''; self.out = Z   # out = 마지막으로 발행한 명령
        self.events = deque(maxlen=30)
        self.sink = None            # 사건 영구 기록(파일) — 실패해도 조종은 계속
        self.st = None; self.state_t = None; self.state_seq = 0; self.episode = None
        self.resume_pending = None  # (요청 시각, 그때 state_seq) — 시뮬이 stop_requested=false 를 보낼 때까지 0
        self.reset_pending = None   # 요청 시각
        self.ep_change_t = None     # 마지막 episode 변경 시각
        self.sim_was_ok = False; self.bad_input = False; self.bad_state = False
        self.sim_busy = ''          # Gazebo 끄기·지도 체험 시작 처리 중(이유 글): take·resume·reset 거부, cmd 폐기(서버 정본). 끝나도 잠금은 그대로(자동 복원 없음)

    def ev(self, level, text):
        e = {'t': time.strftime('%H:%M:%S'), 'st': level, 'text': text}
        self.events.appendleft(e)
        print(f"[ev] {e['t']} {level} {text}", flush=True)   # 10-14: 요청·거부·결과를 로그 파일에도 1줄씩(화면 링 6개만으론 거부 원물이 사라짐)
        if self.sink:
            try:
                self.sink(e)
            except Exception:
                pass

    def _lock(self):
        """잠금 + 재개 취소 + 입력 폐기 + 잠금 세대 +1(이미 잠겼어도)"""
        self.latch = True; self.resume_pending = None; self._void(); self.stop_gen += 1
        self._safety_log.emit('lock', 'lock_transition', _log_source(2), stop_gen=self.stop_gen)

    def _void(self):
        """지금까지의 입력을 버린다. 다음 비영은 이 뒤에 새로 받은 손 뗌(0) 다음에만."""
        self.intent = Z; self.intent_t = -1e9; self.need_neutral = True

    def sim_block(self):
        if self.sim_busy:
            return self.sim_busy
        if self.st is None:
            return '시뮬 상태 미수신'
        if self.now() - self.state_t > STATE_STALE:
            return '시뮬 상태 끊김'
        if self.st['reset_in_progress']:
            return '시뮬 리셋 중'
        if not self.st['policy_running']:
            return '정책 미실행'
        return ''

    def on_state(self, raw):
        d = clean_state(raw)
        if d is None:
            if not self.bad_state:
                self.ev('warn', '시뮬 상태 형식 오류 — 무시(받지 않은 것으로)')
            self.bad_state = True; return False
        self.bad_state = False
        prev = self.st; self.st = d; self.state_t = self.now(); self.state_seq += 1
        if d['fallen'] and not (prev or {}).get('fallen'):
            self.ev('bad', '넘어짐 (시뮬 판정)')
        if self.episode is not None and d['episode'] != self.episode:
            self.ep_change_t = self.now()               # 사진: 바뀐 직후 도착한 프레임은 옛 episode 렌더일 수 있음
            self._lock()
            self.ev('warn', f'새 에피소드 {d["episode"]} · STOP 유지')
        self.episode = d['episode']
        if self.resume_pending and self.state_seq > self.resume_pending[1] and not d['stop_requested']:
            self.resume_pending = None; self.latch = False; self._void()
            self._safety_log.emit('resume', 'sim_confirmed', _log_source(), stop_gen=self.stop_gen)
            self.ev('ok', 'STOP 해제 확인(시뮬) · 새 입력 전까지 0')
        elif d['stop_requested'] and not self.latch:      # 시뮬이 STOP 상태(리셋 뒤 등)면 앱도 잠근다
            self._lock(); self.ev('warn', '시뮬이 STOP 상태 · «STOP 해제» 필요')
            self._safety_log.emit('relock', 'sim_stop_requested', _log_source(), stop_gen=self.stop_gen)
        return True

    def take(self, cid, who='이 기기'):
        if self.sim_busy:
            self.ev('warn', f'조종권 거부 · {self.sim_busy} ({who})'); return False
        if self.controller not in (None, cid):
            return False
        if self.controller != cid:
            self.controller = cid; self._void(); self.ev('ok', f'조종권 얻음 · {who}')
        return True

    def drop(self, cid, why):
        """조종권을 잃으면(반납·끊김·숨김·로그아웃) 0 + STOP 잠금 — 다음 조종자는 «STOP 해제»부터(정지 뒤 재움직임 원인 미확인이라 보수적으로)"""
        if self.controller == cid:
            self.controller = None; self._lock()
            self.ev('warn', f'조종권 해제 · {why} → 명령 0 · STOP 잠금')

    def cmd(self, cid, axes):
        """axes = valid_axes() 결과. None(형식 오류)이면 그 요청은 0 + 무효화."""
        if cid != self.controller:
            return
        if axes is None:
            if not self.bad_input:
                self.ev('warn', '형식 오류 입력 → 명령 0')
            self.bad_input = True; self._void(); return
        self.bad_input = False
        if self.latch or self.reset_pending or self.resume_pending or self.sim_block():
            self._void(); return                 # 잠금·대기·끊김 중 입력은 버린다 — 풀린 뒤 새 손 뗌부터
        self.intent = axes; self.intent_t = self.now()
        if self.velocity_projection(*axes) == (Z, ''):
            self.need_neutral = False

    def stop(self, who):
        if not self.latch:
            self.ev('bad', f'STOP 요청 · 명령 0 잠금 ({who})')
        elif self.resume_pending:
            self.ev('bad', f'STOP ({who}) · 재개 요청 취소')
        self._lock()   # 이미 잠겼어도 세대 +1 — 확인창 동안 누른 남의 STOP 을 resume 이 풀지 못하게
        # Fixed labels only: who can contain a caller-supplied reason or identity.
        reason = who if isinstance(who, str) and who in {'startup', 'connection/reconnection', 'link grace expired',
            'output stalled', 'wire generation exhausted', 'protocol mismatch',
            'history storage blocked', 'history storage unavailable', 'outgoing queue full',
            'server authorization rejected', 'client shutdown', 'invalid lease', 'server STOP'} else 'other_stop'
        self._safety_log.emit('stop', reason, _log_source(2), stop_gen=self.stop_gen)

    def resume(self, cid, gen=None):
        """조종권 · 앱 래치 · 시뮬이 STOP 을 확인한 상태에서만. 성공해도 시뮬 해제 확인 전까지 0.
        gen(«조종 시작» 확인 때 본 stop_gen)이 오면 지금 세대와 같을 때만 — 다르면 거부(재시도 0, 사람 재확인). None = 옛 클라이언트(따로 누르는 «STOP 해제», 그 순간의 사람 행동)"""
        why = ('조종권 없음' if cid != self.controller else '잠금 아님' if not self.latch
               else '잠금 세대 다름 — 확인 뒤 새 STOP·잠금(다시 «조종 시작»)' if gen is not None and gen != self.stop_gen
               else '리셋 처리 중' if self.reset_pending else '재개 확인 대기 중' if self.resume_pending
               else self.sim_block() or ('' if self.st['stop_requested'] else '시뮬 STOP 확인 전 — 잠시 뒤'))
        if why:
            diagnostic_reason = {
                '조종권 없음': 'no_controller', '잠금 아님': 'not_latched',
                '잠금 세대 다름 — 확인 뒤 새 STOP·잠금(다시 «조종 시작»)': 'generation_mismatch',
                '리셋 처리 중': 'reset_pending', '재개 확인 대기 중': 'resume_pending',
                '시뮬 STOP 확인 전 — 잠시 뒤': 'sim_stop_unconfirmed',
                '시뮬 상태 미수신': 'sim_unseen', '시뮬 상태 끊김': 'sim_stale',
                '시뮬 리셋 중': 'sim_resetting', '정책 미실행': 'policy_not_running',
            }.get(why, 'sim_busy')
            self._safety_log.emit('resume_rejected', diagnostic_reason, _log_source(), stop_gen=self.stop_gen)
            self.ev('warn', f'STOP 해제 거부 · {why}'); return False
        self.resume_pending = (self.now(), self.state_seq); self._void()
        self._safety_log.emit('resume', 'requested', _log_source(), stop_gen=self.stop_gen)
        self.ev('ok', 'STOP 해제 요청 · 시뮬 확인 대기(0 유지)')
        return True

    def reset_begin(self, cid, ready):
        why = self.sim_busy or ('조종권 없음' if cid != self.controller else '리셋 처리 중' if self.reset_pending else '' if ready else '리셋 서비스 미연결')
        if why:
            self.ev('warn', f'시뮬 리셋 거부 · {why}'); return False
        self.reset_pending = self.now(); self._lock()
        self.ev('warn', '시뮬 리셋 요청 · STOP 잠금')
        return True

    def reset_done(self, ok, msg):
        if self.reset_pending is None:
            return                                   # 시간 초과로 이미 닫힘
        self.reset_pending = None; self._lock()
        self.ev('ok' if ok else 'bad', f'리셋 {"응답" if ok else "실패"}: {msg} · STOP 유지')

    def busy_sim(self, why):
        """지도 체험 시작 접수: 조종권 해제(누구든) · 0 · STOP 잠금 · 입력 폐기, 끝날 때까지 take·resume·reset·비영 거부(sim_busy). 끝나도 잠금 유지"""
        if self.controller:
            self.drop(self.controller, why)
        self._lock(); self.sim_busy = why

    def want_stop_pub(self):
        """앱이 잠겼는데 시뮬이 아직 STOP 이 아니면 STOP 을 다시 보낸다(재개 대기 중은 제외)."""
        return self.latch and not self.resume_pending and not (self.st and self.st['stop_requested'])

    def applied(self):
        """지금 보낼 명령. 20 Hz 로 부른다."""
        now = self.now()
        if self.reset_pending is not None and now - self.reset_pending > RESET_TIMEOUT:
            self.reset_pending = None; self.ev('bad', f'리셋 응답 없음 {RESET_TIMEOUT:.0f} s · STOP 유지')
        if self.resume_pending and now - self.resume_pending[0] > RESUME_TIMEOUT:
            self.resume_pending = None; self.ev('warn', 'STOP 해제 확인 없음 · 잠금 유지(다시 누르세요)')
            self._safety_log.emit('resume', 'confirmation_timeout', _log_source(), stop_gen=self.stop_gen)
        block = self.sim_block()
        if block:
            if self.sim_was_ok:
                self.ev('warn', f'{block} → 명령 0 · 입력 버림')
            if self.resume_pending:
                self.resume_pending = None; self.ev('warn', '재개 요청 취소 · 시뮬 상태 이상')
                self._safety_log.emit('resume', 'sim_block_cancelled', _log_source(), stop_gen=self.stop_gen)
            self.sim_was_ok = False; self._void(); self.reason = block; return Z
        self.sim_was_ok = True
        if self.controller is None:
            self.reason = '조종권 없음'; return Z
        if self.reset_pending:
            self.reason = '시뮬 리셋 처리 중'; return Z
        if self.resume_pending:
            self.reason = 'STOP 해제 확인 대기'; return Z
        if self.latch:
            self.reason = 'STOP 요청 · 명령 잠금'; return Z
        if now - self.intent_t > DEAD:
            if self.intent != Z:
                self.ev('warn', '입력 끊김 0.3 s → 명령 0')
            self._void(); self.reason = ''; return Z
        c, why = self.velocity_projection(*self.intent)
        if self.need_neutral and c != Z:
            self.reason = '손을 한 번 뗀 뒤 다시 누르세요'; return Z
        self.reason = why
        return c

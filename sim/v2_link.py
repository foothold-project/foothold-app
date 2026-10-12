#!/usr/bin/env python3
"""v2 시뮬 연결 서버 — 새 UI(web/)를 foothold-v2 Gazebo 시험에 잇는다. 로컬 PC 전용(127.0.0.1).

계약(RL root 채택, 10-12): ROS_DOMAIN_ID=61 · ROS_AUTOMATIC_DISCOVERY_RANGE=LOCALHOST
  앱 → 시뮬  /v2_live/cmd_vel  geometry_msgs/Twist 20 Hz (기록자는 이 서버 하나)
             /v2_live/stop · /v2_live/resume  std_msgs/Empty
             /v2_live/reset  std_srvs/Trigger
  시뮬 → 앱  /v2_live/state  std_msgs/String(JSON, schema v2_live/state/1) · /v2_live/camera/compressed  sensor_msgs/CompressedImage
  QoS 는 모두 reliable · volatile (카메라 depth 1, 나머지 10). 정본: control-app/experiments/33-foothold-v2-gazebo-20261012/online-20261012/CONTRACT-v2_live.md
Gazebo·정책·ingress 기동은 RL 소유. 이 서버는 Gazebo 를 띄우지 않는다.

안전 판단의 정본은 이 서버다(브라우저는 믿지 않는다):
  - 조종권은 한 연결만. 그 연결이 끊기면 0 · 조종권 해제
  - 보내는 명령은 시험한 네 가지뿐: 0, (0.6, 0, 0), (0.6, 0, ±0.5). 그 밖 입력은 0 + 이유
  - 손 뗌·입력 0.3 s 끊김 → 0. STOP(누구나) → 0 래치, RESUME(조종권만) 뒤에도 새 입력 전까지 0
  - 조종권을 새로 얻거나 RESUME·끊김 뒤에는 한 번 «손 뗌(0)»을 받아야 다시 움직인다(자동 복원 없음)
실행: source /opt/ros/jazzy/setup.bash; ROS_DOMAIN_ID=61 ROS_AUTOMATIC_DISCOVERY_RANGE=LOCALHOST python3 sim/v2_link.py
자체검사(ROS 없이): python3 sim/v2_link.py --selftest
"""
import argparse, json, math, os, sys, threading, time
from collections import deque

PRESETS_NOTE = '시험한 명령: 0 · 앞 0.6 · 앞 0.6 + 회전 ±0.5'
SCHEMA = 'v2_live/state/1'
DEAD = 0.3            # 입력 끊김 → 0 (s)
STATE_STALE = 1.0     # 시뮬 상태가 이만큼 안 오면 «끊김»
RESUME_TIMEOUT = 3.0  # STOP 해제 요청 뒤 시뮬 확인을 기다리는 시간
RESET_TIMEOUT = 35.0  # 리셋 응답 대기(계약: 첫 새 state 뒤 응답, 30 s 이내)
Z = (0.0, 0.0, 0.0)


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

    def __init__(self, now=time.monotonic):
        self.now = now
        self.controller = None      # 조종권을 가진 연결 id
        self.latch = False          # 앱 STOP 래치
        self.need_neutral = True    # 손 뗌(0) 한 번을 받아야 움직임
        self.intent = Z; self.intent_t = -1e9
        self.reason = ''; self.out = Z   # out = 마지막으로 발행한 명령
        self.events = deque(maxlen=30)
        self.st = None; self.state_t = None; self.state_seq = 0; self.episode = None
        self.resume_pending = None  # (요청 시각, 그때 state_seq) — 시뮬이 stop_requested=false 를 보낼 때까지 0
        self.reset_pending = None   # 요청 시각
        self.sim_was_ok = False; self.bad_input = False; self.bad_state = False

    def ev(self, level, text):
        self.events.appendleft({'t': time.strftime('%H:%M:%S'), 'st': level, 'text': text})

    def _void(self):
        """지금까지의 입력을 버린다. 다음 비영은 이 뒤에 새로 받은 손 뗌(0) 다음에만."""
        self.intent = Z; self.intent_t = -1e9; self.need_neutral = True

    def sim_block(self):
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
            self.latch = True; self.resume_pending = None; self._void()
            self.ev('warn', f'새 에피소드 {d["episode"]} · STOP 유지')
        self.episode = d['episode']
        if self.resume_pending and self.state_seq > self.resume_pending[1] and not d['stop_requested']:
            self.resume_pending = None; self.latch = False; self._void()
            self.ev('ok', 'STOP 해제 확인(시뮬) · 새 입력 전까지 0')
        elif d['stop_requested'] and not self.latch:      # 시뮬이 STOP 상태(리셋 뒤 등)면 앱도 잠근다
            self.latch = True; self._void(); self.ev('warn', '시뮬이 STOP 상태 · «STOP 해제» 필요')
        return True

    def take(self, cid):
        if self.controller not in (None, cid):
            return False
        if self.controller != cid:
            self.controller = cid; self._void(); self.ev('ok', '조종권 얻음 · 이 기기')
        return True

    def drop(self, cid, why):
        if self.controller == cid:
            self.controller = None; self._void(); self.ev('warn', f'조종권 해제 · {why} → 명령 0')

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
        if quantize(*axes) == (Z, ''):
            self.need_neutral = False

    def stop(self, who):
        if not self.latch:
            self.ev('bad', f'STOP 요청 · 명령 0 잠금 ({who})')
        elif self.resume_pending:
            self.ev('bad', f'STOP ({who}) · 재개 요청 취소')
        self.latch = True; self.resume_pending = None; self._void()

    def resume(self, cid):
        """조종권 · 앱 래치 · 시뮬이 STOP 을 확인한 상태에서만. 성공해도 시뮬 해제 확인 전까지 0."""
        why = ('조종권 없음' if cid != self.controller else '잠금 아님' if not self.latch
               else '리셋 처리 중' if self.reset_pending else '재개 확인 대기 중' if self.resume_pending
               else self.sim_block() or ('' if self.st['stop_requested'] else '시뮬 STOP 확인 전 — 잠시 뒤'))
        if why:
            self.ev('warn', f'STOP 해제 거부 · {why}'); return False
        self.resume_pending = (self.now(), self.state_seq); self._void()
        self.ev('ok', 'STOP 해제 요청 · 시뮬 확인 대기(0 유지)')
        return True

    def reset_begin(self, cid, ready):
        why = '조종권 없음' if cid != self.controller else '리셋 처리 중' if self.reset_pending else '' if ready else '리셋 서비스 미연결'
        if why:
            self.ev('warn', f'시뮬 리셋 거부 · {why}'); return False
        self.reset_pending = self.now(); self.latch = True; self.resume_pending = None; self._void()
        self.ev('warn', '시뮬 리셋 요청 · STOP 잠금')
        return True

    def reset_done(self, ok, msg):
        if self.reset_pending is None:
            return                                   # 시간 초과로 이미 닫힘
        self.reset_pending = None; self.latch = True; self._void()
        self.ev('ok' if ok else 'bad', f'리셋 {"응답" if ok else "실패"}: {msg} · STOP 유지')

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
        block = self.sim_block()
        if block:
            if self.sim_was_ok:
                self.ev('warn', f'{block} → 명령 0 · 입력 버림')
            if self.resume_pending:
                self.resume_pending = None; self.ev('warn', '재개 요청 취소 · 시뮬 상태 이상')
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
        c, why = quantize(*self.intent)
        if self.need_neutral and c != Z:
            self.reason = '손을 한 번 뗀 뒤 다시 누르세요'; return Z
        self.reason = why
        return c


def selftest():
    t = [0.0]; c = Core(now=lambda: t[0]); F = (1.0, 0.0, 0.0); N = Z

    def st(stop=False, ep=0, pol=True, rip=False, **kw):
        d = {'schema': SCHEMA, 'episode': ep, 'stop_requested': stop, 'reset_in_progress': rip, 'policy_running': pol, 'x': 0.0, 'fallen': False}
        d.update(kw); return c.on_state(d)

    def go(*seq):                                   # 입력 차례로 보낸 뒤 명령
        for a in seq:
            c.cmd('a', a)
        return c.applied()

    assert quantize(1, 0, 0)[0] == (0.6, 0, 0) and quantize(1, 0, 1)[0] == (0.6, 0, 0.5) and quantize(1, 0, -1)[0] == (0.6, 0, -0.5)
    for q in [(-1, 0, 0), (0, 1, 0), (0.3, 0, 0), (0, 0, 1)]:
        assert quantize(*q)[0] == Z and quantize(*q)[1], q
    # 4) 입력 형식: NaN/Inf/bool/문자/범위밖/누락 → None
    for m in [{'fx': float('nan'), 'fy': 0, 'fw': 0}, {'fx': float('inf'), 'fy': 0, 'fw': 0}, {'fx': True, 'fy': 0, 'fw': 0},
              {'fx': '1', 'fy': 0, 'fw': 0}, {'fx': 1.5, 'fy': 0, 'fw': 0}, {'fx': 1, 'fy': 0}, {'fx': None, 'fy': 0, 'fw': 0}]:
        assert valid_axes(m) is None, m
    assert valid_axes({'fx': 1, 'fy': 0, 'fw': -1}) == (1.0, 0.0, -1.0)
    # 5) state 형식: 목록/None/틀린 schema/관문값 누락·bool episode → 무시, 표시값 NaN → None
    for bad in [[], None, 'x', {'schema': 'other'}, {'schema': SCHEMA, 'episode': 0, 'stop_requested': False, 'reset_in_progress': False},
                {'schema': SCHEMA, 'episode': True, 'stop_requested': False, 'reset_in_progress': False, 'policy_running': True}]:
        assert clean_state(bad) is None and not c.on_state(bad), bad
    assert clean_state({'schema': SCHEMA, 'episode': 0, 'stop_requested': False, 'reset_in_progress': False, 'policy_running': True,
                        'x': float('nan'), 'fallen': 'yes'}) == {**clean_state({'schema': SCHEMA, 'episode': 0, 'stop_requested': False,
                        'reset_in_progress': False, 'policy_running': True}), 'x': None, 'fallen': None}
    # 1) 초기 state 없음 → 조종권·손 뗌·입력이 있어도 0, 그 입력은 state 가 와도 되살지 않음
    assert c.take('a') and not c.take('b')
    assert go(N, F) == Z and c.reason == '시뮬 상태 미수신'
    st(); assert go(F) == Z and c.reason == '손을 한 번 뗀 뒤 다시 누르세요'
    assert go(N, F) == (0.6, 0, 0)
    c.cmd('b', F); assert c.applied() == (0.6, 0, 0)                  # 남의 입력은 무시(출력 변화 없음)
    c.cmd('a', (1, 0, 1)); assert c.applied() == (0.6, 0, 0.5)
    t[0] += 0.31; st(); assert c.applied() == Z                       # 입력 0.3 s 끊김 → 0
    assert go(F) == Z and go(N, F) == (0.6, 0, 0)                     # 자동 복원 없음
    # 1) state 끊김 → 0 + 입력 버림, 복구만으로는 안 움직임
    t[0] += 1.01; assert go(F) == Z and c.reason == '시뮬 상태 끊김'
    st(); assert go(F) == Z and go(N, F) == (0.6, 0, 0)
    st(pol=False); assert go(N, F) == Z and c.reason == '정책 미실행'
    st(); assert go(N, F) == (0.6, 0, 0)
    # 4) 형식 오류 입력은 그 요청 0 + 무효화
    c.cmd('a', None); assert c.applied() == Z and go(F) == Z and go(N, F) == (0.6, 0, 0)
    # 동시 cmd + STOP → 0 래치
    c.cmd('a', F); c.stop('b'); assert go(F) == Z
    # 2) 시뮬이 STOP 확인 전 재개 거부 → 확인 뒤 재개, 옛 stop_requested=true 표본이 와도 대기 유지, false 확인 뒤 새 0·새 비영
    st(stop=False); assert c.want_stop_pub() and not c.resume('a')
    st(stop=True); assert not c.want_stop_pub() and not c.resume('b') and c.resume('a')
    assert not c.want_stop_pub() and go(N, F) == Z
    st(stop=True); assert c.latch and c.resume_pending and go(N, F) == Z        # 옛 표본 — 다시 래치되지 않고 대기
    st(stop=False); assert not c.latch and go(F) == Z and go(N, F) == (0.6, 0, 0)
    # 2) 재개 대기 중 새 STOP·끊김·새 에피소드·무응답 → 닫힘 유지
    c.stop('a'); st(stop=True); assert c.resume('a'); c.stop('a'); st(stop=False); assert c.latch and go(N, F) == Z
    st(stop=True); assert c.resume('a'); t[0] += 1.01; assert c.applied() == Z and not c.resume_pending
    st(stop=True); assert c.resume('a'); st(stop=False, ep=1); assert c.latch and not c.resume_pending
    st(stop=True, ep=1); assert c.resume('a'); t[0] += 3.01; st(stop=True, ep=1); c.applied(); assert c.latch and not c.resume_pending
    # 3) 리셋: 즉시 잠금·입력 폐기, 대기 중 비영·재개·중복 리셋 거부, 응답·새 에피소드 뒤에도 STOP 유지
    st(stop=True, ep=1); assert c.resume('a'); st(stop=False, ep=1); assert go(N, F) == (0.6, 0, 0)
    assert not c.reset_begin('b', True) and not c.reset_begin('a', False) and c.reset_begin('a', True)
    assert c.latch and go(N, F) == Z and not c.reset_begin('a', True) and not c.resume('a')
    st(stop=True, ep=2, rip=True); assert go(N, F) == Z and c.reason == '시뮬 리셋 중'
    st(stop=True, ep=2); c.reset_done(True, 'ok'); assert c.latch and not c.reset_pending and go(N, F) == Z
    assert c.resume('a'); st(stop=False, ep=2); assert go(N, F) == (0.6, 0, 0)
    assert c.reset_begin('a', True); t[0] += 35.1; st(stop=True, ep=3); c.applied(); assert not c.reset_pending and c.latch
    c.reset_done(True, 'late'); assert c.latch                         # 시간 초과 뒤 늦은 응답은 무시
    # 조종권 해제·새 조종권
    c.drop('a', '연결 끊김'); assert c.controller is None and c.applied() == Z
    assert c.take('b'); c.cmd('b', F); assert c.applied() == Z         # 새 조종권도 손 뗌 먼저(+래치)
    print('selftest OK')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=8790)
    ap.add_argument('--web', default=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'web'))
    ap.add_argument('--selftest', action='store_true')
    a = ap.parse_args()
    if a.selftest:
        return selftest()

    import rclpy
    from rclpy.node import Node
    from rclpy.qos import QoSProfile, ReliabilityPolicy, HistoryPolicy
    from geometry_msgs.msg import Twist
    from std_msgs.msg import Empty, String
    from sensor_msgs.msg import CompressedImage
    from std_srvs.srv import Trigger
    import tornado.ioloop, tornado.web, tornado.websocket

    core = Core(); lock = threading.Lock()
    sim = {'jpeg': None, 'jpeg_t': None, 'jpeg_n': 0}
    clients = {}
    allowed_origins = {f'http://127.0.0.1:{a.port}', f'http://localhost:{a.port}'}

    rclpy.init(); node = Node('fh_app_v2_link')
    rel = QoSProfile(depth=10, reliability=ReliabilityPolicy.RELIABLE, history=HistoryPolicy.KEEP_LAST)
    pub_cmd = node.create_publisher(Twist, '/v2_live/cmd_vel', rel)
    pub_stop = node.create_publisher(Empty, '/v2_live/stop', rel)
    pub_resume = node.create_publisher(Empty, '/v2_live/resume', rel)
    cli_reset = node.create_client(Trigger, '/v2_live/reset')

    def on_state(m):                # ROS 콜백의 예외는 spin 스레드를 죽인다 — 형식 문제는 «받지 않음»으로만
        try:
            d = json.loads(m.data)
        except Exception:
            d = None
        with lock:
            core.on_state(d)

    def reset_done(f):              # ROS 스레드에서 불림
        try:
            r = f.result(); ok, msg = bool(r and r.success), (str(r.message)[:80] if r else '응답 없음')
        except Exception as e:
            ok, msg = False, f'예외 {type(e).__name__}'
        with lock:
            core.reset_done(ok, msg)

    def on_cam(m):
        with lock:
            sim['jpeg'] = bytes(m.data); sim['jpeg_t'] = time.monotonic(); sim['jpeg_n'] += 1

    node.create_subscription(String, '/v2_live/state', on_state, rel)
    node.create_subscription(CompressedImage, '/v2_live/camera/compressed', on_cam, QoSProfile(depth=1, reliability=ReliabilityPolicy.RELIABLE, history=HistoryPolicy.KEEP_LAST))
    threading.Thread(target=rclpy.spin, args=(node,), daemon=True).start()

    last_stop_pub = [0.0]

    def tick():                     # 20 Hz: 명령 발행 + STOP 재전송(시뮬이 래치를 확인할 때까지)
        with lock:
            vx, vy, wz = core.out = core.applied(); want_stop = core.want_stop_pub()
        t = Twist(); t.linear.x, t.linear.y, t.angular.z = vx, vy, wz; pub_cmd.publish(t)
        if want_stop and time.monotonic() - last_stop_pub[0] > 0.5:
            pub_stop.publish(Empty()); last_stop_pub[0] = time.monotonic()

    def snapshot(cid):
        now = time.monotonic()
        with lock:
            age = None if core.state_t is None else round(now - core.state_t, 2)
            cam_age = None if sim['jpeg_t'] is None else round(now - sim['jpeg_t'], 2)
            role = 'control' if core.controller == cid else ('view_other' if core.controller else 'view')
            # 서버 출력(applied)·이유는 누구나 같은 값을 읽는다. role 은 송신 허용에만 쓴다
            return {'op': 'status', 'role': role, 'latch': core.latch, 'applied': list(core.out), 'reason': core.reason,
                    'sim_block': core.sim_block(), 'resume_pending': bool(core.resume_pending), 'reset_pending': core.reset_pending is not None,
                    'episode': core.episode, 'ros_domain': os.environ.get('ROS_DOMAIN_ID'), 'state_age': age, 'cam_age': cam_age, 'sim': core.st, 'events': list(core.events)[:6], 'note': PRESETS_NOTE}

    class WS(tornado.websocket.WebSocketHandler):
        def check_origin(self, origin):
            return origin in allowed_origins          # 다른 웹페이지가 이 포트로 조종하지 못하게

        def open(self):
            self.cid = f'c{id(self)}'; self.cam_n = -1; clients[self.cid] = self

        def on_message(self, raw):
            try:
                m = json.loads(raw)
            except Exception:
                return
            if not isinstance(m, dict):
                return
            op = m.get('op')
            with lock:
                if op == 'take':
                    core.take(self.cid)
                elif op == 'release':
                    core.drop(self.cid, '화면에서 놓음')
                elif op == 'cmd':
                    core.cmd(self.cid, valid_axes(m))
                elif op == 'stop':
                    core.stop('이 기기' if core.controller == self.cid else '보기 전용 기기')
                elif op == 'resume':
                    if core.resume(self.cid):
                        pub_resume.publish(Empty())
                elif op == 'reset':
                    if core.reset_begin(self.cid, cli_reset.service_is_ready()):   # 잠금·입력 폐기를 요청 전에 확정
                        pub_stop.publish(Empty())
                        cli_reset.call_async(Trigger.Request()).add_done_callback(reset_done)
                elif op == 'hidden':
                    core.drop(self.cid, '화면 숨김')

        def on_close(self):
            clients.pop(self.cid, None)
            with lock:
                core.drop(self.cid, '연결 끊김')

    def push():                     # 10 Hz: 상태 + 새 영상
        for c in list(clients.values()):
            s = snapshot(c.cid)
            with lock:
                jpeg, n = sim['jpeg'], sim['jpeg_n']
            try:
                c.write_message(json.dumps(s, ensure_ascii=False))
                if jpeg and n != c.cam_n:
                    c.cam_n = n; c.write_message(jpeg, binary=True)
            except tornado.websocket.WebSocketClosedError:
                pass

    class NoCache(tornado.web.StaticFileHandler):
        def set_extra_headers(self, path):
            self.set_header('Cache-Control', 'no-store')

    app = tornado.web.Application([(r'/ws', WS), (r'/(.*)', NoCache, {'path': a.web, 'default_filename': 'index.html'})])
    app.listen(a.port, address='127.0.0.1')
    tornado.ioloop.PeriodicCallback(tick, 50).start()
    tornado.ioloop.PeriodicCallback(push, 100).start()
    print(f'v2_link http://127.0.0.1:{a.port}/MDrive.dc.html?live=v2  domain={os.environ.get("ROS_DOMAIN_ID", "0")}', flush=True)
    try:
        tornado.ioloop.IOLoop.current().start()
    except KeyboardInterrupt:
        pass
    finally:
        t = Twist(); pub_cmd.publish(t)            # 끝낼 때 0 한 번
        node.destroy_node(); rclpy.try_shutdown()


if __name__ == '__main__':
    sys.exit(main())

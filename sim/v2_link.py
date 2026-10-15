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
자체검사(ROS 없이): python3 sim/v2_link.py --selftest   (선택: V2_LINK_MAPS_ROOT=<RL maps root> 면 실제 지도 전부 검사 통과 확인)
"""
import argparse, base64, hashlib, json, math, os, re, sqlite3, struct, subprocess, sys, threading, time, zlib
from collections import deque
from pathlib import Path

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
            self.ev('ok', 'STOP 해제 확인(시뮬) · 새 입력 전까지 0')
        elif d['stop_requested'] and not self.latch:      # 시뮬이 STOP 상태(리셋 뒤 등)면 앱도 잠근다
            self._lock(); self.ev('warn', '시뮬이 STOP 상태 · «STOP 해제» 필요')
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
        if quantize(*axes) == (Z, ''):
            self.need_neutral = False

    def stop(self, who):
        if not self.latch:
            self.ev('bad', f'STOP 요청 · 명령 0 잠금 ({who})')
        elif self.resume_pending:
            self.ev('bad', f'STOP ({who}) · 재개 요청 취소')
        self._lock()   # 이미 잠겼어도 세대 +1 — 확인창 동안 누른 남의 STOP 을 resume 이 풀지 못하게

    def resume(self, cid, gen=None):
        """조종권 · 앱 래치 · 시뮬이 STOP 을 확인한 상태에서만. 성공해도 시뮬 해제 확인 전까지 0.
        gen(«조종 시작» 확인 때 본 stop_gen)이 오면 지금 세대와 같을 때만 — 다르면 거부(재시도 0, 사람 재확인). None = 옛 클라이언트(따로 누르는 «STOP 해제», 그 순간의 사람 행동)"""
        why = ('조종권 없음' if cid != self.controller else '잠금 아님' if not self.latch
               else '잠금 세대 다름 — 확인 뒤 새 STOP·잠금(다시 «조종 시작»)' if gen is not None and gen != self.stop_gen
               else '리셋 처리 중' if self.reset_pending else '재개 확인 대기 중' if self.resume_pending
               else self.sim_block() or ('' if self.st['stop_requested'] else '시뮬 STOP 확인 전 — 잠시 뒤'))
        if why:
            self.ev('warn', f'STOP 해제 거부 · {why}'); return False
        self.resume_pending = (self.now(), self.state_seq); self._void()
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


class Media:
    """서버 보관 기록: 사진(서버가 받은 최신 프레임 그대로 — 업로드 없음)·사건. 파일 이름·경로는 서버가 만든다.
    runs/app-media/photos/<날짜>/<시각>-ep<에피소드>-<번호>.jpg + photos.jsonl(사진 정보) + events.jsonl(사건)"""

    def __init__(self, root):
        self.root = Path(root); (self.root / 'photos').mkdir(parents=True, exist_ok=True); self.n = 0

    def _append(self, name, d):
        with open(self.root / name, 'a', encoding='utf-8') as f:
            f.write(json.dumps(d, ensure_ascii=False) + '\n')

    def event(self, e):
        self._append('events.jsonl', {'at': time.strftime('%Y-%m-%dT%H:%M:%S%z'), **e})

    def photo(self, jpeg, meta):
        self.n += 1
        day, ts = time.strftime('%Y%m%d'), time.strftime('%H%M%S')
        name = f'{ts}-ep{meta.get("episode")}-{os.getpid()}-{self.n}.jpg'
        d = self.root / 'photos' / day; d.mkdir(exist_ok=True)
        tmp = d / (name + '.tmp')
        tmp.write_bytes(jpeg); os.replace(tmp, d / name)
        meta = {**meta, 'saved_at': time.strftime('%Y-%m-%dT%H:%M:%S%z'), 'bytes': len(jpeg), 'url': f'media/photos/{day}/{name}'}
        self._append('photos.jsonl', meta)
        return meta

    def tail(self, name, n):
        """마지막 n 건(깨진 줄은 건너뜀). ponytail: 파일 전체를 읽는다 — 수만 건이 되면 날짜별로 나눈다"""
        try:
            lines = (self.root / name).read_text(encoding='utf-8').splitlines()[-n:]
        except FileNotFoundError:
            return []
        out = []
        for l in lines:
            try:
                out.append(json.loads(l))
            except ValueError:
                pass
        return out


# ---- 공용 문서(구역·임무·임무 진행·사진 분류) — PC·휴대폰이 같은 값을 본다 ----
# 형식: ('s', 최대 글자) · ('n',) 유한 숫자 ±10000 · ('e', 허용값) · ('l', 항목형식, 최대 개수[, 최소]) · dict = 이 키만 전부 필요
S = lambda n: ('s', n)
N, PT = ('n',), ('l', ('n',), 2, 2)
PHOTO = ('p', re.compile(r'media/photos/\d{8}/[\w.-]{1,80}\.jpg'))      # 서버 사진 경로만(임의 주소·javascript:·.. 불가)
MODS = ('e', {'사진', '운영자 확인', '대기'})   # 지금 앱으로 실제 할 수 있는 모듈만(가스·AI 탐지·음성 방송은 미연결 — 저장 형식에 없음)
WP = {'x': N, 'y': N, 'name': S(40), 'mods': ('l', MODS, 3)}
DOC_KINDS = {
    'zone': {'name': S(40), 'type': ('e', {'금지', '감속'}), 'pts': ('l', PT, 40, 3)},
    # 임무 양식: 지점에서 할 일(모듈). 경보 규칙은 자동 실행 미연결이라 저장하지 않는다
    'tmpl': {'name': S(60), 'desc': S(120), 'mods': ('l', {'type': MODS, 'detail': S(80)}, 6)},
    # 임무 계획: 양식(tmpl id, 비면 기본 양식) + 경유점(지점마다 할 일)
    'mission': {'name': S(60), 'tmpl': S(40), 'memo': S(400), 'wps': ('l', WP, 30)},
    # 수동 임무 진행: 운영자가 직접 조종·확인해 적는 결과(로봇 자동 완료 아님). 계획을 시작 때 복사해 둔다
    'run': {'mode': ('e', {'수동'}), 'mission': S(40), 'tmpl': S(60), 'name': S(60), 'status': ('e', {'진행', '완료', '실패', '중단'}), 'started': S(32), 'ended': S(32), 'memo': S(400),
            'wps': ('l', {**WP, 'st': ('e', {'대기', '방문', '미방문'}), 'at': S(32), 'why': S(120), 'chk': ('e', {'', '확인', '보류', '제외'}), 'photos': ('l', PHOTO, 10)}, 30)},
    # 사진 = 운영자 등록 관찰(AI 탐지 없음): 확인·보류·제외 + 메모
    'note': {'photo': PHOTO, 'cls': ('e', {'확인', '보류', '제외'}), 'memo': S(400)},
}
DOC_MAX, DOC_TOTAL = 12000, 2000          # 문서 하나 최대 바이트 · 전체 문서 수


def doc_check(spec, v, path='doc'):
    """형식이 맞으면 None, 아니면 이유. bool 은 숫자로 받지 않는다"""
    if isinstance(spec, dict):
        if not isinstance(v, dict) or set(v) != set(spec):
            return f'{path}: 키가 {sorted(spec)} 이어야 함'
        for k, s in spec.items():
            e = doc_check(s, v[k], f'{path}.{k}')
            if e:
                return e
        return None
    t = spec[0]
    if t == 's':
        return None if isinstance(v, str) and len(v) <= spec[1] else f'{path}: 글 {spec[1]}자 이하'
    if t == 'n':
        return None if type(v) in (int, float) and math.isfinite(v) and abs(v) <= 1e4 else f'{path}: 유한 숫자(±10000)'
    if t == 'e':
        return None if isinstance(v, str) and v in spec[1] else f'{path}: {sorted(spec[1])} 중 하나'
    if t == 'p':
        return None if isinstance(v, str) and spec[1].fullmatch(v) and '..' not in v else f'{path}: 서버 사진 경로(media/photos/날짜/이름.jpg)만'
    if not isinstance(v, list) or not (spec[3] if len(spec) > 3 else 0) <= len(v) <= spec[2]:
        return f'{path}: 목록 {spec[3] if len(spec) > 3 else 0}~{spec[2]}개'
    for i, x in enumerate(v):
        e = doc_check(spec[1], x, f'{path}[{i}]')
        if e:
            return e
    return None


class Docs:
    """docs.json 하나(임시 파일 → os.replace 원자 교체). ID·판(rev)·작성자·시각은 서버가 붙인다.
    바꿀 내용(후보)을 먼저 파일에 쓰고, 성공한 뒤에만 메모리·전체 판을 확정한다 — 쓰기 실패면 이전 상태 그대로.
    기존 파일이 깨졌으면 원본을 건드리지 않고 문서 저장소만 «사용 불가»(조종·상태는 계속). self.lock 은 문서 전용(조종 lock 과 분리).
    고칠 때는 화면이 읽은 rev 를 보내야 한다 — 다르면 409. ponytail: 매번 파일 전체 쓰기 — 수천 건이면 종류별 파일로"""

    def __init__(self, root):
        self.path = Path(root) / 'docs.json'; self.lock = threading.Lock(); self.n = 0; self.broken = None; self.d = {}
        try:
            d = json.loads(self.path.read_text(encoding='utf-8'))
            if not isinstance(d, dict):
                raise ValueError('최상위가 객체 아님')
            for k, x in d.items():       # 겉 키만이 아니라 저장 때와 같은 형식 검사(doc={} 같은 판이 화면 전체 예외를 내지 않게)
                if not (isinstance(x, dict) and x.get('id') == k and x.get('kind') in DOC_KINDS and type(x.get('rev')) is int and x['rev'] >= 1
                        and isinstance(x.get('by'), str) and isinstance(x.get('at'), str)) or doc_check(DOC_KINDS[x['kind']], x.get('doc')):
                    raise ValueError(f'문서 {str(k)[:40]} 형식')
            self.d = d
        except FileNotFoundError:
            pass
        except Exception as e:      # 깨진 파일: 덮어쓰지 않는다
            self.broken = f'docs.json 읽기 실패({type(e).__name__}) — 원본 보존, 문서 저장소 사용 불가'
        self.rev = sum(x['rev'] for x in self.d.values())    # 화면이 «바뀜»을 알아채는 전체 판

    def apply(self, m, actor):
        """m = {op:'put'|'del', kind, id(새 문서는 None), rev, doc}. 반환 (HTTP 코드, 응답). self.lock 안에서 부른다"""
        if self.broken:
            return 503, {'error': self.broken}
        if not isinstance(m, dict) or m.get('op') not in ('put', 'del'):
            return 400, {'error': 'op 는 put·del'}
        did, cur = m.get('id'), None
        if did is not None:
            if not isinstance(did, str) or not re.fullmatch(r'[a-z]\w{1,40}', did):
                return 400, {'error': 'id 형식'}
            rev = m.get('rev')
            if type(rev) is not int or rev < 1:
                return 400, {'error': 'rev 는 1 이상 정수'}
            cur = self.d.get(did)
            if cur is None:
                return 404, {'error': '없는 문서(다른 기기가 지웠을 수 있음)'}
            if rev != cur['rev']:
                return 409, {'error': '다른 기기가 먼저 고침 — 새로 읽은 뒤 다시', 'cur': cur}
        kind = cur['kind'] if cur else m.get('kind')
        if not isinstance(kind, str) or kind not in DOC_KINDS:
            return 400, {'error': f'종류는 {sorted(DOC_KINDS)}'}
        new = dict(self.d)
        if m['op'] == 'del':
            if cur is None:
                return 400, {'error': '지울 id 필요'}
            del new[did]
            self._write(new); self.d = new; self.rev += 1
            return 200, {'ok': True, 'id': did, 'kind': kind, 'name': cur['doc'].get('name', '')}
        doc = m.get('doc')
        e = doc_check(DOC_KINDS[kind], doc)
        if e:
            return 400, {'error': e}
        if len(json.dumps(doc, ensure_ascii=False).encode()) > DOC_MAX:
            return 400, {'error': f'문서가 너무 큼({DOC_MAX} 바이트 이하)'}
        # 하나만 있어야 하는 것: 진행 중 수동 임무 하나 · 사진 하나에 분류 하나. 겹치면 409 + 기존 문서(그 id·rev 로 다시 읽고 고침)
        for x in self.d.values():
            if x['id'] != did and x['kind'] == kind and (
                    (kind == 'run' and doc['status'] == '진행' and x['doc'].get('status') == '진행') or
                    (kind == 'note' and x['doc'].get('photo') == doc['photo'])):
                return 409, {'error': '이미 진행 중인 수동 임무가 있음 — 먼저 끝내세요' if kind == 'run' else '이 사진은 다른 기기가 먼저 분류함 — 최신 판 위에 다시', 'cur': x}
        if cur is None:
            if len(self.d) >= DOC_TOTAL:
                return 400, {'error': f'문서 수 한도 {DOC_TOTAL}'}
            while True:                # 같은 초·같은 pid 로 다시 열면 n 이 0 부터라 기존 id 와 겹칠 수 있다 → 겹치면 다시 뽑기(형식 그대로)
                self.n += 1; did = f'{kind[0]}{time.strftime("%m%d%H%M%S")}{os.getpid() % 1000:03d}{self.n}'
                if did not in self.d: break
        new[did] = {'id': did, 'kind': kind, 'rev': (cur['rev'] if cur else 0) + 1, 'by': actor, 'at': time.strftime('%Y-%m-%dT%H:%M:%S%z'), 'doc': doc}
        self._write(new); self.d = new; self.rev += 1
        return 200, {'ok': True, 'id': did, 'rev': new[did]['rev'], 'kind': kind, 'name': doc.get('name', ''), 'new': cur is None}

    def _write(self, d):            # 실패하면 예외 — 호출자는 메모리를 바꾸지 않은 채 500
        tmp = self.path.with_suffix('.tmp')
        tmp.write_text(json.dumps(d, ensure_ascii=False), encoding='utf-8'); os.replace(tmp, self.path)

    def listing(self):              # GET /api/docs 응답. server/store.Store.listing 과 같은 모양
        return {'docs': list(self.d.values()), 'rev': self.rev, 'broken': self.broken}


def open_docs(spec, media):
    """--store 값 → (문서 저장소, 알림 글). json = 지금의 docs.json. sqlite:<경로> = server/store.Store(검사는 이 파일의 doc_check).
    DB 가 없으면 docs.json 을 읽기만 해서 이전(server/migrate import: 복사본 → 임시 DB → 검증 → 새 이름, 덮어쓰기 없음).
    이전이 실패하면 docs.json(원본)으로 돌아간다. docs.json 은 어느 경우에도 지우거나 덮지 않는다.
    주의: sqlite 로 쓴 뒤 json 으로 되돌리면 그 사이 변경은 docs.json 에 없다 — server/migrate.py export 로 새 파일을 만들어 바꿔 넣는다."""
    if spec == 'json':
        return Docs(media), ''
    if not spec.startswith('sqlite:') or len(spec) == len('sqlite:'):
        raise SystemExit('--store 는 json 또는 sqlite:<경로>')
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from server.store import Store
    from server import migrate
    db, chk = Path(spec[len('sqlite:'):]), (lambda k, d: doc_check(DOC_KINDS[k], d))
    if not db.exists():
        try:
            # docs.json 이 아직 없는 새 media 폴더면 빈 DB 로 시작(json 경로가 빈 Docs 로 시작하는 것과 같게) — 폴더 자체는 있어야
            migrate.cmd_import(argparse.Namespace(src=str(media), out=str(db), allow_empty=not (Path(media) / 'docs.json').exists()), check=chk)
        except Exception as e:      # 이전 실패 → 원본 그대로 사용(작업 폴더 manifest 에 이유)
            return Docs(media), f'SQLite 이전 실패({type(e).__name__}: {str(e)[:80]}) — docs.json 으로 계속'
    return Store(db, create=False, check=chk), ''


def actor_from_header(v):
    """관문이 붙인 «계정 · 기기»(퍼센트 인코딩 UTF-8 — HTTP 헤더는 ASCII 만 안전). 형식이 틀리면 표시용 대체값"""
    from urllib.parse import unquote
    if not v:
        return ''
    try:
        if not v.isascii():
            raise ValueError
        a = unquote(v, errors='strict')
    except (ValueError, UnicodeDecodeError):
        return '관문 기기(이름 해독 실패)'
    return re.sub(r'[\x00-\x1f\x7f]', '', a).strip()[:48] or '관문 기기'


SESSION_RESULTS = {'starting', 'ready', 'already_running', 'resource_blocked', 'budget_exhausted', 'bad_args', 'failed'}
START_TEXT = {'timeout': '래퍼 응답 시간 초과 — 결과 미확인(켜졌을 수 있음 · 상태·영상으로 확인 · 자동 재요청 없음)',
              'starting': '시뮬 기동 중 · 상태·영상 연결은 화면 표시로 판정(안전 준비 판정 아님)',
              'ready': '시뮬 상태·영상 수신 확인(안전 준비 판정 아님 · STOP 상태)', 'already_running': '이미 실행 중',
              'resource_blocked': '자원 부족으로 기동 안 함', 'budget_exhausted': '사용 가능 횟수 소진(기동 안 함)', 'bad_args': '인자 거부(기동 안 함)', 'failed': '기동 실패'}


def parse_session(out, code):
    """RL 래퍼(request_session.sh, schema v2_session/1) 출력 → (결과, 표시 글). 형식이 틀리면 실패로(추정 없음)"""
    for line in reversed((out or '').strip().splitlines()):
        try:
            d = json.loads(line)
        except ValueError:
            continue
        if isinstance(d, dict) and d.get('schema') == 'v2_session/1' and d.get('result') in SESSION_RESULTS:
            extra = ' · '.join(f'{lab}{str(d[k])[:80]}' for k, lab in (('reason', ''), ('ends_at', '종료 예정 '), ('ledger_used', '기존 평지 체험 사용 횟수 '), ('map_ledger_used', '지도 체험 사용 횟수 ')) if d.get(k) is not None)
            return d['result'], extra
    return 'failed', f'래퍼 응답 형식 틀림(종료 {code})'


UX_EXIT = {'ready': 0, 'starting': 0, 'already_running': 3, 'resource_blocked': 4, 'bad_args': 2, 'failed': 1}   # RL ux_start.sh 머리말(5 budget_exhausted 없음)


def ux_usage(s):
    """사용자 체험 경로 결속(RL UX-CONTRACT): schema v2_session/1 + usage_scope "user_experience" + count_limit 칸이 있고 null.
    칸이 없거나 다른 값(experiment·"unknown"·숫자)이면 False — 숫자 null 만으로 «제한 없음»을 단정하지 않는다"""
    return (isinstance(s, dict) and s.get('schema') == 'v2_session/1' and s.get('usage_scope') == 'user_experience'
            and 'count_limit' in s and s['count_limit'] is None)


def ux_result(out, code):
    """ux_start.sh 출력 → (결과, 글). 결과·종료 코드가 머리말 표와 맞고, 성공(starting/ready)이면 usage 결속까지 맞아야 채택"""
    res, extra = parse_session(out, code)
    if res not in UX_EXIT or UX_EXIT[res] != code:
        return 'failed', f'래퍼 결과({res})와 종료 코드({code}) 모순'
    if res in ('starting', 'ready'):
        d = None
        for line in reversed((out or '').strip().splitlines()):   # parse_session 이 채택한 줄과 같은 규칙(마지막 v2_session/1 줄)
            try:
                x = json.loads(line)
            except ValueError:
                continue
            if isinstance(x, dict) and x.get('schema') == 'v2_session/1' and x.get('result') in SESSION_RESULTS:
                d = x; break
        if not ux_usage(d):
            return 'failed', '래퍼 응답이 사용자 체험 경로가 아님(usage_scope·count_limit 불일치)'
    return res, extra


class SimStart:
    """«시뮬 시작(30분)» — 사용자가 누를 때만 RL 래퍼를 한 번 부른다. 동시 1건·120 s 쿨다운·재시도/연장 없음"""
    COOL, LEDGER_MAX, FRESH = 120.0, 8, 15.0   # LEDGER_MAX = RL request_session.sh 정본값(다르면 미확인) · 조회 신선도(폴 2~5 s)

    def __init__(self, wrapper, now=time.monotonic, args=(), status_name='session_status.sh', ux=False):
        self.wrapper, self.now, self.busy, self.last = wrapper, now, False, -1e9
        self.args, self.status_name, self.ux = tuple(args), status_name, ux   # ux = 사용자 체험 경로(ux_start.sh flat · ux_status.sh) — 횟수 대신 usage 결속 확인
        self.session = None         # session_status.sh 마지막 결과(읽기만) — running/starting/idle, 남은 시간
        self.sess_t = None          # 그 결과를 받은 시각(monotonic)
        self.polled = False         # session_status.sh 를 한 번이라도 불렀나(조회 중 ↔ 확인 못 함 구분)
        self.result = None          # 마지막 «시뮬 시작» 래퍼 결과 {t, st, text} — 화면이 계속 보여 줌(toast 만으로 숨기지 않게)

    def ledger(self):
        """기존(평지) 체험 원장 — session_status.sh 의 ledger_used/max 를 읽기만. 신선·schema·정수·max 정본·0≤used≤max 가 아니면 None(미확인 — 0 도 허용도 아님).
        누적 횟수라 날짜로 다시 채워지지 않는다. 증설·초기화는 RL 소유"""
        s = self.session if self.sess_t is not None and 0 <= self.now() - self.sess_t <= self.FRESH else None
        if self.ux or not s or s.get('schema') != 'v2_session/1':
            return None
        u, mx = s.get('ledger_used'), s.get('ledger_max')
        return {'used': u, 'max': mx} if type(u) is int and type(mx) is int and mx == self.LEDGER_MAX and 0 <= u <= mx else None

    def usage(self):
        """'experiment'(옛 경로 — 횟수 원장) | 'user_experience'(신선한 ux_status 가 결속을 보임) | None(미확인)"""
        if not self.ux:
            return 'experiment'
        s = self.session if self.sess_t is not None and 0 <= self.now() - self.sess_t <= self.FRESH else None
        return 'user_experience' if ux_usage(s) else None

    def refuse(self, sim_live):
        if not self.wrapper:
            return 'RL 래퍼 미설정 — 시뮬 시작 불가(RL 쪽에서 기동)'
        if self.busy:
            return '시작 요청 처리 중'
        if sim_live:
            return '시뮬이 이미 돌고 있음'
        if (self.session or {}).get('result') in ('running', 'starting'):
            return '시뮬 세션이 이미 켜지는 중·실행 중(RL 상태)'
        if self.ux:                  # 사용자 체험: 횟수 검사 대신 결속 확인 — 미확인이면 거부(제한 없음으로 단정 0)
            if self.usage() is None:
                return '사용자 체험 경로 상태 조회 중' if self.session is None and not self.polled else '사용자 체험 경로 확인 못 함(상태가 «사용자 체험 · 횟수 제한 없음»이 아님) — 잠시 뒤 다시 확인'
            a = unit_state(self.session)   # 같은 unit 이 확실히 꺼짐(inactive·failed)일 때만 — MapStart.unit_why 와 같은 규칙
            if a not in UNIT_OFF:
                return 'Gazebo unit 상태 미확인' if a is None else f'Gazebo unit {a} — 끈 뒤 다시'
            rip = self.session.get('request_in_progress')   # RL: marker pid+starttime 결속, 모르면 null — true·null 모두 거부(추측 허용 0)
            if rip is not False:
                return '시작 요청 진행 중(RL)' if rip is True else '시작 요청 진행 여부 미확인 — 잠시 뒤 다시 확인'
            left = self.COOL - (self.now() - self.last)
            return f'방금 요청함 — {left:.0f} s 뒤 다시' if left > 0 else ''
        lg = self.ledger()           # 미확인(조회 전·실패·오래됨·형식 틀림)도 거부 — 0·허용으로 단정 0. 다음 폴 성공이면 자동으로 풀림(자동 기동 0)
        if lg is None:
            return '기존 평지 체험 사용 가능 횟수 조회 중' if self.sess_t is None and self.session is None and not self.polled else '기존 평지 체험 사용 가능 횟수 확인 못 함 — 잠시 뒤 다시 확인'
        if lg['used'] >= lg['max']:
            return f'기존 평지 체험 사용 가능 횟수 소진({lg["used"]}/{lg["max"]}) — 날짜가 바뀌어도 다시 채워지지 않음 · 지도 화면의 «지도 체험 시작»은 별도 횟수'
        left = self.COOL - (self.now() - self.last)
        return f'방금 요청함 — {left:.0f} s 뒤 다시' if left > 0 else ''

    def state(self, sim_live):
        why = self.refuse(sim_live)
        ss = self.session or {}
        return {'ok': not why, 'why': why, 'busy': self.busy,
                'session': {k: ss.get(k) for k in ('result', 'reason', 'started_at', 'ends_at', 'remaining_s')} if ss else None,
                'ledger': self.ledger(), 'last': self.result, 'usage_scope': self.usage()}

    def poll(self):
        """RL 상태 스크립트(읽기만, 약 0.05 s). 래퍼와 같은 폴더. 실패하면 None(추정 없음)"""
        d = read_session(str(Path(self.wrapper).with_name(self.status_name)))   # 종료 코드 0 + schema v2_session/1 아니면 미확인
        self.session = d if d and d.get('result') in ('running', 'starting', 'idle') else None
        self.sess_t = self.now() if self.session else None
        self.polled = True
        # 권장 주기: 켜지는 중 2 s, 그 밖 5 s
        return 2.0 if self.busy or (self.session or {}).get('result') == 'starting' else 5.0


def read_session(status_sh, timeout=10.0):
    """session_status.sh(RL, 읽기만) 한 번 → dict 또는 None(종료 코드≠0·시간 초과·형식 틀림 = 미확인, 추정 없음).
    timeout 이 유한 양수가 아니면 실행하지 않고 미확인(남은 시간 0 이하로 60 s 상한을 늘리지 않게)"""
    if not (type(timeout) in (int, float) and math.isfinite(timeout) and timeout > 0):
        return None
    try:
        r = subprocess.run(['bash', status_sh], capture_output=True, text=True, timeout=timeout)
        d = json.loads(r.stdout.strip().splitlines()[-1])
        return d if r.returncode == 0 and isinstance(d, dict) and d.get('schema') == 'v2_session/1' else None
    except Exception:
        return None


UNIT_OFF = ('inactive', 'failed')                                   # systemd ActiveState 중 «꺼짐»으로 받는 값만
UNIT_LIVE = ('active', 'activating', 'reloading', 'deactivating')


def unit_state(d):
    """session_status 결과 → active_state(위 두 목록의 값만) 또는 None(없음·모르는 값·형식 틀림 = 미확인)"""
    v = (d or {}).get('active_state')
    return v if isinstance(v, str) and v in UNIT_OFF + UNIT_LIVE else None


class SimStop:
    """«Gazebo 종료» — 로봇 STOP(명령 0 잠금)과 다르다: RL 의 stop_live.sh(= systemctl --user stop fh-v2-live, SIGINT 정리)를
    로그인한 기기가 확인 뒤 누를 때만 한 번 부른다. 경로는 --sim-start 와 같은 폴더의 고정 이름(서버 정본, 화면이 못 바꿈).
    동시 1건·30 s 쿨다운·전체 60 s 상한. 다른 기기가 조종 중이면 거부(남의 조종을 끊지 않음).
    확인 범위 = «ROS 세션 종료»(unit 비활성 + 상태 수신 3 s 끊김)뿐 — Gazebo 잔여 프로세스 0 은 이 앱이 확인하지 않는다.
    stop_live.sh 는 끝에 `status … || true` 라 종료 코드 0 만으로는 성공이 아니다"""
    COOL, LIMIT, GAP, WRAP = 30.0, 60.0, 3.0, 45.0     # WRAP = stop_live 기다림(systemd TimeoutStopSec 45), 전체는 LIMIT 안

    def __init__(self, start_wrapper, now=time.monotonic, stop=None, status=None):
        """옛 경로: --sim-start 옆 stop_live.sh·session_status.sh. 사용자 체험: stop·status 를 명시(--ux-stop · ux_status.sh)"""
        p = Path(stop) if stop else Path(start_wrapper).with_name('stop_live.sh') if start_wrapper else None
        q = Path(status) if stop else p.with_name('session_status.sh') if p else None
        self.wrapper = str(p) if p and p.is_file() else None
        self.status_sh = str(q) if self.wrapper and q and q.is_file() else None
        self.now, self.busy, self.last_t, self.last = now, False, -1e9, None   # last = 마지막 결과 {t, st, text}

    def on(self, sim_live, session, map_session=None):
        return bool(sim_live or any((x or {}).get('result') in ('running', 'starting') or unit_state(x) in UNIT_LIVE for x in (session, map_session)))

    def refuse(self, gated, starting, sim_live, session, holder_other, map_session=None):
        if not self.wrapper or not self.status_sh:
            return 'Gazebo 종료 경로 미설정'
        if not gated:
            return '로그인한 기기에서만(관문 경유)'
        if self.busy:
            return 'Gazebo 종료 처리 중'
        if starting:
            return '시뮬 시작 요청 처리 중 — 끝난 뒤'
        if not self.on(sim_live, session, map_session):
            return '켜진 Gazebo 없음'
        if holder_other:
            return f'{holder_other} 조종 중 — 그 기기에서 STOP·반납한 뒤'
        left = self.COOL - (self.now() - self.last_t)
        return f'방금 요청함 — {left:.0f} s 뒤 다시' if left > 0 else ''

    def state(self, gated, starting, sim_live, session, holder_other, runner=None, map_ledger=None, map_session=None):
        """runner = 지금 unit 을 쓰는 쪽(MapStart.runner). 원장은 그 쪽 것만: live_v2 → 기존 체험 원장, live_map → 지도 체험 원장, 모름 → null"""
        why = self.refuse(gated, starting, sim_live, session, holder_other, map_session)
        ss = session or {}
        if ux_usage(map_session) and unit_state(map_session) in UNIT_LIVE:   # 사용자 체험 세션 — 횟수 제한 없음(남은 횟수 칸 null)
            kind, left = 'user', None
        elif runner == 'live_map':
            kind, left = 'map', (map_ledger['max'] - map_ledger['used'] if map_ledger else None)
        elif runner == 'live_v2':
            kind = 'online'
            left = ss['ledger_max'] - ss['ledger_used'] if all(type(ss.get(k)) is int for k in ('ledger_max', 'ledger_used')) else None
        else:
            kind, left = None, None
        return {'ok': not why, 'why': why, 'busy': self.busy, 'on': self.on(sim_live, session, map_session), 'ledger_left': left, 'ledger_kind': kind, 'last': self.last}


def stop_run(stopper, run_wrapper, read_unit, state_age, sleep=time.sleep):
    """stop_live.sh 한 번 + ROS 세션 종료 확인. 시작부터 stopper.LIMIT 안에서 끝낸다. → (st, text) — 'ok' 는 확인됐을 때만.
    run_wrapper(timeout) → 종료 코드 | None(시간 안에 안 끝남 — 죽이지 않음). read_unit(timeout) → UNIT_OFF/UNIT_LIVE 값 | None(미확인).
    state_age() → 마지막 상태 수신 뒤 s | None(받은 적 없음). 유한·0 이상이 아니면 미확인"""
    t0 = stopper.now(); left = lambda: stopper.LIMIT - (stopper.now() - t0)
    rc = run_wrapper(min(stopper.WRAP, left()))
    if rc is None:
        return 'bad', 'Gazebo 종료 확인 못 함 · stop_live 가 시간 안에 안 끝남 — 상태 표시 확인'
    unit = age = None
    while left() > 0:
        unit = read_unit(min(10.0, left()))
        age = state_age()
        age_ok = age is None or (type(age) in (int, float) and math.isfinite(age) and age >= 0)
        if not age_ok:
            age = None; unit = None if unit not in UNIT_OFF else unit; break
        if unit in UNIT_OFF and (age is None or age > stopper.GAP) and left() >= 0:
            return 'ok', f'ROS 세션 종료 확인 · unit {unit} · 상태 수신 끊김{"" if age is None else f" {age:.0f} s"} (Gazebo 잔여 프로세스는 미확인)' + (f' · stop_live 종료 코드 {rc}' if rc else '')
        if left() <= 1.0:
            break
        sleep(1.0)
    return 'bad', f'Gazebo 종료 확인 못 함 · unit {unit or "미확인"} · 상태 {"미확인/없음" if age is None else f"{age:.1f} s 전"} · stop_live 종료 코드 {rc} — 상태 표시 확인'


def selftest_stop():
    import tempfile
    t = [0.0]; tick = lambda s: t.__setitem__(0, t[0] + s)
    with tempfile.TemporaryDirectory() as td:
        req = Path(td) / 'request_session.sh'; req.write_text('exit 0\n')
        assert SimStop(str(req)).wrapper is None                                   # stop_live.sh 없으면 미설정
        assert SimStop(None).refuse(True, False, True, None, None) == 'Gazebo 종료 경로 미설정'
        (Path(td) / 'stop_live.sh').write_text('echo stop >> "$(dirname "$0")/calls"\n')
        (Path(td) / 'session_status.sh').write_text('echo \'{"schema":"v2_session/1","result":"idle","active_state":"inactive","ledger_used":8,"ledger_max":8}\'\n')
        s = SimStop(str(req), lambda: t[0])
        run = lambda: s.refuse(True, False, True, None, None)
        assert run() == ''
        assert s.refuse(False, False, True, None, None).startswith('로그인한')                 # 관문 신원 없는 127.0.0.1 직접
        assert s.refuse(True, True, True, None, None).startswith('시뮬 시작 요청')             # 시작과 경합
        assert s.refuse(True, False, False, {'result': 'idle'}, None) == '켜진 Gazebo 없음'
        assert s.refuse(True, False, False, {'result': 'starting'}, None) == ''               # 켜지는 중도 끌 수 있음
        assert '조종 중' in s.refuse(True, False, True, None, 'B · 폰')                        # 타인 holder: 거부
        s.busy = True; assert run() == 'Gazebo 종료 처리 중'; s.busy = False                  # 같은 rid 중복·연타
        s.last_t = 0.0; t[0] = 10.0; assert run().startswith('방금'); t[0] = 31.0; assert run() == ''
        on8 = {'result': 'running', 'ledger_used': 8, 'ledger_max': 8}
        st = s.state(True, False, True, on8, None, 'live_v2')
        assert st['ok'] and st['on'] and st['ledger_left'] == 0 and st['ledger_kind'] == 'online' and st['last'] is None
        assert s.state(True, False, True, {'ledger_used': '8', 'ledger_max': 8}, None, 'live_v2')['ledger_left'] is None
        # 번들4: 지도 체험 세션이면 지도 원장(남은 4−used), 기존 원장 8/8 을 쓰지 않음 · runner 모름 → null
        st = s.state(True, False, True, on8, None, 'live_map', {'used': 1, 'max': 4, 'keys': ['rooms_a/f1']})
        assert st['ledger_left'] == 3 and st['ledger_kind'] == 'map'
        assert s.state(True, False, True, on8, None, 'live_map', None)['ledger_left'] is None
        st = s.state(True, False, True, on8, None, None); assert st['ledger_left'] is None and st['ledger_kind'] is None
        # 켜짐 판정은 같은 unit active_state 로도(지도 세션: 기존 세션 idle·sim_live 없음)
        assert s.refuse(True, False, False, {'result': 'idle'}, None, {'result': 'running', 'active_state': 'active'}) == ''
        assert s.refuse(True, False, False, {'result': 'idle'}, None, {'result': 'idle', 'active_state': 'activating'}) == ''
        assert s.refuse(True, False, False, {'result': 'idle'}, None, {'result': 'idle', 'active_state': 'inactive'}) == '켜진 Gazebo 없음'
        # 실제 subprocess 한 번(모의 wrapper·모의 상태 스크립트 — 실제 stop_live 호출 0)
        assert subprocess.run(['bash', s.wrapper], timeout=10).returncode == 0 and (Path(td) / 'calls').read_text() == 'stop\n'
        assert read_session(s.status_sh)['active_state'] == 'inactive'
        assert read_session(str(req)) is None                                      # 출력 없음 → 미확인
    # 판정(가짜 시계): rc 0 이어도 unit active 면 성공 아님 · 늦은 state · timeout · unit 미확인
    def go(rc, units, ages, cost=0.0, wrap_cost=0.0):
        t[0] = 0.0; s2 = SimStop(None, lambda: t[0]); u, a_ = iter(units), iter(ages); seen = []
        def ru(to):
            seen.append(to); assert 0 < to <= 10.0; tick(min(cost, to)); return next(u, units[-1])
        def rw(to):
            assert to <= 45.0; tick(min(wrap_cost, to)); return rc
        r = stop_run(s2, rw, ru, lambda: next(a_, ages[-1]), sleep=tick)
        assert t[0] <= 60.0 + 1e-9, t[0]; return r
    assert go(0, ['inactive'], [5.0])[0] == 'ok'
    assert go(0, ['failed'], [5.0])[0] == 'ok'
    assert go(0, ['inactive'], [None])[0] == 'ok'                                  # 상태를 받은 적 없음 = 끊김
    r = go(0, ['active'], [5.0]); assert r[0] == 'bad' and 'active' in r[1]          # rc 0 + unit active → 성공 아님
    assert go(0, ['deactivating', 'deactivating', 'inactive'], [5.0])[0] == 'ok'      # 내려가는 중 → 기다려서 확인
    r = go(0, ['inactive'], [0.2, 0.5, 0.1, 0.3] + [0.2] * 80); assert r[0] == 'bad'  # 옛 state 계속 늦게 옴 → 확인 못 함
    assert go(0, ['inactive'], [0.2, 1.0, 4.0])[0] == 'ok'
    assert go(None, ['inactive'], [9.0])[0] == 'bad'                               # wrapper 시간 초과 → 성공 표시 금지
    assert go(0, [None], [9.0])[0] == 'bad'                                        # unit 읽기 실패 → 미확인
    r = go(1, ['inactive'], [9.0]); assert r[0] == 'ok' and '종료 코드 1' in r[1]    # 종료 코드는 숨기지 않음
    for bad_age in (-1.0, float('nan'), float('inf'), '5', True):                  # 상태 나이 이상 → 미확인
        assert go(0, ['inactive'], [bad_age])[0] == 'bad', bad_age
    assert go(0, ['inactive'], [9.0], wrap_cost=45.0)[0] == 'ok'                   # wrapper 45 s 뒤에도 상한 안
    assert go(0, ['active'], [9.0], wrap_cost=45.0, cost=10.0)[0] == 'bad'          # 조회 무응답(매번 상한까지) → 60 s 안에 닫힘
    for to in (0, 0.0, -1.0, float('nan'), float('inf'), None):                     # 남은 시간 0 이하·비유한 → 실행 안 함·미확인
        assert read_session('/nonexistent', to) is None, to
    # 종료 처리 중 입력 경계(서버 정본, Core 만): 같은/새 연결 take·resume·reset 거부(→ on_message 의 pub_resume·리셋 서비스 호출 0), cmd 0
    t[0] = 0.0; c = Core(now=lambda: t[0])
    S = lambda stop: c.on_state({'schema': SCHEMA, 'episode': 0, 'stop_requested': stop, 'reset_in_progress': False, 'policy_running': True})
    S(False); assert c.take('a'); c.cmd('a', Z); c.cmd('a', (1.0, 0.0, 0.0)); assert c.applied() == (0.6, 0, 0)
    c.drop('a', 'Gazebo 종료'); c._lock(); c.sim_busy = 'Gazebo 종료 중'   # stop_sim 과 같은 순서
    S(True); assert c.sim_block() == 'Gazebo 종료 중'
    for cid in ('a', 'b'):
        assert not c.take(cid) and c.controller is None
        c.cmd(cid, Z); c.cmd(cid, (1.0, 0.0, 0.0)); assert c.applied() == Z
        assert not c.resume(cid) and c.resume_pending is None
        assert not c.reset_begin(cid, True) and c.reset_pending is None
    c.sim_busy = ''                                                                # 끝남 → 자동 복원 없음
    assert c.latch and c.controller is None and c.resume_pending is None and c.applied() == Z
    assert c.take('b'); c.cmd('b', Z); c.cmd('b', (1.0, 0.0, 0.0)); assert c.applied() == Z and c.latch   # STOP 잠금 유지
    # unit 값·상태 스크립트 형식
    for d, want in [({'active_state': 'inactive'}, 'inactive'), ({'active_state': ''}, None), ({'active_state': 'unknown'}, None),
                    ({'active_state': False}, None), ({'active_state': ' inactive'}, None), ({}, None), (None, None), ({'active_state': 'maintenance'}, None)]:
        assert unit_state(d) == want, d
    with tempfile.TemporaryDirectory() as td:
        ok_json = '{"schema":"v2_session/1","result":"idle","active_state":"inactive"}'
        for body, want in [(f"echo '{ok_json}'", 'inactive'), (f"echo '{ok_json}'; exit 1", None), ('echo', None), ('echo "  "', None),
                           ("echo '{\"schema\":\"other\",\"active_state\":\"inactive\"}'", None), ('sleep 3', None)]:
            f = Path(td) / 'ss.sh'; f.write_text(body + '\n')
            assert unit_state(read_session(str(f), timeout=1.0)) == want, body


def cam_why(core, sim, now):
    """지금 가진 카메라 프레임이 지금 회차와 연관 확인되는지 — 사진 저장·영상 push 공용(lock 안에서 부름). '' = 연관 확인.
    10-15 ②: 영상 push 도 이 검사를 통과한 프레임만(전엔 jpeg_ep·리셋 대조 없이 새 프레임이면 보냄 → 리셋·새 episode 직후 옛 렌더가 새 회차 화면에 섞일 수 있었음)"""
    st = core.st if core.state_t is not None and now - core.state_t <= 1.0 else None
    # ponytail: 바뀐 직후 1 s 는 옛 렌더가 섞일 수 있어 거부(지연 실측 없음). 프레임에 episode 가 실리면 그걸로 대조
    return ('시뮬 상태 없음(1 s 안)' if st is None else '리셋 중' if core.reset_pending or st.get('reset_in_progress') or sim['jpeg_reset']
            else 'episode 바뀜(프레임과 연관 미확인)' if sim['jpeg_ep'] != core.episode
            or (core.ep_change_t is not None and min(now, sim['jpeg_t']) - core.ep_change_t < 1.0) else '')


def selftest_camwhy():
    """영상 push·사진 공용 연관 검사: 상태 없음·리셋·옛 episode·바뀐 직후 1 s 프레임 거부, 그 뒤 새 프레임은 통과"""
    t = [0.0]; c = Core(now=lambda: t[0])
    S = lambda ep, rip=False: c.on_state({'schema': SCHEMA, 'episode': ep, 'stop_requested': True, 'reset_in_progress': rip, 'policy_running': True})
    F = lambda: {'jpeg_t': t[0], 'jpeg_ep': c.episode, 'jpeg_reset': bool(c.reset_pending or (c.st or {}).get('reset_in_progress'))}
    assert cam_why(c, {'jpeg_t': 0.0, 'jpeg_ep': None, 'jpeg_reset': False}, 0.0).startswith('시뮬 상태 없음')
    S(1); f = F(); assert cam_why(c, f, t[0]) == ''                                 # 같은 회차·리셋 아님 → 보냄
    t[0] = 2.0; S(1, rip=True); assert cam_why(c, F(), t[0]) == '리셋 중'           # 리셋 중 받은 프레임
    t[0] = 3.0; S(2); assert 'episode' in cam_why(c, f, t[0])                        # 옛 회차 프레임(리셋 뒤에도 남은 sim['jpeg'])
    t[0] = 3.5; f2 = F(); assert 'episode' in cam_why(c, f2, t[0])                   # 바뀐 직후 1 s 안 도착 프레임
    t[0] = 4.6; S(2); assert 'episode' in cam_why(c, f2, t[0])                       # 그 프레임은 시간이 지나도 계속 거부
    f3 = F(); assert cam_why(c, f3, t[0]) == ''                                      # 1 s 지난 뒤 새 프레임은 통과
    t[0] = 6.0; assert cam_why(c, f3, t[0]).startswith('시뮬 상태 없음')             # 상태 끊김 1 s 넘음


def selftest_stopgen():
    """N1 잠금 세대(CAS): 잠그는 모든 일마다 +1(이미 잠겼어도), gen 다른 resume 거부·재시도 없음, gen 없는 옛 클라이언트 resume 은 그대로"""
    t = [0.0]; c = Core(now=lambda: t[0])
    S = lambda stop, ep=0, rip=False: c.on_state({'schema': SCHEMA, 'episode': ep, 'stop_requested': stop, 'reset_in_progress': rip, 'policy_running': True})
    S(True); g0 = c.stop_gen
    c.stop('b'); assert c.latch and c.stop_gen == g0 + 1                         # 이미 잠김 + 남의 STOP → 세대 +1(옛 latch boolean 은 흔적 0)
    assert c.take('a'); assert c.stop_gen == g0 + 1                              # take 는 세대 무관
    assert not c.resume('a', g0) and c.resume_pending is None and c.latch        # 확인 때 본 g0 → 거부
    assert c.resume('a', c.stop_gen) and c.resume_pending                        # 지금 세대 → 접수
    g = c.stop_gen; c.stop('b'); assert c.stop_gen == g + 1 and c.resume_pending is None and c.latch   # 접수 뒤 STOP → 재개 취소 + 세대 +1
    assert not c.resume('a', g)                                                  # 같은 옛 세대 재전송도 거부
    g = c.stop_gen; c.drop('a', 'x'); assert c.stop_gen == g + 1 and c.controller is None   # 조종권 해제 = 잠금
    g = c.stop_gen; c.drop('zz', 'x'); assert c.stop_gen == g                    # 남의 해제(조종권 없음)는 무관
    assert c.take('a'); g = c.stop_gen; assert c.reset_begin('a', True) and c.stop_gen == g + 1
    g = c.stop_gen; c.reset_done(True, 'ok'); assert c.stop_gen == g + 1          # 리셋 완료도 세대 +1 → 리셋 전 확인으로 재개 0
    g = c.stop_gen; t[0] += 0.1; S(True, ep=1); assert c.stop_gen == g + 1        # episode 변경
    g = c.stop_gen; assert c.resume('a', g); t[0] += 0.1; S(False, ep=1); assert not c.latch and c.stop_gen == g   # 정상 해제 = 세대 그대로
    g = c.stop_gen; t[0] += 0.1; S(True, ep=1); assert c.latch and c.stop_gen == g + 1   # 시뮬이 스스로 STOP
    g = c.stop_gen; c.busy_sim('지도 체험 시작'); assert c.stop_gen > g; c.sim_busy = ''
    assert c.take('a'); c.stop('a'); t[0] += 0.1; S(True, ep=1)
    assert c.resume('a') and c.resume_pending                                    # gen 없음 = 옛 클라이언트(따로 누르는 «STOP 해제») 그대로
    c.stop('a'); assert not c.resume('a', -1)


def selftest_extra():
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        m = Media(td); meta = m.photo(b'\xff\xd8x', {'episode': 3, 'x': 1.0})
        assert meta['url'].startswith('media/photos/') and meta['url'].endswith('.jpg') and '..' not in meta['url']
        assert (Path(td) / meta['url'][len('media/'):]).read_bytes() == b'\xff\xd8x'
        m.event({'t': '01:02:03', 'st': 'ok', 'text': 'a'})
        with open(Path(td) / 'events.jsonl', 'a') as f:
            f.write('깨진 줄\n')
        m.event({'t': '01:02:04', 'st': 'ok', 'text': 'b'})
        assert [e['text'] for e in m.tail('events.jsonl', 5)] == ['a', 'b'] and m.tail('none.jsonl', 5) == []
        # 공용 문서: 서버 ID·rev, 형식 검사, rev 충돌 409, 원자 쓰기 후 다시 읽어도 같음
        d = Docs(td); z = {'name': '금지1', 'type': '금지', 'pts': [[0, 0], [1, 0], [1, 1]]}
        c, r = d.apply({'op': 'put', 'kind': 'zone', 'id': None, 'doc': z}, 'A'); assert c == 200 and r['rev'] == 1 and r['new'], r
        zid = r['id']; assert d.d[zid]['by'] == 'A' and Docs(td).d == d.d and not (Path(td) / 'docs.tmp').exists()
        assert d.apply({'op': 'put', 'id': zid, 'rev': 1, 'doc': {**z, 'name': '금지2'}}, 'B')[0] == 200
        c, r = d.apply({'op': 'put', 'id': zid, 'rev': 1, 'doc': {**z, 'name': '늦은 수정'}}, 'A'); assert c == 409 and r['cur']['doc']['name'] == '금지2'
        fz, orig = time.localtime(), time.strftime   # 같은 초·같은 pid 로 다시 연 두 Docs(n=0 부터) — 기존 id 를 덮지 않는다
        time.strftime = lambda f, t=None: orig(f, fz)
        try:
            a_ = Docs(td).apply({'op': 'put', 'kind': 'zone', 'id': None, 'doc': z}, 'C')[1]['id']
            b_ = Docs(td).apply({'op': 'put', 'kind': 'zone', 'id': None, 'doc': z}, 'C')[1]['id']
        finally:
            time.strftime = orig
        assert a_ != b_ and {a_, b_, zid} <= set(Docs(td).d)
        for bad in [{**z, 'pts': [[0, 0], [1, 1]]}, {**z, 'pts': [[0, 0], [1, float('nan')], [1, 1]]}, {**z, 'pts': [[0, 0], [True, 0], [1, 1]]},
                    {**z, 'type': '위험'}, {**z, 'name': 'x' * 41}, {**z, 'extra': 1}, {'name': 'a'}, 'str']:
            assert d.apply({'op': 'put', 'kind': 'zone', 'id': None, 'doc': bad}, 'A')[0] == 400, bad
        assert d.apply({'op': 'put', 'kind': 'evil', 'id': None, 'doc': {}}, 'A')[0] == 400
        assert d.apply({'op': 'put', 'id': 'nope', 'rev': 1, 'doc': z}, 'A')[0] == 404
        n = {'photo': 'media/photos/20261013/a.jpg', 'cls': '확인', 'memo': ''}
        for bad in ['http://x/a.jpg', 'javascript:alert(1)', 'media/photos/20261013/../a.jpg', 'media/photos/2026/a.jpg', ['x']]:
            assert d.apply({'op': 'put', 'kind': 'note', 'id': None, 'doc': {**n, 'photo': bad}}, 'A')[0] == 400, bad
        for bad in [['확인'], {'a': 1}, None]:      # 목록·사전 값도 400(TypeError 500 아님)
            assert d.apply({'op': 'put', 'kind': 'note', 'id': None, 'doc': {**n, 'cls': bad}}, 'A')[0] == 400
        assert d.apply({'op': 'put', 'kind': ['zone'], 'id': None, 'doc': z}, 'A')[0] == 400
        assert d.apply({'op': 'put', 'kind': {'z': 1}, 'id': None, 'doc': z}, 'A')[0] == 400
        for rv_ in [True, 0, -1, '2', 2.0, None]:
            assert d.apply({'op': 'put', 'id': zid, 'rev': rv_, 'doc': z}, 'A')[0] == 400, rv_
        assert d.apply({'op': 'put', 'id': ['x'], 'rev': 1, 'doc': z}, 'A')[0] == 400
        assert d.apply({'op': 'put', 'kind': 'note', 'id': None, 'doc': n}, 'A')[0] == 200
        assert d.apply({'op': 'put', 'kind': 'note', 'id': None, 'doc': {**n, 'cls': '맞음'}}, 'A')[0] == 400
        tm = {'name': 't', 'desc': '', 'mods': [{'type': '사진', 'detail': '전방 1장'}]}
        assert d.apply({'op': 'put', 'kind': 'tmpl', 'id': None, 'doc': tm}, 'A')[0] == 200
        for bad in ({'type': '가스 측정', 'detail': ''}, {'type': 'AI 탐지', 'detail': ''}):   # 미연결 모듈은 저장 안 됨
            assert d.apply({'op': 'put', 'kind': 'tmpl', 'id': None, 'doc': {**tm, 'mods': [bad]}}, 'A')[0] == 400
        assert d.apply({'op': 'put', 'kind': 'tmpl', 'id': None, 'doc': {**tm, 'rules': []}}, 'A')[0] == 400
        wp = {'x': 1, 'y': 2, 'name': '계단 앞', 'mods': ['사진', '운영자 확인']}
        assert d.apply({'op': 'put', 'kind': 'mission', 'id': None, 'doc': {'name': 'm', 'tmpl': '', 'memo': '', 'wps': [wp]}}, 'A')[0] == 200
        assert d.apply({'op': 'put', 'kind': 'mission', 'id': None, 'doc': {'name': 'm', 'tmpl': '', 'memo': '', 'wps': [{**wp, 'mods': ['사진'] * 4}]}}, 'A')[0] == 400
        rw = {**wp, 'st': '미방문', 'at': '', 'why': '길 막힘', 'chk': '', 'photos': ['media/photos/20261013/a.jpg']}
        assert d.apply({'op': 'put', 'kind': 'run', 'id': None, 'doc': {'mode': '수동', 'mission': 'm1', 'tmpl': 't', 'name': 'm', 'status': '중단', 'started': 't', 'ended': 't', 'memo': '', 'wps': [rw]}}, 'A')[0] == 200
        assert d.apply({'op': 'put', 'kind': 'run', 'id': None, 'doc': {'mode': '수동', 'mission': 'm1', 'tmpl': 't', 'name': 'm', 'status': '중단', 'started': 't', 'ended': 't', 'memo': '', 'wps': [{**rw, 'chk': '맞음'}]}}, 'A')[0] == 400
        # 하나만: 같은 사진 분류를 두 기기가 동시에 새로 만들면 둘째는 409 + 기존 문서 → 그 id·rev 로 고침(중복 없음)
        c, r = d.apply({'op': 'put', 'kind': 'note', 'id': None, 'doc': {**n, 'cls': '보류'}}, 'B'); assert c == 409 and r['cur']['doc']['photo'] == n['photo'], r
        assert d.apply({'op': 'put', 'id': r['cur']['id'], 'rev': r['cur']['rev'], 'doc': {**n, 'cls': '보류'}}, 'B')[0] == 200
        assert [x['doc']['cls'] for x in d.d.values() if x['kind'] == 'note'] == ['보류']
        # 진행 중 수동 임무는 하나: 두 기기가 동시에 시작 → 둘째 409(기존 진행 run) · 끝낸 뒤엔 새로 시작 가능
        go = {'mode': '수동', 'mission': 'm1', 'tmpl': 't', 'name': 'm', 'status': '진행', 'started': 't', 'ended': '', 'memo': '', 'wps': [rw]}
        c1, r1 = d.apply({'op': 'put', 'kind': 'run', 'id': None, 'doc': go}, 'A'); c2, r2 = d.apply({'op': 'put', 'kind': 'run', 'id': None, 'doc': go}, 'B')
        assert c1 == 200 and c2 == 409 and r2['cur']['id'] == r1['id'] and sum(x['kind'] == 'run' and x['doc']['status'] == '진행' for x in d.d.values()) == 1
        assert d.apply({'op': 'put', 'id': r1['id'], 'rev': 1, 'doc': {**go, 'memo': '진행 중 수정'}}, 'A')[0] == 200     # 자기 자신 수정은 허용
        assert d.apply({'op': 'put', 'id': r1['id'], 'rev': 2, 'doc': {**go, 'status': '완료'}}, 'A')[0] == 200
        assert d.apply({'op': 'put', 'kind': 'run', 'id': None, 'doc': go}, 'B')[0] == 200
        # 쓰기 실패 주입: 메모리·rev·파일 모두 그대로(put·del)
        before, rv, raw = json.dumps(d.d), d.rev, (Path(td) / 'docs.json').read_text()
        real = d._write
        def boom(_): raise OSError('disk full')
        d._write = boom
        for m_ in [{'op': 'put', 'kind': 'zone', 'id': None, 'doc': z}, {'op': 'put', 'id': zid, 'rev': 2, 'doc': {**z, 'name': 'x'}}, {'op': 'del', 'id': zid, 'rev': 2}]:
            try:
                d.apply(m_, 'A'); assert False, '예외가 나야 함'
            except OSError:
                pass
            assert json.dumps(d.d) == before and d.rev == rv and (Path(td) / 'docs.json').read_text() == raw
        d._write = real
        assert d.apply({'op': 'del', 'id': zid, 'rev': 2}, 'A')[0] == 200 and zid not in d.d and d.rev == rv + 1
        # 깨진 파일: 사용 불가 표시, 원본 그대로, 쓰기 503
        ok1 = {'id': 'z1', 'kind': 'zone', 'rev': 1, 'by': 'A', 'at': 't', 'doc': z}
        for junk in ['{깨짐', '[1,2]', '{"a": {"id": "b"}}'] + [json.dumps({'z1': {**ok1, **bad}}, ensure_ascii=False) for bad in
                     ({'doc': {}}, {'rev': 0}, {'by': None}, {'at': 3}, {'doc': {**z, 'type': '위험'}}, {'kind': 'note'})]:   # 겉 키만 맞고 속이 틀린 판도 사용 불가
            (Path(td) / 'docs.json').write_text(junk)
            b_ = Docs(td); assert b_.broken and b_.d == {} and b_.apply({'op': 'put', 'kind': 'zone', 'id': None, 'doc': z}, 'A')[0] == 503
            assert (Path(td) / 'docs.json').read_text() == junk
    from urllib.parse import quote
    assert actor_from_header(quote('tester · 휴대폰')) == 'tester · 휴대폰' and actor_from_header('') == ''
    assert actor_from_header('%FF%FE') == '관문 기기(이름 해독 실패)' and actor_from_header('휴대폰') == '관문 기기(이름 해독 실패)'
    assert actor_from_header(quote('a\nb' + 'x' * 99)) == 'ab' + 'x' * 46 and actor_from_header('%0A') == '관문 기기'
    ok = '{"schema":"v2_session/1","result":"starting","ends_at":"02:30"}'
    assert parse_session('로그\n' + ok, 0) == ('starting', '종료 예정 02:30')
    assert parse_session('{"schema":"v2_session/1","result":"already_running","reason":"active"}', 3)[0] == 'already_running'
    for bad in ['', 'x', '{"schema":"other","result":"ready"}', '{"schema":"v2_session/1","result":"yay"}']:
        assert parse_session(bad, 1)[0] == 'failed', bad
    t = [0.0]; s_ = SimStart(None, lambda: t[0]); assert s_.refuse(False).startswith('RL 래퍼 미설정')
    s_ = SimStart('/x', lambda: t[0]); assert s_.refuse(False) == '기존 평지 체험 사용 가능 횟수 조회 중'   # 첫 조회 전 = 조회 중(허용 아님)
    G = {'schema': 'v2_session/1', 'result': 'idle', 'ledger_used': 7, 'ledger_max': 8}
    s_.session, s_.sess_t, s_.polled = dict(G), t[0], True; assert s_.refuse(False) == '' and s_.refuse(True)   # 기준 7/8 신선 → 허용, 시뮬 켜짐은 기존 거부
    assert s_.state(False) == {**s_.state(False), 'ok': True, 'ledger': {'used': 7, 'max': 8}, 'last': None}
    # 기존 체험 원장(읽기만): 소진이면 거부(날짜 초기화 아님). 미확인(형식·schema·max·범위·오래됨·조회 실패)도 거부 — 0·소진으로 단정 안 함
    s_.session = {**G, 'ledger_used': 8}; assert s_.ledger() == {'used': 8, 'max': 8} and s_.refuse(False).startswith('기존 평지 체험 사용 가능 횟수 소진(8/8)')
    st_ = s_.state(False); assert st_['ok'] is False and st_['ledger'] == {'used': 8, 'max': 8}
    s_.busy = True; assert s_.refuse(False) == '시작 요청 처리 중'; s_.busy = False                   # 기존 거부 순서 우선
    UNK = '기존 평지 체험 사용 가능 횟수 확인 못 함 — 잠시 뒤 다시 확인'
    for k, v in [('ledger_used', '8'), ('ledger_used', True), ('ledger_used', 9), ('ledger_used', -1), ('ledger_max', 9), ('ledger_max', 8.0), ('schema', 'x'), ('ledger_used', None)]:
        s_.session = {**G, k: v}; assert s_.ledger() is None and s_.refuse(False) == UNK and s_.state(False)['ok'] is False and s_.state(False)['ledger'] is None, (k, v)
    s_.session = dict(G); t[0] += 16; assert s_.ledger() is None and s_.refuse(False) == UNK               # 오래된 조회
    s_.session, s_.sess_t = None, None; assert s_.refuse(False) == UNK                                     # 조회 실패
    s_.session, s_.sess_t = dict(G), t[0]; assert s_.refuse(False) == ''                                   # 다음 폴 성공 → 자동 회복(표시만)
    with tempfile.TemporaryDirectory() as td_:                                                          # 실제 poll 경로: 형식 틀림·실패 = 미확인 → 거부
        w_ = Path(td_) / 'request_session.sh'; w_.write_text('touch "$(dirname "$0")/CALLED"\n'); ss_ = Path(td_) / 'session_status.sh'
        for out in ['echo \'{"schema":"v2_session/1","result":"idle","ledger_used":8,"ledger_max":8}\'', 'echo \'{"schema":"v2_session/1","result":"idle","ledger_used":"7","ledger_max":8}\'', 'exit 3', 'echo 깨짐']:
            ss_.write_text(out + '\n'); p_ = SimStart(str(w_), lambda: t[0]); p_.poll(); assert p_.refuse(False), out
        ss_.write_text('echo \'{"schema":"v2_session/1","result":"idle","ledger_used":7,"ledger_max":8}\'\n'); p_ = SimStart(str(w_), lambda: t[0]); p_.poll(); assert p_.refuse(False) == ''
        assert not (Path(td_) / 'CALLED').exists()                                                      # 조회만 — 래퍼 호출 0
    t[0] = 0.0
    s_.session, s_.sess_t = dict(G), 60.0; s_.last = 0.0; t[0] = 60.0; assert s_.refuse(False).startswith('방금'); t[0] = s_.sess_t = 120.1; assert s_.refuse(False) == ''
    s_.busy = True; assert s_.refuse(False) == '시작 요청 처리 중'
    s_.busy = False; s_.session = {'result': 'starting'}; assert s_.refuse(False).startswith('시뮬 세션') and s_.state(False)['session']['result'] == 'starting'
    s_.session = dict(G); assert s_.refuse(False) == ''


# ---------------------------------------------------------------- 저장 지도(읽기만) — docs/CONTRACT-maps-sim-stop.md 3·4절
# <maps_root>/<building_id>/<floor_id>/<map_version>/{map.pgm, map.yaml, meta.json}. 쓰기는 RL 구동기(/v2_map/save)만
# world 마다 건물 키가 따로(단층 v5_single ≠ 2층 건물 v5) — 같은 GT 원본을 써도 자산 부모 폴더는 분리
# 층·버전·meta 키는 RL 정본 map-20261014/MAP-CONTRACT.md §1·§4(live_map.meta_check)와 같게
MAP_WORLDS = {'v5_single': ('v5_single', ('f1',)), 'v5_building': ('v5', ('l1', 'l2')), 'rooms_a': ('rooms_a', ('f1',))}
MAP_FLOORS = {b: fl for b, fl in MAP_WORLDS.values()}
MAP_VER = re.compile(r'\d{8}-\d{6}-e\d+|gt-\d{8}')          # 저장본 / 사전 GT 래스터
MAP_REASON = ('user_save', 'pre_reset_autosave', 'gt_raster_copy')
MAP_DIM, MAP_PNG_MAX, MAP_PGM_MAX = 2000, 512 * 1024, 4_100_000


class MapErr(ValueError):
    pass


def read_pgm(b):
    """P5·maxval 255 → (w, h, 화소 bytes). 그 밖은 MapErr"""
    tok, i = [], 0
    while len(tok) < 4:
        while i < len(b) and b[i:i + 1].isspace():
            i += 1
        if b[i:i + 1] == b'#':
            while i < len(b) and b[i:i + 1] != b'\n':
                i += 1
            continue
        j = i
        while j < len(b) and not b[j:j + 1].isspace():
            j += 1
        if j == i:
            raise MapErr('PGM 머리 잘림')
        tok.append(b[i:j]); i = j
    if tok[0] != b'P5' or not all(t.isdigit() for t in tok[1:]):
        raise MapErr('PGM 형식 아님(P5 만)')
    w, h, mx = map(int, tok[1:])
    if mx != 255 or not (1 <= w <= MAP_DIM and 1 <= h <= MAP_DIM):
        raise MapErr(f'PGM 크기·최대값 범위 밖({w}×{h}, {mx})')
    px = b[i + 1:]
    if len(px) != w * h:
        raise MapErr(f'PGM 화소 수 불일치({len(px)} ≠ {w * h})')
    return w, h, px


def png_gray(w, h, px, rgb=False):
    """8비트 PNG(표준 라이브러리만, IHDR/IDAT/IEND 만 — gAMA·sRGB·iCCP 없음 = 브라우저가 값 안 바꿈). 행 순서는 PGM 그대로(위 = y 큰 쪽). rgb = 칸당 3바이트"""
    ch = lambda t, d: struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d))
    n = w * (3 if rgb else 1)
    raw = b''.join(b'\0' + px[y * n:(y + 1) * n] for y in range(h))
    return b'\x89PNG\r\n\x1a\n' + ch(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2 if rgb else 0, 0, 0, 0)) + ch(b'IDAT', zlib.compress(raw, 9)) + ch(b'IEND', b'')


def read_pgm16(b, w, h):
    """height.pgm: P5 maxval 65535(큰 끝), 크기 = 지도와 같아야 함 → RGB 화소(R=hi·G=lo·B=0). 그 밖은 MapErr"""
    head = b'P5\n%d %d\n65535\n' % (w, h)
    if not b.startswith(head) or len(b) != len(head) + 2 * w * h:
        raise MapErr('높이 PGM 형식·크기가 지도와 다름(P5 16비트)')
    px = bytearray(3 * w * h); px[0::3] = b[len(head)::2]; px[1::3] = b[len(head) + 1::2]
    return bytes(px)


def height_meta(j, meta, map_sha):
    """height.json(RL HEIGHT-CONTRACT v2_map_height/1) 검사 → 화면 요약. 지도 meta·map.pgm sha 와 하나라도 다르면 MapErr"""
    e, fin_ = j.get('encoding') if isinstance(j, dict) else None, lambda x: type(x) in (int, float) and math.isfinite(x)
    st, band = j.get('stats') if isinstance(j, dict) else None, j.get('band_rel_m') if isinstance(j, dict) else None
    if not isinstance(j, dict) or j.get('schema') != 'v2_map_height/1':
        raise MapErr('높이 meta 형식 아님')
    if j.get('map_source') != 'gt_raster' or j.get('height_source') != 'gt_geometry' or j.get('sensor') is not False:
        raise MapErr('높이 출처가 GT 기하 아님(SLAM·센서 높이는 받지 않음)')
    if any(j.get(k) != meta[k] for k in ('world_id', 'building_id', 'floor_id', 'map_version', 'map_source', 'width', 'height')) or j.get('map_sha256_pgm') != map_sha:
        raise MapErr('높이 레이어가 이 지도와 다름(이름·크기·map sha)')
    if not (fin_(j.get('resolution')) and abs(j['resolution'] - meta['resolution']) <= 1e-9 and isinstance(j.get('origin'), list) and len(j['origin']) == 3
            and all(fin_(a) and abs(a - b) <= 1e-6 for a, b in zip(j['origin'], meta['origin']))):     # 숫자로 비교(-20 vs -20.0)
        raise MapErr('높이 격자 해상도·원점이 지도와 다름')
    if not (isinstance(e, dict) and e.get('type') == 'pgm16_be' and type(e.get('unknown')) is int and e['unknown'] == 0 and e.get('step_m') == 0.001
            and e.get('rel_m') == '(v-1)/1000 - 1.0' and isinstance(e.get('row0'), str) and e['row0'].split(' ')[0] == 'y_max'    # 행 순서 = map.pgm 과 같음(뒤집은 선언 거부)
            and fin_(j.get('floor_z')) and isinstance(band, list) and len(band) == 2 and all(fin_(x) for x in band) and band[0] < band[1] and isinstance(st, dict)
            and fin_(st.get('rel_min')) and fin_(st.get('rel_max')) and isinstance(j.get('sha256_height_pgm'), str)):
        raise MapErr('높이 인코딩·값 범위 밖')
    return {**{k: meta[k] for k in ('building_id', 'floor_id', 'map_version', 'width', 'height', 'resolution', 'origin')}, 'map_sha256_pgm': map_sha,
            'floor_z': j['floor_z'], 'band_rel_m': band, 'height_source': 'gt_geometry', 'sensor': False,
            'rel_min': st['rel_min'], 'rel_max': st['rel_max']}


def yaml_check(txt, meta):
    """map.yaml 의 resolution·origin 이 meta 와 같은지(RL live_map.meta_check 와 같은 파싱·허용오차). 아니면 MapErr"""
    y = dict(l.split(':', 1) for l in txt.splitlines() if ':' in l)
    try:
        r, o = float(y.get('resolution', 'nan')), json.loads(y.get('origin', '[]').strip())
        ok = abs(r - meta['resolution']) <= 1e-9 and len(o) == 3 and all(abs(a - b) <= 1e-6 for a, b in zip(o, meta['origin']))
    except (ValueError, TypeError):
        ok = False
    if not ok:
        raise MapErr('map.yaml resolution·origin 이 meta 와 다름')


def map_meta(m, b, f, v):
    """meta.json 검사 → 화면에 보낼 요약 dict. RL live_map.meta_check 와 같은 규칙(yaml 은 yaml_check). 어긋나면 MapErr"""
    fin = lambda x: type(x) in (int, float) and math.isfinite(x)
    hx = lambda x: isinstance(x, str) and re.fullmatch(r'[0-9a-f]{64}', x)
    need = ('schema', 'world_id', 'building_id', 'floor_id', 'epoch', 'map_version', 'map_source', 'map_frame', 'resolution', 'origin',
            'width', 'height', 'saved_sim_t', 'saved_wall', 'reason', 'sha256_pgm')
    if not isinstance(m, dict) or m.get('schema') != 'v2_map_meta/1' or not all(k in m for k in need):
        raise MapErr('meta 형식 아님(필수 키 없음)')
    if not all(isinstance(m[k], str) for k in ('world_id', 'building_id', 'floor_id', 'map_version', 'map_source')):
        raise MapErr('meta 이름 칸이 문자열 아님')
    if (m['building_id'], m['floor_id'], m['map_version']) != (b, f, v):
        raise MapErr('meta 의 건물·층·버전이 폴더와 다름')
    wd = MAP_WORLDS.get(m['world_id'])
    if not wd or wd[0] != b or f not in wd[1]:
        raise MapErr('meta world_id 가 건물·층과 맞지 않음')
    src, ep, o = m['map_source'], m['epoch'], m['origin']
    ok_ep = (src == 'slam' and type(ep) is int and ep >= 1) or (src == 'gt_raster' and ep is None)
    if (not ok_ep or m['map_frame'] != 'map' or m['reason'] not in MAP_REASON or not fin(m['resolution']) or m['resolution'] <= 0
            or not (isinstance(o, list) and len(o) == 3 and all(fin(x) for x in o))
            or not all(type(m[k]) is int and 1 <= m[k] <= MAP_DIM for k in ('width', 'height'))
            or not hx(m['sha256_pgm']) or not (m['saved_sim_t'] is None or fin(m['saved_sim_t']))
            or (src == 'gt_raster' and not (isinstance(m.get('source_pgm'), str) and hx(m.get('source_sha256'))))):
        raise MapErr('meta 값 범위 밖')
    return {k: m[k] for k in ('world_id', 'building_id', 'floor_id', 'map_version', 'map_source', 'epoch', 'resolution', 'origin', 'width', 'height', 'saved_sim_t')}


class MapStore:
    """저장 지도 읽기만. 이름은 허용목록·정규식, 경로는 루트 안(심볼릭 링크로 밖으로 나가면 거부). 버전 폴더는 바뀌지 않으므로 결과 캐시"""

    def __init__(self, root):
        self.root = Path(root).resolve() if root else None
        self.cache, self.sha = {}, {}       # ponytail: 최근 8장 FIFO — 지도 수가 많아지면 LRU 로

    def _dir(self, b, f, v):
        if not self.root:
            raise MapErr('지도 폴더 미설정')
        if b not in MAP_FLOORS or f not in MAP_FLOORS[b] or not (isinstance(v, str) and MAP_VER.fullmatch(v)):
            raise MapErr('지도 이름이 허용목록·형식 밖')
        d = (self.root / b / f / v).resolve()
        if d.parent.parent.parent != self.root or not d.is_dir():
            raise MapErr('지도 없음')
        return d

    def listing(self):
        out, skipped = [], 0
        for b, fl in MAP_FLOORS.items():
            for f in fl:
                base = self.root / b / f if self.root else None
                for d in sorted(base.iterdir()) if base and base.is_dir() else []:
                    try:                    # 목록에도 끝까지 검증된 것만(sha·크기·PNG 상한). ponytail: 지도 수십 장 넘으면 meta 만 보고 get 때 검증
                        out.append({k: x for k, x in self.get(b, f, d.name).items() if k != 'png'})
                    except Exception:           # 지도 하나가 이상해도 다른 지도 목록은 유지(이상한 것만 뺌)
                        skipped += 1
        return out, skipped

    def get(self, b, f, v):
        key = (b, f, v)
        if key in self.cache:
            return self.cache[key]
        d = self._dir(b, f, v)
        try:
            m = json.loads((d / 'meta.json').read_text()); meta = map_meta(m, b, f, v); yaml_check((d / 'map.yaml').read_text(), meta)
            if (d / 'map.pgm').stat().st_size > MAP_PGM_MAX:
                raise MapErr('PGM 너무 큼')
            raw = (d / 'map.pgm').read_bytes()
        except OSError:
            raise MapErr('지도 파일 읽기 실패')
        except ValueError as e:
            raise e if isinstance(e, MapErr) else MapErr('meta JSON 아님')
        if hashlib.sha256(raw).hexdigest() != m['sha256_pgm']:
            raise MapErr('PGM sha256 이 meta 와 다름')
        w, h, px = read_pgm(raw)
        if (w, h) != (meta['width'], meta['height']):
            raise MapErr('PGM 크기가 meta 와 다름')
        png = png_gray(w, h, px)
        if len(png) > MAP_PNG_MAX:
            raise MapErr(f'PNG {len(png)} B > 상한 {MAP_PNG_MAX} B')
        r = {**meta, 'png': base64.b64encode(png).decode()}
        self._put(key, r); self.sha[key] = m['sha256_pgm']        # 검증 끝난 map.pgm sha(높이 레이어 대조용, 작아서 안 지움)
        return r

    def _put(self, key, r):
        if len(self.cache) >= 8:
            self.cache.pop(next(iter(self.cache)))
        self.cache[key] = r

    def _file(self, d, name):
        """버전 폴더 안의 보통 파일만(심볼릭 링크로 밖·다른 버전으로 새면 거부). 없으면 None"""
        p = (d / name).resolve()
        if p.parent != d:
            raise MapErr(f'{name} 이 버전 폴더 밖을 가리킴')
        return p if p.is_file() else None

    def height(self, b, f, v):
        """같은 버전 폴더의 height.{json,pgm}(GT 기하 높이, 센서 아님) → 요약 + RGB PNG base64. 지도 검증을 먼저 통과해야 함. 없으면 MapErr('높이 레이어 없음')"""
        key = (b, f, v, 'h')
        if key in self.cache:
            return self.cache[key]
        meta = self.get(b, f, v); d = self._dir(b, f, v); sha = self.sha[(b, f, v)]
        hj, hp = self._file(d, 'height.json'), self._file(d, 'height.pgm')
        if not hj or not hp:
            raise MapErr('높이 레이어 없음(이 지도는 높이 원본 미제공)')
        try:
            if hj.stat().st_size > 64 * 1024 or hp.stat().st_size > 2 * MAP_PGM_MAX:
                raise MapErr('높이 파일 너무 큼(JSON 64 KB · PGM 상한)')
            j = json.loads(hj.read_text()); raw = hp.read_bytes()
        except OSError:
            raise MapErr('높이 파일 읽기 실패')
        except ValueError as e:
            raise e if isinstance(e, MapErr) else MapErr('높이 meta JSON 아님')
        hm = height_meta(j, meta, sha)
        if hashlib.sha256(raw).hexdigest() != j['sha256_height_pgm']:
            raise MapErr('높이 PGM sha256 이 meta 와 다름')
        png = png_gray(meta['width'], meta['height'], read_pgm16(raw, meta['width'], meta['height']), rgb=True)
        if len(png) * 4 // 3 > MAP_PNG_MAX:                       # 응답 상한 = base64 기준 512 KB
            raise MapErr(f'높이 PNG {len(png)} B — 상한 넘음, 표시 안 함')
        r = {**hm, 'png': base64.b64encode(png).decode()}
        self._put(key, r)
        return r


# ---------------------------------------------------------------- 실시간 지도·지도 체험 시작·저장 — docs/CONTRACT-maps-sim-stop.md 7~9절
# RL 정본 map-20261014/MAP-CONTRACT.md §4·§5: /v2_map/status(JSON 1 Hz) · /v2_map/map(OccupancyGrid, transient_local) · /v2_map/save(Trigger)
LIVE_STALE, POSE_AGE, POSE_SIM_GAP, STAMP_EPS, HOLD_MAX = 3.0, 2.0, 1.0, 1e-3, 40.0
# UPD_MAX: SLAM 정상 확장 중 status 가 표시 격자보다 앞설 때(새 격자 변환·도착 대기) 표시 격자를 «갱신 중»으로 둘 수 있는 상한.
# 시계 = 그 그림을 검증·표시한 시각(반복 status 로 연장 0). slam 발행 5 s + 변환(1500² ≈3 s) + status 1 Hz 를 덮고 한 주기 놓침은 덮지 않음 — 보정 손잡이(≤15 s)
UPD_MAX = 12.0
POSE_SRC = {('slam', 'slam'): 'slam_tf', ('static', 'gt_raster'): 'gt_identity'}     # (mode, map_source) → 허용 pose 출처. static+저장 slam = 없음
NULL_KO = {'saved_slam_map_not_localized': '저장 SLAM 지도 — 위치 추정 없음', 'tf_stale': '위치 변환 오래됨', 'tf_lookup_failed': '위치 변환 없음'}
# 연결 건물 층 context(RL CONN-UI-9 초안 connected.MAP_NULL_REASONS) — 결속 안 되면 RL 이 status.map·pose_map=null + 이 코드
MAP_NULL_KO = {'floor_transit': '층 이동 중 — 지도·위치 숨김', 'context_mismatch': '층 지도 결속 안 맞음 — 지도·위치 숨김', 'no_grid_yet': '이 층 지도 아직 없음',
               'saved_map_other_floor': '저장 지도는 기동 층 것 — 지금 다른 층이라 지도·위치 숨김', 'gt_check_failed': '층 GT 지도 검사 실패 — 지도 숨김',
               'slam_none': '이 층 SLAM 없음', 'slam_waiting_floor': 'SLAM 이 층 확정 기다림', 'slam_activating': 'SLAM 켜는 중', 'slam_activate_failed': 'SLAM 켜기 실패',
               'slam_restore_failed': '층 SLAM 되살리기 실패', 'slam_restore_unverified': '층 SLAM 되살림 미확인 — 지도 숨김', 'slam_stopped': 'SLAM 멈춤',
               'slam_blocked': 'SLAM 막힘', 'slam_halted': 'SLAM 중단', 'slam_error': 'SLAM 오류'}
FLOOR_HOLD = '층 이동 중·층 미확인 — 지도·위치 숨김(조종·STOP 은 그대로)'
FLOOR_MAPWAIT = '현재층 확정 · 그 층 지도 대기'   # on_floor + current_floor 있음 + 표시 지도 층(floor_id) null — 현재층은 current_floor 가 정본
CELL_OK = bytes(range(101)) + b'\xff'                                                # OccupancyGrid 칸 허용값 -1·0~100(int8 바이트)
GRAY = bytes(254 if v <= 25 else 0 if 65 <= v <= 100 else 205 for v in range(256))  # int8 바이트(음수 = 128~255) → 자유 254·벽 0·모름 205
fin = lambda x: type(x) in (int, float) and math.isfinite(x)
safe_txt = lambda s, n=80: re.sub(r'/\S*', '<경로>', re.sub(r'[\x00-\x1f\x7f]', '', s))[:n] if isinstance(s, str) else ''   # 호스트 경로 지움


def grid_png(g):
    """받은 격자 dict(frame, w, h, res, origin[x,y,yaw], data=int8 바이트, 아래 행부터) → (PNG, '') | (None, 이유). 무거운 일이라 IOLoop·ROS 스레드 밖"""
    w, h, o, q = g.get('w'), g.get('h'), g.get('origin'), g.get('q')
    if g.get('frame') != 'map':
        return None, f'격자 frame 이 map 아님({safe_txt(g.get("frame"), 20)})'
    if not (type(w) is int and type(h) is int and 1 <= w <= MAP_DIM and 1 <= h <= MAP_DIM) or len(g.get('data') or b'') != w * h:
        return None, '격자 크기 범위 밖·화소 수 불일치'
    if not (fin(g.get('res')) and g['res'] > 0 and isinstance(o, (list, tuple)) and len(o) == 3 and all(fin(x) for x in o)
            and isinstance(q, (list, tuple)) and len(q) == 4 and all(fin(x) for x in q) and abs(math.hypot(*q) - 1) <= 1e-3):
        return None, '격자 해상도·원점(x,y,z)·자세(쿼터니언) 형식 틀림'
    if abs(q[0]) > 1e-6 or abs(q[1]) > 1e-6 or abs(math.atan2(2 * q[3] * q[2], 1 - 2 * q[2] * q[2])) > 1e-6:
        return None, '원점 회전 있는 격자는 그리지 않음(yaw 0 만)'
    if g['data'].translate(None, CELL_OK):
        return None, '격자 칸 값이 -1·0~100 밖'
    px = g['data'].translate(GRAY)
    png = png_gray(w, h, b''.join(px[y * w:(y + 1) * w] for y in range(h - 1, -1, -1)))   # 위 행부터(PGM·PNG 순서)
    return (png, '') if len(png) <= MAP_PNG_MAX else (None, f'PNG {len(png)} B > 상한')


class LiveMap:
    """실시간 지도 결속(서버가 정본). 격자는 이 조건이 전부 맞을 때만 표시: status 3 s 안·형식 유효·map_accepting·map_error 없음·
    status.map.epoch == epoch·격자 w/h/res/stamp == status.map·격자 수신 ≥ 결속 키를 처음 본 시각. 키 = (world, building, floor, mode, source, version, epoch).
    키가 바뀌거나 조건이 깨지면 표시 격자·마커 즉시 버림(옛 epoch 늦은 격자는 수신 시각으로 거부). 앱 RESET·Gazebo 끄기 요청은 키가 바뀔 때까지 «리셋 중».
    on_status/on_grid = ROS 스레드, commit = 변환 일꾼, view/png = 웹 스레드. 자체 lock(조종 lock 과 따로)"""

    def __init__(self, now=time.monotonic):
        self.now, self.lock, self.wake = now, threading.Lock(), threading.Event()
        self.st = self.st_t = self.key = self.key_t = self.cand = self.pending = self.shown = self.hold_t = None
        self.hold_key, self.seq, self.grid_why, self.st_sim = None, 0, '', None

    @staticmethod
    def key_of(d):
        """status → (결속 키, '') | (None, 이유)"""
        if not isinstance(d, dict) or d.get('schema') != 'v2_map_status/1':
            return None, '지도 상태 형식 모름'
        w, b, f, mode, src, ver, ep, fr = (d.get(k) for k in KEY_NAMES)
        wd = MAP_WORLDS.get(w) if isinstance(w, str) else None
        if fr is not None and not (type(fr) is int and fr >= 0):
            return None, '층 context 세대(floor_rev) 형식 틀림'
        if fr is not None and f is None and d.get('floor_state') in ('transit', 'unknown') and wd and wd[0] == b:
            return None, FLOOR_HOLD                         # 연결 건물 층 이탈 — 형식 정상, 키 없음(격자·위치 버림)
        if (fr is not None and f is None and d.get('floor_state') == 'on_floor' and wd and wd[0] == b and d.get('current_floor') in wd[1]
                and d.get('map') is None):                  # 층은 확정, 그 층 지도는 아직(표시 지도 층 null) — 층 이동 중과 구분
            mr = d.get('map_null_reason')
            return None, FLOOR_MAPWAIT + (f' · {MAP_NULL_KO[mr]}' if isinstance(mr, str) and mr in MAP_NULL_KO else '')
        if not wd or wd[0] != b or f not in wd[1]:
            return None, '지형·건물·층이 허용표 밖'
        if mode not in ('slam', 'static') or src not in ('slam', 'gt_raster') or (mode == 'slam' and src != 'slam'):
            return None, '지도 모드·출처 모름'
        if (mode == 'slam' and ver is not None) or (mode == 'static' and not (isinstance(ver, str) and MAP_VER.fullmatch(ver))):
            return None, '지도 버전 형식 틀림'
        if d.get('map_frame') != 'map' or not (type(ep) is int and ep >= 1):
            return None, '지도 frame·epoch 형식 틀림'
        sl = d.get('slam_lifecycle')                        # 선택 칸 형식(틀리면 상태 전체를 모름으로 — view·NULL_KO·ROS 스레드가 죽지 않게)
        if (type(d.get('map_accepting')) is not bool or not (d.get('sim_t') is None or fin(d.get('sim_t')))
                or any(d.get(x) is not None and not isinstance(d.get(x), str) for x in ('map_error', 'pose_map_null_reason', 'map_null_reason', 'floor_state', 'floor_reason'))
                or any(d.get(x) is not None and not isinstance(d.get(x), dict) for x in ('map', 'pose_map', 'last_save', 'scan', 'slam_lifecycle'))
                or (sl is not None and not isinstance(sl.get('state'), (str, type(None))))):
            return None, '지도 상태 선택 칸 형식 틀림'
        m = d.get('map')
        if fr is not None and isinstance(m, dict) and (m.get('floor_id') != f or m.get('floor_rev') != fr):
            return None, MAP_NULL_KO['context_mismatch']    # 상태 스냅샷 안에서 지도 층 context ≠ 현재 context
        return (w, b, f, mode, src, ver, ep, fr), ''

    def _drop(self):
        self.shown = self.pending = None

    def _why(self, t):          # 지금 status 로 격자를 보일 수 없는 이유('' = 보일 수 있음). 이유가 있으면 표시 격자 버림
        d = self.st
        why = ('지도 상태 미수신' if d is None else f'지도 상태 {t - self.st_t:.0f} s 끊김' if t - self.st_t > LIVE_STALE
               else self.key_of(d)[1] or ('리셋 중 — 이전 지도·위치 버림, 새 지도 기다림' if d.get('map_accepting') is not True
                                         or (self.hold_t is not None and t - self.hold_t < HOLD_MAX) else '')
               or (f'지도 오류 · {safe_txt(d.get("map_error"))}' if d.get('map_error') is not None else '')
               or ('상태의 지도 epoch 가 현재 epoch 와 다름' if isinstance(d.get('map'), dict) and d['map'].get('epoch') != self.key[6] else ''))
        if why:
            self._drop()
        if why.startswith('지도 상태') and d is not None and t - self.st_t > LIVE_STALE:
            self.key = None                                 # 끊김 = 세션 경계 — 다시 오면 새 키(새 수신 시각)부터
        return why

    def _shown_why(self, t):    # 표시 중 격자가 지금 status 와 아직 맞나('' = 맞음). 안 맞으면 새 올바른 격자 전까지 격자·마커 0
        s, m, k = self.shown, (self.st or {}).get('map'), self.key
        if s is None:
            return ''
        s['upd'] = False
        if not isinstance(m, dict) or s['key'] != k or m.get('epoch') != k[6]:
            return '상태에 이 지도 없음 — 새 격자 기다림'
        res = m.get('resolution', m.get('res'))
        if not (fin(res) and res > 0) or abs(res - s['res']) > 1e-4:
            return '상태의 지도 크기·해상도가 바뀜 — 새 격자 기다림'
        if not all(type(m.get(x)) is int and 0 < m[x] <= 100000 for x in ('width', 'height')):   # 엄격 int(True==1·1.0==1 같은 값으로 «같은 크기» 통과 0)
            return '상태의 지도 크기 형식 이상 — 새 격자 기다림'
        if (k[3] == 'slam' or k[7] is not None) and not fin(m.get('stamp_sim')):
            return '상태의 지도 stamp 형식 이상 — 새 격자 기다림'
        same_wh = (s['w'], s['h']) == (m.get('width'), m.get('height'))
        stamp_ok = not (k[3] == 'slam' or k[7] is not None) or (fin(m.get('stamp_sim')) and abs(m['stamp_sim'] - s['stamp']) <= STAMP_EPS)
        if same_wh and stamp_ok:
            return ''
        # ── S2 유한 보유: 같은 K·slam·status 의 지도 메타가 형식 정상이고 표시 격자보다 «앞선» stamp 일 때만(정상 확장·새 격자 변환 대기).
        #    시한 = 이 그림 검증 시각 + UPD_MAX(반복 status 로 연장 0). 마커는 view 에서 끔(옛 그림 + 새 위치 조합 0). 그 밖(역행·형식 이상)은 즉시 버림
        if k[3] == 'slam' and m['stamp_sim'] > s['stamp'] + STAMP_EPS:   # (w/h·res·stamp 형식은 위에서 확인)
            if t - s['t'] <= UPD_MAX:
                s['upd'] = True
                return ''
            return f'새 격자가 {UPD_MAX:.0f} s 안 안 옴 — 새 격자 기다림'
        return '상태의 지도 크기·해상도가 바뀜 — 새 격자 기다림' if not same_wh else '상태의 지도 stamp 가 바뀜 — 새 격자 기다림'

    def _check(self, t):        # 상태 수준 이유 → 표시 격자 대조. 이유가 있으면 표시 격자 버림(대기 격자는 아직 앞선 것만 남김)
        why = self._why(t)
        if not why and self.shown is not None:
            why = self._shown_why(t)
            if why:
                self.shown = None; self.grid_why = why
        if self.pending is not None and not self._ahead(self.pending[0]):
            self.pending = None                             # 이미 지난 stamp 의 대기 격자는 다시 맞을 일 없음
        return why

    def _ahead(self, g):        # 대기 격자가 아직 status 보다 앞선 slam 격자인가
        m = (self.st or {}).get('map')
        return bool(self.key and (self.key[3] == 'slam' or self.key[7] is not None) and isinstance(m, dict) and fin(m.get('stamp_sim')) and fin(g.get('stamp')) and g['stamp'] > m['stamp_sim'] + STAMP_EPS)

    def _bind(self, g, t):      # 격자 g 가 지금 status 의 현재 epoch 지도인가 → '' | 이유
        m, k = (self.st or {}).get('map'), self.key
        if not isinstance(m, dict) or k is None:
            return '상태에 지도 없음(이번 epoch 첫 지도 전)'
        if m.get('epoch') != k[6]:
            return '상태의 지도 epoch 가 현재 epoch 와 다름'
        if g['t'] < self.key_t:
            return '이전 결속 키 때 받은 격자(버림)'
        res = m.get('resolution', m.get('res'))
        if (g['w'], g['h']) != (m.get('width'), m.get('height')) or not fin(res) or abs(res - g['res']) > 1e-4:
            return '격자 크기·해상도가 상태와 다름'
        if (k[3] == 'slam' or k[7] is not None) and not (fin(m.get('stamp_sim')) and fin(g['stamp']) and abs(m['stamp_sim'] - g['stamp']) <= STAMP_EPS):   # 연결 static 도 stamp(층 확정 시각) 비교 — l1·l2 GT 같은 크기
            return '격자 stamp 가 상태와 다름 — 다음 상태 기다림'       # static 은 stamp 비교 안 함(RL 이 파일 지도를 stamp 없이 냄) — 저장 meta 대조로
        return ''

    def on_status(self, d):
        with self.lock:
            t = self.now(); self.st, self.st_t = d, t
            k = self.key_of(d)[0]
            prev = self.st_sim; self.st_sim = d.get('sim_t') if isinstance(d, dict) and fin(d.get('sim_t')) else None
            if k is not None and k == self.key and prev is not None and self.st_sim is not None and self.st_sim < prev - 1.0:
                self.key = None                             # 같은 키인데 sim 시계 되감김 = 새 기동(episode 1 재사용) — 새 키로
            if k != self.key:
                self.key, self.key_t = k, t; self._drop()
                if k != self.hold_key:
                    self.hold_t = None                      # 키가 바뀌면(새 epoch·세션) 리셋 표시 해제
            if not self._why(t) and self.pending and self.pending[2] == self.key and not self._bind(self.pending[0], t):
                self._show(*self.pending[:2])               # 앞선 격자: 보관 당시 K 와 같고 메타가 맞을 때만 같은 lock 안 원자 교체
            self._check(t)

    def on_grid(self, g):       # ROS 스레드: 최신 1장만 둔다(변환은 일꾼)
        with self.lock:
            g['t'] = self.now(); self.cand = g
        self.wake.set()

    def take(self):
        with self.lock:
            g, self.cand = self.cand, None
            return g

    def static_key(self):       # 일꾼이 lock 밖에서 저장 meta 를 읽을 키(static 일 때만)
        with self.lock:
            return self.key if self.key and self.key[3] == 'static' else None

    def commit(self, g, png, why, key=None):
        """key = static 저장 meta 를 대조한 키(그 사이 키가 바뀌었으면 거부)"""
        with self.lock:
            t = self.now()
            why = (why or self._why(t) or ('지도 결속 키가 바뀜(버림)' if self.key and self.key[3] == 'static' and key != self.key else '')
                   or self._bind(g, t))
            if png and (why.startswith('격자 stamp') or why.startswith('격자 크기') and self._ahead(g)):
                self.pending = (g, png, self.key)           # 상태가 한 박자 늦은 경우(S1: 크기·원점이 바뀐 앞선 격자 포함) — 보관 당시 K 와 함께, 다음 status 에서 다시 결속
            elif not why:
                self._show(g, png)
            self.grid_why = why

    def _show(self, g, png):
        self.seq += 1; self.pending = None; self.grid_why = ''
        self.shown = {'key': self.key, 'seq': self.seq, 'w': g['w'], 'h': g['h'], 'res': g['res'], 'origin': list(g['origin']), 'stamp': g['stamp'],
                      'png': base64.b64encode(png).decode(), 't': self.now(), 'upd': False}   # t = 검증·표시 시각(S2 보유 시한의 시계)

    def hold(self):             # 앱 RESET·Gazebo 끄기 요청: 응답 전에 격자·마커 버림, 키가 바뀔 때까지(최대 HOLD_MAX)
        with self.lock:
            self.hold_t, self.hold_key = self.now(), self.key; self._drop()

    def release(self):          # RESET 실패 응답
        with self.lock:
            self.hold_t = None

    def png(self):
        with self.lock:
            self._check(self.now()); s = self.shown
            return None if s is None else {'seq': s['seq'], 'epoch': s['key'][6], 'world_id': s['key'][0], 'floor_id': s['key'][2], 'png': s['png']}

    def view(self):
        """화면에 보낼 요약(경로·kids·maps_root 없음). st: off|stale|unknown|reset|wait|ok|bad"""
        with self.lock:
            t, d = self.now(), self.st
            why = self._check(t)
            if d is None:
                return {'st': 'off', 'bound': False, 'why': why}
            k, kwhy = self.key_of(d)
            fh = kwhy in (FLOOR_HOLD, MAP_NULL_KO['context_mismatch']) or kwhy.startswith(FLOOR_MAPWAIT)   # 층 이탈·context 불일치 = 형식 정상 대기(모름 아님)
            st = ('stale' if t - self.st_t > LIVE_STALE else 'wait' if fh else 'unknown' if kwhy else 'reset' if why.startswith('리셋') else 'wait' if why.endswith('기다림')
                  else 'bad' if why else 'ok' if self.shown else 'wait')
            mn = MAP_NULL_KO.get(d.get('map_null_reason')) if d.get('map') is None else None
            v = {'st': st, 'bound': self.key is not None and not self._why(t), 'why': why or ('' if self.shown else mn or self.grid_why or '이번 epoch 지도 기다림(slam 5 s·static 10 s 마다 발행)'),   # bound = 상태 수준만(Views.cur_key 와 같은 조건) — 격자 보유 만료·형상 거부로 follow/points 끄지 않음
                 'age_s': round(t - self.st_t, 1)}
            fr, fs_ = d.get('floor_rev'), d.get('floor_state')
            if (k or fh) and type(fr) is int and fr >= 0 and isinstance(d.get('world_id'), str) and d['world_id'] in MAP_WORLDS:   # 연결 건물 층 context(RL CONN-UI-9) — 형식 맞고 결속 또는 정상 층 대기일 때만
                fl = MAP_WORLDS[d['world_id']][1]; cf = d.get('current_floor')
                v['floor'] = {'rev': fr, 'state': fs_ if fs_ in ('on_floor', 'transit', 'unknown') else 'unknown',
                              'current': cf if cf in fl and fs_ == 'on_floor' else None, 'reason': safe_txt(d.get('floor_reason'), 40)}
            hx = lambda x: x if isinstance(x, str) and re.fullmatch(r'[0-9a-f]{64}', x) else None   # 전체 3D 결속 칸(RL CONN-UI-5 초안) — 형식 틀리면 None
            w_, b_, ep_ = d.get('world_id'), d.get('building_id'), d.get('epoch')
            if k is None and fh and isinstance(w_, str) and w_ in MAP_WORLDS and MAP_WORLDS[w_][0] == b_ and type(ep_) is int and ep_ >= 1:
                v.update(world_id=w_, building_id=b_, epoch=ep_)   # K 없는 정상 층 대기: 신원 칸만(현재층 탭·전체 3D 결속용) — grid·pose·그림은 계속 없음
            if k or 'world_id' in v:
                sf, gm = d.get('spawn_floor'), d.get('geom')
                v['spawn_floor'] = sf if sf in MAP_FLOORS.get(v['building_id'] if k is None else k[1], ()) else None
                v['world_src_sha256'] = hx(d.get('world_src_sha256'))
                v['geom'] = {'schema': gm['schema'], 'sha256': hx(gm.get('sha256'))} if isinstance(gm, dict) and gm.get('schema') == 'v2_building_geom/1' and hx(gm.get('sha256')) else None
            if k is None:
                return v
            v.update(zip(KEY_NAMES, k))
            sc, ls, sl = d.get('scan'), d.get('last_save'), d.get('slam_lifecycle')
            v['sim_t'] = d['sim_t'] if fin(d.get('sim_t')) else None
            v['scan'] = {'n': sc['n'], 'age_s': sc.get('age_s') if fin(sc.get('age_s')) else None} if isinstance(sc, dict) and type(sc.get('n')) is int else None
            v['slam'] = safe_txt(sl.get('state'), 24) if isinstance(sl, dict) and sl.get('epoch') == k[6] else None
            v['last_save'] = ({'ok': ls.get('ok') is True, 'map_version': ls['map_version'] if isinstance(ls.get('map_version'), str) and MAP_VER.fullmatch(ls['map_version']) else None,
                               'reason': safe_txt(ls.get('reason')), 'epoch': ls.get('epoch') if type(ls.get('epoch')) is int else None} if isinstance(ls, dict) else None)
            s = self.shown
            v['grid'] = None if s is None else {**{k_: s[k_] for k_ in ('seq', 'w', 'h', 'res', 'origin', 'upd')}, 'stamp': s['stamp'] if fin(s['stamp']) else None}
            p, want = d.get('pose_map'), POSE_SRC.get(k[3:5])
            ok_p = (s is not None and not s['upd'] and isinstance(p, dict) and want and p.get('source') == want and all(fin(p.get(x)) for x in ('x', 'y', 'yaw', 'stamp_sim'))
                    and fin(d.get('sim_t')) and abs(d['sim_t'] - p['stamp_sim']) <= POSE_SIM_GAP and t - self.st_t <= POSE_AGE)
            v['pose'] = {'x': p['x'], 'y': p['y'], 'yaw': p['yaw'], 'source': want} if ok_p else None
            pr = d.get('pose_map_null_reason') if isinstance(d.get('pose_map_null_reason'), str) else None
            v['pose_why'] = '' if ok_p else '지도 갱신 중(새 격자 받는 중) — 위치 표시 잠시 끔' if s is not None and s['upd'] else ((MAP_NULL_KO.get(pr) or '지도 없음') if s is None else (NULL_KO.get(pr) or MAP_NULL_KO.get(pr))   # 격자 없음: 연결 건물 구체 이유 먼저
                                             or ('이 지도는 위치 표시 안 함(저장 SLAM 지도)' if not want else '위치 형식 틀림·오래됨'))
            return v

    def sim_span(self):         # 보조 뷰 시각 대조: (마지막 status sim_t, 그 뒤 흐른 벽시계만큼 더한 추정 상한) | None. status 는 1 Hz 라 영상이 최대 ~1 s 앞설 수 있음
        with self.lock:
            return None if self.st_sim is None or self.st_t is None else (self.st_sim, self.st_sim + max(0.0, self.now() - self.st_t))

    def cur_key(self):          # 보조 뷰(점군·3인칭) 결속용: 격자를 보일 수 있는 status 일 때만 키, 아니면 None(리셋·끊김·형식 틀림)
        with self.lock:
            return self.key if self.st is not None and not self._why(self.now()) else None

    def prod(self):             # 보조 뷰 producer 자기 진단(/v2_map/status 의 points_view·follow_cam) → 앱 빈칸 이유. 3 s 안 status 만, 허용 코드만(그 밖 'unknown')
        with self.lock:
            d = self.st
            if not isinstance(d, dict) or self.st_t is None or self.now() - self.st_t > LIVE_STALE:
                return {'points': None, 'follow': None}
            out = {}
            for k, src in (('points', 'points_view'), ('follow', 'follow_cam')):
                x = d.get(src)
                r, n, en = (x.get('last_reason'), x.get('n_pub'), x.get('enabled')) if isinstance(x, dict) else (None, None, None)
                out[k] = None if not isinstance(x, dict) else {
                    'reason': r if r in PROD_REASONS[k] else None if r is None else 'unknown',
                    'n_pub': n if type(n) is int and n >= 0 else None, 'enabled': en if type(en) is bool else None}
            return out


# 보조 관제 뷰(RL view-20261014/VIEW-CONTRACT.md §1·§2, FIX1): /v2_map/points_view(JSON) · /v2_map/follow_cam(JSON, JPEG base64).
# 최신 1개만 들고 있다가 앱이 view_get 으로 끌어간다(≤2 Hz, status·조종 WS push 에 싣지 않음). 결속 키가 지금 지도와 다르면 버림.
PV_SCHEMA, PV_MAX_N, PV_MAX_RAW, VIEW_MIN_DT, VIEW_STALE, PV_MAX_ABS = 'v2_map/points_view/1', 4000, 80000, 0.2, 3.0, 3000.0   # 좌표 |m| 상한(앱 0.1 m 칸 키 범위 안)
VIEW_SIM_EPS = 0.5    # 뷰 stamp_sim 이 sim_t 추정 상한(마지막 1 Hz status sim_t + 그 뒤 벽시계)보다 이만큼 넘게 앞서면 시각 이상
FC_SCHEMA, FC_MAX, FC_MAX_RAW = 'v2_map/follow_cam/1', 64000, 90000
KEY_NAMES = ('world_id', 'building_id', 'floor_id', 'mode', 'map_source', 'map_version', 'epoch', 'floor_rev')   # floor_rev = 연결 건물 층 context 세대(없는 world 는 None)
PROD_REASONS = {   # RL map-20261014/points_view.py REASONS·FOLLOW_REASONS 와 같은 코드(앱 문구 표는 ui/src/app/OpsQuad.tsx)
    'points': ('ok', 'no_cloud', 'reset', 'floor_transit', 'stale_epoch', 'sim_t_unknown', 'future_stamp', 'not_localized', 'bad_cloud', 'tf_lookup_failed', 'tf_stale', 'empty', 'encode_error'),
    'follow': ('ok', 'no_frame', 'reset', 'floor_transit', 'stale_epoch', 'sim_t_unknown', 'no_stamp', 'future_stamp', 'out_of_order', 'bad_image', 'too_large')}


class Views:
    def __init__(self, key_fn, now=time.monotonic, sim_fn=lambda: None):   # sim_fn: (lo, hi) = LiveMap.sim_span() | None
        self.key_fn, self.now, self.sim_fn, self.lock = key_fn, now, sim_fn, threading.Lock()
        self.p = {'last': None, 'seq': 0, 't': None, 'why': '', 'key': None, 'drop': 0}
        self.f = {'last': None, 'seq': 0, 't': None, 'why': '', 'key': None, 'drop': 0}

    def _gate(self, s, k, t):   # 키가 바뀌면 들고 있던 것 버림 · 입력 과속(< VIEW_MIN_DT) 버림 → 받아도 되나
        if k != s['key']:
            s.update(last=None, key=k, t=None)
        if k is None:
            s['why'] = '지도 세션 없음·리셋 중'; return False
        if s['t'] is not None and t - s['t'] < VIEW_MIN_DT:
            s['drop'] += 1; return False
        return True

    @staticmethod
    def points_why(d, k):
        """points_view JSON(dict) → (보관 dict, '') | (None, 이유). k = 지금 지도 결속 키"""
        if not isinstance(d, dict) or d.get('schema') != PV_SCHEMA or d.get('encoding') != 'xyz_f32le_b64' or d.get('frame') != 'map':
            return None, '점군 형식·frame 모름'
        if tuple(d.get(x) for x in KEY_NAMES) != k:
            return None, '점군이 지금 지도(world·층·모드·epoch)와 다름'
        n, seq, bp = d.get('n'), d.get('seq'), d.get('base_pose_map')
        if type(n) is not int or not 1 <= n <= PV_MAX_N or type(seq) is not int or not finite(d.get('stamp_sim')):
            return None, '점군 n·seq·stamp 형식 틀림'
        if not isinstance(bp, dict) or not all(finite(bp.get(x)) for x in ('x', 'y', 'z', 'yaw')) or any(abs(bp[x]) > PV_MAX_ABS for x in ('x', 'y', 'z')):
            return None, '점군 로봇 자세 형식 틀림'
        try:
            raw = base64.b64decode(d.get('xyz'), validate=True)
        except Exception:
            return None, '점군 xyz 해독 실패'
        if len(raw) != n * 12 or not all(math.isfinite(v) and abs(v) <= PV_MAX_ABS for v in struct.unpack(f'<{3 * n}f', raw)):
            return None, '점군 xyz 길이·값 틀림(n×12·유한·범위)'
        return {'seq': seq, 'stamp_sim': d['stamp_sim'], 'n': n, 'xyz': d['xyz'], 'truncated': d.get('truncated') is True,
                'base_pose_map': {x: bp[x] for x in ('x', 'y', 'z', 'yaw')}, **dict(zip(KEY_NAMES, k))}, ''

    def on_points(self, txt):   # ROS 스레드
        k, t = self.key_fn(), self.now()
        with self.lock:
            s = self.p
            if not self._gate(s, k, t):
                return
            if not isinstance(txt, str) or len(txt) > PV_MAX_RAW:
                s['why'] = '점군 메시지 크기 상한 초과'; return
            try:
                d = json.loads(txt)
            except Exception:
                d = None
            v, why = self.points_why(d, k)
            last = s['last']
            if v and last and (v['seq'] <= last['seq'] or v['stamp_sim'] < last['stamp_sim']):
                v, why = None, '옛 점군(seq·stamp 역행)'
            if v and (tw := self._time_why(v['stamp_sim'])) and tw[0] == 'bad':
                v, why = None, tw[1]                        # 미래 시각은 들이지 않음(캐시 오염 → 정상 프레임 영구 거부 방지)
            if not v:
                s['why'] = why; return
            s.update(last=v, t=t, why=''); s['seq'] += 1

    @staticmethod
    def follow_why(d, k):
        """follow_cam JSON(VIEW-CONTRACT §2) → (보관 dict, '') | (None, 이유)"""
        if (not isinstance(d, dict) or d.get('schema') != FC_SCHEMA or d.get('frame') != 'follow_cam' or d.get('source') != 'gazebo_render'
                or d.get('format') != 'jpeg'):
            return None, '3인칭 형식·출처 모름'
        if tuple(d.get(x) for x in KEY_NAMES) != k:
            return None, '3인칭이 지금 지도(world·층·모드·epoch)와 다름'
        w, h, seq = d.get('width'), d.get('height'), d.get('seq')
        if not (type(w) is int and type(h) is int and 1 <= w <= 4096 and 1 <= h <= 4096 and type(seq) is int and finite(d.get('stamp_sim'))):
            return None, '3인칭 크기·seq·stamp 형식 틀림'
        try:
            raw = base64.b64decode(d.get('data_b64'), validate=True)
        except Exception:
            return None, '3인칭 영상 해독 실패'
        if not (100 < len(raw) <= FC_MAX and raw[:2] == b'\xff\xd8'):
            return None, '3인칭 영상 형식 틀림(JPEG·64 000 B 이하)'
        return {'seq': seq, 'stamp_sim': d['stamp_sim'], 'width': w, 'height': h, 'jpeg': d['data_b64'], **dict(zip(KEY_NAMES, k))}, ''

    def on_follow(self, txt):   # ROS 스레드: Gazebo 렌더 3인칭(JSON). 같은 키 안에서 seq·stamp 엄격 증가만
        k, t = self.key_fn(), self.now()
        with self.lock:
            s = self.f
            if not self._gate(s, k, t):
                return
            if not isinstance(txt, str) or len(txt) > FC_MAX_RAW:
                s['why'] = '3인칭 메시지 크기 상한 초과'; return
            try:
                d = json.loads(txt)
            except Exception:
                d = None
            v, why = self.follow_why(d, k)
            last = s['last']
            if v and last and (v['seq'] <= last['seq'] or v['stamp_sim'] <= last['stamp_sim']):
                v, why = None, '옛 3인칭 프레임(seq·stamp 역행·중복)'
            if v and (tw := self._time_why(v['stamp_sim'])) and tw[0] == 'bad':
                v, why = None, tw[1]
            if not v:
                s['why'] = why; return
            s.update(last=v, t=t, why=''); s['seq'] += 1

    def _one(self, s, t, k):
        if s['key'] != k:       # 지도 키가 바뀌었는데 새 메시지가 아직 없으면 옛것은 버린다
            s.update(last=None, key=k, t=None)
        age = None if s['t'] is None else round(t - s['t'], 1)
        st = ('off' if s['last'] is None and not s['why'] else 'bad' if s['last'] is None
              else 'stale' if age > VIEW_STALE else 'ok')
        why = s['why'] or ('받은 것 없음' if st == 'off' else '오래됨' if st == 'stale' else '')
        if st == 'ok':          # 시뮬 시각 대조(기준시계 = live_map status sim_t, 1 Hz): 모름 → 안 줌 · 추정 상한+0.5 s 넘게 앞섬 → 이상 · 마지막 sim_t 보다 3 s 넘게 옛것 → 오래됨
            st, why = self._time_why(s['last']['stamp_sim']) or ('ok', '')
        return {'st': st, 'why': why, 'seq': s['last']['seq'] if s['last'] else None, 'age_s': age}   # 앱이 바뀐 때만 끌어가게(점군 = 메시지 seq)

    def _time_why(self, ss):    # → None(정상) | (st, 이유). hi = sim_t + status 뒤 흐른 벽시계(RTF ≤ 1 가정, RTF > 1 은 미검증)
        sp = self.sim_fn()
        if not sp or not all(finite(x) for x in sp):
            return 'stale', '현재 시뮬 시각 모름'
        if ss > sp[1] + VIEW_SIM_EPS:
            return 'bad', '뷰 시각이 현재 시뮬 추정보다 미래'
        if sp[0] - ss > VIEW_STALE:
            return 'stale', '시뮬 시각 기준 오래됨'
        return None

    def view(self):
        k, t = self.key_fn(), self.now()
        with self.lock:
            return {'follow': self._one(self.f, t, k), 'points': self._one(self.p, t, k)}

    def get(self, what):        # → (dict, '') | (None, 이유). 오래된 것은 안 줌
        k, t = self.key_fn(), self.now()
        with self.lock:
            s = self.p if what == 'points' else self.f if what == 'follow' else None
            if s is None:
                return None, '보기 종류 모름'
            v = self._one(s, t, k)
            return (dict(s['last'], age_s=v['age_s']), '') if v['st'] == 'ok' else (None, v['why'] or '없음')


def selftest_views():
    t, key, sim = [100.0], [('rooms_a', 'rooms_a', 'f1', 'slam', 'slam', None, 3, None)], [1.0]
    lag = [0.0]   # status 뒤 흐른 시간(추정 상한 = sim + lag)
    V = Views(lambda: key[0], now=lambda: t[0], sim_fn=lambda: (sim[0], sim[0] + lag[0]) if finite(sim[0]) else None)
    def pv(seq, n=2, k=None, xyz=None, **kw):
        k = k or key[0]
        d = {'schema': PV_SCHEMA, 'encoding': 'xyz_f32le_b64', 'frame': 'map', 'seq': seq, 'stamp_sim': float(seq), 'n': n, 'voxel_m': 0.1,
             'base_pose_map': {'x': 1.0, 'y': 2.0, 'z': 0.3, 'yaw': 0.5}, **dict(zip(KEY_NAMES, k)),
             'xyz': base64.b64encode(xyz if xyz is not None else struct.pack(f'<{3 * n}f', *([0.5] * 3 * n))).decode()}
        d.update(kw); return json.dumps(d)
    assert V.view()['points']['st'] == 'off' and V.get('points')[0] is None
    V.on_points(pv(1)); x, why = V.get('points'); assert x and x['seq'] == 1 and x['n'] == 2 and x['epoch'] == 3 and not why, why
    assert V.view()['points']['seq'] == 1 and V.view()['points']['st'] == 'ok'
    t[0] += 0.05; V.on_points(pv(2)); assert V.get('points')[0]['seq'] == 1 and V.p['drop'] == 1        # 과속 입력 버림
    t[0] += 0.3; V.on_points(pv(1)); assert V.get('points')[0]['seq'] == 1 and '옛' in V.p['why']       # seq 역행
    t[0] += 0.3; V.on_points(pv(3, k=key[0][:6] + (2,))); assert V.get('points')[0]['seq'] == 1 and '지도' in V.p['why']   # 옛 epoch
    for bad in (pv(4, n=2, xyz=struct.pack('<6f', 0, 0, 0, 0, float('nan'), 0)), pv(4, n=2, xyz=struct.pack('<6f', 0, 0, 0, 1e20, 0, 0)),
                pv(4, base_pose_map={'x': 1e9, 'y': 2, 'z': 0, 'yaw': 0}), pv(4, n=3, xyz=struct.pack('<6f', *[0.5] * 6)), pv(4, n=4001), pv(4, frame='odom'),
                pv(4, base_pose_map={'x': 1, 'y': 2, 'z': 0, 'yaw': None}), 'x' * (PV_MAX_RAW + 1), '{bad'):
        t[0] += 0.21; V.on_points(bad); assert V.get('points')[0]['seq'] == 1, (V.get('points')[0]['seq'], bad[-160:])
    t[0] += 0.3; sim[0] = 5.0; V.on_points(pv(5)); assert V.get('points')[0]['seq'] == 5
    t[0] += VIEW_STALE + 0.1; assert V.view()['points']['st'] == 'stale' and V.get('points')[0] is None   # 오래되면 안 줌
    t[0] += 0.3; sim[0] = 6.0; V.on_points(pv(6)); key[0] = key[0][:6] + (4,)                                          # 새 epoch → 옛것 즉시 버림
    assert V.get('points')[0] is None and V.view()['points']['st'] == 'off'
    old = key[0]; key[0] = None; t[0] += 0.3; V.on_points(pv(7, k=old)); assert V.get('points')[0] is None and V.view()['points']['why'].startswith('지도 세션 없음')
    key[0] = ('rooms_a', 'rooms_a', 'f1', 'slam', 'slam', None, 5, None)
    def fc(seq, k=None, stamp=None, data=b'\xff\xd8' + b'0' * 200, **kw):
        d = {'schema': FC_SCHEMA, 'frame': 'follow_cam', 'source': 'gazebo_render', 'format': 'jpeg', 'width': 320, 'height': 240, 'seq': seq,
             'stamp_sim': float(seq) if stamp is None else stamp, **dict(zip(KEY_NAMES, k or key[0])), 'data_b64': base64.b64encode(data).decode()}
        d.update(kw); return json.dumps(d)
    sim[0] = 2.0; V.on_follow(fc(1, data=b'\x89PNG' + b'0' * 200)); assert V.get('follow')[0] is None and 'JPEG' in V.f['why']
    t[0] += 0.3; V.on_follow(fc(2)); f = V.get('follow')[0]
    assert f and f['seq'] == 2 and base64.b64decode(f['jpeg'])[:2] == b'\xff\xd8' and f['epoch'] == 5 and f['world_id'] == 'rooms_a'
    for bad in (fc(1), fc(3, stamp=2.0), fc(3, k=key[0][:6] + (4,)), fc(3, source='web'), fc(3, width=0), fc(3, stamp=float('inf')),
                fc(3, data=b'\xff\xd8' + b'0' * FC_MAX), fc(3, data_b64='!!'), 'x' * (FC_MAX_RAW + 1)):
        t[0] += 0.21; V.on_follow(bad); assert V.get('follow')[0]['seq'] == 2, (V.f['why'], bad[-120:])
    t[0] += 0.21; sim[0] = 3.0; V.on_follow(fc(3)); assert V.get('follow')[0]['seq'] == 3 and V.view()['follow']['seq'] == 3
    for sv, st_, w in ((None, 'stale', '모름'), (float('nan'), 'stale', '모름'), (3.6, 'ok', ''), (2.4, 'bad', '미래'), (6.1, 'stale', '오래됨')):   # 시뮬 시각 대조 반례
        sim[0] = sv; v = V.view()['follow']; assert v['st'] == st_ and w in v['why'] and (V.get('follow')[0] is None) == (st_ != 'ok'), (sv, v)
    sim[0] = 3.0; assert V.get('follow')[0]['seq'] == 3
    t[0] += 0.21; V.on_follow(fc(4, stamp=100.0)); assert V.get('follow')[0]['seq'] == 3 and '미래' in V.f['why']        # 미래 프레임 = 캐시 안 함
    t[0] += 0.21; V.on_follow(fc(4, stamp=3.3)); assert V.get('follow')[0]['seq'] == 4                                   # 다음 정상 프레임 회복
    lag[0] = 0.9; t[0] += 0.21; V.on_follow(fc(5, stamp=4.3)); assert V.get('follow')[0]['seq'] == 5                    # 1 Hz status 지연: sim_t+0.9 s+0.5 안이면 받음
    lag[0] = 0.0; assert V.view()['follow']['st'] == 'bad'                                                               # 같은 프레임도 추정 상한(3.0+0.5)을 넘으면 이상(보이지 않음)
    key[0] = key[0][:6] + (6,); assert V.get('follow')[0] is None
    assert V.get('bogus')[0] is None
    print('views selftest ok')



def static_meta_why(g, key, get):
    """static 격자 ↔ 저장 지도 meta(같은 건물·층·버전): 크기·해상도·원점 x,y 가 같아야. get = MapStore.get. → '' | 이유"""
    if key is None:
        return ''
    try:
        m = get(key[1], key[2], key[5])
    except Exception as e:
        return f'저장 지도 meta 확인 불가 · {safe_txt(str(e), 40)}'
    if m['world_id'] != key[0] or m['map_source'] != key[4]:
        return '저장 지도 meta 의 world·출처가 상태와 다름'
    if (g['w'], g['h']) != (m['width'], m['height']) or abs(g['res'] - m['resolution']) > 1e-9 or any(abs(a - b) > 1e-6 for a, b in zip(g['origin'][:2], m['origin'][:2])):
        return '격자가 저장 지도 meta(크기·해상도·원점)와 다름'
    return ''


def map_args(m, has_ver, follow_ok=False):
    """map_start 요청 → (start_map.sh 인자, 원장 키, '') | (None, None, 이유). has_ver(b, f, v) = 저장 지도 폴더 있음.
    follow_cam(엄격 bool, 기본 false) = true 면 마지막 토큰 'follow-cam' 1개(RL VIEW-CONTRACT §2) — 래퍼가 지원할 때(follow_ok)만"""
    w, f, mode, v = (m.get(k) for k in ('world_id', 'floor_id', 'mode', 'map_version'))
    fc = m.get('follow_cam', False)
    if type(fc) is not bool:
        return None, None, '외부 3인칭 값은 true/false 만'
    if fc and not follow_ok:
        return None, None, '이 서버의 지도 체험 래퍼는 외부 3인칭 카메라를 지원하지 않음'
    wd = MAP_WORLDS.get(w) if isinstance(w, str) else None
    if not wd or f not in wd[1]:
        return None, None, '지형·층이 허용표 밖'
    if mode not in ('slam', 'static'):
        return None, None, '모드는 slam 또는 static'
    if mode == 'slam' and v is not None:
        return None, None, 'slam 은 지도 버전 없이 시작'
    if mode == 'static' and not (isinstance(v, str) and MAP_VER.fullmatch(v) and has_ver(wd[0], f, v)):
        return None, None, 'static 은 저장 지도 버전을 골라야 함(목록에 있는 것)'
    return [w, f, mode] + ([v] if mode == 'static' else []) + (['follow-cam'] if fc else []), f'{w}/{f}', ''


class MapStart:
    """«지도 체험 시작» — RL start_map.sh 를 사용자가 확인 뒤 누를 때만 한 번(허용 인자만). 상태는 같은 폴더 map_status.sh(읽기만).
    단일 unit 이라 기존 «시뮬 시작»과 busy·쿨다운을 같이 쓴다(SimStart.busy·last). 원장은 지도 체험 것만(기존 체험 원장과 섞지 않음)"""

    LEDGER_ID, LEDGER_MAX, FRESH = 'map-20261014', 4, 15.0      # RL map_status.sh 정본 상수 · 조회 결과 신선도(폴 2~5 s)
    KEYS = {f'{w}/{f}' for w, (_, fl) in MAP_WORLDS.items() for f in fl}

    def __init__(self, wrapper, now=time.monotonic, status_name='map_status.sh', prefix=(), ux=False):
        p = Path(wrapper) if wrapper else None
        ok = bool(p and p.is_file() and p.with_name(status_name).is_file())
        self.wrapper = str(p) if ok else None
        self.status_sh = str(p.with_name(status_name)) if ok else None
        self.prefix, self.ux = tuple(prefix), ux      # ux = ux_start.sh map … · ux_status.sh — 원장·키 검사 대신 usage 결속
        self.now, self.session, self.sess_t, self.last = now, None, None, None

    def poll(self):
        d = read_session(self.status_sh) if self.status_sh else None
        self.session = d if d and d.get('result') in ('running', 'starting', 'idle') else None
        self.sess_t = self.now() if self.session else None

    def fresh(self):
        return self.session is not None and self.sess_t is not None and 0 <= self.now() - self.sess_t <= self.FRESH

    def ledger(self):
        """지도 체험 원장(map_status.sh) — ledger_id·max 정본 일치, 0≤used≤max, 키는 허용표·중복 0·개수 = used(키당 1회). 하나라도 아니면 None(미확인)"""
        s = self.session if self.fresh() and not self.ux else {}
        u, mx, ks = s.get('map_ledger_used'), s.get('map_ledger_max'), s.get('map_ledger_keys_used')
        ok = (s.get('ledger_id') == self.LEDGER_ID and type(mx) is int and mx == self.LEDGER_MAX and type(u) is int and 0 <= u <= mx
              and isinstance(ks, list) and all(isinstance(x, str) and x in self.KEYS for x in ks) and len(set(ks)) == len(ks) == u)
        return {'used': u, 'max': mx, 'keys': list(ks)} if ok else None

    def unit_why(self):
        """같은 unit(fh-v2-live) 이 확실히 꺼져 있고 요청 진행 없음 → '' . 미확인·deactivating·켜짐 → 이유"""
        if not self.fresh():
            return '지도 체험 상태 조회 미확인(오래됨·실패)'
        s = self.session; a = unit_state(s)
        if a is None:
            return 'Gazebo unit 상태 미확인'
        if a not in UNIT_OFF:
            return f'Gazebo unit {a} — 끈 뒤 다시(세계 변경 = 끄고 새로 시작)'
        if s.get('request_in_progress') is not False:
            return '시작 요청 진행 중(RL)' if s.get('request_in_progress') is True else '시작 요청 진행 여부 미확인'
        return ''

    def usage(self):
        if not self.ux:
            return 'experiment'
        return 'user_experience' if self.fresh() and ux_usage(self.session) else None

    def runner(self):           # 지금 unit 을 쓰는 쪽: 'live_map'(지도 체험) | 'live_v2'(기존 체험) | 'ux_flat'(사용자 평지) | None(꺼짐·미확인)
        s = self.session if self.fresh() else {}
        return s.get('runner') if s.get('runner') in ('live_map', 'live_v2', 'ux_flat') and unit_state(s) in UNIT_LIVE else None

    def refuse(self, key, gated, starter, stopping, sim_live, holder_other):
        if not self.wrapper:
            return '지도 체험 시작 경로 미설정'
        if not gated:
            return '로그인한 기기에서만(관문 경유)'
        if starter.busy:
            return '시작 요청 처리 중'
        if stopping:
            return 'Gazebo 종료 처리 중'
        if sim_live or any((x or {}).get('result') in ('running', 'starting') for x in (starter.session, self.session)):
            return 'Gazebo 가 이미 켜짐 — 끈 뒤 다시(세계 변경 = 끄고 새로 시작)'
        if holder_other:
            return f'{holder_other} 조종 중 — 그 기기에서 STOP·반납한 뒤'
        uw = self.unit_why()
        if uw:
            return uw
        if self.ux:
            if self.usage() is None:
                return '사용자 체험 경로 확인 못 함(상태가 «사용자 체험 · 횟수 제한 없음»이 아님)'
            left = SimStart.COOL - (starter.now() - starter.last)
            return f'방금 요청함 — {left:.0f} s 뒤 다시' if left > 0 else ''
        lg = self.ledger()
        if lg is None:
            return '지도 체험 원장 미확인'
        if lg['used'] >= lg['max']:
            return f'지도 체험 원장 소진 {lg["used"]}/{lg["max"]}'
        if key and key in lg['keys']:
            return f'{key} 는 이미 사용(지형·층마다 1회)'
        left = SimStart.COOL - (starter.now() - starter.last)
        return f'방금 요청함 — {left:.0f} s 뒤 다시' if left > 0 else ''

    def follow_ok(self):        # 사용자 체험 래퍼(ux_start.sh)가 map 의 마지막 토큰 follow-cam 을 받는 판인가(파일 읽기만 — 최종 판정은 래퍼 종료 코드)
        try:
            return bool(self.ux and self.wrapper and b'follow-cam' in Path(self.wrapper).read_bytes())
        except OSError:
            return False

    def state(self, gated, starter, stopping, sim_live, holder_other):
        why = self.refuse(None, gated, starter, stopping, sim_live, holder_other)
        s = (self.session or {}) if self.fresh() else {}
        return {'ok': not why, 'why': why, 'busy': starter.busy, 'ledger': self.ledger(), 'last': self.last, 'usage_scope': self.usage(), 'follow_cam_ok': self.follow_ok(),
                'session': {k: s.get(k) for k in ('result', 'runner', 'world_id', 'floor_id', 'map_mode', 'remaining_s')} if s else None}


MAP_EXIT = {'ready': 0, 'starting': 0, 'already_running': 3, 'resource_blocked': 4, 'budget_exhausted': 5, 'bad_args': 2, 'failed': 1}   # start_map.sh 머리말


def map_result(out, code):
    """start_map.sh 출력 → (결과, 글). 결과와 종료 코드가 머리말 표와 안 맞으면 실패(성공 채택 0)"""
    res, extra = parse_session(out, code)
    if res in MAP_EXIT and MAP_EXIT[res] != code:
        return 'failed', f'래퍼 결과({res})와 종료 코드({code}) 모순'
    return res, extra


def save_refuse(gated, busy, v, ready):
    if not gated:
        return '로그인한 기기에서만(관문 경유)'
    if busy:
        return '저장 처리 중'
    if v.get('mode') != 'slam' or v.get('st') != 'ok':
        return 'SLAM 실시간 지도가 보일 때만 저장' + (f' · {v["why"]}' if v.get('why') else '')
    return '' if ready else '저장 서비스 없음(/v2_map/save)'


SAVE_CTX = ('world_id', 'building_id', 'floor_id', 'epoch', 'floor_rev')   # 저장 요청 출처(RL CONN-UI-10 /v2_map/save message JSON — save_lock 안 캡처 문맥)
SAVE_WHY_KO = {'floor_transit': '층 이동 중이라 저장 안 함', 'slam_not_ready': 'SLAM 준비 전이라 저장 안 함', 'slam_context_mismatch': 'SLAM 층 문맥이 달라 저장 안 함',
               'save_busy': '다른 저장 처리 중', 'grid_context_mismatch': '저장 순간 지도 문맥이 달라져 저장 안 함'}


def save_result(success, message, req=None):
    """Trigger 응답 → (ok, 글, 출처|None). message JSON 의 map_version(정규식)·reason·구조값만 쓰고 path 는 버림.
    req = 요청 때 지도 출처. 응답 구조값이 있으면 같아야 하고, 연결 건물(floor_rev 있음)은 다섯 개 모두 필수 — 다르면 이번 요청 성공으로 안 씀
    (공유 last_save 재읽기 0 — 늦은 다른 층 결과가 이 요청 성공이 되지 않게)"""
    try:
        d = json.loads(message)
    except (TypeError, ValueError):
        d = None
    d = d if isinstance(d, dict) else {}
    ver = d.get('map_version') if isinstance(d.get('map_version'), str) and MAP_VER.fullmatch(d['map_version']) else None
    ok = success is True and ver is not None and (d.get('ok') if req is not None and req.get('floor_rev') is not None else d.get('ok', True)) is True   # 연결 건물은 message ok true 필수 · 비연결은 legacy(없으면 통과)
    if ok and req is not None:
        need = req.get('floor_rev') is not None
        bad = [k for k in SAVE_CTX if (k in d or need) and (type(d.get(k)), d.get(k)) != (type(req.get(k)), req.get(k))]   # True≠1 까지 구분
        if bad:
            return False, f'지도 저장 결과 미확인 · 응답이 요청한 지도와 다름({"·".join(bad)}) — 이번 요청 성공으로 안 씀, 저장 지도 목록 다시 확인', None
    text = f'지도 저장됨 · {ver}' if ok else f'지도 저장 실패 · {SAVE_WHY_KO.get(d.get("reason")) or safe_txt(d.get("reason")) or "응답 형식 틀림"}'
    return ok, text, ({**{k: req.get(k) for k in SAVE_CTX}, 'map_version': ver} if ok and req is not None else None)


def selftest_live():
    t = [100.0]; L = LiveMap(now=lambda: t[0])
    def S(ep=1, acc=True, mw=4, stamp=5.0, **kw):
        d = {'schema': 'v2_map_status/1', 'world_id': 'rooms_a', 'building_id': 'rooms_a', 'floor_id': 'f1', 'mode': 'slam', 'map_source': 'slam',
             'map_version': None, 'map_frame': 'map', 'epoch': ep, 'sim_t': 6.0, 'map_accepting': acc, 'map_error': None,
             'map': None if mw is None else {'width': mw, 'height': 2, 'resolution': 0.05, 'n': 1, 'epoch': ep, 'stamp_sim': stamp},
             'pose_map': {'x': 1.0, 'y': 2.0, 'yaw': 0.1, 'stamp_sim': 5.8, 'source': 'slam_tf'}, 'pose_map_null_reason': None,
             'scan': {'n': 9, 'age_s': 0.1}, 'slam_lifecycle': {'epoch': ep, 'state': 'ok'}, 'last_save': None, 'maps_root': '/secret/maps', 'kids': {'slam': 1}}
        d.update(kw); L.on_status(d)
    # 보조 뷰 producer 진단: 허용 코드만 통과 · 모르는 코드 'unknown' · 형식 틀림 None · status 3 s 넘으면 둘 다 None
    assert L.prod() == {'points': None, 'follow': None}
    S(points_view={'n_pub': 0, 'last_reason': 'sim_t_unknown'}, follow_cam={'enabled': True, 'n_pub': 0, 'last_reason': 'sim_t_unknown'})
    assert L.prod() == {'points': {'reason': 'sim_t_unknown', 'n_pub': 0, 'enabled': None}, 'follow': {'reason': 'sim_t_unknown', 'n_pub': 0, 'enabled': True}}, L.prod()
    S(points_view={'n_pub': -1, 'last_reason': '<script>'}, follow_cam={'enabled': 'yes', 'n_pub': 2.0, 'last_reason': 'no_cloud'})   # no_cloud 는 follow 코드 아님
    assert L.prod() == {'points': {'reason': 'unknown', 'n_pub': None, 'enabled': None}, 'follow': {'reason': 'unknown', 'n_pub': None, 'enabled': None}}, L.prod()
    S(follow_cam={'enabled': False, 'n_pub': 0, 'last_reason': 'no_frame'}); assert L.prod() == {'points': None, 'follow': {'reason': 'no_frame', 'n_pub': 0, 'enabled': False}}
    t[0] += LIVE_STALE + 0.1; assert L.prod() == {'points': None, 'follow': None}
    t[0] = 100.0; L = LiveMap(now=lambda: t[0])
    metas = {('v5', 'l1', '20261014-120000-e1'): {'world_id': 'v5_building', 'map_source': 'slam', 'width': 4, 'height': 2, 'resolution': 0.05, 'origin': [-1.0, -2.0, 0]},
             ('v5', 'l1', 'gt-20261012'): {'world_id': 'v5_building', 'map_source': 'gt_raster', 'width': 4, 'height': 2, 'resolution': 0.05, 'origin': [-1.0, -2.0, 0]}}
    def get(b, f, v):
        if (b, f, v) not in metas:
            raise MapErr('지도 없음')
        return metas[(b, f, v)]
    def G(stamp=5.0, w=4, frame='map', data=None, origin=(-1.0, -2.0, 0.0), q=(0.0, 0.0, 0.0, 1.0)):
        g = {'frame': frame, 'w': w, 'h': 2, 'res': 0.05, 'origin': origin, 'q': q, 'stamp': stamp, 'data': data if data is not None else bytes([0, 100, 255, 50] * (w // 2))}
        L.on_grid(g); g2 = L.take(); png, why = grid_png(g2); k = L.static_key()   # 일꾼과 같은 순서: 변환 → (static) meta 대조 → commit
        L.commit(g2, png, why or static_meta_why(g2, k, get), k)
    def V():
        return L.view()
    assert V()['st'] == 'off'
    g0 = {'frame': 'map', 'w': 2, 'h': 2, 'res': 0.05, 'origin': (0, 0, 0.3), 'q': (0, 0, 0, 1), 'data': bytes([0, 100, 255, 30])}
    png, why = grid_png(g0); assert why == '' and png.startswith(b'\x89PNG')
    i, idat = 8, b''                                   # 위아래: ROS data[0] = 아래 행 → PNG 첫 행 = data 의 마지막 행(저장 PGM 과 같은 방향)
    while i < len(png):
        n, ty = struct.unpack('>I4s', png[i:i + 8]); idat += png[i + 8:i + 8 + n] if ty == b'IDAT' else b''; i += 12 + n
    assert zlib.decompress(idat) == b'\0' + bytes([205, 205]) + b'\0' + bytes([254, 0])
    for bad in ({'frame': 'odom'}, {'w': 3}, {'w': 0}, {'w': True}, {'res': float('nan')}, {'res': 0}, {'origin': (0, float('inf'), 0)}, {'w': 2001},
                {'q': (0, 0, 0.2, 0.98)}, {'q': (0.1, 0, 0, 0.995)}, {'q': (0, 0, 0, 2)}, {'q': (0, 0, 0, float('nan'))}, {'q': None},
                {'data': bytes([0, 101, 0, 0])}, {'data': bytes([0, 0xfe, 0, 0])}):
        assert grid_png({**g0, **bad})[0] is None, bad
    # 정상: status 먼저 → 격자(같은 stamp) → 표시 + 마커, 경로·kids 미노출
    S(); t[0] += 0.1; G(); v = V()
    assert v['st'] == 'ok' and v['grid']['seq'] == 1 and v['pose']['source'] == 'slam_tf' and v['slam'] == 'ok', v
    assert '/secret' not in json.dumps(v, ensure_ascii=False) and 'kids' not in v and L.png()['epoch'] == 1
    # 격자가 status 보다 먼저(stamp 앞섬) → 대기 → 다음 status 에서 결속
    t[0] += 1; G(stamp=10.0); assert V()['grid']['seq'] == 1
    S(stamp=10.0); assert V()['grid']['seq'] == 2
    # 모르는 status(틀린 world·building·frame·schema) → 즉시 버림
    for bad in ({'world_id': 'v5'}, {'building_id': 'v5'}, {'map_frame': 'odom'}, {'schema': 'x'}, {'epoch': True}, {'mode': 'slam', 'map_source': 'gt_raster'}):
        S(stamp=10.0); G(stamp=10.0); assert V()['st'] == 'ok', bad
        S(stamp=10.0, **bad); v = V(); assert v['st'] == 'unknown' and v.get('grid') is None and L.png() is None, (bad, v)
    # 틀린 frame 격자 → 표시 안 함
    S(stamp=11.0); t[0] += 0.1; G(stamp=11.0, frame='odom'); assert V()['grid'] is None and 'frame' in V()['why']
    # RESET: accepting false → 즉시 버림, 늦은 e1 격자(새 키 전 수신) 거부, e2 첫 지도 전 빈칸, e2 지도만 표시
    G(stamp=11.0); assert V()['st'] == 'ok'
    S(stamp=11.0, acc=False); v = V(); assert v['st'] == 'reset' and v['grid'] is None and v['pose'] is None
    t[0] += 0.2; G(stamp=11.0); assert V()['grid'] is None                       # 리셋 중 늦은 e1
    late = {'frame': 'map', 'w': 4, 'h': 2, 'res': 0.05, 'origin': (-1.0, -2.0, 0.0), 'q': (0, 0, 0, 1), 'stamp': 1.0, 'data': bytes(8)}
    L.on_grid(late); late = L.take()                                               # e1 때 받은 격자(변환 지연)
    t[0] += 0.2; S(ep=2, mw=None); assert V()['st'] == 'wait' and V()['grid'] is None
    S(ep=2, stamp=1.0); L.commit(late, *grid_png(late)); assert V()['grid'] is None and '이전 결속' in V()['why']   # stamp 우연 일치여도 수신 시각으로 거부
    t[0] += 0.1; G(stamp=1.0); v = V(); assert v['st'] == 'ok' and v['epoch'] == 2
    S(ep=2, stamp=1.0, map={'width': 4, 'height': 2, 'resolution': 0.05, 'epoch': 1, 'stamp_sim': 1.0}); assert V()['grid'] is None   # 상태의 지도 epoch 어긋남
    S(ep=2, stamp=None); G(stamp=1.0); assert V()['grid'] is None                 # slam 인데 상태 stamp null → 거부(0 으로 바꾸지 않음)
    S(ep=2, stamp=1.0); G(stamp=1.0); assert V()['st'] == 'ok'
    t[0] += 0.5; S(ep=2, stamp=1.0, sim_t=0.5); assert V()['grid'] is None         # 같은 키·sim 되감김 = 새 기동 → 새로 받은 격자만
    G(stamp=1.0); assert V()['st'] == 'ok'
    # 앱 RESET 요청 → 키 바뀔 때까지 리셋, 실패 응답이면 해제
    S(ep=2, stamp=1.0); G(stamp=1.0); assert V()['st'] == 'ok'
    L.hold(); assert V()['st'] == 'reset' and V()['grid'] is None
    S(ep=2, stamp=1.0); G(stamp=1.0); assert V()['grid'] is None
    L.release(); S(ep=2, stamp=1.0); G(stamp=1.0); assert V()['st'] == 'ok'
    L.hold(); t[0] += 0.1; S(ep=3, stamp=0.5); G(stamp=0.5); assert V()['st'] == 'ok' and V()['epoch'] == 3
    # 마커: 출처 어긋남·sim 1 s 넘게 차이·저장 SLAM static(null 이유) → 마커 0, 지도는 표시
    S(ep=3, stamp=0.5, pose_map={'x': 1, 'y': 2, 'yaw': 0, 'stamp_sim': 5.8, 'source': 'gt_identity'}); assert V()['pose'] is None
    S(ep=3, stamp=0.5, pose_map={'x': 1, 'y': 2, 'yaw': 0, 'stamp_sim': 4.5, 'source': 'slam_tf'}); assert V()['pose'] is None
    S(ep=3, stamp=0.5); t[0] += 2.5; assert V()['pose'] is None and V()['grid'] is not None      # status 2 s 넘음 → 마커만 끔
    t[0] += 0.6; v = V(); assert v['st'] == 'stale' and v['grid'] is None and L.png() is None    # 3 s 끊김 → 지도도 버림
    t[0] += 1; S(ep=3, stamp=0.5); G(stamp=0.5); assert V()['st'] == 'ok'                      # 끊김 뒤 = 새 키 → 새로 받은 격자만
    st_ = dict(world_id='v5_building', building_id='v5', floor_id='l1', mode='static', map_source='slam', map_version='20261014-120000-e1',
               pose_map=None, pose_map_null_reason='saved_slam_map_not_localized')
    t[0] += 0.1; S(ep=1, stamp=None, **st_); G(stamp=0.0); v = V()                # static: 상태 stamp null + 격자 stamp 0 → 정상(meta 대조로 결속)
    assert v['st'] == 'ok' and v['pose'] is None and v['pose_why'].startswith('저장 SLAM'), v
    S(ep=1, stamp=None, **st_); G(stamp=0.0, w=2); assert V()['grid']['seq'] == v['grid']['seq']   # meta 와 크기 다른 격자 → 안 바뀜(크기는 상태와도 달라 거부)
    st_m = {**st_, 'map': {'width': 2, 'height': 2, 'resolution': 0.05, 'epoch': 1, 'stamp_sim': None}}
    S(ep=1, **st_m); v2 = V(); assert v2['grid'] is None and v2['pose'] is None and v2['st'] == 'wait' and L.png() is None   # 상태 형상이 바뀜 → 앞 격자 버림(마지막 지도 유지 0)
    G(stamp=0.0, w=2); assert V()['grid'] is None and 'meta' in L.grid_why        # 상태와는 맞아도 저장 meta 와 다르면 거부 → 빈 상태 유지
    gt_ = dict(st_, map_source='gt_raster', map_version='gt-20261012', pose_map={'x': 1, 'y': 2, 'yaw': 0, 'stamp_sim': 5.9, 'source': 'gt_identity'}, pose_map_null_reason=None)
    t[0] += 0.1; S(ep=1, stamp=None, **gt_); G(stamp=0.0); v = V(); assert v['st'] == 'ok' and v['pose']['source'] == 'gt_identity', v
    t[0] += 0.1; S(ep=1, stamp=None, **{**gt_, 'map_version': 'gt-20261013'}); G(stamp=0.0); assert V()['grid'] is None and 'meta' in V()['why']   # meta 없는 버전
    S(ep=1, stamp=None, **{**st_, 'map_version': None}); assert V()['st'] == 'unknown'
    S(ep=1, stamp=0.0, map_error='map too large /x/y'); assert V()['st'] == 'bad' and '/x' not in V()['why']
    # 표시 중 격자 ↔ 현재 status — 즉시 버림(경계 유지): map None·같은 stamp 에 크기만 바뀜·stamp 역행·nan·해상도 바뀜·형식 이상(bool·0·실수 w)
    nan = float('nan'); M = lambda **kw: {'map': {'width': 4, 'height': 2, 'resolution': 0.05, 'epoch': 7, 'stamp_sim': 4.0, **kw}}
    t[0] += 0.1; S(ep=7, stamp=3.0); G(stamp=3.0); assert V()['st'] == 'ok'
    for chg in ({'mw': None}, {'mw': 6}, {'stamp': 2.0}, {'stamp': nan}, M(resolution=0.1), M(width=True), M(width=0), M(width=4.0), M(height=-2), M(stamp_sim='4'), M(epoch=6)):
        S(ep=7, stamp=3.0); G(stamp=3.0); assert V()['st'] == 'ok', chg
        S(**{'ep': 7, 'stamp': 3.0, **chg}); v = V(); assert v['grid'] is None and v['pose'] is None and L.png() is None and v['st'] in ('wait', 'bad'), (chg, v)   # epoch 어긋남 = bad(상태 수준)
        assert v['bound'] == (L.cur_key() is not None), (chg, v)          # bound = 상태 수준만(Views.cur_key 와 같은 조건)
        if 'map' in chg and chg['map'].get('epoch') == 7: assert v['bound'], (chg, v)   # 격자 형상 거부(형식 이상 포함)는 보조 뷰 결속을 끊지 않음
    # 같은 크기 + bool/실수 크기: 1×1 표시 격자에 width True·1.0 → «같은 크기» 통과 0
    for bw in (True, 1.0):
        S(ep=7, stamp=3.0, mw=1); G(stamp=3.0, w=1, data=bytes([0, 100])); assert V()['st'] == 'ok' and V()['grid']['w'] == 1
        S(ep=7, stamp=3.0, map={'width': bw, 'height': 2, 'resolution': 0.05, 'epoch': 7, 'stamp_sim': 3.0}); v = V()
        assert v['grid'] is None and v['bound'] and '형식' in v['why'], (bw, v)
    # S2 유한 보유: 같은 K·slam·형식 정상·앞선 stamp(크기 확장 포함) → 검증된 그림 유지 + upd + 마커 0 · bound 유지. 시한 = 검증 시각 + UPD_MAX(반복 status 연장 0)
    S(ep=7, stamp=3.0); G(stamp=3.0); v = V(); n0 = v['grid']['seq']; assert v['grid']['upd'] is False and v['pose'] is not None and v['grid']['stamp'] == 3.0
    t[0] += 1; S(ep=7, stamp=4.0, mw=6); v = V()
    assert v['st'] == 'ok' and v['bound'] and v['grid']['seq'] == n0 and v['grid']['upd'] is True and v['pose'] is None and '갱신' in v['pose_why'] and L.png()['seq'] == n0, v
    for _ in range(10):
        t[0] += 1; S(ep=7, stamp=4.0, mw=6); assert V()['grid']['upd'] is True   # 검증 뒤 11 s — 반복 status 는 시한을 늘리지 않음
    t[0] += UPD_MAX - 11 + 0.5; S(ep=7, stamp=4.0, mw=6); v = V()
    assert v['grid'] is None and L.png() is None and v['st'] == 'wait' and v['bound'] and str(int(UPD_MAX)) in v['why'], v
    assert L.cur_key() is not None                                               # 보유 만료 = 격자만 버림 — 보조 뷰(점군·3인칭) 결속 유지
    # S1: 크기·원점 바뀐 앞선 격자가 status 보다 먼저 → pending(K 함께) → 다음 status 같은 lock 안 원자 교체(공백 0)
    S(ep=7, stamp=10.0); G(stamp=10.0); n1 = V()['grid']['seq']
    t[0] += 0.1; G(stamp=15.0, w=6, origin=(-2.0, -3.0, 0.0)); v = V()
    assert L.pending is not None and v['grid']['seq'] == n1 and v['grid']['w'] == 4 and v['grid']['upd'] is False, v
    t[0] += 0.3; S(ep=7, stamp=15.0, mw=6); v = V()
    assert v['grid']['seq'] == n1 + 1 and v['grid']['w'] == 6 and v['grid']['origin'][:2] == [-2.0, -3.0] and v['grid']['upd'] is False and v['pose'] is not None, v
    # 순서 반대: status 먼저(확장) → 보유(upd, 마커 0) → 격자 도착 → 교체(마커 복귀)
    t[0] += 4.6; S(ep=7, stamp=20.0, mw=8); v = V(); assert v['grid']['seq'] == n1 + 1 and v['grid']['upd'] is True and v['pose'] is None
    t[0] += 0.8; G(stamp=20.0, w=8); v = V(); assert v['grid']['seq'] == n1 + 2 and v['grid']['w'] == 8 and v['grid']['upd'] is False and v['pose'] is not None
    # 연속 확장 30회(크기·원점·stamp 매번 바뀜), 도착 순서 교대 — 어느 순간에도 그림 0 없음, seq 는 한 번에 1씩
    st0, w0, n2 = 20.0, 8, n1 + 2
    for i in range(1, 31):
        sp, w_ = st0 + 5 * i, w0 + 2 * i; o = (-1.0 - 0.1 * i, -2.0, 0.0)
        for _ in range(4):                                   # 사이 status 1 Hz(옛 메타 그대로) — 그림 유지
            t[0] += 1; S(ep=7, stamp=sp - 5, mw=w_ - 2); assert V()['grid']['upd'] is False
        if i % 2:
            t[0] += 0.7; G(stamp=sp, w=w_, origin=o); assert V()['grid']['seq'] == n2 + i - 1 and V()['grid']['upd'] is False
            t[0] += 0.3; S(ep=7, stamp=sp, mw=w_)
        else:
            t[0] += 0.7; S(ep=7, stamp=sp, mw=w_); v = V(); assert v['grid'] is not None and v['grid']['upd'] is True and v['pose'] is None, (i, v)
            t[0] += 0.3; G(stamp=sp, w=w_, origin=o)
        v = V(); assert v['st'] == 'ok' and v['grid']['seq'] == n2 + i and v['grid']['w'] == w_ and v['grid']['upd'] is False, (i, v)
    # 앞선 pending: 키가 바뀌면(새 epoch) 재채택 0 · 지난 stamp 대기 격자 버림
    sp = st0 + 5 * 31; w_ = w0 + 62
    t[0] += 1; G(stamp=sp + 5, w=w_ + 2); assert L.pending is not None
    t[0] += 0.3; S(ep=8, stamp=sp + 5, mw=w_ + 2); v = V(); assert L.pending is None and v['grid'] is None and v['epoch'] == 8, v
    t[0] += 0.1; S(ep=8, stamp=1.0); G(stamp=1.0); assert V()['st'] == 'ok'
    G(stamp=0.5); assert V()['grid']['stamp'] == 1.0 and L.pending is None          # 뒤처진 격자: 대기·교체 0
    t[0] += 0.1; S(ep=7, stamp=4.0); G(stamp=4.0); assert V()['st'] == 'ok'        # (아래 시험용 상태 복귀: ep 7 새 키)
    G(stamp=5.0); assert L.pending is not None; S(ep=7, stamp=6.0); assert L.pending is None and V()['grid']['upd'] is True   # 지난 stamp 대기 격자 버림(그림은 보유)
    # 선택 칸 형식 틀림(list 등) → 상태 전체 «모름», 예외 0
    for bad in ({'map_error': ['x']}, {'pose_map_null_reason': ['tf_stale']}, {'slam_lifecycle': ['ok']}, {'slam_lifecycle': {'epoch': 7, 'state': ['ok']}},
                {'map': [1]}, {'pose_map': 'x'}, {'last_save': 1}, {'scan': []}, {'map_accepting': 'yes'}, {'sim_t': 'now'}):
        S(ep=7, stamp=4.0); G(stamp=4.0); assert V()['st'] == 'ok'
        S(ep=7, stamp=4.0, **bad); v = V(); assert v['st'] == 'unknown' and v.get('grid') is None and L.png() is None, (bad, v)
    S(ep=7, stamp=4.0, pose_map=None, pose_map_null_reason='tf_stale'); G(stamp=4.0); assert V()['pose_why'] == '위치 변환 오래됨'
    # 연결 건물 층 context(RL CONN-UI-9 초안): K 에 floor_rev · 이탈은 형식 정상 대기 · 연결 static 도 격자 stamp(층 확정 시각) 비교
    metas[('v5', 'l2', 'gt-20261012')] = dict(metas[('v5', 'l1', 'gt-20261012')])
    def SC(fid='l1', fr=1, fs='on_floor', stamp=20.0, mfid=None, mfr=None, ep=9, **kw):
        mp = {'width': 4, 'height': 2, 'resolution': 0.05, 'n': 1, 'epoch': 9, 'stamp_sim': stamp, 'floor_id': mfid or fid, 'floor_rev': fr if mfr is None else mfr}
        S(ep=ep, **{'world_id': 'v5_building', 'building_id': 'v5', 'floor_id': fid, 'mode': 'static', 'map_source': 'gt_raster', 'map_version': 'gt-20261012',
                   'floor_rev': fr, 'floor_state': fs, 'current_floor': fid if fs == 'on_floor' else None, 'pose_map': None, 'map': mp, **kw})
    t[0] += 1; SC(); t[0] += 0.1; G(stamp=20.0); v = V()
    assert v['st'] == 'ok' and (v['floor_id'], v['floor_rev']) == ('l1', 1) and v['floor'] == {'rev': 1, 'state': 'on_floor', 'current': 'l1', 'reason': ''}, v
    n = v['grid']['seq']; G(stamp=19.0); assert V()['grid']['seq'] == n                     # 같은 키라도 stamp 다른 격자는 안 받음(연결 static)
    SC(fid=None, fr=2, fs='transit', map=None, map_null_reason='floor_transit', floor_reason='connector_stairs'); v = V()
    assert v['st'] == 'wait' and v['why'] == FLOOR_HOLD and v.get('grid') is None and L.png() is None and v['floor'] == {'rev': 2, 'state': 'transit', 'current': None, 'reason': 'connector_stairs'}, v
    G(stamp=20.0); assert V().get('grid') is None                                            # 이동 중 늦은 l1 격자
    SC(fid='l2', fr=3, stamp=30.0); t[0] += 0.1; G(stamp=20.0); v = V()
    assert v['grid'] is None and v['floor_id'] == 'l2', v                                    # 같은 크기 옛 l1 격자가 새 키 뒤 도착 → stamp 로 거부
    G(stamp=30.0); v = V(); assert v['st'] == 'ok' and (v['floor_id'], v['floor_rev']) == ('l2', 3) and v['grid'] is not None, v
    SC(fid='l2', fr=3, stamp=30.0, mfr=2); v = V(); assert v['st'] == 'wait' and v.get('grid') is None and '결속' in v['why'], v   # 스냅샷 안 지도 context ≠ 현재
    SC(fid='l2', fr=4, stamp=40.0, map=None, map_null_reason='saved_map_other_floor', pose_map_null_reason='saved_map_other_floor'); v = V()
    assert v['grid'] is None and v['pose'] is None and '기동 층' in v['why'] and '기동 층' in v['pose_why'], v
    SC(fid=None, fr=5, map=None, map_null_reason='slam_activating', current_floor='l1'); v = V()    # 층 확정·표시 지도 층 null → 지도 대기(층 이동 중 아님), 현재층 = current_floor
    assert v['st'] == 'wait' and v['why'].startswith(FLOOR_MAPWAIT) and 'SLAM' in v['why'] and v.get('grid') is None and v['floor'] == {'rev': 5, 'state': 'on_floor', 'current': 'l1', 'reason': ''}, v
    SC(fid=None, fr=5, map=None, current_floor='l9'); v = V(); assert v['st'] == 'unknown' and 'world_id' not in v and 'floor' not in v   # 허용표 밖 현재층은 대기 아님·신원 0
    for bad in (-1, True, 1.0):
        SC(fr=bad); v = V(); assert v['st'] == 'unknown' and 'world_id' not in v and 'floor' not in v, bad
    # K 없는 정상 층 대기(지도 대기·층 이동 중)에도 신원 칸(world·building·epoch·spawn·SDF·geom sha)은 내보냄 — grid·pose 는 계속 없음(root 최종 결합)
    idn = dict(spawn_floor='l1', world_src_sha256='a' * 64, geom={'schema': 'v2_building_geom/1', 'sha256': 'b' * 64})
    for o in (dict(fid=None, fr=6, map=None, current_floor='l2', map_null_reason='no_grid_yet'), dict(fid=None, fr=7, fs='transit', map=None, map_null_reason='floor_transit')):
        SC(**o, **idn); v = V()
        assert v['st'] == 'wait' and (v['world_id'], v['building_id'], v['epoch'], v['spawn_floor'], v['world_src_sha256'], v['geom']['sha256']) == ('v5_building', 'v5', 9, 'l1', 'a' * 64, 'b' * 64), v
        assert v.get('grid') is None and v.get('pose') is None and 'floor_id' not in v and 'mode' not in v, v
    assert V()['floor']['state'] == 'transit'
    SC(fid=None, fr=6, map=None, current_floor='l2', **idn); assert V()['floor']['current'] == 'l2'
    SC(fid=None, fr=6, map=None, current_floor='l2', ep=0, **idn); assert 'world_id' not in V()                 # epoch 형식 틀림 → 신원 0
    SC(fid=None, fr=6, map=None, current_floor='l2', building_id='v4', **idn); v = V(); assert v['st'] == 'unknown' and 'world_id' not in v
    # 전체 3D 결속 칸: 형식 맞을 때만 그대로, 그 밖 None(이 건물 층 아닌 spawn_floor·64 hex 아님·geom schema 다름)
    S(ep=7, stamp=4.0, spawn_floor='f1', world_src_sha256='a' * 64, geom={'schema': 'v2_building_geom/1', 'sha256': 'b' * 64}); v = V()
    assert (v['spawn_floor'], v['world_src_sha256'], v['geom']) == ('f1', 'a' * 64, {'schema': 'v2_building_geom/1', 'sha256': 'b' * 64}), v
    S(ep=7, stamp=4.0, spawn_floor='l2', world_src_sha256='A' * 64, geom={'schema': 'x', 'sha256': 'b' * 64}); v = V()
    assert v['spawn_floor'] is None and v['world_src_sha256'] is None and v['geom'] is None, v
    # map_start 인자: 허용표·버전 규칙
    has = lambda b, f, v: (b, f, v) == ('v5', 'l2', 'gt-20261012')
    assert map_args({'world_id': 'v5_building', 'floor_id': 'l2', 'mode': 'static', 'map_version': 'gt-20261012'}, has) == (['v5_building', 'l2', 'static', 'gt-20261012'], 'v5_building/l2', '')
    assert map_args({'world_id': 'rooms_a', 'floor_id': 'f1', 'mode': 'slam'}, has) == (['rooms_a', 'f1', 'slam'], 'rooms_a/f1', '')
    assert map_args({'world_id': 'rooms_a', 'floor_id': 'f1', 'mode': 'slam', 'follow_cam': True}, has, True)[0] == ['rooms_a', 'f1', 'slam', 'follow-cam']
    assert map_args({'world_id': 'v5_building', 'floor_id': 'l2', 'mode': 'static', 'map_version': 'gt-20261012', 'follow_cam': True}, has, True)[0][-2:] == ['gt-20261012', 'follow-cam']
    assert map_args({'world_id': 'rooms_a', 'floor_id': 'f1', 'mode': 'slam', 'follow_cam': False}, has, True)[0] == ['rooms_a', 'f1', 'slam']
    for fc in ('true', 1, None, [True]):          # 엄격 bool 만
        assert map_args({'world_id': 'rooms_a', 'floor_id': 'f1', 'mode': 'slam', 'follow_cam': fc}, has, True)[0] is None, fc
    assert map_args({'world_id': 'rooms_a', 'floor_id': 'f1', 'mode': 'slam', 'follow_cam': True}, has, False)[0] is None   # 래퍼 미지원이면 거부(조용히 빼지 않음)
    for bad in ({'world_id': 'v5', 'floor_id': 'l1', 'mode': 'slam'}, {'world_id': 'rooms_a', 'floor_id': 'l1', 'mode': 'slam'},
                {'world_id': 'rooms_a', 'floor_id': 'f1', 'mode': 'x'}, {'world_id': 'rooms_a', 'floor_id': 'f1', 'mode': 'slam', 'map_version': 'gt-20261012'},
                {'world_id': 'v5_building', 'floor_id': 'l1', 'mode': 'static', 'map_version': 'gt-20261012'},
                {'world_id': 'v5_building', 'floor_id': 'l2', 'mode': 'static', 'map_version': '../x'}, {'world_id': ['rooms_a'], 'floor_id': 'f1', 'mode': 'slam'},
                {'world_id': 'v5_building', 'floor_id': 'l2', 'mode': 'static'}):
        assert map_args(bad, has)[2], bad
    # map_start 거부: 시작/종료 경합·켜짐·남의 조종·원장
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        (Path(td) / 'start_map.sh').write_text(''); (Path(td) / 'map_status.sh').write_text('')
        tt = [1000.0]; sst = SimStart('/x', lambda: tt[0]); M = MapStart(str(Path(td) / 'start_map.sh'))
        assert MapStart(str(Path(td) / 'none.sh')).refuse('rooms_a/f1', True, sst, False, False, None).endswith('미설정')
        R = lambda key='rooms_a/f1', gated=True, stopping=False, live=False, other=None: M.refuse(key, gated, sst, stopping, live, other)
        M.now = lambda: tt[0]
        assert R() == '지도 체험 상태 조회 미확인(오래됨·실패)'
        GOOD = {'result': 'idle', 'ledger_id': 'map-20261014', 'active_state': 'inactive', 'request_in_progress': False,
                'map_ledger_used': 1, 'map_ledger_max': 4, 'map_ledger_keys_used': ['v5_single/f1']}
        M.session = dict(GOOD); M.sess_t = tt[0]
        assert R() == '' and '이미 사용' in R('v5_single/f1') and R(gated=False).startswith('로그인')
        assert R(stopping=True).startswith('Gazebo 종료') and R(live=True).startswith('Gazebo 가') and R(other='폰').startswith('폰')
        sst.busy = True; assert R() == '시작 요청 처리 중'; sst.busy = False
        sst.session = {'result': 'running'}; assert R().startswith('Gazebo 가'); sst.session = None
        M.session['result'] = 'starting'; assert R().startswith('Gazebo 가'); M.session['result'] = 'idle'
        sst.last = tt[0] - 10; assert R().startswith('방금'); sst.last = -1e9
        M.session.update(map_ledger_used=4, map_ledger_keys_used=sorted(MapStart.KEYS)); assert R().startswith('지도 체험 원장 소진 4/4')
        M.session['map_ledger_keys_used'] = 'x'; assert M.ledger() is None and R() == '지도 체험 원장 미확인'
        # 원장 엄격 검사(번들4): id·max·범위·키 허용표·중복·개수=used — 하나라도 틀리면 미확인 → 시작 거부
        for k, v in [('ledger_id', 'map-x'), ('ledger_id', None), ('map_ledger_max', 5), ('map_ledger_max', 4.0), ('map_ledger_used', -1),
                     ('map_ledger_used', 2), ('map_ledger_used', True), ('map_ledger_keys_used', ['v5_single/f1', 'v5_single/f1']),
                     ('map_ledger_keys_used', ['v5_single/f9']), ('map_ledger_keys_used', [1]), ('map_ledger_keys_used', [])]:
            M.session = {**GOOD, k: v}; assert M.ledger() is None and R() == '지도 체험 원장 미확인', (k, v)
        M.session = {**GOOD, 'map_ledger_used': 0, 'map_ledger_keys_used': []}; assert M.ledger() == {'used': 0, 'max': 4, 'keys': []} and R() == ''
        # unit 상태·요청 진행·조회 신선도: 미확인/deactivating/켜짐/요청 중 → 거부
        for k, v, want in [('active_state', None, 'Gazebo unit 상태 미확인'), ('active_state', 'unknown', 'Gazebo unit 상태 미확인'),
                           ('active_state', 'deactivating', 'Gazebo unit deactivating'), ('active_state', 'active', 'Gazebo unit active'),
                           ('request_in_progress', True, '시작 요청 진행 중'), ('request_in_progress', None, '시작 요청 진행 여부 미확인'),
                           ('request_in_progress', 'false', '시작 요청 진행 여부 미확인'), ('request_in_progress', 0, '시작 요청 진행 여부 미확인')]:
            M.session = {**GOOD, k: v}; assert R().startswith(want), (k, v, R())
        M.session = dict(GOOD); tt[0] += 16.0; assert R().startswith('지도 체험 상태 조회 미확인') and M.ledger() is None
        M.sess_t = tt[0]; assert R() == ''
        # runner: 같은 unit active 일 때만, 꺼짐·미확인·오래됨 → None
        M.session = {**GOOD, 'active_state': 'active', 'runner': 'live_map'}; assert M.runner() == 'live_map'
        M.session = {**GOOD, 'active_state': 'active', 'runner': 'live_v2'}; assert M.runner() == 'live_v2'
        for bad in ({**GOOD, 'runner': 'live_map'}, {**GOOD, 'active_state': 'active', 'runner': 'unknown'}, {**GOOD, 'active_state': 'active'}):
            M.session = bad; assert M.runner() is None, bad
        M.session = {**GOOD, 'active_state': 'active', 'runner': 'live_map'}; tt[0] += 16.0; assert M.runner() is None
    # 래퍼 결과·종료 코드 모순 → 실패(성공 채택 0)
    J = lambda r: json.dumps({'schema': 'v2_session/1', 'result': r})
    assert map_result(J('starting'), 0)[0] == 'starting' and map_result(J('ready'), 0)[0] == 'ready'
    for r, code in [('starting', 1), ('ready', 3), ('starting', 5), ('budget_exhausted', 0), ('already_running', 0)]:
        res, txt = map_result(J(r), code); assert res == 'failed' and '모순' in txt, (r, code)
    assert map_result(J('budget_exhausted'), 5)[0] == 'budget_exhausted' and map_result('', 0)[0] != 'starting'
    # 지도 체험 시작 접수(Core): 조종 중이던 기기도 해제·0·잠금, 처리 중 take/resume/reset/비영 거부·STOP 은 됨, 끝나도 자동 복원 0
    c = Core(now=lambda: t[0]); c.on_state({'schema': SCHEMA, 'episode': 0, 'stop_requested': False, 'reset_in_progress': False, 'policy_running': True})
    assert c.take('a'); c.cmd('a', Z); c.cmd('a', (1.0, 0.0, 0.0)); assert c.applied() == (0.6, 0, 0)
    c.busy_sim('지도 체험 시작 처리 중'); assert c.controller is None and c.latch and c.applied() == Z
    for cid in ('a', 'b'):
        assert not c.take(cid) and not c.resume(cid) and not c.reset_begin(cid, True)
        c.cmd(cid, Z); c.cmd(cid, (1.0, 0.0, 0.0)); assert c.applied() == Z
    c.stop('b'); assert c.latch
    c.sim_busy = ''; assert c.take('a'); c.cmd('a', Z); c.cmd('a', (1.0, 0.0, 0.0)); assert c.applied() == Z and c.latch
    # 저장: 거부·응답 해석(경로 버림·epoch 바뀜·형식 틀림)
    ok_v = {'st': 'ok', 'mode': 'slam'}
    assert save_refuse(False, False, ok_v, True).startswith('로그인') and save_refuse(True, True, ok_v, True) == '저장 처리 중'
    assert save_refuse(True, False, {'st': 'ok', 'mode': 'static'}, True).startswith('SLAM') and save_refuse(True, False, ok_v, False).startswith('저장 서비스')
    assert save_refuse(True, False, {'st': 'reset', 'mode': 'slam', 'why': '리셋 중'}, True).endswith('리셋 중') and save_refuse(True, False, ok_v, True) == ''
    msg = json.dumps({'map_version': '20261014-120000-e2', 'reason': 'user_save', 'path': '/home/u/maps/rooms_a/f1/20261014-120000-e2'})
    rq = {'world_id': 'rooms_a', 'building_id': 'rooms_a', 'floor_id': 'f1', 'epoch': 2, 'floor_rev': None}
    assert save_result(True, msg, rq) == (True, '지도 저장됨 · 20261014-120000-e2', {**rq, 'map_version': '20261014-120000-e2'})   # 단층: 구조값 없어도 됨
    assert save_result(True, msg)[2] is None and '/home' not in save_result(True, msg, rq)[1]
    assert save_result(True, json.dumps({'map_version': '20261014-120000-e2', 'epoch': 3}), rq)[0] is False                 # 있으면 같아야
    ok_, txt, _ = save_result(False, json.dumps({'map_version': None, 'reason': "save error FileExistsError: [Errno 17] File exists: '/home/u/maps/x'"}), rq)
    assert not ok_ and '/home' not in txt and '<경로>' in txt
    assert save_result(True, 'not json', rq)[0] is False and save_result(True, json.dumps({'map_version': '../x'}), rq)[0] is False
    cq = {'world_id': 'v5_building', 'building_id': 'v5', 'floor_id': 'l2', 'epoch': 4, 'floor_rev': 3}                  # 연결 건물: 다섯 개 필수·정확히 같음
    cm = lambda **o: json.dumps({'ok': True, 'map_version': '20261015-010000-e4', 'reason': 'saved', **cq, 'path': '/x', **o})
    assert save_result(True, cm(), cq)[0] is True and save_result(True, cm(), cq)[2]['floor_rev'] == 3
    for o in ({'floor_id': 'l1'}, {'floor_rev': 2}, {'epoch': 5}, {'world_id': 'v5_single'}, {'floor_rev': 3.0}, {'epoch': True}):
        r_ = save_result(True, cm(**o), cq); assert r_[0] is False and r_[2] is None and '미확인' in r_[1], o
    assert save_result(True, json.dumps({'map_version': '20261015-010000-e4'}), cq)[0] is False                         # 구조값 없는 응답 = 성공 0
    assert save_result(True, cm(), cq)[0] is True and save_result(True, json.dumps({'map_version': '20261015-010000-e4', **cq}), cq)[0] is False   # 연결 건물: ok 키 누락 = 성공 0
    assert save_result(True, cm(ok=False), cq)[0] is False and save_result(True, json.dumps({'map_version': '20261014-120000-e2', **rq, 'ok': True, 'path': '/x'}), rq)[0] is True
    assert save_result(False, json.dumps({'ok': False, 'map_version': None, 'reason': 'floor_transit', 'world_id': 'v5_building', 'building_id': 'v5', 'floor_id': None, 'epoch': None, 'floor_rev': None}), cq)[1] == '지도 저장 실패 · 층 이동 중이라 저장 안 함'


def selftest_maps():
    import tempfile
    def unpng(p):                                   # 시험용: IDAT 풀어 화소 되찾기
        i, idat = 8, b''
        while i < len(p):
            n, t = struct.unpack('>I4s', p[i:i + 8]); idat += p[i + 8:i + 8 + n] if t == b'IDAT' else b''; i += 12 + n
        w, h = struct.unpack('>II', p[16:24]); r = zlib.decompress(idat)
        return w, h, b''.join(r[y * (w + 1) + 1:(y + 1) * (w + 1)] for y in range(h))
    px = bytes([0, 205, 254, 254, 0, 205])
    assert read_pgm(b'P5\n# c\n3 2\n255\n' + px) == (3, 2, px) and unpng(png_gray(3, 2, px)) == (3, 2, px)
    for bad in (b'P2\n3 2\n255\n' + px, b'P5\n3 2\n15\n' + px, b'P5\n3 2\n255\n' + px[:5], b'P5\n3', b'P5\n2001 1\n255\n' + bytes(2001)):
        try:
            read_pgm(bad); raise AssertionError(bad[:12])
        except MapErr:
            pass
    with tempfile.TemporaryDirectory() as td:
        root = Path(td) / 'maps'; s = MapStore(str(root))
        def put(b, f, v, raw=b'P5\n3 2\n255\n' + px, drop=(), yml='image: map.pgm\nmode: trinary\nresolution: 0.05\norigin: [-20, -14, 0]\nnegate: 0\n', **kw):
            d = root / b / f / v; d.mkdir(parents=True, exist_ok=True); (d / 'map.pgm').write_bytes(raw); sh = hashlib.sha256(raw).hexdigest()
            gt = kw.get('map_source') == 'gt_raster'
            m = {'schema': 'v2_map_meta/1', 'world_id': 'v5_building', 'building_id': b, 'floor_id': f, 'map_version': v, 'map_source': 'slam', 'epoch': 1,
                 'map_frame': 'map', 'resolution': 0.05, 'origin': [-20, -14, 0], 'width': 3, 'height': 2, 'saved_sim_t': 12.5, 'saved_wall': '2026-10-14T10:00:00+09:00',
                 'reason': 'user_save', 'sha256_pgm': sh,
                 **({'epoch': None, 'saved_sim_t': None, 'saved_wall': None, 'reason': 'gt_raster_copy', 'source_pgm': 'x/v5-l1.pgm', 'source_sha256': sh} if gt else {}), **kw}
            for k in drop:
                del m[k]
            (d / 'meta.json').write_text(json.dumps(m)); (d / 'map.yaml').write_text(yml)
        V, G, GT = '20261014-100000-e1', 'gt-20261012', {'map_source': 'gt_raster', 'epoch': None}
        put('v5', 'l1', G, **GT); put('v5', 'l2', V)
        r = s.get('v5', 'l1', G); assert r['map_source'] == 'gt_raster' and r['epoch'] is None and unpng(base64.b64decode(r['png'])) == (3, 2, px)
        bad = [('20261014-100001-e1', {'sha256_pgm': '0' * 64}), ('20261014-100002-e1', {'floor_id': 'l2'}), ('20261014-100003-e1', {'world_id': 'rooms_a'}),
               ('20261014-100004-e1', {'width': 4}), ('20261014-100005-e1', {'resolution': float('nan')}), ('20261014-100007-e1', {'world_id': ['v5_building']}),
               ('20261014-100008-e1', {'world_id': 'v5_single'}), ('20261014-100009-e1', {'building_id': {'x': 1}}), ('20261014-100011-e1', {'epoch': 0}),
               ('20261014-100012-e1', {'epoch': None}), ('20261014-100013-e1', {'map_frame': 'odom'}), ('20261014-100014-e1', {'reason': 'x'}),
               ('gt-20261013', {'map_source': 'gt_raster', 'epoch': 1}),
               ('gt-20261014', {'map_source': 'gt_raster', 'source_sha256': None})]
        for v, kw in bad:
            put('v5', 'l1', v, **kw)
        put('v5', 'l1', '20261014-100019-e1', yml='resolution: 0.1\norigin: [-20, -14, 0]\n')     # yaml 해상도 어긋남
        put('v5', 'l1', '20261014-100020-e1', yml='resolution: 0.05\norigin: [-20, -13, 0]\n')   # yaml 원점 어긋남
        put('v5', 'l1', '20261014-100021-e1', yml='resolution: 0.05\n')                          # yaml 원점 없음
        put('v5', 'l1', '20261014-100022-e1'); (root / 'v5' / 'l1' / '20261014-100022-e1' / 'map.yaml').unlink()   # yaml 파일 없음
        put('v5', 'l1', '20261014-100016-e1', drop=('saved_wall',))                        # null 허용 키도 «키는 항상 있음»
        put('v5', 'l1', '20261014-100017-e1', drop=('sha256_pgm',)); put('v5', 'l1', '20261014-100018-e1', drop=('saved_sim_t',))
        (root / 'v5' / 'l1' / 'not-a-version').mkdir()
        (root / 'v5' / 'l1' / '20261014-100006-e1').symlink_to(root / 'v5' / 'l2' / V)      # 다른 층으로 새는 링크
        put('v5', 'l2', '20261014-100010-e2', saved_sim_t=None, saved_wall=None, note='추가 키 허용')
        put('v5_single', 'f1', G, world_id='v5_single', **GT)                                # 단층은 따로 건물 키
        lst, sk = s.listing(); assert [(x['building_id'], x['floor_id'], x['map_version']) for x in lst] == [
            ('v5_single', 'f1', G), ('v5', 'l1', G), ('v5', 'l2', V), ('v5', 'l2', '20261014-100010-e2')] and sk == len(bad) + 9, (lst, sk)
        assert lst[3]['saved_sim_t'] is None and lst[0]['world_id'] == 'v5_single' and 'note' not in lst[3]
        for args in [('v5', 'l1', '20261014-100001-e1'), ('v5', 'l1', '20261014-100004-e1'), ('v5', 'l3', V), ('x', 'l1', V), ('v5', 'floor1', G),
                     ('v5', 'l1', '../l2/' + V), ('v5', 'l1', '20261014-999999-e1'), ('v5', 'l1', '20261014-100006-e1'), ('v5', 'l1', None), ('v5', 'l1', 'gt-2026101')]:
            try:
                s.get(*args); raise AssertionError(args)
            except MapErr:
                pass
        assert MapStore(None).listing() == ([], 0)
        # 높이 레이어(height.json/pgm, RL HEIGHT-CONTRACT): 정상 = RGB 무손실 · 원점 -20 vs -20.0 숫자 비교 · 어긋나면 MapErr · 없음 = MapErr
        d = root / 'v5' / 'l1' / G; hv = bytes([0, 0, 0x03, 0xE9, 0x0A, 0x8D, 0xFF, 0xFF, 0x00, 0x01, 0x05, 0xDD])     # 모름·0 m·1.7 m·최대·-1 m·0.5 m
        hp = b'P5\n3 2\n65535\n' + hv; EN = {'type': 'pgm16_be', 'row0': 'y_max (map.pgm 과 같음)', 'unknown': 0, 'rel_m': '(v-1)/1000 - 1.0', 'step_m': 0.001}
        def hput(raw=hp, **kw):
            (d / 'height.pgm').write_bytes(raw); s.cache.pop(('v5', 'l1', G, 'h'), None)
            (d / 'height.json').write_text(json.dumps({'schema': 'v2_map_height/1', 'world_id': 'v5_building', 'building_id': 'v5', 'floor_id': 'l1', 'map_version': G,
                'map_source': 'gt_raster', 'map_sha256_pgm': hashlib.sha256(b'P5\n3 2\n255\n' + px).hexdigest(), 'resolution': 0.05, 'origin': [-20.0, -14.0, 0.0],
                'width': 3, 'height': 2, 'floor_z': 0.0, 'encoding': EN,
                'height_source': 'gt_geometry', 'sensor': False, 'band_rel_m': [-1.0, 1.5], 'stats': {'rel_min': -1.0, 'rel_max': 64.534},
                'sha256_height_pgm': hashlib.sha256(raw).hexdigest(), **kw}))
        try:
            s.height('v5', 'l1', G); raise AssertionError('높이 없음인데 통과')
        except MapErr as e:
            assert '없음' in str(e)
        hput(); r = s.height('v5', 'l1', G); pg = base64.b64decode(r['png']); i, idat = 8, b''
        while i < len(pg):
            n, t = struct.unpack('>I4s', pg[i:i + 8]); idat += pg[i + 8:i + 8 + n] if t == b'IDAT' else b''; assert t in (b'IHDR', b'IDAT', b'IEND'); i += 12 + n
        z = zlib.decompress(idat); rgb = b''.join(z[y * 10 + 1:(y + 1) * 10] for y in range(2))
        assert pg[24:26] == b'\x08\x02' and bytes(rgb[0::3]) == hv[0::2] and bytes(rgb[1::3]) == hv[1::2] and not any(rgb[2::3])
        assert r['sensor'] is False and r['floor_z'] == 0.0 and 'sha256_height_pgm' not in r
        for kw, raw in [({'map_sha256_pgm': '0' * 64}, hp), ({'origin': [-20.0, -13.0, 0.0]}, hp), ({'floor_id': 'l2'}, hp), ({'sensor': True}, hp),
                        ({'sha256_height_pgm': '0' * 64}, hp), ({}, hp[:-1]), ({}, b'P5\n3 2\n255\n' + px), ({'encoding': {'type': 'pgm8'}}, hp),
                        ({'map_source': 'slam'}, hp), ({'height_source': 'slam_cloud'}, hp), ({'sensor': None}, hp), ({'band_rel_m': [1.5, -1.0]}, hp),
                        ({'band_rel_m': [-1.0, float('inf')]}, hp), ({'encoding': {**EN, 'row0': 'y_min'}}, hp), ({'encoding': {**EN, 'unknown': 0.0}}, hp),
                        ({'encoding': {**EN, 'unknown': False}}, hp)]:
            hput(raw, **kw)
            try:
                s.height('v5', 'l1', G); raise AssertionError(kw)
            except MapErr:
                pass
        hput(); (d / 'height.json').rename(d / 'h2.json'); (d / 'height.json').symlink_to(root / 'v5' / 'l2' / V / 'meta.json'); s.cache.pop(('v5', 'l1', G, 'h'), None)
        try:                                            # 파일 심볼릭 링크로 다른 버전 폴더 → 거부
            s.height('v5', 'l1', G); raise AssertionError('파일 링크 통과')
        except MapErr as e:
            assert '밖' in str(e)
        (d / 'height.json').unlink(); (d / 'h2.json').write_text('{' + ' ' * 70000 + '}'); (d / 'h2.json').rename(d / 'height.json')
        try:
            s.height('v5', 'l1', G); raise AssertionError('큰 JSON 통과')
        except MapErr as e:
            assert '너무 큼' in str(e)
        assert len(s.cache) <= 8
        for e in ('height.json', 'height.pgm'):
            (d / e).unlink()
    real = Path(os.environ.get('V2_LINK_V5_PGM', ''))        # 주면 실제 v5-l1.pgm 크기 확인(읽기만)
    if real.name and real.is_file():
        w, h, q = read_pgm(real.read_bytes()); n = len(png_gray(w, h, q)); assert (w, h) == (800, 640) and n < MAP_PNG_MAX, n
    rl = Path(os.environ.get('V2_LINK_MAPS_ROOT', ''))       # 주면 RL 정본 maps root 전체가 skip 0 으로 통과하는지(읽기만)
    if rl.name and rl.is_dir():
        lst, sk = MapStore(str(rl)).listing(); assert sk == 0 and {(x['building_id'], x['floor_id'], x['map_version']) for x in lst} >= {
            ('v5_single', 'f1', 'gt-20261012'), ('v5', 'l1', 'gt-20261012'), ('v5', 'l2', 'gt-20261012')}, (lst, sk)


def selftest_ux():
    """사용자 체험 경로(RL UX-CONTRACT) 결속: usage 칸이 맞을 때만 허용, 옛 원장 무시, 래퍼 응답도 결속 검사, 실제 래퍼 호출 0(상태 스크립트만)"""
    import tempfile
    G = {'schema': 'v2_session/1', 'result': 'idle', 'active_state': 'inactive', 'request_in_progress': False, 'usage_scope': 'user_experience', 'count_limit': None, 'ux_launch_n': 20}
    assert ux_usage(G)
    for k, v in (('usage_scope', 'experiment'), ('usage_scope', None), ('count_limit', 'unknown'), ('count_limit', 0), ('count_limit', {'total': 8}), ('schema', 'x')):
        assert not ux_usage({**G, k: v}), (k, v)
    assert not ux_usage({k: v for k, v in G.items() if k != 'count_limit'}) and not ux_usage(None)   # 칸 없음 ≠ null
    J = lambda **o: json.dumps({**G, 'result': 'starting', **o})
    assert ux_result(J(), 0)[0] == 'starting' and ux_result(J(result='ready'), 0)[0] == 'ready'
    assert ux_result(J(), 1)[0] == 'failed'                                        # 결과·종료 코드 모순
    assert ux_result(J(usage_scope='experiment'), 0)[0] == 'failed'                # 실험 경로 응답은 성공으로 채택 0
    assert ux_result(J(count_limit=8), 0)[0] == 'failed'
    assert ux_result(J(result='budget_exhausted'), 5)[0] == 'failed'               # ux 에는 5 가 없음
    assert ux_result(J(result='already_running'), 3)[0] == 'already_running' and ux_result(J(result='resource_blocked'), 4)[0] == 'resource_blocked'
    assert ux_result('{broken\n' + J(), 0)[0] == 'starting' and ux_result('x', 0)[0] == 'failed'
    t = [100.0]
    st = SimStart('/x/ux_start.sh', lambda: t[0], args=('flat',), status_name='ux_status.sh', ux=True)
    assert st.refuse(False) == '사용자 체험 경로 상태 조회 중' and st.state(False)['usage_scope'] is None
    st.polled = True; st.session, st.sess_t = {**G, 'ledger_used': 8, 'ledger_max': 8}, t[0]           # 옛 원장 칸이 있어도 무시
    assert st.refuse(False) == '' and st.ledger() is None and st.state(False)['usage_scope'] == 'user_experience'
    st.session = {**G, 'count_limit': 'unknown'}; assert st.refuse(False).startswith('사용자 체험 경로 확인 못 함') and st.state(False)['usage_scope'] is None
    for rip, want in [(True, '시작 요청 진행 중'), (None, '시작 요청 진행 여부 미확인')]:
        st.session = {**G, 'request_in_progress': rip}; assert st.refuse(False).startswith(want), rip
    st.session = {k: v for k, v in G.items() if k != 'request_in_progress'}; assert st.refuse(False).startswith('시작 요청 진행 여부 미확인')
    st.session = {**G, 'result': 'running', 'active_state': 'active', 'runner': 'live_v2', 'usage_scope': 'experiment', 'count_limit': {'total': 8, 'test': 4}}
    assert st.refuse(False).startswith('시뮬 세션이 이미')                          # 실험 세션이 unit 사용 중
    st.session = dict(G); t[0] += SimStart.FRESH + 1; assert st.refuse(False).startswith('사용자 체험 경로 확인 못 함')   # 낡음
    st.sess_t = t[0]; st.last = t[0]; assert st.refuse(False).startswith('방금 요청함')                                   # 쿨다운은 그대로
    legacy = SimStart('/x/request_session.sh', lambda: t[0]); assert legacy.state(False)['usage_scope'] == 'experiment'
    with tempfile.TemporaryDirectory() as td:
        d = Path(td); (d / 'ux_start.sh').write_text('touch "$(dirname "$0")/CALLED"\n'); (d / 'stop_live.sh').write_text('touch "$(dirname "$0")/CALLED"\n')
        (d / 'ux_status.sh').write_text("echo '" + json.dumps(G) + "'\n")
        s2 = SimStart(str(d / 'ux_start.sh'), args=('flat',), status_name='ux_status.sh', ux=True); s2.poll()
        assert s2.refuse(False) == '' and s2.state(False)['usage_scope'] == 'user_experience'
        m = MapStart(str(d / 'ux_start.sh'), status_name='ux_status.sh', prefix=('map',), ux=True); m.poll()
        assert m.wrapper and m.ledger() is None and m.usage() == 'user_experience'
        s2.last = -1e9
        assert m.refuse('rooms_a/f1', True, s2, False, False, None) == '' and m.state(True, s2, False, False, None)['usage_scope'] == 'user_experience'
        m.session = {**G, 'request_in_progress': True}; assert m.refuse('rooms_a/f1', True, s2, False, False, None).startswith('시작 요청 진행 중')
        # 반례(Codex 10-14): 상태 스크립트 rc≠0 이면 그럴듯한 idle JSON 도 미확인 · unit 이 확실히 꺼짐(inactive·failed)일 때만 시작 가능
        for body, ok in [("echo '" + json.dumps(G) + "'; exit 1\n", False), ("echo '" + json.dumps({**G, 'schema': 'x'}) + "'\n", False),
                         ("echo '" + json.dumps({**G, 'active_state': 'failed'}) + "'\n", True)]:
            (d / 'ux_status.sh').write_text(body); s2.poll()
            assert (s2.refuse(False) == '') is ok and (s2.state(False)['ok']) is ok, body
        for a_ in ('active', 'activating', 'deactivating', 'unknown', '', None):
            s2.session = {**G, 'active_state': a_}; s2.sess_t = s2.now()
            assert s2.refuse(False).startswith('Gazebo unit') and not s2.state(False)['ok'], a_
        s2.session = {k: v for k, v in G.items() if k != 'active_state'}; assert s2.refuse(False) == 'Gazebo unit 상태 미확인'
        assert not (d / 'CALLED').exists()   # 반례 전부에서 래퍼(시작·종료) 호출 0
        m.session = {**G, 'usage_scope': None, 'count_limit': 'unknown'}; assert m.refuse('rooms_a/f1', True, s2, False, False, None).startswith('사용자 체험 경로 확인 못 함')
        assert MapStart(str(d / 'ux_start.sh')).wrapper is None                        # 옛 이름(map_status.sh) 없으면 옛 경로로 안 붙음
        sp = SimStop(None, stop=str(d / 'stop_live.sh'), status=str(d / 'ux_status.sh'))
        assert sp.wrapper and sp.status_sh.endswith('ux_status.sh')
        on = {**G, 'result': 'running', 'active_state': 'active', 'runner': 'ux_flat'}
        x = sp.state(True, False, False, on, None, 'ux_flat', None, on)
        assert x['ledger_kind'] == 'user' and x['ledger_left'] is None and x['on']
        exp = {**G, 'result': 'running', 'active_state': 'active', 'runner': 'live_v2', 'usage_scope': 'experiment', 'count_limit': {'total': 8}, 'ledger_used': 8, 'ledger_max': 8}
        assert sp.state(True, False, False, exp, None, 'live_v2', None, exp)['ledger_kind'] == 'online'
        assert not (d / 'CALLED').exists()                                          # 상태 조회·판정만 — 시작·정지 래퍼 호출 0


# ---------------------------------------------------------------- 건물 전체 GT 간략 기하(읽기만, op geom_get) — RL v2_building_geom/1
# 파일 = <geom_root>/<GEOM_FILES[building_id]>. 쓰기는 RL 생성기만. 센서·주행 판정 아님 · 정밀도 주장 0. 앱 ui/src/data/geom.ts okGeom 과 같은 한도(GEOM_LIM)
GEOM_FILES = {'v5': ('v5_building', 'v5_building_geom.json')}
GEOM_LIM = {'bytes': 512 * 1024, 'floors': 8, 'boxes': 2000, 'meshes': 64, 'connectors': 32, 'coord': 500}   # 좌표 |m| 한도
GEOM_KINDS = ('floor', 'wall', 'stair', 'ramp', 'obstacle', 'ceiling', 'other')


def geom_check(g, building_id, world_id):
    """서버 쪽 엄격 검사 — 하나라도 어긋나면 MapErr(일부만 보내기 0). 앱이 같은 규칙으로 다시 검사한다"""
    fin = lambda x: type(x) in (int, float) and math.isfinite(x) and abs(x) <= GEOM_LIM['coord']
    v3 = lambda p: isinstance(p, list) and len(p) == 3 and all(fin(x) for x in p)
    ab = lambda a: isinstance(a, list) and len(a) == 6 and all(fin(x) for x in a) and a[0] <= a[3] and a[1] <= a[4] and a[2] <= a[5]
    lst = lambda k, n: isinstance(g.get(k), list) and len(g[k]) <= n
    if not isinstance(g, dict) or g.get('schema') != 'v2_building_geom/1':
        raise MapErr('기하 형식 버전 다름')
    if g.get('building_id') != building_id or g.get('world_id') != world_id:
        raise MapErr('다른 건물·world 기하')
    if g.get('frame') != 'world' or g.get('source') != 'gt_sdf' or g.get('sensor') is not False or g.get('precision_claim') is not False:
        raise MapErr('기하 출처 표시 이상(GT·센서 아님·정밀도 주장 0 이어야)')
    if not lst('floors', GEOM_LIM['floors']) or not g['floors'] or not all(isinstance(f, dict) and isinstance(f.get('floor_id'), str) and fin(f.get('z')) for f in g['floors']):
        raise MapErr('층 목록 이상')
    fs = [f['floor_id'] for f in g['floors']]
    if len(set(fs)) != len(fs):
        raise MapErr('층 이름 중복')
    sh = g.get('sdf_sha256')
    if not isinstance(sh, dict) or set(sh) != set(fs) or not all(isinstance(x, str) and re.fullmatch(r'[0-9a-f]{64}', x) for x in sh.values()):
        raise MapErr('원본 SDF sha 없음·층과 다름 — 결속 불가')
    if not (lst('boxes', GEOM_LIM['boxes']) and lst('meshes', GEOM_LIM['meshes']) and lst('connectors', GEOM_LIM['connectors'])):
        raise MapErr('기하 목록 이상·개수 한도 넘음')
    fl = lambda f: f is None or f in fs
    for b in g['boxes']:
        if not (isinstance(b, dict) and b.get('approximation') == 'exact_box' and isinstance(b.get('corners'), list) and len(b['corners']) == 8
                and all(v3(p) for p in b['corners']) and ab(b.get('aabb')) and fl(b.get('floor_id')) and b.get('kind') in GEOM_KINDS and isinstance(b.get('id'), str)):
            raise MapErr(f'상자 형식 이상 · {safe_txt(b.get("id") if isinstance(b, dict) else "?", 40)}')
    for m in g['meshes']:
        if not (isinstance(m, dict) and m.get('approximation') == 'aabb' and ab(m.get('aabb')) and fl(m.get('floor_id')) and m.get('kind') in GEOM_KINDS
                and m.get('fill') is False and isinstance(m.get('id'), str)):
            raise MapErr(f'mesh 형식 이상(외곽 상자·채움 0 이어야) · {safe_txt(m.get("id") if isinstance(m, dict) else "?", 40)}')
    for c in g['connectors']:
        if not (isinstance(c, dict) and c.get('kind') in ('stair', 'ramp') and c.get('from') in fs and c.get('to') in fs and v3(c.get('entry')) and v3(c.get('exit'))
                and c.get('traversable_claim') is False and isinstance(c.get('id'), str)):
            raise MapErr(f'층 연결 형식 이상(통과 가능 주장 0 이어야) · {safe_txt(c.get("id") if isinstance(c, dict) else "?", 40)}')


def geom_read(root, building_id):
    """루트 안 정해진 파일만(경로 탈출·심볼릭 링크 밖 0) · ≤ 512 KB · 엄격 검사 → (geom, 파일 sha256). 실패는 MapErr(친절한 이유)"""
    if not isinstance(building_id, str) or building_id not in GEOM_FILES:
        raise MapErr('건물 전체 3D 를 지원하지 않는 건물')
    if not root:
        raise MapErr('서버에 건물 기하 경로 없음(--geom-root 미설정)')
    world_id, name = GEOM_FILES[building_id]
    base = os.path.realpath(root); f = os.path.realpath(os.path.join(base, name))
    if os.path.dirname(f) != base:
        raise MapErr('기하 파일이 기하 루트 밖')
    try:
        with open(f, 'rb') as h:
            raw = h.read(GEOM_LIM['bytes'] + 1)
    except FileNotFoundError:
        raise MapErr('이 건물 기하 파일 없음')
    if len(raw) > GEOM_LIM['bytes']:
        raise MapErr('기하 파일이 512 KB 넘음')
    try:
        g = json.loads(raw, parse_constant=lambda x: (_ for _ in ()).throw(ValueError(x)))   # NaN·Infinity 거부
    except ValueError:
        raise MapErr('기하 파일 JSON 아님')
    geom_check(g, building_id, world_id)
    return g, hashlib.sha256(raw).hexdigest()


def selftest_geom():
    import copy, tempfile
    box = {'id': 'b', 'floor_id': 'l1', 'kind': 'floor', 'approximation': 'exact_box', 'aabb': [0, 0, 0, 1, 1, 0.1],
           'corners': [[i & 4 and 1, i & 2 and 1, i & 1 and 0.1] for i in range(8)]}
    G = {'schema': 'v2_building_geom/1', 'building_id': 'v5', 'world_id': 'v5_building', 'frame': 'world', 'source': 'gt_sdf', 'sensor': False, 'precision_claim': False,
         'sdf_sha256': {'l1': 'a' * 64, 'l2': 'b' * 64}, 'floors': [{'floor_id': 'l1', 'z': 0.0}, {'floor_id': 'l2', 'z': 2.4}], 'boxes': [box],
         'meshes': [{'id': 'r', 'floor_id': None, 'kind': 'ramp', 'approximation': 'aabb', 'aabb': [0, 0, 0, 2, 1, 1], 'fill': False}],
         'connectors': [{'id': 's', 'kind': 'stair', 'from': 'l1', 'to': 'l2', 'entry': [3, 4, 0], 'exit': [7.8, 4, 2.4], 'traversable_claim': False}]}
    geom_check(copy.deepcopy(G), 'v5', 'v5_building')
    bad = [lambda g: g.update(sensor=True), lambda g: g.update(world_id='v5_single'), lambda g: g['floors'].append({'floor_id': 'l1', 'z': 5}),
           lambda g: g['sdf_sha256'].pop('l2'), lambda g: g['boxes'][0]['corners'].pop(), lambda g: g['boxes'][0].update(kind='door'),
           lambda g: g['boxes'][0]['corners'][0].__setitem__(0, 501), lambda g: g['boxes'][0].update(aabb=[1, 0, 0, 0, 1, 1]),
           lambda g: g['meshes'][0].update(fill=True), lambda g: g['connectors'][0].update(traversable_claim=True),
           lambda g: g.update(boxes=[box] * 2001), lambda g: g.update(connectors=g['connectors'] * 33), lambda g: g['boxes'][0].update(floor_id='l9')]
    for i, f in enumerate(bad):
        g = copy.deepcopy(G); f(g)
        try:
            geom_check(g, 'v5', 'v5_building'); raise AssertionError(f'geom bad {i} 통과')
        except MapErr:
            pass
    with tempfile.TemporaryDirectory() as d:
        r = os.path.join(d, 'root'); os.mkdir(r)
        for why, setup in [('경로 없음', None), ('파일 없음', lambda: None), ('512', lambda: Path(r, 'v5_building_geom.json').write_bytes(b' ' * (GEOM_LIM['bytes'] + 1))),
                           ('JSON', lambda: Path(r, 'v5_building_geom.json').write_text('{"a": NaN}')),
                           ('루트 밖', lambda: (Path(r, 'v5_building_geom.json').unlink(), Path(d, 'out.json').write_text(json.dumps(G)), os.symlink(os.path.join(d, 'out.json'), os.path.join(r, 'v5_building_geom.json'))))]:
            setup and setup()
            try:
                geom_read(None if why == '경로 없음' else r, 'v5'); raise AssertionError(why)
            except MapErr:
                pass
        Path(r, 'v5_building_geom.json').unlink(); Path(r, 'v5_building_geom.json').write_text(json.dumps(G))
        g, h = geom_read(r, 'v5'); assert g['building_id'] == 'v5' and len(h) == 64
        try:
            geom_read(r, ['v5']); raise AssertionError('건물')
        except MapErr:
            pass


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
    c.drop('a', '연결 끊김'); assert c.controller is None and c.applied() == Z and c.latch
    st(stop=True, ep=3); assert c.take('a') and c.resume('a'); c.drop('a', '로그아웃'); assert c.latch and not c.resume_pending   # 재개 대기 중 끊김도 잠금
    assert c.take('b'); c.cmd('b', F); assert c.applied() == Z         # 새 조종권도 손 뗌 먼저(+래치)
    selftest_extra(); selftest_stop(); selftest_stopgen(); selftest_camwhy(); selftest_maps(); selftest_live(); selftest_ux(); selftest_views(); selftest_geom()
    print('selftest OK')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=8790)
    ap.add_argument('--web', default=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'web'))
    repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    ap.add_argument('--media', default=os.path.join(repo, 'runs', 'app-media'), help='서버 보관 사진·사건 폴더')
    ap.add_argument('--sim-start', default=None, help='RL 래퍼(request_session.sh) 절대경로. 없으면 «시뮬 시작» 버튼은 이유만 보임')
    ap.add_argument('--store', default='json', help='공용 문서 저장: json(기본, <media>/docs.json) 또는 sqlite:<DB 경로>(없으면 docs.json 을 읽어 이전)')
    ap.add_argument('--maps-root', default=None, help='저장 지도 루트(읽기만, <건물>/<층>/<버전>/). 없으면 지도 목록 빈 칸')
    ap.add_argument('--map-start', default=None, help='RL 지도 체험 시작(start_map.sh) 절대경로. 같은 폴더 map_status.sh 로 지도 원장 조회. 없으면 «지도 체험 시작» 이유만')
    ap.add_argument('--ux-start', default=None, help='RL 사용자 체험 래퍼(ux_start.sh) 절대경로 — 주면 시뮬 시작=flat·지도 체험=map, 상태 ux_status.sh(같은 폴더), 횟수 원장 대신 usage 결속 확인. --sim-start·--map-start 와 같이 못 씀')
    ap.add_argument('--ux-stop', default=None, help='--ux-start 와 함께: Gazebo 종료 stop_live.sh 절대경로(같은 unit)')
    ap.add_argument('--geom-root', default=None, help='건물 전체 GT 간략 기하 폴더(읽기만, RL 생성 v5_building_geom.json). 없으면 «전체 3D» 이유만')
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
    from nav_msgs.msg import OccupancyGrid
    from rclpy.qos import DurabilityPolicy
    from std_srvs.srv import Trigger
    import tornado.ioloop, tornado.web, tornado.websocket

    core = Core(); lock = threading.Lock()
    sim = {'jpeg': None, 'jpeg_t': None, 'jpeg_n': 0, 'jpeg_wall': None, 'jpeg_stamp': None, 'jpeg_ep': None, 'jpeg_reset': False}
    media = Media(a.media); core.sink = media.event
    docs, docs_note = open_docs(a.store, a.media)
    if docs_note:
        core.ev('warn', docs_note); print(docs_note, flush=True)
    if a.ux_start:                  # 사용자 체험 경로 — 옛 경로와 섞지 않음, 파일이 다 있어야 기동
        if a.sim_start or a.map_start:
            sys.exit('[v2_link] --ux-start 는 --sim-start·--map-start 와 같이 쓰지 않는다')
        ux = Path(a.ux_start)
        if not (ux.is_absolute() and ux.is_file() and ux.with_name('ux_status.sh').is_file() and a.ux_stop and Path(a.ux_stop).is_absolute() and Path(a.ux_stop).is_file()):
            sys.exit('[v2_link] --ux-start(절대경로·옆 ux_status.sh)·--ux-stop(절대경로) 파일 확인 실패')
        starter = SimStart(str(ux), args=('flat',), status_name='ux_status.sh', ux=True)
        stopper = SimStop(None, stop=a.ux_stop, status=str(ux.with_name('ux_status.sh')))
        mapper = MapStart(str(ux), status_name='ux_status.sh', prefix=('map',), ux=True)
    else:
        starter = SimStart(a.sim_start if a.sim_start and os.path.isfile(a.sim_start) else None)
        stopper = SimStop(starter.wrapper)
        mapper = MapStart(a.map_start)
    maps = MapStore(a.maps_root)
    live = LiveMap()
    save = {'busy': False, 'seq': 0, 'wait': {}}      # 지도 저장: 처리 중 1건, 요청 순번 → (연결, rid, 요청 때 epoch)
    photo_last = [0.0]
    poll_start = bool(starter.wrapper and Path(starter.wrapper).with_name(starter.status_name).is_file())
    if poll_start or mapper.status_sh:
        def poll_loop():            # 상태 스크립트(읽기만) — 켜지는 중 2 s, 그 밖 5 s
            while True:
                dt = starter.poll() if poll_start else 5.0
                mapper.poll()
                time.sleep(2.0 if starter.busy or (mapper.session or {}).get('result') == 'starting' else dt)
        threading.Thread(target=poll_loop, daemon=True).start()
    ver = {'t': -1e9, 'v': '미확인'}

    def version():                  # 지금 디스크의 판(커밋 + 미커밋 수정 여부). 열린 탭이 옛 판인지 화면이 비교한다
        if time.monotonic() - ver['t'] > 5:
            try:
                h = subprocess.run(['git', '-C', repo, 'rev-parse', '--short', 'HEAD'], capture_output=True, text=True, timeout=3).stdout.strip()
                d = subprocess.run(['git', '-C', repo, 'status', '--porcelain', '--', 'web', 'sim'], capture_output=True, text=True, timeout=3).stdout.strip()
                ver['v'] = (h or '미확인') + ('+수정' if d else '')
            except Exception:
                ver['v'] = '미확인'
            ver['t'] = time.monotonic()
        return ver['v']
    clients = {}
    allowed_origins = {f'http://127.0.0.1:{a.port}', f'http://localhost:{a.port}'}

    from rclpy.signals import SignalHandlerOptions
    # rclpy 기본 SIGINT 처리기는 컨텍스트를 먼저 닫아 아래 «끝낼 때 0» 발행이 실패한다 → Ctrl+C 는 파이썬 KeyboardInterrupt 로 받는다
    rclpy.init(signal_handler_options=SignalHandlerOptions.NO); node = Node('fh_app_v2_link')
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
        if not ok:
            live.release()

    def on_cam(m):
        with lock:
            sim['jpeg'] = bytes(m.data); sim['jpeg_t'] = time.monotonic(); sim['jpeg_n'] += 1
            sim['jpeg_wall'] = time.time(); sim['jpeg_stamp'] = m.header.stamp.sec + m.header.stamp.nanosec * 1e-9
            # 받은 순간의 episode·리셋 여부(사진 저장 때 대조 — 옛 episode 프레임이 새 episode 에 붙지 않게)
            sim['jpeg_ep'] = core.episode
            sim['jpeg_reset'] = bool(core.reset_pending or (core.st or {}).get('reset_in_progress'))

    def on_map_status(m):           # /v2_map/status(1 Hz) — 형식 틀림은 LiveMap 이 «모름»으로
        try:
            d = json.loads(m.data)
        except Exception:
            d = None
        try:
            live.on_status(d)
        except Exception as e:      # 형식 차단을 지나친 예외도 ROS spin 을 죽이지 않게(그 status 만 버림)
            print(f'[v2_link] /v2_map/status 처리 실패 {type(e).__name__}', flush=True)

    def on_grid(m):                 # 최신 1장만 넘김(변환·검사는 일꾼). data 는 int8 배열 → 바이트 복사 한 번
        try:
            i = m.info; o, q = i.origin.position, i.origin.orientation
            live.on_grid({'frame': m.header.frame_id, 'w': i.width, 'h': i.height, 'res': i.resolution, 'origin': (o.x, o.y, o.z), 'q': (q.x, q.y, q.z, q.w),
                          'stamp': m.header.stamp.sec + m.header.stamp.nanosec * 1e-9,
                          'data': m.data.tobytes() if hasattr(m.data, 'tobytes') else bytes(x & 255 for x in m.data)})
        except Exception as e:
            print(f'[v2_link] /v2_map/map 처리 실패 {type(e).__name__}', flush=True)

    def map_worker():               # ≤1 Hz: PNG 변환 + (static) 저장 meta 대조는 여기서 — ROS·IOLoop·조종 lock 밖
        while True:
            live.wake.wait(); live.wake.clear()
            g = live.take()
            if g:
                try:
                    png, why = grid_png(g); k = live.static_key()
                    live.commit(g, png, why or static_meta_why(g, k, maps.get), k)
                except Exception as e:
                    live.commit(g, None, f'격자 처리 실패 · {type(e).__name__}')
            time.sleep(1.0)

    node.create_subscription(String, '/v2_live/state', on_state, rel)
    node.create_subscription(String, '/v2_map/status', on_map_status, rel)
    node.create_subscription(OccupancyGrid, '/v2_map/map', on_grid,
                             QoSProfile(depth=1, reliability=ReliabilityPolicy.RELIABLE, durability=DurabilityPolicy.TRANSIENT_LOCAL, history=HistoryPolicy.KEEP_LAST))
    cli_save = node.create_client(Trigger, '/v2_map/save')
    threading.Thread(target=map_worker, daemon=True).start()
    node.create_subscription(CompressedImage, '/v2_live/camera/compressed', on_cam, QoSProfile(depth=1, reliability=ReliabilityPolicy.RELIABLE, history=HistoryPolicy.KEEP_LAST))
    views = Views(live.cur_key, sim_fn=live.sim_span)     # 보조 관제 뷰: 최신 1개만, 앱이 view_get 으로 끌어감(push 0)
    q1 = QoSProfile(depth=1, reliability=ReliabilityPolicy.RELIABLE, history=HistoryPolicy.KEEP_LAST)
    node.create_subscription(String, '/v2_map/points_view', lambda m: views.on_points(m.data), q1)
    node.create_subscription(String, '/v2_map/follow_cam', lambda m: views.on_follow(m.data), q1)
    # spin 은 명시 executor + 짧은 spin_once 반복: 끝낼 때 멈춤 → join(진행 중 콜백 끝남) → 그 뒤에 node·context 파괴.
    # (옛: daemon rclpy.spin 을 둔 채 destroy → 대기 중인 rcl 스레드와 경합, INT 종료 rc -6 «terminate called without an active exception»)
    from rclpy.executors import SingleThreadedExecutor
    ex = SingleThreadedExecutor(); ex.add_node(node); spin_stop = threading.Event()

    def spin_loop():
        while not spin_stop.is_set() and rclpy.ok():
            ex.spin_once(timeout_sec=0.1)
    spin_t = threading.Thread(target=spin_loop, daemon=True); spin_t.start()

    last_stop_pub = [0.0]

    def tick():                     # 20 Hz: 명령 발행 + STOP 재전송(시뮬이 래치를 확인할 때까지)
        with lock:
            vx, vy, wz = core.out = core.applied(); want_stop = core.want_stop_pub()
        t = Twist(); t.linear.x, t.linear.y, t.angular.z = vx, vy, wz; pub_cmd.publish(t)
        if want_stop and time.monotonic() - last_stop_pub[0] > 0.5:
            pub_stop.publish(Empty()); last_stop_pub[0] = time.monotonic()

    def sim_live():                 # 시뮬이 지금 돌고 있나(시작 버튼 거부용)
        return core.st is not None and core.state_t is not None and time.monotonic() - core.state_t < 3

    def snapshot(c):
        cid = c.cid
        now = time.monotonic()
        v = version()
        lv = live.view(); sv_why = save_refuse(c.gated, save['busy'], lv, cli_save.service_is_ready()); vw = views.view()
        for k_, p_ in live.prod().items():
            vw[k_]['prod'] = p_
        with lock:
            holder = clients[core.controller].actor if core.controller in clients else None
            age = None if core.state_t is None else round(now - core.state_t, 2)
            cam_age = None if sim['jpeg_t'] is None else round(now - sim['jpeg_t'], 2)
            role = 'control' if core.controller == cid else ('view_other' if core.controller else 'view')
            # 서버 출력(applied)·이유는 누구나 같은 값을 읽는다. role 은 송신 허용에만 쓴다
            return {'op': 'status', 'role': role, 'latch': core.latch, 'stop_gen': core.stop_gen, 'applied': list(core.out), 'reason': core.reason,
                    'sim_block': core.sim_block(), 'resume_pending': bool(core.resume_pending), 'reset_pending': core.reset_pending is not None,
                    'episode': core.episode, 'ros_domain': os.environ.get('ROS_DOMAIN_ID'), 'state_age': age, 'cam_age': cam_age, 'sim': core.st, 'events': list(core.events)[:6], 'note': PRESETS_NOTE,
                    'me': c.actor, 'holder': holder, 'ver': v, 'sim_start': starter.state(sim_live()), 'docs_rev': docs.rev,
                    'sim_stop': stopper.state(c.gated, starter.busy, sim_live(), starter.session, holder if core.controller not in (None, cid) else None,
                                              mapper.runner(), mapper.ledger(), mapper.session if mapper.fresh() else None),
                    'map_start': mapper.state(c.gated, starter, stopper.busy, sim_live(), holder if core.controller not in (None, cid) else None),
                    'live_map': lv, 'map_save': {'ok': not sv_why, 'why': sv_why, 'busy': save['busy']}, 'views': vw}

    def reply(c, rid, ok, text, **kw):
        try:
            c.write_message(json.dumps({'op': 'reply', 'rid': rid, 'ok': ok, 'text': text, **kw}, ensure_ascii=False))
        except tornado.websocket.WebSocketClosedError:
            pass

    def take_photo(c, rid):
        """서버가 가진 최신 프레임을 저장한다. 위치(GT)는 저장 요청 때 받은 최신 상태값이다 — 프레임 시각에 맞춘 동기 GT 가 아니다.
        episode 연관은 확인될 때만 저장: 프레임·상태 1 s 안, 리셋 아님, 프레임 받을 때와 지금의 episode 같음, episode 바뀐 뒤 1 s 지남"""
        now = time.monotonic()
        with lock:
            if now - photo_last[0] < 0.5:
                return reply(c, rid, False, '사진 실패 · 너무 빠름(0.5 s 에 한 장)')
            if sim['jpeg'] is None or now - sim['jpeg_t'] > 1.0:
                return reply(c, rid, False, '사진 실패 · 지금 받은 영상 없음(1 s 안의 프레임 없음)')
            why = cam_why(core, sim, now)
            if why:
                return reply(c, rid, False, f'사진 실패 · {why} — 잠시 뒤 다시')
            photo_last[0] = now
            jpeg = sim['jpeg']
            meta = {'frame_at': time.strftime('%Y-%m-%dT%H:%M:%S', time.localtime(sim['jpeg_wall'])) + f'.{int(sim["jpeg_wall"] % 1 * 1000):03d}' + time.strftime('%z'),
                    'frame_stamp_sim_s': sim['jpeg_stamp'], 'episode': core.episode, 'by': c.actor,
                    'source': st.get('source'), 'x': st.get('x'), 'y': st.get('y'), 'yaw': st.get('yaw'),
                    'gt_note': '위치 = 저장 요청 때 받은 최신 GT(프레임 동기 아님)', 'gt_age_s': round(now - core.state_t, 2),
                    'camera': 'Gazebo 렌더(실카메라 아님)'}
        try:
            meta = media.photo(jpeg, meta)
        except OSError as e:
            return reply(c, rid, False, f'사진 저장 실패 · {type(e).__name__}')
        with lock:
            core.ev('ok', f'사진 저장 · {c.actor} · episode {meta["episode"]}')
        reply(c, rid, True, '사진 서버 저장', photo=meta)

    def start_sim(c, rid):
        with lock:
            holder = clients[core.controller].actor if core.controller in clients and core.controller != c.cid else None
            why = 'Gazebo 종료 처리 중' if stopper.busy else starter.refuse(sim_live()) or (f'{holder} 조종 중 — 그 기기에서 STOP·반납한 뒤' if holder else '')
            if why:
                core.ev('warn', f'시뮬 시작 거부 · {why}'); return reply(c, rid, False, why)
            starter.busy = True; starter.last = time.monotonic()
            core.busy_sim('시뮬 시작 처리 중')          # 지도 체험과 같음: 조종권 해제·0·STOP 잠금·입력 폐기, 끝날 때까지 take·resume·reset 거부(끝나도 잠금 유지)
            core.ev('warn', f'시뮬 시작 요청(30분) · {c.actor} · STOP 상태로 시작')
        reply(c, rid, True, '시뮬 시작 요청함 — 아직 켜진 것 아님 · 결과는 «최근 시작 결과»에 표시')

        def run():                  # ROS·웹 스레드를 막지 않게 따로. 재시도·연장 없음
            try:
                r = subprocess.run(['bash', starter.wrapper, *starter.args], capture_output=True, text=True, timeout=240)
                res, extra = (ux_result if starter.ux else parse_session)(r.stdout, r.returncode)
            except subprocess.TimeoutExpired:   # 240 s ≥ RL ux_start 최대 대기(sctl 10 s·systemd-run 30·기동 30·state 8 등) — 넘으면 실패가 아니라 미확인
                res, extra = 'timeout', ''
            except Exception as e:
                res, extra = 'failed', type(e).__name__
            ok_ = res in ('starting', 'ready')
            text = START_TEXT[res]
            with lock:
                starter.busy = False; core.sim_busy = ''   # 처리 중 표시만 해제 — 잠금·조종권 자동 복원 0
                starter.result = {'t': time.strftime('%H:%M:%S'), 'st': 'ok' if ok_ else 'bad', 'text': f'{text}{" · " + extra if extra else ""}'[:200]}
                core.ev('ok' if ok_ else 'bad', f'시뮬 시작 결과 · {starter.result["text"]}')
        threading.Thread(target=run, daemon=True).start()

    def start_map(c, rid, m):
        """지도 체험 시작: 인자 허용표 검사 → 같은 조종 lock 에서 0·STOP 잠금·입력 폐기·조종권 해제 + 처리 중 take/resume/reset/비영 차단 → start_map.sh 1회.
        재시도·연장·자동 take/resume 0. 끝나도 STOP 잠금 유지"""
        args, key, why = map_args(m, lambda b, f, v: bool(maps.root) and (maps.root / b / f / v / 'meta.json').is_file(), mapper.follow_ok())
        with lock:
            holder = clients[core.controller].actor if core.controller in clients and core.controller != c.cid else None
            why = why or mapper.refuse(key, c.gated, starter, stopper.busy, sim_live(), holder)
            if why:
                core.ev('warn', f'지도 체험 시작 거부 · {key or "인자 틀림"} {safe_txt(m.get("mode"), 10)} · {c.actor} · {why}'); return reply(c, rid, False, why)
            starter.busy = True; starter.last = time.monotonic(); core.busy_sim('지도 체험 시작 처리 중')
            core.ev('warn', f'지도 체험 시작 요청 · {key} {args[2]}{" " + args[3] if len(args) > 3 else ""} · {c.actor} · STOP 상태로 시작')
        live.hold()
        reply(c, rid, True, f'지도 체험 시작 요청함({key} {args[2]}) — 준비되면 지도·영상이 들어옵니다')

        def run():
            try:
                r = subprocess.run(['bash', mapper.wrapper, *mapper.prefix, *args], capture_output=True, text=True, timeout=240)
                res, extra = (ux_result if mapper.ux else map_result)(r.stdout, r.returncode)
            except subprocess.TimeoutExpired:   # 240 s ≥ RL ux_start 최대 대기(sctl 10 s·systemd-run 30·기동 30·state 8 등) — 넘으면 실패가 아니라 미확인
                res, extra = 'timeout', ''
            except Exception as e:
                res, extra = 'failed', type(e).__name__
            text = START_TEXT[res]
            with lock:
                starter.busy = False; core.sim_busy = ''
                mapper.last = {'t': time.strftime('%H:%M:%S'), 'st': 'ok' if res in ('starting', 'ready') else 'bad', 'text': f'{key} · {text}'}
                core.ev(mapper.last['st'], f'지도 체험 시작 결과 · {key} · {text}{" · " + safe_txt(extra, 120) if extra else ""}')
            mapper.poll()
        threading.Thread(target=run, daemon=True).start()

    def save_map(c, rid):
        """/v2_map/save 1회, 10 s 제한. 응답의 path 는 버림. 시간 넘으면 «결과 미확인»(서버 저장은 늦게 끝날 수 있음 — 목록 재조회), 자동 재호출 0.
        늦은 응답·연결 끊긴 뒤 응답은 사건으로만(요청 순번 대조)"""
        v = live.view(); why = save_refuse(c.gated, save['busy'], v, cli_save.service_is_ready())
        if why:
            core.ev('warn', f'지도 저장 거부 · {c.actor} · {why}'); return reply(c, rid, False, why)
        save['busy'] = True; save['seq'] += 1; n = save['seq']; save['wait'][n] = (c, rid, v['epoch'])
        req = {k: v.get(k) for k in SAVE_CTX}       # 요청 때 출처(응답은 이것과 대조 — 지금 상태 재읽기로 성공 판정 0)
        loop = tornado.ioloop.IOLoop.current()
        with lock:
            core.ev('ok', f'지도 저장 요청 · epoch {v["epoch"]} · {c.actor}')

        def finish(n, ok, text, late=False, ctx=None):
            w = save['wait'].pop(n, None)
            if n == save['seq']:
                save['busy'] = False
            with lock:
                core.ev('ok' if ok else 'warn', ('늦은 지도 저장 응답(현재 지도·결과로 쓰지 않음) · ' if late else '') + text)
            if w and not late and w[0].cid in clients:
                reply(w[0], w[1], ok, text, **({'save': ctx} if ok and ctx else {}))

        def done(f):                # ROS 스레드
            try:
                r = f.result(); ok, text, ctx = save_result(r.success, r.message, req)
            except Exception as e:
                ok, text, ctx = False, f'지도 저장 결과 미확인 · {type(e).__name__} — 저장 지도 목록 다시 확인', None
            def on_loop():
                w = save['wait'].get(n)
                if w is None:       # 이미 시간 초과로 닫힘
                    return finish(n, ok, text, late=True)
                ep_now = live.view().get('epoch')
                finish(n, ok, text + (f' · 요청 때 epoch {w[2]}, 지금 {ep_now}' if ep_now != w[2] else ''), ctx=ctx)
            loop.add_callback(on_loop)

        def timeout():
            if n in save['wait']:
                finish(n, False, '지도 저장 결과 미확인 · 10 s 안에 응답 없음(늦게 저장될 수 있음) — 저장 지도 목록 다시 확인')
                save['wait'].pop(n, None)
        cli_save.call_async(Trigger.Request()).add_done_callback(done)
        loop.call_later(10.0, timeout)

    def stop_sim(c, rid):
        with lock:
            holder = clients[core.controller].actor if core.controller in clients and core.controller != c.cid else None
            why = stopper.refuse(c.gated, starter.busy, sim_live(), starter.session, holder, mapper.session if mapper.fresh() else None)
            if why:
                core.ev('warn', f'Gazebo 종료 거부 · {why}'); return reply(c, rid, False, why)
            stopper.busy = True; stopper.last_t = time.monotonic(); core.sim_busy = 'Gazebo 종료 중'
            core.drop(c.cid, 'Gazebo 종료')           # 본인 조종 중이면 입력 폐기·0·STOP 잠금·반납(다시 조종하려면 새 take)
            core._lock()
            core.ev('warn', f'Gazebo 종료 요청 · {c.actor} · 명령 0 잠금')
        live.hold()                 # 지도·마커도 바로 버림(세션이 바뀔 때까지)
        reply(c, rid, True, 'Gazebo 종료 요청함 — ROS 세션 종료가 확인되면 표시합니다')

        def state_age():
            with lock:
                return None if core.state_t is None else time.monotonic() - core.state_t

        def run_wrapper(timeout):   # 시간 안에 안 끝나도 죽이지 않는다(systemctl 쪽 TimeoutStopSec 45) — 나중에 따로 거둠
            p = subprocess.Popen(['bash', stopper.wrapper], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                return p.wait(timeout)
            except subprocess.TimeoutExpired:
                threading.Thread(target=p.wait, daemon=True).start(); return None

        def run():                  # 조종 lock·20 Hz·영상을 막지 않게 따로. 연결이 끊기거나 로그아웃해도 결과는 기록되고 busy 는 풀린다
            try:
                st_, text = stop_run(stopper, run_wrapper, lambda to: unit_state(read_session(stopper.status_sh, to)), state_age)
            except Exception as e:
                st_, text = 'bad', f'Gazebo 종료 확인 못 함 · {type(e).__name__}'
            with lock:
                stopper.busy = False; core.sim_busy = ''; stopper.last = {'t': time.strftime('%H:%M:%S'), 'st': st_, 'text': text}
                core.ev(st_, text)
        threading.Thread(target=run, daemon=True).start()

    def map_op(c, rid, op, m):
        """저장 지도 읽기(파일·sha·PNG 변환)는 IOLoop 밖. 연결마다 한 번에 하나 — 조종·STOP·영상 처리를 막지 않는다"""
        if c.map_busy:
            return reply(c, rid, False, '지도 요청 처리 중')
        c.map_busy = True
        a = (m.get('building_id'), m.get('floor_id'), m.get('map_version'))
        work = ((lambda: {'maps': maps.listing()[0]}) if op == 'map_list' else (lambda: {'height': maps.height(*a)}) if op == 'height_get'
                else (lambda: {'map': maps.get(*a)}))
        loop = tornado.ioloop.IOLoop.current()

        def done(fut):
            c.map_busy = False
            try:
                reply(c, rid, True, '', **fut.result())
            except MapErr as e:
                reply(c, rid, False, f'지도 · {e}')
            except Exception as e:
                reply(c, rid, False, f'지도 읽기 실패 · {type(e).__name__}')
        loop.add_future(loop.run_in_executor(None, work), done)

    def geom_op(c, rid, m):
        """건물 기하 읽기(파일·검사)는 IOLoop 밖 · 연결마다 한 번에 하나 · 5 s 넘으면 이유로 답(늦은 결과 버림, 끝날 때까지 busy 유지 — 스레드 쌓임 0)"""
        if c.geom_busy:
            return reply(c, rid, False, '건물 기하 요청 처리 중')
        c.geom_busy = True; sent = [False]
        loop = tornado.ioloop.IOLoop.current()

        def once(ok, text, **kw):
            if not sent[0]:
                sent[0] = True; reply(c, rid, ok, text, **kw)

        def done(fut):
            c.geom_busy = False
            try:
                g, h = fut.result(); once(True, '', geom=g, geom_sha256=h)
            except MapErr as e:
                once(False, f'건물 기하 · {e}')
            except Exception as e:
                once(False, f'건물 기하 읽기 실패 · {type(e).__name__}')
        loop.call_later(5.0, lambda: once(False, '건물 기하 · 5 s 안에 못 읽음 — 잠시 뒤 다시'))
        loop.add_future(loop.run_in_executor(None, geom_read, a.geom_root, m.get('building_id')), done)

    class WS(tornado.websocket.WebSocketHandler):
        def check_origin(self, origin):
            return origin in allowed_origins          # 다른 웹페이지가 이 포트로 조종하지 못하게

        def open(self):
            self.cid = f'c{id(self)}'; self.cam_n = -1; self.map_busy = False; self.geom_busy = False
            # 보호 관문(v2_gate)이 붙인 «계정 · 기기». 8790 은 127.0.0.1 전용이라 이 PC 안의 프로세스만 쓸 수 있다(신뢰 경계 = 이 PC)
            self.gated = bool(actor_from_header(self.request.headers.get('X-FH-Actor', '')))   # 관문 로그인 신원(Gazebo 종료 조건)
            self.actor = actor_from_header(self.request.headers.get('X-FH-Actor', '')) or '이 PC(127.0.0.1)'
            clients[self.cid] = self

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
                    core.take(self.cid, self.actor)
                elif op == 'release':
                    core.drop(self.cid, '화면에서 놓음')
                elif op == 'cmd':
                    core.cmd(self.cid, valid_axes(m))
                elif op == 'stop':
                    core.stop('이 기기' if core.controller == self.cid else '보기 전용 기기')
                elif op == 'resume':
                    g = m.get('stop_gen')   # 없음 = 옛 클라이언트. 있으면 0 이상 정수만(bool·실수·문자 = 형식 오류 → 거부)
                    if 'stop_gen' in m and not (type(g) is int and g >= 0):
                        core.ev('warn', 'STOP 해제 거부 · stop_gen 형식 오류')
                    elif core.resume(self.cid, g):
                        pub_resume.publish(Empty())
                elif op == 'reset':
                    if core.reset_begin(self.cid, cli_reset.service_is_ready()):   # 잠금·입력 폐기를 요청 전에 확정
                        live.hold()                         # 이전 epoch 지도·마커는 응답 전에 버림
                        pub_stop.publish(Empty())
                        cli_reset.call_async(Trigger.Request()).add_done_callback(reset_done)
                elif op == 'hidden':
                    core.drop(self.cid, '화면 숨김')
            rid = m.get('rid') if type(m.get('rid')) is int else None
            if op == 'photo':
                take_photo(self, rid)
            elif op == 'sim_start':
                start_sim(self, rid)
            elif op == 'sim_stop':
                stop_sim(self, rid)
            elif op in ('map_list', 'map_get', 'height_get'):
                map_op(self, rid, op, m)
            elif op == 'geom_get':
                geom_op(self, rid, m)
            elif op == 'map_live_get':
                x = live.png()
                reply(self, rid, bool(x), '' if x else '표시할 실시간 지도 없음', live=x)
            elif op == 'view_get':
                x, why = views.get(m.get('what'))
                reply(self, rid, bool(x), why, view=x)
            elif op == 'map_start':
                start_map(self, rid, m)
            elif op == 'map_save':
                save_map(self, rid)

        def on_close(self):
            clients.pop(self.cid, None)
            with lock:
                core.drop(self.cid, '연결 끊김')

    def push():                     # 10 Hz: 상태 + 새 영상
        for c in list(clients.values()):
            s = snapshot(c)
            with lock:
                jpeg, n = sim['jpeg'], sim['jpeg_n']
                if jpeg and cam_why(core, sim, time.monotonic()):
                    jpeg = None             # 지금 회차와 연관 미확인 프레임(리셋 중·옛 episode·바뀐 직후 1 s·상태 끊김)은 보내지 않음 — 화면은 cam_age 로 «미연결»
            try:
                c.write_message(json.dumps(s, ensure_ascii=False))
                if jpeg and n != c.cam_n:
                    c.cam_n = n; c.write_message(jpeg, binary=True)
            except tornado.websocket.WebSocketClosedError:
                pass

    class NoCache(tornado.web.StaticFileHandler):
        def set_extra_headers(self, path):
            self.set_header('Cache-Control', 'no-store')

    class MediaList(tornado.web.RequestHandler):
        def get(self):              # 서버 보관 기록(모든 기기 공통). 예시 데이터 아님
            self.set_header('Cache-Control', 'no-store')
            self.finish({'photos': media.tail('photos.jsonl', 200)[::-1], 'events': media.tail('events.jsonl', 300)[::-1], 'ver': version()})

    KIND_KO = {'zone': '구역', 'tmpl': '임무 양식', 'mission': '임무 계획', 'run': '임무 진행', 'note': '사진 분류'}

    class DocsAPI(tornado.web.RequestHandler):
        # 공용 문서. 쓰기는 이 PC 출처(관문은 Origin 을 이 주소로 붙여 중계) — 다른 웹페이지가 몰래 못 씀. 로봇 조종권과 무관
        async def get(self):
            self.set_header('Cache-Control', 'no-store')
            def work():                 # SQLite 일 수 있어 IOLoop 밖에서. 실행 중 DB 오류 = 500 JSON(broken 은 200 + broken 글, 쓰기만 503)
                with docs.lock:
                    try:
                        return 200, docs.listing()
                    except sqlite3.Error as e:
                        return 500, {'error': f'읽기 실패 · {type(e).__name__} — 잠시 뒤 다시'}
            code, r = await tornado.ioloop.IOLoop.current().run_in_executor(None, work)
            self.set_status(code); self.finish(r)

        async def post(self):
            self.set_header('Cache-Control', 'no-store')
            if self.request.headers.get('Origin') not in allowed_origins:
                self.set_status(403); return self.finish({'error': '다른 출처'})
            try:
                m = json.loads(self.request.body)
            except ValueError:
                self.set_status(400); return self.finish({'error': 'JSON 아님'})
            actor = actor_from_header(self.request.headers.get('X-FH-Actor', '')) or '이 PC(127.0.0.1)'
            def work():                 # 파일 쓰기는 일꾼 스레드에서, 문서 lock 만 — 조종 lock·20 Hz 명령 발행을 막지 않는다
                with docs.lock:
                    try:
                        return docs.apply(m, actor)
                    except (OSError, sqlite3.Error) as e:
                        return 500, {'error': f'저장 실패 · {type(e).__name__} — 이전 상태 그대로, 초안은 화면에'}
            code, r = await tornado.ioloop.IOLoop.current().run_in_executor(None, work)
            with lock:                  # 조종 lock 은 사건 한 줄만
                if code == 200:
                    core.ev('ok', f'{KIND_KO[r["kind"]]} {"삭제" if m.get("op") == "del" else "추가" if r.get("new") else "수정"} · {r["name"] or r["id"]} · {actor}')
            self.set_status(code); self.finish(r)

    app = tornado.web.Application([(r'/ws', WS), (r'/api/media', MediaList), (r'/api/docs', DocsAPI),
                                   (r'/media/(photos/\d{8}/[\w.-]+\.jpg)', NoCache, {'path': a.media}),
                                   (r'/(.*)', NoCache, {'path': a.web, 'default_filename': 'index.html'})])
    app.listen(a.port, address='127.0.0.1')
    tornado.ioloop.PeriodicCallback(tick, 50).start()
    tornado.ioloop.PeriodicCallback(push, 100).start()
    print(f'v2_link http://127.0.0.1:{a.port}/MDrive.dc.html?live=v2  domain={os.environ.get("ROS_DOMAIN_ID", "0")}', flush=True)
    try:
        tornado.ioloop.IOLoop.current().start()
    except KeyboardInterrupt:
        pass
    finally:
        t = Twist(); pub_cmd.publish(t)            # 끝낼 때 0 한 번 — RELIABLE 구독자 확인(ack)을 최대 1 s 기다림(받았다는 보장은 아님)
        try:
            from rclpy.duration import Duration; pub_cmd.wait_for_all_acked(Duration(seconds=1.0))
        except Exception:
            pass
        spin_stop.set(); spin_t.join(3.0)          # 진행 중 콜백이 끝난 뒤에만 파괴
        if spin_t.is_alive():                      # 콜백이 3 s 넘게 도는 중 — 지금 파괴하면 경합. 강제 종료 없이 끝날 때까지 보류
            print('v2_link 종료: spin 콜백 3 s 안에 안 끝남 — node/context 파괴 보류, 콜백 끝날 때까지 대기(INT 만 지원 · 더 걸리면 TERM 은 기본 종료=한계)', flush=True)
            spin_t.join()
            print('v2_link 종료: spin 콜백 끝남 — 파괴 진행', flush=True)
        if not ex.shutdown(timeout_sec=1.0):       # executor 가 아직 일하는 중이면 파괴 0, 종료 미확인으로 남김(rc 3)
            print('v2_link 종료 미확인: executor shutdown 시간 초과 — node/context 파괴 안 함', flush=True)
            sys.exit(3)
        node.destroy_node(); rclpy.try_shutdown()


if __name__ == '__main__':
    sys.exit(main())

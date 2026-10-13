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
import argparse, json, math, os, re, sqlite3, subprocess, sys, threading, time
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

    def ev(self, level, text):
        e = {'t': time.strftime('%H:%M:%S'), 'st': level, 'text': text}
        self.events.appendleft(e)
        if self.sink:
            try:
                self.sink(e)
            except Exception:
                pass

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
            self.ep_change_t = self.now()               # 사진: 바뀐 직후 도착한 프레임은 옛 episode 렌더일 수 있음
            self.latch = True; self.resume_pending = None; self._void()
            self.ev('warn', f'새 에피소드 {d["episode"]} · STOP 유지')
        self.episode = d['episode']
        if self.resume_pending and self.state_seq > self.resume_pending[1] and not d['stop_requested']:
            self.resume_pending = None; self.latch = False; self._void()
            self.ev('ok', 'STOP 해제 확인(시뮬) · 새 입력 전까지 0')
        elif d['stop_requested'] and not self.latch:      # 시뮬이 STOP 상태(리셋 뒤 등)면 앱도 잠근다
            self.latch = True; self._void(); self.ev('warn', '시뮬이 STOP 상태 · «STOP 해제» 필요')
        return True

    def take(self, cid, who='이 기기'):
        if self.controller not in (None, cid):
            return False
        if self.controller != cid:
            self.controller = cid; self._void(); self.ev('ok', f'조종권 얻음 · {who}')
        return True

    def drop(self, cid, why):
        """조종권을 잃으면(반납·끊김·숨김·로그아웃) 0 + STOP 잠금 — 다음 조종자는 «STOP 해제»부터(정지 뒤 재움직임 원인 미확인이라 보수적으로)"""
        if self.controller == cid:
            self.controller = None; self.latch = True; self.resume_pending = None; self._void()
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
            self.n += 1; did = f'{kind[0]}{time.strftime("%m%d%H%M%S")}{os.getpid() % 1000:03d}{self.n}'
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
            migrate.cmd_import(argparse.Namespace(src=str(media), out=str(db)), check=chk)
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


SESSION_RESULTS = {'starting', 'ready', 'already_running', 'resource_blocked', 'budget_exhausted', 'failed'}


def parse_session(out, code):
    """RL 래퍼(request_session.sh, schema v2_session/1) 출력 → (결과, 표시 글). 형식이 틀리면 실패로(추정 없음)"""
    for line in reversed((out or '').strip().splitlines()):
        try:
            d = json.loads(line)
        except ValueError:
            continue
        if isinstance(d, dict) and d.get('schema') == 'v2_session/1' and d.get('result') in SESSION_RESULTS:
            extra = ' · '.join(f'{lab}{str(d[k])[:80]}' for k, lab in (('reason', ''), ('ends_at', '종료 예정 '), ('ledger_used', '기동 원장 ')) if d.get(k) is not None)
            return d['result'], extra
    return 'failed', f'래퍼 응답 형식 틀림(종료 {code})'


class SimStart:
    """«시뮬 시작(30분)» — 사용자가 누를 때만 RL 래퍼를 한 번 부른다. 동시 1건·120 s 쿨다운·재시도/연장 없음"""
    COOL = 120.0

    def __init__(self, wrapper, now=time.monotonic):
        self.wrapper, self.now, self.busy, self.last = wrapper, now, False, -1e9
        self.session = None         # session_status.sh 마지막 결과(읽기만) — running/starting/idle, 남은 시간

    def refuse(self, sim_live):
        if not self.wrapper:
            return 'RL 래퍼 미설정 — 시뮬 시작 불가(RL 쪽에서 기동)'
        if self.busy:
            return '시작 요청 처리 중'
        if sim_live:
            return '시뮬이 이미 돌고 있음'
        if (self.session or {}).get('result') in ('running', 'starting'):
            return '시뮬 세션이 이미 켜지는 중·실행 중(RL 상태)'
        left = self.COOL - (self.now() - self.last)
        return f'방금 요청함 — {left:.0f} s 뒤 다시' if left > 0 else ''

    def state(self, sim_live):
        why = self.refuse(sim_live)
        ss = self.session or {}
        return {'ok': not why, 'why': why, 'busy': self.busy,
                'session': {k: ss.get(k) for k in ('result', 'reason', 'started_at', 'ends_at', 'remaining_s')} if ss else None}

    def poll(self):
        """RL 상태 스크립트(읽기만, 약 0.05 s). 래퍼와 같은 폴더. 실패하면 None(추정 없음)"""
        try:
            r = subprocess.run(['bash', str(Path(self.wrapper).with_name('session_status.sh'))], capture_output=True, text=True, timeout=10)
            d = json.loads(r.stdout.strip().splitlines()[-1])
            self.session = d if isinstance(d, dict) and d.get('result') in ('running', 'starting', 'idle') else None
        except Exception:
            self.session = None
        # 권장 주기: 켜지는 중 2 s, 그 밖 5 s
        return 2.0 if self.busy or (self.session or {}).get('result') == 'starting' else 5.0


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
    s_ = SimStart('/x', lambda: t[0]); assert s_.refuse(False) == '' and s_.refuse(True)
    s_.last = 0.0; t[0] = 60.0; assert s_.refuse(False).startswith('방금'); t[0] = 120.1; assert s_.refuse(False) == ''
    s_.busy = True; assert s_.refuse(False) == '시작 요청 처리 중'
    s_.busy = False; s_.session = {'result': 'starting'}; assert s_.refuse(False).startswith('시뮬 세션') and s_.state(False)['session']['result'] == 'starting'
    s_.session = {'result': 'idle'}; assert s_.refuse(False) == ''


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
    selftest_extra()
    print('selftest OK')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=8790)
    ap.add_argument('--web', default=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'web'))
    repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    ap.add_argument('--media', default=os.path.join(repo, 'runs', 'app-media'), help='서버 보관 사진·사건 폴더')
    ap.add_argument('--sim-start', default=None, help='RL 래퍼(request_session.sh) 절대경로. 없으면 «시뮬 시작» 버튼은 이유만 보임')
    ap.add_argument('--store', default='json', help='공용 문서 저장: json(기본, <media>/docs.json) 또는 sqlite:<DB 경로>(없으면 docs.json 을 읽어 이전)')
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
    sim = {'jpeg': None, 'jpeg_t': None, 'jpeg_n': 0, 'jpeg_wall': None, 'jpeg_stamp': None, 'jpeg_ep': None, 'jpeg_reset': False}
    media = Media(a.media); core.sink = media.event
    docs, docs_note = open_docs(a.store, a.media)
    if docs_note:
        core.ev('warn', docs_note); print(docs_note, flush=True)
    starter = SimStart(a.sim_start if a.sim_start and os.path.isfile(a.sim_start) else None)
    photo_last = [0.0]
    if starter.wrapper and Path(starter.wrapper).with_name('session_status.sh').is_file():
        def poll_loop():
            while True:
                time.sleep(starter.poll())
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

    def on_cam(m):
        with lock:
            sim['jpeg'] = bytes(m.data); sim['jpeg_t'] = time.monotonic(); sim['jpeg_n'] += 1
            sim['jpeg_wall'] = time.time(); sim['jpeg_stamp'] = m.header.stamp.sec + m.header.stamp.nanosec * 1e-9
            # 받은 순간의 episode·리셋 여부(사진 저장 때 대조 — 옛 episode 프레임이 새 episode 에 붙지 않게)
            sim['jpeg_ep'] = core.episode
            sim['jpeg_reset'] = bool(core.reset_pending or (core.st or {}).get('reset_in_progress'))

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

    def sim_live():                 # 시뮬이 지금 돌고 있나(시작 버튼 거부용)
        return core.st is not None and core.state_t is not None and time.monotonic() - core.state_t < 3

    def snapshot(c):
        cid = c.cid
        now = time.monotonic()
        v = version()
        with lock:
            holder = clients[core.controller].actor if core.controller in clients else None
            age = None if core.state_t is None else round(now - core.state_t, 2)
            cam_age = None if sim['jpeg_t'] is None else round(now - sim['jpeg_t'], 2)
            role = 'control' if core.controller == cid else ('view_other' if core.controller else 'view')
            # 서버 출력(applied)·이유는 누구나 같은 값을 읽는다. role 은 송신 허용에만 쓴다
            return {'op': 'status', 'role': role, 'latch': core.latch, 'applied': list(core.out), 'reason': core.reason,
                    'sim_block': core.sim_block(), 'resume_pending': bool(core.resume_pending), 'reset_pending': core.reset_pending is not None,
                    'episode': core.episode, 'ros_domain': os.environ.get('ROS_DOMAIN_ID'), 'state_age': age, 'cam_age': cam_age, 'sim': core.st, 'events': list(core.events)[:6], 'note': PRESETS_NOTE,
                    'me': c.actor, 'holder': holder, 'ver': v, 'sim_start': starter.state(sim_live()), 'docs_rev': docs.rev}

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
            st = core.st if core.state_t is not None and now - core.state_t <= 1.0 else None
            # ponytail: 바뀐 직후 1 s 는 옛 렌더가 섞일 수 있어 거부(지연 실측 없음). 프레임에 episode 가 실리면 그걸로 대조
            why = ('시뮬 상태 없음(1 s 안)' if st is None else '리셋 중' if core.reset_pending or st.get('reset_in_progress') or sim['jpeg_reset']
                   else 'episode 바뀜(프레임과 연관 미확인)' if sim['jpeg_ep'] != core.episode
                   or (core.ep_change_t is not None and min(now, sim['jpeg_t']) - core.ep_change_t < 1.0) else '')
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
            why = starter.refuse(sim_live())
            if why:
                core.ev('warn', f'시뮬 시작 거부 · {why}'); return reply(c, rid, False, why)
            starter.busy = True; starter.last = time.monotonic()
            core.latch = True; core._void()            # 시작 전에도 잠금 — 새 시뮬은 STOP 상태로 시작(계약), 앱도 같은 상태로
            core.ev('warn', f'시뮬 시작 요청(30분) · {c.actor} · STOP 상태로 시작')
        reply(c, rid, True, '시뮬 시작 요청함 — 준비되면 영상·상태가 들어옵니다')

        def run():                  # ROS·웹 스레드를 막지 않게 따로. 재시도·연장 없음
            try:
                r = subprocess.run(['bash', starter.wrapper], capture_output=True, text=True, timeout=240)
                res, extra = parse_session(r.stdout, r.returncode)
            except Exception as e:
                res, extra = 'failed', type(e).__name__
            ok_ = res in ('starting', 'ready')
            text = {'starting': '시뮬 기동 중 · 상태·영상 연결은 화면 표시로 판정(안전 준비 판정 아님)',
                    'ready': '시뮬 상태·영상 수신 확인(안전 준비 판정 아님 · STOP 상태)', 'already_running': '이미 실행 중',
                    'resource_blocked': '자원 부족으로 기동 안 함', 'budget_exhausted': '오늘 기동 횟수 소진', 'failed': '기동 실패'}[res]
            with lock:
                starter.busy = False
                core.ev('ok' if ok_ else 'bad', f'시뮬 시작 결과 · {text}{" · " + extra if extra else ""}')
        threading.Thread(target=run, daemon=True).start()

    class WS(tornado.websocket.WebSocketHandler):
        def check_origin(self, origin):
            return origin in allowed_origins          # 다른 웹페이지가 이 포트로 조종하지 못하게

        def open(self):
            self.cid = f'c{id(self)}'; self.cam_n = -1
            # 보호 관문(v2_gate)이 붙인 «계정 · 기기». 8790 은 127.0.0.1 전용이라 이 PC 안의 프로세스만 쓸 수 있다(신뢰 경계 = 이 PC)
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
                    if core.resume(self.cid):
                        pub_resume.publish(Empty())
                elif op == 'reset':
                    if core.reset_begin(self.cid, cli_reset.service_is_ready()):   # 잠금·입력 폐기를 요청 전에 확정
                        pub_stop.publish(Empty())
                        cli_reset.call_async(Trigger.Request()).add_done_callback(reset_done)
                elif op == 'hidden':
                    core.drop(self.cid, '화면 숨김')
            rid = m.get('rid') if type(m.get('rid')) is int else None
            if op == 'photo':
                take_photo(self, rid)
            elif op == 'sim_start':
                start_sim(self, rid)

        def on_close(self):
            clients.pop(self.cid, None)
            with lock:
                core.drop(self.cid, '연결 끊김')

    def push():                     # 10 Hz: 상태 + 새 영상
        for c in list(clients.values()):
            s = snapshot(c)
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

    class MediaList(tornado.web.RequestHandler):
        def get(self):              # 서버 보관 기록(모든 기기 공통). 예시 데이터 아님
            self.set_header('Cache-Control', 'no-store')
            self.finish({'photos': media.tail('photos.jsonl', 200)[::-1], 'events': media.tail('events.jsonl', 300)[::-1], 'ver': version()})

    KIND_KO = {'zone': '구역', 'tmpl': '임무 양식', 'mission': '임무 계획', 'run': '임무 진행', 'note': '사진 분류'}

    class DocsAPI(tornado.web.RequestHandler):
        # 공용 문서. 쓰기는 이 PC 출처(관문은 Origin 을 이 주소로 붙여 중계) — 다른 웹페이지가 몰래 못 씀. 로봇 조종권과 무관
        async def get(self):
            self.set_header('Cache-Control', 'no-store')
            def work():                 # SQLite 일 수 있어 IOLoop 밖에서
                with docs.lock:
                    return docs.listing()
            self.finish(await tornado.ioloop.IOLoop.current().run_in_executor(None, work))

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
        t = Twist(); pub_cmd.publish(t)            # 끝낼 때 0 한 번
        node.destroy_node(); rclpy.try_shutdown()


if __name__ == '__main__':
    sys.exit(main())

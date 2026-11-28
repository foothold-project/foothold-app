"""손 조종 입력 → 속도 명령 한 식 (시뮬 · 데모 · 실기 · 키보드 · 화면 조이스틱 · 폰 손잡이 · 실기 리모컨 공통).

정본은 이 파일이고 TS 짝은 apps/contracts/teleop.ts 다. 두 쪽은 tests/test_teleop.py 가 같은 표로 대조한다.
Pydantic 없이 쓴다 (에이전트 · 웹이 같은 식을 옮겨 쓸 수 있게).

막대 (stick) = (전후, 옆, 돌기), 각 -1..1. + 는 전진 · 왼쪽 · 왼쪽으로 돌기 (vx · vy · wz 와 같은 부호).
실기 리모컨으로 말하면 (ly, -lx, -rx) 다.

곡선 출처 (실기 START 저수준 실행기, 팀장 11/23 11:15 · 11:51):
  apps/agent/foothold_agent/policy/lowlevel.py remote_want (커밋 c3e43c7b)
  apps/agent/runner_cpp/src/core.cpp remote_want · REMOTE.md 2 절 (커밋 7ec8a8c6)
  전후 = s·|s| × 상한 (제곱, 후진도 같은 식), 옆 · 돌기 = s × 상한 (직선), |s| < 문턱 이면 0 (문턱 밖 값은 늘리지 않는다).
"""
import math

# 전후 축만 제곱. 옆 · 돌기는 직선 (실기 리모컨과 같음). 조직 설정 칸으로 두지 않는다:
# 실기 C++ 실행기 리모컨 곡선이 고정이라, 앱만 바꾸면 리모컨과 앱이 다른 속도를 낸다.
FORWARD_CURVE = 'square'

# 조직 설정 칸의 위 끝 (models.OrgSettings 의 le 와 같음 · test_teleop 이 대조). 칸이 없을 때의 값이기도 하다.
SIM_CEILING = {'max_vx': 1.5, 'max_vx_back': 1.5, 'max_vy': 0.5, 'max_wz': 1.2}
REAL_CEILING = {'max_vx': 1.5, 'max_vx_back': 1.5, 'max_vy': 1.0, 'max_wz': 2.5}
DEFAULT_DEADZONE = 0.1   # OrgSettings.stick_deadzone 기본

# 웹 KeyboardEvent.code → 키 뜻 (apps/web/src/simdrive.tsx KEYS 와 같은 배치)
KEYMAP = {'KeyW': 'forward', 'ArrowUp': 'forward', 'KeyS': 'back', 'ArrowDown': 'back',
          'KeyA': 'turn_left', 'KeyD': 'turn_right', 'ArrowLeft': 'left', 'ArrowRight': 'right'}


def _number(value, default):
    return float(value) if type(value) in (int, float) and math.isfinite(value) and value >= 0 else default


def teleop_caps(settings, *, simulation):
    """조직 설정 (모델별 덮어쓰기를 합친 실효값, dict 또는 OrgSettings) → 축별 상한.

    시뮬: 전진 · 후진 sim_max_vx, 옆 sim_max_vy, 돌기 sim_max_wz.
    실기: real_max_vx · real_max_vx_back · real_max_vy · real_max_wz.
    칸이 없거나 잘못된 값이면 그 칸의 위 끝. 위 끝을 넘는 값은 위 끝으로 자른다.
    """
    get = settings.get if isinstance(settings, dict) else (lambda k: getattr(settings, k, None))
    ceiling = SIM_CEILING if simulation is True else REAL_CEILING
    names = ({'max_vx': 'sim_max_vx', 'max_vx_back': 'sim_max_vx', 'max_vy': 'sim_max_vy', 'max_wz': 'sim_max_wz'}
             if simulation is True else
             {'max_vx': 'real_max_vx', 'max_vx_back': 'real_max_vx_back', 'max_vy': 'real_max_vy', 'max_wz': 'real_max_wz'})
    return {axis: min(_number(get(name), ceiling[axis]), ceiling[axis]) for axis, name in names.items()}


def deadzone(settings):
    get = settings.get if isinstance(settings, dict) else (lambda k: getattr(settings, k, None))
    return min(_number(get('stick_deadzone'), DEFAULT_DEADZONE), 1.0)


def _axis(value, gate):
    if type(value) not in (int, float) or not math.isfinite(value):
        return 0.0
    value = min(1.0, max(-1.0, float(value)))
    return 0.0 if abs(value) < gate else value


def stick_velocity(stick, caps, gate):
    """막대 (전후, 옆, 돌기) → (vx m/s, vy m/s, wz rad/s). 키보드 · 화면 · 폰 · 리모컨 모두 이 식."""
    f, y, t = (_axis(v, gate) for v in stick)
    f = f * abs(f)
    vx = f * (caps['max_vx'] if f >= 0 else caps['max_vx_back'])
    return (vx + 0.0, y * caps['max_vy'] + 0.0, t * caps['max_wz'] + 0.0)   # + 0.0: -0 을 0 으로 (TS 와 같게)


def key_stick(keys, caps, key_vx):
    """누른 키 뜻 (KEYMAP 값의 모음) → 막대 위치. 화면 조이스틱은 이 위치를 그리고, 속도는 stick_velocity 로 낸다.

    전후 키 하나 = 속도가 key_vx (상한 안) 가 되는 막대 위치 (제곱 곡선을 거꾸로 푼 값). 옆 · 돌기 키 = 끝까지.
    반대 키를 함께 누르면 그 축은 0.
    """
    keys = set(keys)
    f = ('forward' in keys) - ('back' in keys)
    top = caps['max_vx'] if f > 0 else caps['max_vx_back']
    stick_f = 0.0 if f == 0 or top <= 0 else f * math.sqrt(min(_number(key_vx, top), top) / top)
    return (stick_f + 0.0, float(('left' in keys) - ('right' in keys)), float(('turn_left' in keys) - ('turn_right' in keys)))

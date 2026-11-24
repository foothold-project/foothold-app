"""Jetson 에서 START 저수준 정책 실행 (리모컨으로 시작 · 정지).

  python3 -m foothold_agent.policy.run --folder ~/foothold-policy-1122/policy/start-m15500-app --nic eth0            # dry-run: 읽고 계산만, 송신 0
  FH_GO2_DIRECT_ENABLED=1 FH_GO2_DIRECT_NIC=eth0 FH_GO2_FIELD_APPROVAL=/abs/approval.json \\
  python3 -m foothold_agent.policy.run --folder ... --nic eth0 --live                                                 # 실제 송신 (팀장 동의 · 표식)

리모컨: 위 + start = START 정책 (앉힘 → 저수준 → 일어서기 → 정책), 아래 + start = AME-2 (student 대기 · 알림만),
← + start = 순정 free walk 복귀, → + start = 순정 classic 복귀, L2 + B = 비상 감쇠.
사건은 JSON 줄로 표준 출력 (넘어짐 ROBOT_FALL 포함). reconstruction (깊이) 모드는 깊이 원천을 붙인 뒤에 연다 (지금은 off 만).
"""
import argparse
import json
import os
import signal
import sys
import time
from pathlib import Path

from .lowlevel import CMD_HZ, POLICY_HZ, LowLevelRunner, Phase
from .start import StartPolicy


class PeriodStats:
    """START 동안 정책 틱 간격 (ms) · 상태 줄에 p99 · 최대 · 30 ms 넘은 누적 횟수 (lead 11/23 14:51: 학습 지연 DR 0~15 ms)."""
    def __init__(self, window=250):
        self.window, self.dts, self.last, self.over30, self.n, self.resyncs = window, [], None, 0, 0, 0

    def mark(self, now, in_policy):
        if in_policy and self.last is not None:
            dt = (now - self.last) * 1e3
            self.dts = (self.dts + [dt])[-self.window:]
            self.n += 1
            self.over30 += dt > 30.
        self.last = now if in_policy else None

    def summary(self):
        if not self.dts:
            return {}
        d = sorted(self.dts)
        return {'dt_p99': round(d[min(len(d) - 1, int(len(d) * .99))], 1), 'dt_max': round(d[-1], 1), 'dt_over30': self.over30, 'dt_n': self.n, 'resync': self.resyncs}



def jetson_temp():
    """Jetson 온도 구역 중 가장 높은 값 (°C · 상태 줄마다 · 팀장 11/24 13:44). 읽을 수 없으면 None."""
    best = None
    for f in Path('/sys/devices/virtual/thermal').glob('thermal_zone*/temp'):
        try:
            v = int(f.read_text().strip()) / 1000
        except (OSError, ValueError):
            continue
        if -40 < v < 150:
            best = v if best is None else max(best, v)
    return None if best is None else round(best, 1)

def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--folder', required=True, type=Path)
    ap.add_argument('--nic', required=True)
    ap.add_argument('--mode', default='off', choices=['off'])
    ap.add_argument('--live', action='store_true')
    ap.add_argument('--armed-by-remote', action='store_true',
                    help='자동 시작용 (팀장 11/23 10:11): 승인 표식 없이 --live. 순정 상태로 기다리고, 리모컨 위 + start 를 사람이 눌러야 저수준 송신 시작. '
                         'FH_GO2_DIRECT_ENABLED=1 · FH_GO2_DIRECT_NIC 가 --nic 와 같아야 함')
    ap.add_argument('--sport-mode', default='mcf', help="고수준 복귀 이름 (기본 mcf · 11/22 실기 확인 · 시작할 때 CheckMode 로 읽은 이름이 우선)")
    ap.add_argument('--seconds', type=float, default=0, help='0 = 끄기 전까지 (기본 · 팀장 결정 11: 시간 상한 대신 생존 신호)')
    ap.add_argument('--status', type=float, default=1.0, help='상태 한 줄 간격 (초) · 0 = 끔')
    ap.add_argument('--stand-only', action='store_true', help='일어선 뒤 정책 없이 기본 자세만 유지 (첫 실기 시험)')
    ap.add_argument('--debug-est', type=Path, help='기록용 ONNX 폴더 (행동은 정본과 같음 · START_TRACE 에 전진 속도 추정 칸)')
    ap.add_argument('--trace-dir', type=Path, help='START 가 켜진 동안 50 Hz 기록 폴더 (팀장 결정 9 · 기본 끔)')
    ap.add_argument('--app-port', type=int, default=0, help='앱 명령 받기 (127.0.0.1 UDP 포트 · 0 = 끔 · 리모컨 우선 · 실기 미확인)')
    ap.add_argument('--fwd-max', type=float, default=1.5, help='전진 상한 m/s (막대 끝 = 이 값 · 1.5 넘지 못함)')
    ap.add_argument('--stop-mode', default='sit', choices=['sit', 'settle', 'stand'],
                    help='멈춰 내려놓는 길: sit 바로 엎드림 (기본 · 11/22 실기 확인) · settle 정렬 대기 (최대 1.5 초) 뒤 엎드림 (못 맞춰도 엎드림) · stand 서 있는 채 순정 BalanceStand → StandDown (실기 미확인)')
    ap.add_argument('--sit-first', action='store_true', help='넘겨받기 전에 StandDown 으로 앉히기 (기본: 지금 자세 그대로 넘겨받음)')
    a = ap.parse_args(argv)
    from . import lowlevel
    lowlevel.FWD_TOP = min(max(a.fwd_max, 0.), lowlevel.CAPS['vx'][1])
    if a.live and a.armed_by_remote:
        # 사람의 확인 = 리모컨 위 + start (실행기는 그 전까지 순정 상태에서 아무것도 보내지 않음 · test_dry_run · test_l2b_in_factory_mode)
        if os.environ.get('FH_GO2_DIRECT_ENABLED') != '1' or os.environ.get('FH_GO2_DIRECT_NIC') != a.nic:
            raise PermissionError('armed-by-remote needs FH_GO2_DIRECT_ENABLED=1 and FH_GO2_DIRECT_NIC equal to --nic')
    elif a.live:
        from foothold_agent.go2_direct.approval import validate
        approval = validate(os.environ)   # 사람 · 0600 · 30 분 표식 없으면 여기서 멈춘다
        if approval.nic != a.nic:
            raise PermissionError('approval NIC differs from --nic')
    from .unitree import UnitreeSdk
    app = None
    if a.app_port:
        from .applink import AppLink
        app = AppLink(a.app_port)
    trace = None
    if a.trace_dir:
        from .trace import ThreadedTraceWriter
        trace = ThreadedTraceWriter(a.trace_dir, 'start', on_full=lambda: print(json.dumps({'code': 'TRACE_FULL'}), flush=True))
    import gc
    from .trace import START_FLAG, pin_cpus
    START_FLAG.unlink(missing_ok=True)   # 실행기는 순정 (HIGH) 으로 시작한다
    cpus = pin_cpus(range(4, 8))   # 팀장 11/23 16:06: MAXN 8 코어면 실행기 전용 4~7 (카메라 · 기록은 0~3) · 15W (0~3 만) 면 그대로

    def _on_event(e):
        print(json.dumps({'t': round(e.t, 3), 'code': e.code, **e.data}, ensure_ascii=False), flush=True)
        if e.code == 'MODE_LOW':
            START_FLAG.touch()   # START: 순정 기록은 쉼
            gc.collect(); gc.disable()   # START 동안 Python 메모리 정리가 제어 반복 사이에 끼지 않게
        elif e.code == 'MODE_HIGH':
            START_FLAG.unlink(missing_ok=True)   # 순정으로 돌아옴: 순정 기록 다시 (MODE_HIGH_FAILED 면 순정이 아니므로 그대로 쉼)
            gc.enable(); gc.collect()
    sdk = UnitreeSdk(a.nic)
    runner = LowLevelRunner(sdk, StartPolicy(a.folder, a.mode, debug_est=a.debug_est), live=a.live, sport_mode=a.sport_mode, stand_only=a.stand_only, sit_first=a.sit_first, app=app, trace=trace, stop_mode=a.stop_mode,
                            on_event=_on_event)
    def _term(signum, frame):   # kill (SIGTERM) 도 Ctrl+C 와 같이 엎드린 뒤 순정으로 끝낸다
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, _term)
    runner.emit('RUNNER_READY', cpus=cpus, live=a.live, armed='remote' if a.armed_by_remote else ('marker' if a.live else None), mode=a.mode, app_port=a.app_port or None)
    t0, k = time.monotonic(), 0
    per = CMD_HZ // POLICY_HZ
    pt = PeriodStats()
    try:
        while not a.seconds or time.monotonic() - t0 < a.seconds:
            if k % per == 0:
                pt.mark(time.monotonic(), runner.phase is Phase.POLICY)
                s = runner.tick()
                if a.status and k % int(a.status * CMD_HZ) == 0:
                    print(json.dumps({'status': runner.phase.value, 'stale': bool(s['stale']), 'grav_z': round(float(s['grav'][2]), 3),
                                      'keys': sorted(s['remote'].keys), 'lx': round(s['remote'].lx, 2), 'ly': round(s['remote'].ly, 2),
                                      'rx': round(s['remote'].rx, 2), 'cmd': [round(float(x), 2) for x in runner.cmd], 'act_max': round(float(abs(runner.last_action).max()), 2), 'pitch_x': round(float(s['grav'][0]), 3), 'roll_y': round(float(s['grav'][1]), 3), 'sent': runner.sent, 'app': app is not None and app.velocity() is not None, 'bat': getattr(sdk, 'battery', lambda: None)(), 'jetson_c': jetson_temp(), **pt.summary()}, ensure_ascii=False), flush=True)
                    if trace is not None:
                        trace.flush()
            else:
                runner.hold()
            k += 1
            lag = time.monotonic() - (t0 + k / CMD_HZ)
            if lag > 2. / CMD_HZ:
                # 늦으면 밀린 틱을 몰아 돌리지 않고 지금 시각에 다시 맞춘다 (몰아 돌리면 정책이 같은 상태로 연달아 두 번 돈다)
                t0 += lag
                pt.resyncs += 1
            time.sleep(max(0., t0 + k / CMD_HZ - time.monotonic()))
    except KeyboardInterrupt:
        pass
    finally:
        runner.shutdown()
        if trace is not None:
            trace.close()
        runner.emit('RUNNER_EXIT', sent=runner.sent)
        if app is not None:
            app.close()
    return 0


if __name__ == '__main__':
    sys.exit(main())

"""순정 (Sport · Classic) 걷기 동안 읽기 전용 50 Hz 기록 (팀장 11/23 09:36 · lead 09:39 전달 4 번).

  PYTHONPATH=../pylib:. python3 -m foothold_agent.policy.factory_record --nic enP8p1s0 --out ~/foothold-policy-1122/trace --label classic

명령을 보내지 않는다: rt/lowstate · rt/sportmodestate 구독만 하고, 발행자 · SportClient · MotionSwitcherClient 를 만들지 않는다.
한 줄 꼴은 실행기 START 기록 (trace_row) 과 같고, 순정 쪽 칸 (sport: 모드 · 보행 · 몸 높이 · 펌웨어 속도 추정) 을 더한다.
"""
from __future__ import annotations

import argparse
import json
import sys
import threading
import time
from pathlib import Path

import numpy as np

from .lowlevel import parse_remote
from .start import POLICY_FROM_SDK, projected_gravity
from .trace import TraceWriter, r4

HZ = 50


class ReadOnlyState:
    def __init__(self, nic):
        from unitree_sdk2py.core.channel import ChannelFactoryInitialize, ChannelSubscriber
        from unitree_sdk2py.idl.unitree_go.msg.dds_ import LowState_, SportModeState_
        ChannelFactoryInitialize(0, nic)
        self.lock, self.low, self.sport, self.low_t = threading.Lock(), None, None, 0.
        self._a = ChannelSubscriber('rt/lowstate', LowState_); self._a.Init(self._on_low, 10)
        self._b = ChannelSubscriber('rt/sportmodestate', SportModeState_); self._b.Init(self._on_sport, 10)

    def _on_low(self, msg):
        with self.lock:
            self.low, self.low_t = msg, time.monotonic()

    def _on_sport(self, msg):
        with self.lock:
            self.sport = msg

    def snapshot(self):
        with self.lock:
            return self.low, self.low_t, self.sport


def row(low, low_t, sport, label, now):
    ms = low.motor_state
    sdk = lambda f: np.array([f(ms[i]) for i in range(12)])[POLICY_FROM_SDK]
    r = parse_remote(bytes(low.wireless_remote))
    out = {'t': round(now, 4), 'phase': 'factory', 'label': label, 'stale': now - low_t > .05,
           'stick': r4((r.lx, r.ly, r.rx)), 'keys': sorted(r.keys), 'want': None, 'shape': None, 'goal': None, 'cmd': None, 'target': None,
           'q': r4(sdk(lambda m: m.q)), 'dq': r4(sdk(lambda m: m.dq)), 'tau': r4(sdk(lambda m: m.tau_est)),
           'temp': [int(x) for x in sdk(lambda m: m.temperature)],
           'foot': [int(x) for x in low.foot_force], 'gyro': r4(low.imu_state.gyroscope),
           'grav': r4(projected_gravity(tuple(low.imu_state.quaternion))), 'est_vx': None, 'sport': None}
    if sport is not None:
        g = lambda k: getattr(sport, k, None)   # SDK IDL SportModeState_ 칸 (없으면 null)
        num = lambda v, f=float: None if v is None else round(f(v), 4)
        out['sport'] = {'mode': num(g('mode'), int), 'gait': num(g('gait_type'), int), 'err': num(g('error_code'), int), 'height': num(g('body_height')),
                        'vel': r4(g('velocity')), 'yaw_speed': num(g('yaw_speed'))}
    return out


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--nic', required=True)
    ap.add_argument('--out', required=True, type=Path)
    ap.add_argument('--label', default='factory', help='sport · classic 처럼 순서표 줄 이름')
    ap.add_argument('--seconds', type=float, default=0, help='0 = Ctrl+C 까지')
    a = ap.parse_args(argv)
    st = ReadOnlyState(a.nic)
    tw = TraceWriter(a.out, f'factory-{a.label}', on_full=lambda: print(json.dumps({'code': 'TRACE_FULL'}), flush=True))
    print(json.dumps({'code': 'FACTORY_RECORD_READY', 'label': a.label, 'file': str(tw.path)}), flush=True)
    t0, k = time.monotonic(), 0
    try:
        while not a.seconds or time.monotonic() - t0 < a.seconds:
            low, low_t, sport = st.snapshot()
            if low is not None:
                tw.write(row(low, low_t, sport, a.label, time.monotonic()))
            k += 1
            if k % HZ == 0:
                tw.flush()
            time.sleep(max(0., t0 + k / HZ - time.monotonic()))
    except KeyboardInterrupt:
        pass
    finally:
        tw.close()
        print(json.dumps({'code': 'FACTORY_RECORD_EXIT', 'rows': tw.rows}), flush=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())

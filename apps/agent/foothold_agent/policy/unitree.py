"""LowLevelRunner 의 실기 경계: unitree_sdk2py (DDS) 로 LowState 받기 · LowCmd 보내기 · 모드 전환 · SportClient.

Unitree 공식 예제 (go2 low-level stand · MotionSwitcherClient) 의 이름과 순서를 따른다. 이 Go2 X 에서 재지 않았다 (실기 미확인).
import 는 생성할 때만 한다 (시험 · dry-run 에서 SDK 가 없어도 모듈을 읽을 수 있게).
"""
from __future__ import annotations

import threading
import time

import numpy as np

POS_STOP, VEL_STOP = 2.146e9, 16000.0


class UnitreeSdk:
    def __init__(self, nic: str, *, timeout_s=1.0):
        from unitree_sdk2py.core.channel import ChannelFactoryInitialize, ChannelPublisher, ChannelSubscriber
        from unitree_sdk2py.idl.default import unitree_go_msg_dds__LowCmd_
        from unitree_sdk2py.idl.unitree_go.msg.dds_ import LowCmd_, LowState_
        from unitree_sdk2py.utils.crc import CRC
        from unitree_sdk2py.go2.sport.sport_client import SportClient
        from unitree_sdk2py.comm.motion_switcher.motion_switcher_client import MotionSwitcherClient
        ChannelFactoryInitialize(0, nic)
        self._lock, self._state, self._stamp = threading.Lock(), None, 0.
        self._sub = ChannelSubscriber('rt/lowstate', LowState_)
        self._sub.Init(self._on_state, 10)
        self._pub = ChannelPublisher('rt/lowcmd', LowCmd_)
        self._pub.Init()
        self._crc = CRC()
        self._cmd = unitree_go_msg_dds__LowCmd_()
        self._cmd.head[0], self._cmd.head[1] = 0xFE, 0xEF
        self._cmd.level_flag, self._cmd.gpio = 0xFF, 0
        for m in self._cmd.motor_cmd:
            m.mode, m.q, m.dq, m.kp, m.kd, m.tau = 0x01, POS_STOP, VEL_STOP, 0., 0., 0.
        self.sport = SportClient(); self.sport.SetTimeout(timeout_s); self.sport.Init()
        self.switcher = MotionSwitcherClient(); self.switcher.SetTimeout(timeout_s); self.switcher.Init()

    def _on_state(self, msg):
        with self._lock:
            self._state, self._stamp = msg, time.monotonic()

    def low_state(self):
        with self._lock:
            s, stamp = self._state, self._stamp
        if s is None:
            return 0., (1, 0, 0, 0), (0, 0, 0), np.zeros(12), np.zeros(12), b''
        ms = s.motor_state
        return (stamp, tuple(s.imu_state.quaternion), tuple(s.imu_state.gyroscope),
                np.array([ms[i].q for i in range(12)]), np.array([ms[i].dq for i in range(12)]), bytes(s.wireless_remote))

    def motor_tau(self):
        """LowState.motor_state[i].tau_est (SDK 순서 · 기록용)."""
        with self._lock:
            s = self._state
        return [float(s.motor_state[i].tau_est) for i in range(12)] if s is not None else None

    def foot_force(self):
        """LowState.foot_force (SDK 순서 FR · FL · RR · RL · 원시 값 · 검증 안 된 값이라 정책 입력에는 안 씀)."""
        with self._lock:
            s = self._state
        return [int(x) for x in s.foot_force] if s is not None else []

    def send(self, q, dq, kp, kd, tau):
        for i in range(12):
            m = self._cmd.motor_cmd[i]
            m.q, m.dq, m.kp, m.kd, m.tau = float(q[i]), float(dq[i]), float(kp[i]), float(kd[i]), float(tau[i])
        self._cmd.crc = self._crc.Crc(self._cmd)
        self._pub.Write(self._cmd)

    def stand_down(self):
        return self.sport.StandDown()

    def recovery_stand(self):
        return self.sport.RecoveryStand()

    def balance_stand(self):
        return self.sport.BalanceStand()

    def free_walk(self):
        return self.sport.FreeWalk()

    def classic_walk(self, flag=True):
        return self.sport.ClassicWalk(flag)

    def release_mode(self):
        return self.switcher.ReleaseMode()

    def check_mode(self) -> str:
        code, data = self.switcher.CheckMode()
        return (data or {}).get('name', '') if code == 0 else 'unknown'

    def select_mode(self, name):
        return self.switcher.SelectMode(name)

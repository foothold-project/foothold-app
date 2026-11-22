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
import sys
import time
from pathlib import Path

from .lowlevel import CMD_HZ, POLICY_HZ, LowLevelRunner, Phase
from .start import StartPolicy


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--folder', required=True, type=Path)
    ap.add_argument('--nic', required=True)
    ap.add_argument('--mode', default='off', choices=['off'])
    ap.add_argument('--live', action='store_true')
    ap.add_argument('--sport-mode', default='normal', help="고수준 복귀 이름 (SDK 예제 'normal' · 펌웨어에 따라 'mcf' · 실기 미확인)")
    ap.add_argument('--seconds', type=float, default=0, help='0 = until Ctrl+C')
    a = ap.parse_args(argv)
    if a.live:
        from foothold_agent.go2_direct.approval import validate
        approval = validate(os.environ)   # 사람 · 0600 · 30 분 표식 없으면 여기서 멈춘다
        if approval.nic != a.nic:
            raise PermissionError('approval NIC differs from --nic')
    from .unitree import UnitreeSdk
    sdk = UnitreeSdk(a.nic)
    runner = LowLevelRunner(sdk, StartPolicy(a.folder, a.mode), live=a.live, sport_mode=a.sport_mode,
                            on_event=lambda e: print(json.dumps({'t': round(e.t, 3), 'code': e.code, **e.data}, ensure_ascii=False), flush=True))
    runner.emit('RUNNER_READY', live=a.live, mode=a.mode)
    t0, k = time.monotonic(), 0
    per = CMD_HZ // POLICY_HZ
    try:
        while not a.seconds or time.monotonic() - t0 < a.seconds:
            if k % per == 0:
                runner.tick()
            else:
                runner.hold()
            k += 1
            time.sleep(max(0., t0 + k / CMD_HZ - time.monotonic()))
    except KeyboardInterrupt:
        pass
    finally:
        if runner.phase in (Phase.POLICY, Phase.STANDING_UP):
            runner.damp('exit')
            runner.to_high()
        runner.emit('RUNNER_EXIT', sent=runner.sent)
    return 0


if __name__ == '__main__':
    sys.exit(main())

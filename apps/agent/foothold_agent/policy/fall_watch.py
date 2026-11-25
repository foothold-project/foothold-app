"""순정 모드 (Classic · Sport) 넘어짐을 중력 방향으로 알아냄 (팀장 11/25 17:32).

START 실행기는 정책 중에만 넘어짐을 본다 (runner.cpp: grav_z > -0.5 · 0.5 s).
순정 모드에는 그런 이벤트가 없어 11/24 18:55 R2+Y 「Love」 중 뒤로 뒤집힌 것이 기록에만 남았다.
순정의 뒷다리 서기 동작은 몸을 약 100° 세우므로 (grav ≈ [-0.98, 0, 0.2]) 실행기 기준을 그대로 쓰면
동작마다 넘어짐으로 잡힌다. 그래서 순정 기준은 「뒤집힘 · 옆으로 구름 · 앞으로 처박힘」 만 본다:
  grav_z > 0.5 (등이 바닥 쪽, 120° 넘게) 또는 |grav_y| > 0.8 (옆으로 53° 넘게) 또는 grav_x > 0.8 (앞으로 숙임)
이 0.5 s 이어지면 FACTORY_FALL 한 번, 수평 (grav_z < -0.9) 이 1 s 이어지면 FACTORY_FALL_RECOVERED.
"""
HOLD_S = .5
LEVEL_S = 1.


def tipped(grav):
    x, y, z = grav
    return z > .5 or abs(y) > .8 or x > .8


class FallWatch:
    def __init__(self):
        self.since = None      # 기운 상태가 시작된 때
        self.level_since = None
        self.fallen = False
        self.peak = None

    def update(self, grav, now, err=None):
        """grav (몸 기준 중력 방향) · now (초) → 새 이벤트 dict 또는 None."""
        if grav is None:
            return None
        if self.fallen:
            if grav[2] < -.9:
                if self.level_since is None:
                    self.level_since = now
                if now - self.level_since >= LEVEL_S:
                    self.fallen, self.since, self.level_since = False, None, None
                    return {'code': 'FACTORY_FALL_RECOVERED', 'err': err}
            else:
                self.level_since = None
            return None
        if tipped(grav):
            if self.since is None:
                self.since, self.peak = now, list(grav)
            if grav[2] > self.peak[2]:
                self.peak = list(grav)
            if now - self.since >= HOLD_S:
                self.fallen, self.level_since = True, None
                return {'code': 'FACTORY_FALL', 'grav': [round(v, 3) for v in self.peak], 'err': err}
        else:
            self.since = None
        return None

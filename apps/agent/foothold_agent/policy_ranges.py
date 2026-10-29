"""Agent-side simulation command ranges; no physical-policy selection here."""
from dataclasses import dataclass
import math

from foothold_agent.safety.core import Z


def velocity_input(value, *, local=False):
    """SI triples for an explicitly simulation Session, without axis clipping."""
    types = (list, tuple) if local else (list,)
    if (not isinstance(value, types) or len(value) != 3
            or not all(type(x) in (int, float) and -1e100 < x < 1e100
                       and math.isfinite(x) for x in value)):
        return None
    return tuple(value)


@dataclass(frozen=True)
class VelocityRange:
    adapter_id: str
    vx_min_moving: float
    vx_max: float
    vy_min: float
    vy_max: float
    wz_min: float
    wz_max: float

    def validate(self, velocity):
        value = velocity_input(velocity, local=True)
        if value is None:
            return Z, 'INVALID_VELOCITY'
        if value == Z:
            return Z, 'ZERO'
        vx, vy, wz = value
        if not (self.vx_min_moving <= vx <= self.vx_max
                and self.vy_min <= vy <= self.vy_max
                and self.wz_min <= wz <= self.wz_max):
            return Z, 'UNSUPPORTED_VELOCITY'
        return value, 'TESTED'  # range acceptance, not a walking-validation claim

    def project(self, vx, vy, wz):
        value, reason = self.validate((vx, vy, wz))
        return value, '' if reason in ('ZERO', 'TESTED') else reason

    def metadata(self):
        """Additive policy facts; legacy phone limits keep their input semantics."""
        return dict(policy_adapter_id=self.adapter_id, requires_forward_motion=True,
                    policy_velocity_range=dict(vx_min_moving=self.vx_min_moving,
                        vx_max=self.vx_max, vy_min=self.vy_min, vy_max=self.vy_max,
                        wz_min=self.wz_min, wz_max=self.wz_max))


# DRIVE-MODES-VALIDATION.md: training env.yaml ranges; standing is ALL axes zero.
POLICY_RANGES = {
    'foothold-v2': VelocityRange('foothold-v2', .4, 1.5, 0.0, 0.0, -1.0, 1.0),
}
FOOTHOLD_V2 = POLICY_RANGES['foothold-v2']

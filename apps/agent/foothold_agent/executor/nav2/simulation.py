"""SI-only Nav2 policy, enabled by a simmgr launch proof and the local Hub.

No environment switch selects this policy. The private simmgr bootstrap supplies
the proof; the normal module entry point always retains the physical policy.
"""
from dataclasses import dataclass
from pathlib import Path
import re

from foothold_agent.safety.core import Z
from .intent import number


@dataclass(frozen=True)
class SimulationBinding:
    robot_id: str
    run_id: str
    generation: int
    epoch: int
    maps: tuple

    @classmethod
    def from_launch(cls, proof, config, env):
        """Verify the launch's live native PID, start time, cgroup and DDS scope.

        Missing/mismatched proof disables the policy. Files are read only at
        startup, before ROS/listeners, never in the motion loop.
        """
        floors = config.floor_bindings
        if not isinstance(proof, dict) or floors is None:
            return None
        try:
            identity, registration = proof['identity'], proof['registration']
            pid, ticks = identity['main_pid'], identity['main_start_ticks']
            if (type(pid) is not int or pid <= 0 or type(ticks) is not int or ticks <= 0
                    or identity['ros_domain'] != '93' or env.get('ROS_DOMAIN_ID') != '93'
                    or not re.fullmatch(r'fh-srv-[0-9a-f]{12}', identity['partition'])
                    or env.get('GZ_PARTITION') != identity['partition']
                    or not identity['cgroup'].startswith('/')
                    or identity['cgroup'] == '/'
                    or registration != dict(robot_id=config.robot_id, run_id=floors.run_id,
                                            generation=floors.generation)
                    or floors.robot_id != config.robot_id):
                return None
            proc = Path('/proc') / str(pid)
            if int((proc/'stat').read_text().rsplit(')', 1)[1].split()[19]) != ticks:
                return None
            groups = (proc/'cgroup').read_text().splitlines()
            native_env = dict(item.split(b'=', 1) for item in (proc/'environ').read_bytes().split(b'\0') if b'=' in item)
            if (not any(row.split(':', 2)[-1] == identity['cgroup'] for row in groups)
                    or native_env.get(b'ROS_DOMAIN_ID') != b'93'):
                return None
            # The main supervisor need not carry GZ_PARTITION. Verify a recorded
            # native child in that same cgroup rather than discovering processes.
            partition_verified = False
            for row in identity['processes']:
                if row.get('partition') != identity['partition']:
                    continue
                if type(row.get('pid')) is not int or row['pid'] <= 0:
                    return None
                child = Path('/proc') / str(row['pid'])
                child_env = dict(item.split(b'=', 1) for item in (child/'environ').read_bytes().split(b'\0') if b'=' in item)
                if (int((child/'stat').read_text().rsplit(')', 1)[1].split()[19]) != row['start_ticks']
                        or not any(group.split(':', 2)[-1] == identity['cgroup'] for group in (child/'cgroup').read_text().splitlines())
                        or child_env.get(b'ROS_DOMAIN_ID') != b'93'
                        or child_env.get(b'GZ_PARTITION') != identity['partition'].encode()):
                    return None
                partition_verified = True
            if not partition_verified:
                return None
            return cls(config.robot_id, floors.run_id, floors.generation, floors.epoch,
                       tuple((b['world_id'], b['floor_id'], b['sha256']) for b in floors.bindings.values()))
        except (KeyError, ValueError, TypeError, AttributeError, OSError):
            return None

    def matches(self, binding):
        return (binding is not None and binding.episode >= self.epoch
                and (binding.world, binding.floor, binding.map_sha) in self.maps)


class SimulationPolicyAdapter:
    @property
    def policy_version(self):
        return 'nav2-simulation-si/2' if self.enabled() else self.physical.policy_version

    def __init__(self, physical, enabled):
        self.physical, self.enabled = physical, enabled

    @staticmethod
    def validate(velocity):
        if (not isinstance(velocity, (tuple, list)) or len(velocity) != 3
                or not all(number(x) for x in velocity)):
            return Z, 'INVALID_VELOCITY'
        vx, vy, wz = velocity
        if not (0 <= vx <= .6 and vy == 0 and -.5 <= wz <= .5):
            return Z, 'UNSUPPORTED_VELOCITY'
        return tuple(velocity), 'TESTED' if any(velocity) else 'ZERO'

    def adapt(self, velocity):
        if not self.enabled():
            return self.physical.adapt(velocity)
        # Values fit Core's existing [-1,1] input validation, but are SI here.
        return self.validate(velocity)

    def project(self, vx, vy, wz):
        if not self.enabled():
            # A lost binding must never reinterpret SI as physical axes.
            return Z, 'SIMULATION_BINDING_REQUIRED'
        velocity, reason = self.validate((vx, vy, wz))
        return velocity, '' if reason in ('TESTED', 'ZERO') else reason

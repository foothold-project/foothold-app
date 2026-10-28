"""Control plane has no ROS identity; only allowlisted children may join domain93."""
import os
from foothold_agent.ros_bridge.config import DDS_OVERRIDES, REQUIRED_ENV, validate_isolation

# Do not pass DB URLs, service keys, pass keys, FH_SIM_RUN, PYTHONPATH or DDS knobs.
BASE_KEYS = ('PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR',
             'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS')


def validate_control_environment(env=None):
    env = os.environ if env is None else env
    if any(name.startswith('ROS_') or name in (*DDS_OVERRIDES, 'RMW_IMPLEMENTATION') for name in env):
        raise ValueError('control plane must not inherit ROS/DDS environment')


def child_environment(domain, env=None):
    env = os.environ if env is None else env
    validate_control_environment(env)
    if domain != 93:
        raise ValueError('simulation domain must be 93')
    child = {name: env[name] for name in BASE_KEYS if name in env}
    child.setdefault('PATH', os.defpath)
    from .sysroot_environment import load
    child.update(load(env))
    if 'FH_SIM_NATIVE_PYTHON_DIR' in env:
        if env['FH_SIM_NATIVE_PYTHON_DIR'] != '/opt/foothold-sim/python-vendor':
            raise ValueError('unapproved native Python vendor path')
        child['FH_SIM_NATIVE_PYTHON_DIR'] = env['FH_SIM_NATIVE_PYTHON_DIR']
    child.update(REQUIRED_ENV, GZ_IP='127.0.0.1', PYTHONDONTWRITEBYTECODE='1')
    validate_isolation(child)
    return child

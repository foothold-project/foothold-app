"""Read-only approval-run resource gates. No unit creation or process signals."""
import json
import os
from pathlib import Path
import subprocess
import time


class ResourceGate:
    def __init__(self, config, *, now=time.monotonic):
        self.c, self.now = config, now
        self.previous_swap = None
        self.swap_since = self.rtf_since = None

    def update(self, sample, *, starting=False):
        now = self.now()
        if starting:
            return (sample['available_mib'] >= self.c['host_available_start_mib']
                    and sample['load1'] <= self.c['load1_start_max']
                    and sample['gpu_free_mib'] >= self.c['gpu_free_start_mib'])
        if sample['available_mib'] < self.c['host_available_stop_mib']:
            return False
        if sample['swap_in_kib_s'] > self.c['swap_in_kib_s_max']:
            self.swap_since = now if self.swap_since is None else self.swap_since
        else:
            self.swap_since = None
        if sample['rtf'] < self.c['rtf_min']:
            self.rtf_since = now if self.rtf_since is None else self.rtf_since
        else:
            self.rtf_since = None
        return not (self.swap_since is not None and now-self.swap_since >= self.c['swap_hold_wall_s']
                    or self.rtf_since is not None and now-self.rtf_since >= self.c['rtf_hold_wall_s'])


def scope_limits(config):
    """Require the separately owned Nav group; never inherit an unconstrained shell."""
    relative = next(line.split(':', 2)[2] for line in Path('/proc/self/cgroup').read_text().splitlines()
                    if line.startswith('0::'))
    group = Path('/sys/fs/cgroup')/relative.lstrip('/')
    mem, swap, tasks = [int((group/name).read_text()) for name in ('memory.max', 'memory.swap.max', 'pids.max')]
    quota, period = map(int, (group/'cpu.max').read_text().split())
    limits = config['nav_limits']
    if (mem > limits['memory_mib']*1024**2 or swap != limits['swap_mib']*1024**2
            or tasks > limits['tasks'] or quota/period > limits['cpu_percent']/100):
        raise ValueError('Nav group must be <=768MiB/swap0/CPU150%/Tasks256')
    return str(group)


def snapshot(previous=None, *, rtf=1.0):
    now = time.monotonic()
    memory = dict(line.split(':', 1) for line in Path('/proc/meminfo').read_text().splitlines())
    vm = dict(line.split() for line in Path('/proc/vmstat').read_text().splitlines())
    swap = int(vm['pswpin'])*os.sysconf('SC_PAGE_SIZE')/1024
    rate = 0 if previous is None else max(0, swap-previous['swap_kib'])/max(.001, now-previous['wall'])
    gpu = subprocess.run(['nvidia-smi', '--query-gpu=memory.free', '--format=csv,noheader,nounits'],
                         capture_output=True, text=True, check=True, timeout=1)
    return {'wall': now, 'available_mib': int(memory['MemAvailable'].split()[0])/1024,
            'load1': os.getloadavg()[0], 'gpu_free_mib': min(float(x) for x in gpu.stdout.splitlines()),
            'swap_in_kib_s': rate, 'swap_kib': swap, 'rtf': rtf}

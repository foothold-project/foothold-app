"""One-second Linux counters. Persist numeric IDs, never cmdline, environ or NIC addresses."""
import os
from pathlib import Path
import socket
import time


def process(path):
    try:
        # comm can contain spaces and parentheses. Fields 14, 15 and 22 follow it.
        fields = (path / 'stat').read_text().rsplit(')', 1)[1].split()
        return int(fields[19]), int(fields[11]) + int(fields[12])
    except (OSError, IndexError, ValueError):
        return None


def agent_pid():
    modules = {b'foothold_agent.desktop', b'foothold_agent.setup', b'foothold_agent.go2_direct',
               b'foothold_agent.go2_readonly'}
    matches = []
    for path in Path('/proc').glob('[0-9]*/cmdline'):
        try:
            args = path.read_bytes().split(b'\0')
            if any(a == b'-m' and b in modules for a, b in zip(args, args[1:])):
                matches.append(int(path.parent.name))
        except OSError:
            pass
    return matches[0] if len(matches) == 1 else None


class Metrics:
    def __init__(self, pid, nic):
        self.pid, self.auto, self.nic = pid, pid is None, nic
        self.ticks = os.sysconf('SC_CLK_TCK')
        self.start = self.previous = time.monotonic()
        self.cpu, self.tasks = {}, {}

    def sample(self):
        now = time.monotonic()
        window = max(now - self.previous, .000001)
        cpu = {}
        for line in Path('/proc/stat').read_text().splitlines():
            if not line.startswith('cpu'):
                break
            key, *values = line.split()
            ticks = list(map(int, values[:8]))
            total, idle = sum(ticks), sum(ticks[3:5])
            old_total, old_idle = self.cpu.get(key, (total, idle))
            delta = total - old_total
            cpu[key] = round(100 * (1 - (idle - old_idle) / delta), 1) if delta else None
            self.cpu[key] = total, idle
        if self.auto and (not self.pid or not Path(f'/proc/{self.pid}').exists()):
            self.pid = agent_pid()
        tasks = {}
        if self.pid:
            path = Path('/proc') / str(self.pid)
            tasks['agent'] = process(path)
            tasks.update((p.name, process(p)) for p in (path / 'task').glob('[0-9]*'))
        tasks['recorder'] = process(Path('/proc/self'))
        pct = {}
        for key, value in tasks.items():
            old = self.tasks.get(key)
            pct[key] = (round(100 * (value[1] - old[1]) / self.ticks / window, 1)
                        if value and old and old[0] == value[0] else None)
        self.tasks, self.previous = tasks, now
        net = {}
        for line in Path('/proc/net/dev').read_text().splitlines()[2:]:
            name, values = line.rsplit(':', 1)
            name = name.strip()
            try:
                key = 'robot_nic' if name == self.nic else f'if{socket.if_nametoindex(name)}'
            except OSError:
                continue  # hot-unplug between the two reads
            fields = values.split()
            net[key] = [int(fields[0]), int(fields[8])]
        memory = {k.rstrip(':'): int(v) for k, v, *_ in
                  (line.split() for line in Path('/proc/meminfo').read_text().splitlines())
                  if k in ('MemTotal:', 'MemAvailable:', 'SwapFree:')}
        rss = int(Path('/proc/self/statm').read_text().split()[1]) * os.sysconf('SC_PAGE_SIZE')
        seconds = {k: v[1] / self.ticks for k, v in tasks.items() if v is not None}
        return dict(cpu_pct=cpu, task_pct=pct, task_cpu_s=seconds, agent_pid=self.pid, memory_kib=memory,
                    load=os.getloadavg(), net_rx_tx_bytes=net, recorder_rss_bytes=rss,
                    elapsed_s=round(now - self.start, 3), window_s=round(window, 3))

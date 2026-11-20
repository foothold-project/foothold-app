"""Read only frame headers for DDS statistics; join journal locks on the sender's clock."""
from bisect import bisect_left
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone
import json
import math
import re

from .journal import event
from .storage import samples
from .topics import LOW_TOPIC, SPORT_TOPIC, SYSTEM


@dataclass
class Stats:
    bins: Counter = field(default_factory=Counter)
    last: int | None = None
    count: int = 0
    total: int = 0
    max_size: int = 0
    max_gap: int = 0
    over: int = 0

    def add(self, msg):
        if self.last is not None:
            delta = msg.mono - self.last
            if delta < 0:
                raise ValueError('capture clocks out of order')
            self.bins[round(delta / 1e6)] += 1
            self.max_gap = max(self.max_gap, delta)
            self.over += delta > 200_000_000
        self.last = msg.mono
        self.total += msg.size
        self.count += 1
        self.max_size = max(msg.size, self.max_size)

    def percentile(self, p):
        target = math.ceil((self.count - 1) * p)
        for gap, frequency in sorted(self.bins.items()):
            target -= frequency
            if target <= 0:
                return str(gap)
        return '—'


def locks(path):
    events = []
    if path:
        with open(path, encoding='utf8') as stream:
            for number, line in enumerate(stream, 1):
                if 'GO2_LOCK kind=lock ' not in line:
                    continue
                wall = None
                if line.startswith('{'):
                    row = json.loads(line)
                    stamp = int(row['__MONOTONIC_TIMESTAMP']) * 1000
                    wall = int(row['__REALTIME_TIMESTAMP']) * 1000
                    line = row['MESSAGE']
                else:
                    prefix = re.match(r'\s*\[\s*(\d+)\.(\d+)\]', line)
                    if not prefix:
                        raise ValueError(f'journal line {number} requires -o json or short-monotonic')
                    stamp = int(prefix[1]) * 10**9 + int(prefix[2][:9].ljust(9, '0'))
                entry = event(line, stamp, wall)
                if entry:
                    events.append((stamp, number, entry['cause'], wall))
    return sorted(events)


def value(n):
    return '—' if n is None else f'{n:.1f}'


def analyze(root, journal=None, system_jsonl=False):
    if system_jsonl:
        for msg in samples(root, headers_only=True):
            if msg.meta['topic'] == SYSTEM:
                print(json.dumps(dict(mono_ns=msg.mono, wall_ns=msg.wall, **json.loads(msg.payload)),
                                 separators=(',', ':')))
        return
    events = locks(journal)
    journal_states = set()
    if not journal:
        for sample in samples(root, headers_only=True):
            if sample.meta['topic'] == SYSTEM:
                row = json.loads(sample.payload)
                journal_states.add(row.get('lock_journal', 'unavailable'))
                for entry in row.get('locks', ()):
                    events.append((entry['mono'], len(events) + 1, entry['cause'], entry['wall']))
        events.sort()
    stats = defaultdict(Stats)
    first = last = latest = None
    matched, cpu, pos = [], [], 0
    drops = lost = {}
    for item in samples(root, headers_only=True):
        if first is None:
            first, start_wall = item.mono, item.wall
            pos = bisect_left(events, (first,))
        while pos < len(events) and events[pos][0] <= item.mono:
            at, number, cause, wall = events[pos]
            pos += 1
            if wall is not None and abs((wall - at) - (item.wall - item.mono)) > 5e9:
                continue  # journal entry from another boot
            ages = [None if stats[t].last is None else (at - stats[t].last) / 1e6
                    for t in (LOW_TOPIC, SPORT_TOPIC)]
            matched.append((number, (at - first) / 1e9, cause, *ages, latest))
        last = item.mono
        topic = item.meta['topic']
        if topic == SYSTEM:
            row = json.loads(item.payload)
            latest = row['cpu_pct']['cpu']
            cpu.append(((last - first) / 1e9, latest, row['task_pct'].get('agent'),
                        row['task_pct']['recorder'], row['recorder_rss_bytes'] / 2**20))
            drops = row['queue_drops']
            lost = row.get('dds_lost', {})
        else:
            stats[topic].add(item)
    duration = ((last - first) / 1e9) if first is not None else 0
    start = datetime.fromtimestamp(start_wall / 1e9, timezone.utc).isoformat() if first is not None else '—'
    print(f'# DDS capture · {start} · {duration:.3f} s\n')
    print('| topic | n | p50 ms | p95 ms | max ms | >200 ms | bytes | max B | B/s |')
    print('|---|---:|---:|---:|---:|---:|---:|---:|---:|')
    for topic, s in sorted(stats.items()):
        if s.count:
            print(f'| {topic} | {s.count} | {s.percentile(.5)} | {s.percentile(.95)} | '
                  f'{value(s.max_gap / 1e6 if s.count > 1 else None)} | {s.over} | '
                  f'{s.total} | {s.max_size} | {value(s.total / duration if duration else None)} |')
    print(f'\nRecorder queue drops (last sample): {json.dumps(drops)}')
    print(f'DDS reader reported losses (last sample): {json.dumps(lost)}')
    print('\n| interval s | system CPU % | agent CPU % | recorder CPU % | peak recorder MiB |')
    print('|---|---:|---:|---:|---:|')
    stride = max(1, math.ceil(len(cpu) / 12))
    for i in range(0, len(cpu), stride):
        batch = cpu[i:i+stride]
        cells = []
        for col in (1, 2, 3):
            readings = [r[col] for r in batch if r[col] is not None]
            cells.append(value(sum(readings) / len(readings) if readings else None))
        print(f'| {batch[0][0]:.1f}–{batch[-1][0]:.1f} | ' + ' | '.join(cells)
              + f' | {max(r[4] for r in batch):.1f} |')
    label = 'journal line' if journal else 'journal event'
    print(f'\n| {label} | capture s | lock cause | low age ms | sport age ms | last system CPU % |')
    print('|---:|---:|---|---:|---:|---:|')
    for n, t, cause, low, sport, system in matched:
        print(f'| {n} | {t:.3f} | {cause} | {value(low)} | {value(sport)} | {value(system)} |')
    if not matched:
        print('\nNo timestamped lock in the retained window.')
    if journal_states:
        print('Local journal status: ' + ', '.join(sorted(journal_states)))

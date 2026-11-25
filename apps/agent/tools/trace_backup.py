#!/usr/bin/env python3
"""Back up Jetson START traces to ai-lx01 when they pass 2 GB (팀장 11/25 12:14).

Runs on ai-lx01 from a user timer (trace-backup.timer, every 10 min). The C++ runner stops
recording when the *.jsonl files directly in the trace folder pass 4 GB (trace.cpp
total_limit). When they pass 2 GB this script:
  1. picks the closed files (not written for 10 min, so the open recording is left alone),
  2. copies them to ai-lx01 and checks sha256 on both sides,
  3. moves only the verified files on the Jetson into trace/archive-<YYYYMMDD>/.
Files in sub-folders are not counted by the runner, so recording continues. Nothing is deleted.
Only ssh/rsync are used: no DDS participant is started on the Jetson.
"""
import hashlib, json, os, subprocess, sys, time

HOST = os.environ.get('FH_JETSON_HOST') or subprocess.run(
    ['tailscale', 'ip', '-4', 'go2x-jetson'], capture_output=True, text=True).stdout.strip()
KEY = os.path.expanduser(os.environ.get('FH_JETSON_KEY', '~/.ssh/id_ed25519_go2x'))
TRACE = 'foothold-policy-1122/trace'
LOCAL = os.environ.get('FH_TRACE_BACKUP', '/mnt/win-d/mai/data/go2x_raw/jetson-trace')
START_AT = int(os.environ.get('FH_TRACE_START_AT', 2_000_000_000))
IDLE_S = 600
SSH = ['ssh', '-i', KEY, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', f'nvidia@{HOST}']

LIST = f'''cd ~/{TRACE} && python3 -c "
import os,json,time
now=time.time()
print(json.dumps([[f,os.path.getsize(f),now-os.path.getmtime(f)] for f in os.listdir('.') if f.endswith('.jsonl') and os.path.isfile(f)]))"'''


def ssh(cmd, **kw):
    return subprocess.run(SSH + [cmd], capture_output=True, text=True, timeout=kw.get('timeout', 60))


def sha_local(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(1 << 20), b''):
            h.update(block)
    return h.hexdigest()


def pick(files, start_at=START_AT, idle_s=IDLE_S):
    """Closed files to back up once the total passes start_at. Oldest first."""
    total = sum(size for _, size, _ in files)
    if total < start_at:
        return total, []
    return total, sorted([f for f, _, idle in files if idle >= idle_s])


def main():
    if not HOST:
        print('trace-backup: Jetson 주소 없음 (tailscale)'); return 0
    r = ssh(LIST)
    if r.returncode != 0:
        print('trace-backup: Jetson 응답 없음'); return 0
    total, chosen = pick(json.loads(r.stdout))
    if not chosen:
        print(f'trace-backup: 합계 {total / 1e9:.2f} GB · 백업 안 함 (기준 {START_AT / 1e9:.0f} GB)'); return 0
    day = time.strftime('%Y%m%d')
    dest = os.path.join(LOCAL, day)
    os.makedirs(dest, exist_ok=True)
    src = [f'nvidia@{HOST}:{TRACE}/{f}' for f in chosen]
    r = subprocess.run(['rsync', '-a', '-e', f'ssh -i {KEY} -o BatchMode=yes'] + src + [dest + '/'],
                       capture_output=True, text=True, timeout=3600)
    if r.returncode != 0:
        print('trace-backup: rsync 실패', r.stderr[-300:]); return 1
    r = ssh(f'cd ~/{TRACE} && sha256sum ' + ' '.join(chosen), timeout=600)
    remote = dict(reversed(line.split(None, 1)) for line in r.stdout.splitlines())
    ok = [f for f in chosen if remote.get(f) == sha_local(os.path.join(dest, f))]
    bad = sorted(set(chosen) - set(ok))
    if ok:
        r = ssh(f'cd ~/{TRACE} && mkdir -p archive-{day} && mv -n ' + ' '.join(ok) + f' archive-{day}/')
        if r.returncode != 0:
            print('trace-backup: Jetson 옮기기 실패', r.stderr[-300:]); return 1
    print(f'trace-backup: 합계 {total / 1e9:.2f} GB · 백업 {len(ok)} 개 → {dest} · Jetson archive-{day} 로 옮김'
          + (f' · sha 불일치 {len(bad)} 개 남김: {bad[:3]}' if bad else ''))
    return 1 if bad else 0


if __name__ == '__main__':
    if sys.argv[1:] == ['--self-test']:
        files = [['a.jsonl', 1_500_000_000, 900], ['b.jsonl', 600_000_000, 30], ['c.jsonl', 10, 1200]]
        assert pick(files) == (2_100_000_010, ['a.jsonl', 'c.jsonl']), pick(files)
        assert pick(files[:1]) == (1_500_000_000, [])
        print('self-test ok'); sys.exit(0)
    sys.exit(main())

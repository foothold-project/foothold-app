import argparse
import asyncio
import json
import logging
import math
import os
import signal
import sys
import threading
from pathlib import Path


def positive(text):
    n = float(text)
    if not math.isfinite(n) or n <= 0:
        raise argparse.ArgumentTypeError('positive finite number required')
    return n


def port(text):
    n = int(text)
    if not 1 <= n <= 65535:
        raise argparse.ArgumentTypeError('invalid port')
    return n


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv and argv[0] == 'replay':
        parser = argparse.ArgumentParser(description='Replay into the agent with memory-only robot outputs.')
        parser.add_argument('directory', type=Path)
        parser.add_argument('--speed', type=positive, default=1.)
        parser.add_argument('--server-port', type=port, help='local development server on 127.0.0.1')
        args = parser.parse_args(argv[1:])
        from .replay import replay
        logging.basicConfig(level=logging.INFO, format='%(asctime)s %(message)s')
        print(json.dumps(asyncio.run(replay(args.directory, args.speed, args.server_port))))
    elif argv and argv[0] == 'analyze':
        parser = argparse.ArgumentParser(description='Summarize retained samples and align GO2_LOCK journal entries.')
        parser.add_argument('directory', type=Path)
        parser.add_argument('--journal', type=Path)
        parser.add_argument('--system-jsonl', action='store_true', help='emit full per-second counters')
        args = parser.parse_args(argv[1:])
        from .analyze import analyze
        analyze(args.directory, args.journal, args.system_jsonl)
    else:
        parser = argparse.ArgumentParser(description='Record passive Go2 DDS subscriptions. Other commands: replay, analyze.')
        parser.add_argument('--out', required=True, type=Path)
        parser.add_argument('--nic', required=True, help='dedicated wired robot NIC')
        parser.add_argument('--agent-pid', type=int, help='setup PID (automatically detect a single agent by default)')
        depth = parser.add_mutually_exclusive_group(required=True)
        depth.add_argument('--status-port', type=port, help='follow depth_selected from local agent setup /status')
        depth.add_argument('--depth-selected', help='explicit current depth topic, or none')
        parser.add_argument('--video', action='store_true', help='retain private front-camera payloads')
        parser.add_argument('--max-gb', type=positive, default=20.)
        parser.add_argument('--chunk-mb', type=positive, default=128.)
        parser.add_argument('--chunk-seconds', type=positive, default=60.)
        args = parser.parse_args(argv)
        from .capture import capture
        stop = threading.Event()
        for sig in (signal.SIGINT, signal.SIGTERM):
            signal.signal(sig, lambda *_: stop.set())
        os.nice(10)
        capture(args, stop)


if __name__ == '__main__':
    main()

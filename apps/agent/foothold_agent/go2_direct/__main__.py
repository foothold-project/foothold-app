"""Explicit, disabled-by-default field entrypoint. Starting joins real DDS."""
import argparse
import asyncio
import os
import signal
import sys

from .config import Config
from .runtime import run
from .reporting import Reporting


async def serve(config, env):
    loop = asyncio.get_running_loop()
    stop = asyncio.Event()
    signals = (signal.SIGINT, signal.SIGTERM)
    for sig in signals:
        loop.add_signal_handler(sig, stop.set)
    try:
        if getattr(config, 'readonly', False):
            from .readonly import run as run_readonly
            await run_readonly(config, stop=stop)
        elif config.server:
            from .server import run as run_server
            from .media import Publisher
            await run_server(config, env, stop=stop, media_factory=Publisher)
        else:
            await run(config, env, stop=stop, reporting_factory=Reporting)
    finally:
        for sig in signals:
            loop.remove_signal_handler(sig)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--server', action='store_true', help='explicit server-drive trial; no phone listener')
    parser.add_argument('--readonly', action='store_true', help='server observation only; no motion SDK objects')
    parser.add_argument('--nic', help='explicit NIC for --server --readonly only')
    args = parser.parse_args(argv)
    if args.readonly and (not args.server or not args.nic) or args.nic and not args.readonly:
        parser.error('--readonly requires --server --nic; --nic is observation-only')
    config = None
    try:
        env = dict(os.environ)
        if args.readonly:
            from .readonly import Config as ReadonlyConfig
            config = ReadonlyConfig.from_env(env, args.nic)
        else:
            config = Config.from_env(env, server=args.server)
        asyncio.run(serve(config, env))
        return 0
    except (Exception, KeyboardInterrupt):
        # Never echo environment values, tokens, addresses, or the field serial.
        print('Go2 direct stopped or refused; check reviewed field configuration', file=sys.stderr)
        return 2
    finally:
        if config is not None and config.verifier is not None:
            config.verifier.close()


if __name__ == '__main__':
    raise SystemExit(main())

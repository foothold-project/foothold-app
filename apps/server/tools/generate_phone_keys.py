#!/usr/bin/env python3
"""Create one robot's server and agent key files outside the repository."""
import argparse
import base64
import json
import os
from pathlib import Path
import re
from uuid import UUID


def generate(robot, kid, server_path, agent_path):
    robot = str(UUID(robot))
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', kid):
        raise ValueError('invalid key ID')
    root = Path(__file__).resolve().parents[3]
    paths = [Path(p).expanduser().absolute() for p in (server_path, agent_path)]
    resolved = [p.resolve() for p in paths]
    if resolved[0] == resolved[1] or any(p.is_relative_to(root) for p in resolved):
        raise ValueError('distinct output files outside the repository required')
    secret = base64.urlsafe_b64encode(os.urandom(32)).rstrip(b'=').decode()
    bodies = [{robot: {'active': kid, 'keys': {kid: secret}}}, {kid: secret}]
    created = []
    try:
        for path, body in zip(paths, bodies):
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            created.append(path)
            with os.fdopen(fd, 'w') as output:
                json.dump(body, output)
                output.write('\n')
                output.flush()
                os.fsync(output.fileno())
    except BaseException:
        for path in created:
            path.unlink()
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--robot', required=True)
    parser.add_argument('--kid', required=True)
    parser.add_argument('--server-output', required=True)
    parser.add_argument('--agent-output', required=True)
    args = parser.parse_args()
    generate(args.robot, args.kid, args.server_output, args.agent_output)
    print('Created private server and agent key files; no key material printed.')


if __name__ == '__main__':
    main()

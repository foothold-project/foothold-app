#!/usr/bin/env bash
# Build HEAD from prepare-release's actual allowlist, without the checkout's files.
set -euo pipefail
repo=$(git -C "$(dirname -- "$0")" rev-parse --show-toplevel)
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT

# Read the committed script too, so the script and archived inputs share HEAD.
# Parse only its web archive command; never execute the release/deployment script.
python3 - "$repo" > "$work/paths" <<'PY'
import shlex
import subprocess
import sys

script = subprocess.check_output(
    ['git', '-C', sys.argv[1], 'show', 'HEAD:deploy/prepare-release.sh'], text=True)
commands = script.replace('\\\n', ' ').splitlines()
prefix = ['git', '--git-dir=$repo', 'archive', '$sha', 'apps/contracts', 'apps/web']
for command in commands:
    if not command.startswith('git --git-dir="$repo" archive "$sha" apps/contracts apps/web '):
        continue
    words = shlex.split(command)
    assert words[:6] == prefix, 'Unexpected web archive command'
    pipe = words.index('|')
    assert words[pipe:] == ['|', 'tar', '-x', '-C', '$build'], 'Unexpected archive extraction'
    print('\n'.join(words[4:pipe]))
    break
else:
    sys.exit('Cannot find prepare-release web archive allowlist')
PY
mapfile -t paths < "$work/paths"
git -C "$repo" archive HEAD "${paths[@]}" | tar -x -C "$work"
(
    cd "$work/apps/web"
    npm ci --ignore-scripts
    npm run build
)
grep -Fq 'fh.btMission.' "$work"/apps/web/dist/assets/*.js
for asset in top-f{1,2}.png scenarios-f{1,2}.json; do grep -Fq "factory-zone/$asset" "$work"/apps/web/dist/assets/*.js; done
printf 'PASS: HEAD web archive builds with the BT mission editor and per-floor assets in its bundle\n'

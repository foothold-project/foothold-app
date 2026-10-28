#!/usr/bin/env bash
# Pure decision tests: every filesystem/service command below is a shell fake.
set -euo pipefail
source "$(dirname "$0")/../common.sh"
valid_sha 0123456789abcdef0123456789abcdef01234567
if valid_sha dev || valid_sha ../escape || valid_site 'name;command'; then exit 1; fi
valid_site development.example.org
needs_rollback 1 1
if needs_rollback 0 1 || needs_rollback 1 0 || needs_rollback 0 0; then exit 1; fi
calls=()
ln() { calls+=("ln:$*"); }
mv() { calls+=("mv:$*"); }
rm() { calls+=("rm:$*"); }
systemctl() { calls+=("systemctl:$*"); }
restore_release /opt/foothold/releases/previous
[[ ${calls[0]} == 'ln:-s /opt/foothold/releases/previous /opt/foothold/current.next' ]]
[[ ${calls[1]} == 'mv:-Tf /opt/foothold/current.next /opt/foothold/current' ]]
[[ ${calls[2]} == 'systemctl:restart foothold-server' ]]
calls=()
restore_release ''
[[ ${calls[0]} == 'rm:-f /opt/foothold/current' && ${calls[1]} == 'systemctl:stop foothold-server' ]]
# Atomic activation failure must propagate, never pretend restart succeeded.
ln() { return 1; }
if restore_release /opt/foothold/releases/previous; then exit 1; fi
printf 'PASS: validation, rollback, first-deploy cleanup, activation failure\n'

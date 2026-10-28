#!/usr/bin/env bash
# Actual flock contention, temporary state only; no ROS/process scans/services.
set -euo pipefail
source "$(dirname "$0")/../common.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
sha=1111111111111111111111111111111111111111
take_sim_deploy_guard "$sha" "$work/absent" "$work/pin"
mkdir -p "$work/guard/state"
touch "$work/guard/deploy.lock"
printf '%s\n' "$sha" > "$work/pin"
(take_sim_deploy_guard "$sha" "$work/guard" "$work/pin")
if (take_sim_deploy_guard 2222222222222222222222222222222222222222 "$work/guard" "$work/pin"); then exit 1; fi
touch "$work/guard/state/unproven"
if (take_sim_deploy_guard "$sha" "$work/guard" "$work/pin"); then exit 1; fi
rm "$work/guard/state/unproven"
exec 7<>"$work/guard/deploy.lock"
flock -sn 7
if (exec 7>&-; take_sim_deploy_guard "$sha" "$work/guard" "$work/pin"); then exit 1; fi
flock -u 7
(take_sim_deploy_guard "$sha" "$work/guard" "$work/pin")
# Parent's guard fd must be inherited without deadlocking/replacing its inode.
(take_sim_deploy_guard "$sha" "$work/guard" "$work/pin"
 bash -c 'source "$1"; take_sim_deploy_guard "$2" "$3" "$4"' bash "$(dirname "$0")/../common.sh" "$sha" "$work/guard" "$work/pin")
printf 'PASS: absent install, SHA mismatch, durable latch, live manager lock, clean idle\n'

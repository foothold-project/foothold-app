#!/usr/bin/env bash
# Actual flock contention, temporary state only; no ROS/process scans/services.
set -euo pipefail
source "$(dirname "$0")/../common.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
sha=1111111111111111111111111111111111111111
take_sim_deploy_guard "$sha" "$work/absent"
mkdir -p "$work/guard/state"
touch "$work/guard/deploy.lock"
(take_sim_deploy_guard "$sha" "$work/guard")
(take_sim_deploy_guard 2222222222222222222222222222222222222222 "$work/guard") # idle accepts next SHA
touch "$work/guard/state/unproven"
if (take_sim_deploy_guard "$sha" "$work/guard"); then exit 1; fi
rm "$work/guard/state/unproven"
touch "$work/guard/setup-unproven"
if (take_sim_deploy_guard "$sha" "$work/guard"); then exit 1; fi
rm "$work/guard/setup-unproven"
exec 7<>"$work/guard/deploy.lock"
flock -sn 7
if (exec 7>&-; take_sim_deploy_guard "$sha" "$work/guard"); then exit 1; fi
flock -u 7
(take_sim_deploy_guard "$sha" "$work/guard")
touch "$work/packages-unproven"
if (take_sim_deploy_guard "$sha" "$work/absent" "$work/packages-unproven"); then exit 1; fi
rm "$work/packages-unproven"
touch "$work/packages-unproven.release-pending"
if (take_sim_deploy_guard "$sha" "$work/absent" "$work/packages-unproven"); then exit 1; fi
rm "$work/packages-unproven.release-pending"
touch "$work/guard/setup-unproven.release-pending"
if (take_sim_deploy_guard "$sha" "$work/guard"); then exit 1; fi
rm "$work/guard/setup-unproven.release-pending"
# Parent's guard fd must be inherited without deadlocking/replacing its inode.
(take_sim_deploy_guard "$sha" "$work/guard"
 bash -c 'source "$1"; take_sim_deploy_guard "$2" "$3" ' bash "$(dirname "$0")/../common.sh" "$sha" "$work/guard")
printf 'PASS: absent install, new idle SHA, durable latch, live session lock, clean idle\n'

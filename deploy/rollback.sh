#!/usr/bin/env bash
set +x
set -euo pipefail
[[ $EUID == 0 && $# == 1 ]] || { echo 'Usage (server root): rollback.sh <previous-full-sha>' >&2; exit 2; }
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
source ./common.sh
valid_sha "$1" || exit 2
take_deploy_lock || exit 1
take_sim_deploy_guard "$1" || { echo 'Sim deployment fence refused: active session or cleanup unproven.' >&2; exit 1; }
target=$1
release=/opt/foothold/releases/$target
[[ -x $release/.venv/bin/uvicorn && -s $release/apps/web/dist/index.html && $(cat "$release/COMMIT") == "$1" ]] || exit 1
previous=''
if [[ -L /opt/foothold/current ]]; then previous=$(readlink -f /opt/foothold/current); fi
switched=0
sim_stopped=0
finish() {
    local result=$? rollback=not-needed
    trap - EXIT
    if needs_rollback "$result" "$switched"; then
        if restore_release "$previous"; then rollback=restored; else rollback=FAILED; fi
    elif (( result != 0 && sim_stopped == 1 )); then
        if sim_manager_start; then rollback=restored-idle-manager; else rollback=FAILED; fi
    fi
    printf '%s rollback-to=%s previous=%s exit=%s recovery=%s mode=manual\n' "$(date -u +%FT%TZ)" "$target" "${previous##*/}" "$result" "$rollback" >> /var/lib/foothold/deploys.log
    exit "$result"
}
trap finish EXIT
sim_manager_stop
sim_stopped=1
activate_release "$release"
switched=1
systemctl restart foothold-server
sim_manager_start
(cd "$release" && "$release/.venv/bin/python" -m deploy.smoke)

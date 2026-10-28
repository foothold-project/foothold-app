#!/usr/bin/env bash
set +x
set -euo pipefail
[[ $EUID == 0 && $# == 1 ]] || { echo 'Usage (server root): rollback.sh <previous-full-sha>' >&2; exit 2; }
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
source ./common.sh
valid_sha "$1" || exit 2
take_deploy_lock || exit 1
take_sim_deploy_guard "$1" || { echo 'Sim deployment fence refused; stop cleanly and approve the same sim SHA first.' >&2; exit 1; }
target=$1
release=/opt/foothold/releases/$target
[[ -x $release/.venv/bin/uvicorn && -s $release/apps/web/dist/index.html && $(cat "$release/COMMIT") == "$1" ]] || exit 1
previous=''
if [[ -L /opt/foothold/current ]]; then previous=$(readlink -f /opt/foothold/current); fi
switched=0
finish() {
    local result=$? rollback=not-needed
    trap - EXIT
    if needs_rollback "$result" "$switched"; then
        if restore_release "$previous"; then rollback=restored; else rollback=FAILED; fi
    fi
    printf '%s rollback-to=%s previous=%s exit=%s recovery=%s mode=manual\n' "$(date -u +%FT%TZ)" "$target" "${previous##*/}" "$result" "$rollback" >> /var/lib/foothold/deploys.log
    exit "$result"
}
trap finish EXIT
activate_release "$release"
switched=1
systemctl restart foothold-server
(cd "$release" && "$release/.venv/bin/python" -m deploy.smoke)

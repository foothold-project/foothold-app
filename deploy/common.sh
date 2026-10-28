#!/usr/bin/env bash
# Shared only by trusted, root-owned deployment scripts.
valid_sha() { [[ ${1:-} =~ ^[0-9a-f]{40}$ ]]; }
valid_site() { [[ ${1:-} =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ && $1 == *.* && $1 != *..* ]]; }
needs_rollback() { (( $1 != 0 && $2 == 1 )); }
activate_release() {
    local target=$1
    ln -sfn "$target" /opt/foothold/current.next &&
    mv -Tf /opt/foothold/current.next /opt/foothold/current
}
# Deliberately no database downgrade. A failed first deploy has no fallback.
restore_release() {
    local previous=$1
    if [[ -n $previous ]]; then
        activate_release "$previous" && systemctl restart foothold-server
    else
        rm -f /opt/foothold/current
        systemctl stop foothold-server
    fi
}

# An auto parent keeps fd 9 across prepare + deploy; manual callers take it here.
take_deploy_lock() {
    local lock=${1:-/var/lib/foothold/deploy.lock}
    if [[ ${FH_DEPLOY_LOCK_HELD:-} == 1 && /proc/self/fd/9 -ef $lock ]]; then
        flock -n 9
    else
        exec 9>"$lock"
        flock -n 9
    fi
}

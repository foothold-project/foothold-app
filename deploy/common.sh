#!/usr/bin/env bash
# Shared only by trusted, root-owned deployment scripts.
valid_sha() { [[ ${1:-} =~ ^[0-9a-f]{40}$ ]]; }
valid_site() { [[ ${1:-} =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ && $1 == *.* && $1 != *..* ]]; }
needs_rollback() { (( $1 != 0 && $2 == 1 )); }
activate_release() {
    local target=$1
    ln -s "$target" /opt/foothold/current.next &&
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

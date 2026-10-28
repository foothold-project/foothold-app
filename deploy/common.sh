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
        sim_manager_stop && activate_release "$previous" && systemctl restart foothold-server && sim_manager_start
    else
        sim_manager_stop && rm -f /opt/foothold/current && systemctl stop foothold-server
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

# Only GitHub repository URLs without credentials, queries, ports or shell syntax.
repo_transport() {
    if [[ ${1:-} =~ ^https://github\.com/[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*\.git$ ]]; then
        printf 'https\n'
    elif [[ ${1:-} =~ ^git@github\.com:[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*\.git$ ]]; then
        printf 'ssh\n'
    else
        return 1
    fi
}

configure_repo_transport() {
    local repo=$1 transport=$2 result
    if [[ $transport == https ]]; then
        if git --git-dir="$repo" config --unset-all core.sshCommand; then :; else
            result=$?
            [[ $result == 5 ]] || return "$result"
        fi
        # Public pulls must not obtain credentials from a global helper.
        git --git-dir="$repo" config credential.helper ''
    elif [[ $transport == ssh ]]; then
        git --git-dir="$repo" config core.sshCommand 'ssh -i /etc/foothold/deploy_ed25519 -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/etc/foothold/github_known_hosts -o ConnectTimeout=15'
    else
        return 2
    fi
}

# Server sim installation provisions this directory before enabling a manager.
# Hold fd 8 until deploy/rollback exits, including failure rollback. The manager
# holds a shared lock from pre-creation through full cleanup of each session.
take_sim_deploy_guard() {
    local target=$1 guard=${2:-/var/lib/foothold-sim/guard}
    [[ -e $guard || -L $guard ]] || return 0
    [[ -d $guard/state && ! -L $guard/state && -d $guard && ! -L $guard && -f $guard/deploy.lock && ! -L $guard/deploy.lock ]] || return 1
    if [[ ${FH_SIM_DEPLOY_LOCK_HELD:-} == 1 && /proc/self/fd/8 -ef $guard/deploy.lock ]]; then
        flock -xn 8 || return 1
    else
        exec 8<>"$guard/deploy.lock" || return 1
        flock -xn 8 || return 1
    fi
    export FH_SIM_DEPLOY_LOCK_HELD=1
    [[ ! -e $guard/state/unproven && ! -L $guard/state/unproven ]] || return 1
    valid_sha "$target"
}

# Runs under the held exclusive guard; idle admission is fenced until completion.
sim_manager_stop() {
    [[ -d /var/lib/foothold-sim/guard ]] || return 0
    python3 "$(dirname -- "${BASH_SOURCE[0]}")/sim_control.py" stop
}
sim_manager_start() {
    [[ -d /var/lib/foothold-sim/guard ]] || return 0
    python3 "$(dirname -- "${BASH_SOURCE[0]}")/sim_control.py" start
}

#!/usr/bin/env bash
set +x
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"

# Arguments are internal test seams; the installed entry point uses fixed paths.
autodeploy_run() (
    local state=$1 current=$2 off=$3 scripts=$4 remote sha deployed='' handed_off=0
    [[ ! -e $off ]] || { echo 'auto: disabled by off file'; exit 0; }
    take_deploy_lock "$state/deploy.lock" || { echo 'auto: busy; skipped'; exit 0; }
    export FH_DEPLOY_LOCK_HELD=1 FH_DEPLOY_MODE=auto FH_BUILD_USER=foothold-build
    export GIT_TERMINAL_PROMPT=0
    if ! remote=$(git --git-dir="$state/repo.git" ls-remote --exit-code origin refs/heads/dev 2>/dev/null); then
        echo 'auto: ls-remote failed; deployment state unchanged'; exit 0
    fi
    read -r sha ref <<< "$remote"
    if ! valid_sha "$sha" || [[ $ref != refs/heads/dev || $remote == *$'\n'* ]]; then
        echo 'auto: invalid remote response; deployment state unchanged'; exit 0
    fi
    [[ ! -f $current/COMMIT ]] || read -r deployed < "$current/COMMIT"
    [[ $sha != "$deployed" ]] || { echo "auto: current $sha; skipped"; exit 0; }
    if [[ -f $state/autodeploy.failed && $(cat "$state/autodeploy.failed") == "$sha" ]]; then
        echo "auto: failed $sha; skipped until a new commit"; exit 0
    fi
    if ! take_sim_deploy_guard "$sha" "$state/../foothold-sim/guard"; then
        echo 'auto: sim session active or cleanup unproven; skipped'; exit 0
    fi
    # Network/fetch failures are transient; do not poison this deployment SHA.
    if ! git --git-dir="$state/repo.git" fetch --no-tags origin "$sha" >/dev/null 2>&1; then
        echo 'auto: fetch failed; deployment state unchanged'; exit 0
    fi
    if ! resolved=$(git --git-dir="$state/repo.git" rev-parse --verify "$sha^{commit}" 2>/dev/null) || [[ $resolved != "$sha" ]]; then
        echo 'auto: fetched commit unavailable; deployment state unchanged'; exit 0
    fi
    finish_auto() {
        local result=$?
        trap - EXIT
        if (( result != 0 )); then
            printf '%s\n' "$sha" > "$state/autodeploy.failed.next"
            mv -f "$state/autodeploy.failed.next" "$state/autodeploy.failed"
            if (( handed_off == 0 )); then
                printf '%s commit=%s exit=%s mode=auto phase=prepare\n' "$(date -u +%FT%TZ)" "$sha" "$result" >> "$state/deploys.log"
            fi
            echo "auto: failed $sha; see journal and deploys.log"
        fi
        exit "$result"
    }
    trap finish_auto EXIT
    (cd "$state/repo.git" && bash "$scripts/prepare-release.sh" "$sha" "$state/incoming")
    handed_off=1
    bash "$scripts/deploy.sh" "$sha"
    echo "auto: deployed $sha"
)

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
    [[ $EUID == 0 && $# == 0 ]] || { echo 'Usage (server root): autodeploy.sh' >&2; exit 2; }
    autodeploy_run /var/lib/foothold /opt/foothold/current \
        /etc/foothold/autodeploy.off "$(cd -- "$(dirname -- "$0")" && pwd)"
fi

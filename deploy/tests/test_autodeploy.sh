#!/usr/bin/env bash
# Real temporary files/flock, fake Git and deployment; no server or network.
set -euo pipefail
scripts=$(cd -- "$(dirname -- "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
export TEST_STATE="$work/state" TEST_CURRENT="$work/current" TEST_OFF="$work/off" TEST_SCRIPTS="$work/tools" TEST_TRACE="$work/trace" SOURCE_SCRIPTS="$scripts"
mkdir -p "$TEST_STATE/repo.git" "$TEST_STATE/incoming" "$TEST_CURRENT" "$TEST_SCRIPTS"
export TEST_SHA=1111111111111111111111111111111111111111 TEST_REMOTE_FAIL=0 TEST_PREP_FAIL=0 TEST_DEPLOY_FAIL=0 TEST_FETCH_FAIL=0
cat > "$work/run" <<'RUN'
#!/usr/bin/env bash
source "$SOURCE_SCRIPTS/autodeploy.sh"
git() {
    case " $* " in
        *' ls-remote '*)
            [[ $TEST_REMOTE_FAIL == 0 ]] || return 1
            printf '%s\trefs/heads/dev\n' "$TEST_SHA" ;;
        *' fetch '*) echo fetch >> "$TEST_TRACE"; return "$TEST_FETCH_FAIL" ;;
        *' rev-parse '*) echo "$TEST_SHA" ;;
        *) exit 99 ;;
    esac
}
autodeploy_run "$TEST_STATE" "$TEST_CURRENT" "$TEST_OFF" "$TEST_SCRIPTS"
RUN
cat > "$TEST_SCRIPTS/prepare-release.sh" <<'PREP'
#!/usr/bin/env bash
[[ $1 == "$TEST_SHA" && $2 == "$TEST_STATE/incoming" ]] || exit 99
echo prepare >> "$TEST_TRACE"
exit "$TEST_PREP_FAIL"
PREP
cat > "$TEST_SCRIPTS/deploy.sh" <<'DEPLOY'
#!/usr/bin/env bash
set -euo pipefail
source "$SOURCE_SCRIPTS/common.sh"
take_deploy_lock "$TEST_STATE/deploy.lock"
[[ $FH_DEPLOY_MODE == auto && $FH_BUILD_USER == foothold-build ]] || exit 99
echo deploy >> "$TEST_TRACE"
exit "$TEST_DEPLOY_FAIL"
DEPLOY
run() { bash "$work/run" > "$work/output"; }
empty_trace() { [[ ! -s $TEST_TRACE ]]; }
printf '%s\n' "$TEST_SHA" > "$TEST_CURRENT/COMMIT"
run; empty_trace # already current
rm "$TEST_CURRENT/COMMIT"
printf '%s\n' "$TEST_SHA" > "$TEST_STATE/autodeploy.failed"
run; empty_trace # failed target never retried
rm "$TEST_STATE/autodeploy.failed"
touch "$TEST_OFF"
run; empty_trace
rm "$TEST_OFF"
printf 'unchanged\n' > "$TEST_STATE/autodeploy.failed"
export TEST_REMOTE_FAIL=1
run; empty_trace
[[ $(cat "$TEST_STATE/autodeploy.failed") == unchanged && ! -e $TEST_STATE/deploys.log ]]
export TEST_REMOTE_FAIL=0
exec 8>"$TEST_STATE/deploy.lock"
flock -n 8
run; empty_trace
flock -u 8
run
[[ $(cat "$TEST_TRACE") == $'fetch\nprepare\ndeploy' ]] # lock inherited without deadlock
: > "$TEST_TRACE"
export TEST_PREP_FAIL=1
if run; then echo 'Expected prepare failure' >&2; exit 1; fi
[[ $(cat "$TEST_STATE/autodeploy.failed") == "$TEST_SHA" ]]
[[ $(cat "$TEST_TRACE") == $'fetch\nprepare' ]]
rg -q 'mode=auto phase=prepare' "$TEST_STATE/deploys.log"
: > "$TEST_TRACE"
run; empty_trace
export TEST_SHA=2222222222222222222222222222222222222222 TEST_PREP_FAIL=0 TEST_DEPLOY_FAIL=1
if run; then echo 'Expected deploy failure' >&2; exit 1; fi
[[ $(cat "$TEST_STATE/autodeploy.failed") == "$TEST_SHA" ]]
: > "$TEST_TRACE"
run; empty_trace
export TEST_SHA=3333333333333333333333333333333333333333 TEST_DEPLOY_FAIL=0 TEST_FETCH_FAIL=1
if run; then echo 'Expected fetch failure' >&2; exit 1; fi
[[ $(cat "$TEST_STATE/autodeploy.failed") == "$TEST_SHA" ]]
printf 'PASS: current, failed SHA, off, network no-change, lock, inherited lock, new SHA, prepare/deploy/fetch failures\n'

#!/usr/bin/env bash
set +x
set -euo pipefail
[[ $EUID == 0 && $# == 1 ]] || { echo 'Usage (server root): deploy.sh <full-commit-sha>' >&2; exit 2; }
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
source ./common.sh
valid_sha "$1" || { echo 'A full lowercase commit SHA is required.' >&2; exit 2; }
sha=$1
mode=manual
[[ ${FH_DEPLOY_MODE:-} != auto ]] || mode=auto
take_deploy_lock || { echo 'Another deploy/rollback is running.' >&2; exit 1; }
take_sim_deploy_guard "$1" || { echo 'Sim deployment fence refused: active session or cleanup unproven.' >&2; exit 1; }
previous=''
if [[ -L /opt/foothold/current ]]; then previous=$(readlink -f /opt/foothold/current); fi
switched=0
sim_stopped=0
caddy_prepared=0
finish() {
    local result=$? rollback=not-needed caddy_recovery=not-needed
    trap - EXIT
    if needs_rollback "$result" "$switched"; then
        if restore_release "$previous"; then rollback=restored; else rollback=FAILED; fi
    elif (( result != 0 && sim_stopped == 1 )); then
        if sim_manager_start; then rollback=restored-idle-manager; else rollback=FAILED; fi
    fi
    if (( result != 0 && caddy_prepared == 1 )); then
        if python3 "$FH_DEPLOY_TOOLS_DIR/caddy_sync.py" rollback; then
            caddy_recovery=restored
        else
            caddy_recovery=FAILED
            echo 'Caddy configuration recovery FAILED; root recovery required.' >&2
        fi
    fi
    if [[ $caddy_recovery == FAILED ]]; then rollback=FAILED; fi
    printf '%s commit=%s previous=%s exit=%s rollback=%s mode=%s\n' "$(date -u +%FT%TZ)" "$sha" "${previous##*/}" "$result" "$rollback" "$mode" >> /var/lib/foothold/deploys.log
    exit "$result"
}
trap finish EXIT
release=/opt/foothold/releases/$sha
archive=/var/lib/foothold/incoming/$sha.tar.gz
[[ ! -e $release && ! -L $release ]] || { echo 'Release exists; use rollback.sh or audit/remove a failed preparation privately.' >&2; exit 1; }
read -r checksum filename < "$archive.sha256"
[[ $checksum =~ ^[0-9a-f]{64}$ && $filename == "$sha.tar.gz" ]] || exit 2
[[ $(sha256sum "$archive" | cut -d' ' -f1) == "$checksum" ]] || { echo 'Artifact checksum mismatch.' >&2; exit 1; }
install -d -m 755 "$release"
tar -xzf "$archive" -C "$release" --no-same-owner --no-same-permissions
[[ $(cat "$release/COMMIT") == "$sha" && -s $release/apps/web/dist/index.html ]] || exit 1
# Release code and venv stay root-owned; the runtime account cannot mutate them.
python3.12 -m venv "$release/.venv"
"$release/.venv/bin/python" -m pip install --disable-pip-version-check -r "$release/apps/server/requirements.txt"
chown -R root:root "$release"
chmod -R u=rwX,go=rX "$release"
if [[ -d /var/lib/foothold-sim/guard ]]; then
    # Only these evidence leaves are writable; code and venv remain root-owned.
    install -d -o foothold-sim -g foothold-sim -m 700 "$release/runs/server-sim" "$release/tmp/p1c/startup"
fi
cd "$release"
"$release/.venv/bin/python" -m deploy.database
"$release/.venv/bin/python" -m deploy.site
set -a
source /etc/foothold/site.env
set +a
valid_site "$FH_SITE" || exit 2
python3 "$FH_DEPLOY_TOOLS_DIR/caddy_sync.py" prepare "$release/deploy/Caddyfile"
caddy_prepared=1
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sim_manager_stop
sim_stopped=1
activate_release "$release"
switched=1
systemctl restart foothold-server
sim_manager_start
# reload reads site.env again; on the first deployment Caddy may not be running.
if systemctl is-active --quiet caddy; then systemctl reload caddy; else systemctl start caddy; fi
"$release/.venv/bin/python" -m deploy.smoke
python3 "$FH_DEPLOY_TOOLS_DIR/caddy_sync.py" commit
printf 'Deployment checks passed for %s\n' "$sha"

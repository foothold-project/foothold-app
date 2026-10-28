#!/usr/bin/env bash
set +x
set -euo pipefail
[[ $EUID == 0 && $# == 1 ]] || { echo 'Usage (server root): deploy.sh <full-commit-sha>' >&2; exit 2; }
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
source ./common.sh
valid_sha "$1" || { echo 'A full lowercase commit SHA is required.' >&2; exit 2; }
sha=$1
exec 9>/var/lib/foothold/deploy.lock
flock -n 9 || { echo 'Another deploy/rollback is running.' >&2; exit 1; }
previous=''
if [[ -L /opt/foothold/current ]]; then previous=$(readlink -f /opt/foothold/current); fi
release=/opt/foothold/releases/$sha
archive=/var/lib/foothold/incoming/$sha.tar.gz
[[ ! -e $release && ! -L $release ]] || { echo 'Release exists; use rollback.sh or audit/remove a failed preparation privately.' >&2; exit 1; }
read -r checksum filename < "$archive.sha256"
[[ $checksum =~ ^[0-9a-f]{64}$ && $filename == "$sha.tar.gz" ]] || exit 2
[[ $(sha256sum "$archive" | cut -d' ' -f1) == "$checksum" ]] || { echo 'Artifact checksum mismatch.' >&2; exit 1; }
switched=0
finish() {
    local result=$? rollback=not-needed
    trap - EXIT
    if needs_rollback "$result" "$switched"; then
        if restore_release "$previous"; then rollback=restored; else rollback=FAILED; fi
    fi
    printf '%s commit=%s previous=%s exit=%s rollback=%s\n' "$(date -u +%FT%TZ)" "$sha" "${previous##*/}" "$result" "$rollback" >> /var/lib/foothold/deploys.log
    exit "$result"
}
trap finish EXIT
install -d -m 755 "$release"
tar -xzf "$archive" -C "$release" --no-same-owner --no-same-permissions
[[ $(cat "$release/COMMIT") == "$sha" && -s $release/apps/web/dist/index.html ]] || exit 1
# Release code and venv stay root-owned; the runtime account cannot mutate them.
python3.12 -m venv "$release/.venv"
"$release/.venv/bin/python" -m pip install --disable-pip-version-check -r "$release/apps/server/requirements.txt"
chown -R root:root "$release"
chmod -R u=rwX,go=rX "$release"
cd "$release"
"$release/.venv/bin/python" -m deploy.database
"$release/.venv/bin/python" -m deploy.site
set -a
source /etc/foothold/site.env
set +a
valid_site "$FH_SITE" || exit 2
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
activate_release "$release"
switched=1
systemctl restart foothold-server
# reload reads site.env again; on the first deployment Caddy may not be running.
if systemctl is-active --quiet caddy; then systemctl reload caddy; else systemctl start caddy; fi
"$release/.venv/bin/python" -m deploy.smoke
printf 'Deployment checks passed for %s\n' "$sha"

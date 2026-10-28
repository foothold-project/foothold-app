#!/usr/bin/env bash
set +x
set -euo pipefail
[[ $EUID == 0 ]] || { echo 'Run on the new server as root.' >&2; exit 1; }
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
source ./common.sh
. /etc/os-release
[[ $ID == ubuntu && $VERSION_ID == 24.04 ]] || { echo 'Ubuntu 24.04 required.' >&2; exit 1; }
: "${CADDY_VERSION:?Select the exact official package version first}"
# Existing state is retained on rerun; never rotate passwords implicitly.
if [[ ! -f /etc/foothold/server.env ]]; then
    : "${FH_SITE:?}" "${FH_ORG_NAME:?}" "${FH_BOOTSTRAP_USERNAME:?}" "${FH_BOOTSTRAP_DISPLAY_NAME:?}"
    valid_site "$FH_SITE" || exit 2
fi
export FH_SITE FH_ORG_NAME FH_BOOTSTRAP_USERNAME FH_BOOTSTRAP_DISPLAY_NAME
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y python3.12-venv postgresql-16 postgresql-client-16 curl gnupg ca-certificates ufw rsync debian-keyring debian-archive-keyring apt-transport-https
if [[ ! -s /usr/share/keyrings/caddy-stable-archive-keyring.gpg ]]; then
    curl -1fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
fi
curl -1fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt -o /etc/apt/sources.list.d/caddy-stable.list
chmod 644 /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
apt-get update
apt-get install -y "caddy=$CADDY_VERSION"
apt-mark hold caddy
getent passwd foothold >/dev/null || useradd --system --home-dir /var/lib/foothold --shell /usr/sbin/nologin foothold
[[ $(getent passwd foothold | cut -d: -f7) == /usr/sbin/nologin ]] || { echo 'Existing service account must have nologin shell.' >&2; exit 1; }
install -d -m 755 /opt/foothold /opt/foothold/releases /var/lib/foothold
install -d -m 700 /etc/foothold /var/lib/foothold/incoming
install -d -o foothold -g foothold -m 700 /var/lib/foothold/files
# Dedicated new-server cluster: no remote TCP listeners, including IPv6.
install -d /etc/postgresql/16/main/conf.d
printf "listen_addresses = '127.0.0.1'\npassword_encryption = 'scram-sha-256'\n" > /etc/postgresql/16/main/conf.d/foothold.conf
systemctl restart postgresql@16-main
python3 ./bootstrap-state.py
install -m 644 foothold-server.service /etc/systemd/system/foothold-server.service
install -m 644 Caddyfile /etc/caddy/Caddyfile
install -d /etc/systemd/system/caddy.service.d
install -m 644 caddy-foothold.conf /etc/systemd/system/caddy.service.d/foothold.conf
systemctl daemon-reload
systemctl enable foothold-server caddy
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
# No API start until the first release is migrated. No optional cron is installed.
printf 'Bootstrap complete; credentials were saved privately, never printed.\n'

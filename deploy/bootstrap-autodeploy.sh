#!/usr/bin/env bash
# Optional existing-server step; no PostgreSQL/API/Caddy restart or timer start.
set +x
set -euo pipefail
[[ $EUID == 0 ]] || exit 2
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
[[ -x /opt/foothold/current/.venv/bin/python ]] || { echo 'Deploy the reviewed release manually first.' >&2; exit 2; }
take_deploy_lock || { echo 'A deploy/rollback is running.' >&2; exit 1; }
. /etc/os-release
[[ $ID == ubuntu && $VERSION_ID == 24.04 ]] || exit 2
: "${NODE_VERSION:?Choose an exact NodeSource 24 LTS apt version}"
FH_REPO_URL=${FH_REPO_URL:-${FH_REPO_SSH_URL:-}}
: "${FH_REPO_URL:?Supply the GitHub repository URL}"
transport=$(repo_transport "$FH_REPO_URL") || { echo 'Only strict GitHub HTTPS or SSH repository URLs are accepted.' >&2; exit 2; }
[[ $NODE_VERSION == 24.* && $NODE_VERSION != *[[:space:]]* ]] || exit 2
if [[ $transport == ssh ]]; then
    [[ -s /etc/foothold/github_known_hosts ]] || { echo 'Install verified GitHub SSH host keys first (README).'; exit 2; }
fi
export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=l
apt-get update
packages=(curl gnupg ca-certificates git util-linux)
[[ $transport != ssh ]] || packages+=(openssh-client)
apt-get install --no-upgrade -y "${packages[@]}"
install -d -m 755 /usr/share/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/foothold-nodesource.gpg
chmod 644 /usr/share/keyrings/foothold-nodesource.gpg
printf 'deb [signed-by=/usr/share/keyrings/foothold-nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main\n' > /etc/apt/sources.list.d/foothold-nodesource.list
apt-get update
apt-mark unhold nodejs >/dev/null 2>&1 || true
apt-get install -y "nodejs=$NODE_VERSION"
apt-mark hold nodejs
getent passwd foothold-build >/dev/null || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin foothold-build
[[ $(getent passwd foothold-build | cut -d: -f7) == /usr/sbin/nologin && $(id -u foothold-build) != 0 && $(id -Gn foothold-build) == foothold-build ]] || { echo 'Audit build account privileges.' >&2; exit 2; }
install -d -m 700 /etc/foothold /var/lib/foothold/incoming
if [[ $transport == ssh ]]; then
    if [[ ! -e /etc/foothold/deploy_ed25519 ]]; then
        umask 077
        ssh-keygen -q -t ed25519 -N '' -C foothold-dev-pull -f /etc/foothold/deploy_ed25519
    fi
    chown root:root /etc/foothold/deploy_ed25519 /etc/foothold/github_known_hosts
    chmod 600 /etc/foothold/deploy_ed25519 /etc/foothold/github_known_hosts
fi
if [[ ! -d /var/lib/foothold/repo.git ]]; then
    git init --bare /var/lib/foothold/repo.git >/dev/null
    git --git-dir=/var/lib/foothold/repo.git remote add origin "$FH_REPO_URL"
fi
[[ $(git --git-dir=/var/lib/foothold/repo.git remote get-url origin) == "$FH_REPO_URL" ]] || { echo 'Mirror origin mismatch.' >&2; exit 2; }
configure_repo_transport /var/lib/foothold/repo.git "$transport"
# Public HTTPS needs no key; SSH still requires human deploy-key registration.
install -d -m 755 /opt/foothold/deploy-tools
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
for script in common.sh autodeploy.sh prepare-release.sh deploy.sh rollback.sh; do
    install -o root -g root -m 644 "$script" /opt/foothold/deploy-tools/"$script"
done
install -o root -g root -m 644 foothold-autodeploy.service foothold-autodeploy.timer /etc/systemd/system/
# Provision the new check account using the already-deployed, reviewed source.
(cd /opt/foothold/current && .venv/bin/python -m deploy.smoke_account)
systemctl daemon-reload
printf 'Autodeploy installed, timer not enabled; verify repository access before enabling.\n'

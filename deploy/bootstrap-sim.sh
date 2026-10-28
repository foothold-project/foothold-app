#!/usr/bin/env bash
# Dedicated simulation identity/units only; no apt, GPU, API or simulator start.
set +x
set -euo pipefail
[[ $EUID == 0 && $# == 1 && ( $1 == --prepare || $1 == --activate ) ]] || { echo 'Usage: server root bootstrap-sim.sh --prepare|--activate' >&2; exit 2; }
mode=$1
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
source ./common.sh
take_deploy_lock || exit 1
take_sim_deploy_guard "$(cat /opt/foothold/current/COMMIT)" || { echo 'Active or unproven simulation; setup refused.' >&2; exit 1; }
. /etc/os-release
[[ $ID == ubuntu && $VERSION_ID == 24.04 && $(dpkg --print-architecture) == amd64 ]] || exit 2
# The installed tools must already contain the reviewed gate, not just release code.
for script in common.sh autodeploy.sh deploy.sh rollback.sh prepare-release.sh sim_control.py; do
    cmp -s "$script" "/opt/foothold/deploy-tools/$script" || { echo 'Install reviewed deployment tools first.' >&2; exit 2; }
done
getent passwd foothold-sim >/dev/null || useradd --system --no-create-home --home-dir /var/lib/foothold-sim --shell /usr/sbin/nologin foothold-sim
[[ $(getent passwd foothold-sim | cut -d: -f7) == /usr/sbin/nologin && $(getent passwd foothold-sim | cut -d: -f6) == /var/lib/foothold-sim && $(id -gn foothold-sim) == foothold-sim && $(id -u foothold-sim) != 0 ]] || exit 2
# Existing unexpected privileges are never silently removed or accepted.
for group in $(id -Gn foothold-sim); do
    [[ $group == foothold-sim || $group == render || $group == video ]] || { echo 'Audit simulation account groups.' >&2; exit 2; }
done
for group in render video; do
    getent group "$group" >/dev/null || { echo 'Required existing render/video group missing.' >&2; exit 2; }
    usermod -a -G "$group" foothold-sim
done
install -d -o root -g foothold-sim -m 750 /var/lib/foothold-sim /etc/foothold-sim /opt/foothold-sim
install -d -o foothold-sim -g foothold-sim -m 700 /var/lib/foothold-sim/replay
install -d -o foothold -g foothold -m 700 /var/lib/foothold/sim-credentials
install -d -o root -g root -m 755 /var/lib/foothold-sim/.config/systemd/user
install -o root -g root -m 644 foothold-simmgr.service foothold-sim.slice /var/lib/foothold-sim/.config/systemd/user/
release=$(readlink -f /opt/foothold/current)
[[ $release == /opt/foothold/releases/* && -s $release/apps/simmgr/__main__.py ]] || exit 2
install -d -o foothold-sim -g foothold-sim -m 700 "$release/runs/server-sim" "$release/tmp/p1c/startup"
loginctl enable-linger foothold-sim
uid=$(id -u foothold-sim)
[[ $uid =~ ^[1-9][0-9]*$ ]] || exit 2
install -d -o root -g root -m 755 "/etc/systemd/system/user-$uid.slice.d"
install -o root -g root -m 644 foothold-sim-user-slice.conf "/etc/systemd/system/user-$uid.slice.d/foothold-sim.conf"
install -o root -g root -m 644 foothold-sim-proof.socket foothold-sim-proof@.service /etc/systemd/system/
install -o root -g root -m 644 proc_proof_server.py /opt/foothold/deploy-tools/proc_proof_server.py
systemctl daemon-reload
systemctl enable --now foothold-sim-proof.socket
# The parent system slice bounds even a modified/escaped user-manager slice.
systemctl set-property --runtime "user-$uid.slice" MemoryMax=4G MemorySwapMax=0 CPUQuota=400% TasksMax=640
systemctl start "user@$uid.service"
runuser -u foothold-sim -- env -i PATH=/usr/bin:/bin XDG_RUNTIME_DIR="/run/user/$uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" systemctl --user daemon-reload
if [[ $mode == --prepare ]]; then
    printf 'Simulation identity and user units prepared; guard and manager not activated.\n'
    exit 0
fi
# First activation follows package/asset/EGL/private-config/map/helper review.
[[ -s /etc/foothold-sim/manager.env && -s /etc/foothold-sim/packages.lock.json && -S /run/foothold-sim-proof.sock ]] || { echo 'Private configuration, package lock and proof socket required.' >&2; exit 2; }
sha=$(cat /opt/foothold/current/COMMIT)
if [[ -e /var/lib/foothold-sim/guard || -L /var/lib/foothold-sim/guard ]]; then
    take_sim_deploy_guard "$sha" || exit 1
else
    # Acquire the inode before publishing the guard directory; no admission gap.
    stage=$(mktemp -d /var/lib/foothold-sim/.guard-XXXXXXXX)
    chmod 755 "$stage"
    install -d -o foothold-sim -g foothold-sim -m 700 "$stage/state"
    (umask 007; : > "$stage/deploy.lock")
    chown root:foothold-sim "$stage/deploy.lock"
    chmod 660 "$stage/deploy.lock"
    exec 8<>"$stage/deploy.lock"
    flock -xn 8
    mv -T "$stage" /var/lib/foothold-sim/guard
    export FH_SIM_DEPLOY_LOCK_HELD=1
fi
if ! python3 ./sim_control.py start; then
    # No episode could start under the exclusive lock; still retain failed setup.
    python3 ./mark_sim_failure.py
    echo 'Manager activation failed; deployment fenced pending manual audit.' >&2
    exit 1
fi
printf 'Same-release idle manager ready; no simulation session started.\n'

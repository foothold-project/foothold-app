#!/usr/bin/env bash
# Real temporary Git config only; no network, keys or system mutations.
set -euo pipefail
source "$(dirname "$0")/../common.sh"
[[ $(repo_transport https://github.com/example/project.git) == https ]]
[[ $(repo_transport git@github.com:example/project.git) == ssh ]]
for bad in 'https://token@github.com/example/project.git' \
 'https://github.com.evil/example/project.git' 'http://github.com/example/project.git' \
 'https://github.com:443/example/project.git' 'https://github.com/example/project.git?token=x' \
 'https://github.com/example/project.git#fragment' 'https://github.com/../project.git' \
 'https://github.com/example/../project.git' 'git@github.com:example/project.git;id' \
 'ssh://git@github.com/example/project.git' '/tmp/repo.git'; do
    if repo_transport "$bad"; then echo 'Unsafe repository URL accepted' >&2; exit 1; fi
done
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
git init -q --bare "$work/repo.git"
configure_repo_transport "$work/repo.git" https # No SSH configuration/key required.
[[ $(git --git-dir="$work/repo.git" config credential.helper) == '' ]]
configure_repo_transport "$work/repo.git" ssh
[[ $(git --git-dir="$work/repo.git" config core.sshCommand) == *StrictHostKeyChecking=yes* ]]
configure_repo_transport "$work/repo.git" https # Clear a previous SSH transport.
if git --git-dir="$work/repo.git" config --get core.sshCommand; then exit 1; fi
printf 'PASS: strict HTTPS/SSH URLs, unsafe URL rejection, HTTPS without SSH state, SSH-to-HTTPS cleanup\n'

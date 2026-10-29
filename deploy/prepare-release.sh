#!/usr/bin/env bash
set +x
set -euo pipefail
[[ $# == 2 ]] || { echo 'Usage: prepare-release.sh <commit> <output-directory>' >&2; exit 2; }
repo=$(git rev-parse --absolute-git-dir)
sha=$(git rev-parse --verify "$1^{commit}")
out=$(realpath "$2")
[[ -d $out ]] || exit 2
work=$(mktemp -d)
build='' build_unit=''
cleanup() {
    # On interruption also stop the independent build cgroup before deleting input.
    if [[ -n $build_unit ]]; then systemctl stop "$build_unit" >/dev/null 2>&1 || true; fi
    rm -rf -- "$work"
    [[ -z $build ]] || rm -rf -- "$build"
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
if [[ $EUID == 0 ]]; then
    [[ ${FH_BUILD_USER:-} == foothold-build ]] || { echo 'Root builds require FH_BUILD_USER=foothold-build.' >&2; exit 2; }
    # Outside /tmp so PrivateTmp can isolate the service without hiding its input.
    build=$(mktemp -d /var/lib/foothold/build.XXXXXXXX)
else
    build=$(mktemp -d)
fi
# Only web and its imported data enter the build sandbox; never server/deploy.
git --git-dir="$repo" archive "$sha" apps/contracts apps/web \
  mobile/sim/maps.json 'mobile/sim/assets/*/top.png' 'mobile/sim/assets/*/top.json' | tar -x -C "$build"
# Validate the actual archived input, including empty globs and orphan metadata.
shopt -s nullglob
top_images=("$build"/mobile/sim/assets/*/top.png)
top_metadata=("$build"/mobile/sim/assets/*/top.json)
[[ ${#top_images[@]} -gt 0 && ${#top_images[@]} == ${#top_metadata[@]} ]] || {
    echo 'Top-view input requires matching nonempty PNG/JSON pairs.' >&2; exit 1;
}
for top_image in "${top_images[@]}"; do
    [[ -f ${top_image%.png}.json ]] || {
        echo 'Top-view PNG is missing adjacent JSON metadata.' >&2; exit 1;
    }
done
shopt -u nullglob
if [[ $EUID == 0 ]]; then
    chmod 755 "$build"
    chmod -R u=rwX,go=rX "$build"
    chown -R foothold-build:foothold-build "$build/apps/web"
    build_unit="foothold-web-build-$$"
    # --wait finishes after unit shutdown; KillMode kills lingering descendants.
    # Inputs outside web stay root-owned/read-only. No deploy lock fd reaches npm.
    systemd-run --quiet --wait --collect --pipe --unit="$build_unit" \
        --property=Type=exec --property=User=foothold-build --property=Group=foothold-build \
        --property=KillMode=control-group --property=TimeoutStopSec=15s \
        --property=RuntimeMaxSec=20min --property=NoNewPrivileges=yes \
        --property=ProtectSystem=strict --property=ProtectHome=yes --property=PrivateTmp=yes \
        --property="ReadWritePaths=$build/apps/web" \
        /usr/bin/env -i PATH=/usr/bin:/bin HOME="$build/apps/web" \
        /usr/bin/bash -c 'cd "$1/apps/web" && npm ci --ignore-scripts && npm run build' bash "$build" 9>&- 8>&-
else
    (cd "$build/apps/web" && npm ci --ignore-scripts && npm run build) 8>&- 9>&-
fi
# Root constructs trusted code afresh only after all sandbox processes have exited.
git --git-dir="$repo" archive "$sha" apps/server apps/contracts apps/simmgr apps/agent deploy | tar -x -C "$work"
# Reject replaced parent paths and all symlinks/special files before privileged copy.
for directory in "$build/apps" "$build/apps/web" "$build/apps/web/dist"; do
    [[ -d $directory && ! -L $directory ]] || { echo 'Invalid web build directory.' >&2; exit 1; }
done
[[ -z $(find "$build/apps/web/dist" ! -type d ! -type f -print -quit) ]] || { echo 'Web dist contains a link or special file.' >&2; exit 1; }
[[ -s $build/apps/web/dist/index.html ]] || exit 1
# The release directory is root-owned and never inside the writable build tree.
mkdir -p "$work/release/apps/web"
cp -a "$work/apps/server" "$work/apps/contracts" "$work/apps/simmgr" "$work/apps/agent" "$work/release/apps/"
rm -rf "$work/release/apps/server/tests" "$work/release/apps/server/tools" "$work/release/apps/contracts/tests"
cp -a "$build/apps/web/dist" "$work/release/apps/web/"
cp -a "$work/deploy" "$work/release/"
printf '%s\n' "$sha" > "$work/release/COMMIT"
tar -czf "$out/$sha.tar.gz" -C "$work/release" .
(cd "$out" && sha256sum "$sha.tar.gz" > "$sha.tar.gz.sha256")
printf 'Prepared %s\n' "$sha"

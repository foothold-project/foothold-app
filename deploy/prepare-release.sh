#!/usr/bin/env bash
set +x
set -euo pipefail
[[ $# == 2 ]] || { echo 'Usage: prepare-release.sh <commit> <output-directory>' >&2; exit 2; }
repo=$(git rev-parse --absolute-git-dir)
sha=$(git rev-parse --verify "$1^{commit}")
out=$(realpath "$2")
[[ -d $out ]] || exit 2
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
# Keep the web's out-of-app imports, without archiving the simulator runtime.
git --git-dir="$repo" archive "$sha" apps/server apps/contracts apps/web deploy \
  mobile/sim/maps.json 'mobile/sim/assets/*/top.png' | tar -x -C "$work"
# No .env or working-tree files enter this clean build.
if [[ $EUID == 0 ]]; then
    # Root never runs npm or candidate-controlled package scripts.
    [[ ${FH_BUILD_USER:-} == foothold-build ]] || { echo 'Root builds require FH_BUILD_USER=foothold-build.' >&2; exit 2; }
    chown -R foothold-build:foothold-build "$work"
    # Do not let candidate build scripts retain or unlock the parent lock fd.
    runuser -u foothold-build -- env -i PATH=/usr/bin:/bin HOME="$work" \
        bash -c 'cd "$1/apps/web" && npm ci --ignore-scripts && npm run build' bash "$work" 9>&-
else
    (cd "$work/apps/web" && npm ci --ignore-scripts && npm run build)
fi
# Manager, agent, tests, web build tooling and node_modules are not shipped.
mkdir -p "$work/release/apps/web"
cp -a "$work/apps/server" "$work/apps/contracts" "$work/release/apps/"
rm -rf "$work/release/apps/server/tests" "$work/release/apps/server/tools" "$work/release/apps/contracts/tests"
cp -a "$work/apps/web/dist" "$work/release/apps/web/"
cp -a "$work/deploy" "$work/release/"
printf '%s\n' "$sha" > "$work/release/COMMIT"
tar -czf "$out/$sha.tar.gz" -C "$work/release" .
(cd "$out" && sha256sum "$sha.tar.gz" > "$sha.tar.gz.sha256")
printf 'Prepared %s\n' "$sha"

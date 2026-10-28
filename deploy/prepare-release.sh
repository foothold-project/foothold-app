#!/usr/bin/env bash
set +x
set -euo pipefail
[[ $# == 2 ]] || { echo 'Usage: prepare-release.sh <commit> <output-directory>' >&2; exit 2; }
repo=$(git rev-parse --show-toplevel)
sha=$(git rev-parse --verify "$1^{commit}")
out=$(realpath "$2")
[[ -d $out ]] || exit 2
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
# Keep the web's out-of-app imports, without archiving the simulator runtime.
git -C "$repo" archive "$sha" apps/server apps/contracts apps/web deploy \
  mobile/sim/maps.json 'mobile/sim/assets/*/top.png' | tar -x -C "$work"
# No .env or working-tree files enter this clean build.
(cd "$work/apps/web" && npm ci --ignore-scripts && npm run build)
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

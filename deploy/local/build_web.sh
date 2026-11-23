#!/bin/sh
# Local compose only: build apps/web and package the MuJoCo browser simulator.
# Same inputs as deploy/prepare-release.sh (web + the data it imports), copied
# out of the read-only /src mount so the checkout is never written.
# /sim-assets is FH_SIM_ASSETS (private policies + MuJoCo runtime); when it is
# empty or differs from the approved SHA, prepare_sim.py drops /sim/ and keeps web.
set -eu
src=${FH_SRC:-/src}
work=${FH_WORK:-/work}
out=${FH_OUT:-/out}
assets=${FH_SIM_ASSETS_DIR:-/sim-assets}

rm -rf "$work/build" "$out/dist"
mkdir -p "$work/build/apps" "$work/build/mobile/sim" "$out"
cp -a "$src/apps/contracts" "$work/build/apps/"
# apps/web without a host node_modules or old dist
mkdir -p "$work/build/apps/web"
(cd "$src/apps/web" && tar -cf - --exclude=./node_modules --exclude=./dist .) | tar -xf - -C "$work/build/apps/web"
cp -a "$src/mobile/sim/maps.json" "$src/mobile/sim/terrain" "$src/mobile/sim/bt.js" "$src/mobile/sim/bt.d.ts" \
    "$work/build/mobile/sim/"
(cd "$src" && find mobile/sim/assets -mindepth 2 -maxdepth 2 -type f \
    \( -name 'top*.png' -o -name 'top.json' -o -name 'map*.json' -o -name 'scenarios*.json' \) \
    -exec cp --parents {} "$work/build/" \;)

cd "$work/build/apps/web"
npm ci --ignore-scripts --no-audit --no-fund
npm run build
mkdir -p "$out/dist"
cp -a dist/. "$out/dist/"
# MuJoCo: the existing packager, the whole mobile/sim tree as input.
# As root it requires root-owned, not group/other-writable private assets, so
# copy the host mount into such a folder first (contents and SHA checks unchanged).
private="$work/sim-assets"
rm -rf "$private"; mkdir -p "$private"
if [ -d "$assets" ]; then cp -R "$assets/." "$private/"; fi
if [ "$(id -u)" = 0 ]; then chown -R 0:0 "$private"; fi
chmod -R go-w "$private"
python3 "$src/deploy/prepare_sim.py" "$src/mobile/sim" "$private" "$out/dist"
echo "web ready: $out/dist"

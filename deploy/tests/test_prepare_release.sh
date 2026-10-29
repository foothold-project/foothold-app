#!/usr/bin/env bash
# Fake npm in a temporary bare repository: archive isolation and link rejection.
set -euo pipefail
[[ $EUID != 0 ]] || { echo 'Run this fake-build test as a non-root user.' >&2; exit 2; }
prepare=$(cd -- "$(dirname -- "$0")/.." && pwd)/prepare-release.sh
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/source/apps/server" "$work/source/apps/contracts" "$work/source/apps/web" \
    "$work/source/apps/simmgr" "$work/source/apps/agent/tools/sim" "$work/source/apps/agent/tools/nav2" \
    "$work/source/deploy" "$work/source/mobile/sim/assets/test" "$work/bin" "$work/out" "$work/check"
printf trusted-server > "$work/source/apps/server/marker"
printf trusted-simmgr > "$work/source/apps/simmgr/marker"
printf trusted-agent > "$work/source/apps/agent/tools/sim/marker"
printf trusted-nav2 > "$work/source/apps/agent/tools/nav2/marker"
printf trusted-contracts > "$work/source/apps/contracts/marker"
printf trusted-deploy > "$work/source/deploy/marker"
cp "$(dirname "$prepare")/prepare_sim.py" "$work/source/deploy/prepare_sim.py"
printf '{}' > "$work/source/apps/web/package.json"
printf '{}' > "$work/source/mobile/sim/maps.json"
printf placeholder > "$work/source/mobile/sim/assets/test/top.png"
printf '{"width":100}' > "$work/source/mobile/sim/assets/test/top.json"
git init -q "$work/source"
git -C "$work/source" add apps/simmgr/marker apps/agent/tools/sim/marker apps/agent/tools/nav2/marker apps/server/marker apps/contracts/marker apps/web/package.json deploy/marker deploy/prepare_sim.py mobile/sim/maps.json mobile/sim/assets/test/top.png mobile/sim/assets/test/top.json
git -C "$work/source" -c user.name=Test -c user.email=test@users.noreply.github.com commit -qm fixture
sha=$(git -C "$work/source" rev-parse HEAD)
git clone -q --bare "$work/source" "$work/repo.git"
cat > "$work/bin/npm" <<'NPM'
#!/usr/bin/env bash
set -euo pipefail
if [[ $1 == ci ]]; then [[ $2 == --ignore-scripts ]]; exit; fi
[[ $1 == run && $2 == build ]]
# Root-executed sources were never present in the build input.
[[ ! -e ../server && ! -e ../../deploy ]]
[[ -s ../../mobile/sim/assets/test/top.png ]]
[[ $(cat ../../mobile/sim/assets/test/top.json) == '{"width":100}' ]]
# A malicious build tries to create/modify root-executed code and contracts.
mkdir -p ../server ../../deploy dist
printf tainted-server > ../server/marker
printf tainted-deploy > ../../deploy/marker
printf tainted-contracts > ../contracts/marker
printf '<html>fake build</html>' > dist/index.html
[[ ${TEST_LINK:-0} == 0 ]] || ln -s /etc/passwd dist/unsafe
NPM
chmod +x "$work/bin/npm"
(cd "$work/repo.git" && FH_SIM_ASSETS="$work/absent" PATH="$work/bin:$PATH" bash "$prepare" "$sha" "$work/out")
tar -xzf "$work/out/$sha.tar.gz" -C "$work/check"
[[ $(cat "$work/check/apps/server/marker") == trusted-server ]]
[[ $(cat "$work/check/apps/contracts/marker") == trusted-contracts ]]
[[ $(cat "$work/check/apps/simmgr/marker") == trusted-simmgr ]]
[[ $(cat "$work/check/apps/agent/tools/sim/marker") == trusted-agent ]]
[[ $(cat "$work/check/apps/agent/tools/nav2/marker") == trusted-nav2 ]]
[[ $(cat "$work/check/deploy/marker") == trusted-deploy ]]
rm "$work/out/$sha.tar.gz" "$work/out/$sha.tar.gz.sha256"
if (cd "$work/repo.git" && TEST_LINK=1 PATH="$work/bin:$PATH" bash "$prepare" "$sha" "$work/out") > "$work/rejected" 2>&1; then
    echo 'Expected symlink dist rejection' >&2; exit 1
fi
[[ ! -e $work/out/$sha.tar.gz ]]
grep -q 'Web dist contains a link or special file' "$work/rejected"
# A tracked PNG without its metadata must fail before npm runs.
mkdir -p "$work/source/mobile/sim/assets/unpaired"
printf placeholder > "$work/source/mobile/sim/assets/unpaired/top.png"
git -C "$work/source" add mobile/sim/assets/unpaired/top.png
git -C "$work/source" -c user.name=Test -c user.email=test@users.noreply.github.com commit -qm missing-metadata
git -C "$work/repo.git" fetch -q "$work/source" HEAD
bad_sha=$(git -C "$work/source" rev-parse HEAD)
if (cd "$work/repo.git" && PATH="$work/bin:$PATH" bash "$prepare" "$bad_sha" "$work/out") > "$work/rejected" 2>&1; then
    echo 'Expected missing top metadata rejection' >&2; exit 1
fi
[[ ! -e $work/out/$bad_sha.tar.gz ]]
grep -q 'Top-view input requires matching nonempty PNG/JSON pairs' "$work/rejected"
# With no PNG or JSON matches git archive itself must reject the empty glob.
git -C "$work/source" rm -q mobile/sim/assets/test/top.png mobile/sim/assets/test/top.json mobile/sim/assets/unpaired/top.png
git -C "$work/source" -c user.name=Test -c user.email=test@users.noreply.github.com commit -qm empty-topviews
git -C "$work/repo.git" fetch -q "$work/source" HEAD
bad_sha=$(git -C "$work/source" rev-parse HEAD)
if (cd "$work/repo.git" && PATH="$work/bin:$PATH" bash "$prepare" "$bad_sha" "$work/out") > "$work/rejected" 2>&1; then
    echo 'Expected empty top-view input rejection' >&2; exit 1
fi
[[ ! -e $work/out/$bad_sha.tar.gz ]]
printf 'PASS: bare archive, paired top-view input, pristine trusted code, dist symlink rejection\n'

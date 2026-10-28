#!/usr/bin/env bash
# Match deploy.sh: source ./common.sh from tools, then cd to release root.
set -euo pipefail
scripts=$(cd -- "$(dirname -- "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/tools" "$work/release" "$work/guard"
cp "$scripts/common.sh" "$work/tools/common.sh"
cp "$scripts/sim_control.py" "$work/tools/sim_control.py"
exercise() (
    cd "$work/tools"
    source ./common.sh
    cd "$work/release"
    calls=()
    python3() {
        # No helper is actually run: verify the executable exists in tools,
        # not at the current release root, for both stop and start.
        [[ $1 == "$work/tools/sim_control.py" && -f $1 ]] || return 91
        calls+=("$2")
    }
    sim_manager_stop "$work/guard"
    sim_manager_start "$work/guard"
    [[ ${calls[*]} == 'stop start' ]]
)
exercise
# The exact pre-fix relative helper expressions must reproduce the regression.
python3 - "$work/tools/common.sh" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
p.write_text(p.read_text().replace('"$FH_DEPLOY_TOOLS_DIR/sim_control.py"',
    '"$(dirname -- "${BASH_SOURCE[0]}")/sim_control.py"'))
PY
if exercise; then echo 'Expected old helper expression to fail after cd' >&2; exit 1; fi
printf 'PASS: real deploy cwd transition, stop+start absolute helper, old expression rejected\n'

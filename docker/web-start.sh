#!/bin/sh
# Compose web start: lockfile deps -> simulator folder from the read-only assets -> Vite.
# A simulator failure never blocks the web; localSim then shows the guide page at /sim/.
set -u
# 마운트된 lockfile이 바뀌었어도 volume의 의존성을 현재 소스에 맞춘다.
npm ci --ignore-scripts || exit 1
# Non-root: prepare_sim requires root-owned private assets only when it runs as root.
if runuser -u node -- python3 /workspace/deploy/prepare_sim.py /workspace/mobile/sim /workspace/sim-assets /tmp/fh-sim; then
  :
else
  echo "경고: prepare_sim 실패 (rc $?). 웹은 뜨고 /sim/ 은 안내 화면이다. FH_SIM_ASSETS 의 SHA256SUMS 를 확인하세요" >&2
fi
export FH_SIM_DIR=/tmp/fh-sim/sim
exec npm run dev

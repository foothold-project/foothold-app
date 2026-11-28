#!/bin/sh
# Compose web start: lockfile deps -> simulator folder from the read-only assets -> Vite.
# A simulator failure never blocks the web; /sim/ then shows a guide page.
set -u
ASSETS=${FH_SIM_ASSETS:-/workspace/sim-assets}
OUT=${FH_SIM_OUT:-/tmp/fh-sim}
# 마운트된 lockfile이 바뀌었어도 volume의 의존성을 현재 소스에 맞춘다.
npm ci --ignore-scripts || exit 1

# /sim/ guide with the reason (localSim serves index.html of the prepared folder).
guide() {
  rm -rf "$OUT/sim"
  mkdir -p "$OUT/sim"
  cat > "$OUT/sim/index.html" <<EOF
<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>시뮬 준비 안 됨</title>
<body style="font:15px/1.6 system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 16px;word-break:keep-all">
<h1 style="font-size:20px">시뮬을 준비하지 못했습니다</h1>
<p>$1</p>
<p>웹은 그대로 씁니다. 고친 뒤 web 컨테이너를 다시 켭니다 (docker compose restart web).</p>
</body></html>
EOF
  chmod 644 "$OUT/sim/index.html"
  echo "경고: $1 웹은 뜨고 /sim/ 은 이 안내 화면이다." >&2
}

# Each start begins fresh; a guide or simulator from an earlier start is not kept.
rm -rf "$OUT"
if [ -z "$(ls -A "$ASSETS" 2>/dev/null)" ]; then
  # FH_SIM_ASSETS unset: compose mounts an empty volume. localSim shows its own guide.
  echo "알림: 시뮬 자산이 없어 /sim/ 은 안내 화면이다. 넣으려면 .env 의 FH_SIM_ASSETS 에 자산 폴더를 적고 다시 띄우세요" >&2
# Non-root: prepare_sim requires root-owned private assets only when it runs as root.
elif [ -n "$(runuser -u node -- find "$ASSETS" ! -readable -print -quit 2>&1)" ]; then
  guide "시뮬 자산 일부를 컨테이너의 node 사용자 (uid 1000) 가 읽을 수 없습니다. 자산 폴더를 남이 읽을 수 있게 (파일 644 · 폴더 755) 두거나 uid 1000 소유로 두세요."
elif runuser -u node -- python3 /workspace/deploy/prepare_sim.py /workspace/mobile/sim "$ASSETS" "$OUT"; then
  :
else
  guide "prepare_sim 실패 (rc $?). FH_SIM_ASSETS 의 자산을 SHA256SUMS 로 확인하세요 (python3 tools/local_up.py --docker)."
fi
export FH_SIM_DIR="$OUT/sim"
exec npm run dev

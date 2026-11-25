#!/bin/bash
# Go2 본체 ↔ Jetson 유선 상태를 1 초마다 남김 (팀장 11/24 15:31). DDS 에 붙지 않음: 커널 패킷 수와 ping 만 씀.
# 11/24 15:21 Go2 본체가 유선으로 아무것도 안 보내고 ping 에 응답 없던 멈춤을 바로 알아채려는 것.
# 설정: ~/foothold-policy-1122/link.env 에 GO2_HOST=<Go2 주 보드 주소> · NIC=<유선 장치> (주소는 저장소에 적지 않음)
set -u
D="$HOME/foothold-policy-1122"
[ -f "$D/link.env" ] && . "$D/link.env"
NIC="${NIC:-enP8p1s0}"
OUT="$D/trace/link-health-$(date +%Y%m%d-%H%M%S).jsonl"
STAT="/sys/class/net/$NIC/statistics"
prev=$(cat "$STAT/rx_packets" 2>/dev/null || echo 0)
n=0; ping_ok=null
while true; do
  sleep 1
  cur=$(cat "$STAT/rx_packets" 2>/dev/null || echo 0)
  link=$(cat "/sys/class/net/$NIC/operstate" 2>/dev/null || echo unknown)
  if [ -n "${GO2_HOST:-}" ] && [ $((n % 5)) = 0 ]; then
    ping -c 1 -W 1 -I "$NIC" "$GO2_HOST" >/dev/null 2>&1 && ping_ok=true || ping_ok=false
  fi
  line="{\"wall\": $(date +%s.%N | cut -c1-14), \"link\": \"$link\", \"rx_per_s\": $((cur - prev)), \"go2_ping\": $ping_ok}"
  echo "$line" >> "$OUT"
  echo "$line" > "$D/trace/link-health-status.json"
  prev=$cur; n=$((n + 1))
done

#!/bin/bash
# Go2 X 켠 뒤 점검 (읽기만 · DDS 에 붙지 않음 · 로봇 명령 없음 · 팀장 11/24 16:11: 켤 때마다 스스로 돌려 결과 파일).
# 부팅 3 분 뒤 foothold-boot-check.timer 가 부름 → trace/boot-check-<시각>.txt · 마지막 결과는 trace/boot-check-last.txt
D=$HOME/foothold-policy-1122
echo "== 시각 · 켜진 지"; date '+%F %T'; uptime -p
echo "== 시계 맞춤"; timedatectl show -p NTPSynchronized --value
echo "== 성능 (MAXN · 클록)"; nvpmodel -q 2>/dev/null | head -2 | tr '\n' ' '; echo; cat /sys/devices/system/cpu/cpu*/cpufreq/scaling_cur_freq 2>/dev/null | sort -u | tr '\n' ' '; echo; systemctl is-active jetson-clocks-boot
echo "== 실시간 우선순위 한도 (기대 50)"; echo "ulimit -r $(ulimit -r)"; systemctl show user@$(id -u).service -p LimitRTPRIO --value; systemctl --user show foothold-policy -p LimitRTPRIO --value
echo "== 시스템 기록 디스크 (기대 /var/log/journal)"; journalctl --header 2>/dev/null | grep -m1 'File path'; journalctl --list-boots --no-pager 2>/dev/null | tail -2
echo "== 서비스"; systemctl --user is-active foothold-policy foothold-depth foothold-factory-record | tr '\n' ' '; systemctl is-active fh-wifi-keepalive.timer; systemctl --user show foothold-depth -p NRestarts --value
echo "== 실행기 인자 (기대 --debug-est · --fwd-max 1.2)"; pgrep -af foothold_agent.policy.run | grep -o -- '--debug-est [^ ]*\|--fwd-max [^ ]*' | tr '\n' ' '; echo; taskset -pc $(pgrep -f foothold_agent.policy.run | head -1) 2>/dev/null
echo "== 올린 파일 md5"; cd $D/run/foothold_agent/policy && md5sum start.py lowlevel.py factory_record.py run.py unitree.py depth_health.py trace.py | awk '{printf "%s=%s ", $2, substr($1,1,8)}'; md5sum $D/depth.sh | awk '{printf "depth.sh=%s\n", substr($1,1,8)}'
echo "== 깊이 (최근 20 초)"; f=$(ls -t $D/trace/depth-health-*.jsonl | head -1); tail -20 $f | python3 -c "
import sys,json
R=[json.loads(l) for l in sys.stdin if l.strip()]
fr=[r.get('frames') or 0 for r in R]; lat=[r.get('lat_ms_p50') for r in R if r.get('lat_ms_p50') is not None]
print('초',len(R),'장/초 최소',min(fr),'평균',round(sum(fr)/len(fr),1),'지연 p50 최소',min(lat) if lat else None,'최대',max(lat) if lat else None)"
echo "== 상태 줄 (배터리 · Jetson 온도 · 주기)"; grep -a '"status"' $D/live-auto.log | tail -1 | python3 -c "
import sys,json; d=json.loads(sys.stdin.read()); print({k:d.get(k) for k in ('status','bat','jetson_c','dt_p99','dt_max','dt_over30','sent')})"
echo "== 순정 기록 칸 (bat · h_kin · temp)"; f=$(ls -t $D/trace/factory-auto-*.jsonl | head -1); tail -1 $f | python3 -c "
import sys,json; d=json.loads(sys.stdin.read()); print('h_kin',d.get('h_kin'),'순정 height',(d.get('sport') or {}).get('height'),'bat',d.get('bat'),'모터 최고',max(d.get('temp') or [0]))"
echo "== D435i USB"; grep -o "Device USB type: [0-9.]*" $(ls -t $D/trace/depth-camera-*.log | head -1) | head -1
echo "== 디스크"; df -h / | tail -1
echo "== 유선 (Go2 ↔ Jetson · DDS 안 씀)"; systemctl --user is-active foothold-link-health; cat $D/trace/link-health-status.json 2>/dev/null
echo "== 판정 (한 줄씩 OK / FAIL)"
ok(){ if eval "$2"; then echo "OK   $1"; else echo "FAIL $1"; fi; }
ok "시계 맞춤" '[ "$(timedatectl show -p NTPSynchronized --value)" = yes ]'
ok "실시간 한도 50" '[ "$(systemctl --user show foothold-policy -p LimitRTPRIO --value)" = 50 ]'
ok "MAXN" 'nvpmodel -q 2>/dev/null | grep -q MAXN'
for s in foothold-policy foothold-depth foothold-factory-record foothold-link-health; do ok "서비스 $s" "systemctl --user is-active --quiet $s"; done
ok "깊이 28 장/초 이상 · 지연 20~60 ms" 'python3 -c "import json,sys;d=json.load(open(\"$D/trace/depth-health-status.json\"));l=d.get(\"lat_ms_p50\") or 0;sys.exit(0 if (d.get(\"frames\") or 0)>=28 and 20<=l<=60 else 1)"'
ok "유선 패킷 500/초 이상 · Go2 ping" 'python3 -c "import json,sys;d=json.load(open(\"$D/trace/link-health-status.json\"));sys.exit(0 if d.get(\"rx_per_s\",0)>=500 and d.get(\"go2_ping\") is True else 1)"'
ok "D435i USB 3 (2.1 이면 접촉 확인)" 'grep -q "Device USB type: 3" $(ls -t $D/trace/depth-camera-*.log | head -1)'
ok "배터리 기록" 'grep -a "\"status\"" $D/live-auto.log | tail -1 | grep -q "\"soc\": [0-9]"'

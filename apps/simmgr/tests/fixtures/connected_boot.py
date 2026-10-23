# Source: control-app/experiments/33-foothold-v2-gazebo-20261012/
# sensor-spec-20261016/stage/sensor-runtime-r1/live_map.py
# Original sha256: 588c8a5dd9b7cf9e; boot copied verbatim, dependencies supplied by tests.
def main():
    gate = CN.Gate(ft) if CONN else None
    def static_floor(ep, f, rev): pass
    def floor_tick(sim_t, pos, tilt, fallen): pass
    def publish_status():
        st = {}
        pub_status.publish(st)

    def boot(why):
        """Gazebo 기동 + 에피소드 상태 초기화(last_action 0·HOLD 0.5 s·STOP 래치 유지)."""
        with snap_lock:
            snap.update(reset_in_progress=True, plugin_mode="DOWN", x=None, _hold_logged=None, cmd_applied=None,
                        cmd_applied_sim_t=None, cmd_applied_seq=None, actor_phase="down", sim_t=None)   # map: 이전 epoch sim 시각 사용 0
        ing.on_stop(why="stop_latched_by_" + why)
        first, err = sim.start()
        if err:
            return None, err
        with snap_lock:
            snap["episode"] += 1; snap["reset_in_progress"] = False
        log_event("episode_start", episode=snap["episode"], why=why)
        tf_buf.clear()                           # map: sim 시계가 0 으로 되감겼으니 이전 epoch TF 버림
        ms.new_epoch(snap["episode"])            # map: 이전 grid·scan·slam 상태 버림(자식 시작 전에)
        pv.new_epoch(snap["episode"]); pv_resubscribe(snap["episode"])   # view: 점군도 같은 epoch 결속
        fg.new_epoch(snap["episode"])                                     # view: follow_cam 도 같은 epoch(sim.start 뒤 = 새 Gazebo)
        if cg:
            cg.new_epoch(snap["episode"])                                 # sensor-runtime: 앞 RGB 도 같은 epoch
        if lidar_view:
            lidar_view.new_epoch(snap["episode"]); lidar_resubscribe(snap["episode"])   # points-lidar: 같은 epoch, 층 무관
        if a.map_mode == "slam":
            resubscribe_map(snap["episode"])   # connected: rev 없음 → 구독 0(층 확정 때 worker 가 (ep,rev) 로)
        elif not CONN:
            pub_static()
        if CONN:                                 # connected: 층 미확정으로 시작(rev+1), 보기 닫음. slam 은 첫 층 확정 때 worker 가 띄움
            ft.reset(snap["episode"]); gate.close(); views_floor(snap["episode"], None, None)
            with ft.lock:                      # halt(끈적한 정지)는 그대로 — 표시만 대기로
                static_sel.update(ep=None, rev=None, floor=None, g=None, meta=None, why="floor_transit")
                slam_ctx.update(floor=None, epoch=snap["episode"], rev=None, state="halted" if CONN and a.map_mode == "slam" and fw.halt else "waiting_floor",
                                why=fw.halt if CONN and a.map_mode == "slam" else None)
        with kids_lock:
            kids.start(snap["episode"], names=(["bridge", "adapter", "p2l"] if sp else ["bridge", "p2l"]) if CONN and a.map_mode == "slam" else None)   # map: epoch = Gazebo 기동 번호
        if a.map_mode == "slam" and not CONN:
            threading.Thread(target=activate_slam, args=(snap["episode"],), daemon=True).start()
        return first, None

    return boot, gate

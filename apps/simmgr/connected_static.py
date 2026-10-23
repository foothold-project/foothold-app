# Source: control-app/experiments/33-foothold-v2-gazebo-20261012/vmap-verify4-20261015/live_map.py
# Original sha256: 4f2acab267fcff64; static selection and tick bodies copied verbatim.
# These functions are transplanted into the verified runtime main scope.

def static_floor(ep, f, rev):   # connected static: 확정층 f 지도 선택(None = 이탈 → 발행 중단·공백). 선택·ms context 를 ft.lock 안에서 한 번에
        with ft.lock:
            if (ft.epoch, ft.rev) != (ep, rev):
                return None
            e = static_by_floor.get(f) if f else None
            g_ = e["g"] if e else None
            if g_ is not None:
                g_.header.stamp = stamp(round(ft.confirm_t, 3))   # 층 바뀔 때마다 새 값(ms 로 반올림 → status stamp_sim 과 정확히 같음)
            static_sel.update(ep=ep, rev=rev, floor=f, g=g_, meta=e["meta"] if e else None,
                              why=None if g_ is not None else ("floor_transit" if f is None else e["why"]))
            ms.new_epoch(ep, rev, f if g_ is not None else None)
            if g_ is None:
                ms.close()
            return dict(static_sel)

def floor_tick(sim_t, pos, tilt, fallen):   # connected: 층 추적 1 tick(제어 루프 스레드). 전환 작업은 worker 큐로만
        prev = ft.current
        sup = cols.support(float(pos[0]), float(pos[1]), float(pos[2])) if np.isfinite(pos).all() else float("nan")
        ev, rev = ft.update(sim_t, float(pos[0]), float(pos[1]), float(pos[2]), tilt, fallen, sup)
        if ev is None:
            return
        fs = ft.snapshot(); ep = fs["epoch"]
        log_event("floor_" + ev, epoch=ep, rev=rev, prev=prev, cur=fs["current_floor"], state=fs["floor_state"], reason=fs["floor_reason"],
                  sim_t=sim_t, support=None if not math.isfinite(sup) else round(sup, 3))
        if ev == "leave":
            views_floor(ep, None, rev)
            if a.map_mode == "slam":
                jobs.put(("leave", ep, rev, prev))
            else:
                static_floor(ep, None, rev)        # root②-3: 이탈 = 발행 중단·공백
        elif a.map_mode == "slam":
            jobs.put(("confirm", ep, rev, fs["current_floor"]))
        else:                                       # root②-3: static = 확정층 canonical GT 로 교체(검사 실패·저장 SLAM 다른 층 = 공백)
            sel = static_floor(ep, fs["current_floor"], rev)
            if sel is not None:
                pub_static()
                sm_ = sel["meta"]
                views_floor(ep, fs["current_floor"], rev, {"map_version": sm_["map_version"], "map_source": sm_["map_source"]} if sm_ else
                            {"map_version": None, "map_source": None})

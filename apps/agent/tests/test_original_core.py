"""Original Core assertions, with expectations unchanged; see PORTING.md."""

from foothold_agent.safety.core import Core, SCHEMA, Z, clean_state, quantize, valid_axes


def test_original_core():
    t = [0.0]; c = Core(now=lambda: t[0]); F = (1.0, 0.0, 0.0); N = Z

    def st(stop=False, ep=0, pol=True, rip=False, **kw):
        d = {'schema': SCHEMA, 'episode': ep, 'stop_requested': stop, 'reset_in_progress': rip, 'policy_running': pol, 'x': 0.0, 'fallen': False}
        d.update(kw); return c.on_state(d)

    def go(*seq):                                   # 입력 차례로 보낸 뒤 명령
        for a in seq:
            c.cmd('a', a)
        return c.applied()

    assert quantize(1, 0, 0)[0] == (0.6, 0, 0) and quantize(1, 0, 1)[0] == (0.6, 0, 0.5) and quantize(1, 0, -1)[0] == (0.6, 0, -0.5)
    for q in [(-1, 0, 0), (0, 1, 0), (0.3, 0, 0), (0, 0, 1)]:
        assert quantize(*q)[0] == Z and quantize(*q)[1], q
    # 4) 입력 형식: NaN/Inf/bool/문자/범위밖/누락 → None
    for m in [{'fx': float('nan'), 'fy': 0, 'fw': 0}, {'fx': float('inf'), 'fy': 0, 'fw': 0}, {'fx': True, 'fy': 0, 'fw': 0},
              {'fx': '1', 'fy': 0, 'fw': 0}, {'fx': 1.5, 'fy': 0, 'fw': 0}, {'fx': 1, 'fy': 0}, {'fx': None, 'fy': 0, 'fw': 0}]:
        assert valid_axes(m) is None, m
    assert valid_axes({'fx': 1, 'fy': 0, 'fw': -1}) == (1.0, 0.0, -1.0)
    # 5) state 형식: 목록/None/틀린 schema/관문값 누락·bool episode → 무시, 표시값 NaN → None
    for bad in [[], None, 'x', {'schema': 'other'}, {'schema': SCHEMA, 'episode': 0, 'stop_requested': False, 'reset_in_progress': False},
                {'schema': SCHEMA, 'episode': True, 'stop_requested': False, 'reset_in_progress': False, 'policy_running': True}]:
        assert clean_state(bad) is None and not c.on_state(bad), bad
    assert clean_state({'schema': SCHEMA, 'episode': 0, 'stop_requested': False, 'reset_in_progress': False, 'policy_running': True,
                        'x': float('nan'), 'fallen': 'yes'}) == {**clean_state({'schema': SCHEMA, 'episode': 0, 'stop_requested': False,
                        'reset_in_progress': False, 'policy_running': True}), 'x': None, 'fallen': None}
    # 1) 초기 state 없음 → 조종권·손 뗌·입력이 있어도 0, 그 입력은 state 가 와도 되살지 않음
    assert c.take('a') and not c.take('b')
    assert go(N, F) == Z and c.reason == '시뮬 상태 미수신'
    st(); assert go(F) == Z and c.reason == '손을 한 번 뗀 뒤 다시 누르세요'
    assert go(N, F) == (0.6, 0, 0)
    c.cmd('b', F); assert c.applied() == (0.6, 0, 0)                  # 남의 입력은 무시(출력 변화 없음)
    c.cmd('a', (1, 0, 1)); assert c.applied() == (0.6, 0, 0.5)
    t[0] += 0.31; st(); assert c.applied() == Z                       # 입력 0.3 s 끊김 → 0
    assert go(F) == Z and go(N, F) == (0.6, 0, 0)                     # 자동 복원 없음
    # 1) state 끊김 → 0 + 입력 버림, 복구만으로는 안 움직임
    t[0] += 1.01; assert go(F) == Z and c.reason == '시뮬 상태 끊김'
    st(); assert go(F) == Z and go(N, F) == (0.6, 0, 0)
    st(pol=False); assert go(N, F) == Z and c.reason == '정책 미실행'
    st(); assert go(N, F) == (0.6, 0, 0)
    # 4) 형식 오류 입력은 그 요청 0 + 무효화
    c.cmd('a', None); assert c.applied() == Z and go(F) == Z and go(N, F) == (0.6, 0, 0)
    # 동시 cmd + STOP → 0 래치
    c.cmd('a', F); c.stop('b'); assert go(F) == Z
    # 2) 시뮬이 STOP 확인 전 재개 거부 → 확인 뒤 재개, 옛 stop_requested=true 표본이 와도 대기 유지, false 확인 뒤 새 0·새 비영
    st(stop=False); assert c.want_stop_pub() and not c.resume('a')
    st(stop=True); assert not c.want_stop_pub() and not c.resume('b') and c.resume('a')
    assert not c.want_stop_pub() and go(N, F) == Z
    st(stop=True); assert c.latch and c.resume_pending and go(N, F) == Z        # 옛 표본 — 다시 래치되지 않고 대기
    st(stop=False); assert not c.latch and go(F) == Z and go(N, F) == (0.6, 0, 0)
    # 2) 재개 대기 중 새 STOP·끊김·새 에피소드·무응답 → 닫힘 유지
    c.stop('a'); st(stop=True); assert c.resume('a'); c.stop('a'); st(stop=False); assert c.latch and go(N, F) == Z
    st(stop=True); assert c.resume('a'); t[0] += 1.01; assert c.applied() == Z and not c.resume_pending
    st(stop=True); assert c.resume('a'); st(stop=False, ep=1); assert c.latch and not c.resume_pending
    st(stop=True, ep=1); assert c.resume('a'); t[0] += 3.01; st(stop=True, ep=1); c.applied(); assert c.latch and not c.resume_pending
    # 3) 리셋: 즉시 잠금·입력 폐기, 대기 중 비영·재개·중복 리셋 거부, 응답·새 에피소드 뒤에도 STOP 유지
    st(stop=True, ep=1); assert c.resume('a'); st(stop=False, ep=1); assert go(N, F) == (0.6, 0, 0)
    assert not c.reset_begin('b', True) and not c.reset_begin('a', False) and c.reset_begin('a', True)
    assert c.latch and go(N, F) == Z and not c.reset_begin('a', True) and not c.resume('a')
    st(stop=True, ep=2, rip=True); assert go(N, F) == Z and c.reason == '시뮬 리셋 중'
    st(stop=True, ep=2); c.reset_done(True, 'ok'); assert c.latch and not c.reset_pending and go(N, F) == Z
    assert c.resume('a'); st(stop=False, ep=2); assert go(N, F) == (0.6, 0, 0)
    assert c.reset_begin('a', True); t[0] += 35.1; st(stop=True, ep=3); c.applied(); assert not c.reset_pending and c.latch
    c.reset_done(True, 'late'); assert c.latch                         # 시간 초과 뒤 늦은 응답은 무시
    # 조종권 해제·새 조종권
    c.drop('a', '연결 끊김'); assert c.controller is None and c.applied() == Z and c.latch
    st(stop=True, ep=3); assert c.take('a') and c.resume('a'); c.drop('a', '로그아웃'); assert c.latch and not c.resume_pending   # 재개 대기 중 끊김도 잠금
    assert c.take('b'); c.cmd('b', F); assert c.applied() == Z         # 새 조종권도 손 뗌 먼저(+래치)


def test_original_stopgen():
    """N1 잠금 세대(CAS): 잠그는 모든 일마다 +1(이미 잠겼어도), gen 다른 resume 거부·재시도 없음, gen 없는 옛 클라이언트 resume 은 그대로"""
    t = [0.0]; c = Core(now=lambda: t[0])
    S = lambda stop, ep=0, rip=False: c.on_state({'schema': SCHEMA, 'episode': ep, 'stop_requested': stop, 'reset_in_progress': rip, 'policy_running': True})
    S(True); g0 = c.stop_gen
    c.stop('b'); assert c.latch and c.stop_gen == g0 + 1                         # 이미 잠김 + 남의 STOP → 세대 +1(옛 latch boolean 은 흔적 0)
    assert c.take('a'); assert c.stop_gen == g0 + 1                              # take 는 세대 무관
    assert not c.resume('a', g0) and c.resume_pending is None and c.latch        # 확인 때 본 g0 → 거부
    assert c.resume('a', c.stop_gen) and c.resume_pending                        # 지금 세대 → 접수
    g = c.stop_gen; c.stop('b'); assert c.stop_gen == g + 1 and c.resume_pending is None and c.latch   # 접수 뒤 STOP → 재개 취소 + 세대 +1
    assert not c.resume('a', g)                                                  # 같은 옛 세대 재전송도 거부
    g = c.stop_gen; c.drop('a', 'x'); assert c.stop_gen == g + 1 and c.controller is None   # 조종권 해제 = 잠금
    g = c.stop_gen; c.drop('zz', 'x'); assert c.stop_gen == g                    # 남의 해제(조종권 없음)는 무관
    assert c.take('a'); g = c.stop_gen; assert c.reset_begin('a', True) and c.stop_gen == g + 1
    g = c.stop_gen; c.reset_done(True, 'ok'); assert c.stop_gen == g + 1          # 리셋 완료도 세대 +1 → 리셋 전 확인으로 재개 0
    g = c.stop_gen; t[0] += 0.1; S(True, ep=1); assert c.stop_gen == g + 1        # episode 변경
    g = c.stop_gen; assert c.resume('a', g); t[0] += 0.1; S(False, ep=1); assert not c.latch and c.stop_gen == g   # 정상 해제 = 세대 그대로
    g = c.stop_gen; t[0] += 0.1; S(True, ep=1); assert c.latch and c.stop_gen == g + 1   # 시뮬이 스스로 STOP
    g = c.stop_gen; c.busy_sim('지도 체험 시작'); assert c.stop_gen > g; c.sim_busy = ''
    assert c.take('a'); c.stop('a'); t[0] += 0.1; S(True, ep=1)
    assert c.resume('a') and c.resume_pending                                    # gen 없음 = 옛 클라이언트(따로 누르는 «STOP 해제») 그대로
    c.stop('a'); assert not c.resume('a', -1)


def test_original_stop_busy_core():
    t = [0.0]
    t[0] = 0.0; c = Core(now=lambda: t[0])
    S = lambda stop: c.on_state({'schema': SCHEMA, 'episode': 0, 'stop_requested': stop, 'reset_in_progress': False, 'policy_running': True})
    S(False); assert c.take('a'); c.cmd('a', Z); c.cmd('a', (1.0, 0.0, 0.0)); assert c.applied() == (0.6, 0, 0)
    c.drop('a', 'Gazebo 종료'); c._lock(); c.sim_busy = 'Gazebo 종료 중'   # stop_sim 과 같은 순서
    S(True); assert c.sim_block() == 'Gazebo 종료 중'
    for cid in ('a', 'b'):
        assert not c.take(cid) and c.controller is None
        c.cmd(cid, Z); c.cmd(cid, (1.0, 0.0, 0.0)); assert c.applied() == Z
        assert not c.resume(cid) and c.resume_pending is None
        assert not c.reset_begin(cid, True) and c.reset_pending is None
    c.sim_busy = ''                                                                # 끝남 → 자동 복원 없음
    assert c.latch and c.controller is None and c.resume_pending is None and c.applied() == Z
    assert c.take('b'); c.cmd('b', Z); c.cmd('b', (1.0, 0.0, 0.0)); assert c.applied() == Z and c.latch   # STOP 잠금 유지


def test_original_map_busy_core():
    t = [0.0]
    c = Core(now=lambda: t[0]); c.on_state({'schema': SCHEMA, 'episode': 0, 'stop_requested': False, 'reset_in_progress': False, 'policy_running': True})
    assert c.take('a'); c.cmd('a', Z); c.cmd('a', (1.0, 0.0, 0.0)); assert c.applied() == (0.6, 0, 0)
    c.busy_sim('지도 체험 시작 처리 중'); assert c.controller is None and c.latch and c.applied() == Z
    for cid in ('a', 'b'):
        assert not c.take(cid) and not c.resume(cid) and not c.reset_begin(cid, True)
        c.cmd(cid, Z); c.cmd(cid, (1.0, 0.0, 0.0)); assert c.applied() == Z
    c.stop('b'); assert c.latch
    c.sim_busy = ''; assert c.take('a'); c.cmd('a', Z); c.cmd('a', (1.0, 0.0, 0.0)); assert c.applied() == Z and c.latch

"""Review regressions: original receipts, sampling gaps and process-wide audit."""
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
import hashlib
import json
from pathlib import Path
import sys
from types import SimpleNamespace as N

import pytest

from test_executor_nav2 import Harness
from test_nav2_tools import C, GOAL, NAV, observation, at, trial
from foothold_agent.executor.nav2 import Binding
from foothold_agent.safety.core import Z
from ledger import Ledger, digest
from trial import Trial, aggregate
from prepare import GTWorld


def register(tmp_path, name='experiment'):
    return Ledger.register(tmp_path/name, C, {'experiment_id': name, 'approval_id': 'safety-approval',
        'preregistration_sha256': digest(C), 'approved_trials': [1,2,3,4]})


def cleanup(ledger, attempt):
    ledger.cleanup({'experiment_id': ledger.registration['experiment_id'], 'attempt_id': attempt['attempt_id'],
        'isolated_start_id': attempt['isolated_start_id'], 'evidence_sha256': 'a'*64,
        'owned_processes_gone': True, 'cgroups_empty': True, 'partition_released': True,
        'original_sources_unchanged': True})


def succeed(ledger, index):
    attempt = ledger.reserve(index, 'isolated-'+str(index), 'operator-'+str(index))
    ledger.finish(attempt, {'status': 'SUCCEEDED'})
    cleanup(ledger, attempt)
    return attempt


def test_delayed_poll_cannot_extend_original_receive_deadline_on_any_output_path():
    h = Harness()
    for step in range(1, 5):
        h.t = step*.05
        h.state()
        h.intent((.6,0,0))
    h.t = .21
    h.e.intent(h.b, (.6,0,0))
    h.t = .49
    h.state()
    h.o.tick()
    assert h.output() == (.6,0,0)
    h.t = .52
    h.events.clear()
    h.state()  # feedback used to publish another nonzero before the next tick
    h.o.tick()
    assert all(v == Z for k,v in h.events if k == 'apply')
    assert h.output() == Z and h.e.binding is None
    assert not h.e.intent(h.b, (.6,0,0))


@pytest.mark.parametrize('reason', ['POLICY_OR_CLOCK_STALE', 'GT_REFUSED', 'RESOURCE_GATE'])
def test_local_stop_zero_and_stop_precede_cancel_without_forging_server_liveness(reason):
    h = Harness()
    last_server = h.s.last_server
    h.t = .1
    h.events.clear()
    h.o.stop(reason)
    assert h.s.last_server == last_server
    assert any(k == 'cancel' for k,v in h.events)
    index = next(i for i,(k,v) in enumerate(h.events) if k == 'cancel')
    assert any(k == 'apply' and v == Z for k,v in h.events[:index])
    assert any(k == 'stop' for k,v in h.events[:index])


@pytest.mark.parametrize('first_still,expected', [(4.999,'SUCCEEDED'),(5.,'SUCCEEDED'),(5.001,'FAILED'),(5.10,'FAILED')])
def test_stop_first_still_observation_obeys_five_wall_second_deadline(first_still, expected):
    t,o = trial('safety')
    t.trigger_stop(o)
    t.ros_zero(.1)
    for i in range(1, 50):
        assert t.update(at(o, i/10, body_still=False)) == 'RUNNING'
    assert t.update(at(o, first_still)) == expected
    if expected == 'FAILED':
        assert t.reason == 'STOP_BODY_TIMEOUT'


@pytest.mark.parametrize('kind', ['goal','safety'])
def test_two_sim_seconds_between_unobserved_samples_cannot_prove_a_hold(kind):
    t,o = Trial(C,GOAL,1,kind=kind), observation()
    t.start(o)
    g = replace(o,x=GOAL['x'] if kind == 'goal' else o.x)
    if kind == 'safety':
        t.trigger_stop(o)
        t.ros_zero(.1)
        g = replace(g, body_still=False)
    assert t.update(at(g,.1),'SUCCEEDED') == 'RUNNING'
    assert t.update(at(g,2.11),'SUCCEEDED') == 'FAILED'
    assert t.reason == 'OBSERVATION_GAP'


def test_sim_jump_and_original_receipt_gap_each_break_hold():
    for change in [dict(sim=2.2,wall=.2,received=.2),dict(sim=.2,wall=.4,received=.4)]:
        t,o=trial(); g=replace(o,x=GOAL['x'])
        t.update(at(g,.1),'SUCCEEDED')
        assert t.update(replace(g,**change),'SUCCEEDED') == 'FAILED'
        assert t.reason == 'OBSERVATION_GAP'


def test_safety_never_uses_goal_success_and_prior_zero_is_ignored():
    t,o=Trial(C,GOAL,1,kind='safety'),observation()
    t.start(o)
    for i in range(1,24):
        assert t.update(at(o,i/10,x=GOAL['x']),'SUCCEEDED') == 'RUNNING'
    t.trigger_stop(at(o,2.4))
    t.ros_zero(2.3)
    assert t.ros_zero_at is None
    t.ros_zero(2.45)
    assert t.ros_zero_at == 2.45


@pytest.mark.parametrize('outcome', ['FAILED','BLOCKED_NOT_STARTED'])
def test_failed_or_blocked_trial_cannot_be_recalled_or_omitted(tmp_path,outcome):
    ledger=register(tmp_path)
    attempt=ledger.reserve(1,'start-a','operator-a')
    ledger.finish(attempt,{'status':outcome})
    reopened=Ledger(ledger.folder,C)
    for index in (1,2):
        with pytest.raises(ValueError,match='HOLD'):
            reopened.reserve(index,'start-b','operator-b')
    report=aggregate(C,reopened)
    assert not report['r0_complete']
    assert report['attempts'][0]['status'] == outcome
    assert report['blocked_not_started'] == (outcome=='BLOCKED_NOT_STARTED')


def test_incomplete_crashed_attempt_and_concurrent_reservations_are_not_retried(tmp_path):
    ledger=register(tmp_path)
    def reserve_one(index):
        try:
            return Ledger(ledger.folder,C).reserve(1,'isolation-'+str(index),'op-'+str(index))['event']
        except ValueError:
            return 'DENIED'
    with ThreadPoolExecutor(max_workers=2) as pool:
        results=list(pool.map(reserve_one,[1,2]))
    assert results.count('attempt_started') == 1 and results.count('DENIED') == 1
    assert not ledger.summary(C)['r0_complete']
    with pytest.raises(FileExistsError):
        Ledger.register(ledger.folder,C,ledger.registration)


def test_ledger_complete_order_cleanup_and_separate_goal_approval(tmp_path):
    ledger=register(tmp_path)
    for i in range(1,5): succeed(ledger,i)
    go={'experiment_id':'experiment','preregistration_sha256':digest(C),
        'approval_id':'new-go-after-safety','approved_trials':list(range(5,11))}
    ledger.approve_go(go)
    for i in range(5,11): succeed(ledger,i)
    result=aggregate(C,Ledger(ledger.folder,C))
    assert result['r0_complete'] and result['success_count'] == 10
    assert [r['trial'] for r in result['attempts']] == C['trials']
    with pytest.raises(ValueError,match='HOLD'):
        ledger.reserve(10,'new-id','new-op')
    assert not aggregate(C,ledger)['r0_complete']


def test_no_goal_phase_or_missing_cleanup_or_wrong_order_is_holding(tmp_path):
    for mode in ('goal','cleanup','order'):
        ledger=register(tmp_path,mode)
        if mode=='goal':
            for i in range(1,5): succeed(ledger,i)
            index=5
        elif mode=='cleanup':
            a=ledger.reserve(1,'start','op'); ledger.finish(a,{'status':'SUCCEEDED'}); index=2
        else: index=2
        with pytest.raises(ValueError,match='HOLD'):
            ledger.reserve(index,'next','new-op')
        assert not ledger.summary(C)['r0_complete']


def test_config_change_or_invalid_registration_cannot_reset_experiment(tmp_path):
    ledger=register(tmp_path)
    with pytest.raises(ValueError,match='preregistration differs'):
        Ledger(ledger.folder,{**C,'goal_xy_m':.5})
    with pytest.raises(ValueError):
        Ledger.register(tmp_path/'unauthorized',C,{})
    file=ledger.folder/'attempts.jsonl'
    file.write_text('{"truncated":true}\n')
    with pytest.raises((ValueError,KeyError)):
        ledger.reserve(1,'a','b')


def geometry(tmp_path, monkeypatch):
    import prepare
    world=tmp_path/'world.sdf'
    world.write_text('<sdf><world><model name="v5_single"><static>1</static><link>'
        '<collision name="floor"><pose>0 0 -.5 0 0 0</pose><geometry><box><size>50 50 1</size></box></geometry></collision>'
        '</link></model></world></sdf>')
    monkeypatch.setattr(prepare,'WORLD_SHA',hashlib.sha256(world.read_bytes()).hexdigest())
    return GTWorld(world)


def test_cell_scale_plan_wobble_uses_expanded_straight_sweep_not_curves(tmp_path,monkeypatch):
    g=geometry(tmp_path,monkeypatch)
    start={'x':-12.,'y':-8.999,'z':.4,'yaw':0}
    goal={'x':-10.8,'y':-9.,'yaw':0}
    trace=[start,{'x':-11.4,'y':-8.98},goal]
    proof=g.path(start,goal,trace)
    assert proof['pass'] and proof['margin_m'] == .05
    assert not g.path(start,goal,[start,{'x':-11.4,'y':-8.8},goal])['pass']
    assert not g.path({**start,'yaw':3.14},goal,trace)['pass']
    assert not g.path(start,{**goal,'y':-7},trace)['pass']
    # All file reads are finished; proofs must keep working from frozen bounds.
    monkeypatch.setattr(Path,'read_bytes',lambda *_: (_ for _ in ()).throw(AssertionError('unexpected IO')))
    assert g.pose(start)['pass'] and g.path(start,goal,trace)['pass']


def test_scan_tf_phase_offset_preserves_derivative_but_out_of_window_blocks():
    from odometry import SimOdom
    s=SimOdom(.25,.02,.15)
    def update(t,scan):
        return s.update(episode=1,clock=t,scan_stamp=scan,stamp=t,x=t*.6,y=0,yaw=0,map_identity=True)
    assert update(1.,.95) is None
    assert update(1.1,1.05) is not None
    assert update(1.2,.8) is None
    assert update(1.3,1.25) is not None


def test_first_unsupported_command_latches_zero_instead_of_flickering():
    h=Harness()
    h.intent((.6,0,.00001))
    assert h.output()==Z and h.e.rejected and h.e.binding is None
    h.intent((.6,0,0))
    assert h.output()==Z


def test_launch_remaps_can_never_target_robot_command_topics(monkeypatch):
    import launch_nav2
    class Node:
        def __init__(self,**kw): self.kw=kw
    monkeypatch.setenv('FH_NAV2_EXECUTE','1')
    monkeypatch.setattr('foothold_agent.ros_bridge.config.validate_isolation',lambda:None)
    monkeypatch.setitem(sys.modules,'launch',N(LaunchDescription=lambda items:items))
    monkeypatch.setitem(sys.modules,'launch_ros.actions',N(Node=Node))
    description=launch_nav2.generate_launch_description()
    remaps=[pair for item in description for pair in item.kw.get('remappings',[])]
    assert remaps
    assert all(destination=='/fh_nav/intent' for source,destination in remaps)
    assert not any(destination.startswith('/v2_live/') for source,destination in remaps)
    assert all(role in ('/fh_nav/intent','DISABLED') for role in launch_nav2.COMMAND_ROLES.values())


@pytest.mark.parametrize('started', [False,True])
def test_runner_reserves_before_preflight_and_reinvocation_cannot_omit_failure(tmp_path,monkeypatch,started):
    import asyncio, runner
    here=tmp_path/'apps/agent/tools/nav2'
    here.mkdir(parents=True)
    monkeypatch.setattr(runner,'HERE',here)
    monkeypatch.setenv('FH_NAV2_EXECUTE','1')
    ledger=register(tmp_path/'runs')
    calls=[]
    async def refused(args,config,policy):
        calls.append(args.trial)
        args.started=started
        raise ValueError('preflight or live refusal')
    monkeypatch.setattr(runner,'_execute',refused)
    args=N(experiment=ledger.folder,trial=1,isolated_start_id='a',operator_confirmation='op',output=tmp_path/'runs/out1')
    with pytest.raises(ValueError,match='refusal'):
        asyncio.run(runner.execute(args,C,{}))
    status='FAILED' if started else 'BLOCKED_NOT_STARTED'
    assert ledger.summary(C)['attempts'][0]['status']==status
    args.output=tmp_path/'runs/out2';args.isolated_start_id='b';args.operator_confirmation='op2'
    with pytest.raises(ValueError,match='HOLD'):
        asyncio.run(runner.execute(args,C,{}))
    assert calls==[1] and not args.output.exists()


def test_copied_map_is_rehashed_and_corruption_cannot_be_certified(tmp_path,monkeypatch):
    import prepare
    source=tmp_path/'source';source.mkdir()
    (source/'map.pgm').write_bytes(b'P5\n800 640\n255\n'+bytes([254])*(800*640))
    (source/'map.yaml').write_text('image: map.pgm\n')
    (source/'meta.json').write_text(json.dumps(dict(world_id='v5_single',floor_id='f1',map_version='gt-20261012',
        resolution=.05,origin=[-20,-14,0],width=800,height=640)))
    monkeypatch.setattr(prepare,'MAP_HASHES',{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in source.iterdir()})
    good=prepare.copy_map(source,tmp_path/'good')
    assert good==prepare.map_manifest(tmp_path/'good')
    original=prepare.shutil.copyfile
    def corrupt(src,dst):
        original(src,dst)
        if dst.name=='map.pgm': dst.write_bytes(b'corrupted')
    monkeypatch.setattr(prepare.shutil,'copyfile',corrupt)
    with pytest.raises(ValueError,match='SHA'):
        prepare.copy_map(source,tmp_path/'corrupt')


@pytest.mark.parametrize('offset,expected',[(.199,'RUNNING'),(.201,'BLOCKED_NOT_STARTED')])
def test_start_position_range_is_checked_before_any_motion(offset,expected):
    t,o=Trial(C,GOAL,1),observation()
    assert t.start(replace(o,x=o.x+offset))==expected


def test_poll_pause_ready_episode_and_stop_generation_each_keep_zero():
    from foothold_agent.executor.nav2 import Owner
    from test_executor_nav2 import Sink, Actions, CONFIG
    h=Harness()
    h.e.intent(h.b,(.6,0,0))
    assert h.e.poll({'run_id':'run','status':'PAUSED'})==Z
    h.e.binding=replace(h.b,episode=2)
    assert not h.o.ready()
    h.e.binding=h.b
    h.o.session=N(core=N(latch=False,stop_gen=h.b.stop_gen+1),holder_run_id='run',lease_confirmed=True,
                  run={'run_id':'run','status':'RUNNING'})
    h.events.clear()
    h.o._cancel_if_invalid()
    assert h.events and h.events[0]==('apply',Z) and h.events[-1][0]=='cancel'


def ros_stub(monkeypatch,clock):
    """Entire RosAdapter constructor/callback/spin API, without importing ROS."""
    from ros_adapter import RosAdapter,ActionMailbox
    def twist(): return N(linear=N(x=0.,y=0.,z=0.),angular=N(x=0.,y=0.,z=0.))
    def pose(): return N(position=N(x=0.,y=0.,z=0.),orientation=N(x=0.,y=0.,z=0.,w=1.))
    def odom(): return N(header=N(),pose=N(pose=pose()),twist=N(twist=twist()))
    class Parameter:
        def __init__(self,*a,**kw): pass
    class Action:
        def __init__(self,*a,**kw): pass
    for name,module in {
        'rclpy.action':N(ActionClient=Action),'rclpy.parameter':N(Parameter=Parameter),
        'rclpy.qos':N(QoSProfile=lambda **kw:N(**kw),ReliabilityPolicy=N(RELIABLE=1,BEST_EFFORT=2),DurabilityPolicy=N(TRANSIENT_LOCAL=1)),
        'geometry_msgs.msg':N(Twist=twist),'nav_msgs.msg':N(Odometry=odom,Path=object,OccupancyGrid=object),
        'nav2_msgs.action':N(NavigateToPose=N(Goal=lambda:N(pose=N(header=N(),pose=pose())))),
        'lifecycle_msgs.srv':N(GetState=N(Request=lambda:None)), 'rosgraph_msgs.msg':N(Clock=object),
        'sensor_msgs.msg':N(LaserScan=object),'std_msgs.msg':N(String=object),'tf2_msgs.msg':N(TFMessage=object)
    }.items(): monkeypatch.setitem(sys.modules,name,module)
    class Node:
        def __init__(self):
            self.subscriptions={};self.messages=[];self.graph_calls=0
            self.infos=[N(topic_type='geometry_msgs/msg/Twist',node_name='controller_server')]
        def set_parameters(self,*a): pass
        def create_client(self,*a): return N(service_is_ready=lambda:False)
        def create_publisher(self,*a): return N(publish=self.messages.append)
        def create_subscription(self,typ,topic,callback,qos): self.subscriptions[topic]=callback
        def get_publishers_info_by_topic(self,*a): self.graph_calls+=1;return self.infos
    node=Node()
    h=Harness();h.t=clock[0]
    policy=json.loads((NAV/'policy.json').read_text())
    glue=RosAdapter(node,h.e,policy,C,ActionMailbox(),now=lambda:clock[0],map_manifest={})
    glue.active=h.b;glue.handle=object()
    return node,glue,h,twist


def test_adapter_constructor_to_callbacks_snapshot_and_owner_pipeline(monkeypatch):
    clock=[.1];node,g,h,twist=ros_stub(monkeypatch,clock)
    def stamp(t): return N(sec=int(t),nanosec=round((t-int(t))*1e9))
    identity=N(header=N(frame_id='map'),child_frame_id='odom',
        transform=N(translation=N(x=0,y=0,z=0),rotation=N(x=0,y=0,z=0,w=1)))
    node.subscriptions['/tf_static'](N(transforms=[identity]))
    for i in range(1,13):
        clock[0]=i/10
        t=clock[0];h.t=t
        raw=dict(schema='v2_live/state/1',episode=1,sim_t=t,x=-12,y=-9,z=.4,yaw=0,
            vx=0,vy=0,wz=0,tilt_deg=0,fallen=False,policy_running=True,stop_requested=False,
            reset_in_progress=False,plugin_mode='LOCKSTEP',cmd_applied=[0,0,0])
        node.subscriptions['/fh_nav/intent'](twist())
        h.o.on_state(raw)
        node.subscriptions['/v2_live/state'](N(data=json.dumps(raw)))
        node.subscriptions['/clock'](N(clock=stamp(t)))
        node.subscriptions['/v2_map/scan'](N(header=N(frame_id='base_footprint',stamp=stamp(t-.05))))
        tf=N(header=N(frame_id='odom',stamp=stamp(t)),child_frame_id='base_footprint',
             transform=N(translation=N(x=-12,y=-9,z=0),rotation=N(x=0,y=0,z=0,w=1)))
        node.subscriptions['/tf'](N(transforms=[tf]))
        g.lifecycle={name:(True,t) for name in g.lifecycle_clients}
        g.spin();h.o.tick()
    view=g.snapshot()
    assert view['frames_ready'] and view['pose_agrees']
    assert node.messages and node.messages[-1].header.stamp.sec==1
    assert view['alignment']['max_scan_tf_delta_s']==pytest.approx(.05)
    before=node.graph_calls
    for i in range(5): g.spin()
    assert node.graph_calls==before  # 10ms spins do not query/deepcopy large paths
    node.subscriptions['/plan'](N(header=N(frame_id='map'),poses=[]))
    clock[0]+=.05;g.spin()
    assert g.snapshot()['path'] is g.snapshot()['path']
    node.infos=[N(topic_type='geometry_msgs/msg/TwistStamped',node_name='outsider')]
    clock[0]+=.21;g.spin()
    assert not g.graph_ok and not g.snapshot()['frames_ready']
    # Intent producer gate and all six velocity axes are meaningful boundaries.
    h.t=clock[0]
    count=h.e._sequence
    g.silenced=True
    node.subscriptions['/fh_nav/intent'](twist())
    assert h.e._sequence==count
    g.silenced=False
    bad=twist();bad.linear.z=.01
    node.subscriptions['/fh_nav/intent'](bad)
    assert h.e.poll(h.s.run)==Z and h.e.rejected


def test_tf_state_pose_disagreement_blocks_readiness(monkeypatch):
    clock=[.1];node,g,h,twist=ros_stub(monkeypatch,clock)
    g.data['state']=({'episode':1,'sim_t':.1,'x':-12,'y':-9,'yaw':0},.1)
    g.data['odom']={'stamp':.1,'x':-11,'y':-9,'yaw':0}
    g.odom_at=.1;g.aligned_samples=20;g.map_identity=True
    g.spin()
    assert not g.snapshot()['pose_agrees'] and not g.snapshot()['frames_ready']


def test_failed_final_trial_stays_in_full_denominator_and_cannot_be_cleaned(tmp_path):
    ledger=register(tmp_path)
    for i in range(1,5): succeed(ledger,i)
    ledger.approve_go({'experiment_id':'experiment','preregistration_sha256':digest(C),
        'approval_id':'go','approved_trials':list(range(5,11))})
    for i in range(5,10): succeed(ledger,i)
    a=ledger.reserve(10,'final','operator-final')
    ledger.finish(a,{'status':'FAILED','reason':'UNSUPPORTED_COMMAND'})
    with pytest.raises(ValueError): cleanup(ledger,a)
    report=aggregate(C,ledger)
    assert len(report['attempts'])==10 and report['success_count']==9 and not report['r0_complete']


def test_owner_loop_gap_and_original_receipt_gap_are_independently_bounded():
    for earlier,later in [
        (dict(wall=.1,sim=.1,received=0), dict(wall=.25,sim=.2,received=.25)),
        (dict(wall=.1,sim=.1,received=0), dict(wall=.31,sim=.2,received=.2))]:
        t,o=trial();g=replace(o,x=GOAL['x'])
        assert t.update(replace(g,**earlier),'SUCCEEDED')=='RUNNING'
        assert t.update(replace(g,**later),'SUCCEEDED')=='FAILED'
        assert t.reason=='OBSERVATION_GAP'


def test_offline_supported_ratio_reports_first_latched_rejection_without_feasibility_claim():
    from assess_commands import assess
    policy=json.loads((NAV/'policy.json').read_text())
    result=assess([{'input_si':v} for v in ((.6,0,0),(.6,0,.0001),(0,0,0),(.1,0,0))],policy)
    assert result['tested_ratio']==.25 and result['first_latched_rejection_index']==1
    assert result['actual_nav2_feasibility_proven'] is False


def test_goal_stop_intervention_cannot_become_a_safety_success():
    t,o=trial()
    t.trigger_stop(o)
    assert t.status=='FAILED' and t.reason=='GOAL_SAFETY_INTERVENTION'


def test_fresh_operator_confirmation_and_fresh_goal_go_are_required(tmp_path):
    ledger=register(tmp_path)
    with pytest.raises(ValueError,match='HOLD'): ledger.reserve(1,'start','')
    assert ledger.summary(C)['denied_invocations']==1
    other=register(tmp_path,'second')
    for i in range(1,5): succeed(other,i)
    with pytest.raises(ValueError,match='fresh goal-phase GO'):
        other.approve_go({'experiment_id':'second','approval_id':'safety-approval',
            'preregistration_sha256':digest(C),'approved_trials':list(range(5,11))})

"""Real launch-description wiring with plain objects: no ROS imports or startup."""
from pathlib import Path
import sys
from types import SimpleNamespace as N

import pytest

NAV=Path(__file__).parents[1]/'tools/nav2'
sys.path.insert(0,str(NAV))
import launch_nav2


@pytest.fixture
def description(monkeypatch):
    class Node:
        def __init__(self,**kwargs):self.kw=kwargs
    monkeypatch.setenv('FH_NAV2_EXECUTE','1')
    monkeypatch.setattr('foothold_agent.ros_bridge.config.validate_isolation',lambda:None)
    monkeypatch.setitem(sys.modules,'launch',N(LaunchDescription=lambda nodes:nodes))
    monkeypatch.setitem(sys.modules,'launch_ros.actions',N(Node=Node))
    return launch_nav2.generate_launch_description()


def test_straight_launch_omits_behavior_server_and_its_command_remaps(description):
    nodes={n.kw['name']:n.kw for n in description}
    assert set(nodes)=={'controller_server','planner_server','bt_navigator','fh_nav_lifecycle_manager'}
    assert 'behavior_server' not in nodes
    assert launch_nav2.COMMAND_ROLES['behavior_server']=='DISABLED'
    assert not any(n['package']=='nav2_behaviors' for n in nodes.values())
    assert '\nbehavior_server:' not in (NAV/'nav2_params.yaml').read_text()
    for name in ('controller_server','planner_server','bt_navigator'):
        assert all(destination=='/fh_nav/intent' for _,destination in nodes[name]['remappings'])


def test_lifecycle_names_match_exactly_the_launched_straight_servers(description):
    manager=next(n for n in description if n.kw['name']=='fh_nav_lifecycle_manager')
    lifecycle=manager.kw['parameters'][0]['node_names']
    launched=[n.kw['name'] for n in description if n is not manager]
    assert lifecycle==['controller_server','planner_server','bt_navigator']
    assert len(lifecycle)==len(set(lifecycle)) and set(lifecycle)==set(launched)


def test_adapter_clients_match_actual_straight_lifecycle_servers(description,monkeypatch):
    from test_nav2_review import ros_stub
    _,adapter,_,_=ros_stub(monkeypatch,[.1])
    launched={n.kw['name'] for n in description if n.kw['name']!='fh_nav_lifecycle_manager'}
    assert set(adapter.lifecycle_clients)==set(launch_nav2.LIFECYCLE_NODES)==launched


@pytest.mark.parametrize('mode,ready',[
    ('all_active',True),('missing',False),('inactive',False),('extra',False),
    ('same_count_wrong_name',False),('stale',False)])
def test_lifecycle_ready_requires_exact_names_active_and_original_freshness(monkeypatch,mode,ready):
    from test_nav2_review import ros_stub
    _,adapter,_,_=ros_stub(monkeypatch,[.1])
    names=('controller_server','planner_server','bt_navigator')
    adapter.lifecycle={name:(True,.1) for name in names}
    if mode=='missing':adapter.lifecycle.pop('planner_server')
    if mode=='inactive':adapter.lifecycle['planner_server']=(False,.1)
    if mode=='extra':adapter.lifecycle['behavior_server']=(True,.1)
    if mode=='same_count_wrong_name':
        adapter.lifecycle.pop('planner_server')
        adapter.lifecycle['unexpected_server']=(True,.1)
    if mode=='stale':adapter.lifecycle['planner_server']=(True,-1.400001)
    adapter.spin()
    assert adapter.snapshot()['lifecycle_ready'] is ready


@pytest.mark.parametrize('publishers,ready', [
    (['controller_server'], True), (['behavior_server'], False),
    (['controller_server', 'behavior_server'], False), ([], False),
])
def test_intent_graph_only_accepts_enabled_command_roles(monkeypatch,publishers,ready):
    from test_nav2_review import ros_stub
    node,adapter,_,_=ros_stub(monkeypatch,[.1])
    node.infos=[N(topic_type='geometry_msgs/msg/Twist',node_name=name) for name in publishers]
    adapter.spin()
    assert adapter.graph_ok is ready

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
    for name in ('controller_server','planner_server','bt_navigator'):
        assert all(destination=='/fh_nav/intent' for _,destination in nodes[name]['remappings'])


def test_lifecycle_names_match_exactly_the_launched_straight_servers(description):
    manager=next(n for n in description if n.kw['name']=='fh_nav_lifecycle_manager')
    lifecycle=manager.kw['parameters'][0]['node_names']
    launched=[n.kw['name'] for n in description if n is not manager]
    assert lifecycle==['controller_server','planner_server','bt_navigator']
    assert len(lifecycle)==len(set(lifecycle)) and set(lifecycle)==set(launched)

"""Product Nav2 extension on the existing ROS thread; no robot motion publisher.

Derived from tools/nav2/ros_adapter's asynchronous action/TF collection. Goal
subscriptions and callbacks capture immutable generations; only terminal result
proves cancellation complete (CancelGoal acceptance alone never does).
"""
from copy import deepcopy
import hashlib
import json
import math
import threading
import time

from .nav_odometry import SimOdom

LIFECYCLE_NODES = ('controller_server', 'planner_server', 'bt_navigator')


class RunNav:
    def __init__(self, node, nav, *, now=time.monotonic):
        from rclpy.action import ActionClient
        from rclpy.parameter import Parameter
        from rclpy.qos import QoSProfile, ReliabilityPolicy, DurabilityPolicy
        from geometry_msgs.msg import Twist
        from nav_msgs.msg import OccupancyGrid, Odometry
        from nav2_msgs.action import NavigateToPose
        from lifecycle_msgs.srv import GetState
        from rosgraph_msgs.msg import Clock
        from sensor_msgs.msg import LaserScan
        from std_msgs.msg import String
        from tf2_msgs.msg import TFMessage
        self.node, self.nav, self.actions, self.now = node, nav, nav.actions, now
        self.lock = threading.Lock()
        self.grid = None
        self.active = self.handle = self.subscription = None
        self.cancel_sent = False
        self.clock = self.scan = None
        self.map_identity = False
        self.state = {}
        self.odom_at = float('-inf')
        self.last_lifecycle = float('-inf')
        self.lifecycle, self.lifecycle_pending = {}, {}
        self.odom = SimOdom(.25, .02, .15)
        self.Twist, self.Odometry = Twist, Odometry
        self.Goal, self.GetState = NavigateToPose.Goal, GetState
        node.set_parameters([Parameter('use_sim_time', value=True)])
        self.navigator = ActionClient(node, NavigateToPose, '/navigate_to_pose')
        self.lifecycle_clients = {name: node.create_client(GetState, '/'+name+'/get_state') for name in LIFECYCLE_NODES}
        self.reliable = QoSProfile(depth=1, reliability=ReliabilityPolicy.RELIABLE)
        sensor = QoSProfile(depth=1, reliability=ReliabilityPolicy.BEST_EFFORT)
        static = QoSProfile(depth=1, reliability=ReliabilityPolicy.RELIABLE, durability=DurabilityPolicy.TRANSIENT_LOCAL)
        self.publisher = node.create_publisher(Odometry, '/fh_nav/odom', self.reliable)
        node.create_subscription(Clock, '/clock', self._clock, sensor)
        node.create_subscription(LaserScan, '/v2_map/scan', self._scan, sensor)
        node.create_subscription(TFMessage, '/tf', self._tf, sensor)
        node.create_subscription(TFMessage, '/tf_static', self._static, static)
        node.create_subscription(OccupancyGrid, '/v2_map/map', self._grid, static)
        node.create_subscription(String, '/v2_live/state', self._state, self.reliable)

    @staticmethod
    def stamp(value):
        return value.sec + value.nanosec*1e-9

    def _clock(self, m):
        self.clock = (self.stamp(m.clock), self.now())

    def _scan(self, m):
        self.scan = (self.stamp(m.header.stamp), self.now()) if m.header.frame_id in ('base_footprint','base','lidar_link') else None

    def _state(self, m):
        try:
            self.state = json.loads(m.data) if len(m.data) <= 65536 else {}
        except (ValueError, RecursionError):
            self.state = {}

    def _static(self, m):
        for t in m.transforms:
            if (t.header.frame_id,t.child_frame_id) == ('map','odom'):
                p,q = t.transform.translation,t.transform.rotation
                self.map_identity = (p.x,p.y,p.z,q.x,q.y,q.z,q.w) == (0,0,0,0,0,0,1)

    def _grid(self, m):
        value = None
        p,q = m.info.origin.position,m.info.origin.orientation
        if (m.header.frame_id == 'map' and 0 < m.info.width <= 4096 and 0 < m.info.height <= 4096
                and len(m.data) == m.info.width*m.info.height and p.z == 0 and q.x == q.y == 0
                and math.isfinite(m.info.resolution) and m.info.resolution > 0
                and abs(q.z*q.z+q.w*q.w-1) <= 1e-7):
            value = dict(width=m.info.width,height=m.info.height,resolution=m.info.resolution,
                origin=[p.x,p.y,math.atan2(2*q.w*q.z,1-2*q.z*q.z)],
                sha256=hashlib.sha256(bytes(v % 256 for v in m.data)).hexdigest())
        with self.lock:
            self.grid = value

    def grid_snapshot(self):
        with self.lock:
            return deepcopy(self.grid)

    def _tf(self, m):
        for t in m.transforms:
            if (t.header.frame_id,t.child_frame_id) != ('odom','base_footprint') or self.clock is None or self.scan is None:
                continue
            if max(self.now()-self.clock[1],self.now()-self.scan[1]) > .2:
                continue
            p,q = t.transform.translation,t.transform.rotation
            if abs(q.x) > 1e-6 or abs(q.y) > 1e-6 or abs(q.z*q.z+q.w*q.w-1) > 1e-6:
                continue
            sample = self.odom.update(episode=self.state.get('episode'),clock=self.clock[0],scan_stamp=self.scan[0],
                stamp=self.stamp(t.header.stamp),x=p.x,y=p.y,yaw=math.atan2(2*q.w*q.z,1-2*q.z*q.z),map_identity=self.map_identity)
            if sample is None:
                self.odom_at = float('-inf')
                continue
            msg = self.Odometry()
            msg.header.stamp = t.header.stamp
            msg.header.frame_id,msg.child_frame_id = 'odom','base_footprint'
            msg.pose.pose.position.x,msg.pose.pose.position.y = sample['x'],sample['y']
            msg.pose.pose.orientation = q
            msg.twist.twist.linear.x,msg.twist.twist.linear.y,msg.twist.twist.angular.z = sample['vx'],sample['vy'],sample['wz']
            self.publisher.publish(msg)
            state = self.state
            agrees = (all(type(state.get(k)) in (int,float) and math.isfinite(state[k]) for k in ('x','y','yaw','sim_t'))
                      and abs(state['sim_t']-sample['stamp']) <= .25
                      and math.hypot(state['x']-sample['x'],state['y']-sample['y']) <= .05
                      and abs(math.atan2(math.sin(state['yaw']-sample['yaw']),math.cos(state['yaw']-sample['yaw']))) <= .05)
            self.odom_at = self.now() if agrees else float('-inf')

    def _intent(self, binding, m):
        if binding != self.active or self.cancel_sent or self.handle is None:
            return
        velocity = (m.linear.x,m.linear.y,m.angular.z)
        if m.linear.z != 0 or m.angular.x != 0 or m.angular.y != 0:
            velocity = (float('nan'),0,0)
        self.nav.intent(binding,velocity)

    def _clear_subscription(self):
        if self.subscription is not None:
            self.node.destroy_subscription(self.subscription)
            self.subscription = None

    def _goal_response(self, future, binding):
        handle = future.result()
        if not handle.accepted:
            self.nav.feedback(binding,'REJECTED')
            self.actions.complete(binding)
            return
        self.handle = handle
        handle.get_result_async().add_done_callback(lambda f,b=binding:self._result(f,b))
        if binding != self.nav.binding or self.actions.take()[1] == binding:
            self._cancel(binding)
            return
        self.subscription = self.node.create_subscription(self.Twist,'/fh_nav/intent',
            lambda m,b=binding:self._intent(b,m),self.reliable)

    def _result(self, future, binding):
        status = future.result().status
        if status not in (4,5,6):
            return  # never call a nonterminal status a cancellation proof
        if binding == self.active:
            self._clear_subscription()
        self.nav.feedback(binding,{4:'SUCCEEDED',5:'CANCELED',6:'ABORTED'}[status])
        self.actions.complete(binding)

    def _cancel(self, binding):
        if binding != self.active or self.handle is None or self.cancel_sent:
            return
        self.cancel_sent = True
        self._clear_subscription()
        self.handle.cancel_goal_async()  # result callback, not response, is proof

    def spin(self):
        item,cancel = self.actions.take()
        if cancel is not None:
            self._cancel(cancel)
        if item is not None:
            binding,point = item
            self.active,self.handle,self.cancel_sent = binding,None,False
            self._clear_subscription()
            if cancel == binding or binding != self.nav.binding:
                self.actions.complete(binding)  # never submitted, hence no live action
            else:
                goal = self.Goal()
                goal.pose.header.frame_id = 'map'
                goal.pose.header.stamp = self.node.get_clock().now().to_msg()
                goal.pose.pose.position.x,goal.pose.pose.position.y = float(point['x']),float(point['y'])
                goal.pose.pose.orientation.z,goal.pose.pose.orientation.w = math.sin(point['yaw']/2),math.cos(point['yaw']/2)
                future = self.navigator.send_goal_async(goal)
                future.add_done_callback(lambda f,b=binding:self._goal_response(f,b))
        now = self.now()
        if now-self.last_lifecycle >= .5:
            self.last_lifecycle = now
            for name,client in self.lifecycle_clients.items():
                pending = self.lifecycle_pending.get(name)
                if pending is not None and pending.done():
                    self.lifecycle[name] = (pending.result().current_state.id == 3,now)
                    self.lifecycle_pending[name] = None
                if self.lifecycle_pending.get(name) is None and client.service_is_ready():
                    self.lifecycle_pending[name] = client.call_async(self.GetState.Request())
        ready = (self.navigator.server_is_ready() and self.map_identity and now-self.odom_at <= .2
                 and len(self.lifecycle) == len(LIFECYCLE_NODES)
                 and all(ok and now-at <= 1.5 for ok,at in self.lifecycle.values()))
        self.actions.health(ready)

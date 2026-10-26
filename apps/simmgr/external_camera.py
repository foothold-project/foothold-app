"""Independent episode camera and pure observer policy; no ROS/Gazebo imports."""
import math
import time
import xml.etree.ElementTree as ET

ENTITY = 'fh_external_camera'
WORLD = 'fh_v2_live'
SERVICE = '/world/' + WORLD + '/set_pose'
GZ_TOPIC = '/v2_live/gz/external_cam'
ROS_TOPIC = '/v2_live/external_cam/compressed'
DEFAULT_VIEW = (math.pi, .45, 3.0)
PERIOD = .1
TIMEOUT = .3


def add_camera(world):
    """Only mutate the generated episode world, after original sensor adaptation."""
    if (world.get('name') != WORLD or world.find(f"model[@name='{ENTITY}']") is not None
            or not any(p.get('filename') == 'gz-sim-user-commands-system' for p in world.findall('plugin'))):
        raise ValueError('external camera requires the cleared world and UserCommands')
    model = ET.fromstring(f'''<model name="{ENTITY}">
      <static>true</static><pose>-3 0 2 0 0.45 0</pose>
      <link name="camera_link"><gravity>false</gravity><kinematic>true</kinematic>
        <sensor name="external_camera" type="camera">
          <always_on>true</always_on><update_rate>5</update_rate><topic>{GZ_TOPIC}</topic>
          <camera><horizontal_fov>1.05</horizontal_fov>
            <image><width>320</width><height>240</height><format>R8G8B8</format></image>
            <clip><near>0.05</near><far>100</far></clip>
          </camera>
        </sensor>
      </link></model>''')
    world.append(model)


def episode_world(text):
    tree = ET.fromstring(text)
    world = tree.find('world')
    if world is None:
        raise ValueError('world missing')
    add_camera(world)
    return ET.tostring(tree, encoding='unicode') + '\n'


def camera_pose(position, view):
    """Gazebo camera looks along +X. Orbit is in world axes, pitch up from horizon."""
    x, y, z = position
    yaw, pitch, radius = view
    cp = math.cos(pitch)
    heading = math.atan2(-math.sin(yaw), -math.cos(yaw))
    # Positive SDF pitch points the camera down, towards the orbit centre.
    return (x + radius*cp*math.cos(yaw), y + radius*cp*math.sin(yaw),
            z + radius*math.sin(pitch), 0., pitch, heading)


class Observer:
    """One shared view, one pending request, monotonic sequence and bounded work."""
    def __init__(self, robot, episode, *, now=time.monotonic):
        self.robot, self.episode, self.now = robot, str(episode), now
        self.epoch = None
        self.seq = -1
        self.view = DEFAULT_VIEW
        self.pending = self.position = None
        self.status_at = self.pose_at = float('-inf')
        self.last_tick = float('-inf')

    def status(self, data):
        if str(data.get('run_id')) != self.episode.replace('-', ''):
            return
        epoch = data.get('epoch')
        if type(epoch) is not int or epoch < 1 or (self.epoch is not None and epoch < self.epoch):
            return
        if epoch != self.epoch:
            self.epoch, self.seq = epoch, -1
            self.pending = self.position = None
            self.view = DEFAULT_VIEW
        self.status_at = self.now()

    def state(self, data):
        if data.get('reset_in_progress') or data.get('episode') != self.epoch:
            self.position = self.pending = None
            return
        pos = tuple(data.get(k) for k in ('x', 'y', 'z'))
        if any(type(v) not in (float, int) or not math.isfinite(v) or abs(v) > 10000 for v in pos):
            self.position = None
            return
        self.position, self.pose_at = pos, self.now()

    def fresh(self):
        now = self.now()
        return (self.position is not None and 0 <= now-self.status_at <= 1
                and 0 <= now-self.pose_at <= .5)

    def submit(self, request, op='view'):
        # Contract validation is repeated at both the HTTP and child IPC boundary.
        from apps.contracts.models import ExternalCameraViewRequest
        r = ExternalCameraViewRequest.model_validate(request)
        if (str(r.robot) != self.robot or str(r.episode_id) != self.episode
                or r.epoch != self.epoch or not self.fresh()):
            raise ValueError('binding unavailable or stale')
        if r.seq <= self.seq or op not in ('view', 'reset', 'cancel'):
            raise ValueError('sequence or operation invalid')
        self.seq = r.seq
        self.pending = None if op == 'cancel' else (
            self.now(), DEFAULT_VIEW if op == 'reset' else (r.yaw, r.pitch, r.radius))
        return dict(accepted=True, shared=True, seq=self.seq, operation=op)

    def discard(self, request):
        """A lost relay ACK may discard only its own still-pending request."""
        from apps.contracts.models import ExternalCameraViewRequest
        r = ExternalCameraViewRequest.model_validate(request)
        if (str(r.robot) == self.robot and str(r.episode_id) == self.episode
                and r.epoch == self.epoch and r.seq == self.seq):
            self.pending = None
        return dict(accepted=True)

    def tick(self, send):
        now = self.now()
        if now-self.last_tick < PERIOD or not self.fresh():
            return False
        self.last_tick = now
        if self.pending is not None:
            at, view = self.pending
            self.pending = None
            if 0 <= now-at <= TIMEOUT:
                self.view = view
        return send(camera_pose(self.position, self.view))

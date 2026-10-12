#!/usr/bin/env python3
"""시험 전용 가짜 v2_live 발행기 — 앱 쪽(v2_link·live.js)만 시험한다. 실제 시뮬·정책의 근거가 아니다.
RL 실제 망(domain 61)과 섞이지 않게 domain 61 에서는 실행을 거부한다.
  ROS_DOMAIN_ID=88 ROS_AUTOMATIC_DISCOVERY_RANGE=LOCALHOST python3 tools/fake_v2_live.py [--camera] [--fall-after S]
state 는 계약 schema(v2_live/state/1) 모양을 따르지만 source="fake_kinematic" 이다(gz_gt 아님).
움직임: 받은 명령으로 1차 지연(시정수 1 s) 적분 — 정지 지연을 흉내 낼 뿐 실제 값이 아니다."""
import argparse, io, json, math, os, sys, time

if os.environ.get('ROS_DOMAIN_ID', '0') == '61':
    sys.exit('fake_v2_live: domain 61 은 RL 실제 망이다 — 다른 domain 에서만 실행')

import rclpy
from rclpy.node import Node
from rclpy.qos import QoSProfile
from geometry_msgs.msg import Twist
from std_msgs.msg import Empty, String
from sensor_msgs.msg import CompressedImage
from std_srvs.srv import Trigger

ap = argparse.ArgumentParser(); ap.add_argument('--camera', action='store_true'); ap.add_argument('--fall-after', type=float, default=0)
a = ap.parse_args()
rclpy.init(); n = Node('fake_v2_live')
S = {'x': 0.0, 'y': 0.0, 'yaw': 0.0, 'vx': 0.0, 'wz': 0.0, 'stop': False, 'resume_wait': False, 'cmd': [0.0, 0.0, 0.0],
     'rx': None, 'rx_t': None, 'ep': 0, 'fallen': False, 't0': time.monotonic(), 'still_since': time.monotonic()}


def on_cmd(m):
    S['rx'] = [m.linear.x, m.linear.y, m.angular.z]; S['rx_t'] = time.monotonic()
    if not S['stop']:
        S['cmd'] = list(S['rx']); S['resume_wait'] = False


def on_stop(_):
    S['stop'] = True; S['cmd'] = [0.0, 0.0, 0.0]


def on_resume(_):
    S['stop'] = False; S['resume_wait'] = True; S['cmd'] = [0.0, 0.0, 0.0]


def on_reset(_, res):
    S.update(x=0.0, y=0.0, yaw=0.0, vx=0.0, wz=0.0, stop=True, cmd=[0.0, 0.0, 0.0], fallen=False, t0=time.monotonic()); S['ep'] += 1
    res.success = True; res.message = f'fake reset episode {S["ep"]}'; return res


q = QoSProfile(depth=10)
n.create_subscription(Twist, '/v2_live/cmd_vel', on_cmd, q)
n.create_subscription(Empty, '/v2_live/stop', on_stop, q)
n.create_subscription(Empty, '/v2_live/resume', on_resume, q)
n.create_service(Trigger, '/v2_live/reset', on_reset)
pub = n.create_publisher(String, '/v2_live/state', q)
cam = n.create_publisher(CompressedImage, '/v2_live/camera/compressed', QoSProfile(depth=1))
DT = 0.1


def step():
    now = time.monotonic(); age = None if S['rx_t'] is None else now - S['rx_t']
    ttl = age is None or age > 0.5
    c = [0.0, 0.0, 0.0] if (ttl or S['stop'] or S['fallen']) else S['cmd']
    k = DT / 1.0
    S['vx'] += (c[0] - S['vx']) * k; S['wz'] += (c[2] - S['wz']) * k
    S['yaw'] += S['wz'] * DT; S['x'] += S['vx'] * math.cos(S['yaw']) * DT; S['y'] += S['vx'] * math.sin(S['yaw']) * DT
    if a.fall_after and not S['fallen'] and now - S['t0'] > a.fall_after:
        S['fallen'] = True; S['vx'] = S['wz'] = 0.0
    if abs(S['vx']) > 0.05 or abs(S['wz']) > 0.10:
        S['still_since'] = now
    d = {'schema': 'v2_live/state/1', 'wall_time': time.time(), 'mono_s': now, 'sim_t': now - S['t0'], 'episode': S['ep'], 'reset_in_progress': False,
         'stop_requested': S['stop'], 'resume_wait': S['resume_wait'], 'cmd_applied': c, 'cmd_last_rx': S['rx'], 'cmd_age_s': age, 'ttl_s': 0.5,
         'ttl_expired': ttl, 'cmd_tested': S['rx'] is None or [round(v, 3) for v in S['rx']] in ([0, 0, 0], [0.6, 0, 0], [0.6, 0, 0.5], [0.6, 0, -0.5]),
         'policy_running': True, 'plugin_mode': 'LOCKSTEP', 'fallback_active': False, 'x': S['x'], 'y': S['y'], 'z': 0.12 if S['fallen'] else 0.32,
         'yaw': S['yaw'], 'vx': S['vx'], 'vy': 0.0, 'wz': S['wz'], 'tilt_deg': 60.0 if S['fallen'] else 2.0, 'fallen': S['fallen'],
         'body_still': now - S['still_since'] >= 1.0, 'rtf': 1.0, 'source': 'fake_kinematic', 'terrain_input': 'none',
         'camera': 'fake' if a.camera else 'off', 'online_ready': False, 'safe_fallback_verified': False}
    pub.publish(String(data=json.dumps(d)))
    if a.camera:
        from PIL import Image, ImageDraw
        im = Image.new('RGB', (320, 240), (30, 40, 48)); dr = ImageDraw.Draw(im)
        dr.text((10, 10), f'FAKE CAMERA  x={S["x"]:.2f}  yaw={S["yaw"]:.2f}', fill=(255, 200, 80))
        b = io.BytesIO(); im.save(b, 'JPEG', quality=60)
        m = CompressedImage(); m.format = 'jpeg'; m.data = b.getvalue(); cam.publish(m)


n.create_timer(DT, step)
print('fake_v2_live domain', os.environ.get('ROS_DOMAIN_ID'), flush=True)
try:
    rclpy.spin(n)
except KeyboardInterrupt:
    pass

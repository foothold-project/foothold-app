"""Synthetic only: no participant, ROS process, SDK, robot or simulator."""
import asyncio
import base64
from datetime import datetime, timezone
from http.client import HTTPConnection
import json
import os
import re
import subprocess
import struct
import sys
import threading
import time
from types import SimpleNamespace as NS
from uuid import uuid4

# opencv-python's Qt bootstrap mutates LD_LIBRARY_PATH on import. Preserve the
# test runner's loader environment so unrelated SDK gate tests remain isolated.
_loader_path = os.environ.get('LD_LIBRARY_PATH')
import cv2
if _loader_path is None:
    os.environ.pop('LD_LIBRARY_PATH', None)
else:
    os.environ['LD_LIBRARY_PATH'] = _loader_path
import numpy as np
import pytest

from apps.contracts.models import MediaVideoFrame
from foothold_agent.depth.convert import raw_depth, compressed_depth, colour, MAX_BYTES
from foothold_agent.depth.discovery import image_topics, choose, notice, IMAGE, COMPRESSED, EMPTY
from foothold_agent.depth.source import Source, Publisher
from foothold_agent.setup.view import Status, make_server, PAGE


def raw(values=None, *, encoding='16UC1', big=False, padding=0):
    values = np.array([[0, 200, 1000], [2000, 5000, 8000]], dtype=np.uint16) if values is None else np.asarray(values)
    dtype = ('>' if big else '<')+('u2' if encoding == '16UC1' else 'f4')
    values = values.astype(dtype)
    h, w = values.shape
    return NS(width=w, height=h, encoding=encoding, step=w*values.itemsize+padding,
        is_bigendian=int(big), data=b''.join(row.tobytes()+b'\0'*padding for row in values),
        header=NS(frame_id='depth_optical_frame', stamp=NS(sec=1, nanosec=1)))


def compressed(values=None, *, encoding='16UC1', transport=True):
    values = np.array([[0, 200, 1000], [2000, 5000, 8000]], dtype=np.uint16) if values is None else np.asarray(values, dtype=np.uint16)
    ok, png = cv2.imencode('.png', values)
    assert ok
    return NS(format=encoding+('; compressedDepth png' if transport else '; png compressed'),
              data=(struct.pack('<iff', 0, 100., 0.) if transport else b'')+png.tobytes(),
              header=raw().header)


@pytest.mark.parametrize('encoding,big,padding', [('16UC1', False, 0), ('16UC1', True, 6),
    ('32FC1', False, 8), ('32FC1', True, 0)])
def test_raw_metric_endian_and_stride(encoding, big, padding):
    metres = np.array([[0., .2, 1.], [2., 5., 8.]])
    message = raw(metres*1000 if encoding == '16UC1' else metres, encoding=encoding, big=big, padding=padding)
    assert np.allclose(raw_depth(message), metres)
    header, payload = colour(message, .2, 5.)
    assert payload is None and header['depth_min_m'] == .2 and header['depth_max_m'] == 5.
    header.update(channel='depth', version='media/1', robot=str(uuid4()), epoch=1, episode_id=None,
                  seq=1, captured_at=datetime.now(timezone.utc).isoformat())
    MediaVideoFrame.model_validate(header)


def test_jpeg_bounds_colours_and_invalid_pixels():
    rng = np.random.default_rng(123)
    header, _ = colour(raw(rng.uniform(0, 15, (1080, 1920)), encoding='32FC1'))
    jpeg = base64.b64decode(header['jpeg'])
    assert len(jpeg) <= 65536 and (header['width'], header['height']) == (640, 360)
    decoded = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR)
    assert decoded.shape == (360, 640, 3)
    # Wide blocks make JPEG bleed irrelevant; invalid values stay black.
    image = np.repeat(np.array([[.2, 5., 0., -1., np.nan, np.inf]], np.float32), 32, axis=0)
    image = np.repeat(image, 32, axis=1)
    header, _ = colour(raw(image, encoding='32FC1'))
    decoded = cv2.imdecode(np.frombuffer(base64.b64decode(header['jpeg']), np.uint8), cv2.IMREAD_COLOR)
    near, far = decoded[16, 16], decoded[16, 48]
    assert near[2] > near[0] and far[0] > far[2]
    assert np.max(decoded[16, [80, 112, 144, 176]]) < 10


@pytest.mark.parametrize('transport', [False, True])
def test_compressed_16_bit_depth_png(transport):
    message = compressed(transport=transport)
    assert np.allclose(compressed_depth(message), raw_depth(raw()))
    header, _ = colour(message)
    assert header['source'] == 'go2_depth'


def test_compressed_float_inverse_depth():
    message = compressed([[0, 100, 50]], encoding='32FC1')
    result = compressed_depth(message)
    assert np.isnan(result[0, 0]) and result[0, 1] == 1 and result[0, 2] == 2
    assert colour(message)[0]['depth_max_m'] == 5


@pytest.mark.parametrize('case', ['rgb', 'step', 'length', 'big', 'raster', 'maxbytes', 'range', 'reversed'])
def test_invalid_raw_or_range_rejected(case):
    message = raw()
    if case == 'rgb': message.encoding = 'rgb8'
    elif case == 'step': message.step = 1
    elif case == 'length': message.data = b'x'
    elif case == 'big': message.is_bigendian = True
    elif case == 'raster': message.width = 20000
    elif case == 'maxbytes': message.data = b'\0'*(MAX_BYTES+1)
    with pytest.raises(ValueError):
        colour(message, float('nan') if case == 'range' else 5. if case == 'reversed' else .2, 5.)


@pytest.mark.parametrize('case', ['rgb', 'rvl', 'empty', 'huge-raster', 'colour-png', 'float-no-header', 'parameters', 'truncated'])
def test_compressed_cannot_claim_colour_or_unbounded_raster(case, monkeypatch):
    message = compressed()
    if case == 'rgb': message.format = 'rgb8; jpeg compressed bgr8'
    elif case == 'rvl': message.format = '16UC1; compressedDepth rvl'
    elif case == 'empty': message.format = ''
    elif case == 'huge-raster':
        message.data = message.data[:28]+struct.pack('>II', 999999, 999999)+message.data[36:]
        monkeypatch.setattr(cv2, 'imdecode', lambda *_: pytest.fail('must check IHDR before native decode'))
    elif case == 'colour-png':
        message.data = message.data[:12]+cv2.imencode('.png', np.zeros((8, 8, 3), np.uint8))[1].tobytes()
    elif case == 'float-no-header': message = compressed(encoding='32FC1', transport=False)
    elif case == 'parameters': message = compressed(encoding='32FC1'); message.data = struct.pack('<iff', 0, float('inf'), 0)+message.data[12:]
    elif case == 'truncated': message.data = b'bad'
    with pytest.raises(ValueError): colour(message)


def endpoints(*names):
    return [NS(topic_name=name, type_name=kind) for name, kind in names]


def test_discovery_only_filter_default_candidates_and_explicit_choice():
    rows = image_topics(endpoints(('rt/lowstate', 'unitree_go::msg::dds_::LowState_'),
        ('rt/camera/depth/image_rect_raw', IMAGE), ('rt/camera/rgb/image_raw', IMAGE),
        ('rt/other/depth/compressedDepth', COMPRESSED), ('rt/camera/info', 'sensor_msgs::msg::dds_::CameraInfo_')))
    assert len(rows) == 4 and all(row['name'] != 'rt/lowstate' for row in rows)
    assert choose(rows)['name'] == 'rt/camera/depth/image_rect_raw'
    assert choose(rows, '/other/depth/compressedDepth')['type'] == COMPRESSED
    assert choose(rows, 'rt/camera/info') is None
    assert choose(rows, '/not/discovered') is None
    assert image_topics([NS(topic_name='x'*257, type_name=IMAGE)]) == []
    assert notice([], None) == EMPTY and '확장 장치' in EMPTY
    assert '고르세요' in notice(rows, None)
    ambiguous = image_topics(endpoints(('rt/a/depth/image', IMAGE), ('rt/b/depth/image', IMAGE)))
    assert choose(ambiguous) is None
    assert choose(image_topics(endpoints(('rt/custom/depth', IMAGE))))['name'] == 'rt/custom/depth'


def test_native_discovery_boundary_reads_only_publication_metadata(monkeypatch):
    from foothold_agent.depth.discovery import Discovery, shared_participant
    made=[]; publication=object()
    camera=endpoints(('rt/custom/depth',IMAGE))[0]
    camera.key='fake-camera'; camera.sample_info=NS(valid_data=True,instance_state=1)
    # Unrelated robot publishers cannot consume the bounded camera inventory.
    values=[NS(topic_name=f'rt/state{i}',type_name='State',key=str(i),
        sample_info=NS(valid_data=True,instance_state=1)) for i in range(64)]
    class Builtin:
        def __init__(self, participant, topic): made.append((participant,topic))
        def take(self, count): assert count==64; return values
    monkeypatch.setitem(sys.modules,'cyclonedds.builtin',NS(BuiltinDataReader=Builtin,BuiltinTopicDcpsPublication=publication))
    monkeypatch.setitem(sys.modules,'cyclonedds.core',NS(InstanceState=NS(Alive=1)))
    factory=NS(_ChannelFactory__initialized=True,_ChannelFactory__participant='existing-domain-zero-nic-participant')
    monkeypatch.setitem(sys.modules,'unitree_sdk2py.core.channel',NS(ChannelFactory=lambda:factory))
    assert shared_participant()=='existing-domain-zero-nic-participant'
    discovery=Discovery(shared_participant())
    assert discovery.poll()==[] and discovery.endpoints=={}
    values=[camera]
    assert len(discovery.poll())==1
    assert made==[('existing-domain-zero-nic-participant',publication)]
    camera.sample_info=NS(valid_data=False,instance_state=2)
    assert discovery.poll()==[]  # disposed publisher must disappear
    discovery.close()
    factory._ChannelFactory__initialized=False
    with pytest.raises(RuntimeError):shared_participant()


def test_laptop_projection_selection_and_request_boundaries():
    status = Status()
    rows = image_topics(endpoints(('rt/custom/depth', IMAGE), ('rt/camera/info', 'CameraInfo')))
    status.update(depth_topics=rows, depth_notice=EMPTY, depth_selected=None)
    assert '보이는 영상 목록' in PAGE and 'textContent=row.name' in PAGE
    server = make_server(status, 0)
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    port = server.server_port
    def post(value, origin=None, host=None):
        conn = HTTPConnection('127.0.0.1', port, timeout=1)
        conn.request('POST', '/depth-topic', json.dumps(value), headers={
            'Host': host or f'127.0.0.1:{port}', 'Origin': origin or f'http://127.0.0.1:{port}',
            'Content-Type': 'application/json'})
        response = conn.getresponse(); code = response.status; response.read(); conn.close(); return code
    try:
        assert post({'topic':'rt/custom/depth'}) == 204
        assert status.depth_choice() == 'rt/custom/depth'
        assert post({'topic':'rt/unknown'}) == 400
        assert post({'topic':'rt/camera/info'}) == 400
        assert post({'topic':'x'*2000}) == 400
        assert post({'topic':None}, origin='https://untrusted.invalid') == 403
        assert post({'topic':None}, host='attacker.invalid') == 403
        assert post({'topic':None}) == 204 and status.depth_choice() is None
    finally:
        server.shutdown(); server.server_close(); thread.join(timeout=1)


def test_laptop_script_compiles_without_network_or_dds():
    script=re.search(r'<script>(.*?)</script>',PAGE,re.S).group(1)
    result=subprocess.run(['node','--check'],input=script,capture_output=True,text=True)
    assert result.returncode==0,result.stderr


@pytest.mark.parametrize('sensor_stamp',['increasing','zero'])
def test_selected_source_freshness_switch_and_shutdown_without_native_dds(sensor_stamp):
    rows = image_topics(endpoints(('rt/custom/depth', IMAGE), ('rt/second/depth', IMAGE)))
    status = Status(); status.update(depth_topics=rows); status.select_depth('rt/custom/depth')
    created = []; closed = []
    class Discovery:
        def __init__(self, participant): assert participant == 'fake'
        def poll(self): return rows
        def close(self): closed.append('discovery')
    class Images:
        def __init__(self, participant, selected): self.count=0; self.selected=selected['name']; created.append(self.selected)
        def take(self):
            self.count += 1
            message=raw(); message.header.stamp.sec=self.count
            if sensor_stamp=='zero':message.header.stamp=NS(sec=0,nanosec=0)
            return [message]
        def close(self): closed.append(self.selected)
    source=Source(NS(robot=str(uuid4())), status=status, participant=lambda:'fake', discovery=Discovery, images=Images)
    source.start()
    try:
        deadline=time.monotonic()+2
        while source.sample('depth') is None and time.monotonic()<deadline: time.sleep(.005)
        item=source.sample('depth'); assert item is not None
        MediaVideoFrame.model_validate(item[1])
        assert item[1]['channel']=='depth' and source.sample('rgb') is None
        status.select_depth('rt/second/depth')
        deadline=time.monotonic()+2
        while len(created)<2 and time.monotonic()<deadline: time.sleep(.005)
        assert created==['rt/custom/depth','rt/second/depth']
        assert 'rt/custom/depth' in closed
        source.now=lambda:item[0]+2
        assert source.sample('depth') is None
    finally:
        source.close(); source.thread.join(timeout=1)
    assert 'discovery' in closed


def test_depth_codec_stall_never_waits_on_input_watchdog_or_stop(monkeypatch):
    from test_go2_server_drive import rig
    import foothold_agent.depth.source as module
    gate=threading.Event(); entered=threading.Event()
    def blocked(*args): entered.set(); gate.wait(2); return colour(*args)
    monkeypatch.setattr(module, 'colour', blocked)
    class Discovery:
        def __init__(self, *_): pass
        def poll(self): return image_topics(endpoints(('rt/custom/depth',IMAGE)))
        def close(self): pass
    class Images:
        def __init__(self,*_): pass
        def take(self): return [raw()]
        def close(self): pass
    source=Source(NS(robot=str(uuid4())),participant=lambda:'fake',discovery=Discovery,images=Images)
    now,sink,normal,emergency,session,client,measured,frame=rig()
    async def scenario():
        source.start()
        try:
            async with asyncio.timeout(.5):
                while not entered.is_set(): await asyncio.sleep(.001)
            for seq in range(1,21):
                now.value+=.05; measured(); frame('cmd',lease_id='fake-lease',seq=seq,axes=[0,0,0]);sink.drain()
                assert not sink.check_watchdog() and not sink.latched
                await asyncio.sleep(.002)
            frame('stop',stop_ref=42)
            assert sink.latched and emergency.calls[-1]==('StopMove',())
            before=time.monotonic(); source.close(); assert time.monotonic()-before<.05
        finally: gate.set();source.close()
    asyncio.run(scenario()); source.thread.join(timeout=1)


@pytest.mark.parametrize('case',['missing-range','equal','nan','source','rgb-with-depth','episode'])
def test_contract_rejects_fake_or_unlabelled_depth(case):
    header=colour(raw())[0]
    header.update(channel='depth',version='media/1',robot=str(uuid4()),epoch=1,episode_id=None,
                  seq=1,captured_at=datetime.now(timezone.utc).isoformat())
    if case=='missing-range': del header['depth_min_m']
    elif case=='equal': header['depth_min_m']=header['depth_max_m']
    elif case=='nan': header['depth_max_m']=float('nan')
    elif case=='source': header['source']='go2_front'
    elif case=='rgb-with-depth': header.update(channel='rgb',source='go2_front')
    elif case=='episode': header['episode_id']=str(uuid4())
    with pytest.raises(ValueError): MediaVideoFrame.model_validate(header)

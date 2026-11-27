"""Isolated GLIM DDS deserialization; only bounded JSON datagrams reach the agent."""
import json
import multiprocessing
import os
import socket
import threading
import time

from .live import GlimLive
from foothold_agent.slam_source import Source

MAX_PACKET = 32768
WAIT_SECONDS = 3


def dds_subscribe(source, nic, callback):
    # Spawn, never fork an initialized DDS participant or the safety threads.
    from unitree_sdk2py.core.channel import ChannelFactoryInitialize
    from .inputs import CloudBus
    if os.name == 'nt':
        from pathlib import Path
        from xml.sax.saxutils import escape
        import sys
        module = sys.modules[ChannelFactoryInitialize.__module__]
        directory = Path(os.environ['LOCALAPPDATA'])/'foothold/cache'
        directory.mkdir(parents=True, exist_ok=True)
        module.ChannelConfigHasInterface = module.ChannelConfigHasInterface.replace(
            '/tmp/cdds.LOG', escape(str(directory/'cdds.LOG')))
    ChannelFactoryInitialize(0, nic)
    bus = CloudBus()
    bus.subscribe(source.cloud_topic, callback)
    return bus.close


def preview_worker(output, env, nic, subscribe=dds_subscribe):
    """SDK callback, raw message and even rejected oversize decoding stay here."""
    source = Source(env, 'glim')
    live = GlimLive(source, time.monotonic)
    lock = threading.Lock()
    latest = None
    next_send = float('-inf')
    close = None
    output.setblocking(False)
    try:
        if hasattr(os, 'nice'):
            os.nice(10)

        def receive(message):
            nonlocal latest
            with lock:
                latest = time.monotonic(), message

        close = subscribe(source, nic, receive)
        while True:
            # No unbounded raw-message queue or raw bytes in parent IPC.
            with lock:
                sample, latest = latest, None
            at = time.monotonic()
            if sample is not None and at >= next_send:
                next_send = at+1
                before = live.seq
                live.update({source.cloud_topic: sample}, float('-inf'))
                packet = dict(received=sample[0], preview=live.preview if live.seq != before else None,
                              reason=None if live.seq != before else 'GLIM 미리보기 자료를 해석하지 못했습니다.')
                data = json.dumps(packet, allow_nan=False, separators=(',', ':')).encode()
                if len(data) <= MAX_PACKET:
                    try:
                        output.send(data)
                    except BlockingIOError:
                        pass  # Full socket drops the preview, never stalls DDS.
            time.sleep(.02)
    finally:
        if close is not None:
            close()
        output.close()


def reap(process):
    process.join(1)
    if process.is_alive():
        process.kill()
        process.join(1)
    if not process.is_alive():
        process.close()


class GlimPreviewProcess:
    def __init__(self, env, now=time.monotonic):
        # Only source configuration crosses spawn, never credentials or channel.
        self.env = {k: v for k, v in env.items() if k.startswith('FH_MAPPING_GLIM_')}
        self.now = now
        self.process = self.input = None
        self.reason = None
        self.started = self.last_packet = None

    def start(self, nic, *, subscribe=dds_subscribe):
        if self.process is not None or not self.env.get('FH_MAPPING_GLIM_CLOUD_TOPIC'):
            return
        if not nic:
            self.reason = 'GLIM 미리보기 네트워크 설정을 확인하지 못했습니다.'
            return
        parent, child = socket.socketpair(type=socket.SOCK_DGRAM)
        parent.setblocking(False)
        try:
            process = multiprocessing.get_context('spawn').Process(
                target=preview_worker, args=(child, self.env, nic, subscribe),
                name='glim-preview', daemon=True)
            process.start()
        except Exception:
            parent.close()
            self.reason = 'GLIM 미리보기 작업자를 시작하지 못했습니다.'
            return
        finally:
            child.close()
        self.input, self.process, self.started = parent, process, self.now()
        self.reason = None

    def poll(self, live, not_before):
        process, receiver = self.process, self.input
        if process is None or receiver is None:
            return
        try:
            alive = process.is_alive()
        except ValueError:
            return  # Concurrent permission-loss cleanup has already reaped it.
        if not alive:
            self.reason = 'GLIM 미리보기 작업자가 종료됐습니다.'
            return
        # At most one small datagram per mapping tick, never a blocking recv.
        try:
            packet = json.loads(receiver.recv(MAX_PACKET))
        except BlockingIOError:
            packet = None
        except (OSError, ValueError):
            self.reason = 'GLIM 미리보기 전달 자료를 읽지 못했습니다.'
            return
        if packet is not None:
            self.last_packet = packet['received']
            if packet['received'] >= not_before and 0 <= self.now()-packet['received'] <= WAIT_SECONDS:
                self.reason = packet['reason']
                if packet['preview'] is not None:
                    live.preview = packet['preview']
                    live.seq = live.preview['seq']
                    live.last_data = packet['received']
        if self.now()-(self.last_packet if self.last_packet is not None else self.started) > WAIT_SECONDS:
            self.reason = 'GLIM 미리보기 자료가 늦어 기다리는 중입니다.'

    def close(self):
        process, self.process = self.process, None
        if self.input is not None:
            self.input.close()
            self.input = None
        if process is not None:
            if process.is_alive():
                process.terminate()
            # Close is also called on the event loop: reap away from control.
            threading.Thread(target=reap, args=(process,), name='glim-preview-reap', daemon=True).start()

"""Bounded receive-only hardware observation sockets, separate from control I/O."""
import asyncio
import base64
from concurrent.futures import ThreadPoolExecutor
from contextlib import suppress
import hmac
import json
import time
from uuid import UUID, uuid4

from fastapi import WebSocket, Request, HTTPException
from fastapi.responses import JSONResponse
from pydantic import TypeAdapter
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from apps.contracts import models as C
from .models import Robot, now
from .security import digest

FRAME = TypeAdapter(C.MediaMessage)
CHANNELS = ('rgb', 'lidar')
MAX_JSON = 90_000


def jpeg_dimensions(data):
    """Bound JPEG raster metadata before sending it to a browser decoder."""
    at = 2
    size = None
    while at+4 <= len(data):
        if data[at] != 255:
            break
        while at < len(data) and data[at] == 255:
            at += 1
        if at+3 > len(data):
            break
        marker = data[at]
        at += 1
        if marker == 0xDA:
            if size is not None:
                return size
            break
        if marker in (0xD8, 0xD9):
            break
        length = int.from_bytes(data[at:at+2], 'big')
        if length < 2 or at+length > len(data):
            break
        if marker in (0xC0, 0xC1, 0xC2) and length >= 8:
            if size is not None:
                raise ValueError('multiple JPEG frame headers')
            size = int.from_bytes(data[at+5:at+7], 'big'), int.from_bytes(data[at+3:at+5], 'big')
        at += length
    raise ValueError('JPEG raster dimensions unavailable')


class Relay:
    def __init__(self, rt):
        self.rt = rt
        self.engine = create_engine(rt.settings.database_url, pool_size=2, max_overflow=0, pool_timeout=.2,
            connect_args={'options':'-c default_transaction_read_only=on -c statement_timeout=1500', 'connect_timeout':1})
        self.factory = sessionmaker(self.engine, expire_on_commit=False)
        self.executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix='fh-drive-media')
        self.pending = 0
        self.publishers, self.viewers, self.latest = {}, {}, {}
        self.sockets = set()

    async def read(self, function, *args):
        async with asyncio.timeout(2):
            return await asyncio.get_running_loop().run_in_executor(self.executor, function, *args)

    def eligible(self, rid):
        if UUID(rid) not in self.rt.settings.server_drive_robots:
            raise ValueError('trial disabled')
        with self.factory() as db:
            row = db.get(Robot, UUID(rid))
            if row is None or row.org_id != self.rt.settings.org_id or row.archived_at or row.simulation is True:
                raise ValueError('physical trial unavailable')

    def viewer_auth(self, headers, cookies, rid):
        actor = self.rt.identity(headers, cookies, 'drive-media-'+str(uuid4()), factory=self.factory)
        self.rt.access(actor, [rid], 'ROBOT_READ', factory=self.factory)
        self.eligible(rid)

    def agent_auth(self, headers):
        raw = headers.get('authorization', '')
        if not raw.startswith('Bearer ') or not raw[7:]:
            raise ValueError('agent authentication required')
        with self.factory() as db:
            rows = db.scalars(select(Robot).where(Robot.org_id == self.rt.settings.org_id,
                Robot.id.in_(self.rt.settings.server_drive_robots), Robot.archived_at.is_(None),
                Robot.simulation.is_(False))).all()
            matching = [str(row.id) for row in rows if hmac.compare_digest(row.agent_token_hash or b'', digest(raw[7:]))]
        if len(matching) != 1:
            raise ValueError('agent authentication rejected')
        return matching[0]

    @staticmethod
    def status(rid, channel, reason, epoch=0):
        return dict(t='media.status', version='media/1', robot=rid, epoch=epoch, episode_id=None,
                    channel=channel, state='NO_POINTS' if channel == 'lidar' else 'NO_VIDEO', reason=reason)

    def publish(self, key, header, payload=None):
        item = time.monotonic(), header, payload
        self.latest[key] = item
        for queue in tuple(self.viewers.get(key, ())):
            if queue.full():
                queue.get_nowait()
            queue.put_nowait(item)

    async def monitor(self, ws, check):
        while True:
            await asyncio.sleep(.5)
            await check()

    async def run_tasks(self, tasks):
        tasks = [asyncio.create_task(coro) for coro in tasks]
        try:
            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                task.result()
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

    async def upload(self, request: Request, channel: str):
        authenticated = False
        self.pending += 1
        try:
            if self.pending > 16 or channel not in CHANNELS or not self.rt.settings.server_drive_robots:
                raise HTTPException(403)
            rid = await self.read(self.agent_auth, request.headers)
            authenticated = True
            raw = bytearray()
            async with asyncio.timeout(1):
                async for chunk in request.stream():
                    raw.extend(chunk)
                    if len(raw) > 100_000:
                        raise HTTPException(413)
            body = json.loads(raw)
            if not isinstance(body, dict) or set(body) != {'header', 'points'}:
                raise ValueError('observation envelope required')
            msg = FRAME.validate_python(body['header'])
            key = rid, channel
            if str(msg.robot) != rid or msg.channel != channel or msg.episode_id is not None:
                raise ValueError('media binding mismatch')
            previous = self.publishers.get(key)
            stamp = time.monotonic()
            if previous is not None and stamp-previous[2] < .2:
                raise HTTPException(429)
            seq = previous[1] if previous and previous[0] == msg.epoch else -1
            payload = None
            if msg.t != 'media.status':
                if msg.seq <= seq or not -1 <= (now()-msg.captured_at).total_seconds() <= 1:
                    raise ValueError('stale or replayed media')
                seq = msg.seq
                if msg.t == 'media.points':
                    if msg.frame != 'lidar_link' or not isinstance(body['points'],str) or len(body['points']) > 64000:
                        raise ValueError('bounded hardware sensor frame required')
                    payload = base64.b64decode(body['points'], validate=True)
                    if base64.b64encode(payload).decode('ascii') != body['points']:
                        raise ValueError('canonical point encoding required')
                    msg.validate_payload(payload)
                else:
                    if body['points'] is not None or msg.source != 'go2_front':
                        raise ValueError('hardware front camera required')
                    if jpeg_dimensions(base64.b64decode(msg.jpeg, validate=True)) != (msg.width, msg.height):
                        raise ValueError('JPEG raster differs from header')
            elif body['points'] is not None:
                raise ValueError('status cannot carry data')
            self.publishers[key] = msg.epoch, seq, stamp
            self.publish(key, msg.model_dump(mode='json'), payload)
            return JSONResponse({'accepted':True}, status_code=202)
        except HTTPException:
            raise
        except (ValueError, TypeError, OverflowError):
            raise HTTPException(400 if authenticated else 403) from None
        except Exception:
            raise HTTPException(503) from None
        finally:
            self.pending -= 1

    async def viewer(self, ws: WebSocket, robot_id: str, channel: str):
        queue = None
        key = robot_id, channel
        self.pending += 1
        try:
            if self.pending > 16 or channel not in CHANNELS or len(self.viewers.get(key, ())) >= 4:
                raise ValueError('capacity or channel')
            if not ws.headers.get('authorization'):
                expected = self.rt.settings.ws_origin or str(ws.base_url).rstrip('/').replace('wss:', 'https:').replace('ws:', 'http:')
                if not ws.headers.get('origin') or ws.headers['origin'] not in (expected, self.rt.settings.tunnel_origin):
                    raise ValueError('origin rejected')
            async def check():
                await self.read(self.viewer_auth, ws.headers, ws.cookies, robot_id)
            await check()
            await ws.accept()
            self.sockets.add(ws)
            queue = asyncio.Queue(maxsize=1)
            self.viewers.setdefault(key, set()).add(queue)
            item = self.latest.get(key)
            queue.put_nowait(item if item and time.monotonic()-item[0] <= 1 else
                (time.monotonic(), self.status(*key, 'No fresh source sample within 1 second'), None))
            async def reject_input():
                await ws.receive()
                raise ValueError('observation socket is receive-only')
            await self.run_tasks([self.frames(ws, key, queue), self.monitor(ws, check), reject_input()])
        except Exception:
            with suppress(Exception):
                await ws.close(code=4403)
        finally:
            self.pending -= 1
            self.sockets.discard(ws)
            if queue is not None:
                self.viewers[key].discard(queue)
                if not self.viewers[key]:
                    self.viewers.pop(key)

    async def frames(self, ws, key, queue):
        while True:
            try:
                received, header, payload = await asyncio.wait_for(queue.get(), 1)
            except asyncio.TimeoutError:
                received, header, payload = 0, None, None
            if time.monotonic()-received > 1:
                old = self.latest.get(key)
                epoch = old[1]['epoch'] if old else 0
                header, payload = self.status(*key, 'No fresh source sample within 1 second', epoch=epoch), None
            await asyncio.wait_for(ws.send_json(header), .2)
            if payload is not None:
                await asyncio.wait_for(ws.send_bytes(payload), .2)

    async def close(self):
        async def close_socket(ws):
            with suppress(Exception):
                await asyncio.wait_for(ws.close(code=1001), .2)
        await asyncio.gather(*(close_socket(ws) for ws in tuple(self.sockets)))
        self.executor.shutdown(wait=False, cancel_futures=True)
        self.engine.dispose()


def install(app, rt):
    rt.drive_media = Relay(rt)
    app.add_api_route('/api/v1/agent/drive-media/{channel}', rt.drive_media.upload, methods=['POST'])
    app.add_api_websocket_route('/api/v1/robots/{robot_id}/drive-media/{channel}', rt.drive_media.viewer)

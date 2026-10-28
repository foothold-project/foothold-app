"""Authenticated control-server transport on loopback only; no phone credentials."""
from contextlib import asynccontextmanager
import asyncio
import hmac
import os
from uuid import UUID, uuid4

from fastapi import Depends, FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.exceptions import RequestValidationError

from apps.contracts import models as C
from .service import Manager, SimError
from .preflight import ResourceGateError, startup_preflight
from .deploy_guard import DeploymentLease
from .launcher import CleanupUnconfirmed


def create_app(settings, launcher=None):
    manager = Manager(settings, launcher)

    @asynccontextmanager
    async def lifespan(app):
        lease = DeploymentLease(os.environ.get('FH_SIM_DEPLOY_GUARD_DIR'))
        lease.acquire()
        clean = False
        try:
            app.state.preflight = await asyncio.to_thread(startup_preflight, settings.real)
            app.state.instance_id = uuid4()
            app.state.ready = True
            try:
                yield
            finally:
                app.state.ready = False
                await manager.close()
                # close_world includes the existing full native cleanup proof.
                clean = not manager.failed and not getattr(manager.launcher, 'failure', False)
        finally:
            app.state.ready = False
            lease.release(clean)

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.manager = manager
    app.state.ready = False

    def authenticate(request: Request):
        if not app.state.ready:
            raise SimError('SIM_UNAVAILABLE', 503)
        supplied = request.headers.get('authorization', '')
        if not hmac.compare_digest(supplied, 'Bearer ' + settings.secret):
            raise SimError('SIM_AUTH_REQUIRED', 401)
        if request.client and request.client.host not in ('127.0.0.1',):
            raise SimError('SIM_LOOPBACK_ONLY', 403)

    @app.middleware('http')
    async def limit_body(request, call_next):
        # Bound reception even for chunked requests, before model validation.
        try:
            authenticate(request)
        except SimError as error:
            return JSONResponse(status_code=error.status, content={'error': {'code': error.code, 'detail': error.detail}})
        async def bounded_body():
            total, chunks = 0, []
            async for chunk in request.stream():
                total += len(chunk)
                if total > 4096:
                    raise SimError('SIM_BODY_TOO_LARGE', 413)
                chunks.append(chunk)
            return b''.join(chunks)
        try:
            request._body = await asyncio.wait_for(bounded_body(), 3)
        except asyncio.TimeoutError:
            return JSONResponse(status_code=408, content={'error': {'code': 'SIM_BODY_TIMEOUT'}})
        except SimError as error:
            return JSONResponse(status_code=error.status, content={'error': {'code': error.code, 'detail': error.detail}})
        return await call_next(request)

    @app.exception_handler(SimError)
    async def sim_error(request, exc):
        return JSONResponse(status_code=exc.status, content={'error': {'code': exc.code, 'detail': exc.detail}})

    @app.exception_handler(ResourceGateError)
    async def resources_low(request, exc):
        return JSONResponse(status_code=503, content={'error': {'code': 'SIM_UNAVAILABLE',
            'detail': {'reason': 'resources_low'}}})

    @app.exception_handler(RequestValidationError)
    async def invalid(request, exc):
        return JSONResponse(status_code=400, content={'error': {'code': 'SIM_VALIDATION'}})

    @app.exception_handler(Exception)
    async def failed(request, exc):
        return JSONResponse(status_code=503, content={'error': {'code': 'SIM_UNAVAILABLE', 'detail': {'reason': 'unknown'}}})

    @app.exception_handler(CleanupUnconfirmed)
    async def cleanup_unconfirmed(request, exc):
        return JSONResponse(status_code=409, content={'error': {'code': exc.code, 'detail': {'reason': 'unknown'}}})

    @app.get('/v1/worlds', dependencies=[Depends(authenticate)], response_model=C.SimCatalog)
    def worlds(org_id: str):
        items = []
        for w in settings.worlds.values():
            if w.id.startswith('v5_building/'):
                if any(item['id'] == 'v5_building' for item in items):
                    continue
                items.append(dict(id='v5_building', name='연결 건물', description=w.description,
                    spawn_floor_ids=[f for f in ('l1', 'l2') if 'v5_building/' + f in settings.worlds]))
            else:
                items.append(dict(id=w.id, name=w.name, description=w.description))
        return dict(worlds=items,
                    slots=[rid for rid, slot in settings.slots.items() if slot.org_id == org_id],
                    max_robots=1 if manager.launcher.real else settings.max_robots,
                    manager_instance_id=app.state.instance_id,
                    launcher='native-single' if manager.launcher.real else 'fake')

    @app.post('/v1/worlds', dependencies=[Depends(authenticate)])
    async def world(body: C.SimWorldStart):
        await manager.start_world(body.world_id, body.spawn_floor_id)
        return {'ok': True}

    @app.get('/v1/robots', dependencies=[Depends(authenticate)], response_model=C.SimRobotList)
    async def robots(org_id: str):
        return {'items': await manager.listing(org_id), 'expired': manager.completions(org_id)}

    @app.post('/v1/robots', dependencies=[Depends(authenticate)], response_model=C.SimRobot)
    async def add(body: C.SimProvision):
        return await manager.add(body.world_id, str(body.robot_id), str(body.owner_id), str(body.org_id), body.agent_token, body.generation, body.spawn_floor_id,
                                 [b.model_dump(mode='json') for b in body.map_bindings])

    @app.delete('/v1/robots/{robot_id}', dependencies=[Depends(authenticate)])
    async def remove(robot_id: UUID, body: C.SimRemove):
        absent = await manager.remove(str(robot_id), body.generation)
        return C.SimRemoval(robot_id=robot_id, generation=body.generation,
                            request_nonce=body.request_nonce,
                            manager_instance_id=app.state.instance_id, absent=absent,
                            startup_clean=app.state.preflight.get('resources_ok') is True
                            and not manager.failed and not manager.closing
                            and not getattr(manager.launcher, 'failure', False))

    async def observer_request(robot_id, body, op):
        from .external_camera import log_ipc_failure
        # Only the authenticated control server calls this relay. It must check
        # the user's current view grant before each call (and cancel on revoke).
        row = manager.robots.get(str(robot_id))
        if str(body.robot) != str(robot_id):
            log_ipc_failure('http_binding')
            raise SimError('SIM_OBSERVER_BINDING', 409)
        if (row is None or row.state != 'RUNNING' or manager.closing or manager.failed
                or not hasattr(manager.launcher, 'external_view')):
            log_ipc_failure('http_unavailable')
            raise SimError('SIM_OBSERVER_UNAVAILABLE', 409)
        try:
            return await manager.launcher.external_view(body, op)
        except (ValueError, OSError, asyncio.TimeoutError) as error:
            log_ipc_failure('http_relay', error)
            raise SimError('SIM_OBSERVER_UNAVAILABLE', 409) from None

    @app.post('/v1/robots/{robot_id}/external-camera/view', dependencies=[Depends(authenticate)])
    async def external_view(robot_id: UUID, body: C.ExternalCameraViewRequest):
        return await observer_request(robot_id, body, 'view')

    @app.post('/v1/robots/{robot_id}/external-camera/reset', dependencies=[Depends(authenticate)])
    async def external_reset(robot_id: UUID, body: C.ExternalCameraViewRequest):
        return await observer_request(robot_id, body, 'reset')

    @app.post('/v1/robots/{robot_id}/external-camera/cancel', dependencies=[Depends(authenticate)])
    async def external_cancel(robot_id: UUID, body: C.ExternalCameraViewRequest):
        return await observer_request(robot_id, body, 'cancel')

    return app

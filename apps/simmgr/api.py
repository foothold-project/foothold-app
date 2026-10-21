"""Authenticated control-server transport on loopback only; no phone credentials."""
from contextlib import asynccontextmanager
import asyncio
import hmac

from fastapi import Depends, FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.exceptions import RequestValidationError

from apps.contracts import models as C
from .service import Manager, SimError


def create_app(settings, launcher=None):
    manager = Manager(settings, launcher)

    @asynccontextmanager
    async def lifespan(app):
        try:
            yield
        finally:
            await manager.close()

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.manager = manager

    def authenticate(request: Request):
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
            return JSONResponse(status_code=error.status, content={'error': {'code': error.code}})
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
            return JSONResponse(status_code=error.status, content={'error': {'code': error.code}})
        return await call_next(request)

    @app.exception_handler(SimError)
    async def sim_error(request, exc):
        return JSONResponse(status_code=exc.status, content={'error': {'code': exc.code}})

    @app.exception_handler(RequestValidationError)
    async def invalid(request, exc):
        return JSONResponse(status_code=400, content={'error': {'code': 'SIM_VALIDATION'}})

    @app.exception_handler(Exception)
    async def failed(request, exc):
        return JSONResponse(status_code=503, content={'error': {'code': 'SIM_UNAVAILABLE'}})

    @app.get('/v1/worlds', dependencies=[Depends(authenticate)], response_model=C.SimCatalog)
    def worlds(org_id: str):
        return dict(worlds=[{'id': w.id} for w in settings.worlds.values()],
                    slots=[rid for rid, slot in settings.slots.items() if slot.org_id == org_id],
                    max_robots=1 if manager.launcher.real else settings.max_robots,
                    launcher='native-single' if manager.launcher.real else 'fake')

    @app.post('/v1/worlds', dependencies=[Depends(authenticate)])
    async def world(body: C.SimWorldStart):
        await manager.start_world(body.world_id)
        return {'ok': True}

    @app.get('/v1/robots', dependencies=[Depends(authenticate)], response_model=C.SimRobotList)
    def robots(org_id: str):
        return {'items': manager.listing(org_id)}

    @app.post('/v1/robots', dependencies=[Depends(authenticate)], response_model=C.SimRobot)
    async def add(body: C.SimProvision):
        return await manager.add(body.world_id, str(body.robot_id), str(body.owner_id), str(body.org_id), body.agent_token, body.generation)

    @app.delete('/v1/robots/{robot_id}', dependencies=[Depends(authenticate)])
    async def remove(robot_id: str, body: C.SimRemove):
        await manager.remove(robot_id, body.generation)
        return {'ok': True}

    return app

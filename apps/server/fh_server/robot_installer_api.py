"""Authenticated platform downloads from the server's fixed installer store."""
from pathlib import Path

from fastapi import Response
from fastapi.responses import StreamingResponse
from starlette.background import BackgroundTask

from apps.contracts import models as C
from .robot_installer import BUILDERS, PLATFORMS, SOURCE_ROOT, InstallerManager, commit_at


def install(app, Identity, fail, authorize, settings):
    manager = InstallerManager(Path(settings.files_root) / 'robot-installer', SOURCE_ROOT,
                               commit_at(SOURCE_ROOT), settings.ws_origin,
                               enabled=settings.robot_installer_enabled)
    app.state.robot_installer = manager

    @app.get('/api/v1/robot-installer/info', response_model=C.RobotInstallerInfo)
    def info(response: Response, auth: Identity):
        authorize(auth[0], 'O')
        response.headers['Cache-Control'] = 'private, no-store'
        return manager.info()

    @app.get('/api/v1/robot-installer/{platform}')
    def download(platform: str, auth: Identity):
        authorize(auth[0], 'O')
        if platform not in PLATFORMS:
            fail(404, 'NOT_FOUND', '설치 파일을 찾을 수 없습니다.')
        state = next(item for item in manager.info()['items'] if item['platform'] == platform)
        if not state['available']:
            fail(404, 'INSTALLER_UNAVAILABLE', '설치 파일을 준비하고 있습니다.',
                 {'reason': state['reason']})
        try:
            opened = manager.current(platform)
        except (OSError, ValueError):
            opened = None
        if opened is None:
            fail(404, 'INSTALLER_UNAVAILABLE', '설치 파일을 준비하고 있습니다.',
                 {'reason': 'invalid_artifact'})
        meta, stream = opened

        def chunks():
            try:
                while data := stream.read(1024 * 1024):
                    yield data
            finally:
                stream.close()

        return StreamingResponse(chunks(), media_type=BUILDERS[platform].media_type,
                                 headers={'Content-Disposition': f'attachment; filename="{meta["filename"]}"',
                                          'Content-Length': str(meta['size']),
                                          'Cache-Control': 'private, no-store',
                                          'X-Content-Type-Options': 'nosniff'},
                                 background=BackgroundTask(stream.close))

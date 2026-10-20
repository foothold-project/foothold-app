"""Private uvicorn test target: short body deadline, same production application."""
from apps.server.fh_server import maps
from apps.server.fh_server.api import create_app

maps.UPLOAD_BODY_SECONDS = 2
app = create_app()

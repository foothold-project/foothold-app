"""Test-only ASGI target: latency while holding private DB connections."""
import time
from sqlalchemy import event
from apps.server.fh_server.main import app


@event.listens_for(app.state.realtime.read_engine, 'before_cursor_execute')
@event.listens_for(app.state.realtime.view_engine, 'before_cursor_execute')
@event.listens_for(app.state.realtime.control_engine, 'before_cursor_execute')
@event.listens_for(app.state.realtime.agent_engine, 'before_cursor_execute')
def delayed_read(conn, cursor, statement, parameters, context, many):
    # Bound identity: 300ms in one SELECT; policy: 150ms in each of two SELECTs.
    # Checkout already happened, so this also exercises pool contention.
    if conn.engine is app.state.realtime.agent_engine or 'robots.id =' in statement:
        time.sleep(.3)
    elif 'FROM robots' in statement or 'JOIN sessions' in statement:
        time.sleep(.15)

"""Explicit integration case, run through check_agent_reconnect.py, not vendored agent code."""
import asyncio
import os

from sqlalchemy import text

from apps.server.tests.conftest import postgres, migrated, seeded
from apps.server.tests.ws_process import server_process


def test_real_pr8_client_keeps_retrying_after_owner_loss_and_reconnects(seeded, tmp_path):
    from foothold_agent.link.client import Client, Settings
    from foothold_agent.link.session import Session

    # An explicitly requested historical package can predate the current wire
    # contract. Diagnose that as a failed compatibility assertion, not a ping
    # timeout / execution error after repeatedly rejecting its hello.
    assert Session().connect().messages[0]['proto'] == 'fh-agent/2', 'Agent wire contract must be fh-agent/2'

    async def check(server):
        class ObservedSession(Session):
            def __init__(self):
                super().__init__(asyncio.get_running_loop().time)
                self.retry_codes = []
                self.pings = 0
                self.connections = 0

            def connect(self):
                self.connections += 1
                return super().connect()

            def transport_retry(self, delay, code):
                self.retry_codes.append(code)
                return super().transport_retry(delay, code)

            def receive(self, frame):
                import json
                decoded = json.loads(frame) if isinstance(frame, (str, bytes)) else frame
                if isinstance(decoded, dict) and decoded.get('t') == 'ping':
                    self.pings += 1
                return super().receive(frame)

        class Sink:
            def apply(self, command):
                assert tuple(command.velocity) == (0, 0, 0)

        session = ObservedSession()
        client = Client(session, Sink(), Settings(url=server['base'] + '/api/v1/agent/ws',
            token=server['agent_token'], retry_initial_s=.1, retry_max_s=.2))
        task = asyncio.create_task(client.run())
        blocker = None
        async def until(predicate, timeout=4):
            async with asyncio.timeout(timeout):
                while not predicate():
                    if task.done():
                        error = task.exception()
                        raise AssertionError('Real Client stopped: ' + type(error).__name__)
                    await asyncio.sleep(.01)
        try:
            await until(lambda: session.pings >= 1)
            assert getattr(session, 'stop_ref', 0) > 0  # current integrated wire contract
            initial_pings = session.pings
            # Only this temporary PostgreSQL is touched. Terminate the owner
            # session and occupy its advisory lock before the next election.
            blocker = server['engine'].connect()
            with server['admin'].begin() as conn:
                pid = conn.scalar(text("SELECT pid FROM pg_locks WHERE locktype='advisory' AND granted"))
                assert pid is not None
                assert conn.scalar(text('SELECT pg_terminate_backend(:pid)'), {'pid': pid})
            blocker.execute(text('SELECT pg_advisory_lock(hashtextextended(:key, 0))'), {'key': server['key']})
            blocker.commit()
            await until(lambda: len(session.retry_codes) >= 3)
            assert not task.done()
            assert session.retry_codes.count(1013) >= 3
            blocker.execute(text('SELECT pg_advisory_unlock_all()'))
            blocker.commit()
            blocker.close()
            blocker = None
            await until(lambda: session.pings > initial_pings)
            assert not task.done()
            assert session.connected
            assert session.core.latch
            print('owner lost -> 3 retryable 1013 closes -> lock released -> authenticated ping; agent='
                  + os.environ['FH_REVIEW_AGENT_COMMIT'])
        finally:
            if blocker is not None:
                blocker.execute(text('SELECT pg_advisory_unlock_all()'))
                blocker.commit()
                blocker.close()
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
    with server_process(seeded, tmp_path) as server:
        asyncio.run(check(server))

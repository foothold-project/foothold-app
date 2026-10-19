"""A private PostgreSQL from the venv wheel; never probes a system service."""
from contextlib import contextmanager
from pathlib import Path
import socket
import tempfile

from pgserver import initdb, pg_ctl
from sqlalchemy import create_engine, text
from sqlalchemy.engine import URL


@contextmanager
def temporary_postgres():
    with tempfile.TemporaryDirectory(prefix='fh-pg-') as folder:
        root = Path(folder)
        data = root / 'data'
        # PostgreSQL uses a private Unix socket, with an ephemeral port number.
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        initdb(['--auth=trust', '--encoding=UTF8', '--locale=C', '-U', 'postgres'], pgdata=data)
        started = False
        try:
            pg_ctl(['-w', '-o', f'-h "" -k {root} -p {port}', '-l', str(root / 'pg.log'), 'start'], pgdata=data)
            started = True
            def url(user):
                return URL.create('postgresql+psycopg', username=user, database='postgres',
                                  query={'host': str(root), 'port': str(port)}).render_as_string(hide_password=False)
            admin = create_engine(url('postgres'))
            with admin.begin() as conn:
                conn.execute(text('CREATE ROLE fh_migrate LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT'))
                conn.execute(text('CREATE ROLE fh_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT'))
                conn.execute(text('CREATE ROLE fh_readonly LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT'))
                conn.execute(text('REVOKE CREATE ON SCHEMA public FROM PUBLIC'))
                conn.execute(text('GRANT USAGE, CREATE ON SCHEMA public TO fh_migrate'))
            admin.dispose()
            yield {'migrate': url('fh_migrate'), 'app': url('fh_app'), 'readonly': url('fh_readonly'),
                   'admin': url('postgres'), 'data': data, 'port': port}
        finally:
            if started:
                pg_ctl(['-w', '-m', 'fast', 'stop'], pgdata=data)

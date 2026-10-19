import os

from alembic import context
from sqlalchemy import create_engine

config = context.config
url = os.environ['FH_MIGRATE_DATABASE_URL']
if not url.startswith('postgresql+psycopg://'):
    raise ValueError('FH_MIGRATE_DATABASE_URL must use postgresql+psycopg')

if context.is_offline_mode():
    context.configure(url=url, literal_binds=True)
    with context.begin_transaction():
        context.run_migrations()
else:
    engine = create_engine(url)
    with engine.connect() as connection:
        context.configure(connection=connection)
        with context.begin_transaction():
            context.run_migrations()
    engine.dispose()

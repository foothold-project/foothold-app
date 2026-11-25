"""Distinguish unconfirmed received bundles without rewriting historical saves."""
from alembic import op

revision = '0033'
down_revision = '0032'
branch_labels = None
depends_on = None


def states(values):
    op.drop_constraint('mapping_status', 'mapping_sessions', type_='check')
    op.create_check_constraint('mapping_status', 'mapping_sessions', f'status IN ({values})')


def upgrade():
    states("'STARTING','RUNNING','SAVING','FINALIZING','UNKNOWN','SAVED','RECEIVED_ONLY','FAILED','CANCELLED'")


def downgrade():
    # Existing RECEIVED_ONLY rows reject downgrade atomically; never relabel
    # unconfirmed geometry as a successful save or delete retained artifacts.
    states("'STARTING','RUNNING','SAVING','FINALIZING','UNKNOWN','SAVED','FAILED','CANCELLED'")

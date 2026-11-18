"""MAC-derived placeholders cannot identify a physical robot uniquely.

Downgrade refuses duplicate active serials; reconcile/archive them first.
"""
from alembic import op
import sqlalchemy as sa

revision = '0031'
down_revision = '0030'
branch_labels = None
depends_on = None


def upgrade():
    # Canonical uint32 decimal prefixes in this range always have ten digits.
    # substr/length and fixed-width digit comparison have the same meaning on
    # PostgreSQL and SQLite. No integer cast of historical free-text serials.
    op.drop_index('robots_active_serial', table_name='robots')
    op.create_index('robots_active_serial', 'robots', ['serial'], unique=True,
        postgresql_where=sa.text("archived_at IS NULL AND serial IS NOT NULL AND NOT (length(serial) >= 12 AND substr(serial, 11, 1) = '-' AND substr(serial, 1, 10) BETWEEN '4294901760' AND '4294967295')"),
        sqlite_where=sa.text("archived_at IS NULL AND serial IS NOT NULL AND NOT (length(serial) >= 12 AND substr(serial, 11, 1) = '-' AND substr(serial, 1, 10) BETWEEN '4294901760' AND '4294967295')"))


def downgrade():
    # PostgreSQL transactional DDL restores the old index on a failed downgrade.
    # Never delete or silently relabel duplicate records to make rollback pass.
    op.drop_index('robots_active_serial', table_name='robots')
    op.create_index('robots_active_serial', 'robots', ['serial'], unique=True,
        postgresql_where=sa.text('archived_at IS NULL AND serial IS NOT NULL'),
        sqlite_where=sa.text('archived_at IS NULL AND serial IS NOT NULL'))

"""Allow archived robot names to be reused without changing historical IDs."""
from alembic import op
from sqlalchemy import text

revision = '0007'
down_revision = '0006'
branch_labels = None
depends_on = None


def upgrade():
    op.drop_constraint('robots_org_id_name_key', 'robots', type_='unique')
    op.create_index('robots_active_org_name', 'robots', ['org_id', 'name'], unique=True,
                    postgresql_where=text('archived_at IS NULL'))


def downgrade():
    # PostgreSQL refuses the downgrade atomically if reused names still exist.
    # Operators must reconcile those names before restoring the old invariant.
    op.create_unique_constraint('robots_org_id_name_key', 'robots', ['org_id', 'name'])
    op.drop_index('robots_active_org_name', table_name='robots')

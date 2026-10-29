"""Hide map hierarchy without deleting immutable snapshots or execution history."""
from alembic import op
import sqlalchemy as sa

revision = '0021'
down_revision = '0020'
branch_labels = None
depends_on = None


def upgrade():
    for table in ('sites', 'buildings', 'floors'):
        op.add_column(table, sa.Column('archived_at', sa.DateTime(timezone=True), nullable=True))
    op.add_column('robots', sa.Column('sim_world_id', sa.Text(), nullable=True))


def downgrade():
    # Dropping archive markers would silently restore deleted selections.
    for table in ('sites', 'buildings', 'floors'):
        op.execute(f"""DO $$ BEGIN IF EXISTS (SELECT 1 FROM {table} WHERE archived_at IS NOT NULL) THEN
            RAISE EXCEPTION 'Reconcile archived map resources explicitly before downgrade';
            END IF; END $$""")
    op.drop_column('robots', 'sim_world_id')
    for table in ('floors', 'buildings', 'sites'):
        op.drop_column(table, 'archived_at')

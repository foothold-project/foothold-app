"""Organization terrain library and persistent generated-floor identity."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = '0025'
down_revision = '0024'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table('terrains',
        sa.Column('id', sa.Text(), primary_key=True),
        sa.Column('org_id', postgresql.UUID(), primary_key=True),
        sa.Column('spec', postgresql.JSONB(), nullable=False),
        sa.Column('version', sa.Integer(), nullable=False),
        sa.Column('archived_at', sa.DateTime(timezone=True)),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.ForeignKeyConstraint(['org_id'], ['organizations.id']),
        sa.CheckConstraint('version > 0', name='terrain_version'))
    op.add_column('floors', sa.Column('terrain_id', sa.Text()))
    op.create_unique_constraint('floors_org_id_terrain_id_key', 'floors', ['org_id', 'terrain_id'])
    op.execute('GRANT SELECT, INSERT, UPDATE ON terrains TO fh_app')
    op.execute('GRANT SELECT ON terrains TO fh_readonly')


def downgrade():
    # Removing the source identity would leave simulation maps with no terrain.
    op.execute("""DO $$ BEGIN IF EXISTS (SELECT 1 FROM terrains)
        OR EXISTS (SELECT 1 FROM floors WHERE terrain_id IS NOT NULL)
        THEN RAISE EXCEPTION 'Retire terrain data before downgrade'; END IF; END $$""")
    op.drop_constraint('floors_org_id_terrain_id_key', 'floors', type_='unique')
    op.drop_column('floors', 'terrain_id')
    op.drop_table('terrains')

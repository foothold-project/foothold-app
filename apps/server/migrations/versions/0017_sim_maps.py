"""Reviewed static world maps retain simulation provenance."""
from alembic import op
import sqlalchemy as sa

revision = '0017'
down_revision = '0016'
branch_labels = None
depends_on = None


def upgrade():
    for table, constraint in (('uploads', 'upload_provenance'), ('map_versions', 'map_version_provenance')):
        op.add_column(table, sa.Column('provenance', sa.Text(), nullable=False, server_default=sa.text("'HUMAN'")))
        op.create_check_constraint(constraint, table, "provenance IN ('HUMAN','SIMULATION')")
    op.add_column('buildings', sa.Column('sim_world_id', sa.Text(), nullable=True))
    op.create_unique_constraint('buildings_org_id_sim_world_id_key', 'buildings', ['org_id', 'sim_world_id'])
    op.add_column('floors', sa.Column('provenance', sa.Text(), nullable=False, server_default=sa.text("'HUMAN'")))
    op.add_column('floors', sa.Column('sim_floor_id', sa.Text(), nullable=True))
    op.add_column('floors', sa.Column('floor_z', sa.Float(), nullable=True))
    op.create_check_constraint('floor_provenance', 'floors', "provenance IN ('HUMAN','SIMULATION')")
    op.create_unique_constraint('floors_building_id_sim_floor_id_key', 'floors', ['building_id', 'sim_floor_id'])


def downgrade():
    # Dropping provenance with simulation data would turn those maps into human
    # maps. Require an explicit data retirement before removing this boundary.
    op.execute("""DO $$ BEGIN IF EXISTS (SELECT 1 FROM floors WHERE provenance='SIMULATION')
        OR EXISTS (SELECT 1 FROM map_versions WHERE provenance='SIMULATION')
        OR EXISTS (SELECT 1 FROM uploads WHERE provenance='SIMULATION')
        THEN RAISE EXCEPTION 'Retire simulation map data before downgrade'; END IF; END $$""")
    op.drop_constraint('floors_building_id_sim_floor_id_key', 'floors', type_='unique')
    op.drop_constraint('floor_provenance', 'floors', type_='check')
    for column in ('floor_z', 'sim_floor_id', 'provenance'):
        op.drop_column('floors', column)
    op.drop_constraint('buildings_org_id_sim_world_id_key', 'buildings', type_='unique')
    op.drop_column('buildings', 'sim_world_id')
    for table, constraint in (('uploads', 'upload_provenance'), ('map_versions', 'map_version_provenance')):
        op.drop_constraint(constraint, table, type_='check')
        op.drop_column(table, 'provenance')

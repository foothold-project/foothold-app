"""Immutable automatic map-update ancestry; assignments retain original references."""
from alembic import op
import sqlalchemy as sa

revision = '0029'
down_revision = '0028'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('scenario_versions', sa.Column('auto_map_from_number', sa.Integer(), nullable=True))
    op.create_foreign_key('scenario_auto_map_source', 'scenario_versions', 'scenario_versions',
        ['scenario_id', 'auto_map_from_number'], ['scenario_id', 'number'])
    op.create_check_constraint('scenario_auto_map_previous', 'scenario_versions',
        'auto_map_from_number IS NULL OR (auto_map_from_number > 0 AND auto_map_from_number < number)')
    # Existing table-level INSERT/SELECT grants cover this column. No UPDATE or
    # DELETE capability is granted; lineage is part of the immutable snapshot.


def downgrade():
    op.execute("""DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM scenario_versions WHERE auto_map_from_number IS NOT NULL) THEN
        RAISE EXCEPTION 'Automatic map lineage requires backup before downgrade';
      END IF;
    END $$""")
    op.drop_constraint('scenario_auto_map_previous', 'scenario_versions', type_='check')
    op.drop_constraint('scenario_auto_map_source', 'scenario_versions', type_='foreignkey')
    op.drop_column('scenario_versions', 'auto_map_from_number')

"""Durable live voxel state; do not reconstruct incomplete historical deltas."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql as pg

revision = '0034'
down_revision = '0033'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table('mapping_voxel_states',
        sa.Column('org_id', pg.UUID(), nullable=False),
        sa.Column('session_id', pg.UUID(), primary_key=True),
        sa.Column('revision', sa.BigInteger(), nullable=False),
        sa.Column('seq', sa.BigInteger(), nullable=False),
        sa.Column('reset_seq', sa.BigInteger(), nullable=False),
        sa.Column('frame_id', sa.Text(), nullable=False),
        sa.Column('cell_count', sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(['org_id', 'session_id'], ['mapping_sessions.org_id', 'mapping_sessions.id'], ondelete='CASCADE'),
        sa.CheckConstraint('revision > 0 AND seq > 0 AND reset_seq > 0 AND reset_seq <= seq', name='mapping_voxel_state_seq'),
        sa.CheckConstraint('cell_count >= 0 AND cell_count <= 500000', name='mapping_voxel_count'))
    op.create_table('mapping_voxels',
        sa.Column('org_id', pg.UUID(), nullable=False),
        sa.Column('session_id', pg.UUID(), primary_key=True),
        sa.Column('x', sa.Integer(), primary_key=True),
        sa.Column('y', sa.Integer(), primary_key=True),
        sa.Column('z', sa.Integer(), primary_key=True),
        sa.Column('seq', sa.BigInteger(), nullable=False),
        sa.Column('present', sa.Boolean(), nullable=False),
        sa.ForeignKeyConstraint(['org_id', 'session_id'], ['mapping_sessions.org_id', 'mapping_sessions.id'], ondelete='CASCADE'),
        sa.CheckConstraint('seq > 0', name='mapping_voxel_seq'),
        sa.CheckConstraint('x BETWEEN -200000 AND 200000 AND y BETWEEN -200000 AND 200000 AND z BETWEEN -200000 AND 200000', name='mapping_voxel_coordinates'))
    op.create_index('mapping_voxel_changes', 'mapping_voxels', ['org_id', 'session_id', 'seq'])
    for table in ('mapping_voxel_states', 'mapping_voxels'):
        op.execute(f'GRANT SELECT, INSERT, UPDATE, DELETE ON {table} TO fh_app')
        op.execute(f'GRANT SELECT ON {table} TO fh_readonly')


def downgrade():
    op.execute("""DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM mapping_voxel_states LIMIT 1)
            OR EXISTS (SELECT 1 FROM mapping_voxels LIMIT 1) THEN
            RAISE EXCEPTION 'Retire live SLAM voxels before downgrade';
        END IF;
    END $$""")
    op.drop_table('mapping_voxels')
    op.drop_table('mapping_voxel_states')

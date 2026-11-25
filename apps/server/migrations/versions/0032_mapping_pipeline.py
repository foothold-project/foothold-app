"""Mapping pipeline phases; retain legacy rows and refuse a lossy downgrade."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql as pg

revision = '0032'
down_revision = '0031'
branch_labels = None
depends_on = None


def states(all_states, active):
    op.drop_constraint('mapping_status', 'mapping_sessions', type_='check')
    op.create_check_constraint('mapping_status', 'mapping_sessions', f'status IN ({all_states})')
    op.drop_index('mapping_one_active_robot', table_name='mapping_sessions')
    op.create_index('mapping_one_active_robot', 'mapping_sessions', ['robot_id'], unique=True,
        postgresql_where=sa.text(f'status IN ({active})'))


def upgrade():
    states("'STARTING','RUNNING','SAVING','FINALIZING','UNKNOWN','SAVED','FAILED','CANCELLED'",
           "'STARTING','RUNNING','SAVING','FINALIZING','UNKNOWN','FAILED'")
    op.create_unique_constraint('mapping_sessions_org_id_id_key', 'mapping_sessions', ['org_id', 'id'])
    op.create_table('mapping_tiles',
        sa.Column('org_id', pg.UUID(), nullable=False),
        sa.Column('session_id', pg.UUID(), primary_key=True),
        sa.Column('x', sa.Integer(), primary_key=True), sa.Column('y', sa.Integer(), primary_key=True),
        sa.Column('revision', sa.BigInteger(), nullable=False), sa.Column('tile_seq', sa.BigInteger(), nullable=False),
        sa.Column('update_seq', sa.BigInteger(), nullable=False),
        sa.Column('frame_id', sa.Text(), nullable=False), sa.Column('floor_z', sa.Float(), nullable=False),
        sa.Column('cells', sa.LargeBinary(), nullable=False),
        sa.ForeignKeyConstraint(['org_id', 'session_id'], ['mapping_sessions.org_id', 'mapping_sessions.id'], ondelete='CASCADE'),
        sa.CheckConstraint('octet_length(cells) = 4096', name='mapping_tile_size'),
        sa.CheckConstraint('tile_seq > 0 AND revision > 0', name='mapping_tile_revision'))
    op.execute('GRANT SELECT, INSERT, UPDATE, DELETE ON mapping_tiles TO fh_app')
    op.execute('GRANT SELECT ON mapping_tiles TO fh_readonly')


def downgrade():
    op.execute("""DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM mapping_tiles LIMIT 1) THEN
            RAISE EXCEPTION 'Retire live SLAM tiles before downgrade';
        END IF;
    END $$""")
    # The check constraint rejects rows in new states atomically: never erase evidence.
    states("'RUNNING','SAVING','SAVED','FAILED','CANCELLED'", "'RUNNING','SAVING','FAILED'")
    op.drop_table('mapping_tiles')
    op.drop_constraint('mapping_sessions_org_id_id_key', 'mapping_sessions', type_='unique')

"""Physical mapping sessions; additive table, no changes to existing rows."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql as pg

revision = '0030'
down_revision = '0029'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table('mapping_sessions',
        sa.Column('id', pg.UUID(), primary_key=True),
        sa.Column('org_id', pg.UUID(), nullable=False),
        sa.Column('robot_id', pg.UUID(), nullable=False),
        sa.Column('floor_id', pg.UUID(), nullable=False),
        sa.Column('owner_id', pg.UUID(), nullable=False),
        sa.Column('base_version_id', pg.UUID(), nullable=True),
        sa.Column('status', sa.Text(), nullable=False),
        sa.Column('progress', pg.JSONB(), nullable=True),
        sa.Column('result', pg.JSONB(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['org_id','robot_id'], ['robots.org_id','robots.id']),
        sa.ForeignKeyConstraint(['org_id','floor_id'], ['floors.org_id','floors.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['org_id','owner_id'], ['users.org_id','users.id']),
        sa.ForeignKeyConstraint(['org_id','base_version_id'], ['map_versions.org_id','map_versions.id'], ondelete='CASCADE'),
        sa.CheckConstraint("status IN ('RUNNING','SAVING','SAVED','FAILED','CANCELLED')", name='mapping_status'))
    op.create_index('mapping_one_active_robot', 'mapping_sessions', ['robot_id'], unique=True,
                    postgresql_where=sa.text("status IN ('RUNNING','SAVING','FAILED')"))
    op.execute('GRANT SELECT, INSERT, UPDATE ON mapping_sessions TO fh_app')
    op.execute('GRANT SELECT ON mapping_sessions TO fh_readonly')


def downgrade():
    op.drop_table('mapping_sessions')

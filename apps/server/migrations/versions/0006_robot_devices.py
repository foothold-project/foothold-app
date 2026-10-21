"""Persist tenant-bound device inventories from agent hello."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID, JSONB

revision = '0006'
down_revision = '0005'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table('robot_devices',
        sa.Column('org_id', UUID(), nullable=False),
        sa.Column('robot_id', UUID(), primary_key=True),
        sa.Column('key', sa.Text(), primary_key=True),
        sa.Column('kind', sa.Text(), nullable=False),
        sa.Column('label', sa.Text(), nullable=False),
        sa.Column('state', sa.Text(), nullable=False),
        sa.Column('info', JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.ForeignKeyConstraint(['org_id', 'robot_id'], ['robots.org_id', 'robots.id']),
        sa.CheckConstraint("kind IN ('CAMERA_RGB','CAMERA_DEPTH','LIDAR','BATTERY','OTHER')", name='device_kind'),
        sa.CheckConstraint("state IN ('OK','MISSING','ERROR')", name='device_state'))
    op.execute('GRANT SELECT, INSERT, UPDATE ON robot_devices TO fh_app')
    op.execute('GRANT SELECT ON robot_devices TO fh_readonly')


def downgrade():
    op.drop_table('robot_devices')

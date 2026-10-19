"""Index tenant/robot lease history without altering stored audit rows."""
from alembic import op
import sqlalchemy as sa

revision = '0005'
down_revision = '0004'
branch_labels = None
depends_on = None


def upgrade():
    op.create_index('lease_log_org_robot_at', 'lease_log', ['org_id', 'robot_id', sa.text('at DESC')])


def downgrade():
    op.drop_index('lease_log_org_robot_at', table_name='lease_log')

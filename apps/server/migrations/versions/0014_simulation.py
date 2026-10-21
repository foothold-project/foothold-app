"""Durable simulation provenance, writable only through simulation provisioning."""
from alembic import op
import sqlalchemy as sa

revision = '0014'
down_revision = '0013'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('robots', sa.Column('simulation', sa.Boolean(), nullable=False, server_default=sa.text('false')))


def downgrade():
    op.drop_column('robots', 'simulation')

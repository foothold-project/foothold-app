"""Durable simulation provenance, writable only through simulation provisioning."""
from alembic import op
import sqlalchemy as sa

revision = '0014'
down_revision = '0013'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('robots', sa.Column('simulation', sa.Boolean(), nullable=False, server_default=sa.text('false')))

    op.add_column('robots', sa.Column('sim_generation', sa.BigInteger(), nullable=False, server_default=sa.text('0')))
    op.add_column('robots', sa.Column('sim_state', sa.Text(), nullable=False, server_default=sa.text("'IDLE'")))

def downgrade():
    op.drop_column('robots', 'sim_state')
    op.drop_column('robots', 'sim_generation')
    op.drop_column('robots', 'simulation')

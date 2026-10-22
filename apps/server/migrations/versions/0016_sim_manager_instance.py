"""Bind simulation reservations to the manager that received their generation."""
from alembic import op
import sqlalchemy as sa

revision = '0016'
down_revision = '0015'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('robots', sa.Column('sim_manager_instance_id', sa.Uuid(), nullable=True))


def downgrade():
    op.drop_column('robots', 'sim_manager_instance_id')

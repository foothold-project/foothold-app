"""Robot demo flag: a simulation robot that keeps running the day cycle.

Real robots are always demo=false. fh_app already holds table-level UPDATE on
robots (0001), so the new column needs no extra grant.
"""
from alembic import op
import sqlalchemy as sa

revision = '0039'
down_revision = '0038'  # local integration: chain after 0038_pairing_offers
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('robots', sa.Column('demo', sa.Boolean(), nullable=False, server_default=sa.text('false')))
    op.create_check_constraint('robot_demo_simulation', 'robots', 'simulation OR NOT demo')


def downgrade():
    op.drop_constraint('robot_demo_simulation', 'robots', type_='check')
    op.drop_column('robots', 'demo')

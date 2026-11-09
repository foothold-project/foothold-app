"""Separate simulation places from real SLAM places; retain all existing data."""
from alembic import op
import sqlalchemy as sa

revision = '0026'
down_revision = '0025'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('sites', sa.Column('purpose', sa.Text(), nullable=False, server_default='REAL'))
    op.create_check_constraint('site_purpose', 'sites', "purpose IN ('SIM','REAL')")
    # Includes archived places: this changes no identities, maps or assignments.
    op.execute("UPDATE sites SET purpose='SIM'")


def downgrade():
    op.drop_constraint('site_purpose', 'sites', type_='check')
    op.drop_column('sites', 'purpose')

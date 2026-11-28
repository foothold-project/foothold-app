"""Phone-shown QR pairing offers (u08).

The offer row never stores a poll secret or robot key. A robot that reads the
code gets a normal pairings row, so the existing confirm/poll path issues the key.
down_revision follows the dev head at writing time (0035); open PRs use 0036/0037,
so whichever merges later re-chains this file.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

revision = '0038'
down_revision = '0035'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table('pairing_offers',
        sa.Column('id', UUID(), primary_key=True),
        sa.Column('org_id', UUID(), nullable=False),
        sa.Column('created_by', UUID(), nullable=False),
        sa.Column('code_hash', sa.LargeBinary(), nullable=False, unique=True),
        sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('state', sa.Text(), nullable=False),
        sa.Column('robot_serial', sa.Text(), nullable=True),
        sa.Column('pairing_id', UUID(), nullable=True),
        sa.Column('robot_id', UUID(), nullable=True),
        sa.ForeignKeyConstraint(['org_id'], ['organizations.id']),
        sa.ForeignKeyConstraint(['org_id', 'created_by'], ['users.org_id', 'users.id']),
        sa.ForeignKeyConstraint(['pairing_id'], ['pairings.id'], ondelete='SET NULL'),
        sa.CheckConstraint("state IN ('WAITING','READ','PAIRED','EXPIRED','FAILED')", name='pairing_offer_state'))
    op.create_index('pairing_offers_creator', 'pairing_offers', ['org_id', 'created_by'])
    op.execute('GRANT SELECT, INSERT, UPDATE, DELETE ON pairing_offers TO fh_app')
    op.execute('GRANT SELECT ON pairing_offers TO fh_readonly')


def downgrade():
    op.drop_table('pairing_offers')

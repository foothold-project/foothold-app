"""Operator pairing and per-robot field safety approval."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

revision = '0022'
down_revision = '0021'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('robots', sa.Column('serial', sa.Text(), nullable=True))
    op.add_column('robots', sa.Column('field_approval_expires_at', sa.DateTime(timezone=True), nullable=True))
    op.create_index('robots_active_serial', 'robots', ['serial'], unique=True,
                    postgresql_where=sa.text('archived_at IS NULL AND serial IS NOT NULL'))
    op.create_table('pairings',
        sa.Column('id', UUID(), primary_key=True),
        sa.Column('org_id', UUID(), nullable=False),
        sa.Column('code_hash', sa.LargeBinary(), nullable=False, unique=True),
        sa.Column('poll_hash', sa.LargeBinary(), nullable=False),
        sa.Column('token_hash', sa.LargeBinary(), nullable=False),
        sa.Column('token_ciphertext', sa.LargeBinary(), nullable=True),
        sa.Column('robot_serial', sa.Text(), nullable=False),
        sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('claimed_by', UUID(), nullable=True),
        sa.Column('robot_id', UUID(), nullable=True),
        sa.Column('consumed', sa.Boolean(), nullable=False),
        sa.ForeignKeyConstraint(['org_id'], ['organizations.id']),
        sa.ForeignKeyConstraint(['org_id', 'claimed_by'], ['users.org_id', 'users.id']),
        sa.ForeignKeyConstraint(['org_id', 'robot_id'], ['robots.org_id', 'robots.id']))
    op.create_table('pairing_rates',
        sa.Column('org_id', UUID(), primary_key=True),
        sa.Column('key_hash', sa.LargeBinary(), primary_key=True),
        sa.Column('window_start', sa.DateTime(timezone=True), primary_key=True),
        sa.Column('count', sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(['org_id'], ['organizations.id']))
    op.execute('GRANT SELECT, INSERT, UPDATE, DELETE ON pairings, pairing_rates TO fh_app')
    op.execute('GRANT SELECT ON pairings, pairing_rates TO fh_readonly')


def downgrade():
    op.drop_table('pairing_rates')
    op.drop_table('pairings')
    op.drop_index('robots_active_serial', table_name='robots')
    op.drop_column('robots', 'field_approval_expires_at')
    op.drop_column('robots', 'serial')

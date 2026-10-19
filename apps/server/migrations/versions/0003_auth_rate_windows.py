"""Bound append-only rate-limit audits using durable mutable window counters."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision = '0003'
down_revision = '0002'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table('auth_rate_windows',
        sa.Column('org_id', UUID(), primary_key=True),
        sa.Column('key_type', sa.Text(), primary_key=True),
        sa.Column('key_hash', sa.Text(), primary_key=True),
        sa.Column('window_start', sa.DateTime(timezone=True), primary_key=True),
        sa.Column('denied_count', sa.BigInteger(), nullable=False, server_default=sa.text('1')),
        sa.Column('user_id', UUID(), nullable=True),
        sa.Column('data', JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.ForeignKeyConstraint(['org_id'], ['organizations.id']),
        sa.ForeignKeyConstraint(['org_id', 'user_id'], ['users.org_id', 'users.id']),
        sa.CheckConstraint("key_type IN ('LOGIN_IP','LOGIN_ACCOUNT','PASSWORD_ACCOUNT')", name='rate_window_key_type'),
        sa.CheckConstraint('denied_count > 0', name='rate_window_positive_count'))
    op.create_index('auth_rate_windows_org_start', 'auth_rate_windows', ['org_id', 'window_start'])
    op.execute('GRANT SELECT, INSERT, UPDATE, DELETE ON auth_rate_windows TO fh_app')
    op.execute('GRANT SELECT ON auth_rate_windows TO fh_readonly')


def downgrade():
    op.drop_table('auth_rate_windows')

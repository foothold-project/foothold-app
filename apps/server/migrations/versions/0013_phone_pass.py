"""Phone-pass metadata and durable, per-robot revocation outbox."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID, JSONB

revision = '0013'
down_revision = '0012'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table('phone_passes',
        sa.Column('org_id', UUID(), nullable=False),
        sa.Column('jti', UUID(), primary_key=True),
        sa.Column('user_id', UUID(), nullable=False),
        sa.Column('device', UUID(), nullable=False),
        sa.Column('robot_id', UUID(), nullable=False),
        sa.Column('purpose', sa.Text(), nullable=False),
        sa.Column('iat', sa.BigInteger(), nullable=False),
        sa.Column('exp', sa.BigInteger(), nullable=False),
        sa.ForeignKeyConstraint(['org_id', 'user_id'], ['users.org_id', 'users.id']),
        sa.ForeignKeyConstraint(['org_id', 'robot_id'], ['robots.org_id', 'robots.id']),
        sa.CheckConstraint("purpose IN ('control','view')", name='phone_pass_purpose'),
        sa.CheckConstraint('exp > iat AND exp - iat <= 600', name='phone_pass_lifetime'))
    op.create_index('phone_passes_identity_exp', 'phone_passes', ['org_id', 'user_id', 'device', 'exp'])
    op.create_table('phone_revocation_batches',
        sa.Column('org_id', UUID(), nullable=False),
        sa.Column('id', sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column('robot_id', UUID(), nullable=False),
        sa.Column('items', JSONB(), nullable=False),
        sa.Column('until', sa.BigInteger(), nullable=False),
        sa.ForeignKeyConstraint(['org_id', 'robot_id'], ['robots.org_id', 'robots.id']),
        sa.UniqueConstraint('org_id', 'robot_id', 'id'))
    op.create_index('phone_revocation_batches_robot_until', 'phone_revocation_batches', ['org_id', 'robot_id', 'until'])
    op.create_table('phone_pass_denials',
        sa.Column('org_id', UUID(), primary_key=True),
        sa.Column('count', sa.BigInteger(), nullable=False),
        sa.Column('reported_at', sa.Float(), nullable=False),
        sa.Column('reasons', JSONB(), nullable=False),
        sa.ForeignKeyConstraint(['org_id'], ['organizations.id']))
    op.create_table('phone_revocations',
        sa.Column('org_id', UUID(), nullable=False),
        sa.Column('seq', sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column('robot_id', UUID(), nullable=False),
        sa.Column('jti', UUID(), nullable=False, unique=True),
        sa.Column('until', sa.BigInteger(), nullable=False),
        sa.Column('batch_id', sa.BigInteger(), nullable=False),
        sa.Column('acked_at', sa.DateTime(timezone=True)),
        sa.ForeignKeyConstraint(['org_id', 'robot_id'], ['robots.org_id', 'robots.id']),
        sa.ForeignKeyConstraint(['org_id', 'robot_id', 'batch_id'],
            ['phone_revocation_batches.org_id', 'phone_revocation_batches.robot_id', 'phone_revocation_batches.id']))
    op.create_index('phone_revocations_robot_until', 'phone_revocations', ['org_id', 'robot_id', 'until'])
    op.execute('GRANT SELECT, INSERT, DELETE ON phone_passes, phone_revocations TO fh_app')
    op.execute('GRANT SELECT, INSERT, DELETE ON phone_revocation_batches TO fh_app')
    op.execute('GRANT SELECT, INSERT, UPDATE, DELETE ON phone_pass_denials TO fh_app')
    op.execute('GRANT USAGE ON SEQUENCE phone_revocation_batches_id_seq TO fh_app')
    op.execute('GRANT SELECT ON phone_revocation_batches, phone_pass_denials TO fh_readonly')
    op.execute('GRANT UPDATE (acked_at) ON phone_revocations TO fh_app')
    op.execute('GRANT USAGE ON SEQUENCE phone_revocations_seq_seq TO fh_app')
    op.execute('GRANT SELECT ON phone_passes, phone_revocations TO fh_readonly')


def downgrade():
    op.drop_table('phone_revocations')
    op.drop_table('phone_revocation_batches')
    op.drop_table('phone_pass_denials')
    op.drop_table('phone_passes')

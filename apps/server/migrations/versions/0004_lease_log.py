"""Append-only lease audit. robots.agent_token_hash already exists in 0001."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

revision = '0004'
down_revision = '0003'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table('lease_log',
        sa.Column('id', sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column('org_id', UUID(), nullable=False),
        sa.Column('robot_id', UUID(), nullable=False),
        sa.Column('op', sa.Text(), nullable=False),
        sa.Column('user_id', UUID()),
        sa.Column('other_user_id', UUID()),
        sa.Column('session_id', UUID()),
        sa.Column('at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.ForeignKeyConstraint(['org_id'], ['organizations.id']),
        sa.ForeignKeyConstraint(['org_id', 'robot_id'], ['robots.org_id', 'robots.id']),
        sa.ForeignKeyConstraint(['org_id', 'user_id'], ['users.org_id', 'users.id']),
        sa.ForeignKeyConstraint(['org_id', 'other_user_id'], ['users.org_id', 'users.id']),
        sa.CheckConstraint("op IN ('TAKE','RELEASE','REQUEST','ACCEPT','DECLINE','TIMEOUT','EXPIRE','RUN_TAKE','RUN_PAUSE_TAKEOVER')", name='lease_log_op'))
    op.execute('GRANT SELECT, INSERT ON lease_log TO fh_app')
    op.execute('REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON lease_log FROM fh_app')
    op.execute('GRANT USAGE, SELECT ON SEQUENCE lease_log_id_seq TO fh_app')
    op.execute('GRANT SELECT ON lease_log TO fh_readonly')
    op.execute('GRANT SELECT ON SEQUENCE lease_log_id_seq TO fh_readonly')


def downgrade():
    op.drop_table('lease_log')

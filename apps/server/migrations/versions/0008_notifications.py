"""Tenant-bound notification inbox; immutable events keep their existing grants."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

revision = '0008'
down_revision = '0007'
branch_labels = None
depends_on = None


def upgrade():
    op.create_unique_constraint('events_org_id_id_key', 'events', ['org_id', 'id'])
    op.create_index('events_org_at_id', 'events', ['org_id', sa.text('at DESC'), sa.text('id DESC')])
    op.create_table('notifications',
        sa.Column('org_id', UUID(), nullable=False),
        sa.Column('id', sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column('user_id', UUID(), nullable=False),
        sa.Column('event_id', sa.BigInteger(), nullable=True),
        sa.Column('kind', sa.Text(), nullable=False),
        sa.Column('title', sa.Text(), nullable=False),
        sa.Column('body', sa.Text(), nullable=False),
        sa.Column('link', sa.Text(), nullable=False),
        sa.Column('read_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.ForeignKeyConstraint(['org_id', 'user_id'], ['users.org_id', 'users.id']),
        sa.ForeignKeyConstraint(['org_id', 'event_id'], ['events.org_id', 'events.id']),
        sa.UniqueConstraint('user_id', 'event_id', 'kind'))
    op.create_index('notifications_user_created_id', 'notifications', ['user_id', sa.text('created_at DESC'), sa.text('id DESC')])
    op.create_index('notifications_user_unread', 'notifications', ['user_id'], postgresql_where=sa.text('read_at IS NULL'))
    op.execute('GRANT SELECT, INSERT, UPDATE ON notifications TO fh_app')
    op.execute('GRANT USAGE, SELECT ON SEQUENCE notifications_id_seq TO fh_app')
    op.execute('GRANT SELECT ON notifications TO fh_readonly')


def downgrade():
    op.drop_table('notifications')
    op.drop_index('events_org_at_id', table_name='events')
    op.drop_constraint('events_org_id_id_key', 'events', type_='unique')

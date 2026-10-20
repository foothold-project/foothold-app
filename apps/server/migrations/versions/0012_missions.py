"""S5a append-only mission/scenario snapshots and limited mutable pointers."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID, JSONB, ARRAY

revision = '0012'
down_revision = '0011'
branch_labels = None
depends_on = None


def upgrade():
    for singular in ('mission', 'scenario'):
        parent, versions = singular + 's', singular + '_versions'
        op.create_table(parent,
            sa.Column('org_id', UUID(), nullable=False),
            sa.Column('id', UUID(), primary_key=True, server_default=sa.text('gen_random_uuid()')),
            sa.Column('name', sa.Text(), nullable=False),
            sa.Column('created_by', UUID(), nullable=False),
            sa.Column('latest_version', sa.Integer(), nullable=False),
            sa.Column('version', sa.Integer(), nullable=False),
            sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column('archived_at', sa.DateTime(timezone=True)),
            sa.ForeignKeyConstraint(['org_id', 'created_by'], ['users.org_id', 'users.id']),
            sa.UniqueConstraint('org_id', 'id'),
            sa.CheckConstraint('latest_version > 0 AND version > 0', name=singular + '_versions_positive'))
        op.create_index(parent + '_org_created', parent, ['org_id', 'created_at', 'id'])
        specific = [sa.Column('steps', JSONB(), nullable=False)] if singular == 'mission' else [
            sa.Column('waypoints', JSONB(), nullable=False), sa.Column('finish', JSONB(), nullable=False),
            sa.Column('notes', sa.Text(), nullable=False), sa.Column('floor_ids', ARRAY(UUID()), nullable=False),
            sa.Column('map_version_ids', ARRAY(UUID()), nullable=False), sa.Column('est_distance_m', sa.Float(), nullable=False)]
        op.create_table(versions,
            sa.Column('org_id', UUID(), nullable=False),
            sa.Column('id', UUID(), primary_key=True, server_default=sa.text('gen_random_uuid()')),
            sa.Column(singular + '_id', UUID(), nullable=False),
            sa.Column('name', sa.Text(), nullable=False),
            sa.Column('number', sa.Integer(), nullable=False),
            sa.Column('required_devices', ARRAY(sa.Text()), nullable=False),
            sa.Column('created_by', UUID(), nullable=False),
            sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            *specific,
            sa.ForeignKeyConstraint(['org_id', singular + '_id'], [parent + '.org_id', parent + '.id']),
            sa.ForeignKeyConstraint(['org_id', 'created_by'], ['users.org_id', 'users.id']),
            sa.UniqueConstraint(singular + '_id', 'number'),
            sa.CheckConstraint('number > 0', name=singular + '_number_positive'))
        op.execute(f'GRANT SELECT, INSERT ON {parent}, {versions} TO fh_app')
        op.execute(f'GRANT UPDATE (name, latest_version, version, archived_at) ON {parent} TO fh_app')
        op.execute(f'GRANT SELECT ON {parent}, {versions} TO fh_readonly')


def downgrade():
    for singular in ('scenario', 'mission'):
        op.drop_table(singular + '_versions')
        op.drop_table(singular + 's')

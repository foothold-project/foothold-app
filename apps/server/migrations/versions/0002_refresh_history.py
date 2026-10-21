"""Keep retired refresh hashes to revoke a session on token replay."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = '0002'
down_revision = '0001'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('sessions', sa.Column('retired_refresh_hashes', JSONB(),
                  nullable=False, server_default=sa.text("'[]'::jsonb")))


def downgrade():
    op.drop_column('sessions', 'retired_refresh_hashes')

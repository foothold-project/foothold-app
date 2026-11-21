"""First-login password change (팀장 2026-11-22).

Accounts created with a temporary or shared default password must change it
before any other API use. Existing accounts keep working (default false).
"""
from alembic import op
import sqlalchemy as sa

revision = '0032'
down_revision = '0031'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('users', sa.Column('password_must_change', sa.Boolean(), nullable=False, server_default=sa.text('false')))


def downgrade():
    op.drop_column('users', 'password_must_change')

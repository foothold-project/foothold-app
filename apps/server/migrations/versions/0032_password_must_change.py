"""First-login password change (팀장 2026-11-22).

Accounts created with a temporary or shared default password must change it
before any other API use. Existing accounts keep working (default false).
"""
from alembic import op

revision = '0032'
down_revision = '0031'
branch_labels = None
depends_on = None


def upgrade():
    # IF NOT EXISTS: 옛 판으로 내린 DB 에서 현재 ORM 으로 자료를 만드는 시험 (test_sim_orphan_worlds) 이 열을 먼저 더해 둘 수 있다.
    op.execute('ALTER TABLE users ADD COLUMN IF NOT EXISTS password_must_change boolean NOT NULL DEFAULT false')


def downgrade():
    op.execute('ALTER TABLE users DROP COLUMN IF EXISTS password_must_change')

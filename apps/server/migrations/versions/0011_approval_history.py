"""PR32 review: immutable request fields and canonical notification kind."""
from alembic import op

revision = '0011'
down_revision = '0010'
branch_labels = None
depends_on = None


def rename_notifications(before, after):
    # Keep an explicitly set destination preference if both keys exist.
    op.execute(f"UPDATE notifications SET kind='{after}' WHERE kind='{before}'")
    op.execute(f"""UPDATE users SET notify_prefs = (notify_prefs - '{before}') ||
        CASE WHEN notify_prefs ? '{after}' THEN '{{}}'::jsonb
             ELSE jsonb_build_object('{after}', notify_prefs -> '{before}') END
        WHERE notify_prefs ? '{before}'""")


def upgrade():
    op.execute('REVOKE UPDATE ON approvals FROM fh_app')
    op.execute('GRANT UPDATE (status, decider_id, decided_at, decision_comment) ON approvals TO fh_app')
    rename_notifications('APPROVAL_RESULT', 'APPROVAL_DECIDED')


def downgrade():
    rename_notifications('APPROVAL_DECIDED', 'APPROVAL_RESULT')
    op.execute('REVOKE UPDATE (status, decider_id, decided_at, decision_comment) ON approvals FROM fh_app')
    op.execute('GRANT UPDATE ON approvals TO fh_app')
